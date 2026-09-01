import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Two owner reports from the same afternoon: "the slider is very glitchy and
 * the UI breaks", and "hover is slow — I need the app to be blazing fast".
 * Both were reproduced against the built page and measured before anything
 * was changed; each test below pins the invariant whose absence produced the
 * number next to it.
 *
 * ── The scrubber ──
 * `#tmTimeLabel` reads "Live" until the first `input` event of a drag, when it
 * becomes "Sep 30, 10:31 PM · 1023.9 GB". Measured in the built page: the
 * label went 23px → 174px, so the range input beside it (flex: 1 1 140px)
 * went 558px → 407px — the TRACK SHRANK BY 27% UNDER THE CURSOR on the first
 * pixel of a drag, so the same pointer x mapped to a different value and the
 * thumb jumped. At a 640px bar the row also wrapped (46px → 84px tall), which
 * shoved the whole treemap down mid-drag. The Liquid Goo trail's
 * ResizeObserver then saw the input resize and snapped its simulation, so
 * the trail teleported too. One cause, three symptoms. The floor below is
 * what stops the row re-flowing: the label may not change width between
 * "Live" and the longest string it can show.
 *
 * ── Hover ──
 * The JS on the hover path is cheap (showTooltip measured at ~0.2ms), which
 * leaves the compositor. `#tooltip` was a full Liquid Glass lens: a
 * position:fixed card carrying `backdrop-filter: url(#lg-f-N) …` — an SVG
 * displacement-map REFERENCE filter — while following the pointer every
 * frame, plus a 4.6ms displacement-map rebuild (measured) each time its size
 * crossed an 8px bucket. A reference filter in backdrop-filter is rasterised
 * against the moving backdrop on every frame; plain blur() is the
 * accelerated path. The tooltip keeps its frost and loses the lens.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The declarations of one rule, from a selector anchor to its closing brace. */
function decls(selectorAnchor: string): string {
  const start = INDEX.indexOf(selectorAnchor);
  assert.notEqual(start, -1, `rule "${selectorAnchor}" exists in index.html`);
  const open = INDEX.indexOf('{', start);
  const close = INDEX.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `rule "${selectorAnchor}" closes`);
  return INDEX.slice(open + 1, close);
}

/** A brace-matched block from an anchor that precedes its opening brace. */
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

/* ═══════════════════════ the scrubber's label ═══════════════════════ */

test('the time label reserves the width of its longest string, so the track never resizes mid-drag', () => {
  const label = decls('.tm-timebar .tm-timelabel');
  // The same format updateTimeLabel uses, on the widest date and byte count
  // the app can print: two-digit day, 12-hour clock with a meridiem, and the
  // largest value formatBytes emits before it rolls to the next unit.
  const widestDate = new Date(2026, 8, 30, 22, 31).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const longest = `${widestDate} · 1023.9 GB`;
  const floor = /min-width:\s*(\d+(?:\.\d+)?)ch/.exec(label);
  assert.ok(floor, `the label declares a floor in ch (it is tabular, so ch tracks its own digits) — ${label.trim()}`);
  // Letters and punctuation are narrower than digits: measured in the built
  // page, this 28-character string is 174px at 7.6px per ch — 0.82ch per
  // character — and a 23ch floor was still unstable at a 640px bar. 0.85
  // keeps a margin over that ratio, so a floor that lets a long month plus a
  // large size grow the label (and shrink the track again) fails here.
  assert.ok(Number(floor![1]) >= Math.ceil(longest.length * 0.85),
    `floor ${floor![1]}ch must cover "${longest}" (${longest.length} chars ≈ ${Math.ceil(longest.length * 0.85)}ch)`);
  assert.doesNotMatch(label, /min-width:\s*\d+px/, 'a px reservation would not scale with the label font');
  // A floor is only a floor if the item cannot be shrunk below it by its
  // siblings: flex-shrink must be 0.
  assert.match(label, /flex:\s*(?:none|0\s+0\s+auto)/, 'the label neither grows nor shrinks — the scrubber does');
});

/* ═══════════════════════ the scrubber's input handler ═══════════════════════ */

test('a scrub does not stop a transport that is not running', () => {
  // lapseStop() → lapseReflect() → fxTmPillBeamsSync() re-attaches FIVE beam
  // instances (each a config normalise + sheet rebuild) and rewrites four
  // aria-selected attributes that wake the speed seg's goo observer — per
  // input event, at pointer rate, when nothing was playing. Measured at half
  // the handler's cost. Stopping is for a transport that is running, or one
  // an export is waiting on (onDone), which is the one case the slider must
  // still end honestly.
  const handler = braced("$('tmTimeSlider').addEventListener('input'");
  assert.doesNotMatch(handler, /^\s*lapseStop\(\);/m, 'lapseStop() must not run unconditionally');
  assert.match(handler, /if\s*\(\s*L\.playing\s*\|\|\s*L\.onDone\s*\)\s*lapseStop\(\)/,
    'stop only when playing, or when an export is listening for the end');
});

