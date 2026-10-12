package eu.kanade.presentation.browse.manga

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.paging.LoadState
import androidx.paging.compose.LazyPagingItems
import eu.kanade.presentation.browse.manga.components.BrowseMangaSourceComfortableGrid
import eu.kanade.presentation.browse.manga.components.BrowseMangaSourceCompactGrid
import eu.kanade.presentation.browse.manga.components.BrowseMangaSourceList
import eu.kanade.presentation.components.AppBar
import eu.kanade.presentation.util.formattedMessage
import eu.kanade.tachiyomi.source.MangaSource
import kotlinx.collections.immutable.persistentListOf
import kotlinx.coroutines.flow.StateFlow
import tachiyomi.core.common.i18n.stringResource
import tachiyomi.domain.entries.manga.model.Manga
import tachiyomi.domain.library.model.LibraryDisplayMode
import tachiyomi.domain.source.manga.model.StubMangaSource
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.components.material.Scaffold
import tachiyomi.presentation.core.i18n.stringResource
import tachiyomi.presentation.core.screens.EmptyScreen
import tachiyomi.presentation.core.screens.EmptyScreenAction
import tachiyomi.presentation.core.screens.LoadingScreen
import tachiyomi.source.local.entries.manga.LocalMangaSource

@Composable
fun BrowseSourceContent(
    source: MangaSource?,
    mangaList: LazyPagingItems<StateFlow<Manga>>,
    columns: GridCells,
    entries: Int = 0,
    topBarHeight: Int = 0,
    displayMode: LibraryDisplayMode,
    snackbarHostState: SnackbarHostState,
    contentPadding: PaddingValues,
    onWebViewClick: () -> Unit,
    onHelpClick: () -> Unit,
    onLocalSourceHelpClick: () -> Unit,
    onMangaClick: (Manga) -> Unit,
    onMangaLongClick: (Manga) -> Unit,
    // Manual pagination (JS sources) feeds loading/errors through these instead of `mangaList.loadState`.
    isLoading: Boolean = false,
    errorMessage: String? = null,
    onRetry: (() -> Unit)? = null,
    /**
     * Whether the grid may draw Paging3's own refresh/append rows.
     *
     * `false` for JS sources. Their listing is driven page-by-page from the navigation bar (see
     * [MangaSourcePaginationBar]), so Paging3's「append」never actually means anything for them: the
     * `PagingData.from(items)` they render is a *static* snapshot, and any stray `LoadState.Loading`
     * (e.g. the one a freshly-created presenter reports before its first snapshot lands) put a
     *「加载中」row under the last cover. Scrolled to the bottom that reads as "more is still coming",
     * which is exactly what the page bar made obsolete.
     *
     * The full-screen states above are untouched on purpose — the *first* page genuinely has nothing
     * to show yet, and that is what [isLoading] / `LoadState.Loading` on an empty grid means.
     *
     * Callers pass `!isJs`; native sources keep the infinite-scroll affordance unchanged.
     */
    showLoadStateItems: Boolean = true,
) {
    val context = LocalContext.current

    val errorState = mangaList.loadState.refresh.takeIf { it is LoadState.Error }
        ?: mangaList.loadState.append.takeIf { it is LoadState.Error }

    val getErrorMessage: (LoadState.Error) -> String = { state ->
        with(context) { state.error.formattedMessage }
    }

    LaunchedEffect(errorState) {
        if (mangaList.itemCount > 0 && errorState != null && errorState is LoadState.Error) {
            val result = snackbarHostState.showSnackbar(
                message = getErrorMessage(errorState),
                actionLabel = context.stringResource(MR.strings.action_retry),
                duration = SnackbarDuration.Indefinite,
            )
            when (result) {
                SnackbarResult.Dismissed -> snackbarHostState.currentSnackbarData?.dismiss()
                SnackbarResult.ActionPerformed -> mangaList.retry()
            }
        }
    }

    // Manual-pagination failure **with content already on screen** (page 3 failed but page 2 is still
    // rendered): report it without wiping the grid. This matters more now that JS sources no longer
    // draw Paging3's rows — the page bar shows no error state of its own, so without this a failed
    // page flip would silently keep the previous page on screen.
    LaunchedEffect(errorMessage) {
        val message = errorMessage ?: return@LaunchedEffect
        if (mangaList.itemCount <= 0) return@LaunchedEffect // handled by the full-screen cases below
        val result = snackbarHostState.showSnackbar(
            message = message,
            actionLabel = context.stringResource(MR.strings.action_retry),
            duration = SnackbarDuration.Indefinite,
        )
        when (result) {
            SnackbarResult.Dismissed -> snackbarHostState.currentSnackbarData?.dismiss()
            SnackbarResult.ActionPerformed -> onRetry?.invoke()
        }
    }

    if (mangaList.itemCount <= 0 && errorState != null && errorState is LoadState.Error) {
        EmptyScreen(
            modifier = Modifier.padding(contentPadding),
            message = getErrorMessage(errorState),
            actions = if (source is LocalMangaSource) {
                persistentListOf(
                    EmptyScreenAction(
                        stringRes = MR.strings.local_source_help_guide,
                        icon = Icons.AutoMirrored.Outlined.HelpOutline,
                        onClick = onLocalSourceHelpClick,
                    ),
                )
            } else {
                persistentListOf(
                    EmptyScreenAction(
                        stringRes = MR.strings.action_retry,
                        icon = Icons.Outlined.Refresh,
                        onClick = mangaList::refresh,
                    ),
                    EmptyScreenAction(
                        stringRes = MR.strings.action_open_in_web_view,
                        icon = Icons.Outlined.Public,
                        onClick = onWebViewClick,
                    ),
                    EmptyScreenAction(
                        stringRes = MR.strings.label_help,
                        icon = Icons.AutoMirrored.Outlined.HelpOutline,
                        onClick = onHelpClick,
                    ),
                )
            },
        )

        return
    }

    // Manual-pagination error (no items yet): show the message with a retry bound to [onRetry].
    if (mangaList.itemCount == 0 && errorMessage != null) {
        EmptyScreen(
            modifier = Modifier.padding(contentPadding),
            message = errorMessage,
            actions = persistentListOf(
                EmptyScreenAction(
                    stringRes = MR.strings.action_retry,
                    icon = Icons.Outlined.Refresh,
                    onClick = onRetry ?: {},
                ),
            ),
        )
        return
    }

    if (mangaList.itemCount == 0 && (mangaList.loadState.refresh is LoadState.Loading || isLoading)) {
        LoadingScreen(
            modifier = Modifier.padding(contentPadding),
        )
        return
    }

    when (displayMode) {
        LibraryDisplayMode.ComfortableGrid -> {
            BrowseMangaSourceComfortableGrid(
                mangaList = mangaList,
                columns = columns,
                contentPadding = contentPadding,
                onMangaClick = onMangaClick,
                onMangaLongClick = onMangaLongClick,
                showLoadStateItems = showLoadStateItems,
            )
        }
        LibraryDisplayMode.List -> {
            BrowseMangaSourceList(
                mangaList = mangaList,
                entries = entries,
                topBarHeight = topBarHeight,
                contentPadding = contentPadding,
                onMangaClick = onMangaClick,
                onMangaLongClick = onMangaLongClick,
                showLoadStateItems = showLoadStateItems,
            )
        }
        LibraryDisplayMode.CompactGrid, LibraryDisplayMode.CoverOnlyGrid -> {
            BrowseMangaSourceCompactGrid(
                mangaList = mangaList,
                columns = columns,
                contentPadding = contentPadding,
                onMangaClick = onMangaClick,
                onMangaLongClick = onMangaLongClick,
                showLoadStateItems = showLoadStateItems,
            )
        }
    }
}

