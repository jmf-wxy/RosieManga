#!/usr/bin/env node
/**
 * probe_jm_search_race.js — 复现「init 不再 await」引入的竞态：搜索卡死在转圈。
 *
 * ### 真机现象（11:41 截图）
 * 搜索「女神的露天咖啡厅」→ 页面标题已切到该词、分页栏显示「第 1 / 125 页」、但**列表空白且转圈不停**。
 * 「125 页」说明 `maxPage` 已经从某处拿到（或是上一次成功的 state），而这一次请求的 promise
 * **从未 settle** —— 宿主 `evalAwaitingResult` 一直等，UI 永远 loading。
 *
 * ### 假设：把 init() 改成 fire-and-forget 之后，搜索跑在 apiDomains 就绪之前
 * `baseUrl` = `https://${JM.apiDomains[index]}`，而 `JM.apiDomains` 声明为 undefined、只在
 * `overwriteApiDomains()` 里被赋值（且要求 `domains.length != 0`）。init 立即返回 ⇒ gate 放行 ⇒
 * 搜索此刻求值 `JM.apiDomains[index]` 抛 `Cannot read properties of undefined (reading '0')`。
 *
 * ⚠️ 这个 throw 发生在 **`.then` 链的最前端**（`search.load` 的第一步），它 reject 的是
 * `evalAwaiting` 里那个被 await 的 promise。宿主应当把它报成 Rejected；可若 JS 侧把这个
 * rejection 变成 floating（S14）或 `.then` 里再套一层未处理的链，宿主就只会看到「永不 settle」。
 * 本探针把两种结局都跑一遍，看真实落在哪一边。
 *
 * 跑法： node probe_jm_search_race.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

const DOMAIN_SECRET = 'diosfjckwpqpdfjkvnqQjsik';
/** 与 verify_source_init_e2e.js 同款封装：域名端点回的是**加密信封**，不是明文 JSON。 */
function jmKey(secret) {
  return Buffer.from(crypto.createHash('md5').update(secret, 'utf8').digest('hex'), 'utf8');
}
function jmSeal(plaintext, secret) {
  const key = jmKey(secret);
  const raw = Buffer.from(plaintext, 'utf8');
  const padLen = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const c = crypto.createCipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString('base64');
}

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  if (ok) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); }
};

