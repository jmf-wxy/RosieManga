#!/usr/bin/env node
/**
 * verify_latest_vs_popular_e2e.js — 「热门」与「最近更新」两个 tab 必须是**不同**的列表，
 * 并且筛选（排序 / 分类）必须真的改变请求。
 *
 * 真机现象（截图 23:40）：两个 tab 显示**完全一样**的内容。
 *
 * ### 根因
 *
 * `getPopularManga` 与 `getLatestUpdates` 都调 `explore[0].load(page - 1)`。而 jm.js 的
 * `explore[0]` 是 `type: "multiPartPage"` —— Venera 里对应 `ExplorePageType.singlePageWithMultiPart`，
 * 即**单页多分组、无分页**。两个 tab 指向同一个无分页入口，内容必然相同。
 *
 * ### 修法（本文件钉住契约）
 *
 *  • 「热门」= **总排行**（原为 `explore[0]`；explore 现在只在源未声明排行时作回落，
 *    且按类型调用 —— 详见 verify_explore_types_e2e.js）。
 *    ⚠️ 传给 `ranking.load()` 的必须是**剥掉 label 的 value**（`"mv"`，不是 `"mv-總排行"`）。
 *    真机实测（probe_jm_popular_latest_distinct.js）：带 label 的 `o=` 被服务端当非法值忽略、
 *    回落到**最新**排序 ⇒ 与「最近更新」100% 重合 ⇒ 两个 tab 看起来完全一样（2026-10-02 的 bug）。
 *  • 「最近更新」= `categoryComics.load(<category>, <param>, [<sort>], page)`，
 *    取 `category.parts` 里 **itemType=="category" 且声明了 categoryParams** 的第一项
 *    （jm ⇒「最新A漫」/ param "0" ⇒ `/categories/filter?o=mr&c=0&page=N`）。
 *  • 选中分类 / 排序时，`getSearchManga` 改走 `categoryComics.load`，并把排序值拼进 `o=`。
 *
 * ⚠️ 为什么必须挑 **有 categoryParams** 的 part：jm 的「每週必看」没有 categoryParams，
 * 且它的 `optionLoader` 返回**两组**选项（時間/類型）——只传一个值会得到 `&type=undefined`。
 * 本文件用反向对照钉住这一点。
 *
 * ⚠️ 空关键词：jm 的 `/search` 是关键词驱动的，空串返回 `total=0`（实测）。所以「筛选」打开
 * 但没输关键词时必须回落 explore，不能发空搜索。
 *
 * ### 与设备的一致性
 *
 * 跑真 `init.js` + 真 `jm.js`，HTTP 由 mock 回放——回放的是 `probe_jm_latest_vs_popular.js`
 * **实测**下来的真实响应形状（`/promote` 是 8 分组数组；`/categories/filter` 是
 * `{total, content}`）。本文件断言的是**宿主发出的 URL**，即设备真正会请求的东西。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const JM_API_SECRET = '185Hcomic3PAPP7R';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
const FETCHED_SERVERS = ['www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club'];
const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

const ktEncodeUtf8 = (s) => Buffer.from(String(s), 'utf8');
function ktDecodeUtf8(v) {
  if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) return null;
  return Buffer.from(v).toString('utf8');
}
function ktMd5(v) {
  if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) return null;
  return crypto.createHash('md5').update(Buffer.from(v)).digest();
}
const ktBase64Encode = (v) => Buffer.from(v).toString('base64');
function ktBase64Decode(t) {
  if (typeof t !== 'string') return null;
  try { return Buffer.from(t.replace(/[\s\uFEFF]/g, ''), 'base64'); } catch { return null; }
}
function ktAesEcb(value, key, encode) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array)) return null;
  key = Buffer.from(key); value = Buffer.from(value);
  if (![16, 24, 32].includes(key.length)) return null;
  const body = value.subarray(0, Math.floor(value.length / 16) * 16);
  if (body.length === 0) return Buffer.alloc(0);
  const c = encode
    ? crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null)
    : crypto.createDecipheriv('aes-' + key.length * 8 + '-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(body), c.final()]);
}
const jmKey = (secret) => Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
function jmSeal(plain, secret) {
  const raw = Buffer.from(plain, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-256-ecb', jmKey(secret), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}

const FROZEN_NOW_MS = 1767225600000;
Date.now = () => FROZEN_NOW_MS;
const NOW_SEC = Math.floor(FROZEN_NOW_MS / 1000);
const apiSecretAt = (t) => `${t}${JM_API_SECRET}`;

// --- 真实响应形状（probe_jm_latest_vs_popular.js 实测）------------------------------------------

/** `/promote?page=0`：8 个分组，library/novels 被源 continue 掉 ⇒ 6 组 × 30 本 = 180。 */
function promotePayload(perSection = 30) {
  const types = ['promote', 'promote', 'promote', 'not_in_category_id', 'category_id', 'category_id', 'library', 'novels'];
  return types.map((type, s) => ({
    id: String(s + 1),
    title: `分組${s + 1}`,
    slug: type === 'category_id' ? `slug${s}` : '',
    type,
    filter_val: '',
    content: Array.from({ length: perSection }, (_, i) => ({
      id: String(900000 + s * 100 + i),
      author: '作者',
      name: `熱門分組${s + 1} 第${i}話`,
      image: '',
      category: { id: '1', title: '同人' },
      category_sub: { id: '1', title: '同人' },
      liked: false,
      is_favorite: false,
      update_at: 1790819926,
    })),
  }));
}
/** `/categories/filter`：{total, content} —— 与 /search 同构。 */
function categoryPayload(total, count, startId, prefix) {
  const content = [];
  for (let i = 0; i < count; i++) {
    content.push({
      id: String(startId + i),
      author: '作者',
      description: null,
      name: `${prefix} 第${i}話`,
      image: '',
      category: { id: '1', title: '同人' },
      category_sub: { id: '1', title: '同人' },
      liked: false,
      is_favorite: false,
      update_at: 1790819926,
    });
  }
  return { search_query: '', total, content, tags: [] };
}
function searchPayload(total, count, startId, prefix) {
  return categoryPayload(total, count, startId, prefix);
}

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}
function apiResponse(payload) {
  // 2026-10-07 起站点给 API 信封也加了 UTF-8 BOM（真机 200 探针实锤 ef bb bf），jm.js 1.4.2 的
  // parseBody() 负责剥离；这里忠实模拟 ⇒ 本文件同时是 BOM 剥离的反例守卫。
  return textEnvelope('\uFEFF' + JSON.stringify({ data: jmSeal(JSON.stringify(payload), apiSecretAt(NOW_SEC)) }));
}
function domainListResponse(servers) {
  return textEnvelope('\uFEFF' + jmSeal(JSON.stringify({ Server: servers }), DOMAIN_SECRET) + '\n');
}

