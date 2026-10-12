package eu.kanade.presentation.more.settings.screen.browse

import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.source.manga.js.JsSourceInfo
import eu.kanade.tachiyomi.source.manga.js.JsSourceIndexEntry
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import eu.kanade.tachiyomi.source.manga.js.JsSourceUpdater
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.toImmutableList
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import tachiyomi.core.common.util.lang.launchIO
import tachiyomi.domain.entries.manga.repository.MangaRepository
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Screen model for the JS 源 management page.
 *
 * Responsibilities:
 *  • show all installed JS sources (name / version / file);
 *  • add a source repository URL and list its catalogue;
 *  • install / update / delete individual sources;
 *  • "sync all" from a repo.
 */
class JsSourcesScreenModel(
    private val defaultRepoUrl: String = DEFAULT_REPO_URL,
    private val mangaRepository: MangaRepository = Injekt.get(),
) : StateScreenModel<JsSourcesState>(JsSourcesState()) {

    private val _events: Channel<JsSourceEvent> = Channel(Int.MAX_VALUE)
    val events = _events.receiveAsFlow()

    init {
        screenModelScope.launchIO {
            JsSourceManager.installed.collectLatest { installed ->
                mutableState.update { it.copy(installed = installed.toImmutableList()) }
            }
        }
        // Populate the repo field with the default repo so a first-time user can sync immediately.
        mutableState.update { it.copy(repoUrl = defaultRepoUrl) }
        loadIndex()
    }

    // --- repo / index -----------------------------------------------------------------------------

    fun setRepoUrl(url: String) {
        mutableState.update { it.copy(repoUrl = url) }
    }

    /** Fetches the repo index and lists available sources. */
    fun loadIndex() {
        val repo = state.value.repoUrl
        if (repo.isBlank()) return
        screenModelScope.launchIO {
            mutableState.update { it.copy(isLoadingIndex = true) }
            val index = JsSourceUpdater.fetchIndex(repo)
            mutableState.update {
                it.copy(
                    isLoadingIndex = false,
                    available = index.toImmutableList(),
                    indexError = index.isEmpty(),
                )
            }
            if (index.isEmpty()) _events.send(JsSourceEvent.IndexFailed)
        }
    }

    /** Installs (or updates) a single source from the current repo. */
    fun install(entry: JsSourceIndexEntry) {
        val repo = state.value.repoUrl
        screenModelScope.launchIO {
            mutableState.update { it.copy(pendingKeys = it.pendingKeys + entry.key) }
            val result = JsSourceUpdater.installFromRepo(repo, entry)
            if (result != null) {
                // A re-install over an existing source is an upgrade; heal its library rows the same
                // way `syncAll` does (a first-time install has none, so this is a no-op).
                runCatching { JsSourceResync.markSourceForResync(mangaRepository, entry.key) }
            }
            mutableState.update { it.copy(pendingKeys = it.pendingKeys - entry.key) }
            _events.send(if (result != null) JsSourceEvent.Installed(entry.name) else JsSourceEvent.InstallFailed(entry.name))
        }
    }

    /** Installs/updates every source in the repo. */
    fun syncAll() {
        val repo = state.value.repoUrl
        screenModelScope.launchIO {
            mutableState.update { it.copy(isSyncing = true) }
            val upgradedKeys = mutableListOf<String>()
            val count = JsSourceUpdater.syncRepo(
                repoUrl = repo,
                onProgress = { done, total ->
                    mutableState.update { it.copy(syncProgress = done to total) }
                },
                onUpgraded = { upgradedKeys += it },
            )
            // Upgrade self-heal (S41): a replaced source may have written a bad chapter list under
            // its previous version. Mark its library rows for a fresh pull — see [JsSourceResync].
            upgradedKeys.sumOf { key ->
                runCatching { JsSourceResync.markSourceForResync(mangaRepository, key) }.getOrDefault(0)
            }
            mutableState.update { it.copy(isSyncing = false, syncProgress = null) }
            _events.send(JsSourceEvent.Synced(count))
        }
    }

    /**
     * Deletes an installed source.
     *
     * `JsSourceManager.uninstall` re-enters QuickJS (`evalBlocking`, i.e. the caller waits for the
     * JS thread) and then deletes the `.js` / `.data` files. Running that on whatever thread the
     * row's click handler happens to be on — the main thread — stalls the frame, so it is moved to
     * IO here.
     */
    fun uninstall(key: String) {
        screenModelScope.launchIO { JsSourceManager.uninstall(key) }
    }

    /**
     * Installs a source imported from a local `*.js` file.
     *
     * ⚠️ The install itself must stay inside [launchIO]. `JsSourceUpdater.installFromText` →
     * `JsSourceManager.install` parses the script in QuickJS (`evalBlocking` =
     * `executor.submit().get()`), reflects its metadata (dozens more blocking evals) and
     * re-dispatches the source's `init()`. This used to run *before* `launchIO`, so the caller's
     * thread paid for all of it — and the caller is an `ActivityResult` callback, i.e. the main
     * thread. Importing a source froze the UI for the whole import.
     */
    fun importFromFile(fileName: String, code: String) {
        screenModelScope.launchIO {
            val result = JsSourceUpdater.installFromText(fileName, code)
            _events.send(if (result != null) JsSourceEvent.Installed(result.name) else JsSourceEvent.ImportFailed)
        }
    }

    /** Installs a source pasted as text. See [importFromFile] for why the install runs on IO. */
    fun importFromText(code: String) {
        screenModelScope.launchIO {
            val result = JsSourceManager.install(code)
            _events.send(if (result != null) JsSourceEvent.Installed(result.name) else JsSourceEvent.ImportFailed)
        }
    }

    companion object {
        /** Canonical Venera source repository. */
        const val DEFAULT_REPO_URL = "https://raw.githubusercontent.com/venera-app/venera-configs/main"
    }
}

