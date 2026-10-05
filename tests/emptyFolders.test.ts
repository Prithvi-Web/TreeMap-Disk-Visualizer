import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-emptyFolders-data-');
// gdu is asked for by name in the one test that wants it; Automatic never picks it here.
process.env.TREEMAP_NO_GDU = '1';

import type { NativeStore, WalkResult } from '../native/index';
import { FileNode, ScanResult } from '../src/models/types';
import { collectEmptyFolders, createScanRecord, evictExpiredScans, findEmptyFolders, SCAN_TTL_MS, startScan } from '../src/services/diskScanner';
import { aliasNamespaceOf } from '../src/utils/pathSanitizer';
import { buildStoreFromTree, Flag, ObjectScanStore, PackedScanStore } from '../src/services/scanStore';
import { markUnlistedPaths } from '../src/services/scanRefusals';
import { emptyFoldersForScan, GDU_EMPTY_FOLDERS_REASON } from '../src/services/emptyFolders';
import { EMPTY_CHECK_BUDGET_MS, setEmptyCheckForTests } from '../src/services/emptyFolderCheck';
import { boundaryRecord, mountOutcome, setNeverDescendForTests } from '../src/utils/mountBoundaries';
import { updateSettings } from '../src/services/settings';
import { ingestColumns, KIND_DIR, REFUSAL_DENIED, REFUSAL_UNREADABLE, REFUSAL_VANISHED } from '../src/services/scan/nativeEngine';
import { adoptNativeStore, adoptNativeStoreInSlices } from '../src/services/scan/nativeMemory';
import { statToInput } from '../src/services/scan/nodeInput';
import { findGduBinary } from '../src/services/gduScanner';
import { mapGduTreeIntoStore } from '../src/services/gduMapper';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { canLock } from './fixtures/nativeEdge';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import { waitFor } from './fixtures/waitFor';
import { settled } from '../src/utils/backgroundWrites';

/**
 * Empty Folders reports directories with nothing underneath them.
 *
 * The thing being pinned here is what it deliberately does NOT report. An empty
 * directory is worth ~0 bytes, so the feature is about tidiness, not space —
 * which makes a false positive purely costly. `.git/refs/tags` and
 * `.git/objects/info` are empty in almost every repository on a disk, so they
 * flooded the list, and "Select all — 1000 folders" then quietly reached into
 * every repo the user owns to delete git's own bookkeeping.
 */

const NOW = 1_800_000_000_000;

function file(name: string, path: string, size = 10): FileNode {
  return { name, path, size, type: 'file', modifiedAt: NOW, isHidden: name.startsWith('.') };
}
function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name, path, type: 'dir', modifiedAt: NOW, isHidden: name.startsWith('.'),
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

/** A tree shaped like a real home folder: one repo, some genuinely empty dirs. */
function tree(): FileNode {
  return dir('r', '/r', [
    dir('proj', '/r/proj', [
      dir('.git', '/r/proj/.git', [
        file('HEAD', '/r/proj/.git/HEAD'),
        dir('refs', '/r/proj/.git/refs', [dir('tags', '/r/proj/.git/refs/tags', [])]),
        dir('objects', '/r/proj/.git/objects', [dir('info', '/r/proj/.git/objects/info', [])]),
      ]),
      dir('src', '/r/proj/src', [file('keep.ts', '/r/proj/src/keep.ts')]),
    ]),
    dir('emptyOne', '/r/emptyOne', []),
    dir('nested', '/r/nested', [dir('deep', '/r/nested/deep', [])]),
    dir('.Trash', '/r/.Trash', []),
  ]);
}

test('git bookkeeping and the OS Trash are never offered as empty folders', () => {
  const { folders } = collectEmptyFolders(tree(), true);
  const paths = folders.map((f) => f.path).sort();

  assert.deepEqual(paths, ['/r/emptyOne', '/r/nested'],
    'only the user\'s own empty directories, and only the topmost of them');

  for (const forbidden of ['/r/proj/.git/refs/tags', '/r/proj/.git/objects/info',
    '/r/proj/.git/refs', '/r/proj/.git/objects', '/r/.Trash']) {
    assert.ok(!paths.includes(forbidden), `${forbidden} must not be offered for deletion`);
  }
});

test('the nested count matches what is offered, so the two numbers agree', () => {
  // The UI says "Select all — N top-level empty folders (M counting nested
  // ones)". If M still counted the git directories, the sentence would promise
  // to remove things the list refuses to show.
  const { folders, totalCount } = collectEmptyFolders(tree(), true);
  assert.equal(folders.length, 2);
  assert.equal(totalCount, 3, 'emptyOne, nested, and nested/deep — nothing from .git or .Trash');
});

test('a directory holding only junk still counts as empty, and .git still does not', () => {
  const t = dir('r', '/r', [
    dir('justJunk', '/r/justJunk', [file('.DS_Store', '/r/justJunk/.DS_Store')]),
    dir('.git', '/r/.git', [
      file('HEAD', '/r/.git/HEAD'),
      dir('info', '/r/.git/info', [file('.DS_Store', '/r/.git/info/.DS_Store')]),
    ]),
  ]);
  const paths = collectEmptyFolders(t, true).folders.map((f) => f.path);
  assert.deepEqual(paths, ['/r/justJunk'], 'junk-only is empty; junk-only inside .git is still git\'s');

  // And with the junk rule off, neither is empty.
  assert.deepEqual(collectEmptyFolders(t, false).folders.map((f) => f.path), []);
});

test('empty localisation folders inside an .app bundle are left alone', () => {
  // A signed bundle ships dozens of empty `.lproj` folders, and they sit inside
  // the signature's seal. Removing one frees ~0 bytes and stops the app
  // launching — the worst possible trade.
  const t = dir('r', '/r', [
    dir('Thing.app', '/r/Thing.app', [
      dir('Contents', '/r/Thing.app/Contents', [
        file('Info.plist', '/r/Thing.app/Contents/Info.plist'),
        dir('Resources', '/r/Thing.app/Contents/Resources', [
          dir('en.lproj', '/r/Thing.app/Contents/Resources/en.lproj', []),
          dir('fr.lproj', '/r/Thing.app/Contents/Resources/fr.lproj', []),
        ]),
      ]),
    ]),
    dir('mine', '/r/mine', []),
  ]);
  const { folders, totalCount } = collectEmptyFolders(t, true);
  assert.deepEqual(folders.map((f) => f.path), ['/r/mine'], 'only the folder the user made');
  assert.equal(totalCount, 1);
});

