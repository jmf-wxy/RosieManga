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
const jmJs = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

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

async function main() {
  const host = { saved: {}, settings: {}, blockingSend: (msg) => blockingHttp(msg) };
  const ctx = makeSandbox(host);
  ctx.reflectMeta();

  console.log(`probe_chapters_shape: comic=${COMIC_ID}\n`);

  const a = await ctx.awaitEval("ComicSource.sources['jm'].init()");
  console.log(`init: done=${a.done} ${a.error ? 'error=' + a.error : ''}\n`);

  const r = await ctx.awaitEval(`ComicSource.sources['jm'].comic.loadInfo('${COMIC_ID}')`);
  console.log(`loadInfo: done=${r.done} ${r.error ? 'error=' + r.error : ''}`);
  if (!r.done) { console.log('RESULT: slot never settled'); return; }

  console.log('\n== 1. 原始 slot.value（JS 侧） ==');
  describe('raw', r.value);

  console.log('\n== 2. __plainValue(slot.value)（宿主 withPlainValue 的结果） ==');
  const plain = vm.runInContext('globalThis.__plainValue(__pv_in)', ctx.sandbox);
  function setIn(v) { ctx.sandbox.__pv_in = v; }
  setIn(r.value);
  const plain2 = vm.runInContext(
    '(function(){ var __v = (globalThis.__pv_in); return (typeof globalThis.__plainValue === "function" ? globalThis.__plainValue(__v) : __v); })()',
    ctx.sandbox);
  describe('plain', plain2);

  console.log('\n== 3. Kotlin getChapterList 等价读取 ==');
  const chapters = plain2.chapters;
  if (chapters === undefined || chapters === null) {
    console.log('  data["chapters"] 缺失 → getChapterList 返回 emptyList →「没有章节」');
  } else if (chapters instanceof Map) {
    console.log('  chapters 仍是 Map（宿主会拿到空 {}）');
  } else {
    const entries = Object.entries(chapters);
    console.log(`  chapters entries=${entries.length}`);
    entries.slice(0, 8).forEach(([k, v], i) => {
      const chapterId = String(k).replace(/^\u200b/, '');
      console.log(`   #${i} rawKey=${JSON.stringify(k)} → chapterId=${JSON.stringify(chapterId)} name=${JSON.stringify(v)}`);
    });
  }

  console.log('\n=== http 时间线 ===');
  for (const h of httpLog) {
    console.log(`  ${String(h.ms).padStart(6)}ms  status=${String(h.status).padEnd(3)}  ${h.url}${h.error ? '  ERROR=' + h.error : ''}`);
  }
  console.log('\nRESULT: probe finished');
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exitCode = 1; });
