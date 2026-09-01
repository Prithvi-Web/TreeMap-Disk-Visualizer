import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Liquid Glass engine's document-wide MutationObserver.
 *
 * The lens watches `style` on the whole body subtree so that an element
 * revealed by a style flip still builds its filter in a window where
 * ResizeObserver is suspended. That makes it a tax on every inline-style
 * animation the app runs: the beam pulse driver writes 17 custom properties
 * per driven instance per frame, the goo thumb writes three, every tooltip
 * glide writes one — and each is its own mutation record.
 *
 * The engine is a self-contained IIFE between exact banners, so it is
 * spliced out and EXECUTED here with the browser it needs stubbed. The one
 * thing this file must never do is pass because the harness fell short: the
 * engine wraps itself in try/catch, so every test below first asserts that
 * the observer was actually constructed.
 */

const START = '/* ═══════════════ Liquid Glass engine ═══════════════';
const END = '/* ═══ end Liquid Glass engine ═══ */';

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function engineSource(): string {
  const a = INDEX.indexOf(START);
  assert.notEqual(a, -1, 'the Liquid Glass engine is spliced into index.html — a renamed banner must fail, never skip');
  const b = INDEX.indexOf(END, a);
  assert.notEqual(b, -1, 'the engine banner opens but never closes');
  return INDEX.slice(a, b);
}

const SRC = engineSource();

type Rec = { type: string; attributeName?: string; target: LgNode; addedNodes?: never[]; removedNodes?: never[] };

type LgNode = {
  queries: number;
  __lg?: { id: string; opts: unknown; key: string };
  firstElementChild: LgNode | null;
  querySelectorAll(sel: string): LgNode[];
  matches(sel: string): boolean;
};

/** A body-subtree element as the observer sees it: does it hold a lens, can
    it contain one, and how often was its subtree searched. */
function lgNode(opts: { children?: boolean; lens?: 'built' | 'unbuilt' } = {}): LgNode {
  const node: LgNode = {
    queries: 0,
    firstElementChild: opts.children ? ({} as LgNode) : null,
    querySelectorAll(_sel: string) { node.queries++; return []; },
    matches() { return false; },
  };
  if (opts.lens) node.__lg = { id: 'lg-f-1', opts: {}, key: opts.lens === 'built' ? '64x24' : '' };
  return node;
}

function harness() {
  let observer: ((muts: Rec[]) => void) | null = null;
  const stubEl = () => {
    const el: Record<string, unknown> = {
      style: { cssText: '', setProperty() {}, removeProperty() {} },
      setAttribute() {}, appendChild(c: unknown) { return c; }, remove() {},
      addEventListener() {}, classList: { add() {} },
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ data: new Array(w * h * 4).fill(0) }),
        putImageData() {},
      }),
      toDataURL: () => 'data:,',
      width: 0, height: 0,
      offsetWidth: 0, offsetHeight: 0,
    };
    return el;
  };
  const doc = {
    body: stubEl(),
    createElement: stubEl,
    createElementNS: stubEl,
    getElementById: () => null,
    querySelectorAll: () => [] as unknown[],
  };
  const scheduled: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'document', 'MutationObserver', 'ResizeObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'console',
    SRC,
  )(
    doc,
    class { constructor(cb: (muts: Rec[]) => void) { observer = cb; } observe() {} },
    class { observe() {} unobserve() {} },
    () => ({ position: 'relative', getPropertyValue: () => '' }),
    (cb: () => void) => { scheduled.push(cb); return scheduled.length; },
    () => {}, () => 0, () => {},
    { warn(...a: unknown[]) { throw new Error('the engine refused to start: ' + a.join(' ')); } },
  );
  assert.ok(observer, 'the engine built its MutationObserver — the harness really ran it');
  return { mutate: (recs: Rec[]) => (observer as (m: Rec[]) => void)(recs) };
}

test('one style-attribute batch asks a target’s subtree once, however many properties were written', () => {
  const h = harness();
  const animated = lgNode({ children: true });   // e.g. a beam host inside a lens card
  const other = lgNode({ children: true });
  const recs: Rec[] = [];
  // exactly what one frame of the beam pulse driver produces
  for (let i = 0; i < 17; i++) recs.push({ type: 'attributes', attributeName: 'style', target: animated });
  recs.push({ type: 'attributes', attributeName: 'class', target: other });
  h.mutate(recs);
  assert.equal(animated.queries, 1, 'seventeen writes in one frame, one subtree query');
  assert.equal(other.queries, 1, 'and a different target is still processed on its own merits');
});

test('a childless element that holds no lens costs the observer nothing at all', () => {
  const h = harness();
  const leaf = lgNode();      // the goo thumb, a beam bloom layer, a tooltip
  h.mutate([{ type: 'attributes', attributeName: 'style', target: leaf }]);
  assert.equal(leaf.queries, 0, 'nothing to build here, and nothing that could contain one');
});

test('an unbuilt lens still schedules — the reveal-by-style-flip case the observer exists for', () => {
  const h = harness();
  const revealed = lgNode({ lens: 'unbuilt' });  // a modal opened by a style flip
  h.mutate([{ type: 'attributes', attributeName: 'style', target: revealed }]);
  assert.equal(revealed.queries, 1, 'a lens host is always looked at, children or not');
  const container = lgNode({ children: true });
  h.mutate([{ type: 'attributes', attributeName: 'hidden', target: container }]);
  assert.equal(container.queries, 1, 'so is any element that could contain one');
});
