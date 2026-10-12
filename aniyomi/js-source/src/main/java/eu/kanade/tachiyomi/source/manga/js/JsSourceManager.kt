package eu.kanade.tachiyomi.source.manga.js

import android.content.Context
import android.util.Log
import eu.kanade.tachiyomi.source.MangaSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale

/**
 * Registry + loader for Venera-style JS comic sources.
 *
 * This is the parallel of Aniyomi's `MangaExtensionManager`, but WITHOUT the APK/class-loader
 * mechanism: a `.js` source is parsed at runtime and wrapped in a [JsMangaSource].
 *
 * The resulting `MangaSource` list is merged into `AndroidMangaSourceManager.sourcesMapFlow`
 * so the sources show up in Browse / GlobalSearch / Library with no UI changes.
 *
 * Storage layout (mirrors Venera):
 * ```
 * filesDir/comic_source/<fileName>.js     ← the source script
 * filesDir/comic_source/<key>.data        ← per-source persisted state (JSON)
 * ```
 */
object JsSourceManager {

    private const val TAG = "JsSourceManager"

    private const val DIR_NAME = "comic_source"

    private var engine: JsEngine? = null
    private var sourceDir: File? = null

    private val _sources = mutableListOf<JsMangaSource>()

    /** Widened view consumed by the source registry; JS-specific fields are hidden behind it. */
    val sources: List<MangaSource> get() = _sources

    /** Concrete view used internally (update checks, metadata) where `key` / `version` are needed. */
    val jsSources: List<JsMangaSource> get() = _sources

    /** Observable snapshot for the management UI. */
    private val _installed = MutableStateFlow<List<JsSourceInfo>>(emptyList())
    val installed: StateFlow<List<JsSourceInfo>> = _installed.asStateFlow()

    /** Per-source persisted state (settings + `ComicSource.saveData`), keyed by source key. */
    private val dataStore = mutableMapOf<String, MutableMap<String, Any?>>()

    /** Maps a source `key` back to the `.js` file it came from, so we can update/delete it. */
    private val keyToFile = mutableMapOf<String, File>()

    /** Reflected `settings` / `account` declarations, keyed by source key. */
    private val metaByKey = mutableMapOf<String, JsSourceMeta>()

    /** Observable config UI state; bumped whenever settings or login state change. */
    private val _configVersion = MutableStateFlow(0)
    val configVersion: StateFlow<Int> = _configVersion.asStateFlow()

    /**
     * Fire-and-forget scope for the per-source `init()` call (see [scheduleSourceInit]).
     *
     * `init()` is by contract *not awaited* (Venera schedules it with `Future.delayed(50ms)` and
     * discards the future), and it may perform real network I/O, so it must never run on whatever
     * thread happened to register the source.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Keys whose `init()` has already been dispatched **for the current JS realm**. */
    private val initDone = mutableSetOf<String>()

    fun init(context: Context) {
        if (engine != null) return
        val e = JsEngine(context)
        engine = e
        val dir = File(context.filesDir, DIR_NAME).apply { mkdirs() }
        sourceDir = dir
        loadFrom(dir)
    }

    /** Scan a directory of `*.js` files and load each as a source. */
    private fun loadFrom(dir: File) {
        if (!dir.isDirectory) return
        dir.listFiles { f -> f.isFile && f.extension == "js" }
            ?.sortedBy { it.name }
            ?.forEach { file ->
                runCatching { register(jsCode = file.readText(), file = file) }
            }
        // Reflect settings/account once, up front. Sources read `loadSetting(...)` synchronously, and
        // that path only consults the cache, so it must be warm before any source code executes —
        // including before `init()`, which reads `refreshDomainsOnStart` the same way.
        warmMeta()
        // Venera runs each source's `init()` right after parsing it. Sources use it to build state
        // that is not persisted (jm.js: the API domain list); without it they throw before their
        // first request. Dispatched here — after `warmMeta()` — and never awaited.
        _sources.forEach { scheduleSourceInit(it.key) }
        refreshInstalled()
    }

    /**
     * Reflects metadata for every registered source, off the JS thread.
     *
     * Also hands each source its [JsSourceMeta] via [JsMangaSource.filterMeta]. That is **the only
     * place** browse filters may be built from: `getFilterList()` is called on the main thread
     * (ScreenModel constructor + Compose click handlers) and must never evaluate QuickJS — see
     * [JsMangaSource.filterMeta] for the deadlock this avoids.
     */
    private fun warmMeta() {
        _sources.forEach { source ->
            runCatching {
                meta(source.key)?.let { source.filterMeta = it }
            }
        }
    }

    // --- source bootstrap (`ComicSource.init`) ----------------------------------------------------

    /**
     * Schedules the source's own `init()` — the hook every Venera source uses to prepare state that
     * is **not** persisted anywhere and therefore cannot be recovered by `loadData`.
     *
     * ### Why this exists (the bug that made 禁漫 登录 fail with `cannot read property '0' of undefined`)
     *
     * `venera/lib/foundation/comic_source/parser.dart` calls, right after parsing a source:
     * ```dart
     * await source.loadData();
     * if (_checkExists("init")) {
     *   Future.delayed(const Duration(milliseconds: 50), () {
     *     JsEngine().runCode("ComicSource.sources.$_key.init()");
     *   });
     * }
     * ```
     * We never did. For `jm.js` that omission is fatal, because its API base URL is built from a
     * **static class field that only `init()` ever populates**:
     * ```js
     * get baseUrl() {
     *     let index = parseInt(this.loadSetting('apiDomain')) - 1   // default "1" -> 0
     *     return `https://${JM.apiDomains[index]}`                  // JM.apiDomains never declared
     * }
     * async init() {
     *     if (this.loadSetting('refreshDomainsOnStart')) await this.refreshApiDomains(false)
     * }
     * ```
     * `JM.apiDomains` has no declared initialiser — `refreshApiDomains()` hands the (fetched, or
     * fallback) server list to `overwriteApiDomains()`, which is the only writer. With `init()`
     * never called, the getter evaluates `undefined[0]` and throws
     * `cannot read property '0' of undefined` — synchronously, before a single byte hits the
     * network. Every entry point that touches `baseUrl` (登录, 搜索, 详情, 收藏) dies the same way,
     * which is why `login` "failed" in ~10 ms with no HTTP request in the log at all.
     *
     * Note the index in the message: `'0'` and not `'NaN'` proves `loadSetting('apiDomain')` *did*
     * resolve (to its declared default `"1"`), so this is not a settings bug — only `apiDomains`
     * was missing.
     *
     * ### Ordering requirement
     *
     * `init()` reads `refreshDomainsOnStart` through `loadSetting`, and that path only consults the
     * **cached** metadata (see [settingValue] / [metaIfCached]). If the cache is cold, the setting
     * resolves to `null`, `init()` silently skips `refreshApiDomains`, and `apiDomains` stays
     * undefined — i.e. the failure above would persist even with the hook wired up. So callers must
     * [warmMeta] first; [runSourceInit] re-warms as a belt-and-braces measure.
     *
     * @param key source `key`; ignored if no engine/source exists for it.
     */
    private fun scheduleSourceInit(key: String) {
        if (!initDone.add(key)) return
        scope.launch { runSourceInit(key) }
    }

