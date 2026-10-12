package eu.kanade.tachiyomi.source.manga.js

import android.content.Context
import android.util.Log
import com.whl.quickjs.android.QuickJSLoader
import com.whl.quickjs.wrapper.JSObject
import com.whl.quickjs.wrapper.QuickJSContext
import com.whl.quickjs.wrapper.QuickJSException
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.LockSupport

/**
 * Owns ONE QuickJS runtime for the JS comic-source subsystem.
 *
 * Venera's `assets/init.js` defines the entire JS-facing API (Network / Html / Convert / UI / Utils)
 * on top of a SINGLE primitive: `sendMessage({ method, ... })`.
 *
 * So all we have to do is:
 *   1. expose `sendMessage` to JS as a synchronous [com.whl.quickjs.wrapper.JSCallFunction]
 *      that dispatches into [JsMessageDispatcher]; and
 *   2. evaluate `init.js`.
 *
 * Every Venera `*.js` comic source then runs UNCHANGED.
 *
 * Threading: the underlying wrapper asserts that a [QuickJSContext] is only ever touched from the
 * thread that created it (`QuickJSContext.checkSameThread()`), so the context is *created inside*
 * the dedicated single-thread executor and every subsequent call is funnelled through that same
 * thread. The UI thread therefore never blocks on JS work.
 *
 * Library notes (verified against the published artifacts, not guessed):
 *   • Maven `wang.harlon.quickjs:wrapper-android:3.2.0` → depends on `wrapper-java`;
 *   • Java package is `com.whl.quickjs.wrapper` (NOT `wang.harlon.quickjs`);
 *   • native `.so` is loaded by `com.whl.quickjs.android.QuickJSLoader.init()`;
 *   • `JSCallFunction` is a Java interface: `Object call(Object... args)`.
 */
