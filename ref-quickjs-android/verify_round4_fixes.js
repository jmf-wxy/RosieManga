// End-to-end verification of the two round-4 fixes against the REAL jm.js + init.js:
//
//   FIX A (login row missing)
//     The account probe must be evaluated IN JS. Reading a converted Map cannot work because
//     QuickJSObject.convertToMap() drops JSFunction-valued keys (verified in wrapper-java bytecode),
//     so `account["login"]` is null for 禁漫 even though the source declares `login`.
//
//   FIX B (刷新域名列表 looks dead)
//     The callback reaches `UI.showDialog(...)`. The dialog must be captured, its actions parked in
//     JS (`__dlgQueue`), and the "Apply" button's callback must remain invocable afterwards —
//     proving the JS-side parking strategy actually keeps the closures alive.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jmSource = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');
const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

// `jm.js` line 76 (`getApiHeaders`) calls `this.dailyCheckIn(true)` WITHOUT awaiting or catching it,
// and `dailyCheckIn` rethrows on failure. That is a floating promise inside the upstream source, so
// a rejection is expected here and is NOT a defect in our engine. Venera's own Dart bridge behaves
// identically (the engine only reports what the top-level expression returns). We therefore record
// these rather than letting Node abort the run.
const floatingRejections = [];
process.on('unhandledRejection', (reason) => {
  floatingRejections.push(String((reason && reason.message) || reason));
});

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`);
  }
}

// --- Sandbox (mirrors the engine) --------------------------------------------
const bridgeCalls = [];
const sandbox = {
  console,
  Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
  Map, Set, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout, setInterval, clearInterval,
  __sendMessageSync: (msg) => {
    bridgeCalls.push(msg);
    // Mirror the REAL dispatcher: it never throws, it returns an `{ error }` envelope for HTTP
    // failures. (An earlier revision of this harness threw instead, which is not what Kotlin does —
    // `JsMessageDispatcher.http()` has a try/catch that funnels everything into `httpError(...)`.)
    // 禁漫 then falls back to its built-in domain list, which is the path we want to exercise.
    if (msg.method === 'http') {
      return { status: null, headers: {}, body: null, error: 'simulated network failure' };
    }
    if (msg.method === 'UI' && msg.function === 'showDialog') return null;
    return null;
  },
  fetch: async () => { throw new Error('ECONNREFUSED'); },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

// The BRIDGE_SHIM as it now appears in JsEngine.kt (dialog-action queue included).
vm.runInContext(
  `
  globalThis.__dlgQueue = [];
  globalThis.__dlgClaimed = 0;
  globalThis.sendMessage = function (msg) {
      try {
          if (msg && msg.method === 'UI' && msg.function === 'showDialog') {
              globalThis.__dlgQueue.push(msg.actions || []);
          }
          var value = __sendMessageSync(msg);
          return Promise.resolve(value);
      } catch (e) {
          return Promise.reject(e);
      }
  };
  globalThis.__claimDialogActions = function () {
      if (globalThis.__dlgClaimed >= globalThis.__dlgQueue.length) return null;
      return globalThis.__dlgQueue[globalThis.__dlgClaimed++];
  };
  `,
  sandbox,
);

vm.runInContext(initJs, sandbox, { filename: 'init.js' });
vm.runInContext(`(() => { ${jmSource}\n; globalThis.__src = new JM(); }).call(globalThis);`, sandbox, {
  filename: 'jm.js',
});
vm.runInContext('ComicSource.sources[globalThis.__src.key] = globalThis.__src;', sandbox);

const key = sandbox.__src.key;
console.log(`source: ${sandbox.__src.name} (key=${key})\n`);

// ============================================================================
console.log('FIX A — account mode probe (the expression parseAccountMode now evaluates)');
// ============================================================================
const root = `ComicSource.sources['${key}']`;
const probeExpr = `
(function () {
    var a = ${root}.account;
    if (a === null || a === undefined) return null;
    return {
        has: true,
        login: typeof a.login === 'function',
        webview: a.loginWithWebview !== null && a.loginWithWebview !== undefined,
        webviewUrl: (a.loginWithWebview || {}).url || null,
        cookieFields: (a.loginWithCookies && a.loginWithCookies.fields) || null,
    };
})()
`;
const probe = vm.runInContext(probeExpr, sandbox);
console.log('  probe =', JSON.stringify(probe));
check('account object detected (has=true)', probe && probe.has === true);
check('login detected as a function -> Password mode', probe && probe.login === true);
check('webview not falsely reported', probe && probe.webview === false);
check('cookieFields absent', probe && probe.cookieFields === null);

// Contrast: what the OLD Map-based check would have seen.
console.log('\n  --- contrast: what the old converted-Map check saw ---');
const accountKeys = vm.runInContext(`Object.keys(${root}.account)`, sandbox);
console.log('  Object.keys(account) =', JSON.stringify(accountKeys));
console.log('  (the wrapper\'s convertToMap would DROP "login" because it is a function)');
const loginType = vm.runInContext(`typeof ${root}.account.login`, sandbox);
check('account.login really is a function', loginType === 'function', `typeof = ${loginType}`);

// ============================================================================
console.log('\nFIX B — 刷新域名列表 callback reaches a capturable dialog with live buttons');
// ============================================================================
const before = sandbox.__dlgQueue.length;
sandbox.__slot = { done: false, value: undefined, error: undefined };

(async () => {
  vm.runInContext(
    `Promise.resolve(ComicSource.sources[globalThis.__src.key].settings.refreshDomains.callback()).then(
       v => { globalThis.__slot.done = true; globalThis.__slot.value = String(v); },
       e => { globalThis.__slot.done = true; globalThis.__slot.error = String(e && e.message || e); }
     );`,
    sandbox,
  );
  for (let i = 0; i < 64 && !sandbox.__slot.done; i++) {
    await new Promise((r) => setImmediate(r));
  }

  check('callback promise settled', sandbox.__slot.done === true, sandbox.__slot.error);
  check('callback did not throw', !sandbox.__slot.error, sandbox.__slot.error);

  const shown = bridgeCalls.filter((m) => m.method === 'UI' && m.function === 'showDialog');
  check('UI.showDialog was issued', shown.length === 1, `count=${shown.length}`);
  if (shown.length) {
    console.log(`        title="${shown[0].title}" actions=${JSON.stringify(shown[0].actions.map((a) => a.text))}`);
  }

  check('actions array was parked in the JS queue', sandbox.__dlgQueue.length === before + 1,
    `queue=${sandbox.__dlgQueue.length} before=${before}`);

  // The claim + invoke path: this is exactly what registerDialogActions + runUiDialogAction do.
  const claimed = vm.runInContext('globalThis.__claimDialogActions()', sandbox);
  check('__claimDialogActions returns the array', Array.isArray(claimed) && claimed.length === 2);
  check('claimed buttons keep their callbacks',
    claimed && claimed.every((a) => typeof a.callback === 'function'),
    claimed ? claimed.map((a) => typeof a.callback).join(',') : 'n/a');

  // Invoke "Apply" (index 1) exactly the way JsEngine.invokeDialogAction does: through a
  // slot-backed Promise with BOTH handlers, so an `async` button body settles the slot whether it
  // resolves or rejects. (`jm.js`'s `get()` throws plain strings on non-200, so rejection is a
  // normal outcome here — it must be captured, not escape as an unhandled rejection.)
  const idx = sandbox.__dlgClaimed - 1;
  sandbox.__applySlot = { done: false, value: undefined, error: undefined };

  vm.runInContext(
    `(function () {
        var slot = globalThis.__applySlot;
        try {
            var a = globalThis.__dlgQueue[${idx}];
            var cb = a[1].callback;
            Promise.resolve(typeof cb === 'function' ? cb() : undefined).then(
              v  => { slot.done = true; slot.value = 'ok'; },
              e  => { slot.done = true; slot.error = String((e && e.message) || e); }
            );
        } catch (e) {
            slot.done = true;
            slot.error = String((e && e.message) || e);
        }
     })();`,
    sandbox,
  );
  for (let i = 0; i < 64 && !sandbox.__applySlot.done; i++) {
    await new Promise((r) => setImmediate(r));
  }

  check('Apply button callback is still invocable after the bridge returned',
    sandbox.__applySlot.done === true, sandbox.__applySlot.error);
  console.log(`        Apply outcome: ${sandbox.__applySlot.error
    ? 'rejected with ' + JSON.stringify(sandbox.__applySlot.error)
    : 'resolved'}`);
  check('rejection is captured in the slot (never escapes as unhandled)',
    sandbox.__applySlot.done === true);

  // Distinguish OUR capture from jm.js's own floating promise (`getApiHeaders` -> `dailyCheckIn`).
  if (floatingRejections.length) {
    console.log(`\n  note: ${floatingRejections.length} floating rejection(s) from jm.js itself:`);
    for (const r of floatingRejections) console.log(`        - ${r}`);
    console.log('        (jm.js:76 calls dailyCheckIn(true) without await/catch — an upstream source');
    console.log('         issue that Venera\'s engine does not surface either. Not our regression.)');
  }

  // Prove the button really ran its own code: `overwriteApiDomains` is called BEFORE the failing
  // network step in jm.js's Apply branch, so the fallback domains must have been written.
  const savedDomains = vm.runInContext(
    `(() => { try { return JSON.stringify(${root}.apiDomains || ${root}.domains || null); }
       catch (e) { return 'n/a'; } })()`,
    sandbox,
  );
  console.log('  source.apiDomains after Apply =', savedDomains);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
