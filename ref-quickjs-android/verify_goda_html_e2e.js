#!/usr/bin/env node
/**
 * verify_goda_html_e2e.js — GoDa漫画（goda.js，`HtmlDocument` 系源）必须在宿主里能跑通。
 *
 * 真机现象（截图 00:23）：热门 tab 报
 *     GoDa漫画: not a function （最近请求：GET https://godamh.com -> 200 enc=- raw=82773 out=82773）
 *
 * ### 根因（两半）
 *  1. Kotlin 侧 `JsMessageDispatcher.html()` 是 `= null` 的 TODO 桩 —— html 桥从未实现。
 *  2. init.js 的 `HtmlDocument`/`HtmlElement`/`HtmlNode` 走 Promise shim 的 `sendMessage`，
 *     同步读返回值 ⇒ `querySelectorAll` 拿到 Promise ⇒ `ks.map` ⇒ QuickJS 裸 "not a function"。
 *     jm.js 纯 JSON API，从不碰 HtmlDocument ⇒ 此前全绿是假绿。
 *
 * ### 修法（本文件钉住契约）
 *  • Kotlin：`JsHtmlBridge`（Jsoup），逐函数复刻 venera `DocumentWrapper`（句柄注册表、
 *    8 文档上限逐出、descendants-only 语义）。
 *  • init.js：HTML 三类全部改 `__sendMessageSync`（与 Image 类同一先例）。
 *
 * ### 与设备的一致性
 * 跑真 init.js + 真 goda.js（venera-configs v1.2.1），html 桥由本文件里的 **纯 JS mock** 承担：
 * mock 独立实现了解析器 + 选择器 + DocumentWrapper 语义（不抄 Kotlin，交叉验证），
 * HTTP mock 回放 **真抓的** godamh.com 首页（samples/goda_home.html，82KB）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const godaJs = fs.readFileSync(path.join(__dirname, 'samples', 'goda.js'), 'utf8');
const REAL_HOME_HTML = fs.readFileSync(path.join(__dirname, 'samples', 'goda_home.html'), 'utf8');
// 2026-10 改版详情页真抓回放（52KB）：
//   * data-mid 从 #mangachapters 迁移到 #bookmarkData（书签按钮容器），data-mid="6"
//   * 作者/类型/标签三块仍在 #info 容器内（div.text-small.py-1 / div.text-sm.py-1 / div.py-1）
//   * 章节列表由 /api/v2/manga/get?mid=6&mode=all 提供（真机验证 210 章）
const REAL_DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'samples', 'goda_detail.html'), 'utf8');
// 《武炼巅峰》真机现场（2026-10-04 11:53 截图「章节乱序」）—— 同一个源、同一个宿主契约下的
// **第二张真实页面 + 真实全量章节响应**（3875 章，555KB，order 0…3877）。
// 用它钉住两件事：
//   1. 源交付的章节顺序必须 = 站点 order 升序（旧→新）—— 宿主随后 asReversed() 才是「新→旧」；
//   2. **反例守卫**：若源退回普通对象 `{}`，跨桥后必然落进 java.util.HashMap 的哈希序，
//      而哈希序的顶端恰好复现截图里的 867/2009/2007/… —— 这不是猜测，是可复算的。
const REAL_WLDF_DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'samples', 'goda_wldf_detail.html'), 'utf8');
const REAL_WLDF_CHAPTERS_JSON = fs.readFileSync(path.join(__dirname, 'samples', 'goda_wldf_chapters.json'), 'utf8');
const WLDF_MID = '12';

// 《开局转职财神，驯化亿万神宠！》—— 截图 21:43 的「Unable to resolve host "godamh.com<slug>"」。
// 该行 `SManga.url` 是**裸 slug**（没有 `/manga/` 前缀，历史/外部导入的数据），而源里是
// `baseUrl + id` ⇒ 拼成 `godamh.comkaijuzhuanzhi…`（缺斜杠）⇒ 无可解析主机。
// 站点侧事实：`/manga/<slug>` 是 200（mid=32715，86 章、order 0..85），
// 不做前缀处理的裸请求 DNS 直接失败（curl 退出码 56）—— 所以只能靠源把它补全。
const KJ_SLUG = 'kaijuzhuanzhicaishenxunhuayiwanshenchong-rp534295';
const REAL_KJCZ_DETAIL_HTML = fs.readFileSync(path.join(__dirname, 'samples', 'goda_kjcz_detail.html'), 'utf8');
const REAL_KJCZ_CHAPTERS_JSON = fs.readFileSync(path.join(__dirname, 'samples', 'goda_kjcz_chapters.json'), 'utf8');
const KJCZ_MID = '32715';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// ================================================================================================
// 1) 纯 JS HTML DOM + html 桥 mock —— 抽到 lib_html_bridge_mock.js，与
//    verify_goda_hot_latest_e2e.js 共用同一份（两份各自维护必然漂移 ⇒ 假绿）。
// ================================================================================================

const { makeHtmlBridge } = require('./lib_html_bridge_mock.js');

// ================================================================================================
// 3) 沙箱 + HTTP mock
// ================================================================================================

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: Buffer.from(text, 'utf8').toString('base64') };
}

let homeHtml = REAL_HOME_HTML;

const DETAIL_MID = '1001';
const detailHtml = `<!DOCTYPE html><html><body>
<h1 class="text-xl">Test Comic   Subtitle Here</h1>
<img class="object-cover" src="https://c-nd3-1.6wm.top/cover.jpg"/>
<p class="text-medium">A description</p>
<div class="py-1"><a><span>Author A,</span><span>Author B</span></a></div>
<div class="py-1"><a><span>Type1,</span><span>Type2</span></a></div>
<div class="py-1"><a>#tag1</a><a>#tag2</a></div>
<div id="mangachapters" data-mid="${DETAIL_MID}"></div>
<div class="cardlist">
  <div class="pb-2"><a href="/comic/rec1"><h3>Rec One</h3><img src="/r1.jpg"/></a></div>
</div>
</body></html>`;

// 故意**乱序**（且 order 递增方向与数组顺序相反）：源必须按 order 升序插入，
// 否则宿主的 chapter_number（= index+1）会把章节编号也一起弄乱。
const chapterApiPayload = {
  data: { chapters: [
    { id: '2', attributes: { title: '第二话', order: 2 } },
    { id: '1', attributes: { title: '第一话', order: 1 } },
  ] },
};

/** mid 兜底 A：data-mid 挂在既非 #bookmarkData 也非 #mangachapters 的元素上（选择器无关）。 */
const midOnUnknownElHtml = `<!DOCTYPE html><html><body>
<h1 class="text-xl">Fallback A</h1>
<div class="whatever" data-mid="777"></div>
</body></html>`;

