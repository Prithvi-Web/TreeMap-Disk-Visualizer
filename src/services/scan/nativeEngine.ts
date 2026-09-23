import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MftExpected, MftLiveCheck, NativeProbe, NativeProgress, ScanStartOptions, WalkResult } from '../../../native/index';
import { loadNative, nativeScanModule, type ScanModule } from './native';
import { MFT_FLUSH_MARGIN_MS, crossCheckMft } from './mftCrossCheck';
import { elevationRefusal, unpackedPath } from './mftHelperPath';
import { mftPromptBlocked, mftPromptEnded, mftPromptStarted, resetMftPromptForTests } from './mftPrompt';
import { statToInput } from './nodeInput';
import { Flag, ScanStore, joinPath } from '../scanStore';
import { cloudProviderFor } from '../cloudFolders';
import { noteRefused } from '../scanRefusals';
import { neverDescendPaths } from '../../utils/mountBoundaries';
import { budgetSnapshot, isScanPaused, registerPausable, unregisterPausable } from '../engineBudget';
import { platform } from '../../platform';
import type { EngineSetting, ScanResult } from '../../models/types';

/**
 * The native engine on the Node side (Phase 3, W2).
 *
 * `tm-walk` lists a directory in one system call and hands the whole tree
 * over as columns in discovery order (index 0 is the root, `parent[i] < i`).
 * This module decides whether a scan may use it (`nativeEligibility`, a pure
 * table), drives a walk at the SSE cadence (`runNativeWalk`: start → poll →
 * take, honouring cancel and the Phase 2 pause gate), and ingests the columns
 * into the same `PackedScanStore` every engine writes today through the same
 * `statToInput` (`ingestColumns`), so the JSON the app emits is identical by
 * construction and everything downstream is unchanged (decision P3-2).
 *
 * Nothing here guesses: a module that is missing, stale or refuses the root
 * is a sentence in `fallbackReason`, and the legacy chain runs.
 */

/** A regular file, socket, fifo or device: a leaf with its lstat size. */
export const KIND_FILE = 0;
/** A directory. */
export const KIND_DIR = 1;
/** A symbolic link: never followed; its size is the length of the target text. */
export const KIND_SYMLINK = 2;
/** The object's data is not local (macOS `SF_DATALESS`, a Windows cloud reparse tag). */
export const FLAG_DATALESS = 1;
/** A directory that could not be listed; the reason is in the refusal columns. */
export const FLAG_REFUSED_DIR = 2;
/** `refusalWhy`: the OS would not let this user list it (EACCES/EPERM). */
export const REFUSAL_DENIED = 1;
/** `refusalWhy`: gone, or no longer a directory, by the time it was listed. */
export const REFUSAL_VANISHED = 2;
/** `refusalWhy`: any other listing error. */
export const REFUSAL_UNREADABLE = 3;
/**
 * How often a native walk is polled once past the first-poll ramp. The poll
 * is how progress crosses to Node (P3-1: polling, never a callback) and also
 * how the walk's end is noticed, so it is short: at 100 ms a finished walk
 * sat unnoticed 20-40 ms on a 200,000-entry scan and ~28 ms on a 100 ms one
 * (M3, 23 September 2026). A poll is a few atomic reads behind one napi call;
 * the progress stream still reads the record at its own 150 ms.
 */
export const NATIVE_POLL_MS = 10;
/**
 * The first poll interval. A poll is an atomic read, so the loop starts here
 * and doubles up to NATIVE_POLL_MS: a scan of a few dozen entries settles in
 * a couple of milliseconds instead of waiting out a whole cadence.
 */
export const NATIVE_POLL_FIRST_MS = 1;
/**
 * How long the cancel path waits for a cancelled walk to report done before
 * abandoning its handle to the module (see `settle`).
 */
export const NATIVE_CANCEL_DEADLINE_MS = 5_000;
/**
 * How long a native walk may show nothing new — no entry, no heartbeat, and
 * neither the scan's pause gate nor a governor hold holding it — before it is
 * a stall the legacy chain retries. The same bound as the legacy walker's
 * `READDIR_DEADLINE_MS` per directory (src/services/diskScanner.ts): a dead
 * network mount costs a bounded time, not the whole scan.
 */
export const NATIVE_STALL_MS = 30_000;
/** What `fastPath` says when the native listing was probed and refused (P3-9). */
export const FAST_PATH_UNAVAILABLE = 'unavailable';
/** The scan surface a module must export to walk a folder. */
export { SCAN_FUNCTIONS, nativeScanModule } from './native';
export type { ScanModule, ScanModuleOutcome } from './native';

/**
 * Does `allocBytes` mean anything here? On Windows libuv leaves `blocks` at
 * zero for every file and the legacy walker records no allocation at all, so
 * the native engine must not either or the two would disagree on every file.
 */
const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;

/**
 * Whether a directory's children are emitted byte-sorted by name. The legacy
 * walker lists with `fs.readdir`, and libuv's `scandir` sorts that listing
 * with `strcmp` on every platform but Windows, where it keeps the file
 * system's own order — which is also what the native listing gives there.
 */
const SORT_CHILDREN = platform().platform !== 'windows';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------ eligibility ------------------------------ */

/** Everything the eligibility table needs, gathered by the caller. */
export interface EligibilityInput {
  /** An incremental rescan: the mtime cache it reuses belongs to the walker until Phase 4. */
  incremental: boolean;
  /** "Don't scan" patterns in force: the glob dialect lives in the walker. */
  ignoreCount: number;
  /** The Scan engine setting. */
  forced: EngineSetting;
  /** A single-file root needs no listing at all. */
  rootIsDir: boolean;
  /** The module as loaded, with the root probed; or why it is not loaded. */
  native: { available: true; probe: NativeProbe } | { available: false; reason: string };
}