    /**
     * `ComicSource.sources[key].init()`, pumped like every other source entry point.
     *
     * Deliberately uses [JsEngine.evalAwaiting] and ignores the value: results are reported by the
     * source through `UI.*` (jm.js shows a dialog / message when the domain refresh fails), and
     * `init()` is documented as fire-and-forget. The return value is only logged, so a source whose
     * `init()` rejects is diagnosable from Logcat instead of vanishing.
     */
    private suspend fun runSourceInit(key: String) {
        val e = engine ?: return
        try {
            runCatching { meta(key) } // ensure declared `default`s are cached before init() reads them
            val outcome = runCatching { e.evalAwaiting("ComicSource.sources[${key.jsQuote()}].init()") }
            JsDebugLog.d(
                TAG,
                "source init($key) -> " +
                    (outcome.exceptionOrNull()?.let { "threw ${it.message}" } ?: "settled(${outcome.getOrNull()})"),
            )
        } finally {
            // Release the eval gate even when init() throws: a source whose init failed must fail
            // visibly in the caller's own request, not hang every later call behind the gate.
            _sources.firstOrNull { it.key == key }?.initGate?.complete(Unit)
        }
        // Deliberately AFTER the gate is released: this can cost a round trip per part, and the
        // source should not keep every other call waiting behind it.
        runCatching { resolveCategoryOptions(key) }
            .onFailure { JsDebugLog.d(TAG, "optionLoader($key) failed: ${it.message}") }
    }

    /**
     * Reflects each `category.parts[*]`'s `categoryComics.optionLoader`, so parts that need
     * **several** option values can be driven from the filter UI.
     *
     * ### Why「每週必看」cannot work without this
     *
     * jm's weekly listing takes **two** option values:
     * ```js
     * load: async (category, param, options, page) => {
     *     if (category !== "每週必看") { ... } else {
     *         let res = await this.get(`${this.baseUrl}/week/filter?id=${options[0]}&type=${options[1]}&page=0`)
     * ```
     * and its `optionLoader` returns the two groups that fill them — 時間 (fetched live from
     * `GET /week`, ~258 entries of `"<id>-2026第258期09.25 - 09.18"`) and 類型 (日漫/韓漫/其他).
     * Pass a single value and the request goes out as `&type=undefined`.
     *
     * ### Both timing constraints matter
     *
     *  • **After `init()`** — the loader hits `baseUrl`, which jm derives from `JM.apiDomains`, a
     *    field only `init()` ever populates. Resolving earlier issues `https://undefined`.
     *  • **Never on demand** — `getFilterList()` runs on the main thread and must not evaluate
     *    QuickJS (S2 self-deadlock); see [JsMangaSource.filterMeta]. So the groups are resolved
     *    once here and read back as plain Kotlin.
     *
     * Failures degrade to "no dynamic groups": the part still renders, just without its extra
     * selects. A source whose `optionLoader` is expensive simply pays it once per app start.
     */
    private suspend fun resolveCategoryOptions(key: String) {
        val e = engine ?: return
        val source = _sources.firstOrNull { it.key == key } ?: return
        // One call per DISTINCT part name — jm declares「特殊PLAY」twice but both are the same kind.
        val parts = source.filterMeta.categoryParts.distinctBy { it.group }
        if (parts.isEmpty()) return

        val resolved = mutableMapOf<String, List<JsOptionGroup>>()
        for (part in parts) {
            // The loader fetches live data, so it must be awaited, not read synchronously.
            val outcome = runCatching {
                e.evalAwaitingResult(
                    "ComicSource.sources[${key.jsQuote()}].categoryComics.optionLoader(" +
                        "${part.category.jsQuote()}, ${(part.param ?: "").jsQuote()})",
                )
            }.getOrNull() as? JsEngine.AwaitResult.Settled ?: continue

            val groups = outcome.value as? List<*> ?: continue
            val parsed = groups.mapNotNull { group ->
                val m = group as? Map<*, *> ?: return@mapNotNull null
                val label = m["label"]?.toString().orEmpty()
                val options = (m["options"] as? List<*>)
                    ?.mapNotNull { it?.toString() }
                    ?.takeIf { it.isNotEmpty() }
                    ?: return@mapNotNull null
                JsOptionGroup(label, options)
            }
            if (parsed.isNotEmpty()) resolved[part.group] = parsed
        }

        if (resolved.isNotEmpty()) {
            source.filterMeta = source.filterMeta.copy(dynamicOptionGroups = resolved)
            JsDebugLog.d(
                TAG,
                "optionLoader($key): " +
                    resolved.entries.joinToString { "${it.key}=${it.value.size}组" },
            )
        }
    }

    // --- install / update / delete (used by the management UI) ------------------------------------

    /**
     * Installs (or replaces) a JS source from raw code, writing it to `comic_source/`.
     *
     * @param jsCode the source script.
     * @param fileName target file name; defaults to `<key>.js`.
     * @return the registered source, or `null` if the script could not be parsed.
     */
    fun install(jsCode: String, fileName: String? = null): JsMangaSource? {
        val dir = sourceDir ?: return null
        // Parse first so we don't write an invalid file to disk and then fail registration.
        val source = register(jsCode, file = null) ?: return null

        val name = fileName?.takeIf { it.endsWith(".js") } ?: "${source.key}.js"
        val file = File(dir, name)
        // A `key` must map to exactly one file. Venera indexes can list two files sharing a key
        // (e.g. copy_manga.js / copy_manga_multi_accounts.js, both `key = "copy_manga"`), and the
        // stale one would otherwise stay on disk and silently win the next startup scan
        // (loadFrom registers files in name order, last one wins the key).
        keyToFile[source.key]?.takeIf { it.absolutePath != file.absolutePath }?.delete()
        runCatching { file.writeText(jsCode) }
        keyToFile[source.key] = file
        // A replaced script is a new class in the realm, so any transform it produced under the old
        // script must not be re-served. (The cache key already hashes the script, so this is belt
        // and braces — it also frees the old entries' memory immediately.)
        ImageTransformCache.evictSource(source.key)
        // Hand the new source its reflected metadata. Warming the cache alone (`meta(...)`) is NOT
        // enough: `warmMeta()` only runs on startup / `reload()`, so a source installed at runtime
        // kept an empty `JsMangaSource.filterMeta` — which silently degraded BOTH「热门」and
        // 「最近更新」to the same explore page (no ranking, no browsable category ⇒ identical lists)
        // and hid the 筛选 chip until the next app start.
        runCatching { meta(source.key)?.let { source.filterMeta = it } }
        // A replaced script is a *new* class in the realm, so any static state its previous `init()`
        // produced is gone; let the new one bootstrap too.
        initDone.remove(source.key)
        scheduleSourceInit(source.key)
        refreshInstalled()
        return source
    }

