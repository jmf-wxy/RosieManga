// Verifies the two JS-level detection semantics we need for parseAccountMode.
//
// 1. Venera's `_checkExists` is: `X !== null && X !== undefined`
//    -> this is *truthy-agnostic*: a declared-but-falsy value ('' / 0 / false) still counts.
// 2. `account.login` is a FUNCTION. We therefore must ask `typeof === "function"` in JS rather
//    than reading the key out of a converted Map: the QuickJS wrapper's convertToMap drops
//    JSFunction-valued entries (it calls release() and `continue`s), so `map["login"]` is null
//    even when the source declares login. That is exactly why the login row disappeared.

function checkExists(obj, path) {
  // Mirrors ComicSource.sources.<key>.account.login !== null && !== undefined
  const v = path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
  return v !== null && v !== undefined;
}

const jm = {
  account: {
    login: async (a, p) => ({ error: false }),
    logout: () => {},
    registerWebsite: null,
  },
};

const cookiesOnly = {
  account: {
    loginWithCookies: { fields: ['c1', 'c2'], validate: () => true },
    logout: () => {},
  },
};

const webviewOnly = {
  account: {
    loginWithWebview: { url: 'https://example.com/login', checkStatus: () => true },
    logout: () => {},
  },
};

const noAccount = {};

const cases = [
  ['jm (password login)', jm],
  ['cookies only', cookiesOnly],
  ['webview only', webviewOnly],
  ['no account', noAccount],
];

for (const [label, obj] of cases) {
  const out = {
    hasAccount: checkExists(obj, 'account'),
    loginFn: typeof (obj.account && obj.account.login) === 'function',
    loginWithWebview: checkExists(obj, 'account.loginWithWebview'),
    loginWithCookiesFields: obj.account && obj.account.loginWithCookies
      ? (obj.account.loginWithCookies.fields || []).slice()
      : null,
  };
  console.log(label.padEnd(22), JSON.stringify(out));
}

// A single-call variant: what one `evalForValueBlocking` of this expression yields.
// Every value is a primitive (boolean / array of strings), so it survives marshalling intact.
const probeExpr = (o) => `(function () {
  var s = ${JSON.stringify(o)};  /* replaced by the real root at runtime */
  return null;
})()`;
void probeExpr;
console.log('\nprobe expression shape:');
console.log(
  `var __a = ROOT.account;` +
    ` ({ has: __a !== null && __a !== undefined,` +
    ` login: !!(__a && typeof __a.login === 'function'),` +
    ` webview: !!(__a && __a.loginWithWebview !== null && __a.loginWithWebview !== undefined),` +
    ` cookieFields: (__a && __a.loginWithCookies && __a.loginWithCookies.fields) || null,` +
    ` register: (__a && __a.registerWebsite) || null })`,
);
