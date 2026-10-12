#!/usr/bin/env node
/**
 * verify_goda_hot_latest_e2e.js — GoDa漫画 的「热门 / 最近更新 / 筛选」必须是**三批不同的数据**。
 *
 * 真机现象（用户报的）：浏览页 → GoDa漫画，热门、最近更新、筛选显示的是同一批数据。
 *
 * ### 根因（站点侧，probe_goda_lists.js 实测，不是猜的）
 *
 * godamh.com 只有四条列表路径，`/manga`（全部）与 `/hots`（人氣排行）**逐 id 100% 同一份**，
 * `/manga-genre/hots`（类型·热门漫画）与 `/dayup`（熱門更新）也是同一份：
 *
 *  | path     | 语义     | 页1 抽样                                    |
 *  |----------|----------|---------------------------------------------|
 *  | /hots    | 人氣排行 | 武炼巅峰 / 我独自升级 / 大王饶命             |
 *  | /dayup   | 熱門更新 | 被追放的转生重骑士 / 满级玩家的第100次回归   |
 *  | /newss   | 最新上架 | 八女帝全背叛 / 万倍返还                     |
 *  | /manga   | 全部     | ≡ /hots                                     |
 *
 * 而 1.2.4 的 goda.js：
 *  • 没声明 `categoryComics.ranking` ⇒ 宿主的「热门」回落到 `explore[0]`（首页多分区被拍平的一锅粥）；
 *  • `category.parts` 第一个带 `categoryParams` 的行是「类型 · 全部」= `/manga`
 *    ⇒ 宿主的「最近更新」拿到 `/manga`，也就是**人气排行**，和热门要指的东西同源；
 *  • 筛选若停在「全部」，同样落到 `/manga`。三处指向同一份，看起来就是"功能没实现"。
 *
 * ### 修法（本文件钉住契约）
 *
 *  • 「热门」    → `categoryComics.ranking.load("hots", page)` ⇒ `/hots/page/N`（人氣排行）
 *  • 「最近更新」→ `categoryComics.load("最近更新", "/dayup", [""], page)` ⇒ `/dayup/page/N`
 *                 （源把「更新」这个 part 放在 `category.parts` **最前面**来声明这一点）
 *  • 「筛选」    → 更新 / 类型 `/manga-genre/*` / 标签 `/manga-tag/*`，各自不同
 *
 * ⚠️ 传给 `ranking.load()` 的必须是**剥掉 label 的 value**（`hots`，不是 `hots-人氣排行`）——
 *    这是 jm 踩过的同一个坑（带 label 的 `o=` 被服务端忽略、静默回落默认排序 ⇒ 两个 tab 一样）。
 *
 * ### 与设备的一致性
 *
 * 跑真 `init.js` + 真 `goda.js`，HTTP 回放 `probe_goda_lists.js` **真抓**下来的页面
 * （samples/goda_list_*.html）。本文件断言的是**宿主真正会发出去的 URL** 与**源解析出来的 id 集合**，
 * 不是源自己说它想要什么。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeHtmlBridge } = require('./lib_html_bridge_mock.js');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const godaJs = fs.readFileSync(path.join(__dirname, 'samples', 'goda.js'), 'utf8');

function sample(name) {
  return fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');
}

// 2026-10-10 真抓（probe_goda_lists.js）：四条列表 + 两条筛选快照。
const LIST = {
  hots: { 1: sample('goda_list_hots.html'), 2: sample('goda_list_hots_p2.html') },
  dayup: { 1: sample('goda_list_dayup.html'), 2: sample('goda_list_dayup_p2.html') },
  newss: { 1: sample('goda_list_newss.html'), 2: sample('goda_list_newss_p2.html') },
  manga: { 1: sample('goda_list_manga.html'), 2: sample('goda_list_manga_p2.html') },
  genre_kr: { 1: sample('goda_list_genre_kr.html') },
  tag_fuchou: { 1: sample('goda_list_tag_fuchou.html') },
};
const HOME_HTML = sample('goda_home.html');

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

/** 从回放页里抽出卡片 id（`/manga/<slug>`），与源解析结果做集合比较。 */
function pageIds(html) {
  const out = [];
  const re = /href="(\/manga\/[^"?#]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].startsWith('/manga/page/')) continue;   // `/manga` 自己的分页链接
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const overlap = (a, b) => {
  const s = new Set(a);
  return b.length ? b.filter((x) => s.has(x)).length / b.length : 0;
};

// ================================================================================================
// 宿主侧逻辑镜像 —— 改了 JsMangaSource.kt 就必须同步改这里，否则这里全绿而设备照旧。
//   • JsMangaSource.parseCategoryParts  : parts(type=="fixed") × categories，顺序展开
//   • JsMangaSource.latestCategory      : 第一个 itemType=="category" 且 param 非空的行
//   • JsMangaSource.popularRankingOption: text 含「總/总」→ value 不含 '_' → 第一个
// ================================================================================================

function reflectCategoryParts(parts) {
  const out = [];
  for (const part of parts || []) {
    if (part.type !== 'fixed') continue;
    (part.categories || []).forEach((name, i) => {
      out.push({
        group: part.name,
        itemType: part.itemType,
        category: name,
        param: (part.categoryParams || [])[i] ?? null,
      });
    });
  }
  return out;
}

const latestCategory = (rows) =>
  rows.find((r) => r.itemType === 'category' && r.param !== null && r.param !== undefined && r.param !== '');

function popularRankingOption(options) {
  if (!options || !options.length) return null;
  const textOf = (o) => o.includes('-') ? o.substring(o.indexOf('-') + 1) : o;
  const chosen =
    options.find((o) => textOf(o).includes('總') || textOf(o).includes('总')) ??
    options.find((o) => !o.split('-')[0].includes('_')) ??
    options[0];
  return chosen.split('-')[0];
}

// ================================================================================================
// 沙箱 + HTTP 回放
// ================================================================================================

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: Buffer.from(text, 'utf8').toString('base64') };
}
function notFound(url) {
  return { status: 404, error: null, headers: {}, body: Buffer.from('', 'utf8').toString('base64') };
}

