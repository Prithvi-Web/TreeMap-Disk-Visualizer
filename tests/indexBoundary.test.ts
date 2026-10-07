import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexBoundary-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { apiCall as call, settleIndexJob as settle } from './fixtures/indexJobs';
import { mountTableNaming } from './fixtures/mountTables';
import { updateSettings } from '../src/services/settings';
import { neverDescendPaths, setBoundaryDepsForTests, setNeverDescendForTests } from '../src/utils/mountBoundaries';
import { setWatchImplForTests, type WatchListener } from '../src/platform/watchRegistry';
import {
  buildIndex,
  closeIndex,
  deleteIndex,
  findNodeIdByPath,
  getRoot,
  openIndex,
  reclaimsSettled,
  stopAllWatchers,
} from '../src/services/indexEngine';

/**
 * The index build honours "Stay on this drive" (Track U, U-24, for the
 * index: U-24i).
 *
 * A scan composes its never-descend list once when it starts — the fixed
 * folders and, under `stay`, every drive the mount table shows mounted inside
 * the folder (`scanBoundary`) — and no engine enters one. The index build
 * walked with the fixed list alone, so after every scan of a folder holding a
 * disk image or a simulator volume the page's build counted the other drive
 * into the folder's index. Now `POST /api/index/build` composes the same list
 * from the folder and the setting (a build needs no scan), the walk leaves
 * every path on it out, and the root's live watcher drops a change at or
 * under one, as Live mode does for a scan.
 *
 * Nothing is mounted: the mount table is injected and names an ordinary
 * folder, `mnt`, which holds one file. Every assertion counts files, folders,
 * bytes or rows.
 */

const NO_TABLE = process.platform === 'win32' ? 'Windows keeps no mount table, so no build there has a drive inside it to stop at' : false;

after(async () => {
  setBoundaryDepsForTests(null);
  setWatchImplForTests(null);
  stopAllWatchers();
  await reclaimsSettled();
  closeIndex();
});

interface Tree {
  root: string;
  mnt: string;
  inside: string;
  other: string;
}

/** root/{top.txt 100 B, mnt/inside.txt 1500 B, other/plain.txt 700 B}, by its real path so the walk spells it as the table does. */
function tree(): Tree {
  const root = fs.realpathSync(fileTempDir('treemap-indexBoundary-'));
  const mnt = path.join(root, 'mnt');
  const other = path.join(root, 'other');
  fs.mkdirSync(mnt);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, 'top.txt'), 'x'.repeat(100));
  const inside = path.join(mnt, 'inside.txt');
  fs.writeFileSync(inside, 'y'.repeat(1500));
  fs.writeFileSync(path.join(other, 'plain.txt'), 'z'.repeat(700));
  return { root, mnt, inside, other };
}

