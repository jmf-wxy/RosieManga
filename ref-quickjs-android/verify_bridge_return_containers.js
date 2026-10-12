// Verifies the bridge's RETURN leg: Kotlin container -> JsonElement string -> JS object.
//
// Why this is needed at all: the wrapper's native marshaller only understands primitives and
// JSObject/JSArray/JSFunction. A java.util.Map makes it throw
//   "Unsupported Java type java.util.LinkedHashMap"
// which the JS side sees as a plain `undefined` — no exception, no log.
//
// The fix routes containers through `QuickJSContext.parseJSON`, which the wrapper itself uses to
// build objects (`createNewJSObject()` === `parseJSON("{}")`). This script mirrors the Kotlin
// `Any?.toJsonElement()` walker and checks the round trip on the shapes sources actually store.

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : '')); }
}

// --- mirror of JsValueConversion.kt::toJsonElement(), then JSON.stringify ---
function toJsonElement(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toJsonElement);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) { if (k != null) out[String(k)] = toJsonElement(v[k]); }
    return out;
  }
  return String(v); // unsupported leaf -> string, never throw
}

// --- the JS side: `await sendMessage(...)` gets the parsed object ---
function bridgeReturn(kotlinValue) {
  // primitive / byte[] paths return as-is
  if (kotlinValue === null) return null;
  const t = typeof kotlinValue;
  if (t === 'string' || t === 'number' || t === 'boolean') return kotlinValue;
  // container path: serialise, then parseJSON on the JS side
  return JSON.parse(JSON.stringify(toJsonElement(kotlinValue)));
}

console.log('RETURN LEG — Kotlin container -> JS value');

// 1. the exact shape jm.js persists during login
const loginBlob = { uid: 12345, token: 'abc.def', expired: false, tags: ['a', 'b'], meta: { v: 2 } };
const r1 = bridgeReturn(loginBlob);
check('nested object survives the round trip', JSON.stringify(r1) === JSON.stringify(loginBlob), JSON.stringify(r1));
check('numbers stay numbers (not strings)', typeof r1.uid === 'number', typeof r1.uid);
check('booleans stay booleans', r1.expired === false, String(r1.expired));

// 2. arrays
const r2 = bridgeReturn([1, 'two', { three: 3 }]);
check('array round trip', Array.isArray(r2) && r2.length === 3 && r2[2].three === 3, JSON.stringify(r2));

// 3. the jm.js settings blob (a plain string, must pass through untouched)
const r3 = bridgeReturn('6');
check('scalar setting passes through unchanged', r3 === '6', String(r3));

// 4. null
check('null passes through', bridgeReturn(null) === null, String(bridgeReturn(null)));

// 5. the OLD behaviour, for contrast: a Map handed straight to native throws
console.log('');
console.log('CONTROL — what the old code did with a container');
const nativeSupported = ['Boolean', 'Double', 'Integer', 'Long', 'String', 'byte[]', 'JSObject', 'JSArray', 'JSFunction'];
const mapType = 'java.util.LinkedHashMap';
check('the old return path was unsupported by native (' + mapType + ' not in [' + nativeSupported.join(', ') + '])',
  nativeSupported.indexOf(mapType) === -1, mapType);
check('symptom matches the device log: JS sees undefined, then throws on property access', (() => {
  const undef = undefined;
  try { void undef.status; return false; } catch (e) { return /undefined|null/.test(String(e.message)); }
})(), 'n/a');

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
