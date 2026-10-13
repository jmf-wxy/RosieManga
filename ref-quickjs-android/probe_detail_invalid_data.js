#!/usr/bin/env node
/**
 * LIVE PROBE — 「共 1 章」回归：宿主读出路径（__plainValue → Kotlin 形状）到底拿到什么？
 *
 * 手动跑：node probe_chapters_shape.js [comicId]
 *
 * 复刻 JsEngine.evalAwaitingResult 的读出契约：
 *   1. slotSetup → Promise.resolve(comic.loadInfo(id)).then(...) 存 slot
 *   2. 泵到 done
 *   3. `__plainValue(slot.value)`（= withPlainValue）→ 这就是 wrapper convertToMap 将枚举的 JS 对象
 *   4. Kotlin 侧等价：data["chapters"] as? Map → entries（key 剥 \u0000 前缀）
 * 并逐层打印形状，定位「共 1 章」在哪一层出现。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

const COMIC_ID = process.argv[2] || '1014509';

// --- Kotlin-equivalent Convert.* ----------------------------------------------------------------

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
// Convert AES-ECB（NoPadding，短尾截断）—— 与 JsMessageDispatcher 的 Kotlin 实现逐字对应。
// jm.js::convertData 的解密腿走这里；缺了它 init() 就会 `null.length`。
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

const httpLog = [];

const { Worker } = require('worker_threads');
const SAB_SIZE = 32 * 1024 * 1024;
const sab = new SharedArrayBuffer(SAB_SIZE);
const flag = new Int32Array(sab, 0, 1);
const lenSlot = new Int32Array(sab, 16, 1);
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
    httpLog.push({ url: label, ms, status: null, error: 'timeout' });
    return JSON.stringify({ status: null, headers: {}, body: null, error: 'timeout' });
  }
  const n = Atomics.load(lenSlot, 0);
  const env = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, n).toString('utf8'));
  inspectBody(label, env);
  httpLog.push({ url: label, ms, status: env.status, error: env.error });
  return JSON.stringify(env);
}

// --- 沙箱 ----------------------------------------------------------------------------------------

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
    if (m === 'http') return host.blockingSend(msg);
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

// --- 形状检查 ------------------------------------------------------------------------------------

function describe(tag, v) {
  const t = v === null ? 'null' : typeof v;
  console.log(`  [${tag}] typeof=${t}`);
  if (v instanceof Map) {
    console.log(`    Map.size=${v.size}`);
    let i = 0;
    for (const [k, val] of v.entries()) {
      if (i++ >= 5) { console.log('    …'); break; }
      console.log(`    entry key=${JSON.stringify(k)} (${typeof k})  value=${JSON.stringify(val)} (${typeof val})`);
    }
    return;
  }
  if (Array.isArray(v)) { console.log(`    Array.length=${v.length}  head=${JSON.stringify(v.slice(0, 3))}`); return; }
  if (t === 'object' && v !== null) {
    const keys = Object.keys(v);
    console.log(`    Object.keys.length=${keys.length}  keys=${JSON.stringify(keys.slice(0, 15))}`);
    if (v.chapters !== undefined) describe(tag + '.chapters', v.chapters);
    return;
  }
  console.log(`    value=${JSON.stringify(v)}`);
}

// --- 响应体形状检查：定位 `throw 'Invalid Data'` 到底是哪个接口 ------------------------------------
const bodyShapes = [];

function inspectBody(label, env) {
  if (env.status == null || typeof env.body !== 'string') return;
  let text;
  try {
    text = Buffer.from(env.body, 'base64').toString('utf8');
  } catch (e) {
    return;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    bodyShapes.push({ url: label, kind: 'NON_JSON', head: text.slice(0, 200) });
    return;
  }
  // jm.js::get/post throws 'Invalid Data' exactly when `typeof json.data !== 'string'`.
  bodyShapes.push({
    url: label,
    kind: typeof json.data === 'string' ? 'OK  (data=string)' : 'BAD (data=' + (json.data === null ? 'null' : typeof json.data) + ')',
    keys: Object.keys(json).slice(0, 10),
    code: json.code,
    errorMsg: json.errorMsg,
  });
}

const TITLE = process.argv[2] || '乗馬女子の騎乗位';

async function main() {
  const host = { saved: {}, settings: {}, blockingSend: (msg) => blockingHttp(msg) };
  const ctx = makeSandbox(host);
  ctx.reflectMeta();

  console.log(`probe_detail_invalid_data: title="${TITLE}"\n`);

  const a = await ctx.awaitEval("ComicSource.sources['jm'].init()");
  console.log(`init: done=${a.done}${a.error ? ' error=' + a.error : ''}\n`);

  const where = await ctx.awaitEval(
    "(typeof search !== 'undefined' && search && typeof search.load === 'function') ? 'global' " +
    ": (ComicSource.sources['jm'].search && typeof ComicSource.sources['jm'].search.load === 'function' ? 'member' : 'none')",
  );
  console.log(`search owner = ${where.value}`);

  let ids = [];
  if (where.value !== 'none') {
    const expr = where.value === 'global' ? 'search' : "ComicSource.sources['jm'].search";
    const s = await ctx.awaitEval(`${expr}.load(${JSON.stringify(TITLE)}, ['mr'], 1)`);
    console.log(`search.load: done=${s.done}${s.error ? ' error=' + s.error : ''}`);
    if (s.done && s.value) {
      console.log(`  keys=${JSON.stringify(Object.keys(s.value).slice(0, 10))}`);
      const list = s.value.comics || s.value.data || [];
      console.log(`  results=${list.length}`);
      ids = list.slice(0, 5).map((c) => ({ id: String(c.id), name: c.name || c.title }));
      ids.forEach((c, i) => console.log(`   #${i} id=${c.id}  ${JSON.stringify(c.name)}`));
    }
  }

  if (ids.length === 0) {
    console.log('\n没有搜到候选 id，无法继续。');
  } else {
    for (const cand of ids.slice(0, 2)) {
      console.log(`\n===== comic.loadInfo('${cand.id}') — ${JSON.stringify(cand.name)} =====`);
      const before = httpLog.length;
      const r = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${cand.id}')`);
      console.log(`  done=${r.done}${r.error ? '  error=' + r.error : ''}`);
      if (r.done && r.value) {
        console.log(`  keys=${JSON.stringify(Object.keys(r.value).slice(0, 12))}`);
        const ch = r.value.chapters;
        if (ch) console.log(`  chapters=${ch instanceof Map ? 'Map(' + ch.size + ')' : Object.keys(ch).length}`);
      }
      console.log(`  本次请求数=${httpLog.length - before}`);
    }
  }

  console.log('\n=== 每个响应的 JSON 形状（BAD 就是 jm.js 抛 Invalid Data 的那一次） ===');
  for (const b of bodyShapes) {
    console.log(`  ${b.kind}  ${b.url}`);
    if (b.kind === 'NON_JSON') console.log(`        head=${JSON.stringify(b.head)}`);
    else console.log(`        keys=${JSON.stringify(b.keys)} code=${JSON.stringify(b.code)} errorMsg=${JSON.stringify(b.errorMsg)}`);
  }

  console.log('\n=== http 时间线 ===');
  for (const h of httpLog) {
    console.log(`  ${String(h.ms).padStart(6)}ms  status=${String(h.status).padEnd(4)}  ${h.url}${h.error ? '  ERROR=' + h.error : ''}`);
  }
  console.log('\nRESULT: probe finished');
}

main().catch((e) => {
  console.error('PROBE ERROR', e);
  process.exitCode = 1;
});
