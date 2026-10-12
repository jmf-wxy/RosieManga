// Verifies that BINARY bridge arguments survive as byte[], not as a LinkedHashMap.
//
// The bug (device log): java.lang.ClassCastException: java.util.LinkedHashMap cannot be cast to byte[]
//   thrown from JsMessageDispatcher.convert() during `refreshDomains`.
//
// Mechanism: `JSObject.toMap()` recurses into EVERY property as an object. A JS ArrayBuffer is an
// object (it has `byteLength`), so it came back as a LinkedHashMap and the bytes were gone.
// `getProperty(name)` instead asks native for the value, and native knows `[B` / `[I` — so an
// ArrayBuffer arrives as a real byte[].
//
// This harness models both readers and asserts which one preserves the payload.

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// A stand-in for a JS object reachable through the wrapper, holding a typed value.
// ---------------------------------------------------------------------------
function makeJsObject(props, typedNames) {
  return {
    __js: true,
    names: Object.keys(props),
    props: props,
    // native knows the type of `typedNames` entries and hands back byte[]
    getProperty(name) {
      const v = props[name];
      if (typedNames.indexOf(name) !== -1 && v && v.__arrayBuffer) return v.bytes;
      return v;
    },
    getNames() { return { __jsArray: true, items: Object.keys(props), length: () => Object.keys(props).length, get: (i) => Object.keys(props)[i] }; },
  };
}

// --- CURRENT (toKotlinValue / toMap): recurses into the ArrayBuffer as an object ---
function readViaToMap(obj) {
  const out = {};
  for (const k of Object.keys(obj.props)) {
    const v = obj.props[k];
    // toMap() sees an ArrayBuffer as an object with byteLength -> LinkedHashMap
    out[k] = (v && v.__arrayBuffer) ? { byteLength: v.bytes.length } : v;
  }
  return out;
}

// --- FIXED (readProperties / getProperty): lets native decide the type ---
function readViaGetProperty(obj) {
  const out = {};
  for (const k of obj.names) {
    const v = obj.getProperty(k);
    out[k] = (v && v.__js) ? readViaGetProperty(v) : v;
  }
  return out;
}

const payload = {
  method: 'convert',
  type: 'base64',
  isEncode: false,
  value: { __arrayBuffer: true, bytes: Buffer.from('a.example.com\nb.example.com') },
};
const arg = makeJsObject(payload, ['value']);

console.log('BINARY ARGUMENT — ArrayBuffer must arrive as byte[]');

const viaToMap = readViaToMap(arg).value;
check('toMap() loses the bytes (reproduces the ClassCastException precondition)',
  !Buffer.isBuffer(viaToMap) && typeof viaToMap === 'object', JSON.stringify(viaToMap));
check('casting that to byte[] would throw — matches the device log',
  (() => { try { if (!Buffer.isBuffer(viaToMap)) throw new TypeError('java.util.LinkedHashMap cannot be cast to byte[]'); return false; } catch (e) { return /cannot be cast to byte\[\]/.test(e.message); } })(),
  'n/a');

const viaGetProperty = readViaGetProperty(arg).value;
check('getProperty() preserves the payload as bytes', Buffer.isBuffer(viaGetProperty), typeof viaGetProperty);
check('the decoded bytes are byte-identical',
  Buffer.isBuffer(viaGetProperty) && viaGetProperty.toString() === 'a.example.com\nb.example.com',
  viaGetProperty && viaGetProperty.toString());

// --- nested containers still work through getProperty ---
console.log('');
console.log('STRUCTURE — nested objects / arrays still convert');

const nested = makeJsObject({
  method: 'http',
  headers: { 'User-Agent': 'x', Accept: '*/*' },
  body: null,
}, []);
const r = readViaGetProperty(nested);
check('nested plain object survives', r.headers && r.headers['User-Agent'] === 'x', JSON.stringify(r));
check('null stays null', r.body === null, String(r.body));

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
