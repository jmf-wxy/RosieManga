#!/usr/bin/env node
/**
 * verify_map_chapters_e2e.js — 「共 48 章 + Missing 11 items + 没有章节」为什么修不掉。
 *
 * 真机现象（用户截图，魔法少女服务 1014509）：详情页显示 48 章、章节名全是「第 N 话」、
 * 日期一律「无」、列表里夹着一行红字 **Missing 11 items**，打开详情页时还弹「没有章节」。
 *
 * ### 根因：JS `Map` 在跨回 Kotlin 那一步是**空的**
 *
 * Venera 的 `ComicDetails` 契约允许源把 `chapters` 作为 `Map<string,string>` 返回 —— jm.js 就是
 * 这么写的（`chapters.set(id, title)`），`tags` 同理是 `Map<string, string[]>`。而 wrapper 的
 * 对象→Kotlin 转换（`QuickJSObject.convertToMap`）用 `JS_GetOwnPropertyNames` 枚举一个值 ——
 * `Map` 实例的条目放在**内部槽**里，不是自有属性，所以 `new Map([['a','b']])` 到 Kotlin 手里
 * 是**空 `{}`**。于是：
 *
 *  1. `getChapterList` 恒返回 `emptyList()`；
 *  2. 详情页自动刷新走 `SyncChaptersWithSource`，空列表 ⇒ `throw NoChaptersException`
 *     ⇒ UI 弹 `no_chapters_error` = **「没有章节」**（截图里那条黑条）；
 *  3. `.venera` 导入端 `fetchRealChapters` 拿到空 ⇒ 按设计**一个章节都不写**（宁缺勿错），
 *     而且提前 return，连 `removeStaleChapters` 都不跑 ⇒ 第一次导入留下的 48 条坏行
 *     （url = `1014509||<位置>`，chapterNumber = 位置值 {1..40,42..47,58,59}）**永远没人清**；
 *  4. 那 48 条坏行的数字集合恰好缺 41、48..57 —— 按 `MissingChapters` 的算法总数正好 **11**
 *     ⇒ 截图上的「Missing 11 items」。
 *
 * ### 修复（两代）
 *
 * 第一代：在**结果读出点**（`evalAwaitingResult` / `evalForValueBlocking`）用 init.js 的
 * `__plainValue` 先在 JS 侧把 Map/Set/类实例摊平——但 Map→「键序对象」在 native 边界连死两次：
 * `\u0000` 前缀被 JNI modified-UTF-8 当 C 字符串终结符截断（全部键变 "" ⇒「共 1 章」，S18）；
 * 换 `\u200b` 救了数量，但 `QuickJSObject.toMap` 用 HashMap 收键，哈希序照样打乱阅读序（S18b）。
 *
 * 第二代（现行）：`__plainValue` 把 Map 转成**有序 [key,value] 对数组**——嵌套 JSArray 在
 * `convertToMap` 里按 index 走成 ArrayList，数量与插入序同时幸存；Kotlin `getChapterList`
 * 读对数组（plain-object chapters 仍走 Map 兜底）。
 *
 * ### 与设备的一致性
 *
 * Node/V8 复现不了 native 编组本身，但 `Object.getOwnPropertyNames(new Map()) === []` 是
 * ECMAScript 事实，QuickJS 的 `JS_GetOwnPropertyNames` 同样如此 —— 用它逐字转写 Kotlin 的
 * `toKotlinValue`/`convertToMap` 即可。真 `init.js` + 真 `jm.js`，`/album` 响应按真实结构回放。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const JM_API_SECRET = '185Hcomic3PAPP7R';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
const DOMAIN_LIST_URL = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';
const FETCHED_SERVERS = ['www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club'];
const IMG_HOST = 'https://cdn-msp.example.net';
const COMIC_ID = '1014509'; // 魔法少女服务 [禁漫天堂x不咕鸟汉化组]

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// --- Kotlin-equivalent `Convert.*` ---------------------------------------------------------------

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

// --- /album 响应（真实结构；series 59 话、name 留空让 jm.js 自己补「第N話」）----------------------

function albumPayload() {
  const series = [];
  for (let sort = 1; sort <= 59; sort++) {
    series.push({ id: String(5500000 + sort), name: '', sort });
  }
  return {
    id: COMIC_ID,
    name: '魔法少女服务 [禁漫天堂x不咕鸟汉化组]',
    description: '有一天，金南珠被来自仙境的生物"Seobi"强行变成了吉祥物。',
    author: ['不知道作者'],
    works: [],
    actors: [],
    tags: ['魔法少女', '兔女郎', '韩漫', '完结', '中文'],
    series,
    related_list: [],
    likes: 0,
    liked: false,
    is_favorite: 0,
    total_views: 0,
    addtime: 1735689600,
  };
}

// --- 沙箱 ----------------------------------------------------------------------------------------

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}
function apiResponse(payload) {
  // 2026-10-07 起站点给 API 信封加了 UTF-8 BOM（真机 200 探针实锤），jm.js 1.4.2 parseBody() 剥离。
  return textEnvelope('\uFEFF' + JSON.stringify({ data: jmSeal(JSON.stringify(payload), apiSecretAt(Math.floor(Date.now() / 1000))) }));
}
function domainListResponse(servers) {
  return textEnvelope('\uFEFF' + jmSeal(JSON.stringify({ Server: servers }), DOMAIN_SECRET) + '\n');
}

function makeSandbox(host) {
  const calls = [];
  const saved = {};
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder,
    setTimeout, clearTimeout,
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
      if (envelope === null) {
        return JSON.stringify({ status: null, headers: {}, body: null, error: 'network unreachable' });
      }
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

  return {
    sandbox,
    checks: calls,
    reflectMeta,
    awaitEval: async (expr, maxTicks = 64) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n' +
        '  try {\n' +
        '    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.done = true; globalThis.' + slot + '.value = v; },\n' +
        '      function (e) { globalThis.' + slot + '.done = true; globalThis.' + slot + '.error = String((e && e.message) || e); }\n' +
        '    );\n' +
        '  } catch (e) {\n' +
        '    globalThis.' + slot + '.done = true;\n' +
        '    globalThis.' + slot + '.error = String((e && e.message) || e);\n' +
        '  }\n' +
        '})();', sandbox);
      for (let i = 0; i < maxTicks; i++) {
        if (vm.runInContext('globalThis.' + slot + '.done === true', sandbox) === true) break;
        vm.runInContext('void 0', sandbox);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const out = {
        done: vm.runInContext('globalThis.' + slot + '.done === true', sandbox) === true,
        value: vm.runInContext('globalThis.' + slot + '.value', sandbox),
        error: vm.runInContext('globalThis.' + slot + '.error', sandbox),
      };
      vm.runInContext('delete globalThis.' + slot, sandbox);
      return out;
    },
  };
}

function makeHost() {
  const httpCalls = [];
  const host = {
    settings: {},
    http: (msg) => {
      httpCalls.push({ method: msg.http_method, url: msg.url });
      if (msg.url === DOMAIN_LIST_URL) return domainListResponse(FETCHED_SERVERS);
      if (msg.url.indexOf('/setting') !== -1) return apiResponse({ img_host: IMG_HOST });
      if (msg.url.indexOf('/album?id=' + COMIC_ID) !== -1) return apiResponse(albumPayload());
      return null;
    },
  };
  const s = makeSandbox(host);
  s.reflectMeta();
  return Object.assign(s, { host, httpCalls });
}

// --- Kotlin 侧的逐行转写 --------------------------------------------------------------------------

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.then !== 'function';

/**
 * `toKotlinValue` 的结构等价物（QuickJSObject.convertToMap 用 JS_GetOwnPropertyNames 枚举 ——
 * 对 `Map` 实例就是空集；Node 的等价观察 = Object.keys / for-in own enumerable）。
 */
