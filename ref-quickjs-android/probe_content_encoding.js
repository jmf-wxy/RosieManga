#!/usr/bin/env node
/**
 * LIVE PROBE — which `Content-Encoding` does the jm CDN actually answer with?
 *
 * This is a **probe**, not a test: it needs the network, so it is deliberately not named
 * `verify_*.js` and the sweep (`for f in verify_*.js`) will not pick it up. Run it by hand when
 * jm changes its CDN, or when you need to re-derive the fact below from first principles:
 *
 *   ./probe_content_encoding.js
 *
 * ### Why this exists
 *
 * A device log reported, right after login:
 *
 *     unexpected token: ''
 *     at parse (native)
 *     at get (unknown.js:270)      ← jm.js: `let json = JSON.parse(res.body)` in the 200 branch
 *
 * A `status: 200` response whose body cannot be parsed, with an *apparently empty* offending token.
 * Two very different causes look identical in a log line:
 *
 *   a) the body really is empty (`Content-Length: 0`), or
 *   b) the body is **compressed** and was never decompressed — the token is not empty, it is simply
 *      unprintable. QuickJS formats this as `unexpected token: '%.*s'` (verified with
 *      `strings libquickjs.so`), and the first byte of a compressed stream is a control character:
 *      `0x1F` (gzip), `0x0B`/`0x1B` (brotli), `0x28` (zstd, which *would* have printed as `(`).
 *
 * (b) is what happens here. Venera sources impersonate desktop Chrome and send
 * `Accept-Encoding: gzip, deflate, br, zstd` — and OkHttp only decompresses **transparently** when
 * *it* added that header itself (`BridgeInterceptor`:
 * `transparentGzip = userRequest.header("Accept-Encoding") == null`). A caller-supplied header
 * therefore disables the one code path that would have decoded the response, and OkHttp has no
 * brotli/zstd support to fall back on.
 *
 * The probe proves it on the wire by sending both header sets to the same URL and reporting the
 * negotiated codec for each.
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

// jm.js constants (sampled from the live source; see `samples/jm.js`).
const API_HOST = process.argv[2] || 'www.cdntwice.org';
const API_PATH = process.argv[3] || '/setting?app_img_shunt=1&express=';
const JM_AUTH_KEY = '18comicAPPContent';
const JM_VERSION = '2.0.16';
const JM_PKG = 'com.example.app';

/** jm.js `baseHeaders` + `getApiHeaders` — byte for byte. */
function jmHeaders() {
  const time = Math.floor(Date.now() / 1000);
  const token = crypto.createHash('md5').update(`${time}${JM_AUTH_KEY}`, 'utf8').digest('hex');
  return {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Connection: 'keep-alive',
    Origin: 'https://localhost',
    Referer: 'https://localhost/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Storage-Access': 'active',
    'X-Requested-With': JM_PKG,
    Authorization: 'Bearer',
    token: token,
    tokenparam: `${time},${JM_VERSION}`,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  };
}

/** One raw request. `https.request` never decompresses, so we observe the wire bytes. */
function rawRequest(host, path, headers, redirectsLeft = 3) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path, method: 'GET', headers, timeout: 20000 },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, `https://${host}`);
          resolve(
            rawRequest(next.host, next.pathname + next.search, headers, redirectsLeft - 1),
          );
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

