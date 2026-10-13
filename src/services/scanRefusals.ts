import type { ScanResult } from '../models/types';
import { Flag, type ScanStore } from './scanStore';
import { noteRefusedBelow } from '../utils/mountBoundaries';
import { formatCount } from '../utils/formatCount';

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

/**
 * How many refused folders a scan names in full (browser re-check C06): the
 * page said "69 folders could not be read" and named five, and nothing in
 * the app could name the other 64. GET /api/scan/:scanId/refused serves this
 * list. It is bounded, so a scan refused hundreds of thousands of folders
 * holds a list of a known size: past the cap the smallest paths are named, as
 * the five examples are, and the rest are counted and said to be.
 */
export const REFUSED_LIST_CAP = 10_000;

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
 * Add `p` to `list`, a refused-folder list read by `refusedFolders`. Paths are
 * appended as the walk meets them and cut back to the REFUSED_LIST_CAP
 * smallest whenever the list reaches twice the cap, so the list never holds
 * twice the cap and the cut is paid once per cap's worth of paths. What the
 * cut keeps is the smallest of everything seen, so the answer does not depend
 * on the order the walk met the folders in.
 */
export function keepRefusedPath(list: string[], p: string): void {
  list.push(p);
  if (list.length >= 2 * REFUSED_LIST_CAP) {
    list.sort();
    list.length = REFUSED_LIST_CAP;
  }
}

/**
 * One more folder refused to `scan`. The walker and the native ingest name a
 * refused folder here, so this is also where a drive mounted beneath it is
 * recorded as never reached (Track U, U-24): it was not "not entered", nothing
 * got near it. The native memory path's sliced adopt (U-35) keeps its own
 * count and paths, added with `addRefused`, and records the drives through
 * `noteUnlistedBelow`. gdu names no refused folder (U-12), and the native
 * memory path names no unreadable one, so there a drive beneath such a folder
 * reads as reached.
 */
export function noteRefused(scan: ScanResult, dirPath: string): void {
  scan.deniedDirs = (scan.deniedDirs ?? 0) + 1;
  scan.deniedExamples = scan.deniedExamples ?? [];
  keepSmallest(scan.deniedExamples, dirPath);
  scan.deniedPaths = scan.deniedPaths ?? [];
  keepRefusedPath(scan.deniedPaths, dirPath);
  if (scan.boundary) noteRefusedBelow(scan.boundary, dirPath);
}

/**
 * Refusals counted apart from the record — a gdu shard, the native memory
 * path's adopt — added to it: `count` to the count, and every one of `paths`
 * (each part keeps its own with `keepRefusedPath`, so they include its
 * smallest) to the list and among the five examples.
 */
export function addRefused(scan: ScanResult, count: number, paths: readonly string[]): void {
  scan.deniedDirs = (scan.deniedDirs ?? 0) + count;
  scan.deniedExamples = scan.deniedExamples ?? [];
  scan.deniedPaths = scan.deniedPaths ?? [];
  for (const p of paths) {
    keepSmallest(scan.deniedExamples, p);
    keepRefusedPath(scan.deniedPaths, p);
  }
}

/** What GET /api/scan/:scanId/refused says of a scan's refused folders, but its id and status. */
export interface RefusedFolderList {
  /** How many folders the scan was refused: /stats' `refused.dirs`. */
  dirs: number;
  /** Their absolute paths in path order, at most REFUSED_LIST_CAP (the smallest). */
  paths: string[];
  /** Refused folders counted but not in `paths`; 0 when every one is named. */
  unnamed: number;
  /** Why some are not named, in a sentence; null when none are left out. */
  unnamedReason: string | null;
}

/** The folders `scan` was refused, every one by path up to the cap, the rest counted. */
export function refusedFolders(scan: ScanResult): RefusedFolderList {
  const dirs = scan.deniedDirs ?? 0;
  const paths = [...(scan.deniedPaths ?? [])].sort().slice(0, REFUSED_LIST_CAP);
  const unnamed = Math.max(0, dirs - paths.length);
  const unnamedReason = unnamed > 0
    ? `TreeMap names the first ${formatCount(REFUSED_LIST_CAP)} of them, in path order; the other ${formatCount(unnamed)} ${unnamed === 1 ? 'was' : 'were'} counted but not named.`
    : null;
  return { dirs, paths, unnamed, unnamedReason };
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
 *
 * Each path is found name by name from the root through `listingsOf`, which reads
 * a folder's listing once for the whole call: a lookup by path scans every child
 * of each folder on the way down, so asking one per path read a Docker host's
 * overlay2 folder (5,000 mounts) 5,000 times (the SEC-1 review, L4).
 */
export function markUnlistedPaths(store: ScanStore, paths: readonly string[]): void {
  const root = store.rootPath;
  const base = root.endsWith(store.sep) ? root : root + store.sep;
  const find = listingsOf(store);
  for (const p of paths) {
    if (p.length <= base.length || !p.startsWith(base)) continue;
    const names = p.slice(base.length).split(store.sep);
    const id = find(names);
    if (id !== -1) {
      markUnlisted(store, id);
      continue;
    }
    if (names.length < 2) continue; // its parent is the root
    const parent = find(names.slice(0, -1));
    if (parent !== -1) markUnlisted(store, parent);
  }
}

/**
 * A lookup of a node by its names below the root, as `findByPath` answers it,
 * that reads each folder's listing once and remembers it by name for as long as
 * the lookup is kept. Of two children of one name — an archive's listing or a
 * sliced adopt can hold two — it takes the first whose subtree holds the rest
 * of the path, as `findByPath` does; taking the first of each name marked the
 * wrong folder, or none (the SEC-2 review, LOW-2).
 */
function listingsOf(store: ScanStore): (names: readonly string[]) => number {
  const byFolder = new Map<number, Map<string, number[]>>();
  const listing = (id: number): Map<string, number[]> => {
    let children = byFolder.get(id);
    if (children === undefined) {
      const named = new Map<string, number[]>();
      store.forEachChild(id, (child) => {
        const name = store.name(child);
        const same = named.get(name);
        if (same) same.push(child);
        else named.set(name, [child]);
      });
      children = named;
      byFolder.set(id, children);
    }
    return children;
  };
  const find = (id: number, names: readonly string[], depth: number): number => {
    if (depth === names.length) return id;
    for (const child of listing(id).get(names[depth]) ?? []) {
      const found = find(child, names, depth + 1);
      if (found !== -1) return found;
    }
    return -1;
  };
  return (names) => find(store.rootId, names, 0);
}
