import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Scan card's controls and the reload path (QA D45, D47, D66, D57).
 *
 *  - D45: "Fast rescan" was ticked for every folder scanned before, though an
 *    incremental rescan always runs on the built-in walker — ~20× slower than
 *    the native engine (4.3 s against 0.2 s on the QA corpus). It is never
 *    ticked for the person now, and not offered where the native engine runs.
 *  - D47: the box stayed hidden after a scan though the path box held the
 *    folder just scanned, until the path was edited.
 *  - D66: after a reload the path box said the home folder while the map
 *    showed another; Scan would have walked the home folder.
 *  - D57: every reload walked the last folder again, though the server still
 *    held the scan — /api/scans lists nothing else. Now it is reopened; when
 *    it has gone, nothing is walked either (the owner, 17 Oct 2026, which
 *    also supersedes B38): the start screen names the folder and offers it.
 *
 * Every function is EXECUTED out of the built page against stubs.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

type El = { hidden: boolean; checked: boolean; value: string; innerHTML: string; textContent: string };
const el = (): El => ({ hidden: true, checked: false, value: '', innerHTML: '', textContent: '' });

/** One browser's localStorage. */
function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    store,
  };
}

/* ══════════════ D45 + D47 — the Fast rescan box ══════════════ */

type Answers = { caps?: unknown; settings?: unknown };
function fastRescan(opts: { scanned: string[]; box: string; answers?: Answers | Error }) {
  // The box reads its path as the Scan button does (asPath, defined beside
  // the folder picker), so that comes along from the page too.
  const src = slice('function asPath(', '\n}\n') + '\n}\n' +
    slice('/* Feature 5 — fast (incremental) rescan helpers.', '/** Shared scanning chrome');
  const els: Record<string, El> = {};
  const $ = (id: string) => (els[id] ??= el());
  $('pathInput').value = opts.box;
  const ls = storage({ 'tm-scanned-roots': JSON.stringify(opts.scanned) });
  const asked: string[] = [];
  const api = async (url: string) => {
    asked.push(url);
    const a = opts.answers;
    if (a instanceof Error) throw a;
    if (url === '/api/engine/capabilities') return a?.caps;
    if (url === '/api/settings') return a?.settings;
    return assert.fail(`unexpected ${url}`);
  };
  const fns = new Function('$', 'localStorage', 'api', 'toast', 'formatCount',
    `'use strict'; ${src} return { maybeShowFastRescan, rememberScannedRoot, refreshFastRescanPlan };`)(
    $, ls, api, () => {}, String,
  ) as { maybeShowFastRescan: () => void; rememberScannedRoot: (p: string) => void; refreshFastRescanPlan: () => Promise<void> };
  return { ...fns, $, asked, ls };
}

const NATIVE = { native: { available: true, version: '1', reason: null } };
const NO_NATIVE = { native: { available: false, version: null, reason: 'not built for this machine' } };
const AUTO = { engine: 'auto', ignore: [] };

test('a folder scanned before is offered a fast rescan, but the box is never ticked for the person (QA D45)', () => {
  const h = fastRescan({ scanned: ['/c'], box: '/c' });
  h.maybeShowFastRescan();
  assert.equal(h.$('fastRescanWrap').hidden, false, 'offered: the folder in the box was scanned before');
  assert.equal(h.$('fastRescan').checked, false, 'and left for the person to choose — it can be the slow path');
  h.$('fastRescan').checked = true; // the person ticks it
  h.maybeShowFastRescan(); // and types
  assert.equal(h.$('fastRescan').checked, true, 'their choice stands while the box is offered');
  h.$('pathInput').value = '/elsewhere';
  h.maybeShowFastRescan();
  assert.equal(h.$('fastRescanWrap').hidden, true, 'a folder never scanned has nothing to reuse');
  assert.equal(h.$('fastRescan').checked, false, 'and a hidden box asks for nothing');
});