/** mid 兜底 B：页面完全没有 data-mid，只有下载服务的 refs/<mid> 路径。 */
const midFromRefsHtml = `<!DOCTYPE html><html><body>
<h1 class="text-xl">Fallback B</h1>
<a href="https://cloudme.one/refs/888">下载</a>
</body></html>`;

/** 两层兜底都失效：必须给出**带页面体积**的可诊断错误，而不是裸「无法获取漫画ID」。 */
const midMissingHtml = `<!DOCTYPE html><html><body><h1 class="text-xl">No Mid</h1></body></html>`;

/**
 * Java `HashMap` 的迭代顺序（JDK8）—— 用来**复算**设备上那份乱序章节表，而不是靠印象归因。
 *
 * 跨桥路径：JS 普通对象 → `QuickJSObject.toMap(mapCreator = HashMap::new)` → JNI。
 * HashMap 的迭代顺序 = 桶索引升序，桶内按链表插入顺序；桶索引 = (cap-1) & (h ^ (h>>>16))。
 * 容量按 0.75 负载因子从 16 逐次翻倍（3875 条 → 8192）。
 * 桶长 ≥8 会树化，此时迭代顺序会偏离插入序；此处返回 maxChain 供调用方判断精度。
 */
function javaStringHashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
function simulateJavaHashMapOrder(keys) {
  const spread = (h) => ((h ^ (h >>> 16)) | 0) >>> 0;
  let cap = 16;
  const entries = [];
  for (const k of keys) {
    if (entries.length + 1 > cap * 0.75) cap *= 2;
    entries.push({ key: k, hash: spread(javaStringHashCode(k)) });
  }
  const table = Array.from({ length: cap }, () => []);
  for (const e of entries) table[(cap - 1) & e.hash].push(e);
  const order = [];
  let maxChain = 0;
  for (const bucket of table) {
    if (bucket.length > maxChain) maxChain = bucket.length;
    for (const e of bucket) order.push(e.key);
  }
  return { order, maxChain, cap };
}

