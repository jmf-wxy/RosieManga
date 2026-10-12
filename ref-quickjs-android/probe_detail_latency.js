#!/usr/bin/env node
/**
 * LIVE PROBE — JS 漫画源详情页到底慢在哪一段？
 *
 * 这是一个 **probe**（需要真实网络），刻意不叫 verify_*.js，全量 sweep 不会带上它。手动跑：
 *
 *   node probe_detail_latency.js [comicId]
 *
 * ### 背景
 *
 * 用户反馈「JS 源漫画进详情页加载时间太长」。已知事实：
 *   - 桥是同步的：init.js `fetch` → `Network.fetchBytes` → `__sendMessageSync`（原生阻塞），
 *     所以**同一根 JS 线程上所有请求物理串行**；
 *   - jm.js `init()` = refreshDomainsOnStart(默认 true) 拉 newsvr-2025.txt（bytepluses 香港）
 *     + refreshImgUrl 拉 `${baseUrl}/setting`，两个串行请求；
 *   - 桥走全局 OkHttp（2 分钟 callTimeout）——一个挂起请求能把 JS 线程堵死很久。
 *
 * 本探针用 **真 jm.js + 真网络** 逐段计时，回答三个问题：
 *   A. init() 两段各花多久？（app 启动即触发，详情页要不要排队等它）
 *   B. 一次 loadInfo（详情页共享的那次）本身多久、发了几个请求？
 *   C. 「启动后立刻进详情页」（init 与 loadInfo 并发）比「init 完成后再进」慢多少？
 *
 * 输出只看 RESULT 表；结论写在会话记录里，不改任何产品代码。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

const COMIC_ID = process.argv[2] || '1014509';

// --- Kotlin-equivalent `Convert.*`（与 verify_map_chapters_e2e.js 逐字一致）-----------------------

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
  key = Buffer.from(key);
  value = Buffer.from(value);
  if (key.length === 0 || value.length === 0) return null;
  const body = value.subarray(0, Math.floor(value.length / 16) * 16);
  const c = encode
    ? crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null)
    : crypto.createDecipheriv('aes-' + key.length * 8 + '-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(body), c.final()]);
}

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// --- 真网络 http 桥（模拟设备：sanitize 后的 Accept-Encoding + 字节信封）--------------------------

const httpLog = []; // { url, ms, status, bytes, error }

// 真阻塞的同步 http：主线程 Atomics.wait 挂起（= 设备上 JS 线程被 OkHttp execute() 阻塞），
// Worker 线程跑异步 fetch，完成后把响应信封写进 SharedArrayBuffer 并唤醒主线程。
const { Worker } = require('worker_threads');
const SAB_SIZE = 32 * 1024 * 1024;
const sab = new SharedArrayBuffer(SAB_SIZE);
const flag = new Int32Array(sab, 0, 1);       // 0=等待 1=就绪
const lenSlot = new Int32Array(sab, 16, 1);   // payload 字节数
const payload = new Uint8Array(sab, 64);
const workerSrc = `
const { parentPort, workerData } = require('worker_threads');
const flag = new Int32Array(workerData.sab, 0, 1);
const lenSlot = new Int32Array(workerData.sab, 16, 1);
const payload = new Uint8Array(workerData.sab, 64);
parentPort.on('message', async (req) => {
  let env;
  try {
    const headers = { ...(req.headers || {}) };
    if (headers['Accept-Encoding']) headers['Accept-Encoding'] = 'gzip, deflate';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(req.url, {
      method: req.http_method || 'GET',
      headers,
      body: req.data != null ? req.data : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const buf = Buffer.from(await res.arrayBuffer());
    env = { status: res.status, headers: {}, body: buf.toString('base64'), error: null };
  } catch (e) {
    env = { status: null, headers: {}, body: null, error: String((e && e.message) || e) };
  }
  let bytes = Buffer.from(JSON.stringify(env), 'utf8');
  if (bytes.length > payload.length) bytes = bytes.subarray(0, payload.length);
  bytes.copy(payload, 0);
  Atomics.store(lenSlot, 0, bytes.length);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
});
`;
const netWorker = new Worker(workerSrc, { eval: true, workerData: { sab } });

function blockingHttp(msg) {
  const started = Date.now();
  const label = String(msg.url).replace(/\?.*/, '?…');
  Atomics.store(flag, 0, 0);
  netWorker.postMessage({
    url: msg.url, http_method: msg.http_method, headers: msg.headers, data: msg.data,
  });
  const woken = Atomics.wait(flag, 0, 0, 35000);
  const ms = Date.now() - started;
  if (woken !== 'ok' || Atomics.load(flag, 0) !== 1) {
    httpLog.push({ url: label, ms, status: null, bytes: 0, error: 'no response within 35s' });
    return JSON.stringify({ status: null, headers: {}, body: null, error: 'timeout' });
  }
  const n = Atomics.load(lenSlot, 0);
  const env = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, n).toString('utf8'));
  httpLog.push({ url: label, ms, status: env.status, bytes: env.body ? Math.floor(env.body.length * 3 / 4) : 0, error: env.error });
  return JSON.stringify(env);
}