test('the box is not offered where the next scan runs on the native engine; it is where it would not (QA D45)', async () => {
  const native = fastRescan({ scanned: ['/c'], box: '/c', answers: { caps: NATIVE, settings: AUTO } });
  native.$('fastRescan').checked = true;
  await native.refreshFastRescanPlan();
  assert.deepEqual(native.asked, ['/api/engine/capabilities', '/api/settings'], 'the engine\'s status and the settings decide it');
  assert.equal(native.$('fastRescanWrap').hidden, true, 'Automatic with the native core: a fast rescan would be ~20× slower');
  assert.equal(native.$('fastRescan').checked, false);

  const forced = fastRescan({ scanned: ['/c'], box: '/c', answers: { caps: NATIVE, settings: { engine: 'native', ignore: [{ pattern: '*.iso', scope: 'suggest' }] } } });
  await forced.refreshFastRescanPlan();
  assert.equal(forced.$('fastRescanWrap').hidden, true, 'the native engine asked for, and a suggest-only rule that does not move the scan off it');

  for (const [why, answers] of [
    ['a "Don\'t scan" pattern keeps the scan on the walker', { caps: NATIVE, settings: { engine: 'auto', ignore: [{ pattern: 'node_modules', scope: 'both' }] } }],
    ['the walker asked for', { caps: NATIVE, settings: { engine: 'walker', ignore: [] } }],
    ['gdu asked for', { caps: NATIVE, settings: { engine: 'gdu', ignore: [] } }],
    ['no native core on this machine', { caps: NO_NATIVE, settings: AUTO }],
  ] as const) {
    const h = fastRescan({ scanned: ['/c'], box: '/c', answers });
    await h.refreshFastRescanPlan();
    assert.equal(h.$('fastRescanWrap').hidden, false, `${why}: offered`);
    assert.equal(h.$('fastRescan').checked, false, `${why}: and not ticked`);
  }

  const unknown = fastRescan({ scanned: ['/c'], box: '/c', answers: new Error('offline') });
  await unknown.refreshFastRescanPlan();
  assert.equal(unknown.$('fastRescanWrap').hidden, false, 'not known: offered unticked, which costs nothing');
});

test('under the NTFS turbo setting the box is not offered where the native core runs: the scan is the turbo mode\'s or the native engine\'s, never the walker\'s (final review F1.6)', async () => {
  // nativeRule (scan/nativeEngine.ts) has no rule for 'ntfs-mft': with the core loaded the native
  // engine walks whenever the turbo mode does not. A ticked box only kept the turbo mode off
  // (diskScanner's mftRuleCause 'incremental') and then went unused (FAST_RESCAN_NOT_USED).
  const turbo = fastRescan({ scanned: ['/c'], box: '/c', answers: { caps: NATIVE, settings: { engine: 'ntfs-mft', ignore: [] } } });
  turbo.$('fastRescan').checked = true;
  await turbo.refreshFastRescanPlan();
  assert.equal(turbo.$('fastRescanWrap').hidden, true, 'the native core loaded: a fast rescan would never be used, and would cost the turbo mode');
  assert.equal(turbo.$('fastRescan').checked, false, 'and a hidden box asks for nothing');

  for (const [why, answers] of [
    ['no native core: the walker scans when the turbo mode does not', { caps: NO_NATIVE, settings: { engine: 'ntfs-mft', ignore: [] } }],
    ['a "Don\'t scan" pattern keeps the scan on the walker', { caps: NATIVE, settings: { engine: 'ntfs-mft', ignore: [{ pattern: 'node_modules', scope: 'both' }] } }],
  ] as const) {
    const h = fastRescan({ scanned: ['/c'], box: '/c', answers });
    await h.refreshFastRescanPlan();
    assert.equal(h.$('fastRescanWrap').hidden, false, `${why}: offered`);
  }
});

test('the box appears as soon as the folder in the path box has been scanned, not after an edit (QA D47)', () => {
  const h = fastRescan({ scanned: [], box: '/c', answers: { caps: NO_NATIVE, settings: AUTO } });
  h.maybeShowFastRescan();
  assert.equal(h.$('fastRescanWrap').hidden, true, 'never scanned yet');
  h.rememberScannedRoot('/c');
  assert.equal(h.$('fastRescanWrap').hidden, false, 'the scan that just finished makes it a scanned folder, at once');
  assert.equal(h.$('fastRescan').checked, false);
  assert.deepEqual(JSON.parse(h.ls.getItem('tm-scanned-roots')!), ['/c']);
});

