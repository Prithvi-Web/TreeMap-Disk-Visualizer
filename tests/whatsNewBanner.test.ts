import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The "What's new since your last scan" banner, on the page (QA D75).
 *
 * The banner subtracts two snapshots' totals. A snapshot records what a scan
 * COUNTED, not what it was allowed to count, so adding a "Don't scan" pattern
 * and scanning again read as "5.0 MB freed · 25,600 files removed" — nothing
 * was removed; the folder was left out by the person's own rule. History
 * already refuses to compare two scans that stopped at different drives
 * (U-24, 409 BOUNDARY_CHANGED, which the banner meets as no banner). This is
 * the page's equivalent for what it knows: the "Don't scan" patterns each scan
 * ran with and the kind of engine that counted, kept per snapshot.
 *
 * `loadWhatsNew` and `renderWhatsNew` are EXECUTED out of the built page with
 * a stub api(), a stub DOM and an in-memory localStorage.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

type Snap = { id: string; rootPath: string; takenAt: number; totalSize: number; fileCount: number; dirCount: number; topEntries: unknown[] };
type Settings = { ignore: Array<{ pattern: string; scope: string }> } | Error;
type El = { hidden: boolean; innerHTML: string };

const T0 = Date.now() - 3_600_000;
const snap = (id: string, takenAt: number, totalSize: number, fileCount: number): Snap =>
  ({ id, rootPath: '/c', takenAt, totalSize, fileCount, dirCount: 1, topEntries: [] });

/** One browser: its localStorage outlives each scan, like the real one. */
function browser() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  return { localStorage, store };
}

/**
 * Finish a scan of /c on `engine` with `settings`, the server holding
 * `snaps` (oldest first, the last one this scan's), and the compare answering
 * `diff`. Returns the banner and every URL asked.
 */
async function scanFinished(b: ReturnType<typeof browser>, opts: {
  engine: string; settings: Settings; snaps: Snap[]; diff?: Record<string, unknown>; scanId?: string | null;
  /** finishScan was told the scan was reopened after a reload (QA D57). */
  reopened?: boolean;
}) {
  const src = slice('/* ─────────────── "What\'s new since last scan" (Dashboard banner) ─────────────── */', "$('whatsNewClose').addEventListener");
  const els: Record<string, El> = {};
  const $ = (id: string) => (els[id] ??= { hidden: true, innerHTML: '' });
  const asked: string[] = [];
  const last = opts.snaps[opts.snaps.length - 1];
  const state = {
    root: { path: '/c' }, scanId: opts.scanId === undefined ? 'scan-' + last.id : opts.scanId,
    scanStats: { engine: opts.engine }, lastScan: { when: last.takenAt, reopened: opts.reopened === true },
    whatsNew: { seq: 0, dismissed: false },
  };
  const api = async (url: string) => {
    asked.push(url);
    if (url.startsWith('/api/snapshots?path=')) return { snapshots: opts.snaps };
    if (url === '/api/settings') { if (opts.settings instanceof Error) throw opts.settings; return opts.settings; }
    if (url.startsWith('/api/snapshots/compare?')) return opts.diff ?? { totalDelta: 0, entries: [] };
    return assert.fail(`unexpected ${url}`);
  };
  const load = new Function('$', 'state', 'api', 'icon', 'escapeHtml', 'formatBytes', 'formatCount', 'localStorage', 'setTimeout', 'switchView',
    `'use strict'; ${src} return loadWhatsNew;`)(
    $, state, api, () => '', (s: string) => String(s), (n: number) => `${n} B`, (n: number) => n.toLocaleString('en-US'),
    b.localStorage, () => assert.fail('the fresh snapshot is already listed: no wait'), () => {},
  ) as () => Promise<void>;
  await load();
  return { card: $('whatsNewCard'), html: $('whatsNewBody').innerHTML, asked };
}

const NO_RULES: Settings = { ignore: [{ pattern: 'node_modules', scope: 'suggest' }] }; // suggest-only: not a scan rule
const ONE_RULE: Settings = { ignore: [{ pattern: 'node_modules', scope: 'suggest' }, { pattern: 'big-folder', scope: 'both' }] };

