package eu.kanade.tachiyomi.source.manga.js

/**
 * Kotlin mirror of Venera's per-source settings contract.
 *
 * A Venera source declares its configuration UI **in JavaScript**:
 *
 * ```javascript
 * class CopyManga extends ComicSource {
 *     settings = {
 *         sortBy: {
 *             title: "收藏排序方式",
 *             type: "select",
 *             options: [ { value: 'update', text: '更新时间' }, ... ],
 *             default: 'update',
 *         },
 *         apiUrl: { title: "API地址", type: "input", validator: "^https?://.*", default: "" },
 *         clearDevice: { title: "清除设备信息", type: "callback", buttonText: "点击清除设备信息",
 *                        callback: async () => { ... } },
 *     }
 * }
 * ```
 *
 * We reflect over that object once per source (see [JsSourceManager.refreshMeta]) and render it
 * natively. Reading a value always goes through the documented fallback chain
 * `saved value → declared default`; writing is done by us (Venera deliberately ships no JS
 * write API for settings, and its `save_data` explicitly rejects the key `"setting"`).
 *
 * See `venera/doc/comic_source.md` §Settings for the upstream spec.
 */
sealed interface JsSettingItem {

    /** The `settings` object key; the unit of persistence and the argument to `loadSetting`. */
    val key: String

    /** Human-readable label; falls back to [key] when the source declares none. */
    val title: String

    /**
     * Dropdown (`type: "select"`).
     *
     * The **`value`** of the chosen option is what gets persisted and what `loadSetting` returns;
     * `text` is display-only. Values are matched back to options when rendering.
     */
    data class Select(
        override val key: String,
        override val title: String,
        val options: List<Option>,
        val defaultValue: String?,
    ) : JsSettingItem {
        data class Option(val value: String, val text: String)

        /** Maps a stored/raw value to the label to display, falling back to the raw value. */
        fun labelFor(raw: Any?): String {
            val v = raw?.toString() ?: return options.firstOrNull { it.value == defaultValue }?.text ?: ""
            return options.firstOrNull { it.value == v }?.text ?: v
        }
    }

    /** Boolean toggle (`type: "switch"`). */
    data class Switch(
        override val key: String,
        override val title: String,
        val defaultValue: Boolean,
    ) : JsSettingItem

    /** Free-text value (`type: "input"`), edited through a dialog. */
    data class Input(
        override val key: String,
        override val title: String,
        val defaultValue: String,
        /** Raw regex string from the source, compiled only when the user submits. */
        val validator: String?,
    ) : JsSettingItem

    /** Action button (`type: "callback"`); runs the source's JS function with no arguments. */
    data class Callback(
        override val key: String,
        override val title: String,
        val buttonText: String,
    ) : JsSettingItem
}

/**
 * How a source exposes login, mirroring Venera's `account` object.
 *
 * The three modes are evaluated in the same precedence order as Venera's parser: `login` wins over
 * `loginWithWebview`, which wins over `loginWithCookies`.
 */
sealed interface JsAccountMode {

    /** `account.login(account, pwd)` — a username/password form. */
    data object Password : JsAccountMode

    /** `account.loginWithWebview` — open a web page and watch for a success signal. */
    data class Webview(val url: String) : JsAccountMode

    /** `account.loginWithCookies` — one text field per declared cookie name. */
    data class Cookies(val fields: List<String>) : JsAccountMode
}

/**
 * One entry of a Venera source's `explore` array, reduced to what the host needs to call it.
 *
 * ### ⚠️ The three types are **not** interchangeable — each has its own calling convention
 *
 * Taken from Venera's own parser (`venera/lib/foundation/comic_source/parser.dart`):
 *
 * | `type` | Venera calls | page base | returns | paginated |
 * |---|---|---|---|---|
 * | `"multiPartPage"`     | `load()`       | —          | `[{title, comics, viewMore}]` | **no** |
 * | `"multiPageComicList"`| `load(page)`   | **1-based**| `{comics, maxPage}`           | yes |
 * | `"mixed"`             | `load(index)`  | **0-based**| `{data: [...], maxPage}`      | yes |
 *
 * The host used to call `explore[0].load(page - 1)` for all three, so a source declaring
 * `multiPageComicList` — i.e. exactly the "分页" kind — had every page request off by one.
 *
 * @param index position in the source's `explore` array (the JS expression is built from it).
 * @param title the entry's `title` (unused by the UI for now; kept for diagnostics).
 * @param type one of `multiPartPage` / `multiPageComicList` / `mixed`.
 */
data class JsExploreEntry(
    val index: Int,
    val title: String,
    val type: String,
) {
    /** Whether the `page` argument is meaningful for this type. */
    val isPaginated: Boolean get() = type == "multiPageComicList" || type == "mixed"
}