// --- 沙箱（与 verify_map 同构，唯 http 走真网络、Date 不冻结）------------------------------------

function makeSandbox(host) {
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
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return false;
    if (m === 'UI') return null;
    if (m === 'delay') return null;
    if (m === 'load_data') return Object.prototype.hasOwnProperty.call(host.saved, msg.data_key) ? host.saved[msg.data_key] : null;
    if (m === 'save_data') { host.saved[msg.data_key] = msg.data; return null; }
    if (m === 'delete_data') { delete host.saved[msg.data_key]; return null; }
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
      // 与设备一致：JS 线程在这里被同步阻塞到网络返回。
      return host.blockingSend(msg);
    }
    return null;
  }

  sandbox.__sendMessageSync = dispatch;
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

  const awaitEval = async (expr, maxTicks = 4000) => {
    const slot = '__pslot_' + Math.random().toString(36).slice(2, 8);
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
  };

  return { sandbox, reflectMeta, awaitEval };
}

// --- 场景 ----------------------------------------------------------------------------------------

function mark(label) {
  const t = Date.now();
  console.log(`  [${(t / 1000).toFixed(2)}s] ${label}`);
  return t;
}
function dur(from) { return ((Date.now() - from) / 1000).toFixed(2) + 's'; }
function printHttpSince(n0) {
  for (let i = n0; i < httpLog.length; i++) {
    const h = httpLog[i];
    console.log(`      · ${h.ms}ms  status=${h.status}  ${h.bytes}B  ${h.url}${h.error ? '  ERROR=' + h.error : ''}`);
  }
}

async function main() {
  const host = { saved: {}, settings: {}, blockingSend: (msg) => blockingHttp(msg) };
  const ctx = makeSandbox(host);

  console.log(`probe_detail_latency: comic=${COMIC_ID}  (真 jm.js × 真网络 × 同步桥时序)\n`);

  let t = mark('boot: eval init.js + jm.js + new JM()');
  ctx.reflectMeta();
  console.log(`  => ${dur(t)}\n`);

  // --- A. init()（app 启动即触发的那次） ---------------------------------------------------------
  let n0 = httpLog.length;
  t = mark('A. init()  [refreshDomainsOnStart=true: newsvr + /setting]');
  const a = await ctx.awaitEval("ComicSource.sources['jm'].init()");
  console.log(`  => ${dur(t)}  done=${a.done} ${a.error ? 'error=' + a.error : ''}`);
  printHttpSince(n0);

  // --- B. loadInfo 冷（详情页共享的那一次） ------------------------------------------------------
  n0 = httpLog.length;
  t = mark(`B. loadInfo('${COMIC_ID}') 冷`);
  const b = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`);
  console.log(`  => ${dur(t)}  done=${b.done} ${b.error ? 'error=' + b.error : ''}${b.done && b.value ? '  chapters=' + (b.value.chapters ? Object.keys(b.value.chapters).length : 'n/a') : ''}`);
  printHttpSince(n0);

  // --- C. loadInfo 热（第二次打开同一详情页） ----------------------------------------------------
  n0 = httpLog.length;
  t = mark(`C. loadInfo('${COMIC_ID}') 热（同一 JS realm 内重开）`);
  const c = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`);
  console.log(`  => ${dur(t)}  done=${c.done} ${c.error ? 'error=' + c.error : ''}`);
  printHttpSince(n0);

  // --- D. 重启场景：新 realm，init 与 loadInfo 并发（app 刚启动就点进详情页） --------------------
  const host2 = { saved: {}, settings: {}, blockingSend: (msg) => blockingHttp(msg) };
  const ctx2 = makeSandbox(host2);
  ctx2.reflectMeta();
  n0 = httpLog.length;
  t = mark("D. 新 realm：init() 与 loadInfo() 同时发（未等 init 完成）");
  const [d1, d2] = await Promise.all([
    ctx2.awaitEval("ComicSource.sources['jm'].init()"),
    ctx2.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`),
  ]);
  console.log(`  => 总 ${dur(t)}  init done=${d1.done} ${d1.error ? 'err=' + d1.error : ''} | loadInfo done=${d2.done} ${d2.error ? 'err=' + d2.error : ''}`);
  printHttpSince(n0);

  console.log('\n=== 全部请求时间线 ===');
  for (const h of httpLog) {
    console.log(`  ${String(h.ms).padStart(6)}ms  status=${String(h.status).padEnd(3)}  ${h.url}`);
  }
  console.log('\nRESULT: probe finished');
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exitCode = 1; });
