package eu.kanade.tachiyomi.source.manga

import android.content.Context
import eu.kanade.tachiyomi.data.download.manga.MangaDownloadManager
import eu.kanade.tachiyomi.extension.manga.MangaExtensionManager
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.MangaSource
import eu.kanade.tachiyomi.source.manga.js.JsSourceManager
import eu.kanade.tachiyomi.source.online.OnlineMangaSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import tachiyomi.domain.source.manga.model.StubMangaSource
import tachiyomi.domain.source.manga.repository.MangaStubSourceRepository
import tachiyomi.domain.source.manga.service.MangaSourceManager
import tachiyomi.source.local.entries.manga.LocalMangaSource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import uy.kohesive.injekt.injectLazy
import java.util.concurrent.ConcurrentHashMap

class AndroidMangaSourceManager(
    private val context: Context,
    private val extensionManager: MangaExtensionManager,
    private val sourceRepository: MangaStubSourceRepository,
) : MangaSourceManager {

    private val _isInitialized = MutableStateFlow(false)
    override val isInitialized: StateFlow<Boolean> = _isInitialized.asStateFlow()

    private val downloadManager: MangaDownloadManager by injectLazy()

    private val scope = CoroutineScope(Job() + Dispatchers.IO)

    private val sourcesMapFlow = MutableStateFlow(ConcurrentHashMap<Long, MangaSource>())

    private val stubSourcesMap = ConcurrentHashMap<Long, StubMangaSource>()

    override val catalogueSources: Flow<List<CatalogueSource>> = sourcesMapFlow.map {
        it.values.filterIsInstance<CatalogueSource>()
    }

    init {
        scope.launch {
            extensionManager.installedExtensionsFlow
                .collectLatest { extensions ->
                    val mutableMap = ConcurrentHashMap<Long, MangaSource>(
                        mapOf(
                            LocalMangaSource.ID to LocalMangaSource(
                                context,
                                Injekt.get(),
                                Injekt.get(),
                            ),
                        ),
                    )
                    extensions.forEach { extension ->
                        extension.sources.forEach {
                            mutableMap[it.id] = it
                            registerStubSource(StubMangaSource.from(it))
                        }
                    }

                    // --- Venera-style JS comic sources (parallel to the Kotlin extension sources) ---
                    // Loaded from `filesDir/comic_source/*.js`; each becomes a `JsMangaSource`.
                    // Being a `CatalogueSource`, it is picked up by Browse/GlobalSearch/Library as-is.
                    runCatching { JsSourceManager.init(context) }
                    JsSourceManager.sources.forEach {
                        mutableMap[it.id] = it
                        registerStubSource(StubMangaSource.from(it))
                    }

                    sourcesMapFlow.value = mutableMap
                    _isInitialized.value = true
                }
        }

        scope.launch {
            sourceRepository.subscribeAllManga()
                .collectLatest { sources ->
                    val mutableMap = stubSourcesMap.toMutableMap()
                    sources.forEach {
                        mutableMap[it.id] = it
                    }
                }
        }
    }

    override fun get(sourceKey: Long): MangaSource? {
        return sourcesMapFlow.value[sourceKey]
    }

    /**
     * Re-merges [JsSourceManager]'s sources into the registry.
     *
     * The registry is normally only rebuilt when `installedExtensionsFlow` emits, so a JS source
     * installed at runtime — imported from a `.venera` backup, or dropped in via the config screen —
     * would stay invisible to Browse / GlobalSearch / Library until the next cold start. Callers that
     * install sources outside the extension pipeline must announce it with this method.
     *
     * Additive on purpose: existing entries (including Kotlin extension sources) are kept, because
     * rebuilding from scratch here would drop whatever the extension collector last produced.
     */
    fun refreshJsSources() {
        scope.launch {
            runCatching { JsSourceManager.init(context) }
            val sources = JsSourceManager.sources
            if (sources.isEmpty()) return@launch

            val mutableMap = ConcurrentHashMap(sourcesMapFlow.value)
            sources.forEach {
                mutableMap[it.id] = it
                registerStubSource(StubMangaSource.from(it))
            }
            sourcesMapFlow.value = mutableMap
        }
    }

    override fun getOrStub(sourceKey: Long): MangaSource {
        return sourcesMapFlow.value[sourceKey] ?: stubSourcesMap.getOrPut(sourceKey) {
            runBlocking { createStubSource(sourceKey) }
        }
    }

    // Intent check: includes both HttpSource (Kotlin extensions) and JsMangaSource (Venera JS).
    override fun getOnlineSources() = sourcesMapFlow.value.values.filterIsInstance<OnlineMangaSource>()

    override fun getCatalogueSources() = sourcesMapFlow.value.values.filterIsInstance<CatalogueSource>()

    override fun getStubSources(): List<StubMangaSource> {
        val onlineSourceIds = getOnlineSources().map { it.id }
        return stubSourcesMap.values.filterNot { it.id in onlineSourceIds }
    }

    private fun registerStubSource(source: StubMangaSource) {
        scope.launch {
            val dbSource = sourceRepository.getStubMangaSource(source.id)
            if (dbSource == source) return@launch
            sourceRepository.upsertStubMangaSource(source.id, source.lang, source.name)
            if (dbSource != null) {
                downloadManager.renameSource(dbSource, source)
            }
        }
    }

    private suspend fun createStubSource(id: Long): StubMangaSource {
        sourceRepository.getStubMangaSource(id)?.let {
            return it
        }
        extensionManager.getSourceData(id)?.let {
            registerStubSource(it)
            return it
        }
        return StubMangaSource(id = id, lang = "", name = "")
    }
}