/**
 * One option group returned by a source's `categoryComics.optionLoader`.
 *
 * Most groups are a plain「排序」list, but some parts need **more than one** value before their
 * `load` can run. jm's「每週必看」is the canonical case: `optionLoader` returns **two** groups —
 * 時間 (fetched live from `GET /week`, e.g. `259-2026第258期09.25 - 09.18`) and 類型
 * (`manga-日漫` / `hanman-韓漫` / `another-其他`) — and its `load` reads `options[0]` as the週 id
 * and `options[1]` as the type. Supplying only one value sends `&type=undefined` to the server.
 *
 * @param label the group's own `label` (「時間」/「類型」), used as the filter's display name.
 * @param options raw `"value-text"` strings exactly as the source declares them, so [JsMangaSource]
 *                can show the text and send the value (see its `JsOptionFilter`).
 */
data class JsOptionGroup(val label: String, val options: List<String>)

/**
 * One selectable category of a Venera source's `category.parts`.
 *
 * @param group the part's `name` (e.g.「成人A漫」) — used as the filter's section label.
 * @param itemType `"category"` → `categoryComics.load`; `"search"` → `search.load`.
 * @param category the visible category name (e.g.「同人」).
 * @param param the part's `categoryParams[i]`, used as `categoryComics.load`'s `param`;
 *              null when the part declares none (the source then falls back to the category name).
 */
data class JsCategoryPart(
    val group: String,
    val itemType: String,
    val category: String,
    val param: String?,
)

/** Everything the configuration UI needs to know about a single JS source. */
data class JsSourceMeta(
    val settings: List<JsSettingItem> = emptyList(),
    val accountMode: JsAccountMode? = null,
    /** `account.registerWebsite`, surfaced as a "注册账号" action when present. */
    val registerWebsite: String? = null,
    /**
     * The source's own `translation` table, i.e. `{ "zh_CN": { "Refresh Domain List": "刷新域名列表" } }`.
     *
     * Sources declare their settings in English and translate them here, so a faithful port **must**
     * apply this table — otherwise the page shows `Refresh Domain List` where Venera shows
     * `刷新域名列表`. Kept on the meta (rather than applied eagerly) so switching app locale can
     * re-render without re-evaluating JS.
     */
    val translations: Map<String, Map<String, String>> = emptyMap(),
    /**
     * The source's `search.optionList` — one entry per option group, each holding the raw
     * `"value-text"` strings Venera declares (see [JsSourceManager.parseSearchOptions]).
     *
     * ⚠️ Read **only** to build the filter UI / request parameters. `[JsMangaSource]` needs the
     * *value* half (left of the first `-`); the *text* half is the localised label.
     */
    val searchOptionList: List<List<String>> = emptyList(),
    /**
     * The source's `category.parts`, flattened into `(groupName, itemType, category, param)` rows.
     *
     * `itemType` is Venera's discriminator: `"category"` rows are served by
     * `categoryComics.load(cat, param, ...)`, `"search"` rows by `search.load(keyword, ...)`.
     * `param` comes from the part's `categoryParams` (parallel array) and may be null.
     */
    val categoryParts: List<JsCategoryPart> = emptyList(),
    /** `category.enableRankingPage` — whether the source offers a separate ranking listing. */
    val enableRanking: Boolean = false,
    /**
     * `categoryComics.ranking.options` — raw `"value-text"` strings (jm:
     * `mv-總排行` / `mv_m-月排行` / `mv_w-周排行` / `mv_t-日排行`).
     */
    val rankingOptions: List<String> = emptyList(),
    /** The source's `explore` array, with each entry's calling convention — see [JsExploreEntry]. */
    val exploreEntries: List<JsExploreEntry> = emptyList(),
    /**
     * `category.parts[*].name` → the option groups its `optionLoader` returned.
     *
     * **Filled in asynchronously**, after `init()` has run (the loader hits `baseUrl`, which some
     * sources only construct there) — see `JsSourceManager.resolveCategoryOptions`. Empty until
     * then, which simply means the part renders without its extra selects.
     *
     * Only parts that return **two or more** groups are interesting: one group is the global
     * 排序 every listing already gets, while two means the part genuinely needs several values.
     */
    val dynamicOptionGroups: Map<String, List<JsOptionGroup>> = emptyMap(),
) {
    val hasAccount: Boolean get() = accountMode != null

    /**
     * Resolves a source-declared string through its own translation table, mirroring Venera's
     * `String.ts(sourceKey)`: try the full locale tag (`zh_CN`), then the bare language (`zh`),
     * then fall back to the original string.
     */
    fun translate(raw: String, locale: String): String {
        if (translations.isEmpty()) return raw
        val language = locale.substringBefore('_').substringBefore('-')
        return translations[locale]?.get(raw)
            ?: translations[language]?.get(raw)
            ?: raw
    }
}
