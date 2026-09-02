import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { ScanResult, DuplicateGroup, DuplicateJob } from '../models/types';
import { storeOf } from './scanStore';
import { peekScan } from './diskScanner';

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
/** How many groups a completed job reports. `groupCount` still counts them all. */
export const REPORTED_GROUPS = 500;
/** How many files are hashed concurrently. */
const HASH_CONCURRENCY = 4;

const jobs = new Map<string, DuplicateJob>();

export function cancelAllDuplicateJobs(): void {
  for (const job of jobs.values()) job.cancelled = true;
  jobs.clear();
}

/**
 * The duplicate job for a scan **without starting one** (v4 §3.1).
 *
 * `getDuplicateJob` starts hashing if there is nothing to return, which is
 * right for the Duplicates view and wrong for the Reclaim Score: scoring a
 * folder must not kick off a full-disk SHA-256 pass as a side effect. The
 * score reads what is already known and reports its `redundant` component as
 * unavailable when nothing is — which is also the honest answer, since
 * "no duplicate found" is only true once the hashing has actually run.
 */
export function peekDuplicateJob(scanId: string): DuplicateJob | undefined {
  return jobs.get(scanId);
}

/**
 * Get (or start) the duplicate job for a scan. Re-uses the finished result on
 * subsequent calls; jobs die with their scan (TTL eviction handled by caller
 * checking the scan first).
 */
export function getDuplicateJob(scan: ScanResult, minSize: number): DuplicateJob {
  // Evict jobs whose scan has been evicted so the map can't grow forever.
  // peekScan, not getScan: housekeeping must not count as the user reading
  // those other scans, or they would never expire.
  for (const [scanId, job] of jobs) {
    if (!peekScan(scanId)) {
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
  if (!scan.store && !scan.root) throw new Error('Scan has no result tree');
  const store = storeOf(scan);

  // Stage 1 — bucket every file by size; only same-size files can be equal.
  // Buckets hold bare ids; a path only materializes when a file gets hashed.
  const bySize = new Map<number, number[]>();
  store.eachFile(store.rootId, (id) => {
    const size = store.size(id);
    if (size >= job.minSize) {
      const bucket = bySize.get(size);
      if (bucket) bucket.push(id);
      else bySize.set(size, [id]);
    }
  });

  const candidates: number[][] = [];
  for (const bucket of bySize.values()) {
    if (bucket.length > 1) candidates.push(bucket);
  }
  job.toHash = candidates.reduce((sum, b) => sum + b.length, 0);

  // Stage 2 — partial hash inside each size bucket.
  const partialGroups: number[][] = [];
  for (const bucket of candidates) {
    if (job.cancelled) return;
    const byPartial = new Map<string, number[]>();
    const hashes = await mapConcurrent(bucket, HASH_CONCURRENCY, (id) =>
      hashFile(store.path(id), PARTIAL_BYTES).catch(() => null)
    );
    bucket.forEach((id, i) => {
      const h = hashes[i];
      if (h === null) return; // unreadable (vanished / permission) — drop it
      const group = byPartial.get(h);
      if (group) group.push(id);
      else byPartial.set(h, [id]);
    });
    for (const group of byPartial.values()) {
      if (group.length > 1) partialGroups.push(group);
      // Files whose whole content fits in the partial read are fully hashed
      // already, but re-hashing them below keeps the logic uniform; they are
      // small, so the second pass is effectively free.
    }
  }

  // Stage 3 — full hash for groups that still match.
  const byFull = new Map<string, number[]>();
  for (const group of partialGroups) {
    if (job.cancelled) return;
    const hashes = await mapConcurrent(group, HASH_CONCURRENCY, (id) =>
      hashFile(store.path(id)).catch(() => null)
    );
    group.forEach((id, i) => {
      const h = hashes[i];
      if (h === null) return;
      const key = `${store.size(id)}:${h}`;
      const bucket = byFull.get(key);
      if (bucket) bucket.push(id);
      else byFull.set(key, [id]);
    });
    job.hashed += group.length;
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, ids] of byFull) {
    if (ids.length < 2) continue;
    const size = store.size(ids[0]);
    groups.push({
      hash: key.slice(key.indexOf(':') + 1),
      size,
      count: ids.length,
      reclaimable: size * (ids.length - 1),
      files: ids
        .map((id) => ({ name: store.name(id), path: store.path(id), modifiedAt: store.modifiedAt(id) }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    });
  }
  groups.sort((a, b) => b.reclaimable - a.reclaimable);

  // Response-size guard; the UI shows the top. `groupCount` below keeps the
  // true total, and the difference is load-bearing for the Reclaim Score: a
  // path absent from `groups` is only "not a duplicate" when every group fits.
  job.groups = groups.slice(0, REPORTED_GROUPS);
  job.groupCount = groups.length;
  job.totalReclaimable = groups.reduce((sum, g) => sum + g.reclaimable, 0);
  // Same size, same hash, different inode is what a real copy looks like — and
  // exactly what an APFS clone (Finder's Duplicate, `cp -c`) looks like too:
  // the clone shares every block with the original, so trashing it frees
  // nothing. Clones cannot be told apart without native code, so on macOS the
  // figure is an upper bound and says so.
  job.reclaimableIsUpperBound = process.platform === 'darwin';
  if (job.reclaimableIsUpperBound) {
    job.reclaimableCaveat =
      "Copies made with Finder's Duplicate share their storage on APFS, so trashing one of those frees nothing until it is edited — treat this figure as an upper bound.";
  }
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
