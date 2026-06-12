import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { FileNode, ScanResult, DuplicateGroup, DuplicateJob } from '../models/types';
import { getScan } from './diskScanner';

/**
 * DuplicateFinder — true (content-equal) duplicate detection over a completed
 * scan, cheap-to-expensive in three stages:
 *
 *   1. group by exact size            (free — sizes come from the scan tree)
 *   2. hash the first 64 KiB          (catches most false positives quickly)
 *   3. stream a full SHA-256          (only for files still matching)
 *
 * Hashing runs as a background job per scanId; the API polls the job record,
 * mirroring how scans themselves report progress.
 */

const PARTIAL_BYTES = 64 * 1024;
/** How many files are hashed concurrently. */
const HASH_CONCURRENCY = 4;

const jobs = new Map<string, DuplicateJob>();

export function cancelAllDuplicateJobs(): void {
  for (const job of jobs.values()) job.cancelled = true;
  jobs.clear();
}

/**
 * Get (or start) the duplicate job for a scan. Re-uses the finished result on
 * subsequent calls; jobs die with their scan (TTL eviction handled by caller
 * checking the scan first).
 */
export function getDuplicateJob(scan: ScanResult, minSize: number): DuplicateJob {
  // Evict jobs whose scan has been evicted so the map can't grow forever.
  for (const [scanId, job] of jobs) {
    if (!getScan(scanId)) {
      job.cancelled = true;
      jobs.delete(scanId);
    }
  }

  const existing = jobs.get(scan.scanId);
  if (existing && existing.minSize === minSize && existing.status !== 'error') {
    return existing;
  }
  if (existing) existing.cancelled = true;

  const job: DuplicateJob = {
    scanId: scan.scanId,
    status: 'running',
    minSize,
    hashed: 0,
    toHash: 0,
    cancelled: false,
    startedAt: Date.now(),
  };
  jobs.set(scan.scanId, job);

  void findDuplicates(scan, job).catch((err: unknown) => {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });

  return job;
}

async function findDuplicates(scan: ScanResult, job: DuplicateJob): Promise<void> {
  if (!scan.root) throw new Error('Scan has no result tree');

  // Stage 1 — bucket every file by size; only same-size files can be equal.
  const bySize = new Map<number, FileNode[]>();
  const stack: FileNode[] = [scan.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'file') {
      if (node.size >= job.minSize) {
        const bucket = bySize.get(node.size);
        if (bucket) bucket.push(node);
        else bySize.set(node.size, [node]);
      }
      continue;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }

  const candidates: FileNode[][] = [];
  for (const bucket of bySize.values()) {
    if (bucket.length > 1) candidates.push(bucket);
  }
  job.toHash = candidates.reduce((sum, b) => sum + b.length, 0);

  // Stage 2 — partial hash inside each size bucket.
  const partialGroups: FileNode[][] = [];
  for (const bucket of candidates) {
    if (job.cancelled) return;
    const byPartial = new Map<string, FileNode[]>();
    const hashes = await mapConcurrent(bucket, HASH_CONCURRENCY, (f) =>
      hashFile(f.path, PARTIAL_BYTES).catch(() => null)
    );
    bucket.forEach((file, i) => {
      const h = hashes[i];
      if (h === null) return; // unreadable (vanished / permission) — drop it
      const group = byPartial.get(h);
      if (group) group.push(file);
      else byPartial.set(h, [file]);
    });
    for (const group of byPartial.values()) {
      if (group.length > 1) partialGroups.push(group);
      // Files whose whole content fits in the partial read are fully hashed
      // already, but re-hashing them below keeps the logic uniform; they are
      // small, so the second pass is effectively free.
    }
  }

  // Stage 3 — full hash for groups that still match.
  const byFull = new Map<string, FileNode[]>();
  for (const group of partialGroups) {
    if (job.cancelled) return;
    const hashes = await mapConcurrent(group, HASH_CONCURRENCY, (f) =>
      hashFile(f.path).catch(() => null)
    );
    group.forEach((file, i) => {
      const h = hashes[i];
      if (h === null) return;
      const key = `${file.size}:${h}`;
      const bucket = byFull.get(key);
      if (bucket) bucket.push(file);
      else byFull.set(key, [file]);
    });
    job.hashed += group.length;
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, files] of byFull) {
    if (files.length < 2) continue;
    const size = files[0].size;
    groups.push({
      hash: key.slice(key.indexOf(':') + 1),
      size,
      count: files.length,
      reclaimable: size * (files.length - 1),
      files: files
        .map((f) => ({ name: f.name, path: f.path, modifiedAt: f.modifiedAt }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    });
  }
  groups.sort((a, b) => b.reclaimable - a.reclaimable);

  job.groups = groups.slice(0, 500); // response-size guard; UI shows the top
  job.groupCount = groups.length;
  job.totalReclaimable = groups.reduce((sum, g) => sum + g.reclaimable, 0);
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/** SHA-256 of a file — the whole file, or just the first `limit` bytes. */
function hashFile(filePath: string, limit?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, limit ? { start: 0, end: limit - 1 } : {});
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
