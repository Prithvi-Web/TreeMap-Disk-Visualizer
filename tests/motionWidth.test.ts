import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Motion & every-width round.
 *
 * Two kinds of check, following the repo's split. The entrance stagger is
 * behaviour — which cards animate, in what order, with what delays — so
 * fxViewEnter is extracted from the living-surface wiring section and RUN
 * here against fake elements (the fxWiring harness precedent). Everything
 * else is a structural pin: the failure mode for each narrow-width fix is
 * a refactor that quietly restores a fixed width or drops a wrap, and no
 * behavioural test can see a layout crush.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const JS_START = '/* ═══════════════ FX: living-surface wiring ═══════════════';
const JS_END = '/* ═══ end FX: living-surface wiring ═══ */';

function wiringSection(): string {
  const start = INDEX.indexOf(JS_START);
  const end = INDEX.indexOf(JS_END);
  assert.ok(start !== -1 && end > start, 'the FX wiring section must be spliced');
  return INDEX.slice(start, end);
}

/** One CSS rule, from a distinctive anchor to its closing brace. */
function rule(selectorAnchor: string): string {
  const start = INDEX.indexOf(selectorAnchor);
  assert.notEqual(start, -1, `rule "${selectorAnchor}" exists in index.html`);
  const end = INDEX.indexOf('}', start);
  assert.notEqual(end, -1, `rule "${selectorAnchor}" closes`);
  return INDEX.slice(start, end + 1);
}

/** The full opening tag that carries `id="…"`. */
function tagOf(id: string): string {
  const at = INDEX.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `element #${id} exists`);
  const open = INDEX.lastIndexOf('<', at);
  const close = INDEX.indexOf('>', at);
  return INDEX.slice(open, close + 1);
}

/** A slice of the app between two exact anchors — containment checks only. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/**
 * A braced block — an at-rule, a keyframes set — from its opening anchor to
 * its MATCHING brace.
 *
 * `slice()` stops at the first `}`, which for a nested at-rule is the first
 * inner rule's brace, and a `[\s\S]{0,N}` window treats `}` as any other
 * character. Both read straight past a closing brace, so neither can say
 * whether a rule is INSIDE the block — the one thing these pins are for.
 */
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

/* ══════════════ Entrance choreography, as behaviour ══════════════ */

type FakeCard = {
  offsetParent: object | null;
  animations: Array<{ frames: Array<Record<string, unknown>>; opts: Record<string, unknown> }>;
  animate(frames: Array<Record<string, unknown>>, opts: Record<string, unknown>): void;
};

function fakeCard(visible = true): FakeCard {
  const card: FakeCard = {
    offsetParent: visible ? {} : null,
    animations: [],
    animate(frames, opts) { card.animations.push({ frames, opts }); },
  };
  return card;
}

function loadFxViewEnter(reduced: boolean): (viewEl: unknown) => void {
  const src = wiringSection();
  const stubEl = () => ({ addEventListener() {}, appendChild(c: unknown) { return c; }, remove() {} });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function(
    'REDUCED', 'FxOrbs', 'FxBeam', '$', 'document', 'state', 'setTimeout', 'clearTimeout',
    `'use strict'; ${src}\nreturn { fxViewEnter };`,
  )(
    reduced,
    { mount: () => ({ setState() {}, destroy() {} }) },
    { attach: (el: unknown) => el, detach() {} },
    stubEl,
    { createElement: stubEl, addEventListener() {} },
    { scanning: false, root: null, view: 'dashboard' },
    () => 0,
    () => {},
  ) as { fxViewEnter: (viewEl: unknown) => void };
  assert.equal(typeof fx.fxViewEnter, 'function', 'fxViewEnter lives in the wiring section');
  return fx.fxViewEnter;
}

test('entrance staggers the first six visible cards; the rest arrive instantly', () => {
  const enter = loadFxViewEnter(false);
  const cards = Array.from({ length: 9 }, () => fakeCard());
  enter({ querySelectorAll: () => cards });
  for (let i = 0; i < 6; i++) {
    assert.equal(cards[i].animations.length, 1, `card ${i} animates once`);
    const { frames, opts } = cards[i].animations[0];
    // Rise + fade: 12px up into place, opacity 0 → 1, nothing else.
    assert.equal(frames[0].transform, 'translateY(12px)');
    assert.equal(frames[0].opacity, 0);
    assert.equal(frames[frames.length - 1].opacity, 1);
    // 30–40ms stagger per slot, holding the from-state through the delay.
    const step = Number(opts.delay) / (i || 1);
    if (i > 0) assert.ok(step >= 30 && step <= 40, `card ${i} delay ${opts.delay} is a 30-40ms stagger`);
    assert.equal(opts.fill, 'backwards', 'the delay must not flash the settled card first');
  }
  // Past the fold: instant — choreographing what nobody sees is pure cost.
  for (let i = 6; i < 9; i++) assert.equal(cards[i].animations.length, 0, `card ${i} arrives instantly`);
});

