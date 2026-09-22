import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every write this file causes — settings, mtime caches, snapshots — lands in
// a directory of its own, never in the owner's real app data. gdu stays off so
// the legacy engine under comparison is always the walker.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-native-engine-test-'));
process.env.TREEMAP_NO_GDU = '1';

import type * as NativeCore from '../native/index';
import type { NativeProbe, NativeProgress, WalkResult, ScanStartOptions } from '../native/index';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';
import {
  isScanPaused,
  pauseScan,
  resetEngineBudgetForTests,
  resumeScan,
  setNativeLoadOptionsForTests,
} from '../src/services/engineBudget';
import {
  FLAG_DATALESS,
  FLAG_REFUSED_DIR,
  KIND_DIR,
  KIND_FILE,
  KIND_SYMLINK,
  NATIVE_POLL_MS,
  REFUSAL_DENIED,
  REFUSAL_UNREADABLE,
  REFUSAL_VANISHED,
  SCAN_FUNCTIONS,
  ingestColumns,
  nativeEligibility,
  nativeScanModule,
} from '../src/services/scan/nativeEngine';
import { statToInput } from '../src/services/scan/nodeInput';
import { PackedScanStore, storeOf } from '../src/services/scanStore';
import { cancelScan, createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { buildScanStats } from '../src/api/scanRoutes';
import { getSettings, updateSettings } from '../src/services/settings';
import { neverDescendPaths } from '../src/utils/mountBoundaries';
import type { EngineSetting, ScanResult } from '../src/models/types';

/**
 * The native engine on the Node side — Phase 3 plan, W2.
 *
 * Four things are proven here, in the order the plan lists them:
 *
 *  1. `nativeEligibility` is a pure table: incremental, an ignore list, a
 *     forced setting, a missing module and a refused probe each give a
 *     sentence, and Automatic with a module that lists the root is a yes.
 *  2. `ingestColumns` over hand-built columns produces a store whose pruned
 *     JSON is byte-identical to what the legacy walker produced on the same
 *     fixture — hard links, a sparse file, a cloud placeholder, `.git`, a
 *     symlink, a refused folder and every extension case included — and the
 *     same counters.
 *  3. `startScan` selects in the plan's order (forced setting → native → gdu →
 *     walker), states `engineReason`, `fastPath` and `fallbackReason` on every
 *     engine, honours pause and cancel on a native scan, and — in a child
 *     process pinned to a module that is not there — runs the walker and
 *     names the missing path.
 *  4. The real module (native/prebuilt, built by scripts/build-native.js)
 *     reports `engine: 'native'`, `fastPath: 'bulk'`, no fallback and the
 *     walker's counters; pause stops the count; cancel frees the handle.
 *
 * The first three run against a fake module injected through the loader's own
 * seam, exactly as tests/engineBudget.test.ts does; the fourth is skipped with
 * its reason when no prebuilt module is on disk.
 */

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };
const REPO = path.join(__dirname, '..');
const TRIPLE = `${process.platform}-${process.arch}`;
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', TRIPLE, 'treemap_core.node');
const NO_NATIVE = path.join(os.tmpdir(), 'treemap-no-native-here.node');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const canLock = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
const STATS_TAIL = ['engineReason', 'fastPath', 'fallbackReason', 'entriesPerSecond', 'cpuSeconds', 'peakRssBytes', 'bytesRead', 'cacheHitRate', 'storageMode', 'placeholdersSkipped'];
const COUNTERS = ['scanned', 'fileCount', 'dirCount', 'walkedDirs', 'cachedDirs', 'hardlinkedFiles', 'hardlinkedBytes', 'sparseFiles', 'sparseBytes', 'slackBytes', 'cloudFiles', 'cloudBytes', 'deniedDirs', 'deniedExamples', 'vanishedDirs', 'unreadableDirs', 'deniedEntries', 'unreadableEntries'] as const;

/* ═══════════════════════════ fixtures ═══════════════════════════ */

const KB = 1024;

/**
 * Every condition the legacy walker documents (docs/engine/CURRENT-STATE.md §3.3)
 * that a temp directory can hold: hard links in one folder, a sparse file, a
 * cloud placeholder under a path the iCloud regex matches, `.git`, a symlink,
 * a refused folder, an empty folder, hidden entries, a Photos library, an
 * archive, names with accents and an emoji, every extension case.
 */
async function buildEdgeFixture(prefix: string): Promise<{ root: string; total: number; locked: string | null }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const cloud = path.join('Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const dirs = ['docs', 'docs/nested', 'empty', '.hidden-dir', 'repo', 'repo/.git', 'vm', cloud, 'photos.photoslibrary', 'mod0', 'mod1', 'mod2'];
  for (const d of dirs) await fsp.mkdir(path.join(root, d), { recursive: true });
  const file = (rel: string, bytes: number): Promise<void> => fsp.writeFile(path.join(root, rel), Buffer.alloc(bytes, 0x61));
  await file('docs/a.txt', 100);
  await file('docs/b.md', 200);
  await file('docs/NOEXT', 50);
  await file('docs/.dotfile', 7);
  await file('docs/résumé.txt', 77);
  await file('docs/party 🎉.txt', 11);
  await file('docs/nested/deep.TAR.GZ', 300);
  await file('archive.zip', 1234);
  await file('.hidden-dir/.secret', 42);
  await file('repo/.git/HEAD', 23);
  await file('repo/README', 5);
  await file('photos.photoslibrary/db.sqlite', 10);
  let files = 12;
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 10; i++) { await file(`mod${d}/s${i}.ts`, 1000 + d * 100 + i); files++; }
  }
  // Hard links in the SAME folder: which twin is the duplicate is decided by
  // the listing order both engines see, not by a race between workers.
  await file('hard-a.bin', 999);
  await fsp.link(path.join(root, 'hard-a.bin'), path.join(root, 'hard-b.bin'));
  files += 2;
  // A symlink: never followed, a leaf with the link's own size.
  await fsp.symlink(path.join('docs', 'a.txt'), path.join(root, 'link.txt'));
  files++;
  // A sparse file outside any cloud folder: claims a mebibyte, occupies nothing.
  await file('vm/disk.img', 0);
  await fsp.truncate(path.join(root, 'vm', 'disk.img'), 1024 * KB);
  files++;
  // A placeholder: the same shape, but under a path the iCloud rule matches.
  await file(path.join(cloud, 'doc.pages'), 0);
  await fsp.truncate(path.join(root, cloud, 'doc.pages'), 4 * KB);
  files++;
  let locked: string | null = null;
  if (canLock) {
    locked = path.join(root, 'locked');
    await fsp.mkdir(locked);
    await file('locked/secret.bin', 1000);
    await fsp.chmod(locked, 0o000);
    dirs.push('locked');
  }
  // The root, every distinct folder (the cloud path is three deep and a nested
  // folder's parent is listed on its own too), and every file the walk can see.
  const distinct = new Set<string>();
  for (const d of dirs) {
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) distinct.add(parts.slice(0, i).join('/'));
  }
  return { root, total: 1 + distinct.size + files, locked };
}

