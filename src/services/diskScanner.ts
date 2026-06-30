import { promises as fsp, Dirent } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FileNode, ScanResult, LargeFolder, EmptyFoldersResult, CompareEntry } from '../models/types';
import { saveSnapshot } from './snapshots';
import { getIgnoreMatchers } from './settings';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { readJsonFile, appDataDir } from './storage';

/**
 * DiskScanner — asynchronous recursive directory walker.
 *
 * Design:
 *  - A queue of directory nodes is drained by up to CONCURRENCY workers.
 *  - Each worker readdir()s one directory, lstat()s its file entries in
 *    small parallel batches, and pushes child directories back on the queue.
 *  - Everything is promise-based, so the event loop is never blocked; the
 *    batch size keeps the number of in-flight fs operations bounded
 *    (back-pressure) instead of fanning out the whole tree at once.
 *  - Directory sizes are summed bottom-up in a single pass at the end.
 */

const CONCURRENCY = 8;
const STAT_BATCH = 32;
/** Yield to the event loop after this many entries so SSE stays responsive. */
const YIELD_EVERY = 2000;

const SCAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EVICT_INTERVAL_MS = 60 * 1000;

/** In-memory store of all scans, auto-evicted after 30 minutes. */
const scans = new Map<string, ScanResult>();

let evictTimer: NodeJS.Timeout | null = null;

