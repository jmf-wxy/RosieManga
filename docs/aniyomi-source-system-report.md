# Aniyomi 源码/扩展系统接线调查报告（基于 main 分支，只读调研）

> 目标：为在 aniyomi fork 中新增"JS 漫画源"（与现有 Kotlin 扩展源并行）定位源码/扩展系统的接线点。
> 所有路径均来自 `github.com/aniyomiorg/aniyomi` 的 `main` 分支（通过 GitHub API / raw 读取，未做任何修改）。

---

## 0. 重要前提修正（用户问题里的假设需纠正）

- **没有 `Source` 接口**。旧 Tachiyomi 的 `Source` 在 Aniyomi 中已按媒介拆分为两个基接口：漫画是 `MangaSource`，动画是 `AnimeSource`。
- **没有 `ExternalSource`**。`source-api` 里与之最接近的只有：
- `ResolvableSource`（`MangaSource` 子接口，用于按 URI 深链解析出 manga/chapter）；
- `UnmeteredSource`（标记接口，表示不走计量网络的源）。
- **漫画与动画是两套完全平行的接口/管理器**：`MangaSource`↔`AnimeSource`、`CatalogueSource`↔`AnimeCatalogueSource`、`MangaExtensionManager`↔`AnimeExtensionManager`、`MangaSourceManager`↔`AnimeSourceManager`、`ui/browse/manga`↔`ui/browse/anime`。你主要做漫画，重点关注 `Manga*` 一侧即可，但结构上需要镜像一份 `Anime*`。
- **`source-api` 已迁移为 Kotlin Multiplatform**，源码不在 `src/main/java` 而在：
- `source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/...`（跨平台公共代码，接口/模型在这里）
- `source-api/src/androidMain/kotlin/eu/kanade/tachiyomi/...`（仅 Android 平台代码）

---

## 1. Source 抽象层（`source-api` 模块）

包根：`eu.kanade.tachiyomi.source`（漫画）/ `eu.kanade.tachiyomi.animesource`（动画）。

### 1.1 漫画基接口 `MangaSource`

文件：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/MangaSource.kt`

```
interface MangaSource {
    val id: Long
    val name: String
    val lang: String            // get() = ""（默认空，CatalogueSource 会强制要求）

    // ===== 现代 suspend API（UI / 仓库层真正调用的）=====
    suspend fun getMangaDetails(manga: SManga): SManga
    suspend fun getChapterList(manga: SManga): List<SChapter>
    suspend fun getPageList(chapter: SChapter): List<Page>

    // ===== 已废弃的 RxJava API（默认实现直接抛异常，可忽略）=====
    @Deprecated("Use the non-RxJava API instead")
    fun fetchMangaDetails(manga: SManga): Observable<SManga> = throw IllegalStateException("Not used")
    @Deprecated("Use the non-RxJava API instead")
    fun fetchChapterList(manga: SManga): Observable<List<SChapter>> = throw IllegalStateException("Not used")
    @Deprecated("Use the non-RxJava API instead")
    fun fetchPageList(chapter: SChapter): Observable<List<Page>> = throw IllegalStateException("Not used")
}
```

### 1.2 可浏览源 `CatalogueSource`（JS 源最应该实现的接口）

文件：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/CatalogueSource.kt`

```
interface CatalogueSource : MangaSource {
    override val lang: String
    val supportsLatest: Boolean

    suspend fun getPopularManga(page: Int): MangasPage
    suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage
    suspend fun getLatestUpdates(page: Int): MangasPage
    fun getFilterList(): FilterList

    @Deprecated("Use the non-RxJava API instead")
    fun fetchPopularManga(page: Int): Observable<MangasPage> = throw IllegalStateException("Not used")
    @Deprecated("Use the non-RxJava API instead")
    fun fetchSearchManga(page: Int, query: String, filters: FilterList): Observable<MangasPage> = throw IllegalStateException("Not used")
    @Deprecated("Use the non-RxJava API instead")
    fun fetchLatestUpdates(page: Int): Observable<MangasPage> = throw IllegalStateException("Not used")
}
```

