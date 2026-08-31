import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * FX: Liquid Goo — the liquid sliding thumb for segmented controls.
 *
 * Extraction-anchored in the commandPalette.test.ts tradition: the section is
 * pulled out of public/index.html between its banners and EXECUTED here under
 * DOM stubs, because spring physics are behaviour (determinism, settle time,
 * overshoot) and the failure mode of the DOM half is a refactor quietly
 * breaking the fallback path nobody exercises.
 *
 * The section is permanently spliced now, so a missing banner is a BROKEN
 * BUILD, not a pending one: it fails loudly here instead of silently turning
 * 17 behavioural tests into skips (a renamed banner once did exactly that —
 * green suite, zero coverage). `FXGOO_SECTION=/path/to/section.js` still
 * points the same tests at a standalone file for pre-merge validation.
 */

const BANNER = '/* ═══════════════ FX: Liquid Goo ═══════════════ */';
const END_BANNER = '/* ═══ end FX: Liquid Goo ═══ */';

function loadSource(): string {
  if (process.env.FXGOO_SECTION) return readFileSync(process.env.FXGOO_SECTION, 'utf8');
  const html = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf(BANNER);
  assert.notEqual(a, -1, 'FX: Liquid Goo is spliced into index.html — a renamed banner must fail, never skip');
  const b = html.indexOf(END_BANNER, a);
  assert.notEqual(b, -1, 'the section has its end banner');
  return html.slice(a, b + END_BANNER.length);
}

const SRC = loadSource();

/* ══════════════════════ DOM stubs ══════════════════════ */

type Listener = (...args: unknown[]) => void;

/** style stub with the custom-property API the detach pair drives. */
type StubStyle = Record<string, string> & {
  setProperty: (k: string, v: string) => void;
  removeProperty: (k: string) => void;
};
function makeStyle(): StubStyle {
  const s = {} as StubStyle;
  Object.defineProperty(s, 'setProperty', { enumerable: false, value: (k: string, v: string) => { s[k] = v; } });
  Object.defineProperty(s, 'removeProperty', { enumerable: false, value: (k: string) => { delete s[k]; } });
  return s;
}

class StubNode {
  tag: string;
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parentNode: StubNode | null = null;
  style: StubStyle = makeStyle();
  listeners: Record<string, Listener[]> = {};
  cls = new Set<string>();
  offsetLeft = 0; offsetTop = 0; offsetWidth = 0; offsetHeight = 0;
  min = ''; max = ''; value = '';
  classList = {
    add: (...cs: string[]) => cs.forEach((c) => this.cls.add(c)),
    remove: (...cs: string[]) => cs.forEach((c) => this.cls.delete(c)),
    contains: (c: string) => this.cls.has(c),
  };
  constructor(tag: string) { this.tag = tag; }
  get className() { return [...this.cls].join(' '); }
  set className(v: string) { this.cls = new Set(v.split(/\s+/).filter(Boolean)); this.classList = {
    add: (...cs: string[]) => cs.forEach((c) => this.cls.add(c)),
    remove: (...cs: string[]) => cs.forEach((c) => this.cls.delete(c)),
    contains: (c: string) => this.cls.has(c),
  }; }
  get firstChild(): StubNode | null { return this.children[0] ?? null; }
  get nextSibling(): StubNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] ?? null;
  }
  get parentElement(): StubNode | null { return this.parentNode; }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === 'class') this.cls = new Set(v.split(/\s+/).filter(Boolean));
  }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(n: StubNode) { n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n: StubNode, ref: StubNode | null) {
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n: StubNode) {
    const i = this.children.indexOf(n);
    if (i !== -1) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type: string, fn: Listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn({ type }); }
  querySelector(sel: string): StubNode | null {
    if (sel === 'button[aria-selected="true"]') {
      return this.children.find((c) => c.tag === 'button' && c.attrs['aria-selected'] === 'true') ?? null;
    }
    return null;
  }
  findByClass(c: string): StubNode | null {
    for (const child of this.children) {
      if (child.cls.has(c)) return child;
      const deep = child.findByClass(c);
      if (deep) return deep;
    }
    return null;
  }
}

interface Dom {
  document: { createElement: (t: string) => StubNode; createElementNS: (ns: string, t: string) => StubNode };
  performance: { now: () => number };
  raf: (cb: (t: number) => void) => number;
  caf: (id: number) => void;
  MO: unknown; RO: unknown; gcs: () => { position: string };
  pump: (dt?: number) => number;      // run queued rAF callbacks; returns how many ran
  pumpUntilIdle: (max?: number) => number;
  queued: () => number;
  rafCount: () => number;
  mutationObservers: Array<{ trigger: () => void }>;
  resizeObservers: Array<{ trigger: () => void }>;
  failCreateNS?: boolean;
}

