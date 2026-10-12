import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-indexBuildRoot-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
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
 * `/var/...` reach the build as links. The build never follows a link — the
 * root included: it indexes the link itself as one file. Before this, the
 * walk listed the folder the link points at while the root was recorded as a
 * file, and every build of it failed ("the folder numbered 0 was never handed
 * over") — after setting the saved index aside, for an explicit build. A scan
 * of the same path follows it (QA D78): it is rooted at the folder the link
 * points to, and the page builds the index from the scan's root, so the index
 * it asks for is that folder's and holds what the scan shows.
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

/**
 * `real/{a.txt, sub/b.txt}`, and `link` → `real`. Only the parent is a real path — by the native
 * realpath, as a scan resolves a link root: the JS one keeps the temp folder as typed, and the Windows
 * runner's is the 8.3 `RUNNER~1` (CI run 38318285188).
 */
function linkTree(): LinkTree {
  const base = fs.realpathSync.native(fileTempDir('treemap-indexBuildRoot-'));
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

test('the page builds the index from the scan’s root: a scan of a link to a folder is of the folder (D78), and the index of that root holds what the scan shows — explicit or capped', { skip: NO_LINKS }, async () => {
  const { real, link } = linkTree();

  const scan = await startScan(link);
  await waitFor(() => scan.status !== 'running', 'the scan of the link settling');
  assert.equal(scan.status, 'complete', scan.error);
  const scanned = getScan(scan.scanId) ?? scan;
  assert.equal(scanned.rootPath, real, 'the scan is rooted at the folder the link points to');
  const store = storeOf(scanned);
  assert.equal(scanned.fileCount, 2);
  assert.equal(scanned.dirCount, 2);

  for (const cap of [undefined, 10]) {
    const built = await buildIndex(scanned.rootPath, { live: false, ...(cap === undefined ? {} : { maxEntries: cap }) });
    const how = cap === undefined ? 'explicit' : 'capped';
    assert.equal(built.state, 'ready', `${how}: the build of the scan's root completes`);
    assert.equal(built.path, real);
    assert.equal(built.fileCount, scanned.fileCount, `${how}: as many files as the scan shows`);
    assert.equal(built.dirCount, scanned.dirCount, `${how}: as many folders as the scan shows`);
    assert.equal(built.totalSize, store.size(store.rootId), `${how}: the size the scan shows`);
  }
});

test('an index asked for by a link’s own path is the link itself: one row, never followed — explicit or capped', { skip: NO_LINKS }, async () => {
  const { link } = linkTree();
  const linkBytes = fs.lstatSync(link).size;

  for (const cap of [undefined, 10]) {
    const built = await buildIndex(link, { live: false, ...(cap === undefined ? {} : { maxEntries: cap }) });
    const how = cap === undefined ? 'explicit' : 'capped';
    assert.equal(built.state, 'ready', `${how}: the build of a link completes`);
    assert.equal(built.path, link, `${how}: under the path it was given, not the link's target`);
    assert.equal(built.fileCount, 1, `${how}: one file`);
    assert.equal(built.dirCount, 0, `${how}: no folder`);
    assert.equal(built.totalSize, linkBytes, `${how}: the link's own bytes`);
    const rows = rowsOf(built.id);
    assert.equal(rows.length, 1, `${how}: one row — nothing behind the link is in it: ${rows.map((r) => r.name).join(', ')}`);
    assert.equal(rows[0].name, 'link');
    assert.equal(rows[0].is_dir, 0, `${how}: the link is a leaf, as every link inside a tree is`);
    assert.ok((rows[0].flags & FLAG.SYMLINK) !== 0, `${how}: and says it is a link`);
    const tree = readTree(link);
    assert.equal(tree?.root.type, 'file', `${how}: the tree read shows one file`);
    assert.equal(tree?.root.size, linkBytes);
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

/* ══════════════════ a link the index holds, asked for by its own path (final review F1.4) ══════════════════ */

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function get(base: string, url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  resetRateLimiter();
  const res = await fetch(base + url);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const statusOf = (base: string, p: string) => get(base, '/api/index/status?path=' + encodeURIComponent(p));
const treeOf = (base: string, p: string) => get(base, '/api/index/tree?path=' + encodeURIComponent(p) + '&maxNodes=25000');

test('a link inside an indexed folder is not served as a folder of the index: the page is told it is not indexed, and scans the folder it points to, as the scan does (final review F1.4)', { skip: NO_LINKS }, async () => {
  // A scan of a link to a folder walks the folder (D78); the index records the link as the one entry
  // it is (M-1). Served under the link's spelling, the instant paint was a one-tile map of 100-odd
  // bytes, labelled "Index live — always current", until the scan replaced it — or for good, if it failed.
  const { real, link } = linkTree();
  const parent = path.dirname(real);
  const built = await buildIndex(parent, { live: false });
  assert.equal(built.state, 'ready');
  const { base, close } = await listen();
  try {
    const status = await statusOf(base, link);
    assert.equal(status.status, 200);
    assert.equal(status.json.indexed, false, 'the link is not a folder the index holds');
    assert.equal(status.json.root, null, 'and no root is offered for it');
    const tree = await treeOf(base, link);
    assert.equal(tree.status, 404, 'its tree is not served either');
    assert.equal(tree.json.code, 'PATH_NOT_FOUND');
    // The folder it points to, and the folder holding it, are served as they always were.
    assert.equal((await statusOf(base, real)).json.indexed, true);
    assert.equal((await treeOf(base, real)).status, 200);
    assert.equal((await statusOf(base, parent)).json.indexed, true);
  } finally {
    await close();
  }
});

test('an index saved under a link\'s own path (a one-row index of the link) is not served for it either (final review F1.4)', { skip: NO_LINKS }, async () => {
  // Before D78 a scan of /tmp asked for the index of /tmp itself: one row, the link.
  const { link } = linkTree();
  await buildIndex(link, { live: false });
  const { base, close } = await listen();
  try {
    const status = await statusOf(base, link);
    assert.equal(status.json.indexed, false, 'not offered as the folder the link points to');
    assert.equal((await treeOf(base, link)).status, 404);
  } finally {
    await close();
  }
});

test('the published spec says what the two index routes answer for a link the index holds: the tree is 404 PATH_NOT_FOUND, the status indexed false and root null (final review F2.1)', { skip: NO_LINKS }, async () => {
  // AGENTS.md names /api/openapi.json the machine-readable contract; it listed INDEX_NOT_BUILT alone for
  // the tree's 404, and said nothing of a link, so an agent reading it could not expect either answer.
  const { real, link } = linkTree();
  const parent = path.dirname(real);
  await buildIndex(parent, { live: false });
  const { base, close } = await listen();
  try {
    const answers = [
      await treeOf(base, link), // a link the index holds
      await treeOf(base, path.join(parent, 'not-there')), // a path inside an indexed folder that the index does not hold
      await treeOf(base, fs.realpathSync(fileTempDir('treemap-indexBuildRoot-unindexed-'))), // a folder no index holds
    ];
    assert.deepEqual(answers.map((a) => [a.status, a.json.code]), [[404, 'PATH_NOT_FOUND'], [404, 'PATH_NOT_FOUND'], [404, 'INDEX_NOT_BUILT']]);
    const status = await statusOf(base, link);
    assert.deepEqual([status.json.indexed, status.json.root], [false, null]);

    const doc = (await get(base, '/api/openapi.json')).json as { paths: Record<string, { get: { responses: Record<string, { description: string; content?: Record<string, { schema: { description?: string } }> }> } }> };
    const tree404 = doc.paths['/api/index/tree'].get.responses['404'].description;
    for (const answer of answers) assert.ok(tree404.includes(String(answer.json.code)), `the tree's 404 names ${String(answer.json.code)}: ${tree404}`);
    assert.match(tree404, /PATH_NOT_FOUND — [^;]*\blink\b/, 'and says a link the index holds is answered so');
    const statusSaid = doc.paths['/api/index/status'].get.responses['200'].content?.['application/json'].schema.description ?? '';
    assert.match(statusSaid, /\blink\b[^.]*\bindexed false and root null\b/, `the status says a link answers indexed false and root null: ${statusSaid}`);
  } finally {
    await close();
  }
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
