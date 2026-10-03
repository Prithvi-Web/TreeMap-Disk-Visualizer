import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATFS_TIMEOUT_MS } from '../diskUsage';
import { newestCountsByRoot, newestSnapshotCounts, type SnapshotCounts } from '../snapshots';
import { formatCount } from '../../utils/formatCount';

/**
 * How many entries a native scan will hold, projected before it walks (Track U,
 * U-30; the inputs P and U of the Phase 4 chooser, plan §S.1.1). Two sources,
 * in this order:
 *
 *  1. **The previous scan of exactly this folder** — the newest snapshot whose
 *     root is this path, read as its `fileCount + dirCount`: the rows the scan
 *     held, the root among them. A fact about this tree as it was.
 *  2. **Only when there is none, and only for a folder that is a whole volume**,
 *     the file system's used inodes (statfs `files − ffree`), summed over the
 *     volumes the folder covers (macOS `/` is its system volume and its data
 *     volume). A hint and never a bound: an inode with several names is one
 *     inode, and names are what a scan counts.
 *
 * Unknown is `null` with its reason — never 0, never a partial sum (U-D13) —
 * and nothing here throws: a hand-edited snapshots.json, a volume that does
 * not answer or a dep that breaks is a sentence, and the scan walks anyway.
 * Not quite read-only: a corrupt snapshots.json read through `readJsonFile`
 * is copied aside to snapshots.json.corrupt in app-data, as every reader of it
 * does. Until U-24 records each scan's boundary rule, every snapshot of the
 * root counts, whatever rule it was taken under. The history is not parsed at
 * every start: snapshots.ts keeps each root's newest counts, read once a
 * process and kept current by each save (`newestSnapshotCounts`).
 */

/** Where a projection's number came from; `none` when there is no number. */
export type ProjectionSource = 'previousScan' | 'usedInodes' | 'none';

export interface EntryProjection {
  /** The entries projected, the root included; null when unknown. */
  entries: number | null;
  source: ProjectionSource;
  /** Where the number came from, or why there is none, in a sentence that follows "because". */
  reason: string;
}

/** Everything the projection reads, injected so every case can be counted on any machine. */
export interface ProjectionDeps {
  platform: NodeJS.Platform;
  /**
   * Snapshot records, unchecked, among which is `rootPath`'s newest: every
   * record on file would do, since the projection picks the newest of exactly
   * this root. The live one hands over only that newest, from the counts
   * index, so a scan start parses no history (`newestSnapshotCounts`).
   */
  snapshots(rootPath: string): Promise<readonly unknown[]>;
  /** `stat().dev`; rejects when the path cannot be read. */
  dev(target: string): Promise<number>;
  /** statfs's inode counts for the volume at `mount`. */
  statfs(mount: string): Promise<{ files: number; ffree: number }>;
  /** Calls `fire` once `ms` have passed, unless the function it returns is called first. */
  timer(ms: number, fire: () => void): () => void;
}

const LIVE: ProjectionDeps = {
  platform: process.platform,
  snapshots: async (rootPath) => {
    const newest = await newestSnapshotCounts(rootPath);
    return newest === null ? [] : [newest];
  },
  dev: async (target) => (await fsp.stat(target)).dev,
  statfs: async (mount) => {
    const st = await fsp.statfs(mount);
    return { files: Number(st.files), ffree: Number(st.ffree) };
  },
  timer: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
};

/** The data volume macOS firmlinks into `/`: a scan of `/` walks both. */
const DARWIN_DATA_VOLUME = '/System/Volumes/Data';
const NO_EARLIER_SCAN = 'no earlier scan of this folder is on record';

/** A failure as words, whatever was thrown: a value with no string form (a null-prototype object) still gives a reason, never a throw. */
function describe(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'a failure with no description';
  }
}

/**
 * The volumes `root` covers whole, whose used inodes may hint at its size, or
 * null: macOS `/` is its volume group; Linux `/`, a Windows drive's root and a
 * mount point — a folder on another device than its parent — are themselves.
 * Anything else, or a folder whose device cannot be read, covers no volume.
 */
export async function wholeVolumeMounts(root: string, deps: ProjectionDeps = LIVE): Promise<string[] | null> {
  if (deps.platform === 'win32' && /^[A-Za-z]:[\\/]?$/.test(root)) return [root];
  if (deps.platform !== 'win32' && root === '/') return deps.platform === 'darwin' ? ['/', DARWIN_DATA_VOLUME] : ['/'];
  const parent = (deps.platform === 'win32' ? path.win32 : path.posix).dirname(root);
  if (parent === root) return null;
  try {
    const [own, above] = await Promise.all([deps.dev(root), deps.dev(parent)]);
    return own !== above ? [root] : null;
  } catch {
    return null;
  }
}

type InodeCount = { used: number } | { used: null; why: string };

/** statfs's `files − ffree` for `mount` within diskUsage's statfs bound, or why it is not known. */
async function usedInodes(mount: string, deps: ProjectionDeps): Promise<InodeCount> {
  let counts: { files: number; ffree: number };
  try {
    counts = await withinDeadline(deps.statfs(mount), STATFS_TIMEOUT_MS, deps);
  } catch (err: unknown) {
    return { used: null, why: err === DEADLINE ? `statfs did not answer within ${STATFS_TIMEOUT_MS / 1000} s` : `statfs failed (${describe(err)})` };
  }
  const files = Number(counts.files);
  const ffree = Number(counts.ffree);
  if (!Number.isSafeInteger(files) || !Number.isSafeInteger(ffree)) return { used: null, why: 'statfs reported inode counts that are not whole numbers' };
  if (files <= 0) return { used: null, why: 'the file system reports no inode count there' };
  if (ffree < 0 || ffree > files) return { used: null, why: `statfs reported more free inodes (${formatCount(ffree)}) than inodes (${formatCount(files)})` };
  // A volume holding files has inodes in use: every one free is a file system
  // that does not count them (some FUSE mounts), never a measured 0.
  if (ffree === files) return { used: null, why: 'the file system reports every inode free there, so it does not count them' };
  return { used: files - ffree };
}

