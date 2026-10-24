import crypto from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
import { FileNode, ScanResult, Snapshot, SnapshotBoundary, SnapshotDiff, SnapshotDeltaEntry, SnapshotTreeNode } from '../models/types';
import { appDataDir, readJsonFile, writeJsonFile } from './storage';
import { isEphemeral } from './portableMode';
import { Flag, ScanStore, TreeSource, asStore, storeOf } from './scanStore';
import { mountOutcome } from '../utils/mountBoundaries';
import { separatorOf } from '../utils/pathSeparator';

/**
 * Snapshots — lightweight scan history persisted to snapshots.json in the
 * app-data dir. One snapshot is saved automatically at the end of every
 * successful scan (no extra user action), so Trends "just works" after the
 * second scan of a folder. Only sizes and top-level entries are stored in
 * snapshots.json itself; the time-slider treemap additionally stores a
 * shallow tree (2–3 levels, ~100 KB budget) per snapshot in a separate
 * per-root file so the main history file stays a few KB per snapshot.
 */

const SNAP_FILE = 'snapshots.json';
/** Per root path, keep at most this many snapshots (oldest dropped first). */
const MAX_PER_ROOT = 200;
/** Top-level entries recorded per snapshot. */
const MAX_TOP_ENTRIES = 100;

/** Serialized-size budget for one snapshot's stored tree (time slider). */
const TREE_BYTE_BUDGET = 100_000;
/** Depth/children ladders tried until the tree fits the byte budget. */
const TREE_SHAPES: { depth: number; perDir: number }[] = [
  { depth: 3, perDir: 30 },
  { depth: 3, perDir: 18 },
  { depth: 3, perDir: 10 },
  { depth: 2, perDir: 30 },
  { depth: 2, perDir: 12 },
];

interface SnapshotStore {
  snapshots: Snapshot[];
}

/** Reads of snapshots.json, each a parse of the whole history: counted for the tests that prove the counts index spares them. */
let historyReads = 0;

async function load(): Promise<SnapshotStore> {
  historyReads++;
  const store = await readJsonFile<SnapshotStore>(SNAP_FILE, { snapshots: [] });
  if (!Array.isArray(store.snapshots)) return { snapshots: [] };
  return store;
}

/* ---------- The newest counts of each root (Track U, U-30) ---------- */

/** A root's newest snapshot as a native scan's projection reads it: its counts, unchecked, as the file holds them. */
export interface SnapshotCounts {
  rootPath: string;
  takenAt: unknown;
  fileCount: unknown;
  dirCount: unknown;
}

/** When a record says it was taken: its `takenAt`, or -Infinity — the oldest — when that is not a finite number. */
function takenAtOf(record: { takenAt?: unknown }): number {
  return typeof record.takenAt === 'number' && Number.isFinite(record.takenAt) ? record.takenAt : -Infinity;
}

/**
 * Each root's newest snapshot among `records`, as its counts, unchecked: the
 * latest `takenAt`; of two taken at the same time, the one written later; a
 * record with no usable time, the oldest. Anything that is not an object with
 * a string `rootPath` is passed over: a hand-edited or old file can hold
 * anything (Track U, U-30).
 */
export function newestCountsByRoot(records: readonly unknown[]): Map<string, SnapshotCounts> {
  const newest = new Map<string, SnapshotCounts>();
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;
    if (typeof r.rootPath !== 'string') continue;
    const held = newest.get(r.rootPath);
    // `>=`: of two taken at the same time, the one written later.
    if (held === undefined || takenAtOf(r) >= takenAtOf(held)) {
      newest.set(r.rootPath, { rootPath: r.rootPath, takenAt: r.takenAt, fileCount: r.fileCount, dirCount: r.dirCount });
    }
  }
  return newest;
}

/**
 * The newest counts of each root, with the stamp of the snapshots.json they
 * came from, so a native scan's projection reads one root's counts without
 * parsing the whole history — tens of MB on a long-used Mac — at every start.
 *
 *  - Built by one read the first time it is asked for in a process.
 *  - Rebuilt, with no read, from the history `saveSnapshot` has just written
 *    (already parsed), and stamped then: every save of this process waits its
 *    turn (`saving`), so no other save of it can write between the two.
 *  - Read again only when the file on disk is not the one stamped: written by
 *    another process (the MCP server, a second app), by a person, or removed.
 *
 * A stamp is taken before the read it labels, so a write during that read
 * makes the next ask read again: a mismatch costs a read, never a stale
 * answer. The one write this can miss is another process's landing between
 * this process's write and its look at that write, microseconds apart, until
 * the file next changes.
 */