function makeDom(): Dom {
  let clock = 0;
  let nextId = 1;
  let calls = 0;
  let queue: Array<{ id: number; cb: (t: number) => void }> = [];
  const mutationObservers: Array<{ trigger: () => void }> = [];
  const resizeObservers: Array<{ trigger: () => void }> = [];
  const dom: Dom = {
    document: {
      createElement: (t: string) => new StubNode(t),
      createElementNS: (_ns: string, t: string) => {
        if (dom.failCreateNS) throw new Error('SVG unavailable (test-injected)');
        return new StubNode(t);
      },
    },
    performance: { now: () => clock },
    raf: (cb) => { calls++; const id = nextId++; queue.push({ id, cb }); return id; },
    caf: (id) => { queue = queue.filter((e) => e.id !== id); },
    MO: class {
      cb: Listener; dead = false;
      constructor(cb: Listener) { this.cb = cb; mutationObservers.push(this as never); }
      observe() { /* recorded implicitly */ }
      disconnect() { this.dead = true; }
      trigger() { if (!this.dead) this.cb([], this); }
    },
    RO: class {
      cb: Listener; dead = false;
      constructor(cb: Listener) { this.cb = cb; resizeObservers.push(this as never); }
      observe() { /* recorded implicitly */ }
      disconnect() { this.dead = true; }
      trigger() { if (!this.dead) this.cb([], this); }
    },
    gcs: () => ({ position: 'static' }),
    pump: (dt = 16) => {
      clock += dt;
      const q = queue; queue = [];
      for (const e of q) e.cb(clock);
      return q.length;
    },
    pumpUntilIdle: (max = 2000) => {
      let n = 0;
      while (queue.length && n < max) { dom.pump(); n++; }
      return n;
    },
    queued: () => queue.length,
    rafCount: () => calls,
    mutationObservers, resizeObservers,
  };
  return dom;
}

interface MoveMapped {
  stiffness: number; damping: number; stretch: number; tail: number; force: number;
}
interface FxGooApi {
  segThumb: (el: StubNode, opts?: Record<string, unknown>) => Record<string, unknown> | null;
  slider: (el: StubNode, opts?: Record<string, unknown>) => Record<string, unknown> | null;
  spring: (from: number, to: number, cfg: unknown, onFrame: (v: number, done: boolean) => void) =>
    { value: number; done: boolean; stop: () => void; retarget: (t: number) => void };
  detach: (el: StubNode) => void;
  detachPair: (field: StubNode, btn: StubNode, opts?: Record<string, unknown>) => Record<string, unknown> | null;
  bendAttach: (el: StubNode, opts?: Record<string, unknown>) => Record<string, unknown> | null;
  bendPull: (el: StubNode, nx: number, ny: number) => void;
  bendRelease: (el: StubNode) => void;
  bendPath: (bw: number, bh: number, r: number, bendCur: number, bendCurX: number) => string;
  simulate: (cfg: unknown) => { duration: number; values: number[]; peak: number; overshoots: boolean };
  compileLinear: (cfg: unknown) => { duration: number; easing: string };
  mapMove: (t?: Record<string, unknown>) => MoveMapped;
  presets: Record<string, { stiffness: number; damping: number; mass: number }>;
  SEG_SPRING: { stiffness: number; damping: number; mass: number };
  MOVE: MoveMapped;
  BEND: { vertical: number; horizontal: number };
}

function loadFxGoo(reduced = false, dom: Dom = makeDom()): { fx: FxGooApi; dom: Dom } {
  const fn = new Function(
    'REDUCED', 'document', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'CSS', 'console',
    `${SRC}\n;return FxGoo;`,
  );
  const fx = fn(
    reduced, dom.document, dom.performance, dom.raf, dom.caf,
    dom.MO, dom.RO, dom.gcs, { supports: () => false }, console,
  ) as FxGooApi;
  return { fx, dom };
}

function makeSeg(): { seg: StubNode; buttons: StubNode[] } {
  const seg = new StubNode('div');
  seg.setAttribute('role', 'tablist');
  seg.cls.add('seg');
  const buttons: StubNode[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new StubNode('button');
    b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    b.offsetLeft = 3 + i * 62; b.offsetTop = 3; b.offsetWidth = 60; b.offsetHeight = 24;
    seg.appendChild(b);
    buttons.push(b);
  }
  return { seg, buttons };
}

/* ══════════════════════ Spring math, as behaviour ══════════════════════ */

test('the spring simulation is deterministic — same config, same curve, twice', () => {
  const { fx } = loadFxGoo();
  const a = fx.simulate({ stiffness: 480, damping: 34, mass: 1 });
  const b = fx.simulate({ stiffness: 480, damping: 34, mass: 1 });
  assert.deepEqual(a.values, b.values);
  assert.equal(a.duration, b.duration);
  assert.deepEqual(fx.simulate('snappy').values, fx.simulate('snappy').values, 'presets too');
});

