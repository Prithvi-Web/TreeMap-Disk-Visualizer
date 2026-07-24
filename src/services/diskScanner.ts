import { promises as fsp, Dirent, Stats } from "fs";
import path from "path";
import crypto from "crypto";
import {
  FileNode,
  ScanResult,
  LargeFolder,
  EmptyFoldersResult,
  CompareEntry,
} from "../models/types";
import { saveSnapshot } from "./snapshots";
import { getIgnoreMatchers } from "./settings";
import { CompiledIgnore, matchesAny } from "../utils/glob";
import { readJsonFile, appDataDir } from "./storage";
import { IO_THREADS } from "../utils/ioThreads";
import { detectContainerKind } from "../utils/containerKind";
import { neverDescend } from "../utils/mountBoundaries";
import { forgetScan } from "./containerScanner";
import { findGduBinary, gduScanIntoStore } from "./gduScanner";
import {
  findNtfsMftBinary,
  ntfsMftScanIntoStore,
  isNtfsVolume,
  NtfsMftCancelledError,
} from "./ntfsMftScanner";
import { mergeScanTimingExtras, recordScanTimingAsync } from "./scanTimingLog";
import {
  PackedScanStore,
  ScanStore,
  Flag,
  NodeInput,
  fileNodeToInput,
  buildStoreFromTree,
  asStore,
  TreeSource,
} from "./scanStore";

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
const STAT_BATCH = IO_THREADS > 4 ? 64 : 32;
/** Yield to the event loop after this many entries so SSE stays responsive. */
const YIELD_EVERY = 2000;

/**
 * A directory that can't answer a listing (dead network mount, wedged
 * permission broker) must cost one worker slot a bounded time — not the whole
 * scan. The orphaned call keeps its libuv slot until the OS lets go, so this
 * is a net for rare pathologies; the mount-boundary skip list keeps the scan
 * from walking into the known ones at all.
 */
const READDIR_DEADLINE_MS = 30_000;

