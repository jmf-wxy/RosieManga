#!/usr/bin/env node
/**
 * probe_goda_lists.js — **站点事实探针**：godamh.com 到底有几条列表、它们各自是什么排序。
 *
 * 起因：用户报「GoDa漫画 浏览页里 热门 / 最近更新 / 筛选 显示的是同一批数据」。
 * 在动源之前必须先知道站点给了哪几条列表 —— 否则只能猜（猜错就是上一次 jm 的教训）。
 *
 * ### 结论（2026-10-10 实测，`node probe_goda_lists.js`）
 *
 * 站点只有 **四条** 列表路径，全部是同一套骨架 `<path>/page/<n>` + 卡片 `.pb-2`
 * + 末位分页按钮 = 总页数（100）：
 *
 *  | path        | 首页分区标题 | 抽样内容（页 1 前 3）                      |
 *  |-------------|--------------|--------------------------------------------|
 *  | `/hots`     | 人氣排行      | 武炼巅峰 / 我独自升级 / 大王饶命            |
 *  | `/dayup`    | 熱門更新      | 被追放的转生重骑士 / 满级玩家的第100次回归   |
 *  | `/newss`    | 最新上架      | 八女帝全背叛 / 万倍返还 / 反派大人          |
 *  | `/manga`    | （全部）      | 武炼巅峰 / 我独自升级 / 大王饶命            |
 *
 * ⚠️ 两条**镜像**（本探针逐 id 比对，不是看前几个像不像）：
 *   • `/manga`  ≡ `/hots`          —— 「全部」默认顺序就是人气排行；
 *   • `/manga-genre/hots` ≡ `/dayup` —— 类型里的「热门漫画」是「熱門更新」的同一份。
 *
 * 所以「站点其实只有三份排序」。源能做、也必须做的，是把三个入口指到**语义正确的那条 path**：
 *   • 热门     → `/hots`（人氣排行）
 *   • 最近更新 → `/dayup`（熱門更新）
 *   • 筛选     → 类型 `/manga-genre/*`、标签 `/manga-tag/*`（这些都各自不同）
 *
 * 其它路径（`/updates` `/latest` `/recent` `/new` `/hot` `/rank` `/top`）全是 **404**，
 * 站点没有查询参数排序（页面里没有任何 `?sort=` / `?o=` 链接）。
 *
 * 抓下来的页 1 存进 `samples/`（`goda_list_hots.html` …）供 `verify_goda_hot_latest_e2e.js` 回放。
 */

'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://godamh.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const PATHS = ['hots', 'dayup', 'newss', 'manga'];
const PAGES = [1, 2];
const OUT_DIR = path.join(__dirname, 'samples');

/** 只取卡片链接（`/manga/<slug>`），跳过分页链接（`/hots/page/3` 之类）。 */
function comicIds(html) {
  const out = [];
  const re = /href="(\/manga\/[^"?#]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    // ⚠️ `/manga` 自己的分页链接就是 `/manga/page/N` —— 不排掉会把「全部」页的条数虚增 7 条，
    // 于是「/manga 与 /hots 是不是同一份」永远比不出 100%。
    if (m[1].startsWith('/manga/page/')) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function titles(html) {
  const out = [];
  const re = /<h3[^>]*>([\s\S]{0,200}?)<\/h3>/g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[1].replace(/<[^>]+>/g, '').trim();
    if (t) out.push(t);
  }
  return out;
}

function maxPageButton(html) {
  const re = /<button[^>]*class="[^"]*text-small[^"]*"[^>]*>([\s\S]{0,120}?)<\/button>/g;
  const hits = [];
  let m;
  while ((m = re.exec(html))) hits.push(m[1].replace(/<[^>]+>/g, '').trim());
  return hits.length ? hits[hits.length - 1] : null;
}

async function get(p) {
  const res = await fetch(BASE + p, { headers: { 'User-Agent': UA, Referer: BASE } });
  return { status: res.status, body: await res.text() };
}

async function main() {
  const store = {};
  for (const name of PATHS) {
    for (const page of PAGES) {
      const url = `/${name}${page > 1 ? '/page/' + page : ''}`;
      const res = await get(url);
      if (res.status !== 200) {
        console.log(`${url.padEnd(18)} -> ${res.status}`);
        store[`${name}:${page}`] = null;
        continue;
      }
      const ids = comicIds(res.body);
      console.log(
        `${url.padEnd(18)} -> 200  ${String(res.body.length).padStart(6)}B  ids=${String(ids.length).padStart(2)}  ` +
          `maxPageBtn=${String(maxPageButton(res.body)).padStart(3)}  ${titles(res.body).slice(0, 3).join(' / ')}`,
      );
      store[`${name}:${page}`] = ids;
      // 页 1 / 页 2 都落盘：页 2 是「分页是否真的前进」的证据，
      // samples 里的静态文件就是 verify_goda_hot_latest_e2e.js 回放用的全部素材。
      fs.writeFileSync(path.join(OUT_DIR, `goda_list_${name}${page > 1 ? '_p2' : ''}.html`), res.body, 'utf8');
    }
  }

  console.log('\n--- 页1 两两重合（id 集合）---');
  const names = PATHS.filter((n) => store[`${n}:1`]);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = new Set(store[`${names[i]}:1`]);
      const b = store[`${names[j]}:1`];
      const same = b.filter((x) => a.has(x)).length;
      const ratio = b.length ? same / b.length : 0;
      console.log(
        `/${names[i]} vs /${names[j]}: ${same}/${b.length} = ${(ratio * 100).toFixed(0)}%` +
          (ratio === 1 ? '   ⚠️ 完全同一份' : ''),
      );
    }
  }

  console.log('\n--- 页1 vs 页2（是否真的翻页）---');
  for (const n of names) {
    const a = new Set(store[`${n}:1`] || []);
    const b = store[`${n}:2`] || [];
    const same = b.filter((x) => a.has(x)).length;
    console.log(`/${n}: 页2 与页1 重合 ${same}/${b.length}` + (same === 0 ? '   ✓ 已翻页' : '   ⚠️'));
  }

  console.log('\n--- 类型 / 标签页抽样 ---');
  for (const p of ['/manga-genre/kr', '/manga-genre/hots', '/manga-genre/cn', '/manga-tag/fuchou']) {
    const res = await get(p);
    console.log(`${p.padEnd(20)} -> ${res.status}  ${titles(res.body).slice(0, 3).join(' / ')}`);
    if (res.status === 200) {
      // 筛选的两条快照一并落盘（韩漫 / 复仇标签）——verify 要证明「筛选」真的换了一批数据。
      if (p === '/manga-genre/kr') fs.writeFileSync(path.join(OUT_DIR, 'goda_list_genre_kr.html'), res.body, 'utf8');
      if (p === '/manga-tag/fuchou') fs.writeFileSync(path.join(OUT_DIR, 'goda_list_tag_fuchou.html'), res.body, 'utf8');
      const ids = comicIds(res.body);
      const dayup = new Set(store['dayup:1'] || []);
      const hots = new Set(store['hots:1'] || []);
      console.log(
        `${' '.repeat(20)}    ids=${ids.length}  vs /dayup=${ids.filter((x) => dayup.has(x)).length}` +
          `  vs /hots=${ids.filter((x) => hots.has(x)).length}`,
      );
    }
  }

  console.log('\n--- 不存在的排序路径（预期 404）---');
  for (const p of ['/updates', '/latest', '/recent', '/new', '/hot', '/rank', '/top']) {
    const res = await get(p);
    console.log(`${p.padEnd(12)} -> ${res.status}`);
  }
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