test('the entrance reads every offsetParent before it writes a single animation', () => {
  const enter = loadFxViewEnter(false);
  const order: string[] = [];
  const cards = Array.from({ length: 9 }, () => {
    const card = fakeCard();
    Object.defineProperty(card, 'offsetParent', { get() { order.push('read'); return {}; }, configurable: true });
    const write = card.animate.bind(card);
    card.animate = (frames, opts) => { order.push('write'); write(frames, opts); };
    return card;
  });
  enter({ querySelectorAll: () => cards });
  assert.ok(order.includes('read') && order.includes('write'), 'the pass really ran');
  // animate() with fill:'backwards' applies its first keyframe immediately, so
  // it invalidates style; an offsetParent read after it forces a fresh style +
  // layout pass. Interleaved, that is six flushes stacked behind view.mount().
  assert.ok(order.lastIndexOf('read') < order.indexOf('write'),
    'reads and writes are batched — one forced layout on the view-switch hot path, not six');
});

test('cards in hidden panes are skipped without consuming a stagger slot', () => {
  const enter = loadFxViewEnter(false);
  const hidden = fakeCard(false);
  const a = fakeCard();
  const b = fakeCard();
  enter({ querySelectorAll: () => [hidden, a, b] });
  assert.equal(hidden.animations.length, 0, 'a display:none card cannot animate');
  assert.equal(a.animations[0].opts.delay, 0, 'the first VISIBLE card leads');
  assert.ok(Number(b.animations[0].opts.delay) > 0, 'the second visible card follows it');
});

test('REDUCED means no entrance at all — not a shorter one', () => {
  const enter = loadFxViewEnter(true);
  const cards = [fakeCard(), fakeCard()];
  enter({ querySelectorAll: () => cards });
  for (const c of cards) assert.equal(c.animations.length, 0);
});

test('switchView fires the entrance only on a hidden → shown entry, never on a data refresh', () => {
  const sv = slice('function switchView(', 'function renderCapabilityNotice(');
  // Captured BEFORE the visibility toggles, or every re-call would look like
  // an entry once the view is already up.
  const captureAt = sv.indexOf('wasHidden');
  const toggleAt = sv.indexOf("classList.toggle('active'");
  assert.ok(captureAt !== -1, 'switchView records whether the view was hidden');
  assert.ok(toggleAt !== -1 && captureAt < toggleAt, 'the record is taken before the toggles');
  assert.match(sv, /wasHidden && viewEl && !viewEl\.hidden/, 'entry = was hidden, now shown');
  assert.match(sv, /fxViewEnter\(viewEl\)/, 'the choreography is called with the view element');
});

/* ══════════════ Pane crossfades ══════════════ */

const PANES = [
  'histPanelCalendar', 'histPanelJournal', 'histPanelCompare',
  'dupPaneExact', 'dupPaneNear',
  'cleanPaneRules', 'cleanPaneSmart', 'cleanPaneVideo', 'cleanPaneEmpty', 'cleanPaneCloud',
];

test('every flip pane carries the crossfade class', () => {
  for (const id of PANES) {
    assert.match(tagOf(id), /class="[^"]*pane-fade[^"]*"/, `#${id} fades in when revealed`);
  }
});

test('the pane fade is 150ms of opacity and nothing that could move layout', () => {
  const fade = rule('.pane-fade {');
  assert.match(fade, /animation:[^;]*var\(--dur-1\)/, 'one --dur-1 (150ms) pass');
  // The WHOLE keyframes set: sliced to the first `}` this saw only the `from`
  // stop, so a `to` stop translating the pane and adding a margin — layout
  // movement on every one of the ten pane flips — was invisible to it.
  const kf = braced('@keyframes paneFade');
  assert.match(kf, /opacity:\s*0/, 'it fades from transparent');
  assert.ok(!/transform|height|margin|padding|top|left|inset/.test(kf),
    'opacity only — a crossfade must not reflow');
});

