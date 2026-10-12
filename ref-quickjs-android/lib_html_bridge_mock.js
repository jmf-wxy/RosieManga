'use strict';
/**
 * lib_html_bridge_mock.js — 纯 JS HTML DOM + html 桥 mock（台子共用）。
 *
 * 原来是 verify_goda_html_e2e.js 的内联实现，抽出来是为了让「goda 列表/排行」那组断言
 * （verify_goda_hot_latest_e2e.js）跑在**同一份** Dart `package:html` 语义 mock 上 ——
 * 两份各自维护的 mock 迟早会漂移，而漂移的方向总是「假绿」。
 *
 * 独立实现（不抄 Kotlin/Jsoup），只覆盖 Venera 源用到的子集：标签/类/id 复合选择器 +
 * `>` 子代 + 空格后代组合器；句柄注册表复刻 venera DocumentWrapper / JsHtmlBridge 契约。
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return m;
    }
  });
}

class MEl {
  constructor(tag, attrs, parent) {
    this.kind = 'element';
    this.tag = tag.toLowerCase();
    this.attrs = attrs;
    this.classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this.parent = parent;
    this.childNodes = [];
  }
  append(node) { node.parent = this; this.childNodes.push(node); }
  id() { return this.attrs.id || ''; }
  /** Dart `package:html` `Element.text` 语义：后代文本节点**原样**拼接（不折叠空白）。 */
  text() {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.kind === 'text') out += c.text;
        else if (c.kind === 'element') walk(c);
      }
    };
    walk(this);
    return decodeEntities(out);
  }
}

function parseHtml(src) {
  const root = new MEl('#document', {}, null);
  let cur = root;
  let i = 0;
  const n = src.length;
  const tagRe = /<!--[\s\S]*?-->|<!(?:doctype|DOCTYPE)[^>]*>|<\/([a-zA-Z][-\w]*)\s*>|<([a-zA-Z][-\w]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const attrRe = /([a-zA-Z_:@][-\w.:]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+)))?/g;
  while (i < n) {
    if (cur.tag === 'script' || cur.tag === 'style') {
      const close = src.toLowerCase().indexOf('</' + cur.tag, i);
      const end = close === -1 ? n : close;
      if (end > i) cur.append({ kind: 'text', text: src.slice(i, end), parent: cur });
      i = end;
      if (close !== -1) {
        // 消费闭合标签并出栈，否则下一轮 close === i 死循环。
        const gt = src.indexOf('>', close);
        cur = cur.parent || root;
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    tagRe.lastIndex = i;
    const m = tagRe.exec(src);
    if (!m) {
      const rest = src.slice(i);
      if (rest.trim()) cur.append({ kind: 'text', text: rest, parent: cur });
      break;
    }
    if (m.index > i) cur.append({ kind: 'text', text: src.slice(i, m.index), parent: cur });
    i = tagRe.lastIndex;
    if (m[0].startsWith('<!--')) { cur.append({ kind: 'comment', text: m[0], parent: cur }); continue; }
    if (m[0].startsWith('<!')) continue;
    if (m[1] !== undefined) { // closing tag
      let node = cur;
      while (node && node.tag !== m[1].toLowerCase() && node.tag !== '#document') node = node.parent;
      if (node && node.tag !== '#document') cur = node.parent;
      continue;
    }
    const attrs = {};
    const attrSrc = m[3] || '';
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(attrSrc))) {
      attrs[am[1].toLowerCase()] = decodeEntities(am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '');
    }
    const el = new MEl(m[2], attrs, cur);
    cur.append(el);
    if (!VOID_TAGS.has(el.tag) && m[4] !== '/') cur = el;
  }
  return root;
}

// --- 选择器 --------------------------------------------------------------------------------------