> 说明：浏览/全局搜索/图书馆只认 `CatalogueSource`。只要一个对象 `is CatalogueSource`，它就会出现在 Browse 源列表、GlobalSearch、以及被 `GetRemoteManga` 调用。`fetchXxx`（Rx）默认抛异常无所谓，UI 走的是 suspend 的 `getXxx`。

### 1.3 可配置源 `ConfigurableSource`（可选，用于源内设置项）

文件：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/ConfigurableSource.kt`

```
interface ConfigurableSource : MangaSource {
    fun getSourcePreferences(): SharedPreferences   // = Injekt.get<Application>().getSharedPreferences("source_$id", ...)
    fun setupPreferenceScreen(screen: PreferenceScreen)
}
```

### 1.4 HTTP 源抽象 `HttpSource`（OkHttp 实现，JS 源可"借用"其网络）

文件：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/HttpSource.kt`

```
abstract class HttpSource : CatalogueSource {
    protected val network: NetworkHelper by injectLazy()      // 共享网络层（见第 4 节）
    abstract val baseUrl: String
    open val versionId = 1
    override val id by lazy { generateId(name, lang, versionId) }   // MD5(name/lang/ver) 生成稳定 id
    val headers: Headers by lazy { headersBuilder().build() }
    open val client: OkHttpClient get() = network.client      // 复用全局共享 OkHttp client

    // 图片下载相关（注意：这些不在 CatalogueSource 里，而是 HttpSource 额外提供的）
    open suspend fun getImage(page: Page): Response { return client.newCachelessCallWithProgress(imageRequest(page), page).awaitSuccess() }
    open suspend fun getImageUrl(page: Page): String { ... }
    protected open fun imageRequest(page: Page): Request { return GET(page.imageUrl!!, headers) }
    open fun getMangaUrl(manga: SManga): String { ... }
    open fun getChapterUrl(chapter: SChapter): String { ... }
    open fun prepareNewChapter(chapter: SChapter, manga: SManga) {}
}
```

- `source-api/.../source/online/ParsedHttpSource.kt`：`HttpSource` 的 Jsoup 子类，把 `popularMangaParse` 等拆成 `popularMangaSelector()`/`popularMangaFromElement()` 等选择器方法（JS 源一般不用它，除非你想用 HTML 解析）。
- `source-api/.../source/online/ResolvableSource.kt`：如果你要让 JS 源支持"打开一个链接跳转到某漫画/章节"，实现它（`getUriType`/`getManga`/`getChapter`）。

### 1.5 工厂 `SourceFactory`

