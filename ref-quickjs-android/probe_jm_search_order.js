#!/usr/bin/env node
/**
 * LIVE PROBE — 我们的宿主给 jm.js 传了 `options = []` 之后，`/search` 到底返回了什么？
 *
 * 这是一个 **probe**（需要真实网络），所以刻意不叫 `verify_*.js`，全量 sweep 不会带上它。
 * 手动跑：
 *
 *   ./probe_jm_search_order.js [host] [keyword]
 *
 * ### 为什么存在
 *
 * jm.js 的搜索长这样（samples/jm.js:641）：
 *
 *     load: async (keyword, options, page) => {
 *         let url = `${this.baseUrl}/search?search_query=${keyword}&o=${options[0]}`
 *
 * `options` 是**源的 optionList 里每个 select 的「值」**（Venera 侧由 UI 传入，默认取第一项）。
 * 而宿主目前写死了空数组：
 *
 *     engine.eval("...search.load($query, [], $page)")     // ← JsMangaSource.kt:60
 *
 * 于是 URL 里出现字面量 `o=undefined`。这个 probe 把三种 `o`（宿主现状 / 源默认 / 空）
 * 原样发出去并各自解密，用**同一秒**的时间戳，直接对比 `total` / `content.length`。
 *
 * 结论只有两种：
 *   - `o=undefined` → total=0  ⇒ 根因确定，宿主必须传源声明的默认选项；
 *   - `o=undefined` → 有结果  ⇒ 搜索为空另有原因（回到 JsEngine 的 promise 语义去查）。
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

const API_HOST = process.argv[2] || 'www.cdntwice.org';
const KEYWORD = process.argv[3] || '魔法少女';

const JM_AUTH_KEY = '18comicAPPContent';
const JM_SECRET = '185Hcomic3PAPP7R';
const JM_VERSION = '2.0.16';
const JM_PKG = 'com.example.app';

/** jm.js `baseHeaders` + `getApiHeaders(time)` —— 逐字段对齐。 */
function jmHeaders(time) {
  const token = crypto.createHash('md5').update(`${time}${JM_AUTH_KEY}`, 'utf8').digest('hex');
  return {
    Accept: '*/*',
    // jm.js 原本是 "gzip, deflate, br, zstd"；宿主 sanitizeAcceptEncoding() 之后是下面这个，
    // probe 用宿主最终会发的头，这样拿到的 body 才是设备真正会解析的东西。
    'Accept-Encoding': 'gzip, deflate',
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
    token,
    tokenparam: `${time},${JM_VERSION}`,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  };
}

