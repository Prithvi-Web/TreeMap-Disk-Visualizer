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

/* A text node with the two things rollHtml needs of one: a mutable value and
   splitText, which inserts the tail as this node's next sibling. */
function makeText(v: string): any {
  const t: any = {
    nodeType: 3, parentNode: null, _v: String(v),
    splitText(off: number) {
      const rest = makeText(t._v.slice(off));
      t._v = t._v.slice(0, off);
      if (t.parentNode) {
        t.parentNode.children.splice(t.parentNode.children.indexOf(t) + 1, 0, rest);
        rest.parentNode = t.parentNode;
      }
      return rest;
    },
  };
  Object.defineProperty(t, 'nodeValue', { get: () => t._v, set: (x: string) => { t._v = String(x); } });
  Object.defineProperty(t, 'textContent', { get: () => t._v });
  return t;
}

/* A minimal element: enough surface for roll()/rollText()/countUp(), plus the
   innerHTML rewrite, tree walk and node replacement rollHtml performs. */
function makeEl(tag = 'span'): any {
  const e: any = {
    nodeType: 1, tagName: tag.toUpperCase(),
    className: '', children: [], attrs: {}, style: {}, dataset: {}, parentNode: null,
    setAttribute(k: string, v: string) { e.attrs[k] = v; },
    appendChild(c: any) { c.parentNode = e; e.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) { c.parentNode = e; e.children.push(c); } },
    replaceChild(next: any, old: any) {
      const i = e.children.indexOf(old);
      assert.notEqual(i, -1, 'replaceChild was handed a real child');
      next.parentNode = e; old.parentNode = null; e.children[i] = next;
      return old;
    },
  };
  let own = '';
  Object.defineProperty(e, 'textContent', {
    get() {
      if (e.children.length) return e.children.map((c: any) => (c.nodeValue != null ? c.nodeValue : c.textContent)).join('');
      return own;
    },
    set(v: string) { own = String(v); e.children = []; },
  });
  // Enough of a parser for the summary markup the app actually writes:
  // text with <b>/<span> wrappers around the digit runs.
  Object.defineProperty(e, 'innerHTML', {
    set(html: string) {
      own = ''; e.children = [];
      const stack: any[] = [e];
      const re = /<\/?([a-zA-Z][\w-]*)[^>]*>/g;
      let last = 0, m: RegExpExecArray | null;
      const text = (s: string) => { if (s) stack[stack.length - 1].appendChild(makeText(s)); };
      while ((m = re.exec(html))) {
        text(html.slice(last, m.index));
        if (m[0][1] === '/') stack.pop();
        else stack.push(stack[stack.length - 1].appendChild(makeEl(m[1])));
        last = m.index + m[0].length;
      }
      text(html.slice(last));
    },
  });
  return e;
}

/** Every `.fx-roll` root under a node, in document order. */
function rollRoots(node: any): any[] {
  const out: any[] = [];
  (function walk(n: any) {
    for (const c of n.children || []) {
      if (c.nodeType === 3) continue;
      if (c.className === 'fx-roll') out.push(c);
      walk(c);
    }
  })(node);
  return out;
}

/** One roll root as `{ from, to }` — the digits it resumes from, and its target. */
function rollPair(root: any): { from: string; to: string } {
  const ds = root.children.filter((c: any) => c.className === 'fx-roll-d');
  return {
    from: ds.map((d: any) => Math.abs(Number(/translateY\((-?\d+)em\)/.exec(d.children[1].style.transform)![1]))).join(''),
    to: ds.map((d: any) => d.children[0].textContent).join(''),
  };
}

/**
 * The whole subtree as one readable line: text verbatim, elements as
 * `tag[…]`, and a rolling run collapsed to `«from→to»`.
 *
 * Counting `.fx-roll` roots is not enough to hold rollHtml: roll() carries
 * its OWN snap guards, so a rollHtml that wrongly proceeds still ends up
 * with zero roll roots — while having split the text nodes and wrapped
 * every run in a span it had no business touching. The outline shows that.
 */
