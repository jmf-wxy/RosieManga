#!/usr/bin/env node
/**
 * LIVE PROBE — 「热门」与「最近更新」当前用的端点，返回的到底是不是同一批？
 *
 * 真机现象：JS 源浏览页「热门」与「最近更新」两个 tab 显示**完全一样**的内容，
 * 期望「热门」显示**总排行**。
 *
 * 当前宿主实现（JsMangaSource.kt）：
 *   热门     → categoryComics.ranking.load(popularRankingOption())  → /categories/filter?o=mv_m&c=0&page=N
 *   最近更新 → categoryComics.load("最新A漫","0",[defaultSort])      → /categories/filter?o=mr&c=0&page=N
 *
 * 本 probe 回答三个问题：
 *   1. o=mr&c=0 与 o=mv_m&c=0 的**第 1 页 id 集合是否相同**？（若相同 → 端点层面的锅）
 *   2. 服务端对 c=0 是否**忽略 o 参数**？（对比 o=mr / o=mv_m / o=mv / o=mv_w 四档）
 *   3. 加 `&page=2` 后内容是否变化？（判断 c=0 是否真的可分页）
 *
 * 跑法（需真网络）： node probe_jm_popular_latest_distinct.js [host]
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

function gunzipMaybe(buf, encoding) {
  try {
    if ((encoding || '').includes('gzip')) return zlib.gunzipSync(buf);
    if ((encoding || '').includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch { /* fallthrough */ }
  return buf;
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
    'X-Requested-With': JM_PKG,
    Authorization: 'Bearer',
    token,
    tokenparam: `${time},${JM_VERSION}`,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  };
}

async function probe(label, path, time) {
  const url = `https://${global.HOST}${path}`;
  const buf = await curlGet(url, jmHeaders(time));
  const out = { label, path };
  if (!buf) { out.error = 'request failed'; return out; }
  let envelope;
  try {
    envelope = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    out.error = `envelope JSON.parse: ${e.message} (${buf.toString('utf8').slice(0, 80)})`;
    return out;
  }
  if (typeof envelope.data !== 'string') { out.error = `envelope.data is ${typeof envelope.data}`; return out; }
  try {
    const parsed = JSON.parse(convertData(envelope.data, `${time}${JM_SECRET}`));
    out.total = parsed.total;
    let content = [];
    if (Array.isArray(parsed)) {
      out.shape = 'array';
      content = parsed.flatMap((s) => (Array.isArray(s && s.content) ? s.content : []));
    } else {
      out.shape = `{${Object.keys(parsed).slice(0, 4).join(',')}}`;
      content = Array.isArray(parsed.content) ? parsed.content
        : Array.isArray(parsed.list) ? parsed.list : [];
    }
    out.count = content.length;
    out.ids = content.map((c) => String(c.id));
    out.head = content.slice(0, 3).map((c) => `${c.id}:${String(c.name).slice(0, 14)}`);
  } catch (e) {
    out.error = `decrypt/parse: ${e.message}`;
  }
  return out;
}

function overlap(a, b) {
  if (!a || !b || !a.length || !b.length) return null;
  const setB = new Set(b);
  const hit = a.filter((x) => setB.has(x)).length;
  return hit / Math.max(a.length, b.length);
}

