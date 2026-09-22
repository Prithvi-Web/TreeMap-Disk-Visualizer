import path from 'node:path';
import type { NativeProbe, NativeProgress, ScanStartOptions, WalkResult } from '../../../native/index';
import { nativeScanModule, type ScanModule } from './native';
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
/** How often a long native walk is polled — the SSE cadence's order (P3-1). */
export const NATIVE_POLL_MS = 100;
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
 *    Windows, so the walker's children are byte-sorted by name while the
 *    native listing arrives in the file system's own order (APFS's is a hash
 *    order) — the ingest sorts the same way, off Windows, so the JSON and the
 *    hard-link choice below agree with the walker by construction;
 *  - hard links are keyed `${dev}:${ino}` in that order: the first name seen
 *    keeps the bytes, every later one is a duplicate with size 0 and the
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
  const paths: (string | undefined)[] = new Array<string | undefined>(n);
  paths[0] = rootPath;
  const sep = store.sep;
  /** The full path of node `i`, built on demand from the parent chain and remembered. */
  const pathOf = (i: number): string => {
    const known = paths[i];
    if (known !== undefined) return known;
    const chain: number[] = [];
    let k = i;
    while (paths[k] === undefined) {
      chain.push(k);
      k = cols.parent[k];
    }
    let p = paths[k] as string;
    for (let c = chain.length - 1; c >= 0; c--) {
      const node = chain[c];
      p = joinPath(p, sep, names.toString('utf8', off[node], off[node + 1]));
      paths[node] = p;
    }
    return p;
  };

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
  const links = new Map<number, number>();
  for (let k = 0; k < cols.hardlinkNode.length; k++) links.set(cols.hardlinkNode[k], k);
  const seen = new Set<string>();
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
      let inoKey: string | undefined;
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
        const link = links.get(i);
        if (link !== undefined) inoKey = `${cols.hardlinkDev[link]}:${cols.hardlinkIno[link]}`;
      }
      if (inoKey !== undefined) {
        if (seen.has(inoKey)) {
          input.hardlinkDuplicate = true;
          scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + 1;
          scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + input.size;
          input.size = 0; // the first name seen already counted
        } else {
          seen.add(inoKey);
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
 * the walk could not measure its own (a platform without a thread clock),
 * never zero.
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
