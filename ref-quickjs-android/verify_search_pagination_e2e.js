#!/usr/bin/env node
/**
 * verify_search_pagination_e2e.js — 「搜索时无限显示相同的漫画」的宿主侧根因与修法。
 *
 * 真机现象（用户截图 Screenshot_20261001_231123）：在 **源浏览页的搜索**里，
 * 网格每一格都是同一条标题（「没穿裤子用肉棒征服妹子大作战」），底部持续转圈 ——
 * 即 **Paging 一直在 append，而每次 append 拿到的是同一批漫画**。
 *
 * ### 谁在重复？本文件把三层分开验证
 *
 *  1. **源层**：`jm.js search.load(keyword, options, page)` 只在 `page > 1` 时拼 `&page=`
 *     （1-based）。服务端若忽略/不前进，则 page=1/2/3 返回同一批 content，而
 *     `total` 仍很大 ⇒ `maxPage = ceil(total/80)` 很大。
 *
 *  2. **适配层（JsMangaSource.parseListing）**：`hasNextPage = maxPage != null && maxPage > 0`
 *     —— 只要源报了个正数 maxPage，宿主就无条件继续翻。**从未校验「本页内容是否前进」**。
 *     这就是无限 append 的开关。
 *
 *  3. **UI 层（BrowseMangaSourceComfortableGrid）**：`items(count = itemCount) { index -> }`
 *     **没有 key**。当 Paging 真的追加了 N 份相同数据时，Compose 按位置复用 slot，
 *     视觉上就是「每一格都是同一本」。
 *
 * ### 修法（本文件同时钉住契约）
 *
 * `parseListing` 必须维护 **上一页返回的 id 集合**，当新页与上一页**高度重叠**（或完全相同）
 * 时判定「内容没有前进」，`hasNextPage = false` —— 这是唯一不依赖服务端语义的停止条件。
 * 同时 `getSearchManga` 在**第 2 页开始**才允许携带 page 参数之外的变化；页码语义保持 1-based。
 *
 * ### 台子纪律
 *
 * 本文件不联网：mock 回放的是 `probe_jm_search_order.js` / `verify_listing_eval_e2e.js`
 * 已经实测下来的字段结构。**反向对照**在最后一节：把 mock 改回「page 生效」的响应，
 * 断言新逻辑**不会**错误地提前停止分页（避免修复引入「只能翻一页」的新 bug）。
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

// --- Kotlin-equivalent `Convert.*`（与 verify_listing_eval_e2e.js 一致）------------------------

const ktEncodeUtf8 = (str) => Buffer.from(String(str), 'utf8');
function ktDecodeUtf8(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  return Buffer.from(value).toString('utf8');
}
function ktMd5(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  return crypto.createHash('md5').update(Buffer.from(value)).digest();
}
const ktBase64Encode = (value) => Buffer.from(value).toString('base64');
function ktBase64Decode(text) {
  if (typeof text !== 'string') return null;
  try { return Buffer.from(text.replace(/[\s\uFEFF]/g, ''), 'base64'); } catch (e) { return null; }
}
function ktAesEcb(value, key, encode) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array)) return null;
  key = Buffer.from(key);
  value = Buffer.from(value);
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
function jmSeal(plaintext, secret) {
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-256-ecb', jmKey(secret), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}
const apiSecretAt = (t) => `${t}${JM_API_SECRET}`;

const FROZEN_NOW_MS = 1767225600000;
Date.now = () => FROZEN_NOW_MS;
const NOW_SEC = Math.floor(FROZEN_NOW_MS / 1000);

// --- 响应构造 -----------------------------------------------------------------------------------

/** 生成一页 `/search` 响应，id 从 `startId` 起。 */
function searchPayload({ total, count, startId, title = '没穿裤子用肉棒征服妹子大作战' }) {
  const content = [];
  for (let i = 0; i < count; i++) {
    content.push({
      id: String(startId + i),
      author: '作者',
      description: null,
      name: title,
      image: '',
      category: { id: '1', title: '同人' },
      category_sub: { id: '1', title: '同人' },
      liked: false,
      is_favorite: false,
      update_at: 1790819926,
      adddate: '2026-09-30',
    });
  }
  return { search_query: title, search_type: 'site', y: 0, m: 0, total, content };
}
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
      name: `分組${s + 1} 第${i}話`,
      image: '',
      category: { id: '1', title: '同人' },
      category_sub: { id: '1', title: '同人' },
      liked: false,
      is_favorite: false,
      update_at: 1790819926,
    })),
  }));
}

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}
function apiResponse(payload) {
  // 2026-10-07 起站点给 API 信封加了 UTF-8 BOM（真机 200 探针实锤），jm.js 1.4.2 parseBody() 剥离。
  return textEnvelope('\uFEFF' + JSON.stringify({ data: jmSeal(JSON.stringify(payload), apiSecretAt(NOW_SEC)) }));
}
function domainListResponse(servers) {
  return textEnvelope('\uFEFF' + jmSeal(JSON.stringify({ Server: servers }), DOMAIN_SECRET) + '\n');
}