    /** Deletes an installed source: removes its `.js` file and unregisters it. */
    fun uninstall(key: String) {
        keyToFile.remove(key)?.delete()
        sourceDir?.let { dir ->
            // Defensive: also drop any file whose declared name matches, in case the map was stale.
            dir.listFiles { f -> f.isFile && f.extension == "js" }?.forEach { f ->
                if (f.name == "$key.js") f.delete()
            }
            // Same for the persisted settings/login blob.
            File(dir, "$key.data").delete()
        }
        _sources.removeAll { it.key == key }
        dataStore.remove(key)
        metaByKey.remove(key)
        initDone.remove(key)
        // Free any transform results this source produced; its pixels are unreachable now.
        ImageTransformCache.evictSource(key)
        engine?.let { e -> runCatching { e.evalBlocking("delete ComicSource.sources['$key'];") } }
        refreshInstalled()
        _configVersion.update { it + 1 }
    }

    /** Reloads all sources from disk, dropping anything no longer present. */
    fun reload() {
        _sources.clear()
        keyToFile.clear()
        metaByKey.clear()
        // Every script is re-evaluated into a fresh class, so every cached transform belongs to a
        // realm that no longer exists — drop the whole cache rather than leak stale pixel buffers.
        ImageTransformCache.clear()
        // `reload()` re-evaluates every script, so each class (and any static state `init()` built on
        // it, e.g. jm.js's `apiDomains`) is brand new — the cached keys would wrongly suppress it.
        initDone.clear()
        sourceDir?.let { loadFrom(it) } ?: refreshInstalled()
    }

    // --- parsing ----------------------------------------------------------------------------------

    /**
     * Parses one JS source and registers it.
     *
     * Venera's parser finds the `class X extends ComicSource` line, instantiates it, then reads
     * `name` / `key` / `version`. We do the same here via [JsEngine.evalBlocking].
     *
     * @return the registered [JsMangaSource], or `null` if the script could not be parsed.
     */
    private fun register(jsCode: String, file: File?): JsMangaSource? {
        val e = engine ?: return null
        val className = jsCode.lineSequence().map { it.trim() }
            .firstOrNull { it.startsWith("class ") && it.contains("extends ComicSource") }
            ?.substringAfter("class ")?.substringBefore(" extends")?.trim()
            ?: return null

        e.evalBlocking("(() => { $jsCode; this['__temp'] = new $className(); }).call(this);")
        val name = e.evalBlocking("this['__temp'].name")?.toString() ?: return null
        val key = e.evalBlocking("this['__temp'].key")?.toString() ?: return null
        val version = e.evalBlocking("this['__temp'].version")?.toString().orEmpty()
        e.evalBlocking("ComicSource.sources['$key'] = this['__temp'];")

        file?.let { keyToFile[key] = it }

        // Restore settings/login written by an earlier session before anything reads them.
        restore(key)

        _sources.firstOrNull { it.key == key }?.let {
            // Already registered (startup double-load or re-install of the same key): refresh meta.
            it.version = version
            it.name = name
            return it
        }

        val source = JsMangaSource(
            id = JsMangaSource.keyToId(key),
            name = name,
            lang = "all", // TODO(M4): expose a `lang` field on the JS side
            key = key,
            engine = e,
            version = version,
        )
        _sources += source
        return source
    }

    /** Convenience overload kept for simple callers (e.g. adb-pushed files, tests). */
    fun add(jsCode: String): JsMangaSource? = register(jsCode, file = null)

    private fun refreshInstalled() {
        _installed.update { _ ->
            _sources.map {
                JsSourceInfo(
                    key = it.key,
                    name = it.name,
                    version = it.version,
                    fileName = keyToFile[it.key]?.name,
                    isInstalled = true,
                    isLoggedIn = isLogged(it.key),
                )
            }
        }
    }

    // --- settings / account reflection -------------------------------------------------------------

    /**
     * Reads the source's `settings` and `account` declarations out of the live JS object.
     *
     * Venera re-evaluates `ComicSource.sources.<key>.settings` on every render, so sources may build
     * the object dynamically; we deliberately do the same rather than caching it inside JS.
     *
     * @return the parsed metadata, or `null` if the source is unknown to the engine.
     */
    fun meta(key: String): JsSourceMeta? {
        val meta = metaByKey[key] ?: parseMeta(key)?.also { metaByKey[key] = it }
        return meta
    }

    /**
     * Metadata without ever touching the engine.
     *
     * [JsMessageDispatcher] handles `load_setting` **on the JS thread**, and the QuickJS wrapper
     * rejects re-entrant access from that same thread — so the dispatch path must use this variant
     * and fall back to `null` defaults rather than reflecting. Reflecting happens from the UI
     * coroutine instead, which is safely off-thread.
     */
    internal fun metaIfCached(key: String): JsSourceMeta? = metaByKey[key]

