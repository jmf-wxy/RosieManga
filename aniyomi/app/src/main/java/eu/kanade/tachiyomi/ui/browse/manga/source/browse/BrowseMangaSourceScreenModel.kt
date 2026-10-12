package eu.kanade.tachiyomi.ui.browse.manga.source.browse

import android.content.res.Configuration
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.cachedIn
import androidx.paging.filter
import androidx.paging.map
import androidx.paging.PagingData
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import eu.kanade.core.preference.asState
import eu.kanade.domain.entries.manga.interactor.UpdateManga
import eu.kanade.domain.entries.manga.model.toDomainManga
import eu.kanade.domain.source.manga.interactor.GetMangaIncognitoState
import eu.kanade.domain.source.service.SourcePreferences
import eu.kanade.domain.track.manga.interactor.AddMangaTracks
import eu.kanade.presentation.util.ioCoroutineScope
import eu.kanade.tachiyomi.data.cache.MangaCoverCache
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.js.JsCatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.util.removeCovers
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.toImmutableList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tachiyomi.core.common.preference.CheckboxState
import tachiyomi.core.common.preference.mapAsCheckboxState
import tachiyomi.core.common.util.lang.launchIO
import tachiyomi.domain.category.manga.interactor.GetMangaCategories
import tachiyomi.domain.category.manga.interactor.SetMangaCategories
import tachiyomi.domain.category.model.Category
import tachiyomi.domain.entries.manga.interactor.GetDuplicateLibraryManga
import tachiyomi.domain.entries.manga.interactor.GetManga
import tachiyomi.domain.entries.manga.interactor.NetworkToLocalManga
import tachiyomi.domain.entries.manga.model.Manga
import tachiyomi.domain.entries.manga.model.toMangaUpdate
import tachiyomi.domain.items.chapter.interactor.SetMangaDefaultChapterFlags
import tachiyomi.domain.library.service.LibraryPreferences
import tachiyomi.domain.source.manga.interactor.GetRemoteManga
import tachiyomi.domain.source.manga.service.MangaSourceManager
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import eu.kanade.tachiyomi.source.model.Filter as SourceModelFilter

