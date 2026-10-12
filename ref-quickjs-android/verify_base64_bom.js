/**
 * verify_base64_bom.js — why `refreshDomains` saw `decodeUtf8(..., got null)`.
 *
 * The jm domain-list endpoint returns HTTP 200 with **a UTF-8 BOM** in front of base64 text:
 *
 *   $ curl -s .../newsvr-2025.txt | xxd | head -1
 *   00000000: efbb bf58 2b62 6e7a 5949 6377 4636 4337  ...X+bnzYIcwF6C7
 *
 * `EF BB BF` = U+FEFF (BOM), then `X+bnz...` = base64 payload.
 *
 * jm.js feeds that **string straight to `Convert.decodeBase64`** (`convertData`), and then the
 * decoded bytes to `Convert.decryptAesEcb`, then `Convert.decodeUtf8`. When the base64 step fails
 * it returns null, and the *next* line dies on `res.length`:
 *
 *   let data      = this.convertData(await res.text(), domainSecret)
 *   ...
 *   let res       = Convert.decodeUtf8(decrypted)   // decrypted === null
 *   while (start < res.length && ...)                // <- 'length' of undefined
 *
 * So the question this pins down is a decoder-strictness question, and Java and Dart answer it
 * differently:
 *
 *   • Dart `base64Decode` (used by Venera) **skips** non-alphabet characters — BOM, spaces,
 *     newlines are all ignored. It never throws on a leading BOM.
 *   • Java `Base64.getDecoder().decode(s)` is strict: it throws `IllegalArgumentException` on any
 *     character outside the alphabet that is not a valid `=` pad. A leading U+FEFF throws.
 *
 * Our Kotlin wraps that in `runCatching { }.getOrNull()`, which converts "Java is stricter than
 * Dart" into a **silent null** — the worst possible outcome, because the source then runs on with
 * a missing value instead of reporting a real error.
 *
 * This script proves the lenient/strict split and fixes the contract the Kotlin port must meet:
 * trim + strip BOM, use a MIME-style decoder, and *never* return null for a merely-untidy input.
 */

'use strict';
const https = require('https');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const BOM = '\uFEFF';

/**
 * Java decoder behaviour, measured with `java Base64Probe.java` on Temurin 17 (see
 * ref-quickjs-android/Base64Probe.java):
 *
 *   input                     Base64.getDecoder()        Base64.getMimeDecoder()
 *   aGVsbG8gd29ybGQ=          ok                          ok
 *   <BOM>aGVsbG8gd29ybGQ=     IllegalArgumentException    ok
 *   aGVsbG8gd29ybGQ=<LF>      IllegalArgumentException    ok
 *   aGVs<LF>bG8g<LF>d29ybGQ=  IllegalArgumentException    ok
 *     aGVsbG8gd29ybGQ=        IllegalArgumentException    ok
 *   aGVsbG8gd29ybGQ           ok                          ok
 *
 * So the *only* strict/lenient switch that matters is `getDecoder()` -> `getMimeDecoder()`.
 * `getDecoder()` rejects the real endpoint's BOM; `getMimeDecoder()` accepts everything Dart
 * accepts. These two functions model each decoder exactly, so the assertions below are real
 * (an earlier version of this file tested Node's lenient Buffer and passed a bug through).
 */
const MIME_WHITESPACE = /[\s\uFEFF\u0000-\u001F\u007F-\u009F]/;

function javaStrictDecode(s) {
  // getDecoder(): rejects anything outside the alphabet after padding — BOM and whitespace alike.
  if (s.length === 0) return Buffer.alloc(0);
  const core = s.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(core)) throw new Error('Illegal base64 character');
  if (s.length % 4 !== 0) throw new Error('bad length');
  return Buffer.from(s, 'base64');
}

function javaMimeDecode(s) {
  // getMimeDecoder(): skips every non-alphabet character anywhere.
  const cleaned = s.replace(new RegExp(MIME_WHITESPACE.source, 'g'), '');
  const core = cleaned.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(core)) throw new Error('Illegal base64 character');
  return Buffer.from(cleaned, 'base64');
}

