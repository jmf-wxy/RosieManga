/**
 * verify_source_init_e2e.js — the source-bootstrap (`ComicSource.init`) chain, from the 15:06 log.
 *
 * The device log this exists to explain:
 *   [JsSourceConfigModel]  onLogin(jm) fields=2
 *   [JsSourceManager]      login ENTER jm (account='143***')
 *   [JsEngine]             evalAwaitingResult: done(raw=Boolean=true)
 *                          error=cannot read property '0' of undefined
 *                          script=ComicSource.sources["jm"].account.login("1439034493", "4566548989")
 *   [JsSourceManager]      login EXIT -> Failure
 *
 * Two numbers in that log already told the story, and neither is about login:
 *
 *   1. **11 ms between ENTER and the rejection.** A real `/login` POST cannot complete in 11 ms.
 *      So nothing reached the network — the `login` async function threw on its *first* statement.
 *   2. **`'0'`, not `'NaN'`.** The index in the message is the *resolved* `apiDomain` setting
 *      (`"1"` → 0), not a missing value. So `loadSetting()` worked and only the array was missing.
 *
 * `account.login` immediately evaluates `` `${this.baseUrl}/login` ``, and jm.js's `baseUrl` is:
 *
 *   get baseUrl() {
 *       let index = parseInt(this.loadSetting('apiDomain')) - 1   // "1" -> 0
 *       return `https://${JM.apiDomains[index]}`                  // JM.apiDomains has NO initialiser
 *   }
 *
 * `JM.apiDomains` is a static class field that jm.js **never declares** — the only writer is
 * `overwriteApiDomains()`, which is only reachable from `refreshApiDomains()`, which only runs from
 * `init()`:
 *
 *   async init() {
 *       if (this.loadSetting('refreshDomainsOnStart')) await this.refreshApiDomains(false)
 *       this.refreshImgUrl(false)
 *   }
 *
 * Venera calls that hook itself (`venera/lib/foundation/comic_source/parser.dart:170`):
 *   await source.loadData();
 *   if (_checkExists("init")) Future.delayed(50ms, () => JsEngine().runCode("...$key.init()"));
 *
 * Our host did not, so `JM.apiDomains` was `undefined`, the getter evaluated `undefined[0]`, and
 * *every* entry point that touches `baseUrl` (登录/搜索/详情/收藏) died before its first request.
 *
 * ### Why the older login harness stayed GREEN while the device stayed RED
 *
 * `verify_login_e2e.js` injected `JM.apiDomains = [...]` into its sandbox with the comment
 * "Venera fills it from persisted data". That is the state the *harness* wanted, not the state the
 * host actually produced — a `mock` that models our expectations instead of the device's behaviour.
 * This file does the opposite: it reproduces the failure first (test 1), and only then proves the
 * fix makes it go away (tests 2+).
 *
 * The host-side mirror of the fix: `JsSourceManager.scheduleSourceInit()` — dispatched *after*
 * `warmMeta()`, because `init()` reads `refreshDomainsOnStart` through the same cache-only
 * `load_setting` path as everything else (test 4 pins that ordering requirement down).
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

/** jm.js's own constants, copied so the mock can speak the server's encryption. */
const JM_API_SECRET = '185Hcomic3PAPP7R';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
const DOMAIN_LIST_URL = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// --- Kotlin-equivalent `Convert.*` (JsMessageDispatcher::convert) --------------------------------

function ktEncodeUtf8(str) { return Buffer.from(String(str), 'utf8'); }

/** Kotlin refuses a non-ByteArray here and returns null; model that refusal, do not paper over it. */
function ktDecodeUtf8(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  return Buffer.from(value).toString('utf8');
}

function ktMd5(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  return crypto.createHash('md5').update(Buffer.from(value)).digest();
}

function ktBase64Encode(value) { return Buffer.from(value).toString('base64'); }

