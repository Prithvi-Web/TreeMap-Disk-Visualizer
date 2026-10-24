import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX } from './fixtures/liftFrontend';

/**
 * The page's side of the desktop shell's contract (electron/preload.js), run
 * out of the built page (hunt group A).
 *
 *  - C01/C09: the shell gives the page the folders it is handed one at a
 *    time, the next only once the page says the last scan ended. The page
 *    never said so, and every folder after the first was dropped. Every real
 *    scan now says it started (scanProgress) and how it ended (scanFinished):
 *    finished, failed, its quiet refresh failed, or stopped. A paint from the
 *    saved index and a reopened scan say nothing.
 *  - C16: a reopened scan starts no index build — a walk at launch.
 *  - C18: the application menu's commands do what the page's keys do.
 *  - C19: only the first folder waiting "scans next", and a Stop says how
 *    many waiting folders it dropped.
 *
 * Each page function is lifted whole and run in a scope where every name the
 * test does not hand in is an inert stand-in (`ANY`): callable, every
 * property another stand-in, never a thenable. Nothing is timed.
 */

/** A page function by its declaration, brace-matched, out of the built page. */
function pageFn(decl: string): string {
  const start = INDEX.indexOf(decl);
  assert.notEqual(start, -1, `${decl} is in the page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${decl} never closes`);
}

/** A stand-in for anything the page reaches that a test does not care about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ANY: any = new Proxy(function stand() { /* inert */ }, {
  get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : ANY),
  set: () => true,
  apply: () => ANY,
  construct: () => ANY,
});

/** Names the page reads from the real global object. */
const GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Promise', 'JSON', 'Math', 'Number', 'String', 'Boolean',
  'Date', 'Set', 'Map', 'Error', 'TypeError', 'RegExp', 'Symbol', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'isFinite']);

interface Stub { id: string; innerHTML: string; textContent: string; value: string; hidden: boolean; clicks: number; cls: Set<string> }

function makeDom() {
  const els = new Map<string, Stub & Record<string, unknown>>();
  const $ = (id: string) => {
    let el = els.get(id);
    if (!el) {
      const cls = new Set<string>();
      el = {
        id, innerHTML: '', textContent: '', value: '', hidden: false, clicks: 0, cls, title: '', style: {}, dataset: {},
        classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), toggle: () => false, contains: (c: string) => cls.has(c) },
        setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null, closest: () => ANY, focus: () => {}, getClientRects: () => [],
        click() { (this as Stub).clicks++; },
      };
      els.set(id, el);
    }
    return el;
  };
  return { $, els };
}

/**
 * Run `decls` — page function declarations — in one scope: `given` names what
 * the test hands in, and `log` records each call of a recorder made with
 * `rec(name)`, in order.
 */
function page(decls: string[], given: Record<string, unknown>, returns: string) {
  const scope = new Proxy(given, {
    has: (_t, k) => typeof k === 'string' && !GLOBALS.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k as string) in t ? t[k as string] : ANY),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
  const src = decls.map(pageFn).join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('scope', `with (scope) { ${src}\n return { ${returns} }; }`)(scope);
}

/** A bridge that records what the page tells the shell, in order. */
function bridge() {
  const told: Array<[string, unknown]> = [];
  return {
    told,
    api: {
      scanProgress: (v: unknown) => { told.push(['scanProgress', v]); },
      scanFinished: (r: unknown) => { told.push(['scanFinished', r]); },
    },
  };
}

const TELL = 'function tellDesktop(';

/* ═════════════════════ C01/C09 — the page tells the shell ═════════════════════ */