// --- 沙箱 ---------------------------------------------------------------------------------------

/**
 * @param {{http:(msg)=>object|null, settings?:object}} host 收到的 `http` 消息 → 信封。
 *        回放 `jm.js` 真正会发的 URL（`/search?...&page=N`），让**页码进入 mock 的决策**，
 *        这样才不是「替宿主造状态」。
 */
function makeSandbox(host) {
  const httpHandler = host.http;
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
      const envelope = httpHandler(msg);
      if (envelope === null) return JSON.stringify({ status: null, headers: {}, body: null, error: 'network unreachable' });
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

  // 让源处于「已 init」状态：把 baseUrl 依赖的 apiDomains 直接供给（Venera 的 init 就是这么做的）。
  vm.runInContext(`JM.apiDomains = ${JSON.stringify(FETCHED_SERVERS)};`, sandbox);

  return {
    sandbox,
    calls,
    reflectMeta,
    rawEval: (expr) => vm.runInContext(expr, sandbox),
    awaitEval: async (expr, maxTicks = 64) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n' +
        '  try {\n' +
        '    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.value = v; globalThis.' + slot + '.done = true; },\n' +
        '      function (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '    );\n' +
        '  } catch (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '})();',
        sandbox,
      );
      for (let i = 0; i < maxTicks; i++) {
        await new Promise((r) => setImmediate(r));
        const st = vm.runInContext('globalThis.' + slot, sandbox);
        if (st.done) {
          if (st.error !== undefined) throw st.error;
          return st.value;
        }
      }
      throw new Error('awaitEval: promise never settled within ' + maxTicks + ' ticks');
    },
    /** 读出 `__plainValue` 之后的形态（init.js 的转换器）——与宿主拿到的数据同构。 */
    plainEval: async (expr) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n' +
        '  try {\n' +
        '    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.value = __plainValue(v); globalThis.' + slot + '.done = true; },\n' +
        '      function (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '    );\n' +
        '  } catch (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '})();',
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
      throw new Error('plainEval: promise never settled');
    },
  };
}

// --- 宿主侧 parseListing 的两种实现 -------------------------------------------------------------

/** 旧：只信 `maxPage>0`。 */
function parseListingOld(res) {
  const comics = flattenComics(res);
  const maxPage = res && typeof res === 'object' && !Array.isArray(res)
    ? Number.parseInt(String(res.maxPage), 10)
    : NaN;
  const hasNext = Number.isFinite(maxPage) && maxPage > 0;
  return { count: comics.length, ids: comics.map((c) => String(c.id)), hasNext };
}

/**
 * 新：额外用「与上一页的 id 重叠率」判「内容是否前进」。
 * 必须**逐页递增**（page == prevPage+1）才比较，避免 refresh 重取 page=1 被误停。
 */
function parseListingNew(res, prev, page) {
  const comics = flattenComics(res);
  const ids = comics.map((c) => String(c.id));
  const maxPage = res && typeof res === 'object' && !Array.isArray(res)
    ? Number.parseInt(String(res.maxPage), 10)
    : NaN;
  let hasNext = Number.isFinite(maxPage) && maxPage > 0;
  if (hasNext && prev && prev.page === page - 1 && ids.length) {
    const repeated = ids.filter((id) => prev.ids.has(id)).length;
    if (repeated / ids.length >= 0.9) hasNext = false; // 内容没有前进
  }
  return { count: comics.length, ids, hasNext, next: { ids: new Set(ids), page } };
}

function flattenComics(res) {
  if (Array.isArray(res)) return res.flatMap(flattenComics);
  if (res && typeof res === 'object') {
    if (Array.isArray(res.comics)) return res.comics.flatMap(flattenComics);
    return [res];
  }
  return [];
}

// --- 用例 ---------------------------------------------------------------------------------------

