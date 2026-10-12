#!/usr/bin/env node
/**
 * probe_jm_search_repeat.js — 连续搜索的真实时延（区分「单次慢」与「越搜越慢」）。
 *
 * ### 为什么要重写而不是直接用 probe_jm_search_latency.js
 *
 * 1. **那个探针的 `time` 戳是循环外算一次**（`let time` 在 for 之外），于是同一个时间戳被复用于
 *    所有关键词。jm 的 `get()` 把 `Math.floor(Date.now()/1000)` 拼进 AES 密钥
 *    （`convertData(data, time + kJmSecret)`），真实使用时**每次搜索都是新戳**。复用一个戳会
 *    掩盖两件事：签名与时间的耦合，以及同戳命中缓存的可能。
 * 2. **它只测单次**。用户抱怨的是「搜索好慢」——真机是**连续输入**（边打边搜 / 换词重搜），
 *    慢的成因常常是每轮的固定开销 × 轮数，或者服务端对高频请求的限流，而不是单次往返。
 *
 * 本探针逐项测：
 *   • 每轮用**真实新戳**，记录单次时延与失败形态（限流 / 签名错 / 超时）
 *   • 连续 N 轮，观察**是否单调变慢**（连接复用失效、token 过期、源站限流）
 *   • 两轮之间的间隔，模拟真实打字节奏
 *
 * 判读：
 *   • 每轮都 ~600ms 且稳定 ⇒ 源站正常，App 里的等待另有来源（桥 / 入库 / UI），本探针只作对照。
 *   • 越到后面越慢或开始报错 ⇒ 源站对高频搜索限流，宿主该做**防抖 + 取消**，而不是等它变快。
 *
 * 跑法（需真网络）： node probe_jm_search_repeat.js [轮数] [间隔ms]
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

// 与 jm.js convertData 等价：AES-256-ECB(md5hex(secret))，无 padding，两端补位到 16 的倍数。
function convertData(input, secret) {
  const key = Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
  const data = Buffer.from(String(input).replace(/[\s﻿]/g, ''), 'base64');
  const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
  dec.setAutoPadding(false);
  let res = Buffer.concat([dec.update(data), dec.final()]).toString('utf8');
  let s = 0;
  while (s < res.length && res[s] !== '{' && res[s] !== '[') s++;
  let e = res.length - 1;
  while (e > s && res[e] !== '}' && res[e] !== ']') e--;
  return res.substring(s, e + 1);
}

function get(url, headers) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ error: 'bad url' }); return; }
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: headers || {},
        timeout: 25000, servername: u.hostname },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).toString(), headers));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // 源站按 Accept-Encoding 回 gzip；不解压的话 JSON.parse 必然失败（表现为 54 字节的信封）。
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          let body = raw;
          if (enc.includes('gzip')) { try { body = zlib.gunzipSync(raw); } catch { /* 保持原样 */ } }
          else if (enc.includes('deflate')) { try { body = zlib.inflateSync(raw); } catch { /* 同上 */ } }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

/** jm 的鉴权是 `token`(md5(time+key)) + `tokenparam` **两个独立头**，不是 Bearer。 */
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