test('a new "Don\'t scan" rule is never reported as space freed or files removed (QA D75)', async () => {
  const b = browser();
  const a = snap('a', T0, 8_800_000_000, 101_034);
  const first = await scanFinished(b, { engine: 'native', settings: NO_RULES, snaps: [a] });
  assert.equal(first.card.hidden, true, 'a first scan has nothing to compare');

  // The person adds "big-folder" to Don't scan; the next scan runs on the walker (the patterns' glob dialect lives there).
  const bSnap = snap('b', T0 + 60_000, 8_795_000_000, 75_434);
  const second = await scanFinished(b, {
    engine: 'turbo-walker', settings: ONE_RULE, snaps: [a, bSnap],
    diff: { totalDelta: -5_000_000, entries: [{ name: 'other', path: '/c/other', delta: 10, type: 'dir' }] },
  });
  assert.equal(second.card.hidden, false, 'the banner says what happened');
  assert.doesNotMatch(second.html, /freed|removed|added/, 'nothing was freed, removed or added — the rule left them out');
  assert.match(second.html, /25,600 files no longer scanned/, 'the difference, called what it is');
  assert.match(second.html, /your “Don’t scan” rules changed/, 'and why');
  assert.doesNotMatch(second.html, /grew the most/, 'no mover is named across a change in what was counted');
  assert.doesNotMatch(second.html, /class="delta-badge num (up|down)"/, 'nor coloured as growth or as space won back');
});

test('two scans that counted the same way keep the plain words: added, freed, removed', async () => {
  const b = browser();
  const a = snap('a', T0, 10_000, 100);
  await scanFinished(b, { engine: 'turbo-walker', settings: ONE_RULE, snaps: [a] });
  const c = snap('c', T0 + 60_000, 8_000, 90);
  // The native engine and the walker count the same entries: an engine change inside that family is no change.
  const banner = await scanFinished(b, { engine: 'turbo-walker', settings: ONE_RULE, snaps: [a, c], diff: { totalDelta: -2_000, entries: [] } });
  assert.match(banner.html, /2000 B freed/);
  assert.match(banner.html, /10 files removed/);
  const d = snap('d', T0 + 120_000, 9_000, 95);
  const up = await scanFinished(b, { engine: 'turbo-walker', settings: { ignore: [{ pattern: 'big-folder', scope: 'scan' }] }, snaps: [a, c, d], diff: { totalDelta: 1_000, entries: [] } });
  assert.match(up.html, /\+1000 B added/, 'a rule\'s scope moving between "scan" and "both" changes nothing that was counted');
  assert.match(up.html, /\+5 files added/);
});

test('a snapshot this page never saw (a scheduled scan, another window) gets neutral words: a change in totals, no cause claimed', async () => {
  const b = browser();
  const x = snap('x', T0, 10_000, 100); // no record: scanned elsewhere
  const y = snap('y', T0 + 60_000, 8_000, 90);
  const banner = await scanFinished(b, { engine: 'native', settings: NO_RULES, snaps: [x, y],
    diff: { totalDelta: -2_000, entries: [{ name: 'Library', path: '/c/Library', delta: 900, type: 'dir' }] } });
  assert.equal(banner.card.hidden, false);
  assert.doesNotMatch(banner.html, /freed|removed|added/, 'whether anything was removed is not known');
  assert.doesNotMatch(banner.html, /grew the most/, 'nor whether a folder grew: it may only have been counted again (review L1)');
  assert.match(banner.html, /−2000 B/, 'the change in the total is still stated');
  assert.match(banner.html, /−10 files/);
  // The same when the settings could not be read for this scan.
  const b2 = browser();
  await scanFinished(b2, { engine: 'native', settings: NO_RULES, snaps: [x] });
  const unread = await scanFinished(b2, { engine: 'native', settings: new Error('offline'), snaps: [x, y], diff: { totalDelta: -2_000, entries: [] } });
  assert.doesNotMatch(unread.html, /freed|removed/, 'a scan whose rules could not be read is not compared as the same');
});