/** `Base64.getMimeDecoder()`: tolerant of BOM / whitespace, exactly like Dart's `base64Decode`. */
function ktBase64Decode(text) {
  if (typeof text !== 'string') return null;
  try { return Buffer.from(text.replace(/[\s\uFEFF]/g, ''), 'base64'); } catch (e) { return null; }
}

/**
 * `Cipher("AES/<mode>/NoPadding")` driven the way Venera drives BouncyCastle's `processBlock`:
 * a partial trailing block is **dropped**, and no PKCS#7 is added on encrypt / removed on decrypt.
 */
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

/** The key derivation jm.js uses: `utf8(hex(md5(utf8(secret))))` = 32 ASCII chars = AES-256. */
function jmKey(secret) {
  return Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
}

/** Encrypts a plaintext the way the jm server does for a given secret (PADDED, as the server does). */
function jmSeal(plaintext, secret) {
  const key = jmKey(secret);
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}

/** Per-second API secret, exactly as jm.js's `get()`/`post()` derive it. */
function apiSecretAt(timeSeconds) { return `${timeSeconds}${JM_API_SECRET}`; }

/**
 * The clock is frozen for the whole run: the API secret is per-second and is derived independently by
 * the source and by the mock, so a second boundary between the two would flake the login assertions.
 * `Date` is shared into the vm context, so both sides read the same value.
 */
const FROZEN_NOW_MS = 1767225600000; // 2026-01-01T00:00:00Z
Date.now = () => FROZEN_NOW_MS;

/**
 * `undefined[0]` as an error *message*.
 *
 * The wording is engine-specific and must not be normalised away: QuickJS (device) says
 * `cannot read property '0' of undefined`, V8 (this harness) says
 * `Cannot read properties of undefined (reading '0')`. Matching both keeps the assertion about the
 * actual defect — an index access on an undefined array — instead of a spelling.
 */
function isUndefinedIndexError(message, index) {
  const m = String(message);
  return new RegExp(`cannot read propert(y|ies) of undefined`).test(m) ||
    new RegExp(`reading '${index}'`).test(m);
}

const DEVICE_INDEX_ERROR = "cannot read property '0' of undefined";

// --- the device-faithful sandbox ----------------------------------------------------------------

/**
 * @param opts.host.calls           array the mock appends every bridge call to
 * @param opts.host.http            (msg) => envelope object | null  (null = network failure)
 * @param opts.host.metaWarm        whether the host reflected `settings` before the source ran
 * @param opts.host.settings        persisted setting values (what the user chose in the UI)
 * @param opts.host.saveData        persisted `ComicSource.saveData` values
 */
