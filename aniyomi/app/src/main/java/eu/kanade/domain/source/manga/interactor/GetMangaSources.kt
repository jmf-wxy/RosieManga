package eu.kanade.domain.source.manga.interactor

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import tachiyomi.core.common.util.lang.compareToWithCollator
import tachiyomi.domain.source.manga.model.Source
import tachiyomi.domain.source.manga.repository.MangaSourceRepository
import tachiyomi.source.local.entries.manga.LocalMangaSource

/**
 * Every installed catalogue source, sorted by name (the local source is excluded).
 *
 * Used by source migration so a whole source can be migrated to any other installed source,
 * not only to sources sharing the same name.
 */
class GetMangaSources(
    private val repository: MangaSourceRepository,
) {

    fun subscribe(): Flow<List<Source>> {
        return repository.getMangaSources()
            .map { sources ->
                sources
                    .filterNot { it.id == LocalMangaSource.ID }
                    .sortedWith(
                        Comparator { a, b -> a.name.lowercase().compareToWithCollator(b.name.lowercase()) },
                    )
            }
    }
}