    private fun parseMeta(key: String): JsSourceMeta? {
        val e = engine ?: return null
        val root = "ComicSource.sources['${key.replace("'", "\\'")}']"

        // NOTE: the QuickJS wrapper returns nested objects as `JSObject`, not `Map`, so every value
        // must go through `toKotlinValue()`. Casting directly makes `settings` look empty.
        val settingsProbe = runCatching { e.evalForValueBlocking("$root.settings") }
        Log.d(
            TAG,
            "meta[$key] settings -> ${settingsProbe.getOrNull()?.javaClass?.name} " +
                "keys=${(settingsProbe.getOrNull() as? Map<*, *>)?.keys} " +
                "err=${settingsProbe.exceptionOrNull()}",
        )

        val translations = parseTranslations(e, root)
        Log.d(TAG, "meta[$key] translation locales=${translations.keys}")

        // Order matters: Venera renders settings in declaration order. `Object.keys()` is
        // guaranteed by spec to follow insertion order for string keys, whereas the wrapper's
        // `getNames()` (used by `JSObject.toMap()`) does NOT preserve it — which is what scrambled
        // the rows (图片分流 jumped above 启动时刷新域名列表).
        val orderedKeys = runCatching { e.evalForValueBlocking("Object.keys($root.settings || {})") }
            .getOrNull()
            ?.let { it as? List<*> }
            ?.mapNotNull { it?.toString() }
            .orEmpty()

        val settingsRaw = settingsProbe.getOrNull() as? Map<*, *> ?: emptyMap<Any?, Any?>()

        // Drive the iteration by `orderedKeys`, falling back to map order for anything missing.
        val effectiveKeys = (orderedKeys + settingsRaw.keys.mapNotNull { it?.toString() })
            .distinct()
        Log.d(TAG, "meta[$key] settings order=$effectiveKeys")

        val settings = effectiveKeys.mapNotNull { name ->
            val rawValue = settingsRaw[name] ?: settingsRaw.entries
                .firstOrNull { it.key?.toString() == name }?.value
                ?: return@mapNotNull null
            val obj = rawValue as? Map<*, *> ?: run {
                Log.w(TAG, "meta[$key] setting '$name' is ${rawValue.javaClass.name}, not a Map")
                return@mapNotNull null
            }
            parseSettingItem(name, obj, translations)
        }
        Log.d(TAG, "meta[$key] parsed ${settings.size} items: ${settings.map { it.key }}")

        return JsSourceMeta(
            settings = settings,
            accountMode = parseAccountMode(e, root),
            searchOptionList = parseSearchOptions(e, root),
            categoryParts = parseCategoryParts(e, root),
            enableRanking = runCatching { e.evalForValueBlocking("$root.category.enableRankingPage") }
                .getOrNull()?.toString() == "true",
            rankingOptions = runCatching {
                e.evalForValueBlocking(
                    "($root.categoryComics && $root.categoryComics.ranking && " +
                        "$root.categoryComics.ranking.options) || []",
                )
            }.getOrNull()?.let { it as? List<*> }?.mapNotNull { it?.toString() }.orEmpty(),
            exploreEntries = parseExploreEntries(e, root),
            registerWebsite = runCatching { e.evalForValueBlocking("$root.account.registerWebsite") }
                .getOrNull()?.toString()?.takeIf { it.isNotBlank() && it != "null" && it != "undefined" },
            translations = translations,
        )
    }

    /**
     * Reads `search.optionList` — the source's own search-time option groups (jm.js: 排序).
     *
     * ### Why this must be reflected here and not on demand
     *
     * `CatalogueSource.getFilterList()` is invoked from a Compose click handler and from
     * `BrowseMangaSourceScreenModel`'s **`init`**, i.e. on the main thread. Evaluating QuickJS there
     * would re-enter the engine from a thread that may already be draining a job — the exact
     * self-deadlock S2 warns about. So the option groups are captured once here, during
     * [warmMeta], which already runs off the JS thread at source load.
     *
     * Each group is returned as its raw `options` array; entries are `"value-text"` and the value
     * (left of the first `-`) is what the source splices into the request.
     */
    private fun parseSearchOptions(e: JsEngine, root: String): List<List<String>> {
        val groups = runCatching { e.evalForValueBlocking("($root.search && $root.search.optionList) || []") }
            .getOrNull() as? List<*> ?: return emptyList()
        return groups.mapNotNull { group ->
            val m = group as? Map<*, *> ?: return@mapNotNull null
            val options = m["options"] as? List<*> ?: return@mapNotNull null
            options.mapNotNull { it?.toString() }.takeIf { it.isNotEmpty() }
        }
    }

    /**
     * Reads `category.parts` and flattens it into [JsCategoryPart] rows.
     *
     * Venera's `parser.dart` reads each part's `categories` / `itemType` / optional `categoryParams`
     * in parallel arrays, so index `i` of `categoryParams` belongs to `categories[i]`. `type` other
     * than `"fixed"` (e.g. `"random"`) is skipped — Venera only ever presents fixed parts as a
     * browsable list.
     */
    private fun parseCategoryParts(e: JsEngine, root: String): List<JsCategoryPart> {
        val parts = runCatching { e.evalForValueBlocking("($root.category && $root.category.parts) || []") }
            .getOrNull() as? List<*> ?: return emptyList()
        val out = mutableListOf<JsCategoryPart>()
        for (part in parts) {
            val m = part as? Map<*, *> ?: continue
            if (m["type"]?.toString() != "fixed") continue
            val group = m["name"]?.toString() ?: continue
            val itemType = m["itemType"]?.toString() ?: continue
            val categories = m["categories"] as? List<*> ?: continue
            val params = m["categoryParams"] as? List<*>
            categories.forEachIndexed { i, c ->
                val name = c?.toString() ?: return@forEachIndexed
                out.add(JsCategoryPart(group, itemType, name, params?.getOrNull(i)?.toString()))
            }
        }
        return out
    }

    /**
     * Reads the source's `explore` array — each entry's `title` and, crucially, its **`type`**.
     *
     * The type is not cosmetic: Venera calls the three kinds differently (`load()` with no argument
     * for `multiPartPage`, `load(page)` 1-based for `multiPageComicList`, `load(index)` 0-based for
     * `mixed`). Reflecting it once here is what lets [JsMangaSource] build the right expression;
     * assuming one convention for all three is how a paginated source ends up permanently off by
     * one. See [JsExploreEntry] for the full table.
     *
     * Entries without a `load` function are dropped — nothing can be called on them.
     */
    private fun parseExploreEntries(e: JsEngine, root: String): List<JsExploreEntry> {
        val raw = runCatching { e.evalForValueBlocking("$root.explore || []") }
            .getOrNull() as? List<*> ?: return emptyList()
        return raw.mapIndexedNotNull { i, entry ->
            val m = entry as? Map<*, *> ?: return@mapIndexedNotNull null
            val hasLoad = runCatching {
                e.evalForValueBlocking("typeof (($root.explore || [])[$i] || {}).load === 'function'")
            }.getOrNull()?.toString() == "true"
            if (!hasLoad) return@mapIndexedNotNull null
            JsExploreEntry(
                index = i,
                title = m["title"]?.toString().orEmpty(),
                type = m["type"]?.toString().orEmpty(),
            )
        }
    }

