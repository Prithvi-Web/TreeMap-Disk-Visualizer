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
import { setBoundaryDepsForTests } from '../src/utils/mountBoundaries';
import { setWatchImplForTests, type WatchListener } from '../src/platform/watchRegistry';
import {
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
