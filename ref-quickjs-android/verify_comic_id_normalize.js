#!/usr/bin/env node
/**
 * verify_comic_id_normalize.js —— 钉住 `JsMangaSource.normalizeComicId` 的规则。
 *
 * ### 为什么需要这个台子
 *
 * 这个方法一直是**台子盲区**（Node 侧测不到 private Kotlin 函数），却藏着一个会主动制造 bug 的
 * 启发式：早期实现是「不是裸 token ⇒ 提取第一个 3+ 位数字串」，本意是挽救 jm 那种把整段路径
 * 存进 `SManga.url` 的脏数据（`/album/544148/乗馬女子…`）。
 *
 * 直到 GoDa 出现 `…shenxunhuayiwanshenchong-<b>rp534295</b>` —— **合法路径里嵌着 6 位连续数字**：
 *   `/manga/kaiju…-rp534295`  →  DIGIT_RUN 命中  →  `534295`  →  `https://godamh.com534295`
 * 请求直接失效，而且看起来像「源的问题」。
 *
 * ### 这个台子怎么做到"读得到 Kotlin"
 *
 * 它**从 JsMangaSource.kt 源码里提取三个正则字面量**，并按源码中判定的**先后顺序**在 Node 里
 * 复刻决策。所以：
 *   • 谁改了正则字面量 / 调换了判定顺序，这个台子立刻红 —— 不是靠人记得同步；
 *   • 用例表本身就是"什么算合法 id"的可执行文档。
 *
 * ⚠️ 它仍然只是**等价复刻**：真正的 Kotlin 行为仍需 `:app:assembleDebug` 保证可编译。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KT = path.join(
  __dirname, '..', 'aniyomi', 'js-source', 'src', 'main', 'java',
  'eu', 'kanade', 'tachiyomi', 'source', 'manga', 'js', 'JsMangaSource.kt',
);

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const src = fs.readFileSync(KT, 'utf8');

/** 从 Kotlin 源码取 `val NAME = Regex("…")` 的正则字面量（Kotlin 转义 → JS 转义）。 */
function extractRegexLiteral(name) {
  const m = new RegExp('val ' + name + ' = Regex\\("((?:[^"\\\\]|\\\\.)*)"\\)').exec(src);
  if (!m) throw new Error('在 JsMangaSource.kt 里找不到 val ' + name + ' = Regex("…")');
  return m[1].replace(/\\\\/g, '\\');
}

const PLAIN_SRC = extractRegexLiteral('PLAIN_ID');
const PATH_SRC = extractRegexLiteral('PATH_LIKE_ID');
const DIGIT_SRC = extractRegexLiteral('DIGIT_RUN');

const PLAIN = new RegExp('^(?:' + PLAIN_SRC + ')$');       // Kotlin Regex.matches = 全串匹配
const PATHLIKE = new RegExp('^(?:' + PATH_SRC + ')$');
const DIGIT = new RegExp(DIGIT_SRC);                        // Kotlin Regex.find = 搜索

/** 与 `normalizeComicId` 等价的复刻（顺序必须与源码一致，见下面的顺序断言）。 */
function normalize(raw) {
  if (raw === '') return raw;
  if (raw.length <= 64 && PLAIN.test(raw)) return raw;
  if (PATHLIKE.test(raw)) return raw;
  const m = DIGIT.exec(raw);
  return m ? m[0] : raw;
}

/** 早期实现（没有 PATH_LIKE_ID 那一步）—— 只用于反例对照，证明这次修的是什么。 */
function legacyNormalize(raw) {
  if (raw === '') return raw;
  if (raw.length <= 64 && PLAIN.test(raw)) return raw;
  const m = DIGIT.exec(raw);
  return m ? m[0] : raw;
}

console.log('从 JsMangaSource.kt 提取到的正则：');
console.log('  PLAIN_ID     = ' + JSON.stringify(PLAIN_SRC));
console.log('  PATH_LIKE_ID = ' + JSON.stringify(PATH_SRC));
console.log('  DIGIT_RUN    = ' + JSON.stringify(DIGIT_SRC));

section('顺序契约：PATH_LIKE_ID 的判定必须排在 DIGIT_RUN 之前（这个顺序就是修复本身）');
const iPath = src.indexOf('PATH_LIKE_ID.matches(raw)');
const iDigit = src.indexOf('DIGIT_RUN.find(raw)');
check('源码里两处判定都存在', iPath > 0 && iDigit > 0, { iPath, iDigit });
check('★PATH_LIKE_ID.matches(raw) 出现在 DIGIT_RUN.find(raw) 之前',
  iPath > 0 && iDigit > 0 && iPath < iDigit, { iPath, iDigit });

section('用例表：合法 id 一律原样返回，只有真脏数据才被“回收”');
const KJ_SLUG = 'kaijuzhuanzhicaishenxunhuayiwanshenchong-rp534295';
const cases = [
  // [输入, 期望, 说明]
  ['544148', '544148', 'jm 的裸数字 id'],
  ['wuliandianfeng-pikapi', 'wuliandianfeng-pikapi', '裸 slug（列表页 href 去掉前缀的形态）'],
  ['/manga/wuliandianfeng-pikapi', '/manga/wuliandianfeng-pikapi', 'GoDa 正常路径'],
  ['/manga/' + KJ_SLUG, '/manga/' + KJ_SLUG, '★GoDa 路径 + slug 内 6 位连续数字（旧实现会毁掉它）'],
  [KJ_SLUG, KJ_SLUG, '★裸 slug（截图 21:43 那种历史数据）—— 必须原样，由源补 /manga/'],
  ['/album/544148/乗馬女子アスリート', '544148', 'jm 脏数据：路径被塞进 ?id=，含非 ASCII ⇒ 回收数字'],
  ['/album?id=544148', '544148', '含 ? / = ⇒ 不可能是合法路径 ⇒ 回收数字'],
  ['', '', '空串'],
];
for (const [input, expected, why] of cases) {
  check(`${why}: ${JSON.stringify(input).slice(0, 58)} → ${JSON.stringify(expected)}`,
    normalize(input) === expected, { got: normalize(input), expected });
}

section('反例对照：旧实现（缺少 PATH_LIKE_ID 一步）会怎么错');
const oldGot = legacyNormalize('/manga/' + KJ_SLUG);
check('★旧实现把 ' + KJ_SLUG + ' 这样的路径压成 "534295"（= https://godamh.com534295）',
  oldGot === '534295', oldGot);
check('新实现不再这样（同一个输入原样通过）', normalize('/manga/' + KJ_SLUG) === '/manga/' + KJ_SLUG);
check('而 jm 的脏数据在新实现下仍然被回收（修复没有牺牲原目标）',
  normalize('/album/544148/乗馬女子アスリート') === '544148');

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
