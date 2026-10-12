#!/usr/bin/env node
/**
 * LIVE PROBE — jm.js 的搜索分页到底有没有「前进」？
 *
 * 这是 **probe**（需要真实网络），不是 verify_*，全量 sweep 不会带上它。手动跑：
 *
 *   ./probe_jm_search_pagination.js [host] [keyword]
 *
 * ### 为什么存在（设备现象）
 *
 * 用户在 JS 漫画源里搜索时，结果列表**无限追加同一批漫画**（截图：同一个长标题
 * 「没穿裤子用肉棒征服妹子大作战」在网格里重复铺满，底部还在转圈）。
 *
 * jm.js 的搜索是 1-based，且**只在 page>1 时**才拼 `&page=`：
 *
 *     load: async (keyword, options, page) => {
 *         let url = `${this.baseUrl}/search?search_query=${keyword}&o=${options[0]}`
 *         if (page > 1) url += `&page=${page}`
 *         ...
 *         let total = data.total
 *         let maxPage = Math.ceil(total / 80)
 *     }
 *
 * 两条可能的根因，本 probe 直接把它们分开：
 *   A. 服务端 `?page=` 不生效（或被忽略/被 CF 缓存）⇒ page=1/2/3 返回**同样的 80 条**，
 *      而 `total` 很大 ⇒ maxPage 很大 ⇒ 宿主不断 page+1 ⇒ 无限追加相同内容。
 *   B. 服务端 page 生效，但 `total`（本例是「模糊匹配全库」）远大于真实可翻页数 ⇒
 *      翻到某一页后服务端开始重复吐同一批 ⇒ 同样是无限追加。
 *
 * 两者都会让用户的截图成立，但修法不同：
 *   A ⇒ 必须识别「内容没有前进」并主动置 hasNextPage=false（或在宿主侧去重/停翻）。
 *   B ⇒ 需要用「本页首条 id 是否出现过」做停止条件。
 *
 * 输出重点：每页的 total / 首条 id / 末条 id / id 集合；以及 page1 与 page2 的
 * id 集合重叠率。重叠率 100% ⇒ A 成立。
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

const API_HOST_ARG = process.argv[2] || null;
const KEYWORD = process.argv[3] || '没穿裤子用肉棒征服妹子大作战';
const O = process.argv[4] || 'mr';

const JM_AUTH_KEY = '18comicAPPContent';
const JM_SECRET = '185Hcomic3PAPP7R';
const JM_VERSION = '2.0.16';
const JM_PKG = 'com.example.app';

/** jm.js `fallbackServers`，域名发现失败时的兜底。 */
const FALLBACK_SERVERS = ['www.cdntwice.org', 'www.cdnsha.org', 'www.cdnaspa.cc', 'www.cdnntr.cc'];

/**
 * jm.js `refreshApiDomains`：
 *   拉 https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt
 *   → convertData(text, 'diosfjckwpqpdfjkvnqQjsik') → JSON.Server（前 4 个）
 * 猜错域名会拿到 CF 的 HTML 拦截页（就是上一版探针的失败原因）。
 */
