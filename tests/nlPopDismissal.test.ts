import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * §9.6's plain-words popover, and the layers that own the window.
 *
 * #nlPop is `position: fixed` and placed from viewport coordinates, so it was
 * moved out of `.tm-toolbar` to keep the viewport as its containing block
 * (tests/nlPopContainment.test.ts pins that, and it must stay). The move had a
 * second effect nobody priced in: the popover also left the toolbar's stacking
 * context. It now paints at the root, at the same rank as #ctxMenu and
 * #rcPopover — ABOVE every modal backdrop, above the command palette's scrim,
 * above the tour card. Open the popover in the Treemap view and press ⌘K
 * without clicking anything and the palette comes up with the popover sitting
 * lit, opaque and still clickable on top of it.
 *
 * Lowering the z-index is not the fix: the popover has to keep clearing the
 * fixed siblings it was raised past in the first place. What is actually wrong
 * is lifetime — a popover anchored to a button inside the view has no business
 * outliving the arrival of a layer that owns the whole window.
 *
 * So the invariant here is structural and about COVERAGE, not about any one
 * modal: every full-window layer the shipped script can reveal must be inside
 * the net that dismisses the popover. Both sides are derived from the built
 * page — the layers from the stylesheet's own geometry, the reveals from the
 * script — so the fifteenth modal, written next month in a file that does not
 * exist yet, is covered the day it is added or this test fails.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ── The page, split into its three languages ───────────────────────────── */

const CSS = (() => {
  const open = INDEX.indexOf('<style>');
  const close = INDEX.indexOf('</style>', open);
  assert.ok(open !== -1 && close > open, 'the page carries one inlined stylesheet');
  return INDEX.slice(open + '<style>'.length, close);
})();

/** Every inline script, concatenated — the app is one of two on the page. */
const JS = (() => {
  const out: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(INDEX)) !== null) out.push(m[1]);
  assert.ok(out.length >= 1, 'the page carries its behaviour inline');
  return out.join('\n');
})();

/* ── The stylesheet, as rules ───────────────────────────────────────────── */

interface Rule { selectors: string[]; body: string }

const RULES: Rule[] = (() => {
  // Nested blocks (@media, @supports) flatten to their inner rules, which is
  // all this file asks about: a layer declared only inside a media query is
  // still a layer, and the narrow-window blocks are where several of them live.
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (!selector || selector.startsWith('@') || /^(from|to|[\d.]+%)$/.test(selector)) continue;
    out.push({ selectors: selector.split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  assert.ok(out.length > 100, 'the stylesheet parsed into rules');
  return out;
})();

const value = (body: string, prop: string): string | null => {
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(flat);
  return m ? m[1].trim() : null;
};

const isZero = (v: string | null): boolean => v !== null && /^0(px|%)?$/.test(v.trim());

/**
 * A layer that owns the window: fixed to the viewport and pinned to all four
 * of its edges. That geometry is the definition on purpose — it is what makes
 * a surface something the user has to deal with before the view underneath,
 * and it is read off the shipped stylesheet rather than listed here, so a new
 * overlay class joins the set by being written, not by being remembered.
 */
function isFullWindowLayer(body: string): boolean {
  if ((value(body, 'position') ?? '').toLowerCase() !== 'fixed') return false;
  const inset = value(body, 'inset');
  if (inset !== null) return inset.trim().split(/\s+/).every((part) => isZero(part));
  return ['top', 'right', 'bottom', 'left'].every((side) => isZero(value(body, side)));
}

/* ── The page, as elements ──────────────────────────────────────────────── */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

interface El { tag: string; id: string; classes: string[] }

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? '') : '';
}

/** Every element carrying an id, by id. Markup only — script and CSS stripped. */
const BY_ID = new Map<string, El>((() => {
  const html = INDEX
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
  const out: [string, El][] = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/' || VOID.has(m[2].toLowerCase())) continue;
    const id = attr(m[3], 'id');
    if (!id) continue;
    out.push([id, { tag: m[2].toLowerCase(), id, classes: attr(m[3], 'class').split(/\s+/).filter(Boolean) }]);
  }
  return out;
})());

/** Does `selector`'s SUBJECT (its rightmost compound) match this element? */
function matches(el: El, selector: string): boolean {
  const subject = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  if (/::/.test(subject)) return false; // a pseudo-element is not the element
  const bare = subject.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  const tag = /^[\w-]+/.exec(bare);
  if (tag && tag[0] !== '*' && tag[0] !== el.tag) return false;
  const ids = bare.match(/#[\w-]+/g) ?? [];
  if (ids.some((i) => i.slice(1) !== el.id)) return false;
  const classes = bare.match(/\.[\w-]+/g) ?? [];
  if (classes.some((c) => !el.classes.includes(c.slice(1)))) return false;
  return Boolean(tag || ids.length || classes.length);
}

/** The ids of every element the stylesheet makes a full-window layer. */
const LAYERS = new Set<string>((() => {
  const ids: string[] = [];
  for (const el of BY_ID.values()) {
    if (!el.id) continue;
    for (const rule of RULES) {
      if (!isFullWindowLayer(rule.body)) continue;
      if (rule.selectors.some((sel) => matches(el, sel))) { ids.push(el.id); break; }
    }
  }
  return ids;
})());

/* ── The reveals: every way the script puts a layer up ──────────────────── */

/**
 * Each form pairs the statement that reveals an element with the ATTRIBUTE it
 * mutates, because that is what a MutationObserver has to be listening for.
 * Only `$('id')` targets can be resolved from text — a layer revealed through
 * a variable is invisible here, which is the other reason the fix must be a
 * net over the elements rather than a call at each call site.
 */
const REVEALS: { re: RegExp; attribute: string; how: string }[] = [
  { re: /\$\('([A-Za-z][\w-]*)'\)\.classList\.add\('open'\)/g, attribute: 'class', how: "classList.add('open')" },
  { re: /\$\('([A-Za-z][\w-]*)'\)\.classList\.toggle\('open'\)/g, attribute: 'class', how: "classList.toggle('open')" },
  { re: /\$\('([A-Za-z][\w-]*)'\)\.hidden\s*=\s*false/g, attribute: 'hidden', how: 'hidden = false' },
  { re: /\$\('([A-Za-z][\w-]*)'\)\.style\.display\s*=\s*'(?!none')/g, attribute: 'style', how: 'style.display' },
];

