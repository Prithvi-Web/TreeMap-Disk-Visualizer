import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX: Rolling Numerals — the digit-roll math and countUp's contract.
 *
 * The roller lives in public/index.html between exact banner comments (the
 * FxCharts extraction precedent). FxNum.math is DOM-free by construction —
 * tokenize/skeleton/plan decide WHAT rolls; the DOM builder only executes
 * the plan — so the decomposition, alignment and snap rules are exercised
 * here in Node as behaviour. The DOM half runs against a small fake
 * document: slot construction and the column travel are observable without
 * a browser because the animation is a CSS transition, not a JS loop.
 *
 * The section is permanently spliced, so a missing banner fails loudly
 * instead of silently skipping the whole suite.
 */

const BANNER = '/* ═══════════════ FX: Rolling Numerals ═══════════════ */';
const END = '/* ═══ end FX: Rolling Numerals ═══ */';

function sectionSource(): string {
  const alt = process.env.FXNUM_SRC;
  if (alt && existsSync(alt)) return readFileSync(alt, 'utf8');
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Rolling Numerals is spliced into index.html — a renamed banner must fail, never skip');
  const b = html.indexOf(END, a);
  assert.notEqual(b, -1, 'FX: Rolling Numerals banner opens but never closes');
  return html.slice(a, b + END.length);
}

const SRC = sectionSource();

/* A minimal element: enough surface for roll()/rollText()/countUp(). */
function makeEl(): any {
  const e: any = {
    className: '', children: [], attrs: {}, style: {}, dataset: {},
    setAttribute(k: string, v: string) { e.attrs[k] = v; },
    appendChild(c: any) { e.children.push(c); return c; },
    append(...cs: any[]) { e.children.push(...cs); },
  };
  let own = '';
  Object.defineProperty(e, 'textContent', {
    get() {
      if (e.children.length) return e.children.map((c: any) => (c.nodeValue != null ? c.nodeValue : c.textContent)).join('');
      return own;
    },
    set(v: string) { own = String(v); e.children = []; },
  });
  return e;
}