/** `/<name>` 或 `/<name>/page/<n>` → 回放页；认不出来的路径返回 null（调用方决定 404）。 */
function replay(url) {
  const m = /^https:\/\/godamh\.com\/([a-z0-9\-]+)(?:\/page\/(\d+))?$/.exec(url);
  if (m) {
    const bucket = LIST[m[1]];
    if (!bucket) return null;
    const html = bucket[m[2] ? Number(m[2]) : 1];
    return html ? textEnvelope(html) : null;
  }
  if (/^https:\/\/godamh\.com\/manga-genre\/kr(\/page\/(\d+))?$/.test(url)) {
    const page = Number(/page\/(\d+)/.exec(url)?.[1] || 1);
    return page === 1 ? textEnvelope(LIST.genre_kr[1]) : null;
  }
  if (/^https:\/\/godamh\.com\/manga-tag\/fuchou(\/page\/(\d+))?$/.test(url)) {
    const page = Number(/page\/(\d+)/.exec(url)?.[1] || 1);
    return page === 1 ? textEnvelope(LIST.tag_fuchou[1]) : null;
  }
  if (url === 'https://godamh.com' || url === 'https://godamh.com/') return textEnvelope(HOME_HTML);
  return null;
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

  let settings = {};
  const htmlBridge = makeHtmlBridge();

  function dispatch(msg) {
    calls.push(msg);
    switch (msg.method) {
      case 'getLocale': return 'zh_CN';
      case 'getPlatform': return 'android';
      case 'isLogged': return false;
      case 'UI': return null;
      case 'delay': return null;
      case 'load_data': return Object.prototype.hasOwnProperty.call(saved, msg.data_key) ? saved[msg.data_key] : null;
      case 'save_data': saved[msg.data_key] = msg.data; return null;
      case 'load_setting': return settings[msg.setting_key] ? settings[msg.setting_key].default : undefined;
      case 'convert': {
        if (msg.type === 'utf8') return msg.isEncode ? Buffer.from(String(msg.value), 'utf8') : Buffer.from(msg.value).toString('utf8');
        if (msg.type === 'base64') {
          if (msg.isEncode) return Buffer.from(msg.value).toString('base64');
          try { return Buffer.from(String(msg.value).replace(/[\s\uFEFF]/g, ''), 'base64'); } catch { return null; }
        }
        return null;
      }
      case 'http': {
        const url = String(msg.url || '');
        // ⚠️ 回放不出来就**给 404** —— 让源自己抛错。兜底成首页会让每一个"URL 指错了"的
        // 断言都静默变绿（站点首页恰好也有卡片），这是最容易造出假绿的一步。
        return JSON.stringify(replay(url) ?? notFound(url));
      }
      case 'html': return htmlBridge(msg);
      default: return null;
    }
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

  const raw = vm.runInContext('ComicSource.sources["goda"].settings', sandbox);
  settings = raw || {};

  return {
    sandbox,
    calls,
    httpUrls: () => calls.filter((c) => c.method === 'http').map((c) => String(c.url)),
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

/** 宿主调用 ranking.load / categoryComics.load 时发出的表达式。 */
function rankingCall(value, page) {
  return `ComicSource.sources["goda"].categoryComics.ranking.load(${JSON.stringify(value)}, ${page})`;
}
function categoryCall(category, param, page) {
  return `ComicSource.sources["goda"].categoryComics.load(${JSON.stringify(category)}, ${JSON.stringify(param)}, [""], ${page})`;
}

async function main() {
  const sb = makeSandbox();

  // --- 元数据（宿主 warmMeta 的反射） -----------------------------------------------------------
  section('源声明的元数据（宿主 warmMeta 反射到的东西）');
  const enableRanking = vm.runInContext('ComicSource.sources["goda"].category.enableRankingPage', sb.sandbox);
  const rankingOptions = vm.runInContext(
    'ComicSource.sources["goda"].categoryComics.ranking && ComicSource.sources["goda"].categoryComics.ranking.options || []',
    sb.sandbox,
  );
  const parts = vm.runInContext('ComicSource.sources["goda"].category.parts', sb.sandbox);
  const rows = reflectCategoryParts(parts);

  check('enableRankingPage = true（否则「热门」回落到 explore）', enableRanking === true, enableRanking);
  check('ranking.options 是 "value-text" 三条',
    JSON.stringify(rankingOptions) === JSON.stringify(['hots-人氣排行', 'dayup-熱門更新', 'newss-最新上架']),
    rankingOptions);
  check('category.parts 的第一个 part 是「更新」（顺序即契约）',
    parts && parts[0] && parts[0].name === '更新', parts && parts[0] && parts[0].name);
  check('「更新」part 的 params 指向 /dayup 与 /newss',
    JSON.stringify(parts[0].categoryParams) === JSON.stringify(['/dayup', '/newss']), parts[0].categoryParams);

  const latest = latestCategory(rows);
  check('宿主 latestCategory = 「更新 · 最近更新」/ /dayup',
    latest && latest.group === '更新' && latest.category === '最近更新' && latest.param === '/dayup', latest);
  // 回归钉子：1.2.4 就是挂在 /manga 上，而 /manga ≡ /hots ⇒ 最近更新与热门同源。
  check('latestCategory **不是** 类型·全部（/manga ≡ /hots，指过去就与热门同批）',
    latest && latest.param !== '/manga', latest && latest.param);

  const popular = popularRankingOption(rankingOptions);
  check('宿主 popularRankingOption = "hots"（剥掉 label 的 value）', popular === 'hots', popular);

  // --- 热门 -------------------------------------------------------------------------------------
  section('「热门」tab = ranking.load("hots", page) ⇒ /hots/page/N');
  const hot = await sb.plainEval(rankingCall(popular, 1));
  const hotIds = (hot.comics || []).map((c) => c && c.id);
  check('请求 URL = https://godamh.com/hots/page/1',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/hots/page/1', sb.httpUrls().slice(-2));
  check('URL 里不含 label（"hots-人氣排行" 拼进去会被服务端忽略 ⇒ 回落默认排序）',
    !sb.httpUrls().slice(-1)[0].includes('人氣排行'), sb.httpUrls().slice(-1)[0]);
  check('解析出 18 条（真抓页的卡片数）', hotIds.length >= 15, hotIds.length);
  check('maxPage = 100（末位 button.text-small）', hot.maxPage === 100, hot.maxPage);
  const hotExpected = pageIds(LIST.hots[1]);
  check('id 与 /hots 真抓页一致（≥90%）', overlap(hotExpected, hotIds) >= 0.9,
    { got: hotIds.length, inPage: hotIds.filter((x) => hotExpected.includes(x)).length });

  // --- 最近更新 ---------------------------------------------------------------------------------
  section('「最近更新」tab = categoryComics.load("最近更新", "/dayup", [""], page) ⇒ /dayup/page/N');
  const latestRes = await sb.plainEval(categoryCall(latest.category, latest.param, 1));
  const latestIds = (latestRes.comics || []).map((c) => c && c.id);
  check('请求 URL = https://godamh.com/dayup/page/1',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/dayup/page/1', sb.httpUrls().slice(-1));
  check('解析出 18 条', latestIds.length >= 15, latestIds.length);
  check('maxPage = 100', latestRes.maxPage === 100, latestRes.maxPage);
  const dayupExpected = pageIds(LIST.dayup[1]);
  check('id 与 /dayup 真抓页一致（≥90%）', overlap(dayupExpected, latestIds) >= 0.9,
    { got: latestIds.length, inPage: latestIds.filter((x) => dayupExpected.includes(x)).length });

  // --- 三条列表必须互不相同（用户的原话：「都是同一批数据」） ----------------------------------
  section('热门 / 最近更新 / 最新上架 必须是三批不同的数据');
  const newssRes = await sb.plainEval(categoryCall('最新上架', '/newss', 1));
  const newssIds = (newssRes.comics || []).map((c) => c && c.id);
  check('最新上架 URL = https://godamh.com/newss/page/1',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/newss/page/1', sb.httpUrls().slice(-1));
  const ovHotLatest = overlap(hotIds, latestIds);
  const ovHotNewss = overlap(hotIds, newssIds);
  const ovLatestNewss = overlap(latestIds, newssIds);
  check(`热门 vs 最近更新 重合 < 20%（实测 ${(ovHotLatest * 100).toFixed(0)}%）`, ovHotLatest < 0.2, ovHotLatest);
  check(`热门 vs 最新上架 重合 < 20%（实测 ${(ovHotNewss * 100).toFixed(0)}%）`, ovHotNewss < 0.2, ovHotNewss);
  check(`最近更新 vs 最新上架 重合 < 20%（实测 ${(ovLatestNewss * 100).toFixed(0)}%）`, ovLatestNewss < 0.2, ovLatestNewss);

  // --- 分页 -------------------------------------------------------------------------------------
  section('分页真的前进（不是把同一页翻来覆去）');
  const hot2 = await sb.plainEval(rankingCall(popular, 2));
  const hot2Ids = (hot2.comics || []).map((c) => c && c.id);
  check('热门 页2 URL = /hots/page/2',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/hots/page/2', sb.httpUrls().slice(-1));
  const ovHot12 = overlap(hotIds, hot2Ids);
  check(`热门 页1 vs 页2 重合 < 50%（实测 ${(ovHot12 * 100).toFixed(0)}%）`, ovHot12 < 0.5, ovHot12);
  const latest2 = await sb.plainEval(categoryCall(latest.category, latest.param, 2));
  const latest2Ids = (latest2.comics || []).map((c) => c && c.id);
  const ovLatest12 = overlap(latestIds, latest2Ids);
  check(`最近更新 页1 vs 页2 重合 < 50%（实测 ${(ovLatest12 * 100).toFixed(0)}%）`, ovLatest12 < 0.5, ovLatest12);

  // --- 筛选 -------------------------------------------------------------------------------------
  section('「筛选」：类型 / 标签各自换一批数据');
  const kr = await sb.plainEval(categoryCall('韩漫', '/manga-genre/kr', 1));
  const krIds = (kr.comics || []).map((c) => c && c.id);
  check('韩漫 URL = https://godamh.com/manga-genre/kr/page/1',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/manga-genre/kr/page/1', sb.httpUrls().slice(-1));
  check('解析出 18 条', krIds.length >= 15, krIds.length);
  check(`韩漫 vs 热门 重合 < 30%（实测 ${(overlap(hotIds, krIds) * 100).toFixed(0)}%）`, overlap(hotIds, krIds) < 0.3);

  const tag = await sb.plainEval(categoryCall('复仇', '/manga-tag/fuchou', 1));
  const tagIds = (tag.comics || []).map((c) => c && c.id);
  check('复仇 URL = https://godamh.com/manga-tag/fuchou/page/1',
    sb.httpUrls().slice(-1)[0] === 'https://godamh.com/manga-tag/fuchou/page/1', sb.httpUrls().slice(-1));
  check('解析出 18 条', tagIds.length >= 15, tagIds.length);
  check(`复仇 vs 韩漫 重合 < 30%（实测 ${(overlap(krIds, tagIds) * 100).toFixed(0)}%）`, overlap(krIds, tagIds) < 0.3);

  // --- 反例 / 回归钉子 -------------------------------------------------------------------------
  section('反例：站点镜像 & explore 不是「热门」的正确来源');
  const mangaRes = await sb.plainEval(categoryCall('全部', '/manga', 1));
  const mangaIds = (mangaRes.comics || []).map((c) => c && c.id);
  // 站点事实：`/manga` 与 `/hots` 是同一份。正因为它，「类型·全部」绝不能当「最近更新」用。
  check('/manga（全部）≡ /hots（站点镜像，所以「全部」不能顶替「最近更新」）',
    overlap(hotIds, mangaIds) >= 0.9, overlap(hotIds, mangaIds));

  const exploreParts = await sb.plainEval('ComicSource.sources["goda"].explore[0].load()');
  const flatIds = [];
  for (const p of exploreParts || []) for (const c of (p.comics || [])) if (c && c.id) flatIds.push(c.id);
  check('explore 仍是首页多分区（4 组、有漫画）',
    Array.isArray(exploreParts) && exploreParts.length === 4 && flatIds.length > 0,
    { parts: exploreParts && exploreParts.length, comics: flatIds.length });
  const ovExploreHot = overlap(hotIds, flatIds);
  check(`explore 拍平 ≠ 热门排行榜（重合 ${(ovExploreHot * 100).toFixed(0)}% —— 所以它不能当「热门」）`,
    ovExploreHot < 0.5, ovExploreHot);

  section('反例：路径写错必须**立刻报错**，不能静默回落首页');
  let badErr = null;
  try { await sb.plainEval(rankingCall('人氣排行', 1)); } catch (e) { badErr = String((e && e.message) || e); }
  check('把 label 当 value 传给 ranking.load → 源抛错（404，不是首页兜底）',
    badErr !== null && badErr.includes('404'), badErr);

  section('结果');
  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
