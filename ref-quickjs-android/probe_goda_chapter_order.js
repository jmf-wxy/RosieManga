#!/usr/bin/env node
/**
 * probe_goda_chapter_order.js —— 真抓 GoDa API，回答一个问题：
 *   「站点返回的 chapters 数组本身是什么顺序？order 字段与数组下标是否单调？」
 *
 * 背景：详情页章节排序在设备上不符合预期（期望「新→旧」自顶向下）。
 *   宿主 JsMangaSource.getChapterList 会把源返回的顺序当作「旧→新」并 asReversed()，
 *   所以源必须交付「旧→新」。本探针只观测站点事实，不改产品代码。
 *
 * 用法：node probe_goda_chapter_order.js [mid=12] [漫画名]
 */
const MID = process.argv[2] || '12';
const NAME = process.argv[3] || '武炼巅峰';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  Referer: 'https://godamh.com/',
};

function line(s = '') { console.log(s); }
function isMonotonic(arr, keyFn, dir) {
  for (let i = 1; i < arr.length; i++) {
    const a = keyFn(arr[i - 1]);
    const b = keyFn(arr[i]);
    if (a == null || b == null) continue;
    if (dir > 0 ? a > b : a < b) return false;
  }
  return true;
}

(async () => {
  const url = `https://v2.apikk.top/api/v2/manga/get?mid=${MID}&mode=all&t=${Date.now()}`;
  line(`GET ${url}`);
  const res = await fetch(url, { headers: HEADERS });
  line(`status=${res.status} content-type=${res.headers.get('content-type')}`);
  const body = await res.text();
  line(`raw bytes = ${Buffer.byteLength(body, 'utf8')}`);
  let json;
  try { json = JSON.parse(body); } catch (e) {
    line(`JSON 解析失败：${e.message}`);
    line(body.slice(0, 300));
    process.exit(1);
  }
  const chapters = json?.data?.chapters;
  if (!Array.isArray(chapters)) {
    line(`chapters 不是数组：${JSON.stringify(chapters)?.slice(0, 200)}`);
    process.exit(1);
  }
  line(`\n【${NAME}】mid=${MID}  共 ${chapters.length} 章`);

  const attrs = chapters.map((c) => ({
    id: c?.id,
    order: c?.attributes?.order,
    title: c?.attributes?.title,
  }));

  line(`\n-- 数组前 8 条（站点原始顺序）--`);
  attrs.slice(0, 8).forEach((a, i) => line(`  [${i}] order=${a.order}  id=${a.id}  ${a.title}`));
  line(`-- 数组后 8 条 --`);
  attrs.slice(-8).forEach((a, i) => line(`  [${attrs.length - 8 + i}] order=${a.order}  id=${a.id}  ${a.title}`));

  const orders = attrs.map((a) => a.order).filter((o) => typeof o === 'number');
  line(`\norder 数值范围：min=${Math.min(...orders)}  max=${Math.max(...orders)}  缺失=${attrs.length - orders.length}`);
  line(`数组顺序本身是 order 升序？ ${isMonotonic(attrs, (a) => a.order, +1)}`);
  line(`数组顺序本身是 order 降序？ ${isMonotonic(attrs, (a) => a.order, -1)}`);

  // 标题里的数字与 order 是否同步（goda 的 title 常形如「867 你想成为星图师?」）
  const withNum = attrs.filter((a) => /^\d+/.test(String(a.title || '')));
  line(`标题以数字开头的条目：${withNum.length}/${attrs.length}`);
  if (withNum.length >= 4) {
    line('  前 4 条标题数字 vs order：');
    withNum.slice(0, 4).forEach((a) => line(`    titleNum=${/^(\d+)/.exec(a.title)[1]}  order=${a.order}`));
    const tn = withNum.map((a) => Number(/^(\d+)/.exec(a.title)[1]));
    line(`  标题数字升序？ ${tn.every((v, i) => i === 0 || tn[i - 1] <= v)}`);
    line(`  标题数字降序？ ${tn.every((v, i) => i === 0 || tn[i - 1] >= v)}`);
  }

  // 若源做「order 升序」排序后，宿主 asReversed() 的顶端会是哪几条
  const asc = attrs.slice().sort((a, b) => ((a.order ?? 0) - (b.order ?? 0)));
  line(`\n-- 按 order 升序排序后，末尾 6 条（= 宿主反转后显示在最顶上）--`);
  asc.slice(-6).reverse().forEach((a) => line(`  order=${a.order}  ${a.title}`));
  line(`-- 按 order 升序排序后，开头 3 条（= 显示在最底部）--`);
  asc.slice(0, 3).forEach((a) => line(`  order=${a.order}  ${a.title}`));
})();
