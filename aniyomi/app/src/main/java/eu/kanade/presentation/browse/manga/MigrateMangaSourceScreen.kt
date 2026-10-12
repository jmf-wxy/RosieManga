package eu.kanade.presentation.browse.manga

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Numbers
import androidx.compose.material.icons.outlined.SortByAlpha
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.kanade.domain.source.interactor.SetMigrateSorting
import eu.kanade.presentation.browse.manga.components.BaseMangaSourceItem
import eu.kanade.presentation.browse.manga.components.MangaSourceIcon
import eu.kanade.tachiyomi.ui.browse.manga.migration.sources.MigrateMangaSourceScreenModel
import eu.kanade.tachiyomi.util.system.copyToClipboard
import kotlinx.collections.immutable.ImmutableList
import tachiyomi.domain.source.manga.model.Source
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.components.Badge
import tachiyomi.presentation.core.components.BadgeGroup
import tachiyomi.presentation.core.components.ScrollbarLazyColumn
import tachiyomi.presentation.core.components.Scroller.STICKY_HEADER_KEY_PREFIX
import tachiyomi.presentation.core.components.material.padding
import tachiyomi.presentation.core.components.material.topSmallPaddingValues
import tachiyomi.presentation.core.i18n.pluralStringResource
import tachiyomi.presentation.core.i18n.stringResource
import tachiyomi.presentation.core.screens.EmptyScreen
import tachiyomi.presentation.core.screens.LoadingScreen
import tachiyomi.presentation.core.theme.header
import tachiyomi.presentation.core.util.plus
import tachiyomi.presentation.core.util.secondaryItemAlpha

@Composable
fun MigrateMangaSourceScreen(
    state: MigrateMangaSourceScreenModel.State,
    contentPadding: PaddingValues,
    onClickItem: (Source) -> Unit,
    onToggleSortingDirection: () -> Unit,
    onToggleSortingMode: () -> Unit,
    onDismissDialog: () -> Unit,
    onSelectTarget: (Source, Source) -> Unit,
    onConfirmMigration: (Source, Source) -> Unit,
) {
    val context = LocalContext.current
    when {
        state.isLoading -> LoadingScreen(Modifier.padding(contentPadding))
        state.isEmpty -> EmptyScreen(
            stringRes = MR.strings.information_empty_library,
            modifier = Modifier.padding(contentPadding),
        )
        else ->
            MigrateSourceList(
                list = state.items,
                contentPadding = contentPadding,
                onClickItem = onClickItem,
                onLongClickItem = { source ->
                    val sourceId = source.id.toString()
                    context.copyToClipboard(sourceId, sourceId)
                },
                sortingMode = state.sortingMode,
                onToggleSortingMode = onToggleSortingMode,
                sortingDirection = state.sortingDirection,
                onToggleSortingDirection = onToggleSortingDirection,
            )
    }

    when (val dialog = state.dialog) {
        is MigrateMangaSourceScreenModel.Dialog.SelectTarget -> {
            SelectTargetSourceDialog(
                source = dialog.source,
                candidates = dialog.candidates,
                isFallback = dialog.isFallback,
                onDismissRequest = onDismissDialog,
                onConfirm = onSelectTarget,
            )
        }
        is MigrateMangaSourceScreenModel.Dialog.Confirm -> {
            ConfirmSourceMigrationDialog(
                source = dialog.source,
                target = dialog.target,
                count = dialog.count,
                onDismissRequest = onDismissDialog,
                onConfirm = onConfirmMigration,
            )
        }
        MigrateMangaSourceScreenModel.Dialog.Migrating -> {
            LoadingScreen()
        }
        MigrateMangaSourceScreenModel.Dialog.Closed -> {}
    }
}

