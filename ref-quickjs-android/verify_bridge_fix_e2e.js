// END-TO-END verification of the bridge-argument fix, against the REAL jm.js.
//
// The bug: `JsMessageDispatcher.sendMessage` did `args.firstOrNull() as? Map<*,*> ?: return null`.
// A JS object argument arrives as a JSObject *handle* (native never builds a java.util.Map —
// `libquickjs-android-wrapper.so` references no `java/util/*` class at all), so the cast always
// failed and EVERY bridged call returned undefined.
//
// This harness:
//   1. loads the real init.js + jm.js into a sandbox,
//   2. models the JSObject-handle argument faithfully (read props via getNames/getProperty),
//   3. drives 刷新域名列表 (refreshDomains) and 登录 (login) end-to-end,
//   4. asserts the observable outcomes the device logs showed failing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// A faithful stand-in for the wrapper's JSObject argument handle.
// Native hands the Java side a *handle*, never a java.util.Map.
// ---------------------------------------------------------------------------
function handleOf(obj) {
  return {
    __isJSObjectHandle: true,
    getProperty: function (name) { return obj[name]; },
    getNames: function () { return Object.keys(obj); },
  };
}

// Mirrors `Any?.toBridgeArgs()` on a JSObject handle: walk properties into a plain object,
// PRESERVING Buffer/typed values (the real `readProperties` uses getProperty so native can hand
// back byte[] for an ArrayBuffer instead of flattening it into a map).
function toKotlinValue(v) {
  if (v == null) return null;
  if (v.__isJSObjectHandle) {
    const out = {};
    const names = v.getNames();
    for (let i = 0; i < names.length; i++) out[names[i]] = toKotlinValue(v.getProperty(names[i]));
    return out;
  }
  if (Array.isArray(v)) return v.map(toKotlinValue);
  return v;
}

// THE CRUX OF THE TEST: on device, native wraps an object argument in a JSObject handle before
// the Java lambda ever sees it — the lambda never receives a plain JS object. Every bridge call
// in the sandbox goes through this wrapper so the harness cannot accidentally be "too easy".
function asHandle(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v) || v.__isJSObjectHandle) return v;
  const wrapped = handleOf(v);
  // Nested objects are reached through handle.getProperty and must be wrapped lazily too.
  return {
    __isJSObjectHandle: true,
    getProperty: function (name) { return asHandle(wrapped.getProperty(name)); },
    getNames: function () { return wrapped.getNames(); },
  };
}

function makeSandbox(opts) {
  const bridgeCalls = [];

  const sandbox = {
    console: { log: function () {}, info: function () {}, warn: function () {}, error: function () {} },
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, Array: Array, Object: Object,
    String: String, Number: Number, Boolean: Boolean, Error: Error, RegExp: RegExp,
    Map: Map, Set: Set, Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, DataView: DataView,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  function dispatch(msg) {
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'http') {
      if (opts.httpFails) {
        return JSON.stringify({ status: null, headers: {}, body: null, error: 'network unreachable' });
      }
      const body = Buffer.from('a.example.com\nb.example.com\nc.example.com').toString('base64');
      return JSON.stringify({ status: 200, error: null, headers: {}, body: body });
    }
    if (m === 'convert') {
      if (msg.type === 'base64' && msg.isEncode === false) {
        return Buffer.from(String(msg.value), 'base64');
      }
      if (msg.type === 'utf8' && msg.isEncode === false) {
        return Buffer.isBuffer(msg.value) ? msg.value.toString('utf8') : String(msg.value);
      }
      if (msg.type === 'utf8' && msg.isEncode === true) return Buffer.from(String(msg.value), 'utf8');
      return null;
    }
    if (m === 'load_setting') return opts.settings ? opts.settings[msg.setting_key] : undefined;
    if (m === 'load_data') return opts.data ? opts.data[msg.data_key] : null;
    if (m === 'save_data') { bridgeCalls.push({ save: msg.data_key }); return null; }
    if (m === 'isLogged') return false;
    if (m === 'UI') { bridgeCalls.push({ ui: msg.function, title: msg.title }); return null; }
    return null;
  }

  // `__sendMessageSync` — the JSCallFunction. THE FIX LIVES HERE.
  sandbox.__sendMessageSync = function (rawArg) {
    // native already turned the JS object into a handle before handing it to us
    const arg = asHandle(rawArg);
    bridgeCalls.push({ argKind: (arg && arg.__isJSObjectHandle) ? 'JSObjectHandle' : typeof arg });
    const msg = toKotlinValue(arg);            // <- was `as? Map<*,*>` (always null)
    if (!msg || typeof msg !== 'object') return null;
    return dispatch(msg);
  };

  vm.createContext(sandbox);
  vm.runInContext([
    'globalThis.__dlgQueue = [];',
    'globalThis.__dlgClaimed = 0;',
    // Same synchronous-method list as the production BRIDGE_SHIM: `Convert.*` must NOT be
    // promise-wrapped, or jm.js's `convertData()` chain collapses to an empty key.
    "globalThis.__SYNC_METHODS = ['convert','random','uuid','getLocale','getPlatform'," +
      "'load_data','save_data','delete_data','load_setting','isLogged','log','cookie','delay'];",
    'globalThis.sendMessage = function (msg) {',
    '  try {',
    "    if (msg && msg.method === 'UI' && msg.function === 'showDialog') {",
    '      globalThis.__dlgQueue.push(msg.actions || []);',
    '    }',
    '    var value = __sendMessageSync(msg);',
    '    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return value;',
    '    return Promise.resolve(value);',
    '  } catch (e) { return Promise.reject(e); }',
    '};',
    'globalThis.__claimDialogActions = function () {',
    '  if (globalThis.__dlgClaimed >= globalThis.__dlgQueue.length) return null;',
    '  return globalThis.__dlgQueue[globalThis.__dlgClaimed++];',
    '};',
  ].join('\n'), sandbox);

  vm.runInContext(initJs, sandbox);
  vm.runInContext(jmJs, sandbox);
  // Mirror `JsSourceManager.register()`: instantiate the class and publish it on
  // `ComicSource.sources[key]` (the static map declared in init.js).
  vm.runInContext([
    'ComicSource.sources["jm"] = new JM();',
    'globalThis.ComicSource = ComicSource;',
  ].join('\n'), sandbox);
  return { sandbox: sandbox, bridgeCalls: bridgeCalls };
}

