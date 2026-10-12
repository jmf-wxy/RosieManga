# Aniyomi × Venera 融合方案与实施计划

> 目标：以 **Aniyomi（Android / Kotlin）为基座**，把两个 App「获取漫画的方式」结合起来——
> 既保留 Aniyomi 原有的 **Kotlin 扩展源（APK 扩展）**，又新增 **Venera 式的 JS 漫画源（QuickJS 引擎、免编译加源、可热更新）**，两者共存。
> 同时借鉴 Venera 的**阅读器 / 书架导航 / 主题配色**。
>
> 版本：v1 · 生成日期：2026-09-29

---

## 0. 结论先行（TL;DR）

| 项 | 结论 |
|---|---|
| 可行性 | **可行**。Aniyomi 的源体系是「面向接口」的，只要让一个对象 `is CatalogueSource` 并注册进 `MangaSourceManager`，Browse / 全局搜索 / 书架 / 阅读器**零改动**即可接入。 |
| 核心做法 | 新建 `JsMangaSource : CatalogueSource` 适配器 + 内嵌 **QuickJS** 引擎 + 复用 Venera 的 `init.js` 与 `*.js` 源，桥接到 Aniyomi 的 **OkHttp / Jsoup / 加密 / CookieJar**。 |
| 最大难点 | ① **同步桥**（Venera 的 `sendMessage` 是阻塞式返回）；② **JS 引擎 JNI 选型**。 <br>（③ 许可证冲突已于 4.6 节决策：**仅自用、接受 GPL-3.0、直接复用 `init.js`**，不再构成难点） |
| 工作量 | 中等偏大。MVP（能加源、能浏览、能读图）约 **1–2 周**；全 API 对齐与 UI 借鉴为后续阶段。 |
| 本机构建 | ⚠️ **本机无法命令行构建**（JDK 8、无 Android SDK）。必须用 **Android Studio（自带 JBR 21 + SDK）** 打开工程编译。 |
| 第一优先 | 先跑通 **M1 JS 引擎 + M2 最小源**，再铺全量 API。 |

---

## 1. 背景与目标

### 1.1 两个项目对比

| 维度 | Aniyomi（基座） | Venera（参考 / 借鉴源） |
|---|---|---|
| 平台 | 仅 Android | Flutter 跨平台（Android/iOS/桌面） |
| 语言 | Kotlin（Gradle KTS） | Dart（+ Rust 构建链） |
| 血统 | fork 自 Mihon（Tachiyomi 后继） | 独立项目，**已归档停更** |
| 许可 | Apache-2.0 | **GPL-3.0** ✅ 已接受（仅自用；Apache-2.0 与 GPLv3 兼容） |
| 内容 | 漫画 + 动画 | 漫画 |
| 源机制 | **Kotlin 扩展 APK**（`ChildFirstPathClassLoader` 动态加载） | **JavaScript 源**（QuickJS 运行，无需编译） |
| 源分发 | 扩展仓库（APK 下载安装） | JSON 索引（`venera-configs`），下载 `.js` |
| 阅读器 | View 系分页/条漫（性能优先） | Flutter 6 种模式 + 每漫画设置 |
| 主题 | M3 + 约 20 套 + Monet + AMOLED | 种子色 Material You |
| 导航 | 底部 Tab（Voyager 路由） | 自适应 NaviPane（移动顶栏/桌面侧栏） |

### 1.2 用户诉求（已确认）

1. **以 Aniyomi 为主**，技术栈 = **Android 原生 Kotlin**。
2. 源的获取方式**两者都要**：原有 Kotlin 扩展源 + 新增 Venera 的 JS 源。
3. 借鉴的结合点：**漫画源/扩展体系 + 主题配色系统 + 书架/首页导航 + 阅读器/翻页**。

---

## 2. 已导入的工程与现状

```
D:/VScode/26年/07-animeVenera/
├── aniyomi/                     # 基座（fork 目标），将被改造
├── venera/                      # 只读参考（JS 源 API、init.js、UI 实现）
├── ref-quickjs-android/         # JS 引擎候选库参考
├── docs/
│   ├── IMPLEMENTATION_PLAN.md   # 本文档
│   ├── aniyomi-source-system-report.md   # Aniyomi 源系统接线调查报告
│   ├── venera-comic_source-api.md        # Venera 源编写规范（官方）
│   └── venera-js-api.md                  # Venera 注入 JS API（官方）
├── vendor/js-source/init.js     # Venera 的 JS 胶水层（40KB，拟复用）
└── radiant-pulse-tesla-1uhrtuxB.md       # 原始调研产物
```

