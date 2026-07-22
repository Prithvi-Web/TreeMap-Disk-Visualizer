import { promises as fsp, Dirent, Stats } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FileNode, ScanResult, LargeFolder, EmptyFoldersResult, CompareEntry } from '../models/types';
import { saveSnapshot } from './snapshots';
import { getIgnoreMatchers } from './settings';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { readJsonFile, appDataDir } from './storage';
import { IO_THREADS } from '../utils/ioThreads';
import { detectContainerKind } from '../utils/containerKind';
import { neverDescend } from '../utils/mountBoundaries';
import { forgetScan } from './containerScanner';
import { findGduBinary, gduScan } from './gduScanner';
import { PackedScanStore, ScanStore, Flag, NodeInput, fileNodeToInput } from './scanStore';

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
      console.warn(`[treemap] readdir gave up after ${READDIR_DEADLINE_MS / 1000}s: ${p}`);
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
  if (scan.status === 'running') return now - scan.createdAt > RUNNING_SCAN_HARD_CAP_MS;
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
  for (const scan of scans.values()) scan.cancelled = true;
}

/**
 * Transitional bridge (Phase 3-4 of the packed-store rewrite): consumers not
 * yet migrated to ScanStore ids keep reading `scan.root` as before. For
 * store-backed scans the object tree materializes lazily and is cached until
 * a store mutation (e.g. a container graft) invalidates it; legacy producers
 * (gdu, cloud) assign a real tree through the setter. Removed in Phase 5.
 */