test('when the system answer fills the path box, the box is re-checked for that folder at once (review L3)', async () => {
  const src = slice('async function loadSystem()', '/* Feature 8 — Trash awareness. */');
  const run = (box: string) => {
    const els: Record<string, El & { style: Record<string, string> }> = {};
    const $ = (id: string) => (els[id] ??= { ...el(), style: {} });
    $('pathInput').value = box;
    const checks: string[] = [];
    const noop = () => {};
    const fn = new Function('api', 'state', 'renderKeyNames', 'tour', 'tourRender', '$', 'countUp', 'formatBytes', 'requestAnimationFrame',
      'loadTrash', 'loadSnapshots', 'loadCloudStatus', 'toast', 'maybeShowFastRescan',
      `'use strict'; ${src} return loadSystem;`)(
      async () => ({ hostname: 'h', platform: 'darwin', totalDisk: 10, freeDisk: 4, usedDisk: 6, homeDir: '/Users/x' }),
      {}, noop, undefined, noop, $, noop, String, noop, noop, noop, noop, noop, () => { checks.push($('pathInput').value); },
    ) as () => Promise<unknown>;
    return fn().then(() => ({ checks, box: $('pathInput').value }));
  };
  const empty = await run('');
  assert.equal(empty.box, '/Users/x');
  assert.deepEqual(empty.checks, ['/Users/x'], 'the home folder it filled in is checked');
  const typed = await run('/Users/x/Projects');
  assert.deepEqual(typed.checks, [], 'a box already holding a folder is left as it is');
});

/* ══════════════ D66 + D57 — reload reopens the scan the server still holds ══════════════ */

type Restore = {
  run: () => Promise<void>; state: Record<string, unknown>; $: (id: string) => El; asked: string[];
  started: string[]; startedWith: unknown[]; finished: Array<{ root: unknown; ms: number; stats: unknown; opts: unknown; boxThen: string; scanIdThen: unknown }>;
  toasts: string[]; warned: string[]; painted: number; settled: number;
};
const LAST = { scanId: 's9', rootPath: '/Users/x/corpus', totalSize: 8_800_000_000, fileCount: 101_034, finishedAt: 1_700_000_000_000 };
const STATS = { scanId: 's9', status: 'complete', scanned: 106_664, fileCount: 101_034, dirCount: 5_630, engine: 'native', durationMs: 200 };
const RESULT = { status: 'complete', scanId: 's9', root: { path: '/Users/x/corpus', size: 8_800_000_000 }, fileCount: 101_034 };

