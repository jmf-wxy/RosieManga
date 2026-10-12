// Reproduce the wrapper README's JSCallFunction return test, plus our bridge shape.
// Runs in Node with a mock of the wrapper's setProperty/callFunctionBack contract,
// so we can check OUR JS-side assumptions without a device.

const vm = require('vm');

const ctx = vm.createContext({});

// --- Mock the wrapper exactly as QuickJSContext does ---
// setProperty(name, JSCallFunction): native creates a JS function that calls
// callFunctionBack(id, ...args) and uses its RETURN VALUE as the JS result.
const callFunctionMap = new Map();
let idSeq = 1;

function putCallFunction(fn) {
  const id = idSeq++;
  callFunctionMap.set(id, fn);
  return id;
}

function callFunctionBack(id, ...args) {
  const fn = callFunctionMap.get(id);
  return fn.call(args);          // ← native must use this return value
}

vm.runInContext(`
  globalThis.__wrapJavaFn = function (id) {
    return function () {
      return __callFunctionBack(id, ...Array.from(arguments));
    };
  };
`, ctx);
ctx.__callFunctionBack = callFunctionBack;

// Register a JSCallFunction the way JsMessageDispatcher does
const dispatcher = {
  call(args) {
    const msg = args[0];
    switch (msg.method) {
      case 'getLocale': return 'zh_CN';
      case 'http': return { status: 200, headers: {}, body: null, error: null };
      default: return null;
    }
  },
};
const id = putCallFunction(dispatcher);
vm.runInContext(`globalThis.__sendMessageSync = __wrapJavaFn(${id});`, ctx);

// --- Now run the probes our Kotlin code runs ---
const probe = `
(function () {
  var out = {};
  var a = __sendMessageSync({ method: 'getLocale' });
  out.simpleType = typeof a;
  out.simpleValue = String(a);
  var b = __sendMessageSync({ method: 'http', url: 'x' });
  out.mapType = typeof b;
  out.mapKeys = (b && typeof b === 'object') ? Object.keys(b).join(',') : 'N/A';
  return out;
})()
`;

const result = vm.runInContext(probe, ctx);

console.log('=== mock-wrapper probe result ===');
console.log(JSON.stringify(result, null, 2));
console.log('');
console.log('EXPECT: simpleType=string, simpleValue=zh_CN, mapType=object');
console.log('If we get undefined here, the MOCK is wrong (not the device).');
