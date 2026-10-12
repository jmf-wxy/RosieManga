package eu.kanade.presentation.more.settings.screen.browse.components

import android.content.Intent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import eu.kanade.tachiyomi.source.manga.js.JsUiEvent
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import tachiyomi.presentation.core.components.material.padding

private const val TAG = "JsUiEventHost"

/**
 * Renders Venera's `UI.*` requests raised by JS sources.
 *
 * This is the piece that makes the **刷新域名列表** button *look* like it works. `jm.js`'s callback
 * runs to completion but ends in `UI.showDialog("Update Failed", …, [Cancel, Apply])`; with no host
 * to render it the user saw absolutely nothing, so the button appeared dead even though the fetch,
 * the fallback to built-in domains, and the apply step were all reachable.
 *
 * Only `showDialog` / `showMessage` / `launchUrl` are handled here. `showLoading` / `cancelLoading`
 * need a cancellable blocking surface and are intentionally ignored for now (Venera sources mostly
 * use them around whole-page loads, which our own loading UI already covers).
 */
@Composable
fun JsUiEventHost(
    uiEvents: Flow<JsUiEvent>,
    onDialogAction: (handle: String?, actionIndex: Int) -> Unit,
    onDialogDismissed: (handle: String?) -> Unit,
) {
    val context = LocalContext.current
    var dialog by remember { mutableStateOf<JsUiEvent.Dialog?>(null) }

    LaunchedEffect(Unit) {
        // NOTE: `collect`, not `collectLatest`. With `collectLatest` a second event arriving while
        // the first is being handled cancels the in-flight handling — and since `showDialog` is the
        // payload that actually matters, a fast-following `showMessage` could cancel it before
        // `dialog` was ever assigned. Events here are cheap and independent, so plain `collect`
        // (sequential, no cancellation) is both correct and simpler to reason about.
        uiEvents.collect { event ->
            // Diagnostics kept deliberately: "the button does nothing" reports are ambiguous between
            // "JS never raised anything" and "the host never rendered it", and those two have
            // completely different fixes. This one line decides it — and it goes to the on-screen
            // overlay too, because OEM ROMs (vivo/OriginOS) drop third-party logs from `logcat`.
            JsDebugLog.d(TAG, "UI event -> ${event::class.simpleName}")
            when (event) {
                is JsUiEvent.Dialog -> {
                    JsDebugLog.d(
                        TAG,
                        "showDialog title='${event.title}' actions=${event.actions.size} handle=${event.handle}",
                    )
                    dialog = event
                }

                is JsUiEvent.Message -> context.toast(event.message)

                is JsUiEvent.LaunchUrl -> {
                    runCatching {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, android.net.Uri.parse(event.url))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }.onFailure { context.toast("无法打开链接") }
                }

                // A blocking spinner/cancel pair is not something a settings page should own; the
                // callback's own "执行完成" toast already signals completion.
                is JsUiEvent.Loading, is JsUiEvent.CancelLoading, is JsUiEvent.InputDialog -> Unit
            }
        }
    }

    dialog?.let { d ->
        AlertDialog(
            onDismissRequest = {
                onDialogDismissed(d.handle)
                dialog = null
            },
            title = { Text(d.title.ifBlank { "提示" }) },
            text = {
                // Venera's dialog content is multi-line (one domain per line), so it must scroll and
                // must NOT be truncated — that content is the whole point of the dialog.
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(
                        text = d.content.normalizeDialogText().ifBlank { d.title },
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 20,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            },
            confirmButton = {
                // Render the source's own buttons, in its own order — `jm.js` offers [Cancel, Apply]
                // and the Apply branch performs the actual `overwriteApiDomains`.
                d.actions.forEachIndexed { index, action ->
                    TextButton(
                        onClick = {
                            onDialogAction(d.handle, index)
                            dialog = null
                        },
                    ) {
                        Text(
                            text = action.text,
                            color = if (action.style == "danger") {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.primary
                            },
                        )
                    }
                }
            },
            // A dialog with no declared actions still needs a way out.
            dismissButton = if (d.actions.isEmpty()) {
                {
                    TextButton(
                        onClick = {
                            onDialogDismissed(d.handle)
                            dialog = null
                        },
                    ) { Text("知道了") }
                }
            } else {
                null
            },
            modifier = Modifier.padding(horizontal = MaterialTheme.padding.medium),
        )
    }
}

/**
 * Tidies a source-supplied dialog body so it does not render as a tall, mostly-blank block.
 *
 * Sources build their content by concatenating with `\n\n` separators, and 禁漫's 刷新域名列表
 * literally ends up as
 * `"Using built-in domains:\n\n線路1:  www.cdntwice.org\n\n線路2: …\n\n"` — 11 lines for 4 domains,
 * with a trailing separator. Rendered verbatim in a proportional font that is a wall of dead space
 * (exactly the tall blue block in the report).
 *
 * A blank line inside a `Text` becomes a *full* line of leading, which is far more than the visual
 * gap the sources intend, so we collapse runs of blank lines down to a single `\n` and trim the
 * ends. Deliberately NOT reflowing or word-wrapping: the content is data (domains, error text) and
 * must stay readable verbatim.
 */
private fun String.normalizeDialogText(): String =
    lineSequence()
        .map { it.trimEnd() }
        .filter { it.isNotEmpty() }
        .joinToString("\n")
        .trim()
