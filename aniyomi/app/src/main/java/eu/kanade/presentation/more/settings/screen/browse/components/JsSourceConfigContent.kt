package eu.kanade.presentation.more.settings.screen.browse.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Login
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.kanade.presentation.more.settings.screen.browse.LoginStatus
import eu.kanade.tachiyomi.source.manga.js.JsAccountMode
import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import eu.kanade.tachiyomi.source.manga.js.JsSettingItem
import eu.kanade.tachiyomi.source.manga.js.JsSourceInfo
import eu.kanade.tachiyomi.source.manga.js.JsSourceMeta
import tachiyomi.presentation.core.components.material.padding

/**
 * "漫画源" configuration list — the Aniyomi counterpart of Venera's source page.
 *
 * Layout deliberately mirrors Venera (`lib/pages/comic_source_page.dart`): one flat row per
 * setting, each separated by a hairline divider, with the control right-aligned. We do NOT put
 * every row in its own elevated card — that is what made it read as "not Venera".
 *
 * Each installed JS source expands (tap the header) into its own settings, generated from whatever
 * the source declared in JS. Rows are rendered in **declaration order** (see
 * [eu.kanade.tachiyomi.source.manga.js.JsSourceManager.meta]), matching Venera exactly.
 */
@Composable
fun JsSourceConfigContent(
    sources: List<JsSourceInfo>,
    metas: Map<String, JsSourceMeta>,
    values: Map<String, Map<String, Any?>>,
    lazyListState: LazyListState,
    paddingValues: PaddingValues,
    pendingKeys: Set<String>,
    pendingCallbacks: Set<String>,
    onReloadAll: () -> Unit,
    onSyncAll: () -> Unit,
    onUninstall: (String) -> Unit,
    onSettingChange: (key: String, settingKey: String, value: Any?) -> Unit,
    onRunCallback: (key: String, settingKey: String) -> Unit,
    /** 重新同步此源 — see [SourceConfigCard]'s resync row and the screen model's `resyncSource`. */
    onResyncSource: (key: String) -> Unit,
    onLogin: (key: String, values: List<String>) -> Unit,
    onLogout: (String) -> Unit,
    loginStatus: Map<String, LoginStatus> = emptyMap(),
    modifier: Modifier = Modifier,
) {
    var expandedKeys by remember { mutableStateOf(emptySet<String>()) }

    LazyColumn(
        state = lazyListState,
        contentPadding = paddingValues,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.padding.small),
        modifier = modifier,
    ) {
        item(key = "js_actions") {
            SourceActionRow(
                enabled = pendingKeys.isEmpty(),
                isBusy = pendingKeys.isNotEmpty(),
                onReloadAll = onReloadAll,
                onSyncAll = onSyncAll,
            )
        }

        if (sources.isEmpty()) {
            item(key = "js_empty") {
                Text(
                    text = "还没有安装任何 JS 源。点右上角「源列表」安装，或用右下角按钮导入 .js 文件。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(MaterialTheme.padding.medium),
                )
            }
        }

        items(sources, key = { "cfg_${it.key}" }) { info ->
            val meta = metas[info.key] ?: JsSourceMeta()
            val expanded = info.key in expandedKeys
            SourceConfigCard(
                info = info,
                meta = meta,
                values = values[info.key].orEmpty(),
                expanded = expanded,
                isPending = info.key in pendingKeys,
                pendingCallbacks = pendingCallbacks,
                loginStatus = loginStatus[info.key],
                onToggleExpand = {
                    expandedKeys = if (expanded) expandedKeys - info.key else expandedKeys + info.key
                },
                onUninstall = { onUninstall(info.key) },
                onSettingChange = { settingKey, value -> onSettingChange(info.key, settingKey, value) },
                onRunCallback = { settingKey -> onRunCallback(info.key, settingKey) },
                onResyncSource = { onResyncSource(info.key) },
                onLogin = { v -> onLogin(info.key, v) },
                onLogout = { onLogout(info.key) },
            )
        }
    }
}