function readdirWithDeadline(p: string): Promise<Dirent[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[treemap] readdir gave up after ${READDIR_DEADLINE_MS / 1000}s: ${p}`,
      );
      resolve(null);
    }, READDIR_DEADLINE_MS);
    timer.unref();
    fsp.readdir(p, { withFileTypes: true }).then(
      (entries) => {
        clearTimeout(timer);
        resolve(entries);
      },
      () => {
        clearTimeout(timer);
        resolve(null); // EACCES / EPERM / ENOENT(race) — skip silently
      },
    );
  });
}

const SCAN_TTL_MS = 30 * 60 * 1000; // 30 minutes after a scan settles
/**
 * A 'running' record left wedged by a driver that died (cloud scans register
 * here too) must still be collected eventually — but at a horizon no real
 * scan can hit, because evicting by age alone cancelled slow full-disk walks
 * mid-flight: the record vanished while its status froze at 'running', the
 * progress stream never finished, and the UI spun forever.
 */
const RUNNING_SCAN_HARD_CAP_MS = 6 * 60 * 60 * 1000;
const EVICT_INTERVAL_MS = 60 * 1000;

/** In-memory store of all scans, auto-evicted after 30 minutes. */
const scans = new Map<string, ScanResult>();

/** True when a scan's retention window has passed. Running scans only expire
 *  at the wedge horizon; settled ones 30 minutes after they finished. */
export function scanExpired(scan: ScanResult, now: number): boolean {
  if (scan.status === "running")
    return now - scan.createdAt > RUNNING_SCAN_HARD_CAP_MS;
  return now - (scan.finishedAt ?? scan.createdAt) > SCAN_TTL_MS;
}

let evictTimer: NodeJS.Timeout | null = null;

function ensureEvictor(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, scan] of scans) {
      if (scanExpired(scan, now)) {
        scan.cancelled = true;
        scans.delete(id);
        forgetScan(id); // drop its expanded-container registry too
      }
    }
  }, EVICT_INTERVAL_MS);
  // Don't let the evictor keep the process alive on shutdown.
  evictTimer.unref();
}

export function getScan(scanId: string): ScanResult | undefined {
  return scans.get(scanId);
}

export function allScans(): ScanResult[] {
  return [...scans.values()];
}

export function cancelAllScans(): void {
  for (const scan of scans.values()) {
    if (scan.status !== "running") continue;
    scan.cancelled = true;
    try {
      scan.abort?.();
    } catch {
      /* ignore */
    }
    scan.abort = undefined;
  }
}

/** Cooperative cancel for one scan. The walker/gdu/ntfs engines poll
 *  `scan.cancelled` and call finalizeCancelled when they exit. */
export function cancelScan(scanId: string): boolean {
  const scan = scans.get(scanId);
  if (!scan || scan.status !== "running") return false;
  scan.cancelled = true;
  const abort = scan.abort;
  if (abort) {
    try {
      abort();
    } catch (err) {
      console.warn("[treemap] scan abort handler failed:", err);
    }
    scan.abort = undefined;
  }
  return true;
}

/** Mark a cancelled-but-still-`running` record as finished so SSE/clients
 *  stop waiting. Idempotent if status already left `running`. */
export function finalizeCancelled(scan: ScanResult): void {
  if (scan.status !== "running") return;
  scan.abort = undefined;
  scan.status = "cancelled";
  scan.finishedAt = Date.now();
  recordScanTimingAsync(scan);
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
  Object.defineProperty(scan, "root", {
    enumerable: true,
    configurable: true,
    get(): FileNode | undefined {
      if (legacy) return legacy;
      const store = scan.store;
      if (!store) return undefined;
      return store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER })
        .root;
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
    status: "running",
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
  };
  defineRootAccessor(scan);
  scans.set(scan.scanId, scan);
  return scan;
}

/**
 * Kick off a scan of `rootPath`. Returns the scan record immediately;
 * the walk continues in the background and mutates the record as it goes.
 */
export interface ScanOptions {
  /** Reuse the on-disk mtime cache to skip unchanged subtrees (fast rescan). */
  incremental?: boolean;
  /** Explicit opt-in only — see docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md §3.5.
   *  Never auto-triggered: unlike every other engine, this one produces a
   *  real UAC prompt, so it must never fire without the user asking for it. */
  ntfsMft?: boolean;
}

export async function startScan(
  rootPath: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  ensureEvictor();

  // Fail fast on unreadable/nonexistent roots so the API can 4xx properly.
  const rootStat = await fsp.lstat(rootPath);

  // User-configured "don't scan" patterns; a settings problem never blocks a scan.
  const ignore = await getIgnoreMatchers("scan").catch(
    () => [] as CompiledIgnore[],
  );

  // Incremental rescan: load the previous tree so unchanged directories (same
  // mtime) can be substituted from cache instead of re-walked.
  let cache: Map<string, FileNode> | null = null;
  if (opts.incremental) {
    const cachedRoot = await readJsonFile<FileNode | null>(
      cacheFileName(rootPath),
      null,
    );
    if (
      cachedRoot &&
      cachedRoot.path === rootPath &&
      cachedRoot.type === "dir"
    ) {
      cache = buildDirCache(cachedRoot);
    }
  }

  const scan: ScanResult = {
    scanId: crypto.randomUUID(),
    rootPath,
    status: "running",
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
    engine: IO_THREADS > 4 ? "turbo-walker" : "walker",
    ioThreads: IO_THREADS,
    incremental: !!cache,
    cachedDirs: 0,
    walkedDirs: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
  };
  defineRootAccessor(scan);
  scans.set(scan.scanId, scan);
  mergeScanTimingExtras(scan.scanId, {
    ntfsMftRequested: opts.ntfsMft === true,
  });

  /**
   * The gdu turbo engine is preferred (~112-120k items/sec sharded, vs the
   * walker's 69-97k) but only where it can be exactly as correct as the walker:
   *
   *  - directories only (a single-file "scan" isn't worth a subprocess);
   *  - not incremental — the mtime cache is built around the walker's
   *    per-directory reuse and gdu has no equivalent;
   *  - no ignore list — gdu's -i/-I cannot faithfully express this app's glob
   *    patterns, and quietly scanning something the user excluded is worse than
   *    being slower. Fall back rather than approximate.
   */
  const gduEligible =
    rootStat.isDirectory() &&
    !cache &&
    !opts.incremental &&
    ignore.length === 0 &&
    process.env.TREEMAP_NO_GDU !== "1";

  /**
   * ntfs-mft is tried before gdu when opted in — it's faster than gdu on NTFS
   * because it reads the MFT directly instead of spawning a walking
   * subprocess. Same gates as gdu (directory only, no cache/incremental, no
   * ignore list — raw MFT enumeration has even less ability than gdu to honor
   * glob ignore patterns) plus the explicit opt-in and a platform/filesystem
   * check that must never itself require elevation.
   */
  const ntfsMftRequested =
    process.platform === "win32" &&
    opts.ntfsMft === true &&
    rootStat.isDirectory() &&
    !cache &&
    !opts.incremental &&
    ignore.length === 0 &&
    process.env.TREEMAP_NO_NTFS_MFT !== "1";

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void (async () => {
    // Windows absolute paths look like `C:\Users\foo` — drive letter at [0],
    // path under the volume root after the `C:\` prefix (slice(3)).
    if (ntfsMftRequested && (await isNtfsVolume(rootPath[0]))) {
      try {
        if (process.env.TREEMAP_NO_NTFS_MFT_BIN !== "1") {
          const bin = await findNtfsMftBinary();
          if (!bin) throw new Error("ntfs-mft-scan binary not found");
        } else {
          throw new Error("test escape hatch: binary unavailable");
        }
        scan.engine = "ntfs-mft";
        const driveLetter = rootPath[0];
        const components = rootPath.slice(3).split(path.sep).filter(Boolean); // strip "C:\"
        const store = await ntfsMftScanIntoStore(scan, driveLetter, components);
        if (scan.cancelled) {
          finalizeCancelled(scan);
          return;
        }
        scan.store = store;
        scan.status = "complete";
        scan.finishedAt = Date.now();
        scan.currentPath = scan.rootPath;
        recordScanTimingAsync(scan);
        void saveMtimeCache(scan);
        void saveSnapshot(scan).catch((err: unknown) => {
          console.error("[treemap] snapshot save failed:", err);
        });
        return;
      } catch (err) {
        if (err instanceof NtfsMftCancelledError || scan.cancelled) {
          finalizeCancelled(scan);
          return;
        }
        // Same discipline as gdu: never surface as a scan error, always reset
        // counters before falling through so the next engine doesn't double-count.
        // cloudFiles/cloudBytes are included for structural symmetry with gdu's
        // catch — ntfs-mft never sets them (still 0 from construction); hygiene,
        // not a fix for observed counter corruption.
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[treemap] ntfs-mft engine unavailable, trying gdu/walker: ${detail}`,
        );
        // Clear the premature 'ntfs-mft' tag and surface why for the UI.
        scan.engine = IO_THREADS > 4 ? "turbo-walker" : "walker";
        scan.engineDetail = `Turbo NTFS failed — ${detail}`;
        scan.fileCount = 0;
        scan.dirCount = 0;
        scan.scanned = 0;
        scan.hardlinkedFiles = 0;
        scan.hardlinkedBytes = 0;
        scan.cloudFiles = 0;
        scan.cloudBytes = 0;
      }
    }
    if (gduEligible) {
      try {
        const bin = await findGduBinary();
        if (bin) {
          scan.engine = "gdu-turbo";
          const store = await gduScanIntoStore(scan, bin, cloudProviderFor);
          if (scan.cancelled) {
            finalizeCancelled(scan);
            return;
          }
          scan.store = store;
          scan.status = "complete";
          scan.finishedAt = Date.now();
          scan.currentPath = scan.rootPath;
          recordScanTimingAsync(scan);
          void saveMtimeCache(scan);
          void saveSnapshot(scan).catch((err: unknown) => {
            console.error("[treemap] snapshot save failed:", err);
          });
          return;
        }
      } catch (err) {
        if (scan.cancelled) {
          finalizeCancelled(scan);
          return; // cancellation is not a gdu failure
        }
        // gdu is strictly best-effort: a missing binary, a spawn failure, a
        // non-zero exit or an oversized shard must never surface as a scan
        // error. Log it and let the walker produce the scan.
        console.warn(
          `[treemap] gdu engine unavailable, using walker: ${String(err)}`,
        );
        // Discard whatever the aborted attempt accumulated so the walker
        // doesn't double-count on top of it.
        scan.fileCount = 0;
        scan.dirCount = 0;
        scan.scanned = 0;
        scan.hardlinkedFiles = 0;
        scan.hardlinkedBytes = 0;
        scan.cloudFiles = 0;
        scan.cloudBytes = 0;
      }
      scan.engine = IO_THREADS > 4 ? "turbo-walker" : "walker";
    }
    await walk(scan, rootStat.isDirectory(), ignore, cache);
    if (scan.cancelled) finalizeCancelled(scan);
  })().catch((err: unknown) => {
    if (scan.cancelled) {
      finalizeCancelled(scan);
      return;
    }
    scan.status = "error";
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
    recordScanTimingAsync(scan);
  });

  return scan;
}

