import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * FX: Charts — what the interactive primitives cost per frame, as behaviour.
 *
 * tests/fxCharts.test.ts and tests/fxChartsPrimitives.test.ts evaluate the
 * kit with a Canvas2D that throws, so everything from `frame()` inward is
 * pinned structurally there. This file supplies the missing half: a fake
 * document and a RECORDING 2D context, so a primitive can actually be
 * mounted and driven, and the questions this round is about — how many
 * filtered canvas ops one hover costs, how many models one drag frame
 * builds, whether an entrance rAF is still running under a hover, whether a
 * no-op update spins a 600ms loop — are answered by running the code.
 *
 * The recording context counts draw ops that land while ctx.filter is set,
 * because that is the cost the browser pays: Skia rasterizes every drawing
 * operation under a canvas filter into its own temporary layer.
 */

const BANNER = '/* ═══════════════ FX: Charts ═══════════════ */';
const END = '/* ═══ end FX: Charts ═══ */';

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function sectionSource(): string {
  const alt = process.env.FXCHARTS_SRC;
  if (alt && existsSync(alt)) return readFileSync(alt, 'utf8');
  const a = INDEX.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Charts is spliced into index.html — a renamed banner must fail, never skip');
  const b = INDEX.indexOf(END, a);
  assert.notEqual(b, -1, 'FX: Charts banner opens but never closes');
  return INDEX.slice(a, b + END.length);
}

const SRC = sectionSource();

/* ══════════════ the recording canvas ══════════════ */

type Ctx = {
  ops: string[];
  filtered: string[];      // draw ops that ran while a filter was set
  filtersSet: string[];    // every value assigned to ctx.filter
  [k: string]: unknown;
};

const DRAW_OPS = ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'drawImage', 'clearRect'];
const VOID_OPS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'rect',
  'clip', 'setLineDash', 'bezierCurveTo', 'setTransform', 'translate', 'scale', 'putImageData',
];

function makeCtx(): Ctx {
  const stack: string[] = [];
  let filter = 'none';
  const ctx = {
    ops: [] as string[],
    filtered: [] as string[],
    filtersSet: [] as string[],
  } as unknown as Ctx;
  for (const m of VOID_OPS) {
    (ctx as Record<string, unknown>)[m] = (..._a: unknown[]) => {
      ctx.ops.push(m);
      if (m === 'save') stack.push(filter);
      if (m === 'restore') filter = stack.pop() ?? 'none';
    };
  }
  for (const m of DRAW_OPS) {
    (ctx as Record<string, unknown>)[m] = (..._a: unknown[]) => {
      ctx.ops.push(m);
      if (filter && filter !== 'none') ctx.filtered.push(m);
    };
  }
  (ctx as Record<string, unknown>).measureText = (t: string) => ({ width: String(t).length * 6 });
  (ctx as Record<string, unknown>).createLinearGradient = () => ({ addColorStop() {} });
  (ctx as Record<string, unknown>).createPattern = () => ({});
  (ctx as Record<string, unknown>).createImageData = (w: number, h: number) => ({ data: new Array(w * h * 4).fill(0) });
  Object.defineProperty(ctx, 'filter', {
    get() { return filter; },
    set(v: string) { filter = v; ctx.filtersSet.push(v); },
  });
  return ctx;
}

/* ══════════════ the fake document ══════════════ */

type El = Record<string, unknown> & {
  tag: string;
  children: El[];
  listeners: Record<string, Array<(e: unknown) => void>>;
  ctx?: Ctx;
};

function makeEl(tag = 'div'): El {
  const el = {
    tag,
    children: [] as El[],
    className: '',
    listeners: {} as Record<string, Array<(e: unknown) => void>>,
    style: {} as Record<string, unknown>,
    dataset: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    parentElement: null as El | null,
    clientWidth: 600,
    offsetWidth: 40,
    offsetHeight: 20,
    width: 0,
    height: 0,
    textContent: '',
    classList: {
      add() {}, remove() {}, contains() { return false; },
    },
    setAttribute(k: string, v: string) { (el.attrs as Record<string, string>)[k] = v; },
    appendChild(c: El) { c.parentElement = el; el.children.push(c); return c; },
    append(...cs: El[]) { for (const c of cs) el.appendChild(c); },
    remove() {
      const p = el.parentElement;
      if (p) p.children = p.children.filter((c) => c !== el);
      el.parentElement = null;
    },
    addEventListener(type: string, fn: (e: unknown) => void) { (el.listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn);
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.clientWidth, height: 200 }; },
    getContext() { return (el.ctx ??= makeCtx()); },
  } as unknown as El;
  return el;
}

function fire(el: El, type: string, ev: Record<string, unknown> = {}): void {
  for (const fn of [...(el.listeners[type] || [])]) fn(ev);
}

type Harness = {
  fx: any;
  host: El;
  canvas: El;
  ctx: Ctx;
  doc: { hidden: boolean; createElement(tag: string): El; addEventListener(): void };
  layers: El[];               // offscreen canvases the kit created
  flushRaf(max?: number): number;
  pending(): number;
  cancelled: number[];
};