function ensureEvictor(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, scan] of scans) {
      if (now - scan.createdAt > SCAN_TTL_MS) {
        scan.cancelled = true;
        scans.delete(id);
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
    incremental: !!cache,
    cachedDirs: 0,
    walkedDirs: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
  };
  scans.set(scan.scanId, scan);

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void walk(scan, rootStat.isDirectory(), ignore, cache).catch((err: unknown) => {
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

/** Add a substituted (cached) subtree to the scan counters; returns dir count. */
function tallyCachedSubtree(scan: ScanResult, dirNode: FileNode): number {
  let dirs = 0;
  const stack: FileNode[] = [...(dirNode.children ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    scan.scanned++;
    if (n.type === 'dir') {
      scan.dirCount++;
      dirs++;
      if (n.children) for (const c of n.children) stack.push(c);
    } else {
      scan.fileCount++;
    }
  }
  return dirs;
}

/** Persist the completed tree (compact JSON) so future fast rescans can reuse it. */
async function saveMtimeCache(scan: ScanResult): Promise<void> {
  if (!scan.root || scan.scanned > MTIME_CACHE_MAX_NODES) return;
  try {
    const dir = appDataDir();
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, cacheFileName(scan.rootPath));
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(scan.root), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    console.error('[treemap] mtime-cache save failed:', err);
  }
}

function makeNode(fullPath: string, name: string, isDir: boolean, size: number, mtimeMs: number): FileNode {
  const node: FileNode = {
    name,
    path: fullPath,
    size: isDir ? 0 : size,
    type: isDir ? 'dir' : 'file',
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith('.'),
  };
  if (isDir) {
    node.children = [];
  } else {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) node.extension = ext;
  }
  return node;
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
  const root = makeNode(
    scan.rootPath,
    path.basename(scan.rootPath) || scan.rootPath,
    rootIsDir,
    rootStat.size,
    rootStat.mtimeMs
  );
  scan.scanned = 1;
  if (rootIsDir) scan.dirCount = 1;
  else scan.fileCount = 1;

  if (rootIsDir) {
    await drainQueue(scan, [root], ignore, cache, new Set<string>());
  }
  if (scan.cancelled) return;

  sumDirSizes(root);
  scan.root = root;
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
function drainQueue(scan: ScanResult, initial: FileNode[], ignore: CompiledIgnore[], cache: Map<string, FileNode> | null, seen: Set<string>): Promise<void> {
  const queue: FileNode[] = [...initial];
  let active = 0;

  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (scan.cancelled) {
        if (active === 0) resolve();
        return;
      }
      while (active < CONCURRENCY && queue.length > 0) {
        const dirNode = queue.shift()!;
        active++;
        processDirectory(scan, dirNode, queue, ignore, cache, seen)
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
 * List one directory, stat its entries, attach children, enqueue subdirs.
 * Permission errors are swallowed per-directory: the dir simply stays empty
 * rather than failing the whole scan.
 */
async function processDirectory(
  scan: ScanResult,
  dirNode: FileNode,
  queue: FileNode[],
  ignore: CompiledIgnore[],
  cache: Map<string, FileNode> | null,
  seen: Set<string>
): Promise<void> {
  if (scan.cancelled) return;

  // Incremental: an unchanged directory (same mtime) keeps its cached subtree
  // rather than being re-listed. Trades catching in-place content-size edits
  // for near-instant repeat scans — hence opt-in, with full scan the default.
  if (cache) {
    const cached = cache.get(dirNode.path);
    if (cached && cached.type === 'dir' && cached.children && cached.modifiedAt === dirNode.modifiedAt) {
      dirNode.children = cached.children;
      scan.currentPath = dirNode.path;
      scan.cachedDirs = (scan.cachedDirs ?? 0) + 1 + tallyCachedSubtree(scan, dirNode);
      return; // skip readdir + don't enqueue children
    }
  }
  scan.walkedDirs = (scan.walkedDirs ?? 0) + 1;

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirNode.path, { withFileTypes: true });
  } catch {
    return; // EACCES / EPERM / ENOENT(race) — skip silently
  }

  scan.currentPath = dirNode.path;
  const children = dirNode.children!;

  // Honor the user's "don't scan" list before paying for any lstat calls.
  if (ignore.length > 0) {
    entries = entries.filter((ent) => !matchesAny(ignore, path.join(dirNode.path, ent.name), ent.name));
  }

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirNode.path, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return { node: makeNode(fullPath, ent.name, true, 0, stat.mtimeMs) };
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        const node = makeNode(fullPath, ent.name, false, stat.size, stat.mtimeMs);
        if (ent.isSymbolicLink()) {
          node.isSymlink = true;
          return { node };
        }
        // A cloud placeholder reports a logical size but occupies ~no disk blocks
        // AND lives under a known cloud-sync folder — so plain sparse files
        // (VM images, DB files) are never mislabelled as "cloud-safe to delete".
        if (node.size > 0 && stat.blocks === 0) {
          const provider = cloudProviderFor(fullPath);
          if (provider) {
            node.cloudPlaceholder = true;
            node.cloudProvider = provider;
          }
        }
        // Hard-link key only when the link count says the inode is shared.
        return { node, inoKey: stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : undefined };
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue; // entry vanished mid-scan
      const { node: child, inoKey } = result.value;
      // Dedup hard links sequentially so concurrent workers can't race the set.
      if (inoKey) {
        if (seen.has(inoKey)) {
          child.hardlinkDuplicate = true;
          scan.hardlinkedFiles = (scan.hardlinkedFiles ?? 0) + 1;
          scan.hardlinkedBytes = (scan.hardlinkedBytes ?? 0) + child.size;
          child.size = 0; // first occurrence already counted
        } else {
          seen.add(inoKey);
        }
      }
      if (child.cloudPlaceholder) {
        scan.cloudFiles = (scan.cloudFiles ?? 0) + 1;
        scan.cloudBytes = (scan.cloudBytes ?? 0) + child.size;
      }
      children.push(child);
      scan.scanned++;
      if (child.type === 'dir') {
        scan.dirCount++;
        queue.push(child);
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

/** Bottom-up recursive sum: directory size = Σ children sizes. */
function sumDirSizes(node: FileNode): number {
  if (node.type === 'file' || !node.children) return node.size;
  let total = 0;
  for (const child of node.children) total += sumDirSizes(child);
  node.size = total;
  return total;
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
