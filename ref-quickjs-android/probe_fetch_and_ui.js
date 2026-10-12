// 精确复现 refreshApiDomains 在「无 fetch」环境下的行为
//
// 目的：证明「点了刷新没反应」的机制到底是什么。
// 真机日志里完全没有 UI.showDialog 的痕迹，所以要么回调没跑，要么跑了但没发 UI 调用。
// 这个探针在**与真机 QuickJS 一致的环境（没有 fetch）**下直接调用 callback，看会发生什么。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jmSource = fs.readFileSync(path.join(__dirname, 'samples', 'jm.js'), 'utf8');
const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');

const uiCalls = [];
const bridgeCalls = [];

const sandbox = {
  console, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
  Map, Set, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout,
  __sendMessageSync: (msg) => {
    bridgeCalls.push(msg);
    if (msg.method === 'UI') {
      uiCalls.push({
        fn: msg.function,
        title: msg.title,
        content: msg.content,
        nActions: (msg.actions || []).length,
      });
    }
    if (msg.method === 'http') return { status: null, headers: {}, body: null, error: 'net fail' };
    return null;
  },
  // 注意：故意不提供 fetch —— 与真机 QuickJS 环境一致
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(
  `
  globalThis.__dlgQueue = [];
  globalThis.__dlgClaimed = 0;
  globalThis.sendMessage = function (msg) {
      try {
          if (msg && msg.method === 'UI' && msg.function === 'showDialog') {
              globalThis.__dlgQueue.push(msg.actions || []);
          }
          var value = __sendMessageSync(msg);
          return Promise.resolve(value);
      } catch (e) { return Promise.reject(e); }
  };
  globalThis.__claimDialogActions = function () {
      if (globalThis.__dlgClaimed >= globalThis.__dlgQueue.length) return null;
      return globalThis.__dlgQueue[globalThis.__dlgClaimed++];
  };
  `,
  sandbox,
);
vm.runInContext(initJs, sandbox, { filename: 'init.js' });
vm.runInContext(
  `(() => { ${jmSource}\n; globalThis.__src = new JM(); }).call(globalThis);`,
  sandbox,
  { filename: 'jm.js' },
);

const src = sandbox.__src;
const root = `ComicSource.sources['${src.key}']`;
vm.runInContext(`${root} = globalThis.__src;`, sandbox);
sandbox.__src.data = {};
vm.runInContext('globalThis.__src.constructor.apiDomains = globalThis.__src.constructor.fallbackServers.slice();', sandbox);

console.log('=== 环境检查（模拟真机 QuickJS） ===');
console.log(`typeof fetch     = ${vm.runInContext('typeof fetch', sandbox)}`);
console.log(`typeof UI        = ${vm.runInContext('typeof UI', sandbox)}`);
console.log(`UI.showDialog    = ${vm.runInContext('typeof UI.showDialog', sandbox)}`);
console.log(`UI.showMessage   = ${vm.runInContext('typeof UI.showMessage', sandbox)}`);
console.log('');

async function evalAwaiting(expr) {
  sandbox.__slot = { done: false, value: undefined, error: undefined };
  vm.runInContext(
    `(function () {
        var s = globalThis.__slot;
        try {
          Promise.resolve(${expr}).then(
            v => { s.done = true; s.value = v; },
            e => { s.done = true; s.error = String((e && e.message) || e); }
          );
        } catch (e) { s.done = true; s.error = String((e && e.message) || e); }
     })();`,
    sandbox,
  );
  for (let i = 0; i < 64 && !sandbox.__slot.done; i++) await new Promise((r) => setImmediate(r));
  return { done: sandbox.__slot.done, value: sandbox.__slot.value, error: sandbox.__slot.error };
}

(async () => {
  console.log('=== 场景 A：直接调用 refreshDomains.callback()（无 fetch） ===');
  uiCalls.length = 0;
  bridgeCalls.length = 0;
  const r = await evalAwaiting(`${root}.settings.refreshDomains.callback()`);
  console.log(`  settled = ${r.done}`);
  console.log(`  error   = ${JSON.stringify(r.error)}`);
  console.log(`  value   = ${JSON.stringify(r.value)}`);
  console.log(`  桥调用总数 = ${bridgeCalls.length},  其中 UI = ${uiCalls.length}`);
  uiCalls.forEach((c, i) => {
    console.log(`    [${i}] ${c.fn}  title=${JSON.stringify(c.title)}  actions=${c.nActions}`);
    if (c.content) console.log(`         content=${JSON.stringify(String(c.content).slice(0, 120))}`);
  });
  const methods = {};
  bridgeCalls.forEach((m) => { methods[m.method] = (methods[m.method] || 0) + 1; });
  console.log(`  桥调用分布 = ${JSON.stringify(methods)}`);
  console.log('');

  if (uiCalls.length === 0) {
    console.log('  >>> 结论：没有产生任何 UI 调用 —— showDialog 从未到达桥。');
    console.log('      回调静默走完，用户什么都看不到 = 「点了没反应」。');
  } else {
    console.log('  >>> 结论：回调确实发了 UI 调用。问题在宿主侧的渲染，不在 JS。');
  }
  console.log('');

  console.log('=== 场景 B：fetch 那一行到底抛什么 ===');
  const r2 = await evalAwaiting(`(async () => {
      try {
          let res = await fetch("https://example.com", { headers: {} });
          return "fetch 正常返回: " + String(res);
      } catch (e) {
          return "被 try/catch 捕获: " + String((e && e.message) || e);
      }
  })()`);
  console.log(`  ${JSON.stringify(r2.value || r2.error)}`);
  console.log('');

  console.log('=== 场景 C：refreshApiDomains 完整跑，看它在哪一步停 ===');
  uiCalls.length = 0;
  bridgeCalls.length = 0;
  const r3 = await evalAwaiting(`${root}.refreshApiDomains(true)`);
  console.log(`  settled=${r3.done}  error=${JSON.stringify(r3.error)}`);
  console.log(`  UI 调用 = ${uiCalls.length}`);
  uiCalls.forEach((c, i) => console.log(`    [${i}] ${c.fn} title=${JSON.stringify(c.title)} actions=${c.nActions}`));
  console.log('');

  console.log('=== 场景 D：手动签到（真机日志里报错的那个） ===');
  uiCalls.length = 0;
  bridgeCalls.length = 0;
  const r4 = await evalAwaiting(`${root}.settings.dailyCheckIn.callback()`);
  console.log(`  settled=${r4.done}  error=${JSON.stringify(r4.error)}`);
  console.log(`  UI 调用 = ${uiCalls.length}`);
  uiCalls.forEach((c, i) => console.log(`    [${i}] ${c.fn} title=${JSON.stringify(c.title)} actions=${c.nActions}`));
})();
