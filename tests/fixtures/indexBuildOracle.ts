import path from 'path';
import type Database from 'better-sqlite3';
import { platform } from '../../src/platform';
import { neverDescend } from '../../src/utils/mountBoundaries';
import { extensionOf } from '../../src/utils/searchQuery';
import {
  FLAG,
  IndexCapReached,
  getRoot,
  openIndex,
  startWatcher,
  stopWatcher,
  type BuildOptions,
  type IndexedRoot,
} from '../../src/services/indexEngine';

/**
 * The index builder as it was before plan U-15 (main e73d328,
 * src/services/indexEngine.ts:438-742): `rebuild`, `rememberCapStop` and
 * `rollUpSizes`, verbatim, with the per-entry path map, the
 * "parent not yet inserted" flush and the roll-up pass that U-15 removes.
 * tests/indexBuildBounds.test.ts builds the same trees with it and with the
 * shipped builder, and holds them to the same rows, tree and search hits.
 *
 * Only what the copied code names from the engine's own module scope is
 * stood in for below; the engine's exports are imported as they ship. Its
 * `buildIndex` wrapper is left out: it holds a macOS watch across a rebuild
 * of a live, watched root, and the oracle builds unwatched (`live: false`).
 */

/** As in the engine: the path a capped build's roots row holds while it is written aside. */
const ASIDE_PREFIX = 'building-aside:';
let asideSeq = 0;
/** The engine's stale reasons are module state; the oracle only ever clears its own. */
const staleReasons = new Map<string, string>();

export { rebuild as oracleRebuild };

/** How many rows to insert per transaction. */
const BATCH = 5_000;