export type Eligibility =
  /** The native engine runs, listing through `fastPath`; `reason` is the sentence the stats carry. */
  | { ok: true; fastPath: string; reason: string }
  /**
   * It does not. `fallback` is true when the engine was wanted and something
   * failed (the module, the probe) — that is a `fallbackReason` — and false
   * when a rule or the setting sent the scan elsewhere, which is a choice.
   * `probeRefused` is the case where the stats say `fastPath: 'unavailable'`.
   */
  | { ok: false; reason: string; fallback: boolean; probeRefused: boolean };

/** The rules that keep a scan off the native engine before any module is consulted, or null. Pure. */
export function nativeRule(input: Omit<EligibilityInput, 'native'>): string | null {
  if (input.forced === 'gdu') return 'the Scan engine setting asks for gdu';
  if (input.forced === 'walker') return 'the Scan engine setting asks for the built-in walker';
  const asked = input.forced === 'native' ? 'the Scan engine setting asks for the native engine, but ' : '';
  if (!input.rootIsDir) return `${asked}the root is a single file, which the built-in walker records without a listing`;
  if (input.incremental) return `${asked}this is an incremental rescan, and the mtime cache it reuses belongs to the built-in walker`;
  if (input.ignoreCount > 0) {
    const n = input.ignoreCount;
    return `${asked}the scan has ${n} "don't scan" pattern${n === 1 ? '' : 's'}, and the glob dialect that honours them lives in the built-in walker`;
  }
  return null;
}

/**
 * Whether `rootPath` may be walked by the native engine (decision P3-4): the
 * rules first, then the module, then the probe of the root. Pure — every
 * fact arrives in `input` — and every answer is a sentence.
 */
export function nativeEligibility(rootPath: string, input: EligibilityInput): Eligibility {
  const rule = nativeRule(input);
  if (rule !== null) return { ok: false, reason: rule, fallback: false, probeRefused: false };
  // A forced setting that could not be honoured says so, as the rules above
  // and gdu's fallback do: the stats must show the setting was not ignored.
  const asked = input.forced === 'native' ? 'the Scan engine setting asks for the native engine, but ' : '';
  if (!input.native.available) {
    return { ok: false, reason: `${asked}the native module is not loaded: ${input.native.reason}`, fallback: true, probeRefused: false };
  }
  const probe = input.native.probe;
  if (probe.fastPath === FAST_PATH_UNAVAILABLE) {
    return { ok: false, reason: `${asked}the native listing is unavailable for ${rootPath}: ${probe.reason}`, fallback: true, probeRefused: true };
  }
  const chosen = input.forced === 'native'
    ? 'the native engine was chosen by the Scan engine setting'
    : 'the native engine was chosen: this build has it';
  return { ok: true, fastPath: probe.fastPath, reason: `${chosen}, and ${probe.reason}` };
}

export interface NativeDecision {
  eligibility: Eligibility;
  /** The module to walk with, only when eligible. */
  module: ScanModule | null;
}

/**
 * The eligibility table with the facts gathered: the rules cost nothing and
 * come first, so a scan the setting sends elsewhere never loads a module or
 * pays for a probe; then the loader; then one probe of the root.
 */
export function decideNative(rootPath: string, pre: Omit<EligibilityInput, 'native'>): NativeDecision {
  const rule = nativeRule(pre);
  if (rule !== null) return { eligibility: { ok: false, reason: rule, fallback: false, probeRefused: false }, module: null };
  const surface = nativeScanModule();
  if (!surface.available) return { eligibility: nativeEligibility(rootPath, { ...pre, native: surface }), module: null };
  let probe: NativeProbe;
  try {
    probe = surface.module.scanProbe(rootPath);
  } catch (err: unknown) {
    probe = { fastPath: FAST_PATH_UNAVAILABLE, reason: `the probe of the root failed: ${describe(err)}` };
  }
  const eligibility = nativeEligibility(rootPath, { ...pre, native: { available: true, probe } });
  return { eligibility, module: eligibility.ok ? surface.module : null };
}

/* ------------------------------ ingest ------------------------------ */

/**
 * Build the walk's columns into `store` with the legacy walker's exact
 * semantics, node by node in discovery order (so every parent's store id is
 * known before its children arrive, and a directory's children keep the
 * listing order):
 *
 *  - every node goes through `statToInput` (hidden, extension, container,
 *    `Math.round` of the times, atime omitted unless above zero);
 *  - a symlink is a leaf with `isSymlink` and no sparse or cloud check, as in
 *    the walker (a link's size against zero blocks looks fully sparse);
 *  - cloud placeholder = size above zero, nothing allocated, AND a path under
 *    a known cloud folder — the path is built only for those entries;
 *  - each directory's children are emitted in the walker's order: libuv's
 *    `scandir` sorts a readdir listing with `strcmp` on every platform but
 *    Windows, so the walker's children are byte-sorted by name. The native
 *    listers sort the same way before the walk numbers their entries
 *    (tm-walk's `Listing::sort_by_name`), so off Windows the columns arrive
 *    in that order already; the ingest sorts again — one pass over sorted
 *    input — which keeps a module built before the listers sorted right. The
 *    JSON and the hard-link choice below agree with the walker by
 *    construction;
 *  - hard links are keyed by the family number the walk gave each
 *    (`hardlinkFamily`: files told apart by their exact ids), in that order:
 *    the first name seen keeps the bytes, every later one is a duplicate
 *    with size 0 and the
 *    `hardlinkedFiles/Bytes` tallies (the walker's own choice within a
 *    directory; across directories both engines' choice is a race, which the
 *    equivalence digest normalises, decision P3-8);
 *  - the signed allocation delta (allocated − claimed) feeds `sparseFiles/
 *    Bytes` when negative and `slackBytes` when positive, gated on the
 *    platform's blocks meaning anything, and skipped for a duplicate or a
 *    placeholder whose bytes another line already takes off;
 *  - a child named `.git` sets `GitRepo` on its parent;
 *  - refusals become `deniedDirs` (with the five smallest paths as
 *    examples), `vanishedDirs` or `unreadableDirs`; the walk's per-entry
 *    refusals become `deniedEntries`/`unreadableEntries`.
 *
 * The root (index 0) is the store's own root: its facts from the walk replace
 * the caller's, and `walkedDirs` counts every directory the walk visited
 * (listed or refused), as the walker counts them.
 */
