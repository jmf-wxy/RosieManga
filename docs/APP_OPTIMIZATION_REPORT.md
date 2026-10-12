# 应用优化与问题诊断报告

> 目标：找出 animeVenera（aniyomi + venera JS 源系统）当前**还能优化 / 仍需修复**的点，并评估**流畅度**还能提升多少。
> 调研方式：只读核查 `aniyomi/js-source/.../js/` 桥代码、`aniyomi/app/.../ui/browse/.../BrowseMangaSourceScreenModel.kt`、`JsMessageDispatcher.kt`、`JsMangaSource.kt`、`JsImageEngine.kt`、`JsSourceUpdater.kt`、build 配置与 `docs/`。
> 结论先行：**此前 S27–S41 系列修复绝大部分已落地且代码可见**，当前不是"一堆 bug"，而是**少量桥桩未实现 + 一处会话态缺口 + DB 不自愈 + 图片变换可池化**。流畅度仍有明确可量化的提升空间。

---

## 一、结论先行（TL;DR）

| 维度 | 现状 | 结论 |
|---|---|---|
| 已修但需确认 | S27–S31 手动翻页、S32 主线程 eval 防护、S33/S34 转场/帧循环、S35 HTML 桥、S38 版本门、S40 哈希序告警 | ✅ 代码均已就位，不是空绿 |
| 仍需修复 | `cookie` 桩返回 null（会话不持久）、`compute` 桩返回 null、`log` 未接 logcat、同步 `delay` 用 Thread.sleep | ⚠️ 4 处桥桩，其中 cookie 影响正确性 |
| 体验/流畅度 | 图片 transform 串行在 JS 线程、DB 升级后不自愈、baseline profile 未生成 | 🔧 3 个明确优化点，预期可见提升 |
| 流畅度上限 | 切页/切 tab 卡顿的根因（主线程 eval、重组重算）已消除；剩余瓶颈在图片变换与首启 | 还能提，但属于"锦上添花"级 |

**一句话**：应用骨架健康，下一步是"补桥桩 + 让升级自愈 + 把图片变换挪出主/JS 线程 + 生成 baseline profile"。

---

## 二、已确认健壮、无需再动的项（给你安心）

| 项 | 证据（file:line） | 说明 |
|---|---|---|
| 手动翻页在 ScreenModel 触发（S27–S31） | `BrowseMangaSourceScreenModel.kt:113,249,255,285`（`_manualState` 在 init 前声明、`manualKey()`、`FilterList.signature()`、`ensureManualListing()`） | FilterList.equals 硬编码 false 导致的"搜索慢/旧内容"已根治 |
| 主线程 eval 防护（S32） | `JsSourcesScreenModel.kt:97,110`、`JsSourceConfigScreenModel.kt:124`、`JsSourceConfigScreen.kt:76`（`launchIO` / `withContext(Dispatchers.IO)` 包住 `evalBlocking`） | install/uninstall/saveSetting 不钉主线程 |
| 转场/帧循环（S33/S34） | `MangaLibraryScreenModel.kt:103`（已移除 `withFrameNanos` 常驻循环，改用 `System.nanoTime()`） | 不误用帧回调，Recomposer 不再每帧全扫 |
| HTML 桥落地（S35） | `JsMessageDispatcher.kt:521-526`（`html()` → `JsHtmlBridge().handle(msg)`，非 null 桩） | GoDa 等 HtmlDocument 源可用 |
| 版本门防回滚（S38） | `JsSourceUpdater.kt:129-250`（`isRepoNewer()` 语义化比较，仓库更低拒绝） | 本地补丁不会被"检查更新"冲掉 |
| 章节哈希序告警（S40） | `JsMangaSource.kt:401-412`（`is Map<*,*>` 分支 + `hashOrderWarned` 一次性告警） | 源用普通对象时才告警，已用 `new Map()` 的源正常 |
| 详情去重/缓存（S37 衍生） | `JsMangaSource.kt:629,652,661`（`loadInfoJobs` 并发去重、`loadInfoCache` TTL） | getMangaDetails/getChapterList 竞速不再重复拉 |
| 图片变换锁正确（S16） | `JsImageEngine.kt:61-62,177-182`（`transformLock` 串行、`lock` 不跨 eval、句柄会话内释放） | 不会真机死锁 |

