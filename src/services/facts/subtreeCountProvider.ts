import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import type { ScanStore } from '../scanStore';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `subtreeCount` fact provider (v4 §6.1) — how many things live under a path.
 *
 * Disk City offers building height by **file count**, and the count is not in
 * the tree the map is drawn from: `GET /api/scan/{id}/treemap` is one of the
 * responses §2.1 holds byte-identical to the pre-rewrite baseline, so no field
 * may be added to it. The count therefore arrives the way every other per-node
 * fact does — through `POST /api/facts`, joined client-side by path.
 *
 * ── Why the whole tree is counted at once ──
 *
 * The obvious implementation walks each requested path's subtree. That is
 * O(paths × subtree), and the paths Disk City asks about are the *drawn* ones —
 * which are the big directories near the root, so almost every one of them
 * walks almost the whole tree. At 2,000 paths over a 1.7M-node scan that is
 * hundreds of millions of visits and blows §2.5's 400 ms sidecar budget by
 * orders of magnitude.
 *
 * Instead one bottom-up pass fills a count for **every** node — the same shape
 * as the store's own `sumSizes` — and each requested path is then an O(1)
 * lookup. The pass is O(nodes) once per scan, and the result is cached against
 * the store's `version`, which the store bumps on every mutation. A watcher
 * edit invalidates it correctly rather than serving a stale count.
 *
 * ── What a count means here ──
 *
 * `files` counts file nodes at or below the path; a file's own count is 1, so
 * "height by file count" is never zero for something that exists. `dirs` counts
 * directories strictly below it. A path the scan does not contain is **absent
 * from `values`** — never `{ files: 0 }` — because "not in this tree" and
 * "empty" are different answers and §2.4 does not allow the second to stand in
 * for the first.
 */

export interface SubtreeCountFact {
  /** File nodes at or below this path. A file itself counts 1. */
  files: number;
  /** Directories strictly below this path. A file has 0. */
  dirs: number;
}

/** One filled-in count table, valid for exactly one version of one store. */
interface CountTable {
  version: number;
  files: Uint32Array;
  dirs: Uint32Array;
}

/**
 * Cached per store object, not per scan id.
 *
 * A `WeakMap` means the table dies with the scan it describes: scans are
 * evicted on a TTL, and a `Map` keyed by id would hold every table of every
 * expired scan alive for the life of the process — a leak whose size is the
 * whole point of the packed store being 52 bytes a node.
 */
const tables = new WeakMap<ScanStore, CountTable>();

/**
 * Fill `files` and `dirs` for every node, children before parents.
 *
 * Iterative rather than recursive: a deeply nested tree (node_modules, a
 * Time Machine backup) would overflow the stack, and this runs against
 * whatever the user actually has on disk.
 *
 * Exported for tests, which drive it against a hand-built store where the
 * right answer can be counted by eye.
 */
export function buildCountTable(store: ScanStore): CountTable {
  const files = new Uint32Array(store.count);
  const dirs = new Uint32Array(store.count);

  // Post-order via an explicit stack: push a node, then push it again marked
  // as "children done" so its totals are summed after theirs are known.
  const stack: number[] = [store.rootId];
  const done: boolean[] = [false];

  while (stack.length > 0) {
    const id = stack[stack.length - 1];
    const childrenVisited = done[done.length - 1];

    if (!childrenVisited) {
      done[done.length - 1] = true;
      if (store.isDir(id)) {
        store.forEachChild(id, (child) => {
          stack.push(child);
          done.push(false);
        });
      }
      continue;
    }

    stack.pop();
    done.pop();

    if (!store.isDir(id)) {
      files[id] = 1;
      dirs[id] = 0;
      continue;
    }
    let f = 0;
    let d = 0;
    store.forEachChild(id, (child) => {
      f += files[child];
      d += dirs[child] + (store.isDir(child) ? 1 : 0);
    });
    files[id] = f;
    dirs[id] = d;
  }

  return { version: store.version, files, dirs };
}

function tableFor(store: ScanStore): CountTable {
  const cached = tables.get(store);
  if (cached && cached.version === store.version) return cached;
  const built = buildCountTable(store);
  tables.set(store, built);
  return built;
}

export const subtreeCountProvider: FactProvider<SubtreeCountFact> = {
  id: 'subtreeCount',
  label: 'How many files are under this',
  // Counting nodes the scan already holds needs nothing this machine might lack.
  capabilityKey: null,

  compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<SubtreeCountFact>> {
    const scan = getScan(scanId);
    if (!scan) {
      return Promise.resolve(
        unavailableBatch('That scan has expired. Scan the folder again to count what is in it.', paths.length),
      );
    }
    if (scan.status === 'running') {
      return Promise.resolve(
        unavailableBatch('That scan is still running — the counts are not final yet.', paths.length),
      );
    }
    if (!scan.store && !scan.root) {
      return Promise.resolve(
        unavailableBatch(scan.error ?? 'That scan did not complete, so it has nothing to count.', paths.length),
      );
    }

    const store = storeOf(scan);
    const table = tableFor(store);
    const values = new Map<string, SubtreeCountFact>();
    let skipped = 0;

    for (let i = 0; i < paths.length; i++) {
      // Same contract as every other provider: an abort leaves the rest
      // `skipped`, so requested === computed + skipped + failed always holds
      // and a partial answer can state its own coverage (§2.4).
      if (signal.aborted) {
        skipped += paths.length - i;
        break;
      }
      const id = store.findByPath(paths[i]);
      if (id === -1) {
        skipped++; // not in this tree — absent from `values`, never a zero
        continue;
      }
      values.set(paths[i], { files: table.files[id], dirs: table.dirs[id] });
    }

    return Promise.resolve({
      available: true,
      values,
      stats: { requested: paths.length, computed: values.size, skipped, failed: 0 },
    });
  },
};