/* ---------- Incremental (fast) rescan cache ---------- */

const MTIME_CACHE_MAX_NODES = 300_000;

/** Stable per-root cache filename in the app-data directory. */
function cacheFileName(rootPath: string): string {
  const h = crypto
    .createHash("sha1")
    .update(rootPath)
    .digest("hex")
    .slice(0, 16);
  return `mtime-cache-${h}.json`;
}

/** Index every directory of a cached tree by path for O(1) substitution. */
function buildDirCache(root: FileNode): Map<string, FileNode> {
  const map = new Map<string, FileNode>();
  const stack: FileNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "dir") {
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
}

/**
 * Reuse a validated directory's cached listing: build its direct children
 * into the store and enqueue each subdirectory for its own revalidation
 * visit. Counter semantics mirror a fresh listing (scanned/dirCount/
 * fileCount); as before, cloud and hardlink tallies are not re-derived from
 * cached files — their sizes and flags ride along in the nodes themselves.
 */
function reuseCachedListing(
  scan: ScanResult,
  store: ScanStore,
  dirId: number,
  dirPath: string,
  cachedChildren: FileNode[],
  queue: DirJob[],
): void {
  scan.currentPath = dirPath;
  scan.cachedDirs = (scan.cachedDirs ?? 0) + 1;
  for (const child of cachedChildren) {
    scan.scanned++;
    const childId = store.addNode(dirId, fileNodeToInput(child));
    if (child.type === "dir") {
      scan.dirCount++;
      queue.push({
        id: childId,
        path: child.path,
        cached: child,
        revalidate: true,
      });
    } else {
      scan.fileCount++;
    }
  }
}