@Composable
private fun MigrateSourceList(
    list: ImmutableList<Pair<Source, Long>>,
    contentPadding: PaddingValues,
    onClickItem: (Source) -> Unit,
    onLongClickItem: (Source) -> Unit,
    sortingMode: SetMigrateSorting.Mode,
    onToggleSortingMode: () -> Unit,
    sortingDirection: SetMigrateSorting.Direction,
    onToggleSortingDirection: () -> Unit,
) {
    ScrollbarLazyColumn(
        contentPadding = contentPadding + topSmallPaddingValues,
    ) {
        stickyHeader(key = STICKY_HEADER_KEY_PREFIX) {
            Row(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.background)
                    .padding(start = MaterialTheme.padding.medium),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(MR.strings.migration_selection_prompt),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.header,
                )

                IconButton(onClick = onToggleSortingMode) {
                    when (sortingMode) {
                        SetMigrateSorting.Mode.ALPHABETICAL -> Icon(
                            Icons.Outlined.SortByAlpha,
                            contentDescription = stringResource(MR.strings.action_sort_alpha),
                        )
                        SetMigrateSorting.Mode.TOTAL -> Icon(
                            Icons.Outlined.Numbers,
                            contentDescription = stringResource(MR.strings.action_sort_count),
                        )
                    }
                }
                IconButton(onClick = onToggleSortingDirection) {
                    when (sortingDirection) {
                        SetMigrateSorting.Direction.ASCENDING -> Icon(
                            Icons.Outlined.ArrowUpward,
                            contentDescription = stringResource(MR.strings.action_asc),
                        )
                        SetMigrateSorting.Direction.DESCENDING -> Icon(
                            Icons.Outlined.ArrowDownward,
                            contentDescription = stringResource(MR.strings.action_desc),
                        )
                    }
                }
            }
        }

        items(
            items = list,
            key = { (source, _) -> "migrate-${source.id}" },
        ) { (source, count) ->
            MigrateSourceItem(
                modifier = Modifier.animateItem(),
                source = source,
                count = count,
                onClickItem = { onClickItem(source) },
                onLongClickItem = { onLongClickItem(source) },
            )
        }
    }
}

@Composable
private fun MigrateSourceItem(
    source: Source,
    count: Long,
    onClickItem: () -> Unit,
    onLongClickItem: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BaseMangaSourceItem(
        modifier = modifier,
        source = source,
        showLanguageInContent = source.lang != "",
        onClickItem = onClickItem,
        onLongClickItem = onLongClickItem,
        icon = { MangaSourceIcon(source = source) },
        action = {
            BadgeGroup {
                Badge(text = "$count")
            }
        },
        content = { _, sourceLangString ->
            Column(
                modifier = Modifier
                    .padding(horizontal = MaterialTheme.padding.medium)
                    .weight(1f),
            ) {
                Text(
                    text = source.name.ifBlank { source.id.toString() },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.padding.small),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (sourceLangString != null) {
                        Text(
                            modifier = Modifier.secondaryItemAlpha(),
                            text = sourceLangString,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (source.isStub) {
                        Text(
                            modifier = Modifier.secondaryItemAlpha(),
                            text = stringResource(MR.strings.not_installed),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        },
    )
}

@Composable
private fun SelectTargetSourceDialog(
    source: Source,
    candidates: ImmutableList<Source>,
    isFallback: Boolean,
    onDismissRequest: () -> Unit,
    onConfirm: (Source, Source) -> Unit,
) {
    var selected by remember { mutableStateOf(candidates.firstOrNull()) }

    AlertDialog(
        onDismissRequest = onDismissRequest,
        title = {
            Text(text = stringResource(MR.strings.migration_select_target_source))
        },
        text = {
            Column {
                Text(
                    text = if (isFallback) {
                        stringResource(
                            MR.strings.migration_select_target_source_fallback_text,
                            source.visualName,
                        )
                    } else {
                        stringResource(
                            MR.strings.migration_select_target_source_text,
                            source.visualName,
                        )
                    },
                )
                Column(
                    modifier = Modifier
                        .padding(top = MaterialTheme.padding.medium)
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    candidates.forEach { candidate ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = MaterialTheme.padding.small),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selected?.id == candidate.id,
                                onClick = { selected = candidate },
                            )
                            Text(
                                text = candidate.visualName,
                                modifier = Modifier.padding(start = MaterialTheme.padding.small),
                            )
                        }
                    }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismissRequest) {
                Text(text = stringResource(MR.strings.action_cancel))
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    selected?.let { onConfirm(source, it) }
                },
                enabled = selected != null,
            ) {
                Text(text = stringResource(MR.strings.action_ok))
            }
        },
    )
}

@Composable
private fun ConfirmSourceMigrationDialog(
    source: Source,
    target: Source,
    count: Int,
    onDismissRequest: () -> Unit,
    onConfirm: (Source, Source) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismissRequest,
        title = {
            Text(
                text = pluralStringResource(
                    MR.plurals.migration_source_confirm_title,
                    count,
                    count,
                ),
            )
        },
        text = {
            Text(
                text = stringResource(
                    MR.strings.migration_source_confirm_text,
                    source.visualName,
                    target.visualName,
                    count,
                ),
            )
        },
        dismissButton = {
            TextButton(onClick = onDismissRequest) {
                Text(text = stringResource(MR.strings.action_cancel))
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(source, target) },
            ) {
                Text(text = stringResource(MR.strings.migrate))
            }
        },
    )
}
