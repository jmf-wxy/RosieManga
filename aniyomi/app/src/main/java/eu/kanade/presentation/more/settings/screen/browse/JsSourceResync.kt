package eu.kanade.presentation.more.settings.screen.browse

import eu.kanade.tachiyomi.source.manga.js.JsDebugLog
import eu.kanade.tachiyomi.source.manga.js.JsMangaSource
import kotlinx.coroutines.flow.first
import tachiyomi.domain.entries.manga.model.MangaUpdate
import tachiyomi.domain.entries.manga.repository.MangaRepository

/**
 * Upgrade self-heal for JS sources (S41) — the one place that decides "this source's library rows
 * should re-pull from the source on their next open".
 *
 * ### The problem it fixes
 *
 * A source upgrade routinely fixes what the **previous** version had already written into the
 * library: a scrambled chapter list (GoDa's hash-ordered `chapters`), 未知作者, a stale chapter
 * count. But an already-synced library manga never re-pulls on its own — `MangaScreenModel` gates
 * the initial fetch on `chapters.isEmpty()` / `!manga.initialized`, and a manga that already has
 * chapters satisfies neither — so the fix stays invisible until the user manually pulls to refresh
 * every single entry. Re-syncing here, once, is what makes「升级源之后老漫画就正常了」true.
 *
 * ### How it is done — and why it is safe
 *
 * The lever is the manga's `initialized` flag. `MangaScreenModel` derives
 * `needRefreshInfo = !manga.initialized` and `needRefreshChapter = chapters.isEmpty() ||
 * !manga.initialized`, so flipping it to `false` makes the **next open** run both
 * `fetchMangaFromSource` (metadata) and `fetchChaptersFromSource` (chapter order). It then
 * **self-clears**: `getMangaDetails` ends with `initialized = true`.
 *
 * Red lines respected:
 *  • Read progress is never touched — only the `initialized` column is written.
 *  • No DB schema migration (the S41 2700+-line risk) — an ordinary `MangaUpdate` batch, wrapped by
 *    the repository's own transaction, so a large library pays one write, not one per row.
 *  • Pull-to-refresh stays available as the fallback entry point.
 */
object JsSourceResync {

    private const val TAG = "JsSourceResync"

    /**
     * Marks every **library** manga of the source [key] as needing a fresh pull.
     *
     * @param mangaRepository injected by the caller (this object lives in the app module, which owns
     *   the domain layer, so it does not resolve its own dependency).
     * @return the number of rows changed — `0` when nothing needed it (no library entries, or all
     *   already `initialized = false`).
     */
    suspend fun markSourceForResync(mangaRepository: MangaRepository, key: String): Int {
        val sourceId = JsMangaSource.keyToId(key)
        val favorites = mangaRepository.getMangaFavoritesBySourceId(sourceId).first()
        // Only rows currently `initialized` are flipped: a row already `false` re-pulls on its own,
        // and re-writing it would be a pointless DB write.
        val updates = favorites
            .filter { it.initialized }
            .map { MangaUpdate(id = it.id, initialized = false) }
        if (updates.isEmpty()) return 0
        mangaRepository.updateAllManga(updates)
        JsDebugLog.d(TAG, "resync($key): 标记 ${updates.size} 部库内漫画为待重拉（initialized=false）")
        return updates.size
    }
}
