#!/usr/bin/env node
/**
 * verify_async_http_e2e.js — 异步 http 桥的端到端契约。
 *
 * ### 背景与修复
 *
 * 同步桥把 JS 线程钉死在每次网络往返上。实测（probe_detail_latency.js，真 jm.js × 真网络）：
 *   - jm.js `init()` = newsvr-2025.txt(1.5s) + /setting(1.7s) 串行 —— app 启动即触发；
 *   - 详情页 loadInfo = 单个 /album(~0.3s)；
 *   - jm.js 的 `JM.apiDomains` 在 `init()` 之前**不存在**，宿主 `evalSource` 原本没有 init 门闩，
 *     竞态下 loadInfo 会打到 `https://undefined` 并挂到全局 OkHttp 的 2 分钟 callTimeout ——
 *     这就是「详情页一直加载」的主因之一。
 *
 * 修复（Kotlin 侧，本脚本钉住 JS 侧契约）：
 *   1. BRIDGE_SHIM 新增 `__http_async_cap` 能力探测与 `__http_async` 异步分支；
 *   2. 异步分支返回**真 pending Promise**，Kotlin 完成请求后经 `__httpDeliver(cbId, b64)` 兑现；
 *   3. 能力不满足（老宿主/验证台子）→ 回退同步路径，源侧契约不变（反向对照 §D）。
 *
 * delay 异步腿（§G/§H，2026-10 补）：
 *   旧实现 `delay` = `Thread.sleep` **在 JS 线程上**。init.js 的 `setTimeout`/`setInterval`
 *   建立在该方法之上 —— 源里任何一个定时器/重试退避都会把唯一 QuickJS 线程睡死，
 *   图书馆更新的 loadInfo 泵、下载器 eval 全部排队等它醒（「更新分类卡进度」的放大器）。
 *   修复后有能力时走 `__delay_async`（Kotlin 在 IO 域睡、经 `__httpDeliver` 兑现），
 *   无能力回退同步（§H 用 Atomics.wait 复刻真阻塞，反向对照证明 §G3 不是台子失真）。
 *
 * 台子纪律：逐字复刻 Kotlin 的 BRIDGE_SHIM（sendMessage 段）；§C 用两次不同延迟的投递
 * 断言「真并行」（in-flight 峰值 ≥ 2）——同步桥下物理上不可能，假绿无法通过此节。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

// --- Kotlin BRIDGE_SHIM 的逐字复刻（只保留 sendMessage/async 相关；dlg 队列略去）-------------------
// 来源：JsEngine.kt BRIDGE_SHIM。改动两边必须同步。
const BRIDGE_SHIM_REPLICA = `
    globalThis.__SYNC_METHODS = [
        'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
        'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
        'log', 'cookie', 'delay', 'getClipboard', 'setClipboard'
    ];

    globalThis.__httpAsyncCap = false;
    try { globalThis.__httpAsyncCap = __sendMessageSync({ method: '__http_async_cap' }) === true; } catch (e) {}
    globalThis.__httpPending = {};
    globalThis.__httpCbCounter = 0;
    globalThis.__httpDeliver = function (cbId, b64) {
        var resolve = globalThis.__httpPending[cbId];
        if (!resolve) return;
        delete globalThis.__httpPending[cbId];
        try {
            resolve(Convert.decodeUtf8(Convert.decodeBase64(b64)));
        } catch (e) {}
    };

    globalThis.sendMessage = function (msg) {
        try {
            if (msg && msg.method === 'delay' && globalThis.__httpAsyncCap) {
                var dt = msg.time;
                if (typeof dt !== 'number' || !(dt > 0)) return Promise.resolve(undefined);
                if (dt > 60000) dt = 60000;
                return new Promise(function (resolve) {
                    var cbId = '__delay_cb_' + (globalThis.__httpCbCounter++);
                    globalThis.__httpPending[cbId] = resolve;
                    __sendMessageSync({ method: '__delay_async', __cb: cbId, time: dt });
                });
            }
            if (msg && msg.method === 'http' && globalThis.__httpAsyncCap) {
                return new Promise(function (resolve) {
                    var cbId = '__http_cb_' + (globalThis.__httpCbCounter++);
                    globalThis.__httpPending[cbId] = resolve;
                    __sendMessageSync({
                        method: '__http_async',
                        __cb: cbId,
                        http_method: msg.http_method,
                        url: msg.url,
                        headers: msg.headers,
                        data: msg.data,
                        extra: msg.extra,
                    });
                });
            }
            var value = __sendMessageSync(msg);
            if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return value;
            return Promise.resolve(value);
        } catch (e) {
            return Promise.reject(e);
        }
    };
`;

// --- Kotlin Convert 桥的等价实现（init.js 的 Convert 依赖桥）--------------------------------------

const crypto = require('crypto');
const ktEncodeUtf8 = (str) => Buffer.from(String(str), 'utf8');
function ktDecodeUtf8(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  return Buffer.from(value).toString('utf8');
}
const ktBase64Encode = (value) => Buffer.from(value).toString('base64');
function ktBase64Decode(text) {
  if (typeof text !== 'string') return null;
  try { return Buffer.from(text.replace(/[\s\uFEFF]/g, ''), 'base64'); } catch (e) { return null; }
}

// --- 沙箱 -----------------------------------------------------------------------------------------

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

  const state = {
    capProbeCount: 0,
    asyncMessages: [],
    delayAsyncMessages: [],
    syncDelayMessages: [],
    syncHttpMessages: 0,
    inFlight: 0,
    maxInFlight: 0,
  };

  // 同步 delay 的真实代价：宿主 Kotlin 侧曾是 `Thread.sleep`（钉死 JS 线程）。
  // 台子用 Atomics.wait 复刻「阻塞」语义，§H 的反向对照才能区分「钉住」与「真异步」。
  const busySleep = (ms) => {
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  function dispatch(msg) {
    const m = msg.method;
    if (m === '__http_async_cap') { state.capProbeCount++; return host.asyncCap === true; }
    if (m === '__delay_async') {
      state.delayAsyncMessages.push({ __cb: msg.__cb, time: msg.time });
      const cb = msg.__cb;
      const t = Math.max(0, Number(msg.time) || 0);
      setTimeout(() => {
        vm.runInContext(`globalThis.__httpDeliver('${cb}', '')`, sandbox);
      }, t);
      return null;
    }
    if (m === 'delay') { state.syncDelayMessages.push({ time: msg.time }); busySleep(Number(msg.time) || 0); return null; }
    if (m === '__http_async') {
      state.asyncMessages.push({ __cb: msg.__cb, url: msg.url, http_method: msg.http_method });
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const delay = (host.delays && host.delays[msg.url]) || 10;
      const b64 = host.respond ? host.respond(msg) : ktBase64Encode(JSON.stringify({ status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from('ok:' + msg.__cb)) }));
      setTimeout(() => {
        state.inFlight--;
        vm.runInContext(`globalThis.__httpDeliver('${msg.__cb}', '${b64}')`, sandbox);
      }, delay);
      return null;
    }
    if (m === 'http') { state.syncHttpMessages++; return host.syncHttp ? host.syncHttp(msg) : null; }
    if (m === 'convert') {
      if (msg.type === 'utf8') return msg.isEncode ? ktEncodeUtf8(msg.value) : ktDecodeUtf8(msg.value);
      if (msg.type === 'base64') return msg.isEncode ? ktBase64Encode(msg.value) : ktBase64Decode(msg.value);
      return null;
    }
    if (m === 'load_setting') return 'v';
    return null;
  }

  sandbox.__sendMessageSync = dispatch;
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SHIM_REPLICA, sandbox);
  vm.runInContext(initJs, sandbox);

  const awaitEval = async (expr, maxTicks = 20000) => {
    const slot = '__aslot_' + Math.random().toString(36).slice(2, 8);
    vm.runInContext(
      'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
      '(function () {\n' +
      '  try {\n' +
      '    Promise.resolve(' + expr + ').then(\n' +
      '      function (v) { if (globalThis.' + slot + ') { globalThis.' + slot + '.done = true; globalThis.' + slot + '.value = v; } },\n' +
      '      function (e) { if (globalThis.' + slot + ') { globalThis.' + slot + '.done = true; globalThis.' + slot + '.error = String((e && e.message) || e); } }\n' +
      '    );\n' +
      '  } catch (e) {\n' +
      '    globalThis.' + slot + '.done = true;\n' +
      '    globalThis.' + slot + '.error = String((e && e.message) || e);\n' +
      '  }\n' +
      '})();', sandbox);
    // 时间预算而非 tick 预算：setImmediate 循环在一台快机器上可能比 setTimeout(10ms) 还快耗尽 tick。
    const deadline = Date.now() + 5000;
    for (let i = 0; i < maxTicks && Date.now() < deadline; i++) {
      if (vm.runInContext('globalThis.' + slot + ' && globalThis.' + slot + '.done === true', sandbox) === true) break;
      vm.runInContext('void 0', sandbox);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const out = {
      done: vm.runInContext('globalThis.' + slot + ' && globalThis.' + slot + '.done === true', sandbox) === true,
      value: vm.runInContext('globalThis.' + slot + ' && globalThis.' + slot + '.value', sandbox),
      error: vm.runInContext('globalThis.' + slot + ' && globalThis.' + slot + '.error', sandbox),
      finishedAt: Date.now(),
    };
    vm.runInContext('delete globalThis.' + slot, sandbox);
    return out;
  };

  return { sandbox, state, awaitEval };
}

// --- 场景 -----------------------------------------------------------------------------------------

(async function main() {
  // §A 能力探测与异步分支契约
  section('A. 能力探测（__http_async_cap）与异步分支消息形状');
  const ctxA = makeSandbox({ asyncCap: true, delays: {} });
  check('A1: shim 在装载时恰好发一次能力探测', ctxA.state.capProbeCount === 1, String(ctxA.state.capProbeCount));
  const a = await ctxA.awaitEval("Network.fetchBytes('GET', 'https://api.example/x', {a: 'b'}, null)");
  check('A2: fetchBytes 经异步腿 settle', a.done && !a.error, a.error);
  check('A3: envelope 解出后 body 正确（JSON 字符串信封 + base64 body 双层）',
    a.done && a.value && a.value.status === 200 && ktDecodeUtf8(a.value.body) === 'ok:__http_cb_0',
    JSON.stringify(a.value));
  check('A4: 异步消息带 __cb / http_method / url（Kotlin 需要的三件套）',
    ctxA.state.asyncMessages.length === 1 &&
    ctxA.state.asyncMessages[0].__cb === '__http_cb_0' &&
    ctxA.state.asyncMessages[0].http_method === 'GET' &&
    ctxA.state.asyncMessages[0].url === 'https://api.example/x',
    JSON.stringify(ctxA.state.asyncMessages));
  check('A5: 异步路径未触碰同步 http 分支', ctxA.state.syncHttpMessages === 0, String(ctxA.state.syncHttpMessages));

  // §B 同步 API 不受影响（S3 契约）
  section('B. 同步 API 契约（S3）：SYNC_METHODS 返回值本身，非 Promise');
  const isThenable = (v) => v && typeof v.then === 'function';
  const syncVal = vm.runInContext("sendMessage({ method: 'load_setting', setting_key: 'k' })", ctxA.sandbox);
  check('B1: load_setting 返回值本身（非 Promise）', !isThenable(syncVal) && syncVal === 'v', String(syncVal));
  const httpVal = vm.runInContext("sendMessage({ method: 'http', http_method: 'GET', url: 'https://api.example/y' })", ctxA.sandbox);
  check('B2: http 返回 Promise（异步腿，调用方 await）', isThenable(httpVal), typeof httpVal);

  // §C 真并行：两次不同延迟的请求，in-flight 峰值 ≥ 2
  section('C. 真并行：同步桥下物理上不可能，假绿过不了这节');
  const ctxC = makeSandbox({ asyncCap: true, delays: { 'https://slow.example/a': 120, 'https://fast.example/b': 10 } });
  const t0 = Date.now();
  const [c1, c2] = await Promise.all([
    ctxC.awaitEval("Network.fetchBytes('GET', 'https://slow.example/a', {}, null)"),
    ctxC.awaitEval("Network.fetchBytes('GET', 'https://fast.example/b', {}, null)"),
  ]);
  check('C1: 两个请求都 settle', c1.done && !c1.error && c2.done && !c2.error, (c1.error || c2.error || ''));
  check('C2: in-flight 峰值 = 2（真并发）', ctxC.state.maxInFlight === 2, String(ctxC.state.maxInFlight));
  check('C3: 快请求不被慢请求阻塞（~10ms 完成，不等满 120ms）',
    c2.done && (c2.finishedAt - t0) < 100, 'fast finished at ' + (c2.finishedAt - t0) + 'ms');
  check('C4: 慢请求确实等到了自己的延迟（时序真实）',
    c1.done && (c1.finishedAt - t0) >= 110, 'slow finished at ' + (c1.finishedAt - t0) + 'ms');
  check('C5: 各 promise 收到自己的信封（cbId 一一对应）',
    ktDecodeUtf8(c1.value.body) === 'ok:__http_cb_0' &&
    ktDecodeUtf8(c2.value.body) === 'ok:__http_cb_1',
    ktDecodeUtf8(c1.value.body) + ' / ' + ktDecodeUtf8(c2.value.body));

  // §D 反向对照：无异步能力 → 回退同步路径（老宿主/旧台子行为不变）
  section('D. 反向对照：能力探测失败 → 同步回退（源侧契约不变）');
  const ctxD = makeSandbox({
    asyncCap: false,
    syncHttp: () => JSON.stringify({ status: 200, error: null, headers: {}, body: ktBase64Encode(Buffer.from('sync-ok')) }),
  });
  check('D1: 无能力时不发 __http_async', ctxD.state.asyncMessages.length === 0, '');
  const d = await ctxD.awaitEval("Network.fetchBytes('GET', 'https://api.example/z', {}, null)");
  check('D2: fetchBytes 仍经同步 http 分支 settle',
    d.done && !d.error && ctxD.state.syncHttpMessages === 1 && ktDecodeUtf8(d.value.body) === 'sync-ok',
    (d.error || '') + ' sync=' + ctxD.state.syncHttpMessages);

  // §E 异步错误信封 → fetchBytes 抛错 → 调用链 rejected
  section('E. 异步腿的错误传播：{error} 信封必须变成调用链 rejection');
  const ctxE = makeSandbox({
    asyncCap: true,
    respond: () => ktBase64Encode(JSON.stringify({ status: null, error: 'network dead', headers: {}, body: null })),
  });
  const e = await ctxE.awaitEval("Network.fetchBytes('GET', 'https://dead.example/x', {}, null)");
  check('E1: 链路 rejected 且带错误文本', e.done && /network dead/.test(e.error || ''), e.error);

  // §F 迟到/未知 cbId 的投递被安全忽略
  section('F. 健壮性：未知 cbId 的投递不炸 realm');
  let survived = true;
  try {
    vm.runInContext("globalThis.__httpDeliver('__http_cb_nope', 'e30=')", ctxA.sandbox);
  } catch (err) { survived = false; }
  check('F1: 未知 cbId 投递被忽略', survived, '');

  // §G 异步 delay：不钉 JS 线程 + init.js 的 setTimeout 真的会「晚点响」
  section('G. 异步 delay（__delay_async）：源侧定时器/重试不再冻结整个引擎');
  const ctxG = makeSandbox({ asyncCap: true, delays: {} });
  const g0 = Date.now();
  const delayPromise = vm.runInContext("sendMessage({ method: 'delay', time: 150 })", ctxG.sandbox);
  check('G1: 有能力时 delay 经 __delay_async（异步腿）',
    ctxG.state.delayAsyncMessages.length === 1 && ctxG.state.delayAsyncMessages[0].time === 150,
    JSON.stringify(ctxG.state.delayAsyncMessages));
  check('G2: delay 返回真 pending Promise（非 SYNC_METHODS 的裸值路径）', isThenable(delayPromise), typeof delayPromise);
  const probeAt = Date.now() - g0;
  check('G3: delay 挂起期间 JS 线程未被钉住（紧跟的同步求值立即完成）', probeAt < 80, 'probe at ' + probeAt + 'ms');
  const gv = await ctxG.awaitEval("'eval-ok'");
  check('G4: 挂起期间其他求值可正常进行', gv.done && gv.value === 'eval-ok', gv.error);
  const delayVal = await new Promise((r) => delayPromise.then(r, (e) => r('REJECTED:' + e)));
  const delayElapsed = Date.now() - g0;
  check('G5: delay 兑现（空信封 resolve，等待 ≥ 150ms）',
    delayElapsed >= 140 && (delayVal === '' || delayVal === undefined),
    'value=' + String(delayVal) + ' elapsed=' + delayElapsed + 'ms');
  const gt = await ctxG.awaitEval("new Promise((res) => { setTimeout(() => res('timer-fired'), 40); })");
  check('G6: init.js 的 setTimeout（建立在 delay 桥上）经异步腿触发',
    gt.done && gt.value === 'timer-fired', (gt.error || JSON.stringify(gt.value)));

  // §H 反向对照：无异步能力 → delay 退回同步路径（真阻塞，老宿主行为不变）
  section('H. 反向对照：能力缺失 → delay 同步回退（阻塞语义可被本台子观测）');
  const ctxH = makeSandbox({ asyncCap: false, delays: {} });
  const h0 = Date.now();
  const hVal = vm.runInContext("sendMessage({ method: 'delay', time: 120 })", ctxH.sandbox);
  const hBlock = Date.now() - h0;
  check('H1: 同步回退真实阻塞调用（≥ 110ms）——证明 G3 的「不阻塞」不是台子失真',
    hBlock >= 110 && !isThenable(hVal), 'blocked ' + hBlock + 'ms, thenable=' + isThenable(hVal));
  check('H2: 同步回退未触碰 __delay_async', ctxH.state.delayAsyncMessages.length === 0, '');

  console.log('\n' + (fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`) + `  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('RIG ERROR', e); process.exit(1); });