test('a repository that is genuinely empty is skipped whole, not descended into', () => {
  // `.git` with nothing in it at all is still git's directory, not a stray.
  const t = dir('r', '/r', [dir('.git', '/r/.git', [dir('refs', '/r/.git/refs', [])])]);
  const { folders, totalCount } = collectEmptyFolders(t, true);
  assert.deepEqual(folders, []);
  assert.equal(totalCount, 0);
});

/* ═══════════════ U-4: a folder the scan did not list in full is never empty ═══════════════ */

/*
 * Track U, U-4. A folder macOS refused the scan, one the scan never entered (the
 * never-descend list; later the drives "Stay on this drive" leaves out), one that
 * failed or vanished mid-walk, and one whose listing a "don't scan" pattern or a
 * failed stat left entries out of, all look childless in the tree. Each was
 * offered as empty, and trashing it trashes what the scan never saw. Three layers
 * keep it out: the scan's own record (`Flag.Unlisted`, set where each engine
 * knows), a second look on disk at every folder the answer offers (what no record
 * can know: the native memory path's unreadable folders, a cached listing, a
 * change since the scan), and a last look at delete time
 * (tests/emptyFoldersDelete.test.ts).
 */

test('a folder the scan did not list in full is never offered, never counted, and no folder above it is empty', () => {
  const shape = (): FileNode => dir('r', '/r', [
    dir('refused', '/r/refused', []),
    dir('holder', '/r/holder', [dir('locked', '/r/holder/locked', [])]),
    // Listed, but a "don't scan" pattern left an entry out: its listed empty child is still empty.
    dir('partial', '/r/partial', [dir('kid', '/r/partial/kid', [])]),
    dir('fine', '/r/fine', []),
  ]);
  for (const store of [buildStoreFromTree(shape()), ObjectScanStore.wrap(shape())]) {
    for (const p of ['/r/refused', '/r/holder/locked', '/r/partial']) store.setFlag(store.findByPath(p), Flag.Unlisted, true);
    const { folders, totalCount } = collectEmptyFolders(store, true);
    const kind = store instanceof PackedScanStore ? 'packed' : 'object';
    assert.deepEqual(folders.map((f) => f.path), ['/r/partial/kid', '/r/fine'],
      `${kind}: a folder not listed in full holds what the scan did not see, so neither it nor its holder is empty`);
    assert.equal(totalCount, 2, `${kind}: and neither is counted`);
  }
});

test('the pass looks only at what hangs from the root through folders: never a folder inside an archive, never a removed node', () => {
  for (const store of [buildStoreFromTree(dir('r', '/r', [
    file('box.zip', '/r/box.zip', 100),
    dir('cleared', '/r/cleared', [file('gone.txt', '/r/cleared/gone.txt')]),
    dir('removed-empty', '/r/removed-empty', []),
    dir('kept', '/r/kept', []),
  ])), ObjectScanStore.wrap(dir('r', '/r', [
    file('box.zip', '/r/box.zip', 100),
    dir('cleared', '/r/cleared', [file('gone.txt', '/r/cleared/gone.txt')]),
    dir('removed-empty', '/r/removed-empty', []),
    dir('kept', '/r/kept', []),
  ]))]) {
    const kind = store instanceof PackedScanStore ? 'packed' : 'object';
    // An archive's listing: entries, not folders on disk.
    store.ingestSubtree(store.findByPath('/r/box.zip'), [
      { name: 'inside', path: '/r/box.zip/inside', size: 0, type: 'dir', modifiedAt: NOW, isHidden: false, virtual: true, children: [] },
    ]);
    // A delete the tree has taken in since the scan: the folder it emptied is empty; the folder it took is gone.
    store.removeNode(store.findByPath('/r/cleared/gone.txt'));
    store.removeNode(store.findByPath('/r/removed-empty'));
    const { folders, totalCount } = findEmptyFolders(store, true);
    assert.deepEqual(folders.map((f) => f.path), ['/r/cleared', '/r/kept'], kind);
    assert.equal(totalCount, 2, kind);
  }
});

test('the pass keeps no Map or Set of every node: a memory-mode scan can hold more nodes than V8 lets one hold (U-4b INFO)', () => {
  // A hundred folders: the even ones hold files, junk and an empty folder; the odd ones only an empty folder.
  const kids: FileNode[] = [];
  for (let i = 0; i < 100; i++) {
    const inner: FileNode[] = [];
    if (i % 2 === 0) {
      for (let j = 0; j < 48; j++) inner.push(file(`f${j}.txt`, `/big/d${i}/f${j}.txt`));
      inner.push(file('.DS_Store', `/big/d${i}/.DS_Store`));
      inner.push(dir('e', `/big/d${i}/e`, []));
    } else {
      inner.push(dir('only-empty', `/big/d${i}/only-empty`, []));
    }
    kids.push(dir(`d${i}`, `/big/d${i}`, inner));
  }
  const store = buildStoreFromTree(dir('big', '/big', kids));
  // V8 throws RangeError past 2^24 entries in one Map or Set; counted here through the prototypes.
  const counts = { mapSet: 0, setAdd: 0 };
  const realSet = Map.prototype.set;
  const realAdd = Set.prototype.add;
  Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) { counts.mapSet++; return realSet.call(this, k, v); };
  Set.prototype.add = function (this: Set<unknown>, v: unknown) { counts.setAdd++; return realAdd.call(this, v); };
  let found: ReturnType<typeof findEmptyFolders>;
  try {
    found = findEmptyFolders(store, true);
  } finally {
    Map.prototype.set = realSet;
    Set.prototype.add = realAdd;
  }
  assert.ok(store.count > 2_500, `${store.count} nodes`);
  assert.ok(counts.mapSet + counts.setAdd < 100, `a per-node structure grows with the tree: ${JSON.stringify(counts)} for ${store.count} nodes`);
  assert.equal(found.folders.length, 100, 'e in each even folder, the whole of each odd one');
  assert.equal(found.totalCount, 150);
  assert.deepEqual(found.folders.slice(0, 2).map((f) => [f.path, f.counted]), [['/big/d0/e', 1], ['/big/d1', 2]]);
});

