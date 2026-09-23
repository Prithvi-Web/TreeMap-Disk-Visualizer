// Every write this file causes — settings, the mtime cache, snapshots — lands
// in a directory of its own, never in the owner's real app data; and the
// walker is forced: gdu off through the environment (the seam `startScan`
// offers today), and `engine: 'walker'` in the settings file for the day the
// forced-engine setting (Phase 3, W2) lands — both are set before any
// service is imported, because the modules read them when loaded.
process.env.TREEMAP_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'treemap-edge-data-'));
process.env.TREEMAP_NO_GDU = '1';
require('node:fs').writeFileSync(require('node:path').join(process.env.TREEMAP_DATA_DIR, 'settings.json'), JSON.stringify({ engine: 'walker' }));

import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startScan, cancelAllScans } from '../src/services/diskScanner';
import { Flag, storeOf, type ScanStore } from '../src/services/scanStore';
import type { ScanResult } from '../src/models/types';
import { buildEdgeCases, freezeTimes, DIRECTORY_ATIME_ANCHOR_SECONDS, type EdgeCaseFixture, type EdgeCaseName, type CaseResult } from './fixtures/edgeCases';

/**
 * The legacy walker on every edge case the master prompt's §12.2 names
 * (Phase 3, W3). The walker is the correctness oracle of the native engine
 * (DESIGN.md D2, §5.1), so its behaviour on each case is pinned here, on the
 * fixture `tests/fixtures/edgeCases.ts` builds; the native engine is then
 * held to the same digest in tests/nativeEquivalence.test.ts. A case this OS
 * cannot build is skipped with the fixture's reason, never asserted.
 */

const WALK_DEADLINE_MS = 120_000;
const SETTLE_POLL_MS = 10;
const GiB = 1024 ** 3;
/**
 * How far a file's atime may sit from its mtime plus one second. On Windows
 * libuv hands a stamp over as 100 ns ticks computed through a double, which
 * at this magnitude can land a tick or two either side; a microsecond covers
 * that and nothing a real defect would produce.
 */
const STAMP_TOLERANCE_MS = 0.001;

let fixture: EdgeCaseFixture;
let scan: ScanResult;
let store: ScanStore;
/** Every directory's times as built, captured before the walk, to prove the walk leaves them alone. */
let timesBefore: Map<string, { atimeMs: number; mtimeMs: number }>;

function directoryTimes(root: string): Map<string, { atimeMs: number; mtimeMs: number }> {
  const out = new Map<string, { atimeMs: number; mtimeMs: number }>();
  const visit = (dir: string): void => {
    const st = fs.lstatSync(dir);
    out.set(dir, { atimeMs: st.atimeMs, mtimeMs: st.mtimeMs });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // the refused directory
    }
    for (const ent of entries) if (ent.isDirectory() && !ent.isSymbolicLink()) visit(path.join(dir, ent.name));
  };
  visit(root);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolves once the clock has entered a new whole second, so two calls either side of it cannot share a `Math.floor(Date.now() / 1000)`. */
async function nextWholeSecond(): Promise<void> {
  const start = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === start) await sleep(SETTLE_POLL_MS);
}

/** The walk, settled — or a failure naming the deadline, which is what a followed symlink loop would look like. */
async function walked(root: string): Promise<ScanResult> {
  const s = await startScan(root);
  const deadline = Date.now() + WALK_DEADLINE_MS;
  while (s.status === 'running') {
    if (Date.now() > deadline) {
      cancelAllScans();
      throw new Error(`the walk of ${root} did not finish in ${WALK_DEADLINE_MS / 1000} s`);
    }
    await sleep(SETTLE_POLL_MS);
  }
  return s;
}