    /**
     * Reads the source's `translation` table: `{ "zh_CN": { "English": "中文" } }`.
     *
     * Sources declare `settings` titles in English and localise them here, so without this the
     * config page shows English where Venera shows Chinese.
     */
    private fun parseTranslations(e: JsEngine, root: String): Map<String, Map<String, String>> {
        val raw = runCatching { e.evalForValueBlocking("$root.translation") }
            .getOrNull() as? Map<*, *> ?: return emptyMap()
        return raw.mapNotNull { (locale, table) ->
            val map = (table as? Map<*, *>)?.entries
                ?.mapNotNull { (k, v) -> k?.toString()?.let { kk -> v?.toString()?.let { vv -> kk to vv } } }
                ?.toMap()
                ?: return@mapNotNull null
            locale?.toString()?.let { it to map }
        }.toMap()
    }

    /**
     * Builds one setting row from its raw JS object.
     *
     * Every user-visible string ([JsSettingItem.title], option `text`, `buttonText`) is resolved
     * through the source's own `translation` table, mirroring Venera's `String.ts(sourceKey)`.
     * Translating here (rather than in the composable) keeps dialogs and rows consistent.
     */
    private fun parseSettingItem(
        key: String,
        raw: Map<*, *>,
        translations: Map<String, Map<String, String>>,
    ): JsSettingItem? {
        fun tr(text: String): String = translate(text, translations)

        val title = raw["title"]?.toString()?.takeIf { it.isNotBlank() }?.let(::tr) ?: key
        return when (val type = raw["type"]?.toString()) {
            "select" -> {
                val options = (raw["options"] as? List<*>).orEmpty().mapNotNull { opt ->
                    val o = opt as? Map<*, *> ?: return@mapNotNull null
                    val value = o["value"]?.toString() ?: return@mapNotNull null
                    // `text` is optional in the spec: a source may rely on `value` alone (jm.js does
                    // this for its numeric API-domain options), so fall back to the value itself.
                    JsSettingItem.Select.Option(
                        value = value,
                        text = o["text"]?.toString()?.let(::tr) ?: value,
                    )
                }
                JsSettingItem.Select(key, title, options, raw["default"]?.toString())
            }

            "switch" -> JsSettingItem.Switch(key, title, raw["default"]?.let { it as? Boolean } ?: false)

            "input" -> JsSettingItem.Input(
                key = key,
                title = title,
                defaultValue = raw["default"]?.toString().orEmpty(),
                validator = raw["validator"]?.toString()?.takeIf { it.isNotBlank() },
            )

            "callback" -> JsSettingItem.Callback(
                key = key,
                title = title,
                buttonText = raw["buttonText"]?.toString()?.takeIf { it.isNotBlank() }?.let(::tr) ?: "执行",
            )

            else -> {
                Log.d(TAG, "Skipping setting '$key' of unsupported type '$type'")
                null
            }
        }
    }

    /** Resolves a source-declared string through the current locale, then the bare language. */
    private fun translate(raw: String, translations: Map<String, Map<String, String>>): String {
        if (translations.isEmpty()) return raw
        val locale = Locale.getDefault()
        val language = locale.language
        val country = locale.country
        val full = if (country.isNullOrEmpty()) language else "${language}_$country"
        return translations[full]?.get(raw)
            ?: translations[language]?.get(raw)
            ?: translations["en_US"]?.get(raw)
            ?: raw
    }

    /**
     * Applies Venera's precedence: `login` → `loginWithWebview` → `loginWithCookies`.
     *
     * ### Why this probes in JS instead of reading a converted Map
     *
     * `account.login` / `loginWithWebview.login` etc. are **functions**, and the QuickJS wrapper's
     * `QuickJSObject.convertToMap()` *drops every function-valued key* — it calls
     * `JSFunction.release()` and then jumps straight to the next iteration (verified in the
     * bytecode of `wrapper-java-3.2.0`, offsets 228–246). So a converted `account` map comes back
     * **empty for password-login sources**: `account["login"]` is `null` even though the source
     * declares it, all three mode checks fail, and the login row silently disappears.
     *
     * The fix is to ask JS for primitives that survive marshalling — booleans and a `List<String>`
     * of cookie field names — mirroring Venera's own detection, which is
     * `X !== null && X !== undefined` on the *live* object (see `parser.dart::_checkExists`).
     */
    private fun parseAccountMode(e: JsEngine, root: String): JsAccountMode? {
        // One evaluation returns everything we need as plain primitives.
        val probe = runCatching {
            e.evalForValueBlocking(
                """
                (function () {
                    var a = $root.account;
                    if (a === null || a === undefined) return null;
                    return {
                        has: true,
                        // `typeof` is the only reliable test: the value is a function, and a
                        // converted map would have dropped it.
                        login: typeof a.login === 'function',
                        webview: a.loginWithWebview !== null && a.loginWithWebview !== undefined,
                        webviewUrl: (a.loginWithWebview || {}).url || null,
                        cookieFields: (a.loginWithCookies && a.loginWithCookies.fields) || null,
                    };
                })()
                """.trimIndent(),
            )
        }.getOrNull() as? Map<*, *>

        if (probe == null) {
            // Never had an `account` declaration at all.
            if (runCatching { e.evalForValueBlocking("$root.account") }.getOrNull() == null) {
                Log.d(TAG, "account probe: source declares no account")
            } else {
                Log.w(TAG, "account probe: account present but probe marshalling failed")
            }
            return null
        }

        Log.d(
            TAG,
            "account probe: login=${probe["login"]} webview=${probe["webview"]} " +
                "cookieFields=${probe["cookieFields"]}",
        )

        if (probe["login"] == true) return JsAccountMode.Password

        if (probe["webview"] == true) {
            return JsAccountMode.Webview(probe["webviewUrl"]?.toString().orEmpty())
        }

        val fields = (probe["cookieFields"] as? List<*>)?.mapNotNull { it?.toString() }
        if (!fields.isNullOrEmpty()) return JsAccountMode.Cookies(fields)

        // The source declared an `account` object but none of the three login modes are usable.
        Log.w(TAG, "account present but no login/loginWithWebview/loginWithCookies detected")
        return null
    }

    // --- setting values ---------------------------------------------------------------------------