### 2.1 本机构建环境（关键）

| 项 | 现状 | 影响 |
|---|---|---|
| JDK | `1.8.0_60`（`JAVA_HOME=D:\Java\jdk8`） | Aniyomi 需 **JDK 17+**，命令行 **无法** 用现有 JDK 构建 |
| Android SDK | 未检测到 | 命令行 `./gradlew` 会失败 |
| Gradle | 无全局 | 用工程自带 `gradlew`（仍需 JDK17+SDK） |
| Android Studio | 用户已安装（JBR 21） | ✅ **用它打开工程构建** |

> 结论：**代码就在仓库里改，编译交给 Android Studio**。命令行仅用于文件操作与 git。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  Aniyomi UI 层（Browse / GlobalSearch / Library / Reader）      │  ← 零改动
└───────────────▲──────────────────────────────▲───────────────┘
                │ 只认 CatalogueSource          │
┌───────────────┴───────────────┐  ┌───────────┴───────────────┐
│  Kotlin 扩展源（原机制）        │  │  JsMangaSource（新增适配器） │
│  MangaExtensionLoader →        │  │  : CatalogueSource          │
│  ChildFirstPathClassLoader     │  │  + getImage()               │
└───────────────▲───────────────┘  └───────────▲───────────────┘
                │                              │ 调用 JS
     ┌──────────┴───────────┐      ┌───────────┴────────────────┐
     │ AndroidMangaSource    │      │  JsEngineBridge (QuickJS)   │
     │ Manager.sourcesMapFlow│◄─────│  · 载入 init.js             │
     │ 【唯一注册点】         │ 注册  │  · sendMessage 同步回调      │
     └───────────────────────┘      └───────────▲────────────────┘
                                                │ method 分发
                            ┌───────────────────┴────────────────────┐
                            │ Kotlin 宿主实现（对应 Venera 的 Dart）    │
                            │ http→OkHttp/NetworkHelper · html→Jsoup  │
                            │ convert→JDK+BouncyCastle · cookie→Jar   │
                            │ load_setting→SharedPreferences          │
                            └─────────────────────────────────────────┘