function makeSandbox(opts) {
  const host = opts.host;
  const calls = host.calls;
  const saved = Object.assign({}, host.saveData || {});
  const ui = [];

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  // --- host-side "meta cache": the reflection `JsSourceManager.parseMeta` performs once ----------
  // `load_setting` is cache-only on purpose (the bridge runs on the JS thread and cannot re-enter
  // to reflect), so `declaredDefault()` sees nothing until the host warmed the cache. Modelling
  // that asymmetry is the entire point of test 4.
  let metaCache = null;
  function declaredDefault(settingKey) {
    if (!metaCache) return undefined;
    const item = metaCache[settingKey];
    if (!item) return undefined;
    return item.default;
  }

  /**
   * Mirrors `parseMeta`: reads the live `settings` object and keeps each item's `default`.
   *
   * Read through `vm.runInContext` on purpose — a top-level `class ComicSource` is a *lexical*
   * global binding, so it never shows up as a property of the contextified sandbox object.
   */
  function reflectMeta() {
    const settings = vm.runInContext("ComicSource.sources['jm'].settings", sandbox);
    const out = {};
    for (const [key, item] of Object.entries(settings)) out[key] = { type: item.type, default: item.default };
    metaCache = out;
  }

  function dispatch(msg) {
    const m = msg.method;
    calls.push(msg);

    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return false;
    if (m === 'UI') { ui.push(msg); return null; }
    if (m === 'delay') return null;

    if (m === 'load_data') return Object.prototype.hasOwnProperty.call(saved, msg.data_key) ? saved[msg.data_key] : null;
    if (m === 'save_data') { saved[msg.data_key] = msg.data; return null; }

    // Venera's chain: persisted value -> the source's declared `default` -> undefined.
    if (m === 'load_setting') {
      const persisted = (host.settings || {})[msg.setting_key];
      if (persisted !== undefined) return persisted;
      return declaredDefault(msg.setting_key);
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
      // The Kotlin bridge returns a JSON **string** (a Map would be rejected by native marshalling),
      // so the mock returns a string too — init.js's decode path stays under test.
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
    ui,
    reflectMeta,
    /** Runs `expr` inside the realm and settles it the way `evalAwaitingResult` does. */
    settle: (expr) => vm.runInContext(
      `(async function () {
         try { return { ok: true, value: await (${expr}) }; }
         catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
       })()`, sandbox),
  };
}

/**
 * A raw-text response, wrapped in the exact envelope the Kotlin bridge produces: the response bytes
 * are base64-encoded (so `result.body` survives the string round trip), and the caller side
 * (`init.js`'s patched `fetchBytes` / `sendRequest`) decodes them back.
 *
 * The two layers are not redundant — getting them confused is the classic way a harness goes green
 * on a bridge that is actually broken.
 */
function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}

/**
 * The jm domain-list endpoint. Faithful to the real thing (probed on-device):
 * **bare base64** — not a JSON envelope — with a leading UTF-8 BOM and a trailing newline.
 *
 * `refreshApiDomains` hands the *whole text* to `convertData()`, which is what the brace-scanning
 * loop in that helper exists for.
 */
function domainListResponse(servers) {
  return textEnvelope('\uFEFF' + jmSeal(JSON.stringify({ Server: servers }), DOMAIN_SECRET) + '\n');
}

/**
 * A jm API response. `post()`/`get()` do `JSON.parse(res.body)` and read `json.data` (base64
 * ciphertext), so the envelope — not the bare ciphertext — is what must travel.
 */
function apiResponse(payload) {
  // 2026-10-07 起站点给 API 信封也加了 UTF-8 BOM（真机 200/401 探针均实锤 ef bb bf），
  // jm.js 1.4.2 的 parseBody() 负责剥离；这里忠实模拟 ⇒ 同时是 BOM 剥离的反例守卫。
  const ciphertext = jmSeal(JSON.stringify(payload), apiSecretAt(Math.floor(Date.now() / 1000)));
  return textEnvelope('\uFEFF' + JSON.stringify({ data: ciphertext }));
}

function apiErrorResponse(errorMsg) {
  // 401 分支同样带 BOM（探针实锤），走 get()/post() 的 parseBody()。
  return textEnvelope('\uFEFF' + JSON.stringify({ errorMsg: errorMsg }));
}

// Bare hostnames, exactly like jm.js's own `fallbackServers` — `baseUrl` prepends the scheme
// (`https://${JM.apiDomains[index]}`), so a scheme here would produce `https://https://…`.
const FETCHED_SERVERS = ['d1.example.org', 'd2.example.org', 'd3.example.org', 'd4.example.org'];

/**
 * Builds a host whose `http` mock is faithful to the device: `/login` works, the domain-list URL is
 * served (or not), and `/setting` fails the way a logged-out jm API does — which makes `init()`
 * reject *after* it has already populated the domains, the case the host must tolerate.
 */