function kotToMap(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(kotToMap);
  if (isMap(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = kotToMap(v[k]);
    return out;
  }
  return v;
}

/** 修复后的 Kotlin 读出点 = `withPlainValue(expr)`：先 `__plainValue` 再 `toKotlinValue`。 */
function kotToMapFixed(v, plain) {
  return kotToMap(plain(v));
}

/**
 * `JsMangaSource.getChapterList` 的转写（manga.url = comicId）。
 * S18 契约：Map chapters 由 `__plainValue` 交付为**有序 [key,value] 对数组**（嵌套 JSArray →
 * native convertToMap 按 index 走成 ArrayList，数量与插入序都活着）；plain-object chapters
 * 仍是 Map（HashMap 哈希序兜底，仅保证数量）。
 */
function hostGetChapterList(details, comicId) {
  const raw = details.chapters;
  const entries = Array.isArray(raw)
    ? raw.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [String(p[0]), p[1]])
    : isMap(raw) ? Object.entries(raw) : [];
  const chapters = entries.map(([k, v], i) => ({
    url: comicId + '||' + k,
    name: (v !== null && v !== undefined && String(v).trim() !== '') ? String(v) : k,
    // 编号在阅读序上先做（最旧 = 1），反转后最新章保持最大编号。
    chapter_number: i + 1,
  }));
  // 源给的是旧→新；章节列表自上而下要新→旧（用户对「有没有更新」的检查发生在列表顶部）。
  return chapters.reverse();
}

