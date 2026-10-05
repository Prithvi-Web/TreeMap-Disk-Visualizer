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
