package eu.kanade.tachiyomi.source.manga.js

import java.security.MessageDigest

/**
 * Process-wide cache of **already-transformed** manga page bytes.
 *
 * ### Why this exists — the reader re-evaluates the scramble script on every visit
 *
 * A scrambled source (JM, GoDa, …) reports a `modifyImage` script through
 * `comic.onImageLoad(url, comicId, epId)` ([JsMangaSource.getImage]) and every page view pays the
 * full pipeline in [JsImageEngine.transform]: `decode` (BitmapFactory) → `eval` the script **on the
 * single-threaded JS runtime** → `encode` (PNG). Only the middle step is unavoidable, and it is the
 * expensive one: the `eval` cannot overlap any other source call (S2, one runtime) and a 30-page
 * chapter spends 1.5–4.5s of JS-thread time just unscrambling. Re-opening a chapter — or scrolling
 * back a page — re-ran the exact same script on the exact same bytes, for the exact same output.
 *
 * This cache makes a repeat visit **free**: a hit returns the previously produced PNG and skips
 * decode + eval + encode entirely. It is the single highest-ROI responsiveness win for打散 sources,
 * and it touches nothing on the JS side, so the S2/S16 invariants are untouched.
 *
 * ### What is cached, and what is NOT
 *
 * Only the **transformed result** is stored. The original bytes are deliberately never cached:
 * sources sign/anti-hotlink their URLs (`onImageLoad` returns per-request `headers`), so a cached
 * original could be re-served under a stale signature. The transform output, by contrast, is a
 * pure function of (bytes, script, ids) — no signature is embedded in the pixels.
 *
 * ### Threading — a lock of its own, never held across an eval
 *
 * The reader/downloader call this from IO threads while [JsImageEngine.handle] runs on the JS
 * thread. All access goes through [lock], which is **private to this object** and held only for
 * short map operations. It is never held while an eval runs — that is the S16 deadlock
 * (`transform` must not block the JS thread while it waits for the JS thread). The cache is a pure
 * lookup/side-store around [JsImageEngine.transform] and never participates in the eval.
 *
 * ### Bounds
 *
 * Two independent ceilings, whichever trips first: [MAX_ENTRIES] and [MAX_BYTES]. Access order is
 * tracked ([LinkedHashMap] `accessOrder = true`) so eviction is a true LRU. A cap is mandatory —
 * a 64 MB ceiling is roughly a couple of dozen full pages, small enough to survive low-memory
 * devices, and eviction is silent (a miss just re-runs the transform, which is always correct).
 *
 * ### Invalidation
 *
 * A script change is already reflected in the key (the `modifyImage` script is hashed in), so a
 * source upgrade can never serve a stale transform. [JsSourceManager] additionally calls
 * [evictSource] on uninstall/replace and [clear] on reload, so a removed source's pages do not pin
 * memory.
 */
object ImageTransformCache {

    private const val TAG = "ImageTransformCache"

    /** Upper bound on cached pages. Whichever of this / [MAX_BYTES] trips first wins. */
    private const val MAX_ENTRIES = 64

    /** Upper bound on cached bytes (~64 MB); see the class KDoc for the rationale. */
    private const val MAX_BYTES = 64L * 1024 * 1024

    /**
     * Identity of one transformed page.
     *
     * The four source-level fields ([sourceKey] / [comicId] / [epId] / [scriptHash]) scope the entry
     * to exactly the source that produced it, and [imageHash] ties it to the exact input bytes —
     * together they make the transformed output a pure function of the key, so a hit is always
     * correct.
     */
    data class Key(
        val sourceKey: String,
        val comicId: String,
        val epId: String,
        val scriptHash: String,
        val imageHash: String,
    )

    private val lock = Any()

    /** LRU map: `accessOrder = true` so the eldest entry is the least-recently used. */
    private val entries = LinkedHashMap<Key, ByteArray>(16, 0.75f, true)
    private var totalBytes = 0L

    /**
     * Builds the cache key for one transform.
     *
     * Mirrors the task's key definition exactly: `sha256(original bytes)` plus the source key, the
     * comic id, the episode id and the `modifyImage` script content hash. Hashing the original
     * bytes is O(page) but negligible next to the decode + eval + encode it lets us skip.
     */
    fun keyOf(
        sourceKey: String,
        comicId: String,
        epId: String,
        script: String,
        imageBytes: ByteArray,
    ): Key = Key(
        sourceKey = sourceKey,
        comicId = comicId,
        epId = epId,
        scriptHash = sha256(script.toByteArray(Charsets.UTF_8)),
        imageHash = sha256(imageBytes),
    )

    /** The cached transform for [key], or `null` on a miss. Touching a hit refreshes its LRU rank. */
    fun get(key: Key): ByteArray? = synchronized(lock) { entries[key] }

    /**
     * Stores [bytes] under [key].
     *
     * A re-insert of an existing key replaces the value and re-accounts the byte total (a page may
     * legitimately be re-produced with a different size only if the underlying data changed — but
     * the key covers that, so in practice this is the same-size replace of a just-evicted entry).
     */
    fun put(key: Key, bytes: ByteArray) {
        if (bytes.isEmpty()) return
        synchronized(lock) {
            entries.remove(key)?.let { totalBytes -= it.size }
            entries[key] = bytes
            totalBytes += bytes.size
            evictLocked()
        }
    }

    /** Drops every entry for [sourceKey] — call when a source is uninstalled or replaced. */
    fun evictSource(sourceKey: String) {
        synchronized(lock) {
            val it = entries.entries.iterator()
            while (it.hasNext()) {
                val (key, bytes) = it.next()
                if (key.sourceKey == sourceKey) {
                    totalBytes -= bytes.size
                    it.remove()
                }
            }
        }
    }

    /** Drops everything — call on a full source reload, which re-evaluates every script. */
    fun clear() {
        synchronized(lock) {
            entries.clear()
            totalBytes = 0L
        }
    }

    /** Diagnostics only: current entry count and byte footprint. */
    fun snapshot(): Pair<Int, Long> = synchronized(lock) { entries.size to totalBytes }

    // --- internals --------------------------------------------------------------------------------

    /** Enforces both ceilings by dropping least-recently-used entries. Caller must hold [lock]. */
    private fun evictLocked() {
        val it = entries.entries.iterator()
        while ((entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) && it.hasNext()) {
            val (_, bytes) = it.next()
            totalBytes -= bytes.size
            it.remove()
        }
        JsDebugLog.add(TAG, "cache size=${entries.size} bytes=$totalBytes (limits $MAX_ENTRIES / $MAX_BYTES)")
    }

    /** Lower-case hex SHA-256 of [data]; the hashing primitive shared by both key components. */
    private fun sha256(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(data)
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0F])
        }
        return out.toString()
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