interface CountsIndex {
  byRoot: Map<string, SnapshotCounts>;
  stamp: string;
}
let countsIndex: CountsIndex | null = null;
/** A rebuild in flight, which every ask meanwhile shares: one read, however many scans start at once. */
let rebuilding: Promise<CountsIndex> | null = null;

/**
 * Which snapshots.json is there now: its folder, and its file id, size and
 * times, or `absent`. A no-trace portable session keeps its files in this
 * process, where nothing else can write them. A look that fails otherwise is
 * thrown, never guessed: the projection says the history could not be read.
 */
async function historyStamp(): Promise<string> {
  if (isEphemeral()) return 'in-memory';
  const file = path.join(appDataDir(), SNAP_FILE);
  try {
    const st = await fsp.stat(file);
    return `${file}\0${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${file}\0absent`;
    throw err;
  }
}

function rebuildCountsIndex(): Promise<CountsIndex> {
  if (rebuilding === null) {
    rebuilding = (async () => {
      // The stamp before the read: a write during the read is then a mismatch next time.
      const stamp = await historyStamp();
      const built = { byRoot: newestCountsByRoot((await load()).snapshots), stamp };
      countsIndex = built;
      return built;
    })().finally(() => {
      rebuilding = null;
    });
  }
  return rebuilding;
}

/** The newest snapshot counts of exactly `rootPath`, or null: from the index, read again only when the history on disk changed. */
export async function newestSnapshotCounts(rootPath: string): Promise<SnapshotCounts | null> {
  const stamp = await historyStamp();
  const held = countsIndex;
  const index = held !== null && held.stamp === stamp ? held : await rebuildCountsIndex();
  return index.byRoot.get(rootPath) ?? null;
}

/** Tests only: how many times snapshots.json has been read and parsed in this process. */
export function snapshotHistoryReadsForTests(): number {
  return historyReads;
}

/** Tests only: forget the counts index, as a new process starts without one. */
export function forgetSnapshotCountsForTests(): void {
  countsIndex = null;
}

/* ---------- Time-slider trees (stored beside snapshots.json, per root) ---------- */

/** Trees for one root, keyed by snapshot id — snapshot-trees-<hash>.json. */
type TreeStore = Record<string, SnapshotTreeNode>;

function treeFileName(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return `snapshot-trees-${h}.json`;
}

/** All stored snapshot trees for one root, keyed by snapshot id. */
export async function readSnapshotTrees(rootPath: string): Promise<Record<string, SnapshotTreeNode>> {
  return readJsonFile<TreeStore>(treeFileName(rootPath), {});
}

/**
 * Compact a scan tree to one shape rung: largest `perDir` children per
 * directory, `depth` levels deep. Sizes are kept as-is (not re-summed), so a
 * directory's stored size always reflects its full recursive weight even
 * when its smaller children were dropped. A folder the scan did not list in
 * full is marked (`u`) and kept first, however small (hunt C47): left out, a
 * refused folder's bytes read to the journal as removed by some process.
 */
function compactTree(store: ScanStore, id: number, depth: number, perDir: number): SnapshotTreeNode {
  const out: SnapshotTreeNode = { n: store.name(id), s: store.size(id) };
  if (store.isDir(id)) {
    out.t = 1;
    if (store.flag(id, Flag.Unlisted)) out.u = 1;
    if (depth > 0) {
      const unlisted = (c: number): number => (store.isDir(c) && store.flag(c, Flag.Unlisted) ? 1 : 0);
      const kids = store
        .childIds(id)
        .filter((c) => store.size(c) > 0 || unlisted(c) === 1)
        .sort((a, b) => unlisted(b) - unlisted(a) || store.size(b) - store.size(a))
        .slice(0, perDir)
        .map((c) => compactTree(store, c, depth - 1, perDir));
      if (kids.length) out.c = kids;
    }
  }
  return out;
}

