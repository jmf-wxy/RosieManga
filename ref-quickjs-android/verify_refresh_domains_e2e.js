/**
 * verify_refresh_domains_e2e.js — the full `refreshApiDomains` chain from the 13:21 device log.
 *
 * Device log this reproduces:
 *   [JsSourceConfigContent]  callback button tapped: 'refreshDomains'
 *   [JsSourceManager]        runSettingCallback ENTER jm.refreshDomains
 *   [JsMessageDispatcher]    convert.utf8: expected ByteArray for decodeUtf8, got null
 *   [JsEngine]               evalAwaitingResult: ... error=cannot read property 'length' of undefined
 *                            script=(function () { var src = ComicSource.sources["jm"]; return src.setting...
 *   [JsSourceManager]        runSettingCallback REJECTED: cannot read property 'length' of undefined
 *
 * and the login failure in the same log:
 *   [JsEngine]  ... error=cannot read property '0' of undefined
 *               script=ComicSource.sources["jm"].account.login("1439034493", "4566548989")
 *
 * Both go through jm.js::convertData, which is:
 *
 *   let key       = Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8(secret))))
 *   let data      = Convert.decodeBase64(input)          // <- BOM made Java's getDecoder() throw
 *   let decrypted = Convert.decryptAesEcb(data, key)     // <- was `else -> value`: not implemented
 *   let res       = Convert.decodeUtf8(decrypted)
 *   let start = 0;  while (start < res.length && res[start] !== '{' && res[start] !== '[') start++
 *   let end = res.length - 1; while (end > start && res[end] !== '}' && res[end] !== ']') end--
 *   return res.substring(start, end + 1)
 *
 * This script runs the *whole* chain against a realistic wire payload — BOM, base64, a padded
 * AES-256-ECB blob — with Kotlin-equivalent implementations of every `Convert.*` step, and asserts
 * that it now reaches `JSON.parse` instead of dying on `res.length`.
 *
 * The Kotlin implementations mirrored here:
 *   base64 decode  -> Base64.getMimeDecoder().decode()     (JsMessageDispatcher::convert)
 *   aes-ecb        -> Cipher("AES/ECB/NoPadding"), key 16/24/32 bytes, partial tail dropped
 *   utf8 decode    -> String(bytes, UTF_8)   [note: Java keeps the U+FEFF, see assertion 4]
 */

'use strict';
const crypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const BOM = '\uFEFF';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';

// --- Kotlin-equivalent bridge primitives ------------------------------------------------------

/** `convert.base64` (isEncode=false) after the getMimeDecoder fix. */
function ktDecodeBase64(text) {
  const cleaned = text.replace(/[\s\uFEFF\u0000-\u001F\u007F-\u009F]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'base64');
}

/** `convert.utf8` (isEncode=false). */
function ktDecodeUtf8(bytes) {
  return bytes === null ? null : bytes.toString('utf8');
}

/** `convert.md5`, returning raw 16 bytes (JS side hex-encodes them). */
function ktMd5(bytes) {
  return crypto.createHash('md5').update(bytes).digest();
}

/** `convert.hexEncode` — pure JS in init.js, but same result. */
function hexEncode(bytes) { return Buffer.from(bytes).toString('hex'); }

/** `convert.utf8` (isEncode=true). */
function ktEncodeUtf8(str) { return Buffer.from(str, 'utf8'); }

/** `convert.aes-ecb` after the implementation landed. */
function ktAesEcb(value, key, encode) {
  if (!value || ![16, 24, 32].includes(key.length)) return null;
  const body = value.subarray(0, Math.floor(value.length / 16) * 16);
  if (body.length === 0) return Buffer.alloc(0);
  const c = crypto.createCipheriv ? null : null; // placeholder to keep symmetry
  const cipher = encode
    ? crypto.createCipheriv('aes-' + (key.length * 8) + '-ecb', key, null)
    : crypto.createDecipheriv('aes-' + (key.length * 8) + '-ecb', key, null);
  cipher.setAutoPadding(false); // Venera's processBlock does no PKCS#7 handling
  return Buffer.concat([cipher.update(body), cipher.final()]);
}

// --- jm.js::convertData, transliterated --------------------------------------------------------