function fmtCount(n: number): string {
  // deterministic en-US style separators, independent of the host locale
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function loadFxNum(reduced: boolean) {
  const rafQueue: Array<(t: number) => void> = [];
  const documentStub = {
    hidden: false,
    createElement: () => makeEl(),
    createTextNode: (t: string) => ({ nodeValue: String(t) }),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const out = new Function('REDUCED', 'document', 'requestAnimationFrame', 'formatCount', 'NodeFilter',
    `'use strict'; ${SRC}\nreturn { FxNum, countUp };`)(
    reduced, documentStub, (cb: (t: number) => void) => { rafQueue.push(cb); return rafQueue.length; },
    fmtCount, { SHOW_TEXT: 4 });
  return { ...out, rafQueue };
}

test('FX: Rolling Numerals — section evaluates in Node and exposes the API', () => {
  const { FxNum, countUp } = loadFxNum(true);
  for (const k of ['roll', 'rollText', 'rollHtml']) assert.equal(typeof FxNum[k], 'function', `FxNum.${k}`);
  for (const k of ['tokenize', 'skeleton', 'runs', 'zeroLike', 'plan']) {
    assert.equal(typeof FxNum.math[k], 'function', `FxNum.math.${k}`);
  }
  assert.equal(typeof countUp, 'function', 'countUp stays a free function — call sites are unchanged');
});

/* ══════════════════ decomposition ══════════════════ */

test('tokenize splits maximal digit runs from the statics around them', () => {
  const { FxNum } = loadFxNum(true);
  assert.deepEqual(FxNum.math.tokenize('412.5 GB'), [{ d: '412' }, { s: '.' }, { d: '5' }, { s: ' GB' }]);
  assert.deepEqual(FxNum.math.tokenize('87%'), [{ d: '87' }, { s: '%' }]);
  assert.deepEqual(FxNum.math.tokenize('no digits'), [{ s: 'no digits' }]);
  assert.deepEqual(FxNum.math.tokenize(''), []);
});

test('skeleton collapses every digit run to one mark — the shape of the print', () => {
  const { FxNum } = loadFxNum(true);
  assert.equal(FxNum.math.skeleton('1,234,567'), '#,#,#');
  assert.equal(FxNum.math.skeleton('87%'), '#%');
  assert.equal(FxNum.math.skeleton('at least 3.2 GB · 41'), 'at least #.# GB · #');
  assert.equal(FxNum.math.skeleton('998'), FxNum.math.skeleton('1002'), 'run length is not part of the shape');
});

test('zeroLike prints the same shape at zero — the honest from-nothing start', () => {
  const { FxNum } = loadFxNum(true);
  assert.equal(FxNum.math.zeroLike('1,234'), '0,000');
  assert.equal(FxNum.math.zeroLike('412.5 GB'), '000.0 GB');
});

/* ══════════════════ the plan: alignment and snap rules ══════════════════ */

test('plan pairs digits in place-value order and keeps statics still', () => {
  const { FxNum } = loadFxNum(true);
  const slots = FxNum.math.plan('87%', '93%');
  assert.deepEqual(slots, [{ from: 8, to: 9 }, { from: 7, to: 3 }, { ch: '%' }]);
});

test('plan right-aligns runs of different length — new digits roll from nothing', () => {
  const { FxNum } = loadFxNum(true);
  const slots = FxNum.math.plan('998 files', '1002 files');
  assert.deepEqual(slots.slice(0, 4), [
    { from: null, to: 1 }, { from: 9, to: 0 }, { from: 9, to: 0 }, { from: 8, to: 2 },
  ]);
  assert.deepEqual(slots.slice(4).map((s: any) => s.ch).join(''), ' files', 'the unit never moves');
});

test('plan refuses a shape change — continuity there would be a lie', () => {
  const { FxNum } = loadFxNum(true);
  assert.equal(FxNum.math.plan('1,050,000', '980,000'), null, 'a separator appeared or vanished');
  assert.equal(FxNum.math.plan('3.2 GB', '412 MB'), null, 'the unit changed');
  assert.equal(FxNum.math.plan('Looking…', '12 groups'), null, 'different sentences never roll');
});

/* ══════════════════ the DOM half, against a fake document ══════════════════ */

test('roll builds one masked slot per digit; columns glide to the target on the kicked frame', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.roll(el, '87%', '93%');
  const root = el.children[0];
  assert.equal(root.className, 'fx-roll');
  const slots = root.children.filter((c: any) => c.className === 'fx-roll-d');
  assert.equal(slots.length, 2, 'two digits, two slots');
  assert.equal(root.children[2].nodeValue, '%', 'the static stays a plain text node');
  for (const [i, target] of [[0, 9], [1, 3]] as const) {
    const [sizer, col] = slots[i].children;
    assert.equal(sizer.textContent, String(target), 'the in-flow sizer carries the REAL target digit');
    assert.equal(col.attrs['aria-hidden'], 'true', 'the column is presentation only');
    assert.equal(col.children.length, 10, 'a full 0–9 column');
  }
  assert.equal(slots[0].children[1].style.transform, 'translateY(-8em)', 'columns start at the old digit');
  assert.equal(slots[1].children[1].style.transform, 'translateY(-7em)');
  assert.equal(rafQueue.length, 1, 'one kicked frame, not a loop — the glide is a CSS transition');
  rafQueue.shift()!(0);
  assert.equal(slots[0].children[1].style.transform, 'translateY(-9em)', 'and travel to the new digit');
  assert.equal(slots[1].children[1].style.transform, 'translateY(-3em)');
});

test('roll snaps to plain text on a shape change or when nothing moves', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.roll(el, '3.2 GB', '412 MB');
  assert.equal(el.textContent, '412 MB');
  assert.equal(el.children.length, 0, 'no slots exist for a snap');
  FxNum.roll(el, '5 GB', '5 GB');
  assert.equal(el.textContent, '5 GB');
  assert.equal(rafQueue.length, 0, 'a snap costs zero frames');
});

test('rollText remembers its own last print — post-roll textContent is presentation, not state', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.rollText(el, '14:32');
  assert.equal(el.textContent, '14:32', 'a first paint has no past to roll from');
  FxNum.rollText(el, '15:07');
  assert.equal(el.dataset.fxv, '15:07', 'the stored value is the target string');
  assert.ok(el.children.length > 0, 'the second paint rolls');
  assert.equal(rafQueue.length, 1);
});

/* ══════════════════ countUp keeps its historical contract ══════════════════ */

test('countUp under reduced motion snaps to the formatted target — no slots, ever', () => {
  const { countUp } = loadFxNum(true);
  const el = makeEl();
  countUp(el, 1234567);
  assert.equal(el.textContent, '1,234,567');
  assert.equal(el.children.length, 0);
  assert.equal(el.dataset.v, 1234567, 'data-v resume semantics survive the upgrade');
});

test('countUp rolls from the previous target (data-v), and from a same-shaped zero on first paint', () => {
  const { countUp, FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  countUp(el, 1234567);
  // "0" and "1,234,567" print different shapes; the honest start is every
  // column rolling up from 0, not a snap.
  const root = el.children[0];
  const slots = root.children.filter((c: any) => c.className === 'fx-roll-d');
  assert.equal(slots.length, 7, 'seven digit slots');
  for (const s of slots) assert.equal(s.children[1].style.transform, 'translateY(0em)', 'every column starts at 0');
  rafQueue.shift()!(0);
  assert.equal(el.dataset.v, 1234567);
  countUp(el, 1234571);
  assert.ok(el.children.length > 0, 'the next update rolls from the LAST TARGET, not from the DOM');
  assert.equal(FxNum.math.plan('1,234,567', '1,234,571')!.length, '1,234,567'.length, 'same shape, slot per character');
});
