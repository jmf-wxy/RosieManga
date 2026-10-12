package eu.kanade.tachiyomi.source.online

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.Page
import okhttp3.Response

/**
 * Marker interface for any manga source whose content is fetched over the network **at runtime**,
 * regardless of the underlying implementation (Kotlin extension / Venera-style JS source).
 *
 * Why this exists:
 * ---------------
 * Historically the reader/downloader tested `source is HttpSource` to decide "is this an online
 * source that can load pages from the internet?". That is an *implementation* check, not an
 * *intent* check. A Venera `JsMangaSource` is very much an online source, but it does NOT extend
 * [HttpSource] (its pages come out of a QuickJS runtime, not from OkHttp request builders), so it
 * fell through to `else -> error(loader_not_implemented_error)` in
 * `ChapterLoader.getPageLoader()` and crashed as soon as a chapter was opened.
 *
 * By introducing this marker we invert the dependency: sources declare intent, and the UI asks
 * about intent. Every current [HttpSource] is an [OnlineMangaSource] (see its declaration), and so
 * is the JS bridge — with zero behavioural change for existing extensions.
 *
 * Contract for implementors
 * -------------------------
 * Implementations must be able to produce a [Response] for a given [Page] on demand. For Kotlin
 * extension sources this is [HttpSource.getImage]; for the JS bridge it's an OkHttp call built
 * from the page url plus any per-source headers the JS `comic.onImageLoad(...)` hook returns.
 */
interface OnlineMangaSource : CatalogueSource {

    /**
     * Resolves the real image url for [page], if the source serves pages indirectly (e.g. a
     * viewer page that must be scraped before the CDN url is known).
     *
     * Default: return [Page.imageUrl] when present, else fall back to [Page.url]. This matches how
     * [HttpSource] behaves for sources that already expose a direct image link, and lets the JS
     * bridge omit the extra round-trip entirely.
     */
    suspend fun getImageUrl(page: Page): String = page.imageUrl ?: page.url

    /**
     * Returns the raw response for the given [page]. The caller is responsible for closing it.
     *
     * Must not block the main thread; the reader invokes this from an IO context.
     */
    suspend fun getImage(page: Page): Response
}