async function rebuild(root: string, opts: BuildOptions): Promise<IndexedRoot> {
  const handle = openIndex();
  const provider = platform();

  // A capped build is written aside (`BuildOptions.maxEntries`): the saved
  // root keeps its rows, its watcher and its reason for being stale until
  // this build has finished and is swapped in. An explicit build replaces it
  // up front, as it always has (U-D3: an explicit build is unchanged).
  const aside = opts.maxEntries !== undefined;
  const buildPath = aside ? `${ASIDE_PREFIX}${process.pid}:${++asideSeq}:${root}` : root;

  if (!aside) {
    stopWatcher(root); // a rebuild invalidates any watcher on the old rows
    staleReasons.delete(root); // and whatever made the old rows stale
  }

  // Replace any previous index for this root atomically — or, aside, leave it
  // where it is. This is the transaction that inserts the build's 'building'
  // row, where U-D6's id reservation belongs when U-15 lands.
  handle
    .transaction(() => {
      if (!aside) {
        const prior = handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number } | undefined;
        if (prior) {
          handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(prior.id);
          handle.prepare('DELETE FROM roots WHERE id = ?').run(prior.id);
        }
      }
      handle
        .prepare("INSERT INTO roots (path, state, mechanism) VALUES (?, 'building', ?)")
        .run(buildPath, 'readdir + lstat');
    })
    .call(null);

  const rootId = (handle.prepare('SELECT id FROM roots WHERE path = ?').get(buildPath) as { id: number }).id;
  /** Drops what this build wrote — its rows, then its root — as a cancel always has. */
  const discard = (): void => {
    handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(rootId);
    handle.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
  };

  const insert = handle.prepare(
    `INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
     VALUES (@root_id, @parent_id, @name, @ext, @is_dir, @size, @allocated, @mtime, @flags, @ino, @nlink)`,
  );

  /**
   * path → node id, so a child can name its parent without a query per row.
   * This is a build-time cache, not storage — the only place the full paths
   * exist, and it dies with the build.
   */
  const idByPath = new Map<string, number>();
  /** Inodes already counted, so a hard link is not double-counted. */
  const seenInodes = new Set<number>();

  let processed = 0;
  let fileCount = 0;
  let dirCount = 0;
  let pending: { path: string; row: Record<string, unknown> }[] = [];
  /** Set once the walk has passed `opts.maxEntries`: it stops, and the build is discarded. */
  let capped = false;

  const insertMany = handle.transaction((batch: typeof pending) => {
    for (const item of batch) {
      // Every insert is a true insert — the rows go under this build's own
      // root, never over a previous one's — so the returned rowid IS the
      // node's id. That is what lets v3 drop the old per-batch read-back
      // query entirely.
      idByPath.set(item.path, Number(insert.run(item.row).lastInsertRowid));
    }
  });

  const flush = (): void => {
    if (pending.length === 0) return;
    insertMany(pending);
    pending = [];
  };

  try {
    for await (const entry of provider.fastEnumerate(root, {
      isCancelled: opts.isCancelled,
      skip: (p) => neverDescend(p),
    })) {
      // One entry more than the build may write: stop the walk here (leaving
      // the loop ends the enumerator) rather than write it.
      if (opts.maxEntries !== undefined && processed >= opts.maxEntries) {
        capped = true;
        break;
      }
      const parentPath = entry.path === root ? null : path.dirname(entry.path);
      // A parent is always emitted before its children (fastEnumerate yields
      // directories first), but it may still be sitting in `pending`.
      if (parentPath !== null && !idByPath.has(parentPath)) flush();

      let size = entry.size;
      let flags = 0;
      if (entry.isSymlink) flags |= FLAG.SYMLINK;
      if (entry.name.charCodeAt(0) === 46) flags |= FLAG.HIDDEN;
      if (entry.isDir) size = 0; // rolled up after enumeration

      // Hard links: count the first name, zero the rest, exactly as the walker
      // does — otherwise a Time Machine-style tree reports several times its
      // real size.
      if (!entry.isDir && !entry.isSymlink && entry.nlink > 1) {
        if (seenInodes.has(entry.ino)) {
          flags |= FLAG.HARDLINK_DUPLICATE;
          size = 0;
        } else {
          seenInodes.add(entry.ino);
        }
      }
      // A file claiming bytes it does not occupy is a cloud placeholder.
      if (!entry.isDir && entry.allocatedSize === 0 && entry.size > 0) flags |= FLAG.PLACEHOLDER;

      let parentId: number | null = null;
      if (parentPath !== null) {
        const known = idByPath.get(parentPath);
        if (known === undefined) {
          // The enumerator yields every parent before its children, and the
          // flush above lands any parent still in `pending`. Without a stored
          // path an orphan row would be invisible to every tree read, so a
          // broken invariant fails the build loudly instead of quietly
          // shrinking the tree.
          throw new Error(`index build: parent of ${entry.path} was never enumerated`);
        }
        parentId = known;
      }

      pending.push({
        path: entry.path,
        row: {
          root_id: rootId,
          parent_id: parentId,
          name: entry.name,
          // Directories have no extension in this language, matching the
          // frontend's `n.type === 'file'` guard.
          ext: entry.isDir ? '' : extensionOf(entry.name),
          is_dir: entry.isDir ? 1 : 0,
          size,
          allocated: entry.allocatedSize,
          mtime: entry.modifiedAt,
          flags,
          ino: entry.ino,
          nlink: entry.nlink,
        },
      });

      processed++;
      if (entry.isDir) dirCount++;
      else fileCount++;

      if (pending.length >= BATCH) {
        flush();
        opts.onProgress?.({ phase: 'enumerating', processed, currentPath: entry.path });
      }
    }
    if (!capped) flush();

    if (capped || opts.isCancelled?.()) {
      discard();
      if (capped) rememberCapStop(handle, root, opts.maxEntries!);
      throw capped ? new IndexCapReached(opts.maxEntries!) : new Error('cancelled');
    }

    opts.onProgress?.({ phase: 'summing', processed, currentPath: root });
    const totalSize = rollUpSizes(handle, rootId);

    if (aside) {
      // The swap. The saved root's watcher goes first (on macOS its OS watch
      // is held across this by `buildIndex`), then, in one transaction, the
      // saved root and its rows go and this build takes the folder's path.
      stopWatcher(root);
      staleReasons.delete(root);
    }
    handle
      .transaction(() => {
        if (aside) {
          const prior = handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number } | undefined;
          if (prior) {
            handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(prior.id);
            handle.prepare('DELETE FROM roots WHERE id = ?').run(prior.id);
          }
        }
        handle
          .prepare(
            `UPDATE roots SET path = ?, state = 'ready', built_at = ?, file_count = ?, dir_count = ?, total_size = ?, error = NULL
             WHERE id = ?`,
          )
          .run(root, Date.now(), fileCount, dirCount, totalSize, rootId);
        // A build that finished is the answer to whether the folder fits.
        handle.prepare('DELETE FROM cap_stops WHERE path = ?').run(root);
      })
      .call(null);

    opts.onProgress?.({ phase: 'done', processed, currentPath: root });
    if (opts.live !== false) startWatcher(root);
    return getRoot(root)!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== 'cancelled' && !(err instanceof IndexCapReached)) {
      if (aside) {
        // Nothing half-written is kept, and the saved index stays the
        // folder's. A database that has gone away (closed under the build, a
        // process ending) leaves the row 'building', which the next open
        // discards.
        try {
          discard();
        } catch {
          /* see above */
        }
      } else {
        handle.prepare("UPDATE roots SET state = 'error', error = ? WHERE id = ?").run(message, rootId);
      }
    }
    opts.onProgress?.({ phase: 'error', processed, currentPath: root });
    throw err;
  }
}

