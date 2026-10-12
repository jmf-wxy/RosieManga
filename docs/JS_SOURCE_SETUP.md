# 添加 Venera JS 图源：现状、步骤与阻断点

> 结论先行：**下载/导入源的页面与入口已实现**（见第 0 节）；阅读器取图链路已打通；
> 但 **HTML DOM 未实现**，所以 venera-configs 里绝大多数真实源装上后仍无法解析页面。

---

## 零、用户入口与操作（已实现）

### 入口路径

```
设置 → 浏览 → 【源】分组 →「JS 源」（位于「扩展仓库」下方）
```

- 宿主文件：`app/.../presentation/more/settings/screen/SettingsBrowseScreen.kt`
- 页面文件：`app/.../presentation/more/settings/screen/browse/JsSourcesScreen.kt`
- 包名：`xyz.jmir.tachiyomi.mi`（debug 变体为 `xyz.jmir.tachiyomi.mi.debug`）

### 页面能力

| 区域 | 功能 |
|---|---|
| 仓库地址输入框 | 预填 `https://raw.githubusercontent.com/venera-app/venera-configs/main` |
| 「刷新」按钮 | 拉取 `index.json`，列出手册里所有可安装源 |
| 「全部安装」按钮 | 一键安装/更新仓库内全部源（带进度条） |
| 「已安装」列表 | 显示名称 / 版本 / 文件名 / key，可单独删除 |
| 「可安装」列表 | 显示名称 / 版本 / 描述，可单独安装 |
| 右下 FAB「导入 .js」 | 通过系统文件选择器导入本地 `.js` 源（离线场景） |

### 存储位置

```
/data/data/<包名>/files/comic_source/<fileName>.js     ← 源脚本
/data/data/<包名>/files/comic_source/<key>.data        ← 每源状态（TODO: 尚未落盘）
```

### 代码结构

| 层 | 文件 | 职责 |
|---|---|---|
| 数据模型 | `js-source/.../JsSourceIndex.kt` | `JsSourceIndexEntry` + 索引解析 |
| 下载器 | `js-source/.../JsSourceUpdater.kt` | 拉索引、下载 `.js`、批量同步、本地导入 |
| 注册表 | `js-source/.../JsSourceManager.kt` | 安装/卸载/重载 + `installed` StateFlow |
| 状态 | `app/.../browse/JsSourcesScreenModel.kt` | `JsSourcesState` + 事件 |
| UI | `app/.../browse/components/JsSourcesContent.kt` | 列表与卡片 |
| 壳 | `app/.../browse/components/JsSourcesScreen.kt` | Scaffold + AppBar + FAB |
| 路由 | `app/.../browse/JsSourcesScreen.kt` | Voyager Screen |

### ⚠️ 重要：装完源需要重启 App

`JsSourceManager.init()` 有 `if (engine != null) return` 幂等锁，且只在启动时扫描一次目录。
新安装的源**必须重启应用**才会出现在「浏览 → 源列表」中。这是当前实现的限制
（后续可在 `install()` 里增量注册到 `AndroidMangaSourceManager` 以支持热生效）。

---

## 一、已完成：`OnlineMangaSource` 标记接口

### 为什么必须做

`JsMangaSource` 不是 `HttpSource`，而阅读器/下载链路到处用 `source is HttpSource`
判断「是否在线源」。结果：JS 源**能出现在源列表、能搜到漫画、能进详情，但一开章节就崩**：

```kotlin
// ChapterLoader.kt（改前）
source is HttpSource -> HttpPageLoader(chapter, source)
source is StubMangaSource -> error(...)
else -> error(MR.strings.loader_not_implemented_error)   // ← JS 源掉到这里
```

### 设计原则

**UI 问「意图」，不问「实现」。** 一个源是不是在线源，是它的**性质**，不是它的**父类**。
所以引入标记接口表达意图：

```kotlin
// source-api/src/commonMain/kotlin/eu/kanade/tachiyomi/source/online/OnlineMangaSource.kt
interface OnlineMangaSource : CatalogueSource {
    suspend fun getImageUrl(page: Page): String = page.imageUrl ?: page.url
    suspend fun getImage(page: Page): Response
}
```

### 改动清单（6 个文件）