/** `MissingChapters.missingChaptersCount` 的转写。 */
function missingChaptersCount(numbers) {
  const items = numbers.filter((n) => n !== -1).map((n) => Math.trunc(n))
    .filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  let count = 0, prev = 0;
  for (const cur of items) {
    if (cur > prev + 1) count += cur - prev - 1;
    prev = cur;
  }
  return count;
}

/**
 * 第一次导入留下的坏行（readEpisode 位置直写：url=`comicId||位置`，chapterNumber=位置值）。
 * readEpisode 实测值：'1..20,58,59,21..40,42..47'（48 个）。
 */
function bogusDbChapters() {
  const eps = [];
  for (let i = 1; i <= 20; i++) eps.push(i);
  eps.push(58, 59);
  for (let i = 21; i <= 40; i++) eps.push(i);
  for (let i = 42; i <= 47; i++) eps.push(i);
  return eps.map((ep) => ({ url: COMIC_ID + '||' + ep, chapter_number: ep, name: '第 ' + ep + ' 话' }));
}

/** `SyncChaptersWithSource` 的删除腿：源列表里没有 url 的 DB 行全部删除。 */
function syncRemoved(dbChapters, sourceChapters) {
  if (sourceChapters.length === 0) throw new Error('NoChaptersException(没有章节)');
  return dbChapters.filter((db) => !sourceChapters.some((sc) => sc.url === db.url));
}

const floating = [];
process.on('unhandledRejection', (r) => floating.push(String((r && r.message) || r)));