/** Build the stored tree, stepping down the shape ladder until it fits the budget. */
export function buildSnapshotTree(source: TreeSource): SnapshotTreeNode {
  const store = asStore(source);
  let tree = compactTree(store, store.rootId, TREE_SHAPES[0].depth, TREE_SHAPES[0].perDir);
  for (let i = 1; i < TREE_SHAPES.length; i++) {
    if (JSON.stringify(tree).length <= TREE_BYTE_BUDGET) break;
    tree = compactTree(store, store.rootId, TREE_SHAPES[i].depth, TREE_SHAPES[i].perDir);
  }
  return tree;
}

/**
 * Rebuild a FileNode tree from a stored snapshot tree so the regular
 * squarified layout can be reused unmodified. Paths are reconstructed from
 * the root path; every node reports the snapshot time as its mtime.
 */
export function inflateSnapshotTree(stored: SnapshotTreeNode, rootPath: string, takenAt: number): FileNode {
  const sep = separatorOf(rootPath);
  const build = (t: SnapshotTreeNode, parentPath: string, isRoot: boolean): FileNode => {
    const p = isRoot ? rootPath : parentPath + (parentPath.endsWith(sep) ? '' : sep) + t.n;
    const node: FileNode = {
      name: t.n,
      path: p,
      size: t.s,
      type: t.t ? 'dir' : 'file',
      modifiedAt: takenAt,
      isHidden: t.n.startsWith('.'),
    };
    if (t.t) node.children = (t.c ?? []).map((c) => build(c, p, false));
    return node;
  };
  return build(stored, rootPath, true);
}

/** The snapshot (among `snaps`, oldest-first) whose takenAt is closest to `at`. */
export function closestSnapshot<T extends { takenAt: number }>(snaps: T[], at: number): T | null {
  let best: T | null = null;
  for (const s of snaps) {
    if (!best || Math.abs(s.takenAt - at) < Math.abs(best.takenAt - at)) best = s;
  }
  return best;
}

/**
 * The stored tree closest in time to `at` for this root, plus the snapshot
 * immediately before it (for the diff overlay). Null when no trees exist.
 * No `prev` when the snapshot before it stopped at other drives mounted inside
 * the folder (Track U, U-24): it counted another disk, so its sizes are no
 * overlay for this one — a drive left out would read as files freed.
 */
export async function getSnapshotTreeAt(rootPath: string, at: number): Promise<{
  snapshot: Snapshot;
  tree: SnapshotTreeNode;
  prev: { snapshot: Snapshot; tree: SnapshotTreeNode } | null;
} | null> {
  const [store, trees] = await Promise.all([
    load(),
    readJsonFile<TreeStore>(treeFileName(rootPath), {}),
  ]);
  const withTrees = store.snapshots
    .filter((s) => s.rootPath === rootPath && trees[s.id])
    .sort((a, b) => a.takenAt - b.takenAt);
  const snapshot = closestSnapshot(withTrees, at);
  if (!snapshot) return null;
  const before = withTrees.filter((s) => s.takenAt < snapshot.takenAt);
  const last = before.length ? before[before.length - 1] : null;
  const prevSnap = last && boundaryKeyOf(last.boundary) === boundaryKeyOf(snapshot.boundary) ? last : null;
  return {
    snapshot,
    tree: trees[snapshot.id],
    prev: prevSnap ? { snapshot: prevSnap, tree: trees[prevSnap.id] } : null,
  };
}

/* ---------- Comparability across the scan boundary (Track U, U-24) ---------- */

/**
 * A scan's record of the drives mounted inside its folder, for its snapshot:
 * under `stay` the ones it did not enter, under `cross` the ones it did. None
 * when no drive was involved, or the mount table could not be read (the walk
 * then crossed, as every walk did before U-24).
 */
export function snapshotBoundaryOf(scan: ScanResult): SnapshotBoundary | undefined {
  if (!scan.boundary) return undefined;
  const outcome = mountOutcome(scan.boundary);
  if (!outcome.known) return undefined;
  if (scan.boundary.rule === 'stay') {
    return outcome.notEntered.length > 0 ? { rule: 'stay', notEntered: outcome.notEntered.map((m) => m.path).sort() } : undefined;
  }
  return outcome.entered.length > 0 ? { rule: 'cross', entered: outcome.entered.map((m) => m.path).sort() } : undefined;
}

