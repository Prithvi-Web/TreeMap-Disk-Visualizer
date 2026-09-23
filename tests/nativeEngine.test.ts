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
  NATIVE_CANCEL_DEADLINE_MS,
  NATIVE_POLL_MS,
  NATIVE_STALL_MS,
  REFUSAL_DENIED,
  REFUSAL_UNREADABLE,
  REFUSAL_VANISHED,
  SCAN_FUNCTIONS,
  columnPathOf,
  ingestColumns,
  nativeEligibility,
  nativeScanModule,
  runNativeWalk,
  setNativeWalkTimingForTests,
} from '../src/services/scan/nativeEngine';
import { statToInput } from '../src/services/scan/nodeInput';
import { PackedScanStore, storeOf, type ScanStore } from '../src/services/scanStore';
import { platform } from '../src/platform';
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
 *     reports `engine: 'native'`, the platform's own fast path (`bulk` on
 *     macOS, `getdents` on Linux, `extdDirInfo` on Windows), no fallback and
 *     the walker's counters; pause stops the count; cancel frees the handle; a
 *     take of a walk still running is refused, never joined (N1).
 *  5. The walk can neither freeze the app nor run forever (section 3b): a
 *     cancel is settled by polling to done and abandoned at a deadline when
 *     the walk never answers (N2); a walk that shows nothing new — no entry,
 *     no heartbeat, and neither the scan's pause gate nor a governor hold
 *     holding it — for NATIVE_STALL_MS is a stall the legacy chain retries
 *     (N3); and a module that throws mid-walk has its handle settled before
 *     the error propagates (N4).
 *
 * The fake-module tests run against a fake injected through the loader's own
 * seam, exactly as tests/engineBudget.test.ts does; the real-module tests are
 * skipped with their reason when no prebuilt module is on disk.
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

/*
 * The two platform facts the ingest reads, read the way nativeEngine.ts reads
 * them, so an expectation here follows the product's own fact rather than a
 * platform name. The product holds that `blocks` means nothing on Windows
 * (src/platform/index.ts), so the walker records no allocation there and
 * neither engine keeps a sparse or slack account; and libuv's scandir
 * byte-sorts a readdir listing everywhere but Windows, which keeps the file
 * system's own order, as the native listing does there.
 */
const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;
const SORT_CHILDREN = platform().platform !== 'windows';

/*
 * The listing the real module names for a folder here: tm-walk's
 * `platform_probe` (platform/mod.rs) lists with getattrlistbulk on macOS,
 * getdents64 and statx on Linux and FileIdExtdDirectoryInfo on Windows, named
 * by `FastPath::as_str` (lib.rs). Every other platform has no native listing
 * (platform/unsupported.rs), and its probe says so.
 */
const NATIVE_FAST_PATH = ({ darwin: 'bulk', linux: 'getdents', win32: 'extdDirInfo' } as Partial<Record<NodeJS.Platform, string>>)[process.platform] ?? 'unavailable';

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
  // Written with '/', as every folder below is: path.join turns it into the
  // platform's separator at the disk, and the count at the end splits on '/'.
  // Joined with '\' on Windows, this path's three folders counted as one, and
  // the builder expected two entries fewer than the walker found.
  const cloud = 'Library/Mobile Documents/com~apple~CloudDocs';
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
  // Numbered by exact identity, as the walk numbers them: a bigint stat, so an
  // id past 2^53 is still its own.
  const hardlinks: Array<{ node: number; family: number }> = [];
  const families = new Map<string, number>();
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
        const exact = fs.lstatSync(full, { bigint: true });
        const key = `${exact.dev}:${exact.ino}`;
        if (!families.has(key)) families.set(key, families.size);
        hardlinks.push({ node: id, family: families.get(key)! });
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
    hardlinkFamily: Uint32Array.from(hardlinks.map((h) => h.family)),
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
  /**
   * A worker wedged inside a directory-listing syscall (a dead network
   * mount): every poll reports the same entries and heartbeat, and a cancel
   * is never answered with done, so the walk can only be abandoned.
   */
  wedged?: boolean;
  /** One huge directory still listing: entries stay at zero until the walk is done while the heartbeat ticks on every poll. */
  hugeDir?: boolean;
  /** The n-th poll (1-based) throws this instead of reporting. */
  pollThrows?: { at: number; message: string };
  /** Called at every poll, before it reports: the stall tests advance an injected clock here, the cancel tests flip the record. */
  onPoll?: (polls: number) => void;
  /** Adds the governor surface with a snapshot in this state, so `budgetSnapshot()` sees a live governor (a thermal hold is `paused: true`). */
  governor?: { paused: boolean };
}

interface FakeHandle { root: string; columns: WalkResult; polls: number; pollCalls: number; paused: boolean; cancelled: boolean; done: boolean }

/** The N1 refusal, word for word as tm-node throws it, so the fake and the module agree on what a take of a running walk is. */
const STILL_RUNNING = 'the walk is still running: poll it until done — cancel first to end it — before taking it';

/**
 * A fake tm-node with the scan surface over hand-built columns, injected
 * through the real loader so the handshake still runs. It keeps the real
 * module's contract where the engine depends on it: a cancel is answered
 * with `done` by the next poll (the workers stop at their next check, never
 * inside the cancel call), and a take of a walk that is not done is refused
 * and keeps the handle (N1). `calls.log` records every call in order.
 */