test('a never-descend path is marked where the tree holds it, and the folder that held it where an engine left the node out', () => {
  const store = buildStoreFromTree(dir('r', '/r', [
    dir('Volumes', '/r/Volumes', []),
    dir('a', '/r/a', [dir('b', '/r/a/b', [])]),
    dir('c', '/r/c', []),
  ]));
  markUnlistedPaths(store, ['/r', '/r/Volumes', '/r/c/mnt', '/r/absent', '/r/gone/deeper', '/elsewhere/x']);
  const flagged = (p: string): boolean => store.flag(store.findByPath(p), Flag.Unlisted);
  assert.equal(flagged('/r/Volumes'), true, 'held by the tree: marked');
  assert.equal(flagged('/r/c'), true, 'left out of the tree (gdu\'s -x drops a mount point): the folder that held it is marked');
  assert.equal(flagged('/r'), false, 'the root was listed (a never-descend path may be scanned as a root), and an absent path right under it marks nothing');
  assert.equal(flagged('/r/a'), false, 'nothing else is marked');
  assert.equal(flagged('/r/a/b'), false);
  assert.deepEqual(collectEmptyFolders(store, true).folders.map((f) => f.path), ['/r/a']);
});

/* ─────────────── the native engine's records, on columns built by hand ─────────────── */

/** Columns as the walk hands them over for `root`: every node a folder directly under the root, `refused` as given. */
function handColumns(root: string, names: string[], refused: Array<[number, number]>): WalkResult {
  const all = [path.basename(root), ...names];
  const encoded = all.map((n) => Buffer.from(n, 'utf8'));
  const nameOff = new Uint32Array(all.length + 1);
  let at = 0;
  encoded.forEach((b, i) => { nameOff[i] = at; at += b.length; });
  nameOff[all.length] = at;
  const n = all.length;
  return {
    parent: new Uint32Array(n),
    nameOff,
    names: new Uint8Array(Buffer.concat(encoded)),
    kind: new Uint8Array(n).fill(KIND_DIR),
    flags: new Uint8Array(n),
    size: new Float64Array(n),
    allocBytes: new Float64Array(n),
    mtimeMs: new Float64Array(n).fill(NOW),
    atimeMs: new Float64Array(n),
    hardlinkNode: new Uint32Array(0),
    hardlinkFamily: new Uint32Array(0),
    refusalNode: Uint32Array.from(refused.map(([node]) => node)),
    refusalWhy: Uint8Array.from(refused.map(([, why]) => why)),
    stats: {
      dirsListed: n - refused.length, entries: n - 1, wallMs: 1, cpuSeconds: null, fastPath: 'bulk', workersPeak: 1, climbSteps: 0,
      deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
  };
}

test('the native columns: a folder the walk refused, saw vanish or could not read is not listed, whichever it was', () => {
  const root = '/r';
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '/', statToInput('r', true, 0, NOW));
  ingestColumns(scan, store, handColumns(root, ['denied', 'vanished', 'unreadable', 'fine'], [
    [1, REFUSAL_DENIED], [2, REFUSAL_VANISHED], [3, REFUSAL_UNREADABLE],
  ]), root);
  store.finalize();
  for (const name of ['denied', 'vanished', 'unreadable']) {
    assert.equal(store.flag(store.findByPath(`/r/${name}`), Flag.Unlisted), true, `${name}: not listed`);
  }
  assert.equal(store.flag(store.findByPath('/r/fine'), Flag.Unlisted), false, 'a folder the walk listed is listed');
  assert.deepEqual(collectEmptyFolders(store, true).folders.map((f) => f.path), ['/r/fine']);
  assert.equal(scan.deniedDirs, 1, 'and the counts are as before');
  assert.equal(scan.vanishedDirs, 1);
  assert.equal(scan.unreadableDirs, 1);
});

test('the native columns: a drive mounted beneath a folder the walk refused, saw vanish or could not read was never reached (Track U, TS review R6)', () => {
  const root = '/r';
  const scan = createScanRecord(root);
  const drives = ['/r/denied/d', '/r/vanished/d', '/r/unreadable/d', '/r/fine/d'];
  scan.boundary = boundaryRecord({
    rule: 'stay', source: 'mount', reason: null,
    mounts: drives.map((p) => ({ path: p, filesystem: 'apfs', source: '/dev/disk99s1', underFixed: false })),
    fixed: [], neverDescend: drives,
  });
  const store = new PackedScanStore(root, '/', statToInput('r', true, 0, NOW));
  ingestColumns(scan, store, handColumns(root, ['denied', 'vanished', 'unreadable', 'fine'], [
    [1, REFUSAL_DENIED], [2, REFUSAL_VANISHED], [3, REFUSAL_UNREADABLE],
  ]), root);
  const o = mountOutcome(scan.boundary);
  assert.deepEqual(o.unreached.map((m) => m.path).sort(), ['/r/denied/d', '/r/unreadable/d', '/r/vanished/d'], 'nothing got near them, whichever way their folder failed');
  assert.deepEqual(o.notEntered.map((m) => m.path), ['/r/fine/d']);
});

