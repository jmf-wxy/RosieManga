package eu.kanade.tachiyomi.ui.browse.manga.migration.sources

import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import eu.kanade.domain.entries.manga.interactor.UpdateManga
import eu.kanade.domain.source.interactor.SetMigrateSorting
import eu.kanade.domain.source.manga.interactor.GetMangaSources
import eu.kanade.domain.source.manga.interactor.GetMangaSourcesWithFavoriteCount
import eu.kanade.domain.source.service.SourcePreferences
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.toImmutableList
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import logcat.LogPriority
import tachiyomi.core.common.util.lang.launchIO
import tachiyomi.core.common.util.lang.withUIContext
import tachiyomi.core.common.util.system.logcat
import tachiyomi.domain.entries.manga.interactor.GetMangaFavorites
import tachiyomi.domain.entries.manga.model.Manga
import tachiyomi.domain.entries.manga.model.MangaUpdate
import tachiyomi.domain.source.manga.model.Source
import tachiyomi.domain.source.manga.service.MangaSourceManager
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

class MigrateMangaSourceScreenModel(
    preferences: SourcePreferences = Injekt.get(),
    private val getSourcesWithFavoriteCount: GetMangaSourcesWithFavoriteCount = Injekt.get(),
    private val getSources: GetMangaSources = Injekt.get(),
    private val setMigrateSorting: SetMigrateSorting = Injekt.get(),
    private val getMangaFavorites: GetMangaFavorites = Injekt.get(),
    private val updateManga: UpdateManga = Injekt.get(),
    private val sourceManager: MangaSourceManager = Injekt.get(),
) : StateScreenModel<MigrateMangaSourceScreenModel.State>(State()) {

    private val _channel = Channel<Event>(Int.MAX_VALUE)
    val channel = _channel.receiveAsFlow()

    init {
        screenModelScope.launchIO {
            getSourcesWithFavoriteCount.subscribe()
                .catch {
                    logcat(LogPriority.ERROR, it)
                    _channel.send(Event.FailedFetchingSourcesWithCount)
                }
                .collectLatest { sources ->
                    mutableState.update {
                        it.copy(
                            isLoading = false,
                            items = sources.toImmutableList(),
                        )
                    }
                }
        }

        preferences.migrationSortingDirection().changes()
            .onEach { mutableState.update { state -> state.copy(sortingDirection = it) } }
            .launchIn(screenModelScope)

        preferences.migrationSortingMode().changes()
            .onEach { mutableState.update { state -> state.copy(sortingMode = it) } }
            .launchIn(screenModelScope)
    }

    fun toggleSortingMode() {
        with(state.value) {
            val newMode = when (sortingMode) {
                SetMigrateSorting.Mode.ALPHABETICAL -> SetMigrateSorting.Mode.TOTAL
                SetMigrateSorting.Mode.TOTAL -> SetMigrateSorting.Mode.ALPHABETICAL
            }

            setMigrateSorting.await(newMode, sortingDirection)
        }
    }

    fun toggleSortingDirection() {
        with(state.value) {
            val newDirection = when (sortingDirection) {
                SetMigrateSorting.Direction.ASCENDING -> SetMigrateSorting.Direction.DESCENDING
                SetMigrateSorting.Direction.DESCENDING -> SetMigrateSorting.Direction.ASCENDING
            }

            setMigrateSorting.await(sortingMode, newDirection)
        }
    }

    fun openTargetSourceDialog(source: Source) {
        screenModelScope.launchIO {
            val sameNameCandidates = state.value.items
                .map { it.first }
                .filter { it.id != source.id && it.name.equals(source.name, ignoreCase = true) }

            if (sameNameCandidates.isNotEmpty()) {
                mutableState.update {
                    it.copy(dialog = Dialog.SelectTarget(source, sameNameCandidates.toImmutableList(), isFallback = false))
                }
                return@launchIO
            }

            // No source with the same name (no mirror / other language variant):
            // fall back to every other installed source so the source can still be migrated.
            val candidates = getSources.subscribe()
                .first()
                .filter { it.id != source.id }

            if (candidates.isEmpty()) {
                _channel.send(Event.NoTargetSource)
                return@launchIO
            }

            mutableState.update {
                it.copy(dialog = Dialog.SelectTarget(source, candidates.toImmutableList(), isFallback = true))
            }
        }
    }

    fun dismissDialog() {
        mutableState.update { it.copy(dialog = Dialog.Closed) }
    }

    fun proceedToConfirm(source: Source, target: Source) {
        screenModelScope.launchIO {
            val count = getMangaFavorites.subscribe(source.id).first().size
            mutableState.update {
                it.copy(dialog = Dialog.Confirm(source, target, count))
            }
        }
    }

    fun migrateSource(source: Source, target: Source) {
        screenModelScope.launchIO {
            mutableState.update { it.copy(dialog = Dialog.Migrating) }

            try {
                val favorites = getMangaFavorites.subscribe(source.id).first()
                // `SManga.url` is the library identity key: it is written once and never rewritten,
                // so a cross-site migration has to produce a url the *target* source understands.
                // Skipped for a same-source "migration", where the old url is already valid.
                // The cast is safe-by-design: a target that is not a `CatalogueSource` (an
                // uninstalled stub, for instance) simply gets no url resolution and keeps today's
                // behaviour instead of failing the whole migration.
                val resolved = if (source.id != target.id) {
                    (sourceManager.getOrStub(target.id) as? CatalogueSource)
                        ?.let { resolveTargetUrls(favorites, it) }
                        ?: emptyMap()
                } else {
                    emptyMap()
                }
                val updates = favorites.map { manga ->
                    MangaUpdate(
                        id = manga.id,
                        source = target.id,
                        initialized = false,
                        url = resolved[manga.id] ?: manga.url,
                    )
                }
                updateManga.awaitAll(updates)

                withUIContext {
                    _channel.send(Event.MigrationComplete(favorites.size))
                    if (source.id != target.id) {
                        _channel.send(
                            Event.UrlsResolved(
                                rewritten = resolved.size,
                                unresolved = favorites.size - resolved.size,
                            ),
                        )
                    }
                }
            } catch (e: Throwable) {
                logcat(LogPriority.ERROR, e)
                withUIContext {
                    _channel.send(Event.MigrationFailed)
                }
            } finally {
                mutableState.update { it.copy(dialog = Dialog.Closed) }
            }
        }
    }

    /**
     * Finds each favorite's counterpart **in the target source** by searching its title, and
     * returns `mangaId -> new url` for the ones it could resolve.
     *
     * ### Why this exists
     *
     * `MangaUpdate` used to carry only `source`, which left the **old** url in place. That url
     * belongs to the source being migrated *away from*, so the first `getMangaDetails` after a
     * cross-site migration hit the new source with a foreign path and failed. Migrating between
     * same-named / mirror sources happened to work only because their url scheme is identical —
     * which is exactly the case the old code silently assumed for everyone.
     *
     * ### The policy: rewrite only on a unique match
     *
     * A url is rewritten **only** when the target source returns exactly one distinct result whose
     * normalized title equals the manga's own title. No hit, or two distinct hits, keeps the old
     * url — i.e. the previous behaviour. A wrong mapping is far more expensive than a failed
     * migration (it silently points a library entry at another work), so ambiguity is never
     * resolved by guessing.
     */
    private suspend fun resolveTargetUrls(
        favorites: List<Manga>,
        target: CatalogueSource,
    ): Map<Long, String> {
        if (favorites.isEmpty()) return emptyMap()
        // `getFilterList()` re-enters QuickJS for JS sources; a failure here must not abort the
        // whole migration, so fall back to an empty filter list (search still works).
        val filters = runCatching { target.getFilterList() }.getOrElse { FilterList(emptyList()) }
        val resolved = mutableMapOf<Long, String>()
        favorites.forEach { manga ->
            val wanted = normalizeTitle(manga.title)
            if (wanted.isEmpty()) return@forEach
            val hits = mutableSetOf<String>()
            var page = 1
            // Searches run one at a time on purpose: JS sources serialize on the single QuickJS
            // runtime, so parallelizing here would only queue work behind the same lock.
            while (hits.isEmpty() && page <= MAX_SEARCH_PAGES) {
                val result = runCatching {
                    withTimeoutOrNull(SEARCH_TIMEOUT_MS) {
                        target.getSearchManga(page, manga.title, filters)
                    }
                }.getOrNull() ?: break
                result.mangas.forEach { candidate ->
                    if (normalizeTitle(candidate.title) == wanted) {
                        candidate.url.takeIf { it.isNotBlank() }?.let { hits += it }
                    }
                }
                if (!result.hasNextPage) break
                page++
            }
            if (hits.size == 1) resolved[manga.id] = hits.first()
        }
        if (resolved.isNotEmpty()) {
            logcat(LogPriority.DEBUG) { "migrate: resolved ${resolved.size}/${favorites.size} urls" }
        }
        return resolved
    }

    /**
     * Title key for matching: lower-cased with everything that is not a letter or digit dropped,
     * so 「One Piece」/「one-piece」/「ONE PIECE!」 collapse together while 「X (2023)」 and 「X」
     * stay distinct (digits are kept, so volume/season suffixes still matter).
     */
    private fun normalizeTitle(title: String): String =
        title.lowercase().filter { it.isLetterOrDigit() }

    @Immutable
    data class State(
        val isLoading: Boolean = true,
        val items: ImmutableList<Pair<Source, Long>> = persistentListOf(),
        val sortingMode: SetMigrateSorting.Mode = SetMigrateSorting.Mode.ALPHABETICAL,
        val sortingDirection: SetMigrateSorting.Direction = SetMigrateSorting.Direction.ASCENDING,
        val dialog: Dialog = Dialog.Closed,
    ) {
        val isEmpty = items.isEmpty()
    }

    @Immutable
    sealed interface Dialog {
        data object Closed : Dialog
        data class SelectTarget(
            val source: Source,
            val candidates: ImmutableList<Source>,
            /** True when there is no same-named source and every other source is offered instead. */
            val isFallback: Boolean = false,
        ) : Dialog
        data class Confirm(
            val source: Source,
            val target: Source,
            val count: Int,
        ) : Dialog
        data object Migrating : Dialog
    }

    sealed interface Event {
        data object FailedFetchingSourcesWithCount : Event
        data object NoTargetSource : Event
        data object MigrationFailed : Event
        data class MigrationComplete(val count: Int) : Event
        /**
         * Emitted only for a cross-site migration, after [MigrationComplete]. Reports how many
         * library entries got a url the target source understands ([rewritten]) and how many kept
         * their old url because the title search found nothing or was ambiguous ([unresolved]).
         */
        data class UrlsResolved(val rewritten: Int, val unresolved: Int) : Event
    }

    private companion object {
        /** Page 1 of a search is normally enough; page 2 is a cheap second chance. */
        const val MAX_SEARCH_PAGES = 2

        /** Per-search wall clock. A hung source must not hang the migration dialog forever. */
        const val SEARCH_TIMEOUT_MS = 15_000L
    }
}
