import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Instant open must not borrow the parent root's counts (A1).
 *
 * `GET /api/index/tree` returns the tree for the path that was asked for, but
 * its `fileCount` / `dirCount` / `totalSize` describe the whole IndexedRoot
 * that CONTAINS that path — `rootFor()` matches by prefix. So scanning `~`
 * once and then opening `~/Documents` painted a headline whose item count came
 * from the home folder and whose byte total came from Documents, at an
 * items/sec rate neither of them supports. Three surfaces published that
 * pairing: the "Scanned N files …" headline, the Files/Folders tiles, and the
 * engine row.
 *
 * Every test here EXECUTES the real function out of the built page against
 * stubs, because all three defects are behaviour under a specific input, not
 * the presence of a line of code. The invariant is the same one §10 states:
 * a number that does not describe the thing on screen is not shown at all, and
 * "not shown" means blanked, not left holding the last scan's value.
 *
 * The other two defects in the same file are honesty defects of the same
 * family — a control that refuses in silence, and a tab that hides itself
 * while it waits — so they are pinned here too.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A slice of the built page between two exact anchors. */
function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

/**
 * A slice with its comments removed.
 *
 * The one structural check below looks for an absence, and the fix that
 * created that absence necessarily EXPLAINS the guard it deleted — so a scan
 * of the raw text finds the fix's own documentation and calls it the bug. The
 * repo's standing answer (frontendContract's `appCode`) is to check structure
 * against code only; strings are left alone, none of them matter here.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

type El = {
  hidden: boolean; innerHTML: string; textContent: string;
  dataset: Record<string, unknown>;
  classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void };
  setAttribute: (k: string, v: string) => void;
  closest: () => null;
  querySelectorAll: () => never[];
};

function el(): El {
  return {
    hidden: false, innerHTML: '', textContent: '',
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    setAttribute: () => {},
    closest: () => null,
    querySelectorAll: () => [],
  };
}

/** A `$` that hands out a stable stub element per id, created on demand. */
function makeDom(): { $: (id: string) => El; els: Record<string, El> } {
  const els: Record<string, El> = {};
  return { $: (id: string) => (els[id] ??= el()), els };
}

/* ══════════════════ 1. openFromIndex — whose counts are these? ══════════════════ */

type IndexTreeBody = Record<string, unknown>;

async function runOpenFromIndex(body: IndexTreeBody) {
  const src = slice('async function openFromIndex', 'async function buildIndexInBackground');
  const state: Record<string, unknown> = { scanId: 'a-previous-scan', root: null, scanStats: null };
  const finished: { stats?: Record<string, unknown> } = {};
  const fn = new Function(
    'api', 'state', 'indexTree', 'finishScan', 'renderIndexBadge', 'performance', 'INSTANT_OPEN_NODES',
    `'use strict'; ${src} return openFromIndex;`,
  )(
    async () => body,
    state,
    () => {},
    async (_root: unknown, _ms: number, stats: Record<string, unknown>) => { finished.stats = stats; },
    () => {},
    { now: () => 1000 },
    250000,
  ) as (p: string, info: unknown) => Promise<boolean>;
  const painted = await fn(String(body.path), { indexed: true, root: { state: 'ready', live: true } });
  return { painted, state, finished };
}

test('opening a SUBFOLDER of an indexed root publishes no item counts at all', async () => {
  // The exact repro: `~` was scanned and indexed, then `~/Documents` is opened.
  // The body carries Documents' tree and the home folder's counters.
  const { painted, state, finished } = await runOpenFromIndex({
    rootPath: '/Users/x',
    path: '/Users/x/Documents',
    fileCount: 900_000,
    dirCount: 100_000,
    totalSize: 800_000_000_000,
    root: { path: '/Users/x/Documents', size: 4_200_000_000, type: 'dir' },
  });
  assert.equal(painted, true, 'the instant paint still happens — the tree itself is correct');
  const stats = state.scanStats as Record<string, unknown>;
  assert.equal(stats.scanned, null, 'no item count: 1,000,000 belongs to the parent, not to Documents');
  assert.equal(stats.fileCount, null, 'no file count for the same reason');
  assert.equal(stats.dirCount, null, 'no folder count for the same reason');
  assert.equal(finished.stats?.scanned, null, 'and finishScan is handed the same honest shape');
});

