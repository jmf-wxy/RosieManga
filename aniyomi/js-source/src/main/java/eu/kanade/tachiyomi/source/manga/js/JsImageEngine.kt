package eu.kanade.tachiyomi.source.manga.js

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Kotlin side of Venera's `Image` primitive — a faithful port of
 * `venera/lib/utils/image.dart` (`Image` / `Color`), reachable from JS through the bridge as
 * `{ method: "image", function: "<op>", ... }` (see [handle]).
 *
 * ### Why this exists — the scrambled-image problem
 *
 * JM (and other Venera sources) serve manga pages as **strips reordered by an algorithm derived
 * from the episode id**: the raw CDN bytes decode to a picture whose horizontal bands are shuffled.
 * The source reports how to reassemble them via `comic.onImageLoad(url, comicId, epId)` →
 * `{ headers, modifyImage }`, where `modifyImage` is a *JS source string* defining
 * `let modifyImage = (image) => ...` that rebuilds the picture using the `Image` API
 * (`Image.empty(w,h)` + `res.fillImageRangeAt(...)`).
 *
 * The pixels themselves must never cross the JS bridge (a full page is millions of ints), so —
 * exactly like Venera — JS only ever passes **integer handles**; the actual pixel work happens
 * here, natively, one [Img] per handle.
 *
 * ### Pixel format
 *
 * Venera decodes to raw straight RGBA and packs pixels as `(a << 24) | (r << 16) | (g << 8) | b`.
 * Android's `ARGB_8888` `Bitmap.getPixels`/`setPixels` use exactly that packing, so the port is
 * bit-exact — including the "copy this rect of pixels" semantics of `fillImageRangeAt`.
 *
 * ### Threading
 *
 * Bridge ops (`handle`) arrive on the JS engine thread; registration/copy-out happen on the caller
 * (reader/downloader IO) thread. Everything guards on [lock]; the whole
 * register → eval → copy-out critical section in [transform] is also serialized so that a
 * concurrent reader + download transform cannot interleave their session sets.
 *
 * The two **native** halves of the pipeline — `BitmapFactory` decode and PNG encode — are handed to
 * [nativePool] instead of running on the caller's IO thread; see that field for why. The eval in
 * the middle stays on the caller thread, because it must (S2: only the creating thread may touch
 * the QuickJS context).
 *
 * ### Lifecycle
 *
 * Every handle created between [transform]'s begin/end is released when it ends (input image,
 * `Image.empty` intermediates, `copyRange` temporaries, the final result). Leaks were the default
 * failure mode: the modify script has no notion of ownership.
 */
object JsImageEngine {

    private const val TAG = "JsImageEngine"

    /** Row-major packed-pixel image, mirroring Venera's Dart `Image` one to one. */
    private class Img(val width: Int, val height: Int, val pixels: IntArray) {
        init {
            // ~40M pixels (~160 MB as ARGB ints) is far above any real manga page; reject higher
            // so a hostile/huge image can't OOM the app through `Image.empty` / decode.
            require(width > 0 && height > 0 && pixels.size.toLong() == width.toLong() * height && pixels.size <= 40_000_000) {
                "invalid image $width x $height (pixels=${pixels.size})"
            }
        }
    }

    private val lock = Any()

    /** Serializes whole transforms; deliberately distinct from [lock] — see [transform]. */
    private val transformLock = Any()
    private val images = HashMap<Int, Img>()
    private var nextKey = 0

    /** Handles created since the current transform began; emptied by [endSession]. */
    private var sessionKeys: MutableSet<Int>? = null

