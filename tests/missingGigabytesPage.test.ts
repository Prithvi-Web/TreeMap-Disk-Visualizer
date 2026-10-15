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
  // The reference paint is a fresh statement's (not being updated), and leaves
  // the page's own state as it found it: it shares nothing mutable with the
  // page under test, so a flag the page fails to clear shows (review F1.6).
  const render = new Function(...keys, `'use strict'; ${INDEX.slice(start, end)}\n` +
    'return (d) => { const data = missingData, updating = missingUpdating; missingData = d; missingUpdating = false; ' +
    'try { renderMissing(); } finally { missingData = data; missingUpdating = updating; } };')(
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
function statement(scanId: string, used: number, volumeName = 'Macintosh HD'): Record<string, unknown> {
  return {
    scanId, rootPath: `/${scanId}`,
    volume: { mountPoint: '/', totalBytes: 1000, usedBytes: used, freeBytes: 1000 - used, reservedBytes: 0, mechanism: 'statfs(/)', mechanismLabel: `what macOS reports for ${volumeName}` },
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
  assert.doesNotMatch(p.body.innerHTML, /Updating…/, 'the swapped-in statement is not marked as updating: it is the newest');
  assert.equal(p.body.innerHTML, p.render(fresh), 'the new statement replaces the old one whole: exactly its own paint, nothing of the old');
  assert.ok(!p.body.classList.contains('fx-chart-loading'), 'the veil is lifted');
});

test('G06 review F1.1: a scan landing while the view is open asks once — the scan\'s emit and the re-mount share one request, and its answer paints', async () => {
  const p = page();
  // finishScan: emit(TOPIC.scan) reaches onScanChange, then switchView(state.view)
  // mounts the view on screen again without leaving it — two ways in, one tick.
  p.view.onScanChange();
  p.view.mount();
  assert.equal(p.asks.length, 1, 'one request for the scan, not one per way into the view');
  await p.asks[0].answer(statement('s1', 600));
  assert.equal(usedShown(p.body), 600, 'and the one answer is painted — not discarded for a second ask');
});

test('G06 review F1.1: a re-entry while the scan\'s ask is out waits on it, even after another scan\'s late answer; once answered, entering again asks again', async () => {
  const p = page();
  p.view.mount(); // s1 asks
  p.state.scanId = 's2';
  p.view.onScanChange(); // s2 asks
  assert.equal(p.asks.length, 2);
  await p.asks[0].answer(statement('s1', 600)); // s1's answer lands late
  p.view.mount(); // a re-entry of the view on screen (switchView(state.view)) while s2's ask is out
  assert.equal(p.asks.length, 2, 's2 is asked once: s1\'s late answer did not free a second ask');
  await p.asks[1].answer(statement('s2', 300));
  assert.equal(usedShown(p.body), 300);
  p.view.mount();
  assert.equal(p.asks.length, 3, 'once its answer is in, entering again asks again');
});

test('G06 review F2.2: an ask that fails frees its scan\'s slot — the scan landing after a mid-scan "still running" asks again, once, without the view being left, and that answer paints', async () => {
  const p = page();
  // Opened mid-scan: state.scanId is already the running scan's, and the
  // server answers that it is still running (409 SCAN_RUNNING).
  p.view.mount();
  await p.asks[0].fail('This scan is still running.');
  assert.match(p.body.innerHTML, /This scan is still running\./, 'the server\'s answer is said');
  // finishScan: emit(TOPIC.scan) with the same scanId, then switchView(state.view).
  p.view.onScanChange();
  p.view.mount();
  assert.equal(p.asks.length, 2, 'the scan landing asks again, once: the failed ask does not hold the scan\'s slot');
  const s1 = statement('s1', 600);
  await p.asks[1].answer(s1);
  assert.equal(p.body.innerHTML, p.render(s1), 'and the new ask\'s answer paints, whole');
});

test('G06 review F2.2: an older scan\'s ask failing late never frees the newer scan\'s slot; once the newer is answered, entering again asks again', async () => {
  const p = page();
  p.view.mount(); // s1 asks
  p.state.scanId = 's2';
  p.view.onScanChange(); // s2 asks
  assert.equal(p.asks.length, 2, 's1 and s2 are each asked');
  await p.asks[0].fail('s1 could not be reconciled.'); // s1's ask fails, late
  assert.doesNotMatch(p.body.innerHTML, /s1 could not be reconciled/, 's1\'s failure is not said over s2, which is still being asked');
  p.view.mount(); // a re-entry of the view on screen while s2's ask is out
  assert.equal(p.asks.length, 2, 's2 is asked once: s1\'s late failure did not free a second ask');
  await p.asks[1].answer(statement('s2', 300));
  assert.equal(usedShown(p.body), 300, 's2\'s answer paints after s1\'s failure');
  p.view.mount();
  assert.equal(p.asks.length, 3, 'once s2\'s answer is in after s1\'s failure, entering again asks again');
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
  assert.doesNotMatch(p.body.innerHTML, /Updating…/, 'the swapped-in statement is not marked as updating: it is the newest');
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
  assert.ok(!p.body.classList.contains('fx-chart-loading'), 'its skeleton rows, not under the veil the last scan\'s receipt had (review F1.10): the two are alternatives');

  await p.asks[1].answer(statement('s1', 620)); // s1's refetch, landing after the scan changed
  assert.equal(usedShown(p.body), null, 'the last scan\'s late answer is not painted over the new scan');
  const s2 = statement('s2', 300);
  await p.asks[2].answer(s2);
  assert.doesNotMatch(p.body.innerHTML, /Updating…/, 'the swapped-in statement is not marked as updating: it is the newest');
  assert.equal(p.body.innerHTML, p.render(s2), 'the new scan shows its own statement, whole');

  p.state.scanId = 's1';
  p.view.onScanChange();
  assert.equal(usedShown(p.body), 620, 'back on the first scan: its newest statement at once, the late answer included');
  assert.match(p.body.innerHTML, /Updating…/);
});

test('G06 review F2.1: a new scan with nothing kept waits on its own statement under no caption — never the last scan\'s, naming the last scan\'s volume', async () => {
  const p = page();
  p.view.mount();
  await p.asks[0].answer(statement('s1', 600, 'Macintosh HD'));
  assert.match(p.info.textContent, /what macOS reports for Macintosh HD\. Every line below/, 's1\'s caption is up with its receipt');

  p.state.scanId = 's2'; // a new scan, on another volume, lands while the view is open
  p.view.onScanChange();
  assert.match(p.body.innerHTML, /Reconciling this disk/, 's2 has nothing kept: its skeleton rows');
  assert.equal(p.info.textContent, '', 'and no caption above them: s1\'s names Macintosh HD and "every line below", and neither is s2\'s');

  await p.asks[1].answer(statement('s2', 300, 'Backup'));
  assert.match(p.info.textContent, /what macOS reports for Backup\. Every line below/, 's2\'s own caption comes with its own statement');
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
  // Four kept, newest to oldest (review F1.9): each opens on its own statement at once.
  for (const [id, used] of [['e', 104], ['d', 103], ['c', 102], ['b', 101]] as const) {
    p.state.scanId = id;
    p.view.onScanChange();
    assert.equal(usedShown(p.body), used, `scan ${id}'s statement is kept`);
  }
  p.state.scanId = 'a';
  p.view.onScanChange();
  assert.equal(usedShown(p.body), null, 'the oldest of five has been let go');
});

test('G06 review F1.9: the scans kept are the four most recently answered — a scan answered again is kept over one answered once since', async () => {
  const p = page();
  const answer = async (id: string, used: number): Promise<void> => {
    p.state.scanId = id;
    p.view.onScanChange();
    await p.asks[p.asks.length - 1].answer(statement(id, used));
  };
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) await answer(id, 100 + i);
  await answer('a', 110); // a is answered again: now the most recent of the four
  await answer('e', 104); // a fifth: the least recently answered goes, which is b
  const kept = (id: string): number | null => { p.state.scanId = id; p.view.onScanChange(); return usedShown(p.body); };
  assert.equal(kept('a'), 110, 'a, answered again, is kept — with its newest statement');
  assert.equal(kept('b'), null, 'b, answered least recently, is the one let go');
  assert.deepEqual(['c', 'd', 'e'].map(kept), [102, 103, 104], 'the rest are kept');
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
  assert.doesNotMatch(p.body.innerHTML, /Updating…/, 'the swapped-in statement is not marked as updating: it is the newest');
  assert.equal(p.body.innerHTML, p.render(newer), 'the newer statement stands');
  p.view.unmount();
  p.view.mount();
  assert.equal(usedShown(p.body), 700, 'and is still kept');
});
