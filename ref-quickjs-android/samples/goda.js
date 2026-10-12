/**
 * 章节图片解码器 — 移植自 keiyoushi/extensions-source (PR #16898)
 *
 * /api/v2/chapter/getinfo 接口返回的图片列表是混淆后的字符串，而非普通数组。
 * 此解码器将该字符串还原为原始 JSON 图片数组。
 *
 * 解码流程：去除 "J7r" 前缀 / "nQ" 后缀 → 按 "kD" 和 "W4s" 标记拆分为 3 段
 * → 重新排序为 段3+段1+段2 → 每隔一个 7 字符块反转 → 将自定义字母表映射回
 * 标准 base64url → base64 解码 → UTF-8 JSON。
 */
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CUSTOM = "_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DECODE_PREFIX = "J7r";
const DECODE_MARKER1 = "kD";
const DECODE_MARKER2 = "W4s";
const DECODE_SUFFIX = "nQ";
const DECODE_GROUP = 7;

// 预计算的查找表：自定义字母表字符码 → 标准 base64url 字符码（-1 表示无效）
const DECODE_TABLE = new Array(128).fill(-1);
for (let i = 0; i < CUSTOM.length; i++) {
    DECODE_TABLE[CUSTOM.charCodeAt(i)] = STD.charCodeAt(i);
}

function decodeChapterImages(input) {
    if (typeof input !== "string" || !input.startsWith(DECODE_PREFIX) || !input.endsWith(DECODE_SUFFIX)) {
        throw "未知的章节数据格式";
    }
    const body = input.substring(DECODE_PREFIX.length, input.length - DECODE_SUFFIX.length);
    const payloadLen = body.length - DECODE_MARKER1.length - DECODE_MARKER2.length;
    if (payloadLen <= 0) {
        throw "未知的章节数据格式";
    }

    const aLen = Math.floor(payloadLen / 3);
    const bLen = Math.floor((payloadLen - aLen) / 2);
    const cLen = payloadLen - aLen - bLen;

    const part1 = body.substring(0, bLen);
    const marker1 = body.substring(bLen, bLen + DECODE_MARKER1.length);
    const part2 = body.substring(bLen + DECODE_MARKER1.length, bLen + DECODE_MARKER1.length + cLen);
    const marker2 = body.substring(bLen + DECODE_MARKER1.length + cLen, bLen + DECODE_MARKER1.length + cLen + DECODE_MARKER2.length);
    const part3 = body.substring(bLen + DECODE_MARKER1.length + cLen + DECODE_MARKER2.length);

    if (marker1 !== DECODE_MARKER1 || marker2 !== DECODE_MARKER2 || part3.length !== aLen) {
        throw "未知的章节数据格式";
    }

    // 重新排序：段3 + 段1 + 段2
    const reordered = part3 + part1 + part2;

    // 去锯齿：每隔一个 GROUP 长度的块做反转
    let unzigzagged = "";
    for (let i = 0, block = 0; i < reordered.length; i += DECODE_GROUP, block++) {
        const chunk = reordered.substring(i, Math.min(i + DECODE_GROUP, reordered.length));
        unzigzagged += (block % 2 === 1) ? chunk.split('').reverse().join('') : chunk;
    }

    // 将自定义字母表映射为标准 base64url
    let standard = "";
    for (let i = 0; i < unzigzagged.length; i++) {
        const code = unzigzagged.charCodeAt(i);
        const mapped = code < DECODE_TABLE.length ? DECODE_TABLE[code] : -1;
        if (mapped < 0) {
            throw "无效的章节数据字符";
        }
        standard += String.fromCharCode(mapped);
    }

    // Base64 解码（纯 JS 实现，venera 运行时不支持 atob）。先将 base64url 转为标准 base64。
    const standardBase64 = standard.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeBase64(standardBase64);
    return JSON.parse(json);
}

/**
 * 纯 JavaScript base64 解码器（venera 运行时缺少 atob）。
 * 将 base64 解码为字节字符，供 JSON 解析使用。
 */
