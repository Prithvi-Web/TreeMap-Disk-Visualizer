import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotTrees-data-');

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileTempDir } from './fixtures/dataDir';
import { FileNode, ScanResult, SnapshotTreeNode } from '../src/models/types';
import { buildSnapshotTree, inflateSnapshotTree, closestSnapshot, prevSizeLookup, saveSnapshot } from '../src/services/snapshots';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { getScan, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { settled } from '../src/utils/backgroundWrites';
import { waitFor } from './fixtures/waitFor';
import { buildStoreFromTree } from '../src/services/scanStore';
import { markUnlisted } from '../src/services/scanRefusals';
process.env.TREEMAP_NO_GDU = '1';

/** Unit tests for the time-slider snapshot-tree logic (pure functions). */

function dir(p: string, name: string, children: FileNode[]): FileNode {
  return {
    name,
    path: p,
    size: children.reduce((s, c) => s + c.size, 0),
    type: 'dir',
    children,
    modifiedAt: 0,
    isHidden: false,
  };
}

function file(p: string, name: string, size: number): FileNode {
  return { name, path: p, size, type: 'file', modifiedAt: 0, isHidden: false };
}

test('buildSnapshotTree keeps parent sizes truthful when children are dropped', () => {
  // 40 files of 1 byte in one dir: only the largest 30 are stored, but the
  // dir's own stored size must stay 40.
  const files = Array.from({ length: 40 }, (_, i) => file(`/r/d/f${i}`, `f${i}`, 1));
  const root = dir('/r', 'r', [dir('/r/d', 'd', files)]);
  const tree = buildSnapshotTree(root);
  assert.equal(tree.s, 40);
  const d = tree.c![0];
  assert.equal(d.s, 40);
  assert.equal(d.c!.length, 30);
});

test('buildSnapshotTree stays within its byte budget on a wide tree', () => {
  // 60 dirs × 60 long-named files would blow 100 KB at full fidelity.
  const dirs = Array.from({ length: 60 }, (_, i) =>
    dir(`/r/dir${i}`, `directory-with-a-fairly-long-name-${i}`,
      Array.from({ length: 60 }, (_, j) =>
        file(`/r/dir${i}/f${j}`, `file-with-a-fairly-long-name-${i}-${j}.bin`, 1000 + j)))
  );
  const root = dir('/r', 'r', dirs);
  const tree = buildSnapshotTree(root);
  assert.ok(JSON.stringify(tree).length <= 100_000, 'serialized tree fits the budget');
  assert.equal(tree.s, root.size, 'root size preserved');
});

test('buildSnapshotTree caps depth at 3 levels', () => {
  const deep = dir('/r', 'r', [
    dir('/r/a', 'a', [
      dir('/r/a/b', 'b', [
        dir('/r/a/b/c', 'c', [file('/r/a/b/c/f', 'f', 5)]),
      ]),
    ]),
  ]);
  const tree = buildSnapshotTree(deep);
  const a = tree.c![0];
  const b = a.c![0];
  const c = b.c![0];
  assert.equal(c.n, 'c');
  assert.equal(c.s, 5); // still carries its full size…
  assert.equal(c.c, undefined); // …but stores no children past level 3
});

test('inflateSnapshotTree rebuilds paths and stamps the snapshot time', () => {
  const root = dir('/Users/t/Music', 'Music', [
    dir('/Users/t/Music/Beatles', 'Beatles', [file('/Users/t/Music/Beatles/help.mp3', 'help.mp3', 9)]),
  ]);
  const inflated = inflateSnapshotTree(buildSnapshotTree(root), '/Users/t/Music', 1234);
  assert.equal(inflated.path, '/Users/t/Music');
  assert.equal(inflated.children![0].path, '/Users/t/Music/Beatles');
  assert.equal(inflated.children![0].children![0].path, '/Users/t/Music/Beatles/help.mp3');
  assert.equal(inflated.children![0].children![0].type, 'file');
  assert.equal(inflated.modifiedAt, 1234);
});

test('inflateSnapshotTree uses backslashes for Windows roots', () => {
  const root = dir('C:\\Data', 'Data', [file('C:\\Data\\x.bin', 'x.bin', 3)]);
  const inflated = inflateSnapshotTree(buildSnapshotTree(root), 'C:\\Data', 1);
  assert.equal(inflated.children![0].path, 'C:\\Data\\x.bin');
});

test('closestSnapshot picks the nearest takenAt in either direction', () => {
  const snaps = [{ takenAt: 100 }, { takenAt: 200 }, { takenAt: 400 }];
  assert.equal(closestSnapshot(snaps, 0)!.takenAt, 100);
  assert.equal(closestSnapshot(snaps, 240)!.takenAt, 200);
  assert.equal(closestSnapshot(snaps, 320)!.takenAt, 400);
  assert.equal(closestSnapshot(snaps, 9999)!.takenAt, 400);
  assert.equal(closestSnapshot([], 5), null);
});

/* ---------- the time slider's diff overlay reads a cut list as a cut list (leftover HE-L4) ---------- */

/** 40 files in `root`, f01 the largest; `sizeOf` may change one. */
function forty(root: string, sizeOf: (name: string, size: number) => number = (_n, s) => s): FileNode[] {
  return Array.from({ length: 40 }, (_, i) => {
    const name = `f${String(i + 1).padStart(2, '0')}`;
    return file(`${root}/${name}`, name, sizeOf(name, 1000 - i * 10));
  });
}

test('a stored tree marks a folder whose children it cut, and the overlay\'s lookup reads an item missing from it as unknown, never as new (leftover HE-L4)', () => {
  const prev = buildSnapshotTree(dir('/data', 'data', [
    ...forty('/data'),
    dir('/data/sub', 'sub', [file('/data/sub/a', 'a', 5000), file('/data/sub/b', 'b', 4000)]),
  ]));
  assert.equal(prev.m, 1, 'the tree says it marks its cut folders');
  assert.equal(prev.k, 1, 'the folder of 41 children kept 30: cut');
  assert.equal(prev.c?.find((c) => c.n === 'sub')?.k, undefined, 'a folder whose every child was kept is not');
  const prevOf = prevSizeLookup(prev, '/data');
  assert.equal(prevOf('/data/f01'), 1000, 'a stored item has its size');
  assert.equal(prevOf('/data/f31'), undefined, 'one past the cut is not known to have been absent');
  assert.equal(prevOf('/data/sub/new'), null, 'one missing from a whole list did not exist');
  assert.equal(prevOf('/data/sub/new/deeper'), null, 'nor did anything inside it');
  // At the depth limit no children are stored at all: what was in that folder is not known.
  const deep = buildSnapshotTree(dir('/r', 'r', [dir('/r/a', 'a', [dir('/r/a/b', 'b', [dir('/r/a/b/c', 'c', [file('/r/a/b/c/x', 'x', 10)])])])]));
  assert.equal(prevSizeLookup(deep, '/r')('/r/a/b/c/y'), undefined);
  assert.equal(prevSizeLookup(deep, '/r')('/r/a/b/c'), 10);
});

test('a folder is marked cut exactly when a child with bytes was left out: one that kept its 30, or kept its overflow as unlisted folders beside them, is whole, and an item missing from it did not exist (review F1.8)', () => {
  /** `/r` holding `files` files, the largest first, and — when `refused` — a folder the scan was refused (0 bytes). */
  const stored = (files: number, refused: boolean): SnapshotTreeNode => {
    const kids: FileNode[] = Array.from({ length: files }, (_, i) => file(`/r/f${i}`, `f${i}`, 1000 - i));
    if (refused) kids.push(dir('/r/refused', 'refused', []));
    const store = buildStoreFromTree(dir('/r', 'r', kids));
    if (refused) markUnlisted(store, store.findByPath('/r/refused'));
    return buildSnapshotTree(store);
  };
  const thirty = stored(30, false);
  assert.equal(thirty.c?.length, 30, 'control: all 30 kept');
  assert.equal(thirty.k, undefined, 'exactly 30 children, all kept: not cut');
  assert.equal(prevSizeLookup(thirty, '/r')('/r/brand-new'), null, 'so an item missing from it did not exist');
  const withExtra = stored(30, true);
  assert.equal(withExtra.c?.length, 31, 'control: the refused folder is kept beside the largest 30');
  assert.equal(withExtra.k, undefined, '31 children, the 31st an unlisted folder kept as an extra: not cut');
  assert.equal(prevSizeLookup(withExtra, '/r')('/r/brand-new'), null, 'so an item missing from it did not exist');
  const cut = stored(31, true);
  assert.equal(cut.c?.length, 31, 'control: the largest 30 and the refused folder are kept');
  assert.equal(cut.k, 1, '32 children, one with bytes left out: cut');
  assert.equal(prevSizeLookup(cut, '/r')('/r/brand-new'), undefined, 'so an item missing from it is not known to have been absent');
});

test('a folder the previous scan could not list in full is read as not known, never as holding nothing (leftover HE-L4, as hunt C47)', () => {
  const prev: SnapshotTreeNode = { n: 'data', s: 10, t: 1, m: 1, c: [{ n: 'Mail', s: 0, t: 1, u: 1 }, { n: 'docs', s: 10, t: 1, c: [{ n: 'a', s: 10 }] }, { n: 'empty', s: 0, t: 1 }] };
  const prevOf = prevSizeLookup(prev, '/data');
  assert.equal(prevOf('/data/Mail/msg.emlx'), undefined, 'what a refused folder held is not known');
  assert.equal(prevOf('/data/Mail'), undefined, 'nor its own size: the 0 stored for it is not what it held (review F1.2)');
  assert.equal(prevOf('/data/docs'), 10, 'a folder listed in full has its size');
  assert.equal(prevOf('/data/docs/b'), null, 'a folder listed in full held only what it lists');
  assert.equal(prevOf('/data/empty/new'), null, 'nor did an empty folder hold anything');
});

test('what the overlay\'s prevSize means is stated with every reason it can be absent, and null only where the folder holding it listed every child (review F1.3)', () => {
  const openapi = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'openapi.ts'), 'utf8');
  assert.ok(openapi.includes("prevSize: nullable(int('Historical layouts only: size in the previous snapshot; null = did not exist (the folder holding it in the previous snapshot listed every child with bytes, apart from what the same “Don’t scan” rules left out of both scans); absent when that is not known — the previous snapshot kept only its largest children there, or none at its depth limit, or could not list it, or the folder holding it, in full (refused, unreadable, not entered, or holding an entry it could not look at)')),"), 'the OpenAPI prevSize names the third cause');
});