function useFakeNative(script: FakeScript) {
  resetNativeForTests();
  resetEngineBudgetForTests();
  const handles = new Map<number, FakeHandle>();
  const calls = { probe: [] as string[], start: [] as Array<{ root: string; opts: ScanStartOptions }>, pause: 0, resume: 0, cancel: 0, take: 0, log: [] as string[] };
  let next = 1;
  const steps = script.steps ?? 3;
  const must = (h: number): FakeHandle => {
    const s = handles.get(h);
    if (!s) throw new Error(`no scan handle ${h}: it was taken, cancelled or never started`);
    return s;
  };
  const governorSnapshot = () => ({
    budget: { preset: 'balanced', cpuPercent: null }, effective: 'balanced', targetShare: 0.5, share1s: 0.1, workers: 2, duty: 0.5,
    thermal: script.governor?.paused ? 'critical' : 'nominal', onBattery: false, interacting: false, machineBusyShare: null,
    paused: script.governor?.paused === true, ticks: 1, mechanisms: {},
  });
  const module = {
    version: () => pkg.nativeVersion,
    scanProbe: (root: string): NativeProbe => { calls.probe.push(root); return script.probe ?? { fastPath: 'bulk', reason: 'fake: the root was listed through the getattrlistbulk path' }; },
    scanStart: (root: string, opts: ScanStartOptions): number => {
      if (script.startError) throw new Error(script.startError);
      calls.start.push({ root, opts });
      calls.log.push('start');
      const id = next++;
      handles.set(id, { root, columns: (script.columns ?? (() => columnsFromDisk(root)))(), polls: 0, pollCalls: 0, paused: false, cancelled: false, done: false });
      return id;
    },
    scanPoll: (h: number): NativeProgress => {
      const s = must(h);
      s.pollCalls++;
      script.onPoll?.(s.pollCalls);
      if (script.pollThrows && s.pollCalls === script.pollThrows.at) throw new Error(script.pollThrows.message);
      const total = s.columns.parent.length - 1;
      if (script.wedged) {
        calls.log.push('poll');
        return { done: false, error: null, entries: 0, dirs: 0, files: 0, bytes: 0, heartbeat: 1, currentPath: path.join(s.root, 'wedged-mount') };
      }
      if (s.cancelled) s.done = true; // the workers saw the cancel at their next check
      if (!s.paused && !s.done) s.polls++;
      if (s.polls >= steps) s.done = true;
      calls.log.push(s.done ? 'poll:done' : 'poll');
      const entries = s.done ? total : script.hugeDir ? 0 : Math.min(total, Math.floor((total * s.polls) / steps));
      return { done: s.done, error: s.done && script.walkError ? script.walkError : null, entries, dirs: 0, files: entries, bytes: 0, heartbeat: s.polls, currentPath: s.done ? null : path.join(s.root, `step-${s.polls}`) };
    },
    scanPause: (h: number): void => { must(h).paused = true; calls.pause++; calls.log.push('pause'); },
    scanResume: (h: number): void => { must(h).paused = false; calls.resume++; calls.log.push('resume'); },
    scanCancel: (h: number): void => { must(h).cancelled = true; calls.cancel++; calls.log.push('cancel'); },
    scanTake: (h: number): WalkResult => {
      const s = must(h);
      calls.take++;
      calls.log.push('take');
      if (!s.done) throw new Error(STILL_RUNNING);
      handles.delete(h);
      if (s.cancelled) throw new Error('the native scan was cancelled');
      if (script.walkError) throw new Error(script.walkError);
      return s.columns;
    },
    ...(script.governor
      ? { governorCapabilities: () => ({}), governorConfigure: () => undefined, governorSnapshot, governorPause: () => undefined, governorResume: () => undefined }
      : {}),
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

/** `cols` ingested into a fresh record for `root`, finalized and summed as runNativeWalk leaves it. */
function ingested(root: string, cols: WalkResult): ScanResult {
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, rootInput(root));
  ingestColumns(scan, store, cols, root);
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return scan;
}

/** Each folder's children in the order `store` keeps them, keyed by the folder's '/'-joined path below the root ('' is the root). */
function storeOrder(store: ScanStore): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (id: number, rel: string): void => {
    const kids = store.childIds(id);
    out.set(rel, kids.map((k) => store.name(k)));
    for (const k of kids) if (store.isDir(k)) visit(k, rel === '' ? store.name(k) : `${rel}/${store.name(k)}`);
  };
  visit(store.rootId, '');
  return out;
}

/** Each folder's children in the order the listing in `cols` gave them, keyed as `storeOrder` keys them. */
function listingOrder(cols: WalkResult): Map<string, string[]> {
  const names = Buffer.from(cols.names.buffer, cols.names.byteOffset, cols.names.byteLength);
  const rel: string[] = [''];
  const out = new Map<string, string[]>([['', []]]);
  for (let i = 1; i < cols.parent.length; i++) {
    const name = names.toString('utf8', cols.nameOff[i], cols.nameOff[i + 1]);
    const up = rel[cols.parent[i]];
    rel[i] = up === '' ? name : `${up}/${name}`;
    const siblings = out.get(up);
    assert.ok(siblings, `node ${i} (${rel[i]}) hangs under node ${cols.parent[i]}, which is not a folder`);
    siblings.push(name);
    if (cols.kind[i] === KIND_DIR) out.set(rel[i], []);
  }
  return out;
}

/**
 * A clock the fake's polls advance by a second each (through `onPoll`), so the
 * stall and cancel deadlines the tests inject are crossed by a known poll
 * count whatever the machine is doing meanwhile: with a 2.5 s threshold, the
 * fourth poll that shows nothing new is the one that crosses it.
 */
const POLL_SECOND_MS = 1_000;
function fakeClock() {
  let now = 0;
  return { now: () => now, tick: () => { now += POLL_SECOND_MS; } };
}

/** A record and a store for driving `runNativeWalk` directly, outside `startScan`. */
function recordFor(root: string): { scan: ScanResult; store: PackedScanStore } {
  return { scan: createScanRecord(root), store: new PackedScanStore(root, path.sep, rootInput(root)) };
}

