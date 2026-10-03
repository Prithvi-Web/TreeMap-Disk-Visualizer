/**
 * completionSlices — the part of a native scan's completion that has to run
 * on the main thread, run a slice at a time (Track U, U-35).
 *
 * A finished walk still leaves Node work over the whole tree: on the memory
 * path, the passes over the store the native build hands over (text
 * candidates, cloud candidates, refused folders). Run in one go, a whole
 * disk's held the event loop for seconds, and every request, every progress
 * frame and, in the app, the window's own process waited behind it. Here the
 * work takes `sliceNodes` steps at a time, and the event loop gets a turn
 * after each slice.
 *
 * Unlike the walks in `slices.ts`, which read a published store that the
 * watcher or a delete can change between slices, this work builds a store
 * nothing else can see yet — the scan is not complete, so no reader, watcher
 * or delete reaches it — so there is no version guard and no second attempt:
 * the work runs once, in order. A scan stopped between two slices ends it
 * there, unfinished, and the caller writes nothing.
 */

/** How the work is sliced. Every field has a default; tests set them to count. */
export interface CompletionSliceOptions {
  /** Hands the event loop a turn after each slice. Default: a `setImmediate` turn. */
  yieldTurn?: () => Promise<void>;
  /** Steps per slice. Default: the caller's. */
  sliceNodes?: number;
  /** Read before every slice and after the last one: true ends the work there, unfinished. */
  isCancelled?: () => boolean;
}

/** Work that can stop between any two of its steps. */
export interface SliceWork {
  /** True once every step is taken. */
  readonly done: boolean;
  /** Takes up to `budget` steps. */
  step(budget: number): void;
}

export interface SliceOutcome {
  /** False when a cancel ended the work before its last step. */
  completed: boolean;
  /** CPU the slices themselves took, in microseconds: the turns between them, which run other work, are not counted. */
  cpuMicros: number;
}

const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** A `process.cpuUsage()` reading, or a difference of two, in microseconds. */
export function cpuMicros(usage: NodeJS.CpuUsage): number {
  return usage.user + usage.system;
}

/**
 * Runs `work` a slice at a time, a turn after each slice: so the turns taken
 * are ceil(steps / slice), and none for work with no step to take.
 */
export async function runInSlices(work: SliceWork, options: CompletionSliceOptions, defaultSlice: number): Promise<SliceOutcome> {
  const yieldTurn = options.yieldTurn ?? nextTurn;
  const slice = options.sliceNodes !== undefined && options.sliceNodes >= 1 ? options.sliceNodes : defaultSlice;
  let used = 0;
  for (;;) {
    if (options.isCancelled?.() === true) return { completed: false, cpuMicros: used };
    if (work.done) return { completed: true, cpuMicros: used };
    const before = process.cpuUsage();
    work.step(slice);
    used += cpuMicros(process.cpuUsage(before));
    await yieldTurn();
  }
}

let optionsForTests: CompletionSliceOptions | null = null;

/** Tests only: how `runNativeWalk` slices a completion — a slice size and a counted turn; null restores the defaults. */
export function setCompletionSlicesForTests(options: CompletionSliceOptions | null): void {
  optionsForTests = options;
}

/** The slicing a completion runs with: the defaults, or a test's. */
export function completionSliceOptions(): CompletionSliceOptions {
  return optionsForTests ?? {};
}
