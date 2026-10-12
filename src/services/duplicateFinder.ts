import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { ScanResult, DuplicateGroup, DuplicateJob, DuplicatePhase, NotHashed } from '../models/types';
import { Flag, storeOf } from './scanStore';
import { peekScan } from './diskScanner';
import { stillLocal } from './dataLocality';

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
 *
 * Nothing is read that would make a sync client download it (the master
 * prompt §3.2, RISKS R1): a cloud placeholder is never opened — it is
 * counted and named in `notHashed` instead — and neither is a symbolic
 * link, which a read follows (a Windows cloud placeholder is a reparse
 * point, recorded as a link by both engines) and which is no file of its
 * own. A hard link's later names carry size 0 in the store (the scan counted
 * the bytes once), so they never reach a bucket. And because a sync client
 * can evict a file after its scan, the pass asks again just before it reads
 * a bucket — of each file's directory entry, never by opening it (the native
 * module's `dataIsLocal`, RISKS R71): a file whose data has left is counted
 * with the placeholders, one that cannot be asked about is not read. The
 * question lives in dataLocality.ts, shared with the near-duplicate pass and
 * the duplicate viewer, which open the same files.
 */

const PARTIAL_BYTES = 64 * 1024;
/** How many groups a completed job reports. `groupCount` still counts them all. */
export const REPORTED_GROUPS = 500;
/**
 * The smallest file looked at when the caller names no minimum: 1 KB, decimal
 * (1,000 bytes, as every size TreeMap prints counts), the Duplicates view's
 * smallest choice. One figure for GET /api/duplicates and the MCP tool
 * find_duplicates, which each kept a 1,024 of their own (the LEFT brief, item 5).
 */
export const DEFAULT_DUPLICATE_MIN_SIZE = 1_000;
/** How many files are hashed concurrently. */
const HASH_CONCURRENCY = 4;
/** How many placeholders `notHashed` names; it counts them all. */
const NOT_HASHED_LISTED = 20;

/** Test-only: told of every file the pass opens, before it is opened. */
let hashOpenObserver: ((file: string) => void) | null = null;

/** Test-only: watch what the pass opens (null stops watching). */
export function observeHashOpensForTests(observer: ((file: string) => void) | null): void {
  hashOpenObserver = observer;
}

/** Test-only: told, after each placeholder `notHashed` considers naming, how many names it holds. */
let notHashedHeldObserver: ((held: number) => void) | null = null;

/** Test-only: watch how many names the `notHashed` list holds (null stops watching). */
export function observeNotHashedHeldForTests(observer: ((held: number) => void) | null): void {
  notHashedHeldObserver = observer;
}

/** Test-only: told of every change to a job's progress (its phase, hashed or toHash). */
let progressObserver: ((progress: { phase: DuplicatePhase; hashed: number; toHash: number }) => void) | null = null;

/** Test-only: watch every progress change (null stops watching). */
export function observeDuplicateProgressForTests(observer: typeof progressObserver): void {
  progressObserver = observer;
}