```

**数据流（以「搜索」为例）：**
`Browse 屏幕 → GetRemoteManga → MangaSourceRepository → (source as CatalogueSource).getSearchManga(page,query)`
`→ JsMangaSource → JsEngineBridge.eval("ComicSource.sources.k.search.load(...)")`
`→ JS 内 sendMessage({method:'http',...}) → Kotlin OkHttp 实发请求 → 返回 body 给 JS`
`→ JS 解析 → 返回 {comics:[...], maxPage:n} → Kotlin 映射为 List<SManga> → UI 渲染`。

---

## 4. 关键技术决策

### 4.1 JS 引擎选型（已定）

| 候选 | 语言支持 | JS↔宿主回调 | 维护度 | 结论 |
|---|---|---|---|---|
| **`wang.harlon.quickjs:wrapper-android:3.2.0`** | ES2020（async/await、Promise、class、Map）+ **ESModule** | ✅ 双向（`JSObject`/`JSArray`/`JSFunction`/`JSCallFunction`） | 活跃（2025-07） | ✅ **采用** |
| `app.cash.quickjs:quickjs-android:0.9.2`（**Aniyomi 已在用**） | ES2020 | ❌ 仅 `evaluate` 原始类型，**无回调** | 仓库已从 GitHub 消失 | ❌ 不足以做 `sendMessage` 桥 |
| J2V8 | V8 全量 | ✅ | 停滞（~2019） | 备选（体积大） |
| Rhino / Duktape | 仅 ES5 | ✅ | — | ❌ 跑不了 Promise/async 源 |

**决策**：JS 源子系统使用 **`wang.harlon.quickjs:wrapper-android:3.2.0`**（明确支持 **16KB page size**，Play 上架必需）。Aniyomi 原有 cashapp quickjs 依赖**保留不动**（`JavaScriptEngine.kt` 仍用它做简单求值），后续可考虑合并为单一引擎。

> 关键点：wrapper 的 `setProperty(name, (JSCallFunction) args -> …)` 正是我们需要的「JS 调 Kotlin 并同步拿返回值」能力——`sendMessage` 直接用它实现，`init.js` 无需改动。


### 4.2 同步桥（`sendMessage`）设计

Venera 的语义是 **`sendMessage(msg)` 阻塞返回结果**；若宿主返回 Future 则 JS 得到 Promise（如 `setTimeout`）。

- JS 引擎运行在 **专属单线程 Executor**（每个源实例一个，参考 Venera `js_pool`）。
- `sendMessage` 用 JNI 回调进入 Kotlin；Kotlin 侧：
  - **同步类**（convert / html / cookie get-set / random / uuid / load_data / load_setting / getLocale）→ 直接算完 return。
  - **异步类**（http / delay / UI）→ 在该 JS 线程内 **阻塞等待** 结果（OkHttp 同步 `execute()`），返回后再交给 JS。可避免 Promise 复杂度。
- 每源独立线程 + 超时（见 4.5），防止一个卡死拖垮全局。

### 4.3 HTML 解析 → Jsoup

Venera 的 `HtmlDocument`/`HtmlElement` 用「文档 ID + 元素下标」句柄模型。Kotlin 直接用 **Jsoup**（Aniyomi 已依赖）：
- `new HtmlDocument(html)` → `Jsoup.parse(html)`
- `querySelector/querySelectorAll/getElementById/getText/getAttributes/innerHtml/children/parent/nextSibling…` → Jsoup 一一对应。
- 句柄表 `MutableMap<Int, Element/Node>` 复刻 `DocumentWrapper`。

### 4.4 网络 / Cookie / 加密

- **网络**：复用 Aniyomi `NetworkHelper.client`（OkHttp，含 CookieJar/UA/Cloudflare/DoH）。`http` 方法对齐 Venera 返回 `{status, headers, body, error}`。
- **Cookie**：复用 `AndroidCookieJar`（Aniyomi 已有），实现 `cookie.set/get/delete`。
- **加密**：`Convert` 用 JDK `MessageDigest`（md5/sha1/256/512）、`Mac`（hmac）、`Cipher`（AES ECB/CBC/CFB/OFB）+ **BouncyCastle**（RSA、GBK 编码用 `Charset`）。Aniyomi 已含 conscrypt。

### 4.5 安全沙箱

JS 源是**第三方不可信代码**。必须：
- 单次 `sendMessage` **超时**（网络 30s、脚本整体 60s）；
- 引擎级别 **内存/递归上限**（QuickJS 支持）；`compute` 走独立池；
- 禁止文件系统访问（Venera 本就没有 FS API，保持不提供）；
- `load_setting/save_data` 只允许写源自己的 `SharedPreferences` 命名空间。

### 4.6 ✅ 许可证（已决策：仅自用，接受 GPL-3.0）

**决策：本项目为「个人自用」，不做对外分发。接受 Venera 的 GPL-3.0 传染，`init.js` 与 `*.js` 源直接复用，不做 clean-room 重写。**

#### 事实基础（已核对）
| 项 | 值 |
|---|---|
| Aniyomi | **Apache-2.0**（`aniyomi/LICENSE` 实测确认） |
| Venera | **GPL-3.0**（`venera/LICENSE` 实测确认）；仓库已停止维护，README 明示 "Feel free to fork" |
| Apache-2.0 → GPL-3.0 | **兼容**（FSF 认定 Apache-2.0 可并入 GPLv3 作品），两者结合无法律障碍 |
| 本项目性质 | 个人自用，**不 convey（不向他人分发）** |

#### 为什么自用场景下 GPL 义务不触发
GPLv3 **§2 原文**：*"You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force."*

即：**自己编译、自己改、装在自己手机上跑 → 无需公开任何源码、无需以 GPL 授权自己的代码、无需附带许可证**。copyleft 的"传染"只在向他人交付（convey / distribute）时才启动。

#### ⚠️ 唯一边界：什么算"分发"
自用豁免的边界比直觉窄。以下行为**会**触发 GPLv3 义务（需公开完整对应源码 + 保留原作者版权声明 + 整体以 GPL-3.0 授权）：

| 行为 | 是否触发 GPL |
|---|---|
| 自己手机装、自己用、自己改 | ❌ 不触发 |
| 把 APK 发给朋友 / 家人装 | ✅ 触发（**向他人交付即 convey**） |
| 上传网盘、发微信群、发论坛、发 GitHub Release | ✅ 触发 |
| 上架应用商店（Google Play / 国内各商店） | ✅ 触发 |
| 只在自己设备间同步（手机 ↔ 平板） | ❌ 不触发（同一主体） |

> **结论**：当前"只自用"的定位下风险为零；但**一旦想分享给任何人，就自动变成"整体 GPL 开源"路线**，届时需要：① 公开完整源码；② 保留 Apache-2.0 与 GPL-3.0 的版权声明；③ 不能添加与 GPL 冲突的 EULA 限制。
> 所以本仓库**按"随时可开源"的标准做卫生**（见下），成本几乎为零，避免日后返工。

#### 已落地的许可证卫生措施
即便自用，仍保留最小合规痕迹，未来若要分发可无缝切换：
1. `aniyomi/js-source/THIRD-PARTY-LICENSES/Venera-GPL-3.0.txt` —— 存放 Venera 原始 GPL-3.0 全文
2. `aniyomi/js-source/README.md` —— 声明 `assets/init.js` 的来源与许可证、以及本项目整体许可状态
3. 本项目自有代码在"仅自用"阶段**不改变** Aniyomi 原有 Apache-2.0 声明（未分发，无义务变更）

#### 已排除的两条路线（记录备查）
- ~~干净重写（clean-room）~~：工作量最大（需重写 1519 行 `init.js` 的等价实现），仅在"必须保持 Apache-2.0 且要分发"时才需要，本项目不需要。
- ~~严格 Apache-2.0 分发~~：放弃，见上。

#### 若未来要分发，还需注意（提前知晓，非当前待办）
- **专有 SDK 冲突**：若接入穿山甲/优量汇/AdMob 等闭源广告 SDK，GPLv3 要求整个组合作品可 GPL 化，而闭源 SDK 不可 → 构成 GPL 违规。个人自用不受影响，**对外分发时是硬冲突**。
- **Apple App Store**：GPL 应用因 Apple ToS 的额外限制，**无法上架**（本项目仅 Android，暂无影响）。
- **国内上架**：需软著、应用备案；且"漫画阅读器聚合第三方站点"的内容合规风险远大于许可证风险。
- **品牌**：Aniyomi / Mihon 社区惯例是 fork 需改名换图标，分发前需处理。

---

## 5. 集成点与改动清单

### 5.1 新建（不改 Aniyomi 原逻辑）

| 文件/模块 | 职责 |
|---|---|
| `:js-source`（新 Gradle 模块） | 隔离 JS 引擎与桥接，便于依赖管理 |
| `JsMangaSource.kt` | `class JsMangaSource : CatalogueSource`，实现 `getPopularManga/getSearchManga/getLatestUpdates/getFilterList/getMangaDetails/getChapterList/getPageList` + `getImage(page)` |
| `JsEngineBridge.kt` | 持有 QuickJS 实例；载入 `init.js`；实现 `sendMessage` 回调分发 |
| `JsMessageDispatcher.kt` | 对应 Venera `_messageReceiver`：`http/html/convert/cookie/random/uuid/load_setting/...` |
| `JsHtmlDom.kt` | Jsoup 版 `DocumentWrapper` |
| `JsConvert.kt` | 加密/编码实现 |
| `JsSourceParser.kt` | 对应 Venera `ComicSourceParser`：反射读取 JS 源的 name/key/version/explore/search/comic 等 |
| `JsSourceManager.kt` | 扫描 `*.js`、解析、构造 `JsMangaSource`、管理源列表与更新 |
| `JsSourceUpdater.kt` | 拉取 JSON 索引（`venera-configs`）、下载/更新 `.js` |
| `assets/init.js` | 复用 Venera 胶水层（注意许可证） |

### 5.2 修改 Aniyomi（最小侵入）

| 文件 | 改动 |
|---|---|
| `AndroidMangaSourceManager.kt` | 在 `init{}` 的 `collectLatest` 里，除 `LocalMangaSource` + 扩展源外，再 `jsSources.forEach { map[it.id] = it }` |
| `MangaSourceManager.kt`（domain） | （可选）引入标记接口 `OnlineMangaSource`，让 `getOnlineSources()` 同时接受 JS 源 |
| 阅读器 / 下载器中的 `source is HttpSource` 判断 | 改为 `source is HttpSource || source is JsMangaSource`（否则 JS 源取不到图/不被当在线源） |
| `settings.gradle.kts` | `include(":js-source")` |
| `:app/build.gradle.kts` | `implementation(project(":js-source"))` |
| 源管理设置页 | 增加「JS 源」管理入口（添加仓库 URL / 更新 / 删除） |

> 关键洞察（来自调查报告）：**只要 `JsMangaSource : CatalogueSource` 进入了 `MangaSourceManager.sourcesMapFlow`，Browse / GlobalSearch / GetRemoteManga 整条链路对它完全透明，UI 无需改动。** 唯一需要动的是「图片来源」路径对 `HttpSource` 的硬编码判断。

---

## 6. 数据模型映射

| Venera（JS 返回） | Aniyomi | 映射规则 |
|---|---|---|
| `Comic.id` | `SManga.url` | 直接作为 url |
| `Comic.title` / `subtitle` | `SManga.title` | `title`（可选拼 subtitle） |
| `Comic.cover` | `SManga.thumbnail_url` | 直接 |
| `Comic.tags: string[]` | `SManga.genre: string[]` | 直接 |
| `Comic.description` | `SManga.description` | 直接 |
| `ComicDetails.uploader` | `SManga.author` / `artist` | 都填 uploader |
| `ComicDetails.chapters: Map<id,title>` | `List<SChapter>` | key→`SChapter.url`，value→`SChapter.name` |
| `comic.loadEp(...).images: string[]` | `List<Page>` | 索引→`Page.index`，url→`Page.url/imageUrl` |
| `comic.onImageLoad(url,..)` → headers | `getImage(page)` 的请求头 | 每次取图前调用 JS 拿 header |
| `key`（源标识） | `MangaSource.id: Long` | `MD5(key)`（参考 `HttpSource.generateId`），保证稳定 |

> 说明：Aniyomi 用 **Long** 作为源 id，Venera 用 **String key**；用 `MD5(key)` 生成稳定 Long 并维护 `key↔id` 映射表。
> 章节/漫画的**分组、排序、grouped chapters** 等 Venera 高级特性，MVP 阶段可暂用扁平列表。

---

## 7. UI 借鉴（第二阶段，非阻塞）

| 维度 | 现状（Aniyomi） | 借鉴（Venera） | 建议 |
|---|---|---|---|
| 阅读器 | 分页 + 条漫（View 系） | 6 种模式 + 每漫画/每源设置 | 在现有 reader 增加「每漫画覆盖设置」「单页首图」等；不必重写渲染 |
| 书架/导航 | 底部 Tab | 自适应 NaviPane（平板侧栏） | 保持底部 Tab；**平板/折叠屏可选侧栏** 作为增量 |
| 主题 | 20 套 + Monet/AMOLED | 种子色 Material You | Aniyomi 已有 Monet，可加「自定义种子色」入口 |

> 原则：**UI 借鉴是增量优化，不阻塞源系统打通**。

---

## 8. 分阶段里程碑

| 阶段 | 目标 | 涉及文件 | 验收标准 |
|---|---|---|---|
| **M0** 环境 | Android Studio 打开 `aniyomi/`，用 JBR17+ 成功构建 baseline APK | — | `assembleDebug` 通过 |
| **M1** 引擎跑通 | 内嵌 JS 引擎，能 `evaluate` 并实现 `sendMessage` 同步回调 | `:js-source/JsEngineBridge.kt` | 控制台打印 JS 返回值；`sendMessage` 可回调 Kotlin |
| **M2** 最小源 | 载入一个 `.js` 源，实现 `loadInfo/loadEp/search` | `JsMangaSource.kt`、`JsSourceParser.kt` | 源出现在 **Browse → 源列表**；能进源、能搜到漫画 |
| **M3** 读图 | 打通 `getPageList` + `getImage`（含 onImageLoad 头） | `JsMangaSource.getImage` | 能在**阅读器里看到图片** |
| **M4** 全 API | 补全 init.js 全部：convert/html/cookie/UI/settings/account | `JsMessageDispatcher`、`JsHtmlDom`、`JsConvert` | 复刻的源与 Venera 表现一致 |
| **M5** 稳定化 | 多源池、超时、内存限制、错误上报、源更新 | `JsSourceManager`、`JsSourceUpdater` | 崩溃率达标、可热更新源 |
| **M6** UI 借鉴 | 阅读器/导航/主题增量 | reader、HomeScreen、主题 | 见第 7 节 |

**建议先做 M0–M3 打通闭环**，再铺 M4+。

---

## 9. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | **GPL-3.0 传染** | ✅ 已消除 | 已决策「仅自用」：不分发则义务不触发，`init.js` 可直接复用（见 4.6 节）。⚠️ 仅当未来对外分发时重新评估 |
| 2 | 同步桥 **死锁/卡 UI** | 🟠 中 | JS 跑独立线程；网络走同步 `execute()`；全链路超时 |
| 3 | JS 引擎 **JNI 兼容**（16KB page size / Play 政策 / ABI） | 🟠 中 | 选活跃维护的 QuickJS 绑定；CI 校验 `.so` 对齐；4 ABI 全打 |
| 4 | `is HttpSource` 硬编码遗漏 → 取不到图 | 🟠 中 | grep 全量替换为 `OnlineMangaSource` 标记接口 |
| 5 | 源 id/key 映射与数据库冲突 | 🟡 低 | `MD5(key)` 稳定映射 + 迁移脚本 |
| 6 | 第三方 JS 源行为不可控（超时/内存/恶意） | 🟠 中 | 沙箱 + 限额 + 源信任提示 |
| 7 | Aniyomi 上游更新频繁（fork 维护成本） | 🟡 低 | 尽量**新增模块 + 少量 patch**，减少与上游 diff |

---

## 10. 下一步（Next Actions）

1. ✅ **已确认**：① 许可证路线 = **仅自用、接受 GPL-3.0、直接复用 `init.js`**（见 4.6 节）；② **QuickJS 优先**（`wang.harlon.quickjs:wrapper-android:3.2.0`）。
2. ⏭ **当前卡点**：本机无 Android Studio / 无 Android SDK / JDK 仅 1.8 → 需按 `docs/BUILD_SETUP.md` 装工具链。
3. 工具链就绪后：跑通 **M0** baseline 构建（`./gradlew :app:assembleDebug`）。
4. 进入 **M1**：按真实编译错误校准 `:js-source` 骨架 API（主要是 wrapper 的 `JSContext`/`JSCallFunction` 签名）。
5. 用 `vendor/js-source/init.js` + 一个真实 `*.js` 源做 **M2** 端到端验证（源出现在 Browse 列表并可取图）。

---

## 11. 当前进展（本次已落地）

- ✅ 导入 **Aniyomi**（main，解压工程 + `git init` + `upstream` 远端已设）与 **Venera**（深度1，只读参考）。
- ✅ 确定 **JS 引擎 = `wang.harlon.quickjs:wrapper-android:3.2.0`**。
- ✅ 新建模块 **`:js-source`** 并完成接线：
  - `js-source/build.gradle.kts`（依赖 source-api / core:common / jsoup / okhttp / wrapper）
  - `js-source/src/main/assets/init.js`（Venera 胶水层，40KB）
  - `JsEngine.kt`、`JsMessageDispatcher.kt`、`JsMangaSource.kt`、`JsSourceManager.kt`（**M1/M2 骨架，含 TODO**）
  - 补丁：`settings.gradle.kts` 加 `include(":js-source")`；`app/build.gradle.kts` 加 `implementation(projects.jsSource)`；
    `AndroidMangaSourceManager.kt` 将 JS 源合并进 `sourcesMapFlow`。
- ⏭️ **未做（需你/环境）**：按 `docs/BUILD_SETUP.md` 安装 Android Studio 后打开 `aniyomi/` 编译；
  编译时按 TODO 校准 wrapper API 与 QuickJS 行为。
- ✅ **许可证已决策**：仅自用、接受 GPL-3.0、直接复用 `init.js`（见 4.6 节）。
- ✅ 已落地许可证卫生：`js-source/THIRD-PARTY-LICENSES/Venera-GPL-3.0.txt` + `js-source/README.md` 声明。

> 骨架代码按「接口正确、可编译为目标」编写，但 **未经真实编译验证**，首次在 Android Studio 打开时预计需要少量 API 修正。

---

### 附：关键参考文件

- Aniyomi 源体系接线：`docs/aniyomi-source-system-report.md`
- Venera 源编写规范：`docs/venera-comic_source-api.md`
- Venera 注入 JS API：`docs/venera-js-api.md`
- Venera 胶水层：`vendor/js-source/init.js`
- Venera 引擎实现（Dart，桥接蓝本）：`venera/lib/foundation/js_engine.dart`
- Venera 源解析器（Dart，绑定蓝本）：`venera/lib/foundation/comic_source/parser.dart`
