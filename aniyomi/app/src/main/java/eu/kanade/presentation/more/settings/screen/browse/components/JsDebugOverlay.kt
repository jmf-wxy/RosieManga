package eu.kanade.presentation.more.settings.screen.browse.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import eu.kanade.tachiyomi.util.system.toast
import tachiyomi.presentation.core.components.material.padding

/**
 * Floating diagnostic console for devices whose `logcat` is unusable.
 *
 * vivo/OriginOS (and some other OEM ROMs) strip third-party app output from `logcat` entirely — a
 * larger log buffer does not help, and `adb logcat --pid=<app>` returns nothing while the app is
 * demonstrably alive and foregrounded. That makes remote diagnosis impossible, so the diagnostic
 * lines are surfaced **on the device** instead: a small bug button that opens a scrollable panel
 * with 清除 / 复制 actions, so the user can read them out or paste them back.
 *
 * Nothing here is shown unless the source config page is open, and the buffer lives in
 * [JsDebugLog] (process-wide), so opening the overlay later still shows what happened earlier.
 */
@Composable
fun JsDebugOverlay(modifier: Modifier = Modifier) {
    val lines by JsDebugLog.lines.collectAsState()
    var expanded by remember { mutableStateOf(false) }

    if (expanded) {
        JsDebugPanel(
            lines = lines,
            onClose = { expanded = false },
            modifier = modifier,
        )
    } else {
        FilledTonalIconButton(
            onClick = { expanded = true },
            modifier = modifier.size(44.dp),
        ) {
            Icon(Icons.Outlined.BugReport, contentDescription = "调试日志(${lines.size})")
        }
    }
}

@Composable
private fun JsDebugPanel(
    lines: List<String>,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val listState = rememberLazyListState()

    // Jump to the newest line whenever one arrives, so the panel reads like a live tail.
    LaunchedEffect(lines.size) {
        if (lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex)
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier
            .fillMaxWidth()
            .height(360.dp),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // --- header: title + count + 清除 / 复制 / 关闭 ---
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = MaterialTheme.padding.medium, end = MaterialTheme.padding.small),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "调试日志 (${lines.size})",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { JsDebugLog.clear() }) {
                    Icon(Icons.Outlined.Delete, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("清除", modifier = Modifier.padding(start = 4.dp))
                }
                TextButton(
                    onClick = {
                        if (lines.isEmpty()) {
                            context.toast("没有日志可复制")
                        } else {
                            clipboard.setText(AnnotatedString(JsDebugLog.dump()))
                            context.toast("已复制 ${lines.size} 行")
                        }
                    },
                ) {
                    Icon(Icons.Outlined.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("复制", modifier = Modifier.padding(start = 4.dp))
                }
                FilledTonalIconButton(onClick = onClose, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Outlined.Close, contentDescription = "关闭")
                }
            }

            // --- body: monospace, newest last ---
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(horizontal = MaterialTheme.padding.medium),
            ) {
                if (lines.isEmpty()) {
                    Text(
                        text = "暂无日志。点「刷新域名列表」或「登录」后回到这里查看。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = MaterialTheme.padding.small),
                    )
                } else {
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                        items(lines) { line ->
                            Text(
                                text = line,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = if (line.contains("REJECTED") || line.contains("THREW") ||
                                    line.contains("ABORT") || line.contains("超时")
                                ) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurface
                                },
                                modifier = Modifier.padding(vertical = 1.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
