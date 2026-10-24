import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Trends paints only the answer for the folder it shows (hunt C83). `loadTrendData` numbered each load
 * but checked the number only for the forecast suffix: pick folder A (a long history, a slow read),
 * then B, and B painted — then A's answer landed and overwrote the chart, the "latest: …" line and the
 * deltas while the list said B. `renderTrendDeltas` awaited its comparison unguarded the same way. And
 * a load that landed after Trends was left built a new chart handle in the hidden view after its
 * unmount had destroyed it. Now an answer for a folder no longer shown, or for a view no longer open,
 * is dropped.
 *
 * The page is read as built (public/index.html); the functions run with stand-ins for the page helpers.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function decl(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  if (INDEX.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const snap = (id: string, totalSize: number) => ({ id, rootPath: '/x', takenAt: 1, totalSize, fileCount: 7 });

/** loadTrendData over stand-ins; `answers` holds each folder's pending /api/snapshots answer. */
function harness() {
  const answers = new Map<string, Deferred<{ snapshots: unknown[] }>>();
  const painted: string[] = [];
  const els: Record<string, { textContent: string; parentElement: { classList: { add(): void; remove(): void } } }> = {};
  const $ = (id: string) => (els[id] ??= { textContent: '', parentElement: { classList: { add() {}, remove() {} } } });
  const state = { view: 'trends', trends: { path: '/a', snapshots: [] as unknown[], forecastRate: null as number | null } };
  const api = (url: string) => {
    const folder = decodeURIComponent(url.split('path=')[1] ?? '');
    const d = deferred<{ snapshots: unknown[] }>();
    answers.set(folder, d);
    return d.promise;
  };
  const deps: Record<string, unknown> = {
    $, state, api,
    formatBytes: (n: number) => `${n} B`, formatCount: (n: number) => String(n),
    drawTrendNet: () => painted.push(`net:${state.trends.path}`),
    drawTrendChart: () => painted.push(`chart:${state.trends.path}`),
    renderTrendDeltas: () => painted.push(`deltas:${state.trends.path}`),
    labelTrendForecast: async () => {},
  };
  const keys = Object.keys(deps);
  const loadTrendData = new Function(...keys, `let trendInfoSeq = 0;\n${decl('loadTrendData')}\nreturn loadTrendData;`)(...keys.map((k) => deps[k])) as () => Promise<void>;
  return { answers, painted, els, state, loadTrendData };
}

test('a slow answer for the folder picked first never paints over the folder picked after it', async () => {
  const h = harness();
  const first = h.loadTrendData();
  h.state.trends.path = '/b'; // the arrow keys move on before /a answers
  const second = h.loadTrendData();
  await flush();
  h.answers.get('/b')?.resolve({ snapshots: [snap('b1', 222)] });
  await second;
  h.answers.get('/a')?.resolve({ snapshots: [snap('a1', 111), snap('a2', 112)] });
  await first;
  assert.deepEqual(h.state.trends.snapshots.map((s) => (s as { id: string }).id), ['b1'], 'the history held is the folder shown');
  assert.equal(h.els.trendInfo.textContent, 'latest: 222 B · 7 files', 'the line is the folder shown');
  assert.deepEqual(h.painted, ['net:/b', 'chart:/b', 'deltas:/b'], 'only the folder shown was painted');
});

test('an answer that lands after Trends was left builds nothing in the hidden view', async () => {
  const h = harness();
  const load = h.loadTrendData();
  await flush();
  h.state.view = 'dashboard'; // left, and the view's unmount destroyed its chart handles
  h.answers.get('/a')?.resolve({ snapshots: [snap('a1', 111)] });
  await load;
  assert.deepEqual(h.painted, [], 'no chart, strip or deltas drawn for a view that is not open');
});

/** renderTrendDeltas over stand-ins, its comparison answer pending until the test settles it. */
function deltasHarness() {
  const host = { innerHTML: 'before' };
  let settle!: { resolve: (v: unknown) => void; reject: (e: Error) => void };
  const pending = new Promise<unknown>((resolve, reject) => { settle = { resolve, reject }; });
  const state = { view: 'trends', trends: { path: '/a', snapshots: [snap('a1', 1), snap('a2', 2)] as unknown[] } };
  const deps: Record<string, unknown> = {
    $: () => host, state, api: () => pending,
    coverageRules: () => null, coverageFor: () => null, formatDate: (t: number) => `d${t}`, cmpWhenPair: () => ['x', 'y'],
    formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), chipFor: () => '', coverageExplains: () => null,
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
  };
  const keys = Object.keys(deps);
  const render = new Function(...keys, `${decl('renderTrendDeltas')}\n${decl('deltaRow')}\nreturn renderTrendDeltas;`)(...keys.map((k) => deps[k])) as () => Promise<void>;
  return { host, state, settle, render };
}

const STALE_ANSWER = { totalDelta: 999, entries: [{ name: 'gone', path: '/a/gone', type: 'dir', sizeA: 9, sizeB: null, delta: -9 }] };

test('the last-change list drops a comparison answer for the same folder once its history was read again (review F1.19)', async () => {
  const h = deltasHarness();
  const running = h.render();
  h.state.trends.snapshots = [snap('a1', 1), snap('a2', 2), snap('a3', 3)]; // a newer load of /a: its own deltas follow
  h.settle.resolve(STALE_ANSWER);
  await running;
  assert.equal(h.host.innerHTML, 'before', 'the comparison of an older pair is not written over the newer history');
});

test('a comparison that fails after another folder was picked writes no error under it (review F1.19)', async () => {
  const h = deltasHarness();
  const running = h.render();
  h.state.trends = { path: '/b', snapshots: [snap('b1', 5)] };
  h.settle.reject(new Error('the comparison of /a failed'));
  await running;
  assert.equal(h.host.innerHTML, 'before', 'folder /a\'s failure is not written under folder /b');
});

test('the last-change list drops a comparison answer for a folder no longer shown', async () => {
  const host = { innerHTML: 'before' };
  const pending = deferred<{ totalDelta: number; entries: unknown[] }>();
  const state = { view: 'trends', trends: { path: '/a', snapshots: [snap('a1', 1), snap('a2', 2)] as unknown[] } };
  const deps: Record<string, unknown> = {
    $: () => host, state, api: () => pending.promise,
    coverageRules: () => null, coverageFor: () => null, formatDate: (t: number) => `d${t}`, cmpWhenPair: () => ['x', 'y'],
    formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), chipFor: () => '', coverageExplains: () => null,
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
  };
  const keys = Object.keys(deps);
  const render = new Function(...keys, `${decl('renderTrendDeltas')}\n${decl('deltaRow')}\nreturn renderTrendDeltas;`)(...keys.map((k) => deps[k])) as () => Promise<void>;
  const running = render();
  state.trends = { path: '/b', snapshots: [snap('b1', 5)] }; // another folder picked meanwhile
  pending.resolve({ totalDelta: 999, entries: [{ name: 'gone', path: '/a/gone', type: 'dir', sizeA: 9, sizeB: null, delta: -9 }] });
  await running;
  assert.equal(host.innerHTML, 'before', 'folder /a\'s deltas are not written under folder /b');
});
