import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * "I want this to be insanely fast" — the all-areas round, as invariants.
 *
 * A 37-agent adversarial pass over src/ui found one structural fact behind
 * all three complaints: every Liquid Glass host was `isolation: isolate` with
 * a `mix-blend-mode: screen` ring, which in the dark theme made the WHOLE
 * host (sidebar, sheet, panel) an isolated offscreen group redrawn on every
 * damaged frame — and the frost then read its backdrop from that group's own
 * empty framebuffer, so the glass was very likely blurring nothing. The rest
 * of the round is the damage story: a hover change blitted the whole treemap
 * canvas, so every frosted overlay on the map re-blurred; modals scrolled
 * inside their own backdrop surface; near-duplicate clusters were nested
 * horizontal scrollers that latched trackpad gestures; and a few hover
 * lifts moved backdrop-filtered or overlapping elements.
 *
 * Each test pins one of those removals. None is anchored to a comment.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function decls(selectorAnchor: string): string {
  const start = INDEX.indexOf(selectorAnchor);
  assert.notEqual(start, -1, `rule "${selectorAnchor}" exists in index.html`);
  const open = INDEX.indexOf('{', start);
  const close = INDEX.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `rule "${selectorAnchor}" closes`);
  return INDEX.slice(open + 1, close);
}

function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

/* ═══════════════ the one line that touches everything ═══════════════ */