文件：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/SourceFactory.kt`

```
interface SourceFactory {
    fun createSources(): List<MangaSource>
}
```

> 扩展 APK 里若主类实现 `SourceFactory` 而非直接 `MangaSource`，加载器会调用 `createSources()` 产出多个源。

### 1.6 漫画数据模型（`source-api/.../source/model/`）

- `SManga.kt`：`interface SManga`（`url, title, artist, author, description, genre, status: Int, thumbnail_url, update_strategy, initialized`）。用 `SManga.create()` 拿到 `SMangaImpl`。
- `SChapter.kt`：`interface SChapter`（`url, name, date_upload, chapter_number, scanlator`）。
- `Page.kt`：`open class Page(index, url, imageUrl, uri)`，带 `State`（QUEUE/LOAD_PAGE/DOWNLOAD_IMAGE/READY/ERROR）。
- `MangasPage.kt`：`data class MangasPage(val mangas: List<SManga>, val hasNextPage: Boolean)`。
- `Filter.kt` / `FilterList.kt`：搜索过滤器类型（`Filter.Text`, `Filter.CheckBox`, `Filter.TriState`, `Filter.Group`, `Filter.Select` 等），`getFilterList()` 返回 `FilterList()`。

### 1.7 动画侧对应接口（平行，仅列出差异）

- `source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/animesource/AnimeSource.kt`：`getPopularAnime`/`getLatestUpdates`/`getSearchAnime`/`getAnimeEpisodeUpdate`/`getAnimeSeasonUpdate`/`getHosterList`/`getVideoList`（**返回 `SAnime`/`SEpisode`/`Video`/`Hoster`**，与漫画模型不互通）。
- 平行文件：`AnimeCatalogueSource.kt`、`ConfigurableAnimeSource.kt`、`AnimeSourceFactory.kt`、`online/AnimeHttpSource.kt`、`online/ParsedAnimeHttpSource.kt`、`online/ResolvableAnimeSource.kt`。

---

## 2. 扩展加载与注册（运行时发现 + 注册点）

### 2.1 扩展管理器 `MangaExtensionManager`

文件：`app/src/main/java/eu/kanade/tachiyomi/extension/manga/MangaExtensionManager.kt`

- 通过 `Injekt` 注入：`class MangaExtensionManager(context, preferences: SourcePreferences, trustExtension: TrustMangaExtension)`。
- 持有三个 `StateFlow`：`installedExtensionsFlow`、`availableExtensionsFlow`、`untrustedExtensionsFlow`（类型为 `MangaExtension.Installed` / `.Available` / `.Untrusted`）。
- 每个 `MangaExtension.Installed` 含 `sources: List<MangaSource>`（即该扩展包里所有源实例）。
- `initExtensions()` 调 `MangaExtensionLoader.loadMangaExtensions(context)` 把扫描到的扩展填入 `installedExtensionsFlow`。
- 提供 `getSourceData(id): StubMangaSource?`、`getExtensionPackage(sourceId)`、`getAppIconForSource(sourceId)`。

### 2.2 扩展加载器 `MangaExtensionLoader`（运行时实例化源的核心）

文件：`app/src/main/java/eu/kanade/tachiyomi/extension/manga/util/MangaExtensionLoader.kt`

关键点（直接从源码提取）：

```
internal object MangaExtensionLoader {
    fun loadMangaExtensions(context: Context): List<MangaLoadResult> {
        // 1) 扫描已安装包（共享扩展）与私有扩展目录（.apk）中声明了扩展 feature 的包
        // 2) 对每个包并发 loadMangaExtension(...)
    }

    // 单个扩展加载（核心）：用 ChildFirstPathClassLoader 从 APK 的 sourceDir 加载类，并实例化源
    // classLoader = ChildFirstPathClassLoader(appInfo.sourceDir, null, context.classLoader)
    // 读取 manifest 里 METADATA_SOURCE_CLASS（分号分隔的类名列表），逐个：
    when (val obj = Class.forName(it, false, classLoader).getDeclaredConstructor().newInstance()) {
        is MangaSource   -> listOf(obj)
        is SourceFactory -> obj.createSources()      // 工厂产出多个源
        else -> throw Exception("Unknown source class type: ${obj.javaClass}")
    }
    // 失败回退：PathClassLoader(appInfo.sourceDir, null, context.classLoader)

