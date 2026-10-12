// Reproduces the `cannot read property 'NaN' of undefined` login failure against REAL jm.js.
//
// Root cause: `Convert.*` is a SYNCHRONOUS API.
//   docs/venera-js-api.md:
//     Convert.md5(value: ArrayBuffer): ArrayBuffer      <- NO Promise
//     Network.fetchBytes(...): Promise<{...}>           <- Promise
//   jm.js relies on that: `convertData()` chains
//     Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8(secret))))
//   with NO `await`. In Venera the Dart side answers `Convert` calls synchronously.
//
//   Our BRIDGE_SHIM wraps EVERY method in `Promise.resolve(...)`, so `Convert.md5()` returned a
//   Promise. `new Uint8Array(promise)` -> an empty typed array -> `hexEncode` produced '' and the
//   AES key was garbage, which blew up downstream as "NaN".
//
// This harness runs the same chain two ways and compares.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
}

// The synchronous methods, per the JS API docs (no Promise in their signature).
const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

function makeSandbox(shimMode) {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, ArrayBuffer, DataView, encodeURIComponent, decodeURIComponent,
    parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  function dispatch(msg) {
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'convert') {
      const v = msg.value;
      if (msg.type === 'utf8' && msg.isEncode === true) return Buffer.from(String(v), 'utf8');
      if (msg.type === 'utf8' && !msg.isEncode) return Buffer.from(v).toString('utf8');
      if (msg.type === 'md5') return Buffer.from(require('crypto').createHash('md5').update(v).digest());
      if (msg.type === 'base64' && !msg.isEncode) return Buffer.from(String(v), 'base64');
      if (msg.type === 'base64' && msg.isEncode) return Buffer.from(v).toString('base64');
      if (m && msg.type && msg.type.startsWith('aes')) return Buffer.from(v); // pass-through for this test
      return null;
    }
    if (m === 'load_data') return null;
    if (m === 'load_setting') return null;
    if (m === 'isLogged') return true;
    if (m === 'UI') return null;
    if (m === 'http') {
      return JSON.stringify({ status: 200, error: null, headers: {}, body: Buffer.from('{}').toString('base64') });
    }
    return null;
  }

  sandbox.__sendMessageSync = (msg) => dispatch(msg);
  vm.createContext(sandbox);

  // THE SHIM UNDER TEST.
  if (shimMode === 'all-promise') {
    // current behaviour: everything becomes a Promise
    vm.runInContext(`
      globalThis.sendMessage = function (msg) {
        try { return Promise.resolve(__sendMessageSync(msg)); }
        catch (e) { return Promise.reject(e); }
      };
    `, sandbox);
  } else {
    // fixed: synchronous methods return their value directly (await on a plain value is fine)
    vm.runInContext(`
      var __SYNC = ${JSON.stringify(SYNC_METHODS)};
      globalThis.sendMessage = function (msg) {
        try {
          var v = __sendMessageSync(msg);
          if (msg && __SYNC.indexOf(msg.method) !== -1) return v;
          return Promise.resolve(v);
        } catch (e) { return Promise.reject(e); }
      };
    `, sandbox);
  }

  vm.runInContext(initJs, sandbox);
  vm.runInContext(jmJs, sandbox);
  vm.runInContext('ComicSource.sources["jm"] = new JM(); globalThis.ComicSource = ComicSource;', sandbox);
  return sandbox;
}

console.log('CONVERT CHAIN — `Convert.md5()` used synchronously, as jm.js does');

function runChain(sandbox) {
  return vm.runInContext(`
    (function () {
      try {
        var out = Convert.hexEncode(Convert.md5(Convert.encodeUtf8('secret')));
        return { ok: true, type: typeof out, len: String(out).length, sample: String(out).slice(0, 16) };
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e) };
      }
    })()
  `, sandbox);
}

const broken = runChain(makeSandbox('all-promise'));
console.log('  current (every method -> Promise):', JSON.stringify(broken));
check('reproduces the failure: md5 result is not usable as bytes',
  !broken.ok || broken.len === 0 || /NaN|object/i.test(broken.type),
  JSON.stringify(broken));

const fixed = runChain(makeSandbox('sync-for-convert'));
console.log('  fixed   (Convert.* stays sync):    ', JSON.stringify(fixed));
check('fixed: md5 hex digest is a proper 32-char string',
  fixed.ok && fixed.len === 32 && /^[0-9a-f]{16}$/.test(fixed.sample), JSON.stringify(fixed));

// The actual key jm.js derives for AES
console.log('');
console.log('JM KEY DERIVATION — convertData() must not throw');

function runConvertData(sandbox) {
  return vm.runInContext(`
    (function () {
      var src = ComicSource.sources['jm'];
      try {
        var k = Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8('0123456789abcdef0123456789abcdef'))));
        return { ok: true, keyBytes: k.byteLength !== undefined ? k.byteLength : (k.length !== undefined ? k.length : 'unknown') };
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e) };
      }
    })()
  `, sandbox);
}

const kb = runConvertData(makeSandbox('all-promise'));
const kf = runConvertData(makeSandbox('sync-for-convert'));
console.log('  current:', JSON.stringify(kb));
console.log('  fixed  :', JSON.stringify(kf));
check('fixed: AES key is non-empty bytes (32 hex chars = 32 bytes)',
  kf.ok && kf.keyBytes === 32, JSON.stringify(kf));

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
