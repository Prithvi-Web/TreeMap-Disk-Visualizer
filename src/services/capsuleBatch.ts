import { promises as fsp } from 'fs';
import path from 'path';
import { realPlaceOf } from '../utils/pathSanitizer';

/**
 * A batch as the Time Capsule deletes it (FG3, FG3b, FG3c): each item once, and an item inside
 * another item of the batch set apart, to go with the item holding it — that one is copied and
 * trashed whole, taking it along, so it gets no copy and no trash step of its own.
 *
 * "Inside" is judged by where each path is on the disk, never by how it is spelled (FG3c). A
 * request is placed by the native realpath of the folder it is in (every link above it resolved,
 * each name as the volume stores it — on macOS and Windows; Linux's realpath keeps each name as it
 * was typed, so there `proj` and `PROJ` stay two items even on a volume that folds case), so
 * `/var/x/proj` and `/private/var/x/proj/a.txt`, or `proj` and `PROJ/a.txt` on a Mac or Windows
 * volume that folds case, are one folder and an item in it — while `A/lnk/x`,
 * where `lnk` is a link out of `A`, is not in `A`, and trashing `A` would take only the link. Only a
 * real folder holds anything: a link is itself the item, wherever it leads. And a folder holds only
 * what is on its own device, so what is on a volume mounted inside it is not taken for part of it —
 * unless the batch holds the volume's root too: that root is an entry of the folder and goes with
 * it, taking what it holds along (FG3d #4). A request the disk cannot place (gone, or unreadable) is
 * its own item, judged by the disk when it is trashed.
 */

/** Where one request is on the disk. */
interface Place {
  /** One key per item however it is spelled: the real path, or for a link its real folder and its identity. */
  key: string;
  /** The real folder the item is in, and that folder's device. */
  realParent: string;
  parentDev: bigint;
  /** For a real folder (not a link): where it is and its device — so it can hold other items. */
  holds: { at: string; dev: bigint } | null;
  /** The item's own place, its real folder and its own name: where a trash step's failure is judged. */
  realPath: string;
}

/** How the disk is read here — the real one, or a test's stand-in for what no test can make (a mount). */
export interface PlaceReader {
  lstat(p: string): Promise<{ dev: bigint; ino: bigint; isSymbolicLink(): boolean; isDirectory(): boolean } | null>;
  stat(p: string): Promise<{ dev: bigint } | null>;
  realPlaceOf(p: string): Promise<string | null>;
}

const DISK: PlaceReader = {
  lstat: (p) => fsp.lstat(p, { bigint: true }).catch(() => null),
  stat: (p) => fsp.stat(p, { bigint: true }).catch(() => null),
  realPlaceOf,
};

async function placeOf(p: string, disk: PlaceReader): Promise<Place | null> {
  const st = await disk.lstat(p);
  if (st === null) return null;
  const realParent = await disk.realPlaceOf(path.dirname(p));
  if (realParent === null) return null;
  const parent = await disk.stat(realParent);
  if (parent === null) return null;
  if (st.isSymbolicLink()) {
    // The link itself, named by its folder and its identity (its own name need not be looked up).
    const realPath = path.join(realParent, path.basename(p));
    return { key: `${realParent}\0${st.dev}:${st.ino}`, realParent, parentDev: parent.dev, holds: null, realPath };
  }
  const real = await disk.realPlaceOf(p);
  if (real === null) return null;
  return { key: real, realParent, parentDev: parent.dev, holds: st.isDirectory() ? { at: real, dev: st.dev } : null, realPath: real };
}

export interface CollapsedBatch<T> {
  /** One request per item, none inside another: each gets its own copy and trash step. */
  top: T[];
  /**
   * The rest, each with `by`, the outermost request of `top` holding it (`same`: it is that item,
   * spelled another way). It goes as `by` goes.
   */
  covered: { request: T; by: string; same: boolean }[];
  /** Each placed request's own place on the disk, by its spelling: where a failure is judged. */
  realPathOf: Map<string, string>;
}