test('opening the indexed root ITSELF keeps its counts — the fix must not blank everything', async () => {
  const { state } = await runOpenFromIndex({
    rootPath: '/Users/x',
    path: '/Users/x',
    fileCount: 900_000,
    dirCount: 100_000,
    totalSize: 800_000_000_000,
    root: { path: '/Users/x', size: 800_000_000_000, type: 'dir' },
  });
  const stats = state.scanStats as Record<string, unknown>;
  assert.equal(stats.fileCount, 900_000, 'these counters really do describe this tree');
  assert.equal(stats.dirCount, 100_000);
  assert.equal(stats.scanned, 1_000_000, 'and the item total is the sum of the two');
});

test('a server that names no root is treated as "these counts are not mine"', async () => {
  // Defensive, and the honest default: if the response cannot prove the
  // counters describe the tree, they are not published as if they did.
  const { state } = await runOpenFromIndex({
    path: '/Users/x/Documents',
    fileCount: 900_000,
    dirCount: 100_000,
    root: { path: '/Users/x/Documents', size: 4_200_000_000, type: 'dir' },
  });
  assert.equal((state.scanStats as Record<string, unknown>).scanned, null);
});

/* ══════════════════ 2. The engine row must not print a zero ══════════════════ */

function runRenderDiskNotes(scanStats: Record<string, unknown>) {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  const { $, els } = makeDom();
  const fn = new Function(
    '$', 'state', 'formatCount', 'formatBytes', 'fxTmPillBeamsSync',
    `'use strict'; ${src} return renderDiskNotes;`,
  )(
    $,
    { scanStats, treemap: { hideCloud: false } },
    (n: number | null) => (n ?? 0).toLocaleString(),
    (n: number) => n + ' B',
    () => {},
  ) as () => void;
  fn();
  return els;
}

test('no item count means no engine row — "scanned 0 items" is a fabricated fact', () => {
  // formatCount(null) prints "0". Nulling the count without gating the row is
  // how the obvious half-fix produced "index — scanned 0 items in 0.1 s".
  const els = runRenderDiskNotes({ engine: 'index', durationMs: 120, scanned: null });
  assert.equal(els.engineRow.hidden, true, 'the row is hidden rather than printing a zero');
  assert.doesNotMatch(els.engineText?.textContent ?? '', /\b0 items\b/, 'and it never wrote that sentence');
});

test('a real scan still gets its engine row', () => {
  const els = runRenderDiskNotes({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 8 });
  assert.equal(els.engineRow.hidden, false, 'the row survives for counts that are real');
  assert.match(els.engineText.textContent, /1,234 items/, 'and states them');
});

/* ══════════════════ 3. finishScan must BLANK the tiles, not skip them ══════════════════ */

function runFinishScan(stats: Record<string, unknown> | null, seed: { files: string; dirs: string }) {
  const src = slice('async function finishScan', 'function renderDiskNotes()');
  const { $, els } = makeDom();
  els.statFiles = el(); els.statFiles.textContent = seed.files; els.statFiles.dataset.v = seed.files.replace(/,/g, '');
  els.statDirs = el(); els.statDirs.textContent = seed.dirs; els.statDirs.dataset.v = seed.dirs.replace(/,/g, '');
  const counted: Array<[El, number]> = [];
  const state: Record<string, unknown> = {
    scanId: null, // the index-first paint: a tree, deliberately no scan yet
    treemap: { rootPath: '' }, grid: { path: '', selection: new Set() },
    apps: { loadedFor: 'x' }, view: 'dashboard', live: { wanted: false },
  };
  const noop = () => {};
  const fn = new Function(
    '$', 'state', 'endScanChrome', 'indexTree', 'updateSelectionBar', 'DUP_PAGE', 'icon',
    'formatCount', 'formatBytes', 'escapeHtml', 'countUp', 'FxNum', 'renderDiskNotes',
    'loadWhatsNew', 'loadDriveHealth', 'loadCostEstimate', 'showListsPending', 'emit', 'TOPIC',
    'switchView', 'toast', 'fxScanDonePulse',
    `'use strict'; ${src} return finishScan;`,
  )(
    $, state, noop, noop, noop, 100, () => '',
    (n: number | null) => (n ?? 0).toLocaleString(),
    (n: number) => n + ' B',
    (s: string) => s,
    (e: El, n: number) => { counted.push([e, n]); },
    { rollText: noop }, noop,
    noop, noop, noop, noop, noop, { scan: 'scan' },
    noop, noop, noop,
  ) as (root: unknown, ms: number, stats: unknown) => Promise<void>;
  return fn({ path: '/Users/x/Documents', size: 4_200_000_000 }, 120, stats)
    .then(() => ({ els, counted, state }));
}

