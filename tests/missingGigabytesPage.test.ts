import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-missingGigabytesPage-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * Missing GB paints at once on a repeat visit (design pass G06).
 *
 * Every visit showed skeleton rows for about a second (1,003-1,133 ms
 * measured) while the statement was read again. The page now keeps the last
 * statement each scan was given and shows it at once, saying it is being
 * updated, while it asks again; the new statement replaces it whole. What is
 * on screen is always ONE statement — its lines sum to its own used figure —
 * never lines of two; a slower, older answer never replaces a newer one; and
 * a scan never shows another scan's statement.
 *
 * Driven through the page's own code: the Missing GB section of the built
 * page, from its renderer to its view registration, run over a stub DOM with
 * an api() whose answers the test hands back in the order it chooses.
 */

type ClassList = { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
interface El { innerHTML: string; textContent: string; classList: ClassList; querySelector(sel: string): unknown; querySelectorAll(): unknown[]; addEventListener(): void }

function el(): El {
  const classes = new Set<string>();
  const e: El = {
    innerHTML: '', textContent: '',
    classList: { add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); }, contains: (c) => classes.has(c) },
    // Only the receipt is ever looked for.
    querySelector: (sel) => (sel === '.mg-receipt' && e.innerHTML.includes('class="mg-receipt"') ? {} : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return e;
}

interface Ask { url: string; answer(d: unknown): Promise<void>; fail(message: string): Promise<void> }
interface View { mount(): void; unmount(): void; onScanChange(): void }

const turns = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

function page(): { body: El; info: El; asks: Ask[]; view: View; state: { scanId: string | null }; render(d: unknown): string } {
  const start = INDEX.indexOf('const MG_SEG = {');
  const end = INDEX.indexOf('/* ── What the two switchable channels mean', start);
  assert.ok(start > 0 && end > start, 'the Missing GB section is in the built page');
  const els: Record<string, El> = {};
  const $ = (id: string): El => (els[id] ||= el());
  const asks: Ask[] = [];
  const api = (url: string): Promise<unknown> => new Promise((resolve, reject) => {
    asks.push({
      url,
      answer: async (d) => { resolve(d); await turns(); },
      fail: async (message) => { reject(new Error(message)); await turns(); },
    });
  });
  let view: View | null = null;
  const state = { scanId: 's1' as string | null };
  const deps: Record<string, unknown> = {
    $, state, api,
    skeletonRows: (_n: number, _h: number, label: string) => `<div class="skel">${label}</div>`,
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${String(n)} B`, formatCount: (n: number) => String(n),
    registerView: (cfg: View & { id: string }) => { if (cfg.id === 'missing') view = cfg; },
    mountedView: { id: 'missing' }, switchView() {}, toast() {}, requestAnimationFrame() {},
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `'use strict'; ${INDEX.slice(start, end)}\nreturn (d) => { missingData = d; renderMissing(); };`)(
    ...keys.map((k) => deps[k]),
  ) as (d: unknown) => void;
  assert.ok(view, 'the view registered itself');
  // A reference paint of one statement alone, on its own body, for comparison.
  const reference = (d: unknown): string => {
    const saved = els.missingBody;
    els.missingBody = el();
    render(d);
    const html = els.missingBody.innerHTML;
    els.missingBody = saved;
    return html;
  };
  return { body: $('missingBody'), info: $('missingInfo'), asks, view: view as unknown as View, state, render: reference };
}

/** A statement whose lines sum to `used`, as every statement the server sends does. */
function statement(scanId: string, used: number): Record<string, unknown> {
  return {
    scanId, rootPath: `/${scanId}`,
    volume: { mountPoint: '/', totalBytes: 1000, usedBytes: used, freeBytes: 1000 - used, reservedBytes: 0, mechanism: 'statfs(/)', mechanismLabel: 'what macOS reports for Macintosh HD' },
    lines: [
      { id: 'scanned', label: 'Files TreeMap scanned', bytes: used - 7, available: true, detail: 'd', count: null, notes: [], remedy: null },
      { id: 'unaccounted', label: 'Unaccounted', bytes: 7, available: true, detail: 'u', count: null, notes: [], remedy: null },
    ],
    unaccountedBytes: 7, coversWholeVolume: true, caveats: [], generatedAt: 0,
  };
}

/** The used figure the receipt on screen states, or null when no receipt is shown. */
const usedShown = (body: El): number | null => {
  const m = /<span class="mg-cap"><b>(\d+) B<\/b> used/.exec(body.innerHTML);
  return m ? Number(m[1]) : null;
};

test('G06: a second visit paints the last statement at once, says it is updating, and swaps in the new one whole', async () => {
  const p = page();
  p.view.mount();
  assert.equal(p.asks.length, 1, 'a visit asks once');
  assert.match(p.asks[0].url, /\/api\/missing-gigabytes\?scanId=s1$/);
  assert.match(p.body.innerHTML, /Reconciling this disk/, 'the first visit has nothing to show yet');
  await p.asks[0].answer(statement('s1', 600));
  assert.equal(usedShown(p.body), 600);
  assert.doesNotMatch(p.body.innerHTML, /Updating…/, 'a fresh statement is not marked as updating');

  p.view.unmount();
  assert.equal(usedShown(p.body), null, 'leaving the view takes the receipt down');
  p.view.mount();
  // Nothing awaited: the receipt is there before the second answer.
  assert.equal(p.asks.length, 2, 'the visit asks again');
  assert.equal(usedShown(p.body), 600, 'the last statement is on screen at once — no skeleton');
  assert.match(p.body.innerHTML, /Updating…/, 'marked plainly as being updated');
  assert.ok(p.body.classList.contains('fx-chart-loading'), 'under the same loading veil a refresh has');
  assert.doesNotMatch(p.body.innerHTML, /Reconciling this disk/, 'and not the skeleton');

  const fresh = statement('s1', 610);
  await p.asks[1].answer(fresh);
  assert.equal(p.body.innerHTML, p.render(fresh), 'the new statement replaces the old one whole: exactly its own paint, nothing of the old');
  assert.ok(!p.body.classList.contains('fx-chart-loading'), 'the veil is lifted');
});

test('G06: an older answer that lands after a newer one is never shown, nor kept for the next visit', async () => {
  const p = page();
  p.view.mount();
  p.view.unmount();
  p.view.mount();
  assert.equal(p.asks.length, 2);
  const newer = statement('s1', 700);
  await p.asks[1].answer(newer);
  assert.equal(usedShown(p.body), 700);
  await p.asks[0].answer(statement('s1', 650)); // the first ask, slower
  assert.equal(p.body.innerHTML, p.render(newer), 'the older answer did not replace the newer one, nor mix into it');
  p.view.unmount();
  p.view.mount();
  assert.equal(usedShown(p.body), 700, 'and the next visit opens on the newer statement');
});

test('G06: a scan never shows another scan\'s statement — not while its own is being read, not when the other\'s answer lands late', async () => {
  const p = page();
  p.view.mount();
  await p.asks[0].answer(statement('s1', 600));
  p.view.unmount();
  p.view.mount(); // s1 asks again; its last statement is up, updating
  assert.equal(usedShown(p.body), 600);

  p.state.scanId = 's2';
  p.view.onScanChange();
  assert.equal(p.asks.length, 3);
  assert.match(p.asks[2].url, /scanId=s2$/);
  assert.equal(usedShown(p.body), null, 'the new scan does not stand on the last scan\'s receipt, veiled or not');
  assert.match(p.body.innerHTML, /Reconciling this disk/, 'it waits on its own first statement');

  await p.asks[1].answer(statement('s1', 620)); // s1's refetch, landing after the scan changed
  assert.equal(usedShown(p.body), null, 'the last scan\'s late answer is not painted over the new scan');
  const s2 = statement('s2', 300);
  await p.asks[2].answer(s2);
  assert.equal(p.body.innerHTML, p.render(s2), 'the new scan shows its own statement, whole');

  p.state.scanId = 's1';
  p.view.onScanChange();
  assert.equal(usedShown(p.body), 620, 'back on the first scan: its newest statement at once, the late answer included');
  assert.match(p.body.innerHTML, /Updating…/);
});

test('G06: a refresh that fails says so and takes the last statement down — it never leaves a stale receipt up', async () => {
  const p = page();
  p.view.mount();
  await p.asks[0].answer(statement('s1', 600));
  p.view.unmount();
  p.view.mount();
  assert.equal(usedShown(p.body), 600);
  await p.asks[1].fail('The disk layout cannot be read on this system.');
  assert.equal(usedShown(p.body), null, 'no receipt the server could not stand behind now');
  assert.match(p.body.innerHTML, /The disk layout cannot be read on this system\./);
  assert.ok(!p.body.classList.contains('fx-chart-loading'));
  p.view.unmount();
  p.view.mount();
  assert.equal(usedShown(p.body), null, 'nor on the next visit');
  assert.match(p.body.innerHTML, /Reconciling this disk/);
});

test('G06: the page keeps a few scans\' statements, not every scan\'s', async () => {
  const p = page();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const [i, id] of ids.entries()) {
    p.state.scanId = id;
    p.view.onScanChange();
    await p.asks[i].answer(statement(id, 100 + i));
  }
  p.state.scanId = 'e';
  p.view.onScanChange();
  assert.equal(usedShown(p.body), 104, 'the latest scan\'s statement is kept');
  p.state.scanId = 'a';
  p.view.onScanChange();
  assert.equal(usedShown(p.body), null, 'the oldest of five has been let go');
});

test('G06: an answer that lands after the view was left is kept for the next visit, not painted into the view that was left', async () => {
  const p = page();
  p.view.mount();
  p.view.unmount();
  await p.asks[0].answer(statement('s1', 640));
  assert.equal(usedShown(p.body), null, 'the view that was left stays as it was left');
  assert.match(p.body.innerHTML, /Run a scan to reconcile this disk\./);
  p.view.mount();
  assert.equal(usedShown(p.body), 640, 'and the next visit opens on it');
});

test('G06: an answer that lands before the page has caught up with a new scan is not painted over it', async () => {
  const p = page();
  p.view.mount();
  p.state.scanId = 's2'; // the scan changed; the view has not been told yet
  await p.asks[0].answer(statement('s1', 600));
  assert.equal(usedShown(p.body), null, 's1\'s statement is not painted while s2 is the scan');
});

test('G06: an older ask that fails after a newer one answered does not take the newer statement down', async () => {
  const p = page();
  p.view.mount();
  p.view.unmount();
  p.view.mount();
  const newer = statement('s1', 700);
  await p.asks[1].answer(newer);
  await p.asks[0].fail('an old failure');
  assert.equal(p.body.innerHTML, p.render(newer), 'the newer statement stands');
  p.view.unmount();
  p.view.mount();
  assert.equal(usedShown(p.body), 700, 'and is still kept');
});
