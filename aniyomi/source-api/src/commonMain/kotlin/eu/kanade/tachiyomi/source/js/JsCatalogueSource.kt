package eu.kanade.tachiyomi.source.js

import eu.kanade.tachiyomi.source.CatalogueSource

/**
 * Marker for JS-backed comic sources (Venera-style `ComicSource.sources.<key>`).
 *
 * The host UI uses this to offer affordances that only make sense when a listing is driven by the
 * engine rather than the native [eu.kanade.tachiyomi.source.online.HttpSource] paging contract —
 * most importantly a **page-based navigation bar** (上一页 / 第 N 页 / 下一页 / 跳页) instead of the
 * Paging3 infinite scroll that every native catalogue source uses.
 *
 * A source implementing this is still a regular [CatalogueSource]: it just happens to be backed by
 * QuickJS. Native sources never implement it, so the check `source is JsCatalogueSource` is an exact
 * "is this a JS source" test (HttpSource is *not* a subtype).
 */
interface JsCatalogueSource : CatalogueSource {
    /**
     * The last `maxPage` the source reported for the most recent listing call, or null if it did not
     * report one (e.g. a one-shot `multiPartPage` explore page). The pagination bar reads this to
     * render「共 M 页」and to clamp the jump input. It is the engine's own value, not a host guess.
     */
    val lastKnownMaxPage: Int?
}