test('a tree an earlier build stored, with no marks, is read as cut wherever it kept as many children as the narrowest shape keeps (leftover HE-L4)', () => {
  const kids = (n: number): SnapshotTreeNode[] => Array.from({ length: n }, (_, i) => ({ n: `k${i}`, s: 100 - i }));
  const wide: SnapshotTreeNode = { n: 'data', s: 999, t: 1, c: kids(10) };
  const narrow: SnapshotTreeNode = { n: 'data', s: 999, t: 1, c: kids(3) };
  assert.equal(prevSizeLookup(wide, '/data')('/data/other'), undefined, 'ten kept: there may have been more');
  assert.equal(prevSizeLookup(narrow, '/data')('/data/other'), null, 'three kept: that was all of them');
});

test('GET /api/snapshots/tree sends no "did not exist" for an item that only fell past the previous tree\'s cut (leftover HE-L4)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-snapshotTrees-overlay-')); // as the route's path guard spells it
  const tree = (files: FileNode[], subFiles: FileNode[]): FileNode => dir(root, path.basename(root), [...files, dir(path.join(root, 'sub'), 'sub', subFiles)]);
  const at = (name: string): string => path.join(root, name);
  const scanOf = (t: FileNode, when: number): ScanResult => ({
    scanId: `overlay-${when}`, rootPath: root, status: 'complete', scanned: 0, fileCount: 0, dirCount: 0, currentPath: '',
    root: t, startedAt: when, finishedAt: when, createdAt: when, cancelled: false,
  }) as unknown as ScanResult;
  const files = (sizeOf?: (n: string, s: number) => number): FileNode[] => forty(root, sizeOf).map((f) => ({ ...f, path: at(f.name) }));
  await saveSnapshot(scanOf(tree(files(), [file(path.join(root, 'sub', 'a'), 'a', 5000)]), 1_000_000));
  // sub and the largest 29 files were kept; f05 and f06 shrink to 1 byte, so f30 and f31 — unchanged —
  // are now among the largest 30 kept; sub gains b.
  await saveSnapshot(scanOf(tree(files((n, s) => (n === 'f05' || n === 'f06' ? 1 : s)), [file(path.join(root, 'sub', 'a'), 'a', 5000), file(path.join(root, 'sub', 'b'), 'b', 3000)]), 2_000_000));
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  let body: { nodes: (FileNode & { prevSize?: number | null })[]; tree: FileNode & { children?: (FileNode & { prevSize?: number | null })[] } };
  try {
    const port = (server.address() as { port: number }).port;
    body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/snapshots/tree?path=${encodeURIComponent(root)}&at=2000000` }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  const node = (p: string) => body.nodes.find((n) => n.path === p);
  for (const name of ['f30', 'f31']) {
    assert.ok(node(at(name)), `${name} is drawn`);
    assert.equal('prevSize' in (node(at(name)) as object), false, `${name} is not called new: ${JSON.stringify(node(at(name)))}`);
  }
  assert.equal(node(at('f01'))?.prevSize, 1000, 'a stored item is compared');
  assert.equal(node(path.join(root, 'sub', 'b'))?.prevSize, null, 'an item missing from a whole list is new');
  const treeKid = body.tree.children?.find((c) => c.path === at('f31'));
  assert.equal(treeKid !== undefined && 'prevSize' in treeKid, false, 'the sunburst\'s tree says the same');
});

/* ---------- the overlay compares two snapshots only under the same "Don't scan" rules (review F1.1) ---------- */

type Layout = { prevTakenAt: number | null; nodes: (FileNode & { prevSize?: number | null })[] };

/** GET /api/snapshots/tree for `root`, at a time past every snapshot: the newest one and the one before. */
async function newestLayout(root: string): Promise<Layout> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/snapshots/tree?path=${encodeURIComponent(root)}&at=${Date.now() + 86_400_000}` }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A real scan of `root` under the current settings, its snapshot and tree saved. */
async function scanAndSave(root: string): Promise<void> {
  const { scanId } = await startScan(root);
  await waitFor(() => getScan(scanId)?.status !== 'running', 'the scan settling');
  assert.equal(getScan(scanId)?.status, 'complete');
  await settled();
}