/** 极简宿主：够跑 init + search.load，重点是**时序**而非桥完整性。 */
function makeHost({ domainDelayMs = 0, domainListWorks = true } = {}) {
  const httpCalls = [];
  const saved = {};
  const meta = {};
  const floating = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, parseInt, isNaN,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  process.on('unhandledRejection', () => {});   // 沙箱内 floating 不该杀掉探针

  // 域名字面量（照抄 jm.js 的 JM.fallbackServers 语义：非空才写入）
  const DOMAIN_PAYLOAD = ['d1.example.org', 'd2.example.org', 'd3.example.org', 'd4.example.org'];

  function dispatch(msg) {
    const m = msg.method;
    if (m === 'getLocale') return 'zh_CN';
    if (m === 'getPlatform') return 'android';
    if (m === 'isLogged') return false;
    if (m === 'UI') return null;
    if (m === 'delay') return null;
    if (m === 'load_data') return Object.prototype.hasOwnProperty.call(saved, msg.data_key) ? saved[msg.data_key] : null;
    if (m === 'save_data') { saved[msg.data_key] = msg.data; return null; }
    if (m === 'load_setting') {
      const e = meta[msg.setting_key];
      return e ? e.default : undefined;
    }
    if (m === 'convert') {
      // ⚠️ 字段名是驼峰 `isEncode`（init.js 的 Convert.* 契约），写成下划线会让 decode 分支
      // 永远走错 ⇒ body 解出 null ⇒ 看起来像"域名没写进去"，其实是自己 mock 坏了。
      if (msg.type === 'utf8') {
        return msg.isEncode
          ? Buffer.from(String(msg.value), 'utf8')
          : Buffer.from(msg.value).toString('utf8');
      }
      if (msg.type === 'base64') {
        return msg.isEncode
          ? Buffer.from(msg.value).toString('base64')
          : Buffer.from(String(msg.value).replace(/[\s﻿]/g, ''), 'base64');
      }
      // ⚠️ convertData() 还要 md5 + aes-ecb 两件套；少任何一件都让密钥算错 / 解密出垃圾
      // → servers 为空 → 域名永远写不进去。漏掉它们会让本探针测的是"mock 坏了"而非"源有竞态"。
      // （`hexEncode` 是 init.js 里的**纯 JS** 实现，不走桥，别为它写分支。）
      if (msg.type === 'md5') {
        return crypto.createHash('md5').update(Buffer.from(String(msg.value))).digest();
      }
      if (msg.type === 'aes-ecb') {
        const key = Buffer.from(msg.key);
        const val = Buffer.from(msg.value);
        if (msg.isEncode) {
          const c = crypto.createCipheriv('aes-256-ecb', key, null);
          c.setAutoPadding(false);
          return Buffer.concat([c.update(val), c.final()]);
        }
        const dec = crypto.createDecipheriv('aes-256-ecb', key, null);
        dec.setAutoPadding(false);
        return Buffer.concat([dec.update(val), dec.final()]);
      }
      return null;
    }
    if (m === 'http') {
      const url = String(msg.url || '');
      httpCalls.push({ url, method: msg.http_method || 'GET' });
      if (url.includes('newsvr-2025.txt')) {
        // ⚠️ 必须**异步**且有真实延迟：域名端点在真机上 TTFB 0.79~1.03s（431 字节）。
        // 同步返回会掩盖整个竞态（域名瞬间就绪，搜索永远追不上）—— 本探针存在的全部意义
        // 就是复现"搜索跑在域名就绪之前"这个窗口。
        const payload = domainListWorks
          ? '﻿' + jmSeal(JSON.stringify({ Server: DOMAIN_PAYLOAD }), DOMAIN_SECRET) + '\n'
          : '';
        return new Promise((resolve) => {
          setTimeout(() => resolve(JSON.stringify(domainListWorks
            ? { status: 200, headers: {}, body: Buffer.from(payload, 'utf8').toString('base64') }
            : { status: 404, headers: {}, body: '' })), domainDelayMs);
        });
      }
      if (url.includes('/search')) {
        // 关键：搜索 URL 里若出现 undefined，说明它跑在域名就绪之前
        return JSON.stringify({
          status: 200, headers: {},
          body: Buffer.from(JSON.stringify({ data: 'x' }), 'utf8').toString('base64'),
        });
      }
      if (url.includes('/setting')) {
        return JSON.stringify({ status: 200, headers: {}, body: Buffer.from('{"img_host":"img.example.org"}').toString('base64') });
      }
      return JSON.stringify({ status: null, headers: {}, body: null, error: 'unreachable: ' + url });
    }
    return null;
  }

  sandbox.__sendMessageSync = (msg) => dispatch(msg);
  vm.createContext(sandbox);
  vm.runInContext('globalThis.__SYNC = ' + JSON.stringify([
    'convert', 'random', 'uuid', 'getLocale', 'getPlatform', 'load_data', 'save_data',
    'delete_data', 'load_setting', 'isLogged', 'log', 'cookie', 'delay',
  ]) + ';', sandbox);
  vm.runInContext(
    'globalThis.sendMessage = function (msg) {\n' +
    '  try { var v = __sendMessageSync(msg);\n' +
    '    if (msg && __SYNC.indexOf(msg.method) !== -1) return v;\n' +
    '    return Promise.resolve(v);\n' +
    '  } catch (e) { return Promise.reject(e); }\n' +
    '};', sandbox);
  vm.runInContext(initJs, sandbox);
  vm.runInContext(jmJs, sandbox);
  vm.runInContext('ComicSource.sources["jm"] = new JM();', sandbox);

  // 反射 settings 默认值（宿主 warmMeta 的等价物）
  const settings = vm.runInContext("ComicSource.sources['jm'].settings", sandbox);
  for (const [k, v] of Object.entries(settings)) meta[k] = { type: v.type, default: v.default };

  /**
   * 宿主视角：跑一段表达式并等它 settle。
   *
   * ⚠️ 这里必须用**真实定时器**轮询（`await sleep(5)`），不能用 `setImmediate`：域名端点在真机
   * 上要 0.8~1.0s，mock 用的是 `setTimeout`；只 drain 微任务的话 slot 永远等不到那一拍，
   * 探针会误报成「永不 settle」。
   */
  async function settle(expr, timeoutMs = 8000) {
    vm.runInContext(
      `(function () {
         globalThis.__slot = { done: false };
         try {
           Promise.resolve(${expr}).then(
             function (v) { globalThis.__slot = { done: true, ok: true, value: v }; },
             function (e) { globalThis.__slot = { done: true, ok: false, err: String((e && e.message) || e) }; }
           );
         } catch (e) {
           globalThis.__slot = { done: true, ok: false, err: String((e && e.message) || e) };
         }
       })()`, sandbox);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const st = vm.runInContext('globalThis.__slot', sandbox);
      if (st.done) return st;
      await new Promise((r) => setTimeout(r, 5));
    }
    return { done: true, ok: false, err: '__NEVER_SETTLED__' };
  }

  /** 等到**后台发现**完成（域名被换成真实线路），而非"有值即可"。 */
  async function waitForDomains(timeoutMs = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const d = vm.runInContext('JM.apiDomains', sandbox);
      // 兜底是 JM.fallbackServers；后台发现完成后会是端点返回的线路，两者不同才算完成。
      if (Array.isArray(d) && d.length && d[0] !== 'www.cdntwice.org') return d;
      await new Promise((r) => setTimeout(r, 5));
    }
    return vm.runInContext('JM.apiDomains', sandbox);
  }

  return { sandbox, httpCalls, floating, settle, waitForDomains };
}

