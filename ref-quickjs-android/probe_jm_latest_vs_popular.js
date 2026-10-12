#!/usr/bin/env node
/**
 * LIVE PROBE — jm 的「最新 / 排行 / 分类」端点到底返回什么？
 *
 * 真机现象（截图 23:40）：源浏览页的两个 tab「热门」与「最近更新」显示**完全一样**的内容。
 * 根因已确定（代码层）：`getPopularManga` 与 `getLatestUpdates` 都调 `explore[0].load(page-1)`，
 * 而 jm.js 的 `explore[0]` 是 `type: "multiPartPage"`（**单页多分组，无分页**）——
 * 两个 tab 必然同源。
 *
 * 本 probe 回答的是「**那正确的『最新』应该请求什么**」：
 *
 *   - `search.load(keyword, ["mr"], page)` → `/search?search_query=..&o=mr`（mr = 最新）
 *   - `search.load(keyword, ["mv"], page)` → `/search?...&o=mv`（总排行）
 *   - `categoryComics.load("最新A漫", "0", ["mr"], 1)` → `/categories/filter?o=mr&c=0&page=1`
 *
 * 判据：三者的 content[0].id / 标题集合是否**互不相同**。若 o=mr 与 o=mv 不同，则
 * 「最新」用 `o=mr`、「热门」用 `o=mv` 是正确且可区分的实现。
 *
 * 跑法（需真网络）：
 *   ./probe_jm_latest_vs_popular.js [host]
 * host 省略时自动走域名发现（curl 语义的简单 GET，比 probe_jm_search_pagination.js 的
 * 自研重定向链稳）。
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');


const JM_AUTH_KEY = '18comicAPPContent';
const JM_SECRET = '185Hcomic3PAPP7R';
const JM_VERSION = '2.0.16';
const JM_PKG = 'com.example.app';
const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
const DOMAIN_URL = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';
const FALLBACK = ['www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club'];

function convertData(input, secret) {
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
  const data = Buffer.from(String(input).replace(/[\s\uFEFF]/g, ''), 'base64');
  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  let res = Buffer.concat([dec.update(data), dec.final()]).toString('utf8');
  let s = 0;
  while (s < res.length && res[s] !== '{' && res[s] !== '[') s++;
  let e = res.length - 1;
  while (e > s && res[e] !== '}' && res[e] !== ']') e--;
  return res.substring(s, e + 1);
}

/** 直连 GET（不跟随重定向链 —— 我们用 curl 验证过目标域名本身返回 200，不需要那层脆弱逻辑）。 */
function curlGet(url, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    const req = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: headers || {},
        timeout: 25000,
        // 沙箱的 TLS 走系统 CA；不要 servername 推断问题。
        servername: u.hostname,
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url);
          resolve(curlGet(next.toString(), headers));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(gunzipMaybe(Buffer.concat(chunks), res.headers['content-encoding'])));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function discoverHost() {
  if (process.argv[2]) return process.argv[2];
  const buf = await curlGet(DOMAIN_URL, { 'User-Agent': 'Mozilla/5.0' });
  if (!buf) return FALLBACK[0];
  try {
    const json = JSON.parse(convertData(buf.toString('utf8'), DOMAIN_SECRET));
    return (json.Server && json.Server[0]) || FALLBACK[0];
  } catch {
    return FALLBACK[0];
  }
}

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