test('another kind of engine counted (gdu shows a folder it may not open as empty): no banner, like a change of drives', async () => {
  const b = browser();
  const a = snap('a', T0, 10_000, 100);
  await scanFinished(b, { engine: 'native', settings: NO_RULES, snaps: [a] });
  const g = snap('g', T0 + 60_000, 8_000, 90);
  const banner = await scanFinished(b, { engine: 'gdu-turbo', settings: NO_RULES, snaps: [a, g], diff: { totalDelta: -2_000, entries: [] } });
  assert.equal(banner.card.hidden, true, 'nothing is said rather than something wrong');
  assert.equal(banner.asked.filter((u) => u.startsWith('/api/snapshots/compare')).length, 0, 'and the two are not compared');
});

test('the record is per snapshot: reopening the same scan compares the same way, and the index paint records nothing', async () => {
  const b = browser();
  const a = snap('a', T0, 10_000, 100);
  await scanFinished(b, { engine: 'native', settings: NO_RULES, snaps: [a] });
  const bSnap = snap('b', T0 + 60_000, 9_000, 74);
  const diff = { totalDelta: -1_000, entries: [] };
  await scanFinished(b, { engine: 'turbo-walker', settings: ONE_RULE, snaps: [a, bSnap], diff });
  // The page is reloaded and the scan reopened: the settings have changed again since, but this scan ran with ONE_RULE.
  const again = await scanFinished(b, { engine: 'turbo-walker', settings: NO_RULES, snaps: [a, bSnap], diff });
  assert.match(again.html, /26 files no longer scanned<\/span>/, 'the scan is described by the rules it ran with');
  assert.match(again.html, /your “Don’t scan” rules changed/);
  // A scan reopened after a reload that has no record is NOT described by
  // today's settings: a rule added since would make the next scan with that
  // rule compare as "the same" and say "freed" again (review M1).
  const b3 = browser();
  const old = snap('old', T0, 10_000, 100); // its banner never ran here
  const reopened = await scanFinished(b3, { engine: 'native', settings: ONE_RULE, snaps: [a, old], reopened: true, diff });
  assert.equal(b3.store.size, 0, 'nothing recorded for a reopened scan');
  assert.doesNotMatch(reopened.html, /freed|removed/, 'and it is compared as unknown');
  assert.ok(!reopened.asked.includes('/api/settings'), 'today\'s settings are not even read for it');
  // A tree painted from the index has no scan behind it, so it records nothing for the snapshot it finds.
  const b2 = browser();
  await scanFinished(b2, { engine: 'index', settings: NO_RULES, snaps: [a], scanId: null });
  assert.equal(b2.store.size, 0, 'no record without a scan');
  await scanFinished(b2, { engine: 'cloud', settings: NO_RULES, snaps: [a] });
  assert.equal(b2.store.size, 0, 'nor for a cloud listing, which no "Don\'t scan" rule or disk engine shaped');
});

test('a finished scan records what it counted under its own id too, so Compare can read two live scans (B24)', async () => {
  const b = browser();
  const a = snap('a', T0, 10_000, 100);
  await scanFinished(b, { engine: 'turbo-walker', settings: ONE_RULE, snaps: [a] });
  const book = JSON.parse(b.store.get('tm-scan-coverage') ?? '{}') as Record<string, Array<{ snap: string; patterns: string[] }>>;
  assert.deepEqual(book['/c']?.map((r) => r.snap).sort(), ['a', 'scan:scan-a'], 'the snapshot and the live scan it came from');
  assert.deepEqual(book['/c']?.find((r) => r.snap === 'scan:scan-a')?.patterns, ['big-folder']);
});

test('the record keeps three scans\u2019 snapshots and live scans, so Compare can pair the last few (B24)', async () => {
  const b = browser();
  const snaps: Snap[] = [];
  for (const id of ['a', 'b', 'c']) {
    snaps.push(snap(id, T0 + snaps.length * 60_000, 10_000, 100));
    await scanFinished(b, { engine: 'turbo-walker', settings: ONE_RULE, snaps: [...snaps], diff: { totalDelta: 0, entries: [] } });
  }
  const book = JSON.parse(b.store.get('tm-scan-coverage') ?? '{}') as Record<string, Array<{ snap: string }>>;
  assert.deepEqual(book['/c']?.map((r) => r.snap).sort(), ['a', 'b', 'c', 'scan:scan-a', 'scan:scan-b', 'scan:scan-c']);
});
