#!/usr/bin/env node
/**
 * verify_listing_eval_e2e.js — 列表这条腿（浏览 / 搜索 / 详情）为什么曾经「一个字都不显示」。
 *
 * 真机现象（用户截图）：全局搜索里 `禁漫天堂` 下面写着**没有结果**。
 *
 * ### 根因（两层，互相独立，都会被 UI 渲染成同一句话）
 *
 * 1. **`JsMangaSource` 用的是 `engine.eval`，不是 `evalAwaitingResult`。**
 *    `eval` = `js.evaluate(script)`，返回的是**活的 JS 句柄**；而源里的加载函数几乎都是 `async`，
 *    于是拿到手的是一个 **未 settle 的 Promise**。`parseListing` 检查的是 `is Map<*, *>` /
 *    `is List<*>` —— 句柄两种都不匹配，**静默塌成 `MangasPage(emptyList(), false)`**。
 *    设置页 / 登录 / `init()` 早就改走 `evalForValueBlocking`/`evalAwaiting*` 了（`JsValueConversion.kt`
 *    的文档开头就写着「naive `eval(...) as? Map<*, *>` silently yields null」），**只有列表这条腿漏了**。
 *
 * 2. **`explore` 的形状是 `{title, comics, viewMore}[]`，不是 `{comics, maxPage}`。**
 *    jm 的 `explore[0]` 是 `type: "multiPartPage"`（首页有 6 个分组），旧解析器把每个**分组**
 *    当漫画读：`id` 取不到（→ `SManga.url` 为空）、`title` 变成分组标题。
 *
 * 本文件把两层分开钉死：1 用「不给 Promise 机会 settle 的裸求值」复现；2 用真实响应形状复现。
 *
 * ### 与设备的一致性
 *
 * 这个台子跑在 Node/V8 上，**无法**复现「JSObject ≠ java.util.Map」这条 QuickJS 包装器事实
 * （那是 native 编组行为）。但复现缺陷并不需要它：`eval` 返回的 Promise 句柄在两边都**不是**
 * Map/List，`parseListing` 在两边都只能返回空。第 1 组用例断言的正是这个结构性事实。
 *
 * 第二组之后的用例跑的是**真 `init.js` + 真 `jm.js`**，HTTP 用真实抓下来的字段结构回放
 * （见 `probe_jm_search_order.js` 的实测输出），不替宿主造任何状态。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

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

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// --- Kotlin-equivalent `Convert.*` (JsMessageDispatcher::convert) --------------------------------

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
/** `Base64.getMimeDecoder()` — BOM/空白全容忍，与 Dart 的 `base64Decode` 等价。 */
function ktBase64Decode(text) {
  if (typeof text !== 'string') return null;
  try { return Buffer.from(text.replace(/[\s\uFEFF]/g, ''), 'base64'); } catch (e) { return null; }
}
/** Venera 驱动 BC `processBlock` 的语义：短尾**丢弃**，加密不填充、解密不去填充。 */
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
/** 服务端是**有填充**的（PKCS#7），源的 `convertData` 靠扫首尾 `{`/`}` 容忍尾块。 */
function jmSeal(plaintext, secret) {
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-256-ecb', jmKey(secret), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}
const apiSecretAt = (t) => `${t}${JM_API_SECRET}`;

/** 时钟冻住：API secret 每秒一变，源与 mock 各自读时钟 ⇒ 秒边界会偶发假红。 */
const FROZEN_NOW_MS = 1767225600000; // 2026-01-01T00:00:00Z
Date.now = () => FROZEN_NOW_MS;

// --- 真实响应形状（probe_jm_search_order.js / dump 实测，别凭想象编）------------------------------

/** `/search`：注意 `description` 是 null，`category`/`category_sub` 是**对象**。 */
function searchPayload(total, n) {
  const content = [];
  for (let i = 0; i < n; i++) {
    const id = String(1478011 + i);
    content.push({
      id,
      author: '60mm',
      description: null,
      name: i === 0 ? '性格最恶な魔法少女を催眠でわからせる (オリジナル) [DL版]' : `魔法少女 第${i}話`,
      image: '',
      category: { id: '1', title: '同人' },
      category_sub: { id: '1', title: '同人' },
      liked: false,
      is_favorite: false,
      update_at: 1790819926,
      adddate: '2026-09-30',
    });
  }
  return { search_query: '魔法少女', search_type: 'site', y: 0, m: 0, total, content };
}

/**
 * `/promote?page=0`：**8 个分组**，`library` / `novels` 会被 jm.js 自己 `continue` 掉，
 * 所以源返回 6 个分组 × 30 本。
 */
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

// --- 沙箱 ---------------------------------------------------------------------------------------

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}
/** jm API 的响应是 `{"data":"<base64 密文>"}` 信封 —— 不是裸密文。 */
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
    /** **旧**宿主这一腿做的事：裸求值，拿到什么就是什么（不 await、不转换）。 */
    rawEval: (expr) => vm.runInContext(expr, sandbox),
    /**
     * **新**宿主这一腿做的事：逐字复刻 `JsEngine.slotSetup` + `pumpUntilSettled`
     * （`Promise.resolve(expr).then(slot.value=…, slot.error=…)`，然后反复 re-enter 直到 `done`）。
     *
     * 「re-enter 一次」在设备上 = 又一次 native `evaluate`，QuickJS 借机跑完 job queue；
     * 这里等价物 = 一次 microtask checkpoint（`setImmediate`）。**不加这一步台子会假红**：
     * Node 的 microtask 只在同步栈清空时执行，同步死循环里 `done` 永远是 false。
     */
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
        vm.runInContext('void 0', sandbox); // DRAIN_JOBS
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
    /** 让 microtask 跑完（等价于宿主 native evaluate 一次内部的 drain）。 */
    drain: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

