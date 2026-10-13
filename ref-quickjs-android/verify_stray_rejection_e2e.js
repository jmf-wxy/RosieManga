#!/usr/bin/env node
/**
 * verify_stray_rejection_e2e.js — 「源自己没 await 的 promise 被拒绝」会炸掉**无关**的调用，
 * 而且炸错人。
 *
 * 真机现象（用户截图，APK 16:46，同一部手机前后两张）：
 *
 *   详情页  共 0 章 + `IllegalStateException: 禁漫天堂: timed out in jm.comic.loadInfo("1231669")`
 *   搜索页        `IllegalStateException: 禁漫天堂: timed out in jm.search.load("魔法", ["mr"], 1)`
 *
 * ### 根因（三层，逐层把上一层报到了完全无关的地方）
 *
 * **1. 源会故意制造「无人接管的拒绝」。**
 *   `jm.js` 的 `getApiHeaders(time)` 在**每一个**请求前都调 `this.dailyCheckIn(true)`，且**不 await**：
 *   ```js
 *   getApiHeaders(time) {
 *       if (this.loadSetting("dailyCheckInTask")) this.dailyCheckIn(true)   // ← 浮动
 *   }
 *   ```
 *   而 `dailyCheckIn` 的 `throwError()`（= `UI.showMessage(msg); throw msg`）有几条路径**没有
 *   `isTask` 守卫**：`Invalid daily_id` / `Invalid check-in result`，以及它内部 `this.get`/`this.post`
 *   抛出的任何错误。`isTask=true` 只豁免了「今天已签到」和「未登录」这两条早退，**不是全部**。
 *   本台子用「`/daily` 返回没有 `daily_id` 的 200」来触发这一条，这正是禁漫对受限请求的答法。
 *
 * **2. QuickJS 的宿主 rejection tracker 把「无人接管的拒绝」变成「下一次 `evaluate()` 抛异常」。**
 *   `libquickjs-android-wrapper.so` 里同时存在符号 `JS_SetHostPromiseRejectionTracker` 与字面量
 *   `"UnhandledPromiseRejectionException: "`（可用字符串扫描复现），并引用
 *   `com/whl/quickjs/wrapper/QuickJSException` —— 即 native `evaluate` 会把 tracker 事件包成
 *   Java 异常抛出。**哪一次 `evaluate` 抛出，完全取决于时机**，所以它炸在宿主正在等待的
 *   `search.load` / `loadInfo` 上。
 *
 * **3. 宿主把「异常」和「超时」拍成了同一个值。**
 *   当时的 `JsMangaSource.evalSource` 写的是
 *   ```kotlin
 *   val outcome = withContext(Dispatchers.IO) { runCatching { engine.evalAwaitingResult(script) }.getOrNull() }
 *   return when (outcome) { ... null -> throw IllegalStateException("$name: timed out in $key.$expr") }
 *   ```
 *   `getOrNull()` 把异常变成 `null`，而 `null` 在 `evalAwaitingResult` 里的**唯一**含义是
 *   「promise 没在预算内 settle」。于是「一个完全无关的 promise 拒绝」被显示成
 *   「`loadInfo` 超时」—— 用户看到的每个字都指向错误的方向。
 *
 * ### 台子怎么复现第 2 层
 *
 * Node 的 `vm` 上下文与主机共用同一个 isolate，所以浮动拒绝会走
 * `process.on('unhandledRejection')`，其触发时机（microtask checkpoint 之后）与设备上
 * 「tracker 记下来、下一次 evaluate 抛出来」的事件顺序一一对应。这里把这层显式建模成
 * `strayPending`：**每次 `evaluate` 先跑脚本、再做一次 checkpoint，若此时仍有挂起的 tracker
 * 事件就抛 `UnhandledPromiseRejectionException`** —— 与 native evaluate 的时序一致
 * （脚本的副作用已经发生，异常来自紧随其后的 drain）。
 *
 * ### 反向对照（本文件最重要的部分）
 *
 * 第 1 组用**修复前的泵 + 修复前的归类**，必须逐字复现真机那条 `timed out in ...`。
 * 复现不了，就说明这个台子证明不了任何事。第 2 组才用修复后的实现。
 *
 * ### 与设备的已知偏差
 *
 * 设备上 `http` 桥是**同步阻塞**的，`pumpUntilSettled` 是一个不 yield 的紧循环；Node 无法在
 * 主线程同步等 HTTP，所以这里用 async host + 每个 tick 一次 `setImmediate`。
 * 第 1 组断言的是「异常会不会炸到我们的调用上」这个结构性事实，与 yield 方式无关。
 *
 * 运行：node verify_stray_rejection_e2e.js
 */

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