/**
 * Two scans counted the same disk when their keys are equal: the drives a scan
 * left out, sorted; or, for a scan that crossed, the drives it went into, under
 * a mark of their own (one drive counted and the same drive left out are two
 * disks); or '' when no drive was involved — which is also what every scan
 * before U-24 recorded, so that history compares among itself as it did.
 * History never compares across two keys: the difference would be a drive,
 * not a change. A crossing scan's drives are in its key (the SEC-1 review, L2):
 * the next crossing scan, after the drive was unplugged, records no boundary,
 * and '' for both read the drive's bytes as space freed.
 */
export function boundaryKeyOf(boundary: SnapshotBoundary | undefined): string {
  if (!boundary) return '';
  if (boundary.rule === 'stay') return boundary.notEntered.join('\n');
  return boundary.entered.length === 0 ? '' : ['entered', ...boundary.entered].join('\n');
}

/** `boundaryKeyOf` for a scan in memory. */
export function scanBoundaryKey(scan: ScanResult): string {
  return boundaryKeyOf(snapshotBoundaryOf(scan));
}

/** The snapshots since the boundary last changed: the latest one's run of equal keys, oldest first. */
export function currentBaseline(snaps: readonly Snapshot[]): Snapshot[] {
  const sorted = [...snaps].sort((a, b) => a.takenAt - b.takenAt);
  if (sorted.length === 0) return sorted;
  const key = boundaryKeyOf(sorted[sorted.length - 1].boundary);
  let start = sorted.length - 1;
  while (start > 0 && boundaryKeyOf(sorted[start - 1].boundary) === key) start--;
  return sorted.slice(start);
}

/**
 * The saves of this process, one at a time: each reads the history, adds to
 * it, writes it and stamps the counts index before the next begins, so no
 * save drops another's snapshot (each rewrites the whole file) and no stamp
 * labels another save's write.
 */
let saving: Promise<unknown> = Promise.resolve();

/** Record a completed scan. Called automatically by the scanner. */
export function saveSnapshot(scan: ScanResult): Promise<Snapshot | null> {
  const turn = saving.then(() => writeSnapshot(scan));
  saving = turn.catch(() => undefined);
  return turn;
}

async function writeSnapshot(scan: ScanResult): Promise<Snapshot | null> {
  if (scan.status !== 'complete' || (!scan.store && !scan.root)) return null;
  const tree = storeOf(scan);

  // The largest MAX_TOP_ENTRIES direct children, empty ones included, and whether that left any out
  // (hunt C46): a diff reads a path missing from a list that holds every child as gone, and one missing
  // from a cut list as not known — an empty item left out read "removed" while it was there.
  const children = tree.childIds(tree.rootId);
  const topEntries = [...children]
    .sort((a, b) => tree.size(b) - tree.size(a))
    .slice(0, MAX_TOP_ENTRIES)
    .map((c) => ({ name: tree.name(c), path: tree.path(c), size: tree.size(c), type: tree.nodeType(c) }));

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    rootPath: scan.rootPath,
    takenAt: scan.finishedAt ?? Date.now(),
    totalSize: tree.size(tree.rootId),
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    topEntries,
    topEntriesCut: children.length > topEntries.length,
    hasTree: true,
  };
  const boundary = snapshotBoundaryOf(scan);
  if (boundary) snapshot.boundary = boundary;

  const store = await load();
  store.snapshots.push(snapshot);

  // Trim per-root history.
  const sameRoot = store.snapshots.filter((s) => s.rootPath === snapshot.rootPath);
  if (sameRoot.length > MAX_PER_ROOT) {
    const cutoff = sameRoot
      .sort((a, b) => a.takenAt - b.takenAt)
      .slice(0, sameRoot.length - MAX_PER_ROOT)
      .map((s) => s.id);
    const drop = new Set(cutoff);
    store.snapshots = store.snapshots.filter((s) => !drop.has(s.id));
  }

  await writeJsonFile(SNAP_FILE, store);
  // The counts index, from the history just written: already parsed, so no read.
  const byRoot = newestCountsByRoot(store.snapshots);
  try {
    countsIndex = { byRoot, stamp: await historyStamp() };
  } catch {
    countsIndex = null; // which file is there could not be told: the next ask reads it
  }

  // Time-slider tree: written after the main store so a failure here can
  // never lose the snapshot itself; orphaned trees are pruned on each save.
  try {
    const file = treeFileName(snapshot.rootPath);
    const trees = await readJsonFile<TreeStore>(file, {});
    trees[snapshot.id] = buildSnapshotTree(tree);
    const keep = new Set(store.snapshots.filter((s) => s.rootPath === snapshot.rootPath).map((s) => s.id));
    for (const id of Object.keys(trees)) if (!keep.has(id)) delete trees[id];
    await writeJsonFile(file, trees);
  } catch (err) {
    console.error('[treemap] snapshot tree save failed:', err);
  }

  return snapshot;
}