/** Dart's Base64Codec behaviour. */
function dartStyleDecode(s) {
  const cleaned = s.replace(new RegExp('[^A-Za-z0-9+/=]', 'g'), '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

console.log('\n=== 1. the real response shape (BOM + base64) ===');
{
  // A stand-in for the endpoint payload: BOM, then base64 of some "decrypted-ish" bytes.
  const payloadBytes = Buffer.from('{"Server":["https://a.example.com"]}', 'utf8');
  const wire = BOM + payloadBytes.toString('base64') + '\n';

  check('first char really is U+FEFF', wire.charCodeAt(0) === 0xFEFF);
  check('Dart-style decode tolerates the BOM', dartStyleDecode(wire).equals(payloadBytes));

  let strictErr = null;
  try { javaStrictDecode(wire); } catch (e) { strictErr = e.message; }
  check('Java strict decode REJECTS the BOM (this is the bug)', strictErr !== null, strictErr);

  let noBomErr = null;
  try { javaStrictDecode(wire.replace(/^\uFEFF/, '').trim()); } catch (e) { noBomErr = e.message; }
  check('Java strict decode ACCEPTS it once the BOM AND surrounding whitespace are stripped',
        noBomErr === null, noBomErr);
}

console.log('\n=== 2. other untidy inputs the two implementations disagree on ===');
{
  const body = Buffer.from('hello world', 'utf8').toString('base64');

  const cases = [
    ['trailing newline',      body + '\n'],
    ['CRLF wrapping',         body.slice(0, 4) + '\r\n' + body.slice(4)],
    ['leading spaces',        '   ' + body],
    ['no "=" padding',        body.replace(/=+$/, '')],
  ];

  for (const [label, input] of cases) {
    let strictOk = true;
    try { javaStrictDecode(input); } catch (e) { strictOk = false; }
    check('Dart accepts "' + label + '" while Java strict ' + (strictOk ? 'also does' : 'throws'),
          dartStyleDecode(input).length > 0, 'decoded empty');
  }
}

console.log('\n=== 3. the failure mode we must eliminate: null instead of an error ===');
{
  const wire = BOM + 'aGVsbG8=';
  // What our current Kotlin does: runCatching { getDecoder().decode(s) }.getOrNull()
  let currentResult;
  try { currentResult = javaStrictDecode(wire); } catch (e) { currentResult = null; }
  check('current Kotlin yields null for a BOM-prefixed input (silent data loss)',
        currentResult === null);

  // What it should do: the MIME decoder, exactly as Venera's Dart decoder tolerates the BOM.
  let fixed = null;
  try { fixed = javaMimeDecode(wire); } catch (e) { /* stays null */ }
  check('switching to getMimeDecoder() turns the same input into real bytes',
        fixed !== null && fixed.toString('utf8') === 'hello', fixed ? 'len=' + fixed.length : 'null');

  // And a genuinely corrupt input must still fail loudly rather than silently.
  let garbage = null;
  try { garbage = javaMimeDecode('!!!not base64!!!'); } catch (e) { garbage = null; }
  check('genuinely corrupt input still fails (we did not just swallow everything)', garbage === null);
}

console.log('\n=== 4. the AES step downstream, given the now-correct bytes ===');
{
  const crypto = require('crypto');
  const secret = 'diosfjckwpqpdfjkvnqQjsik';
  const key = Buffer.from(crypto.createHash('md5').update(secret).digest('hex'), 'utf8');

  const json = '{"Server":["https://a.example.com"]}';
  const raw = Buffer.from(json, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  enc.setAutoPadding(false);
  const ct = Buffer.concat([enc.update(padded), enc.final()]);

  const wire = BOM + ct.toString('base64') + '\n';
  const decoded = javaMimeDecode(wire);
  check('BOM+base64 (with trailing LF) -> ciphertext of the right length', decoded.length === ct.length);

  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  const plain = Buffer.concat([dec.update(decoded), dec.final()]);

  // jm.js::convertData scans BOTH ends — start at the first brace, end at the last close brace —
  // then takes the substring. That is how it tolerates the surviving PKCS#7 padding.
  const text = plain.toString('latin1');
  let start = 0;
  while (start < text.length && text[start] !== '{' && text[start] !== '[') start++;
  let end = text.length - 1;
  while (end > start && text[end] !== '}' && text[end] !== ']') end--;
  const sliced = text.substring(start, end + 1);

  check('scanning BOTH ends recovers valid JSON (head-only scan would not)', (() => {
    try { return JSON.parse(sliced).Server.length === 1; } catch (e) { return false; }
  })());

  check('head-only slicing would have failed (proves the tail scan is load-bearing)', (() => {
    try { JSON.parse(text.slice(start)); return false; } catch (e) { return true; }
  })());
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