| 文件 | 改动 |
|---|---|
| `source-api/.../online/OnlineMangaSource.kt` | **新增**标记接口 |
| `source-api/.../online/HttpSource.kt` | `: CatalogueSource` → `: OnlineMangaSource`；`getImageUrl`/`getImage` 加 `override` |
| `js-source/.../JsMangaSource.kt` | 同上；`getImage(page, comicId, epId)` → `override getImage(page)` |
| `app/.../reader/loader/HttpPageLoader.kt` | `source: HttpSource` → `source: OnlineMangaSource` |
| `app/.../reader/loader/ChapterLoader.kt` | `is HttpSource` → `is OnlineMangaSource` |
| `app/.../util/DataSaver.kt` | 扩展函数接收者 `HttpSource` → `OnlineMangaSource` |
| `domain/.../MangaSourceManager.kt` + `AndroidMangaSourceManager.kt` | `getOnlineSources(): List<HttpSource>` → `List<OnlineMangaSource>` |

**关键收益**：`HttpPageLoader` 整套队列 / 预加载 / 章节缓存机制**被 JS 源直接复用**，
无需另写一个 `JsPageLoader` 再实现一遍。

### 验证

```
:source-api:compileDebugKotlinAndroid   ✅
:domain:compileDebugKotlin              ✅
:js-source:compileDebugKotlin           ✅
:app:compileDebugKotlin                 ✅ BUILD SUCCESSFUL
```

---

## 二、真实源从哪来：venera-configs

### 索引格式（已实测确认）

- 索引：`https://raw.githubusercontent.com/venera-app/venera-configs/main/index.json`
- 单源：`https://raw.githubusercontent.com/venera-app/venera-configs/main/<fileName>`

索引是**顶层数组**，每项结构：

```json
[
  {
    "name": "漫画柜",
    "fileName": "manhuagui.js",
    "key": "ManHuaGui",
    "version": "1.2.1",
    "description": "可选，部分源才有"
  }
]
```

共 33 个源，涵盖拷贝漫画 / MangaDex / 漫画柜 / Komga / Kavita / Lanraragi 等。
注意 **`key` 大小写敏感且各源不统一**（如 `ManHuaGui`、`Komiic` 首字母大写）。

### ⚠️ 阻断点：绝大多数源是 HTML 解析型

实测下载 `manhuagui.js`（1473 行）统计其 API 使用：

| API | 次数 | 当前状态 |
|---|---|---|
| `querySelector` | **70** | ❌ `html()` 直接 `return null` |
| `new HtmlDocument` | 2 | ❌ 同上 |
| `loadData` / `saveData` | 4 / 1 | ⚠️ 仅内存，重启丢失 |
| `Network.get` / `post` | 2 / 3 | ✅ 已实现 |

**结论：`JsMessageDispatcher.html()` 返回 `null` 意味着这类源拿不到任何元素，
`querySelector(...)` 全部得 `null`，解析直接失败。HTML DOM 不是可选项，是接真实源的硬前置。**

---

## 三、分档补齐路线

### 档 A：先用纯 JSON API 源验证链路（不依赖 HTML DOM）

目标是验证「注册 → 列表 → 搜索 → 详情 → 取图」闭环，用最小代价。

1. 写一个只用 `Network.get` + `JSON.parse` 的测试源（骨架见下）；
2. 塞进 `filesDir/comic_source/`；
3. 重启 App，看源是否出现、能否搜到、能否取图。

```javascript
class ComicSource {
    name = "Test JSON Source"
    key = "test_json_source"      // 不含特殊字符；会被塞进 sources['$key']
    version = "0.0.1"
    minAppVersion = "1.0.0"
    url = "https://example.com"

    explore = [{
        title: "Explore",
        load: async (page) => {
            const r = await Network.get("https://example.com/api/list?page=" + page);
            const data = JSON.parse(r.body);
            return {
                comics: data.items.map(it => new Comic({
                    id: String(it.id), title: it.name,
                    cover: it.cover, tags: it.tags || [], description: it.desc || "",
                })),
                maxPage: data.totalPage,
            };
        }
    }]

    search = {
        load: async (keyword, options, page) => {
            const r = await Network.get("https://example.com/api/search?q="
                + encodeURIComponent(keyword) + "&page=" + page);
            const data = JSON.parse(r.body);
            return { comics: data.items.map(it => new Comic({ id: String(it.id), title: it.name })), maxPage: data.totalPage };
        }
    }

    comic = {
        loadInfo: async (id) => {
            const d = JSON.parse((await Network.get("https://example.com/api/comic/" + id)).body);
            return new ComicDetails({ title: d.name, cover: d.cover, description: d.desc, chapters: d.chapters });
        },
        loadEp: async (comicId, epId) => {
            const d = JSON.parse((await Network.get("https://example.com/api/novel/" + comicId + "/" + epId)).body);
            return { images: d.images };
        },
    }
}
```

