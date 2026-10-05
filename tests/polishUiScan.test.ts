import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Polish round — the scan's honesty on the page (first-run-1..4, states-errors-1,
 * -3, -5, -6, -7, a11y-keyboard-5, desktop-polish-8, data-truth-3 mirror,
 * data-truth-5).
 *
 * A refused folder is named, never congratulated; a moved folder does not
 * strand the spinner; a dead server does not spin forever; three failed lists
 * say "couldn't load", not "no files"; expired results offer a rescan; small
 * folders still paint; the tour narrates the view the user is looking at;
 * screen readers hear the scan; a dropped stack of folders scans in order.
 * Every function here is EXECUTED out of the built page against stubs.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function braced(openAnchor: string, from = 0): string {
  const start = INDEX.indexOf(openAnchor, from);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  // Skip the parameter list before looking for the body: a default value is a
  // brace too, and `async function api(url, options, opts = {})` closed the
  // block on its own signature — the function came back as the two characters
  // "{}" and every assertion about its body silently passed or silently failed.
  let p = INDEX.indexOf('(', start), paren = 0;
  for (; p < INDEX.length; p++) {
    if (INDEX[p] === '(') paren++;
    else if (INDEX[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', p); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

type El = {
  hidden: boolean; innerHTML: string; textContent: string; title: string; value: string; disabled: boolean;
  dataset: Record<string, string>; style: Record<string, string>; cls: Set<string>; attrs: Record<string, string>;
  listeners: Record<string, Array<() => void>>; children: El[];
  classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => boolean; contains: (c: string) => boolean };
  setAttribute: (k: string, v: string) => void; getAttribute: (k: string) => string | null; removeAttribute: (k: string) => void;
  closest: () => null; querySelector: (sel: string) => El | null; querySelectorAll: () => El[];
  addEventListener: (n: string, fn: () => void) => void; focus: () => void; appendChild: (c: El) => El; remove: () => void;
};

function el(): El {
  const e: El = {
    hidden: false, innerHTML: '', textContent: '', title: '', value: '', disabled: false,
    dataset: {}, style: {}, cls: new Set(), attrs: {}, listeners: {}, children: [],
    classList: {
      add: (c) => { e.cls.add(c); }, remove: (c) => { e.cls.delete(c); },
      toggle: (c, on) => { const n = on === undefined ? !e.cls.has(c) : on; if (n) e.cls.add(c); else e.cls.delete(c); return n; },
      contains: (c) => e.cls.has(c),
    },
    setAttribute: (k, v) => { e.attrs[k] = v; }, getAttribute: (k) => e.attrs[k] ?? null, removeAttribute: (k) => { delete e.attrs[k]; },
    closest: () => null,
    // The retry row is found by its data attribute inside the innerHTML the
    // code just wrote; a stub element stands in for it and records clicks.
    querySelector: (sel) => (e.innerHTML.includes(sel.replace(/[[\]]/g, '')) ? (e.children[0] ??= el()) : null),
    querySelectorAll: () => [],
    addEventListener: (n, fn) => { (e.listeners[n] ??= []).push(fn); },
    focus: () => {}, appendChild: (c) => { e.children.push(c); return c; }, remove: () => {},
  };
  return e;
}

function makeDom() {
  const els: Record<string, El> = {};
  return { $: (id: string) => (els[id] ??= el()), els };
}

/* ══════════════ data-truth-3 (mirror) — the page's formatBytes never prints 1024 of a unit ══════════════ */

test('the page formatBytes rolls 1024 of a unit into the next unit, like the server copy must', () => {
  const src = braced('function formatBytes(');
  const fb = new Function('UNITS', `'use strict'; ${src} return formatBytes;`)(['B', 'KB', 'MB', 'GB', 'TB', 'PB']) as (n: number, d?: number) => string;
  assert.equal(fb(1048575), '1.0 MB', 'a hair under a mebibyte rounds up — into MB, not "1024.0 KB"');
  assert.equal(fb(1023.6), '1.0 KB', 'bytes that round to 1024 are a kibibyte');
  assert.equal(fb(1099511000000, 0), '1 TB', 'the tray\'s zero-decimal form rolls too');
  assert.equal(fb(1073741000), '1.0 MB'.replace('MB', 'GB'), 'and gibibytes');
  assert.equal(fb(1023.4), '1023 B', 'a value that does not round up stays where it is');
  assert.equal(fb(1536), '1.5 KB');
  assert.equal(fb(500), '500 B');
  assert.equal(fb(0), '0 B');
  assert.equal(fb(1024 ** 5 * 1023.99), '1024.0 PB', 'the last unit has nowhere to roll — it is allowed to say 1024');
  for (let e = 10; e <= 40; e++) {
    for (const f of [0.99995, 0.99999, 1]) {
      const s = fb(2 ** e * f);
      assert.doesNotMatch(s, /^1024(\.\d+)? [KMGT]B$/, `${2 ** e * f} → "${s}"`);
    }
  }
});

/* ══════════════ first-run-1 / first-run-4 — a refused folder is named, not congratulated ══════════════ */

type RefusedHarness = {
  render: () => void; probe: () => Promise<void>;
  els: Record<string, El>; state: Record<string, unknown>; toasts: string[]; asked: string[];
  $: (id: string) => El;
};

function refusedHarness(opts: {
  stats: Record<string, unknown> | null; root: Record<string, unknown>; scanId: string | null;
  platform?: string; refuse?: string[]; missing?: string[];
  /** What the previous scan left in `state.scanRefused` (null when omitted). */
  scanRefused?: Record<string, unknown> | null;
}): RefusedHarness {
  const src = slice('/* ── Refused folders ── */', '/* ── end refused folders ── */');
  const { $, els } = makeDom();
  const toasts: string[] = [];
  const asked: string[] = [];
  const state: Record<string, unknown> = {
    scanStats: opts.stats, root: opts.root, scanId: opts.scanId, scanRefused: opts.scanRefused ?? null,
    system: { platform: opts.platform || 'darwin', homeDir: '/Users/x' },
    pathIndex: new Map(Object.entries((opts.root.children as Array<{ path: string }> | undefined || []).reduce((m, c) => ({ ...m, [c.path]: c }), {}))),
  };
  const api = async (url: string) => {
    asked.push(url);
    const p = decodeURIComponent(url.split('path=')[1] || '');
    if ((opts.refuse || []).includes(p)) { const e = Object.assign(new Error('TreeMap isn’t allowed to read ' + p + '.'), { status: 403, code: 'PERMISSION_DENIED' }); throw e; }
    if ((opts.missing || []).includes(p)) { const e = Object.assign(new Error('not found'), { status: 404, code: 'PATH_NOT_FOUND' }); throw e; }
    return { entries: [] };
  };
  const fns = new Function('$', 'state', 'api', 'toast', 'icon', 'escapeHtml', 'formatCount', 'emit', 'TOPIC', 'window',
    `'use strict'; ${src} return { render: renderRefusedFolders, probe: probeRefusedFolders };`)(
    $, state, api, (m: string) => toasts.push(m), () => '', (s: string) => String(s), (n: number) => String(n), () => {}, { scan: 'scan' },
    { treemapDesktop: null, open: () => {} },
  ) as { render: () => void; probe: () => Promise<void> };
  return { render: fns.render, probe: fns.probe, els, state, toasts, asked, $ };
}

test('the server\'s refused count paints the dashboard row, names the folders, and says what to do on a Mac', () => {
  const h = refusedHarness({
    stats: { fileCount: 1200, refused: { dirs: 2, examples: ['/Users/x/Desktop', '/Users/x/Documents'] } },
    root: { path: '/Users/x', size: 5e9 }, scanId: 's1',
  });
  h.render();
  assert.equal(h.els.accessRow.hidden, false, 'the row shows');
  assert.match(h.els.accessText.textContent, /2 folders could not be read/, 'the count');
  assert.match(h.els.accessText.textContent, /Desktop, Documents/, 'named by their last path segment');
  assert.match(h.els.accessHint.textContent, /Full Disk Access/, 'the fix is named — macOS is protecting them');
  assert.doesNotMatch(h.els.accessHint.textContent, /TREEMAP_NO_GDU|errno|EACCES|403/, 'in plain words');
  assert.equal((h.state.scanRefused as { dirs: number }).dirs, 2, 'and the tour can read it');
  assert.equal(h.els.accessOpenBtn.hidden, false, 'the Privacy settings button is offered on macOS');
});

test('elsewhere the copy is about permissions, and the macOS button is hidden', () => {
  const h = refusedHarness({
    stats: { refused: { dirs: 1, examples: ['C:\\Users\\x\\Documents'] } },
    root: { path: 'C:\\Users\\x', size: 5e9 }, scanId: 's1', platform: 'win32',
  });
  h.render();
  assert.match(h.els.accessText.textContent, /1 folder could not be read/);
  assert.match(h.els.accessText.textContent, /Documents/);
  assert.match(h.els.accessHint.textContent, /permission/i);
  assert.doesNotMatch(h.els.accessHint.textContent, /Full Disk Access/);
  assert.equal(h.els.accessOpenBtn.hidden, true);
});

test('no refusals means no row — and an older server without the field is tolerated', () => {
  const h = refusedHarness({ stats: { fileCount: 10 }, root: { path: '/Users/x', size: 5e9, children: [{ path: '/Users/x/a', size: 5e9 }] }, scanId: 's1' });
  h.render();
  assert.equal(h.els.accessRow.hidden, true);
  assert.equal(h.state.scanRefused, null);
  const zero = refusedHarness({ stats: { refused: { dirs: 0, examples: [] } }, root: { path: '/Users/x', size: 5e9 }, scanId: 's1' });
  zero.render();
  assert.equal(zero.els.accessRow.hidden, true, 'dirs: 0 is "nothing refused"');
});

test('a clean scan clears the last scan\'s refused folders: the server\'s 0 is an answer, and a refusal belongs to its own scan (QA D46)', () => {
  // QA D46: after a /System/Library scan (69 refused) the corpus scan reported
  // refused.dirs 0, and the Scan card kept saying "69 folders could not be
  // read … Give TreeMap Full Disk Access": a 0 fell back to the old count.
  const seventyBefore = { dirs: 69, examples: ['/System/Library/AssetsV2', '/System/Library/Caches'], root: false, scanId: 's1' };
  const corpus = { path: '/Users/x/corpus', size: 5e9 };
  const clean = refusedHarness({ stats: { fileCount: 10, refused: { dirs: 0, examples: [] } }, root: corpus, scanId: 's2', scanRefused: seventyBefore });
  clean.$('accessRow').hidden = false; // as the last scan left it
  clean.render();
  assert.equal(clean.els.accessRow.hidden, true, 'the server counted 0 refusals for this scan: the row goes');
  assert.equal(clean.state.scanRefused, null, 'and the tour no longer reads the last scan\'s 69');
  // The server's count wins whenever it sent one, zero included — even over
  // what a probe said about the same scan.
  const zeroWins = refusedHarness({ stats: { refused: { dirs: 0, examples: [] } }, root: corpus, scanId: 's2', scanRefused: { ...seventyBefore, scanId: 's2' } });
  zeroWins.$('accessRow').hidden = false;
  zeroWins.render();
  assert.equal(zeroWins.els.accessRow.hidden, true, 'refused.dirs 0 is an answer, not a silence');
  assert.equal(zeroWins.state.scanRefused, null);

  // A server that sent no count, before this scan's own probe has answered:
  // the last scan's refusals still describe the last scan, not this one.
  const unsaid = refusedHarness({ stats: { fileCount: 10 }, root: corpus, scanId: 's2', scanRefused: seventyBefore });
  unsaid.$('accessRow').hidden = false;
  unsaid.render();
  assert.equal(unsaid.els.accessRow.hidden, true, 'another scan\'s refusals are never shown for this one');
  assert.equal(unsaid.state.scanRefused, null, 'nor left for the tour to read as this scan\'s');

  // What the probe found for THIS scan is shown, and what the server counts is stamped with the scan it came from.
  const probed = refusedHarness({ stats: { fileCount: 10 }, root: corpus, scanId: 's2', scanRefused: { ...seventyBefore, dirs: 1, scanId: 's2' } });
  probed.render();
  assert.equal(probed.els.accessRow.hidden, false, 'this scan\'s own probe answer still paints');
  assert.match(probed.$('accessText').textContent, /^1 folder could not be read/);
  const counted = refusedHarness({ stats: { refused: { dirs: 3, examples: ['/Users/x/corpus/a'] } }, root: corpus, scanId: 's2', scanRefused: seventyBefore });
  counted.render();
  assert.match(counted.$('accessText').textContent, /^3 folders could not be read — a$/, 'the server\'s count, not the last scan\'s');
  assert.equal((counted.state.scanRefused as { scanId: string } | null)?.scanId, 's2', 'stamped with the scan it describes');
});

test('with no refused field, a 0-byte root is probed — a 403 turns "clean" into "could not read"', async () => {
  const h = refusedHarness({
    stats: { fileCount: 0, dirCount: 1 }, root: { path: '/Users/x/Documents', size: 0, children: [] }, scanId: 's1',
    refuse: ['/Users/x/Documents'],
  });
  h.render();
  await h.probe();
  assert.ok(h.asked.some((u) => u.startsWith('/api/fs/list?path=')), 'the picker\'s listing endpoint is the one-call probe');
  const r = h.state.scanRefused as { dirs: number; root: boolean; examples: string[] };
  assert.equal(r.dirs, 1); assert.equal(r.root, true, 'the scanned folder itself was refused');
  assert.equal(h.els.accessRow.hidden, false);
  assert.equal(h.els.scanStatus.cls.has('error'), true, 'the status line stops saying "Scanned 0 files"');
  assert.match(h.els.scanStatus.innerHTML, /would not let TreeMap look inside|not allowed to read/i);
  assert.ok(h.toasts.some((t) => /Full Disk Access/.test(t)), 'and a toast says what to do');
});

test('the probe checks Desktop, Documents and Downloads under a home-folder scan, and drops a stale answer', async () => {
  const h = refusedHarness({
    stats: { fileCount: 100 }, scanId: 's1',
    root: { path: '/Users/x', size: 5e9, children: [{ path: '/Users/x/Desktop', size: 0, children: [] }, { path: '/Users/x/Library', size: 5e9 }] },
    refuse: ['/Users/x/Desktop', '/Users/x/Downloads'], missing: ['/Users/x/Documents'],
  });
  h.render();
  await h.probe();
  const r = h.state.scanRefused as { dirs: number; root: boolean; examples: string[] };
  assert.equal(r.dirs, 2, 'two of the three protected folders were refused; the missing one is not counted');
  assert.equal(r.root, false);
  assert.deepEqual(r.examples, ['/Users/x/Desktop', '/Users/x/Downloads']);
  assert.ok(!h.asked.some((u) => u.includes('Library')), 'a folder the scan read is not probed');
  // A rescan lands while the probe is in flight: its answer describes a tree that is gone.
  const stale = refusedHarness({ stats: { fileCount: 1 }, scanId: 's1', root: { path: '/Users/x', size: 1, children: [] }, refuse: ['/Users/x/Desktop'] });
  stale.render();
  const p = stale.probe();
  stale.state.scanId = 's2';
  await p;
  assert.equal(stale.state.scanRefused, null, 'a superseded probe paints nothing');
});

/* ══════════════ Track U U-3 — the Full Disk Access button asks the desktop shell, by name ══════════════ */

/**
 * The button's handler and its wiring, out of the built page. `bridge` stands
 * in for window.treemapDesktop: undefined is a browser tab. Every call the
 * page makes — to the bridge, to window.open, to toast — is counted.
 */
function privacyButtonHarness(bridge: unknown) {
  const handler = braced('async function openFullDiskAccessSettings(');
  const wiring = slice("$('accessOpenBtn').addEventListener('click'", '/* ── Scan queue ── */');
  const { $, els } = makeDom();
  const toasts: string[] = [];
  const windowOpens: unknown[][] = [];
  const win = { treemapDesktop: bridge, open: (...args: unknown[]) => { windowOpens.push(args); return null; } };
  const run = new Function('$', 'window', 'toast', `'use strict'; ${handler}\n${wiring}\nreturn openFullDiskAccessSettings;`)(
    $, win, (m: string) => toasts.push(m),
  ) as () => Promise<void>;
  const click = async (): Promise<void> => {
    for (const fn of els.accessOpenBtn.listeners.click || []) fn();
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); // let the bridge's answer land
  };
  return { run, click, toasts, windowOpens, els };
}

/** A bridge whose openPrivacySettings answers with `answer` (a function may throw or reject), recording each pane asked for. */
function privacyBridge(answer: () => unknown) {
  const panes: unknown[] = [];
  return { panes, bridge: { openPrivacySettings: (pane: unknown) => { panes.push(pane); return answer(); } } };
}

test('the Full Disk Access button asks the desktop shell for the pane by name: one bridge call, no window.open, no toast', async () => {
  const { panes, bridge } = privacyBridge(async () => ({ opened: true }));
  const h = privacyButtonHarness(bridge);
  assert.equal((h.els.accessOpenBtn.listeners.click || []).length, 1, 'the button has one click handler');
  await h.click();
  assert.deepEqual(panes, ['full-disk-access'], 'one bridge call, naming the pane — never a URL');
  assert.equal(h.windowOpens.length, 0, 'no window.open: the shell refuses x-apple URLs there (U-D16)');
  assert.equal(h.toasts.length, 0, 'System Settings opened, so there is nothing to say');
  assert.doesNotMatch(INDEX, /x-apple\.systempreferences/, 'the page holds no settings URL at all: the shell owns it');
});

test('without a bridge that opened the pane, the button says the path in words — once — and never calls window.open', async () => {
  const cases: Array<[string, unknown]> = [
    ['a browser tab (no desktop bridge)', undefined],
    ['an older shell without openPrivacySettings', { getPathForFile: () => '' }],
    ['the shell answering opened: false', privacyBridge(async () => ({ opened: false, reason: 'Full Disk Access is a macOS setting.' })).bridge],
    ['the shell answering nothing usable', privacyBridge(async () => undefined).bridge],
    ['the bridge rejecting', privacyBridge(async () => { throw new Error('the IPC channel closed'); }).bridge],
    ['the bridge throwing before it answers', privacyBridge(() => { throw new Error('not a function of this shell'); }).bridge],
  ];
  for (const [what, bridge] of cases) {
    const h = privacyButtonHarness(bridge);
    await assert.doesNotReject(h.run(), `${what}: the handler settles instead of leaving a rejection behind`);
    assert.equal(h.toasts.length, 1, `${what}: one toast`);
    assert.match(h.toasts[0], /System Settings › Privacy & Security › Full Disk Access/, `${what}: it names the pane in words`);
    assert.equal(h.windowOpens.length, 0, `${what}: no window.open`);
  }
});

/**
 * finishScan out of the built page, executed with the index-first stub list
 * plus the names later rounds added. `indexBuilds` records the arguments of
 * every background index build it starts.
 */
function finishScanHarness(over: Record<string, unknown> = {}) {
  const src = slice('async function finishScan', 'function renderDiskNotes()');
  const { $, els } = makeDom();
  const toasts: string[] = [];
  const indexBuilds: unknown[][] = [];
  const noop = () => {};
  const state: Record<string, unknown> = {
    scanId: 's1', treemap: { rootPath: '' }, grid: { path: '', selection: new Set() }, apps: { loadedFor: 'x' },
    view: 'dashboard', live: { wanted: false }, scanStats: null, root: null,
  };
  const deps: Record<string, unknown> = {
    $, state, endScanChrome: noop, indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 100, icon: () => '',
    formatCount: (n: number | null) => String(n ?? 0), formatBytes: (n: number) => n + ' B', escapeHtml: (s: string) => s,
    countUp: noop, FxNum: { rollText: noop }, renderDiskNotes: noop, loadWhatsNew: noop, loadDriveHealth: noop,
    loadCostEstimate: noop, showListsPending: noop, emit: noop, TOPIC: { scan: 'scan' }, switchView: noop,
    toast: (m: string) => toasts.push(m), fxScanDonePulse: noop, loadDashboardLists: async () => {},
    buildIndexInBackground: (...args: unknown[]) => { indexBuilds.push(args); },
    renderGrowthProjection: noop, loadBudgets: noop, refreshTimebar: noop, enableLive: noop, seedNodes: noop,
    setTimeout: noop, fxDonutLoadingSync: noop, renderRefusedFolders: noop, probeRefusedFolders: async () => {},
    armScanExpiry: noop, formatClock: () => '10:31 PM',
    ...over,
  };
  const finishScan = new Function(...Object.keys(deps), `'use strict'; ${src} return finishScan;`)(
    ...Object.values(deps),
  ) as (root: unknown, ms: number, stats: unknown, opts?: { reopenedAt?: number }) => Promise<void>;
  return { finishScan, els, toasts, state, indexBuilds };
}

test('finishScan hands the index build the folder and the scan\'s own stats (Track U review of U-1, finding 9)', async () => {
  // The plan (U-1) decides from the finished scan's count. Dropped, the count
  // reads as unknown, the plan answers 'none' for every scan, and nothing is
  // ever indexed again — with no error anywhere.
  const h = finishScanHarness();
  const stats = { fileCount: 1200, dirCount: 30, scanned: 1230, engine: 'native' };
  await h.finishScan({ path: '/Users/x/Projects', size: 5e9 }, 50, stats);
  assert.equal(h.indexBuilds.length, 1, 'one build is considered per completed scan');
  assert.equal(h.indexBuilds[0][0], '/Users/x/Projects', 'for the folder the scan read');
  assert.equal(h.indexBuilds[0][1], stats, 'with the stats that scan finished with');
  await h.finishScan({ path: '', size: 1 }, 50, stats);
  assert.equal(h.indexBuilds.length, 1, 'a tree with no folder path starts none');
});

test('a scan reopened after a reload says when it ran, and is not announced as a new completion (QA D57)', async () => {
  const rolled: string[] = [];
  const pulses: number[] = [];
  const h = finishScanHarness({
    formatClock: (ms: number) => `clock(${ms})`,
    FxNum: { rollText: (_el: unknown, t: string) => { rolled.push(t); } },
    fxScanDonePulse: () => { pulses.push(1); },
  });
  const F = 1_700_000_000_000;
  await h.finishScan({ path: '/Users/x/corpus', size: 8800 }, 200, { fileCount: 101034, durationMs: 200 }, { reopenedAt: F });
  assert.deepEqual(h.toasts, [], 'no "Scan complete": it completed before the reload, and said so then');
  assert.deepEqual(pulses, [], 'nor the completion pulse');
  assert.match(h.els.scanStatus.innerHTML, /Reopened the scan from clock\(1700000000000\) — <b>101034<\/b> files, 8800 B in \/Users\/x\/corpus/,
    'the card says it is the scan from then, not a scan just made');
  assert.match(h.els.scanAnnounce.textContent, /^Reopened the last scan — /);
  assert.deepEqual(rolled, [`clock(${F})`], 'Last scan is when it ran');
  assert.equal((h.state.lastScan as { when: number }).when, F, 'and What\'s new looks for that scan\'s snapshot');
  assert.equal((h.state.lastScan as { reopened: boolean }).reopened, true, 'knowing it was reopened, so today\'s settings do not describe it (review M1)');
  // A scan that has just completed still announces itself.
  await h.finishScan({ path: '/Users/x/corpus', size: 8800 }, 200, { fileCount: 101034, durationMs: 200 });
  assert.equal(h.toasts.length, 1);
  assert.match(h.els.scanStatus.innerHTML, /Scanned <b>101034<\/b> files in/);
  assert.equal((h.state.lastScan as { reopened: boolean }).reopened, false);
});

test('a refused scan is never toasted as a clean success, and the tour refuses the "clean" card', async () => {
  const { finishScan, els, toasts } = finishScanHarness();
  const noop = () => {};
  await finishScan({ path: '/Users/x/Documents', size: 0, children: [] }, 50, { fileCount: 0, dirCount: 1, scanned: 1 });
  assert.equal(toasts.length, 0, 'nothing to celebrate about 0 B in 0 files — the refused probe speaks instead');
  assert.match(els.scanAnnounce.textContent, /scan/i, 'the screen reader still hears that the scan finished');
  await finishScan({ path: '/Users/x', size: 5e9 }, 50, { fileCount: 1200, refused: { dirs: 3, examples: [] } });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /3 folders could not be read/, 'a partial scan says so in its completion toast');

  // The card names the OS that refused (issue #33): the two word helpers ride
  // along with the function, exactly as they sit in the built page.
  const wins = [braced('function platformWord('), braced('function refusedFolderWords('), braced('async function tourLoadWins(')].join('\n');
  const refusedOn = async (system: { platform: string } | undefined) => {
    const tour: Record<string, unknown> = { step: 'map', wins: [], winIx: 0, unknownReason: '' };
    const run = new Function('state', 'api', 'tour', 'tourRender', `'use strict'; ${wins} return tourLoadWins;`)(
      { scanId: 's1', system, scanRefused: { dirs: 1, root: true, examples: ['/Users/x/Documents'] } }, async () => ({ groups: [] }), tour, noop,
    ) as () => Promise<void>;
    await run();
    assert.equal(tour.step, 'unknown', 'an unread folder is "could not check", never "looks clean"');
    return String(tour.unknownReason);
  };
  assert.match(await refusedOn({ platform: 'darwin' }), /^macOS would not let TreeMap look inside this folder, so nothing here has been checked\.$/);
  assert.match(await refusedOn({ platform: 'win32' }), /^Windows would not let TreeMap look inside this folder, so nothing here has been checked\.$/, 'a Windows user is not told about macOS');
  assert.match(await refusedOn(undefined), /^TreeMap was not allowed to look inside this folder, so nothing here has been checked\.$/, 'before /api/system has answered, no OS is named');
  const clean: Record<string, unknown> = { step: 'map', wins: [], winIx: 0, unknownReason: '' };
  await (new Function('state', 'api', 'tour', 'tourRender', `'use strict'; ${wins} return tourLoadWins;`)(
    { scanId: 's1', scanRefused: null }, async () => ({ groups: [] }), clean, noop) as () => Promise<void>)();
  assert.equal(clean.step, 'clean', 'a genuinely empty answer still earns the honest "clean"');
});

/* ══════════════ first-run-2 / first-run-3 — the tour narrates the view on screen ══════════════ */

test('the first scan of the tour puts the map on screen before the card talks about rectangles', async () => {
  const block = slice('/* ───────────────────── v4 §9.2', '/* ───────────── end §9.2');
  const at = block.indexOf('subscribe(TOPIC.scan,');
  assert.notEqual(at, -1, 'the tour subscribes to scan completion');
  let depth = 0, end = at;
  for (let i = block.indexOf('{', at); i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}' && --depth === 0) { end = block.indexOf(')', i) + 1; break; }
  }
  const src = block.slice(at, end);
  let handler: ((id: unknown) => void) | null = null;
  const switched: string[] = [];
  const tasks: Array<() => void> = [];
  const tour = { active: true, step: 'welcome' };
  const state = { root: { path: '/Users/x' }, view: 'dashboard' };
  new Function('subscribe', 'TOPIC', 'tour', 'state', 'switchView', 'tourRender', 'queueMicrotask', `'use strict'; ${src}`)(
    (_t: string, fn: (id: unknown) => void) => { handler = fn; }, { scan: 'scan' }, tour, state,
    (v: string) => { switched.push(v); state.view = v; }, () => {}, (fn: () => void) => tasks.push(fn));
  handler!('s1');
  assert.equal(tour.step, 'map');
  assert.deepEqual(switched, [], 'not yet — finishScan\'s own switchView(state.view) runs synchronously after this');
  tasks.splice(0).forEach((fn) => fn());
  assert.deepEqual(switched, ['treemap'], 'the map comes up once finishScan is done re-entering the dashboard');
  // A later scan, with the tour past the welcome step, leaves the view alone.
  tour.step = 'win'; state.view = 'dashboard';
  handler!('s2'); tasks.splice(0).forEach((fn) => fn());
  assert.deepEqual(switched, ['treemap']);
});

