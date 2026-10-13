#!/usr/bin/env node
/**
 * verify_image_scramble_e2e.js — 「进入漫画后图片是错乱的（横向条带被打散）」
 *
 * ### 根因
 *
 * JM 服务端的正文图本身就是**打散**的：条带按 epId 派生的算法被重排。Venera 端由
 * `comic.onImageLoad(url, comicId, epId)` 返回 `{ headers, modifyImage }`，`modifyImage` 是一段
 * JS 源码，用 `Image` 原语（`Image.empty(w,h)` + `res.fillImageRangeAt(...)`）把条带重新拼回去。
 * 宿主此前既没调 onImageLoad（Page 不携带章节上下文），也没实现 Image 原语 —— 所以显示的就是
 * 打散原图。
 *
 * ### 修复（本台子逐条验证的契约）
 *
 *  1. `JsMangaSource.getPageList` 给每个 Page URL 追加 `#c=<comicId>&e=<epId>`（URL fragment
 *     不会发给服务器；章节缓存以完整 URL 为 key，标签在重启/重下载后仍在）；
 *  2. `getImage` 解析标签 → 调 onImageLoad → 按返回 headers 取图（**滤掉 Accept-Encoding**，
 *     见 S12）→ 若有 modifyImage，则解码成像素、以整数句柄让 JS 驱动条带重排、重新编码 PNG；
 *  3. Kotlin 侧 `JsImageEngine` 逐行移植 Venera `lib/utils/image.dart` 的 Image 语义；
 *  4. **init.js 的 `Image` 类必须走 `__sendMessageSync`** —— 宿主的 `sendMessage` 是 Promise
 *     shim（S3），而 Image API 是同步契约（Venera 的 flutter_qjs sendMessage 是同步的）。
 *     若走 Promise shim，每个 key 都是 Promise，`new Image(key)` 包着未决值 → 整条链静默失效
 *     （E 节反向对照）。这是本台子最重要的回归钉。
 *
 * ### 与设备的一致性
 *
 * Node 侧用纯 JS 重新实现 Image 语义（与 Kotlin 逐行同构）作为参考实现；jm.js 的 onImageLoad
 * 是**真源码**切片；modifyImage 是 onImageLoad 真实产出的脚本。消息形状（D 节）即 Kotlin
 * `JsImageEngine.handle` 必须实现的契约 —— 两边漂移任何一边，套件就红。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const initJs = fs.readFileSync(path.join(__dirname, 'samples', 'init.js'), 'utf8');
const jmJs = fs.readFileSync(path.join(__dirname, '..', 'js-sources', 'jm.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

// --- Node 参考实现：与 Kotlin JsImageEngine / Venera lib/utils/image.dart 逐行同构 ----------------

const images = new Map();
let nextKey = 0;

class RefImage {
  constructor(width, height, pixels) {
    if (!(width > 0) || !(height > 0) || pixels.length !== width * height) {
      throw new Error('invalid image ' + width + 'x' + height);
    }
    this.width = width; this.height = height; this.pixels = pixels;
  }
}

function refPut(img) { const k = nextKey++; images.set(k, img); return k; }
function refGet(k) { return images.get(typeof k === 'number' ? k : -1) || null; }

function refHandle(msg) {
  const f = msg.function;
  try {
    switch (f) {
      case 'emptyImage': return refPut(new RefImage(msg.width, msg.height, new Int32Array(msg.width * msg.height)));
      case 'copyRange': {
        const src = refGet(msg.key); if (!src) return null;
        const x = msg.x | 0, y = msg.y | 0, w = msg.width | 0, h = msg.height | 0;
        if (x + w > src.width || y + h > src.height) throw new Error('copyRange bounds');
        const out = new Int32Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = src.pixels[(j + y) * src.width + i + x];
        return refPut(new RefImage(w, h, out));
      }
      case 'copyAndRotate90': {
        const src = refGet(msg.key); if (!src) return null;
        const out = new Int32Array(src.pixels.length);
        for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) {
          out[i * src.height + src.height - j - 1] = src.pixels[j * src.width + i];
        }
        return refPut(new RefImage(src.height, src.width, out));
      }
      case 'fillImageAt': {
        const dst = refGet(msg.key), src = refGet(msg.image); if (!dst || !src) return null;
        const x = msg.x | 0, y = msg.y | 0;
        for (let j = 0; j < src.height && j + y < dst.height; j++) {
          for (let i = 0; i < src.width && i + x < dst.width; i++) {
            dst.pixels[(j + y) * dst.width + i + x] = src.pixels[j * src.width + i];
          }
        }
        return null;
      }
      case 'fillImageRangeAt': {
        const dst = refGet(msg.key), src = refGet(msg.image); if (!dst || !src) return null;
        const x = msg.x | 0, y = msg.y | 0, sx = msg.srcX | 0, sy = msg.srcY | 0, w = msg.width | 0, h = msg.height | 0;
        if (x + w > dst.width || y + h > dst.height || sx + w > src.width || sy + h > src.height) {
          throw new Error('fillImageRangeAt bounds');
        }
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          dst.pixels[(j + y) * dst.width + i + x] = src.pixels[(j + sy) * src.width + i + sx];
        }
        return null;
      }
      case 'getWidth': { const s = refGet(msg.key); return s ? s.width : null; }
      case 'getHeight': { const s = refGet(msg.key); return s ? s.height : null; }
      default: return null;
    }
  } catch (e) { return null; }
}

// --- 沙箱 ----------------------------------------------------------------------------------------

const SYNC_METHODS = ['convert', 'random', 'uuid', 'getLocale', 'getPlatform', 'load_data', 'save_data',
  'delete_data', 'load_setting', 'isLogged', 'log', 'cookie', 'delay', 'getClipboard', 'setClipboard'];

function makeSandbox() {
  const imageMessages = [];
  let promiseSendMessageCount = 0;
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, Error, RegExp,
    Map, Set, Uint8Array, Int8Array, Int32Array, ArrayBuffer, DataView, Buffer,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.Convert = {
    encodeUtf8: (s) => Buffer.from(String(s), 'utf8'),
    md5: (b) => crypto.createHash('md5').update(Buffer.from(b)).digest(),
    hexEncode: (b) => Buffer.from(b).toString('hex'),
  };

  function dispatch(msg) {
    if (msg && msg.method === 'image') {
      imageMessages.push(msg);
      return refHandle(msg);
    }
    return null;
  }
  sandbox.__sendMessageSync = dispatch;
  vm.createContext(sandbox);
  vm.runInContext([
    'globalThis.__SYNC_METHODS = ' + JSON.stringify(SYNC_METHODS) + ';',
    'globalThis.__sendCount = 0;',
    'globalThis.sendMessage = function (msg) {',           // 宿主 BRIDGE_SHIM 的等价物
    '  __sendCount++;',
    '  try {',
    '    var v = __sendMessageSync(msg);',
    '    if (msg && __SYNC_METHODS.indexOf(msg.method) !== -1) return v;',
    '    return Promise.resolve(v);',
    '  } catch (e) { return Promise.reject(e); }',
    '};',
  ].join('\n'), sandbox);
  vm.runInContext(initJs, sandbox);

  return { sandbox, imageMessages };
}

// --- A 节：补丁后的 Image 类在 Promise shim 下可用 ------------------------------------------------

function runSectionA() {
  section('A. init.js 的 Image 类走 __sendMessageSync（Promise shim 下必须照常工作）');
  const { sandbox, imageMessages } = makeSandbox();

  const out = vm.runInContext(`
    (function () {
      var img = Image.empty(3, 2);
      if (img === null || img === undefined) return 'empty failed';
      if (typeof img.key !== 'number') return 'key is ' + typeof img.key;
      if (img.width !== 3 || img.height !== 2) return 'size ' + img.width + 'x' + img.height;
      var win = Image.empty(4, 4);
      win.fillImageRangeAt(1, 1, img, 0, 0, 3, 2);
      var part = win.copyRange(1, 1, 3, 2);
      var rot = win.copyAndRotate90();
      if (rot.width !== 4 || rot.height !== 4) return 'rot ' + rot.width + 'x' + rot.height;
      return 'ok:' + part.width + 'x' + part.height;
    })()
  `, sandbox);

  check('Image.empty / width / height / fillImageRangeAt / copyRange / copyAndRotate90 全链可用', out === 'ok:3x2', out);
  check('全程零次走到 Promise 版 sendMessage（补丁钉死同步契约）',
    vm.runInContext("__sendCount", sandbox) === 0,
    String(vm.runInContext("__sendCount", sandbox)));
  check('所有消息 method === "image"', imageMessages.length > 0 && imageMessages.every((m) => m.method === 'image'),
    String(imageMessages.length) + ' messages');
  return { sandbox, imageMessages };
}

// --- B 节：真 jm.js 的 onImageLoad 分档 -----------------------------------------------------------

/** 从真 jm.js 切片 onImageLoad，箭头函数换成 function 以便绑定 this（与类实例调用等价）。 */
function extractOnImageLoad() {
  const startMarker = 'onImageLoad: (url, comicId, epId) => {';
  const endMarker = 'onThumbnailLoad: (url) => {';
  const start = jmJs.indexOf(startMarker);
  const end = jmJs.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) throw new Error('jm.js onImageLoad slice not found');
  let body = jmJs.slice(start, end);
  const docAt = body.lastIndexOf('/**');           // 去掉尾部下一个方法的 JSDoc
  if (docAt > 0) body = body.slice(0, docAt);
  body = body.trimEnd();
  if (body.endsWith(',')) body = body.slice(0, -1);
  const ctx = {
    Convert: {
      encodeUtf8: (s) => Buffer.from(String(s), 'utf8'),
      md5: (b) => crypto.createHash('md5').update(Buffer.from(b)).digest(),
      hexEncode: (b) => Buffer.from(b).toString('hex'),
    },
    Buffer, Math, String, Number,
  };
  ctx.globalThis = ctx;
  return vm.runInNewContext('(' + body.replace(startMarker, 'onImageLoad: function (url, comicId, epId) {').replace(/^onImageLoad:\s*/, '') + ')', ctx);
}