/** All snapshots for one root path, oldest first. */
export async function listSnapshots(rootPath: string): Promise<Snapshot[]> {
  const store = await load();
  return store.snapshots
    .filter((s) => s.rootPath === rootPath)
    .sort((a, b) => a.takenAt - b.takenAt);
}

/** Every root path that has history: { path, count, latest snapshot }. */
export async function listSnapshotRoots(): Promise<
  { rootPath: string; count: number; latestAt: number; latestSize: number }[]
> {
  const store = await load();
  const byRoot = new Map<string, { count: number; latestAt: number; latestSize: number }>();
  for (const s of store.snapshots) {
    const entry = byRoot.get(s.rootPath) ?? { count: 0, latestAt: 0, latestSize: 0 };
    entry.count++;
    if (s.takenAt > entry.latestAt) {
      entry.latestAt = s.takenAt;
      entry.latestSize = s.totalSize;
    }
    byRoot.set(s.rootPath, entry);
  }
  return [...byRoot.entries()]
    .map(([rootPath, v]) => ({ rootPath, ...v }))
    .sort((a, b) => b.latestAt - a.latestAt);
}

/** Every snapshot, without the bulky topEntries — for picker dropdowns. */
export async function listAllSnapshotsSlim(): Promise<Omit<Snapshot, 'topEntries'>[]> {
  const store = await load();
  return store.snapshots
    .map(({ topEntries: _omitted, ...slim }) => slim)
    .sort((a, b) => b.takenAt - a.takenAt);
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const store = await load();
  return store.snapshots.find((s) => s.id === id);
}

/**
 * Whether a snapshot's list of top-level items may leave one out (hunt C46): its own word, or — for one
 * an earlier build saved, with no word — a full list, which may have been cut at MAX_TOP_ENTRIES.
 */
function listMayLeaveOut(s: Snapshot): boolean {
  if (typeof s.topEntriesCut === 'boolean') return s.topEntriesCut;
  return s.topEntries.length >= MAX_TOP_ENTRIES;
}

/**
 * Size deltas between two snapshots (top-level entries matched by path). A path in only one list is
 * removed or new only when the other list holds every item (hunt C46); missing from a list that may have
 * left it out, it crossed the largest-100 line or went or came — not known — so it is left out and
 * counted in `notCompared`, never called removed or new with its whole size as the change.
 */
export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const inB = new Map(b.topEntries.map((e) => [e.path, e]));
  const inA = new Set(a.topEntries.map((e) => e.path));
  const aMayLeaveOut = listMayLeaveOut(a);
  const bMayLeaveOut = listMayLeaveOut(b);
  let notCompared = 0;
  const deltas: SnapshotDeltaEntry[] = [];
  for (const e of a.topEntries) {
    const now = inB.get(e.path);
    if (now !== undefined) deltas.push({ name: e.name, path: e.path, type: e.type, sizeA: e.size, sizeB: now.size, delta: now.size - e.size });
    else if (bMayLeaveOut) notCompared++;
    else deltas.push({ name: e.name, path: e.path, type: e.type, sizeA: e.size, sizeB: null, delta: -e.size });
  }
  for (const e of b.topEntries) {
    if (inA.has(e.path)) continue;
    if (aMayLeaveOut) notCompared++;
    else deltas.push({ name: e.name, path: e.path, type: e.type, sizeA: null, sizeB: e.size, delta: e.size });
  }
  const entries = deltas
    .filter((e) => e.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return {
    a: { id: a.id, takenAt: a.takenAt, totalSize: a.totalSize },
    b: { id: b.id, takenAt: b.takenAt, totalSize: b.totalSize },
    rootPath: b.rootPath,
    totalDelta: b.totalSize - a.totalSize,
    entries,
    ...(notCompared > 0 ? { notCompared } : {}),
  };
}