async function unlockAndRemove(root: string, locked: string | null): Promise<void> {
  if (locked) await fsp.chmod(locked, 0o755).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
}

/** A synthetic tree: `dirs` folders of `filesPerDir` empty files each (the Phase 2 shape). */
async function buildWideTree(dirs: number, filesPerDir: number, prefix: string): Promise<{ root: string; total: number }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `d${String(d).padStart(4, '0')}`);
    await fsp.mkdir(dir);
    const writes: Promise<void>[] = [];
    for (let f = 0; f < filesPerDir; f++) writes.push(fsp.writeFile(path.join(dir, `f${f}.txt`), ''));
    await Promise.all(writes);
  }
  return { root, total: 1 + dirs + dirs * filesPerDir };
}

/* ═══════════════════ hand-built columns from a real tree ═══════════════════ */

/**
 * What the Rust walker would hand over for `root`, built here with readdir
 * and lstat in discovery order: index 0 is the root, `parent[i] < i`, names
 * as UTF-8, the hard-link and refusal side tables sorted by node. The fake
 * module serves these columns, and the ingest test feeds them straight in.
 */
function columnsFromDisk(root: string, over: Partial<WalkResult['stats']> = {}, opts: { scramble?: boolean } = {}): WalkResult {
  const parent: number[] = [0];
  const names: Buffer[] = [Buffer.from(path.basename(root) || root, 'utf8')];
  const kind: number[] = [KIND_DIR];
  const flags: number[] = [0];
  const size: number[] = [0];
  const alloc: number[] = [0];
  const mtime: number[] = [];
  const atime: number[] = [];
  const hardlinks: Array<{ node: number; dev: number; ino: number }> = [];
  const refusals: Array<{ node: number; why: number }> = [];
  const rootStat = fs.lstatSync(root);
  mtime.push(rootStat.mtimeMs);
  atime.push(rootStat.atimeMs);
  const queue: Array<{ id: number; dir: string }> = [{ id: 0, dir: root }];
  let dirsListed = 0;
  let deniedEntries = 0;
  let unreadableEntries = 0;
  while (queue.length) {
    const job = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(job.dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const why = code === 'EACCES' || code === 'EPERM' ? REFUSAL_DENIED : code === 'ENOENT' || code === 'ENOTDIR' ? REFUSAL_VANISHED : REFUSAL_UNREADABLE;
      refusals.push({ node: job.id, why });
      flags[job.id] |= FLAG_REFUSED_DIR;
      continue;
    }
    dirsListed++;
    // readdir arrives byte-sorted (libuv's scandir); a scrambled listing stands
    // in for the file system's own order, which is what getattrlistbulk gives.
    if (opts.scramble) entries.reverse();
    for (const ent of entries) {
      const full = path.join(job.dir, ent.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') deniedEntries++;
        else if (code !== 'ENOENT') unreadableEntries++;
        continue;
      }
      const id = parent.length;
      const isDir = ent.isDirectory() && !ent.isSymbolicLink();
      parent.push(job.id);
      names.push(Buffer.from(ent.name, 'utf8'));
      kind.push(isDir ? KIND_DIR : ent.isSymbolicLink() ? KIND_SYMLINK : KIND_FILE);
      flags.push(0);
      size.push(isDir ? 0 : st.size);
      alloc.push(isDir ? 0 : st.blocks * 512);
      mtime.push(st.mtimeMs);
      atime.push(st.atimeMs);
      if (isDir) {
        if (!neverDescendPaths().includes(full)) queue.push({ id, dir: full });
      } else if (!ent.isSymbolicLink() && st.nlink > 1) {
        hardlinks.push({ node: id, dev: st.dev, ino: st.ino });
      }
    }
  }
  const nameOff = new Uint32Array(names.length + 1);
  let off = 0;
  names.forEach((n, i) => { nameOff[i] = off; off += n.length; });
  nameOff[names.length] = off;
  return {
    parent: Uint32Array.from(parent),
    nameOff,
    names: new Uint8Array(Buffer.concat(names)),
    kind: Uint8Array.from(kind),
    flags: Uint8Array.from(flags),
    size: Float64Array.from(size),
    allocBytes: Float64Array.from(alloc),
    mtimeMs: Float64Array.from(mtime),
    atimeMs: Float64Array.from(atime),
    hardlinkNode: Uint32Array.from(hardlinks.map((h) => h.node)),
    hardlinkDev: Float64Array.from(hardlinks.map((h) => h.dev)),
    hardlinkIno: Float64Array.from(hardlinks.map((h) => h.ino)),
    refusalNode: Uint32Array.from(refusals.map((r) => r.node)),
    refusalWhy: Uint8Array.from(refusals.map((r) => r.why)),
    stats: {
      dirsListed, entries: parent.length - 1, wallMs: 1, cpuSeconds: 0.001, fastPath: 'bulk', workersPeak: 1, climbSteps: 0,
      deniedEntries, unreadableEntries, dataless: 0, ...over,
    },
  };
}

/* ═══════════════════════ the fake module ═══════════════════════ */

interface FakeScript {
  probe?: NativeProbe;
  columns?: () => WalkResult;
  /** Polls before the walk reports done (each poll advances the count). */
  steps?: number;
  startError?: string;
  /** The error the walk ends with (reported by poll, thrown by take). */
  walkError?: string;
}

interface FakeHandle { root: string; columns: WalkResult; polls: number; paused: boolean; cancelled: boolean; done: boolean }