---

## 三、仍需修复的问题（按严重度分类）

### 🔴 高：会话态缺口（影响源正确性）

**问题 1：`cookie` 桥是空桩，会话 Cookie 不持久**
- 位置：`JsMessageDispatcher.kt:735-736`
  ```kotlin
  /** `Network.setCookies/getCookies/deleteCookies` — TODO(M4): wire to AndroidCookieJar. */
  private fun cookie(msg: Map<*, *>): Any? = null
  ```
> **✅ 已修复并编译通过**（见文末「实施状态」）

- 根因：`sendMessage({method:'cookie'})` 全返回 `null`，没有接 `AndroidCookieJar`/持久化存储。
- **⚠️ 落地时修正了本报告原来的判断（影响面比原描述窄）**：`bridgeClient` 是 `network.client.newBuilder()`，
  而 `newBuilder()` **会带上原 client 的 cookieJar** ⇒ OkHttp 本来就在自动存取/回放 Cookie，
  并不是"会话完全不持久"。真正坏的只是**显式 API** 三件套：`getCookies` 返回 `null`（判断登录态的源会拿到
  `undefined` 走错分支）、`deleteCookies` 什么也不做 —— **jm.js 的 `logout()` 就是遍历 `JM.apiDomains`
  调 `Network.deleteCookies(url)`（jm.js:401），所以登出清不掉会话**、`setCookies` 静默失败。
- 修复：实现 `cookie()`，接 `AndroidCookieJar`（aniyomi 已有 `core.common` 的 Cookie 体系），按 `msg["url"]` 读写 `CookieJar`，并把 `setCookies` 落盘。
- 预期效果：登录态源稳定，减少"明明能看却突然 403/要重登"的体感 bug。

### 🟠 中：桥桩未实现（潜在静默失败）

**问题 2：`compute` 桥是空桩 + 重 JS 未隔离线程**
- 位置：`JsMessageDispatcher.kt:141`
  ```kotlin
  "compute" -> { /* TODO(M4): run heavy JS in a separate pool (JsPool) */ null }
  ```
- 影响：任何源调用 `sendMessage({method:'compute'})` 都拿到 `null`（静默）。且注释点明的"重 JS 放独立池（JsPool）"没做——若源在 JS 线程做重加密/重解析，会**挤占图片 transform 与列表加载的 JS 线程**，间接卡顿。
- 修复：实现 `compute()`；把重 JS（compute / 大图 transform）统一调度到一个**专用单线程池**（即 `JsPool` 思路），与列表/图片请求错峰。
- 预期效果：消除"源一算重活，列表/图片就卡"的隐性卡顿；为后续复杂源铺路。

**问题 3：同步 `delay` 用 `Thread.sleep` 钉死 JS 线程**
- 位置：`JsMessageDispatcher.kt:127`
  ```kotlin
  "delay" -> { Thread.sleep((msg["time"] as? Number)?.toLong() ?: 0L); null }
  ```
- 根因：S18 明确要求 `delay` 必须异步（`__delay_async`），同步 `Thread.sleep` 会把整个 JS 线程睡死；若该 delay 期间有别的请求/transform 在等，就是隐性阻塞甚至自死锁。
- 修复：路由到已有的 `delayAsync`（与 `httpAsync` 同模式，不阻塞 JS 线程）。
- 预期效果：避免偶发"卡一下然后恢复"的神秘卡顿。

**问题 4：`log` 未接 Aniyomi logcat（诊断盲区）**
- 位置：`JsMessageDispatcher.kt:235`（`// TODO(M1): forward to Aniyomi Logcat`）
- 影响：源的 `sendMessage({method:'log'})` 不进系统日志，出问题只能靠 `JsDebugLog` 浮层，普通用户无痕。
- 修复：接到 aniyomi 既有日志通道（级别/标题/内容）。
- 预期效果：排障效率提升，减少"只能靠截图猜"的来回。

### 🟡 中：升级后不自愈（体感"修了还是这样"）