/** Decode `body` according to `Content-Encoding`, trying both `deflate` flavours. */
function decode(encoding, body) {
  try {
    switch ((encoding || 'identity').toLowerCase()) {
      case 'identity':
        return { ok: true, bytes: body };
      case 'gzip':
      case 'x-gzip':
        return { ok: true, bytes: zlib.gunzipSync(body) };
      case 'deflate':
        try {
          return { ok: true, bytes: zlib.inflateSync(body) };
        } catch {
          return { ok: true, bytes: zlib.inflateRawSync(body) };
        }
      case 'br':
        return { ok: true, bytes: zlib.brotliDecompressSync(body) };
      case 'zstd':
        return zlib.zstdDecompressSync
          ? { ok: true, bytes: zlib.zstdDecompressSync(body) }
          : { ok: false, why: 'node build has no zstd support' };
      default:
        return { ok: false, why: `unknown codec ${encoding}` };
    }
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/** What a naive client sees: `Convert.decodeUtf8` is lenient, so it never throws — it lies. */
function naiveUtf8Preview(body) {
  const s = body.toString('utf8');
  const first = s.codePointAt(0);
  const printable = first !== undefined && first >= 0x20 && first !== 0xfeff;
  // Reproduce the exact QuickJS message the device printed for the first JSON.parse failure.
  const token = printable ? s[0] : s[0] ?? '';
  return { first: first, printable, token: JSON.stringify(token), looksLikeJson: /^[\s\uFEFF]*[{[]/.test(s) };
}

(async () => {
  const url = `https://${API_HOST}${API_PATH}`;
  console.log(`PROBE — content-encoding negotiation`);
  console.log(`  target: ${url}\n`);

  const source = await rawRequest(API_HOST, API_PATH, jmHeaders());
  if (source.error) {
    console.log(`  SKIPPED — cannot reach ${API_HOST}: ${source.error}`);
    console.log(`  (this probe needs the network; it is not part of the verify_* sweep)`);
    process.exitCode = 0;
    return;
  }

  const sanitized = await rawRequest(API_HOST, API_PATH, {
    ...jmHeaders(),
    'Accept-Encoding': 'gzip, deflate', // what JsMessageDispatcher.sanitizeAcceptEncoding() emits
  });

  const report = (label, res) => {
    const enc = res.headers['content-encoding'] || 'identity';
    const dec = decode(enc, res.body);
    const preview = res.body.length ? naiveUtf8Preview(res.body) : null;
    console.log(`  ${label}`);
    console.log(`    status            : ${res.status}`);
    console.log(`    content-encoding  : ${enc}`);
    console.log(`    wire bytes        : ${res.body.length}` +
      (res.body.length ? `  [${res.body.subarray(0, 4).toString('hex')}]` : ''));
    if (res.body.length) {
      console.log(`    first char        : ${preview.token}` +
        (preview.printable ? '' : '   ← unprintable, renders as empty in a log line'));
    }
    console.log(`    decodable         : ${dec.ok ? `yes (${dec.bytes.length} bytes)` : `NO — ${dec.why}`}`);
    if (dec.ok) {
      const text = dec.bytes.toString('utf8');
      console.log(`    decodes to        : ${JSON.stringify(text.slice(0, 60))}`);
      let parses = true;
      let parseErr = '';
      try {
        JSON.parse(text);
      } catch (e) {
        parses = false;
        parseErr = e.message;
      }
      console.log(`    JSON.parse        : ${parses ? 'ok' : `throws (${parseErr})`}` +
        (res.status === 200 ? '' : '   [not a 200, so the source would take an error branch]'));
    }
    console.log('');
    return { enc, dec, preview };
  };

  console.log(`  --- 1. what the SOURCE sends: Accept-Encoding: gzip, deflate, br, zstd`);
  const a = report('raw jm.js headers', source);

  console.log(`  --- 2. what the BRIDGE now sends: Accept-Encoding: gzip, deflate`);
  const b = report('sanitized headers', sanitized);

  // --- verdict ---------------------------------------------------------------------------------
  // The claim under test is narrow and does not depend on this host answering 200 from here:
  //   1. the codec the origin picks for jm.js's own header set must be one OkHttp cannot decode,
  //      otherwise the device bug would not have shown up as a parse error at all;
  //   2. once br/zstd are dropped, the answer must be decodable without any extra dependency.
  const problems = [];
  if (a.enc === 'identity') {
    problems.push(
      `${API_HOST} did not compress for the source's header set — the device log then needs another ` +
      `explanation (check the app's own http log line for raw=/enc=)`,
    );
  }
  if (!['gzip', 'x-gzip', 'deflate', 'identity'].includes(b.enc)) {
    problems.push(`sanitized header still negotiated '${b.enc}'`);
  }
  if (!b.dec.ok) {
    problems.push(`sanitized response not decodable: ${b.dec.why}`);
  }

  console.log('RESULT: ' + (problems.length === 0 ? 'the fix holds on the wire' : 'CHECK NEEDED'));
  problems.forEach((p) => console.log('  ! ' + p));
  if (problems.length === 0) {
    console.log(`  source header set -> '${a.enc}' (OkHttp cannot decode it); ` +
      `sanitized -> '${b.enc}' (decoded here by zlib)`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
})();
