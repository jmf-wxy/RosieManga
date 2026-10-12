package eu.kanade.tachiyomi.source.manga.js

import android.content.Context
import android.util.Log
import com.whl.quickjs.wrapper.JSCallFunction
import eu.kanade.tachiyomi.network.NetworkHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.Inflater
import java.util.zip.InflaterInputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Kotlin side of Venera's `sendMessage` bridge.
 *
 * This mirrors Venera's Dart `JsEngine._messageReceiver` (see `venera/lib/foundation/js_engine.dart`
 * and `docs/venera-js-api.md`). The JS glue (`assets/init.js`) only ever calls `sendMessage({method})`,
 * so implementing this switch in Kotlin is ALL that is needed to make Venera sources run natively.
 *
 * Runs on the JS engine thread (see [JsEngine]). Blocking here is intentional and safe: the JS
 * runtime gets its own thread, so a slow HTTP call never touches the UI thread.
 */
@Suppress("UNUSED_PARAMETER")
class JsMessageDispatcher(
    private val context: Context,
    private val engine: JsEngine,
) {

    private val network: NetworkHelper = Injekt.get()

    private val TAG = "JsMessageDispatcher"

    /**
     * OkHttp client for the JS bridge, with **bounded** timeouts.
     *
     * The bridge used to ride the app's global client, whose 2-minute `callTimeout` is meant for
     * big media downloads. On the bridge that budget is actively harmful: the JS thread is pinned
     * for the whole request (sync bridge) or one bridge slot is held open (async bridge), so a
     * hanging request — jm.js's `newsvr-2025.txt` domain-list fetch from CN networks is the
     * canonical offender — translated directly into "the app spins forever". API payloads are
     * small JSON; 10s to connect / 30s total is already generous.
     */
    private val bridgeClient: OkHttpClient by lazy {
        network.client.newBuilder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** Launches the async-bridge ([`__http_async`]) completions off the JS thread. */
    private val asyncScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Exposed to JS as global `__sendMessageSync(msg) -> any` (re-exported as a Promise-returning
     * `sendMessage` by [JsEngine.BRIDGE_SHIM]).
     *
     * `JSCallFunction` is a Java interface whose single method is `Object call(Object... args)`,
     * so we implement it explicitly (rather than via SAM lambda) to keep the vararg marshalling
     * unambiguous: JS invokes `sendMessage({ method, ... })` with exactly one object argument.
     *
     * ### Why the argument is NOT `as? Map<*, *>` — the one line that killed the whole bridge
     *
     * A JS **object argument** reaches Java as a `com.whl.quickjs.wrapper.JSObject` *handle*, not
     * as a `java.util.Map`. The wrapper's native library proves it: the only class descriptors it
     * references are `java/lang/{Boolean,Double,Integer,Long,String,Object}` plus its own
     * `com/whl/quickjs/wrapper/{JSObject,JSArray,JSFunction,JSCallFunction,...}` — **there is no
     * reference to `java/util/HashMap` anywhere in `libquickjs-android-wrapper.so`**, so native
     * has no way to build one for us.
     *
     * The original `args.firstOrNull() as? Map<*, *> ?: return null` therefore short-circuited on
     * *every single call*, making the bridge return `null` (→ `undefined` in JS) for every method
     * — `getLocale`, `http`, `convert`, `load_data`, all of them. Sources then tripped over the
     * missing value while looking completely healthy:
     *   • `refreshDomains` → `Network.fetchBytes` saw `undefined`, so `result.error` threw
     *     `cannot read property 'error' of undefined`;
     *   • `login` → `cannot read property 'NaN' of undefined`.
     *
     * [toBridgeArgs] converts the [com.whl.quickjs.wrapper.JSObject] handle into a plain
     * `Map<String, Any?>` **property by property**, which is what keeps `ArrayBuffer` payloads
     * intact as `byte[]` — the generic `toKotlinValue()` would flatten them into a `LinkedHashMap`
     * (see `JsValueConversion.kt::readProperties`), and `convert` then blew up with
     * `ClassCastException: java.util.LinkedHashMap cannot be cast to byte[]`.
     *
     * It touches only native handles, so it must run **on the JS thread** — which is exactly where
     * the bridge invokes us, since this call arrives from inside `evaluate()`.
     */
    val sendMessage: JSCallFunction = object : JSCallFunction {
        override fun call(vararg args: Any?): Any? {
            val arg = args.firstOrNull() ?: return null
            val msg = arg.toBridgeArgs() ?: run {
                JsDebugLog.add(TAG, "bridge: unsupported arg type ${arg.javaClass.simpleName}, dropped")
                return null
            }
            return engine.toJsReturnValueInline(dispatch(msg))
        }
    }

    private fun dispatch(msg: Map<*, *>): Any? = when (msg["method"]) {
        "log" -> { log(msg); null }
        "http" -> executeEnvelope(msg)
        "__http_async_cap" -> true
        "__http_async" -> httpAsync(msg)
        "__delay_async" -> delayAsync(msg)
        "html" -> html(msg)
        "convert" -> convert(msg)
        "cookie" -> cookie(msg)
        "image" -> JsImageEngine.handle(msg)
        "random" -> random(msg)
        "uuid" -> UUID.randomUUID().toString()
        // Only the *fallback*: when the async leg is available the shim rewrites this to
        // `__delay_async` before it ever reaches us — see [delaySync] for why it still sleeps.
        "delay" -> delaySync(msg)

        // --- per-source persistent state (settings + saved data) ---
        "load_data" -> JsSourceManager.data(msg["key"] as String, msg["data_key"] as String)
        "save_data" -> { JsSourceManager.saveData(msg["key"] as String, msg["data_key"] as String, msg["data"]); null }
        "delete_data" -> { JsSourceManager.deleteData(msg["key"] as String, msg["data_key"] as String); null }
        // Venera's chain: saved value → the source's declared `default`. MUST stay synchronous:
        // sources read it without `await` (e.g. `let v = this.loadSetting('x')`).
        "load_setting" -> JsSourceManager.settingValue(msg["key"] as String, msg["setting_key"] as String)
        "isLogged" -> JsSourceManager.isLogged(msg["key"] as String)

        "getLocale" -> "zh_CN"
        "getPlatform" -> "android"
        "UI" -> ui(msg)
        "compute" -> compute(msg)
        else -> null
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * `UI.*` — Venera's user-facing dialogs / toasts.
     *
     * All four calls arrive as `{ method: "UI", function: "<name>", ... }`. We only *publish* them
     * (see [JsUiEvents]); rendering is the app layer's job.
     *
     * ### Why this matters for "the button does nothing"
     *
     * A `callback` setting is usually `async () => this.doSomething()`, and the tail of that chain is
     * very often a `UI.showDialog(...)` (that is exactly what `jm.js`'s 刷新域名列表 does: fetch the
     * domain list, fall back to built-ins, then show an "Update Failed / Apply" dialog). Answering
     * `null` here means the JS succeeds but the user sees no evidence of it whatsoever.
     *
     * The return value is deliberately still `null` for the fire-and-forget calls: `init.js` does not
     * use the result of `showMessage` / `showDialog` / `showLoading`, it only awaits the bridge.
     */
    private fun ui(msg: Map<*, *>): Any? {
        val key = msg["key"] as? String ?: "?"
        return when (msg["function"] as? String) {
            "showMessage" -> {
                val message = msg["message"]?.toString().orEmpty()
                JsDebugLog.d(TAG, "UI.showMessage[$key]: $message")
                JsUiEvents.emit(JsUiEvent.Message(key, message))
                null
            }

            "showDialog" -> {
                val title = msg["title"]?.toString().orEmpty()
                val content = msg["content"]?.toString().orEmpty()
                val rawActions = msg["actions"] as? List<*>
                val actions = rawActions.orEmpty().mapNotNull { raw ->
                    val a = raw as? Map<*, *> ?: return@mapNotNull null
                    JsDialogAction(
                        text = a["text"]?.toString().orEmpty(),
                        style = a["style"]?.toString(),
                    )
                }
                // The buttons hold live JSFunction callbacks that cannot be marshalled into Kotlin,
                // so we never touch them here. Instead the shim (see [JsEngine.BRIDGE_SHIM]) stores
                // the array in a global slot *before* calling us; we only take a note of its name.
                val handle = JsSourceManager.registerDialogActions(actions.isNotEmpty())
                JsDebugLog.d(TAG, "UI.showDialog[$key]: '$title' actions=${actions.map { it.text }} handle=$handle")
                JsUiEvents.emit(JsUiEvent.Dialog(key, title, content, actions, handle))
                null
            }

            "showLoading" -> {
                val id = JsSourceManager.nextLoadingId()
                Log.d(TAG, "UI.showLoading[$key] -> $id")
                JsUiEvents.emit(JsUiEvent.Loading(id, cancellable = msg["onCancel"] != null))
                id
            }

            "cancelLoading" -> {
                val id = (msg["id"] as? Number)?.toLong() ?: return null
                JsUiEvents.emit(JsUiEvent.CancelLoading(id))
                null
            }

            "launchUrl" -> {
                val url = msg["url"]?.toString().orEmpty()
                if (url.isNotBlank()) JsUiEvents.emit(JsUiEvent.LaunchUrl(url))
                null
            }

            "showInputDialog" -> {
                // NOTE: this one is genuinely `await`ed by sources (`let v = await UI.showInputDialog(...)`),
                // so a synchronous `null` would make them see the dialog's result as `undefined`
                // immediately instead of waiting for the user. Making that blocking handshake work
                // requires a reply channel back into the JS thread, which is deliberately out of
                // scope here: no source in the current index needs it (the settings UI has its own
                // input dialog for `input`-type settings), and a half-wired version would be worse
                // than none. We surface the request so the UI can at least show it, and log the gap.
                val requestId = JsSourceManager.nextInputRequestId()
                val title = msg["title"]?.toString().orEmpty()
                Log.w(TAG, "UI.showInputDialog[$key] req=$requestId unsupported (would need a JS reply channel)")
                JsUiEvents.emit(JsUiEvent.InputDialog(key, requestId, title))
                null
            }

            else -> {
                Log.d(TAG, "Unhandled UI function: ${msg["function"]}")
                null
            }
        }
    }

    /**
     * `log(level, title, content)` — forwarded to Logcat under this dispatcher's tag.
     *
     * Sources emit these while they parse a response or recover from a failure, and the old stub
     * dropped every one of them. Without them the only evidence a source leaves behind is the bare
     * string it eventually throws (jm.js's `'Invalid Data'`), which is why diagnosing a bad
     * response used to mean re-running the request by hand.
     *
     * Deliberately NOT mirrored into the on-device [JsDebugLog] buffer: that buffer is what the
     * floating debug overlay renders, and source logs are far too chatty to put in front of a user.
     * Logcat is the right sink — it survives the session and costs nothing when nobody is watching.
     */
    private fun log(msg: Map<*, *>) {
        val level = (msg["level"] as? String)?.lowercase()
        val title = msg["title"]?.toString().orEmpty()
        val content = msg["content"]?.toString().orEmpty()
        val line = buildString {
            if (title.isNotBlank()) append("[").append(title).append("] ")
            append(content)
        }
        if (line.isBlank()) return
        when (level) {
            "error" -> Log.e(TAG, line)
            "warning", "warn" -> Log.w(TAG, line)
            "info" -> Log.i(TAG, line)
            else -> Log.d(TAG, line)
        }
    }

    /**
     * `Network.*` — reuses Aniyomi's shared OkHttp client (cookies, UA, Cloudflare, DoH).
     *
     * ### Why this returns a JSON **String** and not a `Map`
     *
     * `wang.harlon.quickjs`'s `JSCallFunction` return-value marshalling only supports primitives
     * (`String`, `Boolean`, numeric) and `JSObject`/`JSArray`/`JSFunction` handles. A plain
     * `java.util.Map` throws `Unsupported Java type java.util.LinkedHashMap` **in native code**,
     * which means the bridged call silently evaluates to `undefined` on the JS side.
     *
     * That single fact broke every network-dependent feature: `init.js` does
     * `let result = await sendMessage({method:'http', ...}); if (result.error) ...` — with
     * `result === undefined` that line throws `cannot read property 'error' of undefined`, `fetch`
     * rejects, and the source's own `catch {}` swallows it. It surfaced as "刷新域名列表 does
     * nothing" and as `cannot read property 'NaN' of undefined` during login.
     *
     * So the payload travels as a JSON object literal instead — `String` is a supported return
     * type — with the binary body base64-encoded. `init.js` decodes it in `Network.fetchBytes`.
     */
    private fun http(msg: Map<*, *>): Any = executeEnvelope(msg)

    /**
     * Async leg of the http bridge (`__http_async`, capability-probed by [JsEngine.BRIDGE_SHIM]).
     *
     * Returns `null` **immediately** — the JS thread is not blocked — and completes the request on
     * [asyncScope]; the response envelope is handed back to JS through [JsEngine.deliverHttp],
     * which resolves the very Promise the shim created for the caller. This is what lets several
     * source requests be in flight at once (jm.js's `init()` domain fetch no longer pins the
     * thread a detail-page `loadInfo` needs), and what keeps one hanging server from freezing
     * every JS-side feature for up to the client timeout.
     */
    private fun httpAsync(msg: Map<*, *>): Any? {
        val cbId = msg["__cb"] as? String ?: return httpError("__http_async missing __cb")
        asyncScope.launch {
            val envelope = runCatching { executeEnvelope(msg) }.getOrElse { e ->
                httpError("${e.javaClass.simpleName}: ${e.message?.take(200)}")
            }
            engine.deliverHttp(
                cbId,
                Base64.getEncoder().encodeToString(envelope.toByteArray(Charsets.UTF_8)),
            )
        }
        return null
    }

    /**
     * Async leg of the `delay` bridge (`__delay_async`, used by [JsEngine.BRIDGE_SHIM] whenever the
     * async-http capability is present).
     *
     * ### Why `delay` must not stay synchronous
     *
     * The old implementation was `Thread.sleep(time)` **on the JS thread** — the bridge runs inside
     * `evaluate()`, so the sleep pinned the ONLY QuickJS thread for the whole duration. That breaks
     * the Venera contract (Dart's `delay` returns a Promise; the JS isolate keeps running) and it is
     * especially toxic for the library update: `init.js` builds `setTimeout`/`setInterval` on this
     * method, so ANY source-side timer or retry backoff (`await delay(ms)`) froze every in-flight
     * chain — the update's `loadInfo` pumps, the downloader's `onImageLoad` evals, everything — for
     * the full sleep, every time it fired.
     *
     * The async leg parks the caller's promise in JS (same `__httpPending` map the http bridge uses),
     * sleeps on [asyncScope], and completes it through [JsEngine.deliverHttp] → `__httpDeliver`. The
     * payload is the empty string (base64 `""` decodes to empty bytes → `""`), which the awaiting
     * source ignores: `await delay(ms)` only cares about the timing.
     */
    private fun delayAsync(msg: Map<*, *>): Any? {
        val cbId = msg["__cb"] as? String ?: return httpError("__delay_async missing __cb")
        val time = (msg["time"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
        asyncScope.launch {
            if (time > 0) kotlinx.coroutines.delay(time)
            engine.deliverHttp(cbId, "")
        }
        return null
    }

    /**
     * Synchronous fallback for `delay`, reachable only when the async leg is unavailable
     * (`__http_async_cap` answered false — verification rigs, hosts without the async bridge).
     *
     * It still has to sleep: `delay` is one of the shim's `__SYNC_METHODS`, so its return value is
     * handed back raw rather than as a Promise — returning immediately would make every
     * `setTimeout`/`setInterval` fire instantly and destroy source-side retry backoff.
     *
     * What changed is that the sleep is **capped**, matching the shim's own 60 s ceiling on the
     * async leg. An uncapped `Thread.sleep` here pins the only QuickJS thread for the full
     * duration, and a source asking for a multi-minute delay would take the whole engine with it.
     */
    private fun delaySync(msg: Map<*, *>): Any? {
        val requested = (msg["time"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
        val time = requested.coerceAtMost(MAX_SYNC_DELAY_MS)
        if (requested > MAX_SYNC_DELAY_MS) {
            JsDebugLog.add(
                TAG,
                "delay: clamped ${requested}ms -> ${MAX_SYNC_DELAY_MS}ms (sync fallback would pin the JS thread)",
            )
        }
        if (time > 0) Thread.sleep(time)
        return null
    }

    private fun executeEnvelope(msg: Map<*, *>): String {
        val url = msg["url"] as? String ?: return httpError("missing url")
        val method = ((msg["http_method"] as? String) ?: "GET").uppercase()
        val headers = msg["headers"] as? Map<*, *>

        val builder = Request.Builder().url(url)
        headers?.forEach { (k, v) ->
            if (k == null || v == null) return@forEach
            val name = k.toString()
            val value = v.toString()
            if (name.equals("Accept-Encoding", ignoreCase = true)) {
                // Never let the server choose a codec OkHttp cannot decode. See [sanitizeAcceptEncoding].
                sanitizeAcceptEncoding(value)?.let { builder.header(name, it) }
            } else {
                builder.header(name, value)
            }
        }

        val data = msg["data"]
        val body = when (data) {
            is ByteArray -> data.toRequestBody()
            is String -> data.toRequestBody()
            else -> null
        }
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete(body)
            "POST" -> builder.post(body ?: ByteArray(0).toRequestBody())
            "PUT" -> builder.put(body ?: ByteArray(0).toRequestBody())
            "PATCH" -> builder.patch(body ?: ByteArray(0).toRequestBody())
            else -> builder.method(method, body)
        }

        return try {
            bridgeClient.newCall(builder.build()).execute().use { resp ->
                val raw = resp.body.bytes()
                // OkHttp strips this header itself when it decompressed transparently (i.e. when the
                // *caller* did not set `Accept-Encoding`), so a value here means the bytes above are
                // still compressed and it is on us to decode them. See [sanitizeAcceptEncoding].
                val encoding = resp.header("Content-Encoding")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                val decoded = when (encoding) {
                    null, "identity" -> raw
                    "gzip", "x-gzip" -> gunzip(raw)
                    "deflate" -> inflate(raw)
                    else -> return httpError(
                        "unsupported Content-Encoding: $encoding — the bridge only decodes gzip/deflate",
                    )
                }
                logExchange(method, url, resp.code, encoding, raw.size, decoded.size)

                // Built by hand rather than with a JSON lib: this module deliberately has no
                // serialization dependency, and the shape is fixed and tiny.
                buildString {
                    append("{\"status\":").append(resp.code)
                    append(",\"error\":null")
                    // Header names/values are escaped because servers do send quotes in values
                    // (e.g. `Content-Disposition: attachment; filename="x"`), which would otherwise
                    // produce invalid JSON and make the whole response unparseable.
                    append(",\"headers\":{")
                    // `Content-Encoding` is dropped (the body handed to JS is already decoded, so the
                    // header would be a lie) and `Content-Length` is rewritten to the decoded size for
                    // the same reason. `names()` can repeat, hence the explicit `first` flag — an
                    // index-based check would emit a leading comma as soon as one header is skipped.
                    var first = true
                    resp.headers.names().forEach { name ->
                        if (name.equals("Content-Encoding", ignoreCase = true)) return@forEach
                        val value = if (name.equals("Content-Length", ignoreCase = true)) {
                            decoded.size.toString()
                        } else {
                            resp.headers.values(name).joinToString(", ")
                        }
                        if (!first) append(',')
                        first = false
                        append('"').append(name.escapeJson()).append("\":\"")
                        append(value.escapeJson()).append('"')
                    }
                    append("},\"body\":\"")
                    append(Base64.getEncoder().encodeToString(decoded))
                    append("\"}")
                }
            }
        } catch (e: Exception) {
            // The failure path used to leave NO trace at all: the caller only saw a JSON envelope
            // with `status: null`, which a source reports as「Invalid Status Code: null」or, worse,
            // swallows. Log and remember it so the diagnostic surface can show what actually
            // happened (DNS failure, connect timeout, reset…).
            val line = "$method ${url.take(110)} -> FAILED ${e.javaClass.simpleName}: ${e.message}"
            lastExchange = line
            JsDebugLog.add(TAG, "http $line")
            httpError(e.message ?: e.toString())
        }
    }

    /**
     * ### Why a caller-supplied `Accept-Encoding` breaks everything
     *
     * Venera sources impersonate desktop Chrome, so they send
     * `Accept-Encoding: gzip, deflate, br, zstd` (`jm.js`'s `baseHeaders`). OkHttp forwards that
     * verbatim, and it only decompresses **transparently** when *it* added the header itself:
     *
     *     // okhttp3.internal.http.BridgeInterceptor
     *     transparentGzip = userRequest.header("Accept-Encoding") == null && userRequest.header("Range") == null
     *
     * A caller-supplied header therefore disables the single code path that would have decoded the
     * response — and OkHttp has no brotli/zstd support to fall back on. Meanwhile Cloudflare honours
     * the header and prefers `zstd` > `br` > `gzip`.
     *
     * Measured against the live endpoint, sending `jm.js`'s exact header set:
     *
     *     Content-Encoding: zstd
     *     00000000: 28b5 2ffd 0058 4d06 ...     ← `28 b5 2f fd` is the Zstandard magic
     *
     * The compressed bytes were then base64'd, shipped to JS, and handed straight to the source's
     * `JSON.parse(res.body)` — which is why a **200 OK** surfaced as a parse error whose offending
     * token looked empty:
     *
     *     SyntaxError: unexpected token: ''      ← really `unexpected token: '<0x1F>'`
     *
     * QuickJS formats that message as `unexpected token: '%.*s'`, so the token IS printed — but the
     * first byte of a compressed stream is a control character (`0x1F` for gzip, `0x0B`/`0x1B` for
     * brotli, `0x28` for zstd), and a control character is invisible in a log line. That is what made
     * this look like "the server returned an empty body" for a whole round of debugging. The line
     * logged by [logExchange] now makes the distinction explicit.
     *
     * @return the same value minus the codecs we cannot decode, or `null` when nothing survives —
     *   in which case the caller drops the header entirely so OkHttp adds its own `gzip` and gunzips
     *   for us.
     */
    private fun sanitizeAcceptEncoding(value: String): String? = value
        .split(',')
        .map { it.substringBefore(';').trim().lowercase() }
        .filter { it in DECODABLE_ENCODINGS }
        .joinToString(", ")
        .takeIf { it.isNotEmpty() }

    private fun gunzip(raw: ByteArray): ByteArray =
        GZIPInputStream(raw.inputStream()).use { it.readBytes() }

    /**
     * `Content-Encoding: deflate` is ambiguous in the wild: RFC 7230 says zlib-wrapped, but plenty of
     * servers send a raw deflate stream. Try zlib first, then raw.
     */
    private fun inflate(raw: ByteArray): ByteArray =
        runCatching { InflaterInputStream(raw.inputStream()).use { it.readBytes() } }
            .getOrElse { InflaterInputStream(raw.inputStream(), Inflater(true)).use { it.readBytes() } }

    /**
     * One line per exchange, into the on-screen debug buffer.
     *
     * "200 OK, but the source chokes on the body" is otherwise indistinguishable from a transport
     * failure. `raw` is the byte count off the wire and `out` is the byte count after decoding:
     * equal means nothing was decompressed, different means the server compressed and we decoded.
     */
    private fun logExchange(method: String, url: String, code: Int, encoding: String?, raw: Int, out: Int) {
        val suffix = when {
            raw == 0 -> "  (EMPTY BODY)"
            raw != out -> "  (decoded $encoding)"
            else -> ""
        }
        val line = "$method ${url.take(110)} -> $code enc=${encoding ?: "-"} raw=$raw out=$out$suffix"
        lastExchange = line
        JsDebugLog.add(TAG, "http $line")
    }

    /**
     * One-line summary of the most recent bridge HTTP exchange, success **or** failure.
     *
     * ### Why this exists
     *
     * A Venera source reports its own failures as bare strings with no context — jm.js throws
     * exactly `'Invalid Data'` when `JSON.parse(res.body)` succeeds but `json.data` is not a string,
     * and Aniyomi surfaces that verbatim as `禁漫天堂: Invalid Data`. That message cannot be acted
     * on: it does not say which URL, nor whether the server answered `200` with an off-spec envelope
     * (site side) or something else entirely (network side).
     *
     * [JsMangaSource] therefore appends this to the exception it raises, so the snackbar reads
     * e.g. `禁漫天堂: Invalid Data（最近请求：GET https://…/album → 200）`. The distinction is the
     * whole diagnosis: `→ 200` with a bad body is the remote end misbehaving, anything else is
     * transport/domain trouble on this end.
     */
    @Volatile
    private var lastExchange: String? = null

    fun lastExchangeSummary(): String? = lastExchange

    /** Same JSON-string shape as [http], so `init.js` can decode both paths identically. */
    private fun httpError(message: String): String =
        "{\"status\":null,\"headers\":{},\"body\":null,\"error\":" +
            "\"${message.escapeJson()}\"}"

    /** Minimal JSON string escaping — enough for header names, header values and error text. */
    private fun String.escapeJson(): String = buildString(length) {
        for (c in this@escapeJson) {
            when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }

    /**
     * `Html.*` — Venera's handle-based DOM, implemented with Jsoup.
     *
     * One [JsHtmlBridge] per dispatcher (per engine): the handle registry dies with the runtime,
     * exactly like Dart's per-engine `_documents` map. See [JsHtmlBridge] for the full contract —
     * this used to be a `null` stub, which is how the first HTML-parsing source (GoDa漫画)
     * surfaced as `not a function`.
     */
    private val htmlBridge = JsHtmlBridge()

    private fun html(msg: Map<*, *>): Any? = htmlBridge.handle(msg)

    /**
     * `Convert.*` — encodings and hashes.
     *
     * ### Type handling
     *
     * `value` is either a `String` (when the source encodes) or a `byte[]` (when it decodes — a JS
     * `ArrayBuffer` arrives as `byte[]`, see `JsValueConversion.kt::readProperties`).
     *
     * The casts are guarded rather than bare: a bare `value as ByteArray` turned a genuine
     * argument-marshalling problem into an opaque
     * `ClassCastException: java.util.LinkedHashMap cannot be cast to byte[]` that surfaced only as
     * "刷新域名列表 失败" in the UI. Reporting the actual type makes the next occurrence diagnosable
     * from the log alone.
     */
    private fun convert(msg: Map<*, *>): Any? {
        val type = msg["type"] as? String ?: return null
        val encode = msg["isEncode"] as? Boolean ?: false
        val value = msg["value"]

        fun bytes(what: String): ByteArray? {
            if (value is ByteArray) return value
            JsDebugLog.add(TAG, "convert.$type: expected ByteArray for $what, got ${value?.javaClass?.simpleName}")
            return null
        }

        return when (type) {
            "utf8" -> if (encode) {
                (value as? String)?.toByteArray(Charsets.UTF_8)
            } else {
                bytes("decodeUtf8")?.toString(Charsets.UTF_8)
            }

            "base64" -> if (encode) {
                bytes("encodeBase64")?.let { Base64.getEncoder().encode(it) }
            } else {
                // ### Why `getMimeDecoder` and not `getDecoder`
                //
                // The jm domain-list endpoint answers HTTP 200 with a **UTF-8 BOM** in front of its
                // base64 text (`efbb bf` = U+FEFF, then `X+bnz...`). Venera's Dart `base64Decode`
                // skips characters outside the alphabet, so the BOM is harmless there.
                //
                // Java's `Base64.getDecoder()` is strict and throws `IllegalArgumentException` on
                // *any* stray character — BOM, trailing newline, embedded CRLF, leading spaces.
                // Measured on Temurin 17 (ref-quickjs-android/Base64Probe.java):
                //
                //   input                     getDecoder()             getMimeDecoder()
                //   <BOM>aGVsbG8gd29ybGQ=     IllegalArgumentException   ok
                //   aGVsbG8gd29ybGQ=<LF>      IllegalArgumentException   ok
                //   aGVs<LF>bG8g<LF>d29ybGQ=  IllegalArgumentException   ok
                //     aGVsbG8gd29ybGQ=        IllegalArgumentException   ok
                //
                // Wrapped in `runCatching { }.getOrNull()` that became a **silent null**, which is
                // how `refreshDomains` ended up with `Convert.decodeUtf8(..., got null)` and then
                // `cannot read property 'length' of undefined` in jm.js's own `while (start <
                // res.length)` loop. `getMimeDecoder()` matches Dart's tolerance exactly.
                //
                // Deliberately NOT hand-stripping the BOM: a MIME decoder already skips it, and an
                // extra `replace` is one more place to get the character class wrong.
                val text = value as? String
                if (text == null) {
                    JsDebugLog.add(TAG, "convert.base64: expected String, got ${value?.javaClass?.simpleName}")
                    return null
                }
                runCatching { Base64.getMimeDecoder().decode(text) }.onFailure {
                    // Surface the reason instead of degrading to null: the previous silent null is
                    // what made this bug take three rounds of device logs to find.
                    JsDebugLog.add(TAG, "convert.base64: decode failed (${text.length} chars): ${it.message}")
                }.getOrNull()
            }

            "gbk" -> if (encode) {
                (value as? String)?.toByteArray(charset("GBK"))
            } else {
                bytes("decodeGbk")?.toString(charset("GBK"))
            }

            "md5" -> bytes("md5")?.let { digest("MD5", it) }
            "sha1" -> bytes("sha1")?.let { digest("SHA-1", it) }
            "sha256" -> bytes("sha256")?.let { digest("SHA-256", it) }
            "sha512" -> bytes("sha512")?.let { digest("SHA-512", it) }

            "hmac" -> hmac(msg, value, encode)

            "aes-ecb" -> aes(msg, value, encode, "ECB", iv = null)
            "aes-cbc" -> aes(msg, value, encode, "CBC", iv = msg["iv"])
            "aes-cfb", "aes-ofb" -> aes(msg, value, encode, if (type == "aes-cfb") "CFB" else "OFB", iv = msg["iv"])

            else -> {
                // Previously this silent fall-through returned the raw handle, which the JSON
                // return-leg then turned into a meaningless object — the source kept running with
                // garbage instead of failing loudly (`cannot read property 'length' of undefined`).
                JsDebugLog.add(TAG, "convert: unsupported type '$type' (isEncode=$encode)")
                null
            }
        }
    }

    private fun digest(algo: String, value: ByteArray): ByteArray =
        MessageDigest.getInstance(algo).digest(value)

    /**
     * `Convert.hmac(key, value, hash)` → raw digest bytes, `Convert.hmacString(...)` → hex string.
     *
     * Note the argument order in Venera is **key first** (`hmac(key, value, hash)`), which is the
     * opposite of the usual `hmac(message, key)` convention — getting it backwards still produces a
     * plausible-looking hash, so it is easy to ship broken.
     */
    private fun hmac(msg: Map<*, *>, value: Any?, encode: Boolean): Any? {
        val key = msg["key"]
        if (key !is ByteArray) {
            JsDebugLog.add(TAG, "convert.hmac: expected ByteArray key, got ${key?.javaClass?.simpleName}")
            return null
        }
        if (value !is ByteArray) {
            JsDebugLog.add(TAG, "convert.hmac: expected ByteArray value, got ${value?.javaClass?.simpleName}")
            return null
        }
        val algo = when ((msg["hash"] as? String)?.lowercase()) {
            "md5" -> "HmacMD5"
            "sha1" -> "HmacSHA1"
            "sha256" -> "HmacSHA256"
            "sha512" -> "HmacSHA512"
            else -> {
                JsDebugLog.add(TAG, "convert.hmac: unsupported hash '${msg["hash"]}'")
                return null
            }
        }
        val mac = Mac.getInstance(algo).apply { init(SecretKeySpec(key, algo)) }.doFinal(value)
        // `isString` selects Venera's `hmacString` variant, which returns hex text rather than bytes.
        return if (msg["isString"] == true) mac.toHexString() else mac
    }

    /**
     * AES block ciphers, mirroring `venera/lib/foundation/js_engine.dart:442`.
     *
     * ### The two behaviours that must be copied exactly
     *
     * Venera drives BouncyCastle's `processBlock` directly:
     *
     * ```dart
     * var result = Uint8List(value.length);
     * while (offset < value.length) offset += cipher.processBlock(value, offset, result, offset);
     * ```
     *
     * 1. **NoPadding — on both directions.** `processBlock` moves exactly one 16-byte block and
     *    `result.length == value.length`, so there is *no* PKCS#7 padding on encrypt and, crucially,
     *    **no unpadding on decrypt**. The decrypted plaintext therefore keeps its trailing padding
     *    bytes; `jm.js::convertData` copes by scanning forward for the first `{` / `[` rather than
     *    trusting index 0. A port that "helpfully" strips padding would diverge from Venera and
     *    corrupt every payload whose last block happens to end in a byte < 0x11.
     *
     * 2. **A partial trailing block is dropped**, not padded: the loop stops before a final
     *    short block, so the output is `floor(len / 16) * 16` bytes. JDK's `NoPadding` instead
     *    *throws* on a short input, so we trim to a block boundary ourselves to reproduce Venera's
     *    tolerance (a truncated response should still decrypt what it can).
     *
     * The key length selects the AES variant (16/24/32 → AES-128/192/256) exactly as
     * `KeyParameter(key)` does; jm.js derives a 32-byte key, i.e. AES-256.
     */
    private fun aes(msg: Map<*, *>, value: Any?, encode: Boolean, mode: String, iv: Any?): ByteArray? {
        if (value !is ByteArray) {
            JsDebugLog.add(TAG, "convert.aes-$mode: expected ByteArray value, got ${value?.javaClass?.simpleName}")
            return null
        }
        val key = msg["key"]
        if (key !is ByteArray || key.isEmpty()) {
            JsDebugLog.add(TAG, "convert.aes-$mode: expected non-empty ByteArray key, got ${key?.javaClass?.simpleName}")
            return null
        }
        if (key.size != 16 && key.size != 24 && key.size != 32) {
            // Java rejects these outright; say why, since the source's own key derivation is the
            // likely culprit (`Convert.encodeUtf8(Convert.hexEncode(Convert.md5(...)))` = 32 bytes).
            JsDebugLog.add(TAG, "convert.aes-$mode: key must be 16/24/32 bytes, got ${key.size}")
            return null
        }

        val needsIv = mode == "CBC" || mode == "CFB" || mode == "OFB"
        val ivBytes = (iv as? ByteArray)?.takeIf { it.size == 16 }
        if (needsIv && ivBytes == null) {
            JsDebugLog.add(TAG, "convert.aes-$mode: expected 16-byte IV, got ${iv?.javaClass?.simpleName}")
            return null
        }

        // Venera's loop drops a partial tail instead of throwing.
        val body = if (value.size % 16 == 0) value else value.copyOf((value.size / 16) * 16)
        if (body.isEmpty()) {
            JsDebugLog.add(TAG, "convert.aes-$mode: input shorter than one block (${value.size} bytes)")
            return ByteArray(0)
        }

        return runCatching {
            val cipher = Cipher.getInstance("AES/$mode/NoPadding")
            val spec = if (needsIv) {
                IvParameterSpec(ivBytes!!)
            } else {
                null
            }
            cipher.init(if (encode) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), spec)
            cipher.doFinal(body)
        }.onFailure {
            JsDebugLog.add(TAG, "convert.aes-$mode failed: ${it.javaClass.simpleName}: ${it.message}")
        }.getOrNull()
    }

    private fun ByteArray.toHexString(): String =
        joinToString("") { "%02x".format(it) }

    /**
     * `Network.getCookies/setCookies/deleteCookies` — backed by the app's shared cookie jar.
     *
     * ### What this actually fixes (it is narrower than "cookies never worked")
     *
     * `bridgeClient` is `network.client.newBuilder()`, and `newBuilder()` carries the client's
     * `cookieJar` across — so OkHttp was ALREADY storing and replaying cookies for bridge requests
     * on its own. What the stub broke is the *explicit* API sources call on top of that:
     *
     *   • `jm.js`'s `logout()` walks `JM.apiDomains` and calls `Network.deleteCookies(url)` for
     *     each. That returned `null` and cleared nothing, so logging out left the session cookies
     *     in place and the source stayed authenticated.
     *   • `getCookies` returning `null` is worse than a no-op: a source that reads a cookie to
     *     decide whether it is logged in sees `undefined` and takes the wrong branch.
     *
     * ### Shapes
     *
     * `init.js` models a cookie as `{ name, value, domain }`, so `get` returns plain maps carrying
     * exactly those keys. Anything non-primitive crossing back into JS goes through
     * `JsEngine.toJsReturnValueInline` → JSON → `parseJSON`, and both `Map` and `Iterable`
     * serialise cleanly there, so the result arrives as an array of real JS objects.
     *
     * `set` falls back to the request host when a cookie carries no `domain`: `Cookie.Builder`
     * requires one, and a source that only knows `name`/`value` (the common case) would otherwise
     * throw and lose the whole batch.
     *
     * A nested array of cookie objects reaches us as `List<Map<*, *>>` — `readProperties`
     * normalises JS arrays element by element (see `JsValueConversion.kt`).
     */
    private fun cookie(msg: Map<*, *>): Any? {
        val rawUrl = msg["url"] as? String
        val url = rawUrl?.toHttpUrlOrNull()
        if (url == null) {
            JsDebugLog.add(TAG, "cookie: unusable url '$rawUrl' (function=${msg["function"]})")
            return null
        }
        return when (val function = msg["function"] as? String) {
            "get" -> network.cookieJar.get(url).map { c ->
                mapOf("name" to c.name, "value" to c.value, "domain" to c.domain)
            }

            "set" -> {
                val raw = msg["cookies"] as? List<*>
                val cookies = raw.orEmpty().mapNotNull { entry ->
                    val m = entry as? Map<*, *> ?: return@mapNotNull null
                    val name = m["name"]?.toString()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    val value = m["value"]?.toString() ?: return@mapNotNull null
                    val domain = m["domain"]?.toString()?.takeIf { it.isNotBlank() } ?: url.host
                    runCatching { Cookie.Builder().name(name).value(value).domain(domain).build() }
                        .onFailure { JsDebugLog.add(TAG, "cookie.set: cannot build '$name': ${it.message}") }
                        .getOrNull()
                }
                if (cookies.isEmpty()) {
                    JsDebugLog.add(TAG, "cookie.set[${url.host}]: no usable cookie out of ${raw?.size ?: 0}")
                    return null
                }
                network.cookieJar.saveFromResponse(url, cookies)
                Log.d(TAG, "cookie.set[${url.host}]: ${cookies.map { it.name }}")
                null
            }

            "delete" -> {
                val removed = network.cookieJar.remove(url)
                Log.d(TAG, "cookie.delete[${url.host}]: removed=$removed")
                null
            }

            else -> {
                JsDebugLog.add(TAG, "cookie: unsupported function '$function'")
                null
            }
        }
    }

    /**
     * `compute(func, ...args)` — **not implemented**, and deliberately loud about it.
     *
     * A genuine `JsPool` (a second QuickJS runtime on its own thread) is a real feature, not a
     * marshalling fix, because the callable cannot leave this runtime: JS function values are
     * dropped by the wrapper's object conversion (see S5), and a QuickJS context may only be
     * touched from the thread that created it (S2). So the function has to be invoked by
     * re-entering *this* engine — the very thread we are already running on — which means there is
     * nothing to offload yet.
     *
     * No source in the current index calls this, which is why the old silent `null` went unnoticed
     * for so long. We now record the request instead: a source that starts using it will say so in
     * the debug buffer rather than quietly misreading `undefined` as a result.
     */
    private fun compute(msg: Map<*, *>): Any? {
        JsDebugLog.add(
            TAG,
            "compute: unsupported (a JS function cannot cross the bridge; a real JsPool is separate work)",
        )
        return null
    }

    private fun random(msg: Map<*, *>): Number {
        val min = (msg["min"] as? Number)?.toDouble() ?: 0.0
        val max = (msg["max"] as? Number)?.toDouble() ?: 1.0
        val v = min + (max - min) * Math.random()
        return if (msg["type"] == "double") v else v.toLong()
    }

    private companion object {
        /**
         * The codecs the bridge can decode itself. `br` and `zstd` are deliberately absent: OkHttp
         * decodes neither, so offering them only invites a response we would have to throw away.
         * `identity` is kept so a source can explicitly opt out of compression.
         */
        val DECODABLE_ENCODINGS = setOf("gzip", "x-gzip", "deflate", "identity")

        /**
         * Ceiling for the synchronous `delay` fallback. Mirrors the shim's own 60 s cap on the
         * async leg so both paths agree on what a pathological "delay" may cost.
         */
        const val MAX_SYNC_DELAY_MS = 60_000L
    }
}
