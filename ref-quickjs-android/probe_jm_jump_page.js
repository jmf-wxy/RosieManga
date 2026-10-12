#!/usr/bin/env node
/**
 * probe_jm_jump_page.js — 复现「跳转到指定页数时一直转圈」的源站侧行为。
 *
 * 场景：浏览页手动跳页（第 125 / 125 页）。宿主把 `page=N` 交给
 * `categoryComics.load(cat, param, [o], page)` → jm.js 拼
 * `/categories/filter?o=<o>&c=<param>&page=<page>`。
 *
 * 本探针逐页实测：第 1 / 2 / 中段 / 末页(125) / 超界(130) 的
 * 端到端时延、HTTP 状态、解密后 total / content 条数 / 推导 maxPage。
 *
 * 判读：
 *   • 各页都 <1s 正常返回 ⇒ 源站无碍，「一直转圈」在宿主侧（桥/并发/取消），继续查宿主。
 *   • 高页码显著变慢 / 挂起 / 返回异常形态 ⇒ 源站行为问题，宿主按形态处理。
 *
 * 跑法（需真网络）： node probe_jm_jump_page.js [起始域名(可选)]
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

/** 与 jm.js categoryComics.load 同一请求：/categories/filter?o=<o>&c=<c>&page=<page> */
async function timedCategory(host, c, o, page) {
  const time = Math.floor(Date.now() / 1000);
  const url = `https://${host}/categories/filter?o=${o}&c=${c}&page=${page}`;
  const t0 = Date.now();
  const res = await get(url, jmHeaders(time));
  const t1 = Date.now();
  if (res.error) return { error: res.error, ms: t1 - t0 };
  if (res.status !== 200) return { error: 'HTTP ' + res.status, ms: t1 - t0, bytes: res.body.length };
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); }
  catch { return { error: `envelope parse failed (${res.body.length}B, 前40: ${res.body.toString('utf8', 0, 40).replace(/\n/g, ' ')})`, ms: t1 - t0 }; }
  if (!json || typeof json.data !== 'string') {
    return { error: 'Invalid Data (data 非字符串)', ms: t1 - t0, code: json && json.code };
  }
  let content;
  try { content = JSON.parse(convertData(json.data, `${time}${JM_SECRET}`)); }
  catch { return { error: 'decrypt/parse failed', ms: t1 - t0 }; }
  return {
    ms: t1 - t0,
    total: content.total,
    count: (content.content || []).length,
    maxPage: content.total != null ? Math.ceil(content.total / 80) : null,
    firstId: content.content && content.content[0] && (content.content[0].id ?? content.content[0].aid),
  };
}

async function main() {
  const hosts = [process.argv[2]].filter(Boolean);
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
    const r = await timedCategory(candidate, '0', 'mr', 1);
    if (!r.error) { host = candidate; break; }
  }
  if (!host) { console.log('SKIPPED — 所有域名不可达。'); return; }
  console.log(`用域名：${host}   （最近更新 = /categories/filter?o=mr&c=0&page=N）\n`);
  console.log('  页码   总耗时    total   条数  推导maxPage  首条id   备注');
  console.log('  ' + '-'.repeat(78));

  for (const page of [1, 2, 60, 124, 125, 130]) {
    const r = await timedCategory(host, '0', 'mr', page);
    if (r.error) {
      console.log(`  ${String(page).padStart(4)}  ${String(r.ms).padStart(6)}ms  ${' '.repeat(7)}  ${' '.repeat(5)}  ${' '.repeat(10)}  ✗ ${r.error}`);
    } else {
      console.log(
        `  ${String(page).padStart(4)}  ${String(r.ms).padStart(6)}ms  ${String(r.total).padStart(6)}  ` +
        `${String(r.count).padStart(4)}  ${String(r.maxPage).padStart(10)}  ${String(r.firstId ?? '-').padStart(8)}`,
      );
    }
  }
  console.log('\n  ⇒ 若各页都秒回：源站无碍，「一直转圈」出在宿主（桥/并发/取消路径）。');
  console.log('  ⇒ 若某页明显变慢或挂起：该页码本身就是触发条件，把形态带回宿主处理。');
}

main();
