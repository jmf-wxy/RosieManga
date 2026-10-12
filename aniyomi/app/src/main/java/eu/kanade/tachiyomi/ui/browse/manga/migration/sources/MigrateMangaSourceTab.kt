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

