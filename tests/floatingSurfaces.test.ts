import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Surfaces that float over the page (QA D49, D07, D08, D69).
 *
 *  - D49: a dialog's fill was 94% of the page background with no blur, so
 *    dense dashboard text — "8.8 GB", the host name, list rows — read
 *    straight through Clean Up, Compare copies and the Move-to-Trash sheet.
 *    Every `.modal` now paints an OPAQUE base in both themes, and the
 *    element carries the same colour as a floor under its glass layer.
 *  - D07: the first-run coach card was `.glass` — 72% opaque — floating on
 *    the treemap canvas with no scrim; the cell labels showed through its
 *    text. It gets the opaque-glass recipe #rcPopover and #nlPop already use.
 *  - D08: toasts sat top-right, over the view toolbars (Live, Lens, refresh,
 *    Export), for 4–12 s. They are a bottom snackbar now, centred on the
 *    strip the sidebar and the right-hand surfaces (preview pane, cart dock,
 *    coach card) leave, above the selection bar while it is up, and at the
 *    top of the scrim while a dialog is open — checked from the desktop
 *    window's minimum size up.
 *  - D69: a dialog with no primary button takes focus on the sheet itself
 *    (tabindex -1), and the global :focus-visible ring then drew a thick
 *    accent outline around the whole keyboard-shortcuts sheet.
 *
 * Opacity is computed, not pattern-matched: every colour is resolved through
 * the theme tokens of BOTH themes, and the base (last) background layer must
 * come out at alpha 1.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SHEET = (() => {
  const open = INDEX.indexOf('<style>');
  assert.notEqual(open, -1, 'the built page carries an inline stylesheet');
  const close = INDEX.indexOf('</style>', open);
  assert.notEqual(close, -1, 'that stylesheet closes');
  return INDEX.slice(open + '<style>'.length, close).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();

/** The sheet's @media blocks: where each runs, and its max-width when that is all it asks (null: a query this reader does not evaluate). */
const MEDIA = [...SHEET.matchAll(/@media\s*([^{]*)\{/g)].map((m) => {
  let depth = 0, to = -1;
  for (let i = m.index! + m[0].length - 1; i < SHEET.length; i++) {
    if (SHEET[i] === '{') depth++;
    else if (SHEET[i] === '}' && --depth === 0) { to = i; break; }
  }
  const max = /^\(max-width:\s*(\d+(?:\.\d+)?)px\)$/.exec(m[1].trim());
  return { from: m.index!, to, max: max ? Number(max[1]) : null };
});

/** A rule, and — when it sits in an @media block — that block's max-width (null: one this reader cannot evaluate). */
type Rule = { selectors: string[]; body: string; media?: number | null };
const RULES: Rule[] = [...SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => {
    const block = MEDIA.find((b) => m.index! > b.from && m.index! < b.to);
    return { selectors: m[1].trim().split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2], ...(block ? { media: block.max } : {}) };
  })
  .filter((r) => r.selectors[0] && !r.selectors[0].startsWith('@'));

/** Declarations of one rule, last one wins, custom properties included. */
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  // Split on semicolons that are not inside parentheses.
  let depth = 0, start = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i === -1) continue;
    out.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  return out;
}

/** The declarations every rule naming exactly `selector` makes, merged in source order. */
function declsOf(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of RULES) if (r.selectors.includes(selector)) for (const [k, v] of decls(r.body)) out.set(k, v);
  return out;
}

const DARK = declsOf(':root');
const LIGHT = new Map([...DARK, ...declsOf(':root[data-theme="light"]')]);
const THEMES: [string, Map<string, string>][] = [['dark', DARK], ['light', LIGHT]];

