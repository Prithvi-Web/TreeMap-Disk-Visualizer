import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Chart axes, labels and legends say what they mean — QA of 5 Oct 2026 (QA-6).
 *
 * The FX: Charts kit is evaluated out of the built `public/index.html` and its
 * primitives are MOUNTED against a fake document and a recording 2D context
 * (the fxChartsPerf harness, extended to keep each call's arguments and the
 * text state it was made under). `measureText` answers 6 px a character.
 *
 * Sizes are decimal here — 1 GB = 1,000,000,000 bytes — because that is the
 * owner's answer for the whole app (QA D09, 5 Oct 2026): the kit formats bytes
 * ONLY through the page's formatBytes, so the stub below plays that function.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const BANNER = '/* ═══════════════ FX: Charts ═══════════════ */';
const END = '/* ═══ end FX: Charts ═══ */';
const SRC = (() => {
  const a = INDEX.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Charts is spliced into index.html');
  const b = INDEX.indexOf(END, a);
  assert.notEqual(b, -1, 'FX: Charts closes');
  return INDEX.slice(a, b + END.length);
})();

/* ══════════════ the recording canvas ══════════════ */

type Call = { op: string; args: unknown[]; font: string; baseline: string; align: string };

function recordingCtx() {
  const calls: Call[] = [];
  const grad = () => ({ addColorStop() {} });
  const state: Record<string, unknown> = {
    font: '10px sans-serif', textBaseline: 'alphabetic', textAlign: 'start',
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: grad, createRadialGradient: grad, createPattern: () => ({}),
  };
  const ctx = new Proxy(state, {
    get(o, k: string) {
      if (k in o) return o[k];
      return (...args: unknown[]) => {
        calls.push({ op: k, args, font: String(o.font), baseline: String(o.textBaseline), align: String(o.textAlign) });
      };
    },
    set(o, k: string, v) { o[k] = v; return true; },
  });
  return { ctx, calls };
}

/* ══════════════ the fake document ══════════════ */

type El = Record<string, any> & { children: El[]; ctx?: ReturnType<typeof recordingCtx> };

function makeEl(tag = 'div'): El {
  const el: El = {
    tag, children: [], className: '', textContent: '', title: '',
    style: {}, dataset: {}, attrs: {}, parentElement: null,
    clientWidth: 600, offsetWidth: 40, offsetHeight: 20, width: 0, height: 0,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute(k: string, v: string) { el.attrs[k] = v; },
    appendChild(c: El) { c.parentElement = el; el.children.push(c); return c; },
    append(...cs: El[]) { for (const c of cs) el.appendChild(c); },
    remove() { if (el.parentElement) el.parentElement.children = el.parentElement.children.filter((c: El) => c !== el); },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: el.clientWidth, height: 200 }; },
    querySelectorAll() { return []; },
  };
  // textContent = '' empties an element, as it does in a browser
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => text, set: (v: string) => { text = String(v); if (v === '') el.children = []; },
  });
  return el;
}

const DECIMAL_BYTES = `
  const UNITS = ['B','KB','MB','GB','TB','PB'];
  function formatBytes(n, d = 1) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    if (n < 1000) return Math.round(n) + ' B';
    let v = n, u = 0;
    while (v >= 1000 && u < UNITS.length - 1) { v /= 1000; u++; }
    return v.toFixed(d) + ' ' + UNITS[u];
  }`;

