package eu.kanade.tachiyomi.source.manga.js

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * On-screen diagnostic log for JS sources — the escape hatch for devices whose `logcat` output is
 * unusable.
 *
 * vivo/OriginOS (and some other OEM ROMs) filter **third-party app logs out of `logcat` entirely**,
 * regardless of buffer size or log level. `adb logcat --pid=<app>` then returns nothing while the
 * app is demonstrably alive and in the foreground, which makes every "the button does nothing"
 * report impossible to diagnose from a workstation.
 *
 * `Log.d` calls stay in place (they cost nothing when filtered), but the same lines are *also* fed
 * here so the user can read them **on the phone** via the floating debug button.
 *
 * A process-wide singleton on purpose: the interesting sequence spans several layers
 * (`JsSourceConfigContent` → `JsSourceConfigScreenModel` → `JsSourceManager` → `JsEngine`), and
 * threading a store through all of them would be far more invasive than one shared sink.
 */
object JsDebugLog {

    private const val MAX_LINES = 400

    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    private val _lines = MutableStateFlow<List<String>>(emptyList())

    /** Newest-last list of formatted lines; safe to collect from Compose. */
    val lines: StateFlow<List<String>> = _lines.asStateFlow()

    /** Appends a line, keeping only the most recent [MAX_LINES]. */
    fun add(tag: String, message: String) {
        val line = "${timeFormat.format(Date())}  [$tag]  $message"
        _lines.update { current ->
            val next = current + line
            if (next.size > MAX_LINES) next.subList(next.size - MAX_LINES, next.size) else next
        }
    }

    /** Mirrors a line to `logcat` *and* the on-screen buffer. */
    fun d(tag: String, message: String) {
        Log.d(tag, message)
        add(tag, message)
    }

    fun clear() {
        _lines.value = emptyList()
    }

    /** Plain-text dump for the 复制 button. */
    fun dump(): String = _lines.value.joinToString("\n")
}
