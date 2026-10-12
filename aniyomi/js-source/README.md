# `:js-source` 模块

在 Aniyomi（Android / Kotlin）中引入 **Venera 式 JavaScript 漫画源** 能力，与原有的 Kotlin 扩展源**并存**。

---

## ⚖️ 许可证状态（重要）

**本项目已公开发布（公开 GitHub 仓库），因此属于 GPLv3 意义上的「分发 / convey」，整体以 GPL-3.0 授权。**

| 来源 | 许可证 | 本模块中的使用 |
|---|---|---|
| **Aniyomi**（基座工程） | Apache-2.0 | 作为基座被修改/扩展；`aniyomi/LICENSE` 原文保留 |
| **Venera**（JS 源机制来源） | **GPL-3.0** | `assets/init.js` 为其原文副本 |
| **本项目自有代码**（`:js-source` 及根仓库其余部分） | **GPL-3.0** | 见仓库根目录 [`LICENSE`](../../LICENSE) |

`assets/init.js` 复制自 [venera-app/venera](https://github.com/venera-app/venera) 的 `assets/init.js`，该仓库以 **GPL-3.0** 授权，许可证全文见
[`THIRD-PARTY-LICENSES/Venera-GPL-3.0.txt`](./THIRD-PARTY-LICENSES/Venera-GPL-3.0.txt)（与根目录 `LICENSE` 同一份文本）。

> 注：Apache-2.0 与 GPL-3.0 兼容（FSF 认定 Apache-2.0 可并入 GPLv3 作品），两者结合无法律障碍；
> Aniyomi 部分的文件仍可依其原始 Apache-2.0 条款使用。

### 历史沿革：从「自用豁免」到「整体开源」

本项目最初按**个人自用（personal use only）** 定位开发，未对外分发，因而 GPLv3 **§2** 的自用豁免适用：

> You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force.

即：**只要不向他人交付（convey / distribute），就无需公开源码、无需以 GPL 授权自己的代码、无需附带许可证。**

**该阶段已结束。** 按分发红线，以下行为均会触发 GPL 义务，而本项目现已落入其中：

| 行为 | 是否触发 GPL 义务 |
|---|---|
| 自己编译、自己改、装自己手机 | ❌ 不触发 |
| 发 APK 给朋友 / 家人 | ✅ **触发** |
| 上传网盘、发群、发论坛、发 GitHub Release | ✅ **触发** |
| **公开 GitHub 源码仓库** | ✅ **触发（当前状态）** |
| 上架任何应用商店 | ✅ **触发** |

因此当前已按 §2 要求履行：① 公开完整对应源码；② 保留 Apache-2.0 与 GPL-3.0 的版权声明；③ 未添加与 GPL 冲突的授权限制。

### ⚠️ 后续若继续分发，仍需注意

- **闭源广告 SDK 冲突**：接入穿山甲 / 优量汇 / AdMob 等闭源 SDK，GPLv3 要求整个组合作品可 GPL 化，而闭源 SDK 不可 → 构成 GPL 违规。
- **Apple App Store**：GPL 应用受 Apple ToS 限制，**无法上架**。
- **品牌**：Aniyomi / Mihon 社区惯例 fork 需改名换图标。

---

## 目录结构

```
js-source/
├── build.gradle.kts
├── AndroidManifest.xml
├── README.md                        ← 本文件
├── THIRD-PARTY-LICENSES/
│   └── Venera-GPL-3.0.txt           ← Venera 原始 GPL-3.0 全文
└── src/main/
    ├── assets/
    │   └── init.js                  ← 复制自 Venera（GPL-3.0），JS 侧 API 胶水层
    └── java/eu/kanade/tachiyomi/source/manga/js/
        ├── JsEngine.kt              ← QuickJS 引擎封装 + 加载 init.js
        ├── JsMessageDispatcher.kt   ← 对应 Venera Dart 侧 _messageReceiver 的消息分发器
        ├── JsMangaSource.kt         ← : CatalogueSource 适配器
        └── JsSourceManager.kt       ← JS 源注册表
```

---

## 技术要点

- **JS 引擎**：`wang.harlon.quickjs:wrapper-android:3.2.0`
  （选它而非 Aniyomi 内置的 `app.cash.quickjs`，因为后者仅支持 `evaluate` 返回原始类型，**无 Java 回调能力**，做不了 `sendMessage` 同步桥。）
- **桥接原理**：Venera 的 JS 侧全部 API 都建立在唯一原语 `sendMessage({method, ...})` 之上；
  Kotlin 侧只需实现这一个分发器，`init.js` 与所有 `*.js` 漫画源即可**原样复用**。
- **接入方式**：只要对象实现 `CatalogueSource` 并注册进 `MangaSourceManager.sourcesMapFlow`，
  Browse / 全局搜索 / 书架 / 阅读器全链路即可透明使用，**无需修改 UI**。

详细设计与里程碑见 `docs/IMPLEMENTATION_PLAN.md`。

---

## ⚠️ 当前状态

骨架已进入**可用状态**：`:app:assembleDebug` 与 `:app:assembleRelease` 均已构建通过，
JS 源（JM 禁漫天堂 / GoDa 漫画）在真机上可正常浏览、搜索、翻页、解密打散图。

回归基线是 `ref-quickjs-android/` 下的 25 个 `verify_*.js`（Node 台子，改动 `JsMessageDispatcher`
或 `init.js` 前后必跑，要求 0 失败）。

构建环境搭建见 `docs/BUILD_SETUP.md`；架构分层与剩余计划见
`docs/ARCHITECTURE_AND_REMAINING_PLAN.md`。
