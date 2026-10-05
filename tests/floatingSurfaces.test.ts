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

type Rule = { selectors: string[]; body: string };
const RULES: Rule[] = [...SHEET.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].trim().split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] }))
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

/** A page state: which `:has(…)` conditions hold, and whether the preview pane is open. */
type PageState = { active: string[]; preview?: boolean };

/** `body`, `body.preview-open` and any run of `:has(…)` after them: do they hold in `st`? */
function bodyHolds(prefix: string, st: PageState): boolean {
  if (!prefix.startsWith('body')) return false;
  let rest = prefix.slice(4);
  if (rest.startsWith('.preview-open')) {
    if (!st.preview) return false;
    rest = rest.slice('.preview-open'.length);
  }
  while (rest) {
    if (!rest.startsWith(':has(')) return false;
    let depth = 0, end = -1;
    for (let i = 4; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end === -1) return false;
    if (!st.active.includes(rest.slice(5, end))) return false;
    rest = rest.slice(end + 1);
  }
  return true;
}

/**
 * What one element computes to in a page state: every rule whose selector is
 * the element itself, or a `body…` condition then the element, applied by
 * specificity and then source order — the browser's cascade, for the shapes
 * these rules take.
 */
function cascade(target: string, st: PageState): Map<string, string> {
  const hits: { spec: [number, number, number]; at: number; body: string }[] = [];
  RULES.forEach((r, at) => {
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

/** Where each right-hand surface starts (its left edge) in a W-px window, when it is up. */
function rightSurfaces(W: number, st: PageState): { name: string; left: number }[] {
  const out: { name: string; left: number }[] = [];
  if (st.preview) out.push({ name: 'the preview pane', left: W - px(declsOf('#previewPane').get('width')) });
  if (st.active.includes('#cartDock.show')) {
    const dock = declsOf('#cartDock');
    const right = st.preview ? px(declsOf('body.preview-open #cartDock').get('right')) : px(dock.get('right'));
    out.push({ name: 'the cart dock', left: W - right - px(dock.get('width')) });
  }
  if (st.active.includes('#tourOverlay:not([hidden])')) {
    const card = declsOf('.tour-card');
    const capped = /^min\((\d+)px, calc\(100vw - (\d+)px\)\)$/.exec(card.get('width') || '');
    assert.ok(capped, 'the coach card has a capped width');
    out.push({ name: 'the coach card', left: W - px(card.get('right')) - Math.min(Number(capped![1]), W - Number(capped![2])) });
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

test('a toast stays clear of the sidebar, the preview pane, the cart dock and the coach card at every window size (D08)', () => {
  const overlays = ['#cartDock.show', '#tourOverlay:not([hidden])'];
  const residual: string[] = [];
  let checked = 0;
  for (const W of [MIN_W, 1320, 1440, 1920]) {
    for (const collapsed of [false, true]) {
      for (const preview of [false, true]) {
        for (let mask = 0; mask < 1 << overlays.length; mask++) {
          const active = overlays.filter((_, b) => mask & (1 << b));
          if (collapsed) active.push('#sideNav.collapsed');
          const st: PageState = { active, preview };
          const [x0, x1] = toastSpan(W, MIN_H, st);
          const sideEdge = 12 + px(collapsed ? declsOf(':root').get('--side-w-rail') : declsOf(':root').get('--side-w'));
          const right = rightSurfaces(W, st);
          const label = `${W}px, sidebar ${collapsed ? 'rail' : 'open'}${preview ? ', preview' : ''}${active.filter((a) => a !== '#sideNav.collapsed').map((a) => ', ' + a).join('')}`;
          const room = Math.min(W, ...right.map((r) => r.left)) - sideEdge - 24;
          if (room < 240) { residual.push(label); continue; }
          checked++;
          assert.ok(x0 >= sideEdge, `${label}: the toast starts at ${x0}px, the sidebar ends at ${sideEdge}px`);
          for (const r of right) assert.ok(x1 <= r.left, `${label}: the toast ends at ${x1}px, ${r.name} starts at ${r.left}px`);
          assert.ok(x1 - x0 >= 240, `${label}: a toast keeps a readable width (${x1 - x0}px)`);
        }
      }
    }
  }
  assert.ok(checked >= 50, `the clear cases were checked (${checked})`);
  // The one state with no clear room left: the pane AND the cart open (the
  // dock then sits left of the pane) in the smallest window.
  assert.deepEqual(residual, [
    `${MIN_W}px, sidebar open, preview, #cartDock.show`,
    `${MIN_W}px, sidebar open, preview, #cartDock.show, #tourOverlay:not([hidden])`,
    `${MIN_W}px, sidebar rail, preview, #cartDock.show`,
    `${MIN_W}px, sidebar rail, preview, #cartDock.show, #tourOverlay:not([hidden])`,
  ], 'only the pane-and-cart corner of the smallest window is left without room');
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
  assert.equal(cascade('#toasts', { active: ['#selectionBar.visible'] }).get('bottom'), '90px', 'with no dialog the lift still applies');
  assert.equal(cascade('#toasts', { active: [] }).get('top'), undefined, 'and the resting slot is the bottom');
  // A box with no background still takes the clicks that land on it: the
  // stack is see-through to the pointer, the toasts on it are not.
  assert.equal(declsOf('#toasts').get('pointer-events'), 'none', 'the stack lets clicks through to the page');
  assert.equal(declsOf('.toast').get('pointer-events'), 'auto', 'a toast keeps its own buttons');
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
