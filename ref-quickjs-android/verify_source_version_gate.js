#!/usr/bin/env node
/**
 * verify_source_version_gate.js — 「检查更新」不得用字符串不等当"有更新"。
 *
 * ### 真机现象（10:30 截图，两处同时出现）
 *  1. 我独自升级详情页：`GoDa漫画: 无法获取漫画ID（最近请求: GET …/manga/woduzishengji-… -> 200 raw=53176）`
 *     —— **裸错误串，没有页面字节数**。1.2.3 的报错是 `无法获取漫画ID（页面 N 字节…）`，
 *     1.2.2 在这页能成功（`#bookmarkData` 存在）。⇒ 设备上跑的是 **1.2.1**。
 *  2. 武炼巅峰 3875 章，顺序 867 / 2009 / 2007 / 大决战篇 / 3032 / 3031 / 2011 … —— 典型 HashMap 哈希序，
 *     只有 1.2.1（普通对象 `const chapters = {}`）会这样。
 *
 * 两张图一起说明：**1.2.3 被"检查更新"回滚成了 1.2.1**，不是修复无效。
 *
 * ### 根因
 * JsSourceUpdater 的四处判断都是 `entry.version != current.version`（字符串不等）：
 *   本地 1.2.3（站点改版后的本地修复） vs 上游 1.2.1（venera-configs 尚未跟进）
 *   → 字符串不等 ⇒ 判定"有更新" ⇒ installFromRepo 覆盖 ⇒ 修复被静默回滚。
 *
 * 正确语义：只有**仓库版本真正更高**才替换；相等不动，**更低必须拒绝**（那是降级）。
 *
 * 本文件用**逐字复刻**的 Kotlin 逻辑跑断言（不抄结论，只抄判断），并显式钉住三个易错点：
 *   • "1.2.10" > "1.2.9"（纯字符串比较会判反）
 *   • "1.2" == "1.2.0"（缺失分段按 0）
 *   • 未知版本串退回旧的“不等即更新”，保证脏版本仍有机会刷新
 */

'use strict';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// ================================================================================================
// 逐字复刻 JsSourceUpdater.isRepoNewer / parseVersion
// ================================================================================================

function parseVersion(version) {
  const core = version.trim().replace(/^v/, '').split('-')[0].split('+')[0];
  if (core === '') return null;
  const parts = core.split('.');
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;           // toIntOrNull() == null
    out.push(parseInt(p, 10));
  }
  return out;
}

function isRepoNewer(repoVersion, currentVersion) {
  if (repoVersion === '') return false;
  if (repoVersion === currentVersion) return false;
  const repo = parseVersion(repoVersion);
  if (repo === null) return true;
  const current = parseVersion(currentVersion);
  if (current === null) return true;
  const len = Math.max(repo.length, current.length);
  for (let i = 0; i < len; i++) {
    const r = repo[i] !== undefined ? repo[i] : 0;
    const c = current[i] !== undefined ? current[i] : 0;
    if (r !== c) return r > c;
  }
  return false;
}

// 旧实现（回归参照物）：字符串不等
const oldIsUpdate = (repoVersion, currentVersion) =>
  repoVersion !== '' && repoVersion !== currentVersion;

// ================================================================================================

section('核心回归：本地修复版不得被上游旧版回滚（真机 1.2.3 ← 1.2.1）');
check('旧实现确实会把 1.2.3 判成"有更新"（这就是 bug 本身）',
  oldIsUpdate('1.2.1', '1.2.3') === true, { repo: '1.2.1', local: '1.2.3' });
check('新实现拒绝降级 1.2.1 → 本地 1.2.3',
  isRepoNewer('1.2.1', '1.2.3') === false);
check('新实现拒绝降级 1.2.1 → 本地 1.2.2（用户第一次导入的那版）',
  isRepoNewer('1.2.1', '1.2.2') === false);
check('上游真的更高时仍然更新（1.2.1 → 本地 1.1.9）',
  isRepoNewer('1.2.1', '1.1.9') === true);
check('版本相同 → 不动（避免无谓重写文件/丢状态）',
  isRepoNewer('1.2.3', '1.2.3') === false);

section('语义化比较：纯字符串比较会判反的两类');
check('"1.2.10" > "1.2.9"（字符串比较会说 1.2.1 < 1.2.9）',
  isRepoNewer('1.2.10', '1.2.9') === true, { note: 'string compare: ' + ('1.2.10' < '1.2.9') });
check('"1.2.9" < "1.2.10"（反向：不该更新）',
  isRepoNewer('1.2.9', '1.2.10') === false);
check('"1.2" == "1.2.0"（缺失分段按 0，不更新）',
  isRepoNewer('1.2', '1.2.0') === false);
