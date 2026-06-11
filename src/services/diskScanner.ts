import { promises as fsp, Dirent } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FileNode, ScanResult } from '../models/types';

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
export async function startScan(rootPath: string): Promise<ScanResult> {
  ensureEvictor();

  // Fail fast on unreadable/nonexistent roots so the API can 4xx properly.
  const rootStat = await fsp.lstat(rootPath);

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
  scans.set(scan.scanId, scan);

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void walk(scan, rootStat.isDirectory()).catch((err: unknown) => {
    scan.status = 'error';
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
  });

  return scan;
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

async function walk(scan: ScanResult, rootIsDir: boolean): Promise<void> {
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
    await drainQueue(scan, [root]);
  }
  if (scan.cancelled) return;

  sumDirSizes(root);
  scan.root = root;
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  scan.currentPath = scan.rootPath;
}

/**
 * Worker pool: up to CONCURRENCY directories are listed at the same time.
 * Resolves when the queue is empty and every worker has finished.
 */
function drainQueue(scan: ScanResult, initial: FileNode[]): Promise<void> {
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
        processDirectory(scan, dirNode, queue)
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
async function processDirectory(scan: ScanResult, dirNode: FileNode, queue: FileNode[]): Promise<void> {
  if (scan.cancelled) return;

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirNode.path, { withFileTypes: true });
  } catch {
    return; // EACCES / EPERM / ENOENT(race) — skip silently
  }

  scan.currentPath = dirNode.path;
  const children = dirNode.children!;

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirNode.path, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return makeNode(fullPath, ent.name, true, 0, stat.mtimeMs);
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        return makeNode(fullPath, ent.name, false, stat.size, stat.mtimeMs);
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue; // entry vanished mid-scan
      const child = result.value;
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