function makeHost({ domainListWorks = true, metaWarm = true } = {}) {
  const calls = [];
  const httpCalls = [];
  const host = {
    calls,
    metaWarm,
    settings: {},
    saveData: {},
    http: (msg) => {
      httpCalls.push({ method: msg.http_method, url: msg.url });
      if (msg.url.indexOf('/login') !== -1) return apiResponse({ uid: '12345', username: 'tester' });
      if (msg.url === DOMAIN_LIST_URL) return domainListWorks ? domainListResponse(FETCHED_SERVERS) : null;
      if (msg.url.indexOf('/setting') !== -1) {
        // jm answers a logged-out API call like this; jm.js turns it into `throw errorMsg`.
        return { status: 401, error: null, headers: {}, body: ktBase64Encode(Buffer.from('\uFEFF{"errorMsg":"Not Found"}', 'utf8')) };
      }
      return null;
    },
  };
  const s = makeSandbox({ host });
  if (metaWarm) s.reflectMeta(); // the host's warmMeta()
  return Object.assign(s, { host, httpCalls, calls });
}

// jm.js's `getApiHeaders()` fires `dailyCheckIn(true)` as a floating promise, and the source throws
// plain strings. Both are expected upstream behaviour — collect instead of crashing the run.
const floating = [];
process.on('unhandledRejection', (r) => floating.push(String((r && r.message) || r)));

