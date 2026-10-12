package eu.kanade.tachiyomi.data.backup.venera

/**
 * Reproduces **Dart VM's `String.hashCode`** in Kotlin.
 *
 * ### Why this exists
 *
 * Venera's sqlite databases store a source's identity as a single integer column (`type`), e.g.
 * `history.db` and every folder table in `local_favorite.db`. That integer is
 * **`key.hashCode` evaluated by the Dart VM** — *not* Java's `String.hashCode` and *not* the
 * `MD5(key) -> Long` scheme this app uses for [eu.kanade.tachiyomi.source.manga.js.JsMangaSource].
 *
 * | key | Dart `String.hashCode` | Java `String.hashCode` | our `sourceId` (MD5) |
 * |---|---|---|---|
 * | `jm` | 769844263 | 3395 | — |
 * | `nhentai` | 264196719 | -1966864740 | — |
 * | `ehentai` | 385625716 | -2135508221 | — |
 *
 * So a `.venera` backup can only be mapped onto our sources by **re-deriving** the Dart hash from
 * candidate keys and matching against the stored `type` values (see [reverseLookup]).
 *
 * ### The algorithm
 *
 * It is Jenkins' one-at-a-time hash over the **UTF-8 bytes**, followed by a 30-bit mask because the
 * VM returns the value as a Smi (`kHashBits == 30`). Dropping the mask silently produces wrong
 * values for roughly three out of four keys.
 *
 * Verified against real data from a Venera backup: `jm`, `nhentai` and `ehentai` all reproduce the
 * `type` values found in the sqlite tables, with no collisions.
 */
object DartStringHash {

    /**
     * Dart's `String.hashCode`, i.e. Jenkins one-at-a-time over UTF-8 bytes, masked to 30 bits.
     *
     * Kotlin's [Int] wraps exactly like the VM's `uint32_t`, and [ushr] matches the VM's logical
     * right shift, so no explicit masking is needed mid-way.
     */
    fun of(value: String): Int {
        var hash = 0
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val b = byte.toInt() and 0xFF
            hash += b
            hash += hash shl 10
            hash = hash xor (hash ushr 6)
        }
        hash += hash shl 3
        hash = hash xor (hash ushr 11)
        hash += hash shl 15
        return hash and 0x3FFFFFFF
    }

    /**
     * Builds a `dartHash -> sourceKey` table from candidate keys.
     *
     * The candidate set should be every key the backup lets us discover — the `key = "..."` line of
     * each bundled script in `comic_source`, the `favorites` / `searchSources` arrays in
     * `appdata.json`, plus Venera's built-in sources (which ship inside the app and therefore have no
     * script file in the archive, yet can still own history/favourites rows).
     *
     * Collisions are impossible in practice for this key namespace, but first-wins is used anyway so
     * the result is deterministic.
     */
    fun reverseLookup(candidateKeys: Iterable<String>): Map<Int, String> {
        val map = HashMap<Int, String>()
        candidateKeys.forEach { key ->
            if (key.isBlank()) return@forEach
            map.putIfAbsent(of(key), key)
        }
        return map
    }

    /**
     * Venera's built-in comic sources.
     *
     * These are compiled into the Flutter app, so a backup never contains their `.js` — only their
     * `type` integer shows up in `history.db` / `local_favorite.db`. Without this list those rows
     * would be unresolvable.
     */
    val BUILT_IN_KEYS: Set<String> = setOf(
        "picacg",
        "ehentai",
        "jm",
        "hitomi",
        "wnacg",
        "nhentai",
        "htmanga",
        "goda",
        "manhuaren",
        "baozi",
        "kavita",
    )
}
