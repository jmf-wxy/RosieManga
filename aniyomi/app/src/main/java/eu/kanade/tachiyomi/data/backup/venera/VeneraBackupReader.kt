package eu.kanade.tachiyomi.data.backup.venera

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import java.io.File
import java.util.zip.ZipException
import java.util.zip.ZipFile

// --- models -----------------------------------------------------------------------------------------

/** Everything a `.venera` archive holds, already decoded into plain Kotlin. */
data class VeneraBackup(
    /** Bundled source scripts from `comic_source`, before they are registered with [JsSourceManager]. */
    val sources: List<VeneraSourceFile>,
    /** `appdata.json`, kept raw so callers can mine it for source keys. */
    val appDataJson: String?,
    val folders: List<VeneraFolder>,
    val history: List<VeneraHistory>,
    /** Human-readable notes about data that has no Aniyomi counterpart. */
    val notes: List<String>,
)

data class VeneraSourceFile(
    val fileName: String,
    val jsCode: String,
    /** Parsed `comic_source/<key>.data`, or null when the source never wrote state. */
    val data: Map<String, Any?>?,
)

data class VeneraFolder(
    val name: String,
    val order: Long,
    val comics: List<VeneraComic>,
)

data class VeneraComic(
    val id: String,
    val name: String,
    val author: String,
    /** Venera's Dart `String.hashCode` of the owning source's `key`. */
    val type: Int,
    val tags: List<String>,
    /** Despite the name this is usually a **remote URL**, not a local file. */
    val coverPath: String?,
    val dateAdded: Long,
)

data class VeneraHistory(
    val comicId: String,
    val title: String,
    /** Venera's chapter name for the episode currently being read. */
    val subtitle: String,
    val cover: String?,
    val readAt: Long,
    val type: Int,
    val episode: Int,
    val page: Int,
    val maxPage: Int,
    /** Every episode marked as read, in Venera's own ordering. */
    val readEpisodes: List<Int>,
)

// --- detection --------------------------------------------------------------------------------------

/**
 * Recognises Venera's `.venera` export.
 *
 * The archive is a plain ZIP produced by `venera/lib/utils/data.dart::exportAppData`, containing
 * `history.db` / `local_favorite.db` / `appdata.json` / `cookie.db` and a `comic_source/` directory.
 *
 * This is deliberately **not** wired into [eu.kanade.tachiyomi.data.backup.BackupDecoder]: that
 * decoder exists to read protobuf `.tachibk` files, and Venera's format shares nothing with it.
 * Mixing the two would risk regressing ordinary restores.
 */
object VeneraBackupDetector {

    /**
     * Entries that identify a Venera export rather than some other ZIP.
     *
     * `exportAppData` always writes all four, but only **two** are required so that a future version
     * which drops e.g. `cookie.db` still detects. No other plausible archive carries ≥2 of these
     * exact names at its root.
     */
    private val MARKERS = setOf("history.db", "local_favorite.db", "appdata.json", "cookie.db")

    fun isVeneraBackup(context: Context, uri: Uri): Boolean {
        val probe = File(context.cacheDir, PROBE_FILE_NAME)
        return try {
            copyBackupTo(context, uri, probe)
            // The central directory is authoritative, so this is a cheap name lookup — see the note
            // on [VeneraBackupReader.extract] for why the streaming reader must not be used here.
            ZipFile(probe).use { zip ->
                zip.entries().asSequence()
                    .map { it.name.removePrefix("./") }
                    .count { it in MARKERS } >= 2
            }
        } catch (e: Exception) {
            logcat(LogPriority.DEBUG, e) { "Not a Venera backup" }
            false
        } finally {
            probe.delete()
        }
    }

    private const val PROBE_FILE_NAME = "venera_detect_probe.zip"
}

/**
 * Copies a picked backup into [target].
 *
 * `java.util.zip.ZipFile` needs a real, seekable file, while a `content://` URI only yields a
 * stream — and the whole point is to read the ZIP's central directory, which lives at the *end* of
 * the file. Hence a copy. [MAX_ARCHIVE_BYTES] bounds it so a mis-picked large file cannot fill the
 * cache directory.
 */
private fun copyBackupTo(context: Context, uri: Uri, target: File) {
    val stream = context.contentResolver.openInputStream(uri) ?: error("无法读取备份文件")
    stream.use { input ->
        target.outputStream().use { out ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                total += read
                if (total > MAX_ARCHIVE_BYTES) {
                    error("备份文件超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB，已中止")
                }
                out.write(buffer, 0, read)
            }
        }
    }
}

