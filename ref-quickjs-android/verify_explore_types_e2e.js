#!/usr/bin/env node
/**
 * verify_explore_types_e2e.js — Venera 的三种 explore 类型**各有各的调用约定**，宿主不能一把梭。
 *
 * ### 真实根因
 *
 * 宿主过去对所有类型都发 `explore[0].load(page - 1)`。而 Venera 自己的
 * `lib/foundation/comic_source/parser.dart` 是分开处理的：
 *
 * | type                  | Venera 调用      | 页码基数    | 返回                          | 有分页 |
 * |-----------------------|-----------------|------------|-------------------------------|-------|
 * | `multiPartPage`       | `load()`        | —          | `[{title, comics, viewMore}]` | 无    |
 * | `multiPageComicList`  | `load(page)`    | **1-based**| `{comics, maxPage}`           | 有    |
 * | `mixed`               | `load(index)`   | **0-based**| `{data: [...], maxPage}`      | 有    |
 *
 * ⇒ 源只要声明 `multiPageComicList`（**正是用户说的「分页类型」**），每一页的页码都差 1，
 * 表现为：首页跳过、翻页错位、永远翻不到头。
 *
 * ### 本文件钉住的东西
 *
 * 1. 类型元数据被正确读出（`title` + `type`，且 `load` 不是函数的条目被丢掉）。
 * 2. 三种类型发出的**表达式**（进而是 JS 收到的实参）各自正确。
 * 3. `mixed` 的 `{data:[...]}` 能被摊平（旧 `flattenComics` 只认 `comics`，`mixed` 会塌成 1 条垃圾）。
 * 4. 分页判定：`multiPartPage` 永不声明下一页；`multiPageComicList` / `mixed` 在末页停。
 * 5. **反向对照**：旧的「一律 `load(page-1)`」写法在 `multiPageComicList` 上必然错 —— 用真实
 *    源函数记录它收到的实参，证明新旧行为确实不同（不是自说自话）。
 *
 * ### 台子纪律
 *
 * 三个假源都是**按 Venera 文档写的最小实现**，并且**故意记录自己收到的实参**——这是关键：
 * 断言的是「源实际收到什么」，而不是「我们以为我们发了什么」。mock 不替宿主造任何状态。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

const SYNC_METHODS = [
  'convert', 'random', 'uuid', 'getLocale', 'getPlatform',
  'load_data', 'save_data', 'delete_data', 'load_setting', 'isLogged',
  'log', 'cookie', 'delay', 'getClipboard', 'setClipboard',
];

// --- 三个假源（最小实现，各自记录收到的实参）----------------------------------------------------

/**
 * 每个假源都是 `{ title, type, load }`，并且把 `load` 收到的实参记进 `__calls`。
 * 这是本台子的核心：断言「源真正收到什么」。
 */
const SOURCES_JS = `
class ProbeSource extends ComicSource {
  name = "probe"
  key = "probe"
  version = "1.0.0"
  settings = {}
  __calls = []

  explore = [
    // 0: multiPartPage —— 无分页，load 不带参
    {
      title: "首页",
      type: "multiPartPage",
      load: async (...args) => {
        this.__calls.push(["multiPartPage", args.length, args[0]]);
        return [
          { title: "分組A", comics: [{ id: "a1", title: "A1" }, { id: "a2", title: "A2" }], viewMore: null },
          { title: "分組B", comics: [{ id: "b1", title: "B1" }], viewMore: null },
        ];
      },
    },
    // 1: multiPageComicList —— 1-based 分页
    {
      title: "分页列表",
      type: "multiPageComicList",
      load: async (...args) => {
        this.__calls.push(["multiPageComicList", args.length, args[0]]);
        const page = args[0];
        return {
          comics: [
            { id: "p" + page + "_0", title: "第" + page + "页第0本" },
            { id: "p" + page + "_1", title: "第" + page + "页第1本" },
          ],
          maxPage: 3,
        };
      },
    },
    // 2: mixed —— 0-based index，返回 {data:[...]}
    {
      title: "混合",
      type: "mixed",
      load: async (...args) => {
        this.__calls.push(["mixed", args.length, args[0]]);
        const index = args[0];
        return {
          data: [
            [{ id: "m" + index + "_plain", title: "混合第" + index + "页裸列表" }],
            { title: "混合分组", comics: [{ id: "m" + index + "_sec", title: "混合第" + index + "页分组" }] },
          ],
          maxPage: 2,
        };
      },
    },
    // 3: 没有 load 函数 —— 必须被元数据解析丢掉
    { title: "坏的", type: "multiPageComicList" },
  ]
}
`;