/**
 * Remember that a capped build of `rootPath` stopped at `maxEntries`. The
 * larger of two stops is kept: a walk past a million entries is also past a
 * thousand, not the other way round.
 */
function rememberCapStop(handle: Database.Database, rootPath: string, maxEntries: number): void {
  handle
    .prepare(
      `INSERT INTO cap_stops (path, max_entries, stopped_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET max_entries = MAX(max_entries, excluded.max_entries), stopped_at = excluded.stopped_at`,
    )
    .run(rootPath, maxEntries, Date.now());
}

/**
 * Give every directory the recursive sum of its contents.
 *
 * Done in one bottom-up pass rather than a recursive CTE: `fastEnumerate` emits
 * parents before children, so ids ascend with depth, and walking them in
 * descending order visits every child before its parent. That is O(n) with one
 * pass over the table, where the SQL recursive form re-walks each subtree.
 */
function rollUpSizes(handle: Database.Database, rootId: number): number {
  const rows = handle
    .prepare('SELECT id, parent_id, size FROM nodes WHERE root_id = ? ORDER BY id DESC')
    .all(rootId) as { id: number; parent_id: number | null; size: number }[];

  const totals = new Map<number, number>();
  for (const row of rows) {
    const own = row.size + (totals.get(row.id) ?? 0);
    totals.set(row.id, own);
    if (row.parent_id !== null) totals.set(row.parent_id, (totals.get(row.parent_id) ?? 0) + own);
  }

  const update = handle.prepare('UPDATE nodes SET size = ? WHERE id = ?');
  const applyAll = handle.transaction((entries: [number, number][]) => {
    for (const [id, total] of entries) update.run(total, id);
  });
  // Only directories need writing back; a file's own size is already right.
  const dirIds = new Set(
    (handle.prepare('SELECT id FROM nodes WHERE root_id = ? AND is_dir = 1').all(rootId) as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  applyAll([...totals.entries()].filter(([id]) => dirIds.has(id)));

  const rootRow = handle.prepare('SELECT size FROM nodes WHERE root_id = ? AND parent_id IS NULL').get(rootId) as
    | { size: number }
    | undefined;
  return rootRow?.size ?? 0;
}