**问题 5：DB 存量章节顺序/元数据不随源升级重同步（S41）**
- 位置：`JsMangaSource.kt` 详情缓存 + 宿主 `MangaScreenModel.init`（`needRefreshInfo = !manga.initialized`、`needRefreshChapter = chapters.isEmpty()`）
- 根因：源升级修好"章节乱序/未知作者"后，**已入库**的漫画因为"不是空章节、initialized=1"，永远不会回源重拉 → 仍显示旧顺序/旧作者，直到手动下拉刷新。
- 修复：在 `JsSourceUpdater` 成功升级某源后，标记该源下所有 manga 需要重同步（`manga.initialized=false` 或加 `sourceVersion` 比对字段），下次打开自动刷新；或提供"按源强制重同步"入口。
- 预期效果：导入 1.2.3 后**第二天**就看到顺序正确，而不是"拉了新漫画才对、老漫画还是乱"。

### 🟢 低：构建/发布优化（自用可暂缓）

**问题 6：未生成 baseline profile / 未确认 R8 开启**
- 位置：`aniyomi/app/src/main/baseline-prof.txt` 已存在（好），`macrobenchmark` 模块存在，但 app `build.gradle.kts` 未见 `minifyEnabled`/`shrinkResources` 与 `baselineProfile` 生成任务绑定。
- 修复：release 构建开启 R8 + 资源缩减；跑一次 `macrobenchmark` 生成并打入 baseline profile。
- 预期效果：首启/页面切换更快（方法预编译），APK 更小。

**问题 7：若干 `runBlocking` 在 IO 作用域**
- 位置：`AndroidMangaSourceManager.kt:128`、`MangaExtensionLoader.kt:177`、`NotificationReceiver.kt` 等。
- 说明：都在 IO 作用域，非主线程，风险低；仅作审计记录，不必优先动。

---

## 四、流畅度专项（"还能提升吗"——能，且可量化）

| 优化点 | 现在 | 优化方案 | 预期效果 |
|---|---|---|---|
| **图片 transform 线程** | `JsImageEngine.transform` 在 JS 线程串行（`transformLock`） | 把重 `modifyImage` 调度到专用单线程池（同 `JsPool`）；对相同内容做 **content-hash 缓存**（同一张乱序图不重复变换） | 读图加载更顺，重图源（如 goda 打散图）翻页不卡 |
| **重 JS 隔离** | compute/大解析在主 JS 线程 | 见问题 2，独立池 | 列表/图片不再被重活挤占 |
| **首启速度** | 依赖 baseline-prof 是否打入 | 见问题 6，生成并绑定 baseline profile + R8 | 冷启、切 tab 更跟手 |
| **升级自愈** | 见问题 5 | 源升级触发重同步 | 减少"以为没修好"的反复拉取与困惑 |
| **导航切换** | 切 tab 时各 ScreenModel 是否做重 init 需确认 | 确认 `warmMeta()` 结果已缓存、切 tab 不重复 eval；保持 S33 轻转场 | 切底部导航不顿 |

**评估**：此前卡顿主因（主线程 eval、每次重组重算、withFrameNanos 常驻）**已消除**，所以"切页/切 tab 卡"的体感应已大幅改善。剩余流畅度收益来自**图片变换池化 + baseline profile + 升级自愈**三处，属于"更顺"而非"从卡到不卡"。

---

## 五、可执行修复方案（按优先级）

1. **P0（正确性）**：实现 `cookie()` 接 `AndroidCookieJar` 并落盘 —— `JsMessageDispatcher.kt:735-736`。
2. **P1（流畅度）**：`delay` 改走 `delayAsync` —— `JsMessageDispatcher.kt:127`。
3. **P1（流畅度）**：新增专用 JS 单线程池，迁移 `compute` 与重 `modifyImage` 调度 —— `JsMessageDispatcher.kt:141` + `JsImageEngine.kt`。
4. **P1（体验）**：源升级后标记存量 manga 需重同步 —— `JsSourceUpdater.kt` + `MangaScreenModel.init`。
5. **P2（诊断）**：`log` 接 logcat —— `JsMessageDispatcher.kt:235`。
6. **P2（发布）**：release 开 R8 + 生成 baseline profile —— `app/build.gradle.kts` + `macrobenchmark`。
7. **验证**：沿用现有 `ref-quickjs-android/verify_*.js` 台子；设备侧用 `adb run-as <pkg> cat databases/tachiyomi.db*` 直读、用 JS 源列表里的 name/version 自证版本。

