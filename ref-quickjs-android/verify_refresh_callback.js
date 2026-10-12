// Verifies the full 刷新域名列表 (refreshDomains callback) path against the REAL jm.js.
//
// Hypothesis under test:
//   The callback (`() => this.refreshApiDomains(true)`) DOES reach its last step, but that step is
//   `UI.showDialog(...)`, and our dispatcher returns `null` for `method: "UI"`. Because
//   `SendMessage` in init.js awaits the bridge, a resolved `null` is fine *mechanically* — but the
//   dialog never appears, so the button looks dead even though the work was done.
//
//   Additionally, we need to confirm the `sendMessage` shim + slot-polling pump can actually drive
//   the async chain to completion, including the nested `await fetch(...)` -> `res.text()`.
//
// We simulate:
//   - a Promise-returning sendMessage (our BRIDGE_SHIM)
//   - a `fetch` that returns a Response-like object (our `http` dispatch)
//   - a pump loop that re-enters evaluation to drain jobs (our evalAwaiting)

const fs = require('fs');

const path = require('path');
const jmSource = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');

// --- Simulate the bridge ------------------------------------------------------
const sent = [];

class FakeResponse {
  constructor(body, status = 200) {
    this._body = body;
    this.status = status;
    this.ok = status >= 200 && status < 300;
  }
  async text() {
    return this._body;
  }
  async json() {
    return JSON.parse(this._body);
  }
}

// Mirrors JsMessageDispatcher.dispatch(), including the fact that "UI" -> null.
function dispatch(msg) {
  sent.push(msg);
  switch (msg.method) {
    case 'log':
      return null;
    case 'http': {
      // Pretend the domain-list endpoint is unreachable so the fallback branch runs — that is the
      // path jm.js takes in CN, and it still ends in UI.showDialog.
      const err = new Error('simulated network failure');
      err.__httpError = true;
      throw err;
    }
    default:
      return null; // <-- "UI", "convert", ... all currently return null
  }
}

// --- The shim (mirrors JsEngine.BRIDGE_SHIM) ---------------------------------
globalThis.__sendMessageSync = (msg) => dispatch(msg);
globalThis.sendMessage = function (msg) {
  try {
    return Promise.resolve(__sendMessageSync(msg));
  } catch (e) {
    return Promise.reject(e);
  }
};
let _fetchFails = true;
globalThis.fetch = async (url, opts) => {
  if (_fetchFails) throw new Error('ECONNREFUSED ' + url);
  return new FakeResponse('{"Server":["a","b"]}');
};

// init.js defines the whole Network/Html/Convert/UI layer on top of sendMessage. We only need the
// pieces jm.js touches: convertData (Convert), UI.showDialog, and the baseHeaders/State helpers.
// Load the real file so we exercise the real definitions.
const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

// init.js uses `var`/`let` at top level; run it in a sandbox-ish way by indirect eval.
const vm = require('vm');
const sandbox = {
  console,
  sendMessage: globalThis.sendMessage,
  __sendMessageSync: globalThis.__sendMessageSync,
  fetch: globalThis.fetch,
  Promise,
  JSON,
  Math,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  Map,
  Set,
  Uint8Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout,
  clearTimeout,
  globalThis: null,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(initJs, sandbox, { filename: 'init.js' });
  console.log('init.js loaded OK');
} catch (e) {
  console.log('init.js failed to load:', e.message);
}

// --- Load jm.js and instantiate it -------------------------------------------
vm.runInContext(
  `(() => { ${jmSource}\n; globalThis.__src = new JM(); }).call(globalThis);`,
  sandbox,
  { filename: 'jm.js' },
);
const src = sandbox.__src;
// Registration is performed by JsSourceManager.register() on the Kotlin side:
//   ComicSource.sources['<key>'] = this['__temp'];
// We mirror that here so the callback can address the source by key.
vm.runInContext("ComicSource.sources[globalThis.__src.key] = globalThis.__src;", sandbox);
console.log('source name/key:', src.name, '/', src.key);

// --- Drive the callback through the pump loop --------------------------------
// Mirrors evalAwaiting: kick off the expression, then re-enter evaluation to drain jobs.
(async () => {
  sandbox.__slot = { done: false, value: undefined, error: undefined };
  vm.runInContext(
    `Promise.resolve(ComicSource.sources[globalThis.__src.key].settings.refreshDomains.callback()).then(
       v => { globalThis.__slot.done = true; globalThis.__slot.value = String(v); },
       e => { globalThis.__slot.done = true; globalThis.__slot.error = String(e && e.message || e); }
     );`,
    sandbox,
  );

  // Pump: each macrotask boundary lets pending microtasks run.
  for (let i = 0; i < 64; i++) {
    if (sandbox.__slot.done) break;
    await new Promise((r) => setImmediate(r));
  }

  console.log('\nslot settled:', sandbox.__slot.done);
  console.log('slot error :', sandbox.__slot.error);
  console.log('slot value :', sandbox.__slot.value);

  console.log('\n--- messages the JS side sent to the bridge (first 12) ---');
  for (const m of sent.slice(0, 12)) {
    console.log(
      `  method=${m.method}` +
        (m.function ? ` function=${m.function}` : '') +
        (m.title ? ` title=${JSON.stringify(m.title)}` : '') +
        (m.content ? ` content=${JSON.stringify(String(m.content).slice(0, 60))}...` : ''),
    );
  }
  console.log(`  ... total ${sent.length} messages`);

  const uiMsgs = sent.filter((m) => m.method === 'UI');
  console.log('\nUI messages:', uiMsgs.length, uiMsgs.map((m) => m.function));
  if (uiMsgs.length) {
    const d = uiMsgs.find((m) => m.function === 'showDialog');
    if (d) {
      console.log('showDialog title  :', d.title);
      console.log('showDialog actions:', (d.actions || []).map((a) => a.text));
    }
  }

  console.log('\nCONCLUSION:');
  if (sandbox.__slot.done && uiMsgs.some((m) => m.function === 'showDialog')) {
    console.log('  The callback runs to completion and DOES reach UI.showDialog.');
    console.log('  Our dispatcher returns null for "UI", so no dialog is ever shown.');
    console.log('  => the button looks dead even though the JS work succeeded.');
  } else {
    console.log('  The callback did NOT reach UI.showDialog — see slot error above.');
  }
})();
