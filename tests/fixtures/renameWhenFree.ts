import fs from 'node:fs';

/**
 * How many refused attempts `renameWhenFree` makes before it gives up: a guard
 * against a folder that never comes free, counted rather than timed. Each
 * refused rename returns in microseconds, so this is seconds of spinning.
 */
export const RENAME_ATTEMPTS = 5_000_000;

/** What Windows answers while a handle is open somewhere inside the folder. */
const HANDLE_HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Renames `from` to `to` in one step, retrying for as long as Windows refuses
 * because something holds a handle inside the folder — a scan listing it does
 * (the Windows CI leg of 24 Sep 2026: EPERM). POSIX renames at once. It spins
 * synchronously on purpose: a scan's root check finishes on the event loop,
 * which cannot turn while this runs, so the rename lands before that check
 * unless the check's lstat had already gone to a pool thread. Any other error
 * is thrown at once. Answers how many attempts were refused.
 */
export function renameWhenFree(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = fs.renameSync,
  attempts: number = RENAME_ATTEMPTS,
): number {
  for (let refused = 0; ; refused++) {
    try {
      rename(from, to);
      return refused;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!HANDLE_HELD.has(code) || refused + 1 >= attempts) throw err;
    }
  }
}