function expectedNum(epId, pictureName) {
  if (epId < 220980) return 0;
  if (epId < 268850) return 10;
  const hashStr = crypto.createHash('md5').update(Buffer.from(String(epId) + pictureName, 'utf8')).digest('hex');
  const charCode = hashStr.charCodeAt(hashStr.length - 1);
  return epId > 421926 ? (charCode % 8) * 2 + 2 : (charCode % 10) * 2 + 2;
}

const IMG_HEADERS = {
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  Referer: 'https://localhost/',
  'User-Agent': 'okhttp/3.12.0',
};

function pictureNameOf(url) {
  for (let i = url.length - 1; i >= 0; i--) {
    if (url[i] === '/') return url.substring(i + 1, url.length - 5);
  }
  return '';
}

function runSectionB() {
  section('B. 真 jm.js onImageLoad 按 epId 分档（条数公式）');
  const onImageLoad = extractOnImageLoad();
  const source = { getImgHeaders: () => IMG_HEADERS, onImageLoad };
  const imgUrl = (epId) => `https://cdn-msp.example.net/media/photos/${epId}/000abc.webp`;

  const old = source.onImageLoad(imgUrl(100000), '1014509', '100000');
  check('epId < 220980 → 无配置 {}（老章节不打散）',
    old !== null && typeof old === 'object' && old.headers === undefined && old.modifyImage === undefined,
    JSON.stringify(old));

  const mid = source.onImageLoad(imgUrl(250000), '1014509', '250000');
  check('220980 ≤ epId < 268850 → num=10 且带 headers + modifyImage',
    mid && mid.headers && mid.headers.Referer === IMG_HEADERS.Referer &&
      typeof mid.modifyImage === 'string' && mid.modifyImage.indexOf('const num = 10') !== -1,
    mid ? Object.keys(mid).join(',') : String(mid));

  const branches = [];
  for (const epId of [280000, 300000, 350000, 400000, 421926]) {
    branches.push([epId, expectedNum(epId, pictureNameOf(imgUrl(epId)))]);
  }
  let midOk = 0;
  for (const [epId, num] of branches) {
    const cfg = source.onImageLoad(imgUrl(epId), '1014509', String(epId));
    const got = cfg && cfg.modifyImage ? Number((cfg.modifyImage.match(/const num = (\d+)/) || [])[1]) : NaN;
    if (got === num) midOk++;
    else check(`epId=${epId} (268850..421926) → num=${num}`, false, 'got ' + got);
  }
  check(`md5 分档 268850..421926（%10）：${branches.length} 个采样全对`, midOk === branches.length,
    `${midOk}/${branches.length}`);

  const highBranch = [];
  for (const epId of [430000, 500000, 5500000, 5700000]) {
    highBranch.push([epId, expectedNum(epId, pictureNameOf(imgUrl(epId)))]);
  }
  let highOk = 0;
  for (const [epId, num] of highBranch) {
    const cfg = source.onImageLoad(imgUrl(epId), '1014509', String(epId));
    const got = cfg && cfg.modifyImage ? Number((cfg.modifyImage.match(/const num = (\d+)/) || [])[1]) : NaN;
    if (got === num) highOk++;
    else check(`epId=${epId} (>421926) → num=${num}`, false, 'got ' + got);
  }
  check(`md5 分档 >421926（%8）：${highBranch.length} 个采样全对`, highOk === highBranch.length,
    `${highOk}/${highBranch.length}`);

  const gif = source.onImageLoad('https://cdn.example.net/media/photos/250000/anim.gif', '1014509', '250000');
  check('gif → modifyImage 为 null（不做打散）', gif && gif.headers && gif.modifyImage === null,
    gif ? String(gif.modifyImage) : 'null');

  const picName = pictureNameOf(imgUrl(500000));
  check('pictureName = 文件名去掉末尾 5 字符（.webp）', picName === '000abc', picName);
  return { source, imgUrl };
}