    // 最终组装：
    val extension = MangaExtension.Installed(
        name = extName, pkgName = pkgName, versionName = ..., versionCode = ...,
        libVersion = ..., lang = ..., isNsfw = ...,
        sources = sources,                       // <-- 这里把 MangaSource 实例塞进扩展
        pkgFactory = ..., icon = ..., isShared = ...,
    )
}
```

> 结论：**现有"扩展源"是 APK 形式、用 `ChildFirstPathClassLoader` 加载、通过 `SourceFactory.createSources()` 或单 `MangaSource` 实例化的**。JS 源不需要这套 APK 机制——它可以作为普通 Kotlin 对象直接构造（见第 5 节）。

### 2.3 源注册表 `MangaSourceManager`（→ `AndroidMangaSourceManager`）★ 这是"单一注册点"

接口：`domain/src/main/java/tachiyomi/domain/source/manga/service/MangaSourceManager.kt`

```
interface MangaSourceManager {
    val isInitialized: StateFlow<Boolean>
    val catalogueSources: Flow<List<CatalogueSource>>
    fun get(sourceKey: Long): MangaSource?
    fun getOrStub(sourceKey: Long): MangaSource
    fun getOnlineSources(): List<HttpSource>             // 注意：只返回 HttpSource
    fun getCatalogueSources(): List<CatalogueSource>
    fun getStubSources(): List<StubMangaSource>
}
```

实现：`app/src/main/java/eu/kanade/tachiyomi/source/manga/AndroidMangaSourceManager.kt`

```
class AndroidMangaSourceManager(
    private val context: Context,
    private val extensionManager: MangaExtensionManager,
    private val sourceRepository: MangaStubSourceRepository,
) : MangaSourceManager {

    private val sourcesMapFlow = MutableStateFlow(ConcurrentHashMap<Long, MangaSource>())

    override val catalogueSources: Flow<List<CatalogueSource>> =
        sourcesMapFlow.map { it.values.filterIsInstance<CatalogueSource>() }

    init {
        scope.launch {
            extensionManager.installedExtensionsFlow
                .collectLatest { extensions ->
                    val mutableMap = ConcurrentHashMap<Long, MangaSource>(
                        mapOf(
                            LocalMangaSource.ID to LocalMangaSource(context, Injekt.get(), Injekt.get()),
                        ),
                    )
                    extensions.forEach { extension ->
                        extension.sources.forEach {
                            mutableMap[it.id] = it                 // ★ 所有扩展源在此注册
                            registerStubSource(StubMangaSource.from(it))
                        }
                    }
                    sourcesMapFlow.value = mutableMap            // ★ 切换为新的源表
                    _isInitialized.value = true
                }
        }
    }

    override fun get(sourceKey: Long) = sourcesMapFlow.value[sourceKey]
    override fun getOrStub(sourceKey: Long) = sourcesMapFlow.value[sourceKey] ?: ...
    override fun getOnlineSources() = sourcesMapFlow.value.values.filterIsInstance<HttpSource>()
    override fun getCatalogueSources() = sourcesMapFlow.value.values.filterIsInstance<CatalogueSource>()
}
```

> **这就是你要找的"单一注册点"**：往 `sourcesMapFlow`（一个 `ConcurrentHashMap<Long, MangaSource>`）里 `put(id, sourceInstance)`，该源就会立刻出现在 Browse 源列表、GlobalSearch、图书馆来源选择里。`catalogueSources` 只是它的 `CatalogueSource` 过滤视图。

### 2.4 仓库接口（数据层对源的调用契约）

接口：`domain/src/main/java/tachiyomi/domain/source/manga/repository/MangaSourceRepository.kt`

```
typealias SourcePagingSourceType = PagingSource<Long, SManga>

interface MangaSourceRepository {
    fun getMangaSources(): Flow<List<Source>>
    fun getOnlineMangaSources(): Flow<List<Source>>
    fun getMangaSourcesWithFavoriteCount(): Flow<List<Pair<Source, Long>>>
    fun searchManga(sourceId: Long, query: String, filterList: FilterList): SourcePagingSourceType
    fun getPopularManga(sourceId: Long): SourcePagingSourceType
    fun getLatestManga(sourceId: Long): SourcePagingSourceType
}
```

---

## 3. Browse / GlobalSearch 如何消费源列表并调用 fetch 方法

### 3.1 源列表（Browse 的"Sources"标签页）

- `app/src/main/java/eu/kanade/tachiyomi/ui/browse/manga/source/MangaSourcesScreenModel.kt`
- 通过 `GetEnabledMangaSources`（domain interactor）`subscribe()` 得到 `List<Source>`（domain 层的轻量源描述模型），按 `lang`/`PINNED`/`LAST_USED` 分组展示。
- `GetEnabledMangaSources` 的数据源头就是 `MangaSourceManager.catalogueSources`（过滤掉被禁用的）。

### 3.2 打开某个源后的浏览/翻页（★ fetch 方法实际调用处）

- `app/src/main/java/eu/kanade/tachiyomi/ui/browse/manga/source/browse/BrowseMangaSourceScreenModel.kt`

```
val source = sourceManager.getOrStub(sourceId)        // 从 MangaSourceManager 取源实例