/** Persist the completed tree (compact JSON) so future fast rescans can reuse it. */
async function saveMtimeCache(scan: ScanResult): Promise<void> {
  // Size gate first: for store-backed scans, reading `scan.root` materializes
  // an object tree, so it must only ever happen under the 300k-node cap.
  if (scan.scanned > MTIME_CACHE_MAX_NODES) return;
  const tree = scan.root;
  if (!tree) return;
  try {
    const dir = appDataDir();
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, cacheFileName(scan.rootPath));
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(tree), "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    console.error("[treemap] mtime-cache save failed:", err);
  }
}

/** Everything lstat tells us about one entry, shaped for store.addNode. */
function statToInput(
  name: string,
  isDir: boolean,
  size: number,
  mtimeMs: number,
  atimeMs?: number,
): NodeInput {
  const input: NodeInput = {
    name,
    isDir,
    size: isDir ? 0 : size,
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith("."),
  };
  // atime === 0 means "never recorded" on several filesystems — omit rather
  // than let a 1970 date surface anywhere.
  if (atimeMs !== undefined && atimeMs > 0)
    input.accessedAt = Math.round(atimeMs);
  if (!isDir) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, "");
    if (ext) input.extension = ext;
  }
  const container = detectContainerKind(name, isDir);
  if (container) input.container = container;
  return input;
}

/** Infer a cloud provider for a placeholder file from its path. */
function cloudProviderFor(
  p: string,
): "icloud" | "onedrive" | "dropbox" | undefined {
  if (/Library\/Mobile Documents|com~apple~CloudDocs|\.icloud$/i.test(p))
    return "icloud";
  if (/OneDrive/i.test(p)) return "onedrive";
  if (/Dropbox/i.test(p)) return "dropbox";
  return undefined;
}