function useTable(paths: string[]): void {
  setBoundaryDepsForTests({ readTable: async () => mountTableNaming(paths), aliases: async () => () => [] });
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** POST /api/index/build for `root`, waited to its end; the root it built. */
async function buildThroughRoute(base: string, root: string): Promise<{ fileCount: number; dirCount: number; totalSize: number; live: boolean }> {
  const started = await call(base, 'POST', '/api/index/build', { path: root });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  const done = await settle(base, started.json.jobId);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return done.json.root as { fileCount: number; dirCount: number; totalSize: number; live: boolean };
}

const idOf = (root: string, p: string): number | null => findNodeIdByPath(getRoot(root)!.id, root, p);

/** Stands in for the OS watch: each one the index opens is kept, by the folder it watches, for the test to speak through. */
function fakeWatches(t: TestContext): Map<string, WatchListener> {
  const listeners = new Map<string, WatchListener>();
  setWatchImplForTests((target, _opts, listener) => {
    listeners.set(target, listener);
    return { close() {}, on() { return undefined; } };
  });
  t.after(() => { stopAllWatchers(); setWatchImplForTests(null); });
  return listeners;
}

/* ══════════════════ the walk ══════════════════ */

test('POST /api/index/build stays on this drive: under "stay" a drive mounted inside the folder is left out of its index, under "cross" it is walked — and no scan is needed', { skip: NO_TABLE }, async () => {
  const f = tree();
  useTable([f.mnt]);
  await withServer(async (base) => {
    try {
      await updateSettings({ scanBoundary: 'stay' });
      const stay = await buildThroughRoute(base, f.root);
      assert.equal(stay.fileCount, 2, 'stay: top.txt and plain.txt — nothing on the other drive');
      assert.equal(stay.totalSize, 800, 'stay: not a byte of the other drive');
      assert.equal(stay.dirCount, 2, 'stay: the folder and other/; the mount point is left out, as the fixed folders always are');
      assert.equal(idOf(f.root, f.mnt), null, 'stay: no row for the mount point');
      assert.equal(idOf(f.root, f.inside), null, 'stay: nor for anything on the drive');

      await updateSettings({ scanBoundary: 'cross' });
      const cross = await buildThroughRoute(base, f.root);
      assert.equal(cross.fileCount, 3, 'cross: the drive is walked');
      assert.equal(cross.totalSize, 2300);
      assert.notEqual(idOf(f.root, f.inside), null, 'cross: its file is in the index');
    } finally {
      await updateSettings({ scanBoundary: 'stay' });
      deleteIndex(f.root);
    }
  });
});

/* ══════════════════ the live watcher ══════════════════ */

test('the index watcher drops a change on a drive its build left out, and applies one elsewhere', { skip: NO_TABLE }, async (t) => {
  const f = tree();
  useTable([f.mnt]);
  const watches = fakeWatches(t);
  await withServer(async (base) => {
    try {
      await updateSettings({ scanBoundary: 'stay' });
      const built = await buildThroughRoute(base, f.root);
      assert.equal(built.live, true, 'the build attached its watcher');
      const speak = watches.get(f.root) ?? assert.fail('a watch on the folder itself');
      fs.writeFileSync(path.join(f.mnt, 'new-on-the-drive.bin'), 'n'.repeat(4096));
      fs.writeFileSync(path.join(f.other, 'new-here.bin'), 'h'.repeat(2048));
      speak('rename', 'mnt'); // the mount point itself
      speak('rename', 'mnt/new-on-the-drive.bin');
      speak('rename', 'other/new-here.bin');
      await waitFor(() => idOf(f.root, path.join(f.other, 'new-here.bin')) !== null, 'the change on this drive reaching the index');
      assert.equal(idOf(f.root, f.mnt), null, 'the change on the other drive made no row for the mount point');
      assert.equal(idOf(f.root, path.join(f.mnt, 'new-on-the-drive.bin')), null, 'nor for the file on it');
      assert.equal(getRoot(f.root)?.fileCount, 3, 'three files: two built, one applied');
    } finally {
      deleteIndex(f.root);
    }
  });
});

test('POST /api/index/watch on a folder built before this process started drops changes on the drives the setting leaves out', { skip: NO_TABLE }, async (t) => {
  const f = tree();
  useTable([f.mnt]);
  await withServer(async (base) => {
    try {
      await updateSettings({ scanBoundary: 'stay' });
      const built = await buildThroughRoute(base, f.root);
      assert.equal(built.fileCount, 2);
      stopAllWatchers();
      closeIndex(); // what the next start of TreeMap finds: the index, and nothing of the process that built it
      openIndex();

      const watches = fakeWatches(t);
      const attached = await call(base, 'POST', '/api/index/watch', { path: f.root });
      assert.equal(attached.status, 200, JSON.stringify(attached.json));
      assert.equal(attached.json.watching, true);
      const speak = watches.get(f.root) ?? assert.fail('a watch on the folder itself');
      fs.writeFileSync(path.join(f.mnt, 'new-on-the-drive.bin'), 'n'.repeat(4096));
      fs.writeFileSync(path.join(f.other, 'new-here.bin'), 'h'.repeat(2048));
      speak('rename', 'mnt'); // the mount point itself
      speak('rename', 'mnt/new-on-the-drive.bin');
      speak('rename', 'other/new-here.bin');
      await waitFor(() => idOf(f.root, path.join(f.other, 'new-here.bin')) !== null, 'the change on this drive reaching the index');
      assert.equal(idOf(f.root, f.mnt), null, 'the change on the other drive made no row for the mount point');
      assert.equal(idOf(f.root, path.join(f.mnt, 'new-on-the-drive.bin')), null, 'nor for the file on it');
    } finally {
      deleteIndex(f.root);
    }
  });
});

/* ══════════════════ the rule an index was built under (final review F1.5) ══════════════════ */

/** What the badge says of an index built under the rule the setting no longer has. */
const BOUNDARY_CHANGED = /^The “Stay on this drive” setting has changed since this index was built, so a drive mounted inside this folder may be counted differently now\.$/;

/** The saved index of `root`, as GET /api/index/status describes it. */
async function savedIndexOf(base: string, root: string): Promise<{ state: string; live: boolean; staleReason?: string }> {
  const answer = await call(base, 'GET', '/api/index/status?path=' + encodeURIComponent(root));
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.root as { state: string; live: boolean; staleReason?: string };
}

/** PUT /api/settings with "Stay on this drive" set to `rule`, as the Settings window saves it. */
async function saveRule(base: string, rule: 'stay' | 'cross'): Promise<void> {
  const answer = await call(base, 'PUT', '/api/settings', { scanBoundary: rule });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
}

test('changing "Stay on this drive" makes every saved index stale, saying why, so the next scan rebuilds it under the new rule; saving the rule it had changes nothing (final review F1.5)', { skip: NO_TABLE }, async (t) => {
  // The page treats a ready, watched index as current and never rebuilds it; nothing recorded the
  // rule a build ran under, so after the switch every later open painted the index without the
  // drive's bytes (or with them, the other way round) until a restart made it stale.
  const f = tree();
  useTable([f.mnt]);
  fakeWatches(t); // the build attaches its watcher, as one after a scan does
  await withServer(async (base) => {
    try {
      await updateSettings({ scanBoundary: 'stay' });
      const built = await buildThroughRoute(base, f.root);
      assert.equal(built.live, true, 'built under "stay", and watched: current');
      await saveRule(base, 'stay');
      assert.equal((await savedIndexOf(base, f.root)).state, 'ready', 'the rule it had, saved again: the index is still current');
      await saveRule(base, 'cross');
      const switched = await savedIndexOf(base, f.root);
      assert.equal(switched.state, 'stale', 'built under "stay", read under "cross": not current, so the next scan rebuilds it');
      assert.match(switched.staleReason ?? '', BOUNDARY_CHANGED, 'and the badge says why');
      const rebuilt = await buildThroughRoute(base, f.root);
      assert.equal(rebuilt.fileCount, 3, 'rebuilt under "cross": the drive mounted inside is counted');
      assert.equal((await savedIndexOf(base, f.root)).state, 'ready', 'and the rebuilt index is current');
    } finally {
      await updateSettings({ scanBoundary: 'stay' });
      deleteIndex(f.root);
    }
  });
});

test('a build that read the rule before "Stay on this drive" changed finishes stale, saying why, not current (final review F1.5)', { skip: NO_TABLE }, async () => {
  // The rule is read as the build starts; a switch while it walks — a large folder's build after a
  // scan, the Settings window opened meanwhile — would leave a current-looking index under the old one.
  const f = tree();
  let tableAsked = false;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  setBoundaryDepsForTests({
    readTable: async () => { tableAsked = true; await held; return mountTableNaming([f.mnt]); },
    aliases: async () => () => [],
  });
  await withServer(async (base) => {
    try {
      await updateSettings({ scanBoundary: 'stay' });
      const started = await call(base, 'POST', '/api/index/build', { path: f.root });
      assert.equal(started.status, 202, JSON.stringify(started.json));
      await waitFor(() => tableAsked, 'the build reading the mount table, its rule read');
      await saveRule(base, 'cross');
      release();
      const done = await settle(base, started.json.jobId);
      assert.equal(done.status, 200, JSON.stringify(done.json));
      const answered = done.json.root as { state: string; fileCount: number; staleReason?: string };
      assert.equal(answered.fileCount, 2, 'it walked under "stay", the rule it read');
      assert.equal(answered.state, 'stale', 'and the job does not answer it as current');
      const saved = await savedIndexOf(base, f.root);
      assert.equal(saved.state, 'stale', 'nor does the status');
      assert.match(saved.staleReason ?? '', BOUNDARY_CHANGED);
    } finally {
      release();
      useTable([]);
      await updateSettings({ scanBoundary: 'stay' });
      deleteIndex(f.root);
    }
  });
});

/* ══════════════════ a root on the Data volume ══════════════════ */

/**
 * The index's watcher leaves out what `exclusionsOf` leaves out, the scanned-root rule's own reading (the SEC-1
 * review's notes): for a root on macOS's Data volume that includes the fixed folders as that volume spells them,
 * whatever list the build was handed. The index kept a private copy of the filter that read the list alone. A
 * test cannot index the Data volume, so it stands in: this file's temp folder by the Data volume's spelling, and
 * one of its folders added to the fixed list by the root's spelling.
 */
test('an index of a folder on the Data volume drops a change in a fixed folder as that volume spells it, though its build was handed the root’s spelling alone', { skip: process.platform !== 'darwin' && 'the Data volume is macOS’s' }, async (t) => {
  const f = tree();
  const DATA = '/System/Volumes/Data';
  const onData = DATA + f.root;
  if (!fs.existsSync(onData)) return t.skip(`${onData} is not this temp folder's Data-volume spelling here`);
  const watches = fakeWatches(t);
  setNeverDescendForTests([f.other]);
  try {
    const built = await buildIndex(onData, { neverDescend: neverDescendPaths() });
    assert.equal(built.live, true, 'the build attached its watcher');
    const speak = watches.get(onData) ?? assert.fail('a watch on the folder itself');
    fs.writeFileSync(path.join(f.other, 'new-in-the-fixed-folder.bin'), 'n'.repeat(4096));
    fs.writeFileSync(path.join(f.mnt, 'new-here.bin'), 'h'.repeat(2048));
    speak('rename', 'other/new-in-the-fixed-folder.bin');
    speak('rename', 'mnt/new-here.bin');
    await waitFor(() => idOf(onData, `${DATA}${f.mnt}/new-here.bin`) !== null, 'the change elsewhere reaching the index');
    assert.equal(idOf(onData, `${DATA}${f.other}/new-in-the-fixed-folder.bin`), null, 'the change in the fixed folder, as the Data volume spells it, was dropped');
  } finally {
    setNeverDescendForTests(null);
    deleteIndex(onData);
  }
});
