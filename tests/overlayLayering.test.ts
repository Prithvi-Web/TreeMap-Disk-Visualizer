import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Overlay layering — the fixed surfaces that float over the app.
 *
 * Every one of these defects was invisible to the behavioural suite because
 * nothing here is behaviour: a scrim that dims three quarters of the window,
 * a pane that reserves 58px for a header the sidebar deleted, and a dock
 * whose max-width guard measures the wrong box all render perfectly and
 * fail only to the eye. So these are structural pins, and they are written
 * as RELATIONS — "the scrim outranks what it dims", "the dock fits in what
 * is left of the viewport" — never as the literal numbers, because a
 * redesign is allowed to move every one of those numbers and is not allowed
 * to reintroduce the bug.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** One CSS rule inside `src`, from a distinctive anchor to its first `}`. */
function ruleIn(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  assert.notEqual(start, -1, `rule "${anchor}" exists`);
  const end = src.indexOf('}', start);
  assert.notEqual(end, -1, `rule "${anchor}" closes`);
  return src.slice(start, end + 1);
}

const rule = (anchor: string): string => ruleIn(INDEX, anchor);

/**
 * A braced block — here, an at-rule — from its anchor to its MATCHING brace.
 * `ruleIn` stops at the first `}`, which for a media query is the first
 * nested rule's brace, so it cannot answer the only question these media
 * pins ask: is this declaration INSIDE the narrow-window block?
 */
function braced(anchor: string, from = 0): string {
  const start = INDEX.indexOf(anchor, from);
  assert.notEqual(start, -1, `block "${anchor}" exists`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${anchor}" never closes`);
}

/**
 * One declaration's value, or null when the property is absent.
 * The leading `[;{\s]` matters: without it a search for `width` happily
 * matches the tail of `max-width`, which is exactly the pair of properties
 * defect (3) is about.
 */
function optDecl(block: string, prop: string): string | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`).exec(block);
  return m ? m[1].trim() : null;
}

function decl(block: string, prop: string): string {
  const v = optDecl(block, prop);
  assert.ok(v !== null, `"${prop}" is declared in ${JSON.stringify(block.slice(0, 70))}…`);
  return v;
}

const zOf = (anchor: string): number => {
  const z = Number(decl(rule(anchor), 'z-index'));
  assert.ok(Number.isFinite(z), `${anchor} has a numeric z-index`);
  return z;
};

/**
 * Resolve a CSS length to pixels at a given viewport width. Handles the
 * forms this layer actually uses — px, vw, calc(), min(), max(), bare 0 —
 * which is what lets the width pins be evaluated at several viewports
 * instead of string-matched against one hard-coded expression.
 */
function lengthPx(expr: string, viewport: number): number {
  const js = expr
    .replace(/\bcalc\(/g, '(')
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/(-?[\d.]+)vw/g, (_m, n: string) => `(${n} * ${viewport} / 100)`)
    .replace(/(-?[\d.]+)px/g, '$1');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const value = Function(`"use strict"; return (${js});`)() as number;
  assert.ok(Number.isFinite(value), `"${expr}" resolves to a length`);
  return value;
}

/** The app's documented window floor (005-base-ambience.css) and up. */
const WIDTHS = [640, 768, 900, 1280, 1920];

/* ═══════════════ (1) The nav scrim and what it must outrank ═══════════════ */

const Z = {
  scrim: zOf('#navScrim {'),
  selectionBar: zOf('#selectionBar { position: fixed'),
  previewPane: zOf('#previewPane { position: fixed'),
  cartDock: zOf('#cartDock { position: fixed'),
  tour: zOf('#tourOverlay { position: fixed'),
  modal: zOf('.modal-backdrop { position: fixed'),
};

test('the nav scrim dims every app surface it covers, not just the page behind them', () => {
  // The scrim's whole job is "the sidebar is the live surface now; click
  // anywhere else to put it away". A surface that outranks the scrim stays
  // lit AND stays clickable through it, which turns click-to-dismiss into
  // click-to-do-something-else.
  for (const [name, z] of [
    ['#selectionBar', Z.selectionBar],
    ['#previewPane', Z.previewPane],
    ['#cartDock', Z.cartDock],
  ] as const) {
    assert.ok(Z.scrim > z, `#navScrim (${Z.scrim}) must sit above ${name} (${z})`);
  }
});

test('the overlay sidebar sits above its own scrim, and only in the overlay state', () => {
  // The scrim is inert (opacity 0, pointer-events none) until the <=900px
  // block turns it on, so the raise belongs in that same block: at wide
  // widths #sideNav stays where it was, which is what keeps .gsearch-panel
  // (z-index 60, scoped inside #sideNav's stacking context) painting exactly
  // as it does today relative to the preview pane and the cart dock.
  const overlay = braced('@media (max-width: 900px)', INDEX.indexOf('#navScrim {'));
  assert.ok(overlay.includes('#navScrim'), 'the narrow block is the one that arms the scrim');

  const nav = ruleIn(overlay, '#sideNav:not(.collapsed) {');
  const zNav = Number(decl(nav, 'z-index'));
  assert.ok(zNav > Z.scrim, `the overlay sidebar (${zNav}) must sit above the scrim (${Z.scrim})`);

  const base = rule('#sideNav {');
  const zBase = Number(decl(base, 'z-index'));
  assert.ok(
    zBase < Z.previewPane && zBase < Z.cartDock,
    `the in-flow sidebar (${zBase}) keeps its old rank under the preview pane and cart dock`,
  );
});