(async () => {
  console.log('SOURCE BOOTSTRAP — real init.js + real jm.js, host behaviour modelled honestly\n');

  // ---------------------------------------------------------------------------------------------
  console.log('=== 1. CONTROL: with no `init()`, the device error reproduces byte for byte ===');
  {
    const ctx = makeHost({ metaWarm: true });
    const domainsBefore = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('JM.apiDomains is undefined before init() (jm.js never declares it)',
      domainsBefore === undefined, JSON.stringify(domainsBefore));

    const res = await ctx.settle(`ComicSource.sources['jm'].account.login('1439034493', '4566548989')`);
    check('login rejects on undefined[0] — the device\'s exact defect',
      !res.ok && isUndefinedIndexError(res.err, 0), JSON.stringify(res));

    check('and NOT "NaN" — the apiDomain setting default really did resolve to index 0',
      !/NaN/.test(res.err), JSON.stringify(res));

    const loginRequests = ctx.httpCalls.filter((c) => c.url.indexOf('/login') !== -1);
    check('zero HTTP requests were issued — matching the 11 ms failure in the device log',
      loginRequests.length === 0, JSON.stringify(ctx.httpCalls));

    // The getter is reached from every entry point, not just login.
    const explore = await ctx.settle(`ComicSource.sources['jm'].search.load('test', [], 1)`);
    check('search dies the same way (it is the getter, not the login flow)',
      !explore.ok && isUndefinedIndexError(explore.err, 0), JSON.stringify(explore));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n=== 2. FIX: calling init() populates apiDomains and login proceeds ===');
  {
    const ctx = makeHost({ metaWarm: true });
    const init = await ctx.settle(`ComicSource.sources['jm'].init()`);
    console.log('  init() ->', JSON.stringify(init.ok ? '[resolved]' : init.err));

    // jm.js 1.4.1 的 init() 契约（比 1.2.3 的 fire-and-forget 更强）：
    //   • init() 必须**快速 resolve**（域名列表 TTFB ~0.8~1.0s，搜索本身只要 ~0.41s，
    //     让 init 阻塞等于把首帧时间翻三倍）；
    //   • 但域名可用性**不能**押在后台链上 —— 返回前先同步写入内置 `fallbackServers`，
    //     `baseUrl` 立刻可算（1.2.3 那种"立即返回"会让首个请求撞 `undefined[0]`，
    //     再变成 floating rejection，宿主只能等满 300s，表现为「搜索一直转圈」）；
    //   • 后台发现回来后再覆盖成最新线路。
    const domainsRightAfterInit = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('init() resolved WITHOUT waiting for the domain list (性能契约：不阻塞首帧)',
      init.ok === true, JSON.stringify(init));
    check('★init() 返回时 apiDomains 已同步就位 = fallbackServers（首个请求不会撞 undefined）',
      Array.isArray(domainsRightAfterInit) && domainsRightAfterInit.length === 4 &&
        domainsRightAfterInit[0] === 'www.cdntwice.org', JSON.stringify(domainsRightAfterInit));
    check('但 init() 确实触发了域名列表请求（后台 fire-and-forget）',
      ctx.httpCalls.some((c) => c.url.indexOf('newsvr-2025.txt') !== -1),
      JSON.stringify(ctx.httpCalls.map((c) => c.url)));

    // drain：让后台那条 await 链走完（域名字段 + /setting），再断言最终状态。
    for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));

    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('后台发现完成后 JM.apiDomains 被填上（域名可用性语义不变）',
      Array.isArray(domains) && domains.length === FETCHED_SERVERS.length, JSON.stringify(domains));
    check('the fetched hosts survived the AES/base64 round trip intact',
      Array.isArray(domains) && domains[0] === FETCHED_SERVERS[0], JSON.stringify(domains));

    const res = await ctx.settle(`ComicSource.sources['jm'].account.login('1439034493', '4566548989')`);
    check('login now resolves with the source\'s own value', res.ok && res.value === 'ok', JSON.stringify(res));

    const loginReq = ctx.httpCalls.find((c) => c.url.indexOf('/login') !== -1);
    check('a real POST to the resolved baseUrl was issued (hostname + scheme, not doubled)',
      !!loginReq && loginReq.url === `https://${FETCHED_SERVERS[0]}/login` && loginReq.method === 'POST',
      JSON.stringify(loginReq));

    check('uid from the response was handed to save_data (the decrypt chain end-to-end)',
      ctx.calls.some((c) => c.method === 'save_data' && c.data_key === 'uid' && c.data === '12345'),
      JSON.stringify(ctx.calls.filter((c) => c.method === 'save_data')));

    // `init()` 尾部的域名/图片域名刷新都**不 await**，整条后台链在 1.4.1 里整体 `.catch()`：
    // `/setting` 的 401 既不会拖住 init()，也不会变成 floating rejection（S14 的症状）。
    const settingReq = ctx.httpCalls.find((c) => c.url.indexOf('/setting') !== -1);
    check('init() 也触发了 refreshImgUrl()（不 await，走后台链）',
      !!settingReq, JSON.stringify(ctx.httpCalls));
    check('init() resolved even though that follow-up call 401\'d',
      init.ok === true, JSON.stringify(init));
    check('★后台链的失败不再变成 floating rejection（源自己吞掉，S14 症状已消除）',
      floating.length === 0, JSON.stringify(floating));
    check('and the domains it already wrote survive regardless',
      Array.isArray(domains) && domains[0] === FETCHED_SERVERS[0], JSON.stringify(domains));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n=== 3. the domain endpoint being down must NOT leave the source dead ===');
  {
    const ctx = makeHost({ metaWarm: true, domainListWorks: false });
    await ctx.settle(`ComicSource.sources['jm'].init()`);
    // 与 2 同理：init() 不再等域名发现，回落到内置线路发生在后台链跑完之后。
    for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));
    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('init() fell back to JM.fallbackServers', Array.isArray(domains) && domains.length === 4, JSON.stringify(domains));
    check('the fallback list is the source\'s own, unwrapped',
      Array.isArray(domains) && domains[0] === 'www.cdntwice.org', JSON.stringify(domains));

    const res = await ctx.settle(`ComicSource.sources['jm'].account.login('u', 'p')`);
    check('login still works off the fallback domain', res.ok, JSON.stringify(res));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n=== 4. ORDERING: warmMeta 现在只决定「线路新鲜度」，不再是「能不能用」 ===');
  {
    // `refreshDomainsOnStart` has `default: true`, but that default lives in the reflected metadata.
    // With a cold cache `loadSetting` returns undefined, so init() skips the *background discovery*.
    // 1.4.1 起 init() 会先同步写入 `fallbackServers`，所以域名**始终可用** —— cold cache 只是
    // 退化成「用内置线路而不是最新线路」，宿主仍然应该先 warmMeta()（否则永远发现不了新线路），
    // 但「wiring 顺序错了 ⇒ 源静默失效」这个失效模式已经不存在了。
    const ctx = makeHost({ metaWarm: false });
    check('cold cache: loadSetting(refreshDomainsOnStart) is undefined',
      vm.runInContext("ComicSource.sources['jm'].loadSetting('refreshDomainsOnStart') === undefined", ctx.sandbox) === true);

    await ctx.settle(`ComicSource.sources['jm'].init()`);
    check('★cold cache 下 init() 仍同步就位 fallbackServers（wiring 顺序不再是「静默失效」）',
      vm.runInContext('Array.isArray(JM.apiDomains) && JM.apiDomains[0] === "www.cdntwice.org"', ctx.sandbox) === true,
      vm.runInContext('JM.apiDomains', ctx.sandbox));

    // baseUrl 可算 ⇒ 请求真的发得出去；不再退化成像 1.2.3 那样 `parseInt(undefined) - 1` 的 NaN 索引。
    const res = await ctx.settle(`ComicSource.sources['jm'].account.login('u', 'p')`);
    check('★cold cache 不再退化成 NaN 索引（域名可用 ⇒ 请求正常发出，消息形状变了）',
      !/NaN/.test(String(res.err || '')), JSON.stringify(res));

    // Warm cache, same engine state, same call: this is the difference the ordering makes.
    ctx.reflectMeta();
    await ctx.settle(`ComicSource.sources['jm'].init()`);
    // 同上：init() 不等域名发现，drain 之后才断言 apiDomains 已就绪。
    for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));
    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);
    check('after warmMeta() the identical init() call works',
      Array.isArray(domains) && domains[0] === FETCHED_SERVERS[0], JSON.stringify(domains));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n=== 5. mock faithfulness: the bridge envelope really is exercised ===');
  {
    const ctx = makeHost({ metaWarm: true });
    await ctx.settle(`ComicSource.sources['jm'].init()`);
    for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));   // 等后台域名发现
    const domains = vm.runInContext('JM.apiDomains', ctx.sandbox);

    // Both mock layers (bridge base64 + the endpoint's own BOM'd base64) had to decode for this to
    // hold: a harness that skipped either would also "pass" against a broken host.
    check('the BOM\'d, double-base64 domain payload was decoded end to end',
      Array.isArray(domains) && domains.length === FETCHED_SERVERS.length, JSON.stringify(domains));

    // `Network.fetchBytes` must hand back BINARY, not a base64 string: `fetch().text()` calls
    // `Convert.decodeUtf8` on it. If the host stopped pre-decoding, this is where it shows.
    const bodyType = await vm.runInContext(
      `fetch('https://${FETCHED_SERVERS[0]}/login').then(r => r.arrayBuffer()).then(b => (b && b.constructor && b.constructor.name) || typeof b)`,
      ctx.sandbox);
    check('fetchBytes yields binary (ArrayBuffer-ish/Uint8Array), not a base64 string',
      bodyType !== 'string' && bodyType !== 'undefined', String(bodyType));

    check('failures surface as the source\'s own throw, not as a swallowed undefined',
      (await ctx.settle(`Network.fetchBytes('GET', 'https://unreachable.invalid/x').then(() => 'no-throw', e => String(e))`)).value === 'network unreachable');
  }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' +
    (floating.length ? `   (expected floating rejections: ${floating.length})` : ''));
  // Set the code rather than calling `process.exit()`: stdout is a pipe/file here, and an abrupt
  // exit truncates the tail of the report (which is the part you actually need to read).
  process.exitCode = fail === 0 ? 0 : 1;
})()
  // A harness bug must be loud. Without this, the rejection is swallowed by the
  // `unhandledRejection` collector above and the run just stops mid-report with no output.
  .catch((e) => {
    console.error('FATAL (harness bug, not a product result):', (e && e.stack) || e);
    process.exitCode = 2;
  });
