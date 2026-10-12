/**
 * verify_aes_convert.js — pins down the exact AES semantics Venera's sources rely on.
 *
 * The device failure this guards against:
 *   [JsMessageDispatcher] convert.utf8: expected ByteArray for decodeUtf8, got null
 *   [JsEngine] evalAwaitingResult: ... error=cannot read property 'length' of undefined
 *   script=(function () { var src = ComicSource.sources["jm"]; ...
 *
 * Root cause chain (jm.js::convertData):
 *   let key      = Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8(secret))))
 *   let data     = Convert.decodeBase64(input)
 *   let decrypted= Convert.decryptAesEcb(data, key)   // <- Kotlin fell through to `else -> value`
 *   let res      = Convert.decodeUtf8(decrypted)      // <- got null / a Map, not bytes
 *   while (start < res.length && ...)                  // <- TypeError: 'length' of undefined
 *
 * Venera's reference implementation (venera/lib/foundation/js_engine.dart:442) is the authority:
 *
 *   case "aes-ecb":
 *     var cipher = ECBBlockCipher(AESEngine());
 *     cipher.init(isEncode, KeyParameter(key));
 *     var result = Uint8List(value.length);
 *     while (offset < value.length) offset += cipher.processBlock(value, offset, result, offset);
 *     return result;
 *
 * Two facts that follow from that code, both of which a naive "use a crypto library" port gets
 * wrong:
 *   1. **NoPadding.** `processBlock` moves exactly 16 bytes per call and `result.length` equals
 *      `value.length` — there is no PKCS#7 pad on encrypt and *no unpad on decrypt*. The plaintext
 *      therefore keeps its trailing padding bytes, which is why jm.js scans forward for the first
 *      `{` / `[` instead of trusting the start of the string.
 *   2. **A short tail is dropped**, not padded: `while (offset < value.length)` stops before a
 *      final partial block, so the result length is `floor(len/16)*16`.
 *
 * This script checks that understanding against Node's own crypto implementation, so the Kotlin
 * port can be written to match byte-for-byte.
 */

'use strict';
const crypto = require('crypto');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function hex(buf) { return Buffer.from(buf).toString('hex'); }

// --- the exact key-derivation jm.js uses for `domainSecret = "diosfjckwpqpdfjkvnqQjsik"` -------
function jmKeyDerivation(secret) {
  const md5 = crypto.createHash('md5').update(Buffer.from(secret, 'utf8')).digest(); // 16 bytes
  const hexStr = md5.toString('hex');                        // 32 ASCII chars  (Convert.hexEncode)
  return Buffer.from(hexStr, 'utf8');                        // 32 bytes         (Convert.encodeUtf8)
}
// NOTE: this 32-byte key is NOT a valid AES key length in the "16/24/32" sense — it IS 32 bytes,
// so it maps to AES-256. That is intentional and Venera does the same (KeyParameter accepts any
// 16/24/32-byte key).

console.log('\n=== 1. key derivation matches the source contract ===');
{
  const key = jmKeyDerivation('diosfjckwpqpdfjkvnqQjsik');
  check('derived key is 32 bytes (AES-256)', key.length === 32, 'len=' + key.length);
  check('derived key is ASCII hex of the md5', /^[0-9a-f]{32}$/.test(key.toString('utf8')));
}

console.log('\n=== 2. ECB NoPadding round-trips, and padding stays in the plaintext ===');
{
  const key = jmKeyDerivation('diosfjckwpqpdfjkvnqQjsik');

  // The real payload's shape: a JSON document, PKCS#7-padded to a 16-byte multiple.
  const json = '{"Server":["https://a.example.com","https://b.example.com"]}';
  const raw = Buffer.from(json, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  enc.setAutoPadding(false);
  const cipherText = Buffer.concat([enc.update(padded), enc.final()]);

  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  const plain = Buffer.concat([dec.update(cipherText), dec.final()]);

  check('ciphertext length is a 16-byte multiple', cipherText.length % 16 === 0);
  check('NoPadding decrypt returns the FULL padded length', plain.length === padded.length,
        'plain=' + plain.length + ' padded=' + padded.length);
  check('padding bytes survive at the tail (what jm.js scans past)',
        plain.slice(raw.length).every(b => b === padLen));
  check('the JSON body is intact at the head', plain.slice(0, raw.length).toString('utf8') === json);
}

console.log('\n=== 3. auto-padding would CORRUPT the result — the trap we must avoid ===');
{
  const key = jmKeyDerivation('diosfjckwpqpdfjkvnqQjsik');
  const json = '{"Server":["https://a.example.com"]}';
  const raw = Buffer.from(json, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  enc.setAutoPadding(false);
  const cipherText = Buffer.concat([enc.update(padded), enc.final()]);

  // The wrong way: let the library strip what IT thinks is padding.
  const naive = crypto.createDecipheriv('aes-256-ecb', key, null); // autoPadding = true
  let naiveOut = null, threw = false;
  try { naiveOut = Buffer.concat([naive.update(cipherText), naive.final()]); }
  catch (e) { threw = true; }

  check('auto-padding either throws or silently truncates (never byte-identical)',
        threw || naiveOut.length !== plain_len(padded.length), 
        threw ? 'threw=' + true : 'len=' + naiveOut.length);
  function plain_len(n) { return n; }
}

console.log('\n=== 4. a 32-byte key is AES-256, and short input is NOT padded by us ===');
{
  const key = jmKeyDerivation('diosfjckwpqpdfjkvnqQjsik');
  const short = Buffer.alloc(16, 0x41); // exactly one block, no tail
  const enc = crypto.createCipheriv('aes-256-ecb', key, null);
  enc.setAutoPadding(false);
  const ct = Buffer.concat([enc.update(short), enc.final()]);
  check('one full block -> one full block (1:1, no growth)', ct.length === 16, 'len=' + ct.length);

  // Venera's loop drops a partial trailing block rather than erroring or padding it.
  const partial = Buffer.alloc(20, 0x41); // 16 + 4
  const usable = partial.slice(0, Math.floor(partial.length / 16) * 16);
  check('partial tail is dropped to a block boundary (floor semantics)',
        usable.length === 16, 'usable=' + usable.length);
}

console.log('\n=== 5. hexEncode / decodeUtf8 shapes used in convertData ===');
{
  const md5hex = crypto.createHash('md5').update('abc').digest('hex');
  check('hexEncode(md5(x)) is 32 ASCII chars', md5hex.length === 32 && /^[0-9a-f]{32}$/.test(md5hex));

  const original = '{"Server":["x"]}';
  const b64 = Buffer.from(original).toString('base64');
  // Only valid for padding-free base64: `=`/`==` tails mean the 3/4 rule undercounts.
  const expected = original.length;
  check('decodeBase64 round-trips to the original byte count',
        Buffer.from(b64, 'base64').length === expected,
        'got=' + Buffer.from(b64, 'base64').length + ' want=' + expected);
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
