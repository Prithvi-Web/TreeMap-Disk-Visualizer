import crypto from 'crypto';
import { ScanResult, Snapshot, SnapshotDiff, SnapshotDeltaEntry } from '../models/types';
import { readJsonFile, writeJsonFile } from './storage';

/**
 * Snapshots — lightweight scan history persisted to snapshots.json in the
 * app-data dir. One snapshot is saved automatically at the end of every
 * successful scan (no extra user action), so Trends "just works" after the
 * second scan of a folder. Only sizes and top-level entries are stored —
 * never the full tree — keeping the file a few KB per snapshot.
 */

const SNAP_FILE = 'snapshots.json';
/** Per root path, keep at most this many snapshots (oldest dropped first). */
const MAX_PER_ROOT = 200;
/** Top-level entries recorded per snapshot. */
const MAX_TOP_ENTRIES = 100;

interface SnapshotStore {
  snapshots: Snapshot[];
}

async function load(): Promise<SnapshotStore> {
  const store = await readJsonFile<SnapshotStore>(SNAP_FILE, { snapshots: [] });
  if (!Array.isArray(store.snapshots)) return { snapshots: [] };
  return store;
}

/** Record a completed scan. Called automatically by the scanner. */
export async function saveSnapshot(scan: ScanResult): Promise<Snapshot | null> {
  if (scan.status !== 'complete' || !scan.root) return null;

  const topEntries = (scan.root.children ?? [])
    .filter((c) => c.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_TOP_ENTRIES)
    .map((c) => ({ name: c.name, path: c.path, size: c.size, type: c.type }));

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    rootPath: scan.rootPath,
    takenAt: scan.finishedAt ?? Date.now(),
    totalSize: scan.root.size,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    topEntries,
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
