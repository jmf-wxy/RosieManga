package eu.kanade.tachiyomi.ui.browse.manga.source

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.components.TabContent
import eu.kanade.presentation.more.settings.screen.browse.JsSourceConfigScreenModel
import eu.kanade.presentation.more.settings.screen.browse.JsSourcesScreen
import eu.kanade.presentation.more.settings.screen.browse.components.JsDebugOverlay
import eu.kanade.presentation.more.settings.screen.browse.components.JsSourceConfigContent
import eu.kanade.presentation.more.settings.screen.browse.components.JsUiEventHost
import kotlinx.collections.immutable.persistentListOf
import tachiyomi.i18n.aniyomi.AYMR
import tachiyomi.presentation.core.components.material.padding
import tachiyomi.presentation.core.i18n.stringResource

/**
 * "漫画源" tab inside Browse — the Aniyomi home for Venera-style JS sources.
 *
 * This is where a JS source's **own settings** live (sort order, CDN line, image quality, API
 * address, login, …), mirroring Venera's source page. Installing sources from a repository stays on
 * a separate screen, reached through the "源列表" action in the app bar.
 */
@Composable
fun Screen.jsSourcesTab(): TabContent {
    val navigator = LocalNavigator.currentOrThrow
    val screenModel = rememberScreenModel { JsSourceConfigScreenModel() }
    val state by screenModel.state.collectAsState()

    // Sources raise `UI.*` from whichever screen triggered them; hosting here as well means a
    // "刷新"/"签到" result dialog is never swallowed just because the user is on the Browse tab.
    JsUiEventHost(
        uiEvents = screenModel.uiEvents,
        onDialogAction = screenModel::onDialogAction,
        onDialogDismissed = screenModel::onDialogDismissed,
    )

    return TabContent(
        titleRes = AYMR.strings.label_js_sources,
        actions = persistentListOf(
            AppBar.Action(
                title = stringResource(AYMR.strings.action_source_list),
                icon = Icons.Outlined.Tune,
                onClick = { navigator.push(JsSourcesScreen()) },
            ),
        ),
        // Only the extensions tab owns a search query, and it is not always the visible page, so
        // this tab must not capture the shared search bar.
        searchEnabled = false,
        content = { contentPadding, _ ->
            Box(modifier = Modifier.fillMaxSize()) {
                JsSourceConfigContent(
                    sources = state.sources,
                    metas = state.metas,
                    values = state.values,
                    lazyListState = rememberLazyListState(),
                    paddingValues = contentPadding,
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
                )

                // Floating diagnostic console. Needed because vivo/OriginOS strips third-party app
                // logs from `logcat`, so this is the only way to read what a tap actually did.
                JsDebugOverlay(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(MaterialTheme.padding.medium),
                )
            }
        },
    )
}