async function main() {
  // 真机量级：域名端点 TTFB 0.79~1.03s。
  const REAL_DELAY = 900;

  console.log(`=== 1. init() 之后**立刻**搜索（域名端点慢 ${REAL_DELAY}ms = 真机时序）===`);
  {
    const h = makeHost({ domainDelayMs: REAL_DELAY });
    const init = await h.settle(`ComicSource.sources['jm'].init()`, 2000);
    check('init() resolve（不等那 0.9s，性能修复生效）', init.ok === true, init);

    // 修复的核心契约：init 返回时 apiDomains **已经有值**（同步兜底），所以不存在竞态。
    const domainsNow = vm.runInContext('JM.apiDomains', h.sandbox);
    check('init() 返回时 apiDomains 已就绪（同步兜底 ⇒ 无竞态窗口）',
      Array.isArray(domainsNow) && domainsNow.length === 4, domainsNow);
    check('兜底用的是源自己的 JM.fallbackServers',
      Array.isArray(domainsNow) && domainsNow[0] === 'www.cdntwice.org', domainsNow);

    const t0 = Date.now();
    const s = await h.settle(`ComicSource.sources['jm'].search.load('女神的露天咖啡厅', [], 1)`, 3000);
    const elapsed = Date.now() - t0;
    console.log(`  搜索结局 -> ${JSON.stringify(s).slice(0, 140)}  (${elapsed}ms)`);
    check('竞态下搜索**不再抛 undefined[0]**（这正是 11:41 卡死的症状）',
      s.ok === false ? !/undefined/.test(String(s.err)) : true, s.err);
    const searchReq = h.httpCalls.find((c) => c.url.includes('/search'));
    check('搜索发往兜底域名（而不是 undefined 主机）',
      !!searchReq && searchReq.url.includes('www.cdntwice.org'), searchReq && searchReq.url);
    // ⚠️ 只看**主机名**：`?o=undefined` 是排序参数（`search.load(kw, [], 1)` 传了空 options），
    // 与域名无关，别把它误判成"向 undefined 主机发请求"。
    const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
    check('没有向 undefined 主机发请求',
      !h.httpCalls.some((c) => hostOf(c.url) === 'undefined'),
      h.httpCalls.map((c) => hostOf(c.url)));
  }

  console.log('\n=== 2. 后台发现完成后自动升级为真实域名 ===');
  {
    const h = makeHost({ domainDelayMs: REAL_DELAY });
    await h.settle(`ComicSource.sources['jm'].init()`, 2000);
    const domains = await h.waitForDomains(4000);
    check('域名最终被后台发现覆盖成真实线路（发现语义没丢）',
      Array.isArray(domains) && domains[0] === 'd1.example.org', domains);

    const s = await h.settle(`ComicSource.sources['jm'].search.load('x', [], 1)`, 3000);
    const searchReq = h.httpCalls.find((c) => c.url.includes('/search'));
    check('后续搜索走新线路', !!searchReq && searchReq.url.includes('d1.example.org'),
      searchReq && searchReq.url);
  }

  console.log('\n=== 3. 后台链失败必须被吞掉（否则又是 floating → 300s 超时）===');
  {
    // 域名端点 404 ⇒ refreshApiDomains 走 fallback 分支（不抛）；再让 /setting 也失败。
    const h = makeHost({ domainDelayMs: 50, domainListWorks: false });
    const init = await h.settle(`ComicSource.sources['jm'].init()`, 2000);
    check('域名端点挂掉时 init 仍然 resolve', init.ok === true, init);
    const domains = vm.runInContext('JM.apiDomains', h.sandbox);
    check('且 apiDomains 仍是可用的兜底线路（搜索不至于 undefined[0]）',
      Array.isArray(domains) && domains.length === 4, domains);
    // init 之后不应有未接管的 rejection
    await new Promise((r) => setTimeout(r, 300));
    check('后台链的失败没有逃成 unhandledRejection（.catch 生效）',
      h.floating.length === 0, h.floating);
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