export function ingestColumns(scan: ScanResult, store: ScanStore, cols: WalkResult, rootPath: string): void {
  const n = cols.parent.length;
  const names = Buffer.from(cols.names.buffer, cols.names.byteOffset, cols.names.byteLength);
  const off = cols.nameOff;
  const ids = new Int32Array(n);
  ids[0] = store.rootId;
  const pathOf = columnPathOf(cols, rootPath, store.sep);

  const rootMtime = cols.mtimeMs[0];
  if (Number.isFinite(rootMtime)) store.setModifiedAt(store.rootId, Math.round(rootMtime));
  const rootAtime = cols.atimeMs[0];
  store.setAccessedAt(store.rootId, rootAtime > 0 ? Math.round(rootAtime) : undefined);

  // Pass one: each directory's children, in the listing's own order. Ids from
  // several workers interleave, so a directory's children are not contiguous
  // in the columns — but every parent precedes its children.
  const firstChild = new Int32Array(n).fill(-1);
  const lastChild = new Int32Array(n).fill(-1);
  const nextSibling = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    const p = cols.parent[i];
    if (firstChild[p] === -1) firstChild[p] = i;
    else nextSibling[lastChild[p]] = i;
    lastChild[p] = i;
  }
  /** `strcmp` on the UTF-8 name bytes: the order libuv gives a readdir listing. */
  const byNameBytes = (a: number, b: number): number => {
    let i = off[a];
    let j = off[b];
    const iEnd = off[a + 1];
    const jEnd = off[b + 1];
    while (i < iEnd && j < jEnd) {
      const d = names[i] - names[j];
      if (d !== 0) return d;
      i++;
      j++;
    }
    return (iEnd - off[a]) - (jEnd - off[b]);
  };
  // Each node's hard-link record, or -1: one typed-array read per file where
  // a Map lookup cost 5 of the ingest's 64 ms on enum200k (M3, 23 Sep 2026).
  const linkOf = new Int32Array(n).fill(-1);
  for (let k = 0; k < cols.hardlinkNode.length; k++) linkOf[cols.hardlinkNode[k]] = k;
  // Hard-link families seen so far, by the number the walk gave each: the
  // walk tells files apart by their exact ids, which never cross as doubles
  // (a Windows id past 2^53 rounds into its neighbour: the pre-landing review
  // of 23 Sep 2026).
  const seen = new Set<number>();
  let dirs = 1;
  let files = 0;

  // Pass two: breadth-first from the root, a directory's children in the
  // walker's order, so every parent's store id is known before its children
  // arrive and the store keeps that order.
  const queue: number[] = [0];
  for (let head = 0; head < queue.length; head++) {
    const dir = queue[head];
    const kids: number[] = [];
    for (let c = firstChild[dir]; c !== -1; c = nextSibling[c]) kids.push(c);
    if (SORT_CHILDREN) kids.sort(byNameBytes);
    const parentId = ids[dir];
    for (const i of kids) {
      const name = names.toString('utf8', off[i], off[i + 1]);
      const kind = cols.kind[i];
      const isDir = kind === KIND_DIR;
      const mtime = cols.mtimeMs[i];
      const input = statToInput(name, isDir, cols.size[i], Number.isFinite(mtime) ? mtime : 0, cols.atimeMs[i]);
      let allocDelta = 0;
      let family: number | undefined;
      if (kind === KIND_SYMLINK) {
        input.isSymlink = true;
      } else if (!isDir) {
        const alloc = cols.allocBytes[i];
        if (input.size > 0 && alloc === 0) {
          const provider = cloudProviderFor(pathOf(i));
          if (provider) {
            input.cloudPlaceholder = true;
            input.cloudProvider = provider;
          }
        }
        allocDelta = BLOCKS_ARE_MEANINGFUL && input.size > 0 ? alloc - input.size : 0;
        const link = linkOf[i];
        if (link !== -1) family = cols.hardlinkFamily[link];
      }
      if (family !== undefined) {
        if (seen.has(family)) {
          input.hardlinkDuplicate = true;
          scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + 1;
          scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + input.size;
          input.size = 0; // the first name seen already counted
        } else {
          seen.add(family);
        }
      }
      if (input.cloudPlaceholder) {
        scan.cloudFiles = (scan.cloudFiles ?? 0) + 1;
        scan.cloudBytes = (scan.cloudBytes ?? 0) + input.size;
      }
      if (allocDelta !== 0 && !input.hardlinkDuplicate && !input.cloudPlaceholder) {
        if (allocDelta < 0) {
          scan.sparseFiles = (scan.sparseFiles ?? 0) + 1;
          scan.sparseBytes = (scan.sparseBytes ?? 0) - allocDelta;
        } else {
          scan.slackBytes = (scan.slackBytes ?? 0) + allocDelta;
        }
      }
      if (isDir && name === '.git') store.setFlag(parentId, Flag.GitRepo, true);
      ids[i] = store.addNode(parentId, input);
      if (isDir) {
        dirs++;
        queue.push(i);
      } else {
        files++;
      }
    }
  }

  const refusalNode = cols.refusalNode;
  const refusalWhy = cols.refusalWhy;
  for (let r = 0; r < refusalNode.length; r++) {
    const why = refusalWhy[r];
    if (why === REFUSAL_DENIED) noteRefused(scan, pathOf(refusalNode[r]));
    else if (why === REFUSAL_VANISHED) scan.vanishedDirs = (scan.vanishedDirs ?? 0) + 1;
    else scan.unreadableDirs = (scan.unreadableDirs ?? 0) + 1;
  }
  scan.deniedEntries = cols.stats.deniedEntries;
  scan.unreadableEntries = cols.stats.unreadableEntries;
  scan.walkedDirs = cols.stats.dirsListed + refusalNode.length;
  scan.cachedDirs = 0;
  scan.placeholdersSkipped = cols.stats.dataless;
  scan.scanned = n;
  scan.dirCount = dirs;
  scan.fileCount = files;
}