function restore(opts: {
  answer: (url: string) => unknown; box?: string; focused?: boolean; onResult?: (state: Record<string, unknown>) => void; search?: string;
}): Restore {
  // `?path=` is read as every path box is (asPath, defined beside the folder
  // picker), so that comes along from the page too, as in fastRescan above.
  const src = slice('function asPath(', '\n}\n') + '\n}\n' + slice('function requestedPath()', 'void restoreLastSession();');
  const els: Record<string, El> = {};
  const $ = (id: string) => (els[id] ??= el());
  $('pathInput').value = opts.box ?? '/Users/x'; // what loadSystem puts there
  const state: Record<string, unknown> = { root: null, scanning: false, scanId: null, lastFolder: null, scannedBefore: false };
  const asked: string[] = [];
  const started: string[] = [];
  const startedWith: unknown[] = []; // the options each startScan was handed
  const finished: Restore['finished'] = [];
  const toasts: string[] = [];
  const warned: string[] = [];
  const counts = { painted: 0, settled: 0 };
  const api = async (url: string, options?: { method?: string }) => {
    asked.push((options?.method ?? 'GET') + ' ' + url);
    const a = opts.answer(url);
    if (url.endsWith('/result')) opts.onResult?.(state);
    if (a instanceof Error) throw a;
    return a;
  };
  const document = { activeElement: opts.focused ? $('pathInput') : null };
  const run = new Function('$', 'state', 'api', 'location', 'document', 'console', 'startScan', 'finishScan', 'maybeShowFastRescan',
    'rememberScannedRoot', 'toast', 'escapeHtml', 'renderStartChoices', 'tourBootSettled',
    `'use strict'; ${src} return restoreLastSession;`)(
    $, state, api, { search: opts.search ?? '' }, document, { warn: (m: string) => warned.push(m) },
    async (p: string, o?: unknown) => { started.push(p); startedWith.push(o); },
    async (root: unknown, ms: number, stats: unknown, o: unknown) => {
      finished.push({ root, ms, stats, opts: o, boxThen: $('pathInput').value, scanIdThen: state.scanId });
      state.root = root;
    },
    () => {}, () => {}, (m: string) => toasts.push(m), (s: string) => s,
    () => { counts.painted++; }, () => { counts.settled++; },
  ) as () => Promise<void>;
  return {
    run, state, $, asked, started, startedWith, finished, toasts, warned,
    get painted() { return counts.painted; }, get settled() { return counts.settled; },
  };
}
const gone = () => Object.assign(new Error('Unknown or expired scanId'), { status: 404, code: 'SCAN_NOT_FOUND' });

test('a reload reopens the scan the server still holds — nothing is walked again (QA D57)', async () => {
  const h = restore({
    answer: (url) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : url === '/api/scan/s9/result' ? RESULT : assert.fail(`unexpected ${url}`)),
  });
  await h.run();
  assert.deepEqual(h.asked, ['GET /api/scans', 'GET /api/scan/s9/stats', 'GET /api/scan/s9/result'], 'the list, the counters and the tree: no POST /api/scan');
  assert.deepEqual(h.started, [], 'no scan started');
  assert.equal(h.finished.length, 1, 'the tree is painted once, through finishScan');
  assert.deepEqual(h.finished[0].root, RESULT.root);
  const { scanId: _id, status: _st, ...stats } = STATS;
  assert.deepEqual(h.finished[0].stats, stats, 'with the scan\'s own counters, as its complete frame carried them');
  assert.equal(h.finished[0].ms, 200, 'and its own duration');
  assert.deepEqual(h.finished[0].opts, { reopenedAt: LAST.finishedAt }, 'said to be a reopened scan, from when it finished');
  assert.equal(h.finished[0].scanIdThen, 's9', 'the scan\'s id is the one every view asks with');
  assert.deepEqual(h.toasts, []);
  assert.equal(h.state.scannedBefore, true, 'a held scan: this person has scanned before');
  assert.equal(h.settled, 1, 'and the tour hears the restore has settled');
});

test('after a reload the path box names the folder on screen, not the home folder (QA D66)', async () => {
  const h = restore({
    answer: (url) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : RESULT),
  });
  await h.run();
  assert.equal(h.finished[0].boxThen, '/Users/x/corpus', 'set before the tree is painted: Scan and Enter rescan what the map shows');

  // A person already typing a folder keeps it: what they typed is what Scan should take.
  const typing = restore({ box: '/Users/x/Movies', focused: true, answer: (url) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : RESULT) });
  await typing.run();
  assert.equal(typing.$('pathInput').value, '/Users/x/Movies');
});

