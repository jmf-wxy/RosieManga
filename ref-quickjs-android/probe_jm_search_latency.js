#!/usr/bin/env node
/**
 * LIVE PROBE — JS 源「搜索」到底慢在哪一层？
 *
 * 用户反馈：输入漫画名后搜索速度慢，而且列表还停留在上一次的内容上（已改为「先空白+转圈」）。
 * 「还显示旧内容」是宿主的问题（已修）；「慢」需要先分清是不是宿主造成的 —— 本探针只测
 * **源站端到端**（域名发现 → token 头 → /search 信封 → 解密 → 解析），不含 QuickJS 桥与 DB。
 *
 * 判读：
 *   • 若这里就要 2~5s，那么「慢」的主体是源站/网络，宿主能做的只是**把等待做成可见的**。
 *   • 若这里只要几百 ms，而真机仍很慢，就该继续找宿主侧的开销（逐条入库、泵 tick 等）。
 *
 * 跑法（需真网络）： node probe_jm_search_latency.js [host]
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
        servername: u.hostname,
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve(curlGet(new URL(res.headers.location, url).toString(), headers));
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

function gunzipMaybe(buf, encoding) {
  try {
    if ((encoding || '').includes('gzip')) return zlib.gunzipSync(buf);
    if ((encoding || '').includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch { /* fallthrough */ }
  return buf;
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
    'X-Requested-With': JM_PKG,
    Authorization: 'Bearer',
    token,
    tokenparam: `${time},${JM_VERSION}`,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  };
}

/** 端到端一次搜索，返回各阶段耗时（ms）。 */
async function timedSearch(query, time) {
  const path = `/search?search_query=${encodeURIComponent(query)}&o=mr`;
  const t0 = Date.now();
  const buf = await curlGet(`https://${global.HOST}${path}`, jmHeaders(time));
  const tNet = Date.now() - t0;
  if (!buf) return { query, error: 'request failed', netMs: tNet };
  const t1 = Date.now();
  let envelope;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { query, error: `envelope: ${e.message}`, netMs: tNet };
  }
  const tJson = Date.now() - t1;
  const t2 = Date.now();
  let parsed;
  try {
    parsed = JSON.parse(convertData(envelope.data, `${time}${JM_SECRET}`));
  } catch (e) {
    return { query, error: `decrypt: ${e.message}`, netMs: tNet };
  }
  const tDec = Date.now() - t2;
  const content = Array.isArray(parsed.content) ? parsed.content : [];
  return {
    query,
    netMs: tNet,
    jsonMs: tJson,
    decryptMs: tDec,
    totalMs: Date.now() - t0,
    total: parsed.total,
    count: content.length,
    first: content.slice(0, 2).map((c) => `${c.id}:${String(c.name).slice(0, 16)}`),
  };
}

(async () => {
  const time = Math.floor(Date.now() / 1000);
  const hosts = [process.argv[2] || (await (async () => {
    const buf = await curlGet(DOMAIN_URL, { 'User-Agent': 'Mozilla/5.0' });
    if (!buf) return FALLBACK[0];
    try {
      const json = JSON.parse(convertData(buf.toString('utf8'), DOMAIN_SECRET));
      return (json.Server && json.Server[0]) || FALLBACK[0];
    } catch { return FALLBACK[0]; }
  })())];
  for (const h of FALLBACK) if (!hosts.includes(h)) hosts.push(h);

  let ok = false;
  for (const candidate of hosts) {
    global.HOST = candidate;
    const r = await timedSearch('测试', time);
    if (!r.error) { console.log(`用域名：${candidate}\n`); ok = true; break; }
    console.log(`（${candidate} 不可用：${r.error}）`);
  }
  if (!ok) { console.log('SKIPPED — 所有域名不可达。'); return; }

  // 关键词用站内的普通标签词，避免任何具体成人内容。
  const queries = ['無修正', '巨乳', '同人', '校服', '短篇'];
  console.log('搜索端到端耗时（不含 QuickJS 桥 / DB 入库）：\n');
  console.log('  query        总耗时   网络   信封JSON  解密    total   条数  ');
  const rows = [];
  for (const q of queries) {
    const r = await timedSearch(q, time);
    rows.push(r);
    if (r.error) { console.log(`  ${q.padEnd(10)} ERROR: ${r.error}`); continue; }
    console.log(
      `  ${q.padEnd(11)} ${String(r.totalMs + 'ms').padStart(6)} ` +
      `${String(r.netMs + 'ms').padStart(7)} ${String(r.jsonMs + 'ms').padStart(8)} ` +
      `${String(r.decryptMs + 'ms').padStart(6)} ${String(r.total).padStart(7)} ${String(r.count).padStart(5)}`,
    );
  }

  const good = rows.filter((r) => !r.error);
  if (good.length) {
    const avg = Math.round(good.reduce((s, r) => s + r.totalMs, 0) / good.length);
    console.log('');
    console.log(`  平均端到端：${avg}ms（样本 ${good.length}）`);
    console.log(
      avg > 1500
        ? '  ⇒ 源站本身就要 1.5s 以上：宿主无法把它变快，只能把等待做成**可见的**（空白 + 转圈）。'
        : '  ⇒ 源站很快；若真机仍慢，继续查宿主侧开销（逐条入库、泵 tick、桥往返）。',
    );
  }
})();