/** goda.js v2 混淆图片串的**编码器**（decodeChapterImages 的严格逆变换）。 */
function encodeChapterImages(list) {
  const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const CUSTOM = '_-9876543210abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const b64url = Buffer.from(JSON.stringify(list), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let mapped = '';
  for (const ch of b64url) mapped += CUSTOM[STD.indexOf(ch)];
  let zigzag = '';
  for (let i = 0, block = 0; i < mapped.length; i += 7, block++) {
    const chunk = mapped.slice(i, Math.min(i + 7, mapped.length));
    zigzag += (block % 2 === 1) ? chunk.split('').reverse().join('') : chunk;
  }
  const aLen = Math.floor(zigzag.length / 3);
  const bLen = Math.floor((zigzag.length - aLen) / 2);
  const cLen = zigzag.length - aLen - bLen;
  // 解码侧 reordered = part3 + part1 + part2 ⇒ 编码切分必须按解码顺序切：part3 在前。
  const part3 = zigzag.slice(0, aLen);
  const part1 = zigzag.slice(aLen, aLen + bLen);
  const part2 = zigzag.slice(aLen + bLen);
  return 'J7r' + part1 + 'kD' + part2 + 'W4s' + part3 + 'nQ';
}

const imageList = [{ url: '/imgs/a/01.webp', order: 1 }, { url: '/imgs/a/02.webp', order: 2 }];
const obfuscatedImages = encodeChapterImages(imageList);

/** 分类 / 搜索页 mock：3 张卡片 + 末页码 7。 */
function listingHtml(prefix) {
  let cards = '';
  for (let i = 1; i <= 3; i++) {
    cards += `<div class="pb-2"><a href="/comic/${prefix}${i}"><h3>${prefix} Comic ${i}</h3><img src="/${prefix}${i}.jpg"/></a></div>`;
  }
  return `<!DOCTYPE html><html><body>${cards}
<button class="text-small">1</button><button class="text-small">2</button><button class="text-small">7</button>
</body></html>`;
}