@Immutable
data class JsSourcesState(
    val installed: ImmutableList<JsSourceInfo> = immutableListOf(),
    val available: ImmutableList<JsSourceIndexEntry> = immutableListOf(),
    val repoUrl: String = "",
    val isLoadingIndex: Boolean = false,
    val isSyncing: Boolean = false,
    val syncProgress: Pair<Int, Int>? = null,
    val indexError: Boolean = false,
    /** Keys with an install in flight, so the row can show a spinner. */
    val pendingKeys: Set<String> = emptySet(),
) {
    /**
     * Available entries that are not installed yet.
     *
     * ⚠️ `by lazy` on purpose. These used to be plain `get()` properties, so every read rebuilt the
     * sets (`map`/`toSet`/`associateBy`/`filter`). Compose reads them on every recomposition of the
     * list *and* every time it evaluates a lazy item key — i.e. many times per scroll frame. A
     * snapshot is immutable, so computing once per state instance is enough.
     */
    val installable: List<JsSourceIndexEntry> by lazy {
        val installedKeys = installed.map { it.key }.toSet()
        available.filter { it.key !in installedKeys }
    }

    /** Available entries whose installed version differs from the index version. See [installable]. */
    val updatable: List<JsSourceIndexEntry> by lazy {
        val byKey = installed.associateBy { it.key }
        available.filter { entry ->
            val current = byKey[entry.key] ?: return@filter false
            entry.version.isNotEmpty() && entry.version != current.version
        }
    }
}

sealed class JsSourceEvent {
    sealed class LocalizedMessage(val stringRes: StringResource) : JsSourceEvent()
    data class Installed(val name: String) : JsSourceEvent()
    data class InstallFailed(val name: String) : JsSourceEvent()
    data class Synced(val count: Int) : JsSourceEvent()
    data object IndexFailed : JsSourceEvent()
    data object ImportFailed : JsSourceEvent()
}

private fun <T> immutableListOf(): ImmutableList<T> = emptyList<T>().toImmutableList()
