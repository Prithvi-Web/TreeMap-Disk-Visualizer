import fs from 'fs';
import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
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
 */
export interface OnDiskFact {
  /** Bytes the file occupies on its disk now: its allocated blocks × 512. */
  bytes: number;
}

/** Why there is no answer on a system whose files report no blocks. */
export const ON_DISK_UNAVAILABLE =
  'This system reports the size each file claims but not the space it takes on the disk, so TreeMap cannot say how much less a sparse or compressed file takes.';

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
        const st = await fs.promises.lstat(paths[i]);
        values.set(paths[i], { bytes: Number(st.blocks) * 512 });
      } catch {
        failed++;
      }
    }
    return { available: true, values, stats: { requested: paths.length, computed: values.size, skipped, failed } };
  },
};