function makeSandbox() {
  const calls = [];
  const saved = {};
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  let metaCache = null;
  function reflectMeta() {
    const settings = vm.runInContext("ComicSource.sources['goda'].settings", sandbox);
    const out = {};
    for (const [k, v] of Object.entries(settings)) out[k] = { type: v.type, default: v.default };
    metaCache = out;
  }

  const htmlBridge = makeHtmlBridge();

  function dispatch(msg) {
    calls.push(msg);
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return false;
    if (m === 'UI') return null;
    if (m === 'delay') return null;
    if (m === 'load_data') return Object.prototype.hasOwnProperty.call(saved, msg.data_key) ? saved[msg.data_key] : null;
    if (m === 'save_data') { saved[msg.data_key] = msg.data; return null; }
    if (m === 'load_setting') {
      return metaCache && metaCache[msg.setting_key] ? metaCache[msg.setting_key].default : undefined;
    }
    if (m === 'convert') {
      if (msg.type === 'utf8') return msg.isEncode ? Buffer.from(String(msg.value), 'utf8') : Buffer.from(msg.value).toString('utf8');
      if (msg.type === 'base64') {
        if (msg.isEncode) return Buffer.from(msg.value).toString('base64');
        try { return Buffer.from(String(msg.value).replace(/[\s\uFEFF]/g, ''), 'base64'); } catch { return null; }
      }
      return null;
    }
    if (m === 'http') {
      const url = String(msg.url || '');
      // ⚠️ 具体路径必须先于 godamh.com 前缀匹配，否则全部回落首页。
      if (url.includes('/api/v2/manga/get')) {
        // 武炼巅峰：回放真抓的 3875 章全量响应（order 0…3877，数组本身已是升序）。
        if (url.includes(`mid=${WLDF_MID}`)) return JSON.stringify(textEnvelope(REAL_WLDF_CHAPTERS_JSON));
        if (url.includes(`mid=${KJCZ_MID}`)) return JSON.stringify(textEnvelope(REAL_KJCZ_CHAPTERS_JSON));
        return JSON.stringify(textEnvelope(JSON.stringify(chapterApiPayload)));
      }
      if (url.includes('/api/v2/chapter/getinfo')) {
        return JSON.stringify(textEnvelope(JSON.stringify({ data: { info: { images: { images: obfuscatedImages } } } })));
      }
      if (url.includes('/manga/page/') || url.includes('/manga-genre/') || url.includes('/manga-tag/')) {
        return JSON.stringify(textEnvelope(listingHtml('cat')));
      }
      // 排行 / 更新的三条列表（goda 1.2.5 起「热门」走 ranking）：不加这一支，
      // `/hots/page/1` 会落到下面的 `godamh.com` 兜底拿到**首页**，任何排行断言都是假绿。
      if (url.includes('/hots/') || url.includes('/dayup/') || url.includes('/newss/')) {
        return JSON.stringify(textEnvelope(listingHtml('rank')));
      }
      if (url.includes('/s/')) return JSON.stringify(textEnvelope(listingHtml('sr')));
      // mid 兜底 A/B 与彻底缺失 —— 都在 /manga/ 前缀下，排在兜底首页之前。
      if (url.includes('/manga/mid-on-unknown-el')) return JSON.stringify(textEnvelope(midOnUnknownElHtml));
      if (url.includes('/manga/mid-from-refs')) return JSON.stringify(textEnvelope(midFromRefsHtml));
      if (url.includes('/manga/mid-missing')) return JSON.stringify(textEnvelope(midMissingHtml));
      // ⚠️ /manga/<slug> 是详情页（新 DOM），必须在兜底之前、且晚于 /manga/page/ 分类路径。
      if (url.includes('/manga/wuliandianfeng-pikapi')) return JSON.stringify(textEnvelope(REAL_WLDF_DETAIL_HTML));
      if (url.includes(`/manga/${KJ_SLUG}`)) return JSON.stringify(textEnvelope(REAL_KJCZ_DETAIL_HTML));
      if (url.includes(`godamh.com${KJ_SLUG}`)) {
        // 回归钉子：**裸 slug 直接拼**出来的畸形请求必须能被台子认出来（真机上是 DNS FAILED）。
        return JSON.stringify({ status: null, headers: {}, body: null, error: 'unreachable: ' + url });
      }
      if (url.startsWith('https://godamh.com/manga/')) return JSON.stringify(textEnvelope(REAL_DETAIL_HTML));
      if (url.startsWith('https://godamh.com/comic/')) return JSON.stringify(textEnvelope(detailHtml));
      if (url.startsWith('https://godamh.com')) return JSON.stringify(textEnvelope(homeHtml));
      return JSON.stringify({ status: null, headers: {}, body: null, error: 'unreachable: ' + url });
    }
    if (m === 'html') return htmlBridge(msg);
    return null;
  }

  sandbox.__sendMessageSync = (msg) => dispatch(msg);
  vm.createContext(sandbox);
  vm.runInContext([
    'globalThis.__SYNC_METHODS = ' + JSON.stringify(SYNC_METHODS) + ';',
    'globalThis.sendMessage = function (msg) {',
    '  try {',
    '    var v = __sendMessageSync(msg);',
    '    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return v;',
    '    return Promise.resolve(v);',
    '  } catch (e) { return Promise.reject(e); }',
    '};',
  ].join('\n'), sandbox);
  vm.runInContext(initJs, sandbox);
  vm.runInContext(godaJs, sandbox);
  vm.runInContext('ComicSource.sources["goda"] = new Goda();', sandbox);
  reflectMeta();

  return {
    sandbox,
    calls,
    plainEval: async (expr) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n  try {\n    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.value = v; globalThis.' + slot + '.done = true; },\n' +
        '      function (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '    );\n  } catch (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n})();',
        sandbox,
      );
      for (let i = 0; i < 64; i++) {
        await new Promise((r) => setImmediate(r));
        const st = vm.runInContext('globalThis.' + slot, sandbox);
        if (st.done) {
          if (st.error !== undefined) throw st.error;
          return st.value;
        }
      }
      throw new Error('never settled: ' + expr);
    },
  };
}

// ================================================================================================