function makeSandbox() {
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, ArrayBuffer, DataView,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.__sendMessageSync = () => null;
  vm.createContext(sandbox);
  vm.runInContext([
    'globalThis.__SYNC_METHODS = ' + JSON.stringify(SYNC_METHODS) + ';',
    'globalThis.sendMessage = function (msg) {',
    '  try {',
    '    var v = __sendMessageSync(msg);',
    '    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return v;',
    '    return Promise.resolve(v);',
    '  } catch (e) { return Promise.reject(e); }',
    '};',
  ].join('\n'), sandbox);
  vm.runInContext(initJs, sandbox);
  vm.runInContext(SOURCES_JS, sandbox);
  vm.runInContext('ComicSource.sources["probe"] = new ProbeSource();', sandbox);

  return {
    sandbox,
    /** 复刻宿主：求值 + 等 settle + `__plainValue`（跨桥形态）。 */
    plainEval: async (expr) => {
      const slot = '__vslot';
      vm.runInContext(
        'globalThis.' + slot + ' = { done: false, value: undefined, error: undefined };\n' +
        '(function () {\n  try {\n    Promise.resolve(' + expr + ').then(\n' +
        '      function (v) { globalThis.' + slot + '.value = __plainValue(v); globalThis.' + slot + '.done = true; },\n' +
        '      function (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n' +
        '    );\n  } catch (e) { globalThis.' + slot + '.error = e; globalThis.' + slot + '.done = true; }\n})();',
        sandbox,
      );
      for (let i = 0; i < 64; i++) {
        await new Promise((r) => setImmediate(r));
        const st = vm.runInContext('globalThis.' + slot, sandbox);
        if (st.done) {
          if (st.error !== undefined) throw st.error;
          return st.value;
        }
      }
      throw new Error('never settled: ' + expr);
    },
    calls: () => vm.runInContext('ComicSource.sources["probe"].__calls', sandbox),
    resetCalls: () => vm.runInContext('ComicSource.sources["probe"].__calls = []', sandbox),
  };
}

// --- 宿主侧复刻 ---------------------------------------------------------------------------------

/** 复刻 JsSourceManager.parseExploreEntries（丢掉 load 不是函数的条目）。 */
function parseExploreEntries(raw, hasLoad) {
  return (raw || []).map((e, i) => ({ index: i, title: e.title || '', type: e.type || '' }))
    .filter((e) => hasLoad(e.index));
}
/** 复刻 JsMangaSource.popularExploreEntry：优先可分页的。 */
function popularExploreEntry(entries) {
  return entries.find((e) => e.type === 'multiPageComicList')
    || entries.find((e) => e.type === 'mixed')
    || entries[0] || null;
}
/** 复刻 JsMangaSource.loadExplorePage 的表达式构造。 */
function exploreExpr(entry, page) {
  if (entry.type === 'multiPageComicList') return { expr: `explore[${entry.index}].load(${page})`, base: '1-based' };
  if (entry.type === 'mixed') return { expr: `explore[${entry.index}].load(${page - 1})`, base: '0-based' };
  return { expr: `explore[${entry.index}].load()`, base: 'no-arg' };
}
/** 复刻 flattenComics（含 mixed 的 data 分支）。 */
function flattenComics(res) {
  if (Array.isArray(res)) return res.flatMap(flattenComics);
  if (res && typeof res === 'object') {
    const nested = res.comics !== undefined ? res.comics : res.data;
    if (Array.isArray(nested)) return nested.flatMap(flattenComics);
    return [res];
  }
  return [];
}
/** 复刻 parseListing 的 hasNextPage 判定。 */
function hasNext(res, page) {
  const maxPage = res && typeof res === 'object' && !Array.isArray(res)
    ? Number.parseInt(String(res.maxPage), 10) : NaN;
  if (!Number.isFinite(maxPage) || maxPage <= 0) return false;
  if (page > 0) return page < maxPage;
  return true;
}