class BrowseMangaSourceScreenModel(
    private val sourceId: Long,
    listingQuery: String?,
    sourceManager: MangaSourceManager = Injekt.get(),
    sourcePreferences: SourcePreferences = Injekt.get(),
    private val libraryPreferences: LibraryPreferences = Injekt.get(),
    private val coverCache: MangaCoverCache = Injekt.get(),
    private val getRemoteManga: GetRemoteManga = Injekt.get(),
    private val getDuplicateLibraryManga: GetDuplicateLibraryManga = Injekt.get(),
    private val getCategories: GetMangaCategories = Injekt.get(),
    private val setMangaCategories: SetMangaCategories = Injekt.get(),
    private val setMangaDefaultChapterFlags: SetMangaDefaultChapterFlags = Injekt.get(),
    private val getManga: GetManga = Injekt.get(),
    private val networkToLocalManga: NetworkToLocalManga = Injekt.get(),
    private val updateManga: UpdateManga = Injekt.get(),
    private val addTracks: AddMangaTracks = Injekt.get(),
    private val getIncognitoState: GetMangaIncognitoState = Injekt.get(),
) : StateScreenModel<BrowseMangaSourceScreenModel.State>(State(Listing.valueOf(listingQuery))) {

    var displayMode by sourcePreferences.sourceDisplayMode().asState(screenModelScope)

    val source = sourceManager.getOrStub(sourceId)

    /**
     * Read once at construction, like every other preference here. Declared above [init] because
     * [init] kicks off a JS page load whose mapping step reads it — keeping it above removes any doubt
     * about initialization order (see the note on [_manualState]).
     */
    private val hideInLibraryItems = sourcePreferences.hideInMangaLibraryItems().get()

    /**
     * Manual, page-at-a-time listing state for JS sources — see [ManualListing] for what each field
     * means.
     *
     * ### ⚠️ Declared ABOVE [init] on purpose
     *
     * Kotlin runs property initializers and `init` blocks in **declaration order**, and [init] ends
     * with [ensureManualListing], which reads [_manualState]. With this block sitting *below* `init`
     * (where it started out) `_manualState` was still `null` at that moment, so **every** open of a JS
     * source's browse screen died with
     * `NullPointerException: Attempt to invoke interface method '… MutableStateFlow.getValue()' on a
     * null object reference` at `ensureManualListing` ← `<init>`. Keep this above `init` (or drop the
     * call there) if either of them moves.
     */
    private val _manualState = MutableStateFlow(ManualListing())
    val manualState: StateFlow<ManualListing> = _manualState.asStateFlow()

    /**
     * The in-flight manual page load. A new [loadManualPage] **cancels** it: a slow or stuck source
     * call (single-threaded JS runtime, 5-min pump budget) must not make every later 跳页 queue
     * behind it with a spinner that has no way out.
     *
     * ⚠️ Declared ABOVE [init] on purpose — `init` ends with [ensureManualListing], which reaches
     * [loadManualPage] (same initialization-order trap as [_manualState], S31).
     */
    private var manualLoadJob: Job? = null

    /**
     * Generation counter for manual page loads. Each [loadManualPage] bumps it and may only write
     * the listing state while it is still the current generation — that is what makes the
     * watchdog (which invalidates the generation on timeout) safe against a straggler that
     * finishes late and must not clobber a newer load's state.
     */
    private val manualLoadGeneration = AtomicInteger(0)

    private companion object {
        /** Tag for the manual-pagination lifecycle logs (start / source returned / done / timeout). */
        const val MANUAL_LOG_TAG = "BrowseSourceJs"

        /**
         * Watchdog budget for one manual page load (source call + DB mapping). Generous on purpose —
         * the bridge client allows 30s per HTTP call and a source may chain 2–3 of them — but FINITE:
         * past this the page bar flips into a retryable error instead of spinning forever.
         */
        const val MANUAL_PAGE_TIMEOUT_MS = 60_000L
    }

    /**
     * Derived `StateFlow<Flow<PagingData<T>>>` so the existing `collectAsLazyPagingItems()` extension
     * (which is declared on that exact type) can render a JS source's manual page without touching the
     * grid rendering path. Re-emits a fresh `PagingData` whenever [ManualListing.items] changes, which
     * is exactly on every page flip.
     */
    val manualPagingFlow: StateFlow<Flow<PagingData<StateFlow<Manga>>>> =
        _manualState
            .map { state -> flowOf(PagingData.from(state.items)) }
            .stateIn(screenModelScope, SharingStarted.WhileSubscribed(5000), flowOf(PagingData.empty()))

    init {
        if (source is CatalogueSource) {
            mutableState.update {
                var query: String? = null
                var listing = it.listing

                if (listing is Listing.Search) {
                    query = listing.query
                    listing = Listing.Search(query, source.getFilterList())
                }

                it.copy(
                    listing = listing,
                    filters = source.getFilterList(),
                    toolbarQuery = query,
                )
            }
        }

        if (!getIncognitoState.await(source.id)) {
            sourcePreferences.lastUsedMangaSource().set(source.id)
        }

        // First load for JS sources, driven from here rather than from a `LaunchedEffect` in the
        // composable — see [ensureManualListing] and the note on the removed effect in
        // [BrowseMangaSourceScreen]: `FilterList.equals` returns `false` unconditionally, so any
        // effect keyed on filters re-runs on *every* recomposition and re-fetches page 1 endlessly.
        ensureManualListing()
    }

    /**
     * Flow of Pager flow tied to [State.listing]
     */
    val mangaPagerFlowFlow = state.map { it.listing }
        .distinctUntilChanged()
        .map { listing ->
            Pager(PagingConfig(pageSize = 25)) {
                getRemoteManga.subscribe(sourceId, listing.query ?: "", listing.filters)
            }.flow.map { pagingData ->
                pagingData.map {
                    networkToLocalManga.await(it.toDomainManga(sourceId))
                        .let { localManga -> getManga.subscribe(localManga.url, localManga.source) }
                        .filterNotNull()
                        .stateIn(ioCoroutineScope)
                }
                    .filter { !hideInLibraryItems || !it.value.favorite }
            }
                .cachedIn(ioCoroutineScope)
        }
        .stateIn(ioCoroutineScope, SharingStarted.Lazily, emptyFlow())

    /**
     * Whether this source is JS-backed and therefore uses the page-based navigation bar (上一页 / 第 N
     * 页 / 下一页 / 跳页) instead of the Paging3 infinite scroll. Native [CatalogueSource]s never
     * implement [JsCatalogueSource], so this is an exact test.
     */
    val isJsSource: Boolean get() = source is JsCatalogueSource

    /**
     * Manual, page-at-a-time listing state for JS sources.
     *
     * ### Why a separate path from [mangaPagerFlowFlow]
     *
     * The standard browse UI is Paging3 infinite scroll: it keeps `append`ing pages as the user
     * scrolls and never exposes a page number, so there is no place to hang a「第 3 / 12 页」bar. A JS
     * source, however, is engine-driven and its listings have an explicit `maxPage`, so the user
     * expectation (and the request) is a real pagination control. We load one page on demand here
     * instead of streaming, and the Compose side renders the bar from this state.
     *
     * The mapping mirrors [mangaPagerFlowFlow] exactly (`networkToLocalManga` → `getManga.subscribe`
     * → `stateIn`) so favourites / library badges behave identically; only the *trigger* differs
     * (explicit page change vs. scroll position).
     *
     * The「热门」tab intentionally shares this path but the Compose side hides the bar and only ever
     * requests page 1 — see caller notes in [BrowseMangaSourceScreen].
     */
    data class ManualListing(
        val page: Int = 1,
        val maxPage: Int? = null,
        val hasNext: Boolean = false,
        val items: List<StateFlow<Manga>> = emptyList(),
        val isLoading: Boolean = false,
        val error: String? = null,
        /**
         * Which listing the **content currently on screen** came from — see [manualKeyOf]. `null`
         * until the first load completes.
         *
         * Two decisions hang off it, and both exist to stop the host from throwing away what the user
         * is looking at:
         *
         *  • [loadManualPage] blanks the grid only when this key is **not** the one being requested
         *    (new query / tab / filter set). A page flip stays inside one key, so paging does not flash
         *    an empty grid.
         *  • [ensureManualListing] uses it to tell「this listing has never been loaded」apart from
         *    「its content is already here」. Without that, the screen's `LaunchedEffect` — which also
         *    re-runs on every *recomposition from scratch*, i.e. every return from a manga detail page
         *    — reloaded page 1 and dropped the user back to the top of the grid.
         */
        val loadedKey: String? = null,
        /**
         * The key currently in flight, so a second trigger (the `LaunchedEffect` plus an explicit
         * [ensureManualListing] from [setListing]/[search]) cannot start a duplicate request before the
         * first one has recorded itself in [loadedKey].
         */
        val loadingKey: String? = null,
    )

    /**
     * A **value-level** identity for a [Listing]: what would make the host fetch a different page.
     *
     * ### Why not just compare the `Listing` object
     *
     * Because the filter sheet mutates the filter objects **in place** (`Filter.state` is a `var`, and
     * the dialog hands the very same `FilterList` back on「应用」). A `Listing.Search` before and after
     * 「应用筛选」can therefore be the same instance with the same `filters` reference — `equals` says
     * "nothing changed" while the user just asked for something new. `Listing` identity alone cannot
     * see that; a rendered signature can, because `Filter.equals` is itself value-based (name + state).
     *
     * `Popular`/`Latest` carry no filters, so their key is constant. Cosmetic rows ([Filter.Header] /
     * [Filter.Separator]) are skipped — they have no state, and including their names would only make
     * the key noisier.
     */
    private fun Listing.manualKey(): String = when (this) {
        is Listing.Popular -> "popular"
        is Listing.Latest -> "latest"
        is Listing.Search -> "search|${query.orEmpty()}|${filters.signature()}"
    }

    private fun FilterList.signature(): String =
        map { it.signature() }.filter { it.isNotEmpty() }.joinToString("|")

    private fun SourceModelFilter<*>.signature(): String = when (this) {
        is SourceModelFilter.Header, is SourceModelFilter.Separator -> ""
        // A group's state is a nested filter list; recurse so it compares by value too. Anything
        // exotic falls back to `toString`, which only risks an extra reload — never a missed one.
        is SourceModelFilter.Group<*> -> state.joinToString(",", prefix = "$name=[", postfix = "]") { it ->
            (it as? SourceModelFilter<*>)?.signature() ?: it.toString()
        }
        else -> "$name=$state"
    }

    /**
     * Loads page 1 **only when the current listing has no content yet** (and no request for it is in
     * flight).
     *
     * ### The bug this exists for
     *
     * The screen triggers loads from a `LaunchedEffect(state.listing, state.filters)`. That effect also
     * re-runs whenever the browse screen is composed from scratch — and it *is*, on every return from a
     * manga detail page: pushing a screen disposes the browse composition while Voyager keeps both the
     * back-stack entry and its ScreenModel alive. An unconditional `loadManualPage(1)` there made
     * 「返回」behave like「重新打开」: `page` snapped back to 1, the page bar followed, and because that
     * page value is the `key(...)` of the grid subtree, the remembered scroll offset was discarded with
     * it. The report was exactly that — coming back no longer showed where the user had been.
     *
     * A *genuine* listing change still reloads, because [manualKey] changes with the query, the
     * selected tab, or any filter state.
     */
    fun ensureManualListing() {
        if (source !is JsCatalogueSource) return
        val key = state.value.listing.manualKey()
        val manual = _manualState.value
        if (manual.loadedKey == key || manual.loadingKey == key) return
        loadManualPage(1)
    }

    /**
     * Loads a single page for the current listing into [manualState]. No-op for non-JS sources.
     *
     * ### Cancel + watchdog — why this can no longer spin forever
     *
     * The JS runtime is single-threaded and its pump has a 5-minute stuck-detector, so one source
     * call can occupy minutes before it fails. That used to mean: every later 跳页 queued behind it
     * and the page bar spun with no error and no escape (reported as「跳页一直转圈」). Two rails fix
     * the UX without touching the engine:
     *
     *  • a new request **cancels** the in-flight one (its late state writes are dropped — it is no
     *    longer the current generation);
     *  • a watchdog flips the bar into a retryable error after [MANUAL_PAGE_TIMEOUT_MS] even when
     *    the engine call is parked in non-interruptible blocking code — the straggler is
     *    *invalidated*, not killed: it simply loses the right to write the state.
     *
     * The staged logs (start / source returned / done / timeout / failed) exist so the next「一直
     * 转圈」report pinpoints the stall stage from logcat alone: `start` without `source returned`
     * means the stall is inside the source call (initGate / engine), never reaching it means the
     * dispatcher was starved.
     */
    fun loadManualPage(page: Int) {
        if (source !is JsCatalogueSource) return
        val safePage = page.coerceAtLeast(1)
        val gen = manualLoadGeneration.incrementAndGet()
        manualLoadJob?.cancel()
        manualLoadJob = screenModelScope.launchIO {
            val startedAt = System.currentTimeMillis()
            val listing = state.value.listing
            val key = listing.manualKey()
            JsDebugLog.d(MANUAL_LOG_TAG, "loadManualPage: start page=$safePage key=$key gen=$gen")
            // A listing CHANGE (new query / tab / filter set) starts from a blank grid: keeping the old
            // covers while the (源站 ~0.6s + 桥/入库) request ran made a JS search look like it had not
            // reacted at all. A page flip stays inside one key, so it keeps its items and stays seamless.
            val keepItems = _manualState.value.loadedKey == key
            _manualState.update {
                it.copy(
                    page = safePage,
                    isLoading = true,
                    error = null,
                    loadingKey = key,
                    items = if (keepItems) it.items else emptyList(),
                )
            }
            // Fires only if the load is still running past the budget. The engine call may be blocked
            // in non-interruptible code (executor.submit().get()), so *cancelling* cannot always stop
            // it — invalidating the generation and writing the error state is what the user sees.
            val watchdog = launch {
                delay(MANUAL_PAGE_TIMEOUT_MS)
                JsDebugLog.add(
                    MANUAL_LOG_TAG,
                    "loadManualPage: TIMEOUT page=$safePage key=$key gen=$gen after ${MANUAL_PAGE_TIMEOUT_MS}ms",
                )
                manualLoadGeneration.incrementAndGet() // the straggler loses its write rights
                _manualState.update {
                    if (it.loadingKey == key) {
                        it.copy(
                            isLoading = false,
                            error = "加载超时（${MANUAL_PAGE_TIMEOUT_MS / 1000} 秒）— 请重试，或换个页码/线路",
                            loadedKey = key,
                            loadingKey = null,
                        )
                    } else {
                        it
                    }
                }
            }
            try {
                val result = runCatching {
                    val filters = listing.filters
                    val pageResult: MangasPage = when (listing) {
                        is Listing.Popular -> source.getPopularManga(safePage)
                        is Listing.Latest -> source.getLatestUpdates(safePage)
                        is Listing.Search -> source.getSearchManga(safePage, listing.query ?: "", filters)
                    }
                    JsDebugLog.d(
                        MANUAL_LOG_TAG,
                        "loadManualPage: source returned ${pageResult.mangas.size} items " +
                            "(hasNext=${pageResult.hasNextPage}) in ${System.currentTimeMillis() - startedAt}ms",
                    )
                    // Resolve the page's entries CONCURRENTLY. `NetworkToLocalManga.await` is one or two DB
                    // round trips per manga (`getMangaByUrlAndSourceId` + a possible `insertManga`), and a
                    // JS page is 80 of them — awaiting them one after another added a serial DB chain on
                    // top of the source call, *before* anything could be drawn. `awaitAll` keeps the page's
                    // order (unlike `map { async { } }` + `map { it.await() }`, which would also work but
                    // reads as if order mattered less than it does).
                    val mapped = coroutineScope {
                        pageResult.mangas
                            .map { smanga ->
                                async {
                                    networkToLocalManga.await(smanga.toDomainManga(sourceId))
                                        .let { local -> getManga.subscribe(local.url, local.source) }
                                        .filterNotNull()
                                        .stateIn(ioCoroutineScope)
                                }
                            }
                            .awaitAll()
                    }.filter { !hideInLibraryItems || !it.value.favorite }
                    val max = (source as JsCatalogueSource).lastKnownMaxPage
                    // Drop the write if a newer load (or the watchdog) has taken over the bar.
                    if (manualLoadGeneration.get() == gen) {
                        _manualState.update {
                            it.copy(
                                items = mapped,
                                isLoading = false,
                                maxPage = max,
                                hasNext = pageResult.hasNextPage,
                                loadedKey = key,
                                loadingKey = null,
                            )
                        }
                        JsDebugLog.d(
                            MANUAL_LOG_TAG,
                            "loadManualPage: done page=$safePage items=${mapped.size} " +
                                "total=${System.currentTimeMillis() - startedAt}ms",
                        )
                    }
                }
                if (result.isFailure) {
                    val e = result.exceptionOrNull()!!
                    when {
                        // Superseded by a newer page request — it owns the bar now; writing anything
                        // here would clobber its in-flight state.
                        e is CancellationException -> JsDebugLog.d(
                            MANUAL_LOG_TAG,
                            "loadManualPage: cancelled page=$safePage after ${System.currentTimeMillis() - startedAt}ms",
                        )
                        else -> {
                            JsDebugLog.add(
                                MANUAL_LOG_TAG,
                                "loadManualPage: failed page=$safePage -> " +
                                    "${e.javaClass.simpleName}: ${e.message?.take(200)}",
                            )
                            if (manualLoadGeneration.get() == gen) {
                                _manualState.update {
                                    it.copy(
                                        isLoading = false,
                                        error = e.message ?: e.javaClass.simpleName,
                                        // Record the failure as「this key was dealt with」so a mere recomposition does
                                        // not silently retry it in a loop; the retry affordances are explicit (the page
                                        // bar, the snackbar, the empty screen).
                                        loadedKey = key,
                                        loadingKey = null,
                                    )
                                }
                            }
                        }
                    }
                }
            } finally {
                watchdog.cancel()
            }
        }
    }

    fun manualPrevPage() {
        val p = _manualState.value.page
        if (p > 1) loadManualPage(p - 1)
    }

    fun manualNextPage() {
        val s = _manualState.value
        if (s.hasNext) loadManualPage(s.page + 1)
    }

    /** Jump to an absolute page; clamps to a sane lower bound and lets the source reject the rest. */
    fun manualJump(target: Int) {
        loadManualPage(target.coerceAtLeast(1))
    }

    fun manualRetry() = loadManualPage(_manualState.value.page)

    fun getColumnsPreference(orientation: Int): GridCells {
        val isLandscape = orientation == Configuration.ORIENTATION_LANDSCAPE
        val columns = if (isLandscape) {
            libraryPreferences.mangaLandscapeColumns()
        } else {
            libraryPreferences.mangaPortraitColumns()
        }.get()
        return if (columns == 0) GridCells.Adaptive(128.dp) else GridCells.Fixed(columns)
    }

    // returns the number from the size slider
    fun getColumnsPreferenceForCurrentOrientation(orientation: Int): Int {
        val isLandscape = orientation == Configuration.ORIENTATION_LANDSCAPE
        return if (isLandscape) {
            libraryPreferences.mangaLandscapeColumns()
        } else {
            libraryPreferences.mangaPortraitColumns()
        }.get()
    }

    fun resetFilters() {
        if (source !is CatalogueSource) return

        mutableState.update { it.copy(filters = source.getFilterList()) }
    }

    fun setListing(listing: Listing) {
        mutableState.update { it.copy(listing = listing, toolbarQuery = null) }
        // JS sources are driven manually, so the tab click must kick the load itself. (No-op for
        // native sources, and a no-op here when this listing already has content.)
        ensureManualListing()
    }

    fun setFilters(filters: FilterList) {
        if (source !is CatalogueSource) return

        mutableState.update {
            it.copy(
                filters = filters,
            )
        }
    }

    fun search(query: String? = null, filters: FilterList? = null) {
        if (source !is CatalogueSource) return

        val input = state.value.listing as? Listing.Search
            ?: Listing.Search(query = null, filters = source.getFilterList())

        mutableState.update {
            it.copy(
                listing = input.copy(
                    query = query ?: input.query,
                    filters = filters ?: input.filters,
                ),
                toolbarQuery = query ?: input.query,
            )
        }
        // The filter sheet hands back the SAME `FilterList` instance it mutated in place, so
        // `state.listing` may compare equal before and after「应用」 — the screen's
        // `LaunchedEffect(listing, filters)` cannot see that change. Kicking the load from here (and
        // comparing rendered filter values in `ensureManualListing`) is what makes 「已在搜索页改筛选」
        // actually refetch. See [manualKey].
        ensureManualListing()
    }

    fun searchGenre(genreName: String) {
        if (source !is CatalogueSource) return

        val defaultFilters = source.getFilterList()
        var genreExists = false

        filter@ for (sourceFilter in defaultFilters) {
            if (sourceFilter is SourceModelFilter.Group<*>) {
                for (filter in sourceFilter.state) {
                    if (filter is SourceModelFilter<*> && filter.name.equals(genreName, true)) {
                        when (filter) {
                            is SourceModelFilter.TriState -> filter.state = 1
                            is SourceModelFilter.CheckBox -> filter.state = true
                            else -> {}
                        }
                        genreExists = true
                        break@filter
                    }
                }
            } else if (sourceFilter is SourceModelFilter.Select<*>) {
                val index = sourceFilter.values.filterIsInstance<String>()
                    .indexOfFirst { it.equals(genreName, true) }

                if (index != -1) {
                    sourceFilter.state = index
                    genreExists = true
                    break
                }
            }
        }

        mutableState.update {
            val listing = if (genreExists) {
                Listing.Search(query = null, filters = defaultFilters)
            } else {
                Listing.Search(query = genreName, filters = defaultFilters)
            }
            it.copy(
                filters = defaultFilters,
                listing = listing,
                toolbarQuery = listing.query,
            )
        }
        ensureManualListing()
    }

    /**
     * Adds or removes a manga from the library.
     *
     * @param manga the manga to update.
     */
    fun changeMangaFavorite(manga: Manga) {
        screenModelScope.launch {
            var new = manga.copy(
                favorite = !manga.favorite,
                dateAdded = when (manga.favorite) {
                    true -> 0
                    false -> Instant.now().toEpochMilli()
                },
            )

            if (!new.favorite) {
                new = new.removeCovers(coverCache)
            } else {
                setMangaDefaultChapterFlags.await(manga)
                addTracks.bindEnhancedTrackers(manga, source)
            }

            updateManga.await(new.toMangaUpdate())
        }
    }

    fun addFavorite(manga: Manga) {
        screenModelScope.launch {
            val categories = getCategories()
            val defaultCategoryId = libraryPreferences.defaultMangaCategory().get()
            val defaultCategory = categories.find { it.id == defaultCategoryId.toLong() }

            when {
                // Default category set
                defaultCategory != null -> {
                    moveMangaToCategories(manga, defaultCategory)

                    changeMangaFavorite(manga)
                }

                // Automatic 'Default' or no categories
                defaultCategoryId == 0 || categories.isEmpty() -> {
                    moveMangaToCategories(manga)

                    changeMangaFavorite(manga)
                }

                // Choose a category
                else -> {
                    val preselectedIds = getCategories.await(manga.id).map { it.id }
                    setDialog(
                        Dialog.ChangeMangaCategory(
                            manga,
                            categories.mapAsCheckboxState { it.id in preselectedIds }.toImmutableList(),
                        ),
                    )
                }
            }
        }
    }

    /**
     * Get user categories.
     *
     * @return List of categories, not including the default category
     */
    suspend fun getCategories(): List<Category> {
        return getCategories.subscribe()
            .firstOrNull()
            ?.filterNot { it.isSystemCategory }
            .orEmpty()
    }

    suspend fun getDuplicateLibraryManga(manga: Manga): Manga? {
        return getDuplicateLibraryManga.await(manga).getOrNull(0)
    }

    private fun moveMangaToCategories(manga: Manga, vararg categories: Category) {
        moveMangaToCategories(manga, categories.filter { it.id != 0L }.map { it.id })
    }

    fun moveMangaToCategories(manga: Manga, categoryIds: List<Long>) {
        screenModelScope.launchIO {
            setMangaCategories.await(
                mangaId = manga.id,
                categoryIds = categoryIds.toList(),
            )
        }
    }

    fun openFilterSheet() {
        setDialog(Dialog.Filter)
    }

    fun setDialog(dialog: Dialog?) {
        mutableState.update { it.copy(dialog = dialog) }
    }

    fun setToolbarQuery(query: String?) {
        mutableState.update { it.copy(toolbarQuery = query) }
    }

    sealed class Listing(open val query: String?, open val filters: FilterList) {
        data object Popular : Listing(query = GetRemoteManga.QUERY_POPULAR, filters = FilterList())
        data object Latest : Listing(query = GetRemoteManga.QUERY_LATEST, filters = FilterList())
        data class Search(override val query: String?, override val filters: FilterList) : Listing(
            query = query,
            filters = filters,
        )

        companion object {
            fun valueOf(query: String?): Listing {
                return when (query) {
                    GetRemoteManga.QUERY_POPULAR -> Popular
                    GetRemoteManga.QUERY_LATEST -> Latest
                    else -> Search(query = query, filters = FilterList()) // filters are filled in later
                }
            }
        }
    }

    sealed interface Dialog {
        data object Filter : Dialog
        data class RemoveManga(val manga: Manga) : Dialog
        data class AddDuplicateManga(val manga: Manga, val duplicate: Manga) : Dialog
        data class ChangeMangaCategory(
            val manga: Manga,
            val initialSelection: ImmutableList<CheckboxState.State<Category>>,
        ) : Dialog
        data class Migrate(val newManga: Manga, val oldManga: Manga) : Dialog
    }

    @Immutable
    data class State(
        val listing: Listing,
        val filters: FilterList = FilterList(),
        val toolbarQuery: String? = null,
        val dialog: Dialog? = null,
    ) {
        val isUserQuery get() = listing is Listing.Search && !listing.query.isNullOrEmpty()
    }
}