// --- C 节：modifyImage 真脚本执行 → 条带倒序重排 --------------------------------------------------

function runSectionC(ctx, source, imgUrl) {
  section('C. modifyImage 执行（真脚本 × Image 原语）：条带倒序重排');
  const { sandbox, imageMessages } = makeSandbox(); // 全新沙箱，消息计数不被 A 节污染

  const W = 8, H = 10, NUM = 4;
  const srcKey = refPut(new RefImage(W, H, (() => {
    const px = new Int32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      px[r * W + c] = (0xFF << 24) | ((r + 1) * 0x010101); // 每行一个颜色
    }
    return px;
  })()));

  const config = source.onImageLoad(imgUrl(250000), '1014509', '250000');
  const script = config.modifyImage;
  check('onImageLoad 产出可执行脚本（含 num=10 逻辑，改用 num=4 的合成图同构执行）', typeof script === 'string', '');
  // 用合成 num（=4）的同类脚本验证语义：jm 的脚本结构固定，仅 num 不同。
  const synScript = script.replace(/const num = \d+/, 'const num = ' + NUM);

  const resultKey = vm.runInContext(
    '(function () {\n' + synScript + '\n' +
    `  var __r = modifyImage(new Image(${srcKey}));\n` +
    '  return (__r === null || __r === undefined) ? null : __r.key;\n' +
    '})()', sandbox);

  check('modifyImage 返回可用的整数句柄', typeof resultKey === 'number' && refGet(resultKey) !== null, String(resultKey));

  // 期望：blocks 底→顶重排。num=4, h=10 → blockSize=2, remainder=2 → b0=[0,2) b1=[2,4) b2=[4,6) b3=[6,10)
  // 结果行序：[6..9, 4..5, 2..3, 0..1]
  const blockOf = [];
  for (let i = NUM - 1; i >= 0; i--) {
    const start = i * Math.floor(H / NUM);
    const h = Math.floor(H / NUM) + (i === NUM - 1 ? H % NUM : 0);
    for (let k = 0; k < h; k++) blockOf.push(start + k);
  }
  const out = refGet(resultKey).pixels;
  let mismatches = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const want = (0xFF << 24) | ((blockOf[r] + 1) * 0x010101);
      if (out[r * W + c] !== want) mismatches++;
    }
  }
  check(`像素级验证：重排后每行等于原图第 ${JSON.stringify(blockOf)} 行`, mismatches === 0, mismatches + ' mismatches');

  const fillMsgs = imageMessages.filter((m) => m.function === 'fillImageRangeAt');
  check('fillImageRangeAt 恰好被调 NUM 次（每条带一次）', fillMsgs.length === NUM, String(fillMsgs.length));
  return imageMessages;
}

