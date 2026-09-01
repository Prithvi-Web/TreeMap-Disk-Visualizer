import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A kit canvas must never be able to widen the card it sits in.
 *
 * `Canvas2D.setup` writes an explicit INLINE pixel width onto every chart
 * canvas (`canvas.style.width = cssW + 'px'`). An explicit width counts
 * towards its ancestors' MIN-CONTENT size, so a canvas measured once at a wide
 * window becomes the floor for every box above it:
 *
 *   - the wrap is `width: 100%` of the card, so it cannot shrink below the
 *     canvas;
 *   - the card cannot shrink below the wrap;
 *   - the grid track cannot shrink below the card;
 *   - so `host.clientWidth` never changes, the kit's ResizeObserver never
 *     fires, and the canvas is never re-measured. The latch is permanent
 *     until a reload.
 *
 * Measured on the running app before this was capped: load Trends at 1440
 * (card 1137, canvas 1091), resize the window to 900 (the view is 777) and
 * the card STAYS 1137 — `main` reports scrollWidth 1161 against clientWidth
 * 825 and clips the right-hand third of both charts, with no scrollbar to
 * reach it. `min-width: 0` on the card does not help, because the canvas IS
 * the min-content floor; only capping the canvas does.
 *
 * Both families below are DERIVED from the stylesheet rather than listed here,
 * so a wrap or a chart added tomorrow is covered on the day it lands.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const CSS = (() => {
  const open = INDEX.indexOf('<style>');
  const close = INDEX.indexOf('</style>', open);
  assert.ok(open !== -1 && close > open, 'the page carries one inlined stylesheet');
  return INDEX.slice(open + '<style>'.length, close);
})();

interface Rule { selectors: string[]; body: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selectors: selector.split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

const ALL = rules();
const declares = (body: string, prop: string, value: string) =>
  new RegExp(`(^|;)\\s*${prop}:\\s*${value}\\s*(;|$)`).test(body.replace(/\s+/g, ' '));

/** Selectors that a `max-width: 100%` declaration applies to. */
const CAPPED = new Set<string>(
  ALL.filter((r) => declares(r.body, 'max-width', '100%')).flatMap((r) => r.selectors),
);

/**
 * FAMILY A — every `*-wrap` declared `width: 100%`. The repo's own name for
 * "the box that hands a chart the card's content width".
 */
function chartWraps(): string[] {
  const found = new Set<string>();
  for (const r of ALL) {
    if (!declares(r.body, 'width', '100%')) continue;
    for (const s of r.selectors) {
      // A rule for the canvas INSIDE a wrap is a cap attempt, not the wrap.
      if (/\bcanvas\s*$/.test(s)) continue;
      if (/(^|[\s>])[.#][^\s>]*-wrap\b/.test(s)) found.add(s);
    }
  }
  return [...found];
}

/**
 * FAMILY B — every canvas the authors told to fill its box with
 * `width: 100%`. That declaration is DEAD: `setup()` writes an inline width
 * every render and an inline style outranks the sheet. So each of these is
 * a latch too, and each needs the same cap.
 */
function selfSizingCanvases(): string[] {
  const found = new Set<string>();
  for (const r of ALL) {
    if (!declares(r.body, 'width', '100%')) continue;
    for (const s of r.selectors) if (/\bcanvas\s*$/.test(s)) found.add(s);
  }
  return [...found];
}

test('the stylesheet really does declare chart wraps and self-sizing canvases', () => {
  // If a rename empties either list this test is looking at nothing, and the
  // two below would pass while asserting no coverage at all.
  assert.ok(chartWraps().length >= 3, `chart wraps found: ${JSON.stringify(chartWraps())}`);
  assert.ok(
    selfSizingCanvases().length >= 3,
    `self-sizing canvases found: ${JSON.stringify(selfSizingCanvases())}`,
  );
});

test('every chart wrap caps its canvas, so an explicit canvas width cannot pin the card', () => {
  const offenders = chartWraps().filter((wrap) => ![...CAPPED].some((c) => c === `${wrap} canvas`));
  assert.deepEqual(
    offenders,
    [],
    'a chart canvas carries an inline pixel width from Canvas2D.setup; without a `<wrap> canvas ' +
      '{ max-width: 100% }` rule it becomes its card’s min-content floor and the card can never ' +
      'shrink again:\n  ' + offenders.join('\n  '),
  );
});

test('every canvas told to fill its box is capped too — `width: 100%` alone is dead against the inline style', () => {
  const offenders = selfSizingCanvases().filter((s) => !CAPPED.has(s));
  assert.deepEqual(
    offenders,
    [],
    '`width: 100%` on a chart canvas never applies: setup() writes an inline pixel width each render ' +
      'and an inline style outranks the sheet. These need max-width: 100% to actually be bounded:\n  ' +
      offenders.join('\n  '),
  );
});

/**
 * The derivations above — and the CSS slicers in motionWidth, premiumPolish and
 * every other test that pulls one rule out of the built page — are all
 * brace-matched. A `{` or `}` inside a CSS COMMENT therefore ends the previous
 * rule early and hands the next one a selector made of prose, which is not a
 * failure anyone reads as "your comment has a brace in it": it silently points
 * an assertion at the wrong rule.
 *
 * This bit during this very round. A new comment explaining the canvas cap
 * quoted `main { overflow-x: hidden }`, and the test two functions up went from
 * green to reporting `.trend-chart-wrap` as uncapped when it plainly was — the
 * brace had merged the comment into the following selector. One other comment
 * in the sheet had the same shape already.
 */
test('no CSS comment carries a brace — the rule slicers are brace-matched', () => {
  const offenders: string[] = [];
  for (const m of CSS.matchAll(/\/\*[\s\S]*?\*\//g)) {
    if (!/[{}]/.test(m[0])) continue;
    const line = CSS.slice(0, m.index).split('\n').length;
    offenders.push(`line ~${line}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a brace inside a CSS comment silently re-points every brace-matched slice that follows it:\n  ' +
      offenders.join('\n  '),
  );
});