/** 设备行为：域名表可用、`/setting` 返回图片分流、`/search`/`/promote` 回放真实结构。 */
function makeHost({ searchWorks = true, total = 2827 } = {}) {
  const httpCalls = [];
  const host = {
    settings: {},
    http: (msg) => {
      httpCalls.push({ method: msg.http_method, url: msg.url });
      if (msg.url === DOMAIN_LIST_URL) return domainListResponse(FETCHED_SERVERS);
      if (msg.url.indexOf('/setting') !== -1) return apiResponse({ img_host: IMG_HOST });
      if (msg.url.indexOf('/search') !== -1) {
        if (!searchWorks) {
          // jm 对未登录/受限请求的答法；jm.js 会 `throw errorMsg`（丢的是**字符串**，不是 Error）。
          return { status: 401, error: null, headers: {}, body: ktBase64Encode(Buffer.from('{"errorMsg":"請先登入會員"}', 'utf8')) };
        }
        return apiResponse(searchPayload(total, 80));
      }
      if (msg.url.indexOf('/promote') !== -1) return apiResponse(promotePayload());
      return null;
    },
  };
  const s = makeSandbox(host);
  s.reflectMeta(); // 宿主的 warmMeta()
  return Object.assign(s, { host, httpCalls });
}

// --- Kotlin 侧两个解析器的逐行转写 ----------------------------------------------------------------

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.then !== 'function';

/** **旧** `JsMangaSource.parseListing`：只认顶层 Map/List，其它一律空。 */
function oldParseListing(res) {
  if (res !== null && typeof res === 'object' && typeof res.then === 'function') {
    return { mangas: [], hasNextPage: false, note: 'promise handle' };
  }
  let comics = null;
  if (isMap(res)) comics = Array.isArray(res.comics) ? res.comics : null;
  else if (Array.isArray(res)) comics = res;
  if (!comics) return { mangas: [], hasNextPage: false, note: 'unsupported shape' };
  const maxPage = isMap(res) ? Number.parseInt(String(res.maxPage), 10) : NaN;
  const hasNextPage = maxPage > 0 || comics.length > 0;
  return { mangas: comics.map(oldToSManga), hasNextPage };
}
function oldToSManga(m) {
  const g = (k) => (isMap(m) && m[k] !== undefined && m[k] !== null ? m[k] : '');
  return { url: String(g('id')), title: String(g('title')), thumbnail_url: String(g('cover')) };
}

/** **新** `JsMangaSource.parseListing` + `flattenComics`。 */
function newFlattenComics(v) {
  if (Array.isArray(v)) return v.flatMap(newFlattenComics);
  if (isMap(v)) return Array.isArray(v.comics) ? v.comics.flatMap(newFlattenComics) : [v];
  return [];
}
function newParseListing(res) {
  const comics = newFlattenComics(res);
  const maxPage = isMap(res) ? Number.parseInt(String(res.maxPage), 10) : NaN;
  return {
    mangas: comics.map((m) => ({
      url: m && m.id !== undefined && m.id !== null ? String(m.id) : '',
      title: m && m.title !== undefined && m.title !== null ? String(m.title) : '',
      thumbnail_url: m && m.cover !== undefined && m.cover !== null ? String(m.cover) : null,
      genre: m && Array.isArray(m.tags) ? m.tags.join(', ') : '',
    })),
    hasNextPage: Number.isFinite(maxPage) && maxPage > 0,
  };
}

