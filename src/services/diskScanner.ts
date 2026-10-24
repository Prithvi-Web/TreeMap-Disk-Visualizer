import { promises as fsp, Dirent, Stats } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FileNode, ScanResult, LargeFolder, EmptyFoldersResult, CompareEntry, EffectiveBudgetPreset, EngineSetting } from '../models/types';
import { saveSnapshot } from './snapshots';
import { trackWrite } from '../utils/backgroundWrites';
import { getIgnoreMatchers, getSettings } from './settings';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { readJsonFile, writeFileChunked } from './storage';
import { dropLegacyMtimeCaches } from './legacyMtimeCaches';
import { streamTreeJson } from './scanStoreJson';
import { isEphemeral } from './portableMode';
import { IO_THREADS } from '../utils/ioThreads';
import {
  boundaryRecord,
  DEFAULT_BOUNDARY_RULE,
  mountOutcome,
  neverDescendPaths,
  noteCrossedUnlisted,
  noteSkippedMounts,
  restartBoundaryWalk,
  scanBoundary,
  unknownBoundary,
  type BoundaryRule,
  type ScanBoundaryRecord,
} from '../utils/mountBoundaries';
import { forgetScan } from './containerScanner';
import { abortGduScan, findGduBinary, gduScanIntoStore } from './gduScanner';
import { cloudProviderFor } from './cloudFolders';
import { markUnlisted, markUnlistedPaths, noteRefused, noteUnlistedBelow } from './scanRefusals';
import { JUNK_FILES } from './emptyFolderCheck';
import { AppError, permissionDeniedMessage } from '../middleware/errorHandler';
import { PackedScanStore, ScanStore, Flag, fileNodeToInput, buildStoreFromTree, asStore, TreeSource } from './scanStore';
import { platform } from '../platform';
import { beginScanBudget, forgetScanBudget, isScanPaused, scanBudget, throttleBatch, whenResumed, workerCap } from './engineBudget';
import { statToInput } from './scan/nodeInput';
import { FAST_PATH_UNAVAILABLE, MFT_NOT_VERIFIED, decideNative, ignorePatternClause, mftOfferedOn, nativeRuleCause, rootName, runMftWalk, nativeStorageFor, runNativeWalk, type RuleCause } from './scan/nativeEngine';
import { nativeProjection } from './scan/projection';
import { memoryRoomFor, noRestartRefusal } from './scan/nativeMemory';
import { formatCount } from '../utils/formatCount';
import { newScanStorageMode } from './storageMode';
import { SlicedWalk, SliceOptions, walkInSlices } from './slices';
import { aliasNamespaceOf, canonicalDirOf, isSpillFolderName, isSpillPath, PathRejectedError, sanitizePath } from '../utils/pathSanitizer';
import { meansGone } from '../utils/errno';
import { lastFdaState } from '../utils/fdaState';

/**
 * DiskScanner — asynchronous recursive directory walker.
 *
 * Design:
 *  - A queue of directory nodes is drained by up to CONCURRENCY workers.
 *  - Each worker readdir()s one directory, lstat()s its file entries in
 *    parallel batches, and pushes child directories back on the queue.
 *  - Everything is promise-based, so the event loop is never blocked; the
 *    batch size keeps the number of in-flight fs operations bounded
 *    (back-pressure) instead of fanning out the whole tree at once.
 *  - Directory sizes are summed bottom-up in a single pass at the end.
 *
 * Speed comes from parallelism in libuv's threadpool (sized by ioThreads —
 * the "turbo" engine), so worker count and batch size scale with it: enough
 * in-flight lstats to keep every I/O thread busy, not so many that memory
 * or the event loop suffer.
 */

const CONCURRENCY = Math.min(32, Math.max(8, IO_THREADS));
/** The walker's own label: turbo when the libuv pool is sized above the default 4. */
const WALKER_ENGINE: ScanResult['engine'] = IO_THREADS > 4 ? 'turbo-walker' : 'walker';
/** The walker's listing mechanism, as `fastPath` names it. */
const WALKER_FAST_PATH = 'readdir+lstat';
/** gdu's, likewise. */
const GDU_FAST_PATH = 'gdu';
/** The clause every legacy engine's reason ends with: why `cpuSeconds` is null for it. */
const CPU_NOT_MEASURED = 'CPU seconds are not measured per scan by this engine';
/**
 * The scanning budget caps the workers below CONCURRENCY (Eco: two). The cap
 * is read when the walk starts and again after this many entries, so a
 * budget changed mid-scan shows within about a second of walking.
 */
const CAP_REFRESH_ENTRIES = 1000;
const STAT_BATCH = IO_THREADS > 4 ? 64 : 32;
/** Yield to the event loop after this many entries so SSE stays responsive. */
const YIELD_EVERY = 2000;

/**
 * Does `stat.blocks` mean anything here? Asked once, not per file: on Windows
 * libuv leaves it at zero for every file, and believing that zero would make
 * the whole drive look like it claims space it does not occupy.
 */
const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;

/**
 * A directory that can't answer a listing (dead network mount, wedged
 * permission broker) must cost one worker slot a bounded time — not the whole
 * scan. The orphaned call keeps its libuv slot until the OS lets go, so this
 * is a net for rare pathologies; the mount-boundary skip list keeps the scan
 * from walking into the known ones at all.
 */
const READDIR_DEADLINE_MS = 30_000;

/**
 * Why a listing produced nothing.
 *
 * The distinction is Phase 5's: "denied" is space that exists and this user
 * cannot see, which the accounting statement must name; "vanished" is a race
 * with a delete and accounts for nothing; "timeout" is a wedged mount, which is
 * neither. Collapsing all three into `null`, as this once did, meant the
 * statement had no way to tell a disk it was refused from a disk that is empty.
 */
type ListingFailure = 'denied' | 'vanished' | 'timeout' | 'error';

interface Listing {
  entries: Dirent[] | null;
  why: ListingFailure | null;
}

