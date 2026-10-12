package eu.kanade.tachiyomi.source.manga.js

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Downloads and installs Venera JS comic sources from a **source repository** (an HTTP(S) base
 * URL that serves an `index.json` plus the referenced `*.js` files).
 *
 * The canonical repository is `venera-app/venera-configs`, i.e.
 * ```
 * https://raw.githubusercontent.com/venera-app/venera-configs/main/
 *   ├── index.json          ← top-level array of JsSourceIndexEntry
 *   └── manhuagui.js, ...   ← one file per source
 * ```
 *
 * A repo may also be a plain directory URL; [normalizeRepoUrl] tolerates both the bare base URL
 * and a full `.../index.json` URL.
 *
 * ### Why this does NOT use [NetworkHelper]'s main client
 *
 * The app-wide client carries a [eu.kanade.tachiyomi.network.interceptor.CloudflareInterceptor]
 * and a 2-minute `callTimeout`. For a plain `index.json` fetch that is actively harmful:
 *  • `raw.githubusercontent.com` is frequently unreachable from mainland China, so the call hangs
 *    until `callTimeout` and the UI spins forever with no feedback;
 *  • when Cloudflare answers with a challenge the interceptor tries to launch a WebView to solve
 *    it — but this code runs from a settings screen, where there is no browser surface to host it.
 *
 * So index/script downloads get their own bare client with tight timeouts and no interceptors,
 * plus a mirror fallback chain (see [mirrorsFor]).
 */
object JsSourceUpdater {

    private const val TAG = "JsSourceUpdater"

    private const val INDEX_FILE = "index.json"

    /** Per-attempt budget. Deliberately short: the UI is blocked on this, and we retry mirrors. */
    private const val TIMEOUT_SECONDS = 12L

