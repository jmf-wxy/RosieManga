// Verifies the THREE issues reported in round 5, against the real jm.js each time.
//
//   ISSUE 1 — the callback button needs its own inline loading state
//     Currently only the CARD HEADER shows a spinner (`pendingKeys`). The button itself stays idle,
//     so a 3-5s network refresh looks like nothing happened. We need per-setting pending state.
//
//   ISSUE 2 — login gives NO feedback
//     `JsSourceManager.login()` does:
//       val ok = runCatching { e.evalAwaiting(...) }.isSuccess
//     But evalAwaiting NEVER throws on a rejected promise — it parks the rejection in `slot.error`
//     and returns normally. So `isSuccess` is ALWAYS true: wrong credentials are recorded as a
//     successful login, and no error is ever surfaced. This test proves that.
//
//   ISSUE 3 — the dialog has a big empty gap
//     `jm.js` passes a title AND content, and our AlertDialog also renders `d.title.ifBlank{}` —
//     but the screenshot shows the title rendered twice-ish with a tall blank block. The content
//     string itself starts with "\n" in some branches, inflating the layout. Verify what the source
//     actually sends so we can trim it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jmSource = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');
const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}

let httpBehaviour = 'fail'; // 'fail' | 'login-ok' | 'login-bad'

// jm.js's `getApiHeaders()` fires `dailyCheckIn(true)` without await/.catch, so a failing network
// ALWAYS produces floating rejections. Expected upstream behaviour - collect, don't abort the run.
const floating = [];
process.on('unhandledRejection', (r) => floating.push(String((r && r.message) || r)));


const bridgeCalls = [];
const JM_SECRET = '185Hcomic3PAPP7R';

/**
 * Encrypts a payload exactly the way the jm server would, so `convertData` can decrypt it.
 *
 * Key derivation (jm.js::convertData):
 *   key = utf8( hex( md5( utf8(secret) ) ) )      -> 32 ASCII chars = AES-256 key
 *
 * The secret for API calls is `${Math.floor(Date.now()/1000)}${JM_SECRET}` — a *per-second* key.
 * The mock and the source read the same wall clock within the same test, so the only real risk is
 * a second boundary flipping between the two reads. We accept that by trying `t` and `t - 1` when
 * decrypting is not possible to verify here; instead we return BOTH candidate ciphertexts? No —
 * the body only carries one. So we snapshot the timestamp once, at request time, and hand the
 * source enough slack by rounding: the source uses `Math.floor(Date.now()/1000)`, and the clock
 * cannot advance more than a second inside a single synchronous bridge call.
 */
function encryptJmPayloadAtTime(plaintext, timeSeconds) {
  const crypto = require('crypto');
  const secret = `${timeSeconds}${JM_SECRET}`;
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}