test('the time slider compares two snapshots only when their scans ran under the same "Don\'t scan" rules: what a rule hid is never drawn as new, and under one rule a file made beside its match still is (review F1.1)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-snapshotTrees-rule-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', 'x.js'), Buffer.alloc(9000, 1));
  fs.writeFileSync(path.join(proj, 'a.txt'), Buffer.alloc(1000, 1));
  const rule = [{ pattern: 'node_modules', scope: 'scan' as const }];
  const at = (rel: string): string => path.join(proj, rel);
  try {
    await updateSettings({ ignore: rule });
    await scanAndSave(root);
    await updateSettings({ ignore: [] });
    await scanAndSave(root);
    const across = await newestLayout(root);
    const nm = across.nodes.find((n) => n.path === at('node_modules'));
    assert.ok(nm, 'node_modules is drawn now');
    assert.equal('prevSize' in nm, false, `node_modules, which the rule hid, is not drawn as new: ${JSON.stringify(nm)}`);
    assert.equal(across.prevTakenAt, null, 'the snapshot before ran under another rule, so it is not compared at all');

    await updateSettings({ ignore: rule });
    await scanAndSave(root);
    fs.writeFileSync(at('b.txt'), Buffer.alloc(500, 1));
    await scanAndSave(root);
    const same = await newestLayout(root);
    assert.notEqual(same.prevTakenAt, null, 'the same rule both times: the snapshot before is compared');
    assert.equal(same.nodes.find((n) => n.path === at('b.txt'))?.prevSize, null, 'b.txt, made beside the rule\'s match, did not exist');
    assert.equal(same.nodes.find((n) => n.path === at('a.txt'))?.prevSize, 1000, 'a.txt is compared');
    const openapi = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'openapi.ts'), 'utf8');
    assert.ok(openapi.includes('or when the two scans ran under different “Don’t scan” rules (ignoreRules on GET /api/snapshots): what a rule hid or let back in is no change'), 'the OpenAPI document says when there is no previous snapshot to compare');
  } finally {
    await updateSettings({ ignore: [] });
  }
});