init {
    if (source is CatalogueSource) {                  // ★ 只认 CatalogueSource
        ... source.getFilterList() ...
    }
}
// 翻页由 Paging 驱动：
val mangaPagerFlowFlow = state.map { it.listing }.map { listing ->
    Pager(PagingConfig(pageSize = 25)) {
        getRemoteManga.subscribe(sourceId, listing.query ?: "", listing.filters)
    }.flow...
}
```

- `domain/src/main/java/tachiyomi/domain/source/manga/interactor/GetRemoteManga.kt`

```
class GetRemoteManga(private val repository: MangaSourceRepository) {
    fun subscribe(sourceId: Long, query: String, filterList: FilterList): SourcePagingSourceType =
        when (query) {
            QUERY_POPULAR -> repository.getPopularManga(sourceId)
            QUERY_LATEST  -> repository.getLatestManga(sourceId)
            else          -> repository.searchManga(sourceId, query, filterList)
        }
}
```

> 真正的 `source.getPopularManga(page)` / `getSearchManga(...)` / `getLatestUpdates(page)` 调用发生在 `MangaSourceRepository` 的实现类（PagingSource，位于 `:app`/`:data`，内部 `sourceManager.get(sourceId) as CatalogueSource` 后调用 suspend 方法）。**只要你的 JS 源实例进了 `MangaSourceManager` 且 `is CatalogueSource`，这一整条链路对它完全透明。**

### 3.3 全局搜索 GlobalSearch

- 目录：`app/src/main/java/eu/kanade/tachiyomi/ui/browse/manga/source/globalsearch/`
- 同样从 `MangaSourceManager.catalogueSources` 取所有 `CatalogueSource`，逐个调 `source.getSearchManga(...)`。

### 3.4 漫画/动画严格分离

- 动画走 `ui/browse/anime`、`extension/anime`、`source/anime`、`animesource`，以及 `AnimeSourceManager`。做 JS 漫画源时**不需要动动画侧**，但建议保持同样的"镜像"结构以便将来复用 JS 引擎。

---

## 4. 网络层：源是否自包含？

共享网络层文件：`core/common/src/main/java/eu/kanade/tachiyomi/network/NetworkHelper.kt`（`core/common` 是跨 `:app`/`:source-api` 共享的核心模块）

```
class NetworkHelper(private val context: Context, private val preferences: NetworkPreferences) {
    val cookieJar = AndroidCookieJar()
    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .cache(Cache(File(context.cacheDir, "network_cache"), 5L * 1024 * 1024))
        .addInterceptor(UncaughtExceptionInterceptor())
        .addInterceptor(UserAgentInterceptor(::defaultUserAgentProvider))
        // 可选 DoH、CloudflareInterceptor 等
        .build()
    fun defaultUserAgentProvider() = preferences.defaultUserAgent().get().trim()
}
```

结论（直接回答用户第 4 问）：

- **源不是完全自包含的**。`HttpSource` 通过 `protected val network: NetworkHelper by injectLazy()` 拿到**全局共享**的 `OkHttpClient`（`client = network.client`）、`headers`、`cookieJar`、`UserAgent`。
- 因此，一个 JS 支持的源**可以直接复用同一个 `NetworkHelper`**（`Injekt.get<NetworkHelper>()` 或 `injectLazy()`）来做 HTTP 请求，自动获得 Cookie 管理、User-Agent、Cloudflare/DoH 等能力——与 Kotlin `HttpSource` 行为一致。
- 配套的扩展函数（`GET`/`POST`、`asObservableSuccess`、`awaitSuccess`、`newCachelessCallWithProgress` 等）都在 `eu.kanade.tachiyomi.network` 包里，JS 引擎的宿主代码可直接使用。

---

## 5. 最干净的扩展点（设计建议）

**一句话：新建一个实现 `CatalogueSource`（它已继承 `MangaSource`）的漫画源类型，把它作为普通 Kotlin 实例塞进 `AndroidMangaSourceManager.sourcesMapFlow`。** 这样它会被 Browse / GlobalSearch / 图书馆当作与 Kotlin `CatalogueSource` 完全同等的源处理。

### 5.1 推荐的最小接口实现

你的 JS 漫画源类应至少实现（`source-api/.../source/CatalogueSource.kt` + `MangaSource.kt`）：

```
// 建议放在 app 或新建 :js-source 模块
class JsMangaSource(
    override val id: Long,            // 自己用稳定算法生成（参考 HttpSource.generateId）
    override val name: String,
    override val lang: String,
    override val supportsLatest: Boolean,
    private val engine: JsEngine,     // 你引入的 JS 运行时（Rhino / QuickJS / V8 等）
) : CatalogueSource {

    override suspend fun getPopularManga(page: Int): MangasPage =
        engine.invoke("getPopularManga", page)            // JS 回调返回 MangasPage 结构
    override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage = ...
    override suspend fun getLatestUpdates(page: Int): MangasPage = ...
    override fun getFilterList(): FilterList = ...
    override suspend fun getMangaDetails(manga: SManga): SManga = ...
    override suspend fun getChapterList(manga: SManga): List<SChapter> = ...
    override suspend fun getPageList(chapter: SChapter): List<Page> = ...
}
```

> 若需要源内设置项，再 `implement ConfigurableSource`；若需要深链打开，再 `implement ResolvableSource`。

### 5.2 让 JS 源"表现得像在线源"（重要坑点）

- `MangaSourceManager.getOnlineSources()` 当前是 `filterIsInstance<HttpSource>()`，且**图片下载/阅读器代码通常会判断 `source is HttpSource` 来调 `source.getImage(page)`/`getImageUrl(page)`**（这些方法只在 `HttpSource` 上定义，不在 `CatalogueSource` 上）。
- 你的 `JsMangaSource` 若只实现 `CatalogueSource` 而不继承 `HttpSource`，会出现：
- 不会出现在"在线源"相关逻辑（下载、incognito 等按 `getOnlineSources()` 过滤的地方）；
- 阅读器拿页面图片时缺少 `getImage` 方法。
- **推荐做法（比强行继承 HttpSource 更干净）**：

1. 定义标记接口 `interface JsMangaSource : CatalogueSource`（或一个公共基类 `BaseJsMangaSource : CatalogueSource`）；
2. 在该基类里**自己实现图片获取**，复用 `NetworkHelper.client`（照搬 `HttpSource.getImage`/`imageRequest`/`imageUrlRequest` 的逻辑，因为这些只是对 `network.client` 的封装，并不依赖 HttpSource 的其他抽象方法）；
3. 把仓库/阅读器/下载器里 `source is HttpSource` 的判断改为 `source is HttpSource || source is JsMangaSource`（或抽一个 `interface OnlineMangaSource : CatalogueSource` 同时被 `HttpSource` 和 `JsMangaSource` 实现，再让 `getOnlineSources()` 与阅读器按 `OnlineMangaSource` 过滤）。

### 5.3 注册方式（并行于 Kotlin 扩展，无需 APK）

- **不改 `MangaExtensionLoader`**（那是 APK 扩展机制）。新增一个 `JsMangaSourceManager` / `JsMangaExtensionManager`，在初始化时构造你的 JS 源实例列表，并让 `AndroidMangaSourceManager` 除了观察 `extensionManager.installedExtensionsFlow` 外，也把 JS 源合并进 `sourcesMapFlow`（或：让 `JsMangaSourceManager` 直接 `put` 到同一个 `sourcesMapFlow`，因为 `AndroidMangaSourceManager` 是 `MangaSourceManager` 的唯一实现，且 `sourcesMapFlow` 是它内部的可变状态）。
- 最简落地：在 `AndroidMangaSourceManager.init` 的 `collectLatest` 里，除了 `LocalMangaSource` 和扩展源，再 `jsSources.forEach { mutableMap[it.id] = it }`。这样 JS 源与 Kotlin 源出现在同一个 `catalogueSources` 流里，UI 零改动。

---

## 6. 实现该功能时要新建/修改的关键文件清单

新建：

- `app/src/main/java/eu/kanade/tachiyomi/source/manga/JsMangaSource.kt`（或新模块 `:js-manga-source`）：实现 `CatalogueSource` + 图片获取 + 可选 `ConfigurableSource`/`ResolvableSource` 的基类。
- JS 引擎集成（新增依赖/模块，如 Rhino、QuickJS、Duktape；或复用 `core/common` 的网络层做宿主调用）。
- `app/src/main/java/eu/kanade/tachiyomi/extension/manga/JsMangaSourceManager.kt`：加载/构造 JS 源实例并喂给注册表。

修改：

- `app/src/main/java/eu/kanade/tachiyomi/source/manga/AndroidMangaSourceManager.kt`：在 `init`/`sourcesMapFlow` 中合并 JS 源；将 `getOnlineSources()` 的 `filterIsInstance<HttpSource>()` 扩展为也接受 JS 在线源。
- 阅读器/下载器里所有 `source is HttpSource` 判断（图片获取路径）：改为 `source is HttpSource || source is JsMangaSource`，或直接按新的 `OnlineMangaSource` 标记接口判断（建议 grep `is HttpSource` / `HttpSource` 在 `:app` 中的用法）。
- （可选）`domain/.../source/manga/service/MangaSourceManager.kt`：若想让 `getOnlineSources()` 返回类型更通用，可引入 `OnlineMangaSource` 标记接口。

无需修改（对 JS 源透明）：

- `source-api` 的全部接口（`MangaSource`/`CatalogueSource`/`ConfigurableSource`/`SourceFactory`/`ResolvableSource`/`model/*`）——JS 源直接实现它们即可。
- `ui/browse/manga/*`（Browse/GlobalSearch 屏幕）、`GetRemoteManga`、`MangaSourceRepository`——只要实例进了 `MangaSourceManager` 且 `is CatalogueSource` 就自动接通。

---

## 附：本次调研实测的关键路径（main）

- source-api（KMP）：`source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/{MangaSource,CatalogueSource,ConfigurableSource,SourceFactory,UnmeteredSource}.kt`、`source/online/{HttpSource,ParsedHttpSource,ResolvableSource}.kt`、`source/model/{SManga,SChapter,Page,MangasPage,Filter,FilterList}.kt`、`animesource/*`
- 加载/注册：`app/src/main/java/eu/kanade/tachiyomi/extension/manga/MangaExtensionManager.kt`、`extension/manga/util/MangaExtensionLoader.kt`、`source/manga/AndroidMangaSourceManager.kt`
- 领域接口：`domain/src/main/java/tachiyomi/domain/source/manga/service/MangaSourceManager.kt`、`repository/MangaSourceRepository.kt`、`interactor/GetRemoteManga.kt`
- UI 消费：`app/src/main/java/eu/kanade/tachiyomi/ui/browse/manga/source/{MangaSourcesScreenModel.kt,MangaSourcesTab.kt}`、`source/browse/BrowseMangaSourceScreenModel.kt`、`source/globalsearch/`
- 网络：`core/common/src/main/java/eu/kanade/tachiyomi/network/NetworkHelper.kt`