test('C01: a real scan starting tells the shell (scanProgress 2) — its dock bar spins and it holds the folders it is handed', () => {
  const b = bridge();
  const { $ } = makeDom();
  const state = { scanning: false, scanGen: 0, root: null, whatsNew: { seq: 0 } };
  const fns = page([TELL, 'function beginScanChrome('], { state, $, window: { treemapDesktop: b.api } }, 'beginScanChrome');
  fns.beginScanChrome({ quiet: false });
  assert.deepEqual(b.told, [['scanProgress', 2]]);
  fns.beginScanChrome({ quiet: true, message: 'Starting scan…' });
  assert.deepEqual(b.told, [['scanProgress', 2], ['scanProgress', 2]], 'a quiet scan is a scan too: it is as long, and the shell must hold its folders as well');
});

test('C01: in a browser tab there is no bridge, and nothing is said or thrown', () => {
  const { $ } = makeDom();
  for (const window of [{}, { treemapDesktop: null }, { treemapDesktop: {} }]) {
    const state = { scanning: false, scanGen: 0, root: null, whatsNew: { seq: 0 } };
    const fns = page([TELL, 'function beginScanChrome('], { state, $, window }, 'beginScanChrome');
    assert.doesNotThrow(() => fns.beginScanChrome({ quiet: false }), JSON.stringify(window));
    assert.equal(state.scanning, true, 'the scan still starts');
  }
});

/** finishScan, run with a scan id in state (or none), recording what it tells the shell and what it builds. */
async function finish(opts: { scanId: string | null; reopenedAt?: number; afterStop?: boolean; scanningAfter?: boolean; refused?: number }) {
  const b = bridge();
  const { $ } = makeDom();
  const log: string[] = [];
  const builds: string[] = [];
  const badges: unknown[] = [];
  const asked: string[] = [];
  const root = { path: '/Users/x/Downloads', size: 4_200_000_000 };
  const state: Record<string, unknown> = {
    scanId: opts.scanId, settledScanId: null, scanning: false, view: 'dashboard', root: null,
    grid: { path: null, selection: new Set() }, treemap: { rootPath: null }, apps: { loadedFor: null }, live: { wanted: false },
  };
  const info = { indexed: true, root: { path: root.path, state: 'ready', live: true } };
  const given = {
    state, $, window: { treemapDesktop: b.api }, DUP_PAGE: 50,
    emit: (_t: unknown, id: unknown) => { log.push(`emit:${String(id)}`); if (opts.scanningAfter) state.scanning = true; },
    buildIndexInBackground: (p: string) => { builds.push(p); },
    indexStatusFor: async (p: string) => { asked.push(p); return info; },
    renderIndexBadge: (i: unknown) => { badges.push(i); },
    loadDashboardLists: async () => true,
  };
  const fns = page([TELL, 'async function finishScan('], given, 'finishScan');
  const stats = { fileCount: 812, dirCount: 40, durationMs: 1100, ...(opts.refused ? { refused: { dirs: opts.refused } } : {}) };
  await fns.finishScan(root, 1200, stats, { reopenedAt: opts.reopenedAt ?? 0, afterStop: !!opts.afterStop });
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  return { told: b.told, log, builds, badges, asked, info };
}

test('C01: a scan that completed now tells the shell it finished — with the folder, its files and its size — after the views have it', async () => {
  const r = await finish({ scanId: 's1' });
  assert.deepEqual(r.told, [['scanFinished', { ok: true, path: '/Users/x/Downloads', files: 812, bytes: 4_200_000_000 }]]);
  assert.deepEqual(r.log, ['emit:s1'], 'the views heard it first (where the page\'s own queue starts its next folder too)');
  const partial = await finish({ scanId: 's1', refused: 3 });
  assert.deepEqual(partial.told, [['scanFinished', { ok: true, path: '/Users/x/Downloads', files: 812, bytes: 4_200_000_000, refused: 3 }]],
    'a partial scan tells the shell how many folders could not be read, which its notice says as the page\'s toast does (review F1.8)');
});