async function walk(
  scan: ScanResult,
  rootIsDir: boolean,
  ignore: CompiledIgnore[],
  cache: Map<string, FileNode> | null,
): Promise<void> {
  const rootStat = await fsp.lstat(scan.rootPath);
  const store = new PackedScanStore(
    scan.rootPath,
    path.sep,
    statToInput(
      path.basename(scan.rootPath) || scan.rootPath,
      rootIsDir,
      rootStat.size,
      rootStat.mtimeMs,
      rootStat.atimeMs,
    ),
  );
  scan.scanned = 1;
  if (rootIsDir) scan.dirCount = 1;
  else scan.fileCount = 1;

  if (rootIsDir) {
    // Dirs reached through a cached parent's listing get one fresh lstat
    // before their cached listing is trusted — membership is per-scan.
    await drainQueue(
      scan,
      store,
      [
        {
          id: store.rootId,
          path: scan.rootPath,
          cached: null,
          revalidate: false,
        },
      ],
      ignore,
      cache,
      new Set<string>(),
    );
  }
  if (scan.cancelled) {
    finalizeCancelled(scan);
    return;
  }

  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = "complete";
  scan.finishedAt = Date.now();
  scan.currentPath = scan.rootPath;
  recordScanTimingAsync(scan);

  // Persist the tree for future fast rescans, then snapshot for Trends.
  // Failures here must never fail the scan itself.
  void saveMtimeCache(scan);
  void saveSnapshot(scan).catch((err: unknown) => {
    console.error("[treemap] snapshot save failed:", err);
  });
}

/**
 * Worker pool: up to CONCURRENCY directories are listed at the same time.
 * Resolves when the queue is empty and every worker has finished.
 */