@Composable
private fun SourceActionRow(
    enabled: Boolean,
    isBusy: Boolean,
    onReloadAll: () -> Unit,
    onSyncAll: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = MaterialTheme.padding.small),
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.padding.small),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedButton(onClick = onReloadAll, enabled = enabled) { Text("重新加载") }
        OutlinedButton(onClick = onSyncAll, enabled = enabled) { Text("检查更新") }
        if (isBusy) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    }
}

/**
 * One installed source: a header row (name · version · expand · delete) plus, when expanded, the
 * flat list of setting rows — Venera style.
 */
@Composable
private fun SourceConfigCard(
    info: JsSourceInfo,
    meta: JsSourceMeta,
    values: Map<String, Any?>,
    expanded: Boolean,
    isPending: Boolean,
    /**
     * Button tokens (`"<sourceKey>#<settingKey>"`) currently running.
     *
     * Passed down whole rather than pre-filtered per card so the token format lives in exactly one
     * place — the screen model builds it too, and a silent mismatch there would just make the
     * spinner never appear (no crash, no log), which is the worst kind of bug to chase.
     */
    pendingCallbacks: Set<String>,
    /** Last login verdict for this source, if any. Rendered under the account row. */
    loginStatus: LoginStatus?,
    onToggleExpand: () -> Unit,
    onUninstall: () -> Unit,
    onSettingChange: (String, Any?) -> Unit,
    onRunCallback: (String) -> Unit,
    onResyncSource: () -> Unit,
    onLogin: (List<String>) -> Unit,
    onLogout: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        // --- header: name + version + chevron + delete ---
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggleExpand)
                .padding(
                    start = MaterialTheme.padding.medium,
                    end = MaterialTheme.padding.small,
                    top = MaterialTheme.padding.mediumSmall,
                    bottom = MaterialTheme.padding.mediumSmall,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = info.name,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            if (info.version.isNotEmpty()) {
                VersionChip(text = info.version, modifier = Modifier.padding(start = MaterialTheme.padding.small))
            }
            if (info.isLoggedIn) {
                Text(
                    text = "已登录",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = MaterialTheme.padding.small),
                )
            }

            Row(
                modifier = Modifier.weight(1f),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (isPending) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(MaterialTheme.padding.small).size(20.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    IconButton(onClick = onUninstall) {
                        Icon(Icons.Outlined.Delete, contentDescription = "删除")
                    }
                }
                Icon(
                    imageVector = if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                    contentDescription = if (expanded) "收起" else "展开",
                )
            }
        }

        AnimatedVisibility(visible = expanded) {
            Column(modifier = Modifier.padding(bottom = MaterialTheme.padding.small)) {
                HorizontalDivider()

                // Flat rows, Venera style: title on the left, control on the right, hairline between.
                meta.settings.forEachIndexed { index, item ->
                    if (index > 0) SettingDivider()
                    when (item) {
                        is JsSettingItem.Select -> SelectRow(
                            item = item,
                            current = values[item.key] ?: item.defaultValue,
                            onChange = { onSettingChange(item.key, it) },
                        )

                        is JsSettingItem.Switch -> SwitchRow(
                            item = item,
                            current = values[item.key] as? Boolean ?: item.defaultValue,
                            onChange = { onSettingChange(item.key, it) },
                        )

                        is JsSettingItem.Input -> InputRow(
                            item = item,
                            current = values[item.key]?.toString() ?: item.defaultValue,
                            onChange = { onSettingChange(item.key, it) },
                        )

                        is JsSettingItem.Callback -> CallbackRow(
                            item = item,
                            isPending = "${info.key}#${item.key}" in pendingCallbacks,
                            onRun = { onRunCallback(item.key) },
                        )
                    }
                }

                if (meta.hasAccount) {
                    if (meta.settings.isNotEmpty()) SettingDivider()
                    AccountRow(
                        sourceName = info.name,
                        mode = meta.accountMode!!,
                        isLoggedIn = info.isLoggedIn,
                        // The account row shares the card's *header* spinner: the login call is the
                        // only other long-running action here, and `pendingKeys` already covers it
                        // (set in `onLogin`). Reusing it keeps a single "something is happening"
                        // signal instead of two spinners competing for the same row.
                        isPending = isPending,
                        status = loginStatus,
                        onLogin = onLogin,
                        onLogout = onLogout,
                    )
                }

                // 「重新同步此源」— always shown, even for a source with no settings, because it is
                // the *manual* half of the upgrade self-heal (S41): a locally-patched `.js` never
                // appears in the repo index, so `checkUpdates` cannot detect its upgrade and the
                // user needs an explicit way to force this source's library rows to re-pull.
                SettingDivider()
                ResyncRow(isPending = isPending, onResync = onResyncSource)

                if (meta.settings.isEmpty() && !meta.hasAccount) {
                    Text(
                        text = "该源没有可配置项。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(
                            horizontal = MaterialTheme.padding.medium,
                            vertical = MaterialTheme.padding.small,
                        ),
                    )
                }
            }
        }
    }
}