/* ------------------------------ the walk ------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A native refusal as the error the scanner already understands: tm-node
 * prefixes a root refusal with Node's own errno spelling (`ENOENT: …`), so
 * the scan's error path turns it into the sentence every engine uses.
 */
function withErrno(err: unknown, rootPath: string): Error {
  const message = describe(err);
  const e = err instanceof Error ? err : new Error(message);
  const m = /^(E[A-Z]+): /.exec(message);
  if (m) Object.assign(e, { code: m[1], path: rootPath });
  return e;
}

/** The deadlines the walk loop reads and the clock it reads them by. */
interface WalkTiming {
  cancelDeadlineMs: number;
  stallMs: number;
  now: () => number;
}

const WALL_CLOCK: WalkTiming = { cancelDeadlineMs: NATIVE_CANCEL_DEADLINE_MS, stallMs: NATIVE_STALL_MS, now: () => Date.now() };
let timing: WalkTiming = WALL_CLOCK;

/** Test-only: shorter deadlines and a clock of the test's own; null restores the constants and the wall clock. */
export function setNativeWalkTimingForTests(over: Partial<WalkTiming> | null): void {
  timing = over ? { ...WALL_CLOCK, ...over } : WALL_CLOCK;
}

/**
 * Whether the governor is holding every worker in its throttle — critical
 * heat, or a caller's `governorPause()` — which the walk's workers obey too.
 * Read only when a poll showed nothing new, so the common case never asks.
 */
function governorHeld(): boolean {
  return budgetSnapshot().snapshot?.paused === true;
}

/**
 * End a walk and free its handle without ever blocking on it: cancel, poll
 * until the walk reports done, then take it — the cancellation the take
 * throws is the point, the refusal is what frees the handle.
 *
 * A walk that has not reported done by NATIVE_CANCEL_DEADLINE_MS is
 * abandoned. A worker wedged inside a directory-listing syscall (a dead SMB,
 * NFS or FUSE mount) cannot be interrupted from user space, and a take of a
 * walk still running would join its driver thread on this — Node's main —
 * thread, freezing the whole app for as long as the kernel holds the worker.
 * So the thread is abandoned in the module rather than the app frozen: the
 * slot stays in the module's table, with its threads, for the life of the
 * process, and the app goes on without it.
 *
 * Nothing here throws. An unknown handle (already taken, or never started)
 * has nothing to free, and the caller's own outcome — a cancel, a stall, an
 * error mid-walk — is the one that matters.
 */
async function settle(mod: ScanModule, handle: number): Promise<void> {
  try {
    mod.scanCancel(handle);
  } catch {
    return; // an unknown handle: nothing to free
  }
  const t0 = timing.now();
  let interval = NATIVE_POLL_FIRST_MS;
  for (;;) {
    let done: boolean;
    try {
      done = mod.scanPoll(handle).done;
    } catch {
      return; // the handle is gone meanwhile: nothing to free
    }
    if (done) break;
    if (timing.now() - t0 >= timing.cancelDeadlineMs) {
      console.warn(`[treemap] the native walk did not answer a cancel within ${timing.cancelDeadlineMs / 1000} s; its handle and threads are left to the module`);
      return;
    }
    await sleep(interval);
    interval = Math.min(NATIVE_POLL_MS, interval * 2);
  }
  try {
    mod.scanTake(handle);
  } catch {
    /* a cancelled or failed walk refuses to be taken — and is freed by the refusal */
  }
}

/**
 * Walk `rootPath` with the native engine into `store` (whose root the caller
 * created): start, then poll — from NATIVE_POLL_FIRST_MS doubling up to
 * NATIVE_POLL_MS — updating `scan.scanned` and
 * `scan.currentPath`, honouring `scan.cancelled` (the walk is cancelled and
 * its handle settled, see `settle`) and the Phase 2 pause gate (the scan's
 * `Pausable` pauses the handle the instant the gate closes, and the poll
 * loop re-checks the gate, so neither path can be missed), then take the
 * columns, ingest them, finalize and sum. `scan.cpuSeconds` is the walk's
 * own thread CPU plus the ingest's `process.cpuUsage()` delta, or null where
 * the walk could not measure its own (a platform without a thread clock) —
 * never a zero standing in for "unknown", though a coarse clock (Windows
 * counts 15.6 ms ticks) can measure a very short walk as 0.
 *
 * Throws what the walk threw: a root refusal carries Node's errno code so the
 * caller can tell the scan's own failure from one the legacy chain should
 * retry. A walk that shows nothing new for NATIVE_STALL_MS — no entry, no
 * heartbeat, no pause holding it — is settled and thrown as a stall, which
 * the caller turns into a fallback. A module that throws mid-walk has its
 * handle settled first, so nothing is leaked behind the error.
 */