function drainQueue(
  scan: ScanResult,
  store: ScanStore,
  initial: DirJob[],
  ignore: CompiledIgnore[],
  cache: Map<string, FileNode> | null,
  seen: Set<string>,
): Promise<void> {
  const queue: DirJob[] = [...initial];
  let active = 0;

  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (scan.cancelled) {
        if (active === 0) resolve();
        return;
      }
      while (active < CONCURRENCY && queue.length > 0) {
        const job = queue.shift()!;
        active++;
        processDirectory(scan, store, job, queue, ignore, cache, seen)
          .catch((err: unknown) => reject(err))
          .finally(() => {
            active--;
            if (queue.length === 0 && active === 0) resolve();
            else pump();
          });
      }
      if (queue.length === 0 && active === 0) resolve();
    };
    pump();
  });
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
): Promise<void> {
  if (scan.cancelled) return;
  const { id: dirId, path: dirPath } = job;

  // Incremental: a directory whose own mtime is unchanged keeps its cached
  // LISTING (its direct entries — a create/delete/rename would have bumped
  // the mtime), skipping the readdir and every per-file stat. Its
  // subdirectories are still visited, one fresh lstat each: a dir's mtime
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
      // parent's changed mtime makes the next rescan re-list it anyway.
      return;
    }
    store.setModifiedAt(dirId, Math.round(st.mtimeMs));
    store.setAccessedAt(
      dirId,
      st.atimeMs > 0 ? Math.round(st.atimeMs) : undefined,
    );
    if (
      cachedNode.children &&
      mtimesMatch(cachedMtime, Math.round(st.mtimeMs))
    ) {
      reuseCachedListing(
        scan,
        store,
        dirId,
        dirPath,
        cachedNode.children,
        queue,
      );
      return;
    }
    // Its listing changed — fall through and re-list from disk.
  } else if (cache) {
    // Freshly stat'ed by its parent: compare the disk's mtime to the cache's.
    const cached = cache.get(dirPath);
    if (
      cached &&
      cached.type === "dir" &&
      cached.children &&
      mtimesMatch(cached.modifiedAt, store.modifiedAt(dirId))
    ) {
      reuseCachedListing(scan, store, dirId, dirPath, cached.children, queue);
      return;
    }
  }
  scan.walkedDirs = (scan.walkedDirs ?? 0) + 1;

  const listed = await readdirWithDeadline(dirPath);
  if (!listed) return; // unreadable or unresponsive — the dir stays empty
  let entries: Dirent[] = listed;

  scan.currentPath = dirPath;

  // Honor the user's "don't scan" list before paying for any lstat calls.
  if (ignore.length > 0) {
    entries = entries.filter(
      (ent) => !matchesAny(ignore, path.join(dirPath, ent.name), ent.name),
    );
  }

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirPath, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return {
            input: statToInput(ent.name, true, 0, stat.mtimeMs, stat.atimeMs),
            fullPath,
            isDir: true,
          };
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        const input = statToInput(
          ent.name,
          false,
          stat.size,
          stat.mtimeMs,
          stat.atimeMs,
        );
        if (ent.isSymbolicLink()) {
          input.isSymlink = true;
          return { input, fullPath, isDir: false };
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
        // Hard-link key only when the link count says the inode is shared.
        return {
          input,
          fullPath,
          isDir: false,
          inoKey: stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : undefined,
        };
      }),
    );

    for (const result of settled) {
      if (result.status !== "fulfilled") continue; // entry vanished mid-scan
      const { input, fullPath, isDir, inoKey } = result.value;
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
      if (isDir && input.name === ".git")
        store.setFlag(dirId, Flag.GitRepo, true);
      const childId = store.addNode(dirId, input);
      scan.scanned++;
      if (isDir) {
        scan.dirCount++;
        // Mount re-entry points and automount triggers stay visible as empty
        // dirs but are never walked — descending double-counts the disk or
        // blocks forever (see utils/mountBoundaries).
        if (!neverDescend(fullPath))
          queue.push({
            id: childId,
            path: fullPath,
            cached: null,
            revalidate: false,
          });
      } else {
        scan.fileCount++;
      }
    }

    if (scan.scanned % YIELD_EVERY < STAT_BATCH) {
      // Explicit yield so progress SSE and other requests get CPU time
      // even while crunching one enormous directory.
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/* ---------- Aggregations over a completed scan ---------- */

export function collectLargestFiles(
  source: TreeSource,
  limit: number,
  minSize: number,
) {
  const store = asStore(source);
  interface Hit {
    id: number;
    size: number;
  }
  const top: Hit[] = [];
  // Simple bounded insertion keeps memory flat even for huge trees.
  store.eachFile(store.rootId, (id) => {
    const size = store.size(id);
    if (size < minSize) return;
    if (top.length < limit) {
      top.push({ id, size });
      if (top.length === limit) top.sort((a, b) => b.size - a.size);
    } else if (size > top[top.length - 1].size) {
      top[top.length - 1] = { id, size };
      top.sort((a, b) => b.size - a.size);
    }
  });
  top.sort((a, b) => b.size - a.size);
  return top.map(({ id, size }) => ({
    name: store.name(id),
    path: store.path(id),
    size,
    extension: store.extension(id),
    modifiedAt: store.modifiedAt(id),
  }));
}

export function collectLargestFolders(
  source: TreeSource,
  limit: number,
  minSize: number,
): LargeFolder[] {
  const store = asStore(source);
  const found: LargeFolder[] = [];
  // Post-order with an explicit stack (no recursion on deep trees): each
  // frame accumulates its subtree's recursive file count as children finish.
  interface Frame {
    id: number;
    kids: number[];
    next: number;
    count: number;
  }
  const frame = (id: number): Frame => ({
    id,
    kids: store.isDir(id) ? store.childIds(id) : [],
    next: 0,
    count: 0,
  });
  const stack: Frame[] = [frame(store.rootId)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (!store.isDir(f.id)) {
      // A file (containers included — their listings are not files on disk).
      stack.pop();
      if (stack.length) stack[stack.length - 1].count += 1;
      continue;
    }
    if (f.next < f.kids.length) {
      stack.push(frame(f.kids[f.next++]));
      continue;
    }
    stack.pop();
    if (stack.length) {
      const size = store.size(f.id);
      if (size >= minSize) {
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
  return found.sort((a, b) => b.size - a.size).slice(0, limit);
}

/** Junk files that don't stop a folder from counting as empty. */
const JUNK_FILES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  ".localized",
]);
const EMPTY_FOLDERS_CAP = 1000;

/**
 * Find recursively-empty directories: no files anywhere below (only other
 * empty dirs). With `ignoreJunk`, OS metadata files like .DS_Store don't
 * count as content. Returns only the topmost empty dirs — trashing those
 * removes everything beneath them anyway.
 */
export function collectEmptyFolders(
  source: TreeSource,
  ignoreJunk: boolean,
): EmptyFoldersResult {
  const store = asStore(source);

  // Pass 1, bottom-up: a dir is empty when every child is junk or an empty
  // dir. Reachability mirrors the original walk — descend through dirs only,
  // so a container file's virtual listing never participates. Children carry
  // higher ids than their parents (BFS layout; appends too), so one reverse
  // pass over the reachable ids resolves children before parents.
  const ordered: number[] = [];
  {
    const walk: number[] = [store.rootId];
    while (walk.length) {
      const id = walk.pop() as number;
      ordered.push(id);
      if (store.isDir(id)) for (const c of store.childIds(id)) walk.push(c);
    }
    ordered.sort((a, b) => a - b);
  }
  const empty = new Map<number, boolean>();
  for (const id of ordered) {
    empty.set(
      id,
      store.isDir(id)
        ? true
        : ignoreJunk && JUNK_FILES.has(store.name(id).toLowerCase()),
    );
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const id = ordered[i];
    if (id === store.rootId) continue;
    const p = store.parent(id);
    if (!empty.get(id) && empty.get(p)) empty.set(p, false);
  }
  let totalCount = 0;
  for (const id of ordered) {
    if (id !== store.rootId && store.isDir(id) && empty.get(id)) totalCount++;
  }

  // Pass 2, top-down: report only topmost empty dirs (their whole subtree is
  // empty, so trashing the top one is sufficient) and stop descending there.
  // Iterator frames reproduce the original recursion's emission order exactly
  // (descend into a non-empty dir before examining its later siblings).
  const topmost: { name: string; path: string }[] = [];
  let truncated = false;
  interface Frame {
    kids: number[];
    next: number;
  }
  const stack: Frame[] = [{ kids: store.childIds(store.rootId), next: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.next >= f.kids.length) {
      stack.pop();
      continue;
    }
    const c = f.kids[f.next++];
    if (!store.isDir(c)) continue;
    if (empty.get(c)) {
      if (topmost.length < EMPTY_FOLDERS_CAP)
        topmost.push({ name: store.name(c), path: store.path(c) });
      else truncated = true;
    } else {
      stack.push({ kids: store.childIds(c), next: 0 });
    }
  }

  return { folders: topmost, totalCount, truncated };
}

const COMPARE_CAP = 1000;

/**
 * Structural diff of two scans of the same root. Subtrees present in only
 * one scan collapse to a single added/removed entry (a new node_modules is
 * one row, not ten thousand); files present in both are emitted when their
 * size changed. Directories present in both are never emitted themselves —
 * their change is fully explained by the child entries.
 */
export function compareTrees(
  sourceA: TreeSource,
  sourceB: TreeSource,
): { entries: CompareEntry[]; truncated: boolean } {
  const a = asStore(sourceA);
  const b = asStore(sourceB);
  const entries: CompareEntry[] = [];

  const emit = (
    store: ScanStore,
    id: number,
    childPath: string,
    sizeA: number | null,
    sizeB: number | null,
  ): void => {
    const delta = (sizeB ?? 0) - (sizeA ?? 0);
    if (delta === 0 && sizeA !== null && sizeB !== null) return;
    entries.push({
      path: childPath,
      name: store.name(id),
      type: store.nodeType(id),
      sizeA,
      sizeB,
      delta,
      change:
        sizeA === null
          ? "added"
          : sizeB === null
            ? "removed"
            : delta > 0
              ? "grew"
              : "shrank",
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
      } else if (
        a.size(ca) !== b.size(cb) ||
        a.nodeType(ca) !== b.nodeType(cb)
      ) {
        emit(b, cb, childPath, a.size(ca), b.size(cb));
      }
    }
    for (const [name, ca] of aChildren) {
      emit(a, ca, a.childPath(ca, dirPath), a.size(ca), null); // disappeared between scans
    }
  };

  recurse(a.rootId, b.rootId, b.rootPath);
  entries.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return {
    entries: entries.slice(0, COMPARE_CAP),
    truncated: entries.length > COMPARE_CAP,
  };
}

export function collectFileTypes(source: TreeSource) {
  const store = asStore(source);
  const byExt = new Map<string, { count: number; totalSize: number }>();
  store.eachFile(store.rootId, (id) => {
    const ext = store.extension(id) ?? "(none)";
    const entry = byExt.get(ext) ?? { count: 0, totalSize: 0 };
    entry.count++;
    entry.totalSize += store.size(id);
    byExt.set(ext, entry);
  });
  return [...byExt.entries()]
    .map(([ext, v]) => ({ ext, count: v.count, totalSize: v.totalSize }))
    .sort((a, b) => b.totalSize - a.totalSize);
}