function loadKit(): Harness {
  const host = makeEl('div');
  const canvas = makeEl('canvas');
  host.appendChild(canvas);
  const layers: El[] = [];
  const doc = {
    hidden: false,
    createElement(tag: string) {
      const el = makeEl(tag);
      if (tag === 'canvas') layers.push(el);
      return el;
    },
    createTextNode: (t: string) => ({ nodeValue: String(t) }),
    addEventListener() {},
    removeEventListener() {},
  };
  let seq = 0;
  const queue = new Map<number, (t: number) => void>();
  const cancelled: number[] = [];
  const raf = (cb: (t: number) => void) => { queue.set(++seq, cb); return seq; };
  const caf = (id: number) => { if (queue.delete(id)) cancelled.push(id); };
  let now = 0;
  const flushRaf = (max = 400): number => {
    let frames = 0;
    while (queue.size && frames < max) {
      const [id, cb] = queue.entries().next().value as [number, (t: number) => void];
      queue.delete(id);
      now += 16;
      cb(now);
      frames++;
    }
    return frames;
  };
  const stubs = `
    const REDUCED = false;
    const UNITS = ['B','KB','MB','GB','TB','PB'];
    function formatBytes(n, d = 1) {
      if (!Number.isFinite(n) || n < 0) return '0 B';
      if (n < 1024) return Math.round(n) + ' B';
      let v = n, u = 0;
      while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
      return v.toFixed(d) + ' ' + UNITS[u];
    }
    function cssVar(name) { return ''; }
    function getComputedStyle() { return { position: 'relative' }; }
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function(
    'document', 'Canvas2D', 'requestAnimationFrame', 'cancelAnimationFrame', 'FxNum', 'performance',
    `'use strict'; ${stubs}\n${SRC}\nreturn FxCharts;`,
  )(
    doc,
    {
      setup(cv: El, w: number, h: number) {
        cv.width = w; cv.height = h;
        return { ctx: (cv.ctx ??= makeCtx()), dpr: 1, width: w, height: h };
      },
      toLocal(_cv: El, x: number, y: number) { return { x, y }; },
      roundRect(c: Ctx) { (c.beginPath as () => void)(); },
    },
    raf, caf,
    { rollText(el: El, str: string) { (el as Record<string, unknown>).textContent = str; } },
    { now: () => now },
  );
  return {
    fx, host, canvas, ctx: canvas.ctx ??= makeCtx(), doc, layers,
    flushRaf, pending: () => queue.size, cancelled,
  };
}

/* Sanity: the harness really mounts the kit. A stub gap would otherwise turn
   every assertion below into a vacuous pass. */
test('the perf harness mounts a real primitive and paints through the recording context', () => {
  const h = loadKit();
  const g = h.fx.gauge(h.canvas, { value: 0.5, label: 'Used' });
  assert.ok(h.ctx.ops.length > 0, 'the mount painted');
  g.destroy();
});

/* ══════════════ scatter: the dim pass ══════════════ */

function scatterPoints(n: number) {
  return Array.from({ length: n }, (_, i) => ({ x: 1 + i, y: (i + 1) * 1024, label: 'app ' + i }));
}

/* The first three points of scatterPoints() land ~1.5px apart near the
   bottom-left of the plot — the dense cluster the apps view actually has. */
const DOT0 = { clientX: 86, clientY: 214 };
const DOT1 = { clientX: 88, clientY: 213 };
const DOT2 = { clientX: 90, clientY: 212 };

test('scatter dims the crowd with ONE blurred blit, not one filtered op per dot', () => {
  const h = loadKit();
  const pts = scatterPoints(300);
  const s = h.fx.scatter(h.canvas, { points: pts, height: 240 });
  h.flushRaf(); // let the entrance settle
  h.ctx.filtered.length = 0;
  h.ctx.ops.length = 0;
  fire(h.canvas, 'mousemove', DOT0);
  h.flushRaf();
  assert.ok(h.ctx.filtered.length > 0, 'a hover really did dim the crowd — the pass ran');
  assert.equal(h.ctx.filtered.length, 1,
    'exactly one drawing op under the blur: the cached crowd, blitted once');
  assert.equal(h.ctx.filtered[0], 'drawImage', 'and that op is the blit, not an arc');
  s.destroy();
});

test('scatter caches the dimmed crowd for the hover session — moving between dots re-blits, never re-draws', () => {
  const h = loadKit();
  const s = h.fx.scatter(h.canvas, { points: scatterPoints(300), height: 240 });
  h.flushRaf();
  fire(h.canvas, 'mousemove', DOT0);
  h.flushRaf();
  const layer = h.layers.find((l) => l.ctx && l.ctx !== h.ctx);
  assert.ok(layer && layer.ctx, 'the crowd is rendered to an offscreen canvas');
  const drawn = layer.ctx!.ops.length;
  assert.ok(drawn > 100, 'the offscreen pass really drew the crowd');
  let blits = h.ctx.filtered.length;
  for (const at of [DOT1, DOT2]) {
    fire(h.canvas, 'mousemove', at);
    h.flushRaf();
    assert.ok(h.ctx.filtered.length > blits, 'the move really landed on another dot and repainted');
    blits = h.ctx.filtered.length;
  }
  assert.equal(layer.ctx!.ops.length, drawn,
    'later hovers in the same session reuse the layer — the crowd is drawn once');
  s.destroy();
});

test('scatter: a hover during the reveal stops the entrance rAF instead of racing it', () => {
  const h = loadKit();
  const s = h.fx.scatter(h.canvas, { points: scatterPoints(40), height: 240 });
  assert.equal(h.pending(), 1, 'the entrance sweep is running');
  fire(h.canvas, 'mousemove', DOT0);
  assert.equal(h.pending(), 2, 'and the hover coalescer joins it');
  h.flushRaf(2); // the entrance frame, then the hover frame
  assert.equal(h.pending(), 0,
    'the hover that completed the reveal stopped it — not two renders of the dim pass per frame');
  assert.equal(h.cancelled.length, 1, 'exactly one rAF was cancelled: the entrance');
  s.destroy();
});

/* ══════════════ gauge: no loop for a value that did not move ══════════════ */

test('gauge repaints once — never a 600ms rAF loop — when the value is unchanged', () => {
  const h = loadKit();
  const g = h.fx.gauge(h.canvas, { value: 0.42, label: 'Used' });
  h.flushRaf();
  assert.equal(h.pending(), 0, 'the entrance ease settled');
  const paints = h.ctx.ops.filter((o) => o === 'clearRect').length;
  g.update({}); // exactly what the theme handler does to every live gauge
  assert.equal(h.pending(), 0, 'an unchanged value schedules no frames');
  assert.equal(h.ctx.ops.filter((o) => o === 'clearRect').length, paints + 1,
    'one repaint, so the retint lands — and only one');
  g.update({ value: 0.9 });
  assert.ok(h.pending() > 0, 'a value that really moved still eases');
  g.destroy();
});

/* ══════════════ area: one model per drag frame ══════════════ */

function areaSpec(reads: { n: number }) {
  const points = Array.from({ length: 40 }, (_, i) => ({ t: 1000 + i * 86400000, v: (i + 1) * 1e9 }));
  return {
    get series() { reads.n++; return [{ name: 'Used', points }]; },
    height: 300,
    brush: { height: 72 },
  };
}

test('a brush drag frame builds the area model twice — the window move, then the y nudge', () => {
  const h = loadKit();
  const reads = { n: 0 };
  const a = h.fx.area(h.canvas, areaSpec(reads));
  h.flushRaf();
  // press inside the strip: brushTop = 300 + 8, so y = 340 is on the strip
  fire(h.canvas, 'mousedown', { clientX: 200, clientY: 340, preventDefault() {} });
  reads.n = 0;
  fire(h.canvas, 'mousemove', { clientX: 320, clientY: 340 });
  h.flushRaf(1);
  assert.ok(reads.n > 0, 'the drag frame really ran');
  assert.equal(reads.n, 2,
    'one model to map the pointer into time, one after the window moved — the third was pure waste');
  a.destroy();
});

/* ══════════════ area: the hover tick stops writing DOM it does not change ══════════════ */

test('area re-measures the crosshair pill only when its text changes', () => {
  const h = loadKit();
  const reads = { n: 0 };
  const a = h.fx.area(h.canvas, areaSpec(reads));
  h.flushRaf();
  const pill = h.host.children.find((c) => (c.className as string).includes('fx-tip-pill'));
  assert.ok(pill, 'the date pill is mounted on the host');
  let measured = 0;
  Object.defineProperty(pill, 'offsetWidth', { get() { measured++; return 40; }, configurable: true });
  fire(h.canvas, 'mousemove', { clientX: 300, clientY: 100 });
  h.flushRaf(1);
  assert.equal(measured, 1, 'the first hover measures the pill once');
  fire(h.canvas, 'mousemove', { clientX: 301, clientY: 101 });
  h.flushRaf(1);
  assert.equal(measured, 1, 'a frame that lands on the same sample re-measures nothing');
  a.destroy();
});

test('area rebuilds the tooltip only when its title or rows changed', () => {
  const h = loadKit();
  const reads = { n: 0 };
  const a = h.fx.area(h.canvas, areaSpec(reads));
  h.flushRaf();
  const tip = h.host.children.find((c) => c.className === 'fx-tip');
  assert.ok(tip, 'the tooltip panel is mounted on the host');
  fire(h.canvas, 'mousemove', { clientX: 300, clientY: 100 });
  h.flushRaf(1);
  const built = tip!.children.length;
  assert.ok(built > 0, 'the first hover built the rows');
  let cleared = 0;
  Object.defineProperty(tip, 'textContent', {
    get() { return ''; },
    set() { cleared++; (tip as El).children = []; },
    configurable: true,
  });
  fire(h.canvas, 'mousemove', { clientX: 301, clientY: 101 });
  h.flushRaf(1);
  assert.equal(cleared, 0, 'identical content is not torn down and rebuilt every pointer frame');
  a.destroy();
});