test('a scan that has gone — or went away mid-ask — is named on the start screen and offered, never walked again (the owner, 17 Oct 2026, superseding D57\'s rescan)', async () => {
  for (const [what, answer] of [
    ['the counters answer 404', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? gone() : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`))],
    ['the tree answers 404', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : url === '/api/scan/s9/result' ? gone() : { entries: [] })],
  ] as const) {
    const h = restore({ answer });
    await h.run();
    assert.equal(h.finished.length, 0, `${what}: nothing is painted from it`);
    assert.deepEqual(h.started, [], `${what}: and nothing is scanned`);
    assert.ok(h.asked.includes('GET /api/fs/list?path=' + encodeURIComponent(LAST.rootPath)), `${what}: the folder is looked at, to be offered only where the server can open it`);
    assert.deepEqual(h.state.lastFolder, { path: '/Users/x/corpus', size: LAST.totalSize, at: LAST.finishedAt, outcome: 'history', reason: '', offered: true },
      `${what}: the start screen names it, with its size and date, and offers it`);
    assert.equal(h.painted, 1, `${what}: painted once`);
    assert.deepEqual(h.toasts, [], `${what}: no "scanning it again"`);
  }
});

test('a scan that is still held but could not be reopened is never called "no longer held", and is not walked (review M2)', async () => {
  const offline = () => Object.assign(new Error('Couldn’t reach TreeMap — its own server stopped answering.'), { status: 0, code: 'OFFLINE' });
  const failed = () => Object.assign(new Error('The scan’s first frame could not be sent.'), { status: 500, code: 'INTERNAL' });
  for (const [what, answer, reason] of [
    ['the counters could not be reached', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? offline() : { entries: [] }), /server stopped answering/],
    ['the tree answered 500', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : url === '/api/scan/s9/result' ? failed() : { entries: [] }), /could not be sent/],
    ['the counters came back empty', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? null : { entries: [] }), /could not be read/],
  ] as const) {
    const h = restore({ answer });
    await h.run();
    assert.equal(h.finished.length, 0, `${what}: nothing painted`);
    assert.deepEqual(h.started, [], `${what}: nothing walked`);
    const last = h.state.lastFolder as { outcome: string; reason: string; offered: boolean };
    assert.equal(last.outcome, 'unreadable', `${what}: said to be a scan not reopened — the start screen words it "Couldn’t reopen…"`);
    assert.match(last.reason, reason, `${what}: and why`);
    assert.equal(last.offered, true, `${what}: and offered again`);
    assert.deepEqual(h.toasts, [], `${what}: nothing calls it "no longer held"`);
  }
});

test('the person wins the race: a scan they start while the tree downloads is not painted over', async () => {
  const h = restore({
    answer: (url) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : RESULT),
    onResult: (state) => { state.scanning = true; },
  });
  await h.run();
  assert.equal(h.finished.length, 0, 'the reopened tree is dropped');
  assert.deepEqual(h.started, [], 'and nothing is scanned behind their back');
  assert.equal(h.state.scanId, null, 'nor does its id replace theirs');
});

/* ══════════════ B38, superseded — expired, or a relaunch: the history names the folder, the person picks ══════════════ */

test('with no scan held — expired, or the app relaunched — the newest folder in the history is named and offered, never scanned (the owner, 17 Oct 2026, superseding B38)', async () => {
  // B38 scanned the newest folder in the history again at every relaunch. The
  // owner's was `/`: every launch walked the whole disk. The owner, 17 Oct
  // 2026: "ideally users should be able to pick the folder".
  const ROOTS = { roots: [
    { rootPath: '/', count: 7, latestAt: 1_700_000_100_000, latestSize: 494_380_000_000 },
    { rootPath: '/Users/x/Mail', count: 1, latestAt: 1_700_000_000_000, latestSize: 36_000_000 },
  ] };
  const h = restore({
    answer: (url) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? ROOTS : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`)),
  });
  await h.run();
  assert.deepEqual(h.asked, ['GET /api/scans', 'GET /api/snapshots', 'GET /api/fs/list?path=' + encodeURIComponent('/')],
    'the history is asked only because nothing is held, and the folder is looked at — never POST /api/scan');
  assert.deepEqual(h.started, [], 'nothing is scanned');
  assert.deepEqual(h.state.lastFolder, { path: '/', size: 494_380_000_000, at: 1_700_000_100_000, outcome: 'history', reason: '', offered: true },
    'the start screen names the newest folder, with its last size and date');
  assert.equal(h.painted, 1, 'and is painted with it');
  assert.equal(h.state.scannedBefore, true);
  assert.deepEqual(h.toasts, [], 'no toast');
  assert.equal(h.$('pathInput').value, '/Users/x', 'the path box is left as loadSystem filled it');
});