/** Tells the test seam, if any, where `job` stands now. */
function progressed(job: DuplicateJob): void {
  progressObserver?.({ phase: job.phase, hashed: job.hashed, toHash: job.toHash });
}

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
    phase: 'sizes',
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
  // Links and cloud placeholders never enter a bucket; the placeholders are
  // counted instead (see the module comment).
  const bySize = new Map<number, number[]>();
  const placeholders: number[] = [];
  let placeholderBytes = 0;
  store.eachFile(store.rootId, (id) => {
    const size = store.size(id);
    if (size < job.minSize) return;
    if (store.flag(id, Flag.Symlink)) return;
    if (store.flag(id, Flag.CloudPlaceholder)) {
      placeholders.push(id);
      placeholderBytes += size;
      return;
    }
    const bucket = bySize.get(size);
    if (bucket) bucket.push(id);
    else bySize.set(size, [id]);
  });

  const candidates: number[][] = [];
  for (const bucket of bySize.values()) {
    if (bucket.length > 1) candidates.push(bucket);
  }
  job.phase = 'partial';
  job.toHash = candidates.reduce((sum, b) => sum + b.length, 0);
  progressed(job);

  // Stage 2 — partial hash inside each size bucket.
  const partialGroups: number[][] = [];
  for (const candidate of candidates) {
    if (job.cancelled) return;
    const bucket = stillLocal(candidate, (id) => store.path(id), (id) => {
      placeholders.push(id);
      placeholderBytes += store.size(id);
    });
    // A file evicted since the scan is not read, and neither is one left with
    // no copy to compare: both come off this pass's total, so it ends at it.
    job.toHash -= bucket.length < 2 ? candidate.length : candidate.length - bucket.length;
    progressed(job);
    if (bucket.length < 2) continue;
    const byPartial = new Map<string, number[]>();
    const hashes = await mapConcurrent(bucket, HASH_CONCURRENCY, (id) => countedHash(job, store.path(id), PARTIAL_BYTES));
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

  job.notHashed = notHashedReport(placeholders, placeholderBytes, (id) => store.size(id), (id) => store.path(id));

  // Stage 3 — full hash for groups that still match. A pass of its own, so
  // its progress counts from zero against the files it will actually read.
  job.phase = 'full';
  job.hashed = 0;
  job.toHash = partialGroups.reduce((sum, g) => sum + g.length, 0);
  progressed(job);
  const byFull = new Map<string, number[]>();
  for (const group of partialGroups) {
    if (job.cancelled) return;
    const hashes = await mapConcurrent(group, HASH_CONCURRENCY, (id) => countedHash(job, store.path(id)));
    group.forEach((id, i) => {
      const h = hashes[i];
      if (h === null) return;
      const key = `${store.size(id)}:${h}`;
      const bucket = byFull.get(key);
      if (bucket) bucket.push(id);
      else byFull.set(key, [id]);
    });
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
  // nothing. Clone identity is not read (the native scan core does not request
  // ATTR_CMNEXT_CLONEID), so on macOS the figure is an upper bound and says so.
  job.reclaimableIsUpperBound = process.platform === 'darwin';
  if (job.reclaimableIsUpperBound) {
    job.reclaimableCaveat =
      "Copies made with Finder's Duplicate share their storage on APFS, so trashing one of those frees nothing until it is edited — treat this figure as an upper bound.";
  }
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/**
 * What `notHashed` says about `ids`: how many, how much, and the largest
 * `NOT_HASHED_LISTED` by name, biggest first. Equal sizes go to the smaller
 * path, compared with `<` (UTF-16 code units, no locale), both for which
 * make the list and for their order in it, so neither depends on how the
 * store numbered them. With more than `NOT_HASHED_LISTED` ids, paths are
 * built only for those at least as big as the `NOT_HASHED_LISTED`-th largest,
 * and a name is dropped as soon as it cannot make the list, so no more than
 * `NOT_HASHED_LISTED` are held at once however many share that size.
 */
function notHashedReport(ids: number[], bytes: number, sizeOf: (id: number) => number, pathOf: (id: number) => string): NotHashed {
  const bySize = [...ids].sort((a, b) => sizeOf(b) - sizeOf(a));
  const floor = bySize.length > NOT_HASHED_LISTED ? sizeOf(bySize[NOT_HASHED_LISTED - 1]) : -Infinity;
  const largest: Named[] = [];
  for (const id of bySize) {
    const size = sizeOf(id);
    if (size < floor) break; // bySize is biggest first, so every id after this one is below the floor too
    keepIfNamed(largest, { path: pathOf(id), size });
    notHashedHeldObserver?.(largest.length);
  }
  return { files: ids.length, bytes, largest };
}

type Named = NotHashed['largest'][number];

/** Whether `a` is named before `b`: the bigger first, then the smaller path by `<`. */
function namedBefore(a: Named, b: Named): boolean {
  return a.size > b.size || (a.size === b.size && a.path < b.path);
}

/**
 * Puts `entry` where it belongs in `list`, which is in `namedBefore` order and
 * holds at most `NOT_HASHED_LISTED`: the last is dropped to make room, and an
 * entry that would come after all of a full list is not kept.
 */
function keepIfNamed(list: Named[], entry: Named): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (namedBefore(list[mid], entry)) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= NOT_HASHED_LISTED) return;
  if (list.length === NOT_HASHED_LISTED) list.pop();
  list.splice(lo, 0, entry);
}

/** SHA-256 of a file — the whole file, or just the first `limit` bytes. */
function hashFile(filePath: string, limit?: number): Promise<string> {
  hashOpenObserver?.(filePath);
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, limit ? { start: 0, end: limit - 1 } : {});
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * One file's hash (of its first `limit` bytes, or whole), null when it cannot
 * be read — counted into the job's progress as soon as it is done either way
 * (QA D52: the first pass, the long one, used to count nothing, so the
 * Duplicates view read "0 / 39,575 files" until the job was done).
 */
async function countedHash(job: DuplicateJob, filePath: string, limit?: number): Promise<string | null> {
  const hash = await hashFile(filePath, limit).catch(() => null);
  job.hashed += 1;
  progressed(job);
  return hash;
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