function parseCompound(tok) {
  const c = { tag: null, id: null, classes: [] };
  const m = tok.match(/^([a-zA-Z][-\w]*)?((?:[.#][-\w]+)*)$/);
  if (!m) throw new Error('unsupported selector token: ' + tok);
  if (m[1]) c.tag = m[1].toLowerCase();
  const rest = m[2] || '';
  const restRe = /([.#])([-\w]+)/g;
  let rm;
  while ((rm = restRe.exec(rest))) {
    if (rm[1] === '.') c.classes.push(rm[2]);
    else c.id = rm[2];
  }
  return c;
}

function compileSelector(sel) {
  const chain = [];
  const re = /\s*>\s*|\s+/g;
  let last = 0, rel = null, m;
  const push = (tok) => chain.push({ rel, c: parseCompound(tok) });
  while ((m = re.exec(sel))) {
    push(sel.slice(last, m.index));
    rel = m[0].trim() === '>' ? '>' : ' ';
    last = re.lastIndex;
  }
  push(sel.slice(last));
  return chain;
}

function matchCompound(el, c) {
  if (el.kind !== 'element') return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.id() !== c.id) return false;
  for (const cls of c.classes) if (!el.classes.has(cls)) return false;
  return true;
}

function matchChain(el, chain) {
  let node = el;
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = chain[i];
    if (i === chain.length - 1) {
      if (!matchCompound(node, step.c)) return false;
    } else if (step.rel === '>') {
      const p = node.parent;
      if (!p || p.tag === '#document' || !matchCompound(p, step.c)) return false;
      node = p;
    } else {
      let up = node.parent, found = null;
      while (up) {
        if (up.tag !== '#document' && matchCompound(up, step.c)) { found = up; break; }
        up = up.parent;
      }
      if (!found) return false;
      node = found;
    }
  }
  return true;
}

/** 文档序（先序）全元素。 */
function allElements(root) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) { if (c.kind === 'element') { out.push(c); walk(c); } } };
  walk(root);
  return out;
}

function selectAll(root, query) {
  const chain = compileSelector(query);
  const scoped = root.tag === '#document' ? allElements(root) : [root, ...allElements(root)];
  // Dart 语义：element 作用域只匹配后代（不含自身）。
  const candidates = root.tag === '#document' ? scoped : scoped.slice(1);
  return candidates.filter((el) => matchChain(el, chain));
}

function serializeEl(el) {
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  const inner = el.childNodes.map((c) => {
    if (c.kind === 'text') return c.text;
    if (c.kind === 'comment') return c.text;
    return serializeEl(c);
  }).join('');
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

// ================================================================================================
// 2) html 桥 mock —— 复刻 venera DocumentWrapper / JsHtmlBridge 契约（句柄注册表）。
// ================================================================================================

function makeHtmlBridge() {
  const docs = new Map();
  return (msg) => {
    const f = msg.function;
    const docLevel = f === 'querySelector' || f === 'querySelectorAll' || f === 'getElementById';
    if (f === 'parse') {
      docs.set(msg.key, { doc: parseHtml(msg.data), elements: [], nodes: [] });
      return null;
    }
    if (f === 'dispose') { docs.delete(msg.key); return null; }
    const d = docs.get(docLevel ? msg.key : msg.doc);
    if (!d) return null;
    const reg = (el) => { d.elements.push(el); return d.elements.length - 1; };
    const regN = (nd) => { d.nodes.push(nd); return d.nodes.length - 1; };
    switch (f) {
      case 'querySelector': { const el = selectAll(d.doc, msg.query)[0]; return el ? reg(el) : null; }
      case 'querySelectorAll': return selectAll(d.doc, msg.query).map(reg);
      case 'getElementById': {
        const el = allElements(d.doc).find((e) => e.attrs.id === msg.id);
        return el ? reg(el) : null;
      }
      case 'getText': { const el = d.elements[msg.key]; return el ? el.text() : null; }
      case 'getInnerHTML': { const el = d.elements[msg.key]; return el ? serializeEl(el) : null; }
      case 'getAttributes': { const el = d.elements[msg.key]; return el ? { ...el.attrs } : null; }
      case 'getParent': {
        const el = d.elements[msg.key];
        if (!el || !el.parent || el.parent.tag === '#document') return null;
        return reg(el.parent);
      }
      case 'dom_querySelector': {
        const root = d.elements[msg.key];
        const el = selectAll(root, msg.query)[0];
        return el && el !== root ? reg(el) : null;
      }
      case 'dom_querySelectorAll': {
        const root = d.elements[msg.key];
        return selectAll(root, msg.query).filter((e) => e !== root).map(reg);
      }
      case 'getChildren': {
        const el = d.elements[msg.key];
        return el ? el.childNodes.filter((c) => c.kind === 'element').map(reg) : null;
      }
      case 'getNodes': {
        const el = d.elements[msg.key];
        return el ? el.childNodes.map(regN) : null;
      }
      case 'getClassNames': { const el = d.elements[msg.key]; return el ? [...el.classes] : null; }
      case 'getId': { const el = d.elements[msg.key]; return el ? el.id() : null; }
      case 'getLocalName': { const el = d.elements[msg.key]; return el ? el.tag : null; }
      case 'getPreviousSibling': {
        const el = d.elements[msg.key];
        const sibs = el.parent.childNodes.filter((c) => c.kind === 'element');
        const idx = sibs.indexOf(el);
        return idx > 0 ? reg(sibs[idx - 1]) : null;
      }
      case 'getNextSibling': {
        const el = d.elements[msg.key];
        const sibs = el.parent.childNodes.filter((c) => c.kind === 'element');
        const idx = sibs.indexOf(el);
        return idx >= 0 && idx < sibs.length - 1 ? reg(sibs[idx + 1]) : null;
      }
      case 'node_text': {
        const nd = d.nodes[msg.key];
        if (!nd) return null;
        if (nd.kind === 'text') return decodeEntities(nd.text);
        if (nd.kind === 'element') return nd.text();
        return '';
      }
      case 'node_type': {
        const nd = d.nodes[msg.key];
        return nd ? (nd.kind === 'element' ? 'element' : nd.kind === 'text' ? 'text' : nd.kind === 'comment' ? 'comment' : 'unknown') : 'unknown';
      }
      case 'node_toElement':
      case 'node_to_element': {
        const nd = d.nodes[msg.key];
        return nd && nd.kind === 'element' ? reg(nd) : null;
      }
      default: return null;
    }
  };
}
module.exports = { makeHtmlBridge, parseHtml, selectAll, decodeEntities };