**两个必踩的坑：**

- `JsSourceManager.add()` 是把整个源文件**拼接进一段表达式**再 eval：
  `evalBlocking("(() => { $jsCode; this['__temp'] = new $className(); }).call(this);")`。
  所以源文件里**不要写行尾 `//` 注释、不要用反引号模板字符串**，否则拼接后语法错误。
- `comic.loadInfo` 返回的 `chapters` 必须是 **`{ epId: "标题" }` 的 map**，
  `JsMangaSource.getChapterList` 按 `Map` 遍历，返回数组会得到空章节列表。

### 档 B：实现 HTML DOM（接真实源的前提，M4）

在 `JsMessageDispatcher` 里用 Jsoup 实现句柄式 DOM（对齐 `init.js` 的
`HtmlDocument` / `HtmlElement` / `HtmlNode` 契约）：

需要覆盖的 `function` 值（从 `init.js` 提取）：

```
parse, querySelector, querySelectorAll, dispose,
getElementById,
getText, getAttributes, dom_querySelector, dom_querySelectorAll,
getChildren, getNodes, getInnerHTML, getParent, getClassNames,
getId, getLocalName, getPreviousSibling, getNextSibling,
node_text, node_type, node_toElement
```

设计要点：`HtmlDocument` 用一个自增 `key` 在 Kotlin 侧维护
`Map<Int, Document>`，`HtmlElement` 用 `key` 引用 `Element`；`doc` 参数用来定位所属文档。
这是**工作量最大但价值最高**的一步 —— 做完它，venera-configs 里绝大多数源即可直接用。

### 档 C：补齐周边（M5）

| 缺口 | 位置 | 说明 |
|---|---|---|
| `comic_source/*.js` 无写入方 | `JsSourceManager.loadFrom` | 缺导入入口 / `JsSourceUpdater` 下载器 |
| 源索引拉取 | `JsSourceManager.kt` `TODO(M5)` | 拉 `index.json`、比对 `version`、下载更新 |
| 数据持久化 | `saveData` `TODO(M5)` | 现仅内存，重启丢登录态；应落盘 `comic_source/<key>.data` |
| 设置页「JS 源」入口 | — | 添加仓库 URL / 更新全部 / 删除单源 |
| `cookie()` / AES / GBK | `JsMessageDispatcher` | 空实现；部分源登录后取图需要 |
| `lang` 字段 | `JsSourceManager.add` 硬编码 `"all"` | 影响 Browse 的语言筛选 |

---

## 四、临时验证手段：手工落盘

包名以 `app/build.gradle.kts` 的 `applicationId` 为准（debug 版通常带 `.debug` 后缀）：

```bash
# 1. 建目录（run-as 可直接操作应用私有目录）
adb shell run-as <包名> mkdir -p files/comic_source

# 2. 推文件
adb push test_source.js /data/local/tmp/

# 3. 拷进去
adb shell run-as <包名> cp /data/local/tmp/test_source.js files/comic_source/
```

然后**完全重启 App**（`JsSourceManager.init()` 有 `if (engine != null) return` 幂等锁，
且只在启动时扫描一次，热重载不生效）。

排错看 Logcat，tag = **`venera-js`**（`JsEngine` 已把 JS `console.log` 转发过去）。

---

## 五、注意：构建环境

编译前确认 `JAVA_HOME` **不是** JDK 8（本机终端有 `D:\Java\jdk8` 残留）：

```bash
JAVA_HOME="D:/Java/temurin-17" ./gradlew :app:compileDebugKotlin --offline
```

否则报 `FileNotFoundException: D:\Java\jdk8\jre\lib\ext\cldrdata.jar`。