    /**
     * Reads one setting value using Venera's exact fallback chain:
     * saved value → the source's declared `default` → `null`.
     *
     * This is also what the JS-side `loadSetting(key)` resolves to (see [JsMessageDispatcher]).
     *
     * Safe to call from the JS thread: it reads the *cached* metadata only. If the cache is cold the
     * declared default is simply omitted, and the caller sees `null` — a benign miss, since the UI
     * warms the cache before any source can run.
     */
    fun settingValue(key: String, settingKey: String): Any? =
        dataStore[key]?.get(settingKey) ?: declaredDefault(key, settingKey)

    private fun declaredDefault(key: String, settingKey: String): Any? =
        metaIfCached(key)?.settings?.firstOrNull { it.key == settingKey }?.let { item ->
            when (item) {
                is JsSettingItem.Select -> item.defaultValue
                is JsSettingItem.Switch -> item.defaultValue
                is JsSettingItem.Input -> item.defaultValue
                is JsSettingItem.Callback -> null
            }
        }

    /**
     * Persists a setting value chosen in the UI.
     *
     * Venera has no JS write API for settings on purpose (`save_data` even rejects `"setting"`), so
     * the write happens here and only the *read* path is exposed to JS.
     *
     * ### Why this re-runs the source's `init()`
     *
     * A source is allowed to read a setting **once** and cache it in a static — jm.js does exactly
     * that for `imageStream` (read inside `refreshImgUrl`, which only runs at `init()` / 刷新域名).
     * Without the re-dispatch, flipping such a setting silently kept the old value until the next
     * app start — reported as「改了配置没有马上生效」. `baseUrl`-style getters (`loadSetting` per
     * call) are unaffected either way; the re-init is cheap (jm's is ~0ms now) and matches what
     * [importData] already does for the same reason.
     */
    @Synchronized
    fun saveSetting(key: String, settingKey: String, value: Any?) {
        dataStore.getOrPut(key) { mutableMapOf() }[settingKey] = value
        persist(key)
        _configVersion.update { it + 1 }
        // Same re-dispatch as [importData]: cached-in-init settings must see the new value.
        initDone.remove(key)
        scheduleSourceInit(key)
    }

    /**
     * Runs the source's `settings.<settingKey>.callback` (the `callback` setting type).
     *
     * ### Why this returns an outcome instead of `Unit`
     *
     * Callbacks are usually `async () => this.doSomething()` and are the *only* user-visible action
     * on the config page that is not a plain field write — 刷新域名列表 is exactly this. Most of them
     * finish by calling `UI.showDialog` to report "Update Failed"/"Update Success", but a source may
     * also fail before reaching any UI call (bad network, thrown string, dead source). `Unit` made
     * those two cases indistinguishable, so a silent failure looked like a no-op button.
     *
     * Note the same trap as [login]: [JsEngine.evalAwaiting] never throws on a rejected promise, so
     * the rejection must be read off [JsEngine.AwaitResult].
     */
    suspend fun runSettingCallback(key: String, settingKey: String): CallbackOutcome {
        JsDebugLog.d(TAG, "runSettingCallback ENTER $key.$settingKey")
        val e = engine ?: run {
            JsDebugLog.d(TAG, "runSettingCallback ABORT: engine is null")
            return CallbackOutcome.Failed("JS 引擎未就绪")
        }

        val script = "(function () { var src = ComicSource.sources[${key.jsQuote()}]; " +
            "return src.settings[${settingKey.jsQuote()}].callback.call(src); })()"

        val outcome = runCatching {
            withContext(Dispatchers.IO) { e.evalAwaitingResult(script) }
        }.getOrElse {
            JsDebugLog.d(TAG, "runSettingCallback THREW: ${it.message}")
            return CallbackOutcome.Failed(it.message ?: it.toString())
        }

        val result = when (outcome) {
            // Unsettled after the tick budget: the source is stuck on a network retry loop.
            null -> CallbackOutcome.Failed("执行超时（源可能正在重试网络请求）")
            is JsEngine.AwaitResult.Rejected -> {
                Log.w(TAG, "callback $key.$settingKey rejected: ${outcome.message}")
                JsDebugLog.d(TAG, "runSettingCallback REJECTED: ${outcome.message}")
                CallbackOutcome.Failed(outcome.message)
            }
            is JsEngine.AwaitResult.Settled -> CallbackOutcome.Ok
        }
        JsDebugLog.d(TAG, "runSettingCallback EXIT -> ${result::class.simpleName}")
        return result
    }

    /**
     * Outcome of [runSettingCallback].
     *
     * `Ok` does NOT mean the user saw a success message — only that the callback itself ran to
     * completion. Most sources report their own result through `UI.showDialog`, which the dialog
     * channel renders; this outcome exists for the cases where nothing was ever shown.
     */
    sealed interface CallbackOutcome {
        data object Ok : CallbackOutcome
        data class Failed(val reason: String) : CallbackOutcome
    }

    // --- UI bridge (Venera's `UI.*`, raised from the JS thread) -----------------------------------

    /** Monotonic ids for `UI.showLoading` / `UI.cancelLoading` pairs. */
    private val loadingId = java.util.concurrent.atomic.AtomicLong(1)

    private val inputRequestId = java.util.concurrent.atomic.AtomicLong(1)

    /** Live dialog handles (JS `__dlgQueue` indices), so we can drop the JS copy on dismissal. */
    private val liveDialogs = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun nextLoadingId(): Long = loadingId.getAndIncrement()

    fun nextInputRequestId(): Long = inputRequestId.getAndIncrement()

    /**
     * Claims a `UI.showDialog` actions array from the JS-side queue, returning its queue index.
     *
     * The array is deliberately **not** copied into Kotlin: its entries hold `JSFunction` button
     * callbacks, and the wrapper's object-to-map marshaller drops function values (it calls
     * `release()` and skips them). Keeping the array in JS (`__dlgQueue`, populated by
     * [JsEngine.BRIDGE_SHIM]) is the only way to keep those buttons callable, and we re-enter JS
     * through [JsEngine.invokeDialogAction] when the user taps one.
     *
     * MUST run on the JS thread — it *is* on the JS thread, since the bridge invoked us synchronously.
     * Using [evalBlocking] here would submit to the same single-thread executor and deadlock.
     */
    internal fun registerDialogActions(hasActions: Boolean): String? {
        if (!hasActions) return null
        val e = engine ?: return null
        val slot = e.claimDialogActionsInline() ?: return null
        liveDialogs += slot
        return slot
    }

    /** Releases a claimed action array once its dialog is dismissed. */
    fun releaseDialogActions(handle: String?) {
        handle ?: return
        if (!liveDialogs.remove(handle)) return
        engine?.let { e -> runCatching { e.evalBlocking("globalThis.__dlgQueue[$handle] = null") } }
    }