/* ═══════════════════════ the hover path ═══════════════════════ */

test('a same-node frame moves the tooltip; only a node change rebuilds it', () => {
  const move = braced('function moveTooltip(');
  assert.doesNotMatch(move, /innerHTML/, 'moving is positioning, never a rebuild');
  assert.match(move, /dataset\.x\s*=/, 'a resolver repaint that lands later must use the CURRENT position');
  const handler = braced("tmCanvas.addEventListener('mousemove'");
  assert.match(handler, /moveTooltip\(e\.clientX,\s*e\.clientY\)/, 'the same-node branch repositions');
  // The rebuild is reachable, but only behind a node comparison.
  const rebuildAt = handler.indexOf('showTooltip(e.clientX');
  assert.notEqual(rebuildAt, -1, 'a node change still rebuilds the card');
  const guard = handler.slice(0, rebuildAt);
  assert.match(guard, /hit\.n\s*===\s*prevNode/, 'and the branch is chosen by whether the node changed');
});

/* ═══════════════════════ the tooltip's glass ═══════════════════════ */

const START = '/* ═══════════════ Liquid Glass engine ═══════════════';
const END = '/* ═══ end Liquid Glass engine ═══ */';

function engineSource(): string {
  const a = INDEX.indexOf(START);
  assert.notEqual(a, -1, 'the Liquid Glass engine is spliced into index.html');
  const b = INDEX.indexOf(END, a);
  assert.notEqual(b, -1, 'the engine banner opens but never closes');
  return INDEX.slice(a, b);
}

type Fake = {
  sel: string; classes: string[]; props: Record<string, string>; observed: boolean;
  offsetWidth: number; offsetHeight: number; __lg?: { key: string; opts: Record<string, unknown> };
  [k: string]: unknown;
};

/**
 * Runs the engine (the liquidGlassObserver harness, extended to boot real
 * targets) and reports, per target, whether it was given the lens class,
 * whether its size is observed, and what --lg-backdrop it ended up with once
 * every scheduled frame has flushed.
 */
function boot(selectors: string[]): Record<string, Fake> {
  const stubEl = () => ({
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    setAttribute() {}, appendChild(c: unknown) { return c; }, remove() {},
    addEventListener() {}, classList: { add() {} },
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Array(w * h * 4).fill(0) }),
      putImageData() {},
    }),
    toDataURL: () => 'data:,',
    width: 0, height: 0, offsetWidth: 0, offsetHeight: 0,
  });
  const fakes: Record<string, Fake> = {};
  for (const sel of selectors) {
    const f: Fake = {
      sel, classes: [], props: {}, observed: false, offsetWidth: 380, offsetHeight: 104,
      matches: (s: string) => s === sel,
      classList: { add: (c: string) => { f.classes.push(c); } },
      style: {
        setProperty: (k: string, v: string) => { f.props[k] = v; },
        removeProperty: (k: string) => { delete f.props[k]; },
      },
      addEventListener() {},
      querySelectorAll: () => [],
      firstElementChild: null,
    };
    fakes[sel] = f;
  }
  const doc = {
    body: stubEl(),
    createElement: stubEl,
    createElementNS: stubEl,
    getElementById: () => null,
    querySelectorAll: () => Object.values(fakes),
  };
  const frames: Array<() => void> = [];
  let observer: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'document', 'MutationObserver', 'ResizeObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'console',
    engineSource(),
  )(
    doc,
    class { constructor(cb: unknown) { observer = cb; } observe() {} },
    class { observe(el: Fake) { el.observed = true; } unobserve() {} },
    () => ({ position: 'relative', getPropertyValue: () => '' }),
    (cb: () => void) => { frames.push(cb); return frames.length; },
    () => {}, () => 0, () => {},
    { warn(...a: unknown[]) { throw new Error('the engine refused to start: ' + a.join(' ')); } },
  );
  assert.ok(observer, 'the engine ran — the harness did not fall short');
  while (frames.length) frames.shift()!();
  return fakes;
}

test('the tooltip is frosted glass, not a lens: no reference filter, no size observer', () => {
  const t = boot(['#tooltip', '#sideNav']);
  const tip = t['#tooltip'], nav = t['#sideNav'];
  // The control: an ordinary target still gets the full treatment, so a
  // failure below is the tooltip's exemption and not a broken harness.
  assert.ok(nav.classes.includes('lg'), 'the sidebar is a lens host');
  assert.ok(nav.observed, 'and its size is observed');
  assert.match(nav.props['--lg-backdrop'] || '', /^url\(#lg-f-\d+\) blur\(/, 'and it carries the displacement filter');
  // The tooltip keeps the class — .lg::before IS its fill and its frost, it
  // has no other background — and nothing else.
  assert.ok(tip.classes.includes('lg'), 'the tooltip keeps its frosted ::before');
  assert.equal(tip.observed, false, 'a card that resizes on every node must not be a ResizeObserver client');
  assert.equal(tip.props['--lg-backdrop'], undefined,
    'and never receives a url(#…) reference filter to rasterise against a backdrop that moves every frame');
});