check('"1.2.1" > "1.2"（真的更高，仍更新）',
  isRepoNewer('1.2.1', '1.2') === true);
check('"1.10.0" > "1.9.9"（跨位进位）',
  isRepoNewer('1.10.0', '1.9.9') === true);
check('"2.0.0" > "1.99.99"（主版本进位）',
  isRepoNewer('2.0.0', '1.99.99') === true);

section('前缀 / 预发布 / 脏版本');
check('"v1.2.4" > "1.2.3"（v 前缀容忍）',
  isRepoNewer('v1.2.4', '1.2.3') === true);
check('"1.2.4-beta.1" > "1.2.3"（预发布后缀按核心版比较）',
  isRepoNewer('1.2.4-beta.1', '1.2.3') === true);
check('"1.2.3" 与 "1.2.3+build7" 视为相同（构建元数据不参与）',
  isRepoNewer('1.2.3+build7', '1.2.3') === false);
check('仓库版本为空 → 永不更新（index 缺 version 的条目）',
  isRepoNewer('', '1.2.3') === false);
check('仓库版本非数字串 → 退回不等判断（脏版本仍可刷新）',
  isRepoNewer('nightly', '1.2.3') === true);
check('本地版本非数字串 → 退回不等判断（不阻断更新）',
  isRepoNewer('1.2.3', 'unknown') === true);
check('两边都非数字串且不同 → 退回不等判断',
  isRepoNewer('nightly', 'canary') === true);

section('端到端：updateInstalled / outdatedInstalled / pendingUpdates 的筛选结果');
// 模拟设备上「本地 1.2.3 修复 + 上游 index 仍报 1.2.1」的真实局面
const index = [
  { key: 'goda', fileName: 'goda.js', version: '1.2.1' },        // 上游未跟进 ⇒ 必须跳过
  { key: 'jm', fileName: 'jm.js', version: '1.5.0' },           // 上游更高 ⇒ 应更新
  { key: 'untouched', fileName: 'untouched.js', version: '2.0.0' }, // 版本相同 ⇒ 不动
  { key: 'nover', fileName: 'nover.js', version: '' },          // 无版本号 ⇒ 不动
];
const installed = [
  { key: 'goda', version: '1.2.3' },
  { key: 'jm', version: '1.4.2' },
  { key: 'untouched', version: '2.0.0' },
  { key: 'nover', version: '0.9.0' },
];
const pending = index.filter((e) => {
  const cur = installed.find((i) => i.key === e.key);
  if (!cur) return true;                                        // 未安装 ⇒ 待装
  return isRepoNewer(e.version, cur.version);
}).map((e) => e.key);

check('待更新列表只含 jm（本地修复版 goda 不被回滚）',
  JSON.stringify(pending) === JSON.stringify(['jm']), pending);
check('旧实现在同一局面下会把 goda 也列进去（对照）',
  (() => {
    const old = index.filter((e) => {
      const cur = installed.find((i) => i.key === e.key);
      if (!cur) return true;
      return e.version !== '' && e.version !== cur.version;
    }).map((e) => e.key);
    return old.includes('goda');
  })(), { oldWouldInclude: 'goda' });

section('回归钉子：章节顺序修复不被版本门影响（源必须用 Map + order 升序）');
// 宿主 __plainValue 只把 JS Map 转成有序 [k,v] 对数组；普通对象会塌成 HashMap 哈希序。
function __plainValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Map) return [...v.entries()].map(([k, val]) => [k, val]);
  const out = {};
  for (const k of Object.keys(v)) out[k] = v[k];
  return out;
}
const asc = [
  { id: '1', order: 1 }, { id: '2', order: 2 }, { id: '3', order: 3 },
];
function buildChapters(useMap) {
  if (useMap) {
    const m = new Map();
    for (const c of asc.slice().sort((a, b) => a.order - b.order)) m.set(`6@${c.id}`, c.id);
    return __plainValue(m);
  }
  const o = {};
  for (const c of asc) o[`6@${c.id}`] = c.id;   // 1.2.1 的写法
  return __plainValue(o);
}
const asMap = buildChapters(true);
const asObj = buildChapters(false);
check('Map → 有序键值对数组（宿主按 index+1 编号 ⇒ 编号与顺序都对）',
  Array.isArray(asMap) && asMap[0][0] === '6@1' && asMap[2][0] === '6@3', asMap);
check('普通对象 → 键对象（宿主退化为 HashMap 分支，顺序不可控）',
  !Array.isArray(asObj) && typeof asObj === 'object' && !Array.isArray(asObj['6@1']), Object.keys(asObj));

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
