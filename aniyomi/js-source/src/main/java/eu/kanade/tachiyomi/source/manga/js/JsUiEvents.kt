package eu.kanade.tachiyomi.source.manga.js

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * UI requests raised by JS sources through Venera's `UI.*` API.
 *
 * Venera's `init.js` declares four `UI` calls — `showMessage`, `showDialog`, `showLoading`,
 * `cancelLoading` — all of which travel over the same `sendMessage({ method: 'UI', function: ... })`
 * bridge. Until now [JsMessageDispatcher] answered them with a bare `null`, which is *mechanically*
 * fine (nothing throws) but means the user sees nothing at all.
 *
 * That is what made the **刷新域名列表** button look dead: `jm.js`'s callback
 * `() => this.refreshApiDomains(true)` genuinely runs to completion — it fetches the domain list,
 * falls back to the built-in servers, and then ends in
 * `UI.showDialog("Update Failed", …, [Cancel, Apply])`. The dialog was simply being swallowed, so
 * neither the result nor the "Apply" affordance ever reached the screen.
 *
 * This is a headless, UI-toolkit-free channel: the `:js-source` module has no Compose dependency,
 * so it only *publishes* events and lets the app layer decide how to render them.
 *
 * Buffering note: [MutableSharedFlow] with `extraBufferCapacity` + `DROP_OLDEST` — a JS callback may
 * emit several events while no screen is collecting (the user is on another tab), and dropping the
 * oldest is the right trade-off: UI dialogs are inherently ephemeral.
 */
object JsUiEvents {

    private val _events = MutableSharedFlow<JsUiEvent>(
        replay = 0,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Collected by the JS-source screens; UI events are ambient, hence a SharedFlow not a Channel. */
    val events: SharedFlow<JsUiEvent> = _events.asSharedFlow()

    /** Non-suspending emit, safe to call from the JS engine thread. */
    fun emit(event: JsUiEvent) {
        _events.tryEmit(event)
    }
}

/** One `UI.*` request, normalised away from the raw JS message. */
sealed interface JsUiEvent {

    /** `UI.showMessage(message)` — a transient toast. */
    data class Message(val key: String, val message: String) : JsUiEvent

    /**
     * `UI.showDialog(title, content, actions)`.
     *
     * [actions] preserves the JS-declared order; the caller renders them and, on tap, invokes the
     * matching index through [JsSourceManager.runUiDialogAction]. [handle] identifies the live JS-side
     * actions array and must be released with [JsSourceManager.releaseDialogActions] on dismissal.
     */
    data class Dialog(
        val key: String,
        val title: String,
        val content: String,
        val actions: List<JsDialogAction>,
        val handle: String? = null,
    ) : JsUiEvent

    /**
     * `UI.showInputDialog(title, validator, image)` — returns the entered string.
     *
     * Kept as a separate event because, unlike a plain dialog, the JS side **awaits** its result:
     * `sendMessage` must not resolve until the user confirms. See
     * [JsSourceManager.pendingUiInput] for the handshake.
     */
    data class InputDialog(
        val key: String,
        val requestId: Long,
        val title: String,
    ) : JsUiEvent

    /** `UI.showLoading(onCancel)` — a blocking spinner; [id] is what `cancelLoading` refers to. */
    data class Loading(val id: Long, val cancellable: Boolean) : JsUiEvent

    /** `UI.cancelLoading(id)`. */
    data class CancelLoading(val id: Long) : JsUiEvent

    /** `UI.launchUrl(url)` — open in the system browser. */
    data class LaunchUrl(val url: String) : JsUiEvent
}

/** One button on a `UI.showDialog` dialog, as declared by the source. */
data class JsDialogAction(
    val text: String,
    /** `"text"` | `"filled"` | `"danger"`, per the init.js spec; unknown values render as normal. */
    val style: String?,
)