/** Venera's version pill: small rounded chip with a translucent fill. */
@Composable
private fun VersionChip(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .background(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(6.dp),
            )
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Indented hairline between setting rows, matching Venera's list separators. */
@Composable
private fun SettingDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = MaterialTheme.padding.medium),
        color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
    )
}

/** Shared row shell: label on the left, caller-supplied control on the right. */
@Composable
private fun SettingRow(
    title: String,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: @Composable () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = MaterialTheme.padding.medium, vertical = MaterialTheme.padding.mediumSmall),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, style = MaterialTheme.typography.bodyLarge)
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        trailing()
    }
}

/**
 * `select` — Venera renders this as a **bordered box** with the current label and a caret, not as
 * bare text. The stored value stays untouched; only the display text is shown.
 */
@Composable
private fun SelectRow(
    item: JsSettingItem.Select,
    current: Any?,
    onChange: (String) -> Unit,
) {
    var showDialog by remember { mutableStateOf(false) }

    SettingRow(
        title = item.title,
        onClick = { showDialog = true },
    ) {
        Row(
            modifier = Modifier
                .border(
                    width = 1.dp,
                    color = MaterialTheme.colorScheme.outline,
                    shape = RoundedCornerShape(6.dp),
                )
                .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = item.labelFor(current),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(
                Icons.Outlined.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (showDialog) {
        JsSettingSelectDialog(
            item = item,
            currentValue = current,
            onSelect = onChange,
            onDismiss = { showDialog = false },
        )
    }
}

@Composable
private fun SwitchRow(
    item: JsSettingItem.Switch,
    current: Boolean,
    onChange: (Boolean) -> Unit,
) {
    SettingRow(title = item.title) {
        Switch(checked = current, onCheckedChange = onChange)
    }
}

/** `input` — shows the current value underneath the title, with an explicit edit affordance. */
@Composable
private fun InputRow(
    item: JsSettingItem.Input,
    current: String,
    onChange: (String) -> Unit,
) {
    var showDialog by remember { mutableStateOf(false) }

    SettingRow(
        title = item.title,
        subtitle = current.takeIf { it.isNotBlank() },
        onClick = { showDialog = true },
    ) {
        TextButton(onClick = { showDialog = true }) { Text("编辑") }
    }

    if (showDialog) {
        JsSettingInputDialog(
            item = item,
            currentValue = current,
            onConfirm = onChange,
            onDismiss = { showDialog = false },
        )
    }
}

/**
 * `callback` — a filled pill button, matching Venera's `Button.normal`.
 *
 * While the callback runs, the spinner replaces the label **inside** the button (Venera does the
 * same). This matters: `刷新域名列表` can spend 3–5s on network round-trips, and without feedback the
 * tap reads as "the button is broken" — which is exactly how it was reported.
 */
@Composable
private fun CallbackRow(
    item: JsSettingItem.Callback,
    isPending: Boolean,
    onRun: () -> Unit,
) {
    // Diagnostic: "tapping does nothing" reports split into two very different causes — the touch
    // never reaching the button, vs. the button firing but the work failing silently. This logs the
    // moment the click is *delivered*, and mirrors to the on-screen debug overlay because OEM ROMs
    // (vivo/OriginOS) drop third-party app logs from `logcat` entirely.
    val tag = "JsSourceConfigContent"
    SettingRow(title = item.title) {
        androidx.compose.material3.FilledTonalButton(
            onClick = {
                JsDebugLog.d(
                    tag,
                    "callback button tapped: '${item.key}' (isPending=$isPending)",
                )
                onRun()
            },
            enabled = !isPending,
        ) {
            if (isPending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    // On a tonal surface the default primary colour would be low-contrast.
                    color = androidx.compose.material3.LocalContentColor.current,
                )
                Text("正在更新", modifier = Modifier.padding(start = MaterialTheme.padding.small))
            } else {
                Text(item.buttonText)
            }
        }
    }
}

/**
 * 「重新同步此源」— a per-source button that marks this source's library manga for a fresh pull.
 *
 * The **manual** entry point of the upgrade self-heal (S41). Deliberately non-destructive: only the
 * `initialized` column is reset (see `JsSourceConfigScreenModel.markSourceForResync`), so read
 * progress, history and downloads are untouched — each manga simply re-fetches its metadata and
 * chapter list the next time it is opened.
 */
@Composable
private fun ResyncRow(
    isPending: Boolean,
    onResync: () -> Unit,
) {
    SettingRow(
        title = "重新同步此源",
        subtitle = "重拉该源库内漫画的元数据与章节（不改动阅读进度）",
    ) {
        OutlinedButton(onClick = onResync, enabled = !isPending) {
            if (isPending) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                Text("同步中", modifier = Modifier.padding(start = MaterialTheme.padding.small))
            } else {
                Text("重新同步")
            }
        }
    }
}

/**
 * The account row: 登录 / 退出登录, plus an **inline verdict** of the last attempt.
 *
 * The verdict is the whole point. Previously the only feedback was a `Toast` fired from the screen
 * — and `Toast.makeText(applicationContext, ...)` is commonly rate-limited or silently dropped on
 * vivo/OriginOS, so a login could succeed or fail and the screen would look identical either way.
 * That is exactly the reported symptom ("点了登录也没反应，不知道成没成"). Text in the card cannot
 * be suppressed by the ROM, so the user always gets an answer.
 */
@Composable
private fun AccountRow(
    sourceName: String,
    mode: JsAccountMode,
    isLoggedIn: Boolean,
    isPending: Boolean,
    status: LoginStatus?,
    onLogin: (List<String>) -> Unit,
    onLogout: () -> Unit,
) {
    var showDialog by remember { mutableStateOf(false) }

    Column {
        SettingRow(title = "登录") {
            if (isLoggedIn) {
                OutlinedButton(onClick = onLogout, enabled = !isPending) {
                    Icon(Icons.Outlined.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("退出登录", modifier = Modifier.padding(start = MaterialTheme.padding.small))
                }
            } else {
                OutlinedButton(
                    onClick = {
                        JsDebugLog.d("JsSourceConfigContent", "login button tapped (mode=$mode, isPending=$isPending)")
                        showDialog = true
                    },
                    // Webview login needs a browser surface the settings screen cannot host.
                    enabled = !isPending && mode !is JsAccountMode.Webview,
                ) {
                    if (isPending) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("登录中", modifier = Modifier.padding(start = MaterialTheme.padding.small))
                    } else {
                        Icon(Icons.Outlined.Login, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text(
                            text = if (mode is JsAccountMode.Webview) "请用网页登录" else "登录",
                            modifier = Modifier.padding(start = MaterialTheme.padding.small),
                        )
                    }
                }
            }
        }

        // The verdict sits directly under the button the user just pressed. `orEmpty()` messages are
        // already user-facing text (success copy, or the source's own error like "账号或密码错误").
        status?.let {
            Text(
                text = it.message,
                style = MaterialTheme.typography.bodySmall,
                color = if (it.success) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.error
                },
                modifier = Modifier.padding(
                    start = MaterialTheme.padding.medium,
                    end = MaterialTheme.padding.medium,
                    bottom = MaterialTheme.padding.small,
                ),
            )
        }
    }

    if (showDialog) {
        JsLoginDialog(
            // Was hardcoded to "", so the dialog title rendered as a dangling "登录 · ".
            sourceName = sourceName,
            mode = mode,
            onLogin = onLogin,
            onDismiss = { showDialog = false },
        )
    }
}
