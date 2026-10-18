import v8 from 'node:v8';
import vm from 'node:vm';

/**
 * Heap readings for tests that bound what a piece of work holds: a count of
 * bytes, never a time.
 *
 * GitHub's macOS runner has 7 GB of memory, so Node gives a test process a
 * heap of about 2 GB there; this Mac's 16 GB give it twice that. A test whose
 * work held memory in proportion to the square of its input passed here and
 * ran CI's heap out (run 39095045009: the query walk on a 30k-deep chain held
 * about 2.7 GB). A bound on what the work holds fails on every machine alike.
 */

/** A full collection on demand: the flag set at run time, as tests/packedStoreRelease.test.ts does. */
export function collector(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** The bytes the heap holds once everything unreachable is collected. */
export function heldBytes(gc: () => void): number {
  gc();
  return process.memoryUsage().heapUsed;
}
