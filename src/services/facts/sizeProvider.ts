import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `size` fact provider — the seam test for the whole fact layer (§0.2).
 *
 * It computes nothing the scan does not already know: it echoes each path's
 * own byte count straight out of the packed store. That is the point. Before
 * any real provider exists, this one proves the plumbing end to end — the
 * registry, the batching, the TTL cache, the path guard, the response shape —
 * against an answer that cannot itself be wrong.
 *
 * It also demonstrates the layer's sharpest rule at a scale where it is easy
 * to check: **a path the scan does not contain is `skipped`, and is simply
 * absent from `values`.** It is never reported as `bytes: 0`. A pruned-away
 * or since-deleted path is unknown, and unknown is not empty. Every provider
 * added after this one inherits that behaviour, and `tests/facts.test.ts`
 * pins it here where the arithmetic is obvious.
 */

export interface SizeFact {
  /** The scan's own byte count for this path. */
  bytes: number;
}

export const sizeProvider: FactProvider<SizeFact> = {
  id: 'size',
  label: 'Size from the scan',
  // Depends on nothing this machine might lack — the scan is already in memory.
  capabilityKey: null,

  async compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<SizeFact>> {
    const scan = getScan(scanId);
    if (!scan) {
      // Scans live ~30 minutes. An expired one is a real, explainable state,
      // not an error — and saying so beats returning zeroes for every path.
      return unavailableBatch('That scan has expired. Scan the folder again to read its sizes.', paths.length);
    }
    if (scan.status === 'running') {
      return unavailableBatch('That scan is still running — sizes are not final yet.', paths.length);
    }
    if (!scan.store && !scan.root) {
      return unavailableBatch(scan.error ?? 'That scan did not complete, so it has no sizes to read.', paths.length);
    }

    const store = storeOf(scan);
    const values = new Map<string, SizeFact>();
    let skipped = 0;

    for (let i = 0; i < paths.length; i++) {
      // Cheap per-path work, but a 2,000-path batch still runs long enough to
      // outlive a cancelled request; stopping here means the caller's abort
      // actually frees the event loop rather than merely being ignored.
      //
      // Everything left unvisited counts as skipped, not lost: `requested`
      // must always equal computed + skipped + failed, or a caller cannot
      // state its own coverage honestly (§2.4).
      if (signal.aborted) {
        skipped += paths.length - i;
        break;
      }
      const id = store.findByPath(paths[i]);
      if (id === -1) {
        // Not in this scan's tree. Absent from `values` — never zero.
        skipped++;
        continue;
      }
      values.set(paths[i], { bytes: store.size(id) });
    }

    return {
      available: true,
      values,
      stats: {
        requested: paths.length,
        computed: values.size,
        skipped,
        // Reading a size out of an in-memory store cannot fail per path: the
        // id either resolves or it does not, and "does not" is `skipped`.
        failed: 0,
      },
    };
  },
};