test('only an empty history is a first run; a cloud folder is not offered, an unreadable history starts at the start screen, and a folder that has gone is named but not offered', async () => {
  const first = restore({ answer: (url) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? { roots: [] } : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`)) });
  await first.run();
  assert.deepEqual([first.started, first.state.lastFolder, first.state.scannedBefore], [[], null, false], 'no history: a first run, nothing named');
  const cloud = restore({ answer: (url) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? { roots: [{ rootPath: 'cloud://gdrive/', count: 1, latestAt: 1, latestSize: 1 }] } : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`)) });
  await cloud.run();
  assert.deepEqual([cloud.started, cloud.state.lastFolder, cloud.state.scannedBefore], [[], null, true], 'a cloud account is never offered from the start screen — its sign-in may be gone — though it was scanned');
  const broken = restore({ answer: (url) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? new Error('history unreadable') : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`)) });
  await broken.run();
  assert.deepEqual([broken.started, broken.state.lastFolder, broken.toasts], [[], null, []], 'an unreadable history starts at the start screen, without a word at boot');
  const moved = restore({ answer: (url) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? { roots: [{ rootPath: '/Volumes/gone', count: 1, latestAt: 1, latestSize: 1 }] } : url.startsWith('/api/fs/list') ? new Error('That folder no longer exists.') : assert.fail(`unexpected ${url}`)) });
  await moved.run();
  assert.deepEqual(moved.started, [], 'a folder that has gone is not scanned');
  assert.deepEqual(moved.state.lastFolder, { path: '/Volumes/gone', size: 1, at: 1, outcome: 'history', reason: 'That folder no longer exists.', offered: false }, 'it is named with why, and not offered');
  for (const h of [first, cloud, broken, moved]) assert.equal(h.settled, 1, 'every way the restore ends tells the tour once');
});

test('boot starts no scan nobody asked for — expired, relaunched or gone — and a folder someone asked for is theirs (F1.2)', async () => {
  // Review F1.2 made the restore's own rescan unattended, so a relaunch never
  // asked for elevation. There is no such rescan now (the owner, 17 Oct
  // 2026): the start screen offers the folder and the person picks.
  const ROOTS = { roots: [{ rootPath: '/Users/x/corpus', count: 7, latestAt: 1_700_000_100_000, latestSize: 8_800_000_000 }] };
  for (const [what, answer] of [
    ['nothing held: the history names the folder', (url: string) => (url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? ROOTS : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`))],
    ['held, but gone when asked', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? gone() : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`))],
  ] as const) {
    const h = restore({ answer });
    await h.run();
    assert.deepEqual(h.started, [], `${what}: nothing scanned`);
  }
  // `?path=` is a person's request: the VS Code extension's "Scan with TreeMap" on a folder they chose.
  const asked = restore({ search: '?path=' + encodeURIComponent('/Users/x/Projects'), answer: (url) => assert.fail(`unexpected ${url}`) });
  await asked.run();
  assert.deepEqual(asked.started, ['/Users/x/Projects']);
  assert.deepEqual(asked.startedWith, [undefined], 'a folder someone asked for is started as theirs');
  assert.equal(asked.settled, 1, 'and the tour hears the restore has settled');
});

test('a scan the person stopped while the restore was asking keeps its own name on the start screen', async () => {
  const ROOTS = { roots: [{ rootPath: '/Users/x/corpus', count: 7, latestAt: 1, latestSize: 1 }] };
  const h = restore({
    answer: (url) => {
      if (url.startsWith('/api/fs/list')) h.state.lastFolder = { path: '/Users/x/Desktop', outcome: 'stopped', reason: '', offered: true, size: null, at: 0 };
      return url === '/api/scans' ? { scans: [] } : url === '/api/snapshots' ? ROOTS : { entries: [] };
    },
  });
  await h.run();
  assert.equal((h.state.lastFolder as { path: string }).path, '/Users/x/Desktop', 'the history does not replace it');
  assert.equal(h.painted, 0, 'nor repaint over it');
});