// --- D 节：消息形状 = Kotlin JsImageEngine 的契约 -------------------------------------------------

function runSectionD(imageMessages) {
  section('D. 消息形状契约（Kotlin JsImageEngine.handle 必须逐字段实现）');

  const fieldsOf = (m) => Object.keys(m).sort().join(',');
  const wantFill = 'function,height,image,key,method,srcX,srcY,width,x,y';
  const fillMsgs = imageMessages.filter((m) => m.function === 'fillImageRangeAt');
  check('fillImageRangeAt 字段集 {method,function,key,x,y,image,srcX,srcY,width,height}',
    fillMsgs.length > 0 && fillMsgs.every((m) => fieldsOf(m) === wantFill),
    fillMsgs.length ? fieldsOf(fillMsgs[0]) : 'no messages');

  const empties = imageMessages.filter((m) => m.function === 'emptyImage');
  check('emptyImage 字段集 {method,function,width,height}',
    empties.length > 0 && empties.every((m) => fieldsOf(m) === 'function,height,method,width'),
    empties.length ? fieldsOf(empties[0]) : 'no messages');

  const sizes = imageMessages.filter((m) => m.function === 'getWidth' || m.function === 'getHeight');
  check('getWidth/getHeight 字段集 {method,function,key}', sizes.length > 0 && sizes.every((m) => fieldsOf(m) === 'function,key,method'),
    sizes.length ? fieldsOf(sizes[0]) : 'no messages');

  const nums = imageMessages
    .map((m) => (m.function === 'emptyImage' || m.function === 'copyRange' || m.function === 'copyAndRotate90' ? refHandle(m) : undefined))
    .filter((v) => v !== undefined);
  check('句柄创建类函数返回整数（Kotlin 同样必须返回 Int/null，禁止容器）',
    nums.length === 0 || nums.every((v) => typeof v === 'number'), '');
}

