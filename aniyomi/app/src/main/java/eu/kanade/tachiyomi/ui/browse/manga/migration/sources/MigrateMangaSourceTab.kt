package eu.kanade.tachiyomi.ui.browse.manga.migration.sources

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import cafe.adriel.voyager.core.model.rememberScreenModel
import cafe.adriel.voyager.core.screen.Screen
import eu.kanade.presentation.browse.manga.MigrateMangaSourceScreen
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.components.TabContent
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.collections.immutable.persistentListOf
import kotlinx.coroutines.flow.collectLatest
import tachiyomi.core.common.i18n.pluralStringResource
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.i18n.stringResource

@Composable
fun Screen.migrateMangaSourceTab(): TabContent {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val screenModel = rememberScreenModel { MigrateMangaSourceScreenModel() }
    val state by screenModel.state.collectAsState()

    LaunchedEffect(Unit) {
        screenModel.channel.collectLatest { event ->
            when (event) {
                MigrateMangaSourceScreenModel.Event.NoTargetSource -> {
                    context.toast(MR.strings.migration_no_target_source)
                }
                is MigrateMangaSourceScreenModel.Event.MigrationComplete -> {
                    context.toast(
                        context.pluralStringResource(
                            MR.plurals.migration_source_complete,
                            event.count,
                            event.count,
                        ),
                    )
                }
                is MigrateMangaSourceScreenModel.Event.UrlsResolved -> {
                    // Only meaningful for a cross-site migration: those are the entries whose url
                    // had to be re-resolved in the target source. `unresolved` entries kept their
                    // old url and may need a manual fix in the target source.
                    context.toast(
                        if (event.rewritten > 0) {
                            "已重写 ${event.rewritten} 个链接；${event.unresolved} 个未在目标源匹配到，保留原链接"
                        } else {
                            "未能在目标源匹配到任何漫画，链接全部保留原样"
                        },
                    )
                }
                MigrateMangaSourceScreenModel.Event.MigrationFailed -> {
                    context.toast(MR.strings.internal_error)
                }
                else -> {}
            }
        }
    }

    return TabContent(
        titleRes = MR.strings.label_migration,
        actions = persistentListOf(
            AppBar.Action(
                title = stringResource(MR.strings.migration_help_guide),
                icon = Icons.AutoMirrored.Outlined.HelpOutline,
                onClick = {
                    uriHandler.openUri("https://aniyomi.org/help/guides/source-migration/")
                },
            ),
        ),
        content = { contentPadding, _ ->
            MigrateMangaSourceScreen(
                state = state,
                contentPadding = contentPadding,
                // Always go through the target picker: same-named sources when they exist,
                // otherwise every other installed source.
                onClickItem = screenModel::openTargetSourceDialog,
                onToggleSortingDirection = screenModel::toggleSortingDirection,
                onToggleSortingMode = screenModel::toggleSortingMode,
                onDismissDialog = screenModel::dismissDialog,
                onSelectTarget = screenModel::proceedToConfirm,
                onConfirmMigration = screenModel::migrateSource,
            )
        },
    )
}

