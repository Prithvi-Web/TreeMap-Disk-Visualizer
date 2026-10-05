import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexBuildRoot-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getScan, startScan } from '../src/services/diskScanner';
import { storeOf } from '../src/services/scanStore';
import {
  FLAG,
  buildIndex,
  closeIndex,
  getRoot,
  openIndex,
  readTree,
  reclaimsSettled,
  startWatcher,
  stopAllWatchers,
} from '../src/services/indexEngine';

/**
 * What an index build does with the folder it is given (Track U review of
 * the index, 5 Oct 2026, M-1).
 *
 * A root that is a link to a folder. `sanitizePath` returns the caller's
 * spelling, never the link's target, so `~/Projects` as a link, `/tmp` and
 * `/var/...` reach the build as links. A scan never follows a link — the
 * root included: it lstats the root, finds no folder, and shows the link
 * itself as one file. The index shows what the scan of the same path shows.
 * Before this, the walk listed the folder the link points at while the root
 * was recorded as a file, and every build of it failed ("the folder numbered
 * 0 was never handed over") — after setting the saved index aside, for an
 * explicit build.
 *
 * A root that cannot be walked — gone, or a folder TreeMap may not list —
 * is refused with a sentence before anything is written, so an explicit
 * build, which replaces the saved index up front (U-D3), never trades it for
 * an error or for an index of nothing.
 *
 * Nothing here follows a fixture through `realpath`: the link must reach the
 * build as a link. Every assertion counts rows, files and folders.
 */

after(async () => {
  stopAllWatchers();
  await reclaimsSettled();
  closeIndex();
});

interface LinkTree {
  real: string;
  link: string;
}