/** The batch, collapsed as the disk places it. Reads the disk (`disk`, the real one); writes nothing. */
export async function collapseBatch<T extends { path: string }>(batch: T[], disk: PlaceReader = DISK): Promise<CollapsedBatch<T>> {
  // The same spelling twice is one request (FG3), keeping the first.
  const firstOf = new Map<string, T>();
  for (const request of batch) {
    const spelled = path.resolve(request.path);
    if (!firstOf.has(spelled)) firstOf.set(spelled, request);
  }
  const placed: { request: T; place: Place | null }[] = [];
  for (const request of firstOf.values()) placed.push({ request, place: await placeOf(request.path, disk) });

  // The first request of each item, and the real folders that can hold others.
  const firstAt = new Map<string, T>();
  const holders = new Map<string, { request: T; dev: bigint }>();
  for (const { request, place } of placed) {
    if (place === null || firstAt.has(place.key)) continue;
    firstAt.set(place.key, request);
    if (place.holds !== null) holders.set(place.holds.at, { request, dev: place.holds.dev });
  }
  /** The outermost real folder of the batch this place lies in, on its own device, or null. */
  const outermostHolding = (place: Place, self: T): T | null => {
    let by: T | null = null;
    for (let at = place.realParent; ; at = path.dirname(at)) {
      const holder = holders.get(at);
      if (holder !== undefined && holder.request !== self && holder.dev === place.parentDev) by = holder.request; // keep climbing
      if (path.dirname(at) === at) return by;
    }
  };

  const collapsed: CollapsedBatch<T> = { top: [], covered: [], realPathOf: new Map() };
  for (const { request, place } of placed) {
    if (place === null) {
      collapsed.top.push(request);
      continue;
    }
    collapsed.realPathOf.set(request.path, place.realPath);
    const first = firstAt.get(place.key) as T;
    const outer = outermostHolding(place, first);
    if (first === request && outer === null) collapsed.top.push(request);
    else if (outer !== null) collapsed.covered.push({ request, by: outer.path, same: false });
    else collapsed.covered.push({ request, by: first.path, same: true });
  }
  // `by` is a request of `top` (FG3d #4). A holder can itself be held — a volume's root mounted
  // inside a folder of the batch is that folder's entry, while what is on the volume is held by the
  // root alone — and then what it holds goes as the item holding it goes. The chain climbs real
  // folders, so it ends; the bound only makes that plain.
  const tops = new Set(collapsed.top.map((r) => r.path));
  const holderOf = new Map(collapsed.covered.map((c) => [c.request.path, c.by]));
  const outermost = (by: string): string => {
    let at = by;
    for (let hops = 0; !tops.has(at) && holderOf.has(at) && hops <= holderOf.size; hops++) at = holderOf.get(at) as string;
    return at;
  };
  collapsed.covered = collapsed.covered.map((c) => ({ ...c, by: outermost(c.by) }));
  return collapsed;
}

/**
 * Lexical depth: how many names a path has. An undo orders the index's records by it, and a record
 * is data: one whose path is not text sorts last instead of throwing, so the undo reaches the check
 * that refuses it with a sentence (`recordRefusal`, CAPSULE_RECORD_INVALID) rather than failing as
 * an internal error (FG3d #6).
 */
function depthOf(p: unknown): number {
  if (typeof p !== 'string') return Number.MAX_SAFE_INTEGER;
  return path.resolve(p).split(path.sep).filter((name) => name.length > 0).length;
}

/**
 * The order to trash items that are not inside one another: deepest spelling first (FG3c). An item
 * spelled through a link inside another item of the batch (`A/lnk/x`) is trashed before that item
 * takes the link away, so its own trash step still reaches it. Stable otherwise.
 */
export function deepestFirst(paths: string[]): string[] {
  return paths.map((p, i) => ({ p, i, d: depthOf(p) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.p);
}

/**
 * The order to restore items: shallowest spelling first (FG3c), so an item whose place is reached
 * through a folder or link that another item of the same undo puts back is restored after it —
 * never into a folder made up on the way. Stable otherwise.
 */
export function shallowestFirst<T extends { originalPath: string }>(entries: T[]): T[] {
  return entries.map((e, i) => ({ e, i, d: depthOf(e.originalPath) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.e);
}