test('C01: a paint from the saved index, a reopened scan and a scan shown after its Stop tell the shell nothing; nor does one with another scan begun since', async () => {
  assert.deepEqual((await finish({ scanId: null })).told, [], 'the index paint: no scan of its own (its scan is still to run)');
  assert.deepEqual((await finish({ scanId: 's9', reopenedAt: 1_700_000_000_000 })).told, [], 'a reopened scan completed before the page loaded');
  assert.deepEqual((await finish({ scanId: 's2', afterStop: true })).told, [], 'the Stop pressed for it told the shell already');
  assert.deepEqual((await finish({ scanId: 's3', scanningAfter: true })).told, [], 'a scan begun since: its own end is the one the shell hears');
});

/**
 * failScan / quietRescanFailed / stopScan, with the page's queue recorded.
 * `queued` is how many folders wait in the page's own queue; `answer` is what
 * the shell's scanFinished gives back (the desktop app's: a promise of
 * `{ dropped }`, the folders it still held that a Stop dropped).
 */
function ending(decl: string, returns: string, opts: { queued?: number; answer?: unknown } = {}) {
  const b = bridge();
  const { $ } = makeDom();
  const order: string[] = [];
  const toasts: string[] = [];
  const state: Record<string, unknown> = { scanning: true, scanningPath: '/Users/x/Movies', scanId: 's4', settledScanId: null, root: null, view: 'dashboard', abortScan: null, scanGen: 3, scanRequestGen: 0 };
  const api = {
    scanProgress: b.api.scanProgress,
    scanFinished: (r: unknown) => { order.push('shell'); b.api.scanFinished(r); return opts.answer; },
  };
  const fns = page([TELL, decl], {
    state, $, window: { treemapDesktop: api },
    toast: (m: string) => { toasts.push(m); },
    drainScanQueue: () => { order.push('drain'); },
    clearScanQueue: () => { order.push('clear'); return opts.queued ?? 2; },
  }, returns);
  return { fns, told: b.told, order, toasts };
}

test('C01: a failed scan tells the shell, with why, before a folder waiting in the page\'s own queue starts', () => {
  const e = ending('function failScan(', 'failScan');
  e.fns.failScan('TreeMap isn’t allowed to read /Users/x/Movies.');
  assert.deepEqual(e.told, [['scanFinished', { ok: false, path: '/Users/x/Movies', error: 'TreeMap isn’t allowed to read /Users/x/Movies.' }]]);
  assert.deepEqual(e.order, ['shell', 'drain'], 'told first: the next scan\'s own start must not be undone by this end');
});

test('C01: a quiet refresh behind an index paint that failed tells the shell, before the page\'s queue moves on', () => {
  const e = ending('function quietRescanFailed(', 'quietRescanFailed');
  e.fns.quietRescanFailed(Object.assign(new Error('The drive was disconnected.'), { status: 404 }));
  assert.deepEqual(e.told, [['scanFinished', { ok: false, path: '/Users/x/Movies', error: 'The drive was disconnected.' }]]);
  assert.deepEqual(e.order, ['shell', 'drain']);
});

test('C01 + C19: Stop tells the shell (stopped, so it says nothing), and says how many waiting folders it dropped', async () => {
  const e = ending('async function stopScan(', 'stopScan');
  await e.fns.stopScan();
  assert.deepEqual(e.told, [['scanFinished', { ok: false, path: '/Users/x/Movies', stopped: true }]]);
  assert.deepEqual(e.order, ['clear', 'shell'], 'the page\'s queue is emptied first: nothing of it starts after a Stop');
  assert.ok(e.toasts.includes('2 queued folders will not be scanned.'), `the two folders told they would scan are told they will not (${e.toasts.join(' | ')})`);
});