/** Split a value on top-level commas (background layers). */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** Resolve `var(--x)` against a theme's tokens (one level of fallback ignored). */
function resolve(value: string, tokens: Map<string, string>, depth = 0): string {
  assert.ok(depth < 10, `var() chain too deep resolving ${value}`);
  const m = /^var\((--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(value.trim());
  if (!m) return value.trim();
  const v = tokens.get(m[1]);
  assert.ok(v !== undefined, `${m[1]} is defined in this theme`);
  return resolve(v!, tokens, depth + 1);
}

/** Alpha of a single colour value: hex, rgb(a), named transparent, or color-mix with transparent. */
function alphaOf(value: string, tokens: Map<string, string>): number {
  const v = resolve(value, tokens);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return 1;
  if (/^#[0-9a-f]{8}$/i.test(v)) return parseInt(v.slice(7, 9), 16) / 255;
  if (v === 'transparent') return 0;
  let m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length === 4 ? Number(parts[3]) : 1;
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (m) {
    const p = Number(m[2]) / 100;
    return alphaOf(m[1], tokens) * p + alphaOf(m[3], tokens) * (1 - p);
  }
  return assert.fail(`cannot read a colour from "${v}"`);
}

/** The base (bottom) layer of a background value, resolved first so a token holding a whole stack counts. */
function baseAlpha(value: string, tokens: Map<string, string>): number {
  const full = resolve(value, tokens);
  const ls = layers(full);
  return alphaOf(ls[ls.length - 1], tokens);
}

/**
 * Selector specificity as [ids, classes/attrs/pseudo-classes, types].
 * `:is()`, `:not()` and `:has()` count as their most specific argument and
 * `:where()` as nothing — the rule that decides which #toasts slot wins.
 */
function specificity(sel: string): [number, number, number] {
  let ids = 0, cls = 0, types = 0;
  const s = sel.replace(/::[\w-]+/g, ' ')
    .replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, fn: string, arg: string) => {
      if (fn !== 'where') {
        const best = arg.split(',').map((a) => specificity(a.trim()))
          .reduce((x, y) => (beats(y, x) ? y : x), [0, 0, 0] as [number, number, number]);
        ids += best[0]; cls += best[1]; types += best[2];
      }
      return ' ';
    });
  ids += (s.match(/#[\w-]+/g) || []).length;
  cls += (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?/g) || []).length;
  types += (s.replace(/\[[^\]]+\]/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, cls, types];
}
const beats = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/* ══════════════ D49 — every dialog is opaque, in both themes ══════════════ */

test('the dialog sheet paints an opaque base in both themes — the page no longer reads through it (D49)', () => {
  const modal = declsOf('.modal');
  const tint = modal.get('--lg-tint');
  assert.ok(tint, '.modal sets the glass tint its lens layer paints');
  const floor = modal.get('background');
  assert.ok(floor, '.modal carries a background of its own, under the glass layer');
  for (const [name, tokens] of THEMES) {
    assert.equal(baseAlpha(tint!, tokens), 1, `${name}: the tint's base layer is opaque — was 94% of the page background`);
    assert.equal(baseAlpha(floor!, tokens), 1, `${name}: and so is the floor, should the lens layer ever not paint`);
  }
});

test('the glass layer that paints a dialog reads the tint the sheet sets', () => {
  const before = declsOf('.lg::before');
  assert.equal(before.get('background'), 'var(--lg-tint)', 'the lens fill is the tint');
  assert.match(before.get('z-index') || '', /^-1$/, 'and sits above the element’s own background, below its content');
  // The engine makes every .modal a lens host, which is what puts that layer there.
  const targets = INDEX.slice(INDEX.indexOf('/* Which elements get the lens, and how strong. */'), INDEX.indexOf('const SELECTOR ='));
  assert.match(targets, /\['\.modal',/, '.modal is a lens target');
});

test('no rule or inline style makes a particular dialog translucent again (D49)', () => {
  for (const r of RULES) {
    for (const sel of r.selectors) {
      // A selector whose LAST compound is a .modal (not .modal-head, .modal-backdrop…).
      const last = sel.split(/[\s>+~]+/).pop() || '';
      if (!/\.modal(?![\w-])/.test(last) || /::?(before|after)/.test(last)) continue;
      const d = decls(r.body);
      for (const prop of ['--lg-tint', 'background', 'background-color']) {
        const v = d.get(prop);
        if (v === undefined || sel === '.modal') continue;
        for (const [name, tokens] of THEMES) {
          assert.equal(baseAlpha(v, tokens), 1, `${name}: ${sel} sets ${prop} to a translucent base: ${v}`);
        }
      }
      assert.ok(!/(^|;)\s*opacity\s*:/.test(r.body) || sel.includes(':not('), `${sel} does not fade a dialog`);
    }
  }
  for (const m of INDEX.matchAll(/<div class="modal(?: [^"]*)?"([^>]*)>/g)) {
    assert.doesNotMatch(m[1], /background|opacity/, `an inline style on a dialog cannot thin it: ${m[0]}`);
  }
});

/* ══════════════ D07 — the coach card is opaque ══════════════ */

test('the first-run coach card is opaque in both themes, outranking the 72% .glass fill it also carries (D07)', () => {
  assert.match(INDEX, /<div class="tour-card glass" id="tourCard">/, 'the card still carries .glass, so the override must outrank it');
  const rule = RULES.find((r) => r.selectors.some((s) => /\.tour-card/.test(s)) && decls(r.body).has('background'));
  assert.ok(rule, 'a rule gives the coach card its own background');
  const bg = decls(rule!.body).get('background')!;
  for (const [name, tokens] of THEMES) {
    assert.equal(baseAlpha(bg, tokens), 1, `${name}: the coach card's base layer is opaque`);
  }
  // Every .glass background rule — including the light theme's — must lose to it.
  const glassRules = RULES.filter((r) => decls(r.body).has('background'))
    .flatMap((r) => r.selectors.filter((s) => /(^|\s)(:root\[data-theme="light"\] )?\.glass$/.test(s)));
  assert.ok(glassRules.length >= 2, `found the .glass fills: ${glassRules.join(' | ')}`);
  for (const g of glassRules) {
    const themed = g.startsWith(':root[data-theme="light"]');
    const mine = rule!.selectors.filter((s) => s.startsWith(':root[data-theme="light"]') === themed);
    assert.ok(mine.length && mine.some((s) => beats(specificity(s), specificity(g))),
      `${g} is outranked by the coach card's own ${themed ? 'light-theme ' : ''}selector (${rule!.selectors.join(', ')})`);
  }
});

/* ══════════════ D08 — toasts cover no toolbar and no overlay ══════════════ */

function px(v: string | undefined): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec((v || '').trim());
  assert.ok(m, `a px length: ${v}`);
  return Number(m![1]);
}

/**
 * A page state: which `:has(…)` conditions hold, whether the preview pane is open, whether the cart's
 * drawer is open (`body.cart-open`, set by cartDockToggle — never without `#cartDock.show`, since an
 * emptied cart closes the drawer), and the window's width, which decides the `@media (max-width)` rules.
 */
type PageState = { active: string[]; preview?: boolean; cartOpen?: boolean; W?: number };

/** `body`, `body.preview-open`, `.cart-open` and any run of `:has(…)` after them: do they hold in `st`? */
function bodyHolds(prefix: string, st: PageState): boolean {
  if (!prefix.startsWith('body')) return false;
  let rest = prefix.slice(4);
  if (rest.startsWith('.preview-open')) {
    if (!st.preview) return false;
    rest = rest.slice('.preview-open'.length);
  }
  if (rest.startsWith('.cart-open')) {
    if (!st.cartOpen) return false;
    rest = rest.slice('.cart-open'.length);
  }
  while (rest) {
    if (!rest.startsWith(':has(')) return false;
    let depth = 0, end = -1;
    for (let i = 4; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end === -1) return false;
    const cond = rest.slice(5, end);
    // The sidebar is open exactly when it is not collapsed.
    const holds = cond === '#sideNav:not(.collapsed)' ? !st.active.includes('#sideNav.collapsed') : st.active.includes(cond);
    if (!holds) return false;
    rest = rest.slice(end + 1);
  }
  return true;
}

/**
 * What one element computes to in a page state: every rule whose selector is
 * the element itself, or a `body…` condition then the element, applied by
 * specificity and then source order — the browser's cascade, for the shapes
 * these rules take. A rule inside `@media (max-width: N)` counts only in a
 * state whose window is N px or narrower; one inside any other query never.
 */
function cascade(target: string, st: PageState): Map<string, string> {
  const hits: { spec: [number, number, number]; at: number; body: string }[] = [];
  RULES.forEach((r, at) => {
    if (r.media !== undefined && !(r.media !== null && st.W !== undefined && st.W <= r.media)) return;
    for (const sel of r.selectors) {
      let ok = false;
      if (target === 'body') ok = bodyHolds(sel, st);
      else if (sel === target) ok = true;
      else if (sel.endsWith(' ' + target)) ok = bodyHolds(sel.slice(0, -target.length - 1), st);
      if (ok) hits.push({ spec: specificity(sel), at, body: r.body });
    }
  });
  hits.sort((a, b) => (beats(a.spec, b.spec) ? 1 : beats(b.spec, a.spec) ? -1 : a.at - b.at));
  const out = new Map<string, string>();
  for (const h of hits) for (const [k, v] of decls(h.body)) out.set(k, v);
  return out;
}

/** Evaluate a CSS length (px, vw, vh, calc/min/max/var) to px in a W×H window.
    A % is of the window's width: every length read here is a fixed box's left or width. */
function evalLen(src: string, vars: Map<string, string>, W: number, H: number): number {
  let i = 0;
  const s = src.trim();
  const ws = () => { while (s[i] === ' ') i++; };
  const args = (): number[] => {
    const out: number[] = [];
    for (;;) { out.push(expr()); ws(); if (s[i] === ',') { i++; continue; } assert.equal(s[i], ')', `")" in ${src}`); i++; return out; }
  };
  function factor(): number {
    ws();
    if (s[i] === '(') { i++; const v = expr(); ws(); i++; return v; }
    if (s[i] === '-' && !/\d/.test(s[i + 1] || '')) { i++; return -factor(); }
    const fn = /^(calc|min|max|var)\(/.exec(s.slice(i));
    if (fn) {
      i += fn[0].length;
      if (fn[1] === 'var') {
        const m = /^\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/.exec(s.slice(i))!;
        i += m[0].length;
        const v = vars.get(m[1]) ?? m[2];
        assert.ok(v !== undefined, `${m[1]} is defined for ${src}`);
        return evalLen(v!, vars, W, H);
      }
      const a = args();
      return fn[1] === 'calc' ? a[0] : fn[1] === 'min' ? Math.min(...a) : Math.max(...a);
    }
    const m = /^(-?\d+(?:\.\d+)?)(px|vw|vh|%)?/.exec(s.slice(i));
    assert.ok(m, `a number at "${s.slice(i)}" in ${src}`);
    i += m![0].length;
    const n = Number(m![1]);
    return m![2] === 'vw' || m![2] === '%' ? (n * W) / 100 : m![2] === 'vh' ? (n * H) / 100 : n;
  }
  function term(): number {
    let v = factor();
    for (;;) { ws(); if (s[i] === '*') { i++; v *= factor(); } else if (s[i] === '/') { i++; v /= factor(); } else return v; }
  }
  function expr(): number {
    let v = term();
    for (;;) { ws(); if (s[i] === '+' && s[i + 1] === ' ') { i++; v += term(); } else if (s[i] === '-' && s[i + 1] === ' ') { i++; v -= term(); } else return v; }
  }
  const v = expr();
  ws();
  assert.equal(i, s.length, `the whole of "${src}" was read`);
  return v;
}

/** Custom properties the cascade gives `el`, on top of the :root tokens and `body`'s own. */
function scope(st: PageState, ...layers: Map<string, string>[]): Map<string, string> {
  const vars = new Map([...DARK].filter(([k]) => k.startsWith('--')));
  for (const layer of [cascade('body', st), ...layers]) for (const [k, v] of layer) if (k.startsWith('--')) vars.set(k, v);
  return vars;
}

/** The widest toast's horizontal extent in a W-px window and page state. */
function toastSpan(W: number, H: number, st: PageState): [number, number] {
  const stack = cascade('#toasts', st);
  const vars = scope(st, stack);
  const toast = cascade('.toast', st);
  const w = Math.min(evalLen(toast.get('max-width')!, vars, W, H), evalLen(stack.get('max-width')!, vars, W, H));
  const centre = evalLen(stack.get('left')!, vars, W, H);
  assert.match(stack.get('transform') || '', /translateX\(-50%\)/, 'the stack is centred on its own width');
  return [centre - w / 2, centre + w / 2];
}

/**
 * Where each right-hand surface starts (its left edge) in a W-px window, when it is up — each read
 * from its own rules in that state (the open cart, the preview pane, the window's @media), so a
 * surface that moves is found where it moved to, not where it rests.
 */
function rightSurfaces(W: number, given: PageState): { name: string; left: number }[] {
  const st: PageState = { ...given, W };
  const out: { name: string; left: number }[] = [];
  if (st.preview) out.push({ name: 'the preview pane', left: W - px(declsOf('#previewPane').get('width')) });
  if (st.active.includes('#cartDock.show')) {
    const dock = cascade('#cartDock', st);
    const vars = scope(st, dock);
    const w = Math.min(evalLen(dock.get('width')!, vars, W, MIN_H), evalLen(dock.get('max-width')!, vars, W, MIN_H));
    out.push({ name: 'the cart dock', left: W - evalLen(dock.get('right')!, vars, W, MIN_H) - w });
  }
  if (st.active.includes('#tourOverlay:not([hidden])')) {
    const card = cascade('.tour-card', st);
    const vars = scope(st, card);
    out.push({ name: 'the coach card', left: W - evalLen(card.get('right')!, vars, W, MIN_H) - evalLen(card.get('width')!, vars, W, MIN_H) });
  }
  return out;
}

const MIN_W = 1024, MIN_H = 700; // the desktop window's minimum (electron/main.js WINDOW_DEFAULTS)

test('the desktop window minimum the slots are proven at is the one the app sets', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, new RegExp(`minWidth: ${MIN_W}, minHeight: ${MIN_H}`));
});