test('the seg-thumb spring settles within 350ms with a slight overshoot', () => {
  const { fx } = loadFxGoo();
  const sim = fx.simulate(fx.SEG_SPRING);
  assert.ok(sim.duration * 1000 <= 350, `settles in ${Math.round(sim.duration * 1000)}ms — the Apple-feel budget is 350`);
  assert.ok(sim.peak > 1.0005, `overshoots slightly (peak ${sim.peak}) — physical, not eased`);
  assert.ok(sim.peak < 1.05, `but never by more than 5% (peak ${sim.peak}) — restraint above all`);
});

test('the library presets survived the port verbatim', () => {
  const { fx } = loadFxGoo();
  assert.deepEqual(fx.presets.snappy, { stiffness: 480, damping: 34, mass: 1 });
  assert.deepEqual(fx.presets.smooth, { stiffness: 190, damping: 26, mass: 1 });
  assert.deepEqual(fx.presets.bouncy, { stiffness: 320, damping: 17, mass: 1 });
});

test('every simulated curve ends exactly at 1 — springs may wobble but must land', () => {
  const { fx } = loadFxGoo();
  for (const cfg of ['snappy', 'smooth', 'bouncy', { stiffness: 640, damping: 42 }]) {
    const sim = fx.simulate(cfg);
    assert.equal(sim.values[sim.values.length - 1], 1);
    assert.ok(sim.duration < 10, 'and within the simulation cap');
  }
});

test('REDUCED shortcut: spring() snaps in one frame and never touches rAF', () => {
  const { fx, dom } = loadFxGoo(true);
  const frames: Array<[number, boolean]> = [];
  const h = fx.spring(0, 100, 'bouncy', (v, done) => frames.push([v, done]));
  assert.deepEqual(frames, [[100, true]], 'exactly one frame, at the target, marked done');
  assert.equal(h.value, 100);
  assert.equal(h.done, true);
  assert.equal(dom.rafCount(), 0, 'no rAF was ever requested');
});

test('spring() drives to the target on the stub clock, overshoots within bounds, then goes silent', () => {
  const { fx, dom } = loadFxGoo(false);
  let max = -Infinity;
  let doneAt = -1;
  let frames = 0;
  fx.spring(0, 100, fx.SEG_SPRING, (v, done) => {
    frames++;
    if (v > max) max = v;
    if (done) doneAt = frames;
  });
  dom.pumpUntilIdle();
  assert.ok(doneAt > 0, 'the spring reported done');
  assert.ok(max > 100.005, `it genuinely overshot (${max})`);
  assert.ok(max < 105, `but stayed inside 5% (${max})`);
  assert.equal(dom.queued(), 0, 'nothing left in the rAF queue — the loop sleeps');
});

test('a stopped spring schedules nothing further; retarget wakes it again', () => {
  const { fx, dom } = loadFxGoo(false);
  const h = fx.spring(0, 100, 'smooth', () => { /* observed via handle */ });
  dom.pump(); dom.pump();
  h.stop();
  assert.equal(dom.queued(), 0, 'stop() cancels the pending frame');
  h.retarget(50);
  assert.ok(dom.queued() > 0, 'retarget re-arms the loop');
  dom.pumpUntilIdle();
  assert.ok(Math.abs(h.value - 50) < 0.5, `and it lands on the new target (${h.value})`);
});

/* ══════════════════════ segThumb, on DOM stubs ══════════════════════ */

