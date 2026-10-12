// VERIFY: what Java type does the wrapper hand a JSCallFunction when JS passes an OBJECT arg?
//
// Evidence from the .so: it references ONLY these class descriptors —
//   java/lang/Boolean, Double, Integer, Long, String, Object, NullPointerException,
//   IllegalArgumentException  +  com/whl/quickjs/wrapper/{JSObject,JSArray,JSFunction,
//   JSCallFunction,QuickJSContext,...}
// There is NO reference to java/util/HashMap or java/util/ArrayList anywhere in the native lib.
//
// => A JS object argument necessarily arrives as a JSObject *handle*, never as java.util.Map.
//    Our dispatcher does `args.firstOrNull() as? Map<*,*> ?: return null`, which therefore
//    always short-circuits to `null` → every bridged call evaluates to `undefined` in JS.
//
// This script models both the BROKEN and the FIXED dispatch on top of that fact, and runs the
// real init.js `Network.fetchBytes` against each, so the symptom ("cannot read property 'error'
// of undefined") is reproduced and then shown to disappear.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

// ---------------------------------------------------------------------------
// Sandbox: `__sendMessageSync` behaves like a real JSCallFunction on device.
// ---------------------------------------------------------------------------
function makeSandbox(argKind) {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  // The Java-side dispatcher, receiving whatever the wrapper would pass.
  sandbox.__sendMessageSync = function (msg) {
    // --- mirror of JsMessageDispatcher.dispatch ---
    const dispatch = (m) => {
      switch (m.method) {
        case 'getLocale': return 'zh_CN';
        case 'http': {
          // HTTP succeeds: the source's domain list is reachable.
          return JSON.stringify({ status: 200, error: null, headers: {}, body: '' });
        }
        default: return null;
      }
    };

    if (argKind === 'broken') {
      // `args.firstOrNull() as? Map<*,*> ?: return null` — a JSObject handle is not a Map.
      const asMap = null; // what `as?` yields for a JSObject
      if (asMap == null) return null;
      return dispatch(asMap);
    }

    // FIXED: the arg is a JSObject *handle*; read its properties instead of casting.
    const asHandle = msg; // JSObject: read props one by one, all on the JS thread
    if (asHandle == null) return null;
    const plain = { method: asHandle.method, url: asHandle.url, http_method: asHandle.http_method };
    return dispatch(plain);
  };
  return sandbox;
}

// ---------------------------------------------------------------------------
function runCase(label, argKind) {
  const sandbox = makeSandbox(argKind);
  vm.createContext(sandbox);
  // Minimal bridge shim identical to production.
  vm.runInContext(`
    globalThis.sendMessage = function (msg) {
      try { return Promise.resolve(__sendMessageSync(msg)); }
      catch (e) { return Promise.reject(e); }
    };
  `, sandbox);
  vm.runInContext(initJs, sandbox);

  const result = vm.runInContext(`
    (async function () {
      try {
        const r = await Network.fetchBytes('GET', 'https://example.com/x.txt', {}, null);
        return 'RESOLVED status=' + r.status;
      } catch (e) {
        return 'REJECTED ' + String((e && e.message) || e);
      }
    })()
  `, sandbox);

  return result;
}

const p1 = runCase('broken', 'broken');
const p2 = runCase('fixed', 'fixed');

Promise.all([p1, p2]).then(([broken, fixed]) => {
  // NB: vm.runInContext returns the Promise synchronously (same realm), so both are real Promises.
  console.log('arg is JSObject handle, dispatcher casts to Map<*,*> (CURRENT):');
  console.log('  ->', broken);
  console.log('');
  console.log('arg is JSObject handle, dispatcher reads props (FIXED):');
  console.log('  ->', fixed);

  let pass = 0;
  let fail = 0;
  const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
  };
  console.log('');
  check('current dispatch rejects with the device symptom',
    /^REJECTED/.test(broken) && /(of undefined|null)/.test(broken), broken);
  check('fixed dispatch reaches the bridge and resolves',
    /^RESOLVED/.test(fixed), fixed);
  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