/**
 * Page-based navigation bar for JS sources (replaces the Paging3 infinite scroll affordance).
 *
 * Shows 上一页 / 第 N 页 [ / 共 M 页 ] / 下一页 plus a free-text page jump. `hasNext` drives the
 * 下一页 button; `maxPage` (when the source reports one) drives the total label and the jump clamp.
 * Rendered in the browse top bar only for JS sources whose listing is page-based (not「热门」, which
 * shows a single page and hides this bar entirely).
 */
@Composable
fun MangaSourcePaginationBar(
    page: Int,
    maxPage: Int?,
    hasNext: Boolean,
    isLoading: Boolean,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onJump: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var jumpText by remember { mutableStateOf("") }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        tonalElevation = 2.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(
                8.dp,
                Alignment.CenterHorizontally,
            ),
        ) {
            TextButton(onClick = onPrev, enabled = page > 1) { Text("上一页") }
            Text(
                text = if (maxPage != null) "第 $page / $maxPage 页" else "第 $page 页",
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = onNext, enabled = hasNext) { Text("下一页") }
            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                )
            }
            OutlinedTextField(
                value = jumpText,
                onValueChange = { jumpText = it.filter { c -> c.isDigit() }.take(6) },
                modifier = Modifier.widthIn(min = 64.dp, max = 88.dp).height(48.dp),
                singleLine = true,
                label = { Text("跳页") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            TextButton(
                onClick = {
                    jumpText.toIntOrNull()?.let { onJump(it) }
                    jumpText = ""
                },
                enabled = jumpText.toIntOrNull() != null,
            ) { Text("前往") }
        }
    }
}

@Composable
internal fun MissingSourceScreen(
    source: StubMangaSource,
    navigateUp: () -> Unit,
) {
    Scaffold(
        topBar = { scrollBehavior ->
            AppBar(
                title = source.name,
                navigateUp = navigateUp,
                scrollBehavior = scrollBehavior,
            )
        },
    ) { paddingValues ->
        EmptyScreen(
            message = stringResource(MR.strings.source_not_installed, source.toString()),
            modifier = Modifier.padding(paddingValues),
        )
    }
}