    /**
     * Dedicated thread for the **native** halves of the pipeline — `BitmapFactory` decode and PNG
     * encode — so they stop running on the caller's `Dispatchers.IO` thread.
     *
     * **Why off the caller.** `transform` is invoked from `JsMangaSource.getImage` on
     * `Dispatchers.IO`. `decodeByteArray` + `getPixels` and `Bitmap.compress(PNG)` are pure
     * CPU/Bitmap work that pins an IO thread for tens of ms per page; with several pages in flight
     * (reader prefetch + downloader) those threads are unavailable for the OkHttp calls queued
     * behind them. Moving the work off the IO dispatcher is the textbook "don't do CPU work on IO"
     * split, and it costs no extra eval — the eval stays where it must (S2).
     *
     * **Why exactly *one* thread.** A decoded page is an `IntArray` of `width * height` ints, and
     * [Img] permits up to 40M pixels ⇒ ~160 MB per page as ints. Decoding several pages in
     * parallel is therefore an OOM vector, so a single thread doubles as the bound on peak decode
     * memory. Nothing is lost in throughput: the eval between decode and encode is *already*
     * globally serialized by [transformLock], so the pipeline was never able to run two pages'
     * transforms at once anyway.
     *
     * ⚠️ No QuickJS handle ever crosses this boundary. [Img] and `IntArray` are plain Kotlin data
     * with no thread affinity — S2 forbids moving *engine handles* between threads, not data. This
     * thread only ever touches `Bitmap` / `IntArray`, never the runtime.
     */
    private val nativePool = Executors.newSingleThreadExecutor { r ->
        Thread(r, "JsImageEngine-native").apply { isDaemon = true }
    }

