package eu.kanade.tachiyomi.source.manga.js

import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.js.JsCatalogueSource
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.OnlineMangaSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.create
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Adapts a Venera-style JS comic source to a native Aniyomi [CatalogueSource].
 *
 * Once an instance is registered in `AndroidMangaSourceManager.sourcesMapFlow`, the entire
 * Browse / GlobalSearch / Library / Reader pipeline treats it exactly like a Kotlin extension
 * source — with ZERO changes to the UI (see docs/aniyomi-source-system-report.md).
 *
 * ID conventions (Venera is string-based, Aniyomi is Long-based):
 *   • source id  = [keyToId] (stable MD5 of the source `key`)
 *   • comic id   = stored in `SManga.url`
 *   • chapter id = stored in `SChapter.url` as `"<comicId>||<epId>"` because Venera's
 *                  `comic.loadEp(comicId, epId)` needs BOTH, while Aniyomi's `getPageList`
 *                  only receives the [SChapter].
 */
class JsMangaSource(
    override val id: Long,
    /** Visible name; mutable so a source update can refresh metadata without re-registering. */
    override var name: String,
    override val lang: String,
    /** Venera `key`; addresses the JS object `ComicSource.sources.<key>`. */
    val key: String,
    private val engine: JsEngine,
    /** Venera `version` (`""` when the source does not declare one). */
    var version: String = "",
) : OnlineMangaSource, JsCatalogueSource {

    /**
     * Most recent `maxPage` reported by the source for the last listing call. Drives the「共 M 页」
     * label and jump-input clamp in the host's page navigation bar. Updated in [parseListing] — see
     * the assignment near the `maxPage` parse — and read by [BrowseMangaSourceScreenModel] right
     * after the (suspend) source call returns, so the value is the one just produced.
     */
    override var lastKnownMaxPage: Int? = null

    override val supportsLatest: Boolean = true

    /**
     * Gate that releases [evalSource] only after the source's `init()` has been dispatched AND
     * settled (see [JsSourceManager.runSourceInit], which completes this in a `finally`).
     *
     * ### Why this exists: `https://undefined` was a real failure mode
     * jm.js (and any Venera source following the same pattern) builds `baseUrl` from state that
     * ONLY `init()` creates — jm.js's `JM.apiDomains` is not even declared until `init()` assigns
     * it. A detail-page `loadInfo` that raced the startup `init()` evaluated
     * `JM.apiDomains[index]` on `undefined` and either crashed or — worse — issued a request to a
     * garbage host that hung until the client timeout, presenting to the user as「详情页一直在加载」.
     * Awaiting the gate here makes source-call ordering deterministic: Venera runs `init()` right
     * after parsing and before any entry point, and so do we now.
     */
    val initGate = kotlinx.coroutines.CompletableDeferred<Unit>()

    /**
     * Without this the manga detail screen prints the fully-qualified class name
     * (`eu.kanade.tachiyomi.source.manga.js.JsMangaSource@1f2a3b`) in its source row, because
     * `MangaSource` has no `toString` of its own and the UI renders the source as text. Kotlin
     * extension sources get a readable name from the extension metadata; a JS source has only this.
     */
    override fun toString(): String = name

    private val network: NetworkHelper = Injekt.get()

    /**
     * Source-declared browse/search metadata, captured by [JsSourceManager.warmMeta] **at load
     * time** and never evaluated on demand.
     *
     * ### Why a field and not a lazy `eval`
     *
     * `getFilterList()` runs from `BrowseMangaSourceScreenModel`'s constructor and from Compose
     * click handlers — both on the **main thread**. Evaluating QuickJS there re-enters the engine
     * from a thread that may already be draining its job queue, which is precisely the self-
     * deadlock S2 forbids. So the data is reflected once, off-thread ([JsSourceManager.parseMeta]),
     * and read here as plain Kotlin. Until it is set the source simply exposes no filters, which
     * the UI renders exactly as before (no 筛选 chip).
     */
    var filterMeta: JsSourceMeta = JsSourceMeta()

    /**
     * The category used for the「最近更新」tab.
     *
     * ### Why「热门」and「最近更新」used to show the identical list
     *
     * Both delegated to `explore[0].load(...)`, and jm's single explore entry is
     * `type: "multiPartPage"` — `singlePageWithMultiPart` in Venera, i.e. **one page with several
     * sections and no pagination at all**. Two tabs pointed at it cannot differ.
     *
     * The real「最新」lives in `categoryComics` (`/categories/filter?o=mr&c=0` → 最新A漫). Measured
     * live (`ref-quickjs-android/probe_jm_latest_vs_popular.js`): `o=mr` and `o=mv` return
     * **completely different** result sets, so the tab can be honest.
     *
     * Selection rule (generic, not jm-specific): prefer a `"category"` part that declares
     * `categoryParams`. jm's「每週必看」declares none and its `optionLoader` needs **two** option
     * values (時間/類型) — calling it with one yields `&type=undefined`. Parts with explicit params
     * are the canonical browse categories, and jm's first such entry is「最新A漫」/`param "0"`.
     *
     * ### How a source declares what「最近更新」means (goda)
     *
     * The rule above reads **declaration order**, so a source steers this tab by putting its
     * update-sorted group first. goda.js declares a part named「更新」(`/dayup` = 最近更新,
     * `/newss` = 最新上架) ahead of「类型」, because goda's「类型 · 全部」is `/manga` — and `/manga`
     * returns **exactly the same comics as `/hots`** (measured live:
     * `ref-quickjs-android/probe_goda_lists.js`), i.e. the「全部」list is not update-sorted at all.
     * Ordering the parts is therefore the difference between「最近更新」being a real update feed and
     * being a second copy of the ranking.
     */
    private val latestCategory: JsCategoryPart?
        get() = filterMeta.categoryParts.firstOrNull { it.itemType == "category" && !it.param.isNullOrBlank() }

    /**
     * The ranking option「热门」uses — returned as the **JS value** the source expects, never as the
     * declared `"value-text"` entry.
     *
     * ### Two independent bugs lived here; both made「热门」and「最近更新」render one and the same list
     *
     * **1. The display half was being sent as the value.** Venera parses
     * `categoryComics.ranking.options` into a `Map<value, text>` (`parser.dart`:
     * `var key = split.removeAt(0); var value = split.join("-")`) and its ranking page hands
     * `options.keys.first` — the **value** — to `ranking.load()` (`ranking_page.dart`). We passed the
     * whole declared string instead, so jm spliced `o=mv_m-月排行` into the query. The server does not
     * recognise that and **silently falls back to its default order, which is 最新** — measured live
     * (`ref-quickjs-android/probe_jm_popular_latest_distinct.js`): `o=mv_m-月排行` returns a page that
     * is **100 % identical** to `o=mr`, and so does any other unrecognised `o=` (`mv-總排行`,
     * `__bogus__`). Hence「热门」could not differ from「最近更新」no matter which ranking was picked,
     * while the filter sheet's「排行」Select — which *does* strip the label via [optionValue] — was
     * already correct. Same trap for the sort on the search path, which is why [defaultSortValue] and
     * [optionValue] have always fed `o=mr` and not `o=mr-最新`.
     *
     * **2. The option picked was 月排行.** Requested explicitly: 热门 shows the source's **overall**
     * ranking (总排行).
     *
     * ### Selection rule (generic, not jm-specific)
     *
     * Prefer the option whose **text** says「總/总」(总排行); then one whose **value** carries no
     * period suffix (`mv`, as opposed to `mv_m`/`mv_w`/`mv_t`); then the first. Never index 1 blindly:
     * jm declares 總排行 first and `mv_t` (日排行) can legitimately come back nearly empty — measured:
     * 總=10000 / 月=259 / 周=719 / 日=64.
     */
    private fun popularRankingOption(): String? {
        val options = filterMeta.rankingOptions
        if (!filterMeta.enableRanking || options.isEmpty()) return null
        val chosen = options.firstOrNull { option ->
            val text = option.substringAfter('-', option)
            text.contains('總') || text.contains('总')
        } ?: options.firstOrNull { !it.substringBefore('-').contains('_') }
            ?: options.first()
        // `load()` receives the VALUE half only — Venera: `options.keys.first`.
        return chosen.substringBefore('-')
    }

    override fun getFilterList(): FilterList = buildFilterList()

    /**
     * 「热门」— the source's ranking listing (总排行 for jm) when it declares one, otherwise the
     * best paginated `explore` entry it offers.
     *
     * The ranking argument is the option's **value** (`mv`), not its `"value-text"` declaration — see
     * [popularRankingOption] for the live measurement showing what sending the label did.
     *
     * ### Why the explore fallback now picks an entry instead of hard-coding `explore[0]`
     *
     * The three explore types are called differently — `load()` with **no argument** for
     * `multiPartPage`, `load(page)` **1-based** for `multiPageComicList`, `load(index)` **0-based**
     * for `mixed` (Venera's own `parser.dart`; see [JsExploreEntry]). The host used to emit
     * `explore[0].load(page - 1)` for all three, so any source declaring the **paginated**
     * `multiPageComicList` — the「分页类型」one — requested the wrong page on every call and could
     * never advance. Now a paginated entry is preferred outright, and the expression matches its
     * type.
     */
    override suspend fun getPopularManga(page: Int): MangasPage {
        popularRankingOption()?.let { ranking ->
            return parseListing(
                evalSource("categoryComics.ranking.load(${ranking.jsQuote()}, $page)"),
                pagingGuardKey = "popular:$ranking",
                page = page,
            )
        }
        val entry = popularExploreEntry()
            ?: // No ranking and no callable explore entry: nothing to browse.
            return MangasPage(emptyList(), false)
        return loadExplorePage(entry, page)
    }

    /**
     * The explore entry to browse when the source offers no ranking.
     *
     * Order of preference: a **paginated** `multiPageComicList` (the「分页类型」— scrolls forever),
     * then `mixed` (also paginated, page-index based), then whatever is first (jm: a
     * `multiPartPage` home page, which has no pagination at all — that is a property of the source,
     * not something the host can fix).
     */
    private fun popularExploreEntry(): JsExploreEntry? {
        val entries = filterMeta.exploreEntries
        return entries.firstOrNull { it.type == "multiPageComicList" }
            ?: entries.firstOrNull { it.type == "mixed" }
            ?: entries.firstOrNull()
    }

    /**
     * Calls one `explore` entry using **its own** convention, and reports pagination accordingly.
     *
     *  • `multiPartPage` → `load()`, no argument. Returns an array of `{title, comics}` parts and
     *    declares no `maxPage`, so the listing is a one-shot page (`hasNextPage = false`).
     *  • `multiPageComicList` → `load(page)`, **1-based**.
     *  • `mixed` → `load(page - 1)`, **0-based index**; the payload is `{data: [...], maxPage}`, and
     *    `data` may mix plain comics with `{title, comics}` parts — both shapes are flattened.
     */
    private suspend fun loadExplorePage(entry: JsExploreEntry, page: Int): MangasPage {
        val call = when (entry.type) {
            "multiPageComicList" -> "explore[${entry.index}].load($page)"
            "mixed" -> "explore[${entry.index}].load(${page - 1})"
            // Anything else (notably `multiPartPage`) takes no page argument.
            else -> "explore[${entry.index}].load()"
        }
        return parseListing(
            evalSource(call),
            // Only paginated types can loop; a one-shot page has nothing to guard against.
            pagingGuardKey = if (entry.isPaginated) "explore:${entry.index}" else null,
            page = page,
        )
    }

    /**
     * 「最近更新」— the source's newest releases, which is **not** the explore page and **not** the
     * ranking.
     *
     * ### Why the no-category fallback no longer delegates to [getPopularManga]
     *
     * It used to, "duplicating the ranking list is still better than an empty tab". That is precisely
     * how the two tabs ended up showing the SAME data (the complaint that led here): any source whose
     * `category.parts` we cannot read fell back to Popular, so 「最近更新」rendered the ranking. The
     * source's own explore entry is a "home" listing — wrong, but at least genuinely different from the
     * ranking. Only a source that offers neither a browsable category nor an explore entry gets an
     * empty tab, and then there is nothing to show anyway.
     */
    override suspend fun getLatestUpdates(page: Int): MangasPage {
        latestCategory?.let { category ->
            val sort = defaultSortValue() ?: ""
            return parseListing(
                evalSource(
                    "categoryComics.load(${category.category.jsQuote()}, " +
                        "${(category.param ?: "").jsQuote()}, [${sort.jsQuote()}], $page)",
                ),
                // The default sort (`mr`) is a newest-first ordering, so this listing genuinely advances
                // page by page — guard it against a server that ignores `page`.
                pagingGuardKey = "latest:${category.category}",
                page = page,
            )
        }
        val entry = popularExploreEntry() ?: return MangasPage(emptyList(), false)
        return loadExplorePage(entry, page)
    }

    /**
     * Resolves the listing the user actually asked for, by precedence:
     *
     *  1. **排行** — an explicit ranking selection wins outright (Venera makes it a destination of
     *     its own, reachable from the 分类 page).
     *  2. **分类** — a selected category outranks the keyword: Venera's category page is a *browse*
     *     of that category, and the two `itemType`s are served by different endpoints
     *     (`"category"` → `categoryComics.load`, `"search"` → `search.load`).
     *  3. **关键词** — a typed query goes to `search.load`.
     *  4. **None of the above** — an empty keyword gets **nothing** from jm (`total=0`, measured
     *     live; the endpoint is keyword-driven). If a non-default sort was picked, browse the
     *     source's own「最新」category with that sort so the 排序 filter alone still does something
     *     visible; otherwise fall back to the explore page.
     */
    override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage {
        val sort = filters.optionValue(SORT_LABEL) ?: defaultSortValue() ?: ""

        filters.selectedRanking()?.let { ranking ->
            return parseListing(
                evalSource("categoryComics.ranking.load(${ranking.jsQuote()}, $page)"),
                pagingGuardKey = "ranking:$ranking",
                page = page,
            )
        }

        val category = filters.selectedCategory()
        if (category != null) {
            val options = categoryOptionValues(category, filters, sort)
            val optionsLiteral = options.joinToString(prefix = "[", postfix = "]") { it.jsQuote() }
            val call = when (category.itemType) {
                "search" -> "search.load(${category.category.jsQuote()}, $optionsLiteral, $page)"
                else -> "categoryComics.load(${category.category.jsQuote()}, " +
                    "${(category.param ?: "").jsQuote()}, $optionsLiteral, $page)"
            }
            return parseListing(
                evalSource(call),
                pagingGuardKey = "category:${category.category}:${options.joinToString(",")}",
                page = page,
            )
        }

        if (query.isNotBlank()) {
            return parseListing(
                evalSource("search.load(${query.jsQuote()}, [${sort.jsQuote()}], $page)"),
                // Search is the ONE listing that genuinely paginates (`maxPage`), so it is also the
                // only one that can loop forever — guard it against non-advancing pages.
                pagingGuardKey = "search:$query:$sort",
                page = page,
            )
        }

        val latest = latestCategory
        // `defaultSortValue()` is null for a source that declares no sort options (goda), while
        // `sort` is then `""` — comparing the two raw made this branch fire for EVERY such source,
        // so an empty filter fell through to the「最新」category and rendered the same list as the
        // 「最近更新」tab. Treat "no declared default" and "empty" as the same thing.
        if (latest != null && sort != (defaultSortValue() ?: "")) {
            return parseListing(
                evalSource(
                    "categoryComics.load(${latest.category.jsQuote()}, " +
                        "${(latest.param ?: "").jsQuote()}, [${sort.jsQuote()}], $page)",
                ),
                pagingGuardKey = "sorted:${latest.category}:$sort",
                page = page,
            )
        }

        return getPopularManga(page)
    }

    // --- details ---------------------------------------------------------------------------------

    override suspend fun getMangaDetails(manga: SManga): SManga {
        val d = loadDetails(manga.url)
        // Venera's `ComicDetails` keeps creators/genre inside the `tags` map (作者 / 类型 / 标签 …),
        // not in a flat `uploader` field — only some sources (jm.js) ever fill `uploader`. Reading
        // `uploader` alone therefore rendered GoDa's detail page as「未知作者 · 未知」even though
        // the source had parsed both (goda.js puts them in `tags`). Merge, explicit field first.
        fun tagValues(key: String): List<String> {
            val raw = (d["tags"] as? Map<*, *>)?.get(key) as? List<*>
            return raw?.mapNotNull { it?.toString()?.trim() }
                ?.filter { it.isNotBlank() }
                ?: emptyList()
        }
        val uploader = d["uploader"]?.toString()?.takeIf { it.isNotBlank() }
        val creators = uploader ?: tagValues("作者").joinToString(", ").takeIf { it.isNotBlank() }
        // 类型 is the real genre; 标签 (systems/ tropes) only stands in when a source has no 类型 row.
        val genre = tagValues("类型").takeIf { it.isNotEmpty() }?.joinToString(", ")
            ?: tagValues("标签").takeIf { it.isNotEmpty() }?.joinToString(", ")
        return manga.apply {
            d["title"]?.toString()?.let { title = it }
            // Only overwrite the cover with a NON-blank URL. The browse listing already gave this
            // manga a `thumbnail_url` (`toSManga`), and the detail screen's image loader starts from
            // that value — Coil serves it from its memory/disk cache the moment the screen opens.
            // Unconditionally assigning `d["cover"]` used to (a) CLEAR the cover when loadInfo
            // failed or omitted it (`emptyMap` fallback -> null), and (b) trigger a full re-download
            // whenever loadInfo's cover differed from the listing's by even a query parameter. Both
            // showed up to the user as "the detail page's cover takes forever / flashes away".
            d["cover"]?.toString()?.takeIf { it.isNotBlank() }?.let { thumbnail_url = it }
            description = d["description"]?.toString()
            creators?.let {
                author = it
                artist = it
            }
            genre?.let { this.genre = it }
            initialized = true
        }
    }

    override suspend fun getChapterList(manga: SManga): List<SChapter> {
        val data = loadDetails(manga.url)
        // `__plainValue` (init.js) delivers a JS `Map` as an ORDERED list of [key, value] pairs —
        // see the Map branch there for why a keyed object cannot cross the native conversion:
        // `convertToMap` collects object keys into a java.util.HashMap (hash order — insertion
        // order is unrecoverable) and marshals each key through JNI's modified UTF-8, where a
        // NUL-prefixed key truncated to "" (the「共 1 章」collapse). Nested JSArrays become
        // ArrayLists walked by index, so the pair list keeps BOTH count and reading order.
        // Sources that build `chapters` as a plain object still arrive as a Map — fall back.
        val entries: List<Pair<String, String?>> = when (val raw = data["chapters"]) {
            is List<*> -> raw.mapNotNull { pair ->
                val p = pair as? List<*>
                when {
                    p == null || p.isEmpty() -> null
                    else -> Pair(p[0].toString(), p.getOrNull(1)?.toString())
                }
            }
            // ⚠️ This branch is LOSSY and the source can silently force a source into it: a
            // `chapters` built as a plain `{}` object (rather than a JS `Map`) is walked into a
            // java.util.HashMap, so the order below is HASH order, not reading order — and since
            // `chapter_number` is derived from the position, the scrambling also renumbers the
            // chapters. GoDa's list read 510/271/512/269/508/268 for exactly this reason. A source
            // must build a `Map`; treat anything arriving here as "order unknown", not "sorted".
            is Map<*, *> -> {
                // Last time this cost a full debugging round: the *page* looked fine (title, cover,
                // chapter count) and only the order was wrong, so it read as "the host sorts
                // chapters wrong" rather than "this source is one version behind" — the fix had
                // been in the source file for a day while the device still ran the old copy. The
                // shape is the only in-app evidence, so record it once per manga.
                if (hashOrderWarned.add(manga.url)) {
                    JsDebugLog.d(
                        TAG,
                        "getChapterList: '${manga.url}' 的 chapters 是普通对象（非 JS Map）—— " +
                            "跨桥后落进 java.util.HashMap，顺序=哈希序、chapter_number 一并错位。" +
                            "该源必须用 `new Map()` 建章节表；设备上出现乱序时先确认源版本是否已更新。",
                    )
                }
                raw.entries.map { Pair(it.key.toString(), it.value?.toString()) }
            }
            else -> emptyList()
        }
        val chapters = entries.mapIndexed { i, (chapterId, title) ->
            SChapter.create().apply {
                url = "${manga.url}||$chapterId"           // comicId||chapterId
                // A blank title (jm.js guards it with `第${sort}話`, but other sources may not) must
                // not render as an empty row — fall back to the chapter id, which is at least a
                // stable, recognisable label.
                name = title?.takeIf { it.isNotBlank() } ?: chapterId
                // The source builds this list in *reading* order — jm.js sorts `series` by ascending
                // `sort` before inserting — so entry #0 is the **first (oldest)** chapter and gets
                // the lowest number. The list is reversed below, and numbering happens BEFORE the
                // reversal so the newest chapter keeps the HIGHEST number — the two display orders
                // the app can pick (source order / chapter number descending) then both show the
                // newest chapter on top.
                chapter_number = (i + 1).toFloat()
            }
        }
        // Newest chapter first: the source hands us oldest→newest, but a chapter list reads
        // top-down as new→old (users check「有没有更新」against the top of the list).
        return chapters.asReversed()
    }

    override suspend fun getPageList(chapter: SChapter): List<Page> {
        val parts = chapter.url.split("||")
        // `chapter.url` is `"<SManga.url>||<chapterId>"`, so a library row with a malformed manga id
        // poisons this half too. Repair it the same way — see [normalizeComicId].
        val comicId = normalizeComicId(parts.getOrElse(0) { "" }, "loadEp")
        val epId = parts.getOrElse(1) { "" }
        val res = evalSource("comic.loadEp(${comicId.jsQuote()}, ${epId.jsQuote()})") as? Map<*, *>
        val images = res?.get("images") as? List<*> ?: return emptyList()
        return images.mapIndexed { i, rawUrl ->
            val url = rawUrl.toString()
            // Tag every page with its chapter context: `comic.onImageLoad(url, comicId, epId)` —
            // JM's image unscramble is keyed off the epId — needs BOTH ids, and [Page] carries no
            // chapter. The URL fragment never reaches the server (OkHttp strips it from the
            // request line) and the chapter cache keys on the full URL, so the tag survives
            // restarts, cached page lists and re-downloads. [getImage] parses it back out.
            val tagged = "$url#c=$comicId&e=$epId"
            Page(i, url = tagged, imageUrl = tagged)
        }
    }

    /**
     * Image fetch for the reader/downloader — and the **image unscramble point**.
     *
     * Venera sources attach per-image config via `comic.onImageLoad(url, comicId, epId)`
     * (`ImageLoadingConfig`): fetch `url`/`method`/`data`/`headers`, plus an optional `modifyImage`
     * JS script that rebuilds strip-shuffled pictures through the native `Image` primitives
     * ([JsImageEngine]). JM uses exactly this: auth headers + a strip-reorder script keyed off
     * the episode id and picture name.
     *
     * The chapter context arrives via the URL fragment that [getPageList] appends — see there for
     * why that is safe across caching and restarts.
     *
     * Failure semantics: a config error or transform error **degrades, never throws** — a
     * scrambled picture is still readable and still gets cached; a failed page is not.
     */
    override suspend fun getImage(page: Page): Response {
        val taggedUrl = page.imageUrl ?: page.url
        val tag = parseImageTag(taggedUrl)
        if (tag == null) {
            // Untagged page (old cached list, or a source that never tags): fetch as-is, exactly
            // like the previous implementation.
            return network.client.newCall(Request.Builder().url(taggedUrl).build()).execute()
        }

        // Config may be a plain object or a Promise — evalSource settles either.
        val config = runCatching {
            evalSource(
                "comic.onImageLoad(${tag.url.jsQuote()}, ${tag.comicId.jsQuote()}, ${tag.epId.jsQuote()})",
            ) as? Map<*, *>
        }.onFailure { JsDebugLog.add(TAG, "onImageLoad failed: ${it.message}") }.getOrNull()

        val requestUrl = (config?.get("url") as? String)?.takeIf { it.isNotBlank() } ?: tag.url
        val modifyScript = (config?.get("modifyImage") as? String)?.takeIf { it.isNotBlank() }

        val builder = Request.Builder().url(requestUrl)
        (config?.get("headers") as? Map<*, *>)?.forEach { (k, v) ->
            val name = k?.toString() ?: return@forEach
            val value = v?.toString() ?: return@forEach
            if (name.equals("Accept-Encoding", true)) {
                // S12: never forward the source's Accept-Encoding. jm.js sends
                // `gzip, deflate, br, zstd` — CF then picks zstd, OkHttp cannot transparently
                // decode it, and we'd hand compressed garbage to the image decoder.
                return@forEach
            }
            builder.header(name, value)
        }
        val request = builder.build()

        val response = network.client.newCall(request).execute()
        if (modifyScript == null) return response

        val contentType = response.header("Content-Type")
        val original = response.use { it.body.bytes() }

        // Content-hash cache: identical (source, comic, episode, script, bytes) ⇒ reuse the PNG the
        // previous visit produced and skip decode + eval + encode entirely. Misses fall through to
        // the full transform and store the result. See [ImageTransformCache] for the key rationale
        // and the threading rules (a lock of its own, never held across the eval — S16).
        val cacheKey = ImageTransformCache.keyOf(key, tag.comicId, tag.epId, modifyScript, original)
        val cached = ImageTransformCache.get(cacheKey)
        val transformed: ByteArray? = if (cached != null) {
            JsDebugLog.add(
                TAG,
                "transform cache HIT key=$key c=${tag.comicId} e=${tag.epId} " +
                    "(${cached.size}B, 跳过 decode+eval+encode)",
            )
            cached
        } else {
            val produced = runCatching {
                JsImageEngine.transform(engine, modifyScript, original)
            }.onFailure {
                JsDebugLog.add(TAG, "modifyImage failed: ${it.javaClass.simpleName}: ${it.message}")
            }.getOrNull()
            if (produced != null) ImageTransformCache.put(cacheKey, produced)
            JsDebugLog.add(
                TAG,
                "transform cache MISS key=$key c=${tag.comicId} e=${tag.epId} " +
                    "(transformed=${produced != null})",
            )
            produced
        }
        val body = transformed ?: original
        val mediaType = if (transformed != null) "image/png" else contentType ?: "image/jpeg"
        return Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(create(mediaType.toMediaTypeOrNull(), body))
            .build()
    }

    // --- helpers ---------------------------------------------------------------------------------

    /**
     * Evaluates `ComicSource.sources.<key>.<expr>` **and waits for its promise to settle**,
     * returning plain Kotlin data (`Map` / `List` / primitives).
     *
     * ### Why `engine.eval` was the reason "this source finds nothing"
     *
     * `eval()` is a bare `js.evaluate(script)`, which hands back a **live JS handle** — an object
     * arrives as `JSObject`, an array as `JSArray`, and because every Venera source writes its
     * loaders as `async` functions, calling one yields an **unsettled Promise handle**. Both facts
     * break [parseListing] and [loadDetails], which inspect `is Map<*, *>` / `is List<*>`: a handle
     * matches neither, so the listing silently collapses to `MangasPage(emptyList(), false)` and
     * global search renders it as「没有结果」— **indistinguishable from a source that genuinely has
     * no match**. The settings page / login / `init()` all go through `evalForValueBlocking` or
     * `evalAwaiting*` for exactly this reason; the listing leg was simply never migrated.
     *
     * `evalAwaitingResult` also gives us the rejection reason, which we now **throw instead of
     * swallowing** — Aniyomi's global search already has a per-source error row
     * (`MangaSearchItemResult.Error` → `GlobalSearchErrorResultItem`), so a broken request shows up
     * as an error message rather than as an empty result. See [evalSource]'s callers.
     */
    private suspend fun evalSource(expr: String): Any? {
        // Deterministic ordering against `init()`: wait for the gate, but never let a pathological
        // `init()` brick the source — past the fallback window a call proceeds and fails in the
        // source itself, which is a diagnosable error instead of a silent hang.
        //
        // ── Diagnostic (T1, 02-18 无日志无限转圈) ─────────────────────────────────────────────
        // The stall this instrument exists for presented as「跳页既无 JsEngine 日志、也无 OkHttp
        // 请求」——即卡点在求值泵之前。记录 await 的**起止**就能区分三种情况：
        //   • 只有 "awaiting" 无 "released/TIMEOUT" ⇒ 卡在 initGate（init() 从未 settle）；
        //   • 打印 "released ... dispatching" 但随后无 "engine returned" ⇒ 卡在引擎/调度（executor 饿死）；
        //   • 两者都打印 ⇒ 引擎正常返回，卡点在更上层。
        // 纯日志，不改任何控制流。
        val gateStart = System.currentTimeMillis()
        val gateReleased = withTimeoutOrNull(90_000) { initGate.await() } != null
        JsDebugLog.d(
            TAG,
            "evalSource: initGate ${if (gateReleased) "released" else "TIMEOUT(90s)"} " +
                "after ${System.currentTimeMillis() - gateStart}ms; dispatching $key.$expr",
        )
        val script = "ComicSource.sources.$key.$expr"
        // `evalAwaitingResult` is blocking (executor.submit().get()), so keep it off the caller's
        // dispatcher — the same pattern the login path uses (`JsSourceManager` line ~609).
        val attempt = withContext(Dispatchers.IO) {
            runCatching { engine.evalAwaitingResult(script) }
                .onFailure { JsDebugLog.add(TAG, "eval threw: $expr -> ${it.javaClass.simpleName}: ${it.message}") }
        }
        JsDebugLog.d(TAG, "evalSource: engine returned for $key.$expr")
        return when (val outcome = attempt.getOrNull()) {
            is JsEngine.AwaitResult.Settled -> outcome.value
            is JsEngine.AwaitResult.Rejected -> {
                JsDebugLog.add(TAG, "source rejected: $expr -> ${outcome.message}")
                throw IllegalStateException("$name: ${outcome.message}${lastExchangeHint()}")
            }
            null -> {
                // `null` from `evalAwaitingResult` means one thing only: the promise never settled
                // inside the pump's budget. A *thrown* exception used to collapse into the same
                // `null` via `getOrNull()`, and the caller then reported "timed out" for failures
                // that had nothing to do with time — which is exactly how a promise-rejection
                // detonation (`UnhandledPromiseRejectionException: …`, raised by QuickJS on the
                // next `evaluate`) came to be shown as
                // `timed out in jm.comic.loadInfo("…")`. Keep the two apart; they need different
                // investigations and the old collapse ensured the wrong one.
                val cause = attempt.exceptionOrNull()
                if (cause != null) {
                    throw IllegalStateException(
                        "$name: ${cause.javaClass.simpleName}: ${cause.message}${lastExchangeHint()}",
                    )
                }
                JsDebugLog.add(TAG, "source timeout: $expr")
                throw IllegalStateException("$name: timed out in $key.$expr${lastExchangeHint()}")
            }
        }
    }

    /**
     * `（最近请求：GET https://… → 200）`, or empty when nothing was sent yet.
     *
     * Venera sources report failures as bare strings, so an error like jm's `Invalid Data` (thrown
     * when `JSON.parse(body)` yields an object whose `data` is not a string) reaches the user with
     * no indication of *which* request it was about. Appending the last bridge exchange turns it
     * into something diagnosable: `… → 200` with an off-spec body means the remote end answered
     * badly, whereas a `FAILED …`/non-200 line means the trouble is on this side (domain, DNS,
     * interception) and a retry or a different API domain is the right move.
     */
    private fun lastExchangeHint(): String =
        engine.lastHttpExchange()?.let { "（最近请求：$it）" }.orEmpty()

    /**
     * Loads (and shares) the result of ONE `comic.loadInfo` per comic.
     *
     * ### Why this exists: the detail page used to pay for loadInfo **twice**
     *
     * Opening a detail screen makes `MangaScreenModel` run `fetchMangaFromSource` and
     * `fetchChaptersFromSource` **concurrently** (`async` pair) — i.e. `getMangaDetails` and
     * `getChapterList` race, and both called [fetchDetails] on their own. Each call is a full
     * source-side network round trip, and because the QuickJS runtime is single-threaded (S2) the
     * two requests did not even overlap: the screen waited exactly **2 × loadInfo latency** before
     * anything rendered.
     *
     * The fix is single-flight: concurrent callers for the same comicId join one in-flight
     * [Deferred] instead of issuing their own request. No TTL cache is involved, so a manual
     * refresh ("刷新") still hits the source with fresh data — only the redundant *concurrent*
     * duplicate is eliminated.
     *
     * Concurrency notes:
     *  • Registration happens under [loadInfoJobsMutex] so two racing callers cannot both create a
     *    job (the detail screen really does fire both at the same instant).
     *  • [loadInfoScope] uses a `SupervisorJob`, so a caller that gets cancelled (user backs out)
     *    leaves the underlying fetch running for the other joiner instead of killing it mid-flight.
     *  • Cleanup removes the entry only if it is still *this* job, so a fresh load started after a
     *    failure can never be evicted by the previous attempt's `finally`.
     */
    private val loadInfoJobsMutex = Mutex()
    private val loadInfoJobs = ConcurrentHashMap<String, Deferred<Map<*, *>>>()
    private val loadInfoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Short-TTL cache of the LAST successful `comic.loadInfo` per comic.
     *
     * ### Why a TTL is now needed: the library update pays loadInfo TWICE
     *
     * The single-flight map above only dedupes **concurrent** callers — which is what the detail
     * screen produces (`getMangaDetails` and `getChapterList` race in an `async` pair). The library
     * update worker calls them **sequentially** (`MangaLibraryUpdateJob.updateManga`: optional
     * metadata fetch, then chapter list), so each call found the previous one already removed from
     * [loadInfoJobs] and issued a full second `comic.loadInfo` round trip — every manga, every
     * update run, even when nothing changed. For a JS source that is the most expensive thing it
     * can do: the whole update crawls and the progress notification freezes on manga after manga
     * ("更新分类时卡进度").
     *
     * The TTL window only needs to bridge the milliseconds between those two calls, but a slightly
     * wider 45s also absorbs rapid re-entry (opening a detail screen twice in quick succession).
     * Manual refreshes after the window still hit the source fresh — the "no TTL so manual refresh
     * is always fresh" intent is preserved at the granularity that actually matters. Only
     * successful loads are cached; a failed/timeout fetch is retried on the next call.
     */
    private val loadInfoCache = ConcurrentHashMap<String, Pair<Long, Map<*, *>>>()

    /**
     * Manga urls already reported as delivering `chapters` as a plain object (hash order).
     *
     * The symptom is indistinguishable from "the host sorts chapters wrong", so the shape deserves
     * a log line — but a chapter sync runs on every detail-screen open and [JsDebugLog] keeps only
     * 400 lines, so each manga is reported once per process.
     */
    private val hashOrderWarned: MutableSet<String> =
        java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    private suspend fun loadDetails(comicId: String): Map<*, *> {
        val requestId = normalizeComicId(comicId, "loadInfo")
        val now = android.os.SystemClock.elapsedRealtime()
        loadInfoCache[comicId]?.let { (at, data) ->
            if (now - at <= LOAD_INFO_TTL_MS) return data
            loadInfoCache.remove(comicId)
        }
        val job = loadInfoJobsMutex.withLock {
            loadInfoJobs.getOrPut(comicId) {
                loadInfoScope.async { fetchDetails(requestId) }
            }
        }
        try {
            val data = job.await()
            loadInfoCache[comicId] = android.os.SystemClock.elapsedRealtime() to data
            return data
        } finally {
            loadInfoJobsMutex.withLock {
                if (loadInfoJobs[comicId] === job) loadInfoJobs.remove(comicId)
            }
        }
    }

    /**
     * Recovers a usable comic id from a stored one that is clearly not a bare token.
     *
     * ### The failure this exists for
     *
     * A JS manga's identity lives in `SManga.url`, and every request is built by the **source** as
     * `…?id=${id}` — nothing percent-encodes it, so an id containing `/`, `?`, `=` or spaces is
     * spliced into the query verbatim. A library row written with an album **path** instead of an
     * id therefore asks the site about a comic that does not exist:
     *
     * ```
     * 禁漫天堂: Invalid Data（最近请求: GET https://…/album?id=/album/544148/乗馬女子…- -> 200 …）
     * ```
     *
     * `Invalid Data` is jm.js's own check — `typeof json.data !== 'string'` — i.e. the site answered
     * `200` with a short, off-spec error envelope (observed: 42 bytes gzipped, 22 decoded). The page
     * still renders because the data came from the local database, which is why this looked like
     * "the detail page is broken" rather than "this row's id is wrong".
     *
     * ### Why repairing is safe
     *
     * An id carrying path/query characters is **already unusable** for any source: interpolated
     * into `?id=` or `/path/${id}` it changes the request either way. So when the stored value does
     * not look like a plain token, recovering a digit run from it can only improve things — and if
     * no such run exists the original value is passed through untouched, leaving the source's own
     * error intact.
     *
     * The stored row is deliberately **not** rewritten: `SManga.url` is the library's identity key
     * and changing it would orphan the entry's chapters, history and downloads.
     */
    /** A comic id that can be interpolated into a query or path without changing its meaning. */
    private val PLAIN_ID = Regex("[A-Za-z0-9_.~-]{1,64}")

    /**
     * An id that is *already* a well-formed path — the source will prefix it with its own base URL.
     *
     * GoDa's ids look like `/manga/kaijuzhuanzhicaishenxunhuayiwanshenchong-rp534295`. Such an id is
     * perfectly usable, and must survive [normalizeComicId] untouched.
     */
    private val PATH_LIKE_ID = Regex("/[A-Za-z0-9_.~/-]{1,160}")

    /** The first run of three or more digits inside a malformed id — i.e. the real comic id. */
    private val DIGIT_RUN = Regex("\\d{3,}")

    private fun normalizeComicId(raw: String, op: String): String {
        if (raw.isEmpty()) return raw
        // 1) A bare token (`544148`, `wuliandianfeng-pikapi`) — already fine.
        if (raw.length <= 64 && PLAIN_ID.matches(raw)) return raw
        // 2) A well-formed path (`/manga/<slug>`) — already fine, and **this check must come before
        //    [DIGIT_RUN]**. GoDa slugs routinely embed long digit runs (`…-rp534295`); running the
        //    digit-recovery heuristic on them rewrote the id to `534295` and the request went to
        //    `https://godamh.com534295`. The heuristic exists for *malformed* ids (jm's stored
        //    `/album/544148/乗馬女子…`, which contains non-ASCII and `?id=`-hostile characters) —
        //    a clean ASCII path is not malformed, it is simply how such a source addresses a page.
        if (PATH_LIKE_ID.matches(raw)) return raw
        // 3) Whatever is left is genuinely unusable when spliced into a query: recover the id.
        val recovered = DIGIT_RUN.find(raw)?.value
        if (recovered != null) {
            JsDebugLog.add(
                TAG,
                "comic id repaired for $op: ${raw.take(90)} -> $recovered (stored url is not a bare id)",
            )
            return recovered
        }
        return raw
    }

    /** The actual `comic.loadInfo` round trip. Failures propagate to every joiner. */
    private suspend fun fetchDetails(comicId: String): Map<*, *> =
        evalSource("comic.loadInfo(${comicId.jsQuote()})") as? Map<*, *> ?: emptyMap<Any?, Any?>()

    /**
     * Flattens every catalogue shape a Venera source may hand back into one comic list.
     *
     * Two shapes exist and **[parseListing] used to only understand the first**:
     *
     *  1. `{ comics: Comic[], maxPage: number }` — `search.load` / `categoryComics.load` / `ranking.load`;
     *  2. `{ title, comics, viewMore }[]`        — `explore`, i.e. `type: "multiPartPage"`
     *     (jm's `explore[0]` returns exactly this: 首页 has several **sections**).
     *
     * Reading (2) as a comic list yields garbage: each element's `id` is missing (→ empty
     * `SManga.url`) and its `title` is the *section* title, so Browse showed a list of section
     * names. Recursing (see [flattenComics]) fixes it without special-casing the source.
     *
     * ### [pagingGuardKey] — why trusting `maxPage` alone made search loop forever
     *
     * Reported as「搜索时无限显示相同的漫画」: the grid filled with the same title over and over
     * while the spinner kept going. Three layers were involved, and only the middle one is ours:
     *
     *  • **Source**: `jm.js search.load` is 1-based and appends `&page=N` only when `page > 1`. If
     *    the server ignores that parameter (or its result set barely moves for an exact-title
     *    query), pages 2, 3, 4… all come back as the **same 80 comics**, while `total` stays large
     *    and the source keeps computing `maxPage = ceil(total / 80)` — a big, positive, and
     *    completely honest-looking number.
     *  • **Here**: `hasNextPage = maxPage != null && maxPage > 0` — we forwarded that number
     *    straight to Paging without ever checking that **this page actually advanced**. So the
     *    Browse list appended the same 80 comics forever.
     *  • **UI**: `BrowseMangaSourceComfortableGrid` renders `items(count = itemCount) { index -> }`
     *    with **no `key`**, so the repeated rows are indistinguishable to Compose and paint as a
     *    wall of identical cards.
     *
     * The fix is the only stop condition that does not depend on the server being well-behaved:
     * remember the previous page's comic ids for this listing and, when the new page overlaps it
     * almost entirely, declare the listing exhausted. [PAGING_OVERLAP_RATIO] is deliberately high
     * (0.9) so that a source with genuinely duplicated ids *within* one page, or a mildly
     * re-ordered next page, is not mistaken for a stall — the verification rig
     * (`ref-quickjs-android/verify_search_pagination_e2e.js`) pins both directions: the looping
     * case stops at page 2, and a correctly-paginating source keeps going.
     *
     * The guard is keyed by listing (query text) and stores only ONE previous page, so an
     * unrelated new search can never inherit a stale comparison window.
     */
    private fun parseListing(res: Any?, pagingGuardKey: String? = null, page: Int = 0): MangasPage {
        val comics = res.flattenComics()
        // `maxPage` only exists in shape (1). For `multiPartPage` there is no pagination at all —
        // the JS `page` argument is ignored, so claiming `hasNextPage` would make the Browse list
        // append the same section over and over.
        val maxPage = (res as? Map<*, *>)?.get("maxPage")?.toString()?.toIntOrNull()
        // Stash the source's own page count so the host's page navigation bar can show「共 M 页」and
        // clamp the jump input. Only paginated shapes carry `maxPage`; a one-shot `multiPartPage`
        // leaves it null and the bar falls back to「第 N 页」without a total.
        if (maxPage != null && maxPage > 0) lastKnownMaxPage = maxPage
        // `maxPage` only exists for the paginated shapes. `multiPartPage` returns a bare array and
        // `mixed` reports it too, but a one-shot page (`multiPartPage`) must never claim another
        // page: the JS `page` argument is ignored there, so the Browse list would append the same
        // section forever.
        //
        // When both `maxPage` and the actual `page` are known, stop **at** the last page instead of
        // one past it (`page < maxPage`) — Paging otherwise issues one guaranteed-empty request at
        // the end of every listing.
        var hasNextPage = when {
            maxPage == null || maxPage <= 0 -> false
            page > 0 -> page < maxPage
            else -> true
        }

        if (pagingGuardKey != null) {
            val ids = comics.mapNotNull { (it as? Map<*, *>)?.get("id")?.toString()?.takeIf(String::isNotBlank) }
            val previous = lastPageIds[pagingGuardKey]
            // ONLY compare a page against the immediately preceding one. Paging re-requests a page
            // for reasons that are not "the user scrolled further" — a refresh (`getRefreshKey`
            // yields null → page 1 again), a retry after an error, or a re-entry after the listing
            // was evicted. Comparing those against the stale window would see 100% overlap on the
            // FIRST page and wrongly declare a healthy search exhausted. Requiring `page ==
            // previous.page + 1` makes the guard fire only on genuine forward progress.
            if (hasNextPage && previous != null && previous.page == page - 1 && ids.isNotEmpty()) {
                val repeated = ids.count { it in previous.ids }
                if (repeated.toDouble() / ids.size >= PAGING_OVERLAP_RATIO) {
                    // The source handed back (essentially) the page we just consumed: the listing is
                    // exhausted even though it still advertises a `maxPage`. Report the comics we
                    // DID get (they are real — the first page of a repeated series) and stop.
                    JsDebugLog.add(
                        TAG,
                        "paging stall on '$pagingGuardKey' (page $page after ${previous.page}): " +
                            "$repeated/${ids.size} ids repeated -> hasNextPage=false",
                    )
                    hasNextPage = false
                }
            }
            lastPageIds[pagingGuardKey] = PageIds(ids.toSet(), page)
        }

        return MangasPage(comics.map { it.toSManga() }, hasNextPage = hasNextPage)
    }

    /** Ids of one page plus the page number they came from; see [lastPageIds]. */
    private data class PageIds(val ids: Set<String>, val page: Int)

    private fun Any?.flattenComics(): List<Any?> = when (this) {
        is List<*> -> flatMap { it.flattenComics() }
        is Map<*, *> -> {
            // `comics` is the `multiPartPage` / `multiPageComicList` / `search` key; `data` is
            // `mixed`'s — its elements are either plain comics or `{title, comics}` parts, and the
            // recursion below handles both.
            val nested = this["comics"] ?: this["data"]
            if (nested is List<*>) nested.flatMap { it.flattenComics() } else listOf(this)
        }
        else -> emptyList()
    }

    /**
     * Previous page's comic ids, one slot per listing key — the comparison window [parseListing]
     * uses to detect a listing that stopped advancing (see its KDoc for the full post-mortem).
     *
     * A plain [ConcurrentHashMap] of immutable id [Set]s: Paging loads a source's pages
     * sequentially, and even if a future change parallelised them, the worst outcome is a missed
     * (never a wrong) stall detection — which fails safe.
     */
    private val lastPageIds = ConcurrentHashMap<String, PageIds>()

    private fun Any?.toSManga(): SManga = SManga.create().apply {
        val m = this@toSManga as? Map<*, *> ?: return@apply
        url = m["id"]?.toString().orEmpty()
        title = m["title"]?.toString().orEmpty()
        thumbnail_url = m["cover"]?.toString()
        description = m["description"]?.toString()
        genre = (m["tags"] as? List<*>)?.joinToString(", ") { it.toString() }   // SManga.genre is comma-separated
    }

    // --- filters ---------------------------------------------------------------------------------

    /**
     * Builds the Aniyomi `FilterList` the Browse UI renders — a section per group the source itself
     * declares, mirroring Venera's 分类 page.
     *
     * Returning a non-empty list is what makes the standard「筛选」chip appear at all —
     * `BrowseMangaSourceScreen` gates it on `state.filters.isNotEmpty()`, and `state.filters` comes
     * straight from [getFilterList]. Previously this returned an empty list, so the source simply
     * had no filter UI.
     *
     * ### Why every part is exposed, not just `itemType == "category"`
     *
     * The first cut filtered to `itemType == "category"` and consequently lost four of jm's seven
     * groups (主題A漫 / 角色扮演 / 特殊PLAY ×2) — reported as「筛选的类型现在不全…现在少好多」.
     * The `"search"` parts are perfectly usable: their `categories` are **keywords**, served by
     * `search.load(<tag>, options, page)`. Measured live
     * (`ref-quickjs-android/probe_jm_latest_vs_popular.js`): `/search?search_query=無修正&o=mr`
     * and `…=巨乳` both return `total=10000` with 80 items. So the discriminator only decides
     * *which endpoint* a selection hits — never whether to show it.
     *
     * Layout: `Filter.Header` + `Filter.Select` per group. Header renders as a section title, so the
     * sheet reads exactly like Venera's 分类 page (排行 / 每週必看 / 成人A漫 / 主題A漫 / 角色扮演 /
     * 特殊PLAY), with「全部」at index 0 of every group.
     */
    private fun buildFilterList(): FilterList {
        val filters = mutableListOf<Filter<*>>()

        filterMeta.searchOptionList.firstOrNull()?.let { options ->
            filters += Filter.Header(SORT_LABEL)
            filters += JsOptionFilter(SORT_LABEL, options)
        }

        if (filterMeta.enableRanking && filterMeta.rankingOptions.isNotEmpty()) {
            filters += Filter.Header(RANKING_LABEL)
            filters += JsOptionFilter(RANKING_LABEL, listOf("$RANKING_NONE-不启用") + filterMeta.rankingOptions)
        }

        categoryGroups().forEach { (name, parts) ->
            filters += Filter.Header(name)
            filters += JsCategoryFilter(name, listOf(null) + parts)

            // Parts that need SEVERAL option values get one extra Select per group. jm's
            // 「每週必看」is the only such part: it must receive `[週id, 類型]`, fetched by its
            // `optionLoader` (see JsSourceManager.resolveCategoryOptions). A single group is just
            // the global 排序 every listing already gets, so it is skipped to avoid duplicate rows.
            dynamicGroupsFor(parts.first())?.takeIf { it.size >= 2 }?.forEach { group ->
                filters += JsOptionFilter(dynamicFilterName(name, group.label), group.options)
            }
        }

        return FilterList(filters)
    }

    /** The `optionLoader` groups a part declared, keyed by the part's own name. */
    private fun dynamicGroupsFor(part: JsCategoryPart): List<JsOptionGroup>? =
        filterMeta.dynamicOptionGroups[part.group]

    /**
     * The filter name for one of a part's option groups.
     *
     * The group's own label is used verbatim (「時間」/「類型」, as Venera labels them) unless it
     * would collide with the top-level 排序/排行 rows — in which case it is qualified with the
     * part's name. [getSearchManga] reads the value back through this same function, so the two
     * sides can never disagree.
     */
    private fun dynamicFilterName(partGroup: String, label: String): String =
        if (label == SORT_LABEL || label == RANKING_LABEL) "$partGroup · $label" else label

    /**
     * The source's `category.parts`, grouped for display.
     *
     * Parts sharing both a `name` **and** an `itemType` are merged: jm declares「特殊PLAY」twice
     * (群交…騎大車, then CG/重口/獵奇/非H/血腥暴力/站長推薦), which Venera renders as two sections
     * with an identical title. Merging keeps every tag while avoiding two identically-labelled
     * pickers. Grouping on the pair (not the name alone) means two different `itemType`s that
     * happen to share a name stay separate — they are served by different endpoints.
     *
     * Encounter order is preserved (`groupBy` returns a `LinkedHashMap`), so the sheet follows the
     * source's declaration order.
     */
    private fun categoryGroups(): List<Pair<String, List<JsCategoryPart>>> {
        val grouped = filterMeta.categoryParts
            .groupBy { it.group to it.itemType }
            .map { (key, parts) -> key.first to parts }
        // Names must stay unique: Aniyomi keys nothing on the label, but two identical section
        // titles are indistinguishable to the user. Only reachable for name collisions across
        // DIFFERENT itemTypes (same-type collisions were merged above).
        val seen = mutableMapOf<String, Int>()
        return grouped.map { (name, parts) ->
            val n = (seen[name] ?: 0) + 1
            seen[name] = n
            if (n == 1) name to parts else "$name ($n)" to parts
        }
    }

    /** The first (default) sort value declared by the source — jm: `mr` (最新). */
    private fun defaultSortValue(): String? =
        filterMeta.searchOptionList.firstOrNull()?.firstOrNull()?.substringBefore('-')

    /** Reads a named [JsOptionFilter]'s JS-side value. Named (not positional) — there is more than one. */
    private fun FilterList.optionValue(label: String): String? =
        filterIsInstance<JsOptionFilter>().firstOrNull { it.name == label }?.let { it.valueAt(it.state) }

    /**
     * The JS `options` array a category selection should send.
     *
     * Normally that is just `[sort]`. Parts whose `optionLoader` returned **two or more** groups
     * need one value per group instead — jm's「每週必看」reads `options[0]` as the週 id and
     * `options[1]` as the type, so sending `[sort]` alone produced `&type=undefined`.
     *
     * Values come from the per-group Selects ([dynamicFilterName]); a group the user never touched
     * still has `state = 0`, i.e. the source's own first option — which is exactly Venera's default.
     */
    private fun categoryOptionValues(
        category: JsCategoryPart,
        filters: FilterList,
        sort: String,
    ): List<String> {
        val groups = filterMeta.dynamicOptionGroups[category.group]
        if (groups == null || groups.size < 2) return listOf(sort)
        return groups.map { group ->
            filters.optionValue(dynamicFilterName(category.group, group.label)).orEmpty()
        }
    }

    /** The selected ranking option, or null when「不启用」/unsupported. */
    private fun FilterList.selectedRanking(): String? =
        optionValue(RANKING_LABEL)?.takeIf { it != RANKING_NONE }

    /**
     * The first category picked in any group, or null when every group sits at「全部」.
     *
     * Groups are single-choice but nothing stops the user picking in several; the earliest group in
     * declaration order wins, which is at least deterministic.
     */
    private fun FilterList.selectedCategory(): JsCategoryPart? =
        filterIsInstance<JsCategoryFilter>().firstNotNullOfOrNull { it.partAt(it.state) }

    /**
     * A `Select` over the source's raw `"value-text"` option strings, keeping both halves: the UI
     * shows the text, the request needs the value.
     *
     * Used for both「排序」(`search.optionList[0]`) and「排行」(`categoryComics.ranking.options`);
     * callers address them **by name** via [optionValue].
     */
    private class JsOptionFilter(name: String, options: List<String>) :
        Filter.Select<String>(
            name,
            options.map { it.substringAfter('-', it) }.toTypedArray(),
        ) {
        private val optionValues = options.map { it.substringBefore('-') }.toTypedArray()
        fun valueAt(index: Int): String? = optionValues.getOrNull(index)
    }

    /** A `Select` over one group's [JsCategoryPart]s; index 0 is「全部」(null = no category filter). */
    private class JsCategoryFilter(name: String, parts: List<JsCategoryPart?>) :
        Filter.Select<String>(
            name,
            parts.map { it?.category ?: ALL_LABEL }.toTypedArray(),
        ) {
        private val backing = parts.toTypedArray()
        fun partAt(index: Int): JsCategoryPart? = backing.getOrNull(index)
    }

    /**
     * Retired: this used to build the default `search.optionList` values by evaluating QuickJS on
     * every search. The sort value now comes from [defaultSortValue] / [optionValue], which read
     * the metadata [JsSourceManager] reflected **once at load time** — see [filterMeta] for why
     * on-demand evaluation is not acceptable on the paths these are used from.
     *
     * Kept only as a note on what the old `o=undefined` bug was: `jm.js` splices
     * `&o=${options[0]}` into the query, and the host used to hard-code `[]`. Measured live
     * (`ref-quickjs-android/probe_jm_search_order.js`): JM tolerated `o=undefined` and still
     * returned the full result set, so it was never the cause of "search finds nothing" — but it
     * did silently fall back to the server's own ordering instead of Venera's default「最新」.
     */

    // --- image tag helpers ----------------------------------------------------------------------

    private data class ImageTag(val url: String, val comicId: String, val epId: String)

    /**
     * Strict reverse of [getPageList]'s tagging: `…#c=<comicId>&e=<epId>`. Strictness matters —
     * a URL that merely *contains* a `#` for unrelated reasons must fall through to the plain
     * fetch path, not misparse into a bogus context.
     */
    private fun parseImageTag(url: String): ImageTag? {
        val hashIndex = url.lastIndexOf('#')
        if (hashIndex < 0) return null
        val m = TAG_REGEX.matchEntire(url.substring(hashIndex + 1)) ?: return null
        return ImageTag(
            url = url.substring(0, hashIndex),
            comicId = m.groupValues[1],
            epId = m.groupValues[2],
        )
    }

    companion object {
        private const val TAG = "JsMangaSource"

        /** Matches the fragment [getPageList] appends; `matchEntire` keeps [parseImageTag] strict. */
        private val TAG_REGEX = Regex("c=([^&]*)&e=(.+)")

        /**
         * Retired with the S18 pairs rework: `__plainValue` now delivers JS `Map`s as ordered
         * `[key, value]` pair lists (see [getChapterList]), so there is no guard prefix to strip
         * any more. History for future readers: this guard was introduced (S15b) to protect a
         * Map→object conversion from ECMAScript's integer-key reordering, was `"\u0000"` — which
         * JNI's modified UTF-8 treats as a C-string terminator, truncating every guarded key to
         * `""` and collapsing all chapters into one blank entry (「共 1 章」) — then `"\u200b"`,
         * which fixed the count but NOT the order (object keys reach Kotlin through a
         * java.util.HashMap that iterates in hash order). The pairs list removes the entire
         * problem class; see init.js's Map branch for the full post-mortem.
         */
        const val ORDER_GUARD = "\u200b"

        /** How long a successful `comic.loadInfo` may be shared between back-to-back host calls. */
        private const val LOAD_INFO_TTL_MS = 45_000L

        /** Filter labels. Referenced by lookup, so they must stay stable. */
        private const val SORT_LABEL = "排序"
        private const val RANKING_LABEL = "排行"

        /**「全部」of a category group: picked but means "no category". */
        private const val ALL_LABEL = "全部"

        /** Ranking's「不启用」sentinel value (never sent to the source). */
        private const val RANKING_NONE = "__none__"

        /**
         * Fraction of a page's comic ids that may also appear in the previous page before the
         * listing is declared exhausted. High on purpose — see [parseListing]'s KDoc.
         */
        private const val PAGING_OVERLAP_RATIO = 0.9

        /** Stable Long id derived from the Venera `key` (mirrors `HttpSource.generateId`). */
        fun keyToId(key: String): Long {
            val md5 = MessageDigest.getInstance("MD5").digest(key.toByteArray())
            var v = 0L
            for (i in 0 until 8) v = (v shl 8) or (md5[i].toLong() and 0xFF)
            return v
        }
    }
}

/** Minimal JS string literal escaping, so we can inject Kotlin strings into evaluated snippets. */
private fun String.jsQuote(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "") + "\""