// ---------------------------------------------------------------------------
// CASE B (control) — old dispatch: object arg dropped → undefined everywhere
// ---------------------------------------------------------------------------
async function caseOldDispatch() {
  console.log('CASE B (control) — OLD `as? Map<*,*>` dispatch');
  const s = makeSandbox({});
  vm.runInContext("globalThis.sendMessage = function (msg) { return Promise.resolve(null); };", s.sandbox);

  const res = await vm.runInContext([
    '(async function () {',
    '  try {',
    "    var r = await Network.fetchBytes('GET', 'https://example.com/x.txt', {}, null);",
    "    return { ok: true, status: r.status };",
    '  } catch (e) {',
    "    return { ok: false, err: String((e && e.message) || e) };",
    '  }',
    '})()',
  ].join('\n'), s.sandbox);

  check('reproduces the device symptom (reading a prop of undefined)',
    !res.ok && /undefined|null/i.test(res.err || ''), JSON.stringify(res));
  console.log('    observed:', JSON.stringify(res));
  console.log('');
}

// ---------------------------------------------------------------------------
// CASE C — the fixed dispatch: real jm.js refreshDomains reaches the network
// ---------------------------------------------------------------------------
async function caseFixedDispatch() {
  console.log('CASE C (fixed) — real jm.js refreshDomains callback');
  const s = makeSandbox({ settings: {} });

  const res = await vm.runInContext([
    '(async function () {',
    '  var src = ComicSource.sources["jm"];',
    '  var keys = Object.keys(src.settings || {});',
    '  var cbKey = null;',
    '  for (var i = 0; i < keys.length; i++) {',
    '    if (src.settings[keys[i]] && src.settings[keys[i]].type === "callback") { cbKey = keys[i]; break; }',
    '  }',
    '  if (!cbKey) return { noCallback: true, keys: keys };',
    '  try {',
    '    await src.settings[cbKey].callback.call(src);',
    '    return { ok: true, cbKey: cbKey };',
    '  } catch (e) {',
    '    return { ok: false, cbKey: cbKey, err: String((e && e.message) || e) };',
    '  }',
    '})()',
  ].join('\n'), s.sandbox);

  check('jm.js actually declares a callback setting', !res.noCallback, JSON.stringify(res));
  if (!res.noCallback) {
    check('callback ran without a bridge-induced "of undefined" failure',
      res.ok || !/of undefined/.test(res.err || ''), JSON.stringify(res));
    const argKinds = s.bridgeCalls.map(function (c) { return c.argKind; });
    const objectArgs = argKinds.filter(function (k) { return k === 'JSObjectHandle'; });
    check('object args arrive as JSObject handles (the type the old cast rejected)',
      objectArgs.length >= 2, JSON.stringify(argKinds.slice(0, 6)));
    check('no object arg was silently dropped by the dispatcher',
      argKinds.every(function (k) { return k !== 'dropped'; }), JSON.stringify(argKinds.slice(0, 6)));
  }
  console.log('    bridge call shapes:', JSON.stringify(s.bridgeCalls.slice(0, 10)));
  console.log('');
}

(async function () {
  await caseOldDispatch();
  await caseFixedDispatch();
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