(async () => {
  const time = Math.floor(Date.now() / 1000);
  const hosts = [await discoverHost()];
  for (const h of FALLBACK) if (!hosts.includes(h)) hosts.push(h);

  let ok = false;
  for (const candidate of hosts) {
    global.HOST = candidate;
    const t = await probe('probe', '/promote?page=0', time);
    if (!t.error) { console.log(`用域名：${candidate}\n`); ok = true; break; }
    console.log(`（${candidate} 不可用：${t.error}）`);
  }
  if (!ok) { console.log('\nSKIPPED — 所有域名不可达。'); return; }

  const cases = [
    ['最新 (o=mr  c=0 p1)  ← 现在「最近更新」', '/categories/filter?o=mr&c=0&page=1'],
    ['月排 (o=mv_m c=0 p1) ← 现在「热门」    ', '/categories/filter?o=mv_m&c=0&page=1'],
    ['总排 (o=mv  c=0 p1)  ← 期望「热门」    ', '/categories/filter?o=mv&c=0&page=1'],
    ['週排 (o=mv_w c=0 p1)                   ', '/categories/filter?o=mv_w&c=0&page=1'],
    ['日排 (o=mv_t c=0 p1)                   ', '/categories/filter?o=mv_t&c=0&page=1'],
    ['最新 (o=mr  c=0 p2)  ← 分页是否推进    ', '/categories/filter?o=mr&c=0&page=2'],
    ['总排 (o=mv  c=0 p2)  ← 分页是否推进    ', '/categories/filter?o=mv&c=0&page=2'],
    // ★ 决定性：宿主当前把**整串 label**（含「-月排行」文本）当 o= 发出去了。
    ['★宿主现状 (o=mv_m-月排行 带label)      ', '/categories/filter?o=mv_m-月排行&c=0&page=1'],
    ['★宿主现状 (o=mr-最新 带label)          ', '/categories/filter?o=mr-最新&c=0&page=1'],
    ['★宿主现状 (o=mv-總排行 带label)        ', '/categories/filter?o=mv-總排行&c=0&page=1'],
    ['★对照 (o=__bogus__ 非法值)             ', '/categories/filter?o=__bogus__&c=0&page=1'],
  ];

  const res = [];
  for (const [label, path] of cases) {
    const r = await probe(label.trim(), path, time);
    res.push(r);
    if (r.error) {
      console.log(`  ${label}  ERROR: ${r.error}`);
    } else {
      console.log(`  ${label}  total=${r.total} count=${r.count}`);
      console.log(`      head=${JSON.stringify(r.head)}`);
    }
  }
  console.log('');

  const by = (frag) => res.find((r) => r.label.includes(frag));
  const mr1 = by('o=mr  c=0 p1'), mvm1 = by('o=mv_m c=0 p1'), mv1 = by('o=mv  c=0 p1');
  const mr2 = by('o=mr  c=0 p2'), mv2 = by('o=mv  c=0 p2');

  console.log('RESULT:');
  const o1 = overlap(mr1 && mr1.ids, mvm1 && mvm1.ids);
  console.log(`  ① 最新(mr p1) vs 月排(mv_m p1) 重叠率 = ${o1 === null ? 'n/a' : (o1 * 100).toFixed(1) + '%'}` +
    `  ${o1 !== null ? (o1 >= 0.9 ? '⇒ ⚠️ 两 tab 看起来一样（端点重合）' : '⇒ ✔ 本来应可区分') : ''}`);
  const o2 = overlap(mr1 && mr1.ids, mv1 && mv1.ids);
  console.log(`  ② 最新(mr p1) vs 总排(mv   p1) 重叠率 = ${o2 === null ? 'n/a' : (o2 * 100).toFixed(1) + '%'}`);
  const o3 = overlap(mvm1 && mvm1.ids, mv1 && mv1.ids);
  console.log(`  ③ 月排(mv_m) vs 总排(mv)    重叠率 = ${o3 === null ? 'n/a' : (o3 * 100).toFixed(1) + '%'}`);
  const o4 = overlap(mr1 && mr1.ids, mr2 && mr2.ids);
  console.log(`  ④ 最新 p1 vs 最新 p2        重叠率 = ${o4 === null ? 'n/a' : (o4 * 100).toFixed(1) + '%'}` +
    `  ${o4 !== null ? (o4 >= 0.9 ? '⇒ ⚠️ c=0 不可分页/页码被忽略' : '⇒ ✔ 可分页') : ''}`);
  const o5 = overlap(mv1 && mv1.ids, mv2 && mv2.ids);
  console.log(`  ⑤ 总排 p1 vs 总排 p2        重叠率 = ${o5 === null ? 'n/a' : (o5 * 100).toFixed(1) + '%'}`);

  console.log('');
  console.log('★ 宿主现状（整串 label 当 o= 发出去）与谁等价：');
  const lbl = (frag) => res.find((r) => r.label.includes(frag));
  const pairs = [
    ['o=mv_m-月排行 (现状「热门」)', lbl('o=mv_m-月排行 带label')],
    ['o=mr-最新     (现状排序带label)', lbl('o=mr-最新 带label')],
    ['o=mv-總排行   (带label)', lbl('o=mv-總排行 带label')],
    ['o=__bogus__   (非法值对照)', lbl('o=__bogus__ 非法值')],
  ];
  for (const [name, r] of pairs) {
    if (!r || r.error) { console.log(`  ${name}: ERROR ${r && r.error}`); continue; }
    const vsMr = overlap(r.ids, mr1 && mr1.ids);
    const vsMvm = overlap(r.ids, mvm1 && mvm1.ids);
    const vsMv = overlap(r.ids, mv1 && mv1.ids);
    console.log(`  ${name}  total=${r.total}` +
      `  vs最新(mr)=${vsMr === null ? 'n/a' : (vsMr * 100).toFixed(1) + '%'}` +
      `  vs月排=${vsMvm === null ? 'n/a' : (vsMvm * 100).toFixed(1) + '%'}` +
      `  vs总排=${vsMv === null ? 'n/a' : (vsMv * 100).toFixed(1) + '%'}`);
    console.log(`      head=${JSON.stringify(r.head)}`);
  }
  const cur = lbl('o=mv_m-月排行 带label');
  if (cur && cur.ids && mr1 && mr1.ids) {
    const same = overlap(cur.ids, mr1.ids);
    console.log('');
    console.log(same >= 0.9
      ? '  ⇒ 根因确认：带 label 的 o= 被服务端忽略/回落，返回的就是「最新」那一批 ⇒ 两个 tab 必然看起来一样。'
      : '  ⇒ 未复现等价，需要再看 head 判断。');
  }
})();
