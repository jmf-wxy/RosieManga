// END-TO-END login against the REAL jm.js, after the three bridge fixes:
//   1. JS object args arrive as JSObject handles  -> toBridgeArgs() reads them
//   2. containers come back via parseJSON         -> load_data works
//   3. Convert.* is SYNCHRONOUS                   -> convertData() derives a real AES key
//
// The device log before these fixes was:
//   evalAwaitingResult: done error=cannot read property 'NaN' of undefined
//   script=ComicSource.sources["jm"].account.login("1439034493", "...")
//
// This harness reproduces the whole login path and asserts the source now gets far enough to
// report its OWN outcome instead of dying on a bridge-induced undefined.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
}

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

/** The endpoint jm.js's `init()` -> `refreshApiDomains()` fetches to learn its API domains. */
const DOMAIN_LIST_URL = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
const DOMAIN_SERVERS = ['www.cdntwice.org', 'www.cdnsha.org', 'www.cdnaspa.cc', 'www.cdnntr.cc'];

/**
 * Seals a payload the way the jm API does: AES-256-ECB over the plaintext, keyed by
 * `utf8(hex(md5(utf8(secret))))`, PKCS#7-padded, base64'd. `secret` is the fixed one for the domain
 * list and the per-second one (`<epoch>185Hcomic3PAPP7R`) for API calls.
 */
function sealJm(plaintext, secret) {
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const c = crypto.createCipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.concat([raw, Buffer.alloc(padLen, padLen)])), c.final()]).toString('base64');
}

function sealDomainList(servers) {
  return sealJm(JSON.stringify({ Server: servers }), DOMAIN_SECRET);
}

/**
 * The clock is frozen for the whole run.
 *
 * The API secret is **per-second** (`${Math.floor(Date.now()/1000)}185Hcomic3PAPP7R`) and is derived
 * independently by the source and by the mock. Freezing `Date.now()` removes a genuine second-boundary
 * race that would otherwise make these assertions flake once in a few thousand runs — and a flaky
 * security test is worse than none, because people learn to re-run it.
 *
 * `Date` is shared into the vm context, so both sides read the same value.
 */
const FROZEN_NOW_MS = 1767225600000; // 2026-01-01T00:00:00Z
function freezeClock() { Date.now = () => FROZEN_NOW_MS; }