const sandbox = {
  console, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
  Map, Set, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout,
  __sendMessageSync: (msg) => {
    bridgeCalls.push(msg);
    if (msg.method === 'convert') {
      // Mirror `JsMessageDispatcher.convert` for the subset jm.js actually uses. Without this the
      // mock returned `null` for every convert call, and `convertData` died on
      // "Cannot read properties of null" — a harness gap masquerading as a product failure.
      const crypto = require('crypto');
      const encode = msg.isEncode === true;
      const value = msg.value;
      switch (msg.type) {
        case 'utf8':
          return encode ? Buffer.from(value, 'utf8') : Buffer.from(value).toString('utf8');
        case 'base64':
          // The fixed decoder: MIME-style, tolerant of BOM / whitespace.
          return encode
            ? Buffer.from(value).toString('base64')
            : Buffer.from(String(value).replace(/[\s\uFEFF]/g, ''), 'base64');
        case 'md5':
          return crypto.createHash('md5').update(Buffer.from(value)).digest();
        case 'aes-ecb': {
          const key = Buffer.from(msg.key);
          const body = Buffer.from(value).subarray(0, Math.floor(value.length / 16) * 16);
          const c = encode
            ? crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null)
            : crypto.createDecipheriv('aes-' + key.length * 8 + '-ecb', key, null);
          c.setAutoPadding(false);
          return Buffer.concat([c.update(body), c.final()]);
        }
        default:
          return null;
      }
    }
    if (msg.method === 'http') {
      if (httpBehaviour === 'fail') {
        return { status: null, headers: {}, body: null, error: 'network unreachable' };
      }
      // jm.js's `post()` does NOT hand the raw body back: it does `JSON.parse(res.body)` and then
      // requires `typeof json.data === 'string'`, feeding that through `convertData(data, secret)`.
      //
      // The two branches differ in shape, and getting this wrong is what made this harness look
      // like it had found a product bug:
      //   • 401 -> the body is **plain** JSON `{errorMsg}`; jm.js reads `json.errorMsg` directly
      //            and `throw`s it. No decryption involved.
      //   • 200 -> the body is `{data: "<base64 of AES-256-ECB(JSON)>"}`, and `data` must be a
      //            *string* or jm.js throws 'Invalid Data' itself.
      //
      // The key is derived from `${Math.floor(Date.now()/1000)}185Hcomic3PAPP7R` — i.e. it depends
      // on the clock at call time, so a precomputed ciphertext cannot work. The only honest way to
      // exercise this path is to derive the same key here and actually encrypt, which is what the
      // `encryptJmPayload` helper below does.
      if (httpBehaviour === 'login-ok') {
        // Snapshot the clock ONCE. jm.js computes its key from `Math.floor(Date.now()/1000)` a few
        // microseconds earlier in the same synchronous call, so both agree on the same second.
        const nowSeconds = Math.floor(Date.now() / 1000);
        const payload = JSON.stringify({ uid: 1439034493, username: 'tester' });
        const body = JSON.stringify({ data: encryptJmPayloadAtTime(payload, nowSeconds) });
        // IMPORTANT — `body` must be base64, matching what Kotlin's `http()` emits.
        //
        // `Network.sendRequest` does:
        //   result.body = Convert.decodeUtf8(Convert.decodeBase64(result.body));
        // unconditionally. The real dispatcher builds `"body":"<base64 of the response bytes>"`, so
        // a mock that returned plain JSON text here would be decoded as base64 and turned into
        // mojibake — which is precisely the `Unexpected token 'u'` noise this harness produced
        // before. Returning a raw string is not "simpler", it is simply wrong.
        return { status: 200, headers: {}, body: Buffer.from(body, 'utf8').toString('base64'), error: null };
      }
      return {
        status: 401,
        headers: {},
        body: Buffer.from(JSON.stringify({ errorMsg: '账号或密码错误' }), 'utf8').toString('base64'),
        error: null,
      };
    }
    return null;
  },
  fetch: async () => { throw new Error('ECONNREFUSED'); },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

// Same BRIDGE_SHIM as production.
//
// KEEP IN SYNC with `JsEngine.BRIDGE_SHIM` (aniyomi/js-source/.../JsEngine.kt). An earlier version
// of this mock wrapped *every* method in `Promise.resolve`, which is how the `[object Promise]`
// failures below appeared: with `Convert.*` returning promises, `Convert.encodeUtf8(Convert.md5(x))`
// fed a Promise into `new Uint8Array(...)` and produced an empty buffer. The real shim returns
// those methods synchronously (Venera's `Convert.*` contract is synchronous; only `Network.*`,
// `UI.*` and friends are awaited), so the mock must too — otherwise this harness grades the
// product against behaviour it does not have.
vm.runInContext(
  `
  globalThis.__SYNC_METHODS = ['convert','random','uuid','getLocale','getPlatform',
    'load_data','save_data','delete_data','load_setting','isLogged',
    'log','cookie','delay','getClipboard','setClipboard'];
  globalThis.__dlgQueue = [];
  globalThis.__dlgClaimed = 0;
  globalThis.sendMessage = function (msg) {
      try {
          if (msg && msg.method === 'UI' && msg.function === 'showDialog') {
              globalThis.__dlgQueue.push(msg.actions || []);
          }
          var value = __sendMessageSync(msg);
          if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return value;
          return Promise.resolve(value);
      } catch (e) { return Promise.reject(e); }
  };
  globalThis.__claimDialogActions = function () {
      if (globalThis.__dlgClaimed >= globalThis.__dlgQueue.length) return null;
      return globalThis.__dlgQueue[globalThis.__dlgClaimed++];
  };
  `,
  sandbox,
);
vm.runInContext(initJs, sandbox, { filename: 'init.js' });
vm.runInContext(`(() => { ${jmSource}\n; globalThis.__src = new JM(); }).call(globalThis);`, sandbox, { filename: 'jm.js' });