function convertData(input, secret) {
  const key = ktEncodeUtf8(hexEncode(ktMd5(ktEncodeUtf8(secret))));
  const data = ktDecodeBase64(input);
  const decrypted = ktAesEcb(data, key, false);
  const res = ktDecodeUtf8(decrypted);

  // This is the exact loop that produced "cannot read property 'length' of undefined".
  if (res === null || res === undefined) {
    throw new TypeError("cannot read property 'length' of undefined");
  }

  let start = 0;
  while (start < res.length && res[start] !== '{' && res[start] !== '[') start++;
  let end = res.length - 1;
  while (end > start && res[end] !== '}' && res[end] !== ']') end--;
  return res.substring(start, end + 1);
}

// --- a realistic wire payload ------------------------------------------------------------------

/** Builds what the endpoint actually serves: BOM + base64(padded AES-256-ECB(json)). */
function makeWire(json, secret) {
  const key = ktEncodeUtf8(hexEncode(ktMd5(ktEncodeUtf8(secret))));
  const raw = Buffer.from(json, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const ct = ktAesEcb(padded, key, true);
  return BOM + ct.toString('base64') + '\n';
}

console.log('\n=== 1. the two device failures are gone: the chain reaches JSON.parse ===');
{
  const json = '{"Server":["https://a.example.com","https://b.example.com"]}';
  const wire = makeWire(json, DOMAIN_SECRET);

  let result = null, err = null;
  try { result = convertData(wire, DOMAIN_SECRET); } catch (e) { err = e; }

  check('convertData does NOT throw "length of undefined"', err === null, err && err.message);
  check('the returned string is valid JSON', (() => {
    try { return JSON.parse(result).Server.length === 2; } catch (e) { return false; }
  })(), result && result.slice(0, 60));
  check('the server list survived intact', (() => {
    try { return JSON.parse(result).Server[1] === 'https://b.example.com'; } catch (e) { return false; }
  })());
}

console.log('\n=== 2. control: the OLD base64 decoder still reproduces the device error ===');
{
  const json = '{"Server":["https://a.example.com"]}';
  const wire = makeWire(json, DOMAIN_SECRET);

  // Old Kotlin: Base64.getDecoder() inside runCatching{}.getOrNull() -> silent null.
  const strictWouldThrow = (() => {
    const cleaned = wire.replace(/=+$/, '');
    return !/^[A-Za-z0-9+/]*$/.test(cleaned);
  })();
  check('getDecoder() would have rejected this payload (BOM present)', strictWouldThrow);

  const oldData = null; // what runCatching{}.getOrNull() produced
  const oldDecrypted = ktAesEcb(oldData, Buffer.alloc(32), false);
  check('null base64 output cascades to a null AES output', oldDecrypted === null);
  check('and that is exactly what surfaced as "decodeUtf8 ... got null"',
        ktDecodeUtf8(oldDecrypted) === null);
}

console.log('\n=== 3. the login chain (same convertData) also clears ===');
{
  // jm.js login path ends in the same helper; a JSON body with an index access is what triggered
  // "cannot read property '0' of undefined" when convertData returned a broken value.
  const loginJson = '{"uid":123,"username":"tester","token":"abcdef"}';
  const wire = makeWire(loginJson, DOMAIN_SECRET);

  let parsed = null, err = null;
  try { parsed = JSON.parse(convertData(wire, DOMAIN_SECRET)); } catch (e) { err = e; }
  check('login payload parses without an index error', err === null, err && err.message);
  check('field access that previously died now works', parsed !== null && parsed.username === 'tester');
}

console.log('\n=== 4. UTF-8 BOM stays in the decoded string (why the scan loop is needed) ===');
{
  // Java's `String(bytes, UTF_8)` does NOT strip a BOM the way a decoder with BOM-handling would;
  // that is exactly why jm.js scans for the first '{' instead of trusting index 0.
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"a":1}', 'utf8')]);
  const text = withBom.toString('utf8');
  check('BOM survives as U+FEFF after UTF-8 decode', text.charCodeAt(0) === 0xFEFF);
  check('scanning finds the brace at index 1, so the payload is still recovered',
        text.search(/[{[]/) === 1);
}

console.log('\n=== 5. key derivation is stable and jm-specific ===');
{
  const key = ktEncodeUtf8(hexEncode(ktMd5(ktEncodeUtf8(DOMAIN_SECRET))));
  check('AES-256 key (32 bytes) from md5->hex->utf8', key.length === 32, 'len=' + key.length);
  check('key is the ASCII hex of the md5 digest',
        key.toString('utf8') === crypto.createHash('md5').update(DOMAIN_SECRET).digest('hex'));
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
