package eu.kanade.tachiyomi.data.backup.venera

import android.content.Context
import android.net.Uri
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupChapter
import eu.kanade.tachiyomi.data.backup.models.BackupHistory
import eu.kanade.tachiyomi.data.backup.models.BackupManga
import eu.kanade.tachiyomi.data.backup.restore.restorers.MangaCategoriesRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.MangaRestorer
import eu.kanade.tachiyomi.source.manga.AndroidMangaSourceManager
import eu.kanade.tachiyomi.source.manga.js.JsMangaSource
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.system.createFileInCacheDir
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import tachiyomi.data.handlers.manga.MangaDatabaseHandler
import tachiyomi.domain.entries.manga.interactor.GetMangaByUrlAndSourceId
import tachiyomi.domain.items.chapter.interactor.GetChaptersByMangaId
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.coroutines.coroutineContext

/** Which halves of a `.venera` archive to bring over. */
data class VeneraRestoreOptions(
    val sources: Boolean = true,
    val favorites: Boolean = true,
    val history: Boolean = true,
) {
    fun canRestore(): Boolean = sources || favorites || history

    /** Round-trips through [androidx.work.Data] as a `BooleanArray`. */
    fun asBooleanArray() = booleanArrayOf(sources, favorites, history)

    companion object {
        fun fromBooleanArray(array: BooleanArray) = VeneraRestoreOptions(
            sources = array.getOrElse(0) { true },
            favorites = array.getOrElse(1) { true },
            history = array.getOrElse(2) { true },
        )
    }
}

/** Summary of an import, used for the completion notification and the error log. */
data class VeneraRestoreResult(
    val sourcesInstalled: Int = 0,
    val sourcesFailed: Int = 0,
    val categories: Int = 0,
    val favorites: Int = 0,
    val historyEntries: Int = 0,
    val errorCount: Int = 0,
)

/**
 * Imports a Venera `.venera` archive into Aniyomi.
 *
 * ### Why this is a separate pipeline
 *
 * Aniyomi's [eu.kanade.tachiyomi.data.backup.BackupDecoder] only understands protobuf `.tachibk`
 * files, while Venera's export is a ZIP of sqlite databases — the two share nothing. So this class
 * performs the whole translation itself and then **reuses** [MangaCategoriesRestorer] and
 * [MangaRestorer] for the database writes, keeping the fiddly parts (transactions, merging into
 * existing entries, fetch-interval bookkeeping) in one place.
 *
 * ### The identity problem it solves
 *
 * Venera stores a source's identity in sqlite as a single integer — the Dart VM's
 * `String.hashCode(key)`. Aniyomi stores it as `MD5(key)` truncated to a Long. The archive contains
 * no mapping between the two, so [resolveTypeMap] re-derives the Dart hash from every key the
 * archive lets us discover and matches backwards. See [DartStringHash].
 *
 * ### Known limits
 *
 * * Venera's `appdata.json` (reader settings, search history, themes) has no Aniyomi counterpart and
 *   is intentionally ignored; the count of skipped items is reported in the log.
 * * `cookie.db` is not migrated: the two cookie stores use different schemas and Venera sources
 *   re-establish cookies through their own login flow.
 * * A sqlite file Venera left in WAL mode without checkpointing may be missing the most recent
 *   writes; nothing in the archive exposes the `-wal` sidecar.
 */