class JsEngine(private val context: Context) : Closeable {

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "js-engine") }
    private val dispatcher = JsMessageDispatcher(context, this)

    /**
     * One-line summary of the last bridge HTTP exchange (or null if none yet).
     *
     * Used to give a source's bare-string failures some context — jm.js throws `'Invalid Data'`,
     * which on its own cannot be told apart from a domain/network problem. See
     * [JsMessageDispatcher.lastExchangeSummary].
     */
    fun lastHttpExchange(): String? = dispatcher.lastExchangeSummary()

    /**
     * Pending completions of async-bridge http requests (`__http_async`), handed over from OkHttp
     * callback threads and drained **on the JS thread** at the next pump tick / evaluation.
     *
     * The payload is the response envelope, base64-encoded to survive single-quote embedding in
     * the deliver script (base64's alphabet cannot break a JS string literal).
     */
    private class HttpDelivery(val cbId: String, val payloadB64: String)

    private val pendingDeliveries = ConcurrentLinkedQueue<HttpDelivery>()

    /**
     * The thread currently parked inside [pumpUntilSettled], or `null` when no pump is running.
     *
     * Used so that [deliverHttp] can wake the pump the instant an async-bridge result lands instead
     * of relying on the 1 ms poll catching a slice of background CPU. In the background the polling
     * thread is routinely starved of scheduling time, so a pure `Thread.sleep(1)` loop could sit for
     * minutes without ever draining a delivery that was already queued — which is exactly what
     * froze library updates until the app returned to the foreground. `LockSupport.unpark` on this
     * thread makes the wakeup event-driven and immune to that starvation.
     */
    private val pumpThread = AtomicReference<Thread?>(null)

    /**
     * Called from any thread (OkHttp callbacks via [JsMessageDispatcher.httpAsync]) when an
     * async-bridge request completes. Never touches the runtime directly — the delivering
     * evaluate happens on [executor], keeping the single-threaded-runtime invariant (S2).
     */
    fun deliverHttp(cbId: String, payloadB64: String) {
        pendingDeliveries.add(HttpDelivery(cbId, payloadB64))
        // Wake the pump immediately. `unpark` is a no-op (and harmless) if the pump thread is not
        // currently parked; if it fires before the pump parks, the permit is simply consumed by the
        // next `parkNanos`, so no delivery is ever lost.
        pumpThread.get()?.let { LockSupport.unpark(it) }
    }

    /**
     * Resolves the Promises created by the bridge shim's async-http branch: one evaluate per
     * delivery, invoking `globalThis.__httpDeliver(cbId, b64)` (defined in [BRIDGE_SHIM]).
     *
     * MUST run on [executor]. Callbacks that nobody waits on are simply dropped on the floor —
     * the same policy as the fire-and-forget promises sources create today.
     */
    private fun drainDeliveries(stray: MutableList<String>) {
        while (true) {
            val d = pendingDeliveries.poll() ?: return
            val outcome = evaluateTolerating(
                "typeof globalThis.__httpDeliver === 'function' && " +
                    "globalThis.__httpDeliver('${d.cbId}', '${d.payloadB64}')",
            )
            outcome.stray?.let(stray::add)
        }
    }

    /**
     * Created on [executor]'s thread, then only ever used from that thread.
     * `submit(...).get()` blocks the *constructing* thread until the runtime is ready, which is
     * deliberate: the caller (source-manager init) is already off the UI thread.
     */
    private val js: QuickJSContext = executor.submit(Callable { createContext() }).get()

    private fun createContext(): QuickJSContext {
        // Loads libquickjs-android-wrapper.so (arm64-v8a / armeabi-v7a / x86 / x86_64).
        QuickJSLoader.init()
        return QuickJSContext.create().apply {
            // Forward JS `console.log/info/warn/error` into Logcat under tag "venera-js".
            QuickJSLoader.initConsoleLog(this, "venera-js")

            val global: JSObject = getGlobalObject()
            // The single bridge primitive consumed by init.js. Exposed under a prefixed name and
            // wrapped into a Promise-returning `sendMessage` by [BRIDGE_SHIM] below.
            global.setProperty("__sendMessageSync", dispatcher.sendMessage)
            global.setProperty("appVersion", APP_VERSION)

            evaluate(BRIDGE_SHIM)
            evaluate(readAsset("init.js"))

            // One-shot self check: does this wrapper actually run promise callbacks on re-entry?
            // The answer decides whether `evalAwaiting` can work at all, and it is not documented
            // anywhere — so we measure it instead of assuming.
            selfCheckPromiseDrain(this)
        }
    }

    /**
     * Probes whether re-entering `evaluate` drains the QuickJS job queue.
     *
     * `wrapper-android` exports no `executePendingJob` binding, yet every Venera source relies on
     * `async`/`await` and `.then(...)`. If the native `evaluate` does not pump jobs, all async
     * source logic (and thus every "刷新"/"签到" button) is dead. Logging the outcome once makes
     * that binary fact visible in Logcat instead of having to guess.
     */
    private fun selfCheckPromiseDrain(context: QuickJSContext) {
        val probe = runCatching {
            context.evaluate(
                """
                globalThis.__probe = 0;
                Promise.resolve(1).then(function () { globalThis.__probe = 42; });
                globalThis.__probe
                """.trimIndent(),
            )
            val immediate = context.evaluate("globalThis.__probe")
            context.evaluate(DRAIN_JOBS)
            context.evaluate(DRAIN_JOBS)
            val afterTicks = context.evaluate("globalThis.__probe")
            context.evaluate("delete globalThis.__probe")
            immediate to afterTicks
        }.getOrNull()

        Log.i(
            TAG,
            "promise drain self-check: withinEval=${probe?.first} afterTicks=${probe?.second} " +
                "(42 after ticks => engine drains on re-entry)",
        )
    }

    /** Evaluate a JS expression and marshal the result back to Kotlin (Map / List / primitive). */
    suspend fun eval(script: String): Any? =
        withContext(executor.asCoroutineDispatcher()) { js.evaluate(script) }

    /**
     * Blocking variant, safe to call from ANY thread.
     *
     * The wrapper rejects cross-thread access, so we hop onto the JS thread and wait for the
     * result instead of touching [js] directly. Used by [JsSourceManager.add] when parsing a `.js`
     * source file during startup.
     */
    fun evalBlocking(script: String): Any? = submitLogged("evalBlocking(${script.take(40)})") {
        val stray = mutableListOf<String>()
        drainDeliveries(stray)
        val value = evaluateToleratingRetrying(script, stray)
        logStray(stray, "evalBlocking(${script.take(60)})")
        value
    }

    /**
     * Evaluates [script] **and fully converts the result to plain Kotlin** — all on the JS thread.
     *
     * This is the only correct way to read a JS **object or array** out of the engine:
     *
     *  • `evaluate()` hands back a live [JSObject]/[JSArray] handle, not a `Map`/`List`;
     *  • converting it (`toMap()`) internally calls `release()` → `QuickJSContext.freeValue()`,
     *    which asserts `checkSameThread()`.
     *
     * So running `evalBlocking(...).toMap()` from another thread throws a `QuickJSException`
     * that is easily swallowed by `runCatching` — producing an *empty* result with no visible
     * error. Reading a plain [String] never hits this, which is why `name`/`version` worked while
     * `settings` silently came back empty.
     *
     * @return a `Map`/`List`/primitive tree safe to hold and read from any thread, or `null`.
     */
    fun evalForValueBlocking(script: String): Any? = submitLogged("evalForValueBlocking(${script.take(40)})") {
        val stray = mutableListOf<String>()
        drainDeliveries(stray)
        val value = evaluateToleratingRetrying(withPlainValue(script), stray)?.toKotlinValue()
        logStray(stray, "evalForValueBlocking(${script.take(60)})")
        value
    }

    /**
     * Evaluates [script], **waits for any promise it returns to settle**, and returns the resolved
     * value as plain Kotlin data.
     *
     * ### Why a plain `evaluate` is not enough
     *
     * Sources implement their actions as `async` functions — e.g. jm.js declares
     * `callback: () => this.refreshDomains(true)` where `refreshDomains` is `async` and awaits
     * `this.post(...)`. Evaluating that expression yields a **pending Promise** and returns
     * immediately; the body of the async function only runs once the engine drains its job queue.
     *
     * The wrapper exposes no `executePendingJob` binding (the symbol exists in the .so, but there is
     * no `Java_com_whl_..._executePendingJob` entry point), so we cannot pump it directly from Java.
     * What we *can* do is hand the engine repeated opportunities to run jobs by re-entering
     * evaluation, then read the settled value back out of a global slot.
     *
     * This is exactly the difference that made the "刷新"/"签到" buttons look dead.
     */
    /** Runs [block] on the JS thread and blocks the caller until it completes. */
    private fun <T> onEngine(block: () -> T): T = executor.submit(Callable { block() }).get()

    /**
     * Diagnostic (T1, 02-18「无日志无限转圈」) variant of [onEngine] that brackets a submission with an
     * **enqueue / dequeue** pair and reports how long the JS thread took to start running it.
     *
     * The incident had **no** `JsEngine` log at all even though work was clearly outstanding, which
     * is exactly what a starved single-thread executor looks like from the outside. A dequeue line
     * that never appears, or one whose `waited` is huge, localises the stall to the executor instead
     * of the source.
     *
     * Used ONLY for the awaited entry points and the blocking single-shot evaluations. The promise
     * pump talks to the engine through the plain [onEngine] once **per 1 ms tick**, so routing its
     * re-entries through here would emit thousands of lines and flush the 400-line diagnostic buffer
     * that this instrumentation exists to preserve.
     */
    private fun <T> submitLogged(label: String, block: () -> T): T {
        val enqueuedAt = System.currentTimeMillis()
        JsDebugLog.add(TAG, "executor enqueue: $label")
        return executor.submit(Callable {
            JsDebugLog.add(TAG, "executor dequeue: $label (waited ${System.currentTimeMillis() - enqueuedAt}ms)")
            block()
        }).get()
    }

    fun evalAwaiting(script: String): Any? {
        val stray = mutableListOf<String>()
        val slot = "__await_slot_${counter.incrementAndGet()}"
        // Diagnostic (T1): a matching EXIT line is the informational log below. `ENTER` without
        // `EXIT` localises the stall to the bootstrap submit or the pump.
        JsDebugLog.add(TAG, "evalAwaiting ENTER slot=$slot script=${script.take(70)}")
        try {
            submitLogged("evalAwaiting:bootstrap") {
                drainStrayRejections(stray)
                drainDeliveries(stray)
                if (!bootstrapSlot(slot, script, stray)) {
                    logStray(stray, "evalAwaiting(${script.take(60)})")
                    throw IllegalStateException("脚本未能执行（求值槽位未创建）：${script.take(120)}")
                }
            }
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        }
        val stats = pumpUntilSettled(slot, stray)
        // The read-out AND its `toKotlinValue()` both belong to the JS thread: converting a JSObject
        // calls `release()`, which asserts `checkSameThread()`. One task, so the handle never
        // escapes the runtime's thread.
        val result = submitLogged("evalAwaiting:readout") {
            val r = evaluateToleratingRetrying("globalThis.$slot", stray)
            evaluateToleratingRetrying("delete globalThis.$slot", stray)
            r?.toKotlinValue()
        }
        JsDebugLog.d(
            TAG,
            "evalAwaiting: settled=${stats.settled} ticks=${stats.ticks} elapsed=${stats.elapsedMs}ms " +
                "stray=${stray.size} script=${script.take(70)}",
        )
        logStray(stray, "evalAwaiting(${script.take(60)})")
        return result
    }

    /**
     * Like [evalAwaiting], but **tells the caller whether the promise was rejected**.
     *
     * [evalAwaiting] deliberately swallows a rejection into `slot.error` and returns normally, which
     * makes `runCatching { evalAwaiting(...) }.isSuccess` **always true** — the trap that made a
     * failed 登录 look successful (and get persisted as a logged-in state!) while showing the user
     * nothing at all.
     *
     * This variant returns the settled outcome explicitly, so callers that must branch on
     * success/failure (login, callbacks that report errors) can check [AwaitResult.rejected]
     * instead of guessing from "did it throw".
     *
     * @return [AwaitResult.settled] with the resolved value, or [AwaitResult.rejected] with the
     *   error message, or `null` if the slot never settled within [maxTicks] re-entries.
     */
    fun evalAwaitingResult(script: String): AwaitResult? {
        val stray = mutableListOf<String>()
        val slot = "__await_slot_${counter.incrementAndGet()}"
        // Diagnostic (T1): pairs with the informational EXIT log near the end of this method.
        JsDebugLog.add(TAG, "evalAwaitingResult ENTER slot=$slot script=${script.take(70)}")
        try {
            submitLogged("evalAwaitingResult:bootstrap") {
                drainStrayRejections(stray)
                drainDeliveries(stray)
                if (!bootstrapSlot(slot, script, stray)) {
                    logStray(stray, "evalAwaitingResult(${script.take(60)})")
                    throw IllegalStateException("脚本未能执行（求值槽位未创建）：${script.take(120)}")
                }
            }
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        }
        val stats = pumpUntilSettled(slot, stray)
        // `done` is read as a *raw* evaluated value. If the wrapper ever returns something other
        // than a java.lang.Boolean here (a boxed JS value, say), `== true` silently fails and every
        // call looks "unsettled" — i.e. everything times out with no error. Logging the class is
        // what distinguishes "the promise really is slow" from "we cannot read the flag".
        val rawDone = onEngine { evaluateToleratingRetrying("globalThis.$slot.done === true", stray) }
        val done = rawDone == true
        // The value must be normalised *in JS* (`__plainValue`, defined in init.js) before Kotlin
        // ever sees it. A source may hand back a JS `Map` — jm.js's `comic.loadInfo` returns
        // `chapters` as exactly that — and the wrapper's object conversion enumerates
        // `JS_GetOwnPropertyNames`, which for a `Map` instance is EMPTY: the entries live in an
        // internal slot. Without this step `chapters` arrived as `{}`, `getChapterList` returned
        // `emptyList()`, and the detail screen greeted the user with the「没有章节」snackbar
        // (`SyncChaptersWithSource` throws `NoChaptersException` on an empty list) while the import
        // wrote no chapters at all. See the long comment on `__plainValue` in init.js.
        val value = if (done) {
            onEngine { evaluateToleratingRetrying(withPlainValue("globalThis.$slot.value"), stray)?.toKotlinValue() }
        } else {
            null
        }
        val error = if (done) {
            onEngine { evaluateToleratingRetrying("globalThis.$slot.error", stray)?.toKotlinValue() }
        } else {
            null
        }
        onEngine { evaluateToleratingRetrying("delete globalThis.$slot", stray) }
        JsDebugLog.d(
            TAG,
            "evalAwaitingResult: done(raw=${rawDone?.javaClass?.simpleName}=$rawDone) " +
                "ticks=${stats.ticks} elapsed=${stats.elapsedMs}ms stray=${stray.size} " +
                "error=${error?.let { it.toString().take(160) }} script=${script.take(70)}",
        )
        logStray(stray, "evalAwaitingResult(${script.take(60)})")
        if (!done) return null
        return if (error != null) AwaitResult.Rejected(error.toString()) else AwaitResult.Settled(value)
    }

    /**
     * Wraps an expression so that its value is normalised **in JS** before crossing into Kotlin.
     *
     * `__plainValue` (init.js) turns `Map`/`Set`/class instances into the plain shapes the wrapper's
     * `toMap()` can actually enumerate — the one thing it cannot do itself is look inside a `Map`.
     * Guarded with `typeof`, so a pre-init evaluation degrades to the old behaviour instead of
     * throwing a `ReferenceError`.
     */
    private fun withPlainValue(expr: String): String =
        "(function () { var __v = ($expr); " +
            "return (typeof globalThis.__plainValue === 'function' ? globalThis.__plainValue(__v) : __v); })()"

    /** Builds the slot + `Promise.resolve(script).then(...)` bootstrap shared by the await variants. */
    private fun slotSetup(script: String, slot: String): String =
        """
        globalThis.$slot = { done: false, value: undefined, error: undefined };
        (function () {
            try {
                Promise.resolve($script).then(
                    function (v) { if (globalThis.$slot) { globalThis.$slot.done = true; globalThis.$slot.value = v; } },
                    function (e) { if (globalThis.$slot) { globalThis.$slot.done = true; globalThis.$slot.error = String((e && e.message) || e); } }
                );
            } catch (e) {
                globalThis.$slot.done = true;
                globalThis.$slot.error = String((e && e.message) || e);
            }
        })();
        """.trimIndent()

    /**
     * Re-enters evaluation until `slot.done`, giving QuickJS a chance to run queued promise
     * callbacks. Re-entry is the only drain mechanism available (no `executePendingJob` binding).
     *
     * ### Why the budget is wall-clock-first, and no longer "64 re-entries"
     *
     * The old form stopped after a fixed 64 ticks, which is a proxy for **how many `await`s the
     * source performs** — not for time, and not for "is it stuck". Three ways that misfires:
     *
     *  • a healthy source can exceed it. `jm.js`'s `dailyCheckIn` alone adds two sequential round
     *    trips to every request, `refreshApiDomains` walks a server list, and `loadEp` is often
     *    preceded by a `/setting` probe;
     *  • the promises a source fires *without* awaiting (`getApiHeaders` → `dailyCheckIn(true)`,
     *    `init()` → `refreshImgUrl(false)`) queue jobs into the very same drain budget our chain
     *    is competing for;
     *  • a single blocking `http` bridge call makes each tick take as long as a network round trip,
     *    so "64" means nothing in wall-clock terms anyway.
     *
     * A deadline says what we actually mean. [AWAIT_MAX_TICKS] stays as a second, independent
     * guard so a pathological source cannot spin this loop forever, and the 1 ms pace keeps the
     * loop from flattening a core.
     *
     * Stray rejections are collected instead of aborting — see [evaluateTolerating].
     */
    private fun pumpUntilSettled(slot: String, stray: MutableList<String>): PumpStats {
        val startedAt = System.nanoTime()
        val deadline = startedAt + AWAIT_DEADLINE_MS * 1_000_000
        var ticks = 0
        // Register this thread so deliverHttp can unpark it. The pump runs on the *caller* thread
        // (the library-update worker, a detail load, …), never on the JS thread, so parking it does
        // not block evaluation — the JS thread keeps serving ticks via onEngine.
        pumpThread.set(Thread.currentThread())
        try {
            while (true) {
                // Each tick is its own SHORT executor task, and the caller thread does the waiting
                // between ticks. That means other queued evaluations — a search racing a detail load,
                // the image-transform re-entry, an interleaved await — can run on the JS thread while
                // this promise chain waits. The executor remains the ONLY thread that ever evaluates,
                // so the single-threaded-runtime invariant (S2) is untouched; what changed is that an
                // in-flight await no longer *occupies* the thread for its whole wall-clock wait.
                val tick = onEngine {
                    val local = mutableListOf<String>()
                    // Null-safe on purpose: a missing slot must read as "not settled yet", not throw a
                    // TypeError that would abort the pump with an error that names the wrong culprit.
                    val done = evaluateTolerating("globalThis.$slot && globalThis.$slot.done === true").let { o ->
                        o.stray?.let(local::add)
                        o.value == true
                    }
                    if (!done) {
                        // Async-bridge completions first: the delivery may be exactly what this chain
                        // (or the one interleaved with it) is waiting on.
                        drainDeliveries(local)
                        evaluateTolerating(DRAIN_JOBS).stray?.let(local::add)
                    }
                    done to local
                }
                stray.addAll(tick.second)
                if (tick.first) {
                    return PumpStats(true, ticks, (System.nanoTime() - startedAt) / 1_000_000)
                }
                if (ticks >= AWAIT_MAX_TICKS || System.nanoTime() >= deadline) {
                    return PumpStats(false, ticks, (System.nanoTime() - startedAt) / 1_000_000)
                }
                ticks++
                // Park instead of sleeping. A queued delivery unparks us instantly (see deliverHttp),
                // so a waiting source call no longer depends on a 1 ms poll catching a slice of
                // background CPU — which it routinely failed to get, freezing library updates until
                // the app returned to the foreground. The bounded timeout is a backstop against a
                // genuinely stuck promise (the 5-min deadline remains the real stuck-detector).
                LockSupport.parkNanos(PUMP_PARK_NANOS)
            }
        } finally {
            pumpThread.set(null)
        }
    }

    private data class PumpStats(val settled: Boolean, val ticks: Int, val elapsedMs: Long)

    /** One `evaluate` attempt, with a *stray* rejection kept apart from a genuine failure. */
    private class EvalOutcome(val value: Any?, val stray: String?)

    /**
     * `js.evaluate`, but a **stray** promise rejection does not abort the caller.
     *
     * ### The trap this exists for
     *
     * `libquickjs-android-wrapper.so` installs a QuickJS host promise-rejection tracker (the symbol
     * `JS_SetHostPromiseRejectionTracker` and the literal `"UnhandledPromiseRejectionException: "`
     * are both in the library) and surfaces "a promise was rejected and nobody handled it" as a
     * `QuickJSException` thrown **from the next `evaluate()` call — whichever call that happens to
     * be**.
     *
     * Venera sources fire promises they deliberately never await, and some of those rejections are
     * *expected* by design. `jm.js` is the canonical case:
     *
     * ```js
     * getApiHeaders(time) {                      // runs on EVERY request
     *     if (this.loadSetting("dailyCheckInTask")) this.dailyCheckIn(true)   // ← not awaited
     *     ...
     * }
     * async dailyCheckIn(isTask = false) {
     *     ...
     *     if (!uid) throwError("Invalid uid, please login again")   // ← no `isTask` guard
     * }
     * ```
     *
     * So one failing check-in detonates on an unrelated call — a search, a detail load, a settings
     * reflection — and, before this fix, the detonation was even reported as the wrong thing
     * entirely (see [eu.kanade.tachiyomi.source.manga.js.JsMangaSource]'s `evalSource`).
     *
     * **Why swallowing is safe here:** a rejection routed to the *tracker* is by definition one no
     * handler was ever attached to — there is nobody left who could receive it, so nothing is
     * hidden from the caller. Our own `slotSetup` chain always attaches a rejection handler
     * (`.then(onFulfilled, onRejected)`), so a failure of the script we are actually running can
     * never arrive as a stray; it lands in `slot.error` and is reported as [AwaitResult.Rejected].
     */
    private fun evaluateTolerating(script: String): EvalOutcome =
        try {
            EvalOutcome(js.evaluate(script), null)
        } catch (e: QuickJSException) {
            val message = e.message.orEmpty()
            if (message.contains(STRAY_REJECTION_MARKER)) EvalOutcome(null, message) else throw e
        }

    /**
     * [evaluateTolerating] plus one retry, for single-shot evaluations.
     *
     * The retry matters: the tracker fires *during* the evaluation it attaches to, so our script
     * may not have run at all when the stray came out. Consuming it here and evaluating again is
     * what keeps `evalBlocking`/`evalForValueBlocking` (settings reflection, login parsing) from
     * silently returning `null` for a script that never executed.
     */
    private fun evaluateToleratingRetrying(script: String, stray: MutableList<String>): Any? {
        repeat(2) {
            val outcome = evaluateTolerating(script)
            outcome.stray?.let(stray::add)
            if (outcome.stray == null) return outcome.value
        }
        return null
    }

    /** Runs the job queue so any already-queued stray rejection detonates here, not on a caller. */
    private fun drainStrayRejections(stray: MutableList<String>, rounds: Int = STRAY_DRAIN_ROUNDS) {
        repeat(rounds) { evaluateTolerating(DRAIN_JOBS).stray?.let(stray::add) }
    }

    /**
     * Creates the global slot the pump polls, retrying when a stray rejection ate the bootstrap.
     *
     * @return `false` when the slot still does not exist, i.e. the script never got to run.
     */
    private fun bootstrapSlot(slot: String, script: String, stray: MutableList<String>): Boolean {
        repeat(BOOTSTRAP_ATTEMPTS) {
            evaluateTolerating(slotSetup(script, slot)).stray?.let(stray::add)
            if (evaluateTolerating("typeof globalThis.$slot === 'object'").value == true) return true
        }
        JsDebugLog.add(TAG, "evalAwaiting: slot $slot never created for ${script.take(80)}")
        return false
    }

    private fun logStray(stray: List<String>, note: String) {
        if (stray.isEmpty()) return
        JsDebugLog.add(
            TAG,
            "$note: swallowed ${stray.size} stray rejection(s) from promises the source never " +
                "awaited, first=${stray.first().take(140)}",
        )
    }

    /** Outcome of [evalAwaitingResult]: distinguishes "resolved" from "rejected". */
    sealed interface AwaitResult {
        /** The promise resolved; [value] is its result (may be `null`). */
        data class Settled(val value: Any?) : AwaitResult

        /** The promise rejected; [message] is the reason (sources often throw plain strings). */
        data class Rejected(val message: String) : AwaitResult
    }

    // Incremented from arbitrary caller threads now that awaits pump off-executor (slot names
    // must stay unique across interleaved awaits), so this is an AtomicInteger, not a plain var.
    private val counter = AtomicInteger(0)

    /**
     * Claims the oldest unclaimed `UI.showDialog` actions array, returning its queue index.
     *
     * **Must be called from inside the bridge** (i.e. already on the JS thread). Routing this
     * through [evalBlocking] would submit to the same single-thread executor we are *currently*
     * running on and deadlock, hence the direct `evaluate` call.
     *
     * @return the queue index as a string, or `null` when nothing was queued.
     */
    fun claimDialogActionsInline(): String? = runCatching {
        js.evaluate("globalThis.__claimDialogActions && globalThis.__claimDialogActions() !== null")
        val idx = js.evaluate("globalThis.__dlgClaimed - 1")
        (idx as? Number)?.takeIf { it.toInt() >= 0 }?.toInt()?.toString()
    }.getOrNull()

    /**
     * Invokes one button of a claimed dialog.
     *
     * The array lives in JS (`__dlgQueue[index]`) precisely because its `callback`s are functions
     * that cannot be marshalled. Pumped with the same slot technique as [evalAwaiting] so an `async`
     * button body runs to completion.
     */
    fun invokeDialogAction(index: String, actionIndex: Int): Any? {
        val i = index.toIntOrNull() ?: return null
        return evalAwaiting(
            "(function () { var a = globalThis.__dlgQueue[$i]; " +
                "if (!a || !a[$actionIndex]) return undefined; " +
                "var cb = a[$actionIndex].callback; " +
                "return typeof cb === 'function' ? cb() : undefined; })()",
        )
    }

    /**
     * Converts a Kotlin value into something the wrapper can hand back to JS, **from inside the
     * bridge** (i.e. already on the JS thread — hence the `Inline` suffix and the direct `js` use;
     * any `*Blocking` variant here would submit to the executor we are running on and deadlock).
     *
     * ### Why the bridge needs this at all
     *
     * The wrapper's `JSCallFunction` return-value marshalling is implemented in native code, and
     * `libquickjs-android-wrapper.so` only understands
     * `Boolean` / `Double` / `Integer` / `Long` / `String` / `byte[]` / `JSObject` / `JSArray` /
     * `JSFunction`. Hand it a `java.util.Map` and it throws `Unsupported Java type
     * java.util.LinkedHashMap` — which the caller sees as the bridged call evaluating to
     * `undefined`, with no exception reaching JS.
     *
     * That silently broke `load_data` / `load_setting` for any source that stores an object or an
     * array (jm.js persists exactly that during login), so containers are rebuilt as real JS values
     * here rather than being passed through.
     *
     * The rebuild goes through `parseJSON`, which the wrapper implements as `createNewJSObject()`
     * (`parseJSON("{}")`) / `createNewJSArray()` (`parseJSON("[]")`) — so serialising and parsing is
     * both the shortest path and the one the library already relies on internally.
     */
    fun toJsReturnValueInline(value: Any?): Any? = when (value) {
        null -> null
        is String, is Boolean, is Int, is Long, is Double, is Float, is Short, is Byte -> value
        is ByteArray -> value
        else -> {
            // Containers (and anything else non-primitive) travel as JSON and are parsed back into
            // live JS objects. A serialisation failure degrades to `null`, matching the old
            // behaviour, but is logged rather than going silent.
            val json = runCatching { value.toJsonElement().toString() }
                .getOrElse { err ->
                    JsDebugLog.add(TAG, "toJsReturnValueInline: cannot serialise ${value.javaClass.simpleName}: ${err.message}")
                    return null
                }
            runCatching { js.parseJSON(json) }
                .onFailure { JsDebugLog.add(TAG, "toJsReturnValueInline: parseJSON failed: ${it.message}") }
                .getOrNull()
        }
    }

    private fun readAsset(name: String): String =
        context.assets.open(name).bufferedReader().use { it.readText() }

    override fun close() {
        // `destroy()` must also run on the owning thread.
        runCatching { executor.submit { js.destroy() }.get() }
        executor.shutdown()
    }

    companion object {
        private const val TAG = "JsEngine"

        /** Reported to JS as `appVersion`; must satisfy every source's `minAppVersion`. */
        const val APP_VERSION = "1.8.0"

        /**
         * Wraps the synchronous native bridge in a Promise, and re-exports it as the global
         * `sendMessage` that `init.js` expects.
         *
         * **Why this is required:** Venera's `init.js` (and every source built on it) treats
         * `sendMessage` as asynchronous — it is written as `sendMessage({...}).then(cb)` and
         * `await sendMessage({...})`. In Venera the Dart `JSInvokable` bridge is auto-promisified
         * by `flutter_qjs`. Our QuickJS wrapper has **no Promise support at all** (no
         * `executePendingJob`, no `isPromise`), so a raw synchronous return would make every
         * `.then(...)` throw `TypeError` — silently killing every network call, including the
         * "刷新 / 签到" settings buttons.
         *
         * So the native call stays synchronous (it really does block until the result is ready),
         * and we hand JS an already-settled Promise. `then`/`await` then behave exactly as the
         * sources expect, with no event loop needed: the value is available the moment it is
         * requested.
         *
         * **Dialog action parking.** `UI.showDialog(title, content, actions)` passes button
         * `callback`s as *functions*. Function values are dropped by the wrapper's object-to-map
         * conversion (`QuickJSObject.convertToMap` calls `release()` and skips them) and the
         * `JSObject` we receive is freed the moment the bridge call returns — so the only way to
         * keep those buttons alive is to hold them **here, in JS**. The shim therefore pushes every
         * outgoing actions array onto `__dlgQueue` first; the Kotlin side then claims it by index
         * (see `JsUiEvent.Dialog.handle`) and later re-enters JS to invoke the chosen button.
         */
        private val BRIDGE_SHIM = """
            globalThis.__dlgQueue = [];
            globalThis.__dlgClaimed = 0;

            /**
             * Methods the JS API documents as returning a VALUE, not a Promise.
             *
             * docs/venera-js-api.md:
             *   Convert.md5(value: ArrayBuffer): ArrayBuffer        <- no Promise
             *   Network.fetchBytes(...): Promise<{...}>             <- Promise
             *
             * Sources rely on that distinction directly. jm.js's `convertData()` reads
             *   Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8(secret))))
             * with NO `await`; in Venera the Dart side answers `Convert` calls synchronously.
             * Wrapping them in `Promise.resolve(...)` made `Convert.md5()` return a Promise, so
             * `new Uint8Array(promise)` produced an EMPTY array, `hexEncode` yielded '', the AES key
             * was garbage, and login died with the famously unhelpful
             * `cannot read property 'NaN' of undefined`.
             *
             * `await <plain value>` is legal JS, so returning a bare value here is still safe for
             * any source that does await these. Only `.then(...)` on them would break, and the API
             * never promises that.
             */
            globalThis.__SYNC_METHODS = [
                'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
                'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
                'log', 'cookie', 'delay', 'getClipboard', 'setClipboard'
            ];

            /**
             * Async-http capability probe + delivery. The dispatcher answers `true` for
             * `__http_async_cap`; any host without the async leg (verification rigs, older
             * dispatchers) returns null/undefined and the shim transparently falls back to the
             * synchronous path — the source contract never changes.
             *
             * ### Why http wants to be async
             * The sync bridge pins the JS thread for the whole round trip, so ONE hanging request
             * froze every JS-side feature (init's domain fetch blocked detail loads; a slow search
             * blocked everything else). The async branch returns a real pending Promise to the
             * caller, OkHttp runs off-thread, and Kotlin completes it through `__httpDeliver`
             * (resolved by the engine's pump between ticks). Everything except `http` keeps the
             * sync layer — the Image API is synchronous BY CONTRACT (see S3/S16) and the rest are
             * local operations.
             */
            globalThis.__httpAsyncCap = false;
            try { globalThis.__httpAsyncCap = __sendMessageSync({ method: '__http_async_cap' }) === true; } catch (e) {}
            globalThis.__httpPending = {};
            globalThis.__httpCbCounter = 0;
            globalThis.__httpDeliver = function (cbId, b64) {
                var resolve = globalThis.__httpPending[cbId];
                if (!resolve) return;
                delete globalThis.__httpPending[cbId];
                try {
                    // `Convert` comes from init.js (loaded after this shim) — fine: the body only
                    // runs when a delivery arrives, long after boot.
                    resolve(Convert.decodeUtf8(Convert.decodeBase64(b64)));
                } catch (e) { /* a delivery that cannot be decoded is dropped, like a stray */ }
            };

            globalThis.sendMessage = function (msg) {
                try {
                    if (msg && msg.method === 'UI' && msg.function === 'showDialog') {
                        // Actions close over source state, so they must be invoked from JS later.
                        globalThis.__dlgQueue.push(msg.actions || []);
                    }
                    if (msg && msg.method === 'delay' && globalThis.__httpAsyncCap) {
                        // Async leg of `delay`: park THIS promise, let Kotlin sleep off the JS
                        // thread and complete it through __httpDeliver. The synchronous fallback
                        // (below) would `Thread.sleep` ON the JS thread, pinning every other chain
                        // — init.js builds `setTimeout`/`setInterval` on this method, so one
                        // source-side timer used to freeze the whole engine (library update's
                        // loadInfo pumps, downloader evals, everything) for the full sleep.
                        // Capped at 60s: a longer "delay" is pathological for a UI source and
                        // would keep a pending entry (and possibly a pump budget) alive for it.
                        var dt = msg.time;
                        if (typeof dt !== 'number' || !(dt > 0)) return Promise.resolve(undefined);
                        if (dt > 60000) dt = 60000;
                        return new Promise(function (resolve) {
                            var cbId = '__delay_cb_' + (globalThis.__httpCbCounter++);
                            globalThis.__httpPending[cbId] = resolve;
                            __sendMessageSync({ method: '__delay_async', __cb: cbId, time: dt });
                        });
                    }
                    if (msg && msg.method === 'http' && globalThis.__httpAsyncCap) {
                        // Async leg: hand the request to Kotlin, park THIS promise. The envelope
                        // (a JSON string, same shape as the sync bridge returns) arrives later via
                        // __httpDeliver, and `Network.fetchBytes` parses it as before.
                        return new Promise(function (resolve) {
                            var cbId = '__http_cb_' + (globalThis.__httpCbCounter++);
                            globalThis.__httpPending[cbId] = resolve;
                            __sendMessageSync({
                                method: '__http_async',
                                __cb: cbId,
                                http_method: msg.http_method,
                                url: msg.url,
                                headers: msg.headers,
                                data: msg.data,
                                extra: msg.extra,
                            });
                        });
                    }
                    var value = __sendMessageSync(msg);
                    // Synchronous APIs hand back the value itself; everything else (http / html /
                    // UI / compute / image) keeps the already-settled Promise the sources expect.
                    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return value;
                    return Promise.resolve(value);
                } catch (e) {
                    return Promise.reject(e);
                }
            };
            /** Called by Kotlin to take ownership of the most recent actions array. */
            globalThis.__claimDialogActions = function () {
                if (globalThis.__dlgClaimed >= globalThis.__dlgQueue.length) return null;
                return globalThis.__dlgQueue[globalThis.__dlgClaimed++];
            };
        """.trimIndent()

        /**
         * A no-op evaluation used to **drain the QuickJS job queue**.
         *
         * QuickJS runs pending promise callbacks when control returns to the engine, but after an
         * `evaluate()` that produced `.then(...)` chains the jobs may still be queued. Evaluating
         * anything (even a literal) gives the engine a chance to run them before we read on.
         */
        private const val DRAIN_JOBS = "void 0"

        /**
         * Substring of the message the wrapper builds when QuickJS's host promise-rejection tracker
         * reports a rejection nobody attached a handler to. Literal verified in
         * `libquickjs-android-wrapper.so`; the library also references
         * `JS_SetHostPromiseRejectionTracker`, which is what makes this reachable at all.
         */
        private const val STRAY_REJECTION_MARKER = "UnhandledPromiseRejection"

        /**
         * Wall-clock budget for one awaited source call.
         *
         * Deliberately generous, because it is a **stuck-detector, not a UX budget**: each tick
         * either settles or performs a real network round trip through the synchronous bridge, and
         * the app's OkHttp client allows a 2-minute `callTimeout`, so a legitimate three-request
         * chain can occupy minutes on a bad mobile connection. Failing fast here only produces
         * false negatives — the original 64-tick form was doing exactly that.
         */
        private const val AWAIT_DEADLINE_MS = 300_000L

        /** Independent second guard against a pathological source spinning the pump forever. */
        private const val AWAIT_MAX_TICKS = 5_000

        /**
         * Pump pace. When no delivery has arrived, the loop `park`s for this long between ticks; the
         * moment an async-bridge result lands, [deliverHttp] `unpark`s it, so a waiting call is woken
         * immediately rather than on the next 1 ms poll. This is what lets library updates keep
         * draining in the background instead of freezing until the app returns to the foreground.
         */
        private const val PUMP_PARK_NANOS = 1_000_000L // 1 ms

        /** How many no-op evaluations are spent flushing queued stray rejections up front. */
        private const val STRAY_DRAIN_ROUNDS = 4

        private const val BOOTSTRAP_ATTEMPTS = 2
    }
}