function decodeBase64(str) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    str = str.replace(/=+$/, "");

    let result = "";
    let i = 0;
    while (i < str.length) {
        const enc1 = chars.indexOf(str.charAt(i));
        const enc2 = chars.indexOf(str.charAt(i + 1));
        const enc3 = str.charAt(i + 2) ? chars.indexOf(str.charAt(i + 2)) : -1;
        const enc4 = str.charAt(i + 3) ? chars.indexOf(str.charAt(i + 3)) : -1;

        if (enc1 < 0 || enc2 < 0) {
            throw "Invalid base64 character";
        }

        result += String.fromCharCode((enc1 << 2) | (enc2 >> 4));
        if (enc3 >= 0) {
            result += String.fromCharCode(((enc2 & 15) << 4) | (enc3 >> 2));
        }
        if (enc4 >= 0) {
            result += String.fromCharCode(((enc3 & 3) << 6) | enc4);
        }

        i += 4;
    }
    return result;
}

/** @type {import('./_venera_.js')} */
class Goda extends ComicSource {
  // 注意：标记为 [可选] 的字段如果不使用，应将其删除

  // 源名称
  name = "GoDa漫画"

  // 源唯一标识
  key = "goda"

  // ⚠️ 版本必须高于上游 venera-configs 的 goda.js（2026-10-10 实测上游仍是 1.2.1），
  // 否则宿主 JsSourceUpdater 判「有更新」会用上游脚本静默覆盖本地修复。
  version = "1.2.5"

  minAppVersion = "1.4.0"

  // 更新地址
  url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/goda.js"

  settings = {
    domains: {
      title: "域名",
      type: "input",
      default: "godamh.com"
    },
    api: {
      title: "API域名",
      type: "input",
      default: "v2.apikk.top"
    },
    image: {
      title: "图片域名",
      type: "input",
      default: "c-nd3-1.6wm.top"
    }
  }

  get baseUrl() {
    return `https://${this.loadSetting("domains")}`;
  }

  get apiUrl() {
    return `https://${this.loadSetting("api")}/api/v2`;
  }

  get imageUrl() {
    return `https://${this.loadSetting("image")}`;
  }