function outline(n: any): string {
  return (n.children || []).map((c: any) => {
    if (c.nodeType === 3) return c.nodeValue;
    if (c.className === 'fx-roll') { const p = rollPair(c); return `«${p.from}→${p.to}»`; }
    return `${c.tagName.toLowerCase()}[${outline(c)}]`;
  }).join('');
}

function fmtCount(n: number): string {
  // deterministic en-US style separators, independent of the host locale
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function loadFxNum(reduced: boolean) {
  const rafQueue: Array<(t: number) => void> = [];
  const documentStub = {
    hidden: false,
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (t: string) => makeText(t),
    /* rollHtml collects every text node BEFORE it splits any of them, so a
       snapshot walker and a live one agree here. */
    createTreeWalker(root: any, what: number) {
      const found: any[] = [];
      (function walk(n: any) {
        for (const c of n.children || []) {
          if (c.nodeType === 3) { if (what & 4) found.push(c); } else walk(c);
        }
      })(root);
      let i = -1;
      return {
        currentNode: root,
        nextNode(this: any) { i++; if (i >= found.length) return null; this.currentNode = found[i]; return found[i]; },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const out = new Function('REDUCED', 'document', 'requestAnimationFrame', 'formatCount', 'NodeFilter',
    `'use strict'; ${SRC}\nreturn { FxNum, countUp };`)(
    reduced, documentStub, (cb: (t: number) => void) => { rafQueue.push(cb); return rafQueue.length; },
    fmtCount, { SHOW_TEXT: 4 });
  return { ...out, rafQueue, doc: documentStub };
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

test('rollText with an unchanged string touches nothing — no write, no frame, no wiped column', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.rollText(el, '31 Aug');
  FxNum.rollText(el, '30 Aug');
  const rolled = el.children[0];
  assert.equal(rolled.className, 'fx-roll', 'the real change built slots');
  rafQueue.length = 0;
  FxNum.rollText(el, '30 Aug');
  assert.equal(el.children[0], rolled,
    'repainting the same string must not replace the columns with plain text — the crosshair pill '
    + 'is repainted on every pointer frame and most frames say the same date');
  assert.equal(rafQueue.length, 0, 'and nothing is scheduled');
});

/* ══════════════════ rollHtml: the innerHTML surfaces ══════════════════ */

/* The shape every keyed summary in the app has: markup around digit runs,
   rewritten wholesale on each paint. 15 surfaces go through this path. */
const SUMMARY_A = '<b>12</b> groups · <b>3.4 GB</b> reclaimable';
const SUMMARY_B = '<b>14</b> groups · <b>3.6 GB</b> reclaimable';
const B_TEXT = '14 groups · 3.6 GB reclaimable';
/** B printed with no roll at all — the markup exactly as the caller wrote it. */
const B_SNAPPED = 'b[14] groups · b[3.6 GB] reclaimable';
/** B rolled: only 12→14 and the tenths 4→6 are wrapped; the shared '3' is not. */
const B_ROLLED = 'b[span[«12→14»]] groups · b[3.span[«4→6»] GB] reclaimable';

test('rollHtml rewrites the markup, then rolls ONLY the digit runs that changed', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.rollHtml(el, SUMMARY_A, 'scan-1');
  assert.equal(outline(el), 'b[12] groups · b[3.4 GB] reclaimable', 'a first paint has no past — it just prints');
  assert.equal(rafQueue.length, 0);
  FxNum.rollHtml(el, SUMMARY_B, 'scan-1');
  // 12 → 14 and 3.4 → 3.6: the count, and the tenths of the size. The shared
  // '3' keeps its own text node, and every static character is untouched.
  assert.equal(outline(el), B_ROLLED,
    'each changed run resumes from the run the PREVIOUS paint printed in its place');
  assert.equal(rafQueue.length, 2, 'one kicked frame per rolling run — the glide is a CSS transition');
  assert.equal(el.dataset.fxt, B_TEXT, 'the plain text of the new paint is what the next one rolls from');
  assert.equal(el.dataset.fxk, 'scan-1');
});

test('rollHtml snaps when the key says this is a DIFFERENT entity — continuity would be a lie', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const el = makeEl();
  FxNum.rollHtml(el, SUMMARY_A, 'scan-1');
  rafQueue.length = 0;
  FxNum.rollHtml(el, SUMMARY_B, 'scan-2');
  assert.equal(outline(el), B_SNAPPED,
    'a new scan must not roll its group count up from the previous hunt’s figures');
  assert.equal(rafQueue.length, 0, 'and it costs zero frames');
  // The new key is stored, so the paint AFTER it does roll again.
  FxNum.rollHtml(el, SUMMARY_A, 'scan-2');
  assert.equal(rollRoots(el).length, 2, 'same entity again — the rolls come back');
});

test('rollHtml touches nothing under reduced motion, nor in a hidden tab', () => {
  for (const [label, reduced, hidden] of [['REDUCED', true, false], ['hidden', false, true]] as const) {
    const { FxNum, rafQueue, doc } = loadFxNum(reduced);
    doc.hidden = hidden;
    const el = makeEl();
    FxNum.rollHtml(el, SUMMARY_A, 'scan-1');
    FxNum.rollHtml(el, SUMMARY_B, 'scan-1');
    // Not merely "no columns": no split text nodes and no wrapper spans
    // either. roll() would snap these anyway, so only the untouched markup
    // proves rollHtml itself stood down.
    assert.equal(outline(el), B_SNAPPED, `${label}: the caller’s markup is left exactly as written`);
    assert.equal(el.textContent, B_TEXT, `${label}: the value is still correct`);
    assert.equal(rafQueue.length, 0, `${label}: and nothing is scheduled`);
  }
});

test('rollHtml snaps on a shape change and on an unkeyed or unchanged paint', () => {
  const { FxNum, rafQueue } = loadFxNum(false);
  const shape = makeEl();
  FxNum.rollHtml(shape, SUMMARY_A, 'scan-1');
  FxNum.rollHtml(shape, '<b>14</b> groups · <b>3.6 TB</b> reclaimable', 'scan-1');
  assert.equal(outline(shape), 'b[14] groups · b[3.6 TB] reclaimable',
    'the unit moved — the statics are not in the same places');

  const unkeyed = makeEl();
  FxNum.rollHtml(unkeyed, SUMMARY_A, null);
  FxNum.rollHtml(unkeyed, SUMMARY_B, null);
  assert.equal(outline(unkeyed), B_SNAPPED, 'no key, no claim that this is the same entity');

  const same = makeEl();
  FxNum.rollHtml(same, SUMMARY_A, 'scan-1');
  rafQueue.length = 0;
  FxNum.rollHtml(same, SUMMARY_A, 'scan-1');
  assert.equal(outline(same), 'b[12] groups · b[3.4 GB] reclaimable',
    'nothing moved — a repaint of the same numbers rolls nothing');
  assert.equal(rafQueue.length, 0);
});

/* ══════════════════ each guard bites on its own ══════════════════ */

/* roll() and countUp() both refuse REDUCED and a hidden document. Tested only
   through countUp, either guard alone keeps the suite green — so each is
   exercised at its own door here. */

test('roll and rollText snap under reduced motion and in a hidden tab', () => {
  for (const [label, reduced, hidden] of [['REDUCED', true, false], ['hidden', false, true]] as const) {
    const { FxNum, rafQueue, doc } = loadFxNum(reduced);
    doc.hidden = hidden;
    const el = makeEl();
    FxNum.roll(el, '87%', '93%');
    assert.equal(el.textContent, '93%', `${label}: roll prints the target`);
    assert.equal(el.children.length, 0, `${label}: roll builds no slots`);
    const txt = makeEl();
    FxNum.rollText(txt, '14:32');
    FxNum.rollText(txt, '15:07');
    assert.equal(txt.textContent, '15:07', `${label}: rollText prints the target`);
    assert.equal(txt.children.length, 0, `${label}: rollText builds no slots`);
    assert.equal(rafQueue.length, 0, `${label}: and neither schedules a frame`);
  }
});

test('countUp stops at its own door — it never formats the resume point it will not use', () => {
  for (const [label, reduced, hidden] of [['REDUCED', true, false], ['hidden', false, true]] as const) {
    const { countUp, rafQueue, doc } = loadFxNum(reduced);
    doc.hidden = hidden;
    const el = makeEl();
    el.dataset.v = 1234567;
    const seen: number[] = [];
    const fmt = (n: number) => { seen.push(n); return fmtCount(n); };
    countUp(el, 1234571, fmt);
    assert.equal(el.textContent, '1,234,571', `${label}: the target is printed`);
    assert.equal(el.children.length, 0, `${label}: with no slots`);
    assert.equal(rafQueue.length, 0, `${label}: and no frame`);
    // Reaching roll() would format the resume point too, and rely on roll's
    // own guard to snap. countUp returns before it does any of that work.
    assert.deepEqual(seen, [1234571], `${label}: only the target is ever formatted`);
  }
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

/** The `translateY(-Nem)` each column STARTS at — i.e. the digit it resumes from. */
function startDigits(el: any): number[] {
  const root = el.children[0];
  if (!root || root.className !== 'fx-roll') return [];
  return root.children
    .filter((c: any) => c.className === 'fx-roll-d')
    .map((d: any) => Math.abs(Number(/translateY\((-?\d+)em\)/.exec(d.children[1].style.transform)![1])));
}

test('countUp rolls from the previous target (data-v), and from a same-shaped zero on first paint', () => {
  const { countUp, rafQueue } = loadFxNum(false);
  const el = makeEl();
  countUp(el, 1234567);
  // "0" and "1,234,567" print different shapes; the honest start is every
  // column rolling up from 0, not a snap.
  assert.deepEqual(startDigits(el), [0, 0, 0, 0, 0, 0, 0], 'first paint: every column starts at 0');
  rafQueue.shift()!(0);
  assert.equal(el.dataset.v, 1234567);
  countUp(el, 1234571);
  // The whole point of data-v: the second roll RESUMES at 1,234,567 — only
  // the last two columns have anywhere to travel. A resume point hardcoded
  // to zero replays all seven from 0 and this deepEqual is what catches it.
  assert.deepEqual(startDigits(el), [1, 2, 3, 4, 5, 6, 7],
    'the second roll starts at the digits of the PREVIOUS target, not at zero');
  assert.equal(rafQueue.length, 1, 'and it is still one kicked frame');
  rafQueue.shift()!(0);
  const root = el.children[0];
  const cols = root.children.filter((c: any) => c.className === 'fx-roll-d');
  assert.equal(cols[5].children[1].style.transform, 'translateY(-7em)', 'the tens column travels 6 → 7');
  assert.equal(cols[6].children[1].style.transform, 'translateY(-1em)', 'the units column travels 7 → 1');
});

test('countUp with an unchanged value repaints as plain text — a no-op never re-spins', () => {
  const { countUp, rafQueue } = loadFxNum(false);
  const el = makeEl();
  countUp(el, 13);
  assert.ok(el.children.length > 0, 'the first paint rolls up from nothing');
  rafQueue.shift()!(0);
  assert.equal(rafQueue.length, 0);
  countUp(el, 13);
  assert.equal(el.textContent, '13', 'the same value snaps to text');
  assert.equal(el.children.length, 0, 'no slots are rebuilt — renderCart runs on paths that change nothing');
  assert.equal(rafQueue.length, 0, 'and a no-op costs zero frames');
});
