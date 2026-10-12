package tachiyomi.domain.source.manga.service

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.MangaSource
import eu.kanade.tachiyomi.source.online.OnlineMangaSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import tachiyomi.domain.source.manga.model.StubMangaSource

interface MangaSourceManager {

    val isInitialized: StateFlow<Boolean>

    val catalogueSources: Flow<List<CatalogueSource>>

    fun get(sourceKey: Long): MangaSource?

    fun getOrStub(sourceKey: Long): MangaSource

    /**
     * Sources whose content is fetched over the network at runtime — both Kotlin extensions
     * ([eu.kanade.tachiyomi.source.online.HttpSource]) and Venera-style JS sources.
     */
    fun getOnlineSources(): List<OnlineMangaSource>

    fun getCatalogueSources(): List<CatalogueSource>

    fun getStubSources(): List<StubMangaSource>
}
