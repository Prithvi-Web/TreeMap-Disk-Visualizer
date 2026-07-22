import crypto from 'crypto';
import { FileNode, ScanResult, Snapshot, SnapshotDiff, SnapshotDeltaEntry, SnapshotTreeNode } from '../models/types';
import { readJsonFile, writeJsonFile } from './storage';
import { ScanStore, TreeSource, asStore, storeOf } from './scanStore';

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

async function load(): Promise<SnapshotStore> {
  const store = await readJsonFile<SnapshotStore>(SNAP_FILE, { snapshots: [] });
  if (!Array.isArray(store.snapshots)) return { snapshots: [] };
  return store;
}

/* ---------- Time-slider trees (stored beside snapshots.json, per root) ---------- */

/** Trees for one root, keyed by snapshot id — snapshot-trees-<hash>.json. */
type TreeStore = Record<string, SnapshotTreeNode>;

function treeFileName(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return `snapshot-trees-${h}.json`;
}

/**
 * Compact a scan tree to one shape rung: largest `perDir` children per
 * directory, `depth` levels deep. Sizes are kept as-is (not re-summed), so a
 * directory's stored size always reflects its full recursive weight even
 * when its smaller children were dropped.
 */
function compactTree(store: ScanStore, id: number, depth: number, perDir: number): SnapshotTreeNode {
  const out: SnapshotTreeNode = { n: store.name(id), s: store.size(id) };
  if (store.isDir(id)) {
    out.t = 1;
    if (depth > 0) {
      const kids = store
        .childIds(id)
        .filter((c) => store.size(c) > 0)
        .sort((a, b) => store.size(b) - store.size(a))
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
  const sep = rootPath.includes('\\') ? '\\' : '/';
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
  const prevSnap = before.length ? before[before.length - 1] : null;
  return {
    snapshot,
    tree: trees[snapshot.id],
    prev: prevSnap ? { snapshot: prevSnap, tree: trees[prevSnap.id] } : null,
  };
}

/** Record a completed scan. Called automatically by the scanner. */
export async function saveSnapshot(scan: ScanResult): Promise<Snapshot | null> {
  if (scan.status !== 'complete' || (!scan.store && !scan.root)) return null;
  const tree = storeOf(scan);

  const topEntries = tree
    .childIds(tree.rootId)
    .filter((c) => tree.size(c) > 0)
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
    hasTree: true,
  };

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

/** Size deltas between two snapshots (top-level entries matched by path). */
export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const byPath = new Map<string, SnapshotDeltaEntry>();
  for (const e of a.topEntries) {
    byPath.set(e.path, { name: e.name, path: e.path, type: e.type, sizeA: e.size, sizeB: null, delta: -e.size });
  }
  for (const e of b.topEntries) {
    const prev = byPath.get(e.path);
    if (prev) {
      prev.sizeB = e.size;
      prev.delta = e.size - (prev.sizeA ?? 0);
    } else {
      byPath.set(e.path, { name: e.name, path: e.path, type: e.type, sizeA: null, sizeB: e.size, delta: e.size });
    }
  }
  const entries = [...byPath.values()]
    .filter((e) => e.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return {
    a: { id: a.id, takenAt: a.takenAt, totalSize: a.totalSize },
    b: { id: b.id, takenAt: b.takenAt, totalSize: b.totalSize },
    rootPath: b.rootPath,
    totalDelta: b.totalSize - a.totalSize,
    entries,
  };
}