test('toasts rest at the bottom, never over the top-right view toolbars (D08)', () => {
  const t = declsOf('#toasts');
  assert.equal(t.get('position'), 'fixed');
  assert.equal(t.get('top'), undefined, 'not anchored to the top, where Live / Lens / refresh / Export sit');
  assert.ok(px(t.get('bottom')) >= 0, 'anchored to the bottom');
  assert.equal(t.get('right'), undefined, 'and not pinned right, where the cart dock and coach card live');
});

test('a toast stays clear of the sidebar, the preview pane, the cart dock and the coach card at every window size — the open cart\'s drawer too, with the coach card standing left of it (D08, review F1.12)', () => {
  const overlays = ['#cartDock.show', '#tourOverlay:not([hidden])'];
  const residual: string[] = [];
  let checked = 0, besideOpenCart = 0;
  for (const W of [MIN_W, 1320, 1440, 1920]) {
    for (const collapsed of [false, true]) {
      for (const preview of [false, true]) {
        for (let mask = 0; mask < 1 << overlays.length; mask++) {
          const active = overlays.filter((_, b) => mask & (1 << b));
          if (collapsed) active.push('#sideNav.collapsed');
          // The drawer opens only over a shown dock (an emptied cart closes it).
          for (const cartOpen of active.includes('#cartDock.show') ? [false, true] : [false]) {
            const st: PageState = { active, preview, cartOpen, W };
            const [x0, x1] = toastSpan(W, MIN_H, st);
            const sideEdge = 12 + px(collapsed ? declsOf(':root').get('--side-w-rail') : declsOf(':root').get('--side-w'));
            const right = rightSurfaces(W, st);
            const label = `${W}px, sidebar ${collapsed ? 'rail' : 'open'}${preview ? ', preview' : ''}${active.filter((a) => a !== '#sideNav.collapsed').map((a) => ', ' + a).join('')}${cartOpen ? ', cart open' : ''}`;
            const room = Math.min(W, ...right.map((r) => r.left)) - sideEdge - 24;
            if (room < 240) { residual.push(label); continue; }
            checked++;
            if (cartOpen && active.includes('#tourOverlay:not([hidden])')) besideOpenCart++;
            assert.ok(x0 >= sideEdge, `${label}: the toast starts at ${x0}px, the sidebar ends at ${sideEdge}px`);
            for (const r of right) assert.ok(x1 <= r.left, `${label}: the toast ends at ${x1}px, ${r.name} starts at ${r.left}px`);
            assert.ok(x1 - x0 >= 240, `${label}: a toast keeps a readable width (${x1 - x0}px)`);
          }
        }
      }
    }
  }
  assert.ok(checked >= 80, `the clear cases were checked (${checked})`);
  // The coach card stands left of the open cart (H51): those states are
  // checked against where it stands then, not where it rests (review F1.12).
  assert.ok(besideOpenCart >= 7, `the coach card beside the open cart was checked where there is room for a toast (${besideOpenCart})`);
  // The states with no clear room left: the pane AND the cart open (the dock
  // then sits left of the pane) in the smallest window; and the coach card
  // standing left of the open cart in a window under ~1280 px (~1110 px with
  // the sidebar a rail), or under ~1610 px with the preview pane open too.
  assert.deepEqual(residual, [
    `${MIN_W}px, sidebar open, #cartDock.show, #tourOverlay:not([hidden]), cart open`,
    `${MIN_W}px, sidebar open, preview, #cartDock.show`,
    `${MIN_W}px, sidebar open, preview, #cartDock.show, #tourOverlay:not([hidden])`,
    `${MIN_W}px, sidebar open, preview, #cartDock.show, #tourOverlay:not([hidden]), cart open`,
    `${MIN_W}px, sidebar rail, #cartDock.show, #tourOverlay:not([hidden]), cart open`,
    `${MIN_W}px, sidebar rail, preview, #cartDock.show`,
    `${MIN_W}px, sidebar rail, preview, #cartDock.show, #tourOverlay:not([hidden])`,
    `${MIN_W}px, sidebar rail, preview, #cartDock.show, #tourOverlay:not([hidden]), cart open`,
    '1320px, sidebar open, preview, #cartDock.show, #tourOverlay:not([hidden]), cart open',
    '1320px, sidebar rail, preview, #cartDock.show, #tourOverlay:not([hidden]), cart open',
    '1440px, sidebar open, preview, #cartDock.show, #tourOverlay:not([hidden]), cart open',
  ], 'only the pane-and-cart corner of the smallest window, and the coach card beside the open cart where the window is too narrow for a toast between them and the sidebar, are left without room');
});