/** A fake tm-node with the scan surface over hand-built columns, injected through the real loader so the handshake still runs. */
function useFakeNative(script: FakeScript) {
  resetNativeForTests();
  resetEngineBudgetForTests();
  const handles = new Map<number, FakeHandle>();
  const calls = { probe: [] as string[], start: [] as Array<{ root: string; opts: ScanStartOptions }>, pause: 0, resume: 0, cancel: 0, take: 0 };
  let next = 1;
  const steps = script.steps ?? 3;
  const must = (h: number): FakeHandle => {
    const s = handles.get(h);
    if (!s) throw new Error(`no scan handle ${h}: it was taken, cancelled or never started`);
    return s;
  };
  const module = {
    version: () => pkg.nativeVersion,
    scanProbe: (root: string): NativeProbe => { calls.probe.push(root); return script.probe ?? { fastPath: 'bulk', reason: 'fake: the root was listed through the getattrlistbulk path' }; },
    scanStart: (root: string, opts: ScanStartOptions): number => {
      if (script.startError) throw new Error(script.startError);
      calls.start.push({ root, opts });
      const id = next++;
      handles.set(id, { root, columns: (script.columns ?? (() => columnsFromDisk(root)))(), polls: 0, paused: false, cancelled: false, done: false });
      return id;
    },
    scanPoll: (h: number): NativeProgress => {
      const s = must(h);
      const total = s.columns.parent.length - 1;
      if (!s.paused && !s.done) s.polls++;
      if (s.polls >= steps) s.done = true;
      const entries = s.done ? total : Math.min(total, Math.floor((total * s.polls) / steps));
      return { done: s.done, error: s.done && script.walkError ? script.walkError : null, entries, dirs: 0, files: entries, bytes: 0, currentPath: s.done ? null : path.join(s.root, `step-${s.polls}`) };
    },
    scanPause: (h: number): void => { must(h).paused = true; calls.pause++; },
    scanResume: (h: number): void => { must(h).paused = false; calls.resume++; },
    scanCancel: (h: number): void => { const s = must(h); s.cancelled = true; s.done = true; calls.cancel++; },
    scanTake: (h: number): WalkResult => {
      const s = must(h);
      calls.take++;
      handles.delete(h);
      if (s.cancelled) throw new Error('the native scan was cancelled');
      if (script.walkError) throw new Error(script.walkError);
      return s.columns;
    },
  };
  setNativeLoadOptionsForTests({ path: '/fake/treemap_core.node', requireModule: () => module });
  const outcome = loadNative({ path: '/fake/treemap_core.node', requireModule: () => module });
  assert.equal(outcome.available, true, 'the fake must pass the loader’s handshake');
  return { module, handles, calls };
}

/** Pin the loader to a path that is not there, so a machine with the prebuilt answers like one without. */
function useNoNative(): void {
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: NO_NATIVE });
}

/* ═══════════════════════ helpers ═══════════════════════ */

async function settle(scanId: string, limitMs = 60_000): Promise<ScanResult> {
  const t0 = Date.now();
  for (;;) {
    const s = getScan(scanId);
    assert.ok(s, 'the scan record must exist');
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < limitMs, `scan ${scanId} never settled`);
    await sleep(10);
  }
}

async function scanWith(engine: EngineSetting, root: string, opts: { incremental?: boolean } = {}): Promise<ScanResult> {
  await updateSettings({ engine });
  const scan = await startScan(root, opts);
  return settle(scan.scanId);
}

/** The whole tree as the API would emit it, with atime values scrubbed (best-effort by design; presence still compares). */
function treeJson(scan: ScanResult): string {
  const store = storeOf(scan);
  return JSON.stringify(store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root).replace(/"accessedAt":\d+/g, '"accessedAt":1');
}

function counters(scan: ScanResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COUNTERS) out[k] = k === 'deniedExamples' ? [...(scan.deniedExamples ?? [])] : (scan[k] ?? 0);
  return out;
}

function rootInput(root: string) {
  const st = fs.lstatSync(root);
  return statToInput(path.basename(root) || root, true, 0, st.mtimeMs, st.atimeMs);
}

/* ═══════════════════ 1. the eligibility table ═══════════════════ */

const probeOk: NativeProbe = { fastPath: 'bulk', reason: 'the root was listed through the getattrlistbulk path (17 entries)' };
const withModule = { available: true as const, probe: probeOk };
const base = { incremental: false, ignoreCount: 0, forced: 'auto' as EngineSetting, rootIsDir: true, native: withModule };

test('nativeEligibility: Automatic with a module that lists the root is a yes, with the probe’s fast path and a reason', () => {
  const r = nativeEligibility('/tree', base);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fastPath, 'bulk');
  assert.match(r.reason, /native engine/);
  assert.match(r.reason, /getattrlistbulk/, 'the probe’s sentence is carried');
});