    /**
     * Invokes dialog button [actionIndex] **on the JS thread**.
     *
     * Venera's contract: any action closes the dialog, and if the callback returns a promise the
     * button shows a spinner until it settles. The call is therefore pumped with the same slot
     * technique as [JsEngine.evalAwaiting], so `async` button bodies (禁漫's `Apply` →
     * `overwriteApiDomains` + `refreshImgUrl`) run past their first `await` instead of stalling.
     *
     * Failure note: sources frequently *throw plain strings* from these callbacks (禁漫's `get()`
     * does `throw 'Invalid Status Code: ' + res.status`), and some even start floating promises
     * inside them (`getApiHeaders` calls `dailyCheckIn(true)` without awaiting). So a rejected
     * outcome is normal here and must be swallowed with a log rather than surfaced.
     */
    suspend fun runUiDialogAction(handle: String, actionIndex: Int) {
        val e = engine ?: return
        if (handle !in liveDialogs) return
        withContext(Dispatchers.IO) {
            runCatching { e.invokeDialogAction(handle, actionIndex) }
                .onFailure { Log.w(TAG, "dialog action $actionIndex on $handle failed", it) }
        }
    }

    // --- account / login --------------------------------------------------------------------------

    /**
     * Runs the source's `account.login(account, pwd)`.
     *
     * ### Why this inspects the promise outcome instead of `runCatching`
     *
     * The obvious implementation —
     * ```kotlin
     * val ok = runCatching { e.evalAwaiting("$root.account.login(...)") }.isSuccess
     * ```
     * — is **wrong and silently so**. [JsEngine.evalAwaiting] never throws on a rejected promise:
     * it parks the rejection in its slot and returns normally. So `isSuccess` is `true` for *every*
     * outcome, including "network unreachable" and "wrong password". The effect was twofold:
     * bad credentials were **persisted as a logged-in session**, and the UI reported success, so
     * the user got no feedback whatsoever when a login actually failed.
     *
     * [JsEngine.evalAwaitingResult] returns the settled outcome explicitly, which is what lets us
     * distinguish the two cases and surface a real error message.
     *
     * Note the source contract: `login` is documented as "return any value to indicate success",
     * and failures surface as a **rejection** (often a plain string, e.g. 禁漫 throws from `post`).
     * A resolved `undefined` counts as success, matching Venera.
     */
    suspend fun login(key: String, account: String, password: String): LoginResult {
        JsDebugLog.d(TAG, "login ENTER $key (account='${account.take(3)}***')")
        val e = engine ?: run {
            JsDebugLog.d(TAG, "login ABORT: engine is null")
            return LoginResult.Failure("JS 引擎未就绪")
        }
        val root = "ComicSource.sources[${key.jsQuote()}]"
        val outcome = runCatching {
            withContext(Dispatchers.IO) {
                e.evalAwaitingResult("$root.account.login(${account.jsQuote()}, ${password.jsQuote()})")
            }
        }.getOrElse {
            JsDebugLog.d(TAG, "login THREW: ${it.message}")
            return LoginResult.Failure(it.message ?: it.toString())
        }

        val result = when (outcome) {
            null -> LoginResult.Failure("登录超时，请重试（源可能正在重试网络请求）")
            is JsEngine.AwaitResult.Rejected -> LoginResult.Failure(outcome.message)
            is JsEngine.AwaitResult.Settled -> {
                // Persist the credentials so `reLogin` can retry after a "Login expired" error.
                dataStore.getOrPut(key) { mutableMapOf() }["account"] = listOf(account, password)
                persist(key)
                notifyAccountChanged()
                LoginResult.Success
            }
        }
        JsDebugLog.d(TAG, "login EXIT -> ${result::class.simpleName}")
        return result
    }

    /** Outcome of [login]; carries the source's own message so the UI can show *why* it failed. */
    sealed interface LoginResult {
        data object Success : LoginResult
        data class Failure(val reason: String) : LoginResult
    }

    /** Cookie-mode login: validates the fields through the source, then records a logged-in flag. */
    suspend fun loginWithCookies(key: String, values: List<String>): Boolean {
        val e = engine ?: return false
        val root = "ComicSource.sources[${key.jsQuote()}]"
        val args = values.joinToString(", ") { it.jsQuote() }
        val result = runCatching { e.eval("$root.account.loginWithCookies.validate([$args])") }.getOrNull()
        // `validate` returns false for bad cookies; undefined/absent means the source did not object.
        if (result == false) return false
        markLoggedIn(key)
        return true
    }

    /** Called after a webview login reports success. */
    fun markLoggedIn(key: String) {
        dataStore.getOrPut(key) { mutableMapOf() }["account"] = "ok"
        persist(key)
        notifyAccountChanged()
    }

    suspend fun logout(key: String) {
        val e = engine
        runCatching { e?.eval("ComicSource.sources[${key.jsQuote()}].account.logout()") }
        dataStore[key]?.remove("account")
        persist(key)
        notifyAccountChanged()
    }

    /**
     * Announces an account-state change to the UI.
     *
     * **Both statements are load-bearing.** `_configVersion` only wakes the config screen so it can
     * re-read `meta`; the `isLoggedIn` flag that screen renders lives in `_installed`, which is
     * rebuilt *solely* by [refreshInstalled]. Bumping the version without refreshing `_installed`
     * made a **successful login look exactly like a failed one**: the screen re-read the same stale
     * `isLoggedIn = false`, kept the "登录" button, and never showed "已登录" — so the user had no
     * way to tell whether the credentials had worked. [uninstall] already did both, which is why
     * deleting a source always behaved correctly.
     */
    private fun notifyAccountChanged() {
        refreshInstalled()
        _configVersion.update { it + 1 }
    }

    // --- bridge callbacks (invoked from the JS thread via JsMessageDispatcher) --------------------

    @Synchronized
    fun data(key: String, dataKey: String): Any? = dataStore[key]?.get(dataKey)

    @Synchronized
    fun saveData(key: String, dataKey: String, value: Any?) {
        // Mirrors Venera: `save_data` must not be used for settings, which have their own path.
        if (dataKey == "setting") {
            Log.w("JsSourceManager", "Refusing save_data('setting'); use saveSetting() instead")
            return
        }
        dataStore.getOrPut(key) { mutableMapOf() }[dataKey] = value
        persist(key)
    }