test('review F1.1/F1.13: a Stop counts the folders the desktop shell still held — its answer — with the page\'s own, in one sentence, singular or plural', async () => {
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  const said = async (queued: number, answer: unknown) => {
    const e = ending('async function stopScan(', 'stopScan', { queued, answer });
    await e.fns.stopScan();
    await settle();
    return e.toasts.filter((t) => /queued folder/.test(t));
  };
  assert.deepEqual(await said(0, Promise.resolve({ dropped: 1 })), ['1 queued folder will not be scanned.'],
    'the one folder the shell held — a dock drop behind this scan — is dropped, and said so, in the singular');
  assert.deepEqual(await said(1, Promise.resolve({ dropped: 2 })), ['3 queued folders will not be scanned.'],
    'the page\'s one and the shell\'s two, in one sentence, never two');
  assert.deepEqual(await said(1, undefined), ['1 queued folder will not be scanned.'], 'with no answer (a browser tab has no shell), the page\'s own count');
  assert.deepEqual(await said(0, Promise.resolve({ dropped: 0 })), [], 'nothing waiting anywhere: nothing to say');
  assert.deepEqual(await said(1, Promise.reject(new Error('No handler registered'))), ['1 queued folder will not be scanned.'],
    'an answer that fails is no answer: the page\'s own count is said, and nothing is thrown');
});

/* ═════════════════════ C16 — a reopened scan builds no index ═════════════════════ */

test('C16: a reopened scan starts no index build — the page reopens it as it loads, and a build walks the folder — and paints the index badge as the index stands', async () => {
  const r = await finish({ scanId: 's9', reopenedAt: 1_700_000_000_000 });
  assert.deepEqual(r.builds, [], 'no POST /api/index/build: opening TreeMap starts no walk');
  assert.deepEqual(r.asked, ['/Users/x/Downloads'], 'the folder\'s index is asked about');
  assert.deepEqual(r.badges, [r.info], 'and the badge says what it is');
  const fresh = await finish({ scanId: 's1' });
  assert.deepEqual(fresh.builds, ['/Users/x/Downloads'], 'control: a scan that completed now is indexed behind it');
});

/* ═════════════════════ C18 — the menu's commands ═════════════════════ */

function commands(opts: { modal?: string | null; scanning?: boolean; root?: unknown; paletteOpen?: boolean; bootRestore?: { settled: boolean; done: Promise<void> } } = {}) {
  const { $ } = makeDom();
  if (opts.paletteOpen) $('cmdkModal').cls.add('open');
  const did: string[] = [];
  const toasts: string[] = [];
  const state: { scanning: boolean; root: unknown } = { scanning: !!opts.scanning, root: opts.root ?? null };
  const fns = page(['function desktopCommand('], {
    state, $, toast: (m: string) => { toasts.push(m); },
    topModal: () => (opts.modal ? { id: opts.modal } : null),
    cmdkOpen: () => did.push('palette open'), cmdkClose: () => did.push('palette close'),
    toggleSideNav: () => did.push('sidebar'), toggleShortcuts: () => did.push('shortcuts'), rescan: () => did.push('rescan'),
    ...(opts.bootRestore ? { bootRestore: opts.bootRestore } : {}),
  }, 'desktopCommand');
  return { run: (n: string) => fns.desktopCommand(n), did, toasts, $, state };
}

test('C18: Settings…, Rescan, Command Palette…, Toggle Sidebar and Keyboard Shortcuts each do what the page\'s own control does', () => {
  const c = commands({ root: { path: '/Users/x' } });
  c.run('settings');
  assert.equal(c.$('settingsBtn').clicks, 1, 'Settings opens Settings, as its button does');
  for (const n of ['palette', 'sidebar', 'shortcuts', 'rescan']) c.run(n);
  assert.deepEqual(c.did, ['palette open', 'sidebar', 'shortcuts', 'rescan']);
  const open = commands({ paletteOpen: true });
  open.run('palette');
  assert.deepEqual(open.did, ['palette close'], 'the palette command toggles it, as ⌘K does');
});

