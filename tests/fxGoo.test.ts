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

class StubNode {
  tag: string;
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parentNode: StubNode | null = null;
  style: Record<string, string> = {};
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

interface FxGooApi {
  segThumb: (el: StubNode) => Record<string, unknown> | null;
  slider: (el: StubNode) => Record<string, unknown> | null;
  spring: (from: number, to: number, cfg: unknown, onFrame: (v: number, done: boolean) => void) =>
    { value: number; done: boolean; stop: () => void; retarget: (t: number) => void };
  detach: (el: StubNode) => void;
  simulate: (cfg: unknown) => { duration: number; values: number[]; peak: number; overshoots: boolean };
  compileLinear: (cfg: unknown) => { duration: number; easing: string };
  presets: Record<string, { stiffness: number; damping: number; mass: number }>;
  SEG_SPRING: { stiffness: number; damping: number; mass: number };
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
  assert.match(SRC, /0\.2 \+ MOVE\.force \* 1\.6/, 'the tongue-reach clamp survived');
  assert.match(SRC, /\(speed - 20\) \/ 120/, 'the onset ramp keeps micro-jitters from popping the tail in');
  assert.match(SRC, /stiffness: 380,\s*damping: 18/, 'MOVE_DEFAULTS 380/18 drive the slider chase');
});