  get headers() {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
      "Referer": this.baseUrl
    };
  }

  parseComics(doc) {
    const result = [];
    for (let item of doc.querySelectorAll(".pb-2")) {
      const link = item.querySelector("a");
      const titleEl = item.querySelector("h3");
      const img = item.querySelector("img");
      if (link && titleEl && img && link.attributes["href"] && img.attributes["src"]) {
        result.push(new Comic({
          id: link.attributes["href"],
          title: titleEl.text,
          cover: img.attributes["src"]
        }));
      }
    }
    return result;
  }

  /**
   * 站点所有列表页共用同一套骨架：`<path>/page/<n>` + 卡片 `.pb-2` + 末位分页按钮是总页数。
   * 「热门」「最近更新」「筛选」三条路径最终都落到这里，差别只在 `path`。
   *
   * ### 站点的四条列表（2026-10-10 实测，见 ref-quickjs-android/probe_goda_lists.js）
   *
   *  | path               | 首页分区标题 | 内容                                   |
   *  |--------------------|--------------|----------------------------------------|
   *  | `/hots`            | 人氣排行     | 武炼巅峰 / 我独自升级 / 大王饶命 …      |
   *  | `/dayup`           | 熱門更新     | 被追放的转生重骑士 / 满级玩家的第100次回归 |
   *  | `/newss`           | 最新上架     | 八女帝全背叛 / 万倍返还 …               |
   *  | `/manga`           | （全部）     | **与 `/hots` 返回同一批数据**           |
   *
   * ⚠️ `/manga`（全部）与 `/manga-genre/hots`（热门漫画）分别是 `/hots`、`/dayup` 的镜像 ——
   * 站点只有三份真实排序，这是站点行为，不是源能修的。所以本源必须把 tab 指到
   * **语义正确的那条 path**，否则「热门 / 最近更新 / 筛选」看起来就是同一批数据。
   */
  async loadListPage(path, page) {
    let p = (path || "").trim();
    if (!p) {
      throw "空的列表路径";
    }
    if (!p.startsWith("/")) {
      p = "/" + p;
    }
    const res = await Network.get(`${this.baseUrl}${p}/page/${page}`, this.headers);
    if (res.status !== 200) {
      throw `Invalid status code: ${res.status}`;
    }
    const document = new HtmlDocument(res.body);
    let maxPage = null;
    try {
      maxPage = parseInt(document.querySelectorAll("button.text-small").pop().text.replaceAll("\n", "").replaceAll(" ", ""));
    } catch(_) {
      maxPage = 1;
    }
    return {
      comics: this.parseComics(document),
      maxPage: maxPage
    };
  }

  // 发现页列表
  explore = [
    {
      // 页面标题
      // title 用于标识页面，必须唯一
      title: this.name,

      /// multiPartPage 或 multiPageComicList 或 mixed
      type: "multiPartPage",

      load: async () => {
        const res = await Network.get(this.baseUrl, this.headers);
        const document = new HtmlDocument(res.body);
        const result = [{ title: "近期更新", comics: [], viewMore: null }];
        for (let item of document.querySelector(".pb-unit-md").querySelectorAll(".slicarda")) {
          result[0].comics.push(new Comic({
            id: item.attributes["href"],
            title: item.querySelector("h3").text,
            cover: item.querySelector("img").attributes["src"]
          }))
        }
        const cardlists = document.querySelectorAll(".cardlist");
        const hometitles = document.querySelectorAll(".hometitle");
        for (let i = 0; i < hometitles.length; i++) {
          result.push({
            title: hometitles[i].querySelector("h2").text,
            comics: this.parseComics(cardlists[i]),
            viewMore: {
              page: "category",
              attributes: {
                category: hometitles[i].querySelector("h2").text,
                param: hometitles[i].attributes["href"]
              },
            }
          });
        }
        return result;
      }
    }
  ]

  // 分类
  category = {
    /// 分类页标题，用于标识页面，必须唯一
    title: this.name,
    parts: [
      {
        // ⚠️ 这个 part 必须排在**最前面**。宿主的「最近更新」tab 取
        // `category.parts` 展平后**第一个带 categoryParams 的行**（`JsMangaSource.latestCategory`），
        // 所以组的第一项「最近更新」/ `/dayup` 就是那个 tab 的数据源。放在「类型」之后会让
        // 「最近更新」落到「全部」/`/manga` —— 而 `/manga` 与 `/hots` 是同一批数据，
        // 表现就是「热门和最近更新显示一样的」（用户报的现象）。
        name: "更新",
        type: "fixed",
        categories: [
          "最近更新",
          "最新上架"
        ],
        itemType: "category",
        categoryParams: [
          "/dayup",
          "/newss"
        ],
      },
      {
        name: "类型",
        type: "fixed",
        categories: [
          "全部",
          "韩漫",
          "热门漫画",
          "国漫",
          "其他",
          "日漫",
          "欧美"
        ],
        itemType: "category",
        categoryParams: [
          "/manga",
          "/manga-genre/kr",
          "/manga-genre/hots",
          "/manga-genre/cn",
          "/manga-genre/qita",
          "/manga-genre/jp",
          "/manga-genre/ou-mei"
        ],
      },
      {
        name: "标签",
        type: "fixed",
        categories: [
          "复仇",
          "古风",
          "奇幻",
          "逆袭",
          "异能",
          "宅向",
          "穿越",
          "热血",
          "纯爱",
          "系统",
          "重生",
          "冒险",
          "灵异",
          "大女主",
          "剧情",
          "恋爱",
          "玄幻",
          "女神",
          "科幻",
          "魔幻",
          "推理",
          "猎奇",
          "治愈",
          "都市",
          "异形",
          "青春",
          "末日",
          "悬疑",
          "修仙",
          "战斗"
        ],
        itemType: "category",
        categoryParams: [
          "/manga-tag/fuchou",
          "/manga-tag/gufeng",
          "/manga-tag/qihuan",
          "/manga-tag/nixi",
          "/manga-tag/yineng",
          "/manga-tag/zhaixiang",
          "/manga-tag/chuanyue",
          "/manga-tag/rexue",
          "/manga-tag/chunai",
          "/manga-tag/xitong",
          "/manga-tag/zhongsheng",
          "/manga-tag/maoxian",
          "/manga-tag/lingyi",
          "/manga-tag/danvzhu",
          "/manga-tag/juqing",
          "/manga-tag/lianai",
          "/manga-tag/xuanhuan",
          "/manga-tag/nvshen",
          "/manga-tag/kehuan",
          "/manga-tag/mohuan",
          "/manga-tag/tuili",
          "/manga-tag/lieqi",
          "/manga-tag/zhiyu",
          "/manga-tag/doushi",
          "/manga-tag/yixing",
          "/manga-tag/qingchun",
          "/manga-tag/mori",
          "/manga-tag/xuanyi",
          "/manga-tag/xiuxian",
          "/manga-tag/zhandou"
        ],
      }
    ],
    // ⚠️ 必须为 true：宿主的「热门」tab 只在 `enableRankingPage` 为真且 `categoryComics.ranking`
    // 声明了 options 时才走排行榜；否则回落到 `explore` —— 而 explore 是首页多分区被拍平的
    // 一锅粥（近期更新+熱門更新+人氣排行+最新上架），既不分页也不是「热门」。
    enableRankingPage: true,
  }

  /// 分类漫画加载
  categoryComics = {
    load: async (category, params, options, page) => {
      // `params` 来自 part 的 `categoryParams`；没有声明的 part（本源目前都有）回落到类别名。
      return this.loadListPage(params || category, page);
    },

    /**
     * 排行榜 —— 宿主的「热门」tab。
     *
     * `options` 是 `"value-text"`，**左侧是值**：宿主把它剥出来原样传给 `load()`
     * （`JsMangaSource.popularRankingOption`），所以值必须能直接拼进 URL。
     * 默认选中规则：优先 text 含「總/总」的，否则取第一个不带 `_` 的值 ⇒ 命中 `hots`。
     */
    ranking: {
      options: [
        "hots-人氣排行",
        "dayup-熱門更新",
        "newss-最新上架"
      ],
      load: async (option, page) => {
        return this.loadListPage(option, page);
      }
    }
  }

  /// 搜索相关
  search = {
    load: async (keyword, options, page) => {
      const res = await Network.get(`${this.baseUrl}/s/${keyword}?page=${page}`, this.headers);
      if (res.status !== 200) {
        throw `Invalid status code: ${res.status}`;
      }
      const document = new HtmlDocument(res.body);
      let maxPage = null;
      try {
        maxPage = parseInt(document.querySelectorAll("button.text-small").pop().text.replaceAll("\n", "").replaceAll(" ", ""));
      } catch(_) {
        maxPage = 1;
      }
      return {
        comics: this.parseComics(document),
        maxPage: maxPage
      };
    },
    // 是否启用标签建议
    enableTagsSuggestions: false,
  }

  /// 单部漫画相关
  comic = {
    onThumbnailLoad: (url) => {
      return {
        headers: this.headers
      }
    },
    loadInfo: async (id) => {
      // `id` 有两种形态，必须都吃得下：
      //   • `/manga/<slug>` —— 列表页 href 的原样值（正常路径）；
      //   • `<slug>`        —— **裸 slug**：历史入库数据。宿主 `SManga.url` 是漫画的身份键、
      //     写入后不再改写，所以早先（或从别处导入）产生的行会一直带着这种 id，
      //     而 `baseUrl + slug` 会拼出 `godamh.com<slug>`（**缺斜杠**）⇒ 
      //     `UnknownHostException: Unable to resolve host "godamh.comkaijuzhuanzhi…"`，
      //     表现是"这本漫画拉不出章节/下拉刷新报错"，但列表里的旧章节照常显示（来自 DB）。
      // 以 `/` 开头就当完整路径用（站点改前缀也不用改代码），否则补 `/manga/`。
      const pageUrl = id.startsWith("/") ? this.baseUrl + id : `${this.baseUrl}/manga/${id}`;
      const res = await Network.get(pageUrl, this.headers);
      if (res.status !== 200) {
        throw `Invalid status code: ${res.status}`;
      }
      const document = new HtmlDocument(res.body);

      const titleEl = document.querySelector(".text-xl");
      const title = titleEl ? (titleEl.text || "").trim().split("   ")[0] : "";

      const coverEl = document.querySelector(".object-cover");
      const cover = (coverEl && coverEl.attributes && coverEl.attributes["src"]) || "";

      const descEl = document.querySelector("p.text-medium");
      const description = descEl ? (descEl.text || "") : "";

      // 锚定到 #info 容器取作者/类型/标签三块，避免被页面其它 py-1 元素干扰；
      // 旧版页面无 #info 时回退到全局 div.py-1。
      const infos = document.querySelectorAll("#info div.py-1");
      const tags = { "作者": [], "类型": [], "标签": [] };
      const infoBlocks = infos.length >= 3 ? infos : document.querySelectorAll("div.py-1");
      if (infoBlocks && infoBlocks.length >= 3) {
        if (infoBlocks[0]) {
          for (let author of infoBlocks[0].querySelectorAll("a > span")) {
            let author_name = (author.text || "").trim();
            if (author_name.endsWith(",")) {
              author_name = author_name.slice(0, -1).trim();
            }
            if (author_name) tags["作者"].push(author_name);
          }
        }
        if (infoBlocks[1]) {
          for (let category of infoBlocks[1].querySelectorAll("a > span")) {
            let category_name = (category.text || "").trim();
            if (category_name.endsWith(",")) {
              category_name = category_name.slice(0, -1).trim();
            }
            if (category_name) tags["类型"].push(category_name);
          }
        }
        if (infoBlocks[2]) {
          for (let tag of infoBlocks[2].querySelectorAll("a")) {
            const tagText = (tag.text || "").replace("\n", "").replaceAll(" ", "").replace("#", "");
            if (tagText) tags["标签"].push(tagText);
          }
        }
      }

      // 提取漫画 ID —— 四层回退。站点改版频繁（data-mid 已在 #mangachapters → #bookmarkData
      // 之间迁移过一次），任何一层命中即可，最后的正则/标记兜底不依赖 DOM 解析。
      const readMid = (sel) => {
        const el = document.querySelector(sel);
        return el && el.attributes ? el.attributes["data-mid"] : null;
      };
      let mangaId = readMid("#bookmarkData") || readMid("#mangachapters");
      if (!mangaId) {
        // 兜底 A：直接扫原始 HTML，任何元素上的 data-mid 都算（选择器/DOM 形状无关）。
        const m = /data-mid\s*=\s*["']?(\d+)/.exec(res.body);
        if (m) mangaId = m[1];
      }
      if (!mangaId) {
        // 兜底 B：下载服务的 mid 路径（cloudme.one/refs/<mid>）。
        const m = /refs\/(\d+)/.exec(res.body);
        if (m) mangaId = m[1];
      }
      if (!mangaId) {
        // 错误串里带源版本：若设备报的是「[goda 1.2.1] …」这种形状，说明脚本被"检查更新"
        // 回滚成旧版了（本地修复版 vs 上游未跟进 ⇒ 版本门放行降级），而不是修复本身失效。
        throw `[goda ${this.version}] 无法获取漫画ID（页面 ${res.body.length} 字节，未找到 data-mid）`;
      }

      const jsonRes = await Network.get(`${this.apiUrl}/manga/get?mid=${mangaId}&mode=all&t=${Date.now()}`, this.headers);
      if (jsonRes.status !== 200) {
        throw `Invalid status code: ${jsonRes.status}`;
      }

      // 章节必须用 JS `Map` 且按 order 升序插入：
      //  · 宿主 `__plainValue` 只把 Map 转成**有序 [k,v] 对数组**；普通对象 `{}` 会退化成
      //    java.util.HashMap（哈希序），章节列表在设备上就是乱序（实测 510/271/512/269…）。
      //  · 宿主 `getChapterList` 把返回顺序当「旧→新」并用 index+1 当 chapter_number，
      //    乱序会同时毁掉显示顺序和章节编号。
      const chapters = new Map();
      try {
        const jsonData = JSON.parse(jsonRes.body);
        if (jsonData && jsonData["data"] && jsonData["data"]["chapters"]) {
          const list = jsonData["data"]["chapters"].slice();
          list.sort((a, b) => {
            const oa = a && a["attributes"] ? a["attributes"]["order"] : null;
            const ob = b && b["attributes"] ? b["attributes"]["order"] : null;
            // order 缺失时保持接口原序（稳定排序语义）。
            if (typeof oa !== "number" || typeof ob !== "number") return 0;
            return oa - ob;
          });
          for (let ch of list) {
            if (ch["id"] != null && ch["attributes"] && ch["attributes"]["title"] != null) {
              chapters.set(`${mangaId}@${ch["id"]}`, ch["attributes"]["title"]);
            }
          }
        }
      } catch (e) {
        throw "章节数据解析失败";
      }

      const recommend = [];
      for (let item of document.querySelectorAll("div.cardlist > div.pb-2")) {
        const recLink = item.querySelector("a");
        const recTitle = item.querySelector("h3");
        const recImg = item.querySelector("img");
        if (recLink && recTitle && recImg && recLink.attributes["href"] && recImg.attributes["src"]) {
          recommend.push(new Comic({
            id: recLink.attributes["href"],
            title: recTitle.text,
            cover: recImg.attributes["src"]
          }));
        }
      }
      return new ComicDetails({
        title: title,
        cover: cover,
        description: description,
        tags: tags,
        chapters: chapters,
        recommend: recommend,
      });
    },

    loadEp: async (comicId, epId) => {
      if (!epId || !epId.includes("@")) {
        throw "无效的章节ID";
      }
      const ids = epId.split("@");
      const res = await Network.get(`${this.apiUrl}/chapter/getinfo?m=${ids[0]}&c=${ids[1]}`, this.headers);
      if (res.status !== 200) {
        throw `Invalid status code: ${res.status}`;
      }
      let jsonData;
      try {
        jsonData = JSON.parse(res.body);
      } catch (e) {
        throw "章节数据解析失败";
      }

      // 空值安全检查：防止 API 返回异常数据结构导致崩溃
      if (!jsonData || !jsonData["data"] || !jsonData["data"]["info"]
          || !jsonData["data"]["info"]["images"]) {
        throw "章节图片数据为空";
      }
      const imagesRaw = jsonData["data"]["info"]["images"]["images"];

      let imagesList;
      if (typeof imagesRaw === "string") {
        // v2 API：混淆字符串 — 解码还原为 JSON 数组
        imagesList = decodeChapterImages(imagesRaw);
      } else if (Array.isArray(imagesRaw)) {
        // v1 API（向后兼容）：{url: "...", order: N} 数组
        imagesList = imagesRaw;
      } else {
        // 未知格式的图片数据
        throw "未知的图片数据格式";
      }

      const images = [];
      for (let i of imagesList) {
        if (i && i["url"]) {
          images.push(this.imageUrl + i["url"]);
        }
      }
      return { images };
    },

    // 是否启用标签翻译
    enableTagsTranslate: false,
  }
}