test('pressing "Scan my home folder" changes the card: a scanning step, entered from every scan start', () => {
  const render = braced('function tourRender(');
  assert.match(render, /tour\.step === 'scanning'/, 'the card has a scanning step');
  const { $, els } = makeDom();
  const host = els.tourCard = el();
  host.querySelector = () => null;
  const tour = { active: true, step: 'scanning', wins: [], winIx: 0, staged: 0, unknownReason: '' };
  const fn = new Function('$', 'tour', 'state', 'icon', 'escapeHtml', 'formatBytes', 'startScan', 'openBrowse', 'tourLoadWins', 'tourFinish', 'cartAddMany', 'tourAdvanceWin', 'document',
    `'use strict'; ${render} return tourRender;`)(
    $, tour, { system: { homeDir: '/Users/x' }, cart: new Set() }, () => '', (s: string) => s, (n: number) => n + ' B',
    () => {}, () => {}, () => {}, () => {}, () => 0, () => {}, { activeElement: null }) as () => void;
  fn();
  assert.match(host.innerHTML, /Reading your files|Measuring/i, 'the card says what is happening');
  assert.match(host.innerHTML, /data-tour-skip/, 'and stays skippable');
  assert.doesNotMatch(host.innerHTML, /data-tour-home|data-tour-pick/, 'the two start buttons are gone — a second press cannot earn a red toast');
  const started = braced('function tourScanStarted(');
  const failed = braced('function tourScanFailed(');
  const t2 = { active: true, step: 'welcome' };
  const calls: string[] = [];
  const api = new Function('tour', 'tourRender', `'use strict'; ${started}\n${failed}\nreturn { tourScanStarted, tourScanFailed };`)(t2, () => calls.push('render')) as { tourScanStarted: () => void; tourScanFailed: () => void };
  api.tourScanStarted();
  assert.equal(t2.step, 'scanning');
  api.tourScanFailed();
  assert.equal(t2.step, 'welcome', 'a failed scan puts the welcome card back');
  t2.step = 'map'; api.tourScanStarted();
  assert.equal(t2.step, 'map', 'a later rescan does not drag the tour backwards');
  assert.deepEqual(calls, ['render', 'render']);
  assert.match(slice('function beginScanChrome(', 'function endScanChrome('), /tourScanStarted\(\)/, 'every scan start — Browse, ⌘K, drop, the card — tells the tour');
  assert.match(braced('function failScan('), /tourScanFailed\(\)/, 'and every failure');
  assert.match(block(), /tour\.step === 'welcome' \|\| tour\.step === 'scanning'/, 'completion advances from either step');
  function block() { return slice('/* ───────────────────── v4 §9.2', '/* ───────────── end §9.2'); }
});