async function discoverDomains() {
  const url = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';
  const u = new URL(url);
  const res = await rawRequest(u.host, u.pathname + u.search, {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  if (res.error || res.status !== 200) return [];
  const dec = contentDecode(res.headers['content-encoding'], res.body);
  if (!dec.ok) return [];
  try {
    const json = JSON.parse(convertData(dec.bytes.toString('utf8'), 'diosfjckwpqpdfjkvnqQjsik'));
    const servers = Array.isArray(json.Server) ? json.Server.slice(0, 4) : [];
    return servers;
  } catch {
    return [];
  }
}

let API_HOST = API_HOST_ARG;

function jmHeaders(time) {
  const token = crypto.createHash('md5').update(`${time}${JM_AUTH_KEY}`, 'utf8').digest('hex');
  return {
    Accept: '*/*',
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
    const req = https.request({ host, path, method: 'GET', headers, timeout: 25000 }, (res) => {
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

function convertData(input, time) {
  const secret = `${time}${JM_SECRET}`;
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
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

/** 一页：发请求 → 解密 → 报告 total / ids。 */
async function fetchPage(page, time) {
  let path = `/search?search_query=${encodeURIComponent(KEYWORD)}&o=${O}`;
  if (page > 1) path += `&page=${page}`;
  const res = await rawRequest(API_HOST, path, jmHeaders(time));
  const out = { page, path };
  if (res.error) {
    out.error = res.error;
    return out;
  }
  const enc = res.headers['content-encoding'] || 'identity';
  out.status = res.status;
  out.enc = enc;
  out.cacheHeader = res.headers['cf-cache-status'] || res.headers['x-cache'] || '(none)';
  out.age = res.headers['age'] ?? '(none)';
  const dec = contentDecode(enc, res.body);
  if (!dec.ok) {
    out.error = `content-decode failed: ${dec.why}`;
    return out;
  }
  let envelope;
  try {
    envelope = JSON.parse(dec.bytes.toString('utf8'));
  } catch (e) {
    out.error = `envelope JSON.parse: ${e.message}`;
    return out;
  }
  if (typeof envelope.data !== 'string') {
    out.error = `envelope.data is ${typeof envelope.data}`;
    out.raw = JSON.stringify(envelope).slice(0, 200);
    return out;
  }
  try {
    const parsed = JSON.parse(convertData(envelope.data, time));
    out.total = parsed.total;
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    out.count = content.length;
    out.ids = content.map((c) => String(c.id));
    out.titles = content.slice(0, 3).map((c) => String(c.name).slice(0, 24));
    out.firstId = out.ids[0];
    out.lastId = out.ids[out.ids.length - 1];
  } catch (e) {
    out.error = `decrypt/parse: ${e.message}`;
  }
  return out;
}

function overlap(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return null;
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  return { both: inter, ofA: inter / a.length, ofB: inter / b.length };
}

(async () => {
  const time = Math.floor(Date.now() / 1000);

  let hosts = [];
  if (API_HOST) {
    hosts = [API_HOST];
  } else {
    const servers = await discoverDomains();
    if (servers.length) {
      console.log(`（域名发现成功：${servers.join(', ')}）`);
      hosts = servers;
    } else {
      console.log('（域名发现失败，回退 fallbackServers）');
      hosts = FALLBACK_SERVERS;
    }
  }

  // 逐个试：拿到 HTML 拦截页就换下一个域名。
  let firstOk = null;
  for (const h of hosts) {
    API_HOST = h;
    const probePage = await fetchPage(1, time);
    if (probePage.ids) {
      firstOk = probePage;
      break;
    }
    console.log(`（${h} 不可用：${probePage.error}）`);
  }
  if (!firstOk) {
    console.log('\nSKIPPED — 所有域名都不可达（需要真网络；这不是 verify_* 的一部分）。');
    process.exitCode = 0;
    return;
  }

  console.log('PROBE — jm.js 搜索分页是否真的前进？');
  console.log(`  host    : ${API_HOST}`);
  console.log(`  keyword : ${KEYWORD}`);
  console.log(`  o       : ${O}\n`);

  const results = [firstOk];
  for (const page of [2, 3, 4]) {
    const r = await fetchPage(page, time);
    results.push(r);
    if (r.error) {
      console.log(`page=${page}  ERROR: ${r.error}${r.raw ? ' raw=' + r.raw : ''}`);
    } else {
      console.log(
        `page=${page}  status=${r.status} total=${r.total} count=${r.count} ` +
          `cf=${r.cacheHeader} age=${r.age}`,
      );
      console.log(`         ids[0..2]=${r.ids.slice(0, 3).join(',')}  ids[-1]=${r.lastId}`);
      console.log(`         titles=${JSON.stringify(r.titles)}`);
    }
    console.log('');
  }

  const ok = results.filter((r) => !r.error && r.ids);
  if (ok.length < 2) {
    console.log('SKIPPED — 需要真网络，且至少两页成功（这不是 verify_* 的一部分）。');
    process.exitCode = 0;
    return;
  }

  console.log('OVERLAP:');
  for (let i = 1; i < ok.length; i++) {
    const o = overlap(ok[i - 1].ids, ok[i].ids);
    if (o) {
      console.log(
        `  page ${ok[i - 1].page} ∩ page ${ok[i].page}: ${o.both}/${ok[i - 1].ids.length} ` +
          `(${(o.ofA * 100).toFixed(1)}% of prev)`,
      );
    }
  }
  console.log('');

  const first = ok[0];
  const second = ok.find((r) => r.page === 2);
  const maxPage = Math.ceil(first.total / 80);
  console.log('RESULT:');
  console.log(`  total=${first.total} ⇒ 源算出 maxPage=${maxPage}（宿主会据此一直翻页）`);
  if (second) {
    const sameFirst = first.firstId === second.firstId;
    const o = overlap(first.ids, second.ids);
    if (sameFirst && o && o.ofA > 0.95) {
      console.log(`  ✔ 根因 A 成立：page=1 与 page=2 返回几乎同一批（首条同为 ${first.firstId}）`);
      console.log('  ⇒ 服务端 ?page= 不生效（或被缓存）。宿主必须检测「内容没前进」并停止翻页。');
      process.exitCode = 1;
    } else if (sameFirst) {
      console.log(`  ~ 首条相同但集合不同（重叠 ${o ? (o.ofA * 100).toFixed(1) : '?'}%）—— 可能是排序抖动，多跑几次确认。`);
      process.exitCode = 4;
    } else {
      console.log(`  ✘ 根因 A 不成立：page=2 首条 ${second.firstId} ≠ page=1 首条 ${first.firstId}，分页在前进。`);
      console.log('  ⇒ 去查 total/maxPage 是否虚高（根因 B），或宿主侧的 hasNextPage 判定。');
      process.exitCode = 2;
    }
  } else {
    console.log('  ？page=2 没拿到结果，见上面的 ERROR。');
    process.exitCode = 3;
  }
})();