function loadKit() {
  const host = makeEl('div');
  const canvas = makeEl('canvas');
  host.appendChild(canvas);
  const doc = {
    hidden: false,
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (t: string) => ({ nodeValue: String(t) }),
    addEventListener() {}, removeEventListener() {},
  };
  const stubs = `
    const REDUCED = true;
    ${DECIMAL_BYTES}
    function formatCount(n) { return Number(n).toLocaleString('en-US'); }
    function cssVar() { return ''; }
    function formatDay(ms) { return 'day' + ms; }
    function getComputedStyle() { return { position: 'relative' }; }
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function('document', 'Canvas2D', 'requestAnimationFrame', 'cancelAnimationFrame', 'FxNum', 'performance',
    `'use strict'; ${stubs}\n${SRC}\nreturn FxCharts;`,
  )(
    doc,
    {
      setup(cv: El, w: number, h: number) {
        cv.width = w; cv.height = h;
        return { ctx: (cv.ctx ??= recordingCtx()).ctx, dpr: 1, width: w, height: h };
      },
      toLocal: (_cv: El, x: number, y: number) => ({ x, y }),
      roundRect() {},
    },
    () => 0, () => {},
    { rollText(el: El, s: string) { el.textContent = s; } },
    { now: () => 0 },
  );
  const rec = () => (canvas.ctx ??= recordingCtx());
  return { fx, host, canvas, rec };
}

/** The calls of the LAST frame painted — a mount can paint more than once. */
function lastFrame(calls: Call[]): Call[] {
  let from = 0;
  calls.forEach((c, i) => { if (c.op === 'clearRect') from = i; });
  return calls.slice(from);
}
const texts = (calls: Call[]) => lastFrame(calls).filter((c) => c.op === 'fillText');
const px = (font: string) => Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]);

/* ══════════════ D29 — the reclaim radar's labels stay on the canvas ══════════════ */

test('D29: every radar axis label lies inside the canvas — top, bottom and both sides', () => {
  // QA: "Size" (top) and "Duplicate" (bottom) were cut off. The labels sit
  // 15 px past the rim, and the rim left only 22 px of the 100 px half-height
  // for that gap plus a line of 10 px text.
  const axes = ['Size', 'Unused', 'Rebuilds', 'Duplicate', 'Re-gettable', 'Backed up']
    .map((short) => ({ label: short, short, value: 0.5 }));
  // The reclaim panel's 280×200 (the side labels bind), and a wide one where
  // the top and bottom labels are what limits the rim.
  for (const width of [undefined, 420]) {
    const k = loadKit();
    k.fx.radar(k.canvas, { axes, size: 200, width });
    const W = k.canvas.width, H = k.canvas.height;
    assert.equal(H, 200, 'a 200 px tall radar');
    const labels = texts(k.rec().calls);
    assert.equal(labels.length, 6, 'one label per axis');
    for (const c of labels) {
      const [s, x, y] = c.args as [string, number, number];
      const h = px(c.font);
      const top = c.baseline === 'bottom' ? y - h : c.baseline === 'top' ? y : y - h / 2;
      const w = s.length * 6;
      const left = c.align === 'right' ? x - w : c.align === 'center' ? x - w / 2 : x;
      assert.ok(top >= 0 && top + h <= H, `"${s}" spans y ${top.toFixed(1)}–${(top + h).toFixed(1)} inside 0–${H}`);
      assert.ok(left >= 0 && left + w <= W, `"${s}" spans x ${left.toFixed(1)}–${(left + w).toFixed(1)} inside 0–${W}`);
    }
  }
});

/* ══════════════ D48 — Trends with one snapshot; round decimal byte ticks ══════════════ */

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

test('D48: one snapshot is a dot in the middle of the plot, not half under its left edge', () => {
  // A single time maps a zero-width domain; scaleLinear's guard put the point
  // on padL, where the series clip cut it in half. The date under it is the
  // one date there is.
  const k = loadKit();
  k.fx.area(k.canvas, { series: [{ name: 'Used', points: [{ t: T0, v: 46.6e9 }] }], height: 300 });
  const frame = lastFrame(k.rec().calls);
  const W = k.canvas.width;
  const mid = (62 + (W - 14)) / 2; // the plot between padL and padR
  const dot = frame.find((c) => c.op === 'arc' && c.args[2] === 3.5);
  assert.ok(dot, 'the snapshot is drawn as a dot');
  assert.ok(Math.abs((dot!.args[0] as number) - mid) < 0.5, `at the plot's centre ${mid}, not at ${dot!.args[0]}`);
  const dates = texts(k.rec().calls).filter((c) => String(c.args[0]).startsWith('day'));
  assert.deepEqual(dates.map((c) => [c.args[0], Math.round(c.args[1] as number)]), [[`day${T0}`, Math.round(mid)]],
    'one date, under the dot — not the empty days either side of it');
});

test('D48: two snapshots still span the plot edge to edge, dated at both ends', () => {
  const k = loadKit();
  k.fx.area(k.canvas, { series: [{ name: 'Used', points: [{ t: T0, v: 20e9 }, { t: T0 + DAY, v: 46.6e9 }] }], height: 300 });
  const dates = texts(k.rec().calls).filter((c) => String(c.args[0]).startsWith('day')).map((c) => c.args[0]);
  assert.deepEqual(dates, [`day${T0}`, `day${T0 + DAY}`]);
});

test('D48: byte ticks step in round decimal units, printed by formatBytes', () => {
  // QA read 46.6 / 37.3 / 27.9 / 18.6 / 9.3 GB: decimal 10 GB steps printed by
  // a binary formatBytes. The owner chose decimal units (D09): the steps are
  // 1/2/5 × 10^k bytes and the labels are whatever formatBytes prints.
  const k = loadKit();
  k.fx.area(k.canvas, { series: [{ name: 'Used', points: [{ t: T0, v: 20e9 }, { t: T0 + DAY, v: 46.6e9 }] }], height: 300 });
  const y = texts(k.rec().calls).filter((c) => c.align === 'right').map((c) => c.args[0]);
  assert.deepEqual(y, ['0 B', '10.0 GB', '20.0 GB', '30.0 GB', '40.0 GB', '50.0 GB']);
});

test('D48: a log byte axis ticks by decimal decades — 1 KB, 1 MB, 1 GB — and tops at the data', () => {
  const k = loadKit();
  const points = [1e3, 4e5, 3e7, 2e9, 17e9].map((y, i) => ({ x: 10 ** (i + 1), y, label: 'app' + i }));
  k.fx.scatter(k.canvas, { points, logX: 10, logY: 1000 });
  const y = texts(k.rec().calls).filter((c) => c.align === 'right').map((c) => c.args[0]);
  assert.deepEqual(y, ['0 B', '1.0 KB', '1.0 MB', '1.0 GB', '17.0 GB']);
});

test('D48: the Apps scatter asks for decimal byte decades', () => {
  const at = INDEX.indexOf('async function loadAppsScatter');
  const wiring = INDEX.slice(at, INDEX.indexOf('async function loadDuplicates', at));
  assert.match(wiring, /logX: 10, logY: 1000,/, 'base 1000, so every decade prints as a round 1.0 KB / MB / GB');
});