/** `real/{a.txt, sub/b.txt}`, and `link` → `real`. Only the parent is a real path. */
function linkTree(): LinkTree {
  const base = fs.realpathSync(fileTempDir('treemap-indexBuildRoot-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(real, 'a.txt'), 'a'.repeat(1000));
  fs.writeFileSync(path.join(real, 'sub', 'b.txt'), 'b'.repeat(2000));
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link, 'dir');
  return { real, link };
}

let canLink = true;
try {
  linkTree();
} catch {
  canLink = false; // Windows without the symlink privilege
}
const NO_LINKS = canLink ? false : 'this account cannot create symlinks';

/** A folder of `files` small files, by its real path. */
function folder(files: number): string {
  const dir = fs.realpathSync(fileTempDir('treemap-indexBuildRoot-dir-'));
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x');
  return dir;
}

type Row = { id: number; parent_id: number | null; name: string; is_dir: number; size: number; flags: number };
function rowsOf(rootId: number): Row[] {
  return openIndex().prepare('SELECT id, parent_id, name, is_dir, size, flags FROM nodes WHERE root_id = ? ORDER BY id').all(rootId) as Row[];
}
const rootsCount = (): number => (openIndex().prepare('SELECT COUNT(*) c FROM roots').get() as { c: number }).c;

/* ══════════════════ a root that is a link ══════════════════ */

test('an index of a link to a folder is the link itself, as a scan of the same path shows it: one row, never followed — explicit or capped', { skip: NO_LINKS }, async () => {
  const { link } = linkTree();
  const linkBytes = fs.lstatSync(link).size;

  const scan = await startScan(link);
  await waitFor(() => scan.status !== 'running', 'the scan of the link settling');
  assert.equal(scan.status, 'complete', scan.error);
  const scanned = getScan(scan.scanId) ?? scan;
  const store = storeOf(scanned);
  assert.equal(store.isDir(store.rootId), false, 'the scan shows the link as a file: it never follows a link');
  assert.equal(scanned.fileCount, 1);
  assert.equal(scanned.dirCount, 0);

  for (const cap of [undefined, 10]) {
    const built = await buildIndex(link, { live: false, ...(cap === undefined ? {} : { maxEntries: cap }) });
    const how = cap === undefined ? 'explicit' : 'capped';
    assert.equal(built.state, 'ready', `${how}: the build of a link completes`);
    assert.equal(built.path, link, `${how}: under the path it was given, not the link's target`);
    assert.equal(built.fileCount, scanned.fileCount, `${how}: as many files as the scan shows`);
    assert.equal(built.dirCount, scanned.dirCount, `${how}: as many folders as the scan shows`);
    assert.equal(built.totalSize, store.size(store.rootId), `${how}: the size the scan shows`);
    assert.equal(built.totalSize, linkBytes, `${how}: which is the link's own bytes`);
    const rows = rowsOf(built.id);
    assert.equal(rows.length, 1, `${how}: one row — nothing behind the link is in it: ${rows.map((r) => r.name).join(', ')}`);
    assert.equal(rows[0].name, 'link');
    assert.equal(rows[0].is_dir, 0, `${how}: the link is a leaf, as every link inside a tree is`);
    assert.ok((rows[0].flags & FLAG.SYMLINK) !== 0, `${how}: and says it is a link`);
    const tree = readTree(link);
    assert.equal(tree?.root.type, 'file', `${how}: the tree read shows the file the scan shows`);
    assert.equal(tree?.root.size, store.size(store.rootId));
  }
});

test('a link root gets no live watcher: a watch on a link reports the folder it points at, which its index does not hold', { skip: NO_LINKS }, async () => {
  const { link } = linkTree();
  const built = await buildIndex(link); // live by default
  assert.equal(built.state, 'ready');
  assert.equal(built.live, false, 'no watcher was attached to the link');
  assert.equal(startWatcher(link), false, 'nor is one attached on request');
  assert.equal(getRoot(link)?.live, false);
  assert.equal(rowsOf(built.id).length, 1);
});

/* ══════════════════ a root that cannot be walked ══════════════════ */

test('a build of a folder that is not there any more is refused with a sentence before it touches anything: the saved index, its rows and its state are kept — explicit or capped', async (t) => {
  for (const cap of [undefined, 1000]) {
    const how = cap === undefined ? 'explicit' : 'capped';
    const dir = folder(5);
    const saved = await buildIndex(dir, { live: false });
    const savedRows = rowsOf(saved.id);
    const roots = rootsCount();
    fs.renameSync(dir, `${dir}-moved`);
    t.after(() => fs.rmSync(`${dir}-moved`, { recursive: true, force: true }));

    await assert.rejects(buildIndex(dir, { live: false, ...(cap === undefined ? {} : { maxEntries: cap }) }), (err: Error) => {
      assert.match(err.message, /^TreeMap could not index .+: there is nothing at that path\. Nothing was changed: its saved index, if it has one, is kept\.$/, `${how}: ${err.message}`);
      assert.ok(err.message.includes(dir), `${how}: the sentence names the folder`);
      return true;
    });
    const after = getRoot(dir);
    assert.equal(after?.id, saved.id, `${how}: the saved index is still the folder's`);
    assert.equal(after?.state, saved.state, `${how}: in the state it had`);
    assert.deepEqual(rowsOf(saved.id), savedRows, `${how}: with every row`);
    assert.equal(rootsCount(), roots, `${how}: and no root was added, set aside or marked failed`);
  }
});

const NO_MODES = process.platform === 'win32'
  ? 'Windows does not refuse a listing through mode bits'
  : process.getuid?.() === 0 ? 'running as root, every folder can be listed' : false;

test('a build of a folder TreeMap may not list is refused with a sentence, not answered with an index of nothing: the saved index is kept — explicit or capped', { skip: NO_MODES }, async (t) => {
  for (const cap of [undefined, 1000]) {
    const how = cap === undefined ? 'explicit' : 'capped';
    const dir = folder(5);
    const saved = await buildIndex(dir, { live: false });
    const savedRows = rowsOf(saved.id);
    const roots = rootsCount();
    fs.chmodSync(dir, 0o000);
    t.after(() => fs.chmodSync(dir, 0o755));

    await assert.rejects(buildIndex(dir, { live: false, ...(cap === undefined ? {} : { maxEntries: cap }) }), (err: Error) => {
      assert.match(err.message, /^TreeMap could not index .+: TreeMap is not allowed to open it\. Nothing was changed: its saved index, if it has one, is kept\.$/, `${how}: ${err.message}`);
      return true;
    });
    fs.chmodSync(dir, 0o755);
    const after = getRoot(dir);
    assert.equal(after?.id, saved.id, `${how}: the saved index is still the folder's`);
    assert.equal(after?.fileCount, 5, `${how}: with its five files, not an index of nothing`);
    assert.deepEqual(rowsOf(saved.id), savedRows, `${how}: and every row`);
    assert.equal(rootsCount(), roots, `${how}: and no root was added, set aside or marked failed`);
  }
});