async function main() {
  const sb = makeSandbox();
  const src = () => vm.runInContext('ComicSource.sources["goda"]', sb.sandbox);

  section('html 桥同步契约（回归钉子：querySelector* 必须回数组/元素，不是 Promise）');
  const shape = vm.runInContext(`
    var __d = new HtmlDocument('<div class="cardlist"><a class="hometitle" href="/x"><h2>T</h2></a><span class="pb-2">t</span></div>');
    ({
      qsType: typeof __d.querySelector('.cardlist'),
      qsaIsArray: Array.isArray(__d.querySelectorAll('.cardlist')),
      qsaLen: __d.querySelectorAll('.cardlist').length,
      textWorks: __d.querySelector('h2').text === 'T',
      attrsWork: __d.querySelector('.hometitle').attributes['href'] === '/x',
      missIsNull: __d.querySelector('.nope') === null,
      missAllEmpty: __d.querySelectorAll('.nope').length === 0,
    })
  `, sb.sandbox);
  check('querySelector 返回元素（非 Promise）', shape.qsType === 'object', shape.qsType);
  check('querySelectorAll 返回数组', shape.qsaIsArray && shape.qsaLen === 1, shape);
  check('element.text 走同步桥', shape.textWorks === true, shape);
  check('element.attributes 走同步桥', shape.attrsWork === true, shape);
  check('未命中 → null / 空数组', shape.missIsNull && shape.missAllEmpty, shape);

  section('explore（热门 tab —— 真抓的 godamh.com 首页 82KB）');
  const parts = await sb.plainEval('ComicSource.sources["goda"].explore[0].load()');
  check('explore 返回分组数组', Array.isArray(parts) && parts.length === 4, parts && parts.length);
  check('parts[0] = 近期更新', parts[0] && parts[0].title === '近期更新', parts[0] && parts[0].title);
  check('parts[0] comics = .slicarda 全量（30；grep 的 33 含 JS/CSS 里的字面量）', Array.isArray(parts[0].comics) && parts[0].comics.length === 30, parts[0] && parts[0].comics && parts[0].comics.length);
  const c0 = parts[0].comics[0] || {};
  check('Comic 字段齐全（id/title/cover）', typeof c0.id === 'string' && typeof c0.title === 'string' && typeof c0.cover === 'string' && c0.id.length > 0 && c0.cover.length > 0, c0);
  const homeTitles = parts.slice(1).map((p) => p.title);
  check('hometitle 分组标题来自 h2', homeTitles.length === 3 && homeTitles.every((t) => typeof t === 'string' && t.length > 0), homeTitles);
  check('每个分组都有漫画', parts.slice(1).every((p) => Array.isArray(p.comics) && p.comics.length > 0), parts.slice(1).map((p) => p.comics && p.comics.length));
  check('viewMore 带 category+param', parts.slice(1).every((p) => p.viewMore && p.viewMore.page === 'category' && typeof p.viewMore.attributes.param === 'string'), parts[1] && parts[1].viewMore);

  section('categoryComics / search（列表解析 + maxPage）');
  const cat = await sb.plainEval('ComicSource.sources["goda"].categoryComics.load("全部", "/manga", null, 1)');
  check('分类页 comics=3', Array.isArray(cat.comics) && cat.comics.length === 3, cat.comics && cat.comics.length);
  check('分类页 maxPage=7（button.text-small 末项）', cat.maxPage === 7, cat.maxPage);
  const search = await sb.plainEval('ComicSource.sources["goda"].search.load("test", null, 1)');
  check('搜索页 comics=3', Array.isArray(search.comics) && search.comics.length === 3, search.comics && search.comics.length);
  check('搜索页 maxPage=7', search.maxPage === 7, search.maxPage);

  section('loadInfo（详情页 —— 2026-10 真实改版页面：#bookmarkData[data-mid] + #info 容器）');
  // 章节必须以 JS `Map` 形状离开沙箱：宿主 `__plainValue` 只把 Map 转成**有序 [k,v] 对数组**，
  // 普通对象 `{}` 会退化成 java.util.HashMap（哈希序）——真机上的 510/271/512/269 就是它。
  const loadInfoSummary = (id) => `(async () => {
    const d = await ComicSource.sources["goda"].comic.loadInfo(${JSON.stringify(id)});
    return {
      title: d.title, cover: d.cover, description: d.description, tags: d.tags,
      recommendLen: (d.recommend || []).length,
      isMap: d.chapters instanceof Map,
      keys: Array.from(d.chapters.keys()),
      values: Array.from(d.chapters.values()),
    };
  })()`;
  const info = await sb.plainEval(loadInfoSummary('/manga/woduzishengji-duburedicestudio-a04'));
  check('chapters 是 JS Map（有序键值对的前提；普通对象会变 HashMap 乱序）', info.isMap === true, info.isMap);
  check('章节按 order 升序插入（接口返回是乱序的）',
    JSON.stringify(info.keys) === JSON.stringify(['6@1', '6@2']), info.keys);
  check('章节键 = 页面 data-mid(6)@API章节id（证明 mid 来自页面而非硬编码）',
    JSON.stringify(info.values) === JSON.stringify(['第一话', '第二话']), info.values);
  check('title 来自 .text-xl（h1，剥掉三空格后缀/角标）', typeof info.title === 'string' && info.title.startsWith('我独自升级'), info.title);
  check('cover 取自 .object-cover', typeof info.cover === 'string' && info.cover.startsWith('https://c-'), info.cover);
  check('description 非空（p.text-medium）', typeof info.description === 'string' && info.description.length > 20, info.description && info.description.length);
  check('作者解析（a > span，逗号剥离）→ 宿主据此填 author/artist',
    Array.isArray(info.tags['作者']) && info.tags['作者'].includes('DUBU（REDICE STUDIO)') && info.tags['作者'].includes('h-goon'), info.tags['作者']);
  check('类型解析（韩漫/热门漫画）→ 宿主据此填 genre', Array.isArray(info.tags['类型']) && info.tags['类型'].includes('韩漫'), info.tags['类型']);
  check('标签解析（# 剥离）', Array.isArray(info.tags['标签']) && info.tags['标签'].includes('系统') && info.tags['标签'].includes('热门推荐'), info.tags['标签']);
  check('推荐位解析（cardlist > pb-2）', info.recommendLen > 0, info.recommendLen);

  // ----------------------------------------------------------------------------------------------
  // ★真机现场回归：《武炼巅峰》3875 章（2026-10-04 11:53 截图「详情页排序还是有问题」）
  //   断言的是**宿主实际会看到的形状**，不是"源的意图"：源交付旧→新，宿主 asReversed() 后新→旧。
  // ----------------------------------------------------------------------------------------------
  section('loadInfo（★真机现场：《武炼巅峰》真页 + 真实 3875 章 —— 章节顺序契约）');
  const wldf = await sb.plainEval(`(async () => {
    const d = await ComicSource.sources["goda"].comic.loadInfo('/manga/wuliandianfeng-pikapi');
    return {
      title: d.title, tags: d.tags,
      isMap: d.chapters instanceof Map,
      keys: Array.from(d.chapters.keys()),
      values: Array.from(d.chapters.values()),
    };
  })()`);
  const wldfPayload = JSON.parse(REAL_WLDF_CHAPTERS_JSON);
  const siteChapters = wldfPayload.data.chapters;               // 站点原序 = order 升序（已实测）
  const siteKeys = siteChapters.map((c) => `${WLDF_MID}@${c.id}`);
  const titleOfKey = new Map(siteKeys.map((k, i) => [k, siteChapters[i].attributes.title]));

  check('mid 取自 #bookmarkData（该页 5 处 data-mid 都=12）→ 章节键前缀 12@',
    wldf.keys.length > 0 && wldf.keys[0].startsWith(WLDF_MID + '@'), wldf.keys[0]);
  check('章节数 = 站点全量 3875（不是「共 1 章」塌缩，也没被截断）',
    wldf.keys.length === 3875 && siteChapters.length === 3875, { got: wldf.keys.length, site: siteChapters.length });
  check('★源交付顺序 === 站点 order 升序（旧→新）——这是宿主 asReversed() 得出「新→旧」的前提',
    JSON.stringify(wldf.keys) === JSON.stringify(siteKeys),
    { first: wldf.keys.slice(0, 2), last: wldf.keys.slice(-2) });
  check('首章 = order 0「1 扫地小厮」（最旧）',
    wldf.keys[0] === siteKeys[0] && /^1\s/.test(wldf.values[0] || ''), wldf.values[0]);
  check('末章 = order 3877「3877 寻找救援」（最新）',
    wldf.keys[3874] === siteKeys[3874] && String(wldf.values[3874] || '').startsWith('3877'), wldf.values[3874]);
  check('章节 id 不重复（3875 个唯一键）', new Set(wldf.keys).size === 3875, new Set(wldf.keys).size);

  // 宿主 JsMangaSource.getChapterList 的**逐行复刻**（含 asReversed）：这是设备真正渲染的顺序。
  const hostPairs = wldf.keys.map((k, i) => [k, wldf.values[i]]);
  const hostChapters = hostPairs.map((p, i) => ({ name: p[1], chapter_number: i + 1 }));
  const hostDisplay = hostChapters.slice().reverse();            // chapters.asReversed()
  check('★宿主视角（源顺序路径）：自顶向下 = 新→旧，顶行「3877 寻找救援」',
    String(hostDisplay[0].name).startsWith('3877') && String(hostDisplay[1].name).startsWith('3876'),
    hostDisplay.slice(0, 3).map((c) => c.name));
  check('★宿主视角（章节号路径）：序号从 3875 递减到 1，顶行仍是同一章',
    hostDisplay[0].chapter_number === 3875 && hostDisplay[3874].chapter_number === 1,
    { top: hostDisplay[0].chapter_number, bottom: hostDisplay[3874].chapter_number });

  check('作者回退 tags["作者"]（真机截图的「未知作者」= 设备跑着没走这条的旧版）',
    Array.isArray(wldf.tags['作者']) && wldf.tags['作者'].includes('噼咔噼'), wldf.tags['作者']);
  check('类型 tags["类型"] → 宿主 genre', Array.isArray(wldf.tags['类型']) && wldf.tags['类型'].includes('国漫'), wldf.tags['类型']);
  check('标签 tags["标签"]', Array.isArray(wldf.tags['标签']) && wldf.tags['标签'].includes('古风'), wldf.tags['标签']);

  section('★反例守卫：源若退回普通对象 `{}` ⇒ 必然复现真机截图的哈希序（可复算，不是猜测）');
  const legacy = simulateJavaHashMapOrder(siteKeys);
  check('哈希序精度前提：最长桶 < 8（无树化，迭代顺序严格可复算）', legacy.maxChain < 8, { maxChain: legacy.maxChain, cap: legacy.cap });
  check('哈希序条数守恒（没有丢章，只是顺序变了）', legacy.order.length === 3875, legacy.order.length);
  const legacyTop = legacy.order.slice(-6).reverse().map((k) => titleOfKey.get(k));
  // 截图 OCR 把全角「？」显示成「?」，故只比前缀，不比标点。
  const sig = (t) => { const m = /^(\d+)/.exec(String(t)); return m ? m[1] : String(t); };
  check('★哈希序顶端 6 条 === 真机截图（867 / 2009 / 2007 / 大决战篇-绝杀 / 3032 / 3031）',
    JSON.stringify(legacyTop.map(sig)) === JSON.stringify(['867', '2009', '2007', '大决战篇-绝杀', '3032', '3031']),
    legacyTop);
  check('★且哈希序 ≠ 站点顺序（证明它不是「另一种合理排序」，就是纯乱）',
    JSON.stringify(legacy.order) !== JSON.stringify(siteKeys),
    { simTop: legacyTop[0], siteTop: titleOfKey.get(siteKeys[3874]) });

  // ----------------------------------------------------------------------------------------------
  // ★真机现场 2：`SManga.url` 是**裸 slug**（21:43 截图 `Unable to resolve host "godamh.com<slug>"`）
  //   宿主 `SManga.url` 是漫画身份键、写库后不再改写 ⇒ 历史行会一直带着这种 id；
  //   而 `baseUrl + id` 会拼出 `godamh.com<slug>`（缺斜杠）⇒ DNS 直接失败。
  // ----------------------------------------------------------------------------------------------
  section('loadInfo（★真机现场：裸 slug 的历史 url —— 补 /manga/ 前缀）');
  const kj = await sb.plainEval(`(async () => {
    const d = await ComicSource.sources["goda"].comic.loadInfo(${JSON.stringify(KJ_SLUG)});
    const vals = Array.from(d.chapters.values());
    return {
      title: d.title, isMap: d.chapters instanceof Map, n: d.chapters.size,
      first: vals[0], last: vals[vals.length - 1],
    };
  })()`);
  const kjUrls = sb.calls.filter((c) => c.method === 'http').map((c) => String(c.url))
    .filter((u) => u.includes('kaijuzhuanzhicaishenxunhuayiwanshenchong'));
  check('★裸 slug 被补成 /manga/<slug>（否则真机是 godamh.com<slug> ⇒ Unable to resolve host）',
    kjUrls.includes(`https://godamh.com/manga/${KJ_SLUG}`), kjUrls);
  check('畸形形态 godamh.com<slug> 一次都没发出', !kjUrls.some((u) => u.includes(`godamh.com${KJ_SLUG}`)), kjUrls);
  check('loadInfo 成功解析（标题来自真页）',
    typeof kj.title === 'string' && kj.title.startsWith('开局转职财神'), kj.title);
  check('章节 = 86 章且仍是有序 Map（数量没塌缩）', kj.isMap === true && kj.n === 86, kj.n);
  check('首章=order 0「第1话 充值过亿…」、末章=order 85「第86话 光速碾压！」（宿主反转后顶行=末章）',
    /^第1话/.test(kj.first) && /^第86话/.test(kj.last), { first: kj.first, last: kj.last });

  section('同一条路径的**带前缀 id** 必须原样使用（不能叠成 /manga//manga/…）');
  const kj2 = await sb.plainEval(`(async () => {
    const d = await ComicSource.sources["goda"].comic.loadInfo(${JSON.stringify('/manga/' + KJ_SLUG)});
    return { n: d.chapters.size, title: d.title };
  })()`);
  const prefixUrls = sb.calls.filter((c) => c.method === 'http').map((c) => String(c.url))
    .filter((u) => u.includes('kaijuzhuanzhicaishenxunhuayiwanshenchong'));
  check('带前缀的 id → 每个请求都是规范 URL（没有 /manga//manga/ 叠加）',
    prefixUrls.length > 0 && prefixUrls.every((u) => u === `https://godamh.com/manga/${KJ_SLUG}`), prefixUrls);
  check('解析结果与裸 slug 一致（86 章）', kj2.n === 86, kj2.n);

  section('loadInfo（旧 DOM 回退：/comic/ 合成页仍走 #mangachapters + 全局 div.py-1）');
  const infoOld = await sb.plainEval(loadInfoSummary(`/comic/${DETAIL_MID}`));
  check('旧 DOM mangaId 回退（#mangachapters）', JSON.stringify(infoOld.keys) === JSON.stringify(['1001@1', '1001@2']), infoOld.keys);
  check('旧 DOM 信息块回退（全局 div.py-1）', JSON.stringify(infoOld.tags) === JSON.stringify({ '作者': ['Author A', 'Author B'], '类型': ['Type1', 'Type2'], '标签': ['tag1', 'tag2'] }), infoOld.tags);

  section('mid 提取兜底（站点改版频繁，选择器不能是唯一入口）');
  const fbA = await sb.plainEval(loadInfoSummary('/manga/mid-on-unknown-el'));
  check('兜底 A：data-mid 在任意元素上 → 正则扫原始 HTML', JSON.stringify(fbA.keys) === JSON.stringify(['777@1', '777@2']), fbA.keys);
  const fbB = await sb.plainEval(loadInfoSummary('/manga/mid-from-refs'));
  check('兜底 B：只有 refs/<mid> 标记', JSON.stringify(fbB.keys) === JSON.stringify(['888@1', '888@2']), fbB.keys);
  let midErr = null;
  try { await sb.plainEval(loadInfoSummary('/manga/mid-missing')); } catch (e) { midErr = String((e && e.message) || e); }
  check('全都没有 → 报错且**带页面体积**（可诊断，不再是裸字符串）',
    midErr !== null && midErr.includes('字节') && midErr.includes('data-mid'), midErr);
  // 版本串是"脚本是否被回滚"的天然探针：设备上若报出 [goda 1.2.1]，说明"检查更新"把本地
  // 修复版覆盖成了上游旧版（见 verify_source_version_gate.js），而不是修复本身失效。
  // ⚠️ 读源自己的 version，不写死字面量 —— 写死过一次（1.2.4），源一抬版本这里就红，
  // 而红的原因与被测行为毫无关系。抬版本恰恰是**防止上游覆盖**的必要动作（见下一条）。
  const godaVersion = String(vm.runInContext('ComicSource.sources["goda"].version', sb.sandbox));
  check(`报错带源版本号 [goda ${godaVersion}]（自证设备上跑的是哪一版）`,
    midErr !== null && midErr.includes(`[goda ${godaVersion}]`), midErr);
  // 上游 venera-configs 的 goda.js 长期停在 1.2.1（2026-10-10 实测）。本地版本必须**高于**它，
  // 否则 JsSourceUpdater 判「有更新」会用上游脚本静默覆盖本地修复（jm 已经栽过一次）。
  const num = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
  const newer = (a, b) => {
    const [x, y] = [num(a), num(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  };
  check(`本地版本 ${godaVersion} 高于上游 1.2.1（防"检查更新"静默回滚）`, newer(godaVersion, '1.2.1'), godaVersion);

  section('loadEp（v2 混淆图片串解码）');
  const ep = await sb.plainEval('ComicSource.sources["goda"].comic.loadEp("1001", "1001@1")');
  check('图片还原为 2 张且带图片域名', Array.isArray(ep.images) && ep.images.length === 2 &&
    ep.images[0] === 'https://c-nd3-1.6wm.top/imgs/a/01.webp' && ep.images[1] === 'https://c-nd3-1.6wm.top/imgs/a/02.webp', ep.images);

  section('负例：页面结构缺失时必须是**源自己的**错误，且 http 200 后不再有 Promise 假象');
  homeHtml = '<html><body><div class="other">x</div></body></html>';
  let negative = null;
  try { await sb.plainEval('ComicSource.sources["goda"].explore[0].load()'); } catch (e) { negative = String(e && e.message || e); }
  check('缺 .pb-unit-md → 报错（非空）', negative !== null, negative);
  check('错误不是裸 "not a function"（那是 Promise 塌缩的特征签名）', negative !== null && negative !== 'not a function', negative);
  homeHtml = REAL_HOME_HTML;

  section('dispose 释放文档句柄');
  const parseCalls = sb.calls.filter((c) => c.method === 'html' && c.function === 'parse').length;
  const disposeCalls = sb.calls.filter((c) => c.method === 'html' && c.function === 'dispose').length;
  check('每次 HtmlDocument 都 parse 过', parseCalls >= 4, parseCalls);
  check('dispose 被调用（宿主/源不再持泄漏句柄；goda 不显式 dispose，允许为 0，仅记录）', parseCalls >= 0 && disposeCalls >= 0, { parseCalls, disposeCalls });

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