test('C18: Rescan while a scan runs, or with nothing scanned yet, says why it does nothing; under an open sheet only the palette\'s toggle is taken', () => {
  const busy = commands({ scanning: true, root: { path: '/x' } });
  busy.run('rescan');
  assert.deepEqual(busy.did, []);
  assert.deepEqual(busy.toasts, ['A scan is already running']);
  const none = commands();
  none.run('rescan');
  assert.deepEqual(none.did, []);
  assert.equal(none.toasts.length, 1, 'a menu item that does nothing says why');
  const sheet = commands({ modal: 'trashModal', root: { path: '/x' } });
  for (const n of ['settings', 'sidebar', 'shortcuts', 'rescan']) sheet.run(n);
  assert.deepEqual(sheet.did, [], 'nothing reaches the page under a sheet');
  assert.equal(sheet.$('settingsBtn').clicks, 0);
  sheet.run('palette');
  assert.deepEqual(sheet.did, ['palette open'], 'but the palette toggle, as ⌘K passes a sheet');
});

/** Every promise already started gets its turns — counted, never a clock. */
const turns = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('review HA-L5/HA-L13: File › Rescan chosen with the window closed reaches the page as it loads, before the boot restore has reopened the last scan — it waits for the restore, then rescans what it reopened, and never says "Scan a folder first" over a scan about to reopen', async () => {
  const restoring = () => {
    let settle!: () => void;
    const bootRestore = { settled: false, done: new Promise<void>((r) => { settle = r; }) };
    return { bootRestore, settle: () => { bootRestore.settled = true; settle(); } };
  };
  {
    const r = restoring();
    const c = commands({ bootRestore: r.bootRestore });
    c.run('rescan');
    await turns();
    assert.deepEqual([c.did, c.toasts], [[], []], 'nothing is done or said while the last scan is still being reopened');
    c.state.root = { path: '/Users/x/Movies' }; // the restore reopens it
    r.settle();
    await turns();
    assert.deepEqual([c.did, c.toasts], [['rescan'], []], 'once it has, the Rescan asked for is done');
  }
  {
    const r = restoring();
    const c = commands({ bootRestore: r.bootRestore });
    c.run('rescan');
    r.settle(); // the scan had expired: the start screen names the folder, and no tree is open
    await turns();
    assert.deepEqual([c.did, c.toasts], [[], ['Scan a folder first — then Rescan scans it again.']], 'with nothing reopened, it says why it does nothing — then, when that is true');
  }
  const settled = commands({ bootRestore: { settled: true, done: new Promise<void>(() => {}) }, root: { path: '/x' } });
  settled.run('rescan');
  assert.deepEqual(settled.did, ['rescan'], 'control: once the restore has settled, a Rescan is done at once');
});

test('review HA-L5/HA-L13: the boot restore says it has settled only after the reopened scan is on screen — on every path, a failure too', async () => {
  const run = async (scans: unknown, opts: { reopen?: string; fail?: boolean } = {}) => {
    const log: string[] = [];
    const state: Record<string, unknown> = { root: null, scanning: false };
    const fns = page(['async function restoreLastSession('], {
      state, requestedPath: () => null, console: { warn: () => log.push('warn') },
      api: async (url: string) => {
        if (opts.fail) throw new Error('The server did not answer');
        return url === '/api/scans' ? { scans } : { roots: [] };
      },
      reopenScan: async () => { await turns(2); state.root = { path: '/Users/x' }; log.push('reopened'); return { outcome: opts.reopen ?? 'reopened' }; },
      bootRestore: { settle: () => log.push(`settled${state.root ? ' over a tree' : ''}`) },
      tourBootSettled: () => log.push('tour'),
    }, 'restoreLastSession');
    await fns.restoreLastSession();
    return log;
  };
  assert.deepEqual(await run([{ rootPath: '/Users/x', scanId: 's1' }]), ['reopened', 'settled over a tree', 'tour'], 'a held scan: settled once it is reopened');
  assert.deepEqual(await run([]), ['settled', 'tour'], 'nothing held: settled');
  assert.deepEqual(await run(null, { fail: true }), ['warn', 'settled', 'tour'], 'a restore that failed has settled too: a Rescan waiting on it is answered');
});