    @Synchronized
    fun deleteData(key: String, dataKey: String) {
        dataStore[key]?.remove(dataKey)
        persist(key)
    }

    @Synchronized
    fun isLogged(key: String): Boolean = dataStore[key]?.get("account") != null

    /**
     * Bulk-imports a source's persisted state, merging on top of whatever is already there.
     *
     * Used when restoring a backup that carries per-source blobs (Venera's `comic_source/<key>.data`).
     * Keys present in [data] overwrite existing ones, keys not listed are left untouched, and a
     * `null` value removes the key — which matters for `"account"`, since [isLogged] is a pure
     * presence check and a literal `null` account must not read as "logged in".
     *
     * The caller is responsible for having translated the incoming blob into **our** layout: settings
     * live at the top level here, whereas Venera nests them under `"settings"`.
     */
    @Synchronized
    fun importData(key: String, data: Map<String, Any?>) {
        val store = dataStore.getOrPut(key) { mutableMapOf() }
        data.forEach { (dataKey, value) ->
            if (value == null) store.remove(dataKey) else store[dataKey] = value
        }
        persist(key)
        notifyAccountChanged()
        // Settings are read through `loadSetting`, which the source may call *once* at startup and
        // then cache in a static (jm.js: `baseUrl` resolves an index into `apiDomains`). Importing
        // writes them after the source has already `init()`-ed — `install()` runs before
        // `importData()` in the restore — so without re-dispatching, an imported `apiDomain` /
        // `imageStream` would be stored but never applied. Re-run the hook so the new values land.
        initDone.remove(key)
        scheduleSourceInit(key)
    }

    fun findByKey(key: String): JsMangaSource? = _sources.firstOrNull { it.key == key }

    // --- persistence ------------------------------------------------------------------------------

    /**
     * Writes a source's state to `comic_source/<key>.data` as JSON, mirroring Venera's layout so
     * settings and login survive a restart.
     */
    private fun persist(key: String) {
        val dir = sourceDir ?: return
        val snapshot = dataStore[key] ?: return
        runCatching {
            File(dir, "$key.data").writeText(encodeData(snapshot))
        }.onFailure { Log.e("JsSourceManager", "Failed to persist data for '$key'", it) }
    }

    /** Loads `comic_source/<key>.data` if present. Unknown/corrupt files are ignored. */
    private fun restore(key: String) {
        val file = sourceDir?.let { File(it, "$key.data") } ?: return
        if (!file.isFile) return
        val parsed = runCatching { decodeData(file.readText()) }.getOrNull() ?: return
        dataStore[key] = parsed
    }

    private fun encodeData(data: Map<String, Any?>): String =
        data.entries.joinToString(prefix = "{", postfix = "}") { (k, v) ->
            "${k.jsonQuote()}:${encodeValue(v)}"
        }

    private fun encodeValue(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Number -> value.toString()
        is String -> value.jsonQuote()
        is List<*> -> value.joinToString(prefix = "[", postfix = "]") { encodeValue(it) }
        is Map<*, *> -> value.entries.joinToString(prefix = "{", postfix = "}") { (k, v) ->
            "${k.toString().jsonQuote()}:${encodeValue(v)}"
        }
        else -> value.toString().jsonQuote()
    }

    /**
     * Minimal reader for the subset of JSON we write ourselves (objects/arrays/strings/numbers).
     * Deliberately dependency-free — the module has no kotlinx-serialization plugin.
     */
    private fun decodeData(text: String): MutableMap<String, Any?>? {
        val parser = MiniJson(text)
        val root = parser.parseValue() as? Map<*, *> ?: return null
        return root.entries.associateTo(mutableMapOf()) { (k, v) -> k.toString() to v }
    }
}

/** Escapes a Kotlin string into a JSON string literal. */
private fun String.jsonQuote(): String = buildString {
    append('"')
    for (c in this@jsonQuote) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
    append('"')
}

/**
 * Tiny recursive-descent JSON parser, sufficient for the `.data` files this class writes.
 * Kept local because the `:js-source` module deliberately avoids adding a serialization plugin.
 */
private class MiniJson(private val src: String) {

    private var pos = 0

    fun parseValue(): Any? {
        skipWs()
        if (pos >= src.length) return null
        return when (src[pos]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> parseString()
            't' -> "true".also { pos += 4 }
            'f' -> "false".also { pos += 4 }
            'n' -> "null".also { pos += 4 }
            else -> parseNumber()
        }
    }

    private fun parseObject(): MutableMap<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        pos++ // '{'
        skipWs()
        if (pos < src.length && src[pos] == '}') { pos++; return map }
        while (pos < src.length) {
            skipWs()
            val key = parseString()
            skipWs()
            if (pos < src.length && src[pos] == ':') pos++
            map[key] = parseValue()
            skipWs()
            when {
                pos >= src.length -> break
                src[pos] == ',' -> pos++
                src[pos] == '}' -> { pos++; break }
                else -> pos++
            }
        }
        return map
    }

    private fun parseArray(): MutableList<Any?> {
        val list = mutableListOf<Any?>()
        pos++ // '['
        skipWs()
        if (pos < src.length && src[pos] == ']') { pos++; return list }
        while (pos < src.length) {
            skipWs()
            list.add(parseValue())
            skipWs()
            when {
                pos >= src.length -> break
                src[pos] == ',' -> pos++
                src[pos] == ']' -> { pos++; break }
                else -> pos++
            }
        }
        return list
    }

    private fun parseString(): String {
        val sb = StringBuilder()
        pos++ // opening quote
        while (pos < src.length && src[pos] != '"') {
            val c = src[pos]
            if (c == '\\' && pos + 1 < src.length) {
                pos++
                when (val esc = src[pos]) {
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'u' -> {
                        val hex = src.substring(pos + 1, minOf(pos + 5, src.length))
                        sb.append(hex.toIntOrNull(16)?.toChar() ?: '?')
                        pos += 4
                    }
                    else -> sb.append(esc)
                }
            } else {
                sb.append(c)
            }
            pos++
        }
        pos++ // closing quote
        return sb.toString()
    }

    private fun parseNumber(): Any {
        val start = pos
        while (pos < src.length && (src[pos].isDigit() || src[pos] in "-+.eE")) pos++
        val raw = src.substring(start, pos)
        return raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: raw
    }

    private fun skipWs() {
        while (pos < src.length && src[pos].isWhitespace()) pos++
    }
}

/** Minimal JS string literal escaping, so we can inject Kotlin strings into evaluated snippets. */
private fun String.jsQuote(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "") + "\""
