import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Polish round — motion that costs nothing at rest.
 *
 * Each pin holds one removal of per-frame work on a screen the app idles on:
 *  - the scan progress bar slides on `transform`, not `margin-left` (layout
 *    + paint every frame for the whole scan);
 *  - the four ambience blobs are pre-softened gradients, not four
 *    `filter: blur(95px)` render surfaces re-run on every damaged frame;
 *  - the 'Index live' dot breathes a few times on arrival and then rests;
 *  - the sidebar's 26px frost samples a static backdrop while it is in flow,
 *    so it is a tinted fill there and a real blur only when it floats over
 *    content (the narrow-window overlay);
 *  - the welcome mark floats without a `drop-shadow` filter under it;
 *  - a view switch fades without moving the whole view as a layer.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function decls(selectorAnchor: string, hay = INDEX): string {
  const start = hay.indexOf(selectorAnchor);
  assert.notEqual(start, -1, `rule "${selectorAnchor}" exists`);
  const open = hay.indexOf('{', start);
  const close = hay.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `rule "${selectorAnchor}" closes`);
  return hay.slice(open + 1, close);
}

function braced(openAnchor: string, hay = INDEX): string {
  const start = hay.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists`);
  let depth = 0;
  for (let i = hay.indexOf('{', start); i < hay.length; i++) {
    if (hay[i] === '{') depth++;
    else if (hay[i] === '}' && --depth === 0) return hay.slice(start, i + 1);
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

/* ═══════════════ the progress bar ═══════════════ */

test('the indeterminate scan bar travels on transform — the compositor, never layout', () => {
  const kf = braced('@keyframes indeterminate');
  assert.doesNotMatch(kf, /margin|left:|width:|right:|inset/, 'no layout property in the keyframes');
  assert.match(kf, /transform:\s*translateX\(/, 'the fill slides on a transform');
  const fill = decls('.progress-fill {');
  assert.match(fill, /animation:\s*indeterminate/, 'the fill still runs it');
  assert.doesNotMatch(fill, /will-change/, 'no permanent layer: a running transform animation promotes on its own');
});

/* ═══════════════ the ambience field ═══════════════ */

test('the four ambience blobs are pre-softened gradients with no filter surface', () => {
  const blob = decls('.blob {');
  assert.doesNotMatch(blob, /filter/, 'a CSS filter makes each blob its own render surface, re-blurred on every damaged frame');
  assert.match(blob, /position:\s*fixed/, 'still the fixed ambience field');
  for (const n of [1, 2, 3, 4]) {
    const d = decls(`.blob.b${n} {`);
    assert.match(d, /radial-gradient\(circle,\s*rgba\([^)]+\)\s*0%,\s*rgba\([^)]+\)\s*\d+%,\s*transparent\s*\d+%\)/,
      `b${n} bakes the softness into a two-shoulder falloff instead of blurring a hard edge`);
  }
  // The grain stays; both themes keep their own strength.
  assert.match(decls('body::after {'), /feTurbulence/, 'the film grain is untouched');
  assert.match(INDEX, /:root\[data-theme="light"\] body::after \{ opacity: [\d.]+; \}/, 'and the light theme still dials it down');
  assert.match(INDEX, /:root\[data-theme="light"\] \{[\s\S]*?--blob-opacity:/, 'the light blob opacity token is still declared');
});

/* ═══════════════ the index dot rests ═══════════════ */

test('the Index live dot breathes a finite number of times, then rests at full opacity', () => {
  const block = braced('@media (prefers-reduced-motion: no-preference) {');
  const dot = decls('.index-badge:not(.stale) .dot', block);
  const anim = /animation:\s*([^;]+)/.exec(dot)?.[1] ?? '';
  assert.match(anim, /indexPulse/, 'the liveness cue still plays');
  assert.doesNotMatch(anim, /infinite/, 'but not forever — 60 frames/s of damage over the scan card for a 7px dot');
  assert.match(anim, /\s[2-5]\s*$/, 'a few breaths on arrival (a finite iteration count)');
  assert.match(braced('@keyframes indexPulse'), /0%,\s*100%\s*\{\s*opacity:\s*1/, 'and it ends where it rests: fully lit');
});

/* ═══════════════ the sidebar frost ═══════════════ */

test('the sidebar is a tinted fill while in flow and a real frost only as the narrow-window overlay', () => {
  const base = decls('#sideNav {');
  assert.match(base, /--lg-backdrop:\s*none/, 'in flow, nothing ever moves beneath it — a blur samples a static backdrop');
  assert.match(base, /--lg-blur:/, 'the blur radius stays declared for the overlay state');
  const narrow = braced('@media (max-width: 900px) {');
  const overlay = decls('#sideNav:not(.collapsed) {', narrow);
  assert.match(overlay, /position:\s*fixed/, 'the overlay state is the one that floats over content');
  assert.match(overlay, /--lg-backdrop:\s*blur\(var\(--lg-blur\)\)\s*saturate\(var\(--lg-sat\)\)/, 'and that is where the frost comes back');
  assert.match(overlay, /--lg-tint:/, 'with the translucent overlay tint');
  assert.match(narrow, /:root\[data-theme="light"\] #sideNav:not\(\.collapsed\)\s*\{[^}]*--lg-tint:/, 'the light theme re-tunes the overlay tint too');
  assert.match(overlay, /box-shadow:\s*var\(--shadow-3\)/, 'the overlay casts the theme shadow, not a hard-coded black');
  // The engine still frosts it as a plain host — the ::before is its only fill.
  const targets = slice('/* Which elements get the lens, and how strong. */', 'const SELECTOR =');
  assert.match(targets, /\['#sideNav',\s*\{[^}]*plain:\s*1/, '#sideNav stays a plain Liquid Glass target');
});

/* ═══════════════ the welcome screen ═══════════════ */

test('the welcome mark floats without a filter under it', () => {
  const mark = decls('#emptyState .mark {');
  assert.doesNotMatch(mark, /filter/, 'a drop-shadow filter is re-applied on every frame of the perpetual float');
  assert.match(mark, /box-shadow:[^;]*var\(--accent-glow\)/, 'the glow is a static box-shadow that rides the composited transform');
  assert.match(mark, /animation:\s*float/, 'the float itself stays');
  assert.match(braced('@keyframes float'), /transform:\s*translateY/, 'and it is a transform');
});

/* ═══════════════ a view switch does not move the view ═══════════════ */

test('viewIn fades only — no transform, so a switch never composites the whole view as a moving layer', () => {
  const view = decls('.view {');
  const name = /animation:\s*([A-Za-z][\w-]*)/.exec(view)?.[1];
  assert.ok(name, '.view names its entrance animation');
  const kf = braced(`@keyframes ${name}`);
  assert.doesNotMatch(kf, /transform|translate|scale|top:|left:|margin/, 'opacity only');
  assert.match(kf, /opacity:\s*0/, 'it fades from transparent');
  assert.doesNotMatch(view, /transform/, 'and the view itself carries no transform');
  assert.match(view, /var\(--dur-[12]\)/, 'brief: the card stagger is the entrance, this is the crossfade under it');
});