    /**
     * Bare client for repo I/O: no Cloudflare handling, no app interceptors, short timeouts.
     * Lazily built once — [OkHttpClient] instances are expensive and meant to be shared.
     */
    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .callTimeout(TIMEOUT_SECONDS * 2, TimeUnit.SECONDS)
            .build()
    }

    /** Normalizes a user-entered repo URL into a base URL (no trailing slash, no `index.json`). */
    fun normalizeRepoUrl(raw: String): String {
        var url = raw.trim()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://$url"
        }
        url = url.removeSuffix("/")
        url = url.removeSuffix("/$INDEX_FILE")
        return url
    }

    /**
     * Expands a GitHub `raw.githubusercontent.com` base URL into a mirror chain that is usually
     * reachable from mainland China.
     *
     * Non-GitHub URLs are returned as-is (single element) — the user's own host is authoritative.
     * The original URL is always **last**, so a working direct connection still wins.
     */
    private fun mirrorsFor(base: String): List<String> {
        val prefix = "https://raw.githubusercontent.com/"
        if (!base.startsWith(prefix)) return listOf(base)

        // <owner>/<repo>/<ref>/<path...>
        val rest = base.removePrefix(prefix)
        val parts = rest.split('/')
        if (parts.size < 3) return listOf(base)
        val (owner, repo, ref) = parts
        val path = parts.drop(3).joinToString("/")
        val tail = if (path.isEmpty()) "$owner/$repo/$ref" else "$owner/$repo/$ref/$path"

        return listOf(
            "https://ghfast.top/https://raw.githubusercontent.com/$tail",
            "https://gh-proxy.com/https://raw.githubusercontent.com/$tail",
            base,
        ).distinct()
    }

    /** GETs [url] and returns the body, or `null` if every mirror failed. */
    private suspend fun fetchText(url: String): String? {
        for (candidate in mirrorsFor(url)) {
            val result = runCatching {
                http.newCall(Request.Builder().url(candidate).build()).execute().use { response ->
                    if (!response.isSuccessful) {
                        Log.w(TAG, "HTTP ${response.code} from $candidate")
                        return@use null
                    }
                    response.body.string()
                }
            }
            if (result.isSuccess && result.getOrNull() != null) {
                Log.d(TAG, "fetched ${result.getOrNull()!!.length} bytes from $candidate")
                return result.getOrNull()
            }
            Log.w(TAG, "mirror failed: $candidate (${result.exceptionOrNull()})")
        }
        return null
    }

    /** Fetches and parses the repo index. Returns an empty list on any failure. */
    suspend fun fetchIndex(repoUrl: String): List<JsSourceIndexEntry> {
        val base = normalizeRepoUrl(repoUrl)
        if (base.isBlank()) return emptyList()
        val body = fetchText("$base/$INDEX_FILE") ?: return emptyList()
        return runCatching { parseJsSourceIndex(body) }
            .onFailure { Log.w(TAG, "index parse failed", it) }
            .getOrElse { emptyList() }
    }


    /**
     * Whether the repo's copy of a source is **newer** than what is installed.
     *
     * ### Why this is not `entry.version != current.version`
     *
     * The original check was plain string inequality, which is wrong in the one direction that
     * hurts: a **locally patched** source. Fixing a source against a site redesign (goda.js's
     * `data-mid` migration) means shipping a version the upstream repo does not have — e.g. local
     * `1.2.3` vs upstream `1.2.1`. Those strings differ, so every "检查更新" run reported an update
     * and `installFromRepo` **overwrote the fix with the older upstream file**, silently reverting
     * it on the next check. The device then showed 1.2.1's exact error string, which is what made
     * this look like "the fix never worked" rather than "the fix was rolled back".
     *
     * So: only replace when the repo copy is genuinely **newer**; equal is a no-op, and a lower
     * upstream version is a downgrade we must refuse. Unparseable versions on either side fall
     * back to the old inequality so an odd version string still gets a chance to refresh.
     */
    private fun isRepoNewer(repoVersion: String, currentVersion: String): Boolean {
        if (repoVersion.isEmpty()) return false
        if (repoVersion == currentVersion) return false
        val repo = parseVersion(repoVersion) ?: return true
        val current = parseVersion(currentVersion) ?: return true
        for (i in 0 until maxOf(repo.size, current.size)) {
            // A missing component is 0, so "1.2" == "1.2.0".
            val r = repo.getOrElse(i) { 0 }
            val c = current.getOrElse(i) { 0 }
            if (r != c) return r > c
        }
        return false
    }

    /** Splits a dotted version into its numeric components, or `null` if it isn't numeric at all. */
    private fun parseVersion(version: String): List<Int>? {
        val core = version.trim().removePrefix("v").substringBefore('-').substringBefore('+')
        if (core.isEmpty()) return null
        val parts = core.split('.')
        val out = ArrayList<Int>(parts.size)
        for (p in parts) {
            val n = p.toIntOrNull() ?: return null
            out.add(n)
        }
        return out
    }

    /**
     * Downloads one source script from the repo and installs it.
     *
     * @return the installed source, or `null` on failure.
     */
    suspend fun installFromRepo(repoUrl: String, entry: JsSourceIndexEntry): JsMangaSource? {
        val base = normalizeRepoUrl(repoUrl)
        val jsCode = fetchText("$base/${entry.fileName}") ?: return null
        return JsSourceManager.install(jsCode, fileName = entry.fileName)
    }

    /**
     * Installs every source in the repo that is not installed yet, plus refreshes outdated ones.
     *
     * Use this only for an explicit "全部安装" action — see [updateInstalled] for the common case.
     *
     * @param onUpgraded invoked with the keys of **already-installed** sources that were replaced
     *   (i.e. genuine upgrades, not first-time installs). Callers use this to trigger the library
     *   re-sync that fixes a bad chapter list an older source version had written — see
     *   [JsSourceConfigScreenModel]'s `checkUpdates`. Kept as a callback rather than a return field
     *   so the `Int` count contract stays unchanged for the other callers.
     * @return number of sources installed or updated.
     */
    suspend fun syncRepo(
        repoUrl: String,
        onProgress: (Int, Int) -> Unit = { _, _ -> },
        onUpgraded: (List<String>) -> Unit = {},
    ): Int {
        val index = fetchIndex(repoUrl)
        if (index.isEmpty()) return 0

        var done = 0
        val upgraded = mutableListOf<String>()
        index.forEachIndexed { i, entry ->
            onProgress(i + 1, index.size)
            val existing = JsSourceManager.findByKey(entry.key)
            val needsInstall = existing == null || isRepoNewer(entry.version, existing.version)
            if (needsInstall) {
                if (installFromRepo(repoUrl, entry) != null) {
                    done++
                    // Only a *replacement* of an existing source is an upgrade whose library rows may
                    // carry stale chapters; a first-time install has no library rows yet.
                    if (existing != null) upgraded += entry.key
                }
            }
        }
        if (upgraded.isNotEmpty()) onUpgraded(upgraded)
        return done
    }

    /**
     * Updates **only the sources that are already installed**, leaving the rest of the catalogue
     * alone. This is what a "检查更新" action must do: it is a version refresh, not a bulk install.
     *
     * Sources installed from a local file (never seen in the index) are skipped, and so are sources
     * whose index version cannot be compared.
     *
     * @param onUpgraded invoked with the keys of the sources whose **newer** version was actually
     *   written. The caller uses it to force a library re-sync for those sources — the self-heal for
     *   a bad chapter list / 未知作者 that the *previous* source version has already persisted. See
     *   [JsSourceConfigScreenModel]'s `checkUpdates`.
     * @return the number of sources actually replaced.
     */
    suspend fun updateInstalled(
        repoUrl: String,
        onProgress: (Int, Int) -> Unit = { _, _ -> },
        onUpgraded: (List<String>) -> Unit = {},
    ): Int {
        val index = fetchIndex(repoUrl)
        if (index.isEmpty()) return 0

        val installedByKey = JsSourceManager.jsSources.associateBy { it.key }
        val candidates = index.filter { entry ->
            val current = installedByKey[entry.key] ?: return@filter false
            isRepoNewer(entry.version, current.version)
        }
        if (candidates.isEmpty()) return 0

        var done = 0
        val upgraded = mutableListOf<String>()
        candidates.forEachIndexed { i, entry ->
            onProgress(i + 1, candidates.size)
            if (installFromRepo(repoUrl, entry) != null) {
                done++
                upgraded += entry.key
            }
        }
        if (upgraded.isNotEmpty()) onUpgraded(upgraded)
        return done
    }

    /** The installed sources that the index reports as outdated. Used to decide whether to nag. */
    suspend fun outdatedInstalled(repoUrl: String): List<JsSourceIndexEntry> {
        val index = fetchIndex(repoUrl)
        val installedByKey = JsSourceManager.jsSources.associateBy { it.key }
        return index.filter { entry ->
            val current = installedByKey[entry.key] ?: return@filter false
            isRepoNewer(entry.version, current.version)
        }
    }

    /** Returns the subset of [index] that has a newer version than what is installed. */
    fun pendingUpdates(
        index: List<JsSourceIndexEntry>,
        installed: List<JsSourceInfo>,
    ): List<JsSourceIndexEntry> {
        val installedByKey = installed.associateBy { it.key }
        return index.filter { entry ->
            val current = installedByKey[entry.key] ?: return@filter true // not installed yet
            isRepoNewer(entry.version, current.version)
        }
    }

    // --- import from a local .js file -------------------------------------------------------------

    /** Installs a source from a local `*.js` file path (used by the file-picker import flow). */
    fun installFromFile(file: File): JsMangaSource? {
        if (!file.isFile || file.extension != "js") return null
        val code = runCatching { file.readText() }.getOrNull() ?: return null
        return JsSourceManager.install(code, fileName = file.name)
    }

    /** Installs a source from a `content://` stream read into a string. */
    fun installFromText(fileName: String, code: String): JsMangaSource? =
        JsSourceManager.install(code, fileName = fileName)
}
