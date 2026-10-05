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
 *    held the scan — /api/scans lists nothing else. Now it is reopened, and
 *    scanned again only when it has gone, which the page says.
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
  const src = slice('/* Feature 5 — fast (incremental) rescan helpers.', '/** Shared scanning chrome');
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
  started: string[]; finished: Array<{ root: unknown; ms: number; stats: unknown; opts: unknown; boxThen: string; scanIdThen: unknown }>;
  toasts: string[]; warned: string[];
};
const LAST = { scanId: 's9', rootPath: '/Users/x/corpus', totalSize: 8_800_000_000, fileCount: 101_034, finishedAt: 1_700_000_000_000 };
const STATS = { scanId: 's9', status: 'complete', scanned: 106_664, fileCount: 101_034, dirCount: 5_630, engine: 'native', durationMs: 200 };
const RESULT = { status: 'complete', scanId: 's9', root: { path: '/Users/x/corpus', size: 8_800_000_000 }, fileCount: 101_034 };

function restore(opts: {
  answer: (url: string) => unknown; box?: string; focused?: boolean; onResult?: (state: Record<string, unknown>) => void;
}): Restore {
  const src = slice('function requestedPath()', 'void restoreLastSession();');
  const els: Record<string, El> = {};
  const $ = (id: string) => (els[id] ??= el());
  $('pathInput').value = opts.box ?? '/Users/x'; // what loadSystem puts there
  const state: Record<string, unknown> = { root: null, scanning: false, scanId: null };
  const asked: string[] = [];
  const started: string[] = [];
  const finished: Restore['finished'] = [];
  const toasts: string[] = [];
  const warned: string[] = [];
  const api = async (url: string, options?: { method?: string }) => {
    asked.push((options?.method ?? 'GET') + ' ' + url);
    const a = opts.answer(url);
    if (url.endsWith('/result')) opts.onResult?.(state);
    if (a instanceof Error) throw a;
    return a;
  };
  const document = { activeElement: opts.focused ? $('pathInput') : null };
  const run = new Function('$', 'state', 'api', 'location', 'document', 'console', 'startScan', 'finishScan', 'maybeShowFastRescan',
    'rememberScannedRoot', 'toast', 'escapeHtml',
    `'use strict'; ${src} return restoreLastSession;`)(
    $, state, api, { search: '' }, document, { warn: (m: string) => warned.push(m) },
    async (p: string) => { started.push(p); },
    async (root: unknown, ms: number, stats: unknown, o: unknown) => {
      finished.push({ root, ms, stats, opts: o, boxThen: $('pathInput').value, scanIdThen: state.scanId });
      state.root = root;
    },
    () => {}, () => {}, (m: string) => toasts.push(m), (s: string) => s,
  ) as () => Promise<void>;
  return { run, state, $, asked, started, finished, toasts, warned };
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

test('a scan that has gone is scanned again, and the page says so; one that went away mid-ask too (QA D57)', async () => {
  for (const [what, answer] of [
    ['the counters answer 404', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? gone() : url.startsWith('/api/fs/list') ? { entries: [] } : assert.fail(`unexpected ${url}`))],
    ['the tree answers 404', (url: string) => (url === '/api/scans' ? { scans: [LAST] } : url === '/api/scan/s9/stats' ? STATS : url === '/api/scan/s9/result' ? gone() : { entries: [] })],
  ] as const) {
    const h = restore({ answer });
    await h.run();
    assert.equal(h.finished.length, 0, `${what}: nothing is painted from it`);
    assert.ok(h.asked.includes('GET /api/fs/list?path=' + encodeURIComponent(LAST.rootPath)), `${what}: the folder is pre-flighted as before`);
    assert.deepEqual(h.started, ['/Users/x/corpus'], `${what}: and scanned again through the Scan button's path`);
    assert.equal(h.toasts.length, 1, `${what}: not silently`);
    assert.match(h.toasts[0], /^Your last scan of \/Users\/x\/corpus is no longer held — scanning it again\.$/, `${what}: in those words`);
    assert.equal(h.$('pathInput').value, '/Users/x/corpus', `${what}: the box names it`);
  }
});

test('a scan that is still held but could not be reopened is never called "no longer held" (review M2)', async () => {
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
    assert.deepEqual(h.started, ['/Users/x/corpus'], `${what}: the folder is scanned again, so the reload still shows it`);
    assert.equal(h.toasts.length, 1);
    assert.doesNotMatch(h.toasts[0], /no longer held|expired/, `${what}: the scan may well still be held`);
    assert.match(h.toasts[0], /Couldn’t reopen your last scan of \/Users\/x\/corpus/, `${what}: what happened`);
    assert.match(h.toasts[0], reason, `${what}: and why`);
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