(async () => {
  console.log('verify_search_pagination_e2e.js — 搜索「无限显示相同漫画」的根因与修法');

  // ============ 第 1 节：源层 —— jm.js 的页码语义（1-based，page>1 才带? page=）==================
  section('1. 源层：jm.js search.load 的页码语义');

  const seenUrls = [];
  const host1 = {
    http(msg) {
      const url = msg.url;
      seenUrls.push(url);
      const u = new URL(url);
      if (u.hostname.includes('bytepluses')) return domainListResponse(FETCHED_SERVERS);
      if (u.pathname.startsWith('/search')) {
        const page = Number.parseInt(u.searchParams.get('page') || '1', 10);
        // 服务端忽略 page：永远吐同一批 80 条，但 total 很大 ⇒ maxPage 很大。
        return apiResponse(searchPayload({ total: 2827, count: 80, startId: 1478011 }));
      }
      if (u.pathname.startsWith('/promote')) return apiResponse(promotePayload());
      return null;
    },
    settings: {},
  };
  const sb1 = makeSandbox(host1);

  const p1 = await sb1.plainEval('ComicSource.sources["jm"].search.load("没穿裤子用肉棒征服妹子大作战", ["mr"], 1)');
  const p2 = await sb1.plainEval('ComicSource.sources["jm"].search.load("没穿裤子用肉棒征服妹子大作战", ["mr"], 2)');
  const p3 = await sb1.plainEval('ComicSource.sources["jm"].search.load("没穿裤子用肉棒征服妹子大作战", ["mr"], 3)');

  const searchUrls = seenUrls.filter((u) => u.includes('/search'));
  check('page=1 的请求 URL 不带 &page=', !searchUrls[0].includes('page='), searchUrls[0]);
  check('page=2 的请求 URL 带 &page=2', searchUrls[1].includes('page=2'), searchUrls[1]);
  check('page=3 的请求 URL 带 &page=3', searchUrls[2].includes('page=3'), searchUrls[2]);
  check('源返回 {comics, maxPage}', p1 && Array.isArray(p1.comics) && typeof p1.maxPage === 'number');
  check('maxPage = ceil(2827/80) = 36', p1.maxPage === 36, String(p1.maxPage));
  check('服务端忽略 page ⇒ 三页首条 id 相同（这就是设备上看到的重复）',
    String(p1.comics[0].id) === String(p2.comics[0].id) && String(p2.comics[0].id) === String(p3.comics[0].id));

  // ============ 第 2 节：适配层 —— 旧 hasNextPage 判定 = 无限 append 的开关 =====================
  section('2. 适配层：旧 parseListing 无条件继续翻页');

  let prevIds = null;
  const pageIds = [];
  let appendedPages = 0;
  // 模拟 Paging：只要 hasNextPage 就继续 page+1，直到上限（设备上是「无限」）。
  for (let page = 1; page <= 6; page++) {
    const res = page === 1 ? p1 : page === 2 ? p2 : p3;
    const out = parseListingOld(res);
    pageIds.push(out.ids);
    if (out.hasNext) appendedPages++;
  }
  check('旧逻辑：6 次请求都认为 hasNextPage=true（无限 append）', appendedPages === 6, String(appendedPages));
  const oldAllIds = pageIds.flat();
  check('旧逻辑：累计 480 条，去重后只有 80 条 ⇒ 视觉上「无限相同」',
    oldAllIds.length === 480 && new Set(oldAllIds).size === 80,
    `total=${oldAllIds.length} distinct=${new Set(oldAllIds).size}`);

  // ============ 第 3 节：新逻辑 —— 「内容没前进」必须停 =========================================
  section('3. 修复：识别「内容没有前进」并停止分页');

  prevIds = null;
  const newPages = [];
  for (let page = 1; page <= 6; page++) {
    const res = page === 1 ? p1 : p2;
    const out = parseListingNew(res, prevIds, page);
    newPages.push({ page, count: out.count, hasNext: out.hasNext });
    if (!out.hasNext) break;
    prevIds = out.next;
  }
  check('新逻辑：第 1 页 hasNext=true（首屏之后还有真实内容可探）', newPages[0].hasNext === true);
  check('新逻辑：第 2 页与第 1 页完全重叠 ⇒ hasNext=false，循环在第 2 页终止',
    newPages.length === 2 && newPages[1].hasNext === false,
    JSON.stringify(newPages));
  check('新逻辑：只抓了 2 页（不再无限）', newPages.length === 2, String(newPages.length));

  // ============ 第 4 节：反向对照 —— 服务端分页正常时不能被误停 =================================
  section('4. 反向对照：服务端分页正常 ⇒ 新逻辑必须继续翻');

  const seenUrls2 = [];
  const host2 = {
    http(msg) {
      const url = msg.url;
      seenUrls2.push(url);
      const u = new URL(url);
      if (u.hostname.includes('bytepluses')) return domainListResponse(FETCHED_SERVERS);
      if (u.pathname.startsWith('/search')) {
        const page = Number.parseInt(u.searchParams.get('page') || '1', 10);
        // 正常分页：每页 80 条，id 连续前进。
        return apiResponse(searchPayload({ total: 2827, count: 80, startId: 1478011 + (page - 1) * 80 }));
      }
      if (u.pathname.startsWith('/promote')) return apiResponse(promotePayload());
      return null;
    },
    settings: {},
  };
  const sb2 = makeSandbox(host2);
  const q1 = await sb2.plainEval('ComicSource.sources["jm"].search.load("魔法少女", ["mr"], 1)');
  const q2 = await sb2.plainEval('ComicSource.sources["jm"].search.load("魔法少女", ["mr"], 2)');
  const q3 = await sb2.plainEval('ComicSource.sources["jm"].search.load("魔法少女", ["mr"], 3)');

  let rPrev = null;
  const rPages = [];
  let rPage = 0;
  for (const res of [q1, q2, q3]) {
    rPage++;
    const out = parseListingNew(res, rPrev, rPage);
    rPages.push(out.hasNext);
    rPrev = out.next;
  }
  check('正常分页：三页都 hasNext=true（不被误停）', rPages.every((x) => x === true), JSON.stringify(rPages));
  check('正常分页：三页 id 完全不重叠（真的在前进）',
    new Set(q1.comics.map((c) => String(c.id))).size === 80 &&
      !q1.comics.some((c) => String(c.id) === String(q2.comics[0].id)));

  // ============ 第 5 节：explore（浏览页 tab）不受影响 ==========================================
  section('5. 浏览页 explore：multiPartPage 无分页，hasNextPage 必须 false');

  const ex = await sb1.plainEval('ComicSource.sources["jm"].explore[0].load(0)');
  check('explore[0].load(0) 返回分组数组', Array.isArray(ex) && ex.length === 6, String(ex && ex.length));
  const exOld = parseListingOld(ex);
  check('explore 是数组 ⇒ 旧逻辑 maxPage=NaN ⇒ hasNextPage=false（浏览页本来就对）', exOld.hasNext === false);
  check('explore 分组被正确摊平成 6×30=180 本', exOld.count === 180, String(exOld.count));

  // ============ 第 6 节：反向对照 —— refresh / 重试同页不能被误停 ==============================
  section('6. 反向对照：refresh 重新请求 page=1 ⇒ 不能被误判为 stall');

  // 场景：用户先翻了 1、2 页（看到 stall 就停了），随后下拉刷新 —— Paging 的 getRefreshKey 返回
  // null，于是**重新从 page=1 开始**。若守卫不校验「页码递增」，page=1 会与上一次记录的 page=2
  // 去比 —— 而正常分页下 page1 与 page2 不重叠，反而侥幸安全；真正危险的是「上次记录停在 page=1」
  // 的情形（例如首屏只有一页就 refresh），此时 page=1 与记录 page=1 完全重叠 ⇒ 健康源被误停。
  // 所以断言的是：**只有 page === prev.page + 1 才比较**。
  const guardCases = [
    { label: 'page=1 遇 prev.page=1（refresh 首屏）⇒ 不比较，hasNext 保持 true', prev: { page: 1 }, page: 1, wantHasNext: true },
    { label: 'page=1 无 prev（真实首次请求）⇒ 不比较，hasNext 保持 true', prev: null, page: 1, wantHasNext: true },
    { label: 'page=2 遇 prev.page=1（正常推进，内容相同）⇒ 比较并停止', prev: { page: 1 }, page: 2, wantHasNext: false },
  ];
  for (const gc of guardCases) {
    const prev = gc.prev ? { ids: new Set(p1.comics.map((c) => String(c.id))), page: gc.prev.page } : null;
    const out = parseListingNew(p1, prev, gc.page);
    check(gc.label, out.hasNext === gc.wantHasNext, `hasNext=${out.hasNext}`);
  }

  // ============ 汇总 ============================================================================
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('台子自身抛错：', e);
  process.exitCode = 2;
});