test('the glass ring no longer blends: no isolated offscreen group per host', () => {
  const ring = decls('.lg::after {');
  assert.doesNotMatch(ring, /mix-blend-mode/, 'a blended ring makes the whole host an offscreen render surface');
  assert.doesNotMatch(INDEX, /:root\[data-theme="light"\] \.lg::after \{ mix-blend-mode/, 'the light-theme opt-out is gone with the thing it opted out of');
  assert.match(decls('.lg {'), /isolation:\s*isolate/, 'isolation stays: with no blending descendant it is free, and it keeps the frost inside the host');
});

/* ═══════════════ no surface carries the displacement lens ═══════════════ */

test('every Liquid Glass target is frost only: the displacement lens is opt-in nowhere', () => {
  const targets = slice('/* Which elements get the lens, and how strong. */', 'const SELECTOR =');
  const entries = [...targets.matchAll(/\['([^']+)',\s*\{([^}]*)\}\]/g)];
  assert.ok(entries.length >= 12, `the TARGETS list is intact, found ${entries.length}`);
  for (const [, sel, body] of entries) assert.match(body, /\bplain:\s*1\b/, `${sel} keeps its frost and drops the lens`);
  const cartTab = entries.find((e) => e[1] === '#cartTab');
  assert.ok(cartTab && /track:\s*1/.test(cartTab[2]), 'the cart tab still tracks the pointer for its ring angle');
});

test('the reclaim popover, whose base is opaque, does not pay for a blur nobody can see', () => {
  const pop = decls('#rcPopover {');
  assert.match(pop, /--lg-backdrop:\s*none/, 'no backdrop-filter under an opaque base');
  assert.doesNotMatch(pop, /--lg-blur/, 'and no blur radius left to tune');
});

/* ═══════════════ modals ═══════════════ */

test('a modal is a near-opaque pane with no live backdrop, so its scroller is not inside a filter surface', () => {
  const modal = decls('.modal {');
  assert.match(modal, /--lg-backdrop:\s*none/, 'the sheet does not blur what the scrim already tints');
  assert.doesNotMatch(modal, /--lg-blur:\s*30px/, 'the 30px outlier is gone with the filter');
  assert.match(modal, /color-mix\(in srgb, var\(--bg-1\) 94%, transparent\)/, 'the global-search recipe: 94% of the page background carries legibility');
});

test('living-surface effects behind an open sheet are paused, but never the ones inside it', () => {
  const i = INDEX.indexOf('body:has(.modal-backdrop.open)');
  assert.notEqual(i, -1, 'the pause rule exists');
  const rule = INDEX.slice(i, INDEX.indexOf('}', i) + 1);
  assert.match(rule, /animation-play-state:\s*paused/);
  assert.match(rule, /\[data-fxbeam-on\]/, 'beams');
  assert.match(rule, /\[data-fxbeam-bloom\]/, 'their bloom child');
  assert.match(rule, /\.fx-shimmer-text/, 'and the shimmer');
  assert.match(rule, /:not\(\.modal-backdrop\.open \*\)/, 'scoped to hosts OUTSIDE the dialog — the offload modal and Settings host their own strip and orb');
});

/* ═══════════════ hover: damage, not JavaScript ═══════════════ */

test('a hover change presents the union of the two tiles, not the whole map', () => {
  const present = braced('function presentTreemap(');
  assert.match(present, /function presentTreemap\(clip\)/, 'the present takes a clip');
  assert.match(present, /tmCtx\.clip\(\)/, 'and clips to it');
  assert.match(present, /drawImage\(tmBuffer,\s*sx,\s*sy,\s*sw,\s*sh,\s*clip\.x,\s*clip\.y,\s*clip\.w,\s*clip\.h\)/, 'blitting only that region from the buffer');
  assert.match(present, /tmCtx\.save\(\)[\s\S]*tmCtx\.restore\(\)/, 'the clip is scoped to this present');
  const hover = braced("tmCanvas.addEventListener('mousemove'");
  assert.match(hover, /tmHoverUnion\(prev,\s*hit\)/, 'the hover path computes the union of the old and new tile');
  assert.match(hover, /!lensActive\(\)\s*&&\s*isRectMap\(\)/, 'only for the rectangle map without the lens — the lens and the solved renderers keep the full present');
  assert.match(braced('function presentView('), /presentTreemap\(opts && opts\.clip\)/, 'and presentView hands the clip through');
});

test('hover lifts no longer move frosted or overlapping surfaces, and the card shadow steps instead of fading', () => {
  assert.doesNotMatch(decls('#cartTab:hover'), /transform/, 'the cart tab is a frosted surface; moving it re-runs its blur per frame');
  assert.doesNotMatch(decls('.card.glass, .stat-tile {'), /box-shadow/, 'an 80px shadow was repainted across ~9 frames per enter and per leave');
  assert.match(decls('.card.glass, .stat-tile {'), /transition:\s*transform/, 'the 1px lift keeps its travel');
  assert.doesNotMatch(decls('.gcell:hover'), /transform/, 'a lifted grid cell churned compositor layers among hundreds of overlapping siblings');
  assert.doesNotMatch(decls('.gcell {'), /transform var\(--dur-2\)/, 'and its transition list no longer names transform');
  assert.doesNotMatch(INDEX, /\.gcell:active \{ transform/, 'nor does the press');
});

/* ═══════════════ near-duplicates: un-nest the scrollers ═══════════════ */

test('near-duplicate clusters wrap instead of scrolling sideways: no nested scroller to latch a trackpad gesture', () => {
  const strip = decls('.nd-strip {');
  assert.match(strip, /flex-wrap:\s*wrap/, 'a wrapping row');
  assert.doesNotMatch(strip, /overflow-x:\s*auto/, 'never a horizontal scroller inside the vertical one');
  assert.match(decls('.nd-cluster  {'), /content-visibility:\s*auto/, 'the render lock moved to the cluster');
  assert.doesNotMatch(INDEX, /\.nd-item\s+\{\s*content-visibility/, 'and off the tile — two nested locks is worse than one');
  const perStep = /const ND_ITEMS_PER_STEP = (\d+);/.exec(INDEX);
  const batch = /const ND_CLUSTER_BATCH = (\d+);/.exec(INDEX);
  assert.ok(perStep && Number(perStep[1]) <= 12, `a wrapped cluster reveals at most 12 images at once, found ${perStep && perStep[1]}`);
  assert.ok(batch && Number(batch[1]) <= 6, `a mid-scroll append is at most 6 clusters, found ${batch && batch[1]}`);
  assert.match(braced('function ndObserveSentinel('), /rootMargin:\s*'1000px'/, 'and it lands before the user reaches it');
});

test('a mid-scroll append touches only the clusters it inserted', () => {
  const item = braced('function ndItemHtml(');
  assert.match(item, /data-cartin=/, 'cart state is stamped at build time, so the cart walk has nothing to rewrite');
  assert.match(item, /icon\(cartHas\(f\.path\) \? 'check' : 'plus', 14\)/, 'with the icon refreshCartButtons would have written');
  const append = braced('function ndAppendClusters(');
  assert.match(append, /const firstNew = list\.children\.length/, 'the append remembers where the new clusters start');
  assert.match(append, /ndSyncNewNodes\(\[\.\.\.list\.children\]\.slice\(firstNew\)\)/, 'and syncs only those');
  assert.match(braced('function refreshCartButtons('), /function refreshCartButtons\(roots = \[document\]\)/, 'the cart walk takes a scope, defaulting to the document for every other caller');
});

/* ═══════════════ permanent layers ═══════════════ */

test('no permanent will-change on digit strips or goo layers', () => {
  assert.doesNotMatch(decls('.fx-roll-col {'), /will-change/, 'a 560ms transition promotes on its own; forever is ~40 layers on the dashboard');
  assert.doesNotMatch(decls('.fxgoo-sil {'), /will-change/);
  assert.doesNotMatch(decls('.fxgoo-thumb {'), /will-change/);
});