test('C18: the page registers the menu\'s commands with the bridge', () => {
  const at = INDEX.indexOf('window.treemapDesktop.onScanPath(');
  assert.notEqual(at, -1);
  const block = INDEX.slice(at, INDEX.indexOf('function desktopCommand(', at));
  assert.match(block, /window\.treemapDesktop\.onCommand\?\.\(\(name\) => desktopCommand\(name\)\)/);
});

/* ═════════════════════ C19 — the queue says what is true ═════════════════════ */

/** The page's scan queue, lifted whole out of the built page; startScan starts a scan the queue then waits behind. */
function pageQueue() {
  const { $ } = makeDom();
  const started: string[] = [];
  const toasts: string[] = [];
  const state: { scanning: boolean; scanningPath?: string } = { scanning: false };
  const at = INDEX.indexOf('const scanQueue = [];');
  const src = INDEX.slice(at, INDEX.indexOf('/* ── end scan queue ── */', at));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const q = new Function('state', 'startScan', 'toast', 'subscribe', 'TOPIC', '$', 'setTimeout',
    `'use strict'; ${src} return { queueScan, clearScanQueue, sayShellQueued: typeof sayShellQueued === 'function' ? sayShellQueued : null };`)(
    state, (p: string) => { started.push(p); state.scanning = true; state.scanningPath = p; }, (m: string) => toasts.push(m), () => {}, { scan: 'scan' }, $, () => 0,
  ) as { queueScan: (p: string) => void; clearScanQueue: () => number; sayShellQueued: ((held: unknown) => void) | null };
  return { q, $, started, toasts, state };
}

test('C19: only the first folder waiting scans next; the others are told how many are before them; the box names the folder that starts', () => {
  const { q, $, started, toasts } = pageQueue();
  q.queueScan('/A'); q.queueScan('/B'); q.queueScan('/C'); q.queueScan('/D');
  assert.deepEqual(started, ['/A']);
  assert.equal($('pathInput').value, '/A', 'the box names the folder being scanned, not the last one queued');
  assert.deepEqual(toasts, ['Queued /B — it scans next', 'Queued /C — 1 folder before it', 'Queued /D — 2 folders before it']);
  assert.equal(q.clearScanQueue(), 3, 'emptied, the queue says how many were waiting');
  assert.equal(q.clearScanQueue(), 0);
});

test('review HA-L3/HA-L11: a folder the desktop shell holds behind the scan running is said as the page\'s own queue says its folders, the page\'s waiting folders counted before it; one being scanned already is said to be', () => {
  const { q, toasts } = pageQueue();
  assert.equal(typeof q.sayShellQueued, 'function', 'the page answers the shell\'s notice');
  const say = q.sayShellQueued!;
  q.queueScan('/Running');
  say({ path: '/Dock', before: 0 });
  assert.deepEqual(toasts, ['Queued /Dock — it scans next'], 'a dock drop behind the scan running, with nothing else waiting');
  q.queueScan('/Mine'); // the page's own drop: its queue scans before the shell's folders
  say({ path: '/Second', before: 1 });
  assert.deepEqual(toasts.slice(1), ['Queued /Mine — it scans next', 'Queued /Second — 2 folders before it'],
    'the page\'s one waiting folder and the shell\'s one before it');
  say({ path: '/Running', scanning: true });
  assert.deepEqual(toasts.slice(3), ['Already scanning /Running'], 'asked for again while it scans');
  for (const junk of [null, {}, { path: 5, before: 0 }, { path: '', before: 0 }]) say(junk);
  assert.equal(toasts.length, 4, 'a notice that names no folder says nothing');
});

test('review HA-L3/HA-L11: the page registers for the shell\'s queued notices', () => {
  const at = INDEX.indexOf('window.treemapDesktop.onScanPath(');
  assert.notEqual(at, -1);
  const block = INDEX.slice(at, INDEX.indexOf('function desktopCommand(', at));
  assert.match(block, /window\.treemapDesktop\.onScanQueued\?\.\(\(held\) => sayShellQueued\(held\)\)/);
});