/** What a deadline rejects with. */
const DEADLINE = Symbol('deadline');

/** `work`, or a rejection with DEADLINE once `ms` pass first; the timer is cleared when `work` settles. */
function withinDeadline<T>(work: Promise<T>, ms: number, deps: ProjectionDeps): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let clear: () => void = () => undefined;
    // Observed first, so `work` never rejects unobserved, whatever the timer does.
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clear();
        reject(err);
      },
    );
    clear = deps.timer(ms, () => {
      if (settled) return;
      settled = true;
      reject(DEADLINE);
    });
  });
}

/** The newest record of exactly `rootPath` among `records`, or null, by snapshots.ts's one rule (`newestCountsByRoot`). */
function newestOf(records: readonly unknown[], rootPath: string): SnapshotCounts | null {
  return newestCountsByRoot(records).get(rootPath) ?? null;
}

/** Why `value` is not a count a previous scan can be read as, or null when it is one. */
function countProblem(name: string, value: unknown): string | null {
  if (typeof value !== 'number') return `its ${name} is not a number`;
  if (!Number.isSafeInteger(value) || value < 0) return `its ${name} is not a whole number from 0 to 2^53 − 1`;
  return null;
}

/** A previous scan's record as a projection: its file and folder counts, or why they cannot be read as one. */
function fromSnapshot(record: SnapshotCounts): EntryProjection {
  const unusable = (why: string): EntryProjection => ({ entries: null, source: 'none', reason: `the newest scan of this folder on record has no usable size: ${why}` });
  const problem = countProblem('file count', record.fileCount) ?? countProblem('folder count', record.dirCount);
  if (problem !== null) return unusable(problem);
  const entries = (record.fileCount as number) + (record.dirCount as number);
  if (!Number.isSafeInteger(entries)) return unusable('its file and folder counts add up past 2^53 − 1');
  return { entries, source: 'previousScan', reason: `the previous scan of this folder counted ${formatCount(entries)} items` };
}

/** With no previous scan (`lead` says why), the hint of the volumes the folder covers whole, or why there is none. */
async function fromUsedInodes(rootPath: string, deps: ProjectionDeps, lead: string): Promise<EntryProjection> {
  const mounts = await wholeVolumeMounts(rootPath, deps);
  if (mounts === null) {
    return { entries: null, source: 'none', reason: `${lead}, and it is not the root of a volume, whose used inodes could hint at its size` };
  }
  const counts = await Promise.all(mounts.map((mount) => usedInodes(mount, deps)));
  let entries = 0;
  for (const [k, count] of counts.entries()) {
    // Any volume unknown makes the whole hint unknown: never a partial sum.
    if (count.used === null) return { entries: null, source: 'none', reason: `${lead}, and the inodes in use on ${mounts[k]} are unknown: ${count.why}` };
    entries += count.used;
  }
  return {
    entries,
    source: 'usedInodes',
    reason: `${lead}; ${formatCount(entries)} inodes are in use on ${mounts.join(' and ')}, which is only a hint: a file with several names uses one inode`,
  };
}

/**
 * The projection for a native scan of `rootPath` (see the module docs). Never
 * throws: each dep's failure — a rejection or a throw — is caught where it is
 * called and becomes a reason, and the outer net turns anything else (a dep
 * answering outside its contract) into an unknown with its reason.
 */
export async function projectEntries(rootPath: string, deps: ProjectionDeps = LIVE): Promise<EntryProjection> {
  try {
    let lead = NO_EARLIER_SCAN;
    try {
      const newest = newestOf(await deps.snapshots(rootPath), rootPath);
      if (newest !== null) return fromSnapshot(newest);
    } catch (err: unknown) {
      lead = `the earlier scans on record could not be read (${describe(err)})`;
    }
    return await fromUsedInodes(rootPath, deps, lead);
  } catch (err: unknown) {
    return { entries: null, source: 'none', reason: `the size of this folder could not be projected (${describe(err)})` };
  }
}

/** A test's projection for one root: as it is, or a function that gives it, so a test can hold it pending. */
export type ProjectionForTests = EntryProjection | (() => Promise<EntryProjection>);

const projectionsForTests = new Map<string, ProjectionForTests>();

/** Tests only: the projection a scan of `rootPath` gets — a temp folder is never a whole volume; null removes it. */
export function setProjectionForTests(rootPath: string, projection: ProjectionForTests | null): void {
  if (projection === null) projectionsForTests.delete(rootPath);
  else projectionsForTests.set(rootPath, projection);
}

/** The projection `startScan` gives a native scan of `rootPath`: a test's, else `projectEntries`'. */
export async function nativeProjection(rootPath: string): Promise<EntryProjection> {
  const held = projectionsForTests.get(rootPath);
  if (held === undefined) return projectEntries(rootPath);
  return typeof held === 'function' ? held() : held;
}