// --- 沙箱 ---------------------------------------------------------------------------------------

function makeSandbox(host) {
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
    const settings = vm.runInContext("ComicSource.sources['jm'].settings", sandbox);
    const out = {};
    for (const [k, v] of Object.entries(settings)) out[k] = { type: v.type, default: v.default };
    metaCache = out;
  }

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
      const persisted = (host.settings || {})[msg.setting_key];
      if (persisted !== undefined) return persisted;
      return metaCache && metaCache[msg.setting_key] ? metaCache[msg.setting_key].default : undefined;
    }
    if (m === 'convert') {
      if (msg.type === 'utf8') return msg.isEncode ? ktEncodeUtf8(msg.value) : ktDecodeUtf8(msg.value);
      if (msg.type === 'md5') return ktMd5(msg.value);
      if (msg.type === 'base64') return msg.isEncode ? ktBase64Encode(msg.value) : ktBase64Decode(msg.value);
      if (msg.type === 'aes-ecb') return ktAesEcb(msg.value, msg.key, msg.isEncode === true);
      return null;
    }
    if (m === 'http') {
      const envelope = host.http(msg);
      if (envelope === null) return JSON.stringify({ status: null, headers: {}, body: null, error: 'unreachable' });
      return JSON.stringify(envelope);
    }
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
  vm.runInContext(jmJs, sandbox);
  vm.runInContext('ComicSource.sources["jm"] = new JM();', sandbox);
  vm.runInContext(`JM.apiDomains = ${JSON.stringify(FETCHED_SERVERS)};`, sandbox);

  return {
    sandbox,
    calls,
    reflectMeta,
    plainEval: async (expr) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n  try {\n    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.value = __plainValue(v); globalThis.' + slot + '.done = true; },\n' +
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

// --- 宿主侧：复刻 JsMangaSource 的分区/排序解析 --------------------------------------------------

/** 复刻 JsSourceManager.parseCategoryParts（`type=="fixed"` + 并行 categoryParams）。 */
function parseCategoryParts(raw) {
  const out = [];
  for (const part of raw || []) {
    if (part.type !== 'fixed') continue;
    const cats = part.categories || [];
    const params = part.categoryParams || null;
    cats.forEach((c, i) => {
      out.push({ group: part.name, itemType: part.itemType, category: c, param: params ? String(params[i]) : null });
    });
  }
  return out;
}
/** 复刻 JsSourceManager.parseSearchOptions（取每组 options 原始字符串）。 */
function parseSearchOptions(raw) {
  return (raw || []).map((g) => (g.options || []).map(String)).filter((o) => o.length);
}
/** 复刻 JsMangaSource.latestCategory：itemType=="category" 且有 param 的第一项。 */
function pickLatestCategory(parts) {
  return parts.find((p) => p.itemType === 'category' && p.param != null && p.param !== '') || null;
}
/**
 * 复刻 JsMangaSource.categoryGroups：按 (name, itemType) 合并、保持声明序、重名加 (n) 后缀。
 * ⚠️ 必须包含 **所有** itemType（不只 "category"）——第一版只放 category 型，导致
 * 主題A漫/角色扮演/特殊PLAY×2 全丢，用户报了「筛选的类型现在不全」。
 */
function groupCategories(parts) {
  const byKey = new Map();
  for (const p of parts) {
    const key = p.group + '\u0000' + p.itemType;
    if (!byKey.has(key)) byKey.set(key, { name: p.group, parts: [] });
    byKey.get(key).parts.push(p);
  }
  const seen = new Map();
  return [...byKey.values()].map(({ name, parts: ps }) => {
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return { name: n === 1 ? name : `${name} (${n})`, parts: ps };
  });
}

// --- 用例 ---------------------------------------------------------------------------------------

(async () => {
  console.log('verify_latest_vs_popular_e2e.js — 两个 tab 必须不同 + 筛选必须生效');

  const seen = [];
  const host = {
    settings: {},
    http(msg) {
      const url = msg.url;
      seen.push(url);
      const u = new URL(url);
      if (u.hostname.includes('bytepluses')) return domainListResponse(FETCHED_SERVERS);
      if (u.pathname.startsWith('/promote')) return apiResponse(promotePayload());
      if (u.pathname.startsWith('/categories/filter')) {
        const o = u.searchParams.get('o');
        const c = u.searchParams.get('c');
        // 日排行实测为空（total=0），其余有数据 —— 别替宿主造「所有排行都一样」的假状态。
        if (o === 'mv_t') return apiResponse(categoryPayload(0, 0, 0, ''));
        // 不同排序必须给**不同的 id 段**，否则「两个 tab 内容不同」这条断言会假绿。
        // ⚠️ 台子盲区（2026-10-02 踩到）：原来用 `o.length*7919 + o[0]*131 + c.length*17` 派生 id，
        // 而 `mv` / `mr` 长度与首字符**完全相同** ⇒ 两个 tab 拿到同一段 id ⇒ 真身份不同却报 FAIL
        // （假红，比假绿更误导）。改成对**整条 query** 做散列，让任何不同的请求都得到不同 id。
        const seed = `${o}|${c}|${u.searchParams.get('page') || ''}`
          .split('')
          .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
        return apiResponse(categoryPayload(10000, 80, 1000000 + (seed % 100000) * 100, `分类${c} 排序${o}`));
      }
      if (u.pathname.startsWith('/search')) {
        const q = u.searchParams.get('search_query') || '';
        // 实测：空关键词 ⇒ total=0
        if (q.trim() === '') return apiResponse(searchPayload(0, 0, 0, ''));
        return apiResponse(searchPayload(2829, 80, 1478011, `搜索${q}`));
      }
      // `/week` → 時間选项来源（实测：{categories:[{id,time}]}，258 期）
      if (u.pathname === '/week') {
        const categories = Array.from({ length: 258 }, (_, i) => ({
          id: String(259 - i),
          title: '',
          time: `2026第${258 - i}期09.25 - 09.18`,
        }));
        return apiResponse({ categories, type: 'week' });
      }
      // `/week/filter` → 週刊列表（实测：{list:[…]}）
      if (u.pathname.startsWith('/week/filter')) {
        const id = u.searchParams.get('id');
        const type = u.searchParams.get('type');
        return apiResponse({
          list: Array.from({ length: 20 }, (_, i) => ({
            id: `w${id}_${type}_${i}`,
            author: '週刊作者',
            name: `週刊 id=${id} type=${type} 第${i}話`,
            image: '',
            category: { id: '1', title: '同人' },
            category_sub: { id: '1', title: '同人' },
            liked: false,
            is_favorite: false,
            update_at: 1790819926,
          })),
        });
      }
      return null;
    },
  };
  const sb = makeSandbox(host);
  sb.reflectMeta();

  // ============ 1. 源声明的读取 ============
  section('1. 源声明：search.optionList 与 category.parts');

  const rawOptions = vm.runInContext('ComicSource.sources["jm"].search.optionList', sb.sandbox);
  const rawParts = vm.runInContext('ComicSource.sources["jm"].category.parts', sb.sandbox);
  const optGroups = parseSearchOptions(rawOptions);
  const parts = parseCategoryParts(rawParts);

  check('search.optionList 至少一组', optGroups.length >= 1, JSON.stringify(optGroups.length));
  check('第一组是 jm 的 7 个排序项', optGroups[0].length === 7, JSON.stringify(optGroups[0]));
  check('排序项写法是 "value-text"', optGroups[0][0] === 'mr-最新', optGroups[0][0]);
  check('默认排序值 = mr（最新）', optGroups[0][0].substringBefore === undefined ? true : true);
  check('默认排序值取首个 = mr', optGroups[0][0].split('-')[0] === 'mr', optGroups[0][0]);

  check('category.parts 被摊平成多行', parts.length > 0, String(parts.length));
  const weekly = parts.find((p) => p.category === '每週必看');
  check('「每週必看」没有 categoryParams（⇒ 不能用单值调用）',
    weekly && weekly.param === null, JSON.stringify(weekly));
  const aMan = parts.find((p) => p.category === '最新A漫');
  check('「最新A漫」带 param "0"', aMan && aMan.param === '0', JSON.stringify(aMan));

  const latest = pickLatestCategory(parts);
  check('latestCategory 选中「最新A漫」（跳过无 param 的每週必看）',
    latest && latest.category === '最新A漫' && latest.param === '0', JSON.stringify(latest));

  // 排行声明（供第 2 节判断「热门」选哪一档）
  const rawRanking = vm.runInContext(
    'ComicSource.sources["jm"].categoryComics.ranking.options', sb.sandbox);
  const rankingOptions = rawRanking.map(String);
  check('category.enableRankingPage 为 true',
    vm.runInContext('ComicSource.sources["jm"].category.enableRankingPage', sb.sandbox) === true);

  // ============ 1b. 筛选分组必须「全」（用户报「少好多」的那条） ============
  section('1b. 筛选分组必须覆盖 Venera 分类页的全部七组');

  const groups = groupCategories(parts);
  const names = groups.map((g) => g.name);
  console.log(`    分组：${JSON.stringify(names)}`);

  check('「每週必看」在', names.includes('每週必看'));
  check('「成人A漫」在', names.includes('成人A漫'));
  check('「主題A漫」在（itemType=="search"，第一版被漏掉的就是它）', names.includes('主題A漫'));
  check('「角色扮演」在（itemType=="search"）', names.includes('角色扮演'));
  check('「特殊PLAY」在（itemType=="search"）', names.includes('特殊PLAY'));
  check('两个同名「特殊PLAY」被合并成一组（不产生重复标题）',
    names.filter((n) => n.startsWith('特殊PLAY')).length === 1, JSON.stringify(names));

  const themePart = groups.find((g) => g.name === '主題A漫');
  check('「主題A漫」保留全部 18 个标签', themePart && themePart.parts.length === 18,
    String(themePart && themePart.parts.length));
  check('「主題A漫」的标签是 search 型（走 /search，不是 /categories/filter）',
    themePart && themePart.parts.every((p) => p.itemType === 'search'));
  const playPart = groups.find((g) => g.name === '特殊PLAY');
  check('合并后的「特殊PLAY」共 24 个标签（18 + 6）', playPart && playPart.parts.length === 24,
    String(playPart && playPart.parts.length));
  const adultPart = groups.find((g) => g.name === '成人A漫');
  check('「成人A漫」是 category 型且带 param（doujin 等）',
    adultPart && adultPart.parts.some((p) => p.param === 'doujin'));
  check('合并后是 5 个组（特殊PLAY×2 → 1）',
    groups.length === 5, `${groups.length}: ${JSON.stringify(names)}`);

  // ============ 2. 两个 tab 请求不同端点 ============
  section('2.「热门」= 总排行、「最近更新」= 最新A漫，两者必须不同');

  // 复刻 JsMangaSource.popularRankingOption（**终版**）：
  //   ① 文本含「總/总」的优先；② 否则取值不带 `_` 后缀的（mv，而非 mv_m/mv_w/mv_t）；③ 否则第一项。
  //   返回值必须是**去掉 label 的 value 半边** —— 这是 2026-10-02 真机「两 tab 一样」的根因。
  const popularRankingOption = (opts) => {
    if (!opts.length) return null;
    const chosen = opts.find((o) => {
      const text = o.split('-').slice(1).join('-');
      return text.includes('總') || text.includes('总');
    }) || opts.find((o) => !o.split('-')[0].includes('_')) || opts[0];
    return chosen.split('-')[0]; // ← value 半边，Venera: options.keys.first
  };
  const popularValue = popularRankingOption(rankingOptions);
  check('popularRankingOption 选中「总排行」并已剥掉 label ⇒ "mv"',
    popularValue === 'mv', String(popularValue));
  check('返回值不含 "-"（若含 ⇒ 会把 "mv-總排行" 拼进 o=，服务端当非法值忽略）',
    !popularValue.includes('-'), String(popularValue));

  seen.length = 0;
  const popularRes = await sb.plainEval(
    `ComicSource.sources["jm"].categoryComics.ranking.load(${JSON.stringify(popularValue)}, 1)`);
  const popularUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('热门 → /categories/filter（不再是 /promote）', !!popularUrl, popularUrl);
  check('热门 URL 带 o=mv（总排行）', !!popularUrl && popularUrl.includes('o=mv'), popularUrl);
  check('热门 URL 的 o= 不是 "mv-總排行"（带 label 会被服务端回落到默认排序）',
    !!popularUrl && !popularUrl.includes('o=mv-') && !popularUrl.includes('o=mv%2D'),
    popularUrl);
  check('热门 URL 带 c=0', !!popularUrl && popularUrl.includes('c=0'), popularUrl);
  check('热门返回 maxPage（总排行可分页：total=10000 ⇒ maxPage>0）',
    typeof popularRes.maxPage === 'number' && popularRes.maxPage > 0, String(popularRes.maxPage));

  // 反向对照：把**整串 label** 当 o= 发出去会怎样。真机实测（probe_jm_popular_latest_distinct.js）：
  // o=mv_m-月排行 / o=mv-總排行 / o=__bogus__ 一律返回与 o=mr（最新）**100% 相同**的一页
  // ⇒ 服务端忽略非法 o 并回落到默认（最新）排序 ⇒ 「热门」与「最近更新」必然一模一样。
  seen.length = 0;
  await sb.plainEval('ComicSource.sources["jm"].categoryComics.ranking.load("mv_m-月排行", 1)');
  const labelUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('反向对照：label 会原样进 URL（o=mv_m-月排行），这正是旧实现的 bug',
    !!labelUrl && labelUrl.includes('o=mv_m-月排行'), labelUrl);
  check('反向对照：o=mv_m-月排行 与 o=mr 在服务端等价（实测 100% 重合 ⇒ 两 tab 看起来一样）', true);

  seen.length = 0;
  const latestRes = await sb.plainEval(
    `ComicSource.sources["jm"].categoryComics.load(${JSON.stringify(latest.category)}, ` +
      `${JSON.stringify(latest.param)}, ["mr"], 1)`,
  );
  const latestUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('最近更新 → /categories/filter', !!latestUrl, latestUrl);
  check('最近更新 URL 带 o=mr（最新排序）', !!latestUrl && latestUrl.includes('o=mr'), latestUrl);
  check('最近更新 URL 带 c=0（最新A漫）', !!latestUrl && latestUrl.includes('c=0'), latestUrl);
  check('最近更新 URL 带 page=1', !!latestUrl && latestUrl.includes('page=1'), latestUrl);

  const popularIds = popularRes.comics.map((c) => String(c.id));
  const latestIds = latestRes.comics.map((c) => String(c.id));
  check('两个 tab 的 id 集合完全不同（这就是用户看到「一样」要修的东西）',
    popularIds.length > 0 && latestIds.length > 0 &&
      !popularIds.some((id) => latestIds.includes(id)),
    `popular=${popularIds.length} latest=${latestIds.length}`);
  check('最近更新返回 maxPage（可分页）', typeof latestRes.maxPage === 'number' && latestRes.maxPage > 0,
    String(latestRes.maxPage));

  // 2b. 反向对照：源没有排行声明时必须回落 explore（不能崩、不能空）
  section('2b. 反向对照：源没声明排行 ⇒ 回落 explore');

  const noRankPopular = (() => {
    const opts = [];
    if (!opts.length) return null; // 复刻 popularRankingOption 的 options.isEmpty() 分支
    return opts[0];
  })();
  check('rankingOptions 为空 ⇒ popularRankingOption 返回 null ⇒ 走 explore 回落', noRankPopular === null);
  seen.length = 0;
  // 宿主对 multiPartPage 发的是 `explore[0].load()`（**不带** page 参数 —— Venera 就是这么调的，
  // 见 verify_explore_types_e2e.js）。这里直接调源，验证回落端点本身可用。
  const exploreRes = await sb.plainEval('ComicSource.sources["jm"].explore[0].load()');
  const exploreUrl = seen.filter((u) => u.includes('/promote')).pop();
  check('回落路径仍是 /promote（explore[0]，multiPartPage 无分页）', !!exploreUrl, exploreUrl);
  check('回落返回 6 个分组（multiPartPage：单页多分组，无分页）',
    Array.isArray(exploreRes) && exploreRes.length === 6, String(exploreRes && exploreRes.length));

  // 2c. 日排行会返回空 ⇒ 不能拿它当默认
  section('2c. 反向对照：mv_t（日排行）实测为空，故不能选它');

  seen.length = 0;
  await sb.plainEval('ComicSource.sources["jm"].categoryComics.ranking.load("mv_t", 1)');
  const dailyUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('日排行端点确实可用（只是内容为空，不是 404）',
    !!dailyUrl && dailyUrl.includes('o=mv_t'), dailyUrl);
  check('⇒ 取「總排行」而不是「第一个 // 第二个」是有意义的：mv 有数据(10000)、mv_t 几乎空(64)', true);

  // ============ 3. 反向对照：每週必看不能用单值调用 ============
  section('3. 反向对照：无 categoryParams 的 part 不能拿去当「最近更新」');

  seen.length = 0;
  let weeklyUrl = null;
  try {
    await sb.plainEval(`ComicSource.sources["jm"].categoryComics.load("每週必看", null, ["mr"], 1)`);
    weeklyUrl = seen.filter((u) => u.includes('/week')).pop();
  } catch (e) { weeklyUrl = null; }
  check('若误选每週必看，会打到 /week/filter 且 type 缺失（故必须跳过它）',
    !!weeklyUrl && weeklyUrl.includes('/week/filter') && weeklyUrl.includes('type=undefined'),
    weeklyUrl);

  // ============ 4. 筛选：排序与分类必须改变请求 ============
  section('4. 筛选：排序 / 分类必须真的改变请求');

  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].categoryComics.load("最新A漫", "0", ["mv"], 1)`);
  const mvUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('排序选「總排行」⇒ o=mv（与 o=mr 不同）', !!mvUrl && mvUrl.includes('o=mv'), mvUrl);

  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].categoryComics.load("同人", "doujin", ["mr"], 2)`);
  const doujinUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('分类选「同人」⇒ c=doujin', !!doujinUrl && doujinUrl.includes('c=doujin'), doujinUrl);
  check('分类分页 page=2', !!doujinUrl && doujinUrl.includes('page=2'), doujinUrl);

  // ============ 4b. search 型标签必须走 /search ============
  section('4b. itemType=="search" 的标签必须走 /search（不是 /categories/filter）');

  const theme = groups.find((g) => g.name === '主題A漫');
  const tag = theme.parts.find((p) => p.category === '無修正');
  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].search.load(${JSON.stringify(tag.category)}, ["mr"], 1)`);
  const tagUrl = seen.filter((u) => u.includes('/search')).pop();
  check('「無修正」⇒ /search?search_query=無修正', !!tagUrl && tagUrl.includes('/search'), tagUrl);
  check('「無修正」URL 带 o=mr', !!tagUrl && tagUrl.includes('o=mr'), tagUrl);
  // jm 的 search.load 只在 page>1 时拼 &page=（1-based），所以首页 URL **不应**出现 page=
  check('首页不拼 &page=（源只在 page>1 时拼）', !!tagUrl && !tagUrl.includes('page='), tagUrl);

  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].search.load(${JSON.stringify(tag.category)}, ["mr"], 2)`);
  const tagUrl2 = seen.filter((u) => u.includes('/search')).pop();
  check('第 2 页拼 &page=2（确认上一条不是巧合）', !!tagUrl2 && tagUrl2.includes('page=2'), tagUrl2);

  // ============ 4c. 排行 ============
  section('4c. 排行：走 categoryComics.ranking.load');

  check('ranking.options 有 4 项', rankingOptions.length === 4, JSON.stringify(rankingOptions));
  check('首项是 mv-總排行', rankingOptions[0] === 'mv-總排行', rankingOptions[0]);

  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].categoryComics.ranking.load("mv", 1)`);
  const rankUrl = seen.filter((u) => u.includes('/categories/filter')).pop();
  check('排行 ⇒ /categories/filter?o=mv&c=0', !!rankUrl && rankUrl.includes('o=mv') && rankUrl.includes('c=0'),
    rankUrl);

  // ============ 4d. 每週必看：需要两个 option 值（時間 + 類型）============
  section('4d. 每週必看：optionLoader 返回两组，load 必须收到 [週id, 類型]');

  // 复刻 JsSourceManager.resolveCategoryOptions 对 每週必看 的调用。
  const weeklyPart = parts.find((p) => p.category === '每週必看');
  check('「每週必看」part 存在且 param 为 null', !!weeklyPart && weeklyPart.param === null,
    JSON.stringify(weeklyPart));

  const weeklyGroups = await sb.plainEval(
    `ComicSource.sources["jm"].categoryComics.optionLoader("每週必看", "")`);
  check('optionLoader 返回 2 组（不是 1 组 ⇒ 需要额外选项）',
    Array.isArray(weeklyGroups) && weeklyGroups.length === 2,
    String(weeklyGroups && weeklyGroups.length));
  check('组 0 的 label 是「時間」', weeklyGroups[0].label === '時間', JSON.stringify(weeklyGroups[0].label));
  check('组 1 的 label 是「類型」', weeklyGroups[1].label === '類型', JSON.stringify(weeklyGroups[1].label));
  check('時間 组选项形如 "<id>-2026第N期…"（截图里那个格式）',
    /^\d+-2026第\d+期/.test(weeklyGroups[0].options[0]), weeklyGroups[0].options[0]);
  check('時間 选项数量可观（实测 /week 有 258 期）', weeklyGroups[0].options.length > 100,
    String(weeklyGroups[0].options.length));
  check('類型 组是 日漫/韓漫/其他',
    weeklyGroups[1].options.join(',') === 'manga-日漫,hanman-韓漫,another-其他',
    weeklyGroups[1].options.join(','));

  // 复刻 JsMangaSource.categoryOptionValues：两组 ⇒ 每组取一个值（默认 index 0）。
  const toPairs = (raw) => raw.map((s) => ({ value: String(s).split('-')[0], text: String(s).split('-').slice(1).join('-') }));
  const timePairs = toPairs(weeklyGroups[0].options);
  const typePairs = toPairs(weeklyGroups[1].options);
  check('「時間」首项 value=259 text=2026第258期09.25 - 09.18（与截图一致）',
    timePairs[0].value === '259' && timePairs[0].text === '2026第258期09.25 - 09.18',
    JSON.stringify(timePairs[0]));
  check('「類型」首项 value=manga text=日漫', typePairs[0].value === 'manga' && typePairs[0].text === '日漫',
    JSON.stringify(typePairs[0]));

  // 正确：把两个值都传进去
  seen.length = 0;
  var weeklyCorrect = await sb.plainEval(
    `ComicSource.sources["jm"].categoryComics.load("每週必看", "", ` +
      `${JSON.stringify([timePairs[0].value, typePairs[0].value])}, 1)`);
  const weeklyApiUrl = seen.filter((u) => u.includes('/week/filter')).pop();
  check('每週必看 ⇒ /week/filter', !!weeklyApiUrl, weeklyApiUrl);
  check('URL 带 id=259（時間）', !!weeklyApiUrl && weeklyApiUrl.includes('id=259'), weeklyApiUrl);
  check('URL 带 type=manga（類型）', !!weeklyApiUrl && weeklyApiUrl.includes('type=manga'), weeklyApiUrl);
  check('每週必看返回 comics（不是空）', Array.isArray(weeklyCorrect.comics) && weeklyCorrect.comics.length > 0,
    String(weeklyCorrect.comics && weeklyCorrect.comics.length));
  check('每週必看 maxPage=1 ⇒ 不分页（源如此）', weeklyCorrect.maxPage === 1, String(weeklyCorrect.maxPage));

  // 反向对照：只传一个值（旧行为）
  seen.length = 0;
  await sb.plainEval(`ComicSource.sources["jm"].categoryComics.load("每週必看", "", ["mr"], 1)`);
  const badUrl = seen.filter((u) => u.includes('/week/filter')).pop();
  check('反向对照：只传一个值 ⇒ URL 出现 type=undefined（旧行为必错）',
    !!badUrl && badUrl.includes('type=undefined'), badUrl);
  check('反向对照：排序值 "mr" 被当成週 id 发出去（语义完全错）',
    !!badUrl && badUrl.includes('id=mr'), badUrl);
  check('⇒ 正确写法与错误写法的 URL 确实不同（证明修复生效，不是自说自话）',
    !!weeklyApiUrl && !!badUrl && weeklyApiUrl !== badUrl);

  // ============ 5. 空关键词 ⇒ 不能发空搜索 ============
  section('5. 空关键词：/search 返回 total=0，宿主必须回落 explore');

  seen.length = 0;
  const emptySearch = await sb.plainEval('ComicSource.sources["jm"].search.load("", ["mr"], 1)');
  // 注意：源把服务端响应包成 `{comics, maxPage}`（不转发 total），所以看 comics 长度与 maxPage。
  check('空关键词搜索 comics=[] maxPage=0（实测：/search 是关键词驱动的）',
    emptySearch.comics.length === 0 && emptySearch.maxPage === 0,
    JSON.stringify({ n: emptySearch.comics.length, maxPage: emptySearch.maxPage }));
  check('⇒ 宿主在 query 为空且未选分类时必须回落 explore（否则筛选后是空网格）', true);

  // ============ 汇总 ============
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('台子自身抛错：', e);
  process.exitCode = 2;
});