function gunzipMaybe(buf, encoding) {
  try {
    if ((encoding || '').includes('gzip')) return zlib.gunzipSync(buf);
    if ((encoding || '').includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch { /* fallthrough */ }
  return buf;
}

/** 一个端点：发请求 → 信封 → 解密 → 报告前 5 条 id/title。 */
async function probe(label, path, time) {
  const url = `https://${global.HOST}${path}`;
  const buf = await curlGet(url, jmHeaders(time));
  const out = { label, url };
  if (!buf) { out.error = 'request failed'; return out; }
  let envelope;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    out.error = `envelope JSON.parse: ${e.message} (${buf.toString('utf8').slice(0, 80)})`;
    return out;
  }
  if (typeof envelope.data !== 'string') {
    out.error = `envelope.data is ${typeof envelope.data}`;
    return out;
  }
  try {
    const parsed = JSON.parse(convertData(envelope.data, `${time}${JM_SECRET}`));
    out.total = parsed.total;
    // `/promote` 是**分组数组**（每个元素自带 content），`/search` 与 `/categories/filter`
    // 是 `{total, content}`。两种都要认，否则 explore 会假报 count=0。
    let content = [];
    if (Array.isArray(parsed)) {
      out.shape = 'array(分组)';
      out.sections = parsed.length;
      content = parsed.flatMap((s) => (Array.isArray(s && s.content) ? s.content : []));
    } else {
      out.shape = `{${Object.keys(parsed).slice(0, 4).join(',')}}`;
      content = Array.isArray(parsed.content) ? parsed.content
        : Array.isArray(parsed.list) ? parsed.list : [];
    }
    out.count = content.length;
    out.head = content.slice(0, 5).map((c) => ({ id: String(c.id), name: String(c.name).slice(0, 20) }));
  } catch (e) {
    out.error = `decrypt/parse: ${e.message}`;
  }
  return out;
}

(async () => {
  const time = Math.floor(Date.now() / 1000);
  const hosts = [await discoverHost()];
  for (const h of FALLBACK) if (!hosts.includes(h)) hosts.push(h);

  console.log('PROBE — jm「最新 vs 排行 vs 分类」是否真的不同\n');

  for (const candidate of hosts) {
    global.HOST = candidate;
    const test = await probe('probe', '/promote?page=0', time);
    if (!test.error) { console.log(`用域名：${candidate}\n`); break; }
    console.log(`（${candidate} 不可用：${test.error}）`);
    if (candidate === hosts[hosts.length - 1]) {
      console.log('\nSKIPPED — 所有域名不可达。');
      process.exitCode = 0;
      return;
    }
  }

  const cases = [
    // 每週必看的 時間 列表（optionLoader 用 `id-time` 拼 option，UI 显示 time）
    ['/week（時間选项来源）         ', '/week'],
  ];

  const results = [];
  for (const [label, path] of cases) {
    const r = await probe(label, path, time);
    results.push(r);
    console.log(`  ${label}`);
    if (r.error) {
      console.log(`    ERROR: ${r.error}`);
    } else {
      console.log(`    total=${r.total} count=${r.count} shape=${r.shape}` +
        (r.sections ? ` sections=${r.sections}` : ''));
      console.log(`    head=${JSON.stringify(r.head)}`);
    }
    console.log('');
  }

  // 关键判据：空关键词下 o=mr（最新）与 o=mv（熱門）是否不同 —— 这决定两个 tab 的修法。
  const mr = results.find((r) => r.label.includes('月排行'));
  const mv = results.find((r) => r.label.includes('總排行'));
  const catMr = results.find((r) => r.label.includes('explore'));
  console.log('RESULT:');
  if (mr && mv && mr.head && mv.head) {
    const same = JSON.stringify(mr.head.map((x) => x.id)) === JSON.stringify(mv.head.map((x) => x.id));
    console.log(`  o=mr vs o=mv 头部 id ${same ? '相同 ⚠️' : '不同 ✔'}`);
    console.log(`    o=mr : ${JSON.stringify(mr.head.map((x) => x.name))}`);
    console.log(`    o=mv : ${JSON.stringify(mv.head.map((x) => x.name))}`);
    if (!same) {
      console.log('  ✔ 「最新」用 o=mr、「热门」用 o=mv 是可区分的 —— 宿主可按此实现 getLatestUpdates。');
      process.exitCode = 0;
    } else {
      console.log('  ⚠️ o 参数对该关键词不区分；换关键词再测，或改用 /categories/filter 的 c= 分类。');
      process.exitCode = 2;
    }
  } else {
    console.log('  ？缺少可比对的结果，见上面 ERROR。');
    process.exitCode = 3;
  }
  if (catMr && !catMr.error) {
    console.log(`  （分类端点可用：最新A漫 total=${catMr.total} count=${catMr.count}）`);
  }
})();