test('while the selection bar is up, toasts sit above it rather than over its buttons (D08)', () => {
  const lifted = declsOf('body:has(#selectionBar.visible) #toasts');
  assert.ok(lifted.has('bottom'), 'a rule lifts the stack when the bar shows');
  const bar = declsOf('#selectionBar');
  const pad = (bar.get('padding') || '').split(/\s+/).map((v) => px(v));
  const btn = px(declsOf('.btn').get('min-height'));
  const barTop = px(bar.get('bottom')) + pad[0] * 2 + btn;
  assert.ok(px(lifted.get('bottom')) > barTop,
    `the stack starts at ${px(lifted.get('bottom'))}px, above the bar's top at ~${barTop}px`);
});

/* ══════════════ B22 + B36 — the selection bar, the cart pill and the treemap's hint ══════════════ */

/** A shorthand side list → [top, right, bottom, left] in px. */
function sides4(v: string): number[] {
  const p = v.trim().split(/\s+/).map((s) => (s === '0' ? 0 : px(s)));
  return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
}

/**
 * The selection bar's controls, each a width estimate: 7 px a character of
 * 13 px text, a 16 px icon and its 7 px gap, the .btn padding and border. The
 * count line is the long form ("12,345 items selected — 123.4 GB").
 */
function selectionBarItems(): number[] {
  const btnPad = sides4(declsOf('.btn').get('padding') || '0')[1];
  const bar = INDEX.slice(INDEX.indexOf('<div class="glass" id="selectionBar">'), INDEX.indexOf('<!-- ═══════════ Offload progress'));
  const buttons = [...bar.matchAll(/<button class="btn[^"]*" id="(\w+)"[^>]*>(<span data-icon="\w+"><\/span>)?([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map((b) => b[1]), ['selOffloadBtn', 'selTrashBtn', 'selClearBtn'], 'the bar’s three buttons');
  return ['12,345 items selected — 123.4 GB'.length * 7,
    ...buttons.map((b) => (b[2] ? 16 + 7 : 0) + b[3].length * 7 + 2 * btnPad + 2)];
}

/** Rows a wrapping flex line needs for `items` in `inner` px with `gap` between them. */
function rowsFor(items: number[], inner: number, gap: number): number {
  let rows = 1, used = 0;
  for (const w of items) {
    if (used && used + gap + w > inner) { rows++; used = w; } else used += (used ? gap : 0) + w;
  }
  return rows;
}

/** The selection bar's box in a W-px window: left/right edges, bottom and height. */
function barBox(W: number, H: number, st: PageState) {
  const bar = cascade('#selectionBar', st);
  const vars = scope(st, bar);
  assert.match(bar.get('transform') || '', /^translateX\(-50%\)/, 'the bar is centred on its own width');
  const centre = evalLen(bar.get('left')!, vars, W, H);
  const maxW = bar.has('max-width') ? evalLen(bar.get('max-width')!, vars, W, H) : Infinity;
  const [padY, padX] = sides4(bar.get('padding')!);
  const gaps = (bar.get('gap') || '0').split(/\s+/).map((g) => px(g));
  const rowGap = gaps[0], colGap = gaps[1] ?? gaps[0];
  const items = selectionBarItems();
  const natural = items.reduce((s, w) => s + w, 0) + colGap * (items.length - 1) + 2 * padX + 2;
  const width = Math.min(natural, maxW);
  const rows = natural <= maxW ? 1 : rowsFor(items, width - 2 * padX - 2, colGap);
  if (rows > 1) assert.equal(bar.get('flex-wrap'), 'wrap', 'a bar narrower than its controls wraps them rather than overflowing');
  const btnH = px(declsOf('.btn').get('min-height'));
  const height = 2 * padY + 2 + rows * btnH + (rows - 1) * rowGap;
  return { x0: centre - width / 2, x1: centre + width / 2, bottom: px(bar.get('bottom')), height, rows };
}

/** The cart pill (#cartTab) height: its padding and border around a 17 px icon or a 13 px line. */
function pillHeight(): number {
  const tab = declsOf('#cartTab');
  return 2 * sides4(tab.get('padding')!)[0] + 2 + Math.max(17, px(tab.get('font-size')) * 1.35);
}

test('the selection bar never shares a pixel with the cart pill, the preview pane or the sidebar — at every window size (B22)', () => {
  // QA: with the preview pane open the cart pill sat over "Move to Trash" and
  // "Clear" (1440, 1320 and 1024 wide); at 1024 the pane covered the bar's
  // end too. The bar was centred on the WINDOW, blind to the sidebar, the
  // pane and the pill.
  const pillH = pillHeight();
  let checked = 0;
  for (const W of [MIN_W, 1180, 1320, 1440, 1920]) {
    for (const collapsed of [false, true]) {
      for (const preview of [false, true]) {
        for (const cart of [false, true]) {
          const active = ['#selectionBar.visible', ...(cart ? ['#cartDock.show'] : []), ...(collapsed ? ['#sideNav.collapsed'] : [])];
          const st: PageState = { active, preview };
          const label = `${W}px, sidebar ${collapsed ? 'rail' : 'open'}${preview ? ', preview' : ''}${cart ? ', cart' : ''}`;
          const b = barBox(W, MIN_H, st);
          const sideEdge = 12 + px(collapsed ? declsOf(':root').get('--side-w-rail') : declsOf(':root').get('--side-w'));
          assert.ok(b.x0 >= sideEdge, `${label}: the bar starts at ${b.x0.toFixed(0)}px, the sidebar ends at ${sideEdge}px`);
          assert.ok(b.x1 <= W, `${label}: the bar ends inside the window (${b.x1.toFixed(0)}px)`);
          if (preview) {
            const pane = W - px(declsOf('#previewPane').get('width'));
            assert.ok(b.x1 <= pane, `${label}: the bar ends at ${b.x1.toFixed(0)}px, the preview pane starts at ${pane}px`);
          }
          if (cart) {
            const dock = cascade('#cartDock', st);
            const dockBottom = px(dock.get('bottom'));
            const pillLeft = rightSurfaces(W, st).find((r) => r.name === 'the cart dock')!.left;
            const pillRight = pillLeft + px(declsOf('#cartDock').get('width'));
            const apartX = b.x1 <= pillLeft || b.x0 >= pillRight;
            const apartY = b.bottom + b.height <= dockBottom || dockBottom + pillH <= b.bottom;
            assert.ok(apartX || apartY,
              `${label}: the bar (${b.x0.toFixed(0)}–${b.x1.toFixed(0)}px, up to ${(b.bottom + b.height).toFixed(0)}px) and the pill (${pillLeft}–${pillRight}px from ${dockBottom}px up) overlap`);
          }
          const toasts = px(cascade('#toasts', st).get('bottom'));
          assert.ok(toasts >= b.bottom + b.height + 6, `${label}: toasts start at ${toasts}px, above the bar's top at ${(b.bottom + b.height).toFixed(0)}px`);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 40, 'every size and state was checked');
});

test('the cart pill leaves the bottom of the page clear, so the treemap’s hint line is never under it (B36)', () => {
  // QA: "click to drill in · drag to lass" — the pill covered the rest of the
  // hint (lasso, magnifier, Esc), the only on-screen mention of those
  // gestures. The map is fitted to the window less <main>'s bottom padding,
  // so the footer's last line sits that far above the window's bottom edge.
  const padB = (st: PageState) => {
    const m = cascade('main', st);
    return m.has('padding-bottom') ? px(m.get('padding-bottom')) : sides4(m.get('padding')!)[2];
  };
  const pillTop = px(declsOf('#cartDock').get('bottom')) + pillHeight();
  const withCart = padB({ active: ['#cartDock.show'] });
  assert.ok(withCart >= pillTop + 8, `with the cart up the page ends ${withCart}px above the bottom; the pill reaches ${pillTop.toFixed(1)}px`);
  assert.ok(padB({ active: [] }) < withCart, 'and with no cart the page keeps its own, smaller bottom margin');
});

test('the Grid fills <main> exactly with the cart up as well as without — the room the pill takes is not an outer scroll (B36 review F1.2)', () => {
  // Review: the Grid owns the window (100vh less main's padding, so <main>
  // never scrolls around it). B36 raised main's bottom padding from 48 to
  // 76 px while the cart holds anything, and the Grid did not follow: <main>
  // grew a 28 px scroll and the Grid's toolbar slid away. A height, not a
  // min-height (QA D01): with only a floor the Grid grew to hold every tile
  // and <main> scrolled the page around it — tests/gridViewQa drives that.
  let checked = 0;
  for (const H of [MIN_H, 800, 900, 1200]) {
    for (const cart of [false, true]) {
      const st: PageState = { active: [...(cart ? ['#cartDock.show'] : []), '#view-grid.active'] };
      const main = cascade('main', st);
      const [padT, , padB0] = sides4(main.get('padding')!);
      const padB = main.has('padding-bottom') ? px(main.get('padding-bottom')) : padB0;
      const grid = cascade('#view-grid.active', st);
      assert.ok(grid.has('height'), 'the Grid has a height of its own, not only a floor');
      const gridH = evalLen(grid.get('height')!, scope(st, grid), 1440, H);
      const used = padT + gridH + padB;
      assert.equal(used, H,
        `${H}px tall${cart ? ', cart up' : ''}: <main> holds ${padT} + ${gridH} + ${padB} = ${used}px — ` +
        (used > H ? `the page scrolls ${used - H}px around the Grid` : `${H - used}px of window sits empty under it`));
      checked++;
    }
  }
  assert.equal(checked, 8, 'every height was checked with and without the cart');
});

/* ══════════════ D02 — the Grid's last row clears the stacked bars ══════════════ */

/** <main>'s bottom padding in a page state: where the Grid's scroller ends, above the window's bottom. */
function mainPadBottom(st: PageState): number {
  const main = cascade('main', st);
  return main.has('padding-bottom') ? px(main.get('padding-bottom')) : sides4(main.get('padding')!)[2];
}

/** A length the Grid's scroller declares, in px — its var()s read from the page's custom properties and the scroller's own. */
function scrollerLen(st: PageState, sc: Map<string, string>, v: string): number {
  return evalLen(v, scope(st, sc), 1440, MIN_H);
}

/** The Grid's scroller: how far above the window's bottom its last row ends when scrolled to the end. */
function gridFootClearance(st: PageState): number {
  const sc = cascade('#gridScroll', st);
  const padB = sc.has('padding-bottom') ? scrollerLen(st, sc, sc.get('padding-bottom')!) : sides4(sc.get('padding')!)[2];
  // layoutGrid leaves its GAP below the last row: #gridInner is that much taller than the rows.
  const gap = Number((/^const GAP = (\d+), MIN_SQ = /m.exec(INDEX) || [])[1]);
  assert.ok(gap > 0, 'the Grid\'s GAP is in the built page');
  return mainPadBottom(st) + padB + gap;
}

/**
 * Where keyboard focus leaves a tile in the Grid: its bottom edge, in px above
 * the window's bottom. A tile Tab reaches only partly in view is scrolled to
 * the nearest edge of the scroller's window less its scroll-padding there
 * (Chromium's focus scroll: a partly visible element goes to the closest edge
 * of the snapport) — with none, the scroller's very edge.
 */
function gridFocusLine(st: PageState): number {
  const sc = cascade('#gridScroll', st);
  const spb = sc.get('scroll-padding-bottom');
  return mainPadBottom(st) + (spb === undefined ? 0 : scrollerLen(st, sc, spb));
}

/** Every window size and page state with a bar over the Grid's foot, and how high those bars reach above the window's bottom. */
function eachGridFootState(fn: (s: { W: number; st: PageState; label: string; bar: boolean; covered: number }) => void): number {
  const pillH = pillHeight();
  let checked = 0;
  for (const W of [MIN_W, 1180, 1320, 1440, 1920]) {
    for (const collapsed of [false, true]) {
      for (const preview of [false, true]) {
        for (const cart of [false, true]) {
          for (const bar of [false, true]) {
            if (!cart && !bar) continue;
            const active = ['#view-grid.active', ...(bar ? ['#selectionBar.visible'] : []), ...(cart ? ['#cartDock.show'] : []),
              ...(collapsed ? ['#sideNav.collapsed'] : [])];
            const st: PageState = { active, preview };
            const label = `${W}px, sidebar ${collapsed ? 'rail' : 'open'}${preview ? ', preview' : ''}${bar ? ', a selection' : ''}${cart ? ', cart' : ''}`;
            let covered = 0;
            if (bar) { const b = barBox(W, MIN_H, st); covered = Math.max(covered, b.bottom + b.height); }
            if (cart) covered = Math.max(covered, px(cascade('#cartDock', st).get('bottom')) + pillH);
            fn({ W, st, label, bar, covered });
            checked++;
          }
        }
      }
    }
  }
  return checked;
}

test('scrolled to its end, the Grid\'s last row clears the selection bar and the cart pill stacked over it, at every window size (D02)', () => {
  // QA: with something staged and a tile selected, the pill steps up to
  // 124 px above the selection bar — ~170 px of stacked bars over the
  // bottom of the Grid — while the Grid kept 10 px of padding: at 1440×900
  // the selected last-row tile sat under the pill with nothing to scroll,
  // and at 1024×768 scrolled to the end it was still under the dock.
  const checked = eachGridFootState(({ st, label, covered }) => {
    const clear = gridFootClearance(st);
    assert.ok(clear >= covered + 8,
      `${label}: the last row ends ${clear}px above the window's bottom; the bars over it reach ${covered.toFixed(0)}px`);
  });
  assert.equal(checked, 60, 'every size and state was checked');
  // Nothing up, nothing kept: the Grid's own padding is all there is.
  assert.equal(gridFootClearance({ active: ['#view-grid.active'] }), 48 + 10 + 12, 'with no bar and no cart the Grid keeps only its own padding');
});

test('a tile Tab brings into view stops clear of the selection bar and the cart pill — on the line a scroll to the end and a click bring it to (review F2.5)', () => {
  // D02 keeps room at the Grid's foot while the bar is up, and a scroll to
  // the end and a click (gridScrollClear) both stop a tile above it. Focus
  // did not: the next row Tab reaches is usually only partly in view, and
  // the browser scrolls it to the scroller's very edge — its bottom, and its
  // focus ring, under the bar (and the pill) for a run of Tabs (WCAG 2.2
  // 2.4.11, Focus Not Obscured).
  const checked = eachGridFootState(({ st, label, bar, covered }) => {
    const focus = gridFocusLine(st);
    assert.ok(focus >= covered + 8,
      `${label}: a tile Tab brings into view ends ${focus}px above the window's bottom; the bars over it reach ${covered.toFixed(0)}px`);
    if (bar) assert.equal(focus, gridFootClearance(st), `${label}: on the line a scroll to the end and a click bring a tile to`);
  });
  assert.equal(checked, 60, 'every size and state was checked');
});

/* ══════════════ C04 — the preview pane narrows the page, it never covers it ══════════════ */

test('with the preview pane open the page lays out left of it, at every window size — nothing in <main> is under the pane (C04, the B22 remainder)', () => {
  // QA re-check: the pane was a fixed layer over the right 330 px of the page.
  // In "Preview after" with the cart collapsed, "Exit preview" and the end of
  // the banner sat under it (unclickable); the Grid's Sort control and half its
  // Filter box were hidden; at 1024×700 the selected tile itself was under it.
  // Every one of those lives in <main>, an in-flow item of <body>'s grid: the
  // body's right padding is what the content column ends at.
  assert.equal(declsOf('body').get('display'), 'grid', '<body> lays the sidebar and <main> out as a grid');
  assert.ok(!/fixed|absolute/.test(declsOf('main').get('position') || ''), '<main> is in flow, so the body\'s padding bounds it');
  const pane = declsOf('#previewPane');
  assert.equal(pane.get('right'), '0', 'the pane is pinned to the window\'s right edge');
  let checked = 0;
  for (const W of [640, MIN_W, 1180, 1320, 1440, 1920, 2560]) {
    for (const collapsed of [false, true]) {
      for (const preview of [false, true]) {
        const st: PageState = { active: collapsed ? ['#sideNav.collapsed'] : [], preview };
        const body = cascade('body', st);
        const padR = body.has('padding-right') ? evalLen(body.get('padding-right')!, scope(st), W, MIN_H) : 0;
        const label = `${W}px, sidebar ${collapsed ? 'rail' : 'open'}${preview ? ', preview' : ''}`;
        if (preview) {
          const paneW = Math.min(px(pane.get('width')), evalLen(pane.get('max-width')!, scope(st), W, MIN_H));
          assert.ok(W - padR <= W - paneW, `${label}: the page's column ends at ${W - padR}px, the pane starts at ${W - paneW}px`);
        } else {
          assert.equal(padR, 0, `${label}: with the pane shut the page keeps the whole window`);
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 28, 'every size and state was checked');
});

test('while a dialog is open, toasts sit above the sheet, at the smallest window too (D08)', () => {
  const up = cascade('#toasts', { active: ['.modal-backdrop.open'] });
  assert.equal(up.get('bottom'), 'auto', 'no longer anchored to the bottom, where a tall sheet keeps its footer buttons');
  const top = px(up.get('top'));
  const toast = declsOf('.toast');
  const pad = (toast.get('padding') || '').split(/\s+/).map((v) => px(v));
  const line = px(toast.get('font-size')) * Number(toast.get('line-height'));
  const oneLine = pad[0] * 2 + line + 2, twoLines = oneLine + line;
  assert.equal(declsOf('.modal-backdrop').get('align-items'), 'center', 'sheets are centred');
  const cap = /^(\d+)vh$/.exec(declsOf('.modal').get('max-height') || '');
  assert.ok(cap, 'a sheet’s height is capped in vh');
  const headPad = px((declsOf('.modal-head').get('padding') || '').split(/\s+/)[0]);
  for (const H of [MIN_H, 880, 900]) {
    const sheetTop = ((100 - Number(cap![1])) / 2) * (H / 100);
    assert.ok(top + oneLine <= sheetTop,
      `${H}px tall: a one-line toast spans ${top}–${(top + oneLine).toFixed(1)}px, the tallest sheet starts at ${sheetTop}px`);
    assert.ok(top + twoLines <= sheetTop + headPad,
      `${H}px tall: a two-line toast ends at ${(top + twoLines).toFixed(1)}px, inside the sheet's empty top padding (to ${sheetTop + headPad}px)`);
  }
});

test('a dialog opened from the selection bar still puts toasts at the top, and the stack never takes a click (D08)', () => {
  // Move to Trash from the Grid's selection bar is exactly this state: the
  // bar is up AND a sheet is open. The bar's lift must not win the cascade
  // over the dialog slot, or the stack is pinned top AND bottom at once.
  const both = cascade('#toasts', { active: ['#selectionBar.visible', '.modal-backdrop.open'] });
  assert.equal(both.get('bottom'), 'auto', 'the dialog slot outranks the selection-bar lift');
  assert.equal(both.get('top'), declsOf('body:has(.modal-backdrop.open) #toasts').get('top'), 'the stack sits at the top of the scrim');
  assert.equal(cascade('#toasts', { active: ['#selectionBar.visible'] }).get('bottom'),
    declsOf('body:has(#selectionBar.visible) #toasts').get('bottom'), 'with no dialog the lift still applies');
  assert.equal(cascade('#toasts', { active: [] }).get('top'), undefined, 'and the resting slot is the bottom');
  // A box with no background still takes the clicks that land on it: the
  // stack is see-through to the pointer, the toasts on it are not.
  assert.equal(declsOf('#toasts').get('pointer-events'), 'none', 'the stack lets clicks through to the page');
  assert.equal(declsOf('.toast').get('pointer-events'), 'auto', 'a toast keeps its own buttons');
});

/* ══════════════ B27 — the plain-words popover is opaque ══════════════ */

/** The glass engine's TARGETS list, as shipped. */
function lensTargets(): string {
  const from = INDEX.indexOf('/* Which elements get the lens, and how strong. */');
  const to = INDEX.indexOf('const SELECTOR =', from);
  assert.ok(from !== -1 && to > from, 'the glass engine still lists its lens targets');
  return INDEX.slice(from, to);
}

test('the plain-words popover is opaque in both themes — its glass recipe is painted, not just written (B27)', () => {
  // #nlPop declared #rcPopover's opaque recipe as --lg-tint, but only a lens
  // host (.lg, which the engine adds) paints --lg-tint through .lg::before.
  // The popover was never one, so its own .glass class painted --glass-strong
  // — 72% opaque, no blur — and the toolbar, the field list and the
  // time-lapse controls read straight through "Translates to — check it…".
  const tint = declsOf('#nlPop').get('--lg-tint');
  assert.ok(tint, '#nlPop sets the tint its lens layer paints');
  for (const [name, tokens] of THEMES) {
    assert.equal(baseAlpha(tint!, tokens), 1, `${name}: the popover's tint has an opaque base`);
  }
  assert.match(lensTargets(), /\['#nlPop',/,
    '#nlPop is a lens target: .lg::before paints its tint and `.lg.glass` drops the 72% .glass fill under it');
  assert.equal(declsOf('.lg::before').get('background'), 'var(--lg-tint)', 'the lens layer is what reads the tint');
  assert.equal(declsOf('.lg.glass').get('background'), 'none', 'and a lens host carrying .glass paints no fill of its own');
});

test('every element that declares a glass tint is one the engine makes a lens host — a tint nothing reads is the B27 trap', () => {
  const targets = lensTargets();
  const seen: string[] = [];
  for (const r of RULES) {
    if (!decls(r.body).has('--lg-tint')) continue;
    for (const sel of r.selectors) {
      const last = (sel.split(/[\s>+~]+/).pop() || '').replace(/::?[\w-]+(\([^)]*\))?/g, '');
      const key = /^[#.][\w-]+/.exec(last)?.[0];
      if (!key) continue; // :root and the theme blocks declare the token, they do not paint it
      seen.push(key);
      const id = key.startsWith('#') ? key.slice(1) : null;
      const markupLg = id !== null && new RegExp(`id="${id}"[^>]*class="[^"]*\\blg\\b|class="[^"]*\\blg\\b[^"]*"[^>]*id="${id}"`).test(INDEX);
      assert.ok(targets.includes(`['${key}',`) || markupLg,
        `${sel} sets --lg-tint, but ${key} is not a lens target and carries no .lg — the tint is never painted`);
    }
  }
  assert.ok(seen.includes('#nlPop') && seen.includes('#rcPopover') && seen.includes('.modal'),
    `the scan found the tinted surfaces (${[...new Set(seen)].join(', ')})`);
});

/* ══════════════ D69 — no ring around a whole dialog ══════════════ */

test('a dialog that takes focus itself draws no focus ring around the whole sheet (D69)', () => {
  const fn = INDEX.slice(INDEX.indexOf('function modalFocusTarget('), INDEX.indexOf('function modalFocusInto('));
  assert.match(fn, /dlg\.setAttribute\('tabindex', '-1'\)/, 'the sheet itself is the fallback focus target, at tabindex -1');
  const ring = declsOf(':focus-visible');
  assert.match(ring.get('outline') || '', /solid var\(--accent\)/, 'the global ring this has to beat');
  for (const sel of ['.modal[tabindex="-1"]:focus', '.modal[tabindex="-1"]:focus-visible']) {
    const d = declsOf(sel);
    assert.equal(d.get('outline'), 'none', `${sel} draws no outline`);
    assert.ok(beats(specificity(sel), specificity(':focus-visible')), `${sel} outranks the global ring`);
  }
});

/* ══════════════ The global search panel is opaque, like the dialogs (QA-7 follow-up to D49) ══════════════ */

test('the global search panel paints an opaque base in both themes — the Dashboard no longer reads through its results', () => {
  // It floats over whatever the page shows, often the dense Dashboard; its
  // fill was 94% of the page background, so text bled through the rows.
  const dark = declsOf('.gsearch-panel').get('background');
  const light = declsOf(':root[data-theme="light"] .gsearch-panel').get('background');
  assert.ok(dark, '.gsearch-panel sets its own background');
  assert.ok(light, 'and the light theme sets its own');
  assert.equal(baseAlpha(dark!, DARK), 1, 'dark: the base layer is opaque — was 94% of the page background');
  assert.equal(baseAlpha(light!, LIGHT), 1, 'light: the base layer is opaque — was 94% of the page background');
  for (const r of RULES) {
    for (const sel of r.selectors) {
      if (!/\.gsearch-panel(?![\w-])/.test(sel.split(/[\s>+~]+/).pop() || '') || /::?(before|after)/.test(sel)) continue;
      const v = decls(r.body).get('background') ?? decls(r.body).get('background-color');
      if (v === undefined) continue;
      for (const [name, tokens] of THEMES) assert.equal(baseAlpha(v, tokens), 1, `${name}: ${sel} keeps the panel opaque: ${v}`);
    }
  }
});

/* ══════════════ The reclaim breakdown scrolls inside its panel (POL item 3) ══════════════ */

test('the reclaim breakdown scrolls inside its panel, never the panel itself: the opaque backing and the ring stay under the text, and a focus ring inside is not clipped (POL item 3)', () => {
  // #rcPopover is a lensed surface: its opaque fill is .lg::before and its
  // ring .lg::after, both absolutely positioned against it. As the scroll
  // container (overflow:auto) it carried them away with the rows, and a
  // scrolled breakdown showed its text over a see-through sheet. Everything
  // it shows scrolls in .rc-pop-scroll instead, as #ctxMenu's entries scroll
  // in .ctx-list (QA-6b review F1.11). The scroller carries the panel's
  // padding, so the page's focus ring — drawn outside what it marks — has
  // room inside the box that clips it.
  assert.match(INDEX, /\['#rcPopover',/, 'control: #rcPopover is one of the liquid-glass engine\'s surfaces');
  const panel = declsOf('#rcPopover');
  const scroller = declsOf('#rcPopover .rc-pop-scroll');
  const ring = declsOf(':focus-visible');
  const px = (v: string | undefined): number => Number(/(-?\d+(?:\.\d+)?)px/.exec(v ?? '')?.[1] ?? NaN);
  const reach = px(ring.get('outline')) + px(ring.get('outline-offset'));
  assert.ok(reach > 0, `control: the page's ring reaches ${reach} px past what it marks`);
  const room = (scroller.get('padding') ?? '').split(/\s+/).map(px);
  assert.deepEqual({
    panelScrolls: [...panel.keys()].filter((k) => /^overflow/.test(k)),
    panelCapped: panel.has('max-height'),
    panelPadding: panel.get('padding'),
    scrollerCap: scroller.get('max-height'),
    scrollerScrolls: scroller.get('overflow-y'),
    contained: scroller.get('overscroll-behavior'),
    ringRoom: room.length > 0 && room.every((p) => p >= reach),
    corners: scroller.get('border-radius'),
  }, {
    panelScrolls: [],
    panelCapped: false,
    panelPadding: '0',
    scrollerCap: `calc(70vh - ${2 * px(panel.get('border'))}px)`, // the panel's 70vh, less its border above and below
    scrollerScrolls: 'auto',
    contained: 'contain',
    ringRoom: true,
    // Its clip follows the panel's rounded corners, as the panel's own did: a
    // scrollbar that takes room (Windows, Linux) stays inside them.
    corners: 'inherit',
  });
  // Everything the panel shows is written inside the scroller: the template
  // opens with it, and the <div> that closes it is the template's last.
  const open = INDEX.slice(INDEX.indexOf('function openReclaimWhy('), INDEX.indexOf('function closeReclaimWhy('));
  const from = open.indexOf('pop.innerHTML = `');
  assert.notEqual(from, -1, 'control: openReclaimWhy writes the panel from one template');
  const template = open.slice(from + 'pop.innerHTML = `'.length, open.indexOf('`;', from)).trim();
  let depth = 0;
  let closedAt = -1;
  for (const tag of template.matchAll(/<div\b|<\/div>/g)) {
    depth += tag[0] === '</div>' ? -1 : 1;
    if (depth === 0) { closedAt = tag.index!; break; }
  }
  assert.deepEqual({
    opensWith: template.startsWith('<div class="rc-pop-scroll">'),
    closesLast: closedAt === template.length - '</div>'.length,
    holds: ['<div class="rc-pop-head">', 'id="rcPopClose"', '<div class="rc-radar-wrap">', '${reclaimWhyHtml(fact)}'].every((part) => {
      const at = template.indexOf(part);
      return at > 0 && at < closedAt;
    }),
  }, { opensWith: true, closesLast: true, holds: true }, 'the head, its close button, the radar and the rows are all inside .rc-pop-scroll');
});