function makeSandbox(opts) {
  const log = [];
  /** The source's declared setting defaults, reflected once the realm is built (see the host's warmMeta). */
  let declaredDefaults = {};
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    setTimeout, clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  function dispatch(msg) {
    const m = msg.method;
    log.push(m);
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return true;
    if (m === 'load_data') return opts.data ? opts.data[msg.data_key] : null;
    // Venera's chain: persisted value -> the source's declared `default` -> undefined. Dropping the
    // middle step makes `refreshDomainsOnStart` (declared `default: true`) read as undefined, so
    // `init()` would skip the domain refresh and look broken for the wrong reason.
    if (m === 'load_setting') {
      const persisted = opts.settings ? opts.settings[msg.setting_key] : undefined;
      return persisted !== undefined ? persisted : declaredDefaults[msg.setting_key];
    }
    if (m === 'save_data') return null;
    if (m === 'UI') return null;

    if (m === 'convert') {
      const v = msg.value;
      if (msg.type === 'utf8' && msg.isEncode === true) return Buffer.from(String(v), 'utf8');
      if (msg.type === 'utf8' && !msg.isEncode) return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      if (msg.type === 'md5') return crypto.createHash('md5').update(v).digest();
      if (msg.type === 'base64' && msg.isEncode) return Buffer.from(v).toString('base64');
      if (msg.type === 'base64' && !msg.isEncode) return Buffer.from(String(v), 'base64');
      // Mirrors `JsMessageDispatcher::aes`: honour the direction, keep NoPadding, drop a partial
      // tail. An earlier revision always *encrypted* here, which silently broke every decrypt —
      // again a mock that modelled the wrong thing.
      if (msg.type === 'aes-ecb') {
        const keyBuf = Buffer.from(msg.key);
        if (keyBuf.length !== 16 && keyBuf.length !== 24 && keyBuf.length !== 32) return null;
        const body = Buffer.from(v).subarray(0, Math.floor(Buffer.from(v).length / 16) * 16);
        if (body.length === 0) return Buffer.alloc(0);
        const c = msg.isEncode
          ? crypto.createCipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null)
          : crypto.createDecipheriv(`aes-${keyBuf.length * 8}-ecb`, keyBuf, null);
        c.setAutoPadding(false);
        return Buffer.concat([c.update(body), c.final()]);
      }
      return null;
    }

    if (m === 'http') {
      // The domain list is what the source's own `init()` fetches to fill `JM.apiDomains`. It has
      // to be served here, because this harness must not fabricate that state any more (see setup).
      if (msg.url === DOMAIN_LIST_URL) {
        if (opts.domainListFails) {
          return JSON.stringify({ status: null, headers: {}, body: null, error: 'network unreachable' });
        }
        return JSON.stringify({
          status: 200,
          error: null,
          headers: {},
          body: Buffer.from('\uFEFF' + sealDomainList(DOMAIN_SERVERS) + '\n', 'utf8').toString('base64'),
        });
      }
      // A successful /login response, shaped like the real API: a JSON envelope whose `data` field is
      // the base64 AES ciphertext `convertData` will decrypt. (An earlier revision returned plain
      // base64 of plaintext, which is not what jm.js's `post()` expects — it reads `json.data`, so
      // the "success" case could never actually succeed and the assertion had to be softened to
      // "no NaN / of undefined" to pass. A mock that cannot succeed cannot fail either.)
      if (opts.httpFails) {
        return JSON.stringify({ status: null, headers: {}, body: null, error: 'network unreachable' });
      }
      const secret = `${Math.floor(Date.now() / 1000)}185Hcomic3PAPP7R`;
      const envelope = JSON.stringify({ data: sealJm(opts.loginBody || '{"uid":"12345"}', secret) });
      return JSON.stringify({
        status: 200,
        error: null,
        headers: {},
        body: Buffer.from(envelope, 'utf8').toString('base64'),
      });
    }
    return null;
  }

  sandbox.__sendMessageSync = (msg) => dispatch(msg);
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
  vm.runInContext([
    'ComicSource.sources["jm"] = new JM();',
    'globalThis.ComicSource = ComicSource;',
  ].join('\n'), sandbox);

  // Reflect the declared defaults out of the live `settings` object — the same one-time reflection
  // `JsSourceManager.warmMeta()` performs, and the reason `load_setting` can answer synchronously.
  {
    const settings = vm.runInContext("ComicSource.sources['jm'].settings", sandbox);
    for (const [key, item] of Object.entries(settings)) {
      if (item && Object.prototype.hasOwnProperty.call(item, 'default')) declaredDefaults[key] = item.default;
    }
  }

  return { sandbox, log };
}

/**
 * Bootstraps the source the way the host must: `ComicSource.sources.<key>.init()`.
 *
 * ### Why this replaced a single injected line — and the bug that line hid
 *
 * This harness used to do `JM.apiDomains = ["www.cdntwice.org", "www.cdnsha.org"]` with the comment
 * "jm.js never initialises JM.apiDomains itself — Venera fills it from persisted data". That is
 * exactly backwards: **nothing persists it.** `apiDomains` is a static class field that jm.js never
 * declares, and the only writer is `overwriteApiDomains()`, reachable only from
 * `refreshApiDomains()`, reachable only from `init()`.
 *
 * The host was not calling `init()`, so on-device `JM.apiDomains` was `undefined` and
 * `baseUrl` threw `cannot read property '0' of undefined` for 登录/搜索/详情 — while *this file*,
 * which injected the missing state, stayed green. A mock that supplies what the host was supposed
 * to produce is worse than no mock: it converts a hard failure into a false pass.
 *
 * So: no injection. Call `init()` and assert it produced the domains.
 */