/* ══════════════ Hover lift ══════════════ */

test('glass cards and stat tiles get the quiet hover lift — 1px, one shadow step', () => {
  const lift = rule('.card.glass:hover');
  assert.match(lift, /translateY\(-1px\)/);
  assert.match(lift, /var\(--shadow-3\)/, 'one step up from the resting --shadow-2');
  const tile = rule('.stat-tile:hover');
  assert.match(tile, /translateY\(-1px\)/);
  // The 150ms travel both ways lives on the resting rule, not only on :hover.
  const rest = rule('.card.glass, .stat-tile {');
  assert.match(rest, /transition:[^;]*transform var\(--dur-1\)/);
  assert.match(rest, /box-shadow var\(--dur-1\)/);
  // Light theme re-declares the hover shadow (its resting stack differs).
  assert.match(INDEX, /:root\[data-theme="light"\] \.card\.glass:hover/);
});

/* ══════════════ Every-width fixes ══════════════ */

test('the time-lapse bar wraps instead of crushing — the fullscreen-only transport bug', () => {
  const bar = rule('.tm-timebar { display: flex');
  assert.match(bar, /flex-wrap:\s*wrap/, 'controls flow to a second line when tight');
  const slider = rule('.tm-timebar input[type="range"]');
  assert.match(slider, /min-width:\s*140px/, 'the scrubber keeps a usable length');
  const label = rule('.tm-timebar .tm-timelabel');
  assert.ok(!/min-width:\s*\d+px/.test(label), 'the tabular label sizes to content, no px reservation');
  assert.match(tagOf('tmLapseSpeed'), /seg-fit/, 'the speed seg is content-sized');
});

test('the grid search clamps to its toolbar instead of holding 210px forever', () => {
  const field = rule('#gridSearch {');
  assert.match(field, /clamp\(140px,\s*\d+cqw,\s*210px\)/, 'container-relative between honest bounds');
  const toolbar = rule('.grid-toolbar {');
  assert.match(toolbar, /container-type:\s*inline-size/, 'the toolbar measures itself, not the window');
});

test('the city text-equivalent table scrolls in its own wrapper', () => {
  assert.match(rule('#cityTable {'), /overflow-x:\s*auto/,
    'a wide table must scroll inside the details, never the page');
});

test('settings rows give width gracefully inside a narrow modal', () => {
  const sched = rule('.sched-row {');
  assert.match(sched, /grid-template-columns:\s*minmax\([^)]*1fr\)/, 'the folder column has a floor, not a fixed share');
  assert.ok(!/grid-template-columns:[^;]*\s96px\s/.test(sched), 'no fixed-only field columns left');
  const ign = rule('.ign-row {');
  assert.match(ign, /minmax\([^)]*200px\)/, 'the scope column shrinks below its 200px ideal');
});

test('the remaining fixed-width crushes are gone', () => {
  assert.match(rule('.feature-row {'), /flex-wrap:\s*wrap/, 'empty-state features wrap');
  // Found live at 660px: the Largest Files sort seg rode margin-left:auto
  // out through the card edge. Headings wrap their trailing controls.
  assert.match(rule('.card h2 {'), /flex-wrap:\s*wrap/, 'card headings wrap their trailing controls');
  assert.match(rule('.dup-progress .track'), /min\(320px/, 'the hunt progress track fits its card');
  const sys = rule('.sys-row {');
  assert.match(sys, /flex-wrap:\s*wrap/, 'the ring and the facts can stack in a narrow card');
  assert.match(rule('.sys-facts {'), /flex:\s*1 1 \d+px/, 'the facts column wraps below a readable floor');
  assert.match(rule('.tm-foot {'), /flex-wrap:\s*wrap/, 'the canvas footer wraps its legend and hint');
});

test('a narrow toolbar packs its control groups left — no stranded right-hung cluster', () => {
  // Containment, not proximity: moved one line past the query's closing
  // brace the same rule hides the spring at EVERY width, permanently
  // collapsing the toolbar's left/right cluster separation.
  const narrow = braced('@container (max-width: 700px) {');
  assert.match(narrow, /\.tb-spring \{ display: none; \}/,
    'the spring collapses when the container query flips the row to left-flow');
  assert.match(rule('.tb-spring {'), /flex:\s*1 1 0/,
    'and everywhere else it is the growing gap that holds the two clusters apart');
});