test('tiles with no number to show are blanked, never left holding the last scan’s', async () => {
  const { els, counted } = await runFinishScan(
    { fileCount: null, dirCount: null, scanned: null, engine: 'index', durationMs: 120 },
    { files: '900,000', dirs: '100,000' },
  );
  assert.equal(els.statFiles.textContent, '–', 'Files falls back to the dash it ships with');
  assert.equal(els.statDirs.textContent, '–', 'Folders too');
  assert.equal(Number(els.statFiles.dataset.v), 0,
    'and the roll’s resume point goes with it — countUp reads data-v, not the text');
  assert.equal(Number(els.statDirs.dataset.v), 0);
  assert.equal(counted.length, 0, 'nothing was counted up');
});

test('the headline states the bytes but invents no item count', async () => {
  const { els } = await runFinishScan(
    { fileCount: null, dirCount: null, scanned: null, engine: 'index', durationMs: 120 },
    { files: '900,000', dirs: '100,000' },
  );
  assert.match(els.scanStatus.innerHTML, /4200000000 B/, 'the byte total is exact for this tree, so it is shown');
  assert.doesNotMatch(els.scanStatus.innerHTML, /900,000|1,000,000|\b0 files\b/,
    'no borrowed count and no zero standing in for one');
});

test('a real scan still fills both tiles', async () => {
  const { counted } = await runFinishScan(
    { fileCount: 12, dirCount: 3, scanned: 15, engine: 'walker', durationMs: 900 },
    { files: '–', dirs: '–' },
  );
  assert.deepEqual(counted.map(([, n]) => n), [12, 3], 'the numbers still land when they are real');
});

/* ══════════════════ 4. Enter refuses out loud ══════════════════ */

function runPathKeydown(scanning: boolean, key = 'Enter') {
  const src = slice("$('pathInput').addEventListener('keydown'", "$('pathInput').addEventListener('input'");
  const handlers: Record<string, (e: { key: string }) => void> = {};
  const clicks: number[] = [];
  const toasts: Array<[string, string | undefined]> = [];
  new Function(
    '$', 'state', 'toast',
    `'use strict'; ${src}`,
  )(
    (id: string) => (id === 'pathInput'
      ? { addEventListener: (t: string, fn: (e: { key: string }) => void) => { handlers[t] = fn; } }
      : { click: () => clicks.push(1) }),
    { scanning },
    (m: string, kind?: string) => { toasts.push([m, kind]); },
  );
  assert.ok(handlers.keydown, 'the path field has a keydown handler');
  handlers.keydown({ key });
  return { clicks, toasts };
}

test('Enter during the boot auto-scan says what is happening instead of doing nothing', () => {
  // The app auto-scans the last path at boot, so this is the FIRST thing a
  // returning user hits. It must still not cancel the running scan…
  const { clicks, toasts } = runPathKeydown(true);
  assert.equal(clicks.length, 0, 'Enter never presses Stop');
  // …but a refusal nobody can hear is indistinguishable from a dead input.
  assert.equal(toasts.length, 1, 'the refusal is spoken');
  assert.match(toasts[0][0], /scan/i, 'it names what is happening');
  assert.match(toasts[0][0], /stop/i, 'and what to do about it');
});