function readdirWithDeadline(p: string): Promise<Listing> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[treemap] readdir gave up after ${READDIR_DEADLINE_MS / 1000}s: ${p}`);
      resolve({ entries: null, why: 'timeout' });
    }, READDIR_DEADLINE_MS);
    timer.unref();
    fsp.readdir(p, { withFileTypes: true }).then(
      (entries) => {
        clearTimeout(timer);
        resolve({ entries, why: null });
      },
      (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ entries: null, why: classifyFsError(err) });
      },
    );
  });
}

/** Map an fs errno onto the reason the statement reports. */
export function classifyFsError(err: NodeJS.ErrnoException): ListingFailure {
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'denied';
  if (err.code === 'ENOENT') return 'vanished';
  return 'error';
}

/**
 * What the user reads when a scan fails, instead of the disk's own words.
 *
 * The HTTP path already mapped ENOENT/EACCES through the error handler; the
 * progress stream forwarded `scan.error` raw, so unplugging a drive mid-scan
 * put "ENOENT: no such file or directory, lstat '/Volumes/Backup'" in the
 * status line. An error with no errno keeps its own message: it was written
 * by this app and is already a sentence.
 */
export function describeScanError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | null;
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (code === 'ENOENT') {
    return 'The folder disappeared while TreeMap was scanning it — was a drive unplugged, or the folder moved?';
  }
  if (code === 'EACCES' || code === 'EPERM') return permissionDeniedMessage(e?.path, code);
  return err instanceof Error ? err.message : String(err);
}

/**
 * The root, looked at again once the walk is done.
 *
 * A drive unplugged or a folder deleted mid-scan used to settle as 'complete'
 * with whatever had been read so far — the walker drops a vanished directory
 * as a race with a delete, which is right for one folder and wrong for the
 * root. Only ENOENT is a verdict here; a root that is still there but has
 * become unreadable is a different story, and not a reason to discard a walk
 * that finished.
 */
async function assertRootStillThere(rootPath: string): Promise<void> {
  try {
    await fsp.lstat(rootPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
  }
}

/** The last look at the root before a scan settles; replaceable in tests, to land a cancel inside it. */
let rootCheck: (rootPath: string) => Promise<void> = assertRootStillThere;

/** Test seam: `fn` stands in for the root check every engine awaits before it settles; null puts the real one back. */
export function setRootCheckForTests(fn: ((rootPath: string) => Promise<void>) | null): void {
  rootCheck = fn ?? assertRootStillThere;
}

/** Retention after a scan settles — or after it was last read, whichever is later. */
export const SCAN_TTL_MS = 30 * 60 * 1000;
/**
 * `getScan` stamps lastUsedAt no more often than this. The 'complete' frame on
 * the progress stream and the /stats read that follows it must report the same
 * expiresAt, and the evictor only looks once a minute anyway.
 */
const TOUCH_GRANULARITY_MS = 60 * 1000;
/**
 * A 'running' record left wedged by a driver that died (cloud scans register
 * here too) must still be collected eventually — but at a horizon no real
 * scan can hit, because evicting by age alone cancelled slow full-disk walks
 * mid-flight: the record vanished while its status froze at 'running', the
 * progress stream never finished, and the UI spun forever.
 */
const RUNNING_SCAN_HARD_CAP_MS = 6 * 60 * 60 * 1000;
/** Why a running scan collected at that horizon ended (evictExpiredScans), in the record a stream still holds. */
// Counted from when the scan started, paused time included — a paused scan
// stays "running" — so it says the record's age, never that the scan ran for
// six hours (review F1.9).
const RUNNING_SCAN_HARD_CAP_MESSAGE = 'The scan was stopped six hours after it started, the longest TreeMap keeps a scan that has not finished.';
const EVICT_INTERVAL_MS = 60 * 1000;

/** In-memory store of all scans, auto-evicted after 30 minutes. */
const scans = new Map<string, ScanResult>();

/** The later of "it settled" and "someone last asked for it". */
function lastActivity(scan: ScanResult): number {
  return Math.max(scan.finishedAt ?? scan.createdAt, scan.lastUsedAt ?? 0);
}

/** True when a scan's retention window has passed. Running scans only expire
 *  at the wedge horizon; settled ones 30 minutes after they were last used —
 *  a scan a page is actively reading never expires under it. */
export function scanExpired(scan: ScanResult, now: number): boolean {
  if (scan.status === 'running') return now - scan.createdAt > RUNNING_SCAN_HARD_CAP_MS;
  return now - lastActivity(scan) > SCAN_TTL_MS;
}

/** When a settled scan leaves memory unless it is read again; null while running. */
export function scanExpiresAt(scan: ScanResult): number | null {
  if (scan.status === 'running') return null;
  return lastActivity(scan) + SCAN_TTL_MS;
}

/**
 * Things to run when a scan is dropped.
 *
 * A callback list rather than a direct import, because the fact layer already
 * imports this module — calling into it from here would be a cycle. Lets
 * derived caches keyed by scanId die with the scan they describe instead of
 * outliving it for their own TTL.
 */
const scanForgottenHooks: ((scanId: string) => void)[] = [];
export function onScanForgotten(fn: (scanId: string) => void): void {
  scanForgottenHooks.push(fn);
}

let evictTimer: NodeJS.Timeout | null = null;

/**
 * Drop every scan whose retention has passed; returns the ids dropped. Runs on
 * the evictor's timer, and directly from a test, which is the only way the
 * six-hour hard cap can be exercised.
 */
export function evictExpiredScans(now = Date.now()): string[] {
  const evicted: string[] = [];
  for (const [id, scan] of scans) {
    if (!scanExpired(scan, now)) continue;
    scan.cancelled = true;
    // A running record collected at the six-hour limit is settled first, as
    // cancelScan settles one: the engines return on `cancelled` without
    // settling, and a /progress stream holding this record ends only on a
    // status other than 'running' — it went on heartbeating the last count
    // for ever, and the page said "Scanning…" with no end (hunt C68).
    if (scan.status === 'running') {
      scan.status = 'error';
      scan.error = RUNNING_SCAN_HARD_CAP_MESSAGE;
      scan.finishedAt = now;
    }
    scans.delete(id);
    // The shard first: a paused gdu shard is SIGSTOPped with its own deadline
    // disarmed, so dropping the record without killing it would leave a
    // stopped process, its temp directory and its descriptors behind for good.
    abortGduScan(id);
    forgetScan(id); // drop its expanded-container registry too
    forgetScanBudget(id); // and its throttle clock, forced preset and pause
    for (const hook of scanForgottenHooks) {
      try { hook(id); } catch { /* a derived cache must not break eviction */ }
    }
    evicted.push(id);
  }
  return evicted;
}

function ensureEvictor(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => { evictExpiredScans(); }, EVICT_INTERVAL_MS);
  // Don't let the evictor keep the process alive on shutdown.
  evictTimer.unref();
}

/**
 * A scan id as a request carries it: whatever the value, read as `String(value ?? '')`. The
 * one reading every route uses (`requireScan`) and the storage-mode gate uses, so no spelling
 * of an id (a JSON array holding it, say) finds a scan in a handler that the gate did not see.
 * Total: JSON can give an object whose `toString` is no function, at any depth of lists, and
 * String() throws on it; that reads as no id at all (T17a's security review found the throw
 * turning memory-mode requests into 500s).
 */
export function scanIdOf(value: unknown): string {
  try {
    return String(value ?? '');
  } catch {
    return '';
  }
}

/**
 * A scan by id, as a USE: the retention clock restarts (at minute
 * granularity). Every route, fact provider and MCP tool that answers a client
 * about a scan goes through here, which is what keeps results alive under a
 * page that is using them. Housekeeping that merely checks whether a scan
 * still exists must use `peekScan` instead.
 */
export function getScan(scanId: string): ScanResult | undefined {
  const scan = scans.get(scanId);
  if (scan) {
    const now = Date.now();
    if (scan.lastUsedAt === undefined || now - scan.lastUsedAt >= TOUCH_GRANULARITY_MS) scan.lastUsedAt = now;
  }
  return scan;
}

/** A scan by id without counting as a use of it. */
export function peekScan(scanId: string): ScanResult | undefined {
  return scans.get(scanId);
}

export function allScans(): ScanResult[] {
  return [...scans.values()];
}

/**
 * Shutdown: stop every walker cooperatively, and kill any gdu subprocess.
 *
 * The flag alone leaves the subprocess running — it is only observed between
 * shards — so quitting mid-scan would orphan a gdu that keeps reading the disk
 * and holding its temp directory open with nothing left to clean it up. The
 * records themselves are not settled here: the process is going away, and a
 * shutdown is not the user stopping one scan.
 */
export function cancelAllScans(): void {
  for (const scan of scans.values()) {
    scan.cancelled = true;
    abortGduScan(scan.scanId);
    forgetScanBudget(scan.scanId); // a paused walker is released to read the flag
  }
}

/** What a scan the user stopped reports as its error, everywhere. */
export const SCAN_CANCELLED_MESSAGE = 'Scan stopped by user';

/**
 * Stop a running scan on the user's behalf.
 *
 * Two things have to happen, and the order matters:
 *
 * 1. **Settle the record here, synchronously.** Raising `cancelled` alone is
 *    not enough. Every engine observes the flag by simply `return`ing — gdu at
 *    both its exits, the walker after drainQueue, the cloud driver after
 *    listTree — and none of them assign a status, so the record would sit at
 *    'running' forever: the SSE timer in scanRoutes only ends on
 *    `status !== 'running'`, so the stream would keep beating and the UI would
 *    keep spinning. Settling first makes every one of those returns a no-op.
 *    It is race-free because settleComplete, the one place any engine marks a
 *    scan complete, does nothing to a record that is no longer running: a
 *    cancel that lands in an engine's last await (the root check) stays a
 *    cancel. A scan that beat us to the line really did complete, and
 *    `status !== 'running'` below leaves it alone rather than rewriting a
 *    finished scan as an error.
 *
 * 2. **`finishedAt` is not optional.** `scanExpired` falls back to `createdAt`
 *    when it is missing, so cancelling a walk that started more than the
 *    30-minute TTL ago would have the next evictor tick delete the record —
 *    and the UI would get a 404 instead of this message.
 *
 * Killing the gdu child is a separate concern: cooperative cancellation only
 * reaches the shard boundary, which is up to five minutes away.
 *
 * Returns false when the scan is unknown or has already settled, so the route
 * can answer honestly rather than claim to have stopped something.
 */
export function cancelScan(scanId: string): boolean {
  const scan = scans.get(scanId);
  if (!scan) return false;
  scan.cancelled = true;
  abortGduScan(scanId); // no-op unless a gdu subprocess is mid-shard
  // A paused walker is parked on the budget's gate; releasing it here lets it
  // read `cancelled` and return. Nothing else is awaited before the record
  // settles below, so the walker cannot get ahead of the status it reads.
  forgetScanBudget(scanId);
  if (scan.status !== 'running') return false;
  scan.status = 'error';
  scan.error = SCAN_CANCELLED_MESSAGE;
  scan.finishedAt = Date.now();
  return true;
}

/**
 * Compatibility accessor: every production scan's tree lives in `scan.store`,
 * and no production code path reads or writes `scan.root` (the bounded
 * mtime-cache write is the one sanctioned reader). Hand-assembled records
 * (tests) may still assign a tree; it is kept verbatim and consumers reach it
 * through storeOf(), which wraps it in the ObjectScanStore oracle — running
 * the exact legacy logic against the exact assigned nodes.
 */
function defineRootAccessor(scan: ScanResult): void {
  let legacy: FileNode | undefined;
  Object.defineProperty(scan, 'root', {
    enumerable: true,
    configurable: true,
    get(): FileNode | undefined {
      if (legacy) return legacy;
      const store = scan.store;
      if (!store) return undefined;
      return store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root;
    },
    set(value: FileNode | undefined) {
      legacy = value;
    },
  });
}

/**
 * Register an externally-driven scan (cloud providers) in the same store,
 * so progress SSE, results, treemap and every downstream view work on it
 * exactly as they do on a disk scan.
 */
export function createScanRecord(rootPath: string): ScanResult {
  ensureEvictor();
  const scan: ScanResult = {
    scanId: crypto.randomUUID(),
    rootPath,
    status: 'running',
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
    // Captured at start like every scan's, so /stats can state it; a cloud
    // lister does not throttle, but the budget in force is still a fact.
    budget: scanBudget(),
    // A provider enumerates its own files: no listing mechanism of ours ran,
    // nothing fell back, and nothing was measured per scan.
    engineReason: `a cloud provider listing: the provider enumerates its own files; ${CPU_NOT_MEASURED}`,
    fastPath: 'cloud',
    fallbackReason: null,
    cpuSeconds: null,
    bytesRead: null,
    peakRssBytes: null,
    placeholdersSkipped: 0,
    storageMode: newScanStorageMode(),
  };
  defineRootAccessor(scan);
  scans.set(scan.scanId, scan);
  return scan;
}

/** What a native scan says when a fast rescan was asked for (QA D45): the clause startScan's comment explains. */
const FAST_RESCAN_NOT_USED =
  'a fast rescan was asked for and not used: the native engine lists the whole folder faster than the built-in walker reuses its cache, and sees the edits inside files the cache cannot';

/**
 * What the walker says when it took over from a native walk that failed part-way, for a scan that asked
 * to be a fast rescan (POL item 6): the cache is read only for a scan the native engine will not walk, so
 * the walker that took over had none, and its sentence said only that the native engine failed.
 */
const FAST_RESCAN_NOT_USED_AFTER_FAILURE =
  'a fast rescan was asked for and not used: the native engine was to walk this folder, so its cache was not read, and the built-in walker that took over when the native engine failed lists every folder afresh';

/**
 * What the walker says when it reads the fast-rescan cache (QA D45): which listings it reuses — only those
 * `listingSettled` vouches for, by SETTLED_LISTING_MS, the seconds said here (CI3 review F2.1: it said every
 * folder that has not changed) — and that a reused listing holds no file's allocation. Said whenever the
 * cache is read, before the walk knows how many listings it will reuse: `cachedDirs` counts those.
 */
const FAST_RESCAN_PARTIAL =
  'a fast rescan reuses the last scan\'s listing of a folder only when the folder\'s modified time is unchanged and was more than 5 seconds older than the start of that scan, and a listing it reuses records no allocation and no hard-linked bytes: the sparse-file, slack and hard-link figures count only the folders it lists afresh';

/** One reason a faster engine did not run, and what it is about when more than one engine has a rule about that (`RuleCause`). */
interface WhyClause {
  text: string;
  cause: RuleCause | null;
}

/** A clause no other engine's rule can repeat: a failure, a setting, a probe. */
const said = (text: string): WhyClause => ({ text, cause: null });

/**
 * The sentence a legacy engine's `engineReason` carries: what it is, every
 * reason the faster engines did not run, and the CPU clause. A cause two
 * engines' rules share is said once, in the words of the first engine it kept
 * off (QA D45, D75: "this is an incremental rescan" was said twice).
 */
function legacyReason(engine: 'gdu' | 'walker', why: readonly WhyClause[]): string {
  const label = engine === 'gdu' ? 'gdu was chosen' : 'the built-in walker ran';
  const causes = new Set<RuleCause>();
  const clauses: string[] = [];
  for (const { text, cause } of why) {
    if (cause !== null) {
      if (causes.has(cause)) continue;
      causes.add(cause);
    }
    clauses.push(text);
  }
  return `${label}: ${[...clauses, CPU_NOT_MEASURED].join('; ')}`;
}

/** Record why an engine that was wanted could not run; a second reason joins the first rather than replacing it. */
function noteFallback(scan: ScanResult, reason: string): void {
  scan.fallbackReason = scan.fallbackReason ? `${scan.fallbackReason}; ${reason}` : reason;
}

/**
 * Discard whatever an aborted engine attempt accumulated, so the engine that
 * runs next does not count on top of it.
 */
function resetCounters(scan: ScanResult): void {
  scan.fileCount = 0;
  scan.dirCount = 0;
  scan.scanned = 0;
  scan.walkedDirs = 0;
  scan.cachedDirs = 0;
  scan.hardlinkedFiles = 0;
  scan.hardlinkedBytes = 0;
  scan.sparseFiles = 0;
  scan.sparseBytes = 0;
  scan.slackBytes = 0;
  scan.cloudFiles = 0;
  scan.cloudBytes = 0;
  scan.deniedDirs = 0;
  scan.deniedExamples = [];
  scan.deniedPaths = [];
  scan.vanishedDirs = 0;
  scan.unreadableDirs = 0;
  scan.deniedEntries = 0;
  scan.unreadableEntries = 0;
  scan.placeholdersSkipped = 0;
  scan.cpuSeconds = null;
  scan.currentPath = scan.rootPath;
  if (scan.boundary) restartBoundaryWalk(scan.boundary);
}

/**
 * A finished tree becomes the scan's result, and the two background writes
 * start: the mtime cache for a future fast rescan, then the snapshot for
 * Trends. Failures there must never fail the scan itself — and each is
 * caught: an unawaited AND uncaught rejection here reached Node's
 * unhandledRejection, which is fatal by default, so a cache write failing
 * would have taken the whole app down.
 */
/** The NTFS turbo mode's walk, replaceable in tests: it needs Windows, a drive and an elevated helper. */
let mftWalk: typeof runMftWalk = runMftWalk;

/** Test seam: `startScan` runs `fn` as the NTFS turbo mode's walk; null puts the real one back. */
export function setMftWalkForTests(fn: typeof runMftWalk | null): void {
  mftWalk = fn ?? runMftWalk;
}

/** What `gduRuleFor` weighs about a scan. */
export interface GduRuleInput {
  forced: EngineSetting;
  rootIsDir: boolean;
  incremental: boolean;
  ignoreCount: number;
  /** TREEMAP_NO_GDU is set. */
  noGdu: boolean;
  platform: NodeJS.Platform;
  /** The boundary rule is `cross` and the mount table lists a drive the walk can reach (Track U, U-24). */
  crossesMounts?: boolean;
}

/**
 * Why gdu is not wanted for a scan, the first rule that applies, or null
 * when it may run (startScan's comment gives the reasons). On Windows it is
 * never wanted: gdu keys no hard links there, so a tree that has them is
 * counted more than once, and the built-in walker keys them by file id —
 * the owner's decision on RISKS R59, 23 Sep 2026.
 */
export function gduRuleFor(o: GduRuleInput): string | null {
  if (o.forced === 'walker') return 'the Scan engine setting asks for the built-in walker';
  if (o.platform === 'win32') {
    return 'on Windows gdu keys no hard links (it reads every file id as 0), so a tree that has them would be counted more than once; the built-in walker keys them by file id';
  }
  switch (gduRuleCause(o)) {
    case 'singleFile':
      return 'the root is a single file, which needs no gdu process';
    case 'incremental':
      return 'this is an incremental rescan, which gdu has no cache for';
    case 'ignore':
      return `the scan has ${o.ignoreCount} "don't scan" pattern${o.ignoreCount === 1 ? '' : 's'} gdu cannot express`;
    default:
      break;
  }
  // gdu runs with -x and stops at every mount point, so under "Include drives
  // mounted inside it" it would leave out what the person asked to count.
  if (o.crossesMounts) return 'the scan includes the drives mounted inside the folder ("Include drives mounted inside it"), and gdu stops at every drive';
  if (o.noGdu) return 'gdu is switched off by TREEMAP_NO_GDU';
  return null;
}

/** The cause of the rule `gduRuleFor` gives, when another engine's rule can share it (`RuleCause`); else null. */
export function gduRuleCause(o: GduRuleInput): RuleCause | null {
  if (o.forced === 'walker' || o.platform === 'win32') return null;
  if (!o.rootIsDir) return 'singleFile';
  if (o.incremental) return 'incremental';
  if (o.ignoreCount > 0) return 'ignore';
  return null;
}

/**
 * Whether a finished scan is kept in the walker's fast-rescan cache and the
 * snapshot history. An NTFS turbo scan read the table as administrator: its
 * tree holds what an unelevated listing is refused (other accounts'
 * folders, System Volume Information). Kept, the cache would hand that view
 * to the next unelevated rescan, the history would set it beside ordinary
 * scans as growth that is only what this user cannot list, and both would
 * hold it on disk after a yes given "for this one scan only" (the
 * pre-landing review of 23 Sep 2026). Nor is a dry run's (`record: false`).
 */
export function keepsScan(scan: Pick<ScanResult, 'engine'>): boolean {
  return scan.engine !== 'ntfs-mft' && isRecorded(scan);
}

/**
 * Whether a scan is one somebody made, rather than a dry run's (`record:
 * false`). A dry run's scan is held in memory like any other while its
 * candidates are read, and the scanned-root rule and sizes may use it — but
 * it is nobody's scan to list: GET /api/scans offered an Autopilot Preview's
 * scan to Compare and to the page's session restore, which reopened it on the
 * next load as the person's own (C12 review), and the fleet sent it to peers
 * as this machine's last scan.
 */
export function isRecorded(scan: object): boolean {
  return !unrecorded.has(scan);
}

/**
 * The scans started with `record: false` (`ScanOptions`): a dry run's, which
 * must change nothing persistent (browser re-check C12). Beside the record,
 * not on it, so no response that serialises a scan's fields changes shape.
 */
const unrecorded = new WeakSet<object>();

function settleComplete(scan: ScanResult, store: ScanStore): void {
  // Every engine awaits one last look at the root after its cancellation
  // check, and a cancel can land inside that await: the record is then
  // settled as cancelled, and the finished walk must not overwrite it,
  // publish its tree or write the rescan cache and history.
  if (scan.status !== 'running') return;
  // The folders no engine entered look childless in every engine's tree: each
  // is marked here, the one place every engine settles (Track U, U-4), from
  // the scan's own never-descend list (U-24): the fixed folders and, under
  // "Stay on this drive", every drive mounted inside that it did not enter.
  // A record without a boundary (a cloud listing, a test's) has the fixed list.
  markUnlistedPaths(store, scan.boundary?.neverDescend ?? neverDescendPaths());
  scan.store = store;
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  scan.currentPath = scan.rootPath;
  if (!keepsScan(scan)) return;
  // The caches of the format before U-4c L2 are never read: they leave app-data
  // after the cache is written, inside the same tracked write (the U-4c review, F1.2, F2.1).
  trackWrite('saveMtimeCache', saveMtimeCache(scan).catch((err: unknown) => {
    console.error('[treemap] mtime cache save failed:', err);
  }).then(() => dropLegacyMtimeCaches()));
  trackWrite('saveSnapshot', saveSnapshot(scan).catch((err: unknown) => {
    console.error('[treemap] snapshot save failed:', err);
  }));
}

/**
 * Kick off a scan of `rootPath`. Returns the scan record immediately;
 * the walk continues in the background and mutates the record as it goes.
 */
export interface ScanOptions {
  /** Read the fast-rescan cache the last scan of this folder saved, and reuse the listings it vouches for (`listingSettled`). */
  incremental?: boolean;
  /**
   * Run at this preset whatever the setting says or later becomes. The
   * scheduler's scans pass 'eco': nobody asked for them right now, so they
   * must never be the reason the computer feels slow.
   */
  budget?: EffectiveBudgetPreset;
  /**
   * A person started this scan in the TreeMap window. Only such a scan may
   * ask for administrator permission (the NTFS turbo mode): the scheduler,
   * autopilot, a paired computer, the MCP server and API calls that do not
   * say so are never the reason a prompt appears on someone's screen (the
   * pre-landing review of 23 Sep 2026). And only such a scan runs the
   * Automatic budget at Turbo (U-13, engineBudget's `autoBase`): work nobody
   * is watching never runs above the setting.
   */
  interactive?: boolean;
  /**
   * Follow a root that is a link to a folder (QA D78) — true unless said
   * otherwise. Autopilot says otherwise: every check of a policy's folder
   * (never a whole drive, notes, protected paths, the spill folder) was made
   * of the saved spelling, and an unattended deleter must not act through a
   * link that can since lead anywhere. Unfollowed, the link is the one file it
   * is, as every root link was before.
   */
  followLinkRoot?: boolean;
  /**
   * Keep the finished scan in the fast-rescan cache and the snapshot history —
   * true unless said otherwise. A dry run says otherwise (browser re-check C12):
   * an Autopilot Preview scanned its folder and saved a snapshot, and the first
   * real scan on a fresh install then said "Nothing changed since your last
   * scan moments ago", with the forecast and Trends counting the preview.
   */
  record?: boolean;
}

/** The folder a scan walks, and the link it was given as, when it was given one (D78). */
interface ScanRoot {
  rootPath: string;
  rootStat: Stats;
  /** The path the scan was asked for, when that is a link to the folder it walks; else null. */
  linkedFrom: string | null;
}

/**
 * What a scan of `given` walks (QA D78, 5 Oct 2026). A link to a folder —
 * macOS's /tmp, /var and /etc, a project folder kept elsewhere — is followed,
 * here and only here: the scan is of the folder it points to, by that
 * folder's own path, so every engine is handed it, its boundary and its
 * fast-rescan cache are that folder's, and everything the scan lists is
 * spelled under it (the scanned-root rule resolves the parents of every path
 * it is asked about, so a path spelled through the link is the same file).
 * A person who points TreeMap at a folder by a link means the folder; the
 * scan showed one tile, the link, before. No walk follows a link below the
 * root, as before.
 *
 * A link to a file, to nothing, or round in a loop stays the one file it is.
 * The folder a link leads to passes the checks a path typed by hand passes
 * (`sanitizePath`) and must lie in the agent policy's allowed roots, if it
 * has any: the caller checked the link's own spelling, which can lie inside
 * an allowed root while the folder lies anywhere.
 */
async function scanRootOf(given: string, followLink = true): Promise<ScanRoot> {
  const stat = await fsp.lstat(given);
  /** The root as given: walked where it really is, a link in the folders above it resolved. */
  const asGiven = async (): Promise<ScanRoot> => {
    await assertWalkAllowed(given, await placeOfRoot(given, stat), false);
    return { rootPath: given, rootStat: stat, linkedFrom: null };
  };
  if (!stat.isSymbolicLink() || !followLink) return asGiven();
  let target: string;
  try {
    if (!(await fsp.stat(given)).isDirectory()) return asGiven();
    target = await fsp.realpath(given);
  } catch (err) {
    // To nothing, or round in a loop: the one file it is. Anything else — a
    // folder on the way TreeMap may not look into — fails the scan as a scan
    // of that folder would, with the permission sentence, never quietly as a
    // one-file scan of the link.
    if (meansGone(err)) return asGiven();
    throw err;
  }
  const folder = sanitizePath(target);
  await assertWalkAllowed(given, folder, true);
  return { rootPath: folder, rootStat: await fsp.lstat(folder), linkedFrom: given };
}

/**
 * Where a root taken as given really is: every link resolved for a folder or a file, and for a link (scanned
 * as the one file it is) the folder it lies in resolved. A path realpath cannot answer for is judged as given:
 * the walk that follows fails on it in its own words.
 */
async function placeOfRoot(given: string, stat: Stats): Promise<string> {
  if (!stat.isSymbolicLink()) return fsp.realpath(given).catch(() => given);
  const dir = await fsp.realpath(path.dirname(given)).catch(() => path.dirname(given));
  return path.join(dir, path.basename(given));
}

/**
 * The folder a scan of `given` is rooted at (D78): the folder a link points to, else `given`. A caller that
 * reads what earlier scans of the same folder left (the scheduler's history and forecast) reads it under this
 * path, which is the one the scan saves under. It decides as `startScan` does, refusals included.
 */
export async function scanRootPathOf(given: string): Promise<string> {
  return (await scanRootOf(given)).rootPath;
}

/**
 * What startScan refuses a scan of `given` for before it looks at the folder itself — the agent policy where
 * a link root leads or where the root really is (assertWalkAllowed), the path rules where a link root leads —
 * found as startScan finds it (scanRootOf), without walking (GET /api/policy?scanRoot=, review F3.2). A root
 * that cannot be looked at (gone, not readable) is the folder's own state, not a refusal: null, and a scan of
 * it says why in its own words.
 */
export async function scanRootRefusal(given: string): Promise<AppError | PathRejectedError | null> {
  try {
    await scanRootOf(given);
    return null;
  } catch (err) {
    return err instanceof AppError || err instanceof PathRejectedError ? err : null;
  }
}

/**
 * The agent policy's allowed roots confine what a scan walks (AGENTS.md), judged where it really is: `place`,
 * the folder a link root leads to or where the root taken as given lies, must be inside an allowed root, as
 * read as every other gate reads it (`insideAllowedRoots`: a leading `~` the home folder, where it lives and
 * where it really is). The caller checked the root's spelling; a link — the root itself, or a folder above it —
 * can lie inside an allowed root while what it leads to lies anywhere, and a scan grants actions on what it
 * walked.
 */
async function assertWalkAllowed(given: string, place: string, isLinkRoot: boolean): Promise<void> {
  // Imported when called: policy.ts reads the scans (`allScans`), and a module
  // cycle is refused (tests/importCycles.test.ts).
  const { getPolicy, insideAllowedRoots } = await import('./policy');
  const { allowedRoots } = await getPolicy();
  if (allowedRoots.length === 0) return;
  if (insideAllowedRoots(allowedRoots, path.normalize(canonicalDirOf(place)))) return;
  // Where it leads is not named: it lies outside every root this caller may see. Nor is a link blamed
  // unless the root is one: a root outside them for any reason reads the same.
  const why = isLinkRoot ? 'is a link to a folder outside the allowed roots' : 'lies outside the allowed roots where it really is';
  throw new AppError(403, 'POLICY_ROOT_NOT_ALLOWED', `"${given}" ${why} — edit agent-policy.json (allowedRoots) to widen them`);
}

/** The clause a scan of a link to a folder leads its engine sentence with (D78). */
function linkedRootClause(root: ScanRoot): string | null {
  return root.linkedFrom === null ? null : `${root.linkedFrom} is a link to ${root.rootPath}, and TreeMap scanned the folder it points to`;
}

export async function startScan(given: string, opts: ScanOptions = {}): Promise<ScanResult> {
  ensureEvictor();

  // Fail fast on unreadable/nonexistent roots so the API can 4xx properly.
  const root = await scanRootOf(given, opts.followLinkRoot !== false);
  const { rootPath, rootStat } = root;
  /** Every engine sentence, led by the link clause when the root was given as a link (D78). */
  const linkClause = linkedRootClause(root);
  const told = (reason: string): string => (linkClause === null ? reason : `${linkClause}; ${reason}`);
  // lstat alone passes for a folder this user may not LIST (macOS TCC: Mail,
  // Photos, another account's home), and the scan then settled as "complete,
  // 0 files". Opening it is the honest test, and its EACCES/EPERM carries the
  // path the error handler turns into the Full Disk Access sentence.
  if (rootStat.isDirectory()) await (await fsp.opendir(rootPath)).close();

  // User-configured "don't scan" patterns; a settings problem never blocks a scan.
  const ignore = await getIgnoreMatchers('scan').catch(() => [] as CompiledIgnore[]);
  // The engine the user asked for (Phase 3); the same rule — Automatic when
  // the settings cannot be read.
  const forced: EngineSetting = await getSettings().then((s) => s.engine, () => 'auto' as EngineSetting);
  // Where the scan stops at a drive mounted inside the folder (Track U, U-24):
  // the person's rule, then this scan's own reading of the mount table —
  // composed before any engine is chosen (gdu cannot follow `cross`) and kept
  // on the record, so every engine is handed the same list.
  const rule: BoundaryRule = await getSettings().then((s) => s.scanBoundary, () => DEFAULT_BOUNDARY_RULE);
  const boundary = boundaryRecord(
    await scanBoundary(rootPath, rule).catch((err: unknown) => unknownBoundary(rule, process.platform, err instanceof Error ? err.message : String(err), rootPath)),
  );
  if (ignore.length > 0) noteSkippedMounts(boundary, rootPath, (p) => matchesAny(ignore, p, path.basename(p)));

  const rootIsDir = rootStat.isDirectory();

  /*
   * Engine selection (Phase 3, decision P3-4 and DESIGN §4.1), in order:
   * forced setting → native (eligible, module loaded, root probed) → gdu (as
   * before) → the walker. The rules cost nothing and come first, so a scan
   * the setting sends elsewhere never loads a module or pays for a probe; a
   * refused probe or a missing module is a `fallbackReason`, a rule is a
   * clause in `engineReason`, and the walker's sentence ends with every
   * reason the faster engines did not run.
   */
  const nativeInput = { ignoreCount: ignore.length, forced, rootIsDir };
  const native = decideNative(rootPath, nativeInput);
  /*
   * The native walk, when the engine is eligible, with the tree's size
   * projected before it walks (Track U, U-30): the last scan of this folder,
   * else a whole volume's used inodes, else unknown — never a throw. It is
   * projected here, before the record exists, rather than in the walk's
   * fire-and-forget block, so startScan still returns with the native walk
   * started: a pause or a Stop always meets a walk, never a gap before one.
   */
  const nativeWalk = native.eligibility.ok && native.module
    ? { module: native.module, fastPath: native.eligibility.fastPath, reason: native.eligibility.reason, projection: await nativeProjection(rootPath) }
    : null;

  /*
   * A fast (incremental) rescan is the built-in walker's: it reuses the
   * listing the last scan of this folder left in the mtime cache for a folder
   * only when the folder's time is unchanged and was more than
   * SETTLED_LISTING_MS older than the start of that scan (`listingSettled`),
   * since a change in the same tick of the clock can leave the time as it
   * was (CI run 38519159263). Where the native engine
   * walks, a request for one is not used (QA D45, 5 Oct 2026): the native
   * engine lists a whole folder in one call per folder, about twenty times
   * faster on the QA Mac than the walker parses the cache and checks every
   * folder's time, and it is exact where the cache is not — an edit inside a
   * file is seen, every file's allocation is measured, a placeholder is read
   * from its flag. So the cache is read only for a scan the native engine
   * will not walk (the Walker or gdu setting, a pattern, a single file, no
   * module), and gdu's and the turbo mode's rules weigh only that.
   */
  const fastRescanSkipped = opts.incremental === true && nativeWalk !== null;
  const incremental = opts.incremental === true && !fastRescanSkipped;
  let cache: Map<string, FileNode> | null = null;
  if (incremental) {
    // `.catch(() => null)` for the same reason the ignore-matcher read above
    // catches: this is an optimisation, and `null` already means "no usable
    // cache, do a full walk". Without it, `readJsonFile`'s new throw on an
    // undecidable errno aborts the whole scan — and because an fs error
    // carries a string `code`, `errorHandler` maps EACCES/EPERM to
    // `403 PERMISSION_DENIED`, telling the user they lack permission on a
    // folder they can read perfectly well. On Windows that is not theoretical:
    // `writeJsonFile` finishes with a rename, and a read racing it gives
    // EPERM/EBUSY.
    const cachedRoot = await readJsonFile<FileNode | null>(cacheFileName(rootPath, rule), null).catch(() => null);
    if (cachedRoot && cachedRoot.path === rootPath && cachedRoot.type === 'dir') {
      cache = buildDirCache(cachedRoot);
    }
  }

  const scanId = crypto.randomUUID();
  const scan: ScanResult = {
    scanId,
    rootPath,
    status: 'running',
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
    // The Full Disk Access state this scan runs under (U-11, review F1.5):
    // its refusals are worded by it later, whatever the state is by then.
    fdaState: lastFdaState(),
    // The budget this scan runs under, captured now (the settings read above
    // handed the budget module the persisted setting) and kept on the record.
    // A scan a person started raises Automatic to Turbo while it runs (U-13).
    budget: beginScanBudget(scanId, opts.budget, { interactive: opts.interactive === true }),
    engine: WALKER_ENGINE,
    ioThreads: IO_THREADS,
    engineReason: '',
    fastPath: WALKER_FAST_PATH,
    fallbackReason: null,
    cpuSeconds: null,
    bytesRead: null,
    peakRssBytes: null,
    placeholdersSkipped: 0,
    incremental: !!cache,
    cachedDirs: 0,
    walkedDirs: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    sparseFiles: 0,
    sparseBytes: 0,
    slackBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
    // Phase 4: the mode the scan is kept in, `memory` until T16's chooser (storageMode.ts).
    storageMode: newScanStorageMode(),
    boundary,
  };
  defineRootAccessor(scan);
  if (opts.record === false) unrecorded.add(scan);
  scans.set(scan.scanId, scan);

  /** Why each faster engine did not run, in order — the clauses of a legacy engine's reason. */
  const why: WhyClause[] = [];
  /** The fast path a legacy engine reports: `unavailable` once the native listing was probed and refused (P3-9), else its own. */
  let legacyFastPath: string | null = null;
  if (!native.eligibility.ok) {
    why.push({ text: native.eligibility.reason, cause: native.eligibility.fallback ? null : nativeRuleCause(nativeInput) });
    if (native.eligibility.fallback) noteFallback(scan, native.eligibility.reason);
    if (native.eligibility.probeRefused) legacyFastPath = FAST_PATH_UNAVAILABLE;
  }

  /**
   * The gdu turbo engine is preferred to the walker (~112-120k items/sec
   * sharded, vs the walker's 69-97k) but only where it can be exactly as
   * correct as the walker:
   *
   *  - directories only (a single-file "scan" isn't worth a subprocess);
   *  - not incremental — the mtime cache is built around the walker's
   *    per-directory reuse and gdu has no equivalent;
   *  - no ignore list — gdu's -i/-I cannot faithfully express this app's glob
   *    patterns, and quietly scanning something the user excluded is worse than
   *    being slower. Fall back rather than approximate.
   *
   * The Scan engine setting can turn it off (walker) or ask for it (gdu); a
   * rule that keeps a scan gdu asked for off it is a fallback, named. The
   * rules are gduRuleFor's.
   */
  const gduInput: GduRuleInput = {
    forced,
    rootIsDir,
    incremental,
    ignoreCount: ignore.length,
    noGdu: process.env.TREEMAP_NO_GDU === '1',
    platform: process.platform,
    crossesMounts: rule === 'cross' && mountOutcome(boundary).entered.length > 0,
  };
  const gduRule = gduRuleFor(gduInput);
  const gduWanted = !native.eligibility.ok && gduRule === null;

  /*
   * The NTFS turbo mode (Phase 3 W6): only when the setting asks for it, and
   * only on Windows (the setting is refused elsewhere). It goes first; when
   * it is not used — a rule, a declined prompt, a refusal, a divergence — the
   * chain above runs, and every scan the mode was asked for carries its
   * clause, with W6-9's "not verified on this build", in `engineReason`.
   */
  const mftOffered = forced === 'ntfs-mft' && mftOfferedOn();
  const mftWanted = mftOffered && opts.interactive === true;
  // Asked for and never tried: the clause whatever engine then scans — the
  // native engine's reason included, which the first Windows CI run found
  // it missing from (it went only into the legacy engines' reasons).
  const mftUntried = forced === 'ntfs-mft' && !mftOffered
    ? `the NTFS turbo mode (${MFT_NOT_VERIFIED}) was not used: it is Windows only`
    : mftOffered && !mftWanted
      ? `the NTFS turbo mode (${MFT_NOT_VERIFIED}) was not used: it asks for administrator permission only for a scan started from the TreeMap window, and this one was not`
      : null;
  // A fast-rescan request keeps the mode off whichever engine then scans (the
  // walker with its cache, or the native engine, which does not read it): no
  // administrator prompt is raised for a scan that asked to be a rescan.
  const mftRuleCause: RuleCause | null = !mftWanted ? null : !rootIsDir ? 'singleFile' : opts.incremental === true ? 'incremental' : ignore.length > 0 ? 'ignore' : null;
  const mftRule = mftRuleCause === 'singleFile' ? 'the root is a single file, which needs no volume read'
    : mftRuleCause === 'incremental' ? 'this is an incremental rescan, which the turbo mode does not do'
      : mftRuleCause === 'ignore' ? ignorePatternClause(ignore.length)
        : null;
  if (!native.eligibility.ok && gduRule !== null && forced !== 'walker') {
    if (forced === 'gdu') noteFallback(scan, `${gduRule} (the Scan engine setting asked for gdu)`);
    why.push({ text: gduRule, cause: gduRuleCause(gduInput) });
  }

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void (async () => {
    /** The mode's clause when it was asked for and not used; its fallback when that was a failure. */
    let mftClause: string | null = mftUntried;
    /** What the mode's clause is about, when a rule kept it off: the engines after it say that cause no more. */
    let mftCause: RuleCause | null = null;
    let mftFallback: string | null = null;
    if (mftWanted && mftRule !== null) {
      mftClause = `the NTFS turbo mode (${MFT_NOT_VERIFIED}) was not used: ${mftRule}`;
      mftCause = mftRuleCause;
    } else if (mftWanted) {
      scan.engine = 'ntfs-mft';
      scan.fastPath = 'mft';
      scan.engineReason = told(`the NTFS turbo mode was chosen by the Scan engine setting (${MFT_NOT_VERIFIED}); it waits for its elevated helper`);
      const store = new PackedScanStore(rootPath, path.sep, statToInput(rootName(rootPath), true, rootStat.size, rootStat.mtimeMs, rootStat.atimeMs));
      try {
        const outcome = await mftWalk(scan, store, rootPath);
        if (scan.cancelled) return;
        if (outcome.used) {
          scan.engineReason = told(outcome.reason);
          await rootCheck(scan.rootPath);
          settleComplete(scan, store);
          return;
        }
        mftClause = outcome.reason;
        if (outcome.failed) mftFallback = outcome.reason;
      } catch (err) {
        if (scan.cancelled) return;
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' && e.path === scan.rootPath) throw err;
        mftClause = `the NTFS turbo mode (${MFT_NOT_VERIFIED}) failed part-way: ${e instanceof Error ? e.message : String(err)}`;
        mftFallback = mftClause;
      }
      resetCounters(scan);
      scan.engine = WALKER_ENGINE;
      scan.fastPath = WALKER_FAST_PATH;
    }
    if (mftClause !== null) why.unshift({ text: mftClause, cause: mftCause });
    if (mftFallback !== null) noteFallback(scan, mftFallback);
    if (nativeWalk) {
      scan.engine = 'native';
      scan.fastPath = nativeWalk.fastPath;
      scan.engineReason = told([nativeWalk.reason, ...(fastRescanSkipped ? [FAST_RESCAN_NOT_USED] : []), ...(mftClause === null ? [] : [mftClause])].join('; '));
      scan.fallbackReason = mftFallback;
      // The memory store's room, sized from the projection (U-31, the owner's
      // U-Q15): a tree that outgrew the default room is walked once, not once
      // to the ceiling and again. Interim until T16's chooser.
      const storage = nativeStorageFor(nativeWalk.module);
      const room = storage === 'memory' ? memoryRoomFor(nativeWalk.projection) : null;
      scan.nativePlan = { projection: nativeWalk.projection, room };
      if (room?.sizedBy === 'projection') {
        // "Sized for": the plan, before the module is asked; a refusal of it is said after it (runNativeWalk).
        scan.engineReason = `${scan.engineReason}; the memory store was sized for ${formatCount(room.capRows)} rows because ${nativeWalk.projection.reason}`;
      }
      const store = new PackedScanStore(rootPath, path.sep, statToInput(rootName(rootPath), true, rootStat.size, rootStat.mtimeMs, rootStat.atimeMs));
      try {
        await runNativeWalk(scan, store, rootPath, nativeWalk.module, storage, room ?? undefined);
        if (scan.cancelled) return;
        await rootCheck(scan.rootPath);
        settleComplete(scan, store);
        return;
      } catch (err) {
        if (scan.cancelled) return; // cancellation is not a native failure
        // A root that vanished is the scan's failure, not the engine's: the
        // legacy chain would only fail the same way after a pointless retry.
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' && e.path === scan.rootPath) throw err;
        // P4-14 now (U-32, the owner's U-Q16): a tree known to be above T_mem
        // is not walked again from zero by the built-in walker. The scan
        // fails with the reason, its count kept and nothing reset.
        const refusal = noRestartRefusal(err, scan.scanned, nativeWalk.projection);
        if (refusal !== null) throw refusal;
        // Anything else is a fallback: the legacy chain produces the scan,
        // and the stats say what the native engine could not do.
        const reason = `the native engine failed part-way: ${e instanceof Error ? e.message : String(err)}`;
        console.warn(`[treemap] ${reason}; using the legacy engines`);
        resetCounters(scan);
        noteFallback(scan, reason);
        why.push(said(reason));
        if (fastRescanSkipped) why.push(said(FAST_RESCAN_NOT_USED_AFTER_FAILURE));
        scan.engine = WALKER_ENGINE;
        scan.fastPath = WALKER_FAST_PATH;
      }
    }
    if (gduWanted) {
      try {
        const bin = await findGduBinary();
        if (bin) {
          scan.engine = 'gdu-turbo';
          scan.fastPath = legacyFastPath ?? GDU_FAST_PATH;
          scan.engineReason = told(legacyReason('gdu', [...why, said('a gdu binary is available and the scan is a full walk with no ignore list')]));
          const store = await gduScanIntoStore(scan, bin, cloudProviderFor);
          if (scan.cancelled) return;
          await rootCheck(scan.rootPath);
          settleComplete(scan, store);
          return;
        }
        const missing = 'no gdu binary is bundled or on PATH';
        why.push(said(missing));
        if (forced === 'gdu') noteFallback(scan, `${missing} (the Scan engine setting asked for gdu)`);
      } catch (err) {
        if (scan.cancelled) return; // cancellation is not a gdu failure
        // A root that vanished is the scan's failure, not gdu's: the walker
        // would only fail the same way after a pointless second attempt.
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' && e.path === scan.rootPath) throw err;
        // gdu is strictly best-effort: a missing binary, a spawn failure, a
        // non-zero exit or an oversized shard must never surface as a scan
        // error. Log it and let the walker produce the scan.
        const reason = `gdu failed: ${e instanceof Error ? e.message : String(err)}`;
        console.warn(`[treemap] gdu engine unavailable, using walker: ${String(err)}`);
        // Discard whatever the aborted attempt accumulated so the walker
        // doesn't double-count on top of it.
        resetCounters(scan);
        noteFallback(scan, reason);
        why.push(said(reason));
      }
    }
    scan.engine = WALKER_ENGINE;
    scan.fastPath = legacyFastPath ?? WALKER_FAST_PATH;
    scan.engineReason = told(legacyReason('walker', cache === null ? why : [...why, said(FAST_RESCAN_PARTIAL)]));
    await walk(scan, rootIsDir, ignore, cache);
  })().catch((err: unknown) => {
    scan.status = 'error';
    scan.error = describeScanError(err);
    scan.finishedAt = Date.now();
  }).finally(() => {
    // The budget's per-scan state (throttle clock, forced preset, pause) dies
    // with the walk, whichever way it ended.
    forgetScanBudget(scan.scanId);
  });

  return scan;
}

/* ---------- Incremental (fast) rescan cache ---------- */

const MTIME_CACHE_MAX_NODES = 300_000;

/**
 * Stable per-root cache filename in the app-data directory, keyed by the
 * boundary rule as well (Track U, U-24): a listing cached by a scan that
 * stayed on its drive says a drive mounted inside is an empty folder, and a
 * scan that crosses into it must not believe that. A cache from before U-24
 * is safe under `stay`, because the walk checks every folder it is handed
 * against its own list.
 *
 * The name carries the cache's format (U-4c L2): format 2 marks a folder the
 * scan did not list in full (`unlisted`, U-4b L3). An older cache holds such a
 * folder's partial listing unmarked — reused, it would read as complete, and
 * the next cache would be written from that tree — so it is never read: the
 * first fast rescan after the change walks in full.
 *
 * Format 3 (BQL item 8) keeps a name that begins with U+FEFF as it is on disk.
 * The builds that wrote format 2 read stored names through a decoder that
 * dropped a leading mark (fixed in 134674f6), so their cache can list the
 * 900-byte "\uFEFFfoo" as "foo", at the path of the 5-byte file beside it;
 * reused, that listing would point an action on one file at the other. A
 * format-2 cache is therefore never read, and leaves app-data as the
 * unversioned ones do (legacyMtimeCaches.ts).
 */
const MTIME_CACHE_FORMAT = 3;

function cacheFileName(rootPath: string, rule: BoundaryRule): string {
  const key = rule === 'cross' ? `${rootPath}\0cross` : rootPath;
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `mtime-cache-v${MTIME_CACHE_FORMAT}-${h}.json`;
}

/** Index every directory of a cached tree by path for O(1) substitution. */
function buildDirCache(root: FileNode): Map<string, FileNode> {
  const map = new Map<string, FileNode>();
  const stack: FileNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'dir') {
      map.set(n.path, n);
      if (n.children) for (const c of n.children) stack.push(c);
    }
  }
  return map;
}

/**
 * A cached directory mtime "matches" the disk when equal to the millisecond —
 * or, because gdu records whole seconds, when the cached value is
 * second-aligned and the disk time truncates to that same second. Without the
 * tolerance, a cache written by a gdu scan never matches anything and a fast
 * rescan silently degrades into a full walk.
 */
export function mtimesMatch(cachedMs: number, freshMs: number): boolean {
  const fresh = Math.round(freshMs);
  if (cachedMs === fresh) return true;
  return cachedMs % 1000 === 0 && Math.floor(fresh / 1000) * 1000 === cachedMs;
}

/**
 * How much older than its scan's start a folder's time must be for the fast-rescan cache to vouch for
 * the listing that scan read (`listingSettled`). It must cover the widest time a later change can
 * share with the change before it: a whole second, which `mtimesMatch` lets a whole-second cached time
 * stand for, on top of FAT's two-second times — and a kernel that stamps times from a coarse clock, a
 * tick late. Five seconds holds all three with room; a folder changed within them is listed again by
 * the next fast rescan, which costs that one folder's listing.
 */
export const SETTLED_LISTING_MS = 5_000;

/**
 * Whether the fast-rescan cache may vouch for a folder's listing: the folder's time, as the scan that
 * listed it read it, is strictly older than that scan's start by SETTLED_LISTING_MS. git's racily
 * clean entries, for folders (CI run 38519159263): a folder changed again after the scan listed it,
 * within the same tick of the clock as the change before, keeps the time the cache holds — a whole
 * second where gdu wrote the cache or a FAT volume keeps the time, and where a time read to the
 * millisecond happens to fall on one (1 in 1,000), the second `mtimesMatch` allows. Reused, that
 * listing hid the change for good: a file deleted 80 ms after its folder was listed stayed in every
 * fast rescan until the folder changed again. Such a change can only follow a time this close to the
 * scan's start, so a folder whose time is not that much older (or is unknown, or ahead of the clock)
 * is listed again; one that changed long before is reused as ever.
 */
export function listingSettled(folderModifiedAt: number, scanStartedAt: number): boolean {
  return folderModifiedAt < scanStartedAt - SETTLED_LISTING_MS;
}

/**
 * One directory awaiting its listing. The walk works on store ids; the path
 * rides along so nothing is reconstructed, and `cached` carries the fast-
 * rescan candidate whose listing may substitute for a fresh readdir.
 */
interface DirJob {
  id: number;
  path: string;
  /** Cached node for this dir (fast rescan) — its listing may be reused. */
  cached: FileNode | null;
  /** Reached through a cached parent's listing — lstat before trusting it. */
  revalidate: boolean;
  /** This folder's device, once a stat has read it: the boundary detector compares its children with it. */
  dev?: number;
  /** Its parent's device, for a folder reached through a cached listing (whose own stat comes later). */
  parentDev?: number;
}

/**
 * Reuse a validated directory's cached listing: build its direct children
 * into the store and enqueue each subdirectory for its own revalidation
 * visit. Counter semantics mirror a fresh listing (scanned/dirCount/
 * fileCount). The online-only tallies are taken from the same nodes the tree
 * takes, flag and size (QA D45): left out, the Missing Gigabytes statement
 * took back only the placeholders in folders listed afresh. What a cached
 * node does not hold is not guessed: its allocation (so the sparse and slack
 * tallies count only the folders listed afresh — the walker's sentence says
 * so, FAST_RESCAN_PARTIAL) and a hard-link duplicate's bytes.
 */
function reuseCachedListing(scan: ScanResult, store: ScanStore, dirId: number, dirPath: string, cachedChildren: FileNode[], queue: DirJob[], dev: number | undefined): void {
  scan.currentPath = dirPath;
  scan.cachedDirs = (scan.cachedDirs ?? 0) + 1;
  for (const child of cachedChildren) {
    scan.scanned++;
    const childId = store.addNode(dirId, fileNodeToInput(child));
    if (child.type === 'dir') {
      scan.dirCount++;
      queue.push({ id: childId, path: child.path, cached: child, revalidate: true, parentDev: dev });
    } else {
      scan.fileCount++;
      if (child.cloudPlaceholder) {
        scan.cloudFiles = (scan.cloudFiles ?? 0) + 1;
        scan.cloudBytes = (scan.cloudBytes ?? 0) + child.size;
      }
    }
  }
}

/**
 * A folder as the fast-rescan cache holds it: `unlisted` where the scan that wrote it did not list it
 * in full (U-4b L3), or listed it too soon after it last changed for its time to vouch for the
 * listing (`listingSettled`).
 */
type CachedNode = FileNode & { unlisted?: true };

/**
 * The listing a fast rescan may take from the cache for this folder, or null
 * to read it from disk (Track U, U-4b L3). Never one the scan that wrote the
 * cache marked not listed in full — a refusal, a "don't scan" pattern, a
 * failed stat: reused, it would lose `Flag.Unlisted` and read as complete —
 * nor one it marked as read moments after the folder last changed, which a
 * change in the same tick could have left behind unseen (`listingSettled`). And
 * never an empty one, whatever wrote it: gdu and the native engine's per-entry
 * refusals leave a folder they could not read as an empty listing with no
 * mark, and listing a folder that really is empty again costs one call.
 */
function reusableListing(cached: FileNode): FileNode[] | null {
  if ((cached as CachedNode).unlisted === true) return null;
  return cached.children && cached.children.length > 0 ? cached.children : null;
}

/** Tries at a whole cache when the tree keeps changing while it is written. */
const MTIME_CACHE_ATTEMPTS = 3;

/**
 * Persist the completed tree (compact JSON) so future fast rescans can reuse
 * it. A store-backed scan streams it (`streamTreeJson`): the bytes of
 * `JSON.stringify(scan.root)` without building that tree or that string,
 * which froze the app for ~150 ms as a 200,000-entry scan completed. A tree
 * that changes while it is written (a delete, a watcher) is written again from
 * the start, up to MTIME_CACHE_ATTEMPTS times; the file only ever changes by
 * a rename of a whole document. Exported for the tests of that retry.
 *
 * Every folder whose time is not settled by the scan's start (`listingSettled`)
 * is written marked, as one not listed in full is: the next fast rescan lists
 * it again rather than trust a time a same-tick change would have kept.
 */
export async function saveMtimeCache(scan: ScanResult): Promise<void> {
  // The cap bounds the file (48 MB at 200k entries) and the rescan that parses it.
  if (scan.scanned > MTIME_CACHE_MAX_NODES) return;
  // A read-only portable session persists nothing. This cache once built its
  // own path rather than going through storage, and a live portable run
  // proved it was the one remaining leak onto the host after everything else
  // had been redirected; writeFileChunked refuses such a session too.
  if (isEphemeral()) return;
  const name = cacheFileName(scan.rootPath, scan.boundary?.rule ?? DEFAULT_BOUNDARY_RULE);
  try {
    const store = scan.store;
    if (!store) {
      // A bare object tree, with no store behind it, is already built: write it whole.
      const tree = scan.root;
      if (tree) {
        await writeFileChunked(name, async (write) => {
          await write(JSON.stringify(tree));
          return true;
        });
      }
      return;
    }
    const settled = (modifiedAt: number): boolean => listingSettled(modifiedAt, scan.startedAt);
    for (let attempt = 0; attempt < MTIME_CACHE_ATTEMPTS; attempt++) {
      if (await writeFileChunked(name, (write) => streamTreeJson(store, store.rootId, write, { markUnlisted: true, settled }))) return;
    }
    console.warn(`[treemap] mtime cache not saved: the tree changed while it was being written, ${MTIME_CACHE_ATTEMPTS} times`);
  } catch (err) {
    console.error('[treemap] mtime-cache save failed:', err);
  }
}

// statToInput lives in ./scan/nodeInput so the walker and the native engine
// shape every node through one function; cloudProviderFor lives in
// ./cloudFolders so the walker, the gdu mapper and the live index apply one
// gate — a sparse file outside a cloud folder is not a placeholder to any of
// them.

/**
 * What the walk stops at, and what it knows of the mounts (Track U, U-24): the
 * scan's never-descend list, the paths the table listed (for the detector),
 * and the record the walk writes into. A record from before U-24 walks with
 * the fixed list, as every walk did.
 */
interface WalkBounds {
  stop: ReadonlySet<string>;
  listed: ReadonlySet<string>;
  record: ScanBoundaryRecord | null;
}

function walkBoundsOf(scan: ScanResult): WalkBounds {
  const record = scan.boundary ?? null;
  if (!record) return { stop: new Set(neverDescendPaths()), listed: new Set(), record: null };
  return { stop: new Set(record.neverDescend), listed: new Set((record.mounts ?? []).map((m) => m.path)), record };
}

/** A folder's device as the boundary detector reads it; replaceable in tests, which cannot mount anything. */
const statDevice = (_p: string, st: Stats): number => st.dev;
let walkerDevice: (p: string, st: Stats) => number = statDevice;

/** Test seam: the detector reads a folder's device through `fn`; null puts `st.dev` back. */
export function setWalkerDeviceForTests(fn: ((p: string, st: Stats) => number) | null): void {
  walkerDevice = fn ?? statDevice;
}

/**
 * The detector (U-D12): a folder the walk goes into whose device differs from
 * its parent's, and that the mount table did not list, is counted — and walked
 * all the same. A device id never decides whether to descend (P3-3): firmlinks
 * share one, Linux bind mounts share their source's, and every btrfs
 * subvolume has its own.
 */
function noteIfCrossed(bounds: WalkBounds, parentDev: number | undefined, dev: number | undefined, dirPath: string): void {
  if (!bounds.record || parentDev === undefined || dev === undefined || dev === parentDev) return;
  if (!bounds.listed.has(dirPath)) noteCrossedUnlisted(bounds.record, dirPath);
}

async function walk(scan: ScanResult, rootIsDir: boolean, ignore: CompiledIgnore[], cache: Map<string, FileNode> | null): Promise<void> {
  const rootStat = await fsp.lstat(scan.rootPath);
  const store = new PackedScanStore(
    scan.rootPath,
    path.sep,
    statToInput(rootName(scan.rootPath), rootIsDir, rootStat.size, rootStat.mtimeMs, rootStat.atimeMs),
  );
  scan.scanned = 1;
  if (rootIsDir) scan.dirCount = 1;
  else scan.fileCount = 1;

  if (rootIsDir) {
    // Dirs reached through a cached parent's listing get one fresh lstat
    // before their cached listing is trusted — membership is per-scan.
    const root: DirJob = { id: store.rootId, path: scan.rootPath, cached: null, revalidate: false, dev: walkerDevice(scan.rootPath, rootStat) };
    await drainQueue(scan, store, [root], ignore, cache, new Set<string>(), walkBoundsOf(scan));
  }
  if (scan.cancelled) return;
  await rootCheck(scan.rootPath); // ENOENT here is the scan's own error, not a partial result

  store.finalize();
  store.sumSizes();
  settleComplete(scan, store);
}

/**
 * Worker pool: up to CONCURRENCY directories are listed at the same time.
 * Resolves when the queue is empty and every worker has finished.
 */
function drainQueue(scan: ScanResult, store: ScanStore, initial: DirJob[], ignore: CompiledIgnore[], cache: Map<string, FileNode> | null, seen: Set<string>, bounds: WalkBounds): Promise<void> {
  const queue: DirJob[] = [...initial];
  let active = 0;
  // The budget's worker cap: Eco lists two folders at a time, Turbo all of
  // CONCURRENCY. Read at the start and again every CAP_REFRESH_ENTRIES so a
  // budget changed mid-scan shows within about a second.
  let limit = Math.min(CONCURRENCY, workerCap(scan.scanId));
  let capReadAt = scan.scanned;
  // Each in-flight listing borrows a worker slot; the budget's throttle keeps
  // its rest clock per slot, as the native governor does per thread.
  const freeSlots = Array.from({ length: CONCURRENCY }, (_, i) => i);

  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (scan.cancelled) {
        if (active === 0) resolve();
        return;
      }
      if (scan.scanned - capReadAt >= CAP_REFRESH_ENTRIES) {
        limit = Math.min(CONCURRENCY, workerCap(scan.scanId));
        capReadAt = scan.scanned;
      }
      while (active < limit && queue.length > 0) {
        const job = queue.shift()!;
        const slot = freeSlots.pop() ?? active; // never empty: active < limit ≤ CONCURRENCY
        active++;
        processDirectory(scan, store, job, queue, ignore, cache, seen, slot, bounds)
          .catch((err: unknown) => reject(err))
          .finally(() => {
            active--;
            freeSlots.push(slot);
            if (queue.length === 0 && active === 0) resolve();
            else pump();
          });
      }
      if (queue.length === 0 && active === 0) resolve();
    };
    pump();
  });
}

/** A bigint `lstat`, the one the walker's hard-link key reads when a double cannot hold the id. */
export type BigLstat = (p: string) => Promise<{ dev: bigint; ino: bigint }>;

/**
 * The walker's key for a file whose link count says its inode is shared:
 * `${dev}:${ino}`, exact. `Stats` holds ids as doubles, which are exact only
 * below 2^53, and a Windows file id is often past it (a reused NTFS record
 * keeps its sequence number in bits 48..64), where two different files round
 * to one key and one's bytes vanish as the other's duplicate (the pre-landing
 * review of 23 Sep 2026). So an id at or past 2^53 is read once more as a
 * bigint — only for shared files, and only for those ids. A file gone before
 * that second look keeps the key its first stat gave: the walk has already
 * counted it.
 */
export async function hardlinkKey(
  fullPath: string,
  stat: Pick<Stats, 'dev' | 'ino'>,
  lstatBig: BigLstat = (p) => fsp.lstat(p, { bigint: true }),
): Promise<string> {
  if (Number.isSafeInteger(stat.ino)) return `${stat.dev}:${stat.ino}`;
  try {
    const exact = await lstatBig(fullPath);
    return `${exact.dev}:${exact.ino}`;
  } catch {
    return `${stat.dev}:${stat.ino}`;
  }
}

/**
 * List one directory, stat its entries, add children to the store, enqueue
 * subdirs. Permission errors are swallowed per-directory: the dir simply
 * stays empty rather than failing the whole scan.
 */
async function processDirectory(
  scan: ScanResult,
  store: ScanStore,
  job: DirJob,
  queue: DirJob[],
  ignore: CompiledIgnore[],
  cache: Map<string, FileNode> | null,
  seen: Set<string>,
  worker: number,
  bounds: WalkBounds,
): Promise<void> {
  if (scan.cancelled) return;
  // Paused: park here until resumed (or cancelled, which releases the gate).
  if (isScanPaused(scan.scanId)) {
    await whenResumed(scan.scanId);
    if (scan.cancelled) return;
  }
  const { id: dirId, path: dirPath } = job;
  // Track U, U-24: a folder the scan does not descend into is never listed,
  // however the walk was handed it — a cached listing passes on every child it
  // had last time, and a drive may have been mounted there since. Its node
  // stays, an empty folder; nothing inside it is looked at, not even with a
  // stat (a dead mount answers no stat either).
  if (dirId !== store.rootId && bounds.stop.has(dirPath)) return;

  // Incremental: a directory keeps its cached LISTING (its direct entries),
  // skipping the readdir and every per-file stat, only when its own mtime is
  // unchanged and the cache vouches for that time (`reusableListing`): it was
  // more than SETTLED_LISTING_MS older than the start of the scan that wrote
  // the cache (`listingSettled`). An unchanged time alone proves nothing: a
  // create, delete or rename in the same tick of the clock as the change
  // before it can leave the time as it was (CI run 38519159263: a file
  // deleted 80 ms after its folder was listed stayed in every fast rescan).
  // Its subdirectories are still visited, one fresh lstat each: a dir's mtime
  // lives in its own inode and never propagates upward, so substituting whole
  // subtrees on an ancestor's mtime is what made fast rescans miss brand-new
  // files in deep, unchanged-ancestor folders. In-place file edits (same
  // name, new bytes) still go unnoticed — the documented trade-off that makes
  // this opt-in.
  if (job.revalidate) {
    // Reached through a cached parent's listing, so its stats are the CACHE's
    // word, not the disk's — validate before trusting its cached listing.
    const cachedNode = job.cached as FileNode;
    const cachedMtime = cachedNode.modifiedAt;
    let st: Stats;
    try {
      st = await fsp.lstat(dirPath);
    } catch {
      // Vanished since the cache was written. The parent's listing says it
      // exists, so show it empty rather than invent stale contents — the
      // parent's changed mtime makes the next rescan re-list it anyway. It
      // was never listed, so Empty Folders never offers it (U-4).
      markUnlisted(store, dirId);
      return;
    }
    store.setModifiedAt(dirId, Math.round(st.mtimeMs));
    store.setAccessedAt(dirId, st.atimeMs > 0 ? Math.round(st.atimeMs) : undefined);
    job.dev = walkerDevice(dirPath, st);
    noteIfCrossed(bounds, job.parentDev, job.dev, dirPath);
    const listing = reusableListing(cachedNode);
    if (listing && mtimesMatch(cachedMtime, Math.round(st.mtimeMs))) {
      reuseCachedListing(scan, store, dirId, dirPath, listing, queue, job.dev);
      return;
    }
    // Its listing changed — fall through and re-list from disk.
  } else if (cache) {
    // Freshly stat'ed by its parent: compare the disk's mtime to the cache's.
    const cached = cache.get(dirPath);
    const listing = cached && cached.type === 'dir' ? reusableListing(cached) : null;
    if (cached && listing && mtimesMatch(cached.modifiedAt, store.modifiedAt(dirId))) {
      reuseCachedListing(scan, store, dirId, dirPath, listing, queue, job.dev);
      return;
    }
  }
  scan.walkedDirs = (scan.walkedDirs ?? 0) + 1;

  const listed = await readdirWithDeadline(dirPath);
  if (!listed.entries) {
    // The dir still stays empty — but it is now counted (and, for a refusal,
    // named), so the page can say "7 folders couldn't be read" and point at
    // one, rather than folding them into a residual or drawing them as empty.
    // A vanished dir is a race with a delete and accounts for no space at all,
    // but it is counted too: the results are partial, and the page should say so.
    if (listed.why === 'denied') noteRefused(scan, dirPath);
    else if (listed.why === 'vanished') scan.vanishedDirs = (scan.vanishedDirs ?? 0) + 1;
    else scan.unreadableDirs = (scan.unreadableDirs ?? 0) + 1;
    // A drive mounted beneath it was never reached, whichever it was (U-24; noteRefused does the denied).
    if (listed.why !== 'denied') noteUnlistedBelow(scan, dirPath);
    // Childless in the tree, whatever it holds: never offered as empty (U-4).
    markUnlisted(store, dirId);
    return;
  }
  let entries: Dirent[] = listed.entries;

  scan.currentPath = dirPath;

  // Honor the user's "don't scan" list before paying for any lstat calls.
  if (ignore.length > 0) {
    const listedCount = entries.length;
    entries = entries.filter((ent) => !matchesAny(ignore, path.join(dirPath, ent.name), ent.name));
    // What the pattern left out is still in the folder: it is not empty (U-4).
    if (entries.length < listedCount) markUnlisted(store, dirId);
  }

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    // The pause gate sits inside the batch loop, not only per folder: a
    // folder of 100,000 entries would otherwise keep counting for seconds
    // after the person pressed pause.
    if (isScanPaused(scan.scanId)) {
      await whenResumed(scan.scanId);
      if (scan.cancelled) return;
    }
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirPath, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return { input: statToInput(ent.name, true, 0, stat.mtimeMs, stat.atimeMs), fullPath, isDir: true, allocDelta: 0, dev: walkerDevice(fullPath, stat) };
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        const input = statToInput(ent.name, false, stat.size, stat.mtimeMs, stat.atimeMs);
        if (ent.isSymbolicLink()) {
          input.isSymlink = true;
          // Returns BEFORE the shortfall below: a symlink reports a non-zero
          // size against zero blocks, indistinguishable from a fully sparse
          // file, and a home folder holds tens of thousands of them.
          return { input, fullPath, isDir: false, allocDelta: 0 };
        }
        // A cloud placeholder reports a logical size but occupies ~no disk blocks
        // AND lives under a known cloud-sync folder — so plain sparse files
        // (VM images, DB files) are never mislabelled as "cloud-safe to delete".
        if (input.size > 0 && stat.blocks === 0) {
          const provider = cloudProviderFor(fullPath);
          if (provider) {
            input.cloudPlaceholder = true;
            input.cloudProvider = provider;
          }
        }
        // What this file claims, minus what it occupies. Sparse files (a VM
        // disk, Docker.raw) and, on macOS, compressed files land here. It is
        // carried out rather than tallied here because a hard-link duplicate's
        // size is zeroed below — tallying it now would take the same bytes off
        // twice.
        // Signed: negative when the file occupies less than it claims (a VM
        // disk, a compressed file), positive when it occupies more (a small
        // file rounded up to whole pieces of disk). Both halves are needed —
        // the shortfall alone is not a correction, it is half of one, and on a
        // tree of small files the other half is the larger.
        const allocDelta =
          BLOCKS_ARE_MEANINGFUL && input.size > 0 ? stat.blocks * 512 - input.size : 0;
        // Hard-link key only when the link count says the inode is shared.
        const inoKey = stat.nlink > 1 ? await hardlinkKey(fullPath, stat) : undefined;
        return { input, fullPath, isDir: false, allocDelta, inoKey };
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        // Usually a race with a delete, which costs nothing. A refusal is not:
        // it is a real file whose size this user is not allowed to learn.
        const why = classifyFsError(result.reason as NodeJS.ErrnoException);
        if (why === 'denied') scan.deniedEntries = (scan.deniedEntries ?? 0) + 1;
        else if (why !== 'vanished') scan.unreadableEntries = (scan.unreadableEntries ?? 0) + 1;
        // An entry left out but still there: its folder is not empty (U-4). A
        // vanished one is gone, and takes nothing from the folder's listing.
        if (why !== 'vanished') markUnlisted(store, dirId);
        continue;
      }
      const { input, fullPath, isDir, inoKey, allocDelta, dev } = result.value;
      // Dedup hard links sequentially so concurrent workers can't race the set.
      if (inoKey) {
        if (seen.has(inoKey)) {
          input.hardlinkDuplicate = true;
          scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + 1;
          scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + input.size;
          input.size = 0; // first occurrence already counted
        } else {
          seen.add(inoKey);
        }
      }
      if (input.cloudPlaceholder) {
        scan.cloudFiles = (scan.cloudFiles ?? 0) + 1;
        scan.cloudBytes = (scan.cloudBytes ?? 0) + input.size;
      }
      // Space claimed but not occupied. Two exclusions, both arithmetic rather
      // than cosmetic: a hard-link duplicate's bytes were zeroed just above and
      // were never added to the tree total, and a cloud placeholder's bytes are
      // already taken off in full by the cloud line — either one would subtract
      // the same space twice.
      if (allocDelta !== 0 && !input.hardlinkDuplicate && !input.cloudPlaceholder) {
        if (allocDelta < 0) {
          scan.sparseFiles = (scan.sparseFiles ?? 0) + 1;
          scan.sparseBytes = (scan.sparseBytes ?? 0) - allocDelta;
        } else {
          scan.slackBytes = (scan.slackBytes ?? 0) + allocDelta;
        }
      }
      if (isDir && input.name === '.git') store.setFlag(dirId, Flag.GitRepo, true);
      const childId = store.addNode(dirId, input);
      scan.scanned++;
      if (isDir) {
        scan.dirCount++;
        // The scan's never-descend list (utils/mountBoundaries): mount re-entry
        // points, automount triggers and — under "Stay on this drive" — every
        // drive mounted inside the folder stay visible as empty dirs but are
        // never walked; descending double-counts the disk, blocks forever, or
        // counts another disk as this one.
        if (!bounds.stop.has(fullPath)) {
          noteIfCrossed(bounds, job.dev, dev, fullPath);
          queue.push({ id: childId, path: fullPath, cached: null, revalidate: false, dev });
        }
      } else {
        scan.fileCount++;
      }
    }

    if (scan.scanned % YIELD_EVERY < STAT_BATCH) {
      // Explicit yield so progress SSE and other requests get CPU time
      // even while crunching one enormous directory.
      await new Promise<void>((r) => setImmediate(r));
    }
    // The budget: rest in proportion to the work since this worker's previous
    // batch (Eco three parts rest to one of work; Turbo none at all).
    await throttleBatch(scan.scanId, worker);
  }
}

/* ---------- Aggregations over a completed scan ---------- */

/**
 * Steps per slice when the dashboard's lists are walked in slices (Track U,
 * U-17): the cleanup walk's slice, over lighter work per step. After a
 * 9M-entry scan the drained file-type walk held the event loop for 1.8 s and
 * the largest-folders walk for 1.1 s; the routes now take the async forms.
 */
export const COLLECTOR_SLICE_NODES = 16_384;

/**
 * eachFile's walk as one that can stop between any two nodes: the same
 * pre-order, a file visited and never descended into (a container's listing
 * stays invisible), a folder's children in insertion order.
 */
class FileWalk implements SlicedWalk {
  private readonly stack: number[];

  constructor(private readonly store: ScanStore, private readonly visit: (fileId: number) => void) {
    this.stack = [store.rootId];
  }

  step(budget: number): boolean {
    const { store, stack } = this;
    for (let left = budget; stack.length > 0; left--) {
      if (left <= 0) return false;
      const cur = stack.pop() as number;
      if (!store.isDir(cur)) {
        this.visit(cur);
        continue;
      }
      const kids = store.childIds(cur);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return true;
  }
}

/**
 * Every file at or below the root in eachFile's order, walked in slices under
 * U-D9's version guard. `start` begins each attempt and returns its visitor,
 * so whatever a walk the store changed under gathered is thrown away whole.
 */
export async function eachFileInSlices(
  source: TreeSource,
  start: () => (fileId: number) => void,
  options: SliceOptions = {},
): Promise<void> {
  const store = asStore(source);
  await walkInSlices(store, () => new FileWalk(store, start()), options, COLLECTOR_SLICE_NODES);
}

/** collectLargestFiles' bounded insertion, fed one file at a time by either walk. */
function largestFilesTally(store: ScanStore, limit: number, minSize: number) {
  interface Hit { id: number; size: number }
  const top: Hit[] = [];
  return {
    // Simple bounded insertion keeps memory flat even for huge trees.
    visit: (id: number): void => {
      const size = store.size(id);
      if (size < minSize) return;
      if (top.length < limit) {
        top.push({ id, size });
        if (top.length === limit) top.sort((a, b) => b.size - a.size);
      } else if (size > top[top.length - 1].size) {
        top[top.length - 1] = { id, size };
        top.sort((a, b) => b.size - a.size);
      }
    },
    result: () => {
      top.sort((a, b) => b.size - a.size);
      return top.map(({ id, size }) => ({
        name: store.name(id),
        path: store.path(id),
        size,
        extension: store.extension(id),
        modifiedAt: store.modifiedAt(id),
      }));
    },
  };
}

export function collectLargestFiles(source: TreeSource, limit: number, minSize: number) {
  const store = asStore(source);
  const tally = largestFilesTally(store, limit, minSize);
  store.eachFile(store.rootId, tally.visit);
  return tally.result();
}

/** collectLargestFiles walked in slices (U-17): the same answer, the loop handed back between slices. */
export async function collectLargestFilesAsync(source: TreeSource, limit: number, minSize: number, options: SliceOptions = {}) {
  const store = asStore(source);
  let tally = largestFilesTally(store, limit, minSize);
  await eachFileInSlices(store, () => {
    tally = largestFilesTally(store, limit, minSize);
    return tally.visit;
  }, options);
  return tally.result();
}

interface FolderFrame { id: number; kids: number[]; next: number; count: number }

/**
 * collectLargestFolders' post-order walk with an explicit stack (no recursion
 * on deep trees), able to stop between any two steps: entering a node is a
 * step, and so is leaving a folder. Each frame accumulates its subtree's
 * recursive file count as its children finish.
 */
class FolderWalk implements SlicedWalk {
  readonly found: LargeFolder[] = [];
  private readonly stack: FolderFrame[];

  constructor(private readonly store: ScanStore, private readonly minSize: number) {
    this.stack = [this.frame(store.rootId)];
  }

  private frame(id: number): FolderFrame {
    return { id, kids: this.store.isDir(id) ? this.store.childIds(id) : [], next: 0, count: 0 };
  }

  step(budget: number): boolean {
    const { store, stack, found } = this;
    for (let left = budget; stack.length > 0; left--) {
      if (left <= 0) return false;
      const f = stack[stack.length - 1];
      if (!store.isDir(f.id)) {
        // A file (containers included — their listings are not files on disk).
        stack.pop();
        if (stack.length) stack[stack.length - 1].count += 1;
        continue;
      }
      if (f.next < f.kids.length) {
        stack.push(this.frame(f.kids[f.next++]));
        continue;
      }
      stack.pop();
      if (stack.length) {
        const size = store.size(f.id);
        if (size >= this.minSize) {
          found.push({
            name: store.name(f.id),
            path: store.path(f.id),
            size,
            fileCount: f.count,
            modifiedAt: store.modifiedAt(f.id),
          });
        }
        stack[stack.length - 1].count += f.count;
      }
    }
    return true;
  }

  result(limit: number): LargeFolder[] {
    return this.found.sort((a, b) => b.size - a.size).slice(0, limit);
  }
}

export function collectLargestFolders(source: TreeSource, limit: number, minSize: number): LargeFolder[] {
  const walk = new FolderWalk(asStore(source), minSize);
  walk.step(Infinity);
  return walk.result(limit);
}

/** collectLargestFolders walked in slices (U-17): the same answer, the loop handed back between slices. */
export async function collectLargestFoldersAsync(
  source: TreeSource,
  limit: number,
  minSize: number,
  options: SliceOptions = {},
): Promise<LargeFolder[]> {
  const store = asStore(source);
  const { walk } = await walkInSlices(store, () => new FolderWalk(store, minSize), options, COLLECTOR_SLICE_NODES);
  return walk.result(limit);
}

// JUNK_FILES, the junk files that don't stop a folder from counting as empty,
// live in ./emptyFolderCheck, which looks at a folder again on disk by the same rule.
const EMPTY_FOLDERS_CAP = 1000;

/**
 * Directories a tool keeps for itself, and everything beneath them.
 *
 * `.git/refs/tags` and `.git/objects/info` are empty in almost every repository
 * on a disk, so they flooded the list — and an empty directory is worth ~0
 * bytes, so removing them buys nothing while "Select all" quietly reaches into
 * every repo you own. They are git's bookkeeping, not your files.
 */
const TOOL_OWNED_DIRS = new Set(['.git', '.hg', '.svn']);
/**
 * Directories the OS owns and recreates. Trashing the Trash is not a cleanup.
 */
const OS_OWNED_EMPTY_DIRS = new Set(['.trash', '.trashes', '$recycle.bin']);

/**
 * True for a directory whose whole subtree belongs to a tool or an application.
 *
 * The `.app` half is not cosmetic: a bundle ships empty `.lproj` localisation
 * folders by the dozen, and they are inside the code signature's seal. Removing
 * one gains nothing (an empty directory is ~0 bytes) and invalidates the
 * signature, which on macOS means the app stops launching.
 */
function ownsItsContents(name: string): boolean {
  const lower = name.toLowerCase();
  return TOOL_OWNED_DIRS.has(lower) || lower.endsWith('.app');
}

/**
 * TreeMap's own spill folder (`<appData>/` + SPILL_DIR, Phase 4 §S.5.3): owned like a tool's,
 * so neither it nor anything in it is ever offered for the Trash. Asked by `name` (the node's,
 * already read) first, so the path check runs only for a folder that carries the name.
 */
function isTreeMapSpillFolder(store: ScanStore, id: number, name: string): boolean {
  return isSpillFolderName(name) && store.isDir(id) && isSpillPath(store.path(id));
}

/**
 * A second name the system gives a path (macOS's /.nofollow, /.resolve and /.vol: `aliasNamespaceOf`),
 * which a walk of / lists as an empty folder. It is no folder of its own, and the sanitizer refuses a
 * delete naming one (the SEC-2 review, F4), so it is owned like a tool's: never offered nor counted.
 * Decided here, before the list is cut at EMPTY_FOLDERS_CAP — dropped after the cut, one met past it
 * was still counted and still made the list read as cut (the SEC-3 brief, item 7). Second names are
 * names at the root of the boot volume, so only the scan root's own children are asked.
 */
function isSecondNameFolder(store: ScanStore, id: number): boolean {
  return store.parent(id) === store.rootId && store.isDir(id) && aliasNamespaceOf(store.path(id)) !== null;
}

/** What Empty Folders finds in a tree, before anything is looked at again on disk (Track U, U-4). */
export interface EmptyFolderCandidates {
  /**
   * The topmost empty folders, at most EMPTY_FOLDERS_CAP of them. `counted`:
   * how many of `totalCount`'s folders lie at or under it, itself included —
   * what leaves the count when it is withheld. Worked out here, so nothing the
   * walk built is held while the folders are looked at again on disk.
   */
  folders: { name: string; path: string; counted: number }[];
  /** Every reportable empty folder, nested ones included. */
  totalCount: number;
  truncated: boolean;
}

/**
 * Find recursively-empty directories: no files anywhere below (only other
 * empty dirs). With `ignoreJunk`, OS metadata files like .DS_Store don't
 * count as content. Returns only the topmost empty dirs — trashing those
 * removes everything beneath them anyway.
 *
 * A folder the scan did not list in full (`Flag.Unlisted`: refused,
 * unreadable, vanished, never entered, entries left out) is content, never
 * empty, whatever the tree holds under it (U-4, decision U-D12: what was not
 * listed comes from the walk's own records, never from a childless node). So
 * it is never offered or counted, and no folder above it is empty; a folder
 * the scan did list inside it still can be.
 */
export function findEmptyFolders(source: TreeSource, ignoreJunk: boolean): EmptyFolderCandidates {
  const store = asStore(source);
  const count = store.count;

  // Every per-node mark is a byte in a typed array indexed by id (U-4b INFO):
  // a Map or Set of every node throws RangeError past 2^24 entries in V8, and
  // a scan kept in memory can now hold more nodes than that. Four bytes a node.
  // Children carry higher ids than their parents (BFS layout; appends too), so
  // each pass below is one sweep over the ids, in order or in reverse.

  // Which nodes the pass looks at. Reachability mirrors the original walk —
  // descend through dirs only, so a container file's virtual listing never
  // participates, and a removed node (no longer anyone's child) is not reached.
  const reached = new Uint8Array(count);
  // A folder with a child numbered at or below it is content, fail-closed (U-4b review, INFO): the
  // sweeps settle a node only after its parent, which such a child breaks; it and its subtree are
  // not reached, so nothing in them is offered.
  const outOfOrder = new Uint8Array(count);
  reached[store.rootId] = 1;
  for (let id = 0; id < count; id++) {
    if (reached[id] === 1 && store.isDir(id)) store.forEachChild(id, (c) => { if (c > id) reached[c] = 1; else outOfOrder[id] = 1; });
  }

  // Pass 1, bottom-up: a dir is empty when every child is junk or an empty
  // dir. One reverse sweep resolves children before parents.
  const empty = new Uint8Array(count);
  for (let id = 0; id < count; id++) {
    if (reached[id] !== 1) continue;
    const isEmpty = store.isDir(id) ? !store.flag(id, Flag.Unlisted) && outOfOrder[id] === 0 : ignoreJunk && JUNK_FILES.has(store.name(id).toLowerCase());
    if (isEmpty) empty[id] = 1;
  }
  for (let id = count - 1; id >= 0; id--) {
    if (reached[id] !== 1 || id === store.rootId) continue;
    if (empty[id] === 0) empty[store.parent(id)] = 0;
  }
  // Which nodes a tool owns. One forward sweep settles a parent before any of
  // its children ask about it — no second traversal, no recursion.
  const toolOwned = new Uint8Array(count);
  // A scan rooted in the spill folder (or below it) owns nothing it could offer.
  const rootInSpill = isSpillPath(store.path(store.rootId));
  for (let id = 0; id < count; id++) {
    if (reached[id] !== 1 || id === store.rootId) continue;
    if (rootInSpill || toolOwned[store.parent(id)] === 1) {
      toolOwned[id] = 1;
      continue;
    }
    const name = store.name(id);
    if (ownsItsContents(name) || isTreeMapSpillFolder(store, id, name) || isSecondNameFolder(store, id)) toolOwned[id] = 1;
  }
  /** Reportable = empty, and not something a tool or the OS keeps for itself. */
  const reportable = (id: number): boolean =>
    id !== store.rootId && store.isDir(id) && empty[id] === 1 &&
    toolOwned[id] === 0 && !OS_OWNED_EMPTY_DIRS.has(store.name(id).toLowerCase());

  let totalCount = 0;
  for (let id = 0; id < count; id++) {
    if (reached[id] === 1 && reportable(id)) totalCount++;
  }

  // Pass 2, top-down: report only topmost empty dirs (their whole subtree is
  // empty, so trashing the top one is sufficient) and stop descending there.
  // Iterator frames reproduce the original recursion's emission order exactly
  // (descend into a non-empty dir before examining its later siblings).
  /** Reportable folders at or under `id`, an empty one: its subtree is empty folders and junk, so this walk is small. */
  const countedUnder = (id: number): number => {
    let n = 0;
    const walk: number[] = [id];
    while (walk.length) {
      const cur = walk.pop() as number;
      if (reportable(cur)) n++;
      if (store.isDir(cur)) for (const c of store.childIds(cur)) walk.push(c);
    }
    return n;
  };

  const topmost: { name: string; path: string; counted: number }[] = [];
  let truncated = false;
  interface Frame { kids: number[]; next: number }
  const stack: Frame[] = [{ kids: store.childIds(store.rootId), next: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.next >= f.kids.length) {
      stack.pop();
      continue;
    }
    const c = f.kids[f.next++];
    if (!store.isDir(c)) continue;
    if (empty[c] === 1) {
      // An empty dir a tool owns is skipped outright rather than descended
      // into — its whole subtree is empty by definition, so there is nothing
      // reportable below it either.
      if (!reportable(c)) continue;
      if (topmost.length < EMPTY_FOLDERS_CAP) topmost.push({ name: store.name(c), path: store.path(c), counted: countedUnder(c) });
      else truncated = true;
    } else {
      stack.push({ kids: store.childIds(c), next: 0 });
    }
  }

  return { folders: topmost, totalCount, truncated };
}

/** findEmptyFolders as the tree alone answers it: the topmost empty folders, the count, and whether the list was cut. */
export function collectEmptyFolders(source: TreeSource, ignoreJunk: boolean): EmptyFoldersResult {
  const { folders, totalCount, truncated } = findEmptyFolders(source, ignoreJunk);
  return { folders: folders.map(({ name, path: p }) => ({ name, path: p })), totalCount, truncated };
}

const COMPARE_CAP = 1000;

/**
 * Structural diff of two scans of the same root. Subtrees present in only
 * one scan collapse to a single added/removed entry (a new node_modules is
 * one row, not ten thousand); files present in both are emitted when their
 * size changed. Directories present in both are never emitted themselves —
 * their change is fully explained by the child entries.
 */
export function compareTrees(sourceA: TreeSource, sourceB: TreeSource): { entries: CompareEntry[]; truncated: boolean } {
  const a = asStore(sourceA);
  const b = asStore(sourceB);
  const entries: CompareEntry[] = [];

  const emit = (store: ScanStore, id: number, childPath: string, sizeA: number | null, sizeB: number | null): void => {
    const delta = (sizeB ?? 0) - (sizeA ?? 0);
    if (delta === 0 && sizeA !== null && sizeB !== null) return;
    entries.push({
      path: childPath,
      name: store.name(id),
      type: store.nodeType(id),
      sizeA,
      sizeB,
      delta,
      change: sizeA === null ? 'added' : sizeB === null ? 'removed' : delta > 0 ? 'grew' : 'shrank',
    });
  };

  // Same recursion the object version used (depth = tree depth, as before);
  // parent paths thread down so nothing walks parent chains per node.
  const recurse = (aId: number, bId: number, dirPath: string): void => {
    const aChildren = new Map<string, number>();
    for (const c of a.childIds(aId)) aChildren.set(a.name(c), c);

    for (const cb of b.childIds(bId)) {
      const name = b.name(cb);
      const childPath = b.childPath(cb, dirPath);
      const ca = aChildren.get(name);
      if (ca === undefined) {
        emit(b, cb, childPath, null, b.size(cb)); // appeared between scans
        continue;
      }
      aChildren.delete(name);
      if (a.isDir(ca) && b.isDir(cb)) {
        recurse(ca, cb, childPath);
      } else if (a.size(ca) !== b.size(cb) || a.nodeType(ca) !== b.nodeType(cb)) {
        emit(b, cb, childPath, a.size(ca), b.size(cb));
      }
    }
    for (const [name, ca] of aChildren) {
      emit(a, ca, a.childPath(ca, dirPath), a.size(ca), null); // disappeared between scans
    }
  };

  recurse(a.rootId, b.rootId, b.rootPath);
  entries.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { entries: entries.slice(0, COMPARE_CAP), truncated: entries.length > COMPARE_CAP };
}

/** collectFileTypes' per-extension tally, fed one file at a time by either walk. */
function fileTypesTally(store: ScanStore) {
  const byExt = new Map<string, { count: number; totalSize: number }>();
  return {
    visit: (id: number): void => {
      const ext = store.extension(id) ?? '(none)';
      const entry = byExt.get(ext) ?? { count: 0, totalSize: 0 };
      entry.count++;
      entry.totalSize += store.size(id);
      byExt.set(ext, entry);
    },
    result: () => [...byExt.entries()]
      .map(([ext, v]) => ({ ext, count: v.count, totalSize: v.totalSize }))
      .sort((a, b) => b.totalSize - a.totalSize),
  };
}

export function collectFileTypes(source: TreeSource) {
  const store = asStore(source);
  const tally = fileTypesTally(store);
  store.eachFile(store.rootId, tally.visit);
  return tally.result();
}

/** collectFileTypes walked in slices (U-17): the same answer, the loop handed back between slices. */
export async function collectFileTypesAsync(source: TreeSource, options: SliceOptions = {}) {
  const store = asStore(source);
  let tally = fileTypesTally(store);
  await eachFileInSlices(store, () => {
    tally = fileTypesTally(store);
    return tally.visit;
  }, options);
  return tally.result();
}
