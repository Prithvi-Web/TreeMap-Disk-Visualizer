import fs from 'fs';
import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import { lookDeadlineMs, realDeadline } from '../emptyFolderCheck';
import { platform } from '../../platform';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `onDisk` fact provider — what a file takes on its disk now (fifth
 * browser pass F09).
 *
 * The scan counts the size each file CLAIMS. A sparse file (a virtual
 * machine's disk, Docker.raw), a compressed file or a cloud placeholder claims
 * more than it takes, and moving it to the Trash frees only what it takes:
 * Clean Up said "2 files · up to 3.9 GB, freed when you empty the Trash" for
 * two files that take 0 B. This reads each file's allocation — its blocks, 512
 * bytes each — from a metadata read (lstat). No file is opened.
 *
 * Files only: what a folder takes needs a walk, so a folder is skipped, as is
 * a path the scan does not hold. Unavailable where the system does not report
 * blocks (Windows). A file that cannot be looked at now — gone since the scan,
 * refused — is failed: absent from `values`, never a zero.
 *
 * A drive can stop answering after the scan (a NAS asleep, a share gone), and
 * a look at a file on it can then wait minutes or for ever (review F1.1). Each
 * look has the empty-folder check's deadline (2 s); one that misses it is
 * failed, the request asks nothing more, and while that look is still out no
 * request asks anything — the fact is unavailable, saying why — so a quiet
 * drive holds one thread of the I/O pool, never one per request.
 */
export interface OnDiskFact {
  /** Bytes the file occupies on its disk now: its allocated blocks × 512. */
  bytes: number;
}

/** Why there is no answer on a system whose files report no blocks. */
export const ON_DISK_UNAVAILABLE =
  'This system reports the size each file claims but not the space it takes on the disk, so TreeMap cannot say how much less a sparse or compressed file takes.';

/** Why there is no answer while a look that missed its deadline is still out. */
export const ON_DISK_DRIVE_SILENT =
  'A drive did not answer when TreeMap last looked at a file on it, so TreeMap asks nothing more until it does: what these files take on the disk is unknown for now.';

/** What the provider looks with: the disk and the clock, or a test's stand-ins. */
interface OnDiskDeps {
  lstat: (p: string) => Promise<fs.Stats>;
  deadline: (ms: number) => { late: Promise<void>; cancel: () => void };
}

const REAL: OnDiskDeps = { lstat: (p) => fs.promises.lstat(p), deadline: realDeadline };
let deps: OnDiskDeps = REAL;

/** Test seam: the provider's lstat and deadline (null restores the real ones). */
export function setOnDiskForTests(over: Partial<OnDiskDeps> | null): void {
  deps = over ? { ...REAL, ...over } : REAL;
}

/** Looks that missed their deadline and have not come back yet. */
let stillOut = 0;

const LATE = Symbol('late');

/** One file's look, or LATE when it misses its deadline — counted out until it comes back. */
async function lookAt(p: string): Promise<fs.Stats | typeof LATE> {
  const look = deps.lstat(p);
  const deadline = deps.deadline(lookDeadlineMs());
  try {
    const first = await Promise.race([look, deadline.late.then((): typeof LATE => LATE)]);
    if (first === LATE) {
      stillOut++;
      look.then(() => {}, () => {}).finally(() => { stillOut--; });
    }
    return first;
  } finally {
    deadline.cancel();
  }
}

export const onDiskProvider: FactProvider<OnDiskFact> = {
  id: 'onDisk',
  label: 'What a file takes on the disk',
  capabilityKey: null,

  async compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<OnDiskFact>> {
    if (!platform().blocksAreMeaningful) return unavailableBatch(ON_DISK_UNAVAILABLE, paths.length);
    const scan = getScan(scanId);
    if (!scan) return unavailableBatch('That scan has expired. Scan the folder again to measure its files.', paths.length);
    if (scan.status === 'running') return unavailableBatch('That scan is still running — its files are measured once it finishes.', paths.length);
    if (!scan.store && !scan.root) return unavailableBatch(scan.error ?? 'That scan did not complete, so it has no files to measure.', paths.length);
    if (stillOut > 0) return unavailableBatch(ON_DISK_DRIVE_SILENT, paths.length);

    const store = storeOf(scan);
    const values = new Map<string, OnDiskFact>();
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < paths.length; i++) {
      if (signal.aborted) {
        skipped += paths.length - i;
        break;
      }
      const id = store.findByPath(paths[i]);
      // Not in this scan's tree, or a folder: no answer here, and never a zero.
      if (id === -1 || store.isDir(id)) {
        skipped++;
        continue;
      }
      try {
        // One at a time: a drive that does not answer holds one of the I/O
        // pool's threads, never all of them.
        const st = await lookAt(paths[i]);
        if (st === LATE) {
          // Not answered in time: unknown, never a zero — and the rest of
          // this request is not asked of a disk that may be the same one.
          failed++;
          skipped += paths.length - i - 1;
          break;
        }
        values.set(paths[i], { bytes: Number(st.blocks) * 512 });
      } catch {
        failed++;
      }
    }
    return { available: true, values, stats: { requested: paths.length, computed: values.size, skipped, failed } };
  },
};