(async () => {
  console.log('MAP CHAPTERS LEG — 真 init.js + 真 jm.js，/album 按 59 话真实结构回放\n');

  // -------------------------------------------------------------------------------------------
  section('0. 前置：源自己的 init() 生命周期（不替它造任何状态）');
  const ctx = makeHost();
  {
    const init = await ctx.awaitEval("ComicSource.sources['jm'].init()");
    check('init() settle', init.done, JSON.stringify(init));
    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('JM.apiDomains 由源自己填好', Array.isArray(domains) && domains.length === 4, JSON.stringify(domains));
    check('init.js 提供了 __plainValue', vm.runInContext("typeof globalThis.__plainValue === 'function'", ctx.sandbox));
  }

  // -------------------------------------------------------------------------------------------
  section('1. __plainValue 单元：Map/Set/类实例摊平、二进制原样、顺序保留');
  {
    const unit = await ctx.awaitEval(
      '(function () {' +
      '  var m = new Map(); m.set("b", 1); m.set("a", 2); m.set("c", new Map([["deep", true]]));' +
      '  return { chapters: m, tags: new Set(["x","y"]), buf: new Uint8Array([1,2,3]), n: 5, s: "t" };' +
      '})()',
    );
    const plain = vm.runInContext('__plainValue', ctx.sandbox)(unit.value);
    check('Map → 有序 [key,value] 对数组，插入序保留（b 先于 a）',
      Array.isArray(plain.chapters) &&
        JSON.stringify(plain.chapters.map((p) => p[0])) === JSON.stringify(['b', 'a', 'c']),
      JSON.stringify(plain.chapters));
    check('嵌套 Map 一并转成对数组（deep 挂在 value 位）',
      Array.isArray(plain.chapters[2][1]) && plain.chapters[2][1][0][0] === 'deep' &&
        plain.chapters[2][1][0][1] === true,
      JSON.stringify(plain.chapters[2]));
    check('Set → 数组', Array.isArray(plain.tags) && plain.tags.join() === 'x,y', JSON.stringify(plain.tags));
    check('ArrayBuffer/视图原样穿透（编成 byte[] 的通道不能被拍扁）',
      plain.buf instanceof Uint8Array && plain.buf.length === 3, Object.prototype.toString.call(plain.buf));
    check('标量原样', plain.n === 5 && plain.s === 't', JSON.stringify(plain));
  }

  // -------------------------------------------------------------------------------------------
  section('2. CONTROL：旧读出点 —— chapters(Map) 塌成 {} ⇒ 「没有章节」+ 坏行永生');
  let detailsOld = null;
  {
    const out = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`);
    check('loadInfo settle（网络这条腿是通的）', out.done && !out.error, String(out.error));
    check('JS 侧返回的是 ComicDetails 对象（非 Promise、非空）',
      out.value !== null && typeof out.value === 'object' && typeof out.value.then !== 'function' &&
        typeof out.value.chapters !== 'undefined',
      Object.prototype.toString.call(out.value));

    detailsOld = kotToMap(out.value);
    check('Kotlin 视角：chapters 是**空对象**（内部槽不可枚举）',
      isMap(detailsOld.chapters) && Object.keys(detailsOld.chapters).length === 0,
      JSON.stringify(Object.keys(detailsOld.chapters || {})));

    const listOld = hostGetChapterList(detailsOld, COMIC_ID);
    check('getChapterList ⇒ 0 章', listOld.length === 0, String(listOld.length));

    let threw = null;
    try { syncRemoved(bogusDbChapters(), listOld); } catch (e) { threw = e; }
    check('详情页自动刷新 ⇒ NoChaptersException ⇒ UI 弹「没有章节」（截图那条黑条）',
      threw !== null && /NoChaptersException/.test(String(threw)), String(threw));
  }

  // -------------------------------------------------------------------------------------------
  section('3. FIX：新读出点（先 __plainValue）—— 59 话全数到达，顺序/编号/名字都对');
  let listNew = null;
  {
    const out = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`);
    const plain = vm.runInContext('__plainValue', ctx.sandbox);
    const details = kotToMapFixed(out.value, plain);
    check('Kotlin 视角：chapters 是有序对数组且有 59 对（嵌套 JSArray → convertToMap 按 index 走 ArrayList）',
      Array.isArray(details.chapters) && details.chapters.length === 59,
      String(Array.isArray(details.chapters) ? details.chapters.length : typeof details.chapters));

    const ids = details.chapters.map((p) => String(p[0]));
    check('JNI 边界契约：对键的 UTF-8 字节里没有 raw 0x00（NewStringUTF 在此截断 →「共 1 章」塌方）',
      ids.every((k) => Buffer.from(k, 'utf8').indexOf(0) === -1), '');
    check('对键 = series id，按 series.sort 升序（jm.js 排好序的插入序，HashMap 边界碰不到它）',
      ids[0] === '5500001' && ids[58] === '5500059', ids[0] + '..' + ids[58]);

    listNew = hostGetChapterList(details, COMIC_ID);
    check('getChapterList ⇒ 59 章', listNew.length === 59, String(listNew.length));
    check('最新置顶：list[0] = 第59話（最新），编号 = 阅读序反转 ⇒ 59..1 连续递减',
      listNew[0].chapter_number === 59 && listNew[58].chapter_number === 1 &&
        listNew.every((c, i) => c.chapter_number === 59 - i), '');
    check('url = comicId||seriesId（loadEp 的真实参数，不是位置）：顶部 = 最新章 5500059',
      listNew[0].url === COMIC_ID + '||5500059' && listNew[58].url === COMIC_ID + '||5500001', listNew[0].url);
    check('name 落到 jm.js 的「第N話」兜底（series name 为空时源自己补）',
      listNew[0].name === '第59話' && listNew[58].name === '第1話', listNew[0].name + ' / ' + listNew[58].name);
    check('tags(Map) 同步复活（详情页 genre 不再依赖备份里的旧列）',
      isMap(details.tags) && Array.isArray(details.tags.Tag) && details.tags.Tag.length === 5,
      JSON.stringify(details.tags));
  }

  // -------------------------------------------------------------------------------------------
  section('4. 坏行清账：48 条位置行被删、11 缺口归零');
  {
    const db = bogusDbChapters();
    check('坏行 48 条，数字集合与截图一致（缺 41、48..57）',
      db.length === 48 && missingChaptersCount(db.map((c) => c.chapter_number)) === 11,
      'missing=' + missingChaptersCount(db.map((c) => c.chapter_number)));

    const removed = syncRemoved(db, listNew);
    check('同步后 48 条全部进入删除名单（url 对不上任何真实章节）',
      removed.length === 48 && removed.every((c) => /^1014509\|\|\d+$/.test(c.url)), String(removed.length));

    const after = listNew.map((c) => c.chapter_number);
    check('真实列表的缺口数 = 0（Missing 11 items 消失）',
      missingChaptersCount(after) === 0, String(missingChaptersCount(after)));

    // 反向对照：旧读出点下这一步永远走不到——源列表为空直接抛，坏行原封不动。
    check('反向对照：旧读出点连删除名单都产不出来（修复前坏行永生）', detailsOld !== null);
  }

  // --- S18b：Map 插入序必须以「对数组」穿越 native HashMap 边界（2026-10-01 18:56「章节顺序乱」根因） --
  // 真机指纹：详情页顺序 = 第5話,42,37,20,34,27,第51話,… —— 既非升序也非降序 = QuickJSObject.toMap
  // 的 HashMap 哈希序。任何「对象键」方案（裸键 / \u0000 / \u200b）都死在这一层；只有数组
  // （→ ArrayList 按 index）能保序。Node 复现不了真哈希序，这里钉 JS 侧契约 + 键序对照。
  section('S18b. Map 插入序以对数组穿越 native 边界');
  {
    const sc = JSON.parse(vm.runInContext(`
      (function () {
        var m = new Map();
        m.set('5500009', '第9話'); m.set('5500002', '第2話');
        m.set('5500040', '第40話'); m.set('5500001', '第1話');
        var pairs = globalThis.__plainValue(m);
        var bare = {};
        m.forEach(function (v, k) { bare[k] = v; });   // 键序对象方案：JS 侧就已失序
        return JSON.stringify({ pairs: pairs, bare: Object.keys(bare) });
      })()
    `, ctx.sandbox));
    check('S18b: 对数组保持插入序（= 源的阅读序，与键是否整数样无关）',
      JSON.stringify(sc.pairs.map((p) => p[0])) === JSON.stringify(['5500009', '5500002', '5500040', '5500001']),
      JSON.stringify(sc.pairs));
    check('S18b: 反向对照——键序对象被 ECMAScript 重排成数值升序（native HashMap 再乱一层，两层都躲不开）',
      JSON.stringify(sc.bare) === JSON.stringify(['5500001', '5500002', '5500009', '5500040']),
      JSON.stringify(sc.bare));
    const healed = hostGetChapterList({ chapters: sc.pairs }, COMIC_ID);
    check('S18b: getChapterList url 干净（无前缀可剥）、最新置顶（阅读序反转 ⇒ 5500001 在顶、编号 4..1）',
      healed[0].url === COMIC_ID + '||5500001' && healed[0].chapter_number === 4 &&
        healed[3].url === COMIC_ID + '||5500009' && healed[3].chapter_number === 1,
      JSON.stringify(healed.map((c) => c.url)));
  }

  // --- S18：JNI modified-UTF-8 边界（2026-10-01 20:07「共 1 章」的根因，台子盲区第四类） --------------
  // 真机指纹：所有漫画详情页恒「共 1 章」、章节名空白。wrapper 的 toJavaString（Android 分支）=
  // JS_ToCString + env->NewStringUTF：modified UTF-8 里 raw 0x00 就是 C 字符串终结符，旧版
  // '\u0000' 前缀使每个键在 Java 侧截断成 ""，convertToMap 的 HashMap 把 N 章塌成 1 条 "" -> null。
  // Node vm 没有 JNI 边界，任何纯 vm 断言都测不到这一层——这里用字节级模拟钉死契约。
  section('S18. Map 的键必须完整穿越 JNI modified-UTF-8（C 字符串安全）');
  {
    // NewStringUTF 语义：读字节直到 raw 0x00；0x00 只能以 0xC0 0x80（modified UTF-8）出现。
    function newStringUTF(jsStr) {
      const bytes = Buffer.from(jsStr, 'utf8');
      const end = bytes.indexOf(0);
      return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
    }
    const pair = JSON.parse(vm.runInContext(`
      (function () {
        var m = new Map(); m.set('5500009', '第9話');
        var pairs = globalThis.__plainValue(m);
        return JSON.stringify({ keys: pairs.map(function (p) { return p[0]; }) });
      })()
    `, ctx.sandbox));
    check('S18: 现行对键过 NewStringUTF 原样到达 Java（纯键串无 NUL 字节）',
      pair.keys.every((k) => newStringUTF(k) === k), JSON.stringify(pair.keys));
    check('S18: 反向对照——旧版 \\u0000 前缀键过 NewStringUTF 截断为 ""（设备上 N 章塌成 1 章的直接来源）',
      newStringUTF('\u0000550009') === '', JSON.stringify(Buffer.from('\u0000550009', 'utf8').toJSON()));
    check('S18: 契约钉死——__plainValue 产出的对数组键全部不含 raw NUL 字节',
      (() => {
        const probe = JSON.parse(vm.runInContext(`
          JSON.stringify(globalThis.__plainValue((function () {
            var m = new Map(); m.set('5500001', '第1話'); m.set('x', 'y');
            return { chapters: m, tags: new Map([['Author', 'a']]) };
          })()))
        `, ctx.sandbox));
        const keys = [];
        (function walk(v) {
          if (Array.isArray(v)) {
            if (v.length === 2 && !Array.isArray(v[0]) && !Array.isArray(v[1])) keys.push(String(v[0]));
            v.forEach(walk);
          } else if (v !== null && typeof v === 'object') {
            Object.values(v).forEach(walk);
          }
        })(probe);
        return keys.length >= 3 && keys.every((k) => Buffer.from(k, 'utf8').indexOf(0) === -1);
      })(), 'all pair keys NUL-free');
  }

  console.log('\n' + (fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`) + `  (${pass} passed, ${fail} failed)`);
  if (floating.length) {
    console.log('  note: ' + floating.length + ' floating rejection(s) from jm.js itself — expected upstream');
  }
  process.exitCode = fail === 0 ? 0 : 1;
})();