---

## 六、避坑清单（改动时务必记住）

- **改桥必须先跑全套 `verify_*.js`**（`ref-quickjs-android/` 台子），尤其改 `JsMessageDispatcher` / `init.js` 后。
- **`init.js` 三份副本必须同步**（vendor / `js-source/src/main/assets` / `ref-quickjs-android/samples`），改一处漏一处必出诡异 bug。
- **本地打补丁的源版本号必须高于上游**，否则 `isRepoNewer` 会判为"有更新"把你修复覆盖掉（S38）。
- **JS 源升级不会自动修复已入库漫画**（S41），验证时别只盯新漫画，要看老漫画是否自愈。
- **`transform` 绝不能持 `lock` 跨 eval**（S16），否则真机死锁；任何图片相关改动都守住这条。
- **别再引入 `withFrameNanos` 常驻 awaiter**（S34），量帧只用 `JankStats`。

---

## 七、实施状态（2026-10-04 已落地）

改动全部集中在 `aniyomi/js-source/.../js/JsMessageDispatcher.kt`，`:app:assembleDebug --offline -x lint` **构建通过**。

| 报告条目 | 状态 | 实际做法 |
|---|---|---|
| 问题 1 `cookie`（P0） | ✅ 已修 | get/set/delete 接 `network.cookieJar`（`AndroidCookieJar`）。get 返回 `List<Map<String,String>>`（`{name,value,domain}`，经 JSON→`parseJSON` 变成 JS 真对象数组）；set 的 domain 缺省回退 `url.host` |
| 问题 3 同步 `delay`（P1） | ✅ 已加固 | 新增 `delaySync()`，sleep **上限 60s**（对齐 shim 的 `__delay_async` 上限）并告警 |
| 问题 4 `log`（P2） | ✅ 已修 | 按 level 转发 Log.e/w/i/d，格式 `[title] content`；**故意不写进 JsDebugLog**（那是浮层，源日志太吵） |
| 问题 2 `compute`（P1） | ⚠️ 部分 | 改为显式记录"不支持"而非静默 `null`。**真正的 JsPool 无法这样实现**：JS 函数值跨桥会被丢弃（S5），QuickJS context 只能由创建它的线程触碰（S2）⇒ 只能在**当前**引擎重入，没有可卸载的目标。当前索引无源使用 |
| 问题 5 DB 升级自愈（P1） | ❌ 未做 | 见下方说明 |
| 问题 6 baseline profile / R8（P2） | ❌ 未做 | 见下方说明 |

### 为什么问题 5（升级自愈）没动
彻底修需要给 manga 加"上次同步时的源版本"字段 ⇒ **DB 迁移**，对 2700+ 条数据风险偏高。
且 `MangaScreenModel.kt:224-225` 是 `needRefreshInfo = !manga.initialized` / `needRefreshChapter = chapters.isEmpty()`，
只置 `initialized=false` **只能修"未知作者"，修不了乱序**（章节非空 ⇒ `needRefreshChapter` 仍为 false）。
目前**下拉刷新**仍是修乱序的唯一入口（`fetchAllFromSource(manualFetch=true)`）。

### 为什么问题 6（baseline profile / R8）没动
baseline profile 要真机跑 `macrobenchmark` 才能生成，且你日常装的 debug 包**本就不开 R8** —— 这两项在当前环境做不了，属于"上 release 包时再处理"。

### 补充认知（修正了报告里的两处推断）
- **`delay` 的同步 sleep 其实只是兜底**：shim 的 `BRIDGE_SHIM` 在 `__httpAsyncCap` 为真时**已把 `delay` 改写成
  `__delay_async`**，所以真正的卡顿风险早已被异步腿覆盖。同步路径必须继续 sleep —— `delay` 属于
  `__SYNC_METHODS`（返回裸值而非 Promise），直接返回会让 `setTimeout` 立刻触发、毁掉源的重试退避。
- **`cookie`/`delay`/`log` 都在 `__SYNC_METHODS` 里** ⇒ 它们拿到的是**裸值**而不是 Promise，这决定了实现时
  必须直接返回对象/数组（走 JSON 序列化），不能返回 Promise 语义的东西。