export async function runNativeWalk(scan: ScanResult, store: ScanStore, rootPath: string, module?: ScanModule): Promise<void> {
  const mod = module ?? mustScanModule();
  const handle = mod.scanStart(rootPath, { neverDescend: neverDescendPaths(), wantAtime: true });
  let nativePaused = false;
  const setPaused = (want: boolean): void => {
    if (want === nativePaused) return;
    nativePaused = want;
    if (want) mod.scanPause(handle);
    else mod.scanResume(handle);
  };
  let settled = false;
  const settleOnce = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await settle(mod, handle);
  };
  registerPausable(scan.scanId, { pause: () => setPaused(true), resume: () => setPaused(false) });
  // When the walk last showed something new. `entries` counts a directory
  // only once its listing completes, so one huge directory would look stalled
  // for the length of its listing; `heartbeat` — batches the OS has answered,
  // across every worker — advances through it. A walk the scan's pause gate
  // or a governor hold (critical heat, governorPause) is holding is not
  // stalled: it was told to wait.
  let lastProgressAt = timing.now();
  let lastEntries = -1;
  let lastHeartbeat = -1;
  try {
    let interval = NATIVE_POLL_FIRST_MS;
    for (;;) {
      if (scan.cancelled) {
        await settleOnce();
        return;
      }
      const paused = isScanPaused(scan.scanId);
      setPaused(paused);
      const progress = mod.scanPoll(handle);
      scan.scanned = 1 + progress.entries;
      if (progress.currentPath) scan.currentPath = progress.currentPath;
      if (progress.done) break;
      const now = timing.now();
      const moved = progress.entries !== lastEntries || progress.heartbeat !== lastHeartbeat;
      lastEntries = progress.entries;
      lastHeartbeat = progress.heartbeat;
      if (moved || paused || nativePaused || governorHeld()) lastProgressAt = now;
      if (now - lastProgressAt > timing.stallMs) {
        // The same net as the legacy walker's READDIR_DEADLINE_MS: a wedged
        // mount is a bounded cost and a fallback, not a scan that never ends.
        await settleOnce();
        throw new Error(`the native walk made no progress for ${timing.stallMs / 1000} s at ${scan.currentPath ?? rootPath}`);
      }
      await sleep(interval);
      interval = Math.min(NATIVE_POLL_MS, interval * 2);
    }
  } catch (err: unknown) {
    // A module that threw mid-walk (a poll, a pause, a resume) still holds a
    // handle with threads behind it: settle it before the error propagates.
    await settleOnce();
    throw err;
  } finally {
    unregisterPausable(scan.scanId);
  }
  if (scan.cancelled) {
    await settleOnce();
    return;
  }
  let cols: WalkResult;
  try {
    cols = mod.scanTake(handle);
  } catch (err: unknown) {
    throw withErrno(err, rootPath);
  }
  const cpuBefore = process.cpuUsage();
  ingestColumns(scan, store, cols, rootPath);
  store.finalize();
  store.sumSizes();
  const ingest = process.cpuUsage(cpuBefore);
  const walkCpu = cols.stats.cpuSeconds;
  scan.cpuSeconds = typeof walkCpu === 'number' && Number.isFinite(walkCpu)
    ? walkCpu + (ingest.user + ingest.system) / 1e6
    : null;
  scan.currentPath = rootPath;
}

function mustScanModule(): ScanModule {
  const surface = nativeScanModule();
  if (!surface.available) throw new Error(surface.reason);
  return surface.module;
}

/** The name a store's root takes: the last path component, or the whole path when there is none (`/`). */
export function rootName(rootPath: string): string {
  return path.basename(rootPath) || rootPath;
}

/* ------------------------------ the Windows MFT turbo mode (W6, M6) ------------------------------ */

/**
 * The app's temp folder under the OS temp folder: the one place
 * `tm-mft-helper` writes. The helper resolves the same folder for itself
 * (its `APP_TEMP_FOLDER`) and refuses an output anywhere else (W6-2).
 */
export const MFT_TEMP_FOLDER = 'TreeMap-mft';
/** The elevated helper's file name. */
export const MFT_HELPER_FILE = 'tm-mft-helper.exe';
/**
 * W6-9: CI proves the reader on a real volume (M5), but no CI can answer a
 * UAC prompt, so nothing proves the elevation end to end. Every scan through
 * the mode says so, used or not, until something does.
 */
export const MFT_NOT_VERIFIED = 'not verified on this build';
const MFT_LABEL = `${MFT_NOT_VERIFIED}: no test has run its elevation prompt end to end`;

/** What the launcher (electron/mft.js) reports. */
export type MftLaunchOutcome =
  /** The helper ran elevated and exited with `code` (0: columns written; 2: refused, the reason in the file). */
  | { kind: 'exited'; code: number }
  /** The user said no — to the app's sentence or to Windows' prompt. A choice, never an error (W6-1). */
  | { kind: 'declined'; reason: string }
  /** The launch itself failed. */
  | { kind: 'failed'; reason: string };
export interface MftLaunchRequest { helperPath: string; volume: string; root: string; output: string }
/** Asks for elevation and runs the helper once: Electron's main process registers one (`setMftLauncher`). */
export type MftLauncher = (request: MftLaunchRequest) => Promise<MftLaunchOutcome>;
/** The part of tm-node the mode uses. */
export interface MftModule {
  mftTake(path: string): WalkResult;
  mftCrossCheck(paths: string[], expected: MftExpected[]): MftLiveCheck[];
  /** The helper's checks that need no administrator; absent from a module built before it existed. */
  mftPrecheck?(root: string): string | null;
}
/** Seams for tests; the app passes none. */
export interface MftDeps {
  launcher?: MftLauncher | null;
  module?: MftModule | null;
  helperPath?: string | null;
  /** Why a program must not be started as administrator, or null (mftHelperPath.ts). */
  elevationRefusal?: (file: string) => string | null;
  tempFolder?: string;
  now?: () => number;
  random?: () => number;
}
export type MftOutcome =
  /** The store holds the tree, finalized and summed; `reason` is the stats' `engineReason`. */
  | { used: true; reason: string }
  /** Fall back to the listing walk. `failed` makes `reason` a `fallbackReason` too; a decline or a rule is a choice. */
  | { used: false; reason: string; failed: boolean };

