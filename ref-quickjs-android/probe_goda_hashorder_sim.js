#!/usr/bin/env node
/**
 * probe_goda_hashorder_sim.js —— 判定设备上看到的章节顺序是否 = Java HashMap 哈希序。
 *
 * 假设：设备跑的 goda.js 把 `chapters` 建成了普通对象 `{}`（而非 JS `Map`），
 * 于是跨桥时走 QuickJSObject.toMap（mapCreator = HashMap::new），迭代顺序 = 哈希序。
 * 本脚本模拟 Java HashMap 的迭代顺序，和截图逐条比对 → 命中则归因确定。
 *
 * Java HashMap 迭代顺序模拟要点（JDK8）：
 *   hash   = h ^ (h >>> 16)   （String.hashCode 再扰动）
 *   bucket = (table.length - 1) & hash
 *   迭代   = 桶索引升序，桶内按链表插入顺序
 *   扩容   = 容量翻倍 + 链表 split（lo/hi 各保持相对顺序）——等价于按新容量重算索引
 */
const MID = process.argv[2] || '12';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  Referer: 'https://godamh.com/',
};

/** Java String.hashCode：s[0]*31^(n-1) + ... + s[n-1]，32 位有符号 */
function javaStringHashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
/** HashMap.hash(key) = h ^ (h >>> 16) */
function spread(h) {
  return ((h ^ (h >>> 16)) | 0) >>> 0;
}

/** 模拟 HashMap 的桶数组演化，返回最终迭代顺序（不含树化，桶长≥8 会被标记） */
function javaHashMapIterationOrder(keys) {
  const LF = 0.75;
  let cap = 16;
  let entries = []; // {hash, key, value}
  for (const k of keys) {
    if (entries.length + 1 > cap * LF) cap *= 2;
    entries.push({ hash: spread(javaStringHashCode(k)), key: k });
  }
  const table = Array.from({ length: cap }, () => []);
  for (const e of entries) {
    const idx = (cap - 1) & e.hash;
    table[idx].push(e);
  }
  const order = [];
  let maxChain = 0;
  for (let i = 0; i < cap; i++) {
    if (table[i].length > maxChain) maxChain = table[i].length;
    for (const e of table[i]) order.push({ ...e, bucket: i });
  }
  return { order, cap, maxChain };
}

(async () => {
  const url = `https://v2.apikk.top/api/v2/manga/get?mid=${MID}&mode=all&t=${Date.now()}`;
  const body = await (await fetch(url, { headers: HEADERS })).text();
  const chapters = JSON.parse(body).data.chapters;
  console.log(`站点章节数 = ${chapters.length}`);

  // 站点本身是 order 升序（旧→新）。普通对象 + Java HashMap 会把顺序搅乱。
  const keys = chapters.map((c) => `${MID}@${c.id}`);
  const titleOf = new Map(chapters.map((c) => [`${MID}@${c.id}`, c.attributes.title]));

  const { order, cap, maxChain } = javaHashMapIterationOrder(keys);
  console.log(`模拟 HashMap：最终容量 ${cap}，最长桶 ${maxChain}（≥8 会被树化，模拟精度下降）`);
  console.log(`迭代顺序条数 = ${order.length}（应等于章节数，若不等说明 key 有重复）`);

  // 截图（宿主 asReversed 之后）顶部 6 条，反推 HashMap 迭代顺序的末尾 6 条
  const screenshotTop = [
    '867 你想成为星图师?',
    '2009 上古秘境篇-成为我的人吧',
    '2007 上古秘境篇-青与蝶',
    '大决战篇-绝杀',
    '3032 黑域篇-红颜一怒',
    '3031 黑域篇-义不容辞',
  ];

  console.log(`\n-- 模拟 HashMap 迭代顺序的末尾 10 条（宿主 asReversed 后会出现在最顶上）--`);
  order.slice(-10).reverse().forEach((e, i) => {
    console.log(`  ${i < 6 ? '→' : ' '} bucket=${e.bucket}  ${titleOf.get(e.key)}`);
  });

  const shown = order.slice(-6).reverse().map((e) => titleOf.get(e.key));
  console.log(`\n== 与截图顶部逐条比对 ==`);
  let hit = 0;
  for (let i = 0; i < 6; i++) {
    const ok = shown[i] === screenshotTop[i];
    if (ok) hit++;
    console.log(`  [${ok ? '命中' : '不符'}] 模拟=${JSON.stringify(shown[i])}  截图=${JSON.stringify(screenshotTop[i])}`);
  }
  console.log(`\n结论：${hit}/6 命中 ⇒ ${hit >= 5 ? '截图顺序 = Java HashMap 哈希序（设备跑的是「普通对象」版源）' : '不是哈希序，需另找根因'}`);
})();
