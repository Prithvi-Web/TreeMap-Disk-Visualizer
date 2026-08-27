/**
 * Run async work with a ceiling on how much is in flight.
 *
 * ── Why a ceiling, and why this number ──
 *
 * The per-OS bulk readers behind the Reclaim Score (v4 §3) each spend their
 * time inside a subprocess doing blocking filesystem syscalls, so running one
 * chunk at a time leaves seven of eight cores idle waiting on the eighth.
 * Measured on this Mac, `xattr` over 5,000 paths:
 *
 *   sequential, 500/chunk ......... 168.0 ms   (as originally shipped)
 *   4 at a time, 1250/chunk ........ 73.7 ms   ← 2.3x
 *   8 at a time, 625/chunk ........ 136.9 ms
 *
 * **More is not better.** Eight concurrent readers on eight cores was almost
 * as slow as running them one at a time: the processes contend for the same
 * disk queue and for the cores Node itself needs, and the scheduler spends
 * the difference. Four is the measured knee, and it matches the
 * `HASH_CONCURRENCY` the duplicate finder already settled on for the same
 * reason.
 *
 * Note the batch-size axis is nearly flat on its own — one spawn for 5,000
 * paths measured 155 ms against 167 ms for ten spawns, so a spawn costs about
 * 1.2 ms and the work is in the syscalls, not the process creation. Raising
 * the chunk size alone would have bought ~7% while pushing argv toward
 * ARG_MAX. Concurrency is where the time actually is.
 */

/** The measured knee for subprocess-bound filesystem work on this class of machine. */
export const IO_SUBPROCESS_CONCURRENCY = 4;

/**
 * Map `items` through `fn`, at most `limit` in flight, preserving order.
 *
 * Rejects if `fn` does — callers that need per-item isolation catch inside
 * `fn`, exactly as the duplicate finder does with `.catch(() => null)`.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}