interface Opener { id: string; attribute: string; how: string }

const OPENERS: Opener[] = (() => {
  const seen = new Map<string, Opener>();
  for (const form of REVEALS) {
    let m: RegExpExecArray | null;
    form.re.lastIndex = 0;
    while ((m = form.re.exec(JS)) !== null) {
      if (!LAYERS.has(m[1])) continue;
      seen.set(`${m[1]}:${form.attribute}`, { id: m[1], attribute: form.attribute, how: form.how });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
})();

/* ── The guard ──────────────────────────────────────────────────────────── */

/**
 * A named function's body, brace-matched from its declaration. The match runs
 * over raw source, as every slicer in this suite does, so a brace inside a
 * comment in one of these two functions would silently re-point it — the same
 * rule tests/chartWrapNoOverflow.test.ts imposes on the stylesheet's comments.
 */
function functionBody(name: string): string {
  const at = JS.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `the shipped script defines ${name}()`);
  const open = JS.indexOf('{', JS.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < JS.length; i++) {
    if (JS[i] === '{') depth++;
    else if (JS[i] === '}' && --depth === 0) return JS.slice(open + 1, i);
  }
  return assert.fail(`${name}() never closes`);
}

test('the derivation finds real layers and real openers', () => {
  // A parser that quietly matched nothing would make every assertion below
  // vacuously true, so it has to prove it can see the two surfaces named in
  // the bug report before its silence is allowed to mean anything.
  assert.ok(LAYERS.has('cmdkModal'), 'the command palette is a full-window layer');
  assert.ok(LAYERS.has('tourOverlay'), 'the tour card is a full-window layer');
  assert.ok(OPENERS.length >= 8, `the script's reveals were found (got ${OPENERS.length})`);
  assert.ok(OPENERS.some((o) => o.id === 'cmdkModal'), 'the ⌘K path from the repro is among them');
});

test('every layer the app can raise dismisses the plain-words popover', () => {
  const guard = functionBody('nlOverlayGuard');
  assert.ok(/\bnlClose\s*\(/.test(guard), 'the guard closes the popover');
  assert.ok(/\bfocusButton\b/.test(guard), 'the guard decides where focus goes rather than always pulling it back under the new layer');

  // Called, not merely declared: a guard that is never invoked observes nothing.
  const calls = JS.match(/\bnlOverlayGuard\s*\(/g) ?? [];
  assert.ok(calls.length >= 2, 'nlOverlayGuard() is wired up at load, not just defined');

  const sel = /querySelectorAll\('([^']+)'\)/.exec(guard);
  assert.ok(sel, 'the guard names the layers it watches with a selector');
  const parts = sel[1].split(',').map((s) => s.trim()).filter(Boolean);

  const filter = /attributeFilter\s*:\s*\[([^\]]*)\]/.exec(guard);
  assert.ok(filter, 'the guard names the attributes a reveal can flip');
  const watched = new Set((filter[1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1)));

  const escaped: string[] = [];
  for (const op of OPENERS) {
    const el = BY_ID.get(op.id);
    assert.ok(el, `#${op.id} exists in the markup`);
    if (!parts.some((p) => matches(el, p))) { escaped.push(`#${op.id} — no part of "${sel[1]}" selects it`); continue; }
    if (!watched.has(op.attribute)) escaped.push(`#${op.id} — revealed by ${op.how}, but "${op.attribute}" is not observed`);
  }

  assert.deepEqual(escaped, [],
    'a layer that covers the window leaves #nlPop (z 211, a root-level fixed box since it left ' +
    '.tm-toolbar) painted on top of it, lit and clickable over its own scrim — every one of ' +
    'these must be inside the net that dismisses the popover');
});

test('the palette closes the popover before it records where focus came from', () => {
  // cmdkOpen remembers document.activeElement to restore it on close. Dismiss
  // the popover after that snapshot and the palette faithfully restores focus
  // to #nlInput inside a now-hidden dialog, which lands it on <body>; dismiss
  // it before, and the snapshot is the ✨ button the popover was anchored to.
  const open = functionBody('cmdkOpen');
  const closedAt = open.search(/\bnlClose\s*\(/);
  const snapshotAt = open.search(/cmdkPrevFocus\s*=\s*document\.activeElement/);
  assert.ok(closedAt !== -1, 'cmdkOpen dismisses the popover on the way in');
  assert.ok(snapshotAt !== -1, 'cmdkOpen still snapshots the focus it will restore');
  assert.ok(closedAt < snapshotAt, 'the popover goes before the focus snapshot is taken');
});