before(async () => {
  fixture = await buildEdgeCases(fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-edge-')));
  timesBefore = directoryTimes(fixture.root);
  scan = await walked(fixture.root);
  if (scan.status !== 'complete') throw new Error(`the walker failed on the fixture: ${scan.error ?? 'no error recorded'}`);
  store = storeOf(scan);
});

after(async () => {
  cancelAllScans();
  await fixture.cleanup();
  fs.rmSync(process.env.TREEMAP_DATA_DIR as string, { recursive: true, force: true });
});

/** The case, or a skip carrying the fixture's reason; the test body never sees an unbuilt case. */
function built<K extends EdgeCaseName>(t: TestContext, name: K): Extract<EdgeCaseFixture['cases'][K], { built: true }> | null {
  const c = fixture.cases[name] as CaseResult<object>;
  if (!c.built) {
    t.skip(`${name}: ${c.reason}`);
    return null;
  }
  return c as Extract<EdgeCaseFixture['cases'][K], { built: true }>;
}

function node(p: string): number {
  const id = store.findByPath(p);
  assert.notEqual(id, -1, `the walker recorded ${p}`);
  return id;
}

function countNamed(name: string): number {
  let n = 0;
  store.eachNode(store.rootId, (id) => { if (store.name(id) === name) n++; });
  return n;
}

test('the fixture builds, the walker completes it on the forced engine, and every case reports built or its reason', (t) => {
  assert.ok(scan.engine === 'walker' || scan.engine === 'turbo-walker', `the walker, not ${scan.engine}`);
  assert.equal(scan.status, 'complete');
  assert.equal(store.rootPath, fixture.root);
  const report = (Object.keys(fixture.cases) as EdgeCaseName[]).map((name) => {
    const c = fixture.cases[name] as CaseResult<object>;
    return `${name}: ${c.built ? 'built' : `skipped — ${c.reason}`}`;
  });
  t.diagnostic(report.join(' | '));
  t.diagnostic(`unreadableDirs ${scan.unreadableDirs ?? 0}, vanishedDirs ${scan.vanishedDirs ?? 0}, deniedEntries ${scan.deniedEntries ?? 0}, unreadableEntries ${scan.unreadableEntries ?? 0}; times the builder could not stamp: ${fixture.unstamped.length}`);
  assert.equal(scan.unreadableDirs ?? 0, 0, 'nothing failed to list for a reason other than a refusal');
  assert.equal(scan.vanishedDirs ?? 0, 0, 'nothing vanished');
  assert.equal(scan.unreadableEntries ?? 0, 0, 'every entry could be stat-ed');
});

test('the fixture is time-stable: the walk lists every directory and moves no atime and no mtime', (t) => {
  // Listing a directory reads it, and each platform decides differently
  // whether that moves its atime: APFS only when the atime is not newer than
  // the mtime; Linux's default relatime also when it is not newer than the
  // ctime, or is more than a day old; NTFS, where last-access updates are on,
  // only when it is more than an hour from the time of the listing. The
  // builder stamps every directory's atime from one anchor half an hour ahead
  // of this process's start — after the 2023 mtime, after the ctime the stamp
  // itself set, inside the day and inside the hour — so no rule fires, and a
  // walk (this one, or the equivalence gate's many) changes nothing.
  //
  // The directories checked are held to the builder's own inventory, taken by
  // its stamping walk on this platform, rather than to a fixed count: a
  // capture that skipped a directory fails by name instead of leaving that
  // directory's times unchecked, and a platform that legitimately builds
  // fewer (Windows has no mounts, no refused folder, no sparse or odd-name
  // folders) is held to exactly what it built. Equal sizes as well, because a
  // floor alone could be lowered to nothing and still pass.
  const inventory = fixture.directories;
  const missed = inventory.filter((dir) => !timesBefore.has(dir));
  assert.deepEqual(missed, [], `the capture missed ${missed.length} of the ${inventory.length} directories the builder stamped`);
  assert.equal(timesBefore.size, inventory.length, `the capture found ${timesBefore.size} directories and the builder stamped ${inventory.length}`);
  const moved: string[] = [];
  for (const [dir, before] of timesBefore) {
    const after = fs.lstatSync(dir);
    if (after.atimeMs !== before.atimeMs || after.mtimeMs !== before.mtimeMs) moved.push(`${dir}: atime ${before.atimeMs} → ${after.atimeMs}, mtime ${before.mtimeMs} → ${after.mtimeMs}`);
    assert.ok(before.atimeMs > before.mtimeMs, `${dir} was stamped with atime after mtime (${before.atimeMs} > ${before.mtimeMs})`);
  }
  assert.deepEqual(moved, [], 'no directory time moved during the walk');
  t.diagnostic(`${timesBefore.size} directories — every one the builder stamped — kept their atime and mtime through the walk`);
});

test('freezeTimes stamps every directory atime from one anchor per process: after its ctime and its mtime, identical on a re-stamp, while a file keeps mtime + 1 s', async () => {
  // (i) is what Linux's relatime and APFS need before they leave an atime
  // alone at a listing. (ii) is what the equivalence gate needs, because its
  // runs are separated by re-stamps and must all see one tree — so the two
  // stamps below straddle a whole second, which a per-call anchor could not
  // survive. (iii) is the file rule, unchanged: nothing in a walk reads a
  // file, so nothing moves its atime.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-freeze-'));
  try {
    const sub = path.join(root, 'sub');
    const file = path.join(root, 'file.txt');
    fs.mkdirSync(sub);
    fs.writeFileSync(file, 'x');
    const atimes = (): Array<[string, number]> => [root, sub, file].map((p) => [p, fs.lstatSync(p).atimeMs]);

    freezeTimes(root);
    for (const dir of [root, sub]) {
      const st = fs.lstatSync(dir);
      assert.ok(st.atimeMs > st.ctimeMs, `(i) ${dir}: its atime ${st.atimeMs} is after the ctime the stamp set, ${st.ctimeMs}`);
      assert.ok(st.atimeMs > st.mtimeMs, `(i) ${dir}: its atime ${st.atimeMs} is after its mtime ${st.mtimeMs}`);
    }
    const f = fs.lstatSync(file);
    assert.ok(Math.abs(f.atimeMs - f.mtimeMs - 1000) < STAMP_TOLERANCE_MS, `(iii) the file's atime ${f.atimeMs} is its mtime ${f.mtimeMs} plus one second`);
    const first = atimes();

    await nextWholeSecond();
    freezeTimes(root);
    assert.deepEqual(atimes(), first, '(ii) a re-stamp in a later second writes exactly the same atimes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('freezeTimes refuses to stamp once the clock reaches its anchor, rather than stamp directory atimes the next Linux listing would move', () => {
  // A stamp at or past the anchor would write a directory atime no newer than
  // the ctime the stamp itself sets, and relatime moves exactly that: the
  // tree would drift under the gate with nothing saying why. The option moves
  // only the clock this check reads, never the stamps.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-freeze-'));
  try {
    assert.doesNotThrow(() => freezeTimes(root, { nowSeconds: DIRECTORY_ATIME_ANCHOR_SECONDS - 1 }), 'a second before the anchor, every directory atime is still ahead of its ctime');
    assert.throws(() => freezeTimes(root, { nowSeconds: DIRECTORY_ATIME_ANCHOR_SECONDS }), /relatime/, 'at the anchor the fixture refuses, naming the rule it would break');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a skipped case is a real inability: on macOS and Linux every case builds except the ones the platform cannot', (t) => {
  if (process.platform === 'win32') {
    t.skip('on Windows what builds varies with Developer Mode (symbolic links) and NTFS (no sparse proof, no control characters in names)');
    return;
  }
  const allowed = new Map<EdgeCaseName, RegExp>([['caseCollision', /case-insensitive/]]);
  if (process.platform !== 'darwin') {
    allowed.set('nestedMount', /only on macOS/);
    allowed.set('readOnlyMount', /only on macOS/);
  }
  if (process.getuid?.() === 0) allowed.set('deniedDirectory', /root/);
  for (const name of Object.keys(fixture.cases) as EdgeCaseName[]) {
    const c = fixture.cases[name] as CaseResult<object>;
    if (c.built) continue;
    const reason = allowed.get(name);
    assert.ok(reason && reason.test(c.reason), `${name} was not built, and that is not a known inability of this platform: ${c.reason}`);
  }
});

test('a symlink to a file is a leaf with isSymlink and its own size, never followed, and the target is counted once', (t) => {
  const c = built(t, 'symlinkToFile');
  if (!c) return;
  const link = node(c.link);
  assert.equal(store.flag(link, Flag.Symlink), true);
  assert.equal(store.nodeType(link), 'file');
  assert.equal(store.size(link), c.linkBytes, 'the link is the length of its target string');
  assert.equal(store.hasChildArray(link), false, 'a link is never a directory to the walker');
  assert.equal(store.flag(link, Flag.HardlinkDup), false);
  const target = node(c.target);
  assert.equal(store.flag(target, Flag.Symlink), false);
  assert.equal(store.size(target), c.targetBytes);
  assert.equal(store.size(store.parent(link)), c.targetBytes + c.linkBytes, 'the directory holds the target once and the link once');
});

test('a broken symlink is a leaf with isSymlink and the length of its dangling target string', (t) => {
  const c = built(t, 'brokenSymlink');
  if (!c) return;
  const link = node(c.link);
  assert.equal(store.flag(link, Flag.Symlink), true);
  assert.equal(store.nodeType(link), 'file');
  assert.equal(store.size(link), c.linkBytes);
  assert.equal(store.hasChildArray(link), false);
});

test('a circular symlink pair, a link to its own directory and a link into a sibling subtree are leaves: the walk terminates and nothing is counted twice', (t) => {
  const c = built(t, 'circularSymlinks');
  if (!c) return;
  for (const p of [...c.pair, c.selfLoopDir, c.intoSiblings]) {
    const id = node(p);
    assert.equal(store.flag(id, Flag.Symlink), true, `${p} is a symlink`);
    assert.equal(store.nodeType(id), 'file', `${p} is a leaf`);
    assert.equal(store.hasChildArray(id), false, `${p} was not descended into`);
  }
  assert.equal(countNamed('a.bin'), 1, 'the subtree the link points into appears exactly once');
  assert.equal(countNamed(path.basename(c.selfLoopDir)), 1, 'the self-loop did not replicate its directory');
});

test('a hard-link family of three tallies hardlinkedFiles 2 and the bytes once', (t) => {
  const c = built(t, 'hardlinkFamily');
  if (!c) return;
  assert.equal(scan.hardlinkedFiles, 2);
  assert.equal(scan.hardlinkedBytes, 2 * c.bytes);
  const ids = c.family.map(node);
  const carriers = ids.filter((id) => !store.flag(id, Flag.HardlinkDup));
  const dups = ids.filter((id) => store.flag(id, Flag.HardlinkDup));
  assert.equal(carriers.length, 1, 'exactly one name carries the bytes');
  assert.equal(dups.length, 2);
  assert.equal(store.size(carriers[0]), c.bytes);
  for (const d of dups) assert.equal(store.size(d), 0);
  const familyDir = node(path.dirname(c.family[0]));
  assert.equal(store.size(familyDir), c.bytes, 'the directory total counts the family once');
  assert.deepEqual(fixture.hardlinkFamilies, [c.family], 'the fixture reports the family for the digest');
});

test('a truncate-only sparse file lands in sparseFiles/sparseBytes with its logical size intact', (t) => {
  const c = built(t, 'sparseFile');
  if (!c) return;
  const id = node(c.file);
  assert.equal(store.size(id), c.logicalSize, 'the logical size is what the tree shows');
  const expectedCount = [fixture.cases.sparseFile, fixture.cases.sparseFileOver4GiB].filter((x) => x.built).length;
  const expectedBytes = [fixture.cases.sparseFile, fixture.cases.sparseFileOver4GiB].reduce((sum, x) => sum + (x.built ? x.logicalSize : 0), 0);
  assert.equal(scan.sparseFiles, expectedCount, 'only the truncate-only files are sparse; symlinks and the zero-byte file are not');
  assert.equal(scan.sparseBytes, expectedBytes, 'the shortfall is the whole logical size: nothing is allocated');
});

test('a sparse file over 4 GiB keeps its logical size above 2^32 and is counted as sparse', (t) => {
  const c = built(t, 'sparseFileOver4GiB');
  if (!c) return;
  assert.ok(c.logicalSize > 4 * GiB);
  const id = node(c.file);
  assert.equal(store.size(id), c.logicalSize);
  assert.ok((scan.sparseBytes ?? 0) >= c.logicalSize, 'its whole size is in the shortfall');
});

test('a zero-byte file is an ordinary leaf', (t) => {
  const c = built(t, 'zeroByteFile');
  if (!c) return;
  const id = node(c.file);
  assert.equal(store.size(id), 0);
  assert.equal(store.nodeType(id), 'file');
  for (const f of [Flag.Symlink, Flag.HardlinkDup, Flag.CloudPlaceholder, Flag.Hidden]) assert.equal(store.flag(id, f), false);
});

test('names with a newline, a tab and an emoji come back byte-identical', (t) => {
  const c = built(t, 'oddNames');
  if (!c) return;
  const dir = node(c.dir);
  for (const name of c.names) {
    const id = store.childByName(dir, name);
    assert.notEqual(id, -1, `found by its exact name: ${JSON.stringify(name)}`);
    assert.equal(store.name(id), name);
    assert.equal(store.path(id), path.join(c.dir, name), 'and its path rebuilds byte for byte');
    assert.equal(store.findByPath(path.join(c.dir, name)), id);
  }
  assert.equal(store.childCount(dir), c.names.length);
});

test('an NFC/NFD pair: whatever the file system kept is what the walker returns, byte for byte', (t) => {
  const c = built(t, 'nfcNfdPair');
  if (!c) return;
  t.diagnostic(`the file system ${c.folded ? 'folded the two forms into one entry' : 'kept two entries'}: ${c.listed.map((n) => JSON.stringify(n)).join(', ')}`);
  const dir = node(c.dir);
  assert.equal(store.childCount(dir), c.listed.length, 'as many entries as the directory listing shows');
  for (const name of c.listed) {
    const id = store.childByName(dir, name);
    assert.notEqual(id, -1, `the listed form ${JSON.stringify(name)} is what the walker stored`);
    assert.equal(store.name(id), name, 'no normalisation on the way through');
  }
});

test('a case-collision pair is two entries where the directory is case-sensitive', (t) => {
  const c = built(t, 'caseCollision');
  if (!c) return;
  const dir = node(c.dir);
  assert.equal(store.childCount(dir), 2);
  for (const name of c.names) assert.equal(store.name(store.childByName(dir, name)), name);
});

test('a 300-character path round-trips through the store', (t) => {
  const c = built(t, 'longPath');
  if (!c) return;
  assert.ok(c.length >= 300, `${c.length} characters`);
  const id = node(c.leaf);
  assert.equal(store.path(id), c.leaf);
  assert.equal(store.nodeType(id), 'file');
});

test('a directory the OS refuses to list is counted in deniedDirs with its path among the examples, and nothing beneath it is invented', (t) => {
  const c = built(t, 'deniedDirectory');
  if (!c) return;
  assert.equal(scan.deniedDirs, 1);
  assert.ok(scan.deniedExamples?.includes(c.dir), `${c.dir} is named: ${JSON.stringify(scan.deniedExamples)}`);
  const id = node(c.dir);
  assert.equal(store.isDir(id), true, 'the refused folder is still a folder in the tree');
  assert.equal(store.childCount(id), 0, 'and it is empty — never a guess at what is inside');
  assert.equal(store.findByPath(c.hiddenFile), -1, 'the file behind the refusal is not in the tree');
  assert.equal(store.size(id), 0, 'a refused folder accounts for no bytes');
});

for (const name of ['nestedMount', 'readOnlyMount'] as const) {
  test(`${name}: the walker has no device rule (the never-descend list only, P3-3), so it descends and counts the volume — recorded, not judged`, (t) => {
    const c = built(t, name);
    if (!c) return;
    const mp = node(c.mountPoint);
    assert.equal(store.isDir(mp), true);
    const inside = c.files.map((f) => store.findByPath(f));
    t.diagnostic(`${name}: mounted at ${c.mountPoint}; the walker ${inside.every((id) => id !== -1) ? `descended into the mount and recorded its ${c.files.length} files` : 'did not record the files inside the mount'} — the legacy walker checks the never-descend list (absolute system paths) and no device id, and the native engine must do the same`);
    for (const [i, id] of inside.entries()) {
      assert.notEqual(id, -1, `${c.files[i]} inside the mount is in the tree, as the never-descend rule allows`);
      assert.equal(store.nodeType(id), 'file');
    }
    assert.ok(store.size(mp) > 0, 'the mounted volume contributes its bytes');
    if (name === 'readOnlyMount') {
      // The fixture's claim, checked: the volume refuses a write with EROFS.
      assert.throws(() => fs.writeFileSync(path.join(c.mountPoint, 'probe.txt'), 'x'), (err: unknown) => (err as NodeJS.ErrnoException).code === 'EROFS', 'the read-only mount refuses a write with EROFS');
    }
  });
}