class VeneraBackupRestorer(
    private val context: Context,
    private val mangaSourceManager: AndroidMangaSourceManager = Injekt.get(),
    private val mangaCategoriesRestorer: MangaCategoriesRestorer = MangaCategoriesRestorer(),
    private val mangaRestorer: MangaRestorer = MangaRestorer(),
    private val handler: MangaDatabaseHandler = Injekt.get(),
    private val getMangaByUrlAndSourceId: GetMangaByUrlAndSourceId = Injekt.get(),
    private val getChaptersByMangaId: GetChaptersByMangaId = Injekt.get(),
) {

    /** Counts history rows whose real chapter list could not be fetched, for the completion report. */
    private var unresolvedHistory = 0

    private val errors = mutableListOf<Pair<Date, String>>()
    private val notes = mutableListOf<String>()

    suspend fun restore(
        uri: Uri,
        options: VeneraRestoreOptions,
        onProgress: (String) -> Unit = {},
    ): VeneraRestoreResult {
        // The restorer is reusable; a second run must not inherit the first one's log.
        errors.clear()
        notes.clear()

        val reader = VeneraBackupReader(context)
        val backup = try {
            withContext(Dispatchers.IO) { reader.read(uri, onProgress) }
        } finally {
            reader.cleanup()
        }
        notes += backup.notes

        // 1. Sources come first: every other row references a source id, and installing is also what
        //    reveals the `key`s needed to translate Venera's numeric `type` values.
        val install = if (options.sources) {
            installSources(backup, onProgress)
        } else {
            SourceInstall(keys = JsSourceManager.jsSources.map { it.key }.toSet())
        }

        val identity = resolveTypeMap(backup, install.keys)

        // 2. Categories must exist before any manga is written: MangaRestorer resolves the
        //    per-manga category list by looking the names up in the database afterwards.
        val plan = planCategories(backup, identity.typeToId, options)

        // Chapter lists are fetched from the sources here, so this part does real network I/O.
        val jsSources = JsSourceManager.jsSources.associateBy { it.id }
        val mangas = withContext(Dispatchers.IO) {
            buildMangas(backup, identity.typeToId, options, plan, jsSources, onProgress)
        }
        if (unresolvedHistory > 0) {
            notes += "有 $unresolvedHistory 条阅读记录没能取到章节列表（源未安装或网络失败），其进度已跳过。" +
                "这些漫画仍会入库，打开时会自动拉取真实章节。"
        }

        return withContext(Dispatchers.IO) {
            onProgress("正在写入收藏与历史…")
            if (plan.categories.isNotEmpty()) {
                mangaCategoriesRestorer(plan.categories)
            }

            var favorites = 0
            var historyEntries = 0
            mangaRestorer.sortByNew(mangas).forEach { manga ->
                coroutineContext.ensureActive()
                try {
                    // The full list is passed even for entries that use none of it: `restore` resolves
                    // names through it, so a partial list would silently drop categories.
                    mangaRestorer.restore(manga, plan.categories)
                    if (manga.favorite) favorites++
                    historyEntries += manga.history.size
                } catch (e: Exception) {
                    val sourceName = identity.idToKey[manga.source] ?: manga.source.toString()
                    errors += Date() to "${manga.title} [$sourceName]: ${e.message}"
                }
            }

            VeneraRestoreResult(
                sourcesInstalled = install.installed,
                sourcesFailed = install.failed,
                categories = plan.categories.size,
                favorites = favorites,
                historyEntries = historyEntries,
                errorCount = errors.size,
            )
        }
    }

    /** Writes the error log next to Aniyomi's own restore log; returns an empty file when clean. */
    fun writeErrorLog(): File {
        if (errors.isEmpty() && notes.isEmpty()) return File("")
        return try {
            val file = context.createFileInCacheDir("venera_restore_error.txt")
            val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())
            file.bufferedWriter().use { out ->
                errors.forEach { (date, message) -> out.write("[${sdf.format(date)}] $message\n") }
                if (notes.isNotEmpty()) {
                    out.write("\n--- 说明 ---\n")
                    notes.forEach { out.write("· $it\n") }
                }
            }
            file
        } catch (e: Exception) {
            logcat(LogPriority.ERROR, e) { "Failed to write Venera restore log" }
            File("")
        }
    }

    // --- sources -------------------------------------------------------------------------------------

    private data class SourceInstall(
        val keys: Set<String> = emptySet(),
        val installed: Int = 0,
        val failed: Int = 0,
    )

    /**
     * Installs every source script bundled in `comic_source`, then applies its `.data` blob.
     *
     * A script that cannot be evaluated is **not** abandoned: its `key` is still recovered textually
     * so the comics that belong to it keep a stable source id. That mirrors how Aniyomi keeps entries
     * for sources it does not have installed (they show up as "unknown source") instead of silently
     * discarding the user's library.
     */
    private suspend fun installSources(backup: VeneraBackup, onProgress: (String) -> Unit): SourceInstall {
        val keys = mutableSetOf<String>()
        var installed = 0
        var failed = 0
        val total = backup.sources.size

        withContext(Dispatchers.IO) {
            backup.sources.forEachIndexed { index, file ->
                coroutineContext.ensureActive()
                onProgress("正在安装源 ${index + 1}/$total：${file.fileName}")

                // Register without a file-name hint, so the script lands as `<key>.js` rather than
                // under Venera's own name. This archive holds both `jm.js` and `jm(0).js` (Venera
                // appends `(n)` when the same source is imported twice) — the same key twice — and
                // writing them under separate names would leave a stale second copy on disk that the
                // name-ordered startup scan could resurrect.
                val source = runCatching { JsSourceManager.install(file.jsCode) }.getOrNull()
                val key = source?.key ?: declaredKey(file.jsCode)

                if (key == null) {
                    failed++
                    errors += Date() to "无法解析源文件 ${file.fileName}（缺少 key 声明）"
                    return@forEachIndexed
                }

                if (source == null) {
                    failed++
                    // Nothing was written to disk: `install` parses before it persists, deliberately.
                    // The `key` is still recovered so this source's comics keep a stable id and show
                    // up as an "unknown source" instead of being dropped.
                    errors += Date() to "${file.fileName} 解析失败、未能安装，其漫画将显示为「未知源」"
                } else {
                    installed++
                }
                keys += key

                file.data?.let { data ->
                    runCatching { JsSourceManager.importData(key, hoistSettings(data)) }
                        .onFailure { errors += Date() to "${file.fileName} 配置导入失败：${it.message}" }
                }
            }
        }

        // Make the freshly installed sources visible to Browse / Library without a restart.
        mangaSourceManager.refreshJsSources()
        return SourceInstall(keys = keys, installed = installed, failed = failed)
    }

    /**
     * Translates Venera's `.data` layout into ours.
     *
     * Venera keeps settings nested — `data["settings"]["apiDomain"]`, read by
     * `venera/lib/foundation/js_engine.dart` — whereas this app stores them flat at the top level of
     * `dataStore[key]`. Everything else (`account`, `uid`, `lastCheckInDate`, …) is already where we
     * expect it.
     */
    private fun hoistSettings(veneraData: Map<String, Any?>): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        (veneraData["settings"] as? Map<*, *>)?.forEach { (k, v) -> result[k.toString()] = v }
        veneraData.forEach { (k, v) -> if (k != "settings") result[k] = v }
        return result
    }

    /**
     * Last-resort `key` extraction for a script that failed to evaluate.
     *
     * Line-anchored and indentation-limited so it does not match the many `key:` occurrences inside
     * regular expressions and nested object literals that Venera sources contain.
     */
    private fun declaredKey(jsCode: String): String? =
        KEY_DECLARATION.find(jsCode)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }

    // --- identity mapping ----------------------------------------------------------------------------

    /**
     * Venera's numeric `type` translated into Aniyomi's source ids, both ways round.
     *
     * The reverse direction exists purely for error messages: `MangaRestorer` failures are reported
     * per source id, and a raw Long is useless to a human.
     */
    private data class SourceIdentity(
        val typeToId: Map<Int, Long>,
        val idToKey: Map<Long, String>,
    )

    /**
     * Builds `Dart hash (Venera's `type`) -> our sourceId`, the bridge this whole import depends on.
     *
     * Candidate keys come from three places, and all three are needed:
     *  1. the `.js` files bundled in the archive (installed, or textually recovered);
     *  2. `appdata.json`'s `favorites` / `searchSources` arrays — sources the user configured but
     *     whose `.js` is not in this particular export;
     *  3. [DartStringHash.BUILT_IN_KEYS] — sources compiled into Venera itself, which therefore have
     *     no `.js` anywhere.
     *
     * Anything still unresolved is reported rather than guessed at, because a wrong id would graft
     * the user's comics onto an unrelated source.
     */
    private fun resolveTypeMap(backup: VeneraBackup, installedKeys: Set<String>): SourceIdentity {
        val candidates = buildSet {
            addAll(installedKeys)
            addAll(DartStringHash.BUILT_IN_KEYS)
            addAll(keysFromAppData(backup.appDataJson))
        }

        val typeToKey = DartStringHash.reverseLookup(candidates)

        val presentTypes = buildSet {
            backup.folders.forEach { folder -> folder.comics.forEach { add(it.type) } }
            backup.history.forEach { add(it.type) }
        }
        val unresolved = presentTypes.filterNot { typeToKey.containsKey(it) }
        if (unresolved.isNotEmpty()) {
            val affected = backup.folders.sumOf { folder -> folder.comics.count { it.type in unresolved } } +
                backup.history.count { it.type in unresolved }
            notes += "有 $affected 条记录属于 ${unresolved.size} 个无法识别的源" +
                "（备份中既没有对应 .js，也不是内置源），已跳过。type=$unresolved"
        }

        return SourceIdentity(
            typeToId = typeToKey.mapValues { (_, key) -> JsMangaSource.keyToId(key) },
            idToKey = typeToKey.values.associate { key -> JsMangaSource.keyToId(key) to key },
        )
    }

    /** Source keys listed in `appdata.json`, which is how sources without a local `.js` are known. */
    private fun keysFromAppData(appDataJson: String?): List<String> {
        val text = appDataJson ?: return emptyList()
        return runCatching {
            val settings = (JSON.parseToJsonElement(text) as? JsonObject)
                ?.get("settings") as? JsonObject
                ?: return@runCatching emptyList()
            listOf("favorites", "searchSources")
                .flatMap { field ->
                    val array = settings[field] as? JsonArray ?: return@flatMap emptyList()
                    array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                }
        }.getOrElse {
            logcat(LogPriority.DEBUG, it) { "Could not mine source keys from appdata.json" }
            emptyList()
        }
    }

    // --- categories ----------------------------------------------------------------------------------

    /**
     * The translation of Venera's folder layout into Aniyomi's category model.
     *
     * [BackupCategory.order] is meaningful only *within a single archive* — `MangaRestorer` maps a
     * manga's `categories` list back to names through the very same list it is handed — so a dense
     * index is a safe ordering key. Venera's own `folder_order` values are used only to establish
     * the *sequence*, never passed through: two folders may legitimately share a value, and the
     * downstream `associateBy { it.order }` would silently drop one of them, costing that folder's
     * comics every category.
     */
    private class CategoryPlan(
        val categories: List<BackupCategory>,
        /** Venera folder name -> the `order` its comics must carry. */
        val orderByFolder: Map<String, Long>,
        /** `order` of the catch-all, or null when no comic needs it. */
        val catchAllOrder: Long?,
    )

    /**
     * Builds the category list: one entry per Venera folder, plus a «[FALLBACK_CATEGORY]» bucket for
     * comics that no folder claims.
     *
     * ### Why the catch-all exists
     *
     * Venera's favourites always live inside a folder, so every *favourited* comic arrives with a
     * category. A comic that only appears in the reading history does not — and an entry written with
     * no category is invisible in the library, which makes a **successful** import look like a
     * no-op. Those comics are therefore collected into one clearly-named bucket (and flipped to
     * favourite, since the library lists favourites only), so the result of the import is visible and
     * easy to undo — deleting the one category undoes the whole thing.
     */
    private fun planCategories(
        backup: VeneraBackup,
        typeToSourceId: Map<Int, Long>,
        options: VeneraRestoreOptions,
    ): CategoryPlan {
        // Sorted by Venera's own order so the recreated categories keep the user's arrangement;
        // folders the archive did not order fall back to the position the reader assigned them.
        val folders = if (options.favorites) {
            backup.folders.sortedWith(compareBy({ it.order }, { it.name }))
        } else {
            emptyList()
        }

        val categories = folders.mapIndexed { index, folder ->
            BackupCategory(name = folder.name, order = index.toLong())
        }.toMutableList()
        val orderByFolder = folders.withIndex().associate { (index, folder) -> folder.name to index.toLong() }
        val folderedComics = buildSet {
            folders.forEach { folder -> folder.comics.forEach { add(it.type to it.id) } }
        }

        // A row whose source could not be identified is skipped by `buildMangas`, so it must not
        // influence the plan either — otherwise the catch-all would be created for nothing.
        val orphans = when {
            !options.history -> emptyList()
            else -> backup.history
                .filter { it.type in typeToSourceId && (it.type to it.comicId) !in folderedComics }
                .distinctBy { it.type to it.comicId }
        }

        val catchAllOrder = if (orphans.isEmpty()) {
            null
        } else {
            // Reuse a folder that is already called "Venera" rather than creating a twin category —
            // two categories with one name would be indistinguishable in the library's filter.
            categories.indexOfFirst { it.name == FALLBACK_CATEGORY }.takeIf { it >= 0 }?.toLong()
                ?: categories.size.toLong().also { order ->
                    categories += BackupCategory(name = FALLBACK_CATEGORY, order = order)
                }
        }

        if (catchAllOrder != null) {
            notes += "${orphans.size} 部漫画只有阅读记录、不属于任何收藏夹，已加入书架并归入「" +
                "$FALLBACK_CATEGORY」分类（不需要的话删除该分类即可）。"
        }

        return CategoryPlan(categories, orderByFolder, catchAllOrder)
    }

    // --- library entries -----------------------------------------------------------------------------

    /**
     * Folds folders and history into exactly one `BackupManga` per `(source, comicId)`.
     *
     * A comic normally appears in both places — favourited *and* read — and [MangaRestorer] expects a
     * single entry per comic per run, so the two views are merged instead of restored twice.
     */
    private suspend fun buildMangas(
        backup: VeneraBackup,
        typeToSourceId: Map<Int, Long>,
        options: VeneraRestoreOptions,
        plan: CategoryPlan,
        jsSources: Map<Long, JsMangaSource>,
        onProgress: (String) -> Unit,
    ): List<BackupManga> {
        val merged = LinkedHashMap<Pair<Long, String>, BackupManga>()

        if (options.favorites) {
            backup.folders.forEach { folder ->
                val folderOrder = plan.orderByFolder[folder.name] ?: return@forEach
                folder.comics.forEach { comic ->
                    val sourceId = typeToSourceId[comic.type] ?: return@forEach
                    val entry = merged.getOrPut(sourceId to comic.id) {
                        // `favorite` starts false and only flips on an actual folder membership, so a
                        // comic that is merely present in a folder table still ends up in the library.
                        BackupManga(source = sourceId, url = comic.id, title = comic.name, favorite = false)
                    }
                    entry.title = comic.name.ifBlank { entry.title }
                    entry.author = comic.author.takeIf { it.isNotBlank() } ?: entry.author
                    entry.genre = comic.tags.distinct()
                    entry.thumbnailUrl = comic.coverPath.asRemoteUrl() ?: entry.thumbnailUrl
                    entry.dateAdded = comic.dateAdded.takeIf { it > 0 } ?: entry.dateAdded
                    entry.lastModifiedAt = comic.dateAdded.takeIf { it > 0 } ?: entry.lastModifiedAt
                    entry.favorite = true
                    entry.categories = (entry.categories + folderOrder).distinct()
                }
            }
        }

        if (options.history) {
            backup.history.forEach { row ->
                coroutineContext.ensureActive()
                val sourceId = typeToSourceId[row.type] ?: return@forEach
                val entry = merged.getOrPut(sourceId to row.comicId) {
                    BackupManga(source = sourceId, url = row.comicId, title = row.title, favorite = false)
                }
                if (entry.title.isBlank()) entry.title = row.title
                if (entry.thumbnailUrl == null) entry.thumbnailUrl = row.cover.asRemoteUrl()

                // ### Why the chapters are fetched instead of derived from `row.episode`
                //
                // `history.ep` is **not** a chapter id — it is a 1-based *position* in the source's
                // chapter list (`readEpisode` is a plain list of those positions, e.g.
                // `1,2,…,22,58,59`). jm.js only ever uses real per-chapter ids: a multi-volume work
                // gets `series[].id` (`544148`, `544149`, `551255`, …) and a one-shot gets the album
                // id itself (`77095`).
                //
                // The first version of this importer wrote `"<comicId>||<ep>"` straight from
                // `ep`, i.e. `/chapter?id=1`, and 禁漫 answers a chapter that does not exist with
                // `HTTP 200 {"code":200,"data":[]}`. jm.js checks the *HTTP* status, not `code`, so it
                // fell through to `throw 'Invalid Data'` — every restored chapter was unopenable
                // (black reader) and the rejection, being raised from a floating promise, surfaced as
                // `UnhandledPromiseRejectionException: Invalid Data`.
                //
                // So: ask the source for the real list and map positions onto it. If the list cannot
                // be fetched, write **no** chapters at all — a dangling chapter is worse than a
                // missing one, because it is unreadable by construction.
                val real = fetchRealChapters(jsSources[sourceId], row.comicId, onProgress)
                if (real == null) {
                    unresolvedHistory++
                    return@forEach
                }

                val readPositions = (row.readEpisodes.ifEmpty { listOf(row.episode) }).toSet()
                entry.chapters = real.mapIndexed { index, chapter ->
                    val position = index + 1
                    val isCurrent = position == row.episode
                    BackupChapter(
                        url = chapter.url,
                        name = chapter.name.ifBlank { "第 $position 话" },
                        // Only the episode actually open when Venera was closed carries page progress;
                        // the rest are known-finished but have no page count of their own.
                        read = if (isCurrent) row.maxPage > 0 && row.page >= row.maxPage else position in readPositions,
                        lastPageRead = if (isCurrent) row.page.toLong() else 0L,
                        chapterNumber = chapter.chapter_number.takeIf { it > 0F } ?: position.toFloat(),
                        // `SChapter` exposes no source ordering, so the list order the source handed
                        // back *is* the ordering — positions are 1-based and ascending there.
                        sourceOrder = position.toLong(),
                        dateUpload = chapter.date_upload,
                        dateFetch = chapter.date_upload,
                        lastModifiedAt = if (isCurrent && row.readAt > 0) row.readAt else chapter.date_upload,
                    )
                }

                val currentUrl = real.getOrNull(row.episode - 1)?.url ?: return@forEach
                entry.history = entry.history.filterNot { it.url == currentUrl } +
                    BackupHistory(url = currentUrl, lastRead = row.readAt)

                removeStaleChapters(sourceId, row.comicId, real.mapTo(mutableSetOf()) { it.url })
            }
        }

        // The favourites pass above is what assigns folders, so whatever is still uncategorised here
        // came from the history alone. It needs both the catch-all category and `favorite = true`:
        // Aniyomi's library lists favourites only, so an uncategorised *and* unfavourited entry would
        // be written to the database yet never surface anywhere.
        plan.catchAllOrder?.let { order ->
            merged.values
                .filter { it.categories.isEmpty() && it.history.isNotEmpty() }
                .forEach { entry ->
                    entry.categories = listOf(order)
                    entry.favorite = true
                }
        }

        return merged.values.toList()
    }

    /**
     * Asks the source for the authoritative chapter list of one comic.
     *
     * `null` means "we do not know" — the source is not installed, the request failed, or the comic
     * has been delisted. Callers must treat that as *write nothing* rather than falling back to a
     * guess, because a guessed chapter url resolves to a chapter the site does not have.
     */
    private suspend fun fetchRealChapters(
        source: JsMangaSource?,
        comicId: String,
        onProgress: (String) -> Unit,
    ): List<SChapter>? {
        if (source == null) return null
        onProgress("正在获取章节列表：${source.name}")
        return runCatching {
            withTimeout(CHAPTER_FETCH_TIMEOUT_MS) {
                // `getChapterList` reads nothing but `url`; `SManga` has no source field to set.
                source.getChapterList(SManga.create().apply { url = comicId })
            }
        }
            .onFailure { logcat(LogPriority.DEBUG, it) { "Venera import: no chapter list for $comicId" } }
            .getOrNull()
            ?.takeIf { it.isNotEmpty() }
    }

    /**
     * Drops chapters left behind by an earlier import of the same comic.
     *
     * Needed because [MangaRestorer] merges by url and never deletes: a first import that wrote
     * `"<comicId>||1"` (see the note in [buildMangas]) would otherwise keep those unopenable rows
     * alongside the real ones forever, so the reader would still hit them.
     *
     * Scoped tightly on purpose — only chapters of this comic, and only urls that use the JS source's
     * own `"<comicId>||<chapterId>"` namespace, are candidates. Anything the fresh list does not
     * mention is stale *by definition*, since the list is the source's own answer.
     */
    private suspend fun removeStaleChapters(sourceId: Long, comicId: String, realUrls: Set<String>) {
        val prefix = "$comicId||"
        val mangaId = getMangaByUrlAndSourceId.await(comicId, sourceId)?.id ?: return
        val stale = getChaptersByMangaId.await(mangaId)
            .filter { it.url.startsWith(prefix) && it.url !in realUrls }
            .map { it.id }
        if (stale.isEmpty()) return
        handler.await { chaptersQueries.removeChaptersWithIds(stale) }
    }

    /**
     * Venera's `cover_path` column holds a remote URL for network sources and a local file path for
     * ones that cache covers on disk. Only the former is usable here — Aniyomi re-downloads covers.
     */
    private fun String?.asRemoteUrl(): String? =
        this?.takeIf { it.startsWith("http://") || it.startsWith("https://") }

    private companion object {
        /**
         * Name of the bucket that catches comics belonging to no Venera folder. Deliberately the
         * archive's own name, so it reads as "this came from Venera" in the library filter.
         */
        const val FALLBACK_CATEGORY = "Venera"

        val JSON = Json { ignoreUnknownKeys = true; isLenient = true }
        val KEY_DECLARATION = Regex("""(?m)^\s{0,8}key\s*[:=]\s*['"]([^'"]+)['"]""")

        /**
         * Upper bound on one source's chapter-list request during an import.
         *
         * A library can hold hundreds of history rows, and jm.js fans every request out through a
         * floating daily check-in, so a single stalled host must not stall the whole restore. On
         * timeout the comic simply keeps no progress (see [buildMangas]).
         */
        const val CHAPTER_FETCH_TIMEOUT_MS = 20_000L
    }
}

