import { promises as fsp } from 'fs';
import path from 'path';
import { realPlaceOf } from '../utils/pathSanitizer';
import { meansAbsent } from '../utils/errno';

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
 * it, taking what it holds along (FG3d #4). A request that is not there is its own item, and its own
 * capture says it is gone. One whose place cannot be looked at — a look that fails for another
 * reason, which says nothing either way — is never silently its own item (FG3d #10): when it is
 * written inside another request of the batch, or another inside it, the batch is judged by how its
 * paths are written, as before FG3c, so no item gets a second copy for want of a look; the trash
 * step's own look at the disk then says what really went.
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

/**
 * How the disk is read here — the real one, or a test's stand-in for what no test can make (a mount).
 * Each answers null when nothing is there, and throws when a look fails for another reason.
 */
export interface PlaceReader {
  lstat(p: string): Promise<{ dev: bigint; ino: bigint; isSymbolicLink(): boolean; isDirectory(): boolean } | null>;
  stat(p: string): Promise<{ dev: bigint } | null>;
  realPlaceOf(p: string): Promise<string | null>;
}

/** Null for "nothing is there" (`meansAbsent`); any other failure is rethrown: it says nothing either way. */
const absentAsNull = (err: unknown): null => {
  if (meansAbsent(err)) return null;
  throw err;
};

const DISK: PlaceReader = {
  lstat: (p) => fsp.lstat(p, { bigint: true }).catch(absentAsNull),
  stat: (p) => fsp.stat(p, { bigint: true }).catch(absentAsNull),
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
  const unplaced: T[] = [];
  for (const request of firstOf.values()) {
    try {
      placed.push({ request, place: await placeOf(request.path, disk) });
    } catch {
      unplaced.push(request);
    }
  }
  if (unplaced.length > 0 && unplaced.some((u) => writtenWithAnother(u, [...firstOf.values()]))) {
    return bySpelling([...firstOf.values()], new Map(placed.flatMap(({ request, place }) => (place === null ? [] : [[request.path, place.realPath] as const]))));
  }
  for (const request of unplaced) placed.push({ request, place: null });

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

/** Whether `request` is written inside another request of `all`, or another inside it. */
function writtenWithAnother<T extends { path: string }>(request: T, all: T[]): boolean {
  const at = path.resolve(request.path);
  return all.some((other) => other !== request && (isWrittenInside(at, path.resolve(other.path)) || isWrittenInside(path.resolve(other.path), at)));
}

/** Whether the path `inner` is written inside the folder `outer` (both resolved). */
function isWrittenInside(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The batch judged by how its paths are written (FG3b's rule), for when the disk could not place
 * one of them (FG3d #10): each goes with the outermost request written around it. Linear in the
 * batch times the depth of a path. `realPathOf` keeps what the disk did place.
 */
function bySpelling<T extends { path: string }>(requests: T[], realPathOf: Map<string, string>): CollapsedBatch<T> {
  const written = new Map(requests.map((r) => [path.resolve(r.path), r]));
  const collapsed: CollapsedBatch<T> = { top: [], covered: [], realPathOf };
  for (const request of requests) {
    let by: T | null = null;
    for (let at = path.dirname(path.resolve(request.path)); ; at = path.dirname(at)) {
      const holder = written.get(at);
      if (holder !== undefined && holder !== request) by = holder; // keep climbing: the outermost
      if (path.dirname(at) === at) break;
    }
    if (by === null) collapsed.top.push(request);
    else collapsed.covered.push({ request, by: by.path, same: false });
  }
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
 * never into a folder made up on the way. Stable otherwise. An entry that records where it was
 * (`realPath`, FG3d #2) is restored there, not through its spelling, so for it the order decides
 * nothing: no two items of one batch are inside one another where they are.
 */
export function shallowestFirst<T extends { originalPath: string }>(entries: T[]): T[] {
  return entries.map((e, i) => ({ e, i, d: depthOf(e.originalPath) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.e);
}