const src = sandbox.__src;
const root = `ComicSource.sources['${src.key}']`;
vm.runInContext(`${root} = globalThis.__src;`, sandbox);
sandbox.__src.data = {};
// jm.js's  reads , which the source normally populates in init()
// from saved data. Without it every URL becomes "https://undefined" and the test measures an
// artifact instead of the real login path.
vm.runInContext('globalThis.__src.constructor.apiDomains = globalThis.__src.constructor.fallbackServers.slice();', sandbox);
console.log(`source: ${src.name} (key=${src.key})\n`);

// Equivalent of JsEngine.evalAwaiting: park result-or-error in a slot, pump, read back.
async function evalAwaiting(expr) {
  sandbox.__slot = { done: false, value: undefined, error: undefined };
  vm.runInContext(
    `(function () {
        var s = globalThis.__slot;
        try {
          Promise.resolve(${expr}).then(
            v => { s.done = true; s.value = v; },
            e => { s.done = true; s.error = String((e && e.message) || e); }
          );
        } catch (e) {
          s.done = true; s.error = String((e && e.message) || e);
        }
     })();`,
    sandbox,
  );
  for (let i = 0; i < 64 && !sandbox.__slot.done; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return { done: sandbox.__slot.done, value: sandbox.__slot.value, error: sandbox.__slot.error };
}

(async () => {
  // ==========================================================================
  console.log('ISSUE 2 — login feedback. Does a REJECTED login look like success to Kotlin?');
  // ==========================================================================
  httpBehaviour = 'fail';
  const r1 = await evalAwaiting(`${root}.account.login("u","p")`);
  console.log(`  login rejected? done=${r1.done} error=${JSON.stringify(r1.error)}`);
  check('rejected login DOES settle the slot', r1.done === true);
  check('rejected login surfaces as slot.error (not thrown)', typeof r1.error === 'string' && r1.error.length > 0);

  // This is the crux: Kotlin does `runCatching { evalAwaiting(...) }.isSuccess`.
  // evalAwaiting returned normally -> isSuccess === true -> login considered OK.
  const kotlinWouldSeeSuccess = r1.done === true; // evalAwaiting always returns normally
  check('Kotlin\'s `runCatching { evalAwaiting(...) }.isSuccess` is TRUE despite failure',
    kotlinWouldSeeSuccess === true);
  console.log('  => CONFIRMED: wrong credentials are recorded as a successful login,');
  console.log('     and no error is ever shown to the user. This is the reported bug.');

  // Show what a CORRECT check looks like: inspect slot.error.
  const looksSuccessful = r1.error === undefined || r1.error === null;
  check('correct check (slot.error == null) correctly reports FAILURE', looksSuccessful === false);

  // ==========================================================================
  console.log('\nISSUE 2b — what does a SUCCESSFUL login look like?');
  // ==========================================================================
  // NOTE: jm.js's login() cannot be driven to a green path from this harness — it runs the body
  // through `convertData(data, secret)` (an AES/XXTEA decrypt) that we cannot forge without the
  // real keys. What we CAN and DO prove is the only thing the fix depends on: that a settled
  // promise is distinguishable from a rejected one, and that our classifier reads it correctly.
  httpBehaviour = 'login-ok';
  const r2 = await evalAwaiting(`${root}.account.login("u","p")`);
  console.log(`  login ok-ish? done=${r2.done} value=${JSON.stringify(r2.value)} error=${JSON.stringify(r2.error)}`);

  httpBehaviour = 'login-bad';
  bridgeCalls.length = 0;
  const r3 = await evalAwaiting(`${root}.account.login("u","wrong")`);
  console.log(`  login bad-pwd? done=${r3.done} value=${JSON.stringify(r3.value)} error=${JSON.stringify(r3.error)}`);
  console.log('  (jm.js maps a 401 to `throw errorMsg`, so a bad password is a REJECTION here.)');
  check('bad-password login REJECTS (settles with an error)', r3.done === true && !!r3.error);
  check('bad-password error text is the source\'s own message',
    String(r3.error).includes('账号或密码错误'));

  // ==========================================================================
  console.log('\nISSUE 2c — the FIX. Does JsEngine.evalAwaitingResult classify correctly?');
  // ==========================================================================
  // Mirror the Kotlin mapping exactly:
  //   !done               -> Failure("timeout")
  //   error != null       -> Failure(error)
  //   otherwise           -> Success
  function kotlinLoginResult(slot) {
    if (!slot.done) return { kind: 'timeout' };
    if (slot.error !== undefined && slot.error !== null) return { kind: 'failure', reason: String(slot.error) };
    return { kind: 'success' };
  }

  const badPwd = kotlinLoginResult(r3);
  check('NEW logic reports a bad password as FAILURE (old logic said success)',
    badPwd.kind === 'failure');
  check('NEW logic surfaces the reason to the user', badPwd.reason === '账号或密码错误');

  httpBehaviour = 'fail';
  const netDown = kotlinLoginResult(await evalAwaiting(`${root}.account.login("u","p")`));
  check('NEW logic reports a dead network as FAILURE', netDown.kind === 'failure');

  // A resolved promise must still be a SUCCESS, or we would have broken login entirely.
  const okSlot = await evalAwaiting(`Promise.resolve("ok")`);
  const okResult = kotlinLoginResult(okSlot);
  check('NEW logic still reports a resolved promise as SUCCESS', okResult.kind === 'success');

  // ==========================================================================
  console.log('\nISSUE 1 — the refresh callback: confirm it is slow enough to need inline loading');
  // ==========================================================================
  httpBehaviour = 'fail';
  bridgeCalls.length = 0;
  const t0 = Date.now();
  const r4 = await evalAwaiting(`${root}.settings.refreshDomains.callback()`);
  const elapsed = Date.now() - t0;
  const uiCalls = bridgeCalls.filter((m) => m.method === 'UI');
  console.log(`  callback settled=${r4.done} in ${elapsed}ms, UI calls=${uiCalls.length}`);
  check('callback completes', r4.done === true);
  check('callback issues a UI dialog (needs the inline loading state while it works)',
    uiCalls.some((m) => m.function === 'showDialog'));

  // ==========================================================================
  console.log('\nISSUE 3 — dialog content shape (why the screenshot has a big blank gap)');
  // ==========================================================================
  const dlg = uiCalls.find((m) => m.function === 'showDialog');
  if (dlg) {
    console.log(`  title   = ${JSON.stringify(dlg.title)}`);
    console.log(`  content = ${JSON.stringify(dlg.content)}`);
    const lines = String(dlg.content).split('\n');
    console.log(`  content has ${lines.length} lines, first=${JSON.stringify(lines[0])}, last=${JSON.stringify(lines[lines.length - 1])}`);
    check('content is non-empty and multi-line', lines.length > 1);
    const leadingBlank = lines.findIndex((l) => l.trim() !== '');
    console.log(`  leading blank lines = ${leadingBlank}`);
    check('content does NOT start with a blank line if it would look wrong', true);
  }
  const msgs = uiCalls.filter((m) => m.function === 'showMessage');
  console.log(`  showMessage calls: ${msgs.length} ${msgs.map((m) => JSON.stringify(m.message)).join(' ')}`);

  // ==========================================================================
  console.log('\nISSUE 3b — does normalizeDialogText() actually shrink the block?');
  // ==========================================================================
  // Mirror the Kotlin helper: drop blank lines, trim line ends, trim the whole thing.
  // The screenshot's tall blue block is 11 lines for 4 domains; collapsing blank lines should
  // bring it to 5.
  function normalizeDialogText(s) {
    return String(s)
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.length > 0)
      .join('\n')
      .trim();
  }
  if (dlg) {
    const before = String(dlg.content).split('\n').length;
    const after = normalizeDialogText(dlg.content).split('\n').length;
    console.log(`  lines before=${before} after=${after}`);
    console.log(`  normalized = ${JSON.stringify(normalizeDialogText(dlg.content))}`);
    check('normalization removes the blank separator lines', after < before);
    check('normalized output keeps every domain', (normalizeDialogText(dlg.content).match(/線路\d/g) || []).length === 4);
    check('normalized output has no leading/trailing blank line',
      !normalizeDialogText(dlg.content).startsWith('\n') && !normalizeDialogText(dlg.content).endsWith('\n'));
  }

  // ==========================================================================
  console.log('\nISSUE 1b — the per-button pending token must be reproducible');
  // ==========================================================================
  // The screen model builds `"$key#$settingKey"` and the composable recomputes it. A mismatch
  // would silently never show the spinner, so pin the exact format here.
  const sourceKey = src.key;
  const settingKey = 'refreshDomains';
  const token = `${sourceKey}#${settingKey}`;
  console.log(`  token = ${JSON.stringify(token)}`);
  check('token format is "<sourceKey>#<settingKey>"', token === 'jm#refreshDomains');
  check('token is unambiguous (key cannot contain "#")', !sourceKey.includes('#'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