/* ══════════════ states-errors-1 — a quiet rescan that fails ends the chrome ══════════════ */

test('a failed background rescan clears the spinner, the skeletons and the Stop button — and says so', () => {
  const req = slice('async function startScanRequest', 'function followScanProgress(scanId, path, fast, t0) {');
  assert.match(req, /catch \(e\) \{[\s\S]{0,120}if \(quiet\) \{[\s\S]{0,120}return; \}[\s\S]{0,40}failScan\(e\.message\)/, 'the quiet short-circuit is still ahead of failScan');
  assert.match(req, /if \(quiet\) \{ quietRescanFailed\(e\); return; \}/, 'but it no longer returns in silence');
  const fn = braced('function quietRescanFailed(');
  const { $, els } = makeDom();
  const calls: string[] = [];
  const toasts: Array<[string, string]> = [];
  const run = new Function('$', 'endScanChrome', 'restoreDashboardPanels', 'icon', 'escapeHtml', 'toast', 'drainScanQueue', 'state',
    `'use strict'; ${fn} return quietRescanFailed;`)(
    $, () => calls.push('end'), () => calls.push('restore'), () => '', (s: string) => s, (m: string, k: string) => toasts.push([m, k]), () => calls.push('drain'),
    { scanning: true }) as (e: Error) => void;
  assert.equal(INDEX.split('function quietRescanFailed(').length - 1, 1, 'one definition: a second one silently replaced the first, whose messages never showed');
  run(new Error('That folder no longer exists.'));
  assert.deepEqual(calls.slice(0, 2), ['end', 'restore'], 'the chrome ends and the honest panels come back');
  assert.equal(els.scanStatus.cls.has('error'), true);
  assert.match(els.scanStatus.innerHTML, /saved index/i, 'the tree on screen is named for what it is');
  assert.match(els.scanStatus.innerHTML, /Showing the saved index — the refresh failed: That folder no longer exists\./, 'with the reason');
  assert.equal(els.scanAnnounce?.textContent, 'Couldn’t refresh this folder: That folder no longer exists.', 'a screen reader hears it too');
  assert.equal(els.indexBadge.cls.has('stale'), true, '"Index live — always current" is no longer claimed');
  assert.deepEqual(toasts, [['Couldn’t refresh this folder: That folder no longer exists.', 'error']]);
  assert.deepEqual(calls.slice(2), ['drain'], 'a folder waiting behind this one still gets its turn');
  // A rejection that is not an Error still ends the chrome and says something.
  toasts.length = 0;
  assert.doesNotThrow(() => run(undefined as unknown as Error), 'an answer with no message cannot leave the spinner up');
  assert.deepEqual(toasts, [['Couldn’t refresh this folder: the folder could not be read', 'error']]);
});

/* ══════════════ states-errors-3 — a small folder is never a blank canvas ══════════════ */

test('nothing above the 4 KB floor: the map re-asks without the floor, and an empty answer is said out loud', () => {
  const load = braced('async function loadTreemap(');
  const floorAt = load.indexOf('minSize=4096');
  const retryAt = load.indexOf('minSize=1&');
  assert.ok(floorAt !== -1 && retryAt > floorAt, 'the floor is dropped when it would draw nothing');
  assert.match(load.slice(floorAt, retryAt), /!data\.nodes\.length && data\.root\.size > 0/, 'only when the folder has bytes the floor hid');
  const draw = braced('function drawTreemap(');
  const emptyAt = draw.indexOf('if (!px.length)');
  const passOne = draw.indexOf('// Pass 1');
  assert.ok(emptyAt !== -1 && emptyAt < passOne, 'the empty branch runs before any painting pass');
  assert.match(draw.slice(emptyAt, emptyAt + 400), /tmSetEmpty\(/);
  const setEmpty = braced('function tmSetEmpty(');
  const { $, els } = makeDom();
  const fn = new Function('$', `'use strict'; ${setEmpty} return tmSetEmpty;`)($) as (t: string) => void;
  fn('This folder is empty.');
  assert.equal(els.tmEmpty.hidden, false);
  assert.equal(els.tmEmpty.textContent, 'This folder is empty.');
  fn('');
  assert.equal(els.tmEmpty.hidden, true, 'a painted map hides the note');
  assert.match(INDEX, /<div id="tmEmpty"[^>]*role="status"/, 'the note is announced');
  const sun = load.slice(0, floorAt);
  assert.match(sun, /tmSetEmpty\(''\)/, 'the sunburst and cell renderers clear a note the rectangle map left');
});

/* ══════════════ states-errors-5 — the watchdog gives up on a dead server ══════════════ */

test('five unreachable polls in a row end the scan as failed instead of spinning forever', async () => {
  const src = slice('function followScanProgress(', 'async function startCloudScan(');
  const { $ } = makeDom();
  const timers: Array<{ fn: () => Promise<void>; ms: number; cleared: boolean }> = [];
  let now = 0;
  const failed: string[] = [];
  const state: Record<string, unknown> = { scanning: true, scanId: null, es: null, abortScan: null };
  class FakeES { onmessage: unknown = null; onerror: unknown = null; readyState = 0; static CLOSED = 2; close() {} }
  const api = async () => { throw Object.assign(new Error('Couldn’t reach TreeMap'), { status: 0, code: 'OFFLINE' }); };
  const follow = new Function('$', 'state', 'api', 'EventSource', 'performance', 'setInterval', 'clearInterval', 'closeEventSource', 'failScan',
    'finishScan', 'rememberScannedRoot', 'showFastRescanStat', 'scanStatsFor', 'formatCount', 'escapeHtml', 'icon',
    `'use strict'; ${src} return followScanProgress;`)(
    $, state, api, FakeES, { now: () => now },
    (fn: () => Promise<void>, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    (t: { cleared: boolean }) => { if (t) t.cleared = true; },
    () => { state.es = null; }, (m: string) => { failed.push(m); state.scanning = false; },
    () => {}, () => {}, () => {}, async () => ({}), (n: number) => String(n), (s: string) => s, () => '',
  ) as (id: string, p: string, fast: boolean, t0: number) => void;
  follow('s1', '/Users/x', false, 0);
  const dog = timers[0];
  assert.equal(dog.ms, 3000, 'the watchdog ticks every three seconds');
  now = 10_000; // the stream has been silent for longer than the 6 s grace
  for (let i = 0; i < 4; i++) { await dog.fn(); await Promise.resolve(); }
  assert.deepEqual(failed, [], 'four misses are still "transient"');
  await dog.fn(); await Promise.resolve();
  assert.equal(failed.length, 1, 'the fifth consecutive miss ends the scan');
  assert.match(failed[0], /reach TreeMap/, 'with the transport\'s own sentence, which says to check the app is running');
  assert.equal(dog.cleared, true, 'and the watchdog stops');
  assert.equal(state.scanning, false);
});

test('a single transient miss between good polls does not count toward giving up', async () => {
  const src = slice('function followScanProgress(', 'async function startCloudScan(');
  assert.match(src, /dead = 0/, 'a good answer resets the count');
  assert.match(src, /e\.status === 0 \|\| e\.code === 'BAD_RESPONSE' \|\| \(e\.status >= 502 && e\.status <= 504\)/,
    'only "nobody answered" shapes count — a 429 or a 202 is still a live server');
});

/* ══════════════ states-errors-6 — three lists that failed say so, with a retry ══════════════ */

type ListsHarness = { run: () => Promise<boolean>; els: Record<string, El>; state: Record<string, unknown>; rendered: string[] };
function listsHarness(fail: string | null, opts: { pending?: boolean } = {}): ListsHarness {
  const src = braced('async function loadDashboardLists(');
  const { $, els } = makeDom();
  const rendered: string[] = [];
  const state: Record<string, unknown> = { scanId: 's1', largest: [], types: [], bigFolders: [], donut: { animated: true } };
  const api = async (url: string) => {
    if (fail && url.includes(fail)) throw new Error('The server answered 500 with nothing TreeMap could read.');
    if (url.includes('large-files')) return { files: [{ name: 'a.mov', path: '/x/a.mov', size: 9 }] };
    if (url.includes('file-types')) return { types: [{ ext: 'mov', totalSize: 9, count: 1 }] };
    return { folders: [{ name: 'x', path: '/x', size: 9, fileCount: 1 }] };
  };
  const run = new Function('$', 'state', 'api', 'seedNodes', 'formatBytes', 'escapeHtml', 'refreshBigFiles', 'renderBigFolders', 'renderDonut', 'fxDonutLoadingSync', 'toast',
    `'use strict'; ${src} return loadDashboardLists;`)(
    $, state, api, () => {}, (n: number) => n + ' B', (s: string) => s,
    () => rendered.push('files'), () => rendered.push('folders'), () => rendered.push('donut'), (on: boolean) => rendered.push('veil:' + on), () => rendered.push('toast'),
  ) as () => Promise<boolean>;
  return { run, els, state, rendered };
}

test('when one of the three fetches fails, the cards say "couldn\'t load" with a Try again — never "No files found."', async () => {
  const h = listsHarness('file-types');
  const ok = await h.run();
  assert.equal(ok, false);
  for (const id of ['bigFiles', 'bigFolders', 'donutLegend']) {
    assert.match(h.els[id].innerHTML, /Couldn.t load this list/, `#${id} is honest`);
    assert.match(h.els[id].innerHTML, /data-retry-lists/, `#${id} offers a retry`);
    assert.doesNotMatch(h.els[id].innerHTML, /No files found|No folders above/, `#${id} never claims the folder is empty`);
  }
  assert.ok(!h.rendered.includes('files') && !h.rendered.includes('folders'), 'the empty-array renderers did not run over the error rows');
  assert.ok(h.rendered.includes('veil:false'), 'the donut\'s loading veil is lifted');
  // Try again re-runs only the lists.
  const retry = h.els.bigFiles.children[0];
  assert.ok(retry && retry.listeners.click?.length, 'the Try again button is wired');
});

test('when all three answer, the state is filled and the renderers run once each', async () => {
  const h = listsHarness(null);
  const ok = await h.run();
  assert.equal(ok, true);
  assert.equal((h.state.largest as unknown[]).length, 1);
  assert.equal((h.state.types as unknown[]).length, 1);
  assert.equal((h.state.bigFolders as unknown[]).length, 1);
  assert.match(h.els.statLargest.textContent, /a\.mov/);
  assert.deepEqual(h.rendered.filter((r) => !r.startsWith('veil')), ['files', 'folders', 'donut']);
  // U-16: finishScan hands the lists' promise to the cost card before awaiting it, so the card can wait for them.
  assert.match(slice('async function finishScan', 'function renderDiskNotes()'), /const lists = loadDashboardLists\(\);[\s\S]*?await lists;/, 'finishScan goes through the same door, and waits for it');
});

test('an answer for a scan that has since been replaced is dropped', async () => {
  const src = braced('async function loadDashboardLists(');
  assert.match(src, /const scanId = state\.scanId/, 'the id is captured before the awaits');
  assert.match(src, /scanId !== state\.scanId\) return/, 'and a stale answer returns without painting');
});

/* ══════════════ states-errors-7 — expired results offer a rescan ══════════════ */

test('an "expired scanId" error becomes a plain sentence with a one-click Scan again', () => {
  const fn = braced('function scanResultsExpired(');
  const offers: Array<[string, string]> = [];
  const state = { root: { path: '/Users/x' }, scanning: false, scanId: 'abc123' };
  const run = new Function('state', 'toastAction', 'startScan', `'use strict'; ${fn} return scanResultsExpired;`)(
    state, (m: string, label: string) => offers.push([m, label]), () => {}) as (err: Record<string, unknown>, url: string) => void;
  const err: Record<string, unknown> = { code: 'SCAN_NOT_FOUND', status: 404, message: 'Unknown or expired scanId' };
  run(err, '/api/scan/abc123/treemap?root=x');
  assert.match(String(err.message), /expired/i, 'the message is rewritten');
  assert.doesNotMatch(String(err.message), /scanId/, 'no jargon');
  assert.equal(offers.length, 1);
  assert.equal(offers[0][1], 'Scan again');
  run(err, '/api/duplicates?scanId=abc123');
  assert.equal(offers.length, 1, 'one offer per expired scan, however many calls fail');
  const other: Record<string, unknown> = { code: 'SCAN_NOT_FOUND', status: 404, message: 'Unknown or expired scanId' };
  run(other, '/api/scan/OLD/treemap');
  assert.equal(other.message, 'Unknown or expired scanId', 'an id that is not the one on screen is somebody else\'s problem');
  assert.match(braced('async function api('), /SCAN_NOT_FOUND/, 'api() is where every such error passes through');
});

test('when the server says when results expire, the page warns two minutes ahead', () => {
  const fn = braced('function armScanExpiry(');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const offers: string[] = [];
  const state: Record<string, unknown> = { scanId: 's1', scanStats: { expiresAt: 1_000_000 + 10 * 60_000 } };
  const arm = new Function('state', 'toastAction', 'rescan', 'setTimeout', 'clearTimeout', 'Date',
    `'use strict'; ${fn} return armScanExpiry;`)(
    state, (m: string) => offers.push(m), () => {}, (cb: () => void, ms: number) => { timers.push({ fn: cb, ms }); return timers.length; }, () => {},
    { now: () => 1_000_000 }) as () => void;
  arm();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 8 * 60_000, 'ten minutes to expiry: the warning is scheduled two minutes before');
  timers[0].fn();
  assert.equal(offers.length, 1);
  assert.match(offers[0], /expire/i);
  state.scanStats = { fileCount: 3 };
  arm();
  assert.equal(timers.length, 1, 'an older server without expiresAt schedules nothing');
  state.scanStats = { expiresAt: 1_000_000 + 30_000 };
  arm();
  assert.equal(timers[timers.length - 1].ms, 0, 'already inside the two-minute window: warn now');
});

/* ══════════════ a11y-keyboard-5 — a screen reader hears the scan ══════════════ */

test('the scan speaks: start, progress every ten seconds, finish and failure', () => {
  assert.match(INDEX, /<div id="scanAnnounce"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/, 'one polite live region');
  assert.match(INDEX, /<div class="progress-track" id="progressTrack" role="progressbar" aria-label="Scan progress"/, 'the bar is a progressbar');
  assert.match(slice('function beginScanChrome(', 'function endScanChrome('), /\$\('scanAnnounce'\)\.textContent = /, 'start');
  assert.match(braced('function failScan('), /\$\('scanAnnounce'\)\.textContent = /, 'failure');
  assert.match(slice('async function finishScan', 'if (!state.scanId) {'), /\$\('scanAnnounce'\)\.textContent = /, 'completion');
  const follow = slice('function followScanProgress(', 'async function startCloudScan(');
  assert.match(follow, /lastAnnounced/, 'progress is throttled — every frame would drown the user');
  assert.match(follow, /secs - lastAnnounced >= 10/, 'to one sentence every ten seconds');
  assert.match(follow, /\$\('progressTrack'\)\.setAttribute\('aria-valuetext'/, 'and the bar states its count');
});

/* ══════════════ desktop-polish-8 — drag feedback and a queue of dropped folders ══════════════ */

test('dragging a folder over the window lights a drop hint, and leaving it puts the hint out', () => {
  const src = slice('/* ── Drop a folder to scan it ── */', '/* ── end drop ── */');
  assert.match(src, /window\.addEventListener\('dragenter'/);
  assert.match(src, /window\.addEventListener\('dragleave'/);
  assert.match(src, /dragDepth/, 'nested dragenter/dragleave pairs are counted, so the hint does not flicker over child elements');
  assert.match(src, /classList\.add\('drop-hint'\)/);
  assert.match(src, /classList\.remove\('drop-hint'\)/);
  assert.match(src, /includes\('Files'\)/, 'only a file drag lights it — the cart\'s own drag does not');
  const layer = /<div id="dropHint"[^>]*>/.exec(INDEX);
  assert.ok(layer, 'the hint layer exists');
  assert.match(layer![0], /aria-hidden="true"/, 'it is decoration for the pointer, not for a screen reader');
  assert.doesNotMatch(layer![0], /backdrop-filter/, 'no backdrop-filter on a full-screen layer');
  assert.doesNotMatch(layer![0], /will-change/);
});

test('dropping several folders scans them in order — none is silently ignored', async () => {
  const src = slice('/* ── Drop a folder to scan it ── */', '/* ── end drop ── */');
  assert.match(src, /for \(const file of/, 'every dropped item is resolved');
  assert.match(src, /queueScan\(/, 'and handed to the queue');
  const q = slice('/* ── Scan queue ── */', '/* ── end scan queue ── */');
  const started: string[] = [];
  const toasts: string[] = [];
  const state = { scanning: false };
  let onScan: ((id: unknown) => void) | null = null;
  // The harness owns the clock. Draining is deliberately deferred a tick in
  // the page — the finishing scan's own repaint goes first — and running the
  // callback inline here keeps these assertions about ORDER, which is the
  // invariant, rather than about how many turns of the event loop it took.
  const api = new Function('state', 'startScan', 'toast', 'subscribe', 'TOPIC', 'escapeHtml', 'setTimeout', '$',
    `'use strict'; ${q} return { queueScan, drainScanQueue, clearScanQueue };`)(
    state, (p: string) => { started.push(p); state.scanning = true; }, (m: string) => toasts.push(m),
    (_t: string, fn: (id: unknown) => void) => { onScan = fn; }, { scan: 'scan' }, (s: string) => s,
    (fn: () => void) => { fn(); return 0; }, () => el(),
  ) as { queueScan: (p: string) => void; drainScanQueue: () => void; clearScanQueue: () => void };
  api.queueScan('/a'); api.queueScan('/b'); api.queueScan('/c'); api.queueScan('/b');
  assert.deepEqual(started, ['/a'], 'the first starts at once');
  assert.ok(toasts.some((t) => /queued|next/i.test(t)), 'the others are acknowledged, not dropped');
  state.scanning = false; onScan!('s1');
  assert.deepEqual(started, ['/a', '/b'], 'completion starts the next, in order');
  state.scanning = false; onScan!('s2');
  assert.deepEqual(started, ['/a', '/b', '/c'], 'a folder queued twice runs once');
  state.scanning = false; onScan!('s3');
  assert.deepEqual(started, ['/a', '/b', '/c'], 'an empty queue starts nothing');
  api.queueScan('/d'); state.scanning = true; api.queueScan('/e'); api.clearScanQueue(); state.scanning = false; onScan!('s4');
  assert.deepEqual(started, ['/a', '/b', '/c', '/d'], 'Stop clears what was waiting');
  assert.match(braced('function stopScan(', INDEX.indexOf('async function stopScan(')), /clearScanQueue\(\)/, 'and Stop does clear it');
  assert.match(slice("window.treemapDesktop.onScanPath", 'window.addEventListener'), /queueScan\(p\)/, 'dock drops and CLI folders join the same queue');
});

/* ══════════════ data-truth-5 — the forecast names what it measured ══════════════ */

test('the disk-full banner states its basis: a folder\'s growth against the volume, or the volume itself', async () => {
  const fn = braced('async function renderGrowthProjection(');
  const { $, els } = makeDom();
  const run = (forecast: Record<string, unknown>, root: Record<string, unknown>) => new Function('$', 'state', 'api', 'isCloudScan', 'icon', 'formatBytes', 'formatCount', 'escapeHtml',
    `'use strict'; ${fn} return renderGrowthProjection;`)(
    $, { root }, async () => forecast, () => false, () => '', (n: number) => n + ' B', (n: number) => String(n), (s: string) => s) as () => Promise<void>;
  await run({ status: 'ok', fullInDays: 40, bytesPerDay: 1e9, basis: 'folder' }, { name: 'Movies', path: '/Users/x/Movies' })();
  assert.equal(els.growthProj.hidden, false);
  assert.match(els.growthProj.innerHTML, /Movies/, 'the folder the slope came from is named');
  assert.match(els.growthProj.innerHTML, /volume|disk it lives on/i, 'and what the days count down to');
  assert.doesNotMatch(els.growthProj.innerHTML, /this disk is full/, 'the old sentence claimed the whole disk\'s growth');
  assert.match(els.growthProj.innerHTML, /elsewhere/i, 'the caveat: growth elsewhere is not counted');
  await run({ status: 'ok', fullInDays: 40, bytesPerDay: 1e9, basis: 'volume' }, { name: 'Macintosh HD', path: '/' })();
  assert.match(els.growthProj.innerHTML, /this disk/, 'a whole-volume scan may say "this disk"');
  assert.doesNotMatch(els.growthProj.innerHTML, /elsewhere/i, 'and needs no caveat');
  await run({ status: 'ok', fullInDays: 40, bytesPerDay: 1e9 }, { name: 'Movies', path: '/Users/x/Movies' })();
  assert.match(els.growthProj.innerHTML, /Movies/, 'an older server without a basis is read as a folder scan — the honest default');
  assert.match(braced('async function labelTrendForecast('), /basis/, 'the Trends footer uses the same basis');
});

/* ══════════════ the index badge says why an index is stale ══════════════ */

test('a stale index badge gives the server\'s reason, escaped, and keeps the old sentence where there is none', () => {
  // "It wasn't watching while TreeMap was closed" is one reason of several. On
  // macOS every watch in the process shares one change stream, so another
  // folder's watch starting or stopping makes a root stale while it is still
  // being watched — and the badge must not tell the user the app was closed.
  const render = braced('function renderIndexBadge(');
  const escapeHtml = new Function(`'use strict'; ${braced('function escapeHtml(')} return escapeHtml;`)() as (s: string) => string;
  const badge = (root: Record<string, unknown>): { text: string; stale: boolean } => {
    const { $, els } = makeDom();
    const run = new Function('$', 'escapeHtml', `'use strict'; ${render} return renderIndexBadge;`)($, escapeHtml) as (info: unknown) => void;
    run({ indexed: true, root });
    return { text: els.indexBadge.innerHTML, stale: els.indexBadge.cls.has('stale') };
  };

  const why = badge({ state: 'stale', live: true, staleReason: 'Another folder <b>started</b> being watched.' });
  assert.equal(why.stale, true);
  assert.match(why.text, /Index may be out of date\. Another folder &lt;b&gt;started&lt;\/b&gt; being watched\. Scan again to refresh it\./, 'the reason is shown, as text');
  assert.doesNotMatch(why.text, /<b>/, 'never as markup');
  assert.doesNotMatch(why.text, /while TreeMap was closed/, 'and not the one reason it is not');

  const older = badge({ state: 'stale', live: false });
  assert.match(older.text, /it wasn’t watching while TreeMap was closed/, 'a server that gives no reason gets the sentence the badge always said');
  const unwatched = badge({ state: 'ready', live: false, staleReason: 'left over' });
  assert.equal(unwatched.stale, true, 'a ready index nobody is watching is still amber');
  assert.doesNotMatch(unwatched.text, /left over/, 'but only a stale root\'s reason is its reason');
  const live = badge({ state: 'ready', live: true });
  assert.equal(live.stale, false);
  assert.match(live.text, /Index live — always current/);
});