test('segThumb injects silhouette + crisp thumb, chases a new selection, then sleeps', () => {
  const { fx, dom } = loadFxGoo(false);
  const { seg, buttons } = makeSeg();
  fx.segThumb(seg);
  const sil = seg.findByClass('fxgoo-sil');
  const thumb = seg.findByClass('fxgoo-thumb');
  assert.ok(sil, 'the SVG silhouette layer exists');
  assert.ok(thumb, 'the crisp thumb exists');
  assert.ok(seg.cls.has('fxgoo-live'), 'the control is marked live (thumb sheds its own drop shadow)');
  assert.ok(sil!.children.some((c) => c.tag === 'defs'), 'the goo filter is per-control, in its own defs');
  dom.pumpUntilIdle();
  assert.match(thumb!.style.transform, /translate\(3px/, 'parked on the first button');

  buttons[0].setAttribute('aria-selected', 'false');
  buttons[2].setAttribute('aria-selected', 'true');
  dom.mutationObservers.forEach((m) => m.trigger());
  const frames = dom.pumpUntilIdle();
  assert.ok(frames > 3, `the move was animated over frames (${frames}), not teleported`);
  assert.match(thumb!.style.transform, /translate\(127px/, 'and settles exactly on the third button (offsetLeft 127)');
  assert.equal(thumb!.style.width, '60px');
  assert.equal(dom.queued(), 0, 'completely idle between moves — no rAF when settled');
});

test('the goo filter carries the classic numbers: blur 5, contrast 18 / -7, atop', () => {
  const { fx } = loadFxGoo(false);
  const { seg } = makeSeg();
  fx.segThumb(seg);
  const sil = seg.findByClass('fxgoo-sil')!;
  const defs = sil.children.find((c) => c.tag === 'defs')!;
  const filter = defs.children[0];
  const blur = filter.children.find((c) => c.tag === 'feGaussianBlur')!;
  assert.equal(blur.attrs.stdDeviation, '5');
  const cm = filter.children.find((c) => c.tag === 'feColorMatrix')!;
  assert.match(cm.attrs.values, /18 -7$/, 'the goo alpha slope/intercept pairing');
  assert.ok(filter.children.some((c) => c.tag === 'feComposite' && c.attrs.operator === 'atop'),
    'SourceGraphic composited atop — full alpha inside the original geometry');
});

test('if SVG construction throws, the control degrades to a plain CSS-transition thumb', () => {
  const dom = makeDom();
  dom.failCreateNS = true;
  const { fx } = loadFxGoo(false, dom);
  const { seg, buttons } = makeSeg();
  fx.segThumb(seg); // must not throw
  const thumb = seg.findByClass('fxgoo-thumb');
  assert.ok(thumb, 'a thumb still exists');
  assert.ok(thumb!.cls.has('fxgoo-fallback'), 'in fallback mode');
  assert.equal(seg.findByClass('fxgoo-sil'), null, 'no half-built silhouette left behind');
  assert.ok(!seg.cls.has('fxgoo-live'), 'and the thumb keeps its own CSS shadow');
  assert.match(thumb!.style.transform, /translate\(3px/, 'positioned on the selected button');
  buttons[0].setAttribute('aria-selected', 'false');
  buttons[1].setAttribute('aria-selected', 'true');
  dom.mutationObservers.forEach((m) => m.trigger());
  assert.match(thumb!.style.transform, /translate\(65px/, 'selection changes still move it (CSS animates)');
});

test('REDUCED: instant reposition, no goo layer, zero rAF', () => {
  const { fx, dom } = loadFxGoo(true);
  const { seg, buttons } = makeSeg();
  fx.segThumb(seg);
  assert.equal(seg.findByClass('fxgoo-sil'), null, 'no silhouette is even built');
  const thumb = seg.findByClass('fxgoo-thumb')!;
  assert.match(thumb.style.transform, /translate\(3px/);
  buttons[0].setAttribute('aria-selected', 'false');
  buttons[2].setAttribute('aria-selected', 'true');
  dom.mutationObservers.forEach((m) => m.trigger());
  assert.match(thumb.style.transform, /translate\(127px/, 'repositioned instantly');
  assert.equal(dom.rafCount(), 0, 'no animation frames requested at all');
});

test('detach removes every injected node and disconnects the observers', () => {
  const { fx, dom } = loadFxGoo(false);
  const { seg } = makeSeg();
  fx.segThumb(seg);
  dom.pumpUntilIdle();
  fx.detach(seg);
  assert.equal(seg.findByClass('fxgoo-sil'), null);
  assert.equal(seg.findByClass('fxgoo-thumb'), null);
  assert.ok(!seg.cls.has('fxgoo-live'));
  assert.ok(dom.mutationObservers.every((m) => (m as { dead?: boolean }).dead), 'MutationObserver disconnected');
  assert.ok(dom.resizeObservers.every((r) => (r as { dead?: boolean }).dead), 'ResizeObserver disconnected');
  assert.ok(fx.segThumb(seg), 'and the control can be enhanced again');
});

test('a hidden pane (every button measuring 0) never writes a negative rect width', () => {
  // QA F2: '<rect> attribute width: A negative value is not valid ("-0.2")'.
  // offsetWidth of a display:none'd button is 0, and the width spring's
  // 0.4% overshoot carries it below 0 when it chases that target — so this
  // drives a real mid-transit move into a hidden pane and records every
  // width the frame loop writes to the silhouette body.
  const { fx, dom } = loadFxGoo(false);
  const { seg, buttons } = makeSeg();
  fx.segThumb(seg);
  dom.pumpUntilIdle();
  const sil = seg.findByClass('fxgoo-sil')!;
  const body = sil.children.find((c) => c.tag === 'g')!.children.find((c) => c.tag === 'rect')!;
  const widths: number[] = [];
  const orig = body.setAttribute.bind(body);
  body.setAttribute = (k: string, v: string) => { if (k === 'width') widths.push(Number(v)); orig(k, v); };
  // a real move first, so the spring is awake mid-transit…
  buttons[0].setAttribute('aria-selected', 'false');
  buttons[2].setAttribute('aria-selected', 'true');
  dom.mutationObservers.forEach((m) => m.trigger());
  dom.pump(); dom.pump();
  // …then the pane hides: every button measures 0 in every dimension
  for (const b of buttons) { b.offsetLeft = 0; b.offsetTop = 0; b.offsetWidth = 0; b.offsetHeight = 0; }
  dom.mutationObservers.forEach((m) => m.trigger());
  dom.pumpUntilIdle();
  assert.ok(widths.length > 0, 'the animated move did write width frames');
  for (const w of widths) assert.ok(w >= 0, `rect width ${w} was written — negative widths are invalid SVG`);
  const thumb = seg.findByClass('fxgoo-thumb')!;
  assert.equal(thumb.style.opacity, '0', 'a zero-size measurement is treated as hidden');
  assert.equal(dom.queued(), 0, 'and the loop sleeps instead of chasing a hidden target');
});

/* ══════════════════════ slider, on DOM stubs ══════════════════════ */

test('slider trails a moving thumb as liquid, then hides its blob and sleeps', () => {
  const { fx, dom } = loadFxGoo(false);
  const host = new StubNode('div');
  const input = new StubNode('input');
  input.min = '0'; input.max = '100'; input.value = '0';
  input.offsetLeft = 0; input.offsetTop = 0; input.offsetWidth = 216; input.offsetHeight = 16;
  host.appendChild(input);
  fx.slider(input);
  assert.ok(host.cls.has('fxgoo-host'), 'a static host becomes the containing block');
  assert.ok(input.cls.has('fxgoo-range'));
  const sil = host.findByClass('fxgoo-sil')!;
  assert.ok(sil, 'the trail silhouette exists beside the input');
  assert.equal(dom.queued(), 0, 'idle until something moves');

  input.value = '75';
  input.fire('input');
  dom.pump(); dom.pump();
  const body = sil.children.find((c) => c.tag === 'g')!.children.find((c) => c.tag === 'rect')!;
  assert.equal(body.attrs.height, '16', 'the liquid body is visible while trailing');
  dom.pumpUntilIdle();
  assert.equal(body.attrs.height, '0', 'and hides completely once settled');
  assert.equal(dom.queued(), 0, 'no rAF when settled');
});

test('REDUCED: slider() declines to build any goo at all', () => {
  const { fx, dom } = loadFxGoo(true);
  const host = new StubNode('div');
  const input = new StubNode('input');
  host.appendChild(input);
  const h = fx.slider(input);
  assert.equal(h, null);
  assert.equal(host.findByClass('fxgoo-sil'), null);
  assert.equal(dom.rafCount(), 0);
});

/* ══════════════════════ MoveTuning knobs (mapMove) ══════════════════════ */

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

test('mapMove golden: the default knob positions reproduce MOVE_DEFAULTS exactly', () => {
  const { fx } = loadFxGoo();
  const d = fx.mapMove();
  assert.equal(d.stiffness, 380);
  assert.equal(d.damping, 18);
  near(d.stretch, 0.18);
  near(d.tail, 0.46);
  assert.equal(d.force, 0.5);
});

test('mapMove golden: the feel curve is 380·10^(p−0.5) with √stiffness-rescaled damping', () => {
  const { fx } = loadFxGoo();
  near(fx.mapMove({ springiness: 0 }).stiffness, 120.16655108639841);
  near(fx.mapMove({ springiness: 1 }).stiffness, 1201.6655108639843);
  // damping keeps the ratio across the curve: c/√k is springiness-invariant
  const lo = fx.mapMove({ springiness: 0 });
  const hi = fx.mapMove({ springiness: 1 });
  near(lo.damping / Math.sqrt(lo.stiffness), hi.damping / Math.sqrt(hi.stiffness));
  // wobble is ζ-shaped: 0.62 lands on the timebar profile's 12.72
  near(fx.mapMove({ wobble: 0.62 }).damping, 12.72, 1e-12);
  near(fx.mapMove({ trail: 0.66 }).tail, 0.528);
  near(fx.mapMove({ stretch: 0.4 }).stretch, 0.2);
  // `advanced` is the raw escape hatch, passed straight through
  assert.equal(fx.mapMove({ advanced: { stiffness: 999 } }).stiffness, 999);
});

test('mapMove springs are deterministic through simulate — same knobs, same curve', () => {
  const { fx } = loadFxGoo();
  const a = fx.simulate(fx.mapMove({ springiness: 0.7, wobble: 0.62 }));
  const b = fx.simulate(fx.mapMove({ springiness: 0.7, wobble: 0.62 }));
  assert.deepEqual(a.values, b.values);
  assert.equal(a.duration, b.duration);
});

test('the timebar profile is measurably bouncier than the default chase', () => {
  const { fx } = loadFxGoo();
  const stock = fx.simulate(fx.mapMove());
  const timebar = fx.simulate(fx.mapMove({ wobble: 0.62, trail: 0.66, stretch: 0.4 }));
  assert.ok(timebar.peak > stock.peak, `more wobble must overshoot further (${timebar.peak} vs ${stock.peak})`);
  assert.ok(timebar.peak < 1.35, `but stays a profile, not a toy (peak ${timebar.peak})`);
});

/* ══════════════════════ Waviness (feTurbulence + feDisplacementMap) ══════════════════════ */

function waveOf(sil: StubNode): StubNode {
  const defs = sil.children.find((c) => c.tag === 'defs')!;
  const filter = defs.children[0];
  const wave = filter.children.find((c) => c.tag === 'feDisplacementMap');
  assert.ok(wave, 'the displacement pass exists');
  return wave!;
}

test('the waviness pass carries the upstream numbers and parks at scale 0', () => {
  const { fx } = loadFxGoo(false);
  const { seg } = makeSeg();
  fx.segThumb(seg);
  const sil = seg.findByClass('fxgoo-sil')!;
  const defs = sil.children.find((c) => c.tag === 'defs')!;
  const filter = defs.children[0];
  const turb = filter.children.find((c) => c.tag === 'feTurbulence')!;
  assert.ok(turb, 'feTurbulence exists');
  assert.equal(turb.attrs.type, 'fractalNoise');
  assert.equal(turb.attrs.baseFrequency, '0.018');
  assert.equal(turb.attrs.numOctaves, '2');
  assert.equal(turb.attrs.seed, '7');
  const wave = waveOf(sil);
  assert.equal(wave.attrs.in, 'shape-raw');
  assert.equal(wave.attrs.in2, 'wave-noise');
  assert.equal(wave.attrs.xChannelSelector, 'R');
  assert.equal(wave.attrs.yChannelSelector, 'G');
  assert.equal(wave.attrs.scale, '0', 'a resting control pays nothing');
  // and the displaced result feeds the deluxe bands, so ring/shine hug the
  // wavy edge: the BINARIZE matrix reads 'shape', the displacement's output
  const bin = filter.children.filter((c) => c.tag === 'feColorMatrix')[1];
  assert.equal(bin.attrs.in, 'shape');
  assert.equal(wave.attrs.result, 'shape');
});

test('waviness rides motion only: scale rises mid-transit and settles back to 0', () => {
  const { fx, dom } = loadFxGoo(false);
  const { seg, buttons } = makeSeg();
  fx.segThumb(seg);
  dom.pumpUntilIdle();
  const wave = waveOf(seg.findByClass('fxgoo-sil')!);
  assert.equal(wave.attrs.scale, '0', 'still at rest');
  buttons[0].setAttribute('aria-selected', 'false');
  buttons[2].setAttribute('aria-selected', 'true');
  dom.mutationObservers.forEach((m) => m.trigger());
  let peak = 0;
  for (let i = 0; i < 12 && dom.queued(); i++) {
    dom.pump();
    peak = Math.max(peak, Number(wave.attrs.scale));
  }
  assert.ok(peak > 0, `the boundary undulated while travelling (peak scale ${peak})`);
  assert.ok(peak <= 8, `bounded by waviness 4 × 2 (peak scale ${peak})`);
  dom.pumpUntilIdle();
  assert.equal(wave.attrs.scale, '0', 'and settles glass-still');
  assert.equal(dom.queued(), 0, 'with the loop asleep — no idle filter cost');
});

/* ══════════════════════ detachPair, on DOM stubs ══════════════════════ */

function makePair(): { host: StubNode; field: StubNode; btn: StubNode } {
  const host = new StubNode('div');
  const field = new StubNode('div');
  field.offsetLeft = 0; field.offsetTop = 0; field.offsetWidth = 180; field.offsetHeight = 30;
  const btn = new StubNode('button');
  btn.offsetLeft = 186; btn.offsetTop = 0; btn.offsetWidth = 30; btn.offsetHeight = 30;
  host.appendChild(field);
  host.appendChild(btn);
  return { host, field, btn };
}

test('detachPair builds ONE goo group with two mirrored bodies at the 8/22 pairing', () => {
  const { fx } = loadFxGoo(false);
  const { host, field, btn } = makePair();
  fx.detachPair(field, btn);
  const sil = host.findByClass('fxgoo-sil')!;
  assert.ok(sil, 'the shared silhouette exists');
  assert.ok(sil.cls.has('fxgoo-sil-pair'));
  assert.ok(host.cls.has('fxgoo-host'), 'a static host becomes the containing block');
  const defs = sil.children.find((c) => c.tag === 'defs')!;
  const filter = defs.children[0];
  assert.equal(filter.children.find((c) => c.tag === 'feGaussianBlur')!.attrs.stdDeviation, '8');
  const cm = filter.children.find((c) => c.tag === 'feColorMatrix')!;
  assert.match(cm.attrs.values, /22 -8\.67$/, 'the intercept tracks the slope, same alpha crossing as 18/-7');
  const group = sil.children.find((c) => c.tag === 'g')!;
  const rects = group.children.filter((c) => c.tag === 'rect');
  assert.equal(rects.length, 2, 'field body AND button body share the one filter — that is the merge');
  assert.equal(rects[0].attrs.width, '180', 'field mirrored');
  assert.equal(rects[1].attrs.width, '30', 'button mirrored');
  assert.ok(btn.cls.has('fxgoo-pair-item'), 'the mover rides the custom property');
  // A transform is a stacking context, and the field anchors z-indexed
  // panels in the app — by default it must stay transform-free.
  assert.ok(!field.cls.has('fxgoo-pair-item'), 'the field is NOT decorated unless a shift is opted in');
});

test('focus liquid-splits the pair apart; blur merges it back through the anticipation dip', () => {
  const { fx, dom } = loadFxGoo(false);
  const { host, field, btn } = makePair();
  fx.detachPair(field, btn);
  dom.pumpUntilIdle();
  assert.equal(dom.queued(), 0, 'merged and asleep at rest');

  field.fire('focus');
  const frames = dom.pumpUntilIdle();
  assert.ok(frames > 5, `the split animates over frames (${frames})`);
  assert.equal(btn.style['--fxgoo-dx'], '15px', 'the button detaches out past bridging');
  assert.equal(field.style['--fxgoo-dx'], undefined, 'the field never transforms by default');
  const group = host.findByClass('fxgoo-sil')!.children.find((c) => c.tag === 'g')!;
  const btnBody = group.children.filter((c) => c.tag === 'rect')[1];
  assert.equal(btnBody.attrs.x, '201', 'the mirrored body moved with it (186 + 15)');

  field.fire('blur');
  let dipped = 0;
  while (dom.queued()) {
    dom.pump();
    dipped = Math.min(dipped, parseFloat(btn.style['--fxgoo-dx'] || '0'));
  }
  assert.ok(dipped < -0.5, `the merge-back dips toward the returning momentum (${dipped}px)`);
  assert.equal(btn.style['--fxgoo-dx'], '0px', 'and lands merged');
  assert.equal(dom.queued(), 0, 'then sleeps');
});

test('an opted-in fieldShift decorates the field and splits it symmetrically', () => {
  const { fx, dom } = loadFxGoo(false);
  const { field, btn } = makePair();
  fx.detachPair(field, btn, { fieldShift: -5, buttonShift: 10 });
  assert.ok(field.cls.has('fxgoo-pair-item'), 'the field becomes a mover when asked');
  field.fire('focus');
  dom.pumpUntilIdle();
  assert.equal(field.style['--fxgoo-dx'], '-5px', 'the field leans away');
  assert.equal(btn.style['--fxgoo-dx'], '10px');
});

test('detachPair degrades to the plain-CSS split when SVG construction throws', () => {
  const dom = makeDom();
  dom.failCreateNS = true;
  const { fx } = loadFxGoo(false, dom);
  const { host, field, btn } = makePair();
  fx.detachPair(field, btn); // must not throw
  assert.equal(host.findByClass('fxgoo-sil'), null, 'no half-built silhouette left behind');
  assert.ok(btn.cls.has('fxgoo-fallback'), 'fallback mode is visible to CSS');
  assert.ok(!field.cls.has('fxgoo-fallback'), 'the transform-free field stays undecorated in fallback too');
  field.fire('focus');
  assert.equal(btn.style['--fxgoo-dx'], '15px', 'the split still happens — CSS transitions carry it');
  field.fire('blur');
  assert.equal(btn.style['--fxgoo-dx'], '0px');
  assert.equal(dom.rafCount(), 0, 'and no rAF is ever requested in fallback');
});

test('REDUCED: detachPair declines entirely — the resting layout IS the design', () => {
  const { fx, dom } = loadFxGoo(true);
  const { host, field, btn } = makePair();
  assert.equal(fx.detachPair(field, btn), null);
  assert.equal(host.findByClass('fxgoo-sil'), null);
  assert.equal(field.listeners.focus, undefined, 'no listeners are even bound');
  assert.equal(dom.rafCount(), 0);
});

test('detach() tears the pair down completely: nodes, listeners, classes, properties', () => {
  const { fx, dom } = loadFxGoo(false);
  const { host, field, btn } = makePair();
  fx.detachPair(field, btn);
  field.fire('focus');
  dom.pumpUntilIdle();
  fx.detach(field);
  assert.equal(host.findByClass('fxgoo-sil'), null);
  assert.ok(!field.cls.has('fxgoo-pair-item') && !btn.cls.has('fxgoo-pair-item'));
  assert.equal(field.style['--fxgoo-dx'], undefined, 'the custom property is removed');
  assert.equal(btn.style['--fxgoo-dx'], undefined);
  assert.equal((field.listeners.focus ?? []).length + (field.listeners.blur ?? []).length, 0,
    'focus/blur listeners are off');
});

/* ══════════════════════ bend, math and lifecycle ══════════════════════ */

test('bendPath golden: the K=0.5523 cubics and cap deformation reproduce the library frame', () => {
  const { fx } = loadFxGoo();
  assert.equal(
    fx.bendPath(160, 36, 10, 4, 2),
    'M 13.2 0 Q 80 8 151.6 0 C 156.2 0 160 4.5 160 10 L 160 26 C 160 31.5 156.2 36 151.6 36 ' +
    'Q 80 44 13.2 36 C 5.9 36 0 31.5 0 26 L 0 10 C 0 4.5 5.9 0 13.2 0 Z',
    'bendY 4 sags both long edges by 8 (control 2b); bendX 2 blunts the leading cap to 8.4 and stretches the trailing to 13.2'
  );
  assert.equal(
    fx.bendPath(160, 36, 10, 0, 0),
    'M 10 0 Q 80 0 150 0 C 155.5 0 160 4.5 160 10 L 160 26 C 160 31.5 155.5 36 150 36 ' +
    'Q 80 36 10 36 C 4.5 36 0 31.5 0 26 L 0 10 C 0 4.5 4.5 0 10 0 Z',
    'zero bend is a plain rounded rect drawn with the same cubics'
  );
  assert.equal(fx.bendPath(160, 36, 10, 4, 2), fx.bendPath(160, 36, 10, 4, 2), 'deterministic');
  assert.deepEqual(fx.BEND, { vertical: 0.6, horizontal: 0.35 }, 'BendTuning defaults survived the port');
});

test('bend lifecycle: pull leans body and content, release settles flat and self-destroys', () => {
  const { fx, dom } = loadFxGoo(false);
  const tile = new StubNode('div');
  tile.offsetLeft = 0; tile.offsetTop = 0; tile.offsetWidth = 160; tile.offsetHeight = 36;
  assert.ok(fx.bendAttach(tile), 'attach returns a live state');
  assert.ok(fx.bendAttach(tile), 'and is idempotent');
  const sil = tile.findByClass('fxgoo-sil')!;
  assert.ok(sil.cls.has('fxgoo-sil-bend'));
  assert.ok(tile.cls.has('fxgoo-bending'), 'the content-lean scope class is on');
  const pathEl = sil.children.find((c) => c.tag === 'g')!.children.find((c) => c.tag === 'path')!;
  fx.bendPull(tile, 1, 1);
  dom.pump(); dom.pump(); dom.pump();
  assert.ok(parseFloat(tile.style['--lg-bend-y']) > 0.5, `the vertical bend var is live (${tile.style['--lg-bend-y']})`);
  assert.ok(parseFloat(tile.style['--lg-bend-x']) > 0, 'so is the horizontal one');
  assert.equal(tile.style['--lg-bend-yn'], String(parseFloat(tile.style['--lg-bend-y'])), 'unitless twin matches');
  assert.match(pathEl.attrs.d, /Q 80 [1-9]/, 'the silhouette body actually arcs');
  fx.bendRelease(tile);
  dom.pumpUntilIdle();
  assert.equal(tile.findByClass('fxgoo-sil'), null, 'release settles flat and tears the goo down by itself');
  assert.ok(!tile.cls.has('fxgoo-bending'));
  assert.equal(tile.style['--lg-bend-x'], undefined, 'every published var is removed');
  assert.equal(tile.style['--lg-bend-y'], undefined);
  assert.equal(dom.queued(), 0, 'nothing left running');
  assert.ok(fx.bendAttach(tile), 'and the tile can bend again on the next hover');
});

test('REDUCED: bendAttach declines — a still tile is the reduced design', () => {
  const { fx, dom } = loadFxGoo(true);
  const tile = new StubNode('div');
  assert.equal(fx.bendAttach(tile), null);
  fx.bendPull(tile, 1, 1); // must be a harmless no-op
  fx.bendRelease(tile);
  assert.equal(tile.findByClass('fxgoo-sil'), null);
  assert.equal(dom.rafCount(), 0);
});

/* ══════════════════════ Contract, structurally ══════════════════════ */

test('the section honors the frontend contract: REDUCED gates, no fetch, no innerHTML', () => {
  const gates = SRC.match(/if \(REDUCED\)/g) ?? [];
  assert.ok(gates.length >= 3, `every animation entry point checks REDUCED (found ${gates.length} gates)`);
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'network calls only via api() — the section makes none');
  assert.ok(!SRC.includes('innerHTML'), 'nodes are built with createElement(NS), never markup strings');
  assert.ok(!/\bid="/.test(SRC), 'no static element ids — filter ids are counter-generated');
  assert.match(SRC, /'fxgoo-f' \+ \(\+\+uid\)/, 'unique per-control filter ids');
});

test('the tail is the library droplet: laggy 170/22 chase, force-clamped lag, onset ramp', () => {
  assert.match(SRC, /springSteps\(st\.tailX, st\.tailVx, cx, 170, 22/, 'the tail spring survived the port');
  // The clamp now reads the per-instance tuning (mv), whose default is
  // pinned to MOVE below — same formula, same numbers by default.
  assert.match(SRC, /0\.2 \+ mv\.force \* 1\.6/, 'the tongue-reach clamp survived');
  assert.match(SRC, /targetR = base \* mv\.tail \* onset/, 'and the tail-size fraction beside it');
  assert.match(SRC, /\(speed - 20\) \/ 120/, 'the onset ramp keeps micro-jitters from popping the tail in');
  assert.match(SRC, /stiffness: 380,\s*damping: 18/, 'MOVE_DEFAULTS 380/18 drive the slider chase');
  assert.match(SRC, /force: c01\(t && t\.force, MOVE\.force\)/, 'untuned instances resolve force straight to MOVE');
});