/** 与 Kotlin 的 `JsEngine.BRIDGE_SHIM` 逐字一致；改了 Kotlin 就改这里。 */
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
/** 加密不填充、解密**也不去填充**（源靠扫首尾 `{`/`}` 容忍尾部填充字节）。 */
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

// --- 真实响应形状（实测，别凭想象编）--------------------------------------------------------------

function searchPayload(total, n) {
  const content = [];
  for (let i = 0; i < n; i++) {
    content.push({
      id: String(1478011 + i),
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

/** `/album?id=1231669` —— 就是截图里那部「自拍女友总集编」；`series` 有 1 话。 */
function albumPayload(id = '1231669') {
  return {
    id: Number(id),
    name: '自拍女友总集编[禁漫汉化组]',
    author: ['2no.'],
    works: [],
    actors: [],
    tags: ['同人'],
    series: [{ id: 1478011, name: '', sort: 1 }],
    related_list: [],
    addtime: 1790819926,
    description: '',
    likes: '3',
    total_views: '100',
    is_favorite: false,
    liked: false,
  };
}

/** 禁漫对「受限请求」的答法：**HTTP 200**，但 body 里没有 `daily_id`。 */
function dailyWithoutIdPayload() {
  return { code: 200, data: [], errorMsg: 'Not legal request.' };
}

function textEnvelope(text) {
  return { status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from(text, 'utf8')) };
}
function apiResponse(payload) {
  // 2026-10-07 起站点给 API 信封加了 UTF-8 BOM（真机 200 探针实锤），jm.js 1.4.2 parseBody() 剥离。
  return textEnvelope('\uFEFF' + JSON.stringify({ data: jmSeal(JSON.stringify(payload), apiSecretAt(Math.floor(Date.now() / 1000))) }));
}

// --- 浮动拒绝跟踪（= 设备的 JS_SetHostPromiseRejectionTracker）------------------------------------

let strayPending = null;   // 「下一次 evaluate 会抛」—— 对应 tracker 已记录、尚未被抛出
let strayLog = [];         // 本台子观测到的全部浮动拒绝（用于断言「不能被静默吞掉」）

process.on('unhandledRejection', (reason) => {
  const msg = String((reason && reason.message) || reason);
  if (strayPending === null) strayPending = msg;
  strayLog.push(msg);
});

/** 等价于「native evaluate 内部把 job queue 跑干净」；tracker 事件就在这一步冒出来。 */
const checkpoint = () => new Promise((resolve) => setImmediate(resolve));

function resetStray() { strayPending = null; strayLog = []; }

// --- 沙箱 ---------------------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {boolean} opts.dailyCheckInFails `/daily` 是否答「200 但没有 daily_id」
 * @param {number}  opts.searchStatus    `/search` 的 HTTP 状态（401 用来验证「我方拒绝不被吞」）
 */
function makeSandbox(opts = {}) {
  const dailyCheckInFails = opts.dailyCheckInFails !== false;
  const searchStatus = opts.searchStatus || 200;

  const httpCalls = [];
  const saved = { uid: '435507' };            // 备份的 jm.data 里真实存在的值
  let metaCache = null;

  const ctx = vm.createContext(Object.assign(
    {
      console: { log() {}, info() {}, warn() {}, error() {} },
      Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
      Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
      encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
      TextEncoder, TextDecoder, setTimeout, clearTimeout,
    },
    {},
  ));
  vm.runInContext('globalThis.globalThis = globalThis; globalThis.window = globalThis;', ctx);

  function reflectMeta() {
    const settings = vm.runInContext("ComicSource.sources['jm'].settings", ctx);
    const out = {};
    for (const [k, v] of Object.entries(settings)) out[k] = { type: v.type, default: v.default };
    metaCache = out;
  }

  /**
   * 设备的 `http` 桥。**时序是刻意的**：
   *   • `/daily` 立即 resolve —— 设备上桥是同步的，`getApiHeaders()` 返回时该响应已经在手，
   *     所以浮动签到链**先于**我们的 search 链走到 `throwError`。把这一步做成慢的会掩盖本 bug；
   *   • `/search` 延后一个 macrotask —— 保证「stray 先到、我们的链后到」这个真实顺序，
   *     免掉一个会偶发失败的测试（偶发失败比没有测试更糟）。
   */
  function http(msg) {
    httpCalls.push({ method: msg.http_method, url: msg.url });
    const url = String(msg.url);
    if (url === DOMAIN_LIST_URL) {
      return Promise.resolve(textEnvelope('\uFEFF' + jmSeal(JSON.stringify({ Server: FETCHED_SERVERS }), DOMAIN_SECRET) + '\n'));
    }
    if (url.indexOf('/setting') !== -1) return Promise.resolve(apiResponse({ img_host: IMG_HOST }));
    if (url.indexOf('/daily') !== -1) {
      if (!dailyCheckInFails) return Promise.resolve(apiResponse({ daily_id: 7 }));
      return Promise.resolve(apiResponse(dailyWithoutIdPayload()));
    }
    if (url.indexOf('/search') !== -1) {
      return checkpoint().then(() => {
        if (searchStatus !== 200) {
          return { status: searchStatus, error: null, headers: {}, body: ktBase64Encode(Buffer.from('{"errorMsg":"請先登入會員"}', 'utf8')) };
        }
        return apiResponse(searchPayload(2827, 80));
      });
    }
    if (url.indexOf('/album') !== -1) {
      const m = /id=(\d+)/.exec(url);
      return checkpoint().then(() => apiResponse(albumPayload(m ? m[1] : '1231669')));
    }
    return Promise.resolve(null);
  }

  function dispatch(msg) {
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return true;              // 备份里 account 存在 ⇒ isLogged 为真
    if (m === 'UI') return null;
    if (m === 'delay') return null;
    if (m === 'load_data') return Object.prototype.hasOwnProperty.call(saved, msg.data_key) ? saved[msg.data_key] : null;
    if (m === 'save_data') { saved[msg.data_key] = msg.data; return null; }
    if (m === 'load_setting') {
      const persisted = { dailyCheckInTask: true, apiDomain: '3', imageStream: '3' };
      if (persisted[msg.setting_key] !== undefined) return persisted[msg.setting_key];
      return metaCache && metaCache[msg.setting_key] ? metaCache[msg.setting_key].default : undefined;
    }
    if (m === 'convert') {
      if (msg.type === 'utf8') return msg.isEncode ? ktEncodeUtf8(msg.value) : ktDecodeUtf8(msg.value);
      if (msg.type === 'md5') return ktMd5(msg.value);
      if (msg.type === 'base64') return msg.isEncode ? ktBase64Encode(msg.value) : ktBase64Decode(msg.value);
      if (msg.type === 'aes-ecb') return ktAesEcb(msg.value, msg.key, msg.isEncode === true);
      return null;
    }
    if (m === 'http') return http(msg);   // 返回 Promise（设备上是同步值，见上面的时序说明）
    return null;
  }

  ctx.__sendMessageSync = (msg) => dispatch(msg);
  vm.runInContext([
    'globalThis.__SYNC_METHODS = ' + JSON.stringify(SYNC_METHODS) + ';',
    'globalThis.sendMessage = function (msg) {',
    '  try {',
    '    var v = __sendMessageSync(msg);',
    '    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return v;',
    '    return Promise.resolve(v);',
    '  } catch (e) { return Promise.reject(e); }',
    '};',
  ].join('\n'), ctx);
  vm.runInContext(initJs, ctx);
  vm.runInContext(jmJs, ctx);
  // 设备在解析源之后就调 `init()`（`JM.apiDomains` 的唯一写入链）——台子必须走同一条生命周期。
  vm.runInContext('ComicSource.sources["jm"] = new JM();', ctx);
  reflectMeta();

  return { ctx, httpCalls, reflectMeta };
}

/**
 * 让源自己走完生命周期再断言。
 *
 * `JM.apiDomains` **没有初值**，唯一写入链是 `init()` → `refreshApiDomains()` → `overwriteApiDomains()`。
 * 少了这一步，`baseUrl` 会在第一个 HTTP 请求之前就抛 `Cannot read properties of undefined`，
 * 那是另一个缺陷，会把本台子要测的东西完全掩盖掉（沙箱替宿主造状态的经典假绿/假红）。
 * 设备上 `init()` 是 fire-and-forget，这里显式等它 settle，好让断言确定。
 */
async function createReadySandbox(opts) {
  const box = makeSandbox(opts);
  await evalAwaitingNew(box.ctx, 'ComicSource.sources["jm"].init()');
  // `init()` 尾部的 `refreshImgUrl(false)` 是浮动的，多给几个 checkpoint 让它跑完，
  // 否则它会以「下一个用例的 stray」形式出现，让断言随用例顺序漂移。
  for (let i = 0; i < 6; i++) await checkpoint();
  return box;
}

/**
 * 设备的 `evaluate`：脚本先跑（副作用已经发生），随后引擎 drain job queue，
 * 此时若 tracker 有挂起事件，就把它作为异常抛出来 —— 抛给**碰巧在这次调用的人**。
 */
function makeEvaluate(ctx) {
  return async function deviceEvaluate(code) {
    const value = vm.runInContext(code, ctx);
    await checkpoint();
    if (strayPending !== null) {
      const msg = strayPending;
      strayPending = null;
      throw new Error('UnhandledPromiseRejectionException: ' + msg);
    }
    return value;
  };
}

function slotSetup(expr, slot) {
  return (
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
    '})();'
  );
}

/** 修复前的泵：固定 64 次重入，无容忍，任何异常直接冒出去。 */
async function evalAwaitingOld(ctx, expr) {
  const evaluate = makeEvaluate(ctx);
  const slot = '__oldslot';
  await evaluate(slotSetup(expr, slot));
  for (let i = 0; i < 64; i++) {
    if ((await evaluate('globalThis.' + slot + '.done === true')) === true) break;
    await evaluate('void 0'); // DRAIN_JOBS
  }
  const done = (await evaluate('globalThis.' + slot + '.done === true')) === true;
  const out = {
    done,
    value: vm.runInContext('globalThis.' + slot + '.value', ctx),
    error: vm.runInContext('globalThis.' + slot + '.error', ctx),
  };
  vm.runInContext('delete globalThis.' + slot, ctx);
  return out;
}

/** 修复后的泵（逐字复刻 `JsEngine`）：先冲掉挂起的浮动拒绝 → 建立槽位 → 容忍式轮询。 */
async function evalAwaitingNew(ctx, expr) {
  const evaluate = makeEvaluate(ctx);
  const stray = [];

  const tolerant = async (code) => {
    try {
      return { value: await evaluate(code), stray: null };
    } catch (e) {
      if (String(e.message).indexOf('UnhandledPromiseRejection') !== -1) {
        stray.push(String(e.message));
        return { value: null, stray: String(e.message) };
      }
      throw e;
    }
  };
  const retrying = async (code) => {
    for (let i = 0; i < 2; i++) {
      const o = await tolerant(code);
      if (o.stray === null) return o.value;
      stray.push(o.stray);
    }
    return null;
  };

  for (let i = 0; i < 4; i++) await tolerant('void 0');   // drainStrayRejections

  const slot = '__newslot';
  let booted = false;
  for (let i = 0; i < 2 && !booted; i++) {
    await tolerant(slotSetup(expr, slot));
    booted = (await tolerant('typeof globalThis.' + slot + " === 'object'")).value === true;
  }
  if (!booted) throw new Error('脚本未能执行（求值槽位未创建）');

  const startedAt = process.hrtime.bigint();
  let ticks = 0;
  while (true) {
    const probe = await tolerant('globalThis.' + slot + ' && globalThis.' + slot + '.done === true');
    if (probe.value === true) break;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ticks >= 5000 || elapsedMs >= 300000) break;      // AWAIT_MAX_TICKS / AWAIT_DEADLINE_MS
    await tolerant('void 0');
    ticks++;
    await new Promise((r) => setTimeout(r, 1));           // PUMP_INTERVAL_MS
  }

  const done = (await retrying('globalThis.' + slot + '.done === true')) === true;
  const value = done ? await retrying('globalThis.' + slot + '.value') : null;
  const error = done ? await retrying('globalThis.' + slot + '.error') : null;
  await retrying('delete globalThis.' + slot);
  return { done, value, error, stray, ticks };
}

// --- 修复前后 `JsMangaSource.evalSource` 的逐行转写 -------------------------------------------------

/** 修复前：`runCatching{...}.getOrNull()` —— 异常与「没 settle」塌成同一个 `null`。 */
async function evalSourceOld(ctx, expr) {
  let outcome = null;
  let pumpThrew = null;
  try {
    outcome = await evalAwaitingOld(ctx, 'ComicSource.sources["jm"].' + expr);
  } catch (e) {
    pumpThrew = e;                     // 被 runCatching 吃掉
    outcome = null;
  }
  if (pumpThrew !== null) {
    return { kind: 'TIMEOUT-LIE', message: '禁漫天堂: timed out in jm.' + expr, pumpThrew };
  }
  if (outcome === null) return { kind: 'NULL', message: '禁漫天堂: timed out in jm.' + expr, pumpThrew };
  if (outcome.error != null) return { kind: 'REJECTED', message: '禁漫天堂: ' + outcome.error, pumpThrew };
  return { kind: 'SETTLED', value: outcome.value, pumpThrew };
}

/** 修复后：异常与超时分开报告。 */
async function evalSourceNew(ctx, expr) {
  let outcome = null;
  let threw = null;
  try {
    outcome = await evalAwaitingNew(ctx, 'ComicSource.sources["jm"].' + expr);
  } catch (e) {
    threw = e;
  }
  if (threw) return { kind: 'EXCEPTION', message: '禁漫天堂: ' + threw.constructor.name + ': ' + threw.message };
  if (outcome === null) return { kind: 'TIMEOUT', message: '禁漫天堂: timed out in jm.' + expr };
  if (outcome.error != null) return { kind: 'REJECTED', message: '禁漫天堂: ' + outcome.error };
  return { kind: 'SETTLED', value: outcome.value, stray: outcome.stray, ticks: outcome.ticks };
}

// --- 用例 ---------------------------------------------------------------------------------------

(async () => {
  console.log('STRAY REJECTION — 真 init.js + 真 jm.js（js-sources/jm.js 与用户备份里的源逐字节相同）\n');

  // -------------------------------------------------------------------------------------------
  section('1. 反向对照 — 修复前必须复现真机那条 `timed out in ...`');

  {
    const { ctx } = await createReadySandbox();
    resetStray();   // 只观测「测试调用期间」的浮动拒绝，init 自己的另算
    const res = await evalSourceOld(ctx, 'search.load("魔法", ["mr"], 1)');

    check('旧实现把这次调用报成 timeout（与真机截图逐字一致）',
      res.kind === 'TIMEOUT-LIE' && res.message === '禁漫天堂: timed out in jm.search.load("魔法", ["mr"], 1)',
      JSON.stringify(res.message));
    check('而真实原因其实是**抛出的异常**，被 runCatching 吃掉了',
      !!res.pumpThrew && String(res.pumpThrew.message).indexOf('UnhandledPromiseRejectionException') === 0,
      res.pumpThrew ? String(res.pumpThrew.message).slice(0, 140) : 'pump 没有抛（台子未能复现）');
    check('异常内容来自源自己没 await 的 dailyCheckIn，而不是 search 本身',
      !!res.pumpThrew && /Invalid daily_id/i.test(String(res.pumpThrew.message)),
      res.pumpThrew ? String(res.pumpThrew.message).slice(0, 140) : '');

    // 同一机制也作用于详情——真机两张截图是同一件事。
    const { ctx: ctx2 } = await createReadySandbox();
    resetStray();
    const res2 = await evalSourceOld(ctx2, 'comic.loadInfo("1231669")');
    check('同一机制也把 loadInfo 报成 timeout（对齐第二张截图）',
      res2.kind === 'TIMEOUT-LIE' && res2.message === '禁漫天堂: timed out in jm.comic.loadInfo("1231669")',
      JSON.stringify(res2.message));
  }

  // -------------------------------------------------------------------------------------------
  section('2. 修复后 — 浮动拒绝不再炸掉无关调用，调用本身拿到结果');

  {
    const { ctx } = await createReadySandbox();
    resetStray();
    const res = await evalSourceNew(ctx, 'search.load("魔法", ["mr"], 1)');

    check('search.load 正常 settle', res.kind === 'SETTLED', JSON.stringify(res.message || res.kind));
    const comics = res.value && res.value.comics ? res.value.comics : [];
    check('拿到 80 条结果（而不是空列表 / 超时）', comics.length === 80, 'comics=' + comics.length);
    check('maxPage 解析正确（total=2827 / 80）',
      res.value && res.value.maxPage === 36, JSON.stringify(res.value && res.value.maxPage));
    check('第一条的 title 是真实解出来的（不是 undefined）',
      comics.length > 0 && /魔法少女/.test(String(comics[0].title)),
      comics.length ? String(comics[0].title).slice(0, 40) : '');
    check('浮动拒绝确实发生过（是被吞掉，不是没发生）', strayLog.length >= 1, 'stray=' + strayLog.length);
    check('浮动拒绝被记进了 stray 列表（不会静默消失）',
      Array.isArray(res.stray) && res.stray.length >= 1,
      'stray=' + JSON.stringify((res.stray || []).slice(0, 1)));
  }

  {
    const { ctx } = await createReadySandbox();
    resetStray();
    const res = await evalSourceNew(ctx, 'comic.loadInfo("1231669")');

    check('comic.loadInfo 正常 settle', res.kind === 'SETTLED', JSON.stringify(res.message || res.kind));
    const chapters = res.value && res.value.chapters;
    check('章节数 = 1（真机截图是「共 0 章」）',
      chapters && typeof chapters.size === 'number' && chapters.size === 1,
      chapters ? 'size=' + chapters.size : String(chapters));
    check('封面 URL 来自源的当前图床（不是备份里的历史主机）',
      res.value && /^https:\/\/cdn-msp\.example\.net\/media\/albums\//.test(String(res.value.cover)),
      String(res.value && res.value.cover));
    check('title 取自源（覆盖掉备份里的标题）',
      res.value && /自拍女友总集编/.test(String(res.value.title)), String(res.value && res.value.title));
  }

  // -------------------------------------------------------------------------------------------
  section('3. 边界 — 容忍浮动拒绝，不能顺手吞掉「我方调用自己的失败」');

  {
    const { ctx } = await createReadySandbox({ searchStatus: 401 });
    resetStray();
    const res = await evalSourceNew(ctx, 'search.load("魔法", ["mr"], 1)');

    check('源对 401 抛出的消息仍报成 REJECTED（没被当成 stray 吞掉）',
      res.kind === 'REJECTED', JSON.stringify(res.kind + ' ' + (res.message || '')));
    // 源自己的语义：401 + `請先登入會員` **并且** isLogged 为真时，jm.js 翻成 `Login expired`
    // （见 jm.js `get()`）。本沙箱的 isLogged 就是 true —— 备份里带着 account。
    // 断言要跟着源走，别跟着我们期望的文案走。
    check('消息是源自己的语义「Login expired」（isLogged=true 时 jm.js 对 401 的翻法）',
      /Login expired/.test(String(res.message)), String(res.message));
    check('同一轮里浮动拒绝照样被记下来（两种失败互不干扰）', strayLog.length >= 1, 'stray=' + strayLog.length);
  }

  {
    // 我们自己的链永远挂了 rejection handler（slotSetup 的 `.then(ok, err)`），
    // 所以**只有**无人接管的拒绝才会进 stray —— 这是容忍策略安全的前提。
    const { ctx } = await createReadySandbox();
    resetStray();
    await evalSourceNew(ctx, 'search.load("魔法", ["mr"], 1)');
    check('stray 只包含源自己制造的浮动拒绝，不含我方调用的拒绝',
      strayLog.every((m) => !/^Magic/.test(m)), JSON.stringify(strayLog.slice(0, 3)));
  }

  console.log('\n' + (fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`) + `  (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('harness crashed:', e);
  process.exitCode = 2;
});