    /**
     * Runs [block] on [nativePool] and blocks the caller until it finishes.
     *
     * The caller is always a `Dispatchers.IO` worker, never the JS thread, so blocking here cannot
     * self-deadlock (the pool re-enters nothing that waits on the caller). Returns `null` instead of
     * throwing so [transform] keeps its documented "degrades, never throws" contract — except for
     * cancellation, where the interrupt flag is deliberately restored and propagated to the caller.
     */
    private fun <T> onNativeThread(block: () -> T): T? {
        val future = nativePool.submit<T> { block() }
        return try {
            future.get()
        } catch (e: InterruptedException) {
            // The coroutine driving getImage was cancelled. Swallowing the flag would make the
            // cancellation invisible to the rest of the request; restore it and degrade to null.
            future.cancel(true)
            Thread.currentThread().interrupt()
            JsDebugLog.add(TAG, "native pool: interrupted (transform aborted)")
            null
        } catch (e: Exception) {
            JsDebugLog.add(TAG, "native pool: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Bridge entry — `{ method: "image", function: "<op>", ... }`
    // ---------------------------------------------------------------------------------------------

    /**
     * Dispatches one image op. Message shapes are **pinned by the Node verification harness**
     * (`ref-quickjs-android/verify_image_scramble_e2e.js`), which snapshots the exact messages the
     * JS `Image` class (init.js) emits and replays them against a pure-JS reference implementation
     * of these very semantics — so any drift breaks the suite on both sides.
     *
     * Return values are integers or `null` only: per the bridge hard rules, primitive values
     * marshal fine, while containers would need the inline-JSON detour. Throwing inside a bridge
     * call surfaces in JS as a rejection of the surrounding evaluation — bounds violations do
     * exactly that, mirroring Venera's Dart `ArgumentError`s.
     */
    fun handle(msg: Map<*, *>): Any? {
        val function = msg["function"] as? String ?: return null
        return synchronized(lock) {
            when (function) {
                "emptyImage" -> {
                    val w = (msg["width"] as? Number)?.toInt() ?: return@synchronized null
                    val h = (msg["height"] as? Number)?.toInt() ?: return@synchronized null
                    runCatching { put(Img(w, h, IntArray(w * h))) }
                        .onFailure { JsDebugLog.add(TAG, "emptyImage(${w}x$h): ${it.message}") }
                        .getOrNull()
                }
                "copyRange" -> {
                    val src = images[(msg["key"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    val x = (msg["x"] as? Number)?.toInt() ?: 0
                    val y = (msg["y"] as? Number)?.toInt() ?: 0
                    val w = (msg["width"] as? Number)?.toInt() ?: return@synchronized null
                    val h = (msg["height"] as? Number)?.toInt() ?: return@synchronized null
                    runCatching { copyRange(src, x, y, w, h) }
                        .map { put(it) }
                        .onFailure { JsDebugLog.add(TAG, "copyRange: ${it.message}") }
                        .getOrNull()
                }
                "copyAndRotate90" -> {
                    val src = images[(msg["key"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    runCatching { put(rotate90(src)) }
                        .onFailure { JsDebugLog.add(TAG, "copyAndRotate90: ${it.message}") }
                        .getOrNull()
                }
                "fillImageAt" -> {
                    val dst = images[(msg["key"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    val src = images[(msg["image"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    val x = (msg["x"] as? Number)?.toInt() ?: 0
                    val y = (msg["y"] as? Number)?.toInt() ?: 0
                    runCatching { fillImageAt(dst, x, y, src) }
                        .onFailure { JsDebugLog.add(TAG, "fillImageAt: ${it.message}") }
                    null
                }
                "fillImageRangeAt" -> {
                    val dst = images[(msg["key"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    val src = images[(msg["image"] as? Number)?.toInt() ?: return@synchronized null]
                        ?: return@synchronized null
                    val x = (msg["x"] as? Number)?.toInt() ?: 0
                    val y = (msg["y"] as? Number)?.toInt() ?: 0
                    val srcX = (msg["srcX"] as? Number)?.toInt() ?: 0
                    val srcY = (msg["srcY"] as? Number)?.toInt() ?: 0
                    val w = (msg["width"] as? Number)?.toInt() ?: return@synchronized null
                    val h = (msg["height"] as? Number)?.toInt() ?: return@synchronized null
                    runCatching { fillImageRangeAt(dst, x, y, src, srcX, srcY, w, h) }
                        .onFailure { JsDebugLog.add(TAG, "fillImageRangeAt: ${it.message}") }
                    null
                }
                "getWidth" -> images[(msg["key"] as? Number)?.toInt()]?.width
                "getHeight" -> images[(msg["key"] as? Number)?.toInt()]?.height
                else -> {
                    JsDebugLog.add(TAG, "unknown image function: $function")
                    null
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Transform pipeline — entered from JsMangaSource.getImage on an IO dispatcher; the native
    // halves (decode / encode) hop to [nativePool], the eval in between stays on the caller thread.
    // ---------------------------------------------------------------------------------------------

    /**
     * Decodes [imageBytes] **on [nativePool]**, runs the source's `modifyImage` script against it
     * (on the caller's thread — S2) and re-encodes the result as PNG **on [nativePool]**.
     *
     * The script is evaluated as
     * `(function () { <script>; return modifyImage(new Image(key)); })()` — an IIFE so the
     * script's top-level `let modifyImage` never leaks into the shared runtime, and so the return
     * value is a plain handle [Int] (primitive → safe to marshal; a bare `Image` instance would
     * come back as a `JSObject` handle we'd have to unwrap anyway).
     *
     * @return re-encoded PNG bytes, or `null` when decode fails / the script yields no image.
     *   Callers fall back to the untouched original bytes on `null` — a scrambled picture
     *   still beats a failed page.
     */
    fun transform(engine: JsEngine, script: String, imageBytes: ByteArray): ByteArray? {
        val src = onNativeThread { decode(imageBytes) } ?: run {
            JsDebugLog.add(TAG, "transform: decode failed (${imageBytes.size} bytes)")
            return null
        }

        var result: IntArray? = null
        var width = 0
        var height = 0
        // Serialize transforms against each other — but ⚠️ NEVER hold `lock` across the eval:
        // `evalForValueBlocking` blocks this (IO) thread waiting for the JS thread, and the JS
        // thread re-enters [handle] → `lock` for every `Image` op inside the modify script.
        // Holding `lock` here is the textbook S2 self-deadlock ("自己等自己") — it hung every
        // chapter on its first image. `lock` is only ever taken for short, non-blocking sections.
        synchronized(transformLock) {
            val srcKey = synchronized(lock) {
                sessionKeys = HashSet()
                put(src)
            }
            val eval = """
                (function () {
                    $script
                    var __r = modifyImage(new Image($srcKey));
                    return (__r === null || __r === undefined) ? null : __r.key;
                })()
            """.trimIndent()
            // The engine evaluates on its own thread; we are on IO — the *Blocking* variants
            // are safe here (they only deadlock when called *from inside* the bridge, which
            // this is not — and see above for why `lock` must not be held right now).
            var outKey: Int? = null
            try {
                outKey = (engine.evalForValueBlocking(eval) as? Number)?.toInt()
            } finally {
                // Copy out and release ALL session handles under the lock, whether the eval
                // returned, threw, or was interrupted — a leaked handle would pin its pixels.
                synchronized(lock) {
                    val img = outKey?.let { images[it] }
                    if (img == null) {
                        JsDebugLog.add(TAG, "transform: modifyImage returned no image ($outKey)")
                        result = null
                        width = 0
                        height = 0
                    } else {
                        result = img.pixels.copyOf()
                        width = img.width
                        height = img.height
                    }
                    endSession()
                }
            }
        }

        result ?: return null
        return onNativeThread { encode(width, height, result) }
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    private fun put(img: Img): Int {
        val key = nextKey++
        images[key] = img
        sessionKeys?.add(key)
        return key
    }

    private fun endSession() {
        sessionKeys?.forEach { images.remove(it) }
        sessionKeys = null
    }

    /** Venera `Image.copyRange` — bounds semantics preserved verbatim. */
    private fun copyRange(src: Img, x: Int, y: Int, width: Int, height: Int): Img {
        require(x + width <= src.width) { "x + width ($x + $width) > width (${src.width})" }
        require(y + height <= src.height) { "y + height ($y + $height) > height (${src.height})" }
        val data = IntArray(width * height)
        for (j in 0 until height) {
            for (i in 0 until width) {
                data[j * width + i] = src.pixels[(j + y) * src.width + i + x]
            }
        }
        return Img(width, height, data)
    }

    /** Venera `Image.fillImageAt` — deliberately clamped like the original (`&&` guards). */
    private fun fillImageAt(dst: Img, x: Int, y: Int, src: Img) {
        require(x + src.width <= dst.width) { "x + width ($x + ${src.width}) > width (${dst.width})" }
        require(y + src.height <= dst.height) { "y + height ($y + ${src.height}) > height (${dst.height})" }
        var j = 0
        while (j < src.height && j + y < dst.height) {
            var i = 0
            while (i < src.width && i + x < dst.width) {
                dst.pixels[(j + y) * dst.width + i + x] = src.pixels[j * src.width + i]
                i++
            }
            j++
        }
    }

    /** Venera `Image.fillImageRangeAt` — the op the JM unscramble uses once per strip. */
    private fun fillImageRangeAt(dst: Img, x: Int, y: Int, src: Img, srcX: Int, srcY: Int, width: Int, height: Int) {
        require(x + width <= dst.width) { "x + width ($x + $width) > width (${dst.width})" }
        require(y + height <= dst.height) { "y + height ($y + $height) > height (${dst.height})" }
        require(srcX + width <= src.width) { "srcX + width ($srcX + $width) > width (${src.width})" }
        require(srcY + height <= src.height) { "srcY + height ($srcY + $height) > height (${src.height})" }
        for (j in 0 until height) {
            for (i in 0 until width) {
                dst.pixels[(j + y) * dst.width + i + x] = src.pixels[(j + srcY) * src.width + i + srcX]
            }
        }
    }

    /** Venera `Image.copyAndRotate90`. */
    private fun rotate90(src: Img): Img {
        val data = IntArray(src.pixels.size)
        for (j in 0 until src.height) {
            for (i in 0 until src.width) {
                data[i * src.height + src.height - j - 1] = src.pixels[j * src.width + i]
            }
        }
        return Img(src.height, src.width, data)
    }

    /** Runs on [nativePool] (via [onNativeThread]) — never the JS thread, so `Bitmap` is unrestricted. */
    private fun decode(bytes: ByteArray): Img? {
        val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bmp = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) }.getOrNull()
            ?: return null
        val w = bmp.width
        val h = bmp.height
        if (w <= 0 || h <= 0) {
            bmp.recycle()
            return null
        }
        val pixels = IntArray(w * h)
        bmp.getPixels(pixels, 0, w, 0, 0, w, h)
        bmp.recycle()
        return Img(w, h, pixels)
    }

    /**
     * Runs on [nativePool] (via [onNativeThread]). Deliberately PNG-only: the source contract
     * promises "the pixels are the picture", so a lossy re-encode would silently degrade pages.
     */
    private fun encode(width: Int, height: Int, pixels: IntArray): ByteArray? {
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bmp.setPixels(pixels, 0, width, 0, 0, width, height)
        val out = ByteArrayOutputStream()
        return runCatching {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            out.toByteArray()
        }.onFailure { JsDebugLog.add(TAG, "encode: ${it.message}") }.getOrNull().also { bmp.recycle() }
    }
}