/**
 * Kotlin 的 `searchOptions` 惰性属性里那段 JS —— **必须逐字同步**（改了 Kotlin 就改这里）。
 */
const SEARCH_OPTIONS_SCRIPT = (root) =>
  '(() => { const ol = ((' + root + ') && (' + root + ').search && (' + root + ').search.optionList) || []; ' +
  'return ol.map(o => { let v = o && o.default; ' +
  'if (v === undefined || v === null) { const opts = (o && o.options) || []; v = opts.length ? opts[0] : \'\'; } ' +
  'return String(v).split(\'-\')[0]; }); })()';

const floating = [];
process.on('unhandledRejection', (r) => floating.push(String((r && r.message) || r)));

(async () => {
  console.log('LISTING LEG — 真 init.js + 真 jm.js，宿主行为按设备实际做建模\n');

  // -------------------------------------------------------------------------------------------
  section('0. 前置：走完宿主的 init() 生命周期，让 apiDomains 真的被产出来');
  const ctx = makeHost();
  {
    const init = await ctx.awaitEval("ComicSource.sources['jm'].init()");
    check('init() settle（不是靠台子注入 apiDomains）', init.done, JSON.stringify(init));
    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('JM.apiDomains 由源自己填好了', Array.isArray(domains) && domains.length === 4, JSON.stringify(domains));
  }

  // -------------------------------------------------------------------------------------------
  section('1. CONTROL：旧代码路径（裸求值）→ 静默空列表 =「没有结果」');
  {
    const raw = ctx.rawEval("ComicSource.sources['jm'].search.load('魔法少女', [], 1)");
    check('裸求值的返回值是一个 Promise（未 settle），不是 Map/List',
      raw !== null && typeof raw === 'object' && typeof raw.then === 'function',
      Object.prototype.toString.call(raw));

    const listed = oldParseListing(raw);
    check('旧 parseListing ⇒ 0 条结果（设备上的那句「没有结果」）',
      listed.mangas.length === 0, JSON.stringify(listed.note));

    await ctx.drain();
    check('而 HTTP 其实是通的 —— 缺陷在数据出口，不在网络',
      ctx.httpCalls.some((c) => c.url.indexOf('/search') !== -1), JSON.stringify(ctx.httpCalls));
  }

  // -------------------------------------------------------------------------------------------
  section('2. FIX：走 evalAwaitingResult 的协议（Promise.resolve + 反复 re-enter）');
  let searchUrl = null;
  {
    const out = await ctx.awaitEval("ComicSource.sources['jm'].search.load('魔法少女', [], 1)");
    check('settle 成功且没有 error', out.done && !out.error, JSON.stringify(out.error));
    check('拿到的是真对象：{ comics, maxPage }',
      isMap(out.value) && Array.isArray(out.value.comics), Object.prototype.toString.call(out.value));

    const listed = newParseListing(out.value);
    check('新 parseListing ⇒ 80 条漫画', listed.mangas.length === 80, String(listed.mangas.length));
    check('maxPage=ceil(2827/80)=36 ⇒ hasNextPage=true（可以翻页）', listed.hasNextPage === true);
    const first = listed.mangas[0];
    check('url = comic id（给 loadInfo 用）', first.url === '1478011', first.url);
    check('title 取的是条目自己的 name（不是分组标题）',
      first.title === '性格最恶な魔法少女を催眠でわからせる (オリジナル) [DL版]', first.title);
    check('cover = getCoverUrl(id)', /\/media\/albums\/1478011_3x4\.jpg$/.test(String(first.thumbnail_url)), String(first.thumbnail_url));
    check('genre = category.title + category_sub.title', first.genre === '同人, 同人', first.genre);

    searchUrl = ctx.httpCalls.filter((c) => c.url.indexOf('/search') !== -1).pop();
    check('URL 里 `o=undefined`（宿主传了空 options）—— 实测服务端容忍，所以这不是根因',
      /[?&]o=undefined(&|$)/.test(searchUrl.url), searchUrl.url);
  }

  // -------------------------------------------------------------------------------------------
  section('3. 第二层根因：explore 的形状是分组数组，不是 {comics, maxPage}');
  {
    const out = await ctx.awaitEval("ComicSource.sources['jm'].explore[0].load(0)");
    check('explore[0].load() settle', out.done && !out.error, String(out.error));
    check('返回的是数组（multiPartPage）', Array.isArray(out.value), Object.prototype.toString.call(out.value));
    // /promote 原始响应有 8 个分组，jm.js 自己 `continue` 掉 library / novels 后才 push。
    check('6 个分组（library / novels 被源自己跳过，不是被我们过滤）',
      out.value.length === 6 && out.value.every((s) => Array.isArray(s.comics) && s.comics.length === 30),
      'len=' + out.value.length);

    const oldListed = oldParseListing(out.value);
    check('旧 parseListing 把它当漫画列表 ⇒ 6 个「漫画」，url 全是空的（浏览页只会显示分组标题）',
      oldListed.mangas.length === 6 && oldListed.mangas.every((m) => m.url === ''),
      JSON.stringify(oldListed.mangas[0]));

    const listed = newParseListing(out.value);
    check('新 parseListing 摊平 ⇒ 180 条真漫画（6 组 × 30）', listed.mangas.length === 180, String(listed.mangas.length));
    check('每条都有 url', listed.mangas.every((m) => m.url !== ''), '');
    check('multiPartPage 无分页 ⇒ hasNextPage=false（否则浏览页会无限重复同一批）',
      listed.hasNextPage === false);
  }

  // -------------------------------------------------------------------------------------------
  section('4. search.optionList 的默认值（宿主不再写死 []）');
  {
    const opts = vm.runInContext(SEARCH_OPTIONS_SCRIPT("ComicSource.sources['jm']"), ctx.sandbox);
    check('jm 的 7 个排序项 → 默认取第一项的 value', Array.isArray(opts) && opts.length === 1 && opts[0] === 'mr',
      JSON.stringify(opts));

    const literal = '[' + opts.map((o) => JSON.stringify(o)).join(', ') + ']';
    const out = await ctx.awaitEval(`ComicSource.sources['jm'].search.load('魔法少女', ${literal}, 1)`);
    check('settle 成功', out.done && !out.error, String(out.error));
    const url = ctx.httpCalls.filter((c) => c.url.indexOf('/search') !== -1).pop().url;
    check('URL 里是 `o=mr`（Venera 的默认「最新」），不再是 undefined',
      /[?&]o=mr(&|$)/.test(url), url);

    const unknown = vm.runInContext(SEARCH_OPTIONS_SCRIPT("({})"), ctx.sandbox);
    check('没有 optionList 的源 ⇒ 空数组（退回旧行为，不会把搜索一起拖垮）',
      Array.isArray(unknown) && unknown.length === 0, JSON.stringify(unknown));
  }

  // -------------------------------------------------------------------------------------------
  section('5. 失败不再长得像「没有结果」');
  {
    const bad = makeHost({ searchWorks: false });
    // 同样先走源自己的 init()：不调它 `baseUrl` 会在发请求前就抛 undefined[0]，
    // 那测到的就是另一个缺陷了（第 0 组已经单独钉过）。
    await bad.awaitEval("ComicSource.sources['jm'].init()");
    const out = await bad.awaitEval("ComicSource.sources['jm'].search.load('魔法少女', [], 1)");
    check('rejection 带出了源的消息（Kotlin 会 throw IllegalStateException(source: msg)）',
      out.done && typeof out.error === 'string' && out.error.length > 0, JSON.stringify(out.error));
    check('消息里是「請先登入會員」而不是空串', /請先登入會員/.test(String(out.error)), String(out.error));

    // 反向对照：旧路径对同一个输入只能给出「空」——成功与失败长得一模一样。
    const raw = bad.rawEval("ComicSource.sources['jm'].search.load('魔法少女', [], 1)");
    const oldListed = oldParseListing(raw);
    check('反向对照：旧路径对同一次失败同样只得到 0 条，没有任何可区分的信号',
      oldListed.mangas.length === 0);
    // 全局搜索的 UI 有 MangaSearchItemResult.Error → GlobalSearchErrorResultItem(message)，
    // 所以 throw 出来的 message 会**直接显示在页面上**，这正是我们需要的那条诊断通道。
  }

  // -------------------------------------------------------------------------------------------
  console.log('\n' + (fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`) + `  (${pass} passed, ${fail} failed)`);
  if (floating.length) {
    console.log('  note: ' + floating.length + ' floating rejection(s) from jm.js itself (dailyCheckIn / refreshImgUrl) — expected upstream');
  }
  process.exitCode = fail === 0 ? 0 : 1;
})();