/** A memory-mode store as the native build hands it over: the root (0) holding folders `a` (1) and `b` (2), both childless. */
function handMemoryStore(deniedDirs: number[], unreadableDirs: number): NativeStore {
  const capacity = 4;
  const names = ['r', 'a', 'b'].map((n) => new TextEncoder().encode(n));
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  names.forEach((bytes, id) => { nameOff[id] = at; at += bytes.length; });
  for (let id = names.length; id <= capacity; id++) nameOff[id] = at;
  const pool = new Uint8Array(at + 4);
  names.forEach((bytes, id) => pool.set(bytes, nameOff[id]));
  const dirFlags = Flag.Dir | Flag.HasChildArray;
  const col = <T extends { set(v: ArrayLike<number>): void }>(make: (n: number) => T, rows: number[]): T => {
    const out = make(capacity);
    out.set(rows);
    return out;
  };
  return {
    n: 3,
    capacity,
    parent: col((n) => new Int32Array(n), [-1, 0, 0]),
    size: new Float64Array(capacity),
    mtime: col((n) => new Float64Array(n), [NOW, NOW, NOW]),
    flags: col((n) => new Uint16Array(n), [dirFlags, dirFlags, dirFlags]),
    ext: new Uint16Array(capacity),
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names: pool,
    namesLen: at,
    childStart: col((n) => new Uint32Array(n), [1, 3, 3]),
    childCnt: col((n) => new Uint32Array(n), [2, 0, 0]),
    extDict: [''],
    extOverflowIds: new Uint32Array(0),
    extOverflowTexts: [],
    cloudCandidates: new Uint32Array(0),
    textCandidates: new Uint32Array(0),
    sparseTermIds: new Uint32Array(0),
    sparseTermBytes: new Float64Array(0),
    counters: {
      dirs: 3, files: 0, hardlinkedFiles: 0, hardlinkedBytes: 0, cloudFiles: 0, cloudBytes: 0,
      sparseFiles: 0, sparseBytes: 0, slackBytes: 0, deniedDirs, vanishedDirs: 0, unreadableDirs,
    },
    stats: {
      dirsListed: 3 - deniedDirs.length - unreadableDirs, entries: 2, wallMs: 1, cpuSeconds: null, fastPath: 'bulk', workersPeak: 1, climbSteps: 0,
      deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
  } as NativeStore;
}

test('gdu\'s mapper: a folder gdu flagged read_error is not listed', () => {
  const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, NOW));
  const doc = [1, 2, {}, [{ name: '/r/shard', mtime: 1 }, [{ name: 'locked', mtime: 1, read_error: true }], [{ name: 'fine', mtime: 1 }]]];
  const { stats } = mapGduTreeIntoStore(doc, '/r/shard', store, store.rootId);
  store.finalize();
  assert.equal(stats.deniedDirs, 1, 'counted, as before');
  assert.equal(store.flag(store.findByPath('/r/shard/locked'), Flag.Unlisted), true, 'and not listed');
  assert.equal(store.flag(store.findByPath('/r/shard/fine'), Flag.Unlisted), false);
});

test('the native memory path: a folder the walk was refused is not listed', () => {
  const scan = createScanRecord('/r');
  const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, NOW));
  adoptNativeStore(scan, store, handMemoryStore([1], 0));
  assert.equal(store.flag(1, Flag.Unlisted), true, 'the refused folder, by the id the build named');
  assert.equal(store.flag(2, Flag.Unlisted), false);
  assert.deepEqual(collectEmptyFolders(store, true).folders.map((f) => f.path), ['/r/b']);
});

test('the native memory path: a drive mounted beneath a folder the walk was refused was never reached, in slices as in one go (Track U, U-24 on U-35)', async () => {
  for (const sliced of [true, false]) {
    const scan = createScanRecord('/r');
    const drives = ['/r/a/d', '/r/b/d'];
    scan.boundary = boundaryRecord({
      rule: 'stay', source: 'mount', reason: null,
      mounts: drives.map((p) => ({ path: p, filesystem: 'apfs', source: '/dev/disk99s1', underFixed: false })),
      fixed: [], neverDescend: drives,
    });
    const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, NOW));
    if (sliced) {
      const outcome = await adoptNativeStoreInSlices(scan, store, handMemoryStore([1], 0), { sliceNodes: 1, yieldTurn: () => new Promise<void>((r) => setImmediate(r)) });
      assert.equal(outcome.completed, true);
    } else {
      adoptNativeStore(scan, store, handMemoryStore([1], 0));
    }
    const o = mountOutcome(scan.boundary);
    assert.deepEqual(o.unreached.map((m) => m.path), ['/r/a/d'], `${sliced ? 'sliced' : 'one go'}: beneath the refused folder, nothing got near it`);
    assert.deepEqual(o.notEntered.map((m) => m.path), ['/r/b/d']);
  }
});

/* ─────────────── real scans, through GET /api/empty-folders ─────────────── */

interface Answer {
  folders: { name: string; path: string }[];
  totalCount: number;
  truncated: boolean;
  withheld: number;
  reason?: string;
}

let server: http.Server;
let port: number;

before(async () => {
  resetRateLimiter();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  setNeverDescendForTests(null);
  setEmptyCheckForTests(null);
  await updateSettings({ engine: 'auto', ignore: [] });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(url: string): Promise<{ status: number; body: any }> {
  // Every request starts with a full allowance: this file's ~40 requests come faster than 10 a second,
  // and the rate limiter is not what it tests.
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: buf });
        }
      });
    }).on('error', reject);
  });
}