// --- E 节：反向对照 —— 旧实现（走 Promise shim）必然静默失效 --------------------------------------

function runSectionE() {
  section('E. 反向对照：若 Image 类走 Promise 版 sendMessage，整条链静默失效');
  const { sandbox } = makeSandbox();
  vm.runInContext(`
    globalThis.__legacy = (function () {
      // 未打补丁时的形态：方法体用 sendMessage（Promise shim）。
      class LegacyImage {
        constructor(key) { this.key = key; }
        static empty(width, height) {
          let key = sendMessage({ method: 'image', function: 'emptyImage', width: width, height: height });
          return new LegacyImage(key);
        }
        fillImageRangeAt(x, y, image, srcX, srcY, width, height) {
          sendMessage({ method: 'image', function: 'fillImageRangeAt', key: this.key, x: x, y: y,
            image: image.key, srcX: srcX, srcY: srcY, width: width, height: height });
        }
      }
      var img = LegacyImage.empty(8, 10);
      var r = (function () {
        let modifyImage = (image) => {
          const num = 4;
          let res = LegacyImage.empty(8, 10);
          res.fillImageRangeAt(0, 0, image, 0, 0, 8, 10);
          return res;
        };
        return modifyImage(img);
      })();
      return { keyType: typeof r.key, isPromise: r.key instanceof Promise };
    })();
  `, sandbox);
  const legacy = {
    keyType: vm.runInContext("__legacy.keyType", sandbox),
    isPromise: vm.runInContext('__legacy.isPromise', sandbox),
  };
  check('旧实现下 modifyImage 的返回 key 是 Promise 而非数字 → Kotlin 拿不到句柄',
    legacy.keyType === 'object' && legacy.isPromise === true, JSON.stringify(legacy));
}

// -------------------------------------------------------------------------------------------------

(function main() {
  const ctx = runSectionA();
  const { source, imgUrl } = runSectionB();
  const msgs = runSectionC(ctx, source, imgUrl);
  runSectionD(msgs);
  runSectionE();

  console.log('\n' + (fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`) + `  (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