/** 一轮完整搜索：每轮都取**当下**新戳（与 jm.js 的 Date.now() 语义一致）。 */
async function timedSearch(host, keyword) {
  const time = Math.floor(Date.now() / 1000);   // ← 每轮新戳，这是与旧探针的关键差别
  const kw = encodeURIComponent(keyword).replace(/%20/g, '+');
  const url = `https://${host}/search?search_query=${kw}&o=mr`;
  const t0 = Date.now();
  const res = await get(url, jmHeaders(time));
  const t1 = Date.now();
  if (res.error) return { error: res.error, ms: t1 - t0 };
  if (res.status !== 200) return { error: 'HTTP ' + res.status, ms: t1 - t0 };
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); }
  catch { return { error: 'envelope json parse failed', ms: t1 - t0 }; }
  if (!json || typeof json.data !== 'string') {
    return { error: 'Invalid Data (data 非字符串)', ms: t1 - t0, code: json && json.code };
  }
  const t2 = Date.now();
  let content;
  try { content = JSON.parse(convertData(json.data, `${time}${JM_SECRET}`)); }
  catch { return { error: 'decrypt/parse failed', ms: t1 - t0 }; }
  const t3 = Date.now();
  return {
    ms: t3 - t0, net: t2 - t0, decrypt: t3 - t2,
    total: content.total, count: (content.content || []).length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rounds = parseInt(process.argv[2] || '6', 10);
  const gap = parseInt(process.argv[3] || '0', 10);

  const hosts = [process.argv[4]].filter(Boolean);
  if (hosts.length === 0) {
    const r = await get(DOMAIN_URL, { 'User-Agent': 'Mozilla/5.0' });
    if (!r.error && r.status === 200) {
      try {
        for (const h of JSON.parse(convertData(r.body.toString('utf8'), DOMAIN_SECRET))) {
          if (!hosts.includes(h)) hosts.push(h);
        }
      } catch { /* 域名发现失败不是本次要测的东西 */ }
    }
    for (const h of FALLBACK) if (!hosts.includes(h)) hosts.push(h);
  }

  let host = null;
  for (const candidate of hosts) {
    const r = await timedSearch(candidate, '测试');
    if (!r.error) { host = candidate; break; }
  }
  if (!host) { console.log('SKIPPED — 所有域名不可达。'); return; }
  console.log(`用域名：${host}   轮数：${rounds}   间隔：${gap}ms   （每轮使用当下新戳）\n`);

  // 模拟真实打字：同一关键词前缀逐步变长 + 换词，最贴近「边打边搜」。
  const words = ['女', '女神', '女神的', '女神的露', '女神的露天', '女神的露天温', '無修正', '巨乳', '同人'];
  console.log('  轮  关键词        总耗时   网络   解密    total  条数  备注');
  console.log('  ' + '-'.repeat(72));

  const results = [];
  for (let i = 0; i < rounds; i++) {
    const q = words[i % words.length];
    const r = await timedSearch(host, q);
    results.push({ q, ...r });
    if (r.error) {
      console.log(`  ${String(i + 1).padStart(2)}  ${q.padEnd(12)} ${String(r.ms).padStart(5)}ms  ${' '.repeat(6)}  ${' '.repeat(6)}  ${' '.repeat(6)}  ✗ ${r.error}`);
    } else {
      console.log(`  ${String(i + 1).padStart(2)}  ${q.padEnd(12)} ${String(r.ms).padStart(5)}ms  ${String(r.net).padStart(5)}ms  ${String(r.decrypt).padStart(4)}ms  ${String(r.total).padStart(6)}  ${String(r.count).padStart(4)}`);
    }
    if (gap > 0) await sleep(gap);
  }

  const good = results.filter((r) => !r.error);
  const errs = results.filter((r) => r.error);
  const avg = good.length ? Math.round(good.reduce((a, b) => a + b.ms, 0) / good.length) : 0;
  const first = good[0] ? good[0].ms : 0;
  const last = good.length > 1 ? good[good.length - 1].ms : 0;

  console.log('\n  ' + '-'.repeat(72));
  console.log(`  成功 ${good.length}/${rounds}   平均 ${avg}ms   首轮 ${first}ms   末轮 ${last}ms`);
  if (errs.length) {
    console.log(`  ⚠️ 失败 ${errs.length} 轮：${[...new Set(errs.map((e) => e.error))].join(' / ')}`);
    console.log('     ⇒ 源站对高频/连续搜索有约束（限流或签名时效），宿主该做**防抖 + 取消旧请求**。');
  }
  if (good.length > 2 && last > first * 2 && last > first + 500) {
    console.log('  ⚠️ 越搜越慢（末轮 > 首轮 2 倍）⇒ 不是单次往返的问题，排查连接复用/源站限流/本地队列堆积。');
  }
  console.log(`\n  ⇒ 源站单次 ${avg}ms。若真机明显更慢，本探针只作对照，差距在宿主侧（QuickJS 桥往返 /`);
  console.log('    逐条入库 / UI 重组），应改用 probe_fetch_and_ui.js 与 JankStats 量帧。');
}

main();
