package eu.kanade.tachiyomi.source.manga.js

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One entry in a Venera source index (`index.json`).
 *
 * Mirrors the real format used by `venera-app/venera-configs`:
 * ```json
 * { "name": "漫画柜", "fileName": "manhuagui.js", "key": "ManHuaGui",
 *   "version": "1.2.1", "description": "optional" }
 * ```
 */
@Serializable
data class JsSourceIndexEntry(
    val name: String,
    val fileName: String,
    val key: String,
    val version: String = "",
    val description: String? = null,
)

internal val jsSourceIndexJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

/**
 * Parses a Venera source index. The upstream format is a **top-level JSON array**; we also accept
 * an object wrapper (`{"sources": [...]}`) defensively, since some mirrors use that shape.
 *
 * The result is normalized by [dedupeByKey] so callers can rely on `key` being unique.
 */
fun parseJsSourceIndex(body: String): List<JsSourceIndexEntry> {
    val trimmed = body.trim()
    val parsed = runCatching {
        if (trimmed.startsWith("[")) {
            jsSourceIndexJson.decodeFromString<List<JsSourceIndexEntry>>(trimmed)
        } else {
            jsSourceIndexJson.decodeFromString<JsSourceIndexWrapper>(trimmed).sources
        }
    }.getOrElse { emptyList() }
    return parsed.dedupeByKey()
}

/**
 * Collapses index entries that share a `key`, keeping the highest `version` (first wins on a tie).
 *
 * `key` is the *only* identity a Venera source has: the JS runtime addresses a source as
 * `ComicSource.sources['<key>']` (one object per key in the shared realm), and [JsMangaSource.keyToId]
 * derives the Aniyomi source id from the key as well. Two entries with the same key therefore
 * describe one source twice and can never coexist — installing the second would silently overwrite
 * the first.
 *
 * This is not hypothetical: `venera-configs/index.json` ships `copy_manga.js` and
 * `copy_manga_multi_accounts.js`, and **both scripts declare `key = "copy_manga"`** (class name
 * `CopyManga` too). Without this step the management screen renders two rows with the same key and
 * Compose throws `Key "avail_copy_manga" was already used`, crashing the app.
 */
private fun List<JsSourceIndexEntry>.dedupeByKey(): List<JsSourceIndexEntry> {
    val best = LinkedHashMap<String, JsSourceIndexEntry>()
    for (entry in this) {
        val current = best[entry.key]
        if (current == null || compareVersions(entry.version, current.version) > 0) {
            best[entry.key] = entry
        }
    }
    return best.values.toList()
}

/**
 * Compares dotted version strings segment-wise, numerically, so `"1.10.0" > "1.9.0"` — which plain
 * string comparison gets wrong. Non-numeric/missing segments count as `0`.
 */
internal fun compareVersions(a: String, b: String): Int {
    val aParts = a.split('.')
    val bParts = b.split('.')
    for (i in 0 until maxOf(aParts.size, bParts.size)) {
        val diff = (aParts.getOrNull(i)?.toIntOrNull() ?: 0) - (bParts.getOrNull(i)?.toIntOrNull() ?: 0)
        if (diff != 0) return diff
    }
    return 0
}

@Serializable
private data class JsSourceIndexWrapper(val sources: List<JsSourceIndexEntry> = emptyList())

/** Runtime state of one installed JS source, surfaced to the management UI. */
data class JsSourceInfo(
    val key: String,
    val name: String,
    val version: String,
    /**
     * Language tag the source declared (`lang` on the JS object), `"all"` when it declared none.
     * Kept on the info record so the management UI can show it; it does not change where the
     * source appears in the browse list (that is [eu.kanade.tachiyomi.source.manga.js.JsMangaSource.lang]).
     */
    val lang: String = "all",
    val fileName: String?,
    val isInstalled: Boolean,
    /** `true` when a newer `version` is available in the index. */
    val hasUpdate: Boolean = false,
    /** `true` once the source reports a stored account. */
    val isLoggedIn: Boolean = false,
)