/**
 * Waits for `walk` to end, for at most `ms`. A walk the engine never ends
 * (no stall detector, no cancel deadline) would hang the run: past the bound
 * the fake forgets its handles, so the loop's next poll throws and the walk
 * ends, and the caller asserts 'settled' — a failure, not a hang.
 */
async function bounded(walk: Promise<void>, fake: { handles: Map<number, FakeHandle> }, ms = 10_000): Promise<'settled' | 'timed out'> {
  const outcome = await Promise.race([walk.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => 'timed out' as const)]);
  if (outcome === 'timed out') {
    fake.handles.clear();
    await walk.catch(() => undefined);
  }
  return outcome;
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

test('nativeEligibility: forced native that could not be honoured says the setting asked for it — a module that is not loaded, and a probe that refused — as the rules and gdu already do', () => {
  const asked = 'the Scan engine setting asks for the native engine, but ';
  const missing = nativeEligibility('/tree', { ...base, forced: 'native', native: { available: false, reason: 'no native module at /x/treemap_core.node for linux-x64; the legacy engines run instead' } });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, `${asked}the native module is not loaded: no native module at /x/treemap_core.node for linux-x64; the legacy engines run instead`);
    assert.equal(missing.fallback, true);
  }
  const probe: NativeProbe = { fastPath: 'unavailable', reason: 'the native listing is not built for linux yet' };
  const refused = nativeEligibility('/tree', { ...base, forced: 'native', native: { available: true, probe } });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, `${asked}the native listing is unavailable for /tree: the native listing is not built for linux yet`);
    assert.equal(refused.fallback, true);
    assert.equal(refused.probeRefused, true);
  }
  // Automatic asked for nothing, so neither sentence claims it did.
  const auto = nativeEligibility('/tree', { ...base, native: { available: false, reason: 'no module' } });
  assert.equal(auto.ok, false);
  if (!auto.ok) assert.equal(auto.reason, 'the native module is not loaded: no module');
  const autoProbe = nativeEligibility('/tree', { ...base, native: { available: true, probe } });
  assert.equal(autoProbe.ok, false);
  if (!autoProbe.ok) assert.equal(autoProbe.reason, 'the native listing is unavailable for /tree: the native listing is not built for linux yet');
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
    // The fixture exercised every branch it was built for, as far as the
    // platform lets one be built. The walker calls a file a placeholder when it
    // claims bytes, occupies no blocks and lives under a cloud folder, so the
    // truncated file under the iCloud path is one exactly when lstat reports no
    // blocks for it. APFS and ext4 leave a truncate-only file unallocated; on
    // Windows, where the product treats blocks as meaningless, the answer is
    // the platform's, so it is asked here rather than assumed. Sparse
    // accounting is gated on blocks meaning anything, in both engines, so the
    // VM image is sparse only where they do.
    assert.equal(legacy.hardlinkedFiles, 1);
    assert.equal(legacy.hardlinkedBytes, 999);
    const placeholderBlocks = fs.lstatSync(path.join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'doc.pages')).blocks;
    assert.deepEqual({ files: legacy.cloudFiles, bytes: legacy.cloudBytes }, placeholderBlocks === 0 ? { files: 1, bytes: 4 * KB } : { files: 0, bytes: 0 },
      `the truncated file under Library/Mobile Documents occupies ${placeholderBlocks} blocks here`);
    if (BLOCKS_ARE_MEANINGFUL) {
      assert.ok((legacy.sparseFiles ?? 0) >= 1, 'the truncated VM image is sparse');
      assert.ok((legacy.sparseBytes ?? 0) >= 1024 * KB);
    } else {
      assert.deepEqual({ files: legacy.sparseFiles, bytes: legacy.sparseBytes }, { files: 0, bytes: 0 }, 'no sparse account where blocks mean nothing');
    }
    if (locked) assert.deepEqual({ dirs: legacy.deniedDirs, examples: legacy.deniedExamples }, { dirs: 1, examples: [locked] });
    assert.match(treeJson(legacy), /"name":"repo"[^{]*"gitRepo":true/);
    assert.match(treeJson(legacy), /"name":"link\.txt"[^{]*"isSymlink":true/);
    assert.match(treeJson(legacy), /"name":"photos\.photoslibrary"[^{]*"container":"photos"/);

    const cols = columnsFromDisk(root);
    assert.equal(cols.parent.length, total);
    const scan = ingested(root, cols);

    assert.equal(treeJson(scan), treeJson(legacy), 'the pruned JSON differs from the walker’s');
    assert.deepEqual(counters(scan), counters(legacy), 'the counters differ from the walker’s');
    assert.equal(scan.placeholdersSkipped, 0);
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('ingestColumns emits each directory’s children in the order the walker lists them — re-sorted by name bytes wherever libuv sorts a listing, kept as listed on Windows — and the first name in that order keeps a hard link’s bytes', async () => {
  useNoNative();
  const { root, locked } = await buildEdgeFixture('treemap-native-order-');
  try {
    const legacy = await scanWith('walker', root);
    // The premise: a plain readdir listing is in the walker's own order, since
    // the walker lists with the same readdir — byte-sorted by libuv, or on
    // Windows the file system's own order, which the native listing gives too.
    const plain = columnsFromDisk(root);
    assert.deepEqual(listingOrder(plain), storeOrder(storeOf(legacy)), 'a plain listing and the walker disagree on the order of a folder');
    const scrambled = columnsFromDisk(root, {}, { scramble: true });
    const rootsFirstChild = Buffer.from(scrambled.names.buffer, scrambled.names.byteOffset + scrambled.nameOff[1], scrambled.nameOff[2] - scrambled.nameOff[1]).toString('utf8');
    assert.equal(rootsFirstChild, 'vm', 'the listing really is scrambled: the root’s first child is its last name');
    const scan = ingested(root, scrambled);
    if (SORT_CHILDREN) {
      assert.equal(treeJson(scan), treeJson(legacy), 'the pruned JSON differs from the walker’s');
      assert.deepEqual(counters(scan), counters(legacy));
      assert.match(treeJson(scan), /"name":"hard-b\.bin"[^{}]*"hardlinkDuplicate":true/, 'hard-a keeps the bytes and hard-b is the duplicate, as the walker has it, although the listing named hard-b first');
    } else {
      // Where the walker keeps the file system's order, the ingest keeps the
      // listing's: a scrambled listing stays scrambled, and the name it gives
      // first keeps a hard link's bytes. A listing in the walker's own order —
      // which the real listing there gives — is then the walker's tree byte
      // for byte.
      assert.deepEqual(storeOrder(storeOf(scan)), listingOrder(scrambled), 'the ingest re-ordered the listing where the walker keeps the listing’s order');
      assert.match(treeJson(scan), /"name":"hard-a\.bin"[^{}]*"hardlinkDuplicate":true/, 'hard-b, named first by the listing, keeps the bytes and hard-a is the duplicate');
      const inOrder = ingested(root, plain);
      assert.equal(treeJson(inOrder), treeJson(legacy), 'the pruned JSON differs from the walker’s');
      assert.deepEqual(counters(inOrder), counters(legacy));
    }
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('ingestColumns: the cloud-placeholder branch on columns built by hand — size above zero, no allocation, an iCloud path; the same file outside a cloud folder is sparse wherever blocks mean something', () => {
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
    hardlinkNode: new Uint32Array(0), hardlinkFamily: new Uint32Array(0),
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
  // The sparse line is gated on the platform's blocks meaning anything, as the
  // walker's is: on Windows the walker records no allocation, so the ingest
  // keeps no sparse account either and the image is only its size there.
  const sparse = BLOCKS_ARE_MEANINGFUL ? { sparseFiles: 1, sparseBytes: 8000 } : { sparseFiles: undefined, sparseBytes: undefined };
  assert.deepEqual({ cloudFiles: scan.cloudFiles, cloudBytes: scan.cloudBytes, sparseFiles: scan.sparseFiles, sparseBytes: scan.sparseBytes, slackBytes: scan.slackBytes ?? 0 },
    { cloudFiles: 1, cloudBytes: 5000, ...sparse, slackBytes: 0 }, 'the placeholder’s bytes are on the cloud line only, the sparse file’s on the sparse line where there is one');
  assert.equal(scan.placeholdersSkipped, 1, 'the walk’s dataless count');
  assert.equal(store.size(store.rootId), 13000);
});

test('ingestColumns: hard-link families are told apart by the number the walk gave them, never by rounded ids', () => {
  // The walk groups names by their file's exact identity and numbers each
  // family; the ingest keys on that number. It once keyed on `${dev}:${ino}`
  // as doubles, and a Windows file id past 2^53 (a record reused 32 times)
  // rounds into its neighbour's, so two different files counted as one and
  // the second one's bytes vanished (the pre-landing review of 23 Sep 2026).
  const root = '/r';
  const names = ['r', 'a.bin', 'b.bin', 'c.bin'];
  const enc = names.map((n) => Buffer.from(n, 'utf8'));
  const nameOff = new Uint32Array(names.length + 1);
  let off = 0;
  enc.forEach((n, i) => { nameOff[i] = off; off += n.length; });
  nameOff[names.length] = off;
  const cols: WalkResult = {
    parent: Uint32Array.from([0, 0, 0, 0]),
    nameOff,
    names: new Uint8Array(Buffer.concat(enc)),
    kind: Uint8Array.from([KIND_DIR, KIND_FILE, KIND_FILE, KIND_FILE]),
    flags: new Uint8Array(4),
    size: Float64Array.from([0, 10, 20, 20]), allocBytes: Float64Array.from([0, 10, 20, 20]),
    mtimeMs: Float64Array.from([1, 2, 3, 4]), atimeMs: Float64Array.from([NaN, NaN, NaN, NaN]),
    hardlinkNode: Uint32Array.from([1, 2, 3]),
    hardlinkFamily: Uint32Array.from([0, 1, 1]),
    refusalNode: new Uint32Array(0), refusalWhy: new Uint8Array(0),
    stats: { dirsListed: 1, entries: 3, wallMs: 1, cpuSeconds: 0, fastPath: 'bulk', workersPeak: 1, climbSteps: 0, deniedEntries: 0, unreadableEntries: 0, dataless: 0 },
  };
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '/', { name: 'r', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  ingestColumns(scan, store, cols, root);
  store.finalize();
  store.sumSizes();
  assert.equal(store.size(store.rootId), 30, 'a.bin, and one name of the b/c family');
  assert.deepEqual({ files: scan.hardlinkedFiles, bytes: scan.hardlinkedBytes }, { files: 1, bytes: 20 });
  assert.equal(store.materialize(store.findByPath('/r/a.bin')).hardlinkDuplicate, undefined, 'a family of its own');
  assert.equal(store.materialize(store.findByPath('/r/c.bin')).hardlinkDuplicate, true, 'the later name of b’s family');
});

test('columnPathOf builds a path from its parent chain without recursing, and refuses a chain that never reaches the root', () => {
  const columnsOf = (parent: number[], names: string[]): WalkResult => {
    const enc = names.map((n) => Buffer.from(n, 'utf8'));
    const nameOff = new Uint32Array(names.length + 1);
    let off = 0;
    enc.forEach((n, i) => { nameOff[i] = off; off += n.length; });
    nameOff[names.length] = off;
    const n = names.length;
    return {
      parent: Uint32Array.from(parent), nameOff, names: new Uint8Array(Buffer.concat(enc)),
      kind: new Uint8Array(n), flags: new Uint8Array(n), size: new Float64Array(n), allocBytes: new Float64Array(n),
      mtimeMs: new Float64Array(n), atimeMs: new Float64Array(n),
      hardlinkNode: new Uint32Array(0), hardlinkFamily: new Uint32Array(0), refusalNode: new Uint32Array(0), refusalWhy: new Uint8Array(0),
      stats: { dirsListed: 1, entries: n - 1, wallMs: 1, cpuSeconds: 0, fastPath: 'bulk', workersPeak: 1, climbSteps: 0, deniedEntries: 0, unreadableEntries: 0, dataless: 0 },
    };
  };
  // A chain 100,000 deep: far past any stack a recursive climb could use.
  const depth = 100_000;
  const deep = columnsOf(Array.from({ length: depth + 1 }, (_, i) => Math.max(0, i - 1)), ['r', ...Array.from({ length: depth }, () => 'd')]);
  const leaf = columnPathOf(deep, '/r', '/')(depth);
  assert.equal(leaf.length, '/r'.length + depth * 2, 'every level joined once');
  // What is remembered along the way is exact: the parent, and a sibling built from it.
  const small = columnsOf([0, 0, 1, 2, 2], ['r', 'a', 'b', 'c', 'c2']);
  const of = columnPathOf(small, '/r', '/');
  assert.equal(of(3), '/r/a/b/c');
  assert.equal(of(2), '/r/a/b', 'the parent, remembered from its child');
  assert.equal(of(4), '/r/a/b/c2', 'a sibling, built from the remembered parent');
  assert.equal(columnPathOf(small, '/', '/')(3), '/a/b/c', 'a root that ends in the separator gets no second one');
  // A corrupt column whose chain loops (1 → 2 → 1) is refused, never climbed forever.
  const looped = columnsOf([0, 2, 1], ['r', 'a', 'b']);
  assert.throws(() => columnPathOf(looped, '/r', '/')(1), /node 1's parent chain never reaches the root/);
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
    hardlinkNode: new Uint32Array(0), hardlinkFamily: new Uint32Array(0),
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

test('a finished walk is noticed within a short poll, not a whole progress cadence', async () => {
  // The poll that updates progress is also how a walk's end is noticed. At a
  // 100 ms cadence a finished walk sat unnoticed 20-40 ms on a 200,000-entry
  // scan and ~28 ms on a 100 ms one (M3, 23 Sep 2026). Past its ramp (1, 2,
  // 4 ... ms) the loop polls every NATIVE_POLL_MS; a median over the gaps
  // keeps one slow timer on a busy machine from deciding the verdict. The
  // ceiling is half the old 100 ms cadence, which still fails it, and leaves
  // room for Windows, whose default timer ticks every 15.6 ms: a 10 ms sleep
  // there wakes on the next tick, 15.6-31.2 ms on a busy runner.
  const { root, locked } = await buildEdgeFixture('treemap-native-slack-');
  try {
    const { scan, store } = recordFor(root);
    const polls: number[] = [];
    const fake = useFakeNative({ steps: Number.MAX_SAFE_INTEGER, onPoll: () => { polls.push(performance.now()); } });
    let endedAt = 0;
    let takenAt = 0;
    const take = fake.module.scanTake;
    fake.module.scanTake = (h: number) => {
      takenAt = performance.now();
      return take(h);
    };
    // Ends the walk well past the ramp, as a real walk ends: between two polls.
    const timer = setTimeout(() => {
      for (const h of fake.handles.values()) h.done = true;
      endedAt = performance.now();
    }, 400);
    await runNativeWalk(scan, store, root, fake.module);
    clearTimeout(timer);
    const RAMP = 8;
    const gaps = polls.slice(RAMP + 1).map((t, i) => t - polls[RAMP + i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    assert.ok(median <= 50, `past its ramp the loop polled every ${median.toFixed(1)} ms (NATIVE_POLL_MS is ${NATIVE_POLL_MS})`);
    assert.ok(endedAt > 0 && takenAt >= endedAt, 'the walk ended when the test ended it, and was taken after');
    assert.ok(takenAt - endedAt < 60, `the end was noticed ${Math.round(takenAt - endedAt)} ms after the walk ended`);
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('pausing a native scan stops `scanned` within 200 ms and resuming finishes it with every entry counted', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-pause-');
  try {
    const fake = useFakeNative({ steps: 400 }); // about four seconds of polls at NATIVE_POLL_MS, unless paused
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
    const fake = useFakeNative({ steps: 400 }); // still running when the cancel comes, however slow the machine
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

/* ═══════════════════ 3b. settling, stalls and a throw mid-walk (N2–N4) ═══════════════════ */

test('a cancel settles in the module’s order: cancel, then polls until the walk reports done, then the one take that frees the handle — never a take before done', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-settle-');
  try {
    const { scan, store } = recordFor(root);
    const fake = useFakeNative({ steps: 40, onPoll: (n) => { if (n === 2) scan.cancelled = true; } });
    await runNativeWalk(scan, store, root, fake.module);
    const log = fake.calls.log;
    const cancelAt = log.indexOf('cancel');
    assert.ok(cancelAt > 0, `no cancel in: ${log.join(' ')}`);
    assert.deepEqual(log.slice(cancelAt), ['cancel', 'poll:done', 'take'], 'after the cancel: a poll that reports done, then the one take');
    assert.equal(fake.calls.take, 1);
    assert.equal(fake.handles.size, 0, 'the handle was freed');
  } finally {
    await unlockAndRemove(root, locked);
  }
});

test('a cancelled walk that never reports done is abandoned at the cancel deadline: polling stops, take is never called, and the handle stays in the module', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-abandon-');
  const clock = fakeClock();
  try {
    assert.equal(NATIVE_CANCEL_DEADLINE_MS, 5_000);
    setNativeWalkTimingForTests({ cancelDeadlineMs: 2_500, now: clock.now });
    const { scan, store } = recordFor(root);
    const fake = useFakeNative({ wedged: true, onPoll: (n) => { clock.tick(); if (n === 2) scan.cancelled = true; } });
    const walk = runNativeWalk(scan, store, root, fake.module);
    assert.equal(await bounded(walk, fake, 3_000), 'settled', 'runNativeWalk did not return within 3 s of a cancel the walk never answered');
    await walk;
    assert.equal(fake.calls.cancel, 1);
    const after = fake.calls.log.slice(fake.calls.log.indexOf('cancel') + 1);
    assert.ok(after.length >= 1 && after.every((c) => c === 'poll'), `after the cancel, polls and then nothing: ${after.join(' ')}`);
    assert.equal(after.length, 3, 'polled at 1 s and 2 s within the 2.5 s deadline, at 3 s past it, then abandoned');
    assert.equal(fake.calls.take, 0, 'a take of a wedged walk would block the app; it is never attempted');
    assert.equal(fake.handles.size, 1, 'the handle is left in the module for the life of the process');
  } finally {
    setNativeWalkTimingForTests(null);
    await unlockAndRemove(root, locked);
  }
});

test('a walk that shows nothing new for the stall threshold is a stall: cancelled, abandoned when the cancel goes unanswered, and thrown as a sentence naming the directory', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-stall-');
  const clock = fakeClock();
  try {
    assert.equal(NATIVE_STALL_MS, 30_000, 'the legacy walker’s READDIR_DEADLINE_MS');
    setNativeWalkTimingForTests({ stallMs: 2_500, cancelDeadlineMs: 1_500, now: clock.now });
    const { scan, store } = recordFor(root);
    const fake = useFakeNative({ wedged: true, onPoll: clock.tick });
    const walk = runNativeWalk(scan, store, root, fake.module);
    assert.equal(await bounded(walk, fake), 'settled', 'the wedged walk was never ended: no stall was detected within 10 s');
    await assert.rejects(walk, (err: unknown) => {
      assert.equal((err as Error).message, `the native walk made no progress for 2.5 s at ${path.join(root, 'wedged-mount')}`);
      return true;
    });
    const log = fake.calls.log;
    assert.deepEqual(log.slice(0, log.indexOf('cancel')), ['start', 'poll', 'poll', 'poll', 'poll'], 'the first poll is the baseline; the next three showed nothing new at 1 s and 2 s (within 2.5 s) and 3 s (past it)');
    assert.equal(fake.calls.cancel, 1, 'the stalled walk was cancelled');
    assert.equal(fake.calls.take, 0);
    assert.equal(fake.handles.size, 1, 'and abandoned when the cancel went unanswered');
  } finally {
    setNativeWalkTimingForTests(null);
    await unlockAndRemove(root, locked);
  }
});

test('a walk that keeps moving is never a stall however long it takes: entries growing, or only the heartbeat while one huge directory lists', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-steady-');
  const clock = fakeClock();
  try {
    setNativeWalkTimingForTests({ stallMs: 2_500, now: clock.now });
    for (const hugeDir of [false, true]) {
      const { scan, store } = recordFor(root);
      const fake = useFakeNative({ steps: 8, hugeDir, onPoll: clock.tick });
      await runNativeWalk(scan, store, root, fake.module);
      const what = hugeDir ? 'heartbeat only' : 'entries';
      assert.equal(fake.calls.cancel, 0, `${what}: eight polls a second apart, three times the threshold, and never cancelled`);
      assert.equal(fake.calls.log.filter((c) => c.startsWith('poll')).length, 8, what);
      assert.equal(fake.calls.take, 1, what);
      assert.equal(scan.scanned, total, what);
    }
  } finally {
    setNativeWalkTimingForTests(null);
    await unlockAndRemove(root, locked);
  }
});

test('a paused walk is not a stall: the pause gate holds it past the threshold and it finishes after resume, on the native engine', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-stall-paused-');
  const clock = fakeClock();
  try {
    setNativeWalkTimingForTests({ stallMs: 2_500, now: clock.now });
    const fake = useFakeNative({ steps: 40, onPoll: clock.tick });
    await updateSettings({ engine: 'native' });
    const scan = await startScan(root);
    while (scan.status === 'running' && scan.scanned < 3) await sleep(5);
    assert.equal(pauseScan(scan).paused, true);
    const pausedAt = fake.calls.log.length;
    // Six polls a (fake) second apart while paused: 6 s without a new entry or heartbeat, past the 2.5 s threshold.
    const t0 = Date.now();
    while (fake.calls.log.length - pausedAt < 6) {
      assert.ok(Date.now() - t0 < 5_000, 'the paused walk stopped being polled');
      await sleep(5);
    }
    assert.equal(scan.status, 'running');
    assert.equal(fake.calls.cancel, 0, 'a paused walk was cancelled as a stall');
    assert.equal(resumeScan(scan).paused, false);
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete', done.error);
    assert.equal(done.engine, 'native');
    assert.equal(done.fallbackReason, null);
    assert.equal(done.scanned, total);
  } finally {
    setNativeWalkTimingForTests(null);
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('a governor hold (critical heat, or governorPause) is not a stall either; once it lifts, a walk still showing nothing new is', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-stall-governor-');
  const clock = fakeClock();
  try {
    setNativeWalkTimingForTests({ stallMs: 2_500, cancelDeadlineMs: 1_500, now: clock.now });
    const governor = { paused: true };
    const { scan, store } = recordFor(root);
    const fake = useFakeNative({ wedged: true, governor, onPoll: (n) => { clock.tick(); if (n === 6) governor.paused = false; } });
    const walk = runNativeWalk(scan, store, root, fake.module);
    assert.equal(await bounded(walk, fake), 'settled', 'the wedged walk was never ended once the hold lifted');
    await assert.rejects(walk, /made no progress for 2\.5 s/);
    const log = fake.calls.log;
    assert.equal(log.indexOf('cancel'), 1 + 8, `five polls under the hold went unpunished; it lifted before the sixth, and the eighth — 3 s after the last held poll — crossed 2.5 s: ${log.join(' ')}`);
  } finally {
    setNativeWalkTimingForTests(null);
    await unlockAndRemove(root, locked);
  }
});

test('a native walk that stalls falls back to the walker with the stall as the reason, and the scan completes', async () => {
  const { root, total, locked } = await buildEdgeFixture('treemap-native-stall-fallback-');
  const clock = fakeClock();
  try {
    setNativeWalkTimingForTests({ stallMs: 2_500, cancelDeadlineMs: 1_500, now: clock.now });
    const fake = useFakeNative({ wedged: true, onPoll: clock.tick });
    await updateSettings({ engine: 'auto' });
    const scan = await startScan(root);
    const t0 = Date.now();
    while (scan.status === 'running' && Date.now() - t0 < 10_000) await sleep(10);
    if (scan.status === 'running') fake.handles.clear(); // unblock the loop, so the failure below is a failure and not a hang
    assert.notEqual(scan.status, 'running', 'the scan never left the wedged native walk: no stall was detected within 10 s');
    await settle(scan.scanId);
    assert.equal(scan.status, 'complete', scan.error);
    assert.equal(scan.engine === 'walker' || scan.engine === 'turbo-walker', true, scan.engine);
    assert.match(scan.fallbackReason ?? '', /^the native engine failed part-way: the native walk made no progress for 2\.5 s at /);
    assert.equal(scan.fastPath, 'readdir+lstat');
    assert.equal(scan.scanned, total, 'nothing the stalled native attempt counted is left in the total');
    assert.equal(fake.calls.cancel, 1);
    assert.equal(fake.calls.take, 0);
    assert.equal(fake.handles.size, 1, 'the wedged handle stays in the module');
  } finally {
    setNativeWalkTimingForTests(null);
    await unlockAndRemove(root, locked);
  }
});

test('a module that throws mid-walk does not leak the handle: the walk is cancelled and settled before the error propagates', async () => {
  const { root, locked } = await buildEdgeFixture('treemap-native-midthrow-');
  try {
    const { scan, store } = recordFor(root);
    const fake = useFakeNative({ steps: 40, pollThrows: { at: 2, message: 'the native module lost the walk: a worker thread panicked' } });
    await assert.rejects(runNativeWalk(scan, store, root, fake.module), /lost the walk: a worker thread panicked/);
    const log = fake.calls.log;
    const cancelAt = log.indexOf('cancel');
    assert.ok(cancelAt > 0, `no cancel in: ${log.join(' ')}`);
    assert.deepEqual(log.slice(cancelAt), ['cancel', 'poll:done', 'take'], 'settled after the throw: cancelled, polled to done, taken to free it');
    assert.equal(fake.handles.size, 0, 'the handle was freed');
  } finally {
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

test('real module: scanProbe names the platform’s own listing with a reason on a folder, and unavailable on a file', (t) => {
  const real = loadReal(t);
  if (!real) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-native-probe-real-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const probe = real.core.scanProbe(dir);
    assert.equal(probe.fastPath, NATIVE_FAST_PATH, JSON.stringify(probe));
    // Each platform's `probe` (darwin.rs, linux.rs, windows.rs) names its
    // mechanism and counts what it listed: the one file, since every listing
    // drops `.` and `..`. Linux names fstatat instead where statx is refused.
    // A platform without a listing says so for both roots (unsupported.rs).
    const notBuilt = /^the native listing is not built for \S+ yet$/;
    const listed = ({
      bulk: /^getattrlistbulk listed the root directory \(1 entries\)$/,
      getdents: /^getdents64 and (?:statx|fstatat \(statx answered ENOSYS or EPERM\)) listed the root directory \(1 entries\)$/,
      extdDirInfo: /^FileIdExtdDirectoryInfo listed the root directory \(1 entries\)$/,
    } as Partial<Record<string, RegExp>>)[NATIVE_FAST_PATH] ?? notBuilt;
    assert.match(probe.reason, listed);
    const file = real.core.scanProbe(path.join(dir, 'a.txt'));
    assert.equal(file.fastPath, 'unavailable');
    assert.match(file.reason, NATIVE_FAST_PATH === 'unavailable' ? notBuilt : /^the root is not a directory$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real module: a forced native scan reports engine native, the platform’s own fastPath, no fallback, and the walker’s tree and counters byte for byte', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total, locked } = await buildEdgeFixture('treemap-native-real-');
  try {
    const legacy = await scanWith('walker', root);
    const native = await scanWith('native', root);
    assert.equal(native.status, 'complete', native.error);
    const stats = buildScanStats(native);
    assert.equal(stats.engine, 'native');
    assert.equal(stats.fastPath, NATIVE_FAST_PATH);
    assert.equal(stats.fallbackReason, null);
    assert.match(stats.engineReason, /native engine/);
    assert.equal(stats.scanned, total);
    // The two engines' agreement first: a test stops at its first failure, and
    // on a platform whose listing is new this is the finding that matters.
    assert.equal(treeJson(native), treeJson(legacy), 'the native tree differs from the walker’s');
    assert.deepEqual(counters(native), counters(legacy), 'the native counters differ from the walker’s');
    // Measured, never null: Windows' thread and process clocks count 15.6 ms
    // ticks, so a walk of a few dozen entries there can honestly measure 0
    // (the CI dry run of 23 Sep 2026); elsewhere it cannot.
    const coarseClock = process.platform === 'win32';
    assert.ok(
      typeof stats.cpuSeconds === 'number' && (stats.cpuSeconds > 0 || (coarseClock && stats.cpuSeconds === 0)),
      `cpuSeconds ${stats.cpuSeconds}`,
    );
    assert.equal(stats.placeholdersSkipped, 0, 'nothing in the fixture is dataless');
    t.diagnostic(`real module on ${total} entries: native ${stats.entriesPerSecond} entries/s (cpu ${stats.cpuSeconds?.toFixed(4)} s) vs walker ${buildScanStats(legacy).entriesPerSecond} entries/s`);
  } finally {
    await updateSettings({ engine: 'auto' });
    await unlockAndRemove(root, locked);
  }
});

test('real module: pausing a native scan stops `scanned` within 200 ms, and resuming finishes it with every entry counted', async (t) => {
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

test('real module: cancel releases the handle — take throws the cancellation, and a second take says the handle is unknown', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root } = await buildWideTree(200, 50, 'treemap-native-cancel-real-');
  try {
    const h = real.core.scanStart(root, { neverDescend: [], wantAtime: true });
    real.core.scanCancel(h);
    const t0 = Date.now();
    while (!real.core.scanPoll(h).done) {
      assert.ok(Date.now() - t0 < 1_000, 'the cancelled walk never reported done within a second');
      await sleep(5);
    }
    assert.throws(() => real.core.scanTake(h), /cancelled/, 'a take once done throws the cancellation, and that frees the handle');
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

test('real module: scanTake never blocks — a walk still running is refused and kept, the done walk hands over its columns, and a second take says the handle is unknown', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total } = await buildWideTree(200, 50, 'treemap-native-take-real-');
  try {
    // In a child process: the behaviour this replaces was a synchronous join
    // of the driver thread on the caller's thread, which on a paused walk
    // never returns and no JavaScript timer can interrupt. A take that blocks
    // is therefore a child killed at the timeout and a failed assertion here,
    // never a hung test run. Only the pause holds the walk; a 10 000-entry
    // fixture on one worker is far from done when the pause lands.
    const script = `
      const m = require(process.env.TM_MODULE);
      const out = {};
      const h = m.scanStart(process.env.TM_ROOT, { neverDescend: [], wantAtime: false, maxWorkers: 1 });
      m.scanPause(h);
      out.doneAfterPause = m.scanPoll(h).done;
      try { m.scanTake(h); out.pausedTake = 'returned columns'; } catch (e) { out.pausedTake = e.message; }
      out.doneAfterRefusal = m.scanPoll(h).done;
      m.scanResume(h);
      const until = Date.now() + 20_000;
      const nap = new Int32Array(new SharedArrayBuffer(4));
      while (!m.scanPoll(h).done && Date.now() < until) Atomics.wait(nap, 0, 0, 5);
      out.entries = m.scanTake(h).parent.length;
      try { m.scanTake(h); out.secondTake = 'returned columns'; } catch (e) { out.secondTake = e.message; }
      console.log(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TM_MODULE: real.path, TM_ROOT: root } });
    assert.equal(r.status, 0, `the child did not finish (status ${r.status}, signal ${r.signal}): a take of a running walk blocked instead of refusing\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { doneAfterPause: boolean; pausedTake: string; doneAfterRefusal: boolean; entries: number; secondTake: string };
    assert.equal(out.doneAfterPause, false, 'the pause landed before the walk was done, so the pause is what held it');
    assert.equal(out.pausedTake, STILL_RUNNING);
    assert.equal(out.doneAfterRefusal, false, 'the refusal kept the handle: a poll still answers for it');
    assert.equal(out.entries, total, 'resumed, polled to done, taken: every entry');
    assert.match(out.secondTake, /no scan handle/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('real module: the walk result is columns, not copies — typed arrays of the declared kinds with one root and parent < child', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { root, total } = await buildWideTree(5, 4, 'treemap-native-columns-real-');
  try {
    const h = real.core.scanStart(root, { neverDescend: neverDescendPaths(), wantAtime: false });
    let progress = real.core.scanPoll(h);
    while (!progress.done) {
      await sleep(5);
      progress = real.core.scanPoll(h);
    }
    assert.ok(Number.isInteger(progress.heartbeat) && progress.heartbeat >= 1, `heartbeat ${progress.heartbeat}: a walk that listed six directories had at least one batch answered`);
    const cols = real.core.scanTake(h);
    assert.ok(cols.parent instanceof Uint32Array && cols.nameOff instanceof Uint32Array && cols.names instanceof Uint8Array);
    assert.ok(cols.kind instanceof Uint8Array && cols.flags instanceof Uint8Array);
    assert.ok(cols.size instanceof Float64Array && cols.allocBytes instanceof Float64Array && cols.mtimeMs instanceof Float64Array && cols.atimeMs instanceof Float64Array);
    assert.ok(cols.hardlinkNode instanceof Uint32Array && cols.hardlinkFamily instanceof Uint32Array);
    assert.ok(cols.refusalNode instanceof Uint32Array && cols.refusalWhy instanceof Uint8Array);
    assert.equal(cols.parent.length, total);
    assert.equal(cols.nameOff.length, total + 1);
    for (let i = 1; i < total; i++) assert.ok(cols.parent[i] < i, `parent[${i}] = ${cols.parent[i]}`);
    assert.equal(cols.kind[0], KIND_DIR);
    assert.ok(Number.isNaN(cols.atimeMs[1]), 'atime not asked for is NaN');
    assert.equal(cols.stats.fastPath, NATIVE_FAST_PATH);
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