private const val MAX_ARCHIVE_BYTES = 512L * 1024 * 1024

// --- reader -----------------------------------------------------------------------------------------

/**
 * Decodes a `.venera` archive into [VeneraBackup].
 *
 * The archive is extracted into a scratch directory under `cacheDir` because Android's sqlite API
 * only opens real files, then read with plain cursors. Everything is best-effort: a database that is
 * missing or unreadable degrades to an empty list plus a note, rather than failing the whole import.
 */
class VeneraBackupReader(private val context: Context) {

    private var scratchDir: File? = null

    fun read(uri: Uri, onProgress: (String) -> Unit = {}): VeneraBackup {
        onProgress("正在解包备份…")
        val dir = extract(uri)
        scratchDir = dir

        val sources = readSources(dir)
        onProgress("正在读取源配置…")
        val appData = readAppData(dir)

        onProgress("正在读取收藏夹…")
        val folders = readFavorites(dir)

        onProgress("正在读取阅读历史…")
        val (history, historyNotes) = readHistory(dir)

        val notes = historyNotes.toMutableList()
        if (sources.none { it.data != null }) {
            notes += "备份中没有源配置文件（*.data）"
        }

        return VeneraBackup(
            sources = sources,
            appDataJson = appData,
            folders = folders,
            history = history,
            notes = notes,
        )
    }

    /** Removes the scratch directory; safe to call more than once. */
    fun cleanup() {
        scratchDir?.deleteRecursively()
        scratchDir = null
    }

    // --- zip ----------------------------------------------------------------------------------------