async function emptyFolders(scanId: string, ignoreJunk = true): Promise<Answer> {
  const r = await get(`/api/empty-folders?scanId=${scanId}&ignoreJunk=${ignoreJunk}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as Answer;
}

/** A fresh real folder holding `entries`: a name ending in `/` is a folder, any other a file. */
function onDisk(prefix: string, entries: string[]): string {
  const root = fs.realpathSync(fileTempDir(`treemap-emptyFolders-${prefix}-`));
  for (const e of entries) {
    const full = path.join(root, ...e.split('/').filter(Boolean));
    if (e.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x');
    }
  }
  return root;
}

async function scanWith(engine: 'walker' | 'native' | 'auto' | 'gdu', root: string): Promise<ScanResult> {
  await updateSettings({ engine });
  const scan = await startScan(root);
  await waitFor(() => scan.status !== 'running', `the ${engine} scan of ${root}`);
  assert.equal(scan.status, 'complete', scan.error);
  return scan;
}

/** False (after a skip, or a failure on CI) when the engine asked for is not the one that ran. */
function ran(t: TestContext, scan: ScanResult, engine: 'walker' | 'native'): boolean {
  const ok = engine === 'native' ? scan.engine === 'native' : scan.engine === 'walker' || scan.engine === 'turbo-walker';
  if (!ok) skipOrFailOnCi(t, `the ${engine} engine did not run (${scan.engine}): ${scan.fallbackReason ?? scan.engineReason}`);
  return ok;
}

const offered = (a: Answer): string[] => a.folders.map((f) => f.path);

for (const engine of ['walker', 'native'] as const) {
  test(`${engine}: a genuinely empty folder, one holding only junk and one holding only empty folders are still offered`, async (t) => {
    const root = onDisk(`${engine}-plain`, ['e1/', 'junk/.DS_Store', 'nest/a/b/', 'real/file.txt']);
    const scan = await scanWith(engine, root);
    if (!ran(t, scan, engine)) return;
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(offered(answer), ['e1', 'junk', 'nest'].map((n) => path.join(root, n)), 'the topmost empty folders, the second look agreeing');
    assert.equal(answer.totalCount, 5, 'e1, junk, nest, nest/a and nest/a/b');
    assert.equal(answer.withheld, 0, 'nothing changed since the scan, so nothing is withheld');
    assert.deepEqual(Object.keys(answer), ['folders', 'totalCount', 'truncated', 'withheld'], 'the answer keeps its keys and adds one');
  });

  test(`${engine}: a never-descend folder is never offered, and totalCount excludes it`, async (t) => {
    // Empty on disk, so only the scan's own record can keep it out: a second look would find it empty.
    const root = onDisk(`${engine}-never`, ['mnt/', 'plain/', 'keep/file.txt']);
    setNeverDescendForTests([path.join(root, 'mnt')]);
    try {
      const scan = await scanWith(engine, root);
      if (!ran(t, scan, engine)) return;
      const answer = await emptyFolders(scan.scanId);
      assert.deepEqual(offered(answer), [path.join(root, 'plain')], 'the folder the scan never entered is not offered');
      assert.equal(answer.totalCount, 1, 'nor counted');
      assert.equal(answer.withheld, 0, 'it was never a candidate: the second look never touched it');
    } finally {
      setNeverDescendForTests(null);
    }
  });

  test(`${engine}: a folder the walk was refused (mode 000) is never offered, nor the folder that holds it`, { skip: !canLock && 'a folder cannot be made unlistable here (Windows, or running as root)' }, async (t) => {
    const root = onDisk(`${engine}-locked`, ['locked/secret.bin', 'holder/locked2/', 'plain/']);
    const locked = [path.join(root, 'locked'), path.join(root, 'holder', 'locked2')];
    for (const p of locked) fs.chmodSync(p, 0o000);
    try {
      const scan = await scanWith(engine, root);
      if (!ran(t, scan, engine)) return;
      assert.equal(scan.deniedDirs, 2, 'both refusals were counted');
      const answer = await emptyFolders(scan.scanId);
      assert.deepEqual(offered(answer), [path.join(root, 'plain')]);
      assert.equal(answer.totalCount, 1);
      assert.equal(answer.withheld, 0, 'kept out by the scan\'s record, before any second look');
    } finally {
      for (const p of locked) fs.chmodSync(p, 0o755);
    }
  });

  test(`${engine}: an offered folder that changed after the scan is withheld, counted, and its nested count leaves totalCount`, async (t) => {
    const root = onDisk(`${engine}-changed`, ['e1/', 'e2/', 'nest/a/', 'keep/file.txt']);
    const scan = await scanWith(engine, root);
    if (!ran(t, scan, engine)) return;
    assert.equal((await emptyFolders(scan.scanId)).totalCount, 4, 'before: e1, e2, nest and nest/a');
    fs.writeFileSync(path.join(root, 'e1', 'new.txt'), 'arrived after the scan');
    fs.writeFileSync(path.join(root, 'nest', 'a', 'new.txt'), 'and here, one folder down');
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(offered(answer), [path.join(root, 'e2')], 'only the folder still empty on disk');
    assert.equal(answer.withheld, 2, 'the two offered folders that hold something now');
    assert.equal(answer.totalCount, 1, 'and the count no longer holds them, nest/a included');
  });
}

test('walker: a folder the walk could not read (an injected EIO) is never offered', async (t) => {
  // Empty on disk: the second look would offer it, so only the walk's record keeps it out.
  const root = onDisk('eio', ['broken/', 'plain/']);
  const broken = path.join(root, 'broken');
  const real = fs.promises.readdir;
  (fs.promises as { readdir: unknown }).readdir = function (p: fs.PathLike, ...rest: unknown[]) {
    if (String(p) === broken) {
      return Promise.reject(Object.assign(new Error(`EIO: i/o error, scandir '${broken}'`), { code: 'EIO', errno: -5, syscall: 'scandir', path: broken }));
    }
    return (real as (...a: unknown[]) => Promise<unknown>).call(fs.promises, p, ...rest);
  };
  let scan: ScanResult;
  try {
    scan = await scanWith('walker', root);
  } finally {
    (fs.promises as { readdir: unknown }).readdir = real;
  }
  if (!ran(t, scan, 'walker')) return;
  assert.equal(scan.unreadableDirs, 1, 'the failed listing was counted');
  const answer = await emptyFolders(scan.scanId);
  assert.deepEqual(offered(answer), [path.join(root, 'plain')]);
  assert.equal(answer.totalCount, 1);
});

/** Run a walker scan of `root` with `fs.promises.lstat` failing for `target` with `code`. */
async function scanWithLstatFailing(root: string, target: string, code: string): Promise<ScanResult> {
  const real = fs.promises.lstat;
  (fs.promises as { lstat: unknown }).lstat = function (p: fs.PathLike, ...rest: unknown[]) {
    if (String(p) === target) return Promise.reject(Object.assign(new Error(`${code}: lstat '${target}'`), { code, syscall: 'lstat', path: target }));
    return (real as (...a: unknown[]) => Promise<unknown>).call(fs.promises, p, ...rest);
  };
  try {
    return await scanWith('walker', root);
  } finally {
    (fs.promises as { lstat: unknown }).lstat = real;
  }
}

for (const code of ['EACCES', 'EIO']) {
  test(`walker: a folder whose only entry could not be looked at (${code}) is never offered`, async (t) => {
    const root = onDisk(`entry-${code}`, ['shy/hidden.bin', 'plain/']);
    const scan = await scanWithLstatFailing(root, path.join(root, 'shy', 'hidden.bin'), code);
    if (!ran(t, scan, 'walker')) return;
    assert.equal(code === 'EACCES' ? scan.deniedEntries : scan.unreadableEntries, 1, 'the entry was counted');
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(offered(answer), [path.join(root, 'plain')]);
    assert.equal(answer.withheld, 0, 'kept out by the walk\'s record: the folder was never a candidate for the second look');
  });
}

test('walker: an entry that vanished between the listing and its stat leaves its folder empty, as it is', async (t) => {
  const root = onDisk('entry-vanished', ['went/gone.bin', 'plain/']);
  const gone = path.join(root, 'went', 'gone.bin');
  const scan = await scanWithLstatFailing(root, gone, 'ENOENT');
  if (!ran(t, scan, 'walker')) return;
  fs.rmSync(gone);
  const answer = await emptyFolders(scan.scanId);
  assert.deepEqual(offered(answer), ['plain', 'went'].map((n) => path.join(root, n)), 'a race with a delete accounts for nothing');
});

test('walker: a "don\'t scan" pattern that left entries out of a folder keeps it from being offered', async (t) => {
  const root = onDisk('ignored', ['proj/node_modules/x.js', 'plain/']);
  await updateSettings({ ignore: [{ pattern: 'node_modules', scope: 'scan' }] });
  try {
    const scan = await scanWith('auto', root);
    if (!ran(t, scan, 'walker')) return;
    const store = scan.store as PackedScanStore;
    assert.equal(store.findByPath(path.join(root, 'proj', 'node_modules')), -1, 'the pattern was honoured');
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(offered(answer), [path.join(root, 'plain')], 'proj holds node_modules, which the scan was told not to list');
    assert.equal(answer.withheld, 0, 'kept out by the walk\'s record, before any second look');
  } finally {
    await updateSettings({ ignore: [] });
  }
});

test('walker, fast rescan: a folder the cached listing names but the disk no longer has is never offered', async (t) => {
  const root = onDisk('cached-vanished', ['holder/gone/', 'holder/keep.txt', 'plain/']);
  const holder = path.join(root, 'holder');
  const first = await scanWith('walker', root);
  if (!ran(t, first, 'walker')) return;
  await settled(); // the fast-rescan cache is written after the scan answers
  // The folder goes, and its parent's time is put back, so the rescan takes the parent's listing from the cache.
  const times = fs.statSync(holder);
  fs.rmdirSync(path.join(holder, 'gone'));
  fs.utimesSync(holder, times.atime, times.mtime);
  const again = await startScan(root, { incremental: true });
  await waitFor(() => again.status !== 'running', 'the fast rescan');
  assert.equal(again.status, 'complete', again.error);
  assert.ok((again.cachedDirs ?? 0) > 0, 'the rescan took a listing from the cache');
  const store = again.store as PackedScanStore;
  assert.notEqual(store.findByPath(path.join(holder, 'gone')), -1, 'the cached listing still names the folder');
  const answer = await emptyFolders(again.scanId);
  assert.deepEqual(offered(answer), [path.join(root, 'plain')]);
  assert.equal(answer.withheld, 0, 'kept out by the walk\'s record that it never listed it, before any second look');
});

/* ─────────────── a fast rescan keeps what the scan did not list (U-4b L3) ─────────────── */

/** The fast-rescan cache of `root` under "Stay on this drive" (diskScanner's cacheFileName). */
function cacheFileOf(root: string): string {
  return path.join(process.env.TREEMAP_DATA_DIR!, `mtime-cache-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
}

/** A fast rescan of `root`, settled, whose own listings came partly from the cache. */
async function fastRescan(root: string): Promise<ScanResult> {
  const again = await startScan(root, { incremental: true });
  await waitFor(() => again.status !== 'running', 'the fast rescan');
  assert.equal(again.status, 'complete', again.error);
  assert.equal(again.engine === 'walker' || again.engine === 'turbo-walker', true, `a fast rescan runs on the walker (${again.engine})`);
  assert.ok((again.cachedDirs ?? 0) > 0, 'the rescan took a listing from the cache');
  return again;
}

const flagged = (scan: ScanResult, p: string): boolean => {
  const store = scan.store as PackedScanStore;
  const id = store.findByPath(p);
  assert.notEqual(id, -1, `${p} is in the tree`);
  return store.flag(id, Flag.Unlisted);
};

test('walker, fast rescan: a folder the walk was refused is still not listed, though its parent\'s listing came from the cache', { skip: !canLock && 'a folder cannot be made unlistable here (Windows, or running as root)' }, async (t) => {
  const root = onDisk('cached-refused', ['locked/secret.bin', 'plain/']);
  const locked = path.join(root, 'locked');
  fs.chmodSync(locked, 0o000);
  try {
    const first = await scanWith('walker', root);
    if (!ran(t, first, 'walker')) return;
    await settled();
    const again = await fastRescan(root);
    assert.equal(flagged(again, locked), true, 'the cache\'s empty listing for it was not taken as one');
    const answer = await emptyFolders(again.scanId);
    assert.deepEqual(offered(answer), [path.join(root, 'plain')]);
    assert.equal(answer.withheld, 0, 'kept out by the walk\'s own record, before any second look');
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('walker, fast rescan: an empty listing in the cache is listed again, whichever engine wrote it', { skip: !canLock && 'a folder cannot be made unlistable here (Windows, or running as root)' }, async (t) => {
  // gdu and the native engine's per-entry refusals leave a folder they could not read as an empty
  // listing with no mark at all: the walker reads such a folder again rather than believe it.
  const root = onDisk('cached-unmarked', ['locked/secret.bin', 'plain/']);
  const locked = path.join(root, 'locked');
  fs.chmodSync(locked, 0o000);
  try {
    const first = await scanWith('walker', root);
    if (!ran(t, first, 'walker')) return;
    await settled();
    const file = cacheFileOf(root);
    const written = fs.readFileSync(file, 'utf8');
    const bare = written.split(',"unlisted":true').join('');
    assert.ok(bare.includes(`"path":${JSON.stringify(locked)}`) && bare.includes('"children":[]'), 'the cache holds the folder as an empty listing');
    fs.writeFileSync(file, bare);
    const again = await fastRescan(root);
    assert.equal(flagged(again, locked), true);
    assert.deepEqual(offered(await emptyFolders(again.scanId)), [path.join(root, 'plain')]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('walker, fast rescan: a folder a "don\'t scan" pattern left entries out of is still not listed', async (t) => {
  const root = onDisk('cached-ignored', ['proj/node_modules/x.js', 'proj/src/', 'plain/']);
  await updateSettings({ ignore: [{ pattern: 'node_modules', scope: 'scan' }] });
  try {
    const first = await scanWith('auto', root);
    if (!ran(t, first, 'walker')) return;
    const before = await emptyFolders(first.scanId);
    assert.deepEqual(offered(before), [path.join(root, 'plain'), path.join(root, 'proj', 'src')]);
    await settled();
    const again = await fastRescan(root);
    assert.equal(flagged(again, path.join(root, 'proj')), true, 'its cached listing — src, without node_modules — was not taken as the whole folder');
    const answer = await emptyFolders(again.scanId);
    assert.deepEqual(offered(answer), offered(before), 'the same folders, src among them');
    assert.equal(answer.withheld, 0, 'proj is never a candidate: it holds node_modules');
    // The root's own listing is the other way a cached listing is taken (looked up, not revalidated).
    const top = onDisk('cached-ignored-root', ['node_modules/x.js', 'proj/node_modules/x.js', 'proj/src/', 'keep/a/']);
    const firstTop = await scanWith('auto', top);
    if (!ran(t, firstTop, 'walker')) return;
    await settled();
    const againTop = await fastRescan(top);
    assert.equal(flagged(againTop, top), true, 'the root holds node_modules too');
    assert.equal(flagged(againTop, path.join(top, 'proj')), true);
    assert.deepEqual(offered(await emptyFolders(againTop.scanId)), [path.join(top, 'keep'), path.join(top, 'proj', 'src')]);
  } finally {
    await updateSettings({ ignore: [] });
  }
});

test('the native memory path names no unreadable folder, so the second look is what keeps one out', async () => {
  // `a` stands for a folder the walk could not read: counted, never named. On disk it holds a file.
  const root = onDisk('memory-unreadable', ['a/inside.txt', 'b/']);
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(path.basename(root), true, 0, NOW));
  adoptNativeStore(scan, store, handMemoryStore([], 1));
  scan.engine = 'native';
  scan.store = store;
  scan.status = 'complete';
  const answer = await emptyFoldersForScan(scan, true);
  assert.deepEqual(answer.folders.map((f) => f.path), [path.join(root, 'b')]);
  assert.equal(answer.withheld, 1, 'a, offered by the tree, was looked at again and left out');
  assert.equal(answer.totalCount, 1);
});

/* ─────────────── the second look's own rules ─────────────── */

async function settledWalkerScan(prefix: string, entries: string[]): Promise<{ root: string; scan: ScanResult }> {
  const root = onDisk(prefix, entries);
  return { root, scan: await scanWith('walker', root) };
}

test('a folder the second look cannot read is withheld', async () => {
  const { root, scan } = await settledWalkerScan('second-refused', ['e1/', 'e2/']);
  const refused = path.join(root, 'e1');
  setEmptyCheckForTests({
    opendir: (p) => (p === refused
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : fs.promises.opendir(p)),
  });
  try {
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(offered(answer), [path.join(root, 'e2')]);
    assert.equal(answer.withheld, 1);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('a second look that does not answer withholds that folder and every one not yet looked at', async () => {
  const names = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'];
  const { scan } = await settledWalkerScan('second-silent', names.map((n) => `${n}/`));
  let asked = 0;
  setEmptyCheckForTests({
    lstat: () => {
      asked++;
      return new Promise(() => { /* a folder on a drive that stopped answering */ });
    },
    deadline: () => ({ late: Promise.resolve(), cancel: () => {} }),
  });
  try {
    const answer = await emptyFolders(scan.scanId);
    assert.deepEqual(answer.folders, [], 'nothing unanswered is offered');
    assert.equal(answer.withheld, names.length, 'every folder is withheld, looked at or not');
    // U-4b M1: the drive's first look goes alone, so a silent drive holds one thread of the pool, not four.
    assert.equal(asked, 1, `one folder is asked, alone, and its silence answers for the rest (asked ${asked} of ${names.length})`);
    // And the silence is remembered: the page asking again does not take another thread.
    const again = await emptyFolders(scan.scanId);
    assert.equal(again.withheld, names.length);
    assert.equal(asked, 1, 'a second request does not ask the silent drive again');
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('the second look stops after 10 s of looking: one budget for the whole answer, not one per folder', async () => {
  const names = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'];
  const { scan } = await settledWalkerScan('second-budget', names.map((n) => `${n}/`));
  let now = 0;
  let asked = 0;
  setEmptyCheckForTests({
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    // A slow drive: each stat takes 6 s of the clock, and answers.
    lstat: async (p) => { asked++; now += 6_000; return fs.promises.lstat(p); },
  });
  try {
    const answer = await emptyFolders(scan.scanId);
    // The first folder goes alone (6 s); the next stat runs the 10 s out, and nothing more is asked.
    assert.equal(answer.folders.length, 1, JSON.stringify(answer));
    assert.equal(answer.withheld, names.length - 1);
    assert.equal(asked, 2);
  } finally {
    setEmptyCheckForTests(null);
  }
});

/* ─────────────── gdu cannot tell an empty folder from a refused one ─────────────── */

test('a gdu scan offers no empty folder, and says why', async () => {
  const root = onDisk('gdu-record', ['e1/', 'keep/file.txt']);
  const scan = createScanRecord(root);
  scan.engine = 'gdu-turbo';
  scan.store = buildStoreFromTree(dir(path.basename(root), root, [
    dir('e1', path.join(root, 'e1'), []),
    dir('keep', path.join(root, 'keep'), [file('file.txt', path.join(root, 'keep', 'file.txt'), 1)]),
  ]), path.sep);
  scan.status = 'complete';
  const direct = await emptyFoldersForScan(scan, true);
  assert.deepEqual(direct, { folders: [], totalCount: 0, truncated: false, withheld: 0, reason: GDU_EMPTY_FOLDERS_REASON });
  assert.match(GDU_EMPTY_FOLDERS_REASON, /gdu/, 'the reason names the engine');
  assert.match(GDU_EMPTY_FOLDERS_REASON, /Scan engine/, 'and what to do instead');
  // Automatic picks gdu again wherever the native module is missing: only the built-in walker is sure to list every folder.
  assert.match(GDU_EMPTY_FOLDERS_REASON, /Scan engine set to Built-in walker to see them\.$/, 'it names the one engine that always runs');
  assert.doesNotMatch(GDU_EMPTY_FOLDERS_REASON, /Automatic/, 'never Automatic, which can run gdu again');
  const answer = await emptyFolders(scan.scanId);
  assert.deepEqual(answer, direct, 'the route answers the same, reason included');
});

test('a cloud scan\'s folders live at the provider: offered from its listing, never looked for on this disk', async () => {
  const root = 'cloud://gdrive/u4-test';
  const scan = createScanRecord(root);
  scan.engine = 'cloud';
  scan.store = buildStoreFromTree(dir('u4-test', root, [dir('empty', `${root}/empty`, [])]), '/');
  scan.status = 'complete';
  const answer = await emptyFoldersForScan(scan, true);
  assert.deepEqual(answer.folders.map((f) => f.path), [`${root}/empty`]);
  assert.equal(answer.withheld, 0, 'no local look could find a cloud folder, so none is made');
});

test('a real gdu scan offers no empty folder, and says why', { skip: process.platform === 'win32' && 'gdu never runs on Windows (gduRuleFor)' }, async (t) => {
  if (!(await findGduBinary())) {
    skipOrFailOnCi(t, 'no gdu binary is bundled or on PATH; fetch it with node scripts/fetchGdu.js');
    return;
  }
  const root = onDisk('gdu-real', ['e1/', 'keep/file.txt']);
  delete process.env.TREEMAP_NO_GDU;
  let scan: ScanResult;
  try {
    scan = await scanWith('gdu', root);
  } finally {
    process.env.TREEMAP_NO_GDU = '1';
  }
  assert.equal(scan.engine, 'gdu-turbo', scan.engineReason);
  const answer = await emptyFolders(scan.scanId);
  assert.deepEqual(answer.folders, []);
  assert.equal(answer.reason, GDU_EMPTY_FOLDERS_REASON);
});

test('openapi describes the two additive fields', async () => {
  const doc = (await get('/api/openapi.json')).body;
  const schema = doc.components.schemas.EmptyFoldersResult;
  assert.deepEqual(schema.required, ['folders', 'totalCount', 'truncated', 'withheld'], 'withheld is always sent');
  assert.ok(schema.properties.withheld, 'withheld is described');
  assert.ok(schema.properties.reason, 'reason is described');
  assert.ok(!schema.required.includes('reason'), 'and reason is sent only when it applies');
});

/* ─────────────── second names (last: it registers a scan of /) ─────────────── */

test('a scan of / never offers macOS’s second names (/.nofollow, /.resolve, /.vol) as empty folders, nor counts them: a walk lists each as an empty folder, and the sanitizer refuses a delete batch holding one (the SEC-2 review, F4)', { skip: process.platform !== 'darwin' && 'the namespaces are macOS’s' }, async () => {
  // The batch is refused whole, 400 PATH_BLOCKED, before it becomes an operation (AGENTS.md: a path
  // rule), so "Select all" in Empty Folders after a scan of / failed for every folder in it.
  const scan = createScanRecord('/');
  scan.engine = 'walker';
  scan.store = buildStoreFromTree(dir('', '/', [
    dir('.nofollow', '/.nofollow', []),
    dir('.resolve', '/.resolve', []),
    dir('.vol', '/.vol', []),
    dir('sec2-empty', '/sec2-empty', [dir('inner', '/sec2-empty/inner', [])]),
    dir('keep', '/keep', [file('f', '/keep/f')]),
  ]), '/');
  scan.status = 'complete';
  const looked: string[] = [];
  // Every folder looks empty on a second look, as the real look finds those three: nothing here reads this Mac's disk.
  setEmptyCheckForTests({
    lstat: async (p) => { looked.push(p); return { isDirectory: () => true }; },
    opendir: async () => ({ read: async () => null, close: async () => {} }),
    driveOf: async () => '/',
  });
  try {
    const answer = await emptyFoldersForScan(scan, true);
    assert.deepEqual(answer.folders.map((f) => f.path), ['/sec2-empty'], 'only a folder of its own');
    assert.equal(answer.totalCount, 2, 'the second names are not counted either');
    assert.equal(answer.withheld, 0, 'nor withheld: they are not folders that changed since the scan');
    assert.deepEqual(looked.filter((p) => aliasNamespaceOf(p) !== null), [], 'nor looked at again');
  } finally {
    setEmptyCheckForTests(null);
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  }
});