async function bootstrapSource(sandbox) {
  const before = vm.runInContext('typeof JM.apiDomains', sandbox);
  // jm.js 1.2.3 起 init() **不再 await** 域名发现（性能：那串 TTFB ~0.8~1.0s，而登录/搜索本身
  // 只要 ~0.4s；且 overwriteApiDomains 有非空保护，拉不到会回落到 JM.fallbackServers，所以
  // 发现从来不是登录的前置条件）。因此 init() resolve 时域名可能还没就绪。
  // 等价于宿主「init 放行 → 后台发现随后落地」的最终状态：在**宿主侧**把宏任务队列 drain 干净
  // （不能塞进 vm —— 沙箱里没有 setImmediate）。
  await vm.runInContext(
    `(async function () {
       try { await ComicSource.sources['jm'].init(); } catch (e) { /* init() is fire-and-forget */ }
     })()`, sandbox);
  for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));
  const domains = vm.runInContext('JM.apiDomains', sandbox);
  return { before, domains };
}

// jm.js's getApiHeaders() runs `dailyCheckIn(true)` without awaiting, and the source throws
// plain strings. Both produce floating rejections by design — swallow them.
process.on('unhandledRejection', () => {});
freezeClock();

(async () => {
  console.log('LOGIN PATH — real jm.js, Convert.* synchronous');

  // CASE 0 — the host bootstrap the old revision faked. If this regresses, every later assertion
  // here is meaningless, so it is checked first and loudly.
  {
    // `domainListFails` here: the very first failure mode is "the domain endpoint is unreachable",
    // which must still leave a working source (jm.js falls back to `JM.fallbackServers`).
    const { sandbox } = makeSandbox({ domainListFails: true, settings: { apiDomain: '1' } });
    const { before, domains } = await bootstrapSource(sandbox);
    console.log('  [init] apiDomains:', before, '->', JSON.stringify(domains));
    check('apiDomains is undefined until the source\'s own init() runs (nothing persists it)',
      before === 'undefined', before);
    check('init() populates it even with the domain endpoint down (JM.fallbackServers)',
      Array.isArray(domains) && domains.length === 4, JSON.stringify(domains));
  }

  // CASE 1 — the source's own rejection must survive (bad credentials / 401)
  {
    const { sandbox, log } = makeSandbox({ httpFails: true, settings: { apiDomain: '1' } });
    await bootstrapSource(sandbox);
    const res = await vm.runInContext(`
      (async function () {
        try {
          await ComicSource.sources['jm'].account.login('user', 'pass');
          return { ok: true };
        } catch (e) {
          return { ok: false, err: String((e && e.message) || e) };
        }
      })()
    `, sandbox);
    console.log('  [401] ->', JSON.stringify(res));
    check('login fails with a REAL message, not "NaN"',
      !res.ok && !/NaN/.test(res.err) && res.err.length > 0, JSON.stringify(res));
    check('the bridge saw the convert calls (so the AES key was actually derived)',
      log.includes('convert'), JSON.stringify(log));
  }

  // CASE 2 — a decryptable success body: jm.js must reach its own post-processing
  {
    const { sandbox, log } = makeSandbox({
      settings: { apiDomain: '1' },
      loginBody: '{"uid":"12345","username":"tester"}',
    });
    await bootstrapSource(sandbox);
    const res = await vm.runInContext(`
      (async function () {
        try {
          var r = await ComicSource.sources['jm'].account.login('user', 'pass');
          return { ok: true, value: String(r) };
        } catch (e) {
          return { ok: false, err: String((e && e.message) || e) };
        }
      })()
    `, sandbox);
    console.log('  [200] ->', JSON.stringify(res));
    check('login resolves with the source\'s own value', res.ok && res.value === 'ok', JSON.stringify(res));
    check('the decrypted uid reached save_data (the AES + brace-scan chain really ran)',
      log.filter((m) => m === 'save_data').length >= 1 && log.includes('convert'), JSON.stringify(log));
    check('no bridge-induced "NaN" / "of undefined" anywhere on the success path',
      !/NaN|of undefined/.test(res.err || ''), JSON.stringify(res));
  }

  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})()
  .catch((e) => {
    console.error('FATAL (harness bug, not a product result):', (e && e.stack) || e);
    process.exitCode = 2;
  });