function rawRequest(host, path, headers, redirectsLeft = 3) {
  return new Promise((resolve) => {
    const req = https.request({ host, path, method: 'GET', headers, timeout: 20000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, `https://${host}`);
        resolve(rawRequest(next.host, next.pathname + next.search, headers, redirectsLeft - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

function contentDecode(encoding, body) {
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
      default:
        return { ok: false, why: `unsupported codec ${encoding}` };
    }
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/**
 * jm.js `convertData(input, secret)` 的逐行复刻：
 *   key = utf8(hex(md5(utf8(secret))))    ← 32 字节 ⇒ AES-256
 *   data = decodeBase64(input)            ← Dart 语义 = 宽松，跳过 BOM/换行/空白
 *   decryptAesEcb(data, key)              ← NoPadding，不加也不去填充
 *   然后扫首尾 `{`/`[` … `}`/`]`
 */
function convertData(input, time) {
  const secret = `${time}${JM_SECRET}`;
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
  // Node 的 'base64' 解码同样宽松（忽略非法字符），与 Dart / 我们的 MIME decoder 一致。
  const data = Buffer.from(input, 'base64');
  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  const plain = Buffer.concat([dec.update(data), dec.final()]);
  let res = plain.toString('utf8');
  let start = 0;
  while (start < res.length && res[start] !== '{' && res[start] !== '[') start++;
  let end = res.length - 1;
  while (end > start && res[end] !== '}' && res[end] !== ']') end--;
  return res.substring(start, end + 1);
}

/** 一个 case：发请求 → 解信封 → 解密 → 报告 total / content.length。 */
async function probe(label, oValue, time) {
  const path = `/search?search_query=${encodeURIComponent(KEYWORD)}&o=${oValue}`;
  const res = await rawRequest(API_HOST, path, jmHeaders(time));
  if (res.error) return { label, error: res.error };

  const enc = res.headers['content-encoding'] || 'identity';
  const dec = contentDecode(enc, res.body);
  const out = {
    label,
    url: `https://${API_HOST}${path}`,
    status: res.status,
    enc,
    wireBytes: res.body.length,
  };
  if (!dec.ok) {
    out.error = `content-decode failed: ${dec.why}`;
    return out;
  }
  let envelope;
  try {
    envelope = JSON.parse(dec.bytes.toString('utf8'));
  } catch (e) {
    out.error = `envelope JSON.parse threw: ${e.message}`;
    out.rawPreview = JSON.stringify(dec.bytes.toString('utf8').slice(0, 120));
    return out;
  }
  out.envelopeKeys = Object.keys(envelope).join(',');
  if (typeof envelope.data !== 'string') {
    out.error = `envelope.data is ${typeof envelope.data} (source would throw 'Invalid Data')`;
    return out;
  }
  try {
    const plain = convertData(envelope.data, time);
    const parsed = JSON.parse(plain);
    out.jsonKeys = Object.keys(parsed).join(',');
    out.total = parsed.total;
    out.contentLength = Array.isArray(parsed.content) ? parsed.content.length : `(${typeof parsed.content})`;
    out.firstTitle = parsed.content && parsed.content[0] ? parsed.content[0].name : null;
    out.preview = plain.slice(0, 200);
  } catch (e) {
    out.error = `decrypt/parse threw: ${e.message}`;
  }
  return out;
}

(async () => {
  // 三个 case 必须共用同一个 `time`：token 与 AES secret 都由它派生，
  // 而 jm 的 secret 每秒一变 —— 跨秒对比会变成两种变量同时变化。
  const time = Math.floor(Date.now() / 1000);
  console.log('PROBE — jm.js 搜索参数 `o=${options[0]}`，宿主传空数组时会是什么？');
  console.log(`  host    : ${API_HOST}`);
  console.log(`  keyword : ${KEYWORD}`);
  console.log(`  time    : ${time}  (三个 case 共用，保证只有 o 一个变量)\n`);

  const cases = [
    ['宿主现状  options=[]      ⇒ o=undefined', 'undefined'],
    ['源默认首项 options=["mr"] ⇒ o=mr', 'mr'],
    ['空串                      ⇒ o=', ''],
  ];

  const results = [];
  for (const [label, value] of cases) {
    const r = await probe(label, value, time);
    results.push(r);
    console.log(`  ${label}`);
    if (r.error) {
      console.log(`    ERROR: ${r.error}`);
      if (r.rawPreview) console.log(`    raw: ${r.rawPreview}`);
    } else {
      console.log(`    status=${r.status} enc=${r.enc} wire=${r.wireBytes}B`);
      console.log(`    envelope keys : ${r.envelopeKeys ?? '(n/a)'}`);
      console.log(`    decrypted keys: ${r.jsonKeys ?? '(n/a)'}`);
      console.log(`    total         : ${r.total}`);
      console.log(`    content.length: ${r.contentLength}`);
      if (r.firstTitle) console.log(`    first title   : ${r.firstTitle}`);
      if (r.preview) console.log(`    preview       : ${JSON.stringify(r.preview.slice(0, 90))}`);
    }
    console.log('');
  }

  const reachable = results.filter((r) => !r.error || !/cannot reach|timeout|ENOTFOUND|ECONN/.test(r.error));
  if (reachable.length === 0) {
    console.log('SKIPPED — 网络不可达，这个 probe 需要真网络（它不是 verify_* 的一部分）');
    process.exitCode = 0;
    return;
  }

  const host = results.find((r) => r.label.startsWith('宿主现状'));
  const dflt = results.find((r) => r.label.startsWith('源默认首项'));
  console.log('RESULT:');
  if (host && typeof host.total === 'number') {
    if (host.total === 0 && dflt && typeof dflt.total === 'number' && dflt.total > 0) {
      console.log(`  ✔ 根因确认：o=undefined ⇒ total=0（空内容），o=mr ⇒ total=${dflt.total}`);
      console.log('  ⇒ 宿主必须把源的 optionList 默认值（首个选项的 value）传进 search.load。');
      process.exitCode = 1; // 非 0 = 的确复现了设备上的「搜不到」
    } else if (host.total > 0) {
      console.log(`  ✘ 与假设相反：o=undefined 也能拿到 total=${host.total}`);
      console.log('  ⇒ 搜索为空另有原因，去查 JsEngine 的 promise 求值语义（eval vs evalAwaiting）。');
      process.exitCode = 2;
    }
  } else {
    console.log('  ？宿主那一档没拿到可比较的 total，见上面的 ERROR。');
    process.exitCode = 3;
  }
})();
