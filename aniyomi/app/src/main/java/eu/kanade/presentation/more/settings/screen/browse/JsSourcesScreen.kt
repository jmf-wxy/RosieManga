package eu.kanade.presentation.more.settings.screen.browse

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.more.settings.screen.browse.components.JsSourcesScreen
import eu.kanade.presentation.util.Screen
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.flow.collectLatest

/**
 * Voyager screen for managing Venera-style JS comic sources.
 *
 * Entry point: **设置 → 浏览 (SettingsBrowseScreen) → 源 → JS 源**.
 */
class JsSourcesScreen : Screen() {

    @Composable
    override fun Content() {
        val context = LocalContext.current
        val navigator = LocalNavigator.currentOrThrow

        val screenModel = rememberScreenModel { JsSourcesScreenModel() }
        val state by screenModel.state.collectAsState()

        JsSourcesScreen(
            state = state,
            onRepoUrlChange = screenModel::setRepoUrl,
            onReloadIndex = screenModel::loadIndex,
            onSyncAll = screenModel::syncAll,
            onInstall = screenModel::install,
            onUninstall = screenModel::uninstall,
            onImportFile = screenModel::importFromFile,
            navigateUp = navigator::pop,
        )

        LaunchedEffect(Unit) {
            screenModel.events.collectLatest { event ->
                when (event) {
                    is JsSourceEvent.Installed -> context.toast("已安装：${event.name}")
                    is JsSourceEvent.InstallFailed -> context.toast("安装失败：${event.name}")
                    is JsSourceEvent.Synced -> context.toast("已同步 ${event.count} 个源，重启后生效")
                    JsSourceEvent.IndexFailed -> context.toast("无法获取源索引，请检查仓库地址")
                    JsSourceEvent.ImportFailed -> context.toast("导入失败：文件无法解析为 Venera 源")
                }
            }
        }
    }
}
