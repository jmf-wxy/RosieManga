package eu.kanade.presentation.more.settings.screen.browse

import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.more.settings.screen.browse.components.JsDebugOverlay
import eu.kanade.presentation.more.settings.screen.browse.components.JsSourceConfigContent
import eu.kanade.presentation.more.settings.screen.browse.components.JsUiEventHost
import eu.kanade.presentation.util.Screen
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tachiyomi.presentation.core.components.material.Scaffold
import tachiyomi.presentation.core.components.material.padding
import tachiyomi.presentation.core.components.material.topSmallPaddingValues
import tachiyomi.presentation.core.util.plus

/**
 * "漫画源" — list installed JS sources and configure each one inline.
 *
 * Reached from the Browse tab (source list screen) and from 设置 → 浏览 → JS 源.
 */
class JsSourceConfigScreen : Screen() {

    @Composable
    override fun Content() {
        val context = LocalContext.current
        val navigator = LocalNavigator.currentOrThrow
        val screenModel = rememberScreenModel { JsSourceConfigScreenModel() }
        val state by screenModel.state.collectAsState()
        val lazyListState = rememberLazyListState()

        val scope = rememberCoroutineScope()
        val filePicker = rememberLauncherForActivityResult(
            contract = ActivityResultContracts.OpenDocument(),
        ) { uri ->
            uri ?: return@rememberLauncherForActivityResult
            // Nothing here may run on the main thread. This callback *is* main, and it used to do
            // two expensive things inline: read the whole document (blocking I/O through the
            // ContentResolver) and `JsSourceManager.install(...)`, which parses the script in
            // QuickJS (`evalBlocking` → `executor.submit().get()`, i.e. the caller waits for the
            // JS thread), reflects its metadata and re-dispatches `init()` — a visible freeze of
            // the whole UI for the duration of the import.
            //
            // `rememberCoroutineScope()` is main-dispatched, so the toast still lands on the UI
            // thread while only the heavy part is moved to IO.
            scope.launch {
                val result = withContext(Dispatchers.IO) {
                    runCatching {
                        val code = context.contentResolver.openInputStream(uri)
                            ?.bufferedReader()
                            ?.use { it.readText() }
                        if (code.isNullOrBlank()) {
                            null
                        } else {
                            val name = uri.lastPathSegment?.substringAfterLast('/')
                                ?.takeIf { it.endsWith(".js") }
                                ?: "imported_${System.currentTimeMillis()}.js"
                            JsSourceManager.install(code, fileName = name)
                        }
                    }
                }
                val installed = result.getOrNull()
                if (result.isFailure || installed != null) {
                    context.toast(
                        if (installed != null) {
                            "已安装：${installed.name}"
                        } else {
                            "导入失败：文件无法解析为 Venera 源"
                        },
                    )
                }
            }
        }

        Scaffold(
            topBar = { scrollBehavior ->
                AppBar(
                    navigateUp = navigator::pop,
                    title = "漫画源",
                    scrollBehavior = scrollBehavior,
                    actions = {
                        IconButton(onClick = { navigator.push(JsSourcesScreen()) }) {
                            Icon(Icons.Outlined.Refresh, contentDescription = "源列表")
                        }
                    },
                )
            },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = { filePicker.launch(arrayOf("text/javascript", "application/javascript", "*/*")) },
                    icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                    text = { Text("导入 .js") },
                )
            },
        ) { paddingValues ->
            Box(modifier = Modifier.fillMaxSize()) {
                JsSourceConfigContent(
                    sources = state.sources,
                    metas = state.metas,
                    values = state.values,
                    lazyListState = lazyListState,
                    paddingValues = paddingValues +
                        topSmallPaddingValues +
                        PaddingValues(horizontal = MaterialTheme.padding.medium),
                    pendingKeys = state.pendingKeys,
                    pendingCallbacks = state.pendingCallbacks,
                    onReloadAll = screenModel::reloadAll,
                    onSyncAll = screenModel::checkUpdates,
                    onUninstall = screenModel::uninstall,
                    onSettingChange = screenModel::onSettingChange,
                    onRunCallback = screenModel::onRunCallback,
                    onResyncSource = screenModel::resyncSource,
                    onLogin = screenModel::onLogin,
                    onLogout = screenModel::onLogout,
                    loginStatus = state.loginStatus,
                )

                // Floating diagnostic console, bottom-start so it never covers the 导入 .js FAB.
                JsDebugOverlay(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(start = MaterialTheme.padding.medium, bottom = MaterialTheme.padding.medium),
                )
            }
        }

        LaunchedEffect(Unit) {
            screenModel.events.collectLatest { event ->
                when (event) {
                    JsSourceConfigEvent.Reloaded -> context.toast("已重新加载源")
                    is JsSourceConfigEvent.Updated ->
                        context.toast(if (event.count > 0) "已更新 ${event.count} 个源" else "已是最新")
                    is JsSourceConfigEvent.Resynced ->
                        context.toast(
                            if (event.count > 0) {
                                "已标记 ${event.count} 部漫画为待重拉，打开时自动刷新"
                            } else {
                                "该源暂无库内漫画需重同步"
                            },
                        )
                    is JsSourceConfigEvent.CallbackFailed ->
                        // The callback died before it could report through `UI.showDialog`. Sources
                        // usually throw plain strings ("Invalid Status Code: 404"), which read better
                        // than any wrapper text we could invent, so pass it through verbatim.
                        context.toast(event.reason.ifBlank { "执行失败" })
                    JsSourceConfigEvent.LoggedIn -> context.toast("登录成功", Toast.LENGTH_LONG)
                    is JsSourceConfigEvent.LoginFailed ->
                        // Secondary channel only — the same verdict is rendered inline on the source
                        // card (see `AccountRow`), because this toast is not guaranteed to appear.
                        context.toast(event.reason.ifBlank { "登录失败，请检查账号密码" }, Toast.LENGTH_LONG)
                }
            }
        }

        // Venera `UI.*` — sources surface results (and confirmations) through these.
        JsUiEventHost(
            uiEvents = screenModel.uiEvents,
            onDialogAction = screenModel::onDialogAction,
            onDialogDismissed = screenModel::onDialogDismissed,
        )
    }
}
