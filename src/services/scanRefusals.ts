import type { ScanResult } from '../models/types';
import { Flag, type ScanStore } from './scanStore';
import { noteRefusedBelow } from '../utils/mountBoundaries';

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

/**
 * One more folder refused to `scan`. The walker and the native ingest name a
 * refused folder here, so this is also where a drive mounted beneath it is
 * recorded as never reached (Track U, U-24): it was not "not entered", nothing
 * got near it. The native memory path's sliced adopt (U-35) keeps its own
 * count and examples and records the drives through `noteUnlistedBelow`. gdu
 * names no refused folder (U-12), and the native memory path names no
 * unreadable one, so there a drive beneath such a folder reads as reached.
 */
export function noteRefused(scan: ScanResult, dirPath: string): void {
  scan.deniedDirs = (scan.deniedDirs ?? 0) + 1;
  scan.deniedExamples = scan.deniedExamples ?? [];
  keepSmallest(scan.deniedExamples, dirPath);
  if (scan.boundary) noteRefusedBelow(scan.boundary, dirPath);
}

/**
 * A folder the walk could not list — unreadable, past the deadline, vanished
 * mid-walk (the walker and the native ingest), or refused (the native memory
 * path's sliced adopt, which keeps its own count): a drive mounted beneath it
 * was never reached, so it is not reported as "not entered" (Track U, TS
 * review R6). Its count is the caller's.
 */
export function noteUnlistedBelow(scan: ScanResult, dirPath: string): void {
  if (scan.boundary) noteRefusedBelow(scan.boundary, dirPath);
}

/**
 * Folder `id` is one whose whole listing the tree does not hold (Track U, U-4,
 * `Flag.Unlisted`): refused, unreadable, vanished mid-walk, never entered, or
 * listed with entries left out. Its node looks childless, or emptier than it
 * is, so Empty Folders never offers it nor any folder above it. Every engine
 * marks it where it knows (decision U-D12: what was not listed is taken from the
 * walk's own records, never from "a childless node"). An id taken before
 * `finalize()` is fine: the flag moves with its node when the store renumbers.
 * Marking twice changes nothing, and bumps the store's version once.
 */
export function markUnlisted(store: ScanStore, id: number): void {
  if (!store.flag(id, Flag.Unlisted)) store.setFlag(id, Flag.Unlisted, true);
}

/**
 * The never-descend paths a finished scan did not enter, marked `Flag.Unlisted`
 * on any engine's tree (the walker, both native paths, gdu, the NTFS turbo
 * mode): the folder at each path strictly under the root, or — where an engine
 * left the node out, as gdu's `-x` drops a mount point — the folder that held
 * it, whose listing is then short of it. A path that is the root was listed
 * (a never-descend path may be chosen as the root). A path whose parent the
 * tree does not hold either, or whose parent is the root, marks nothing: no
 * folder Empty Folders could offer lost an entry to it.
 *
 * `settleComplete` hands it the scan's own never-descend list (U-24): the
 * fixed folders and, under "Stay on this drive", every drive mounted inside
 * that the scan did not enter, so a not-entered mount is kept out of Empty
 * Folders by this same mark on every engine.
 */
export function markUnlistedPaths(store: ScanStore, paths: readonly string[]): void {
  const root = store.rootPath;
  const base = root.endsWith(store.sep) ? root : root + store.sep;
  for (const p of paths) {
    if (p.length <= base.length || !p.startsWith(base)) continue;
    const id = store.findByPath(p);
    if (id !== -1) {
      markUnlisted(store, id);
      continue;
    }
    const cut = p.lastIndexOf(store.sep);
    if (cut < base.length) continue; // its parent is the root
    const parent = store.findByPath(p.slice(0, cut));
    if (parent !== -1) markUnlisted(store, parent);
  }
}