test('the scrim stays under the non-modal coach card and under real dialogs', () => {
  // #tourOverlay is aria-modal="false" and pointer-events:none everywhere
  // except its 360px card: it narrates while the user drives the real UI,
  // the sidebar included. Dimming and disabling the instructions at the
  // exact moment the user follows them ("open the Clean Up view") would be
  // the bug, not the fix — and because only the card takes pointer events,
  // it costs the scrim nothing but a card-sized hole in a transient dim.
  assert.ok(Z.scrim < Z.tour, `#navScrim (${Z.scrim}) stays under #tourOverlay (${Z.tour})`);
  // A dialog is the one surface allowed to own the window outright.
  assert.ok(Z.scrim < Z.modal, `#navScrim (${Z.scrim}) stays under .modal-backdrop (${Z.modal})`);
  const overlay = braced('@media (max-width: 900px)', INDEX.indexOf('#navScrim {'));
  const zNav = Number(decl(ruleIn(overlay, '#sideNav:not(.collapsed) {'), 'z-index'));
  assert.ok(zNav < Z.modal, `the overlay sidebar (${zNav}) stays under .modal-backdrop (${Z.modal})`);
});

/* ═══════════ (2) The preview pane's offset for a deleted header ═══════════ */

test('the preview pane reserves no room for the horizontal header the sidebar replaced', () => {
  // Nothing is pinned to the top of the viewport any more (000-sidebar.html
  // and 020-sidebar.css both record the header's removal), so any offset
  // beyond the app's own edge gutter is a notch of bare background above a
  // full-height sheet. The gutter is READ from the sidebar's margin rather
  // than typed here, so an inset redesign moves both together.
  const gutter = lengthPx(decl(rule('#sideNav {'), 'margin').split(/\s+/)[0], 1280);
  const pane = rule('#previewPane { position: fixed');
  const top = lengthPx(decl(pane, 'top'), 1280);
  assert.ok(
    top <= gutter,
    `#previewPane top (${top}px) must not exceed the app's ${gutter}px edge gutter — ` +
    'a larger offset is space held for chrome that no longer exists',
  );
});

/* ══════════ (3) The cart dock must narrow, never leave the screen ══════════ */

const dock = rule('#cartDock { position: fixed');
const shifted = rule('body.preview-open #cartDock {');

/** The dock's rendered width at `vw`: its width capped by every max-width in play. */
function dockWidth(vw: number, extraCap: string | null): number {
  const caps = [decl(dock, 'width'), decl(dock, 'max-width')];
  if (extraCap) caps.push(extraCap);
  return Math.min(...caps.map((c) => lengthPx(c, vw)));
}

test('the cart dock fits the space its offset leaves, at the 640px floor and above', () => {
  // `max-width: 92vw` measures the VIEWPORT, not what remains after an
  // offset, so the preview-open state needs a cap of its own. Without one
  // the dock is 366px wide starting 348px from the right edge and its left
  // edge walks off a 640px window.
  const shiftedCap = optDecl(shifted, 'max-width');
  assert.ok(
    shiftedCap !== null,
    'body.preview-open #cartDock must re-cap its width against the space its own offset leaves',
  );
  for (const vw of WIDTHS) {
    const right = lengthPx(decl(dock, 'right'), vw);
    assert.ok(right + dockWidth(vw, null) <= vw, `the resting dock fits at ${vw}px`);

    const rightOpen = lengthPx(decl(shifted, 'right'), vw);
    const openWidth = dockWidth(vw, shiftedCap);
    assert.ok(openWidth > 0, `the shifted dock keeps a positive width at ${vw}px`);
    assert.ok(
      rightOpen + openWidth <= vw,
      `the shifted dock fits at ${vw}px: ${rightOpen} + ${openWidth} > ${vw}`,
    );
  }
});

test('the shifted dock clears the preview pane it is making room for', () => {
  // The offset exists so the two surfaces do not stack; if the pane ever
  // grows past it they overlap instead, and the dock's new cap would happily
  // keep them both "on screen" while hiding one behind the other.
  const pane = rule('#previewPane { position: fixed');
  for (const vw of WIDTHS) {
    const paneWidth = Math.min(lengthPx(decl(pane, 'width'), vw), lengthPx(decl(pane, 'max-width'), vw));
    const rightOpen = lengthPx(decl(shifted, 'right'), vw);
    assert.ok(rightOpen >= paneWidth, `at ${vw}px the dock clears the ${paneWidth}px pane`);
  }
});
