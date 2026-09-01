import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The beams round — every NEW border-beam pairs with a real state and every
 * exit door switches it off, following tests/fxWiring.test.ts.
 *
 * Two halves again. The hover-ambience / state-ownership arbitration and the
 * small sync helpers (pills, hunt cards, one-shots) are extracted and
 * EXECUTED with stub namespaces, because "hover never fights a state beam"
 * and "the one-shot fires once per crossing" are behaviour. The call-site
 * pairings — which app funnel lights which beam, and that every door out of
 * that state switches it off — are structural containment checks, because
 * the classic regression keeps the glow and drops the teardown.
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

/** A slice of the app between two exact anchors — containment checks only. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/* ══════════════ The harness: wiring section, executed ══════════════ */

type FakeEl = {
  nodeType: number; className: string; children: FakeEl[];
  parentNode: FakeEl | null; isConnected: boolean;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  appendChild(c: FakeEl): FakeEl; remove(): void;
  addEventListener(name: string, fn: (...args: unknown[]) => void): void;
  setAttribute(name: string, v: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  closest(sel: string): FakeEl | null;
  querySelector(sel: string): FakeEl | null;
};

function fakeEl(className = ''): FakeEl {
  const matches = (el: FakeEl, sel: string) =>
    sel.replace(/^\./, '').split('.').every((c) => el.className.split(/\s+/).includes(c));
  const el: FakeEl = {
    nodeType: 1, className, children: [], parentNode: null, isConnected: true,
    attrs: {}, listeners: {},
    appendChild(c) { c.parentNode = el; c.isConnected = true; el.children.push(c); return c; },
    remove() {
      if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el);
      el.parentNode = null; el.isConnected = false;
    },
    addEventListener(name, fn) { (el.listeners[name] ??= []).push(fn); },
    setAttribute(name, v) { el.attrs[name] = v; },
    removeAttribute(name) { delete el.attrs[name]; },
    hasAttribute(name) { return name in el.attrs; },
    closest(sel) {
      let cur: FakeEl | null = el;
      while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentNode; }
      return null;
    },
    querySelector(sel) {
      const walk = (n: FakeEl): FakeEl | null => {
        for (const c of n.children) {
          if (matches(c, sel)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
  };
  return el;
}

type BeamCall = { kind: 'attach' | 'detach'; el: FakeEl; opts?: Record<string, unknown> };
type Timer = { id: number; fn: () => void; ms: number; cleared: boolean; fired: boolean };

type Harness = {
  fx: {
    fxStateBeam: (el: FakeEl | null, opts: Record<string, unknown>) => void;
    fxStateBeamDrop: (el: FakeEl | null) => void;
    fxHoverSync: (card: FakeEl | null) => void;
    fxTmPillBeamsSync: (visible?: boolean) => void;
    fxHuntBeamSync: (hostId: string, on: boolean) => void;
    fxGoalPulseSync: (met: boolean | null) => void;
    fxScanDonePulse: () => void;
  };
  els: Record<string, FakeEl>;
  beamCalls: BeamCall[];
  timers: Timer[];
  state: {
    scanning: boolean; root: unknown; view: string;
    live: { on: boolean }; lens: { pinned: boolean };
    treemap: { lapse: { loop: boolean }; history: { diff: boolean }; hideCloud: boolean };
  };
  fireTimers(): void;
};

function makeHarness(): Harness {
  const els: Harness['els'] = {};
  const beamCalls: BeamCall[] = [];
  const timers: Timer[] = [];
  let timerSeq = 0;
  const state: Harness['state'] = {
    scanning: false, root: null, view: 'treemap',
    live: { on: false }, lens: { pinned: false },
    treemap: { lapse: { loop: false }, history: { diff: false }, hideCloud: false },
  };
  const $ = (id: string) => (els[id] ??= fakeEl());
  const FxOrbs = { mount: () => ({ setState() {}, destroy() {} }) };
  const FxBeam = {
    attach(el: FakeEl, opts: Record<string, unknown>) { beamCalls.push({ kind: 'attach', el, opts }); return el; },
    detach(el: FakeEl) { beamCalls.push({ kind: 'detach', el }); },
  };
  const documentStub = { createElement: () => fakeEl(), addEventListener: () => {} };
  const src = wiringSection();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fx = new Function(
    'FxOrbs', 'FxBeam', '$', 'document', 'state', 'setTimeout', 'clearTimeout',
    `'use strict'; ${src}
     return { fxStateBeam, fxStateBeamDrop, fxHoverSync, fxTmPillBeamsSync, fxHuntBeamSync, fxGoalPulseSync, fxScanDonePulse };`,
  )(
    FxOrbs, FxBeam, $, documentStub, state,
    (fn: () => void, ms: number) => { const t: Timer = { id: ++timerSeq, fn, ms, cleared: false, fired: false }; timers.push(t); return t.id; },
    (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
  ) as Harness['fx'];
  const fireTimers = () => {
    for (const t of timers) {
      if (!t.cleared && !t.fired) { t.fired = true; t.fn(); }
    }
  };
  return { fx, els, beamCalls, timers, state, fireTimers };
}

const attaches = (h: Harness, el: FakeEl) => h.beamCalls.filter((c) => c.kind === 'attach' && c.el === el);
const detaches = (h: Harness, el: FakeEl) => h.beamCalls.filter((c) => c.kind === 'detach' && c.el === el);

/* ══════════════ Hover ambience, as behaviour ══════════════ */

test('hover: a quiet md ring, one card at a time, detached after the leave-fade', () => {
  const h = makeHarness();
  const a = fakeEl('card glass');
  const b = fakeEl('card glass');
  h.fx.fxHoverSync(a);
  assert.equal(attaches(h, a).length, 1, 'enter lights the card');
  assert.deepEqual(attaches(h, a)[0].opts,
    { type: 'md', active: true, strength: 0.5, brightness: 0.9, staticColors: true, bloom: false },
    'quiet: half strength, dimmed, and neither of the two per-frame layers — full brightness and the bloom stay reserved for real states');
  h.fx.fxHoverSync(a);
  assert.equal(h.beamCalls.length, 1, 'staying on the card re-attaches nothing');
  h.fx.fxHoverSync(b);
  assert.deepEqual(attaches(h, a)[1].opts, { type: 'md', active: false }, 'moving on fades the old card');
  assert.equal(attaches(h, b).length, 1, 'and lights the new one — never two at once');
  h.fx.fxHoverSync(null);
  assert.deepEqual(attaches(h, b)[1].opts, { type: 'md', active: false }, 'leaving all cards fades the last');
  h.fireTimers();
  assert.equal(detaches(h, a).length, 1, 'the fade timer detaches — a transient card never strands a stylesheet');
  assert.equal(detaches(h, b).length, 1);
});

test('hover: re-entering during the fade cancels the detach and re-lights the same instance', () => {
  const h = makeHarness();
  const a = fakeEl('card glass');
  h.fx.fxHoverSync(a);
  h.fx.fxHoverSync(null);
  assert.equal(h.timers.filter((t) => !t.cleared).length, 1, 'the leave armed a detach');
  h.fx.fxHoverSync(a);
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0, 're-entry disarmed it');
  h.fireTimers();
  assert.equal(detaches(h, a).length, 0, 'no detach ever fires on the re-entered card');
  assert.equal(attaches(h, a).length, 3, 'on, off, on again — through the one instance');
});

test('hover defers to state: a stamped card is skipped, and a state igniting mid-hover takes the host over', () => {
  const h = makeHarness();
  const card = fakeEl('card glass');
  // A state already owns it: hover must not touch it at all.
  h.fx.fxStateBeam(card, { type: 'md', active: true });
  const before = h.beamCalls.length;
  h.fx.fxHoverSync(card);
  assert.equal(h.beamCalls.length, before, 'a data-fxbeam-state card gets no hover attach');
  // Release, hover it, then let the state ignite mid-hover.
  h.fx.fxStateBeam(card, { type: 'md', active: false });
  h.fx.fxHoverSync(card);
  h.fx.fxStateBeam(card, { type: 'md', active: true });
  const during = h.beamCalls.length;
  h.fx.fxHoverSync(null);
  assert.equal(h.beamCalls.length, during, 'the takeover made the later hover-leave a no-op — the state ring survives');
  h.fireTimers();
  assert.equal(detaches(h, card).length, 0, 'and no stale hover timer detaches the state’s instance');
});

test('the one-beam envelope: ambience never blooms, and stands down the moment ANY state beam lights', () => {
  const h = makeHarness();
  const parked = fakeEl('card glass');
  const scanCard = fakeEl('card glass');
  const other = fakeEl('card glass');
  h.fx.fxHoverSync(parked);
  const amb = attaches(h, parked)[0].opts!;
  assert.equal(amb.bloom, false, 'the ambience ring carries no blurred conic layer');
  assert.equal(amb.staticColors, true, 'and no per-frame hue drift — nothing rasters while it rests');
  // A scan lights the scan card. The ring parked under the pointer is a
  // DIFFERENT card, so nothing in the per-card arbitration would touch it.
  h.fx.fxStateBeam(scanCard, { type: 'md', active: true });
  assert.equal(detaches(h, parked).length, 1,
    'the parked ring goes out at once — not a 500ms fade rastering beside the state beam');
  const during = h.beamCalls.length;
  h.fx.fxHoverSync(other);
  h.fx.fxHoverSync(parked);
  h.fx.fxHoverSync(other);
  assert.equal(h.beamCalls.length, during,
    'and a pointer sweeping the dashboard mid-scan lights nothing at all');
  h.fireTimers();
  assert.equal(detaches(h, scanCard).length, 0, 'no stray hover timer touches the state ring');
  // The state ends: ambience is available again.
  h.fx.fxStateBeam(scanCard, { type: 'md', active: false });
  h.fx.fxHoverSync(other);
  assert.equal(attaches(h, other).length, 1, 'with nothing lit, the pointer gets its quiet ring back');
});

test('hover: a state igniting during the leave-fade disarms the pending detach', () => {
  const h = makeHarness();
  const card = fakeEl('card glass');
  h.fx.fxHoverSync(card);
  h.fx.fxHoverSync(null); // fade begins, detach armed
  h.fx.fxStateBeam(card, { type: 'md', active: true }); // the scan starts inside the 900ms window
  h.fireTimers();
  assert.equal(detaches(h, card).length, 0, 'the armed detach never kills the state’s ring');
});

/**
 * The same hazard, defended twice: fxStateBeam clears the pending timer, and
 * the timer itself re-checks the stamp before detaching. The test above only
 * ever exercises the FIRST — the timer is cleared, so its body is dead code
 * there, and deleting the in-timer check kept the suite green. This reaches
 * the timer with the stamp already set, which is what happens whenever a
 * state lands on the card through a path that did not go via fxStateBeam.
 */
test('hover: the leave-fade timer itself refuses to detach a card a state now owns', () => {
  const h = makeHarness();
  const card = fakeEl('card glass');
  h.fx.fxHoverSync(card);
  h.fx.fxHoverSync(null);
  assert.equal(h.timers.filter((t) => !t.cleared).length, 1, 'the leave armed a detach');
  card.setAttribute('data-fxbeam-state', ''); // ownership taken without touching the hover bookkeeping
  h.fireTimers();
  assert.ok(h.timers.every((t) => t.fired || t.cleared), 'the timer really ran');
  assert.equal(detaches(h, card).length, 0,
    'a fired timer must still check ownership — detaching here would strip a live state ring');
});

test('fxStateBeamDrop detaches and clears the stamp — the transient-card off door', () => {
  const h = makeHarness();
  const card = fakeEl('card glass dup-progress');
  h.fx.fxStateBeam(card, { type: 'md', active: true });
  assert.ok(card.hasAttribute('data-fxbeam-state'), 'active stamps ownership');
  h.fx.fxStateBeamDrop(card);
  assert.ok(!card.hasAttribute('data-fxbeam-state'), 'the drop releases it');
  assert.equal(detaches(h, card).length, 1, 'and detaches rather than fades — the card is about to be destroyed');
  h.fx.fxStateBeamDrop(null);
  h.fx.fxStateBeam(null, { type: 'md', active: true });
  assert.equal(h.beamCalls.length, 2, 'both are null-safe');
});

/* ══════════════ The pills and hunt cards, as behaviour ══════════════ */

test('the pill sync reads all five mode states and `visible:false` is the all-off door', () => {
  const h = makeHarness();
  h.state.live.on = true;
  h.state.treemap.history.diff = true;
  h.fx.fxTmPillBeamsSync();
  const on = new Map(h.beamCalls.map((c) => [c.el, c.opts] as const));
  assert.equal(on.size, 5, 'all five pills are synced');
  assert.equal(on.get(h.els.tmLiveToggle)?.active, true, 'Live watches → ring on');
  assert.equal(on.get(h.els.tmDiffToggle)?.active, true, 'Diff enabled → ring on');
  assert.equal(on.get(h.els.tmLensToggle)?.active, false, 'Lens unpinned → off');
  assert.equal(on.get(h.els.tmLapseLoop)?.active, false);
  assert.equal(on.get(h.els.tmCloudToggle)?.active, false);
  for (const c of h.beamCalls) {
    assert.equal(c.opts?.type, 'sm', 'the never-used compact ring, at pill scale');
    assert.equal(c.opts?.strength, 0.7, 'a persistent mode is quieter than an activity');
  }
  h.beamCalls.length = 0;
  h.fx.fxTmPillBeamsSync(false);
  assert.ok(h.beamCalls.every((c) => c.opts?.active === false), 'unmount (visible=false) switches every ring off');
  h.beamCalls.length = 0;
  h.state.view = 'dashboard';
  h.fx.fxTmPillBeamsSync();
  assert.ok(h.beamCalls.every((c) => c.opts?.active === false), 'away from the treemap the default is off too');
});

test('the hunt beam lives on the transient progress card and vanishes with it', () => {
  const h = makeHarness();
  const body = h.els.dupBody = fakeEl();
  h.fx.fxHuntBeamSync('dupBody', true);
  assert.equal(h.beamCalls.length, 0, 'no progress card, nothing to light');
  const card = body.appendChild(fakeEl('card glass dup-progress'));
  h.fx.fxHuntBeamSync('dupBody', true);
  assert.deepEqual(attaches(h, card)[0].opts, { type: 'md', active: true }, 'the hunt lights its card at full strength');
  assert.ok(card.hasAttribute('data-fxbeam-state'), 'stamped — hover keeps its hands off');
  h.fx.fxHuntBeamSync('dupBody', false);
  assert.equal(detaches(h, card).length, 1, 'the off door detaches — the next innerHTML rewrite strands nothing');
});

/* ══════════════ The one-shots, as behaviour ══════════════ */

test('the goal pulse fires once per crossing, never on a restore, and resets with the meter', () => {
  const h = makeHarness();
  h.fx.fxGoalPulseSync(true); // boot restore of an already-met target
  assert.equal(h.beamCalls.length, 0, 'already-met at first sight is not a crossing');
  h.fx.fxGoalPulseSync(null); // target cleared, meter hidden
  h.fx.fxGoalPulseSync(false);
  h.fx.fxGoalPulseSync(true);
  assert.equal(h.beamCalls.length, 1, 'the below→met edge pulses');
  const opts = h.beamCalls[0].opts!;
  assert.equal(opts.type, 'pulse-outside');
  assert.equal(opts.active, true);
  assert.equal(opts.strength, 0.55, 'subtle — §4.1: a notice, not a reward');
  assert.equal(opts.borderRadius, 10, 'the meter row has no corner radius of its own to measure');
  h.fx.fxGoalPulseSync(true);
  h.fx.fxGoalPulseSync(true);
  assert.equal(h.beamCalls.length, 1, 'staying met never re-pulses');
  h.fireTimers();
  assert.equal(h.beamCalls[1].opts?.active, false, 'the pulse switches itself off');
  h.fx.fxGoalPulseSync(false);
  h.fx.fxGoalPulseSync(true);
  assert.equal(h.beamCalls.filter((c) => c.opts?.active === true).length, 2, 'a genuine re-crossing pulses again');
});

/**
 * What the `met === null` reset is actually FOR. The sequence above walks
 * null → false → true, where the false re-seeds the memory either way — so
 * deleting the reset changed nothing and the suite stayed green. The real
 * hazard is below → target cleared → a NEW target that is already met: with
 * the reset the memory is unknown and nothing pulses, without it the stale
 * `false` reads the new target as a crossing the user just caused.
 */
test('clearing the target forgets the old one — a fresh already-met target is not a crossing', () => {
  const h = makeHarness();
  h.fx.fxGoalPulseSync(false); // a target is set and the cart is under it
  h.fx.fxGoalPulseSync(null);  // the user clears the target; the meter hides
  h.fx.fxGoalPulseSync(true);  // a new, smaller target that the cart already exceeds
  assert.equal(h.beamCalls.length, 0,
    'the cart did not move — nothing was crossed, so nothing pulses');
  // And the memory really is unknown, not stuck: crossing from below still works.
  h.fx.fxGoalPulseSync(false);
  h.fx.fxGoalPulseSync(true);
  assert.equal(h.beamCalls.filter((c) => c.opts?.active === true).length, 1,
    'a real below→met edge after the reset still pulses');
});

test('the scan-done pulse is one timed pulse that defers to a scan already running again', () => {
  const h = makeHarness();
  const card = fakeEl('card glass');
  h.els.scanStatus = fakeEl();
  card.appendChild(h.els.scanStatus);
  h.fx.fxScanDonePulse();
  assert.deepEqual(attaches(h, card)[0].opts, { type: 'pulse-outside', active: true, strength: 0.5 });
  assert.ok(card.hasAttribute('data-fxbeam-state'), 'the pulse owns the card while it plays');
  h.state.scanning = true; // a new scan started inside the 2s window
  h.fireTimers();
  assert.equal(attaches(h, card).length, 1, 'the off-timer yields — beginScanChrome’s md ring owns the card now');
  h.state.scanning = false;
  h.fx.fxScanDonePulse();
  h.fireTimers();
  assert.equal(attaches(h, card).at(-1)?.opts?.active, false, 'idle, the off-timer ends the pulse');
});

/* ══════════════ Every activation has its deactivation — structurally ══════════════ */

test('hover wiring: pointer-fine gated pointerover, a window-exit pointerout, and the two pointer-less doors', () => {
  const wiring = wiringSection();
  assert.match(wiring, /matchMedia\('\(pointer: fine\)'\)/, 'touch devices get no hover states');
  assert.match(wiring, /document\.addEventListener\('pointerover'/, 'delegated — lazy, one listener, dynamic cards included');
  assert.match(wiring, /closest \? t\.closest\('\.card\.glass'\) : null/, 'every glass card, resolved per event');
  assert.match(wiring, /document\.addEventListener\('pointerout'[\s\S]{0,120}!e\.relatedTarget[\s\S]{0,40}fxHoverSync\(null\)/,
    'leaving the window clears the ring');
  const sv = slice('function switchView(', 'function renderCapabilityNotice(');
  assert.match(sv, /fxHoverSync\(null\)/, 'a keyboard view switch clears it too');
  const cm = slice('function closeModal(', 'document.querySelectorAll(\'[data-close]\')');
  assert.match(cm, /fxHoverSync\(null\)/, 'and so does closing a modal over a hovered card');
});

test('every pill funnel re-syncs the rings, and the treemap mount/unmount are the shared doors', () => {
  assert.match(slice('function enableLive(', 'function disableLive('), /fxTmPillBeamsSync\(\)/, 'Live on');
  assert.match(slice('function disableLive(', "$('tmLiveToggle').addEventListener"), /fxTmPillBeamsSync\(\)/, 'Live off — every live exit funnels here');
  assert.match(slice('function lensSetPinned(', 'function setTreemapView('), /fxTmPillBeamsSync\(\)/, 'Lens pin/unpin');
  assert.match(slice('function lapseReflect(', 'function lapseStop('), /fxTmPillBeamsSync\(\)/, 'Loop, via the transport’s one reflect');
  assert.match(slice("$('tmDiffToggle').addEventListener", 'const LIVE_PULSE_MS'), /fxTmPillBeamsSync\(\)/, 'Diff toggle');
  assert.match(slice("$('tmCloudToggle').addEventListener", 'const TM_COLOR_MODES'), /fxTmPillBeamsSync\(\)/, 'Hide-cloud toggle');
  assert.match(slice("const ct = $('tmCloudToggle');", "const en = $('engineRow');"), /fxTmPillBeamsSync\(\)/,
    'the no-cloud-files reset flips hideCloud outside its toggle and must re-sync');
  const tmView = slice("id: 'treemap'", "id: 'grid'");
  assert.match(tmView, /fxTmPillBeamsSync\(true\)/, 'mount re-lights persisted modes');
  assert.match(tmView, /fxTmPillBeamsSync\(false\)/, 'unmount is the explicit all-off door');
});

test('the WebM export restores Loop through lapseReflect, so pill class and ring cannot drift', () => {
  const webm = slice('async function exportTimelapseWebm(', 'function exportTreemapPNG(');
  assert.match(webm, /L\.loop = prevLoop;[\s\S]{0,300}lapseReflect\(\);/,
    'the restore reflects — before this round it silently left the pill claiming Off');
});

test('the offload/restore job ring: on with the modal, off in closeModal — the funnel every close reaches', () => {
  const job = slice('function watchJob(', 'function watchOffloadJob(');
  // The strip, not the .modal: a .modal is a Liquid Glass host whose entire
  // fill is .lg::before, and the beam writes that pseudo-element itself.
  assert.match(job, /\$\('offloadModal'\)\.classList\.add\('open'\);[\s\S]{0,600}FxBeam\.attach\(\$\('offloadBeamStrip'\), \{ type: 'md', active: true \}\)/,
    'the ring lights with the sheet');
  assert.match(INDEX, /<span class="fx-beam-strip" id="offloadBeamStrip" aria-hidden="true"><\/span>/,
    'the beam-only child exists inside the sheet');
  const cm = slice('function closeModal(', 'document.querySelectorAll(\'[data-close]\')');
  // The branch, not one exact line: what matters is that the off-switch lives
  // inside closeModal's offloadModal arm, which done(), the scrim and Esc all
  // reach. The arm grew a second statement (a dismissal mid-job now says the
  // job is still running) and a pin on the character sequence failed for a
  // change that cannot affect the beam at all.
  const arm = cm.slice(cm.indexOf("if (id === 'offloadModal')"));
  assert.ok(arm, 'closeModal has an offloadModal arm');
  assert.match(arm, /FxBeam\.attach\(\$\('offloadBeamStrip'\), \{ type: 'md', active: false \}\)/,
    'done(), the scrim and Esc all pass through here');
  assert.match(job, /const done = \(\) => \{ es\.close\(\); activeJob = null; closeModal\('offloadModal'\); \}/,
    'done() still funnels through closeModal — the off door is not bypassed');
});

test('the duplicate hunt ring rides exactly the orb’s four doors', () => {
  const load = slice('async function loadDuplicates(', 'function renderDuplicates(');
  assert.match(load, /fxHuntBeamSync\('dupBody', true\)/, 'on with the progress card');
  const offs = (load.match(/fxHuntBeamSync\('dupBody', false\)/g) || []).length;
  assert.equal(offs, 3, `re-entry, settle and error all drop it (found ${offs})`);
  assert.match(slice("id: 'duplicates'", "id: 'trends'"), /fxHuntBeamSync\('dupBody', false\)/,
    'and the view’s unmount is the fourth door');
});

test('the compare ring: on with Comparing…, dropped on both settles, the error, and the history unmount', () => {
  const run = slice("$('cmpRunBtn').addEventListener", 'async function initCmpSplit(');
  assert.match(run, /fxHuntBeamSync\('cmpBody', true\)/, 'on with the progress card');
  const offs = (run.match(/fxHuntBeamSync\('cmpBody', false\)/g) || []).length;
  assert.equal(offs, 3, `both render branches and the catch drop it (found ${offs})`);
  assert.match(slice("id: 'history',", 'Disk journal'), /fxHuntBeamSync\('cmpBody', false\)/,
    'a mid-compare exit from the view detaches the hidden card’s ring');
});

test('the export button’s sm ring rides the exact lapseExporting pair in both exporters', () => {
  const gif = slice('async function exportTimelapseGif(', 'async function exportTimelapseWebm(');
  const webm = slice('async function exportTimelapseWebm(', 'function exportTreemapPNG(');
  for (const [name, src] of [['gif', gif], ['webm', webm]] as const) {
    assert.match(src, /fxOrbShow\('export',[\s\S]{0,120}FxBeam\.attach\(\$\('tmExportBtn'\), \{ type: 'sm', active: true \}\)/,
      `${name}: the ring lights beside the composing orb`);
    assert.match(src, /fxOrbHide\('export'\);[\s\S]{0,120}FxBeam\.attach\(\$\('tmExportBtn'\), \{ type: 'sm', active: false \}\)/,
      `${name}: the finally that drops the orb drops the ring`);
  }
});

test('the completion pulse rides finishScan’s scanId gate — never the instant paint, never a failure', () => {
  const finish = slice('async function finishScan(', 'void loadWhatsNew();');
  assert.match(finish, /if \(state\.scanId\) \{\s*toast\(`Scan complete[\s\S]{0,200}fxScanDonePulse\(\);/,
    'one crossing, one pulse — the same gate as the one completion toast');
  const fail = slice('function failScan(', 'function statsFromResult(');
  assert.doesNotMatch(fail, /fxScanDonePulse/, 'a failed scan celebrates nothing');
});

test('renderCartGoal owns the goal pulse: met feeds it, and a hidden meter resets the seed', () => {
  const fn = slice('function renderCartGoal(', 'async function renderCart(');
  // …and it is read as UNKNOWN until a scan can resolve the cart's sizes: a
  // staged total of 0 before any scan is an artefact, not "below target", and
  // seeding the one-shot off it made a plain boot restore look like a crossing.
  assert.match(fn, /fxGoalPulseSync\(state\.scanId \? met : null\)/, 'the crossing is read where met is computed');
  assert.match(fn, /host\.hidden = true; fxGoalPulseSync\(null\);/, 'no target → no meter → no seed');
  assert.equal((INDEX.match(/fxGoalPulseSync\(/g) || []).length, 3,
    'the definition and exactly the two render-funnel call sites — no other caller may seed it');
});

test('scan chrome routes its card ring through fxStateBeam — hover must never fight a running scan', () => {
  const begin = slice('function beginScanChrome(', 'function endScanChrome(');
  const end = slice('function endScanChrome(', 'function failScan(');
  assert.match(begin, /fxStateBeam\(\$\('scanStatus'\)\.closest\('\.card'\), \{ type: 'md', active: true \}\)/);
  assert.match(end, /fxStateBeam\(\$\('scanStatus'\)\.closest\('\.card'\), \{ type: 'md', active: false \}\)/);
});