let mftLauncher: MftLauncher | null = null;

/** Electron's main process registers the elevation launcher here (Windows only); null removes it. */
export function setMftLauncher(launcher: MftLauncher | null): void {
  mftLauncher = launcher;
}

/** Volumes the cross-check found a divergence on this session, with the sentence (W6-8). */
const mftSwitchedOff = new Map<string, string>();

/** Test-only: forget the session's divergences, and any prompt or decline. */
export function resetMftSessionForTests(): void {
  mftSwitchedOff.clear();
  resetMftPromptForTests();
}

/** Whether the mode can be offered on `p`: Windows only. */
export function mftOfferedOn(p: NodeJS.Platform = process.platform): boolean {
  return p === 'win32';
}

/** The drive a root is on (`C:`), or null for a root without one (a UNC path). */
export function driveOf(rootPath: string): string | null {
  const m = /^([A-Za-z]):[\\/]/.exec(rootPath);
  return m ? `${m[1].toUpperCase()}:` : null;
}

/**
 * Where the helper may be: beside the prebuilt module (build-native installs
 * it there on Windows), or in a packaged app's resources. Each as a path
 * Windows can start: in a packaged app the first runs through `app.asar`,
 * which only Electron's own `fs` sees into, so it is read under
 * `app.asar.unpacked`, where the release unpacks `native/prebuilt`
 * (`unpackedPath`). `appRoot` and `resources` are seams for tests.
 */
export function mftHelperCandidates(
  appRoot: string = path.join(__dirname, '..', '..', '..'),
  resources: string | undefined = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
): string[] {
  const out = [unpackedPath(path.join(appRoot, 'native', 'prebuilt', `${process.platform}-${process.arch}`, MFT_HELPER_FILE))];
  if (resources) out.push(path.join(resources, 'native', MFT_HELPER_FILE));
  return out;
}

/**
 * Windows' system folder as the kernel reports it, through the native module
 * (`systemDirectory`), or null: off Windows, without the module, or with one
 * built before it had the call. main.js starts PowerShell from it by its full
 * path (electron/mft.js).
 */
export function windowsSystemDirectory(): string | null {
  const outcome = loadNative();
  if (!outcome.available) return null;
  const call = (outcome.module as { systemDirectory?: () => string | null }).systemDirectory;
  return typeof call === 'function' ? call() : null;
}

/** The loaded module's MFT surface, or why there is none. */
function mftModuleOrReason(): MftModule | string {
  const outcome = loadNative();
  if (!outcome.available) return `the native module is not loaded: ${outcome.reason}`;
  const mod = outcome.module;
  const missing = (['mftTake', 'mftCrossCheck'] as const).filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    const named = missing.map((name) => `${name}()`).join(' or ');
    return `the native module at ${outcome.path} has no ${named}, so it cannot read or check the helper's result; rebuild it with npm run build:native`;
  }
  return mod as unknown as MftModule;
}

/**
 * Node `i`'s full path, built on demand from the parent chain and remembered
 * with its parent's (for the parent's other children). A table can be as deep
 * as a path is long — about 16,000 levels on NTFS — so the climb is a loop
 * (the check's copy of this once called itself per level and ran out of
 * stack) and the chain is joined once: a path built for every level on the
 * way costs the square of the depth, which at 100,000 levels ran Node out of
 * memory (the pre-landing review of 23 Sep 2026). The ingest and the MFT
 * cross-check share it. Every parent precedes its child (the walk's
 * contract, and `mftTake`'s check), so the climb ends at the root; a column
 * that breaks that is refused rather than climbed forever.
 */
export function columnPathOf(cols: WalkResult, rootPath: string, sep: string): (i: number) => string {
  const n = cols.parent.length;
  const names = Buffer.from(cols.names.buffer, cols.names.byteOffset, cols.names.byteLength);
  const off = cols.nameOff;
  const paths: (string | undefined)[] = new Array<string | undefined>(n);
  paths[0] = rootPath;
  return (i: number): string => {
    const known = paths[i];
    if (known !== undefined) return known;
    const chain: number[] = [];
    let k = i;
    while (paths[k] === undefined) {
      if (chain.length >= n) throw new Error(`node ${i}'s parent chain never reaches the root`);
      chain.push(k);
      k = cols.parent[k];
    }
    // Only the known ancestor can end in the separator (a root such as "/"
    // or "C:\"); names never hold one, so the rest joins in one go.
    const parts = new Array<string>(chain.length);
    for (let c = 0; c < chain.length; c++) parts[chain.length - 1 - c] = names.toString('utf8', off[chain[c]], off[chain[c] + 1]);
    const p = joinPath(paths[k] as string, sep, parts.join(sep));
    paths[i] = p;
    if (chain.length > 1) paths[cols.parent[i]] = p.slice(0, p.length - parts[parts.length - 1].length - sep.length);
    return p;
  };
}

/**
 * The folder the app's temp folder for the helper lives in, worked out the
 * way the helper works out its own: Rust's `std::env::temp_dir()`, which on
 * Windows is GetTempPath2 — TMP, then TEMP, then USERPROFILE. Node's
 * os.tmpdir() reads TEMP first, so where TMP and TEMP differ the two named
 * different folders, the helper refused the app's output as outside its own,
 * and every scan asked again for nothing (the pre-landing review of 23 Sep
 * 2026). Elsewhere, and with none of the three set, the OS temp folder.
 */
export function helperTempRoot(env: NodeJS.ProcessEnv = process.env, onWindows = process.platform === 'win32'): string {
  if (onWindows) {
    for (const name of ['TMP', 'TEMP', 'USERPROFILE'] as const) {
      const value = env[name];
      if (value) return value;
    }
  }
  return os.tmpdir();
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the app's own temp file; a later scan's sweep (sweepStaleOutputs) removes it once it is old */
  }
}

