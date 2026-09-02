import type { ScanResult } from '../models/types';

/**
 * Folders the OS would not let a scan list, counted and named.
 *
 * The count is the whole truth available — a folder that will not open has an
 * unknowable size — and the page needs to be able to name one, so the scan
 * keeps a handful of examples. Walkers reach directories in whatever order
 * the threadpool returns them, so "the first five seen" would differ between
 * two scans of the same tree; the five SMALLEST paths, kept sorted, are the
 * same for the same tree every time.
 */
export const REFUSED_EXAMPLES = 5;

/** Insert `p` into the sorted list if it belongs among the `cap` smallest. */
export function keepSmallest(list: string[], p: string, cap = REFUSED_EXAMPLES): void {
  if (list.length >= cap && p >= list[list.length - 1]) return;
  let i = 0;
  while (i < list.length && list[i] < p) i++;
  if (list[i] === p) return; // already there
  list.splice(i, 0, p);
  if (list.length > cap) list.pop();
}

/** One more folder refused to `scan`. */
export function noteRefused(scan: ScanResult, dirPath: string): void {
  scan.deniedDirs = (scan.deniedDirs ?? 0) + 1;
  scan.deniedExamples = scan.deniedExamples ?? [];
  keepSmallest(scan.deniedExamples, dirPath);
}