    private fun extract(uri: Uri): File {
        val work = File(context.cacheDir, SCRATCH_DIR_NAME)
        work.deleteRecursively()
        if (!work.mkdirs()) error("无法创建临时目录")
        scratchDir = work

        val archive = File(work, ARCHIVE_FILE_NAME)
        try {
            copyBackupTo(context, uri, archive)
        } catch (e: Exception) {
            error(e.message ?: "无法读取备份文件")
        }

        val dir = File(work, CONTENT_DIR_NAME)
        if (!dir.mkdirs()) error("无法创建临时目录")

        try {
            // `ZipFile`, **not** `ZipInputStream`.
            //
            // Venera writes the archive as a streaming ZIP: every local file header carries the
            // "data descriptor" flag (general purpose bit 3) and therefore declares
            // `compressed size = 0` / `uncompressed size = 0`, with the real sizes only appended
            // after the payload and recorded authoritatively in the central directory.
            //
            // `ZipInputStream` trusts the local header, so it expects 0 bytes and aborts the moment
            // the first real chunk arrives:
            //     ZipException: invalid entry size (expected 0 but got 69632 bytes)
            // That is exactly the wall a `.venera` restore hit — the very first entry failed.
            // `ZipFile` reads the central directory instead, where the sizes are correct.
            //
            // (Also note `ZipInputStream` cannot skip to an arbitrary entry without inflating every
            // entry before it, so even detection would have been reading the whole archive.)
            ZipFile(archive).use { zip ->
                var totalBytes = 0L
                val entries = zip.entries()
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement()
                    val name = entry.name.removePrefix("./").removeSuffix("/")
                    if (entry.isDirectory || !isSafeEntryName(name)) continue

                    val target = File(dir, name)
                    target.parentFile?.mkdirs()
                    val written = zip.getInputStream(entry).use { input ->
                        target.outputStream().use { input.copyTo(it, COPY_BUFFER_SIZE) }
                    }
                    totalBytes += written
                    if (written > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) {
                        error("备份文件异常（解压后过大）")
                    }
                }
            }
        } catch (e: ZipException) {
            error("备份文件已损坏或不是有效的 ZIP：${e.message}")
        } finally {
            // The archive is dead weight once expanded (and holds plaintext credentials).
            archive.delete()
        }
        return dir
    }

    /**
     * Zip-slip guard: only flat names plus one level under `comic_source/` are accepted, and `..` is
     * rejected outright. Venera's export only ever contains those two shapes.
     */
    private fun isSafeEntryName(name: String): Boolean {
        if (name.isEmpty() || name.startsWith("/") || name.contains("..")) return false
        val slashes = name.count { it == '/' }
        return slashes == 0 || (name.startsWith("$COMIC_SOURCE_DIR/") && slashes == 1)
    }

    // --- comic_source -------------------------------------------------------------------------------

    private fun readSources(dir: File): List<VeneraSourceFile> {
        val comicSourceDir = File(dir, COMIC_SOURCE_DIR)
        if (!comicSourceDir.isDirectory) return emptyList()

        val dataByName = comicSourceDir.listFiles { f -> f.isFile && f.extension == "data" }
            ?.associate { it.nameWithoutExtension to parseJsonObject(it.readText()) }
            .orEmpty()

        return comicSourceDir.listFiles { f -> f.isFile && f.extension == "js" }
            ?.sortedBy { it.name }
            ?.map { file ->
                VeneraSourceFile(
                    fileName = file.name,
                    jsCode = file.readText(),
                    // `<key>.data` is keyed by the source key, which is what Venera names the file.
                    data = dataByName[file.nameWithoutExtension],
                )
            }
            .orEmpty()
    }

    private fun readAppData(dir: File): String? =
        File(dir, "appdata.json").takeIf { it.isFile }?.readText()

    // --- local_favorite.db --------------------------------------------------------------------------

    private fun readFavorites(dir: File): List<VeneraFolder> {
        val db = File(dir, "local_favorite.db").takeIf { it.isFile } ?: return emptyList()

        return openDatabase(db) { database ->
            val order = HashMap<String, Long>()
            query(database, "SELECT folder_name, order_value FROM folder_order") { cursor ->
                order[cursor.getString(0)] = cursor.getLong(1)
            }

            tableNames(database, skip = setOf("folder_order", "folder_sync"))
                .mapIndexed { index, folder ->
                    val comics = query(database, "SELECT * FROM ${folder.quoted()}") { cursor ->
                        VeneraComic(
                            id = cursor.str("id"),
                            name = cursor.str("name"),
                            author = cursor.str("author"),
                            type = cursor.int("type"),
                            tags = parseTags(cursor.str("tags")),
                            coverPath = cursor.str("cover_path").takeIf { it.isNotBlank() },
                            dateAdded = parseDate(cursor.str("time")) ?: cursor.long("last_check_time"),
                        )
                    }
                    VeneraFolder(
                        name = folder,
                        // Folders absent from `folder_order` land after the ordered ones, in table order.
                        order = order[folder] ?: (UNORDERED_BASE + index),
                        comics = comics,
                    )
                }
                .filter { it.comics.isNotEmpty() }
        }.orEmpty()
    }

    // --- history.db ---------------------------------------------------------------------------------

    private fun readHistory(dir: File): Pair<List<VeneraHistory>, List<String>> {
        val db = File(dir, "history.db").takeIf { it.isFile }
            ?: return emptyList<VeneraHistory>() to emptyList()

        val notes = mutableListOf<String>()

        val history = openDatabase(db) { database ->
            val tables = tableNames(database, skip = emptySet())
            if ("image_favorites" in tables) {
                val count = query(database, "SELECT COUNT(*) FROM image_favorites") { it.getLong(0) }.firstOrNull() ?: 0
                if (count > 0) {
                    notes += "$count 条单页收藏（image_favorites）在 Aniyomi 中没有对应模型，已跳过"
                }
            }
            if ("history" !in tables) return@openDatabase emptyList()

            query(database, "SELECT * FROM history") { cursor ->
                VeneraHistory(
                    comicId = cursor.str("id"),
                    title = cursor.str("title"),
                    subtitle = cursor.str("subtitle"),
                    cover = cursor.str("cover").takeIf { it.isNotBlank() },
                    readAt = cursor.long("time"),
                    type = cursor.int("type"),
                    episode = cursor.int("ep"),
                    page = cursor.int("page"),
                    maxPage = cursor.int("max_page"),
                    readEpisodes = cursor.str("readEpisode")
                        .split(',')
                        .mapNotNull { it.trim().toIntOrNull() },
                )
            }
        }.orEmpty()

        return history to notes
    }

    // --- sqlite plumbing ----------------------------------------------------------------------------

    private fun <T> openDatabase(file: File, block: (SQLiteDatabase) -> T): T? {
        return try {
            val database = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY)
            database.use(block)
        } catch (e: Exception) {
            // A database Venera never checkpointed, or a schema change, must not kill the whole import.
            logcat(LogPriority.WARN, e) { "Failed to read ${file.name}" }
            null
        }
    }

    private fun <T> query(database: SQLiteDatabase, sql: String, map: (Cursor) -> T): List<T> {
        return try {
            database.rawQuery(sql, null).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) add(map(cursor))
                }
            }
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Query failed: $sql" }
            emptyList()
        }
    }

    private fun tableNames(database: SQLiteDatabase, skip: Set<String>): List<String> =
        query(
            database,
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' " +
                "AND name NOT LIKE 'android_%'",
        ) { it.getString(0) }
            .filter { it !in skip }
            .sorted()

    private fun Cursor.str(column: String): String = getColumnIndex(column).takeIf { it >= 0 && !isNull(it) }
        ?.let { getString(it) }
        .orEmpty()

    private fun Cursor.long(column: String): Long = getColumnIndex(column).takeIf { it >= 0 && !isNull(it) }
        ?.let { getLong(it) }
        ?: 0L

    private fun Cursor.int(column: String): Int = getColumnIndex(column).takeIf { it >= 0 && !isNull(it) }
        ?.let { getInt(it) }
        ?: 0

    private fun String.quoted(): String = "\"" + replace("\"", "\"\"") + "\""

    // --- json ----------------------------------------------------------------------------------------

    private fun parseJsonObject(text: String): Map<String, Any?>? =
        runCatching { JSON.parseToJsonElement(text) as? JsonObject }
            .getOrNull()
            ?.let { obj -> obj.mapValues { (_, value) -> value.toKotlin() } }

    /**
     * Flattens a [JsonElement] into the primitives `:js-source` knows how to persist.
     *
     * Objects become maps, arrays become lists, and primitives become [Boolean] / [Long] / [Double] /
     * [String] — matching what [JsSourceManager] expects for a `.data` payload.
     */
    private fun JsonElement.toKotlin(): Any? = when (this) {
        is JsonObject -> mapValues { (_, value) -> value.toKotlin() }
        is JsonArray -> map { it.toKotlin() }
        is JsonPrimitive -> when {
            isString -> content
            content == "true" -> true
            content == "false" -> false
            content == "null" -> null
            else -> content.toLongOrNull() ?: content.toDoubleOrNull() ?: content
        }
    }

    /** Parses Venera's `local_favorite` timestamp, which is a local-time `yyyy-MM-dd HH:mm:ss`. */
    private fun parseDate(text: String): Long? =
        runCatching {
            java.time.LocalDateTime.parse(text.replace(' ', 'T'))
                .atZone(java.time.ZoneId.systemDefault())
                .toInstant()
                .toEpochMilli()
        }.getOrNull()

    /**
     * Splits Venera's `tags` column into genre names.
     *
     * The column is a comma-separated bag that mixes real tags with per-source metadata, and the two
     * flavours are formatted differently:
     *
     * ```
     * Tag:全彩,Tag:中文,View:903126,Author:某作者,Work:某作品,Actor:某演员,ahegao,同人
     * ```
     *
     * So a **blacklist** of metadata prefixes is the correct rule, not a `Tag:` whitelist — sources
     * like nhentai and ehentai write bare tags (`同人`, `ahegao`, `big breasts`), and a whitelist would
     * silently discard every one of them. Verified against a real backup: 261 `Tag:`-branded entries
     * alongside 2054 bare ones, plus 62 metadata entries across `View`/`Work`/`Author`/`Actor`.
     */
    private fun parseTags(raw: String): List<String> =
        raw.split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() && METADATA_PREFIXES.none { prefix -> it.startsWith(prefix) } }
            .map { it.removePrefix("Tag:") }
            .filter { it.isNotEmpty() }

    companion object {
        private const val SCRATCH_DIR_NAME = "venera_import"
        private const val ARCHIVE_FILE_NAME = "archive.zip"
        private const val CONTENT_DIR_NAME = "data"
        private const val COMIC_SOURCE_DIR = "comic_source"
        private const val COPY_BUFFER_SIZE = 64 * 1024
        private const val MAX_ENTRY_BYTES = 64L * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 256L * 1024 * 1024
        private const val UNORDERED_BASE = 100_000L

        /**
         * Non-tag values that ride along in the `tags` column. `View:` is a hit counter, `Work:` the
         * work title, `Author:`/`Actor:` belong to the author and cast columns of the detail page.
         */
        private val METADATA_PREFIXES = listOf("View:", "Work:", "Author:", "Actor:")

        private val JSON = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}