/**
 * How old a helper output must be before a scan that is not reading it
 * removes it. The helper runs outside the app's process tree, so a TreeMap
 * that quits while it runs leaves its output — every name under the scanned
 * folder — behind; an output a scan reads lives for minutes.
 */
export const MFT_STALE_OUTPUT_MS = 60 * 60 * 1000;
/** tm-mft's `is_output_name`: the only names the helper creates. */
const MFT_OUTPUT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.tmmft$/;
/** The outputs this process's scans are waiting on or reading, never swept. */
const mftOutputsInUse = new Set<string>();

/**
 * Removes the helper outputs in `folder` older than {@link MFT_STALE_OUTPUT_MS}
 * that no scan is using: regular files named as the helper names them, and
 * nothing else — not a link, not another file. Housekeeping: a file that will
 * not go (one another process holds, say) is left for the next scan.
 */
function sweepStaleOutputs(folder: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return; /* checked a moment ago; the next scan sweeps again */
  }
  for (const entry of entries) {
    if (!entry.isFile() || !MFT_OUTPUT_NAME.test(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if (mftOutputsInUse.has(file)) continue;
    try {
      if (now - fs.lstatSync(file).mtimeMs > MFT_STALE_OUTPUT_MS) fs.rmSync(file, { force: true });
    } catch {
      /* gone already, or held open: the next scan sweeps again */
    }
  }
}

/**
 * The MFT turbo mode for one scan (W6): ask for elevation → wait for the
 * helper → `mftTake` → the cross-check → ingest; or say why not.
 *
 * Nothing here throws for the mode's own reasons. A root without a drive
 * letter, a volume already switched off this session, no launcher (the
 * server without the desktop app), a module or helper that is missing, an
 * app temp folder that is a link or a junction, another scan's prompt still
 * open or a decline's quiet period (mftPrompt.ts: rules, not failures), a
 * declined prompt (a choice: `failed: false`, never an error — W6-1), a
 * helper that refused (its sentence, read from its output file, since an
 * elevated process's stderr does not reach the app), and a divergence
 * (W6-8: the volume is switched off for the session, the entry and both
 * values in the reason) all return `used: false`, and the caller lists the
 * folders instead. The helper's output file is removed on every path, and
 * one an earlier run left behind is swept before asking (sweepStaleOutputs).
 */
export async function runMftWalk(scan: ScanResult, store: ScanStore, rootPath: string, deps: MftDeps = {}): Promise<MftOutcome> {
  const notUsed = (why: string, failed: boolean): MftOutcome => ({
    used: false,
    reason: `the NTFS turbo mode (${MFT_LABEL}) was not used: ${why}`,
    failed,
  });
  const volume = driveOf(rootPath);
  if (volume === null) return notUsed('the scan root is not on a drive letter, so there is no NTFS volume to read', false);
  const off = mftSwitchedOff.get(volume);
  if (off !== undefined) return notUsed(`it is off for ${volume} until TreeMap restarts, because ${off}`, true);
  // What goes wrong once the helper was asked for outlives this scan — a
  // PowerShell that cannot start it, a helper that refuses its folder or
  // crashes, a result that will not read, a divergence — so the drive is off
  // until TreeMap restarts rather than asked about again for nothing (the
  // pre-landing review of 23 Sep 2026: it once asked on every scan).
  const switchOff = (why: string): MftOutcome => {
    mftSwitchedOff.set(volume, why);
    return notUsed(`${why}; the mode is off for ${volume} until TreeMap restarts`, true);
  };
  const launcher = deps.launcher === undefined ? mftLauncher : deps.launcher;
  if (!launcher) return notUsed('asking Windows for administrator permission needs the desktop app, and this server runs without it', true);
  const found = deps.module === undefined ? mftModuleOrReason() : (deps.module ?? 'no native module was given');
  if (typeof found === 'string') return notUsed(found, true);
  const mod = found;
  // The helper's own checks that need no administrator (a local drive
  // Windows can type, formatted NTFS), run here first: a drive the elevated
  // helper would only refuse is never the subject of a prompt (the
  // pre-landing review of 23 Sep 2026). A module built before the check
  // existed goes ahead as before.
  const driveRefusal = typeof mod.mftPrecheck === 'function' ? mod.mftPrecheck(rootPath) : null;
  if (driveRefusal !== null) return notUsed(`${driveRefusal}, so nobody was asked`, false);
  const helperPath = deps.helperPath === undefined ? (mftHelperCandidates().find((p) => fs.existsSync(p)) ?? null) : deps.helperPath;
  if (!helperPath) return notUsed(`no ${MFT_HELPER_FILE} ships with this build (looked at ${mftHelperCandidates().join(', ')})`, true);
  // Nothing a program running as the user could change is started as
  // administrator (the third security review of M6): asked before the prompt,
  // so no one is asked for a yes that could not be used. How TreeMap is
  // installed is a rule, not a failure, and the reason says how to fix it.
  const unsafe = (deps.elevationRefusal ?? elevationRefusal)(helperPath);
  if (unsafe) {
    return notUsed(`Windows would start ${helperPath} as administrator, and ${unsafe}; installed for anyone who uses this computer (in Program Files), TreeMap can use it`, false);
  }
  const folder = deps.tempFolder ?? path.join(helperTempRoot(), MFT_TEMP_FOLDER);
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err: unknown) {
    return notUsed(`the app's temp folder ${folder} could not be made: ${describe(err)}`, true);
  }
  // The helper refuses a temp folder that is a link or a junction, which would
  // send its elevated write wherever it points (the security review of M6), so
  // asking first would only raise a prompt whose yes cannot be used. Node sees
  // a Windows junction as a symbolic link; the helper also refuses any other
  // reparse point, which Node cannot see.
  let unfollowed: fs.Stats;
  try {
    unfollowed = fs.lstatSync(folder);
  } catch (err: unknown) {
    return notUsed(`the app's temp folder ${folder} could not be checked: ${describe(err)}`, true);
  }
  if (unfollowed.isSymbolicLink() || !unfollowed.isDirectory()) {
    return notUsed(`the app's temp folder ${folder} is a link, a junction or not a folder, and the elevated helper writes nothing through one`, true);
  }
  const now = deps.now ?? Date.now;
  // An output left by a TreeMap that quit mid-run lists every name under the
  // folder it scanned, and nothing else removes it (the pre-landing review of
  // 23 Sep 2026: the red team). The folder was just proven a real one.
  sweepStaleOutputs(folder, now());
  // A scan cancelled on its way here is not asked about: the prompt would put
  // a question nobody is waiting on, and hold the one prompt slot meanwhile
  // (the TypeScript review of M6).
  if (scan.cancelled) return notUsed('the scan was cancelled', false);
  // Nothing between this check and mftPromptStarted awaits, so two scans
  // cannot both pass it.
  const blocked = mftPromptBlocked(now());
  if (blocked !== null) return notUsed(blocked, false);
  const output = path.join(folder, `${crypto.randomUUID()}.tmmft`);
  // Conservative for correction 9: the read starts no earlier than the launch.
  const readStarted = now();
  try {
    mftOutputsInUse.add(output);
    let launched: MftLaunchOutcome | null = null;
    mftPromptStarted();
    try {
      launched = await launcher({ helperPath, volume, root: rootPath, output });
    } catch (err: unknown) {
      return switchOff(`the helper could not be started: ${describe(err)}`);
    } finally {
      // The prompt is over whatever the clock says: a clock that throws here
      // must not leave it marked open (the TypeScript review of M6).
      let endedAt = Number.NaN;
      try {
        endedAt = now();
      } catch {
        /* no time for a decline: it starts no quiet period (mftPromptEnded) */
      }
      mftPromptEnded(launched?.kind === 'declined', endedAt);
    }
    if (scan.cancelled) return notUsed('the scan was cancelled', false);
    if (launched.kind === 'declined') return notUsed(`${launched.reason}, so the folders were listed instead`, false);
    if (launched.kind === 'failed') return switchOff(`the helper could not be started: ${launched.reason}`);
    if (launched.code !== 0) {
      // With no file, exit 2 is a refusal before the output was made: the
      // helper writes only inside its own temp folder, which is not the one
      // the app named when TMP and TEMP differ or the yes came from another
      // account (an elevated process's error output does not reach the app).
      let why = launched.code === 2
        ? 'the helper refused before writing anything (exit 2, no file): it writes only inside its own temp folder, so TMP and TEMP may name different folders here, or the administrator who said yes is another account, with a temp folder of its own'
        : `the helper exited with code ${launched.code} and left no reason (an elevated process's error output does not reach the app)`;
      if (fs.existsSync(output)) {
        try {
          mod.mftTake(output);
        } catch (err: unknown) {
          why = `the reader refused: ${describe(err)}`;
        }
      }
      return switchOff(why);
    }
    let cols: WalkResult;
    try {
      cols = mod.mftTake(output);
    } catch (err: unknown) {
      return switchOff(`the helper's result could not be read: ${describe(err)}`);
    }
    const verdict = await crossCheckMft(cols, columnPathOf(cols, rootPath, store.sep), readStarted, (p, e) => mod.mftCrossCheck(p, e), deps.random ?? Math.random);
    if (!verdict.ok) {
      return switchOff(verdict.reason);
    }
    // A gate that verified too little must not open (mftCrossCheck.ts,
    // requiredMatches). Every entry written within the margin is also the
    // case where the raw read may be missing creates NTFS had not yet
    // flushed; few openable leaves the table all but unchecked. Not a fault
    // of the reader, so the volume stays on offer for the next scan. The
    // sentence counts what happened, so its numbers add up.
    if (verdict.checked < verdict.required) {
      const ineligible = cols.parent.length - verdict.eligible;
      const margin = `${MFT_FLUSH_MARGIN_MS / 60_000} minutes`;
      return notUsed(
        `the cross-check verified ${verdict.checked} of the ${verdict.required} entries it needs (${verdict.attempts} opened: ${verdict.skipped} could not be opened, ${verdict.recent} had been written since the read; ${ineligible} were not eligible, written within ${margin} of the read or with no time recorded), so the table was not trusted and the folders were listed instead`,
        false,
      );
    }
    const cpuBefore = process.cpuUsage();
    ingestColumns(scan, store, cols, rootPath);
    store.finalize();
    store.sumSizes();
    const ingest = process.cpuUsage(cpuBefore);
    const helperCpu = cols.stats.cpuSeconds;
    scan.cpuSeconds = typeof helperCpu === 'number' && Number.isFinite(helperCpu)
      ? helperCpu + (ingest.user + ingest.system) / 1e6
      : null;
    scan.currentPath = rootPath;
    const aside = [
      verdict.skipped > 0 ? `${verdict.skipped} could not be opened and were replaced` : '',
      verdict.recent > 0 ? `${verdict.recent} had been written since the read and were replaced` : '',
    ].filter(Boolean);
    return {
      used: true,
      reason: `the NTFS turbo mode (${MFT_LABEL}) read ${volume}'s master file table through its elevated helper, and ${verdict.checked} of ${verdict.eligible} eligible entries, opened by the app itself, matched it${aside.length ? ` (${aside.join('; ')})` : ''}`,
    };
  } finally {
    removeQuietly(output);
    mftOutputsInUse.delete(output);
  }
}
