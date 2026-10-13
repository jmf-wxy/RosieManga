# js-sources — 修改后的 JS 漫画源（专属位置）

本文件夹是 RosieManga 项目**修改后的 JS 漫画源**的专属存放位置。
搬迁自 `ref-quickjs-android/samples/`（2026-10-13），内容与 git HEAD 中的版本逐字节一致。

| 文件 | 来源 | 当前版本 |
| --- | --- | --- |
| `jm.js` | 禁漫天堂（jm） | 1.4.3 |
| `goda.js` | GoDa漫画（goda） | 1.2.5 |

## 最近的修改内容

**jm.js**

- 1.4.2：新增 `parseBody()`，剥离 API 响应信封前导的 UTF-8 BOM（EF BB BF）——站点 2026-10-07 起给 API 信封加 BOM，QuickJS `JSON.parse` 会抛 unexpected character。
- 1.4.3：`apiDomain` / `imageStream` 选项补 `text` 标签（此前只声明 `value`，宿主渲染 `text ?: value` 会显示裸索引）；新增 `lang = "zh"`。

**goda.js**

- 1.2.5：三个入口分离（热门 / 最新更新 / 分类各自独立，不再共用一个 load）；新增 `lang = "zh"`。

## 版本治理规则

**本地版本必须高于上游 [venera-configs](https://github.com/venera-app/venera-configs) 中的同名源，否则会被仓库版静默覆盖。**
每次改动源文件后，记得同步提升文件头部的 `version` 字段。

## 推到设备的方法

```bash
adb push js-sources/jm.js /data/local/tmp/
adb shell run-as xyz.jmir.tachiyomi.mi.dev cp /data/local/tmp/jm.js files/comic_source/jm.js
```

（包名以实际调试包为准；`/data/local/tmp` 是临时中转，`run-as` 以应用身份拷入私有目录。）

## 不在这里的东西

- **`init.js` 胶水层不在本文件夹**。它有三副本同步约束，三个副本必须保持一致：
  - `ref-quickjs-android/samples/init.js`
  - `vendor/js-source/init.js`
  - `aniyomi/js-source/src/main/assets/init.js`
- `ref-quickjs-android/samples/` 下剩下的 HTML / JSON 夹具（goda_home.html、goda_*_chapters.json 等）是回归台子的回放素材，留在原处不动。