test('nativeEligibility: forced native keeps the probe’s path and says the setting asked for it', () => {
  const r = nativeEligibility('/tree', { ...base, forced: 'native' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fastPath, 'bulk');
  assert.match(r.reason, /Scan engine setting/);
});

test('nativeEligibility: an incremental rescan is not eligible — the mtime cache belongs to the walker', () => {
  const r = nativeEligibility('/tree', { ...base, incremental: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /incremental/);
  assert.equal(r.fallback, false, 'a rule, not a failure');
  assert.equal(r.probeRefused, false);
});

test('nativeEligibility: an ignore list is not eligible — the glob dialect lives in the walker', () => {
  const r = nativeEligibility('/tree', { ...base, ignoreCount: 2 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /2 .*pattern/);
  assert.equal(r.fallback, false);
});

test('nativeEligibility: a forced gdu or walker setting is not eligible, and names the engine asked for', () => {
  const gdu = nativeEligibility('/tree', { ...base, forced: 'gdu' });
  assert.equal(gdu.ok, false);
  if (!gdu.ok) { assert.match(gdu.reason, /Scan engine setting.*gdu/); assert.equal(gdu.fallback, false); }
  const walker = nativeEligibility('/tree', { ...base, forced: 'walker' });
  assert.equal(walker.ok, false);
  if (!walker.ok) { assert.match(walker.reason, /Scan engine setting.*walker/); assert.equal(walker.fallback, false); }
});

test('nativeEligibility: a root that is not a folder is not eligible', () => {
  const r = nativeEligibility('/tree/file.bin', { ...base, rootIsDir: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /single file/);
  assert.equal(r.fallback, false);
});

test('nativeEligibility: a module that is not loaded is a fallback with the loader’s reason', () => {
  const r = nativeEligibility('/tree', { ...base, native: { available: false, reason: 'no native module at /x/treemap_core.node for linux-x64; the legacy engines run instead' } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /\/x\/treemap_core\.node/);
  assert.equal(r.fallback, true);
  assert.equal(r.probeRefused, false);
});

test('nativeEligibility: forced native on a platform whose probe is unavailable is a fallback carrying the probe’s reason', () => {
  const probe: NativeProbe = { fastPath: 'unavailable', reason: 'the native listing is not built for linux yet' };
  const r = nativeEligibility('/tree', { ...base, forced: 'native', native: { available: true, probe } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /not built for linux yet/);
  assert.equal(r.fallback, true);
  assert.equal(r.probeRefused, true, 'so the stats can say fastPath: unavailable');
});

test('nativeEligibility: the rules come before the probe — forced native and incremental is still not eligible, and says both', () => {
  const r = nativeEligibility('/tree', { ...base, forced: 'native', incremental: true });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /incremental/);
  assert.match(r.reason, /Scan engine setting/);
  assert.equal(r.fallback, false);
});

test('a module without the scan surface is refused with the missing function named, so a stale prebuilt falls back rather than breaks', () => {
  resetNativeForTests();
  resetEngineBudgetForTests();
  const module = { version: () => pkg.nativeVersion, scanProbe: () => probeOk };
  setNativeLoadOptionsForTests({ path: '/fake/stale.node', requireModule: () => module });
  const r = nativeScanModule();
  assert.equal(r.available, false);
  if (r.available) return;
  assert.match(r.reason, /scanStart/);
  assert.match(r.reason, /\/fake\/stale\.node/);
  assert.deepEqual([...SCAN_FUNCTIONS], ['scanProbe', 'scanStart', 'scanPoll', 'scanPause', 'scanResume', 'scanCancel', 'scanTake']);
});

/* ═══════════════════ 2. ingestColumns: byte-identical to the walker ═══════════════════ */

test('ingestColumns on hand-built columns produces the walker’s tree byte for byte, and its counters', async () => {
  useNoNative();
  const { root, total, locked } = await buildEdgeFixture('treemap-native-ingest-');
  try {
    const legacy = await scanWith('walker', root);
    assert.equal(legacy.status, 'complete', legacy.error);
    assert.equal(legacy.engine === 'walker' || legacy.engine === 'turbo-walker', true, legacy.engine);
    assert.equal(legacy.scanned, total, 'the fixture builder and the walker agree on the count');
    // The fixture exercised every branch it was built for.
    assert.equal(legacy.hardlinkedFiles, 1);
    assert.equal(legacy.hardlinkedBytes, 999);
    assert.equal(legacy.cloudFiles, 1, 'the truncated file under Library/Mobile Documents is a placeholder');
    assert.equal(legacy.cloudBytes, 4 * KB);
    assert.ok((legacy.sparseFiles ?? 0) >= 1, 'the truncated VM image is sparse');
    assert.ok((legacy.sparseBytes ?? 0) >= 1024 * KB);
    if (locked) assert.deepEqual({ dirs: legacy.deniedDirs, examples: legacy.deniedExamples }, { dirs: 1, examples: [locked] });
    assert.match(treeJson(legacy), /"name":"repo"[^{]*"gitRepo":true/);
    assert.match(treeJson(legacy), /"name":"link\.txt"[^{]*"isSymlink":true/);
    assert.match(treeJson(legacy), /"name":"photos\.photoslibrary"[^{]*"container":"photos"/);

    const cols = columnsFromDisk(root);
    assert.equal(cols.parent.length, total);
    const scan = createScanRecord(root);
    const store = new PackedScanStore(root, path.sep, rootInput(root));
    ingestColumns(scan, store, cols, root);
    store.finalize();
    store.sumSizes();
    scan.store = store;
    scan.status = 'complete';

    assert.equal(treeJson(scan), treeJson(legacy), 'the pruned JSON differs from the walker’s');
    assert.deepEqual(counters(scan), counters(legacy), 'the counters differ from the walker’s');
    assert.equal(scan.placeholdersSkipped, 0);
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('ingestColumns emits each directory’s children in the walker’s order whatever order the listing came in, and keeps the walker’s hard-link twin', async () => {
  useNoNative();
  const { root, locked } = await buildEdgeFixture('treemap-native-order-');
  try {
    const legacy = await scanWith('walker', root);
    const scrambled = columnsFromDisk(root, {}, { scramble: true });
    const rootsFirstChild = Buffer.from(scrambled.names.buffer, scrambled.names.byteOffset + scrambled.nameOff[1], scrambled.nameOff[2] - scrambled.nameOff[1]).toString('utf8');
    assert.equal(rootsFirstChild, 'vm', 'the listing really is scrambled: the root’s first child is its last name');
    const scan = createScanRecord(root);
    const store = new PackedScanStore(root, path.sep, rootInput(root));
    ingestColumns(scan, store, scrambled, root);
    store.finalize();
    store.sumSizes();
    scan.store = store;
    scan.status = 'complete';
    assert.equal(treeJson(scan), treeJson(legacy), 'the pruned JSON differs from the walker’s');
    assert.deepEqual(counters(scan), counters(legacy));
    assert.match(treeJson(scan), /"name":"hard-b\.bin"[^{}]*"hardlinkDuplicate":true/, 'hard-a keeps the bytes and hard-b is the duplicate, as the walker has it, although the listing named hard-b first');
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('ingestColumns: the cloud-placeholder branch on columns built by hand — size above zero, no allocation, an iCloud path; the same file outside a cloud folder is sparse', () => {
  const root = '/Users/someone';
  const names = [path.basename(root), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'a.pages', 'vm', 'disk.img'];
  const enc = names.map((n) => Buffer.from(n, 'utf8'));
  const nameOff = new Uint32Array(names.length + 1);
  let off = 0;
  enc.forEach((n, i) => { nameOff[i] = off; off += n.length; });
  nameOff[names.length] = off;
  const cols: WalkResult = {
    parent: Uint32Array.from([0, 0, 1, 2, 3, 0, 5]),
    nameOff,
    names: new Uint8Array(Buffer.concat(enc)),
    kind: Uint8Array.from([KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR, KIND_FILE, KIND_DIR, KIND_FILE]),
    flags: Uint8Array.from([0, 0, 0, 0, FLAG_DATALESS, 0, 0]),
    size: Float64Array.from([0, 0, 0, 0, 5000, 0, 8000]),
    allocBytes: Float64Array.from([0, 0, 0, 0, 0, 0, 0]),
    mtimeMs: Float64Array.from([1.7e12, 1.7e12, 1.7e12, 1.7e12, 1.7e12 + 0.4, 1.7e12, 1.7e12 + 0.6]),
    atimeMs: Float64Array.from([NaN, 0, NaN, NaN, 1.6e12 + 0.5, NaN, -1]),
    hardlinkNode: new Uint32Array(0), hardlinkDev: new Float64Array(0), hardlinkIno: new Float64Array(0),
    refusalNode: new Uint32Array(0), refusalWhy: new Uint8Array(0),
    stats: { dirsListed: 5, entries: 6, wallMs: 1, cpuSeconds: 0.01, fastPath: 'bulk', workersPeak: 1, climbSteps: 0, deniedEntries: 0, unreadableEntries: 0, dataless: 1 },
  };
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '/', { name: 'someone', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  ingestColumns(scan, store, cols, root);
  store.finalize();
  store.sumSizes();
  const pages = store.findByPath('/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/a.pages');
  const disk = store.findByPath('/Users/someone/vm/disk.img');
  assert.notEqual(pages, -1);
  assert.notEqual(disk, -1);
  assert.deepEqual(store.materialize(pages), {
    name: 'a.pages', path: '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/a.pages', size: 5000, type: 'file',
    modifiedAt: 1.7e12, isHidden: false, accessedAt: 1.6e12 + 1, extension: 'pages', cloudPlaceholder: true, cloudProvider: 'icloud',
  }, 'Math.round on both times, atime kept when above zero, the placeholder flagged with its provider');
  const diskNode = store.materialize(disk);
  assert.equal(diskNode.cloudPlaceholder, undefined, 'a sparse file outside a cloud folder is never a placeholder');
  assert.equal(diskNode.accessedAt, undefined, 'a negative atime is omitted');
  assert.equal(diskNode.modifiedAt, 1.7e12 + 1, 'rounded up from .6');
  assert.equal(store.materialize(store.findByPath('/Users/someone/Library')).accessedAt, undefined, 'an atime of zero means never recorded');
  assert.deepEqual({ cloudFiles: scan.cloudFiles, cloudBytes: scan.cloudBytes, sparseFiles: scan.sparseFiles, sparseBytes: scan.sparseBytes, slackBytes: scan.slackBytes ?? 0 },
    { cloudFiles: 1, cloudBytes: 5000, sparseFiles: 1, sparseBytes: 8000, slackBytes: 0 }, 'the placeholder’s bytes are on the cloud line only, the sparse file’s on the sparse line');
  assert.equal(scan.placeholdersSkipped, 1, 'the walk’s dataless count');
  assert.equal(store.size(store.rootId), 13000);
});

test('ingestColumns: a refused folder is counted by its kind and named among the five smallest, a vanished one is only counted', () => {
  const root = '/r';
  const names = ['r', 'z-denied', 'a-denied', 'gone', 'bad', 'ok'];
  const enc = names.map((n) => Buffer.from(n, 'utf8'));
  const nameOff = new Uint32Array(names.length + 1);
  let off = 0;
  enc.forEach((n, i) => { nameOff[i] = off; off += n.length; });
  nameOff[names.length] = off;
  const cols: WalkResult = {
    parent: Uint32Array.from([0, 0, 0, 0, 0, 0]),
    nameOff,
    names: new Uint8Array(Buffer.concat(enc)),
    kind: Uint8Array.from([KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR, KIND_DIR]),
    flags: Uint8Array.from([0, FLAG_REFUSED_DIR, FLAG_REFUSED_DIR, FLAG_REFUSED_DIR, FLAG_REFUSED_DIR, 0]),
    size: new Float64Array(6), allocBytes: new Float64Array(6),
    mtimeMs: Float64Array.from([1, 2, 3, 4, 5, 6]), atimeMs: Float64Array.from([NaN, NaN, NaN, NaN, NaN, NaN]),
    hardlinkNode: new Uint32Array(0), hardlinkDev: new Float64Array(0), hardlinkIno: new Float64Array(0),
    refusalNode: Uint32Array.from([1, 2, 3, 4]),
    refusalWhy: Uint8Array.from([REFUSAL_DENIED, REFUSAL_DENIED, REFUSAL_VANISHED, REFUSAL_UNREADABLE]),
    stats: { dirsListed: 2, entries: 5, wallMs: 1, cpuSeconds: 0, fastPath: 'bulk', workersPeak: 1, climbSteps: 0, deniedEntries: 3, unreadableEntries: 2, dataless: 0 },
  };
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '/', { name: 'r', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  ingestColumns(scan, store, cols, root);
  store.finalize();
  assert.deepEqual(
    { deniedDirs: scan.deniedDirs, deniedExamples: scan.deniedExamples, vanishedDirs: scan.vanishedDirs, unreadableDirs: scan.unreadableDirs, deniedEntries: scan.deniedEntries, unreadableEntries: scan.unreadableEntries, walkedDirs: scan.walkedDirs, dirCount: scan.dirCount },
    { deniedDirs: 2, deniedExamples: ['/r/a-denied', '/r/z-denied'], vanishedDirs: 1, unreadableDirs: 1, deniedEntries: 3, unreadableEntries: 2, walkedDirs: 6, dirCount: 6 },
  );
  const denied = store.findByPath('/r/z-denied');
  assert.notEqual(denied, -1);
  assert.equal(store.isDir(denied), true);
  assert.equal(store.childCount(denied), 0, 'a refused folder is a childless folder node, as the walker leaves it');
});

/* ═══════════════════ 3. selection, stats, pause and cancel through the fake ═══════════════════ */

test('buildScanStats appends the Phase 3 keys after budget, in order; entriesPerSecond is null while running and scanned ÷ seconds once complete', () => {
  const scan = createScanRecord('/somewhere');
  const running = buildScanStats(scan);
  const keys = Object.keys(running);
  assert.deepEqual(keys.slice(keys.indexOf('budget') + 1), STATS_TAIL);
  assert.equal(running.entriesPerSecond, null, 'no rate for a scan still running');
  assert.equal(running.peakRssBytes, null);
  assert.equal(running.cacheHitRate, null);
  assert.equal(running.storageMode, 'memory');
  assert.equal(running.bytesRead, null);
  scan.status = 'complete';
  scan.scanned = 3000;
  scan.startedAt = 1000;
  scan.finishedAt = 3000;
  const done = buildScanStats(scan);
  assert.equal(done.entriesPerSecond, 1500);
  assert.equal(done.durationMs, 2000);
  scan.finishedAt = 1000;
  assert.equal(buildScanStats(scan).entriesPerSecond, null, 'a zero-length duration has no rate, not an infinite one');
  assert.equal(typeof done.engineReason, 'string');
  assert.ok(done.engineReason.length > 10);
  assert.equal(done.fastPath, 'cloud', 'a record registered for a provider listing says so');
  assert.equal(done.fallbackReason, null);
  assert.equal(done.cpuSeconds, null);
  assert.equal(done.placeholdersSkipped, 0);
});

test('Automatic picks the native engine when the module lists the root: engine native, the probe’s fast path, no fallback, the walker’s tree and counters', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-auto-');
  try {
    useNoNative();
    const legacy = await scanWith('walker', root);
    const fake = useFakeNative({ steps: 2 });
    const scan = await scanWith('auto', root);
    assert.equal(scan.status, 'complete', scan.error);
    const stats = buildScanStats(scan);
    assert.equal(stats.engine, 'native');
    assert.equal(stats.fastPath, 'bulk');
    assert.equal(stats.fallbackReason, null);
    assert.match(stats.engineReason, /native engine/);
    assert.match(stats.engineReason, /getattrlistbulk/, 'the probe’s own sentence');
    assert.equal(stats.scanned, total);
    assert.equal(treeJson(scan), treeJson(legacy), 'the tree the API emits differs from the walker’s');
    assert.deepEqual(counters(scan), counters(legacy));
    assert.equal(typeof stats.cpuSeconds, 'number', 'the walk’s CPU plus the ingest’s');
    assert.ok((stats.cpuSeconds ?? 0) >= 0.001, `cpuSeconds ${stats.cpuSeconds}`);
    assert.equal(stats.placeholdersSkipped, 0);
    assert.equal(stats.entriesPerSecond === null || stats.entriesPerSecond > 0, true);
    assert.deepEqual(fake.calls.probe, [root], 'one probe, of the root');
    assert.equal(fake.calls.start.length, 1);
    assert.equal(fake.calls.start[0].root, root);
    assert.equal(fake.calls.start[0].opts.wantAtime, true, 'accessedAt is a fact the JSON carries (P3-5)');
    assert.deepEqual(fake.calls.start[0].opts.neverDescend, neverDescendPaths(), 'the legacy never-descend list, passed from Node');
    assert.equal(fake.calls.start[0].opts.maxWorkers, undefined, 'the hill-climber decides');
    assert.equal(fake.calls.take, 1, 'the handle was taken exactly once');
    assert.equal(fake.handles.size, 0, 'and freed');
    assert.equal(scan.currentPath, root, 'settled on the root, like every engine');
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('the forced setting is honoured: walker runs the walker without a probe, native runs the native engine, gdu (off here) falls to the walker naming the reason', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-forced-');
  try {
    const fake = useFakeNative({ steps: 1 });
    const walker = await scanWith('walker', root);
    assert.equal(walker.engine === 'walker' || walker.engine === 'turbo-walker', true, walker.engine);
    assert.match(walker.engineReason, /Scan engine setting/);
    assert.match(walker.engineReason, /not measured per scan by this engine/, 'why cpuSeconds is null');
    assert.equal(walker.fastPath, 'readdir+lstat');
    assert.equal(walker.fallbackReason, null, 'a setting is a choice, not a fallback');
    assert.equal(walker.cpuSeconds, null);
    assert.deepEqual(fake.calls.probe, [], 'a scan the setting sends elsewhere never pays for a probe');

    const native = await scanWith('native', root);
    assert.equal(native.engine, 'native');
    assert.match(native.engineReason, /Scan engine setting/);
    assert.equal(native.fallbackReason, null);
    assert.deepEqual(fake.calls.probe, [root]);

    const gdu = await scanWith('gdu', root);
    assert.equal(gdu.engine === 'walker' || gdu.engine === 'turbo-walker', true, gdu.engine);
    assert.match(gdu.engineReason, /Scan engine setting/);
    assert.match(gdu.fallbackReason ?? '', /gdu/, 'gdu was asked for and could not run: that is a fallback, named');
    assert.equal(gdu.fastPath, 'readdir+lstat');
    assert.deepEqual(fake.calls.probe, [root], 'still no probe for a scan sent to gdu');
  } finally {
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('an incremental rescan and an ignore list keep the walker, each with its sentence and no fallback', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-rules-');
  try {
    const fake = useFakeNative({ steps: 1 });
    const incremental = await scanWith('auto', root, { incremental: true });
    assert.equal(incremental.engine === 'walker' || incremental.engine === 'turbo-walker', true, incremental.engine);
    assert.match(incremental.engineReason, /incremental/);
    assert.equal(incremental.fallbackReason, null);
    assert.equal(incremental.fastPath, 'readdir+lstat');
    assert.deepEqual(fake.calls.probe, []);

    await updateSettings({ ignore: [{ pattern: 'mod1', scope: 'scan' }] });
    try {
      const ignored = await scanWith('auto', root);
      assert.equal(ignored.engine === 'walker' || ignored.engine === 'turbo-walker', true, ignored.engine);
      assert.match(ignored.engineReason, /pattern/);
      assert.equal(ignored.fallbackReason, null);
      assert.equal(storeOf(ignored).findByPath(path.join(root, 'mod1')), -1, 'the pattern was honoured by the engine that knows it');
    } finally {
      await updateSettings({ ignore: [] });
    }
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('a module that is not there is a fallback: the walker runs, fallbackReason names the path, and the scan is complete and correct', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-missing-');
  try {
    useNoNative();
    const scan = await scanWith('auto', root);
    assert.equal(scan.status, 'complete', scan.error);
    assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, scan.engine);
    assert.ok(scan.fallbackReason && scan.fallbackReason.includes(NO_NATIVE), scan.fallbackReason ?? 'null');
    assert.match(scan.engineReason, /walker/);
    assert.equal(scan.fastPath, 'readdir+lstat');
    assert.equal(scan.scanned, total);
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('a probe that says unavailable is a fallback with fastPath unavailable, the probe’s own words, and a complete walker scan', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-probe-');
  try {
    useFakeNative({ probe: { fastPath: 'unavailable', reason: 'the native listing is not built for this platform yet' } });
    const scan = await scanWith('auto', root);
    assert.equal(scan.status, 'complete', scan.error);
    assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, scan.engine);
    assert.equal(scan.fastPath, 'unavailable', 'P3-9: the native listing was probed and refused');
    assert.match(scan.fallbackReason ?? '', /not built for this platform yet/);
    assert.equal(scan.scanned, total);
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('a native walk that fails part-way falls back to the walker with the failure as the reason, and the counters start again from zero', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-midfail-');
  try {
    const fake = useFakeNative({ steps: 3, walkError: 'the native engine failed: a walker thread panicked' });
    const scan = await scanWith('auto', root);
    assert.equal(scan.status, 'complete', scan.error);
    assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, scan.engine);
    assert.match(scan.fallbackReason ?? '', /walker thread panicked/);
    assert.equal(scan.fastPath, 'readdir+lstat');
    assert.equal(scan.scanned, total, 'nothing the aborted native attempt counted is left in the total');
    assert.equal(fake.handles.size, 0, 'the failed handle was freed');
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('a root that disappears under a native walk is the scan’s own error, in the sentence every engine uses, not a fallback', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-vanish-');
  try {
    useFakeNative({ steps: 2, walkError: 'ENOENT: the root disappeared while the native engine was scanning it' });
    const scan = await scanWith('auto', root);
    assert.equal(scan.status, 'error');
    assert.match(scan.error ?? '', /disappeared while TreeMap was scanning/);
    assert.equal(scan.engine, 'native', 'the engine that saw it go');
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('pausing a native scan stops `scanned` within 200 ms and resuming finishes it with every entry counted', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-pause-');
  try {
    const fake = useFakeNative({ steps: 40 }); // four seconds of polls, unless paused
    await updateSettings({ engine: 'native' });
    const scan = await startScan(root);
    const t0 = Date.now();
    while (scan.status === 'running' && scan.scanned < 3) {
      assert.ok(Date.now() - t0 < 5_000, 'the native scan never started counting');
      await sleep(5);
    }
    assert.equal(scan.status, 'running');
    const outcome = pauseScan(scan);
    assert.deepEqual({ paused: outcome.paused, supported: outcome.supported }, { paused: true, supported: true });
    assert.equal(fake.calls.pause, 1, 'the pause reached the native handle at once, not at the next poll');
    assert.equal(isScanPaused(scan.scanId), true);
    await sleep(200);
    const halted = scan.scanned;
    await sleep(3 * NATIVE_POLL_MS);
    assert.equal(scan.scanned, halted, 'scanned kept moving while paused');
    assert.equal(scan.status, 'running');
    assert.ok(halted < total, 'it really was paused mid-way');
    assert.equal(resumeScan(scan).paused, false);
    assert.equal(fake.calls.resume, 1);
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete', done.error);
    assert.equal(done.scanned, total);
    assert.equal(fake.handles.size, 0);
  } finally {
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('cancelling a native scan settles the record at once and releases the handle: it is cancelled natively and taken to free it', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-cancel-');
  try {
    const fake = useFakeNative({ steps: 40 });
    await updateSettings({ engine: 'native' });
    const scan = await startScan(root);
    while (scan.status === 'running' && scan.scanned < 3) await sleep(5);
    assert.equal(cancelScan(scan.scanId), true);
    assert.equal(scan.status, 'error');
    const t0 = Date.now();
    while (fake.handles.size > 0) {
      assert.ok(Date.now() - t0 < 2_000, 'the native handle was never released after the cancel');
      await sleep(5);
    }
    assert.equal(fake.calls.cancel, 1);
    assert.equal(fake.calls.take, 1, 'taken once, to free it; the refusal that throws is what frees it');
    assert.throws(() => fake.module.scanTake(1), /no scan handle/, 'a second take says the handle is gone');
    assert.equal(scan.status, 'error', 'the release did not un-settle the record');
  } finally {
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('in a process pinned to a module that is not there, the walker runs, the fallback names the path, and the scan is complete and correct', async () => {
  const { root, total } = await buildWideTree(20, 30, 'treemap-native-child-');
  const dataDir = path.join(os.tmpdir(), `treemap-native-child-data-${process.pid}`);
  try {
    const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const r = spawnSync(process.execPath, [tsxCli, path.join(__dirname, 'fixtures', 'nativeEngineChild.ts'), root, dataDir], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `child failed:\n${r.stderr}`);
    const line = r.stdout.trim().split('\n').pop() ?? '';
    const out = JSON.parse(line) as { status: string; error: string | null; missing: string; engine: string; engineReason: string; fastPath: string; fallbackReason: string | null; cpuSeconds: number | null; placeholdersSkipped: number; scanned: number; fileCount: number; dirCount: number };
    assert.equal(out.status, 'complete', out.error ?? '');
    assert.equal(out.engine === 'walker' || out.engine === 'turbo-walker', true, out.engine);
    assert.ok(out.fallbackReason && out.fallbackReason.includes(out.missing), `fallbackReason ${out.fallbackReason}`);
    assert.equal(out.fastPath, 'readdir+lstat');
    assert.equal(out.cpuSeconds, null);
    assert.equal(out.placeholdersSkipped, 0);
    assert.deepEqual({ scanned: out.scanned, fileCount: out.fileCount, dirCount: out.dirCount }, { scanned: total, fileCount: 20 * 30, dirCount: 21 });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

/* ═══════════════════ 4. the real module ═══════════════════ */

type Core = typeof NativeCore;

/** The prebuilt module (or TREEMAP_NATIVE_MODULE) through the real loader, or null after skipping with the reason. */
function loadReal(t: TestContext): { core: Core; path: string } | null {
  const override = process.env.TREEMAP_NATIVE_MODULE;
  const file = override ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    t.skip(`no native module at ${file}; build it with node scripts/build-native.js (CI builds it on every leg)`);
    return null;
  }
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: file });
  const r = loadNative({ path: file });
  if (!r.available) assert.fail(r.reason);
  const surface = nativeScanModule();
  if (!surface.available) assert.fail(surface.reason);
  return { core: r.module as unknown as Core, path: file };
}

test('real module: scanProbe reports bulk with a reason on a folder, and unavailable on a file', (t) => {
  const real = loadReal(t);
  if (!real) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-native-probe-real-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const probe = real.core.scanProbe(dir);
    assert.equal(probe.fastPath, process.platform === 'darwin' ? 'bulk' : 'unavailable', JSON.stringify(probe));
    assert.ok(probe.reason.length > 10, probe.reason);
    const file = real.core.scanProbe(path.join(dir, 'a.txt'));
    assert.equal(file.fastPath, 'unavailable');
    assert.match(file.reason, /not a directory|not built/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real module: a forced native scan reports engine native, fastPath bulk, no fallback, and the walker’s tree and counters byte for byte', { skip: process.platform !== 'darwin' && 'the native listing is macOS-only until W4/W5' }, async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total, locked } = await buildEdgeFixture('treemap-native-real-');
  try {
    const legacy = await scanWith('walker', root);
    const native = await scanWith('native', root);
    assert.equal(native.status, 'complete', native.error);
    const stats = buildScanStats(native);
    assert.equal(stats.engine, 'native');
    assert.equal(stats.fastPath, 'bulk');
    assert.equal(stats.fallbackReason, null);
    assert.match(stats.engineReason, /native engine/);
    assert.equal(stats.scanned, total);
    assert.ok(typeof stats.cpuSeconds === 'number' && stats.cpuSeconds > 0, `cpuSeconds ${stats.cpuSeconds}`);
    assert.equal(stats.placeholdersSkipped, 0, 'nothing in the fixture is dataless');
    assert.equal(treeJson(native), treeJson(legacy), 'the native tree differs from the walker’s');
    assert.deepEqual(counters(native), counters(legacy), 'the native counters differ from the walker’s');
    t.diagnostic(`real module on ${total} entries: native ${stats.entriesPerSecond} entries/s (cpu ${stats.cpuSeconds?.toFixed(4)} s) vs walker ${buildScanStats(legacy).entriesPerSecond} entries/s`);
  } finally {
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('real module: pausing a native scan stops `scanned` within 200 ms, and resuming finishes it with every entry counted', { skip: process.platform !== 'darwin' && 'the native listing is macOS-only until W4/W5' }, async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total } = await buildWideTree(400, 50, 'treemap-native-pause-real-');
  try {
    await updateSettings({ engine: 'native', engineBudget: { preset: 'eco', cpuPercent: null } });
    const scan = await startScan(root);
    assert.equal(scan.status, 'running');
    const outcome = pauseScan(scan);
    assert.deepEqual({ paused: outcome.paused, supported: outcome.supported }, { paused: true, supported: true });
    await sleep(200);
    const halted = scan.scanned;
    await sleep(300);
    assert.equal(scan.scanned, halted, 'scanned kept moving while paused');
    assert.equal(scan.status, 'running', 'paused is still running, not finished');
    assert.ok(halted < total, `it really was paused mid-way (${halted} of ${total})`);
    assert.equal(resumeScan(scan).paused, false);
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete', done.error);
    assert.equal(done.engine, 'native');
    assert.equal(done.scanned, total, 'every folder and file was counted once');
    t.diagnostic(`real module, ${total} entries under Eco: ${buildScanStats(done).entriesPerSecond} entries/s`);
  } finally {
    await updateSettings({ engine: 'auto', engineBudget: { preset: 'auto', cpuPercent: null } });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('real module: cancel releases the handle — take throws the cancellation, and a second take says the handle is unknown', { skip: process.platform !== 'darwin' && 'the native listing is macOS-only until W4/W5' }, async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root } = await buildWideTree(200, 50, 'treemap-native-cancel-real-');
  try {
    const h = real.core.scanStart(root, { neverDescend: [], wantAtime: true });
    real.core.scanCancel(h);
    const t0 = Date.now();
    assert.throws(() => real.core.scanTake(h), /cancelled/);
    assert.ok(Date.now() - t0 < 1_000, 'the cancelled walk let go within a second');
    assert.throws(() => real.core.scanTake(h), /handle/, 'the handle is gone');
    assert.throws(() => real.core.scanPoll(h), /handle/);
    assert.throws(() => real.core.scanTake(999_999), /handle/, 'a handle that never existed');

    // Through the scan record too: cancelScan settles it and the engine frees its handle.
    await updateSettings({ engine: 'native' });
    const scan = await startScan(root);
    assert.equal(cancelScan(scan.scanId), true);
    const settled = await settle(scan.scanId, 5_000);
    assert.equal(settled.status, 'error');
    assert.equal(settled.engine, 'native');
  } finally {
    await updateSettings({ engine: 'auto' });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('real module: the walk result is columns, not copies — typed arrays of the declared kinds with one root and parent < child', { skip: process.platform !== 'darwin' && 'the native listing is macOS-only until W4/W5' }, async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total } = await buildWideTree(5, 4, 'treemap-native-columns-real-');
  try {
    const h = real.core.scanStart(root, { neverDescend: neverDescendPaths(), wantAtime: false });
    while (!real.core.scanPoll(h).done) await sleep(5);
    const cols = real.core.scanTake(h);
    assert.ok(cols.parent instanceof Uint32Array && cols.nameOff instanceof Uint32Array && cols.names instanceof Uint8Array);
    assert.ok(cols.kind instanceof Uint8Array && cols.flags instanceof Uint8Array);
    assert.ok(cols.size instanceof Float64Array && cols.allocBytes instanceof Float64Array && cols.mtimeMs instanceof Float64Array && cols.atimeMs instanceof Float64Array);
    assert.ok(cols.hardlinkNode instanceof Uint32Array && cols.hardlinkDev instanceof Float64Array && cols.hardlinkIno instanceof Float64Array);
    assert.ok(cols.refusalNode instanceof Uint32Array && cols.refusalWhy instanceof Uint8Array);
    assert.equal(cols.parent.length, total);
    assert.equal(cols.nameOff.length, total + 1);
    for (let i = 1; i < total; i++) assert.ok(cols.parent[i] < i, `parent[${i}] = ${cols.parent[i]}`);
    assert.equal(cols.kind[0], KIND_DIR);
    assert.ok(Number.isNaN(cols.atimeMs[1]), 'atime not asked for is NaN');
    assert.equal(cols.stats.fastPath, 'bulk');
    assert.equal(cols.stats.entries, total - 1);
    assert.equal(cols.stats.dirsListed, 6);
    assert.ok(cols.stats.cpuSeconds === null || cols.stats.cpuSeconds >= 0);
    assert.equal(Buffer.from(cols.names.buffer, cols.names.byteOffset, cols.nameOff[1]).toString('utf8'), path.basename(root));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the engine setting is part of AppSettings and defaults to Automatic', async () => {
  const settings = await getSettings();
  assert.equal(settings.engine, 'auto');
});
