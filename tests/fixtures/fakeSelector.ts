import assert from 'node:assert/strict';

/**
 * A fake DOM element as far as a CSS selector can see it: its tag, id,
 * classes, attributes and place in the tree.
 *
 * Harnesses that stub `document.querySelectorAll` answer it with `selectAll`
 * below, so the selector the page passes is the selector the harness obeys.
 * Two harnesses once returned a fixed list for any selector that mentioned
 * `.view.active`. Every assertion behind them then held whatever the page's
 * selector said, including one that dropped inputs, menus and the tab order,
 * or one that picked the view's own <section> (B13 review F3.2).
 */
export interface SelectorNode {
  tagName: string;
  id: string;
  cls: Set<string>;
  attrs: Record<string, string>;
  parent: SelectorNode | null;
  children: SelectorNode[];
}

/** One compound selector: `button`, `.view.active`, `[tabindex="0"]`, `#id`, or any run of them. */
type Compound = { tag: string | null; ids: string[]; classes: string[]; attrs: Array<[string, string | null]> };

/** The selector list split at its top-level commas (a comma inside `[…]` or quotes stays). */
function splitList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of selector) {
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0 && !quote) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function compound(text: string, whole: string): Compound {
  const out: Compound = { tag: null, ids: [], classes: [], attrs: [] };
  let at = 0;
  for (const m of text.matchAll(/^([a-z][a-z0-9-]*|\*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gi)) {
    // A part this reader skips would match anything: refuse the selector instead.
    assert.equal(m.index, at, `the fake DOM cannot read "${text.slice(at)}" in "${whole}"`);
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.ids.push(m[3]);
    else out.attrs.push([m[4], m[5] ?? null]);
    at = m.index! + m[0].length;
  }
  assert.equal(at, text.length, `the fake DOM cannot read "${text.slice(at)}" in "${whole}"`);
  return out;
}

/** Each selector of the list as its chain of compounds, joined by the descendant combinator (the only one read). */
function parse(selector: string): Compound[][] {
  return splitList(selector).map((part) => {
    assert.ok(part, `"${selector}" has an empty selector in its list`);
    return part.split(/\s+/).map((c) => compound(c, selector));
  });
}

function matchesCompound(el: SelectorNode, c: Compound): boolean {
  if (c.tag && c.tag !== '*' && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  if (c.classes.some((k) => !el.cls.has(k))) return false;
  return c.attrs.every(([k, v]) => k in el.attrs && (v === null || el.attrs[k] === v));
}

/** `el` matches the chain's last compound and, in order, an ancestor matches each one before it. */
function matchesChain(el: SelectorNode, chain: Compound[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = el.parent; p && i >= 0; p = p.parent) if (matchesCompound(p, chain[i])) i--;
  return i < 0;
}

/** What `root.querySelectorAll(selector)` returns: the descendants of `root` that match, in document order. */
export function selectAll<T extends SelectorNode>(root: T, selector: string): T[] {
  const chains = parse(selector);
  const out: T[] = [];
  const walk = (n: SelectorNode) => {
    for (const c of n.children) {
      if (chains.some((chain) => matchesChain(c, chain))) out.push(c as T);
      walk(c);
    }
  };
  walk(root);
  return out;
}