// --- 用例 ---------------------------------------------------------------------------------------

(async () => {
  console.log('verify_explore_types_e2e.js — 三种 explore 类型各有各的调用约定');

  const sb = makeSandbox();

  // ============ 1. 元数据 ============
  section('1. explore 类型元数据被正确读出');

  const rawExplore = vm.runInContext('ComicSource.sources["probe"].explore', sb.sandbox);
  const hasLoad = (i) => vm.runInContext(
    `typeof ComicSource.sources["probe"].explore[${i}].load === 'function'`, sb.sandbox);
  const entries = parseExploreEntries(rawExplore.map((e) => ({ title: e.title, type: e.type })), hasLoad);

  check('读到 3 个可调用条目（第 4 个没有 load，被丢掉）', entries.length === 3, String(entries.length));
  check('index 保留原数组下标（0/1/2）',
    entries.map((e) => e.index).join(',') === '0,1,2', entries.map((e) => e.index).join(','));
  check('三个 type 各自保留',
    entries.map((e) => e.type).join(',') === 'multiPartPage,multiPageComicList,mixed',
    entries.map((e) => e.type).join(','));

  const chosen = popularExploreEntry(entries);
  check('popularExploreEntry 优先选「分页类型」multiPageComicList（而不是 index 0 的 multiPartPage）',
    chosen && chosen.type === 'multiPageComicList', JSON.stringify(chosen));

  // ============ 2. 三种类型各自的实参 ============
  section('2. 三种类型的调用约定必须各自正确（断言源收到的实参）');

  // --- multiPartPage: load() 不带参 ---
  sb.resetCalls();
  const multiPartExpr = exploreExpr(entries[0], 1);
  check('multiPartPage 表达式不带 page 参数', !multiPartExpr.expr.includes('load(' + '1') &&
    multiPartExpr.expr === 'explore[0].load()', multiPartExpr.expr);
  const multiPartRes = await sb.plainEval('ComicSource.sources["probe"].' + multiPartExpr.expr);
  let calls = sb.calls();
  check('源确实收到 0 个实参（不是 undefined 占位）', calls[0][1] === 0, JSON.stringify(calls[0]));
  check('multiPartPage 摊平出 3 本（2 个分组共 3 本）', flattenComics(multiPartRes).length === 3,
    String(flattenComics(multiPartRes).length));
  check('multiPartPage 不声明下一页（无 maxPage）', hasNext(multiPartRes, 1) === false);
  check('multiPartPage 即使翻到第 5 页也不声明下一页（源忽略 page）',
    hasNext(multiPartRes, 5) === false);

  // --- multiPageComicList: load(page) 1-based ---
  sb.resetCalls();
  const listExpr = exploreExpr(entries[1], 1);
  check('multiPageComicList 第 1 页发 load(1)（1-based，不是 load(0)）',
    listExpr.expr === 'explore[1].load(1)', listExpr.expr);
  const listP1 = await sb.plainEval('ComicSource.sources["probe"].' + listExpr.expr);
  calls = sb.calls();
  check('源确实收到实参 1', calls[0][2] === 1, JSON.stringify(calls[0]));
  check('第 1 页拿到 p1_0/p1_1', flattenComics(listP1).map((c) => c.id).join(',') === 'p1_0,p1_1',
    flattenComics(listP1).map((c) => c.id).join(','));
  check('第 1 页 maxPage=3 ⇒ hasNextPage=true', hasNext(listP1, 1) === true);
  check('第 3 页（末页）⇒ hasNextPage=false（不再多请求一页）', hasNext(listP1, 3) === false);

  sb.resetCalls();
  const listP2 = await sb.plainEval('ComicSource.sources["probe"].' + exploreExpr(entries[1], 2).expr);
  calls = sb.calls();
  check('第 2 页发 load(2) 且源收到 2', exploreExpr(entries[1], 2).expr === 'explore[1].load(2)' && calls[0][2] === 2,
    JSON.stringify(calls[0]));
  check('第 2 页内容与第 1 页不同（真的在前进）',
    flattenComics(listP2).map((c) => c.id).join(',') === 'p2_0,p2_1',
    flattenComics(listP2).map((c) => c.id).join(','));

  // --- mixed: load(index) 0-based ---
  sb.resetCalls();
  const mixedExpr = exploreExpr(entries[2], 1);
  check('mixed 第 1 页（Aniyomi 1-based）发 load(0)（源是 0-based index）',
    mixedExpr.expr === 'explore[2].load(0)', mixedExpr.expr);
  const mixedP1 = await sb.plainEval('ComicSource.sources["probe"].' + mixedExpr.expr);
  calls = sb.calls();
  check('源确实收到 index 0（不是 1）', calls[0][2] === 0, JSON.stringify(calls[0]));
  check('mixed 的 {data:[裸列表, 分组]} 被完整摊平（2 本，不是 1 条垃圾）',
    flattenComics(mixedP1).length === 2, String(flattenComics(mixedP1).length));
  check('mixed 摊平后 id 正确',
    flattenComics(mixedP1).map((c) => c.id).join(',') === 'm0_plain,m0_sec',
    flattenComics(mixedP1).map((c) => c.id).join(','));
  check('mixed 第 1 页 maxPage=2 ⇒ hasNextPage=true', hasNext(mixedP1, 1) === true);
  check('mixed 第 2 页（末页）⇒ hasNextPage=false', hasNext(mixedP1, 2) === false);

  // ============ 3. 反向对照：旧写法在 multiPageComicList 上必然错 ============
  section('3. 反向对照：旧的「一律 load(page-1)」在分页类型上必然错');

  sb.resetCalls();
  const OLD = (page) => `explore[1].load(${page - 1})`; // 旧宿主
  const oldP1 = await sb.plainEval('ComicSource.sources["probe"].' + OLD(1));
  calls = sb.calls();
  check('旧写法第 1 页发 load(0) —— 源收到 0，而源是 1-based',
    calls[0][2] === 0, JSON.stringify(calls[0]));
  check('⇒ 旧写法第 1 页拿到的是「第 0 页」数据（id 前缀 p0_）',
    flattenComics(oldP1).map((c) => c.id).join(',') === 'p0_0,p0_1',
    flattenComics(oldP1).map((c) => c.id).join(','));
  check('⇒ 与正确写法的第 1 页内容不同（证明新旧行为确实有差）',
    flattenComics(oldP1).map((c) => c.id).join(',') !== 'p1_0,p1_1');

  sb.resetCalls();
  await sb.plainEval('ComicSource.sources["probe"].' + OLD(2));
  calls = sb.calls();
  check('旧写法第 2 页发 load(1) ⇒ 与正确写法的第 1 页**重复**（这就是「翻页不动」）',
    calls[0][2] === 1, JSON.stringify(calls[0]));

  // 旧的 flattenComics（只认 `comics`）在 mixed 上的表现
  const oldFlatten = (res) => {
    if (Array.isArray(res)) return res.flatMap(oldFlatten);
    if (res && typeof res === 'object') {
      if (Array.isArray(res.comics)) return res.comics.flatMap(oldFlatten);
      return [res];
    }
    return [];
  };
  check('旧 flattenComics 在 mixed 的 {data:[…]} 上塌成 1 条垃圾（新写法摊平出 2 条）',
    oldFlatten(mixedP1).length === 1 && flattenComics(mixedP1).length === 2,
    `old=${oldFlatten(mixedP1).length} new=${flattenComics(mixedP1).length}`);

  // ============ 4. 分页判定的边界 ============
  section('4. hasNextPage 的边界');

  const mk = (maxPage) => ({ comics: [{ id: 'x' }], maxPage });
  check('maxPage 缺失 ⇒ false（multiPartPage 场景）', hasNext([{ comics: [] }], 1) === false);
  check('maxPage=0 ⇒ false', hasNext(mk(0), 1) === false);
  check('maxPage=1 且 page=1 ⇒ false（只有一页）', hasNext(mk(1), 1) === false);
  check('maxPage=3 且 page=1 ⇒ true', hasNext(mk(3), 1) === true);
  check('maxPage=3 且 page=3 ⇒ false', hasNext(mk(3), 3) === false);
  check('maxPage=3 且 page=4（越界）⇒ false', hasNext(mk(3), 4) === false);

  // ============ 汇总 ============
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('台子自身抛错：', e);
  process.exitCode = 2;
});