test('Enter with nothing running still starts the scan, silently', () => {
  const { clicks, toasts } = runPathKeydown(false);
  assert.equal(clicks.length, 1, 'the button does the work, exactly as before');
  assert.equal(toasts.length, 0, 'and a working control says nothing');
});

test('the refusal fires on Enter only, not on every keystroke', () => {
  const { clicks, toasts } = runPathKeydown(true, 'a');
  assert.equal(toasts.length, 0, 'typing a path mid-scan is not an error');
  assert.equal(clicks.length, 0);
});

/* ══════════════════ 5. Cloud-safe waits in public ══════════════════ */

function runRenderCloudSafe(apiImpl: () => Promise<unknown>) {
  const src = slice('async function renderCloudSafe', 'async function renderGrowthProjection');
  const { $, els } = makeDom();
  els.cleanTabCloud = el(); els.cleanTabCloud.hidden = false;
  const noop = () => {};
  const fn = new Function(
    '$', 'state', 'api', 'seedNodes', 'formatCount', 'formatBytes', 'escapeHtml', 'chipFor',
    'formatDate', 'icon', 'refreshCartButtons',
    `'use strict'; ${src} return renderCloudSafe;`,
  )(
    $, { scanId: 's1' }, apiImpl, noop,
    (n: number) => String(n), (n: number) => n + ' B', (s: string) => String(s),
    () => '', () => '', () => '', noop,
  ) as () => Promise<void>;
  return fn().then(() => els);
}

test('a rescan in flight leaves the Cloud-safe tab visible and says it is waiting', async () => {
  // The endpoint answers 202 {status:'running'} while a scan runs, and api()
  // turns that into a thrown `stillWorking` error — never a body. Catching it
  // like a failure made the whole tab disappear mid-rescan.
  const pending = Object.assign(new Error('Still working on that'), { code: 'PENDING', status: 202, stillWorking: true });
  const els = await runRenderCloudSafe(() => Promise.reject(pending));
  assert.equal(els.cleanTabCloud.hidden, false, 'the tab stays where the user left it');
  assert.notEqual(els.cloudResults.innerHTML, '', 'and it says why it is empty');
  assert.match(els.cloudResults.innerHTML, /scan|wait|still/i, 'in words about the scan still running');
});

test('a real failure still hides the tab — waiting and broken are different answers', async () => {
  const broken = Object.assign(new Error('The server answered 500'), { code: 'SCAN_FAILED', status: 500 });
  const els = await runRenderCloudSafe(() => Promise.reject(broken));
  assert.equal(els.cleanTabCloud.hidden, true, 'nothing to offer, so nothing is offered');
  assert.equal(els.cloudResults.innerHTML, '');
});

test('a scan with no online-only files hides the tab, and one with them fills it', async () => {
  const empty = await runRenderCloudSafe(async () => ({ scanId: 's1', totalCount: 0, totalSize: 0, groups: [] }));
  assert.equal(empty.cleanTabCloud.hidden, true, 'an empty result is not a tab worth showing');

  const full = await runRenderCloudSafe(async () => ({
    scanId: 's1', totalCount: 2, totalSize: 2048,
    groups: [{ provider: 'icloud', count: 2, totalSize: 2048, files: [
      { name: 'a.mov', path: '/x/a.mov', size: 1024, modifiedAt: 1 },
      { name: 'b.mov', path: '/x/b.mov', size: 1024, modifiedAt: 2 },
    ] }],
  }));
  assert.equal(full.cleanTabCloud.hidden, false);
  assert.match(full.cloudResults.innerHTML, /a\.mov/, 'the rows are painted');
});

test('the unreachable 202 guard is gone from renderCloudSafe', () => {
  // `!data.groups` sat AFTER an await that can only resolve with a 2xx body:
  // api() throws on the 202 rather than returning it. Dead code whose comment
  // described a path that no longer exists is worse than no comment — the next
  // reader trusts it and looks for the bug somewhere else.
  const src = codeOnly(slice('async function renderCloudSafe', 'async function renderGrowthProjection'));
  assert.doesNotMatch(src, /!data\.groups/, 'the guard that could never run is deleted');
  assert.match(src, /stillWorking/, 'and the branch that CAN run replaced it');
});