function defineRootAccessor(scan: ScanResult): void {
  let legacy: FileNode | undefined;
  let cached: FileNode | undefined;
  let cachedVersion = -1;
  Object.defineProperty(scan, 'root', {
    enumerable: true,
    configurable: true,
    get(): FileNode | undefined {
      if (legacy) return legacy;
      const store = scan.store;
      if (!store) return undefined;
      if (!cached || cachedVersion !== store.version) {
        cached = store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root;
        cachedVersion = store.version;
      }
      return cached;
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
}

export async function startScan(rootPath: string, opts: ScanOptions = {}): Promise<ScanResult> {
  ensureEvictor();

  // Fail fast on unreadable/nonexistent roots so the API can 4xx properly.
  const rootStat = await fsp.lstat(rootPath);

  // User-configured "don't scan" patterns; a settings problem never blocks a scan.
  const ignore = await getIgnoreMatchers('scan').catch(() => [] as CompiledIgnore[]);

  // Incremental rescan: load the previous tree so unchanged directories (same
  // mtime) can be substituted from cache instead of re-walked.
  let cache: Map<string, FileNode> | null = null;
  if (opts.incremental) {
    const cachedRoot = await readJsonFile<FileNode | null>(cacheFileName(rootPath), null);
    if (cachedRoot && cachedRoot.path === rootPath && cachedRoot.type === 'dir') {
      cache = buildDirCache(cachedRoot);
    }
  }

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
    engine: IO_THREADS > 4 ? 'turbo-walker' : 'walker',
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
    process.env.TREEMAP_NO_GDU !== '1';

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void (async () => {
    if (gduEligible) {
      try {
        const bin = await findGduBinary();
        if (bin) {
          scan.engine = 'gdu-turbo';
          const root = await gduScan(scan, bin, cloudProviderFor);
          if (scan.cancelled) return;
          scan.root = root;
          scan.status = 'complete';
          scan.finishedAt = Date.now();
          scan.currentPath = scan.rootPath;
          void saveMtimeCache(scan);
          void saveSnapshot(scan).catch((err: unknown) => {
            console.error('[treemap] snapshot save failed:', err);
          });
          return;
        }
      } catch (err) {
        if (scan.cancelled) return; // cancellation is not a gdu failure
        // gdu is strictly best-effort: a missing binary, a spawn failure, a
        // non-zero exit or an oversized shard must never surface as a scan
        // error. Log it and let the walker produce the scan.
        console.warn(`[treemap] gdu engine unavailable, using walker: ${String(err)}`);
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
      scan.engine = IO_THREADS > 4 ? 'turbo-walker' : 'walker';
    }
    await walk(scan, rootStat.isDirectory(), ignore, cache);
  })().catch((err: unknown) => {
    scan.status = 'error';
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
  });

  return scan;
}

/* ---------- Incremental (fast) rescan cache ---------- */

const MTIME_CACHE_MAX_NODES = 300_000;

/** Stable per-root cache filename in the app-data directory. */
function cacheFileName(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return `mtime-cache-${h}.json`;
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
function reuseCachedListing(scan: ScanResult, store: ScanStore, dirId: number, dirPath: string, cachedChildren: FileNode[], queue: DirJob[]): void {
  scan.currentPath = dirPath;
  scan.cachedDirs = (scan.cachedDirs ?? 0) + 1;
  for (const child of cachedChildren) {
    scan.scanned++;
    const childId = store.addNode(dirId, fileNodeToInput(child));
    if (child.type === 'dir') {
      scan.dirCount++;
      queue.push({ id: childId, path: child.path, cached: child, revalidate: true });
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
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(tree), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    console.error('[treemap] mtime-cache save failed:', err);
  }
}

/** Everything lstat tells us about one entry, shaped for store.addNode. */
function statToInput(name: string, isDir: boolean, size: number, mtimeMs: number, atimeMs?: number): NodeInput {
  const input: NodeInput = {
    name,
    isDir,
    size: isDir ? 0 : size,
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith('.'),
  };
  // atime === 0 means "never recorded" on several filesystems — omit rather
  // than let a 1970 date surface anywhere.
  if (atimeMs !== undefined && atimeMs > 0) input.accessedAt = Math.round(atimeMs);
  if (!isDir) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) input.extension = ext;
  }
  const container = detectContainerKind(name, isDir);
  if (container) input.container = container;
  return input;
}

/** Infer a cloud provider for a placeholder file from its path. */
function cloudProviderFor(p: string): 'icloud' | 'onedrive' | 'dropbox' | undefined {
  if (/Library\/Mobile Documents|com~apple~CloudDocs|\.icloud$/i.test(p)) return 'icloud';
  if (/OneDrive/i.test(p)) return 'onedrive';
  if (/Dropbox/i.test(p)) return 'dropbox';
  return undefined;
}

async function walk(scan: ScanResult, rootIsDir: boolean, ignore: CompiledIgnore[], cache: Map<string, FileNode> | null): Promise<void> {
  const rootStat = await fsp.lstat(scan.rootPath);
  const store = new PackedScanStore(
    scan.rootPath,
    path.sep,
    statToInput(path.basename(scan.rootPath) || scan.rootPath, rootIsDir, rootStat.size, rootStat.mtimeMs, rootStat.atimeMs),
  );
  scan.scanned = 1;
  if (rootIsDir) scan.dirCount = 1;
  else scan.fileCount = 1;

  if (rootIsDir) {
    // Dirs reached through a cached parent's listing get one fresh lstat
    // before their cached listing is trusted — membership is per-scan.
    await drainQueue(scan, store, [{ id: store.rootId, path: scan.rootPath, cached: null, revalidate: false }], ignore, cache, new Set<string>());
  }
  if (scan.cancelled) return;

  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  scan.currentPath = scan.rootPath;

  // Persist the tree for future fast rescans, then snapshot for Trends.
  // Failures here must never fail the scan itself.
  void saveMtimeCache(scan);
  void saveSnapshot(scan).catch((err: unknown) => {
    console.error('[treemap] snapshot save failed:', err);
  });
}

/**
 * Worker pool: up to CONCURRENCY directories are listed at the same time.
 * Resolves when the queue is empty and every worker has finished.
 */
function drainQueue(scan: ScanResult, store: ScanStore, initial: DirJob[], ignore: CompiledIgnore[], cache: Map<string, FileNode> | null, seen: Set<string>): Promise<void> {
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
  seen: Set<string>
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
    store.setAccessedAt(dirId, st.atimeMs > 0 ? Math.round(st.atimeMs) : undefined);
    if (cachedNode.children && mtimesMatch(cachedMtime, Math.round(st.mtimeMs))) {
      reuseCachedListing(scan, store, dirId, dirPath, cachedNode.children, queue);
      return;
    }
    // Its listing changed — fall through and re-list from disk.
  } else if (cache) {
    // Freshly stat'ed by its parent: compare the disk's mtime to the cache's.
    const cached = cache.get(dirPath);
    if (cached && cached.type === 'dir' && cached.children && mtimesMatch(cached.modifiedAt, store.modifiedAt(dirId))) {
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
    entries = entries.filter((ent) => !matchesAny(ignore, path.join(dirPath, ent.name), ent.name));
  }

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirPath, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return { input: statToInput(ent.name, true, 0, stat.mtimeMs, stat.atimeMs), fullPath, isDir: true };
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        const input = statToInput(ent.name, false, stat.size, stat.mtimeMs, stat.atimeMs);
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
        return { input, fullPath, isDir: false, inoKey: stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : undefined };
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue; // entry vanished mid-scan
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
      if (isDir && input.name === '.git') store.setFlag(dirId, Flag.GitRepo, true);
      const childId = store.addNode(dirId, input);
      scan.scanned++;
      if (isDir) {
        scan.dirCount++;
        // Mount re-entry points and automount triggers stay visible as empty
        // dirs but are never walked — descending double-counts the disk or
        // blocks forever (see utils/mountBoundaries).
        if (!neverDescend(fullPath)) queue.push({ id: childId, path: fullPath, cached: null, revalidate: false });
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

export function collectLargestFiles(root: FileNode, limit: number, minSize: number) {
  const top: FileNode[] = [];
  // Simple bounded insertion keeps memory flat even for huge trees.
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      if (node.size < minSize) return;
      if (top.length < limit) {
        top.push(node);
        if (top.length === limit) top.sort((a, b) => b.size - a.size);
      } else if (node.size > top[top.length - 1].size) {
        top[top.length - 1] = node;
        top.sort((a, b) => b.size - a.size);
      }
      return;
    }
    if (node.children) for (const c of node.children) visit(c);
  };
  visit(root);
  top.sort((a, b) => b.size - a.size);
  return top.map((f) => ({
    name: f.name,
    path: f.path,
    size: f.size,
    extension: f.extension,
    modifiedAt: f.modifiedAt,
  }));
}

export function collectLargestFolders(root: FileNode, limit: number, minSize: number): LargeFolder[] {
  const found: LargeFolder[] = [];
  // Recursive visit returns the subtree's file count so each folder's
  // recursive count is computed in the same single pass as the walk.
  const visit = (node: FileNode): number => {
    if (node.type === 'file') return 1;
    let count = 0;
    if (node.children) for (const c of node.children) count += visit(c);
    if (node !== root && node.size >= minSize) {
      found.push({
        name: node.name,
        path: node.path,
        size: node.size,
        fileCount: count,
        modifiedAt: node.modifiedAt,
      });
    }
    return count;
  };
  visit(root);
  return found.sort((a, b) => b.size - a.size).slice(0, limit);
}

/** Junk files that don't stop a folder from counting as empty. */
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const EMPTY_FOLDERS_CAP = 1000;

/**
 * Find recursively-empty directories: no files anywhere below (only other
 * empty dirs). With `ignoreJunk`, OS metadata files like .DS_Store don't
 * count as content. Returns only the topmost empty dirs — trashing those
 * removes everything beneath them anyway.
 */
export function collectEmptyFolders(root: FileNode, ignoreJunk: boolean): EmptyFoldersResult {
  const isJunk = (n: FileNode): boolean => ignoreJunk && JUNK_FILES.has(n.name.toLowerCase());
  const emptyDirs = new Set<FileNode>();

  // Pass 1, bottom-up: a dir is empty when every child is junk or an empty dir.
  const compute = (node: FileNode): boolean => {
    if (node.type === 'file') return isJunk(node);
    let empty = true;
    if (node.children) {
      for (const c of node.children) {
        if (!compute(c)) empty = false;
      }
    }
    if (empty) emptyDirs.add(node);
    return empty;
  };
  compute(root);
  emptyDirs.delete(root); // never offer to trash the scanned root itself

  // Pass 2, top-down: report only topmost empty dirs (their whole subtree is
  // empty, so trashing the top one is sufficient) and stop descending there.
  const topmost: { name: string; path: string }[] = [];
  let truncated = false;
  const walk = (node: FileNode): void => {
    if (!node.children) return;
    for (const c of node.children) {
      if (c.type !== 'dir') continue;
      if (emptyDirs.has(c)) {
        if (topmost.length < EMPTY_FOLDERS_CAP) topmost.push({ name: c.name, path: c.path });
        else truncated = true;
      } else {
        walk(c);
      }
    }
  };
  walk(root);

  return { folders: topmost, totalCount: emptyDirs.size, truncated };
}

const COMPARE_CAP = 1000;

/**
 * Structural diff of two scans of the same root. Subtrees present in only
 * one scan collapse to a single added/removed entry (a new node_modules is
 * one row, not ten thousand); files present in both are emitted when their
 * size changed. Directories present in both are never emitted themselves —
 * their change is fully explained by the child entries.
 */
export function compareTrees(rootA: FileNode, rootB: FileNode): { entries: CompareEntry[]; truncated: boolean } {
  const entries: CompareEntry[] = [];

  const emit = (node: FileNode, sizeA: number | null, sizeB: number | null): void => {
    const delta = (sizeB ?? 0) - (sizeA ?? 0);
    if (delta === 0 && sizeA !== null && sizeB !== null) return;
    entries.push({
      path: node.path,
      name: node.name,
      type: node.type,
      sizeA,
      sizeB,
      delta,
      change: sizeA === null ? 'added' : sizeB === null ? 'removed' : delta > 0 ? 'grew' : 'shrank',
    });
  };

  const recurse = (a: FileNode, b: FileNode): void => {
    const aChildren = new Map<string, FileNode>();
    for (const c of a.children ?? []) aChildren.set(c.name, c);

    for (const cb of b.children ?? []) {
      const ca = aChildren.get(cb.name);
      if (!ca) {
        emit(cb, null, cb.size); // appeared between scans
        continue;
      }
      aChildren.delete(cb.name);
      if (ca.type === 'dir' && cb.type === 'dir') {
        recurse(ca, cb);
      } else if (ca.size !== cb.size || ca.type !== cb.type) {
        emit(cb, ca.size, cb.size);
      }
    }
    for (const ca of aChildren.values()) {
      emit(ca, ca.size, null); // disappeared between scans
    }
  };

  recurse(rootA, rootB);
  entries.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { entries: entries.slice(0, COMPARE_CAP), truncated: entries.length > COMPARE_CAP };
}

export function collectFileTypes(root: FileNode) {
  const byExt = new Map<string, { count: number; totalSize: number }>();
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      const ext = node.extension ?? '(none)';
      const entry = byExt.get(ext) ?? { count: 0, totalSize: 0 };
      entry.count++;
      entry.totalSize += node.size;
      byExt.set(ext, entry);
      return;
    }
    if (node.children) for (const c of node.children) visit(c);
  };
  visit(root);
  return [...byExt.entries()]
    .map(([ext, v]) => ({ ext, count: v.count, totalSize: v.totalSize }))
    .sort((a, b) => b.totalSize - a.totalSize);
}
