package eu.kanade.tachiyomi.ui.browse.manga.migration.sources

import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import eu.kanade.domain.entries.manga.interactor.UpdateManga
import eu.kanade.domain.source.interactor.SetMigrateSorting
import eu.kanade.domain.source.manga.interactor.GetMangaSources
import eu.kanade.domain.source.manga.interactor.GetMangaSourcesWithFavoriteCount
import eu.kanade.domain.source.service.SourcePreferences
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
import logcat.LogPriority
import tachiyomi.core.common.util.lang.launchIO
import tachiyomi.core.common.util.lang.withUIContext
import tachiyomi.core.common.util.system.logcat
import tachiyomi.domain.entries.manga.interactor.GetMangaFavorites
import tachiyomi.domain.entries.manga.model.MangaUpdate
import tachiyomi.domain.source.manga.model.Source
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

class MigrateMangaSourceScreenModel(
    preferences: SourcePreferences = Injekt.get(),
    private val getSourcesWithFavoriteCount: GetMangaSourcesWithFavoriteCount = Injekt.get(),
    private val getSources: GetMangaSources = Injekt.get(),
    private val setMigrateSorting: SetMigrateSorting = Injekt.get(),
    private val getMangaFavorites: GetMangaFavorites = Injekt.get(),
    private val updateManga: UpdateManga = Injekt.get(),
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
                val updates = favorites.map { manga ->
                    MangaUpdate(
                        id = manga.id,
                        source = target.id,
                        initialized = false,
                    )
                }
                updateManga.awaitAll(updates)

                withUIContext {
                    _channel.send(Event.MigrationComplete(favorites.size))
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
    }
}
