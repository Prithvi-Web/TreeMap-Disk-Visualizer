import { ScanStore } from './scanStore';

/**
 * slices — work over a scan's tree that has to stay on the main thread, run in
 * slices under a version guard (Track U, U-D9).
 *
 * A walk that can stop between any two of its steps is run `sliceNodes` steps
 * at a time, and the event loop gets a turn after each slice, so a request,
 * a progress frame or the window's own work is never held for a whole tree.
 * The store can change during those turns (the watcher, a delete); a walk
 * that saw a change starts again from the beginning, so an answer never mixes
 * two versions of the tree. At most MAX_SLICE_ATTEMPTS walks are made and the
 * last runs in one turn: a store that never stops changing costs one stall,
 * like the walks before slicing did, never a walk that cannot finish.
 *
 * Used by the cleanup suggestions (U-16) and the dashboard's lists (U-17).
 */

/** A walk that can stop between any two of its steps. */
export interface SlicedWalk {
  /** Takes up to `budget` steps; true once the walk is complete. */
  step(budget: number): boolean;
}

/** How a walk slices itself. Every field has a default; tests set them to count. */
export interface SliceOptions {
  /** Hands the event loop a turn between slices. Default: a `setImmediate` turn. */
  yieldTurn?: () => Promise<void>;
  /** Steps per slice. Default: the caller's. */
  sliceNodes?: number;
  /** Told the number of each attempt as it starts (a test counts restarts by it). */
  onAttempt?: (attempt: number) => void;
}

/** U-D9: walks of a store that changed between slices; the last runs in one turn. */
export const MAX_SLICE_ATTEMPTS = 3;

const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const counts = { walks: 0, attempts: 0 };

/**
 * Runs the walk `begin` makes in slices, under the version guard. `begin` is
 * called once per attempt and must start from scratch, so whatever it gathers
 * belongs to the attempt that finished. The answer describes `version`: the
 * store was unchanged from that walk's first step to its last.
 */
export async function walkInSlices<W extends SlicedWalk>(
  store: ScanStore,
  begin: (attempt: number) => W,
  options: SliceOptions,
  defaultSlice: number,
): Promise<{ walk: W; version: number; attempts: number }> {
  const yieldTurn = options.yieldTurn ?? nextTurn;
  const slice = options.sliceNodes !== undefined && options.sliceNodes >= 1 ? options.sliceNodes : defaultSlice;
  counts.walks++;
  for (let attempt = 1; ; attempt++) {
    counts.attempts++;
    options.onAttempt?.(attempt);
    const version = store.version;
    const walk = begin(attempt);
    if (attempt >= MAX_SLICE_ATTEMPTS) {
      walk.step(Infinity);
      return { walk, version, attempts: attempt };
    }
    let changed = false;
    for (let done = false; !done;) {
      done = walk.step(slice);
      await yieldTurn();
      if (store.version !== version) { changed = true; break; }
    }
    if (!changed) return { walk, version, attempts: attempt };
  }
}

/** Test seam: sliced walks and attempts begun since the last reset — counted, never timed. */
export function slicedWalkCountsForTests(): { walks: number; attempts: number } {
  return { ...counts };
}

/** Test seam: zero the counts. */
export function resetSlicedWalkCountsForTests(): void {
  counts.walks = 0;
  counts.attempts = 0;
}
