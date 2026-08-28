import Database from 'better-sqlite3';
import path from 'path';
import { promises as fsp, mkdirSync, unlinkSync } from 'fs';
import { appDataDir } from './storage';
import { isEphemeral } from './portableMode';
import { platform } from '../platform';
import { neverDescend } from '../utils/mountBoundaries';
// `escapeLike` guards the one LIKE query left (the substring search): `_` and
// `%` are LIKE wildcards, and a real filename containing either must not
// become a pattern. Since v3, deletes and scopes work on node ids, so no
// path ever meets LIKE at all.
import { parseQuery, extensionOf, escapeLike } from '../utils/searchQuery';
import type { ChangeEvent, Unsubscribe } from '../platform/types';
import type { FileNode } from '../models/types';
import { meansGone } from '../utils/errno';

/**
 * IndexEngine (A1) — the persistent, live-updated file index.
 *
 * The idea WizTree's reputation rests on is not scanning fast; it is scanning
 * *once*. This service keeps a durable index of a folder tree and updates it
 * from filesystem events, so the second and every later open of a scanned root
 * is a database read rather than a walk.
 *
 * Naming note: the spec calls this file `IndexEngine.ts`. Every other service
 * in this repo is camelCase (`diskScanner.ts`, `cleanupRules.ts`), and §1 says
 * to match existing conventions exactly, so it is `indexEngine.ts`.
 *
 * ── The three things that make an index a liability instead of an asset ──
 *
 * 1. **A half-built index that looks finished.** Killing the app mid-build must
 *    never leave data that reads as complete. A root's rows are written inside
 *    a transaction and its `state` only becomes 'ready' at the very end; any
 *    root found in 'building' at startup is discarded, not resumed, because a
 *    partial tree reports folder sizes that are simply wrong.
 *
 * 2. **Drift.** Events are missed during sleep, unmount, or when the app is
 *    closed. There is no sequence number to resume from with fs.watch, so the
 *    honest position is: an index whose watcher was not attached continuously
 *    since it was built is *stale* until reconciled. `state` says so, the API
 *    says so, and the UI's indicator turns amber. Never serve data you cannot
 *    vouch for.
 *
 * 3. **A schema that changed underneath you.** `schema_version` is checked on
 *    open; a mismatch rebuilds rather than misreads (§3.7). A user who
 *    downgrades gets a rebuild, not corrupted history — and the index is a
 *    cache, so rebuilding loses nothing.
 */

/**
 * Bump when the schema changes. A mismatch rebuilds; it never migrates blindly.
 *
 * v2 added the `ext` column and its index, so A4's `*.zip` searches are an
 * index seek rather than a scan computing extensions on the fly.
 *
 * v3 dropped the stored absolute path. Measured on a real ~/Library (223,779
 * nodes): the `path` column plus its unique index were 320 of 486 bytes per
 * node — 66% of the database was one path stored twice. A node's identity is
 * now (parent_id, name); paths are rebuilt from the tree when needed, which
 * is what keeps 100M nodes inside a ~19 GB envelope instead of ~49 GB.
 */
const SCHEMA_VERSION = 3;

const DB_FILE = 'index.db';

/* Node flag bits, packed into one integer column. */
export const FLAG = {
  SYMLINK: 1 << 0,
  HARDLINK_DUPLICATE: 1 << 1,
  PLACEHOLDER: 1 << 2,
  HIDDEN: 1 << 3,
} as const;

export type IndexState = 'building' | 'ready' | 'stale' | 'error';

export interface IndexedRoot {
  id: number;
  path: string;
  state: IndexState;
  builtAt: number | null;
  fileCount: number;
  dirCount: number;
  totalSize: number;
  mechanism: string;
  /** True while a live watcher is attached to this root. */
  live: boolean;
  error?: string;
}

export interface BuildProgress {
  phase: 'enumerating' | 'summing' | 'done' | 'error';
  processed: number;
  currentPath: string;
}

/* ------------------------------------------------------------------ *
 * Database lifecycle
 * ------------------------------------------------------------------ */

let db: Database.Database | null = null;
let dbPath: string | null = null;

function schemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT NOT NULL UNIQUE,
      state      TEXT NOT NULL,
      built_at   INTEGER,
      file_count INTEGER NOT NULL DEFAULT 0,
      dir_count  INTEGER NOT NULL DEFAULT 0,
      total_size INTEGER NOT NULL DEFAULT 0,
      mechanism  TEXT NOT NULL DEFAULT '',
      error      TEXT
    );

    -- v3: no stored path. A node's absolute path is its ancestor chain joined
    -- with the root's path; helpers findNodeIdByPath / pathOfNode translate in
    -- both directions. The column and its unique index were 66% of the whole
    -- database, and the tree already carries the same information.
    CREATE TABLE IF NOT EXISTS nodes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id   INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      parent_id INTEGER,
      name      TEXT NOT NULL,
      -- Lower-cased extension without the dot, '' when the file has none.
      -- Stored rather than derived so an extension search is an index seek.
      ext       TEXT NOT NULL DEFAULT '',
      is_dir    INTEGER NOT NULL,
      size      INTEGER NOT NULL DEFAULT 0,
      allocated INTEGER,
      mtime     INTEGER NOT NULL DEFAULT 0,
      flags     INTEGER NOT NULL DEFAULT 0,
      ino       INTEGER,
      nlink     INTEGER
    );

    -- The uniqueness that used to live on (root_id, path), at ~29 B/node
    -- instead of 177: a directory cannot hold two entries of one name. Also
    -- serves every children-of-a-directory lookup, so no separate parent
    -- index is needed. Root nodes have parent_id NULL, and UNIQUE treats
    -- NULLs as distinct — which is what the partial index below is for.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_child ON nodes(parent_id, name);
    -- A root's top node without a scan; one row per root qualifies.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_root_node ON nodes(root_id) WHERE parent_id IS NULL;
    -- A4's size-ordered search.
    CREATE INDEX IF NOT EXISTS idx_nodes_size ON nodes(root_id, size DESC);
    -- A4's "older than" filter.
    CREATE INDEX IF NOT EXISTS idx_nodes_mtime ON nodes(root_id, mtime);
    -- A4's name search. Collating NOCASE is what lets a prefix query use the
    -- index: 'LIKE "foo%"' can only be an index seek when the index collation
    -- matches the comparison, and users expect case-insensitive matching.
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name COLLATE NOCASE);
    -- A4's '*.zip' search. Ordered (ext, size DESC) so the extension is an
    -- index seek AND the results come back already sorted — otherwise a
    -- popular extension means sorting hundreds of thousands of rows per query.
    CREATE INDEX IF NOT EXISTS idx_nodes_ext ON nodes(ext, size DESC);
    -- The allocation accountant looks up one hard-link family at a time
    -- (WHERE root_id = ? AND ino = ?), up to 200 times per report. Without
    -- this, SQLite falls back to idx_nodes_mtime and rescans every row in the
    -- root for each one: measured on a real 1,013,072-node home index, those
    -- 200 lookups took 48.3 SECONDS. better-sqlite3 is synchronous, so that
    -- was 48 seconds with the whole event loop blocked — every other request
    -- queued behind it, which is what made opening Settings freeze the app.
    -- With this index the same 200 lookups take 1 ms. It costs ~15 MB on a
    -- 209 MB index, and is built once on the next open of an existing one.
    CREATE INDEX IF NOT EXISTS idx_nodes_ino ON nodes(root_id, ino);
    -- Every readTree call, and the allocation report, start by counting how
    -- many names each multi-linked inode has in this root. That is a GROUP BY
    -- over the whole root — 1M rows, 565 ms measured — even though only the
    -- ~25k hard-linked files can possibly contribute. A PARTIAL index holds
    -- just those rows, and SQLite uses it because the query's own WHERE says
    -- exactly the same thing: 565 ms -> 9 ms, for almost no disk.
    CREATE INDEX IF NOT EXISTS idx_nodes_family ON nodes(root_id, ino)
      WHERE nlink > 1 AND is_dir = 0;
    -- readTree reads one directory at a time, biggest child first. Without a
    -- size-ordered child index every one of those ~29,000 reads builds a temp
    -- B-tree to sort: measured 757 ms of walking, 449 ms with this. The
    -- existing idx_nodes_child is (parent_id, name) and cannot serve the sort.
    CREATE INDEX IF NOT EXISTS idx_nodes_child_size ON nodes(parent_id, size DESC);
  `;
}

/** Absolute path of the index database. */
export function indexDbPath(): string {
  return path.join(appDataDir(), DB_FILE);
}

/**
 * Open (or create) the index database.
 *
 * On a schema-version mismatch the file is deleted and recreated rather than
 * migrated (§3.7). That is safe precisely because this database is a cache:
 * everything in it can be rebuilt from the filesystem, and misreading an old
 * layout would produce wrong sizes, which is worse than a rebuild.
 */
export function openIndex(): Database.Database {
  if (db) return db;

  // A read-only portable session has nowhere of its own to put a database, and
  // putting it in the host's app-data folder is exactly the trace D3 promises
  // not to leave. SQLite's own in-memory mode is the honest answer: the index
  // works for this session and vanishes with the process.
  const ephemeral = isEphemeral();
  const file = ephemeral ? ':memory:' : indexDbPath();
  if (!ephemeral) {
    // The app-data directory is created lazily elsewhere (storage.ts writes it
    // on first save), so on a fresh machine it may not exist yet — and
    // better-sqlite3 refuses to create a database in a missing directory.
    mkdirSync(appDataDir(), { recursive: true });
  }
  dbPath = file;
  let handle = new Database(file);

  const readVersion = (): number | null => {
    try {
      const row = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      return row ? Number.parseInt(row.value, 10) : null;
    } catch {
      return null; // meta table absent — a fresh or foreign file
    }
  };

  const existing = readVersion();
  if (existing !== null && existing !== SCHEMA_VERSION) {
    handle.close();
    // Synchronous on purpose: nothing may touch a half-removed database, and
    // this runs once at startup.
    // The -wal and -shm sidecars must go too: leaving them beside a fresh
    // database makes SQLite try to replay a log written against the old schema.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + suffix);
      } catch {
        /* not present */
      }
    }
    handle = new Database(file);
  }

  // WAL: readers never block the writer, which matters because the live
  // watcher writes while the UI reads.
  handle.pragma('journal_mode = WAL');
  // NORMAL is the documented safe pairing with WAL: durable across process
  // crashes (which is what the mid-build guarantee needs), only at risk from
  // OS-level power loss — and the index is a rebuildable cache either way.
  handle.pragma('synchronous = NORMAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(schemaSql());
  handle.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));

  db = handle;
  discardIncompleteBuilds();
  return db;
}

/**
 * Any root left mid-build by a crash is discarded.
 *
 * Resuming is not an option: enumeration order carries no resumable cursor, and
 * a partially-populated tree reports folder sizes that are confidently wrong.
 * Deleting is cheap and always correct.
 */
function discardIncompleteBuilds(): void {
  if (!db) return;
  const stuck = db.prepare("SELECT id, path FROM roots WHERE state = 'building'").all() as { id: number; path: string }[];
  for (const root of stuck) {
    db.prepare('DELETE FROM nodes WHERE root_id = ?').run(root.id);
    db.prepare('DELETE FROM roots WHERE id = ?').run(root.id);
  }
  // Every surviving root was built by a process that is no longer running, so
  // its watcher is gone and it may have missed changes. Honest state: stale.
  db.prepare("UPDATE roots SET state = 'stale' WHERE state = 'ready'").run();
}

/** Close the database (graceful shutdown, and between tests). */
export function closeIndex(): void {
  stopAllWatchers();
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  db = null;
  dbPath = null;
}

/** Tests only: which file is currently open. */
export function currentIndexPath(): string | null {
  return dbPath;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export interface BuildOptions {
  onProgress?: (p: BuildProgress) => void;
  isCancelled?: () => boolean;
  /** Attach a live watcher when the build completes. Default true. */
  live?: boolean;
}

/** How many rows to insert per transaction. */
const BATCH = 5_000;

/**
 * Build (or rebuild) the index for `root`.
 *
 * The whole point of the state machine: rows land under `state='building'`, and
 * only the final statement flips it to 'ready'. A reader therefore never sees a
 * partial tree as usable, and a crash leaves a row that startup discards.
 */
export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<IndexedRoot> {
  const handle = openIndex();
  const provider = platform();

  stopWatcher(root); // a rebuild invalidates any watcher on the old rows

  // Replace any previous index for this root atomically.
  handle
    .transaction(() => {
      const prior = handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number } | undefined;
      if (prior) {
        handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(prior.id);
        handle.prepare('DELETE FROM roots WHERE id = ?').run(prior.id);
      }
      handle
        .prepare("INSERT INTO roots (path, state, mechanism) VALUES (?, 'building', ?)")
        .run(root, 'readdir + lstat');
    })
    .call(null);

  const rootId = (handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number }).id;

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

  const insertMany = handle.transaction((batch: typeof pending) => {
    for (const item of batch) {
      // Every insert is a true insert — the root's previous rows were deleted
      // up front — so the returned rowid IS the node's id. That is what lets
      // v3 drop the old per-batch read-back query entirely.
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
    flush();

    if (opts.isCancelled?.()) {
      handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(rootId);
      handle.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
      throw new Error('cancelled');
    }

    opts.onProgress?.({ phase: 'summing', processed, currentPath: root });
    const totalSize = rollUpSizes(handle, rootId);

    handle
      .prepare(
        `UPDATE roots SET state = 'ready', built_at = ?, file_count = ?, dir_count = ?, total_size = ?, error = NULL
         WHERE id = ?`,
      )
      .run(Date.now(), fileCount, dirCount, totalSize, rootId);

    opts.onProgress?.({ phase: 'done', processed, currentPath: root });
    if (opts.live !== false) startWatcher(root);
    return getRoot(root)!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== 'cancelled') {
      handle.prepare("UPDATE roots SET state = 'error', error = ? WHERE id = ?").run(message, rootId);
    }
    opts.onProgress?.({ phase: 'error', processed, currentPath: root });
    throw err;
  }
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

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function listRoots(): IndexedRoot[] {
  const handle = openIndex();
  const rows = handle.prepare('SELECT * FROM roots ORDER BY path').all() as Record<string, unknown>[];
  return rows.map(toIndexedRoot);
}

export function getRoot(rootPath: string): IndexedRoot | null {
  const handle = openIndex();
  const row = handle.prepare('SELECT * FROM roots WHERE path = ?').get(rootPath) as Record<string, unknown> | undefined;
  return row ? toIndexedRoot(row) : null;
}

function toIndexedRoot(row: Record<string, unknown>): IndexedRoot {
  const rootPath = String(row.path);
  return {
    id: Number(row.id),
    path: rootPath,
    state: String(row.state) as IndexState,
    builtAt: row.built_at === null ? null : Number(row.built_at),
    fileCount: Number(row.file_count),
    dirCount: Number(row.dir_count),
    totalSize: Number(row.total_size),
    mechanism: String(row.mechanism),
    live: watchers.has(rootPath),
    ...(row.error ? { error: String(row.error) } : {}),
  };
}

/**
 * Which indexed root contains `p`, if any.
 *
 * The deepest match wins: with both `/Users/me` and `/Users/me/Downloads`
 * indexed, a path inside Downloads should be served by the smaller, more
 * specific index.
 */
export function rootFor(p: string): IndexedRoot | null {
  let best: IndexedRoot | null = null;
  for (const root of listRoots()) {
    if (p !== root.path && !p.startsWith(root.path.endsWith(path.sep) ? root.path : root.path + path.sep)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

export function deleteIndex(rootPath?: string): number {
  const handle = openIndex();
  let removed: number;

  if (rootPath === undefined) {
    stopAllWatchers();
    removed = (handle.prepare('SELECT COUNT(*) c FROM roots').get() as { c: number }).c;
    handle.prepare('DELETE FROM nodes').run();
    handle.prepare('DELETE FROM roots').run();
  } else {
    stopWatcher(rootPath);
    const row = handle.prepare('SELECT id FROM roots WHERE path = ?').get(rootPath) as { id: number } | undefined;
    if (!row) return 0;
    handle.prepare('DELETE FROM nodes WHERE root_id = ?').run(row.id);
    handle.prepare('DELETE FROM roots WHERE id = ?').run(row.id);
    removed = 1;
  }

  /* Reclaim the space on disk, not just inside the file.
   *
   * SQLite marks deleted pages free for reuse but never shrinks the file, so
   * dropping a 366,000-file index left a 192 MB database on disk reporting
   * itself as 192 MB. Someone who deletes their index to free space and sees
   * nothing returned has been given a button that visibly does nothing.
   *
   * VACUUM rewrites the file compactly. It is only ever reached from an
   * explicit delete — never from a scan — so the rebuild cost lands on a
   * deliberate cleanup action, which is where a user expects to wait. */
  try {
    handle.pragma('wal_checkpoint(TRUNCATE)'); // fold the write-ahead log in first
    handle.exec('VACUUM');
    // And again afterwards, which is the step that actually matters: in WAL
    // mode the VACUUM writes the entire rebuilt database *through the log*, so
    // without this second checkpoint the bytes simply move from the main file
    // into the -wal sidecar. Measured on a 2,400-file index: 1,032,192 bytes
    // after the vacuum alone, 53,248 after checkpointing it back down.
    handle.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* Space not reclaimed is a disappointment, not a failure — the rows are
       gone either way, and the next VACUUM will catch up. */
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Path ↔ id translation (v3: paths are derived, never stored)
 * ------------------------------------------------------------------ */

/**
 * Join a child name onto its parent's path, byte-for-byte the way the
 * enumerator builds paths (`base.ts`): plain concatenation with the
 * separator, except when the parent already ends with one (`/`, `C:\`).
 * Names never contain separators, so no normalisation is needed — and
 * `path.join` per node would be measurable on a 224k-node read.
 */
function joinChild(parent: string, name: string): string {
  return parent.endsWith(path.sep) ? parent + name : parent + path.sep + name;
}

/**
 * Resolve an absolute path to its node id by descending one segment at a
 * time — `WHERE parent_id = ? AND name = ?` is an idx_nodes_child seek, so
 * this costs one indexed query per path level, once per call.
 *
 * Returns null when the path is outside the root or not in the index, which
 * is exactly what the old `WHERE path = ?` lookup answered with no row.
 */
export function findNodeIdByPath(rootId: number, rootPath: string, absPath: string): number | null {
  const handle = openIndex();
  const top = handle.prepare('SELECT id FROM nodes WHERE root_id = ? AND parent_id IS NULL').get(rootId) as
    | { id: number }
    | undefined;
  if (!top) return null;
  if (absPath === rootPath) return top.id;

  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (!absPath.startsWith(prefix)) return null;

  const childByName = handle.prepare('SELECT id FROM nodes WHERE parent_id = ? AND name = ?');
  let id = top.id;
  for (const segment of absPath.slice(prefix.length).split(path.sep)) {
    if (segment === '') continue;
    const row = childByName.get(id, segment) as { id: number } | undefined;
    if (!row) return null;
    id = row.id;
  }
  return id;
}

/**
 * A memoised node-id → absolute-path resolver.
 *
 * Callers resolving many nodes at once (search hits, hard-link families)
 * share one resolver: results are sibling-heavy, so nearly every ancestor
 * after the first walk is a cache hit and the marginal cost per node is one
 * query for the node's own row.
 */
export function pathResolver(): (nodeId: number) => string | null {
  const handle = openIndex();
  const nodeRow = handle.prepare('SELECT parent_id, name, root_id FROM nodes WHERE id = ?');
  const rootRow = handle.prepare('SELECT path FROM roots WHERE id = ?');
  const cache = new Map<number, string>();

  return (nodeId: number): string | null => {
    const above: { id: number; name: string }[] = [];
    let base: string | undefined;
    let current = nodeId;
    for (;;) {
      const cached = cache.get(current);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      const row = nodeRow.get(current) as { parent_id: number | null; name: string; root_id: number } | undefined;
      if (!row) return null;
      if (row.parent_id === null) {
        // The top node's path is the root's own path — its `name` is only the
        // final segment, and for a root like '/' not even that.
        const root = rootRow.get(row.root_id) as { path: string } | undefined;
        if (!root) return null;
        base = root.path;
        cache.set(current, base);
        break;
      }
      above.push({ id: current, name: row.name });
      current = row.parent_id;
    }
    let result = base;
    for (let i = above.length - 1; i >= 0; i--) {
      result = joinChild(result, above[i].name);
      cache.set(above[i].id, result);
    }
    return result;
  };
}

/** One-off form of `pathResolver` for single lookups and tests. */
export function pathOfNode(nodeId: number): string | null {
  return pathResolver()(nodeId);
}

/* ------------------------------------------------------------------ *
 * Live updates
 * ------------------------------------------------------------------ */

const watchers = new Map<string, Unsubscribe>();

/** Changes are applied in bursts: a build writes thousands of events at once. */
const FLUSH_MS = 400;

interface PendingChange {
  path: string;
  kind: ChangeEvent['kind'];
  /**
   * How many flushes have already tried and failed to resolve this path.
   * A change is only ever re-queued when the filesystem could not say what
   * happened — never to paper over a decision that was actually made.
   */
  attempts: number;
}

/**
 * How many times a change whose `lstat` could not be resolved is re-asked
 * before the root is called stale instead.
 *
 * Five attempts at the 400 ms flush cadence is about two seconds of patience,
 * which covers the descriptor-exhaustion and busy-volume blips this exists
 * for while still bounding the work. Past that the honest answer is not
 * "try forever" but "this index may have missed something" — which is what
 * `stale` has always meant.
 */
export const MAX_CHANGE_ATTEMPTS = 5;

const pendingByRoot = new Map<string, Map<string, PendingChange>>();
const flushTimers = new Map<string, NodeJS.Timeout>();

/**
 * How many change events the OS has actually delivered for each watched root
 * since its watcher attached.
 *
 * This exists because `fs.watch` can attach without error and then deliver
 * NOTHING. Captured on macOS under load, from one traced run: the watcher
 * attached, the process wrote a file into the watched directory, and fifteen
 * seconds later the watcher was detached having never once fired — while the
 * next root in the same process got its first callback in eleven
 * milliseconds. Nothing in this file can make a silent watch speak, but the
 * difference between "the OS said nothing" and "the OS spoke and the index
 * mishandled it" is the difference between a platform limitation and a bug,
 * and it must be possible to tell them apart.
 */
const eventsSeenByRoot = new Map<string, number>();

/**
 * Change events delivered for `rootPath` since its watcher attached, or null
 * when no watcher is attached.
 *
 * Zero, on a root where something demonstrably changed, means the watch is
 * not delivering — see `eventsSeenByRoot`.
 */
export function watcherEventCount(rootPath: string): number | null {
  return watchers.has(rootPath) ? (eventsSeenByRoot.get(rootPath) ?? 0) : null;
}

/**
 * Make sure a flush is coming for this root, without stacking timers.
 *
 * Retries back off. Under descriptor exhaustion EVERY path in a burst is
 * undecidable at once, not one — so a ten-thousand-event build burst would
 * become fifty thousand `lstat` calls at a flat 400 ms cadence, in the
 * process that is already out of descriptors. Doubling the delay per attempt
 * turns that into pressure that relents, which is the only kind that can let
 * the condition clear.
 */
function scheduleFlush(rootPath: string, attempts = 0): void {
  if (flushTimers.has(rootPath)) return;
  // Capped at 4x. The backoff exists to relieve pressure, not to make the
  // index slow to notice things: doubling all the way to the attempt limit
  // would put the last retry twelve seconds after the change, which is well
  // outside what "live" should mean. 400, 800, then 1,600 ms three times —
  // about six seconds of patience in total.
  const delay = FLUSH_MS * Math.pow(2, Math.min(attempts, 2));
  flushTimers.set(
    rootPath,
    setTimeout(() => {
      flushTimers.delete(rootPath);
      void applyPendingChanges(rootPath);
    }, delay),
  );
}

/** Queue one change and make sure it will be flushed. */
function enqueueChange(rootPath: string, change: PendingChange): void {
  let queue = pendingByRoot.get(rootPath);
  if (!queue) {
    queue = new Map();
    pendingByRoot.set(rootPath, queue);
  }
  // Last write for a path wins: a file created then deleted inside one
  // window is a delete, and applying both in order costs a wasted stat.
  //
  // The ATTEMPT COUNT carries forward, though. A path that keeps producing
  // events while staying unreadable — a directory whose permissions changed,
  // which Linux deliberately keeps watching — would otherwise have its
  // counter reset by every new event and retry for ever, which is the one
  // thing `MAX_CHANGE_ATTEMPTS` exists to prevent.
  const prior = queue.get(change.path);
  queue.set(change.path, {
    ...change,
    attempts: Math.max(change.attempts, prior ? prior.attempts : 0),
  });
  scheduleFlush(rootPath, change.attempts);
}

export function startWatcher(rootPath: string): boolean {
  if (watchers.has(rootPath)) return true;
  try {
    eventsSeenByRoot.set(rootPath, 0);
    const unsubscribe = platform().subscribeToChanges(rootPath, (event) => {
      eventsSeenByRoot.set(rootPath, (eventsSeenByRoot.get(rootPath) ?? 0) + 1);
      enqueueChange(rootPath, { path: event.path, kind: event.kind, attempts: 0 });
    });
    watchers.set(rootPath, unsubscribe);
    return true;
  } catch {
    return false; // watch could not be established; the root stays stale
  }
}

/**
 * Ask again about a change the filesystem could not resolve, or admit the
 * index is out of step. Returns true when another attempt is coming.
 *
 * The watcher check is load-bearing: re-queueing after `stopWatcher` would
 * rebuild the very flush machinery it just tore down, and a live timer would
 * hold the event loop open after the caller asked for everything to stop.
 */
function retryOrMarkStale(rootPath: string, rootId: number, builtAt: number | null, change: PendingChange): boolean {
  if (watchers.has(rootPath) && change.attempts + 1 < MAX_CHANGE_ATTEMPTS) {
    enqueueChange(rootPath, { ...change, attempts: change.attempts + 1 });
    return true;
  }
  // `stale` already means "this index may have missed a change" — the state
  // a root gets when its watcher was not attached continuously. A change this
  // process saw and could not apply is the same fact, so it reuses the same
  // word rather than inventing a second one the UI would have to learn.
  //
  // `built_at` is part of the predicate, not decoration. `rootId` was read
  // before this burst's awaits, and `buildIndex` DELETEs the roots row and
  // INSERTs a new one — SQLite reuses a rowid when the deleted row held the
  // maximum. So a flush still in flight when a rebuild finishes could mark a
  // freshly rebuilt index stale, and `AND state = 'ready'` would not stop it
  // because a rebuilt root is exactly that. Matching the build stamp means
  // the row has to be the same row this burst was working on.
  if (db && builtAt !== null) {
    try {
      db.prepare("UPDATE roots SET state = 'stale' WHERE id = ? AND built_at = ? AND state = 'ready'").run(rootId, builtAt);
    } catch {
      /* the database went away underneath us; the next open rebuilds anyway */
    }
  }
  return false;
}

export function stopWatcher(rootPath: string): void {
  const unsubscribe = watchers.get(rootPath);
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* already gone */
    }
    watchers.delete(rootPath);
  }
  const timer = flushTimers.get(rootPath);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(rootPath);
  }
  pendingByRoot.delete(rootPath);
  eventsSeenByRoot.delete(rootPath);
}

export function stopAllWatchers(): void {
  for (const rootPath of [...watchers.keys()]) stopWatcher(rootPath);
}

/**
 * Apply one burst of filesystem changes to the index.
 *
 * Sizes are re-rolled for the affected ancestors only: a 100 GB root must not
 * pay for a full re-sum because one log file grew.
 */
export async function applyPendingChanges(rootPath: string): Promise<number> {
  const queue = pendingByRoot.get(rootPath);
  pendingByRoot.delete(rootPath);
  if (!queue || queue.size === 0) return 0;

  const handle = openIndex();
  const root = getRoot(rootPath);
  if (!root) return 0;

  // Shutdown can close the database while this burst is awaiting a stat: the
  // flush timer fires before closeIndex, the await resumes after it, and any
  // statement on the captured handle then throws "The database connection is
  // not open" as an unhandledRejection (CI's Windows runner caught it after
  // a test; a SIGTERM mid-burst reproduces it in production). An interrupted
  // burst is simply dropped — the staleness guard already exists precisely
  // to cover changes the watcher did not get to apply.
  const stillOpen = (): boolean => db === handle;

  const touchedParents = new Set<string>();
  let applied = 0;

  // Deleting a directory takes its whole subtree with it. v3 stores no
  // paths, so "the subtree" is the id closure of the node — which also makes
  // the old LIKE-wildcard escaping hazard structurally impossible.
  const deleteSubtree = handle.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT ?
       UNION ALL
       SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
     )
     DELETE FROM nodes WHERE id IN (SELECT id FROM sub)`,
  );
  const insertNode = handle.prepare(
    `INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const change of queue.values()) {
    let stat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    let undecided = false;
    try {
      stat = await fsp.lstat(change.path);
    } catch (err) {
      // "Could not tell" is not "gone". This `catch` used to swallow every
      // errno and fall through to the `stat === null` branch below, which
      // runs `deleteSubtree`. Injecting ONE `EMFILE` here removed a live
      // 50,000-byte file from the index while it sat on disk, and a
      // directory would have taken its whole subtree along. It is also why
      // `an external create ... within 2 seconds` failed on macOS CI: the
      // insert was skipped, nothing re-examined the file, and the change was
      // lost for good rather than late.
      if (meansGone(err)) stat = null;
      else undecided = true;
    }
    if (!stillOpen()) return applied;

    if (undecided) {
      // Leave every row exactly as it is — the last thing actually observed
      // beats a guess — and ask again on the next flush.
      retryOrMarkStale(rootPath, root.id, root.builtAt, change);
      continue;
    }

    if (stat === null) {
      const nodeId = findNodeIdByPath(root.id, rootPath, change.path);
      if (nodeId !== null) {
        deleteSubtree.run(nodeId);
        applied++;
      }
    } else {
      const isDir = stat.isDirectory();
      const name = path.basename(change.path);
      let flags = 0;
      if (stat.isSymbolicLink()) flags |= FLAG.SYMLINK;
      if (name.charCodeAt(0) === 46) flags |= FLAG.HIDDEN;
      const allocated = typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : null;
      const mtime = Math.round(stat.mtimeMs);

      let nodeId = findNodeIdByPath(root.id, rootPath, change.path);
      if (nodeId !== null) {
        const existing = handle.prepare('SELECT is_dir FROM nodes WHERE id = ?').get(nodeId) as
          | { is_dir: number }
          | undefined;
        if (existing && existing.is_dir !== (isDir ? 1 : 0)) {
          // The entry changed kind (a file replaced by a directory, or the
          // reverse) between events. Refreshing the row in place would leave
          // a file with children or a directory without them, so the old
          // subtree goes and a fresh row takes its place.
          deleteSubtree.run(nodeId);
          nodeId = null;
        }
      }

      if (nodeId !== null) {
        if (isDir) {
          // A directory's `size` is the roll-up of its children, not what
          // lstat reports — refreshing it here with stat.size (or the old
          // upsert's 0) would wipe the subtree's total until the next full
          // re-sum, which never touches this node.
          handle.prepare('UPDATE nodes SET allocated = ?, mtime = ?, flags = ? WHERE id = ?').run(allocated, mtime, flags, nodeId);
        } else {
          handle
            .prepare('UPDATE nodes SET size = ?, allocated = ?, mtime = ?, flags = ? WHERE id = ?')
            .run(stat.size, allocated, mtime, flags, nodeId);
        }
        applied++;
      } else {
        let parentId: number | null = null;
        try {
          parentId = await ensureParents(handle, root.id, rootPath, path.dirname(change.path));
        } catch (err) {
          // `ensureParents` rethrows an unresolvable `lstat`, and the same
          // rule applies: do not invent an answer, and do not drop the child
          // because its parent was briefly unreadable.
          //
          // But it also runs SQL and recurses, so `SQLITE_FULL`, a busy or
          // corrupt database, or a closed handle land here too. Retrying five
          // times and then calling the root "stale" would report a database
          // fault as index staleness — a wrong diagnosis of a condition that
          // is not going to clear on its own. Only a filesystem errno is
          // retried; anything else is a real failure and propagates.
          if ((err as NodeJS.ErrnoException | null)?.code === undefined) throw err;
          if (!stillOpen()) return applied;
          retryOrMarkStale(rootPath, root.id, root.builtAt, change);
          continue;
        }
        if (!stillOpen()) return applied;
        if (parentId !== null) {
          insertNode.run(
            root.id,
            parentId,
            name,
            isDir ? '' : extensionOf(name),
            isDir ? 1 : 0,
            isDir ? 0 : stat.size,
            allocated,
            mtime,
            flags,
            stat.ino,
            stat.nlink,
          );
          applied++;
        }
      }
    }
    touchedParents.add(path.dirname(change.path));
  }

  if (applied > 0 && stillOpen()) resumAncestors(handle, root.id, rootPath, touchedParents);
  return applied;
}

/**
 * Node id for `dirPath`, creating any missing ancestor directories on the
 * way down. A watcher can deliver a child's event before its parent's, or
 * coalesce the parent's away entirely — and under v3 an orphan row would be
 * invisible to every tree read, so the chain is materialised from the
 * filesystem instead. Returns null when `dirPath` falls outside the root or
 * no longer exists.
 */
async function ensureParents(
  handle: Database.Database,
  rootId: number,
  rootPath: string,
  dirPath: string,
): Promise<number | null> {
  const known = findNodeIdByPath(rootId, rootPath, dirPath);
  if (known !== null) return known;
  // The root's own node missing is a rebuild problem, not a watcher one.
  if (dirPath === rootPath) return null;
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (!dirPath.startsWith(prefix)) return null;

  const parentId = await ensureParents(handle, rootId, rootPath, path.dirname(dirPath));
  if (parentId === null) return null;

  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(dirPath);
  } catch (err) {
    // Vanished again already — nothing to hang the child on.
    if (meansGone(err)) return null;
    // Anything else is undecidable, and returning null here would report
    // "there is no such directory" on the strength of a descriptor shortage.
    // The caller turns this into a retry.
    throw err;
  }
  if (db !== handle) return null; // closed mid-await — see applyPendingChanges
  if (!stat.isDirectory()) return null;

  const name = path.basename(dirPath);
  const info = handle
    .prepare(
      `INSERT INTO nodes (root_id, parent_id, name, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
       VALUES (?, ?, ?, '', 1, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      rootId,
      parentId,
      name,
      typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : null,
      Math.round(stat.mtimeMs),
      name.charCodeAt(0) === 46 ? FLAG.HIDDEN : 0,
      stat.ino,
      stat.nlink,
    );
  return Number(info.lastInsertRowid);
}


/**
 * Re-sum only the directories on the path from each touched folder to the root.
 *
 * The alternative — re-running the whole roll-up — is O(tree) per change burst,
 * which on a multi-million-file root turns a single file write into seconds of
 * work.
 */
function resumAncestors(
  handle: Database.Database,
  rootId: number,
  rootPath: string,
  touched: Set<string>,
): void {
  const chain = new Set<string>();
  for (const start of touched) {
    let current = start;
    for (;;) {
      chain.add(current);
      if (current === rootPath || current === path.dirname(current)) break;
      current = path.dirname(current);
      if (!current.startsWith(rootPath)) break;
    }
  }

  // Deepest first, so a parent is re-summed after its children.
  const ordered = [...chain].sort((a, b) => b.length - a.length);
  const childSum = handle.prepare('SELECT COALESCE(SUM(size), 0) total FROM nodes WHERE parent_id = ?');
  const setSize = handle.prepare('UPDATE nodes SET size = ? WHERE id = ?');

  const apply = handle.transaction(() => {
    for (const dir of ordered) {
      // Outside the root, or itself deleted in this burst — nothing to re-sum.
      const id = findNodeIdByPath(rootId, rootPath, dir);
      if (id === null) continue;
      const { total } = childSum.get(id) as { total: number };
      setSize.run(total, id);
    }
    const rootSize = handle.prepare('SELECT size FROM nodes WHERE root_id = ? AND parent_id IS NULL').get(rootId) as
      | { size: number }
      | undefined;
    const counts = handle
      .prepare('SELECT SUM(is_dir = 0) files, SUM(is_dir = 1) dirs FROM nodes WHERE root_id = ?')
      .get(rootId) as { files: number | null; dirs: number | null };
    handle
      .prepare('UPDATE roots SET total_size = ?, file_count = ?, dir_count = ? WHERE id = ?')
      .run(rootSize?.size ?? 0, counts.files ?? 0, counts.dirs ?? 0, rootId);
  });
  apply();
}

/* ------------------------------------------------------------------ *
 * Tree reads — the shape the frontend already knows
 * ------------------------------------------------------------------ */

interface NodeRow {
  id: number;
  parent_id: number | null;
  name: string;
  is_dir: number;
  size: number;
  allocated: number | null;
  mtime: number;
  flags: number;
  ino: number | null;
  nlink: number | null;
}

/**
 * Read a subtree as a `FileNode`, bounded by `maxNodes`.
 *
 * This must be byte-compatible with what `/api/scan/:id/result` returns, because
 * the frontend renders both through the same code. That means honouring
 * pruneTree's two invariants exactly (see src/utils/pruneTree.ts):
 *
 *   1. **Whole-directory granularity** — a returned directory either carries
 *      *all* of its children or is marked `pruned`, never a partial list. A
 *      partial list would make the Grid view show a folder as smaller than it is.
 *   2. **Sizes stay exact** — a pruned directory still reports its true
 *      recursive total, which is already stored, so drilling in never changes
 *      the number the user just read.
 *
 * Expansion is biggest-first, matching pruneTree: the budget is spent where the
 * user is looking.
 */
/** One pending directory: the row that produced it and the node being filled. */
interface FrontierEntry {
  row: NodeRow;
  node: FileNode;
}

/**
 * A binary max-heap keyed on directory size.
 *
 * `readTree` needs the largest un-expanded directory next, so the node budget
 * is spent on what dominates the view. Getting that from an array means
 * re-sorting on every pop, which is O(n log n) *per iteration* — fine for a
 * fixture, ruinous on a real tree. A heap gives the same order for O(log n) per
 * push and pop.
 *
 * Kept deliberately small and local: this is the only place in the codebase
 * that needs a priority queue, and a dependency for thirty lines would be a
 * poor trade in a project whose frontend ships zero of them.
 */
class MaxHeapBySize {
  private readonly items: FrontierEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: FrontierEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].row.size >= items[i].row.size) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): FrontierEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as FrontierEntry;
    if (items.length === 0) return top;

    items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let largest = i;
      if (left < items.length && items[left].row.size > items[largest].row.size) largest = left;
      if (right < items.length && items[right].row.size > items[largest].row.size) largest = right;
      if (largest === i) break;
      [items[largest], items[i]] = [items[i], items[largest]];
      i = largest;
    }
    return top;
  }
}

export function readTree(
  rootPath: string,
  subPath?: string,
  maxNodes = 250_000,
): { root: FileNode; nodes: number; prunedDirs: number } | null {
  const handle = openIndex();
  const root = getRoot(rootPath);
  if (!root) return null;

  const target = subPath ?? rootPath;
  // v3 stores no paths, so the start row is found by descending the tree one
  // segment at a time — an idx_nodes_child seek per level, ~10 queries once
  // per call in place of the old single path-column lookup.
  const startId = findNodeIdByPath(root.id, rootPath, target);
  if (startId === null) return null;
  const startRow = handle.prepare('SELECT * FROM nodes WHERE id = ?').get(startId) as NodeRow | undefined;
  if (!startRow) return null;

  // LIMIT is not an optimisation detail here, it is the difference between
  // fetching what we keep and fetching what we throw away. A directory that
  // does not fit the remaining budget is withheld whole — but the old query
  // fetched every one of its children first and then discarded them all.
  // Measured on a real 1M-node index with a 25,000-node budget: 275,876 rows
  // fetched to keep 25,000. Asking for one more row than could possibly fit
  // answers the same question — "is this bigger than the room left?" — while
  // reading at most that many rows.
  const childrenOf = handle.prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY size DESC LIMIT ?');

  // How many names for each multi-linked inode live inside this root (A2).
  // Fetched once for the whole root rather than per node: the alternative is a
  // COUNT query per file, which on a large tree is thousands of round trips.
  const familySizes = new Map<number, number>();
  for (const row of handle
    .prepare('SELECT ino, COUNT(*) c FROM nodes WHERE root_id = ? AND is_dir = 0 AND nlink > 1 GROUP BY ino')
    .all(root.id) as { ino: number; c: number }[]) {
    familySizes.set(row.ino, row.c);
  }

  // Paths are rebuilt top-down during the descent: the parent's path is
  // already known when its children are read, so each child costs one string
  // concatenation rather than a stored 143-byte column.
  const startNode = toFileNode(startRow, familySizes, target);
  let nodes = 1;
  let prunedDirs = 0;

  // Biggest-first frontier, so the node budget is spent on what dominates the
  // view rather than on whichever directory happened to be enumerated first.
  //
  // A heap, not a re-sorted array. The obvious `frontier.sort(); shift()` is
  // correct but accidentally quadratic: it re-sorts every pending directory on
  // every iteration, so a root with 47k directories does ~10^9 comparisons and
  // takes **8.5 seconds** for 224k nodes — measured, on a real ~/Library. The
  // whole point of the index is that reopening is instant, and that made it
  // slower than the scan it was meant to replace.
  const frontier = new MaxHeapBySize();
  if (startRow.is_dir) frontier.push({ row: startRow, node: startNode });

  while (frontier.size > 0) {
    const current = frontier.pop();
    if (!current) break;

    // room + 1 rows: enough to place every child if they fit, and exactly one
    // more than fits if they do not — which is all the test below needs.
    const room = maxNodes - nodes;
    const rows = childrenOf.all(current.row.id, room + 1) as NodeRow[];
    if (rows.length === 0) {
      // An empty directory MUST carry `children: []`, not undefined — the
      // empty-folder finder keys off exactly that distinction.
      current.node.children = [];
      continue;
    }
    if (rows.length > room) {
      // Withhold whole directories only: half a directory would break
      // invariant 1 and silently under-report the folder.
      current.node.pruned = true;
      prunedDirs++;
      continue;
    }

    current.node.children = [];
    for (const row of rows) {
      const child = toFileNode(row, familySizes, joinChild(current.node.path, row.name));
      current.node.children.push(child);
      nodes++;
      if (row.is_dir) frontier.push({ row, node: child });
    }
  }

  return { root: startNode, nodes, prunedDirs };
}

function toFileNode(row: NodeRow, familySizes: Map<number, number>, nodePath: string): FileNode {
  const node: FileNode = {
    name: row.name,
    path: nodePath,
    size: row.size,
    type: row.is_dir ? 'dir' : 'file',
    modifiedAt: row.mtime,
    isHidden: (row.flags & FLAG.HIDDEN) !== 0,
  };
  if (!row.is_dir) {
    const dot = row.name.lastIndexOf('.');
    if (dot > 0 && dot < row.name.length - 1) node.extension = row.name.slice(dot + 1).toLowerCase();
  }
  if ((row.flags & FLAG.SYMLINK) !== 0) node.isSymlink = true;
  if ((row.flags & FLAG.HARDLINK_DUPLICATE) !== 0) node.hardlinkDuplicate = true;
  if ((row.flags & FLAG.PLACEHOLDER) !== 0) node.cloudPlaceholder = true;

  /* A2 — allocation, attached only where it says something the size does not.
     Setting these on every node would add four fields to a quarter of a million
     objects to tell the caller nothing. */
  if (!row.is_dir) {
    const allocated = row.allocated;
    const linksTotal = row.nlink ?? 1;

    if (allocated !== null && allocated !== row.size) node.allocatedBytes = allocated;

    if (linksTotal > 1 && row.ino !== null) {
      const linksInScope = familySizes.get(row.ino) ?? 1;
      const bytes = allocated ?? row.size;
      node.linksInScope = linksInScope;
      node.linksTotal = linksTotal;
      // Another name exists — inside the root or beyond it — so deleting this
      // one frees nothing.
      node.sharedBytes = bytes;
      node.exclusiveBytes = 0;
    } else if (allocated !== null && allocated !== row.size) {
      // Sparse, compressed or evicted: the bytes are exclusive, but there are
      // fewer of them than the size suggests.
      node.sharedBytes = 0;
      node.exclusiveBytes = allocated;
    }
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Search (A4)
 * ------------------------------------------------------------------ */

export interface SearchOptions {
  /** Only entries at least this many bytes. */
  minSize?: number;
  /** Only entries not modified for at least this many days. */
  olderThanDays?: number;
  type?: 'file' | 'dir' | 'all';
  /** Restrict to one folder (and everything beneath it). */
  scope?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  name: string;
  path: string;
  /** The folder holding it, so results can be grouped without re-parsing paths. */
  parentPath: string;
  size: number;
  type: 'file' | 'dir';
  extension?: string;
  modifiedAt: number;
  rootPath: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Matches found. Exact unless `countCapped`, in which case it is a floor. */
  total: number;
  /** True when `total` hit the counting cap — display it as "N+", never as exact. */
  countCapped: boolean;
  truncated: boolean;
  /** Milliseconds spent in the database. */
  tookMs: number;
  /** Roots that were searched. */
  roots: string[];
  /** Roots that exist but could not be trusted — reported, never silently used. */
  staleRoots: string[];
}

/** Hard ceiling on rows returned in one page, whatever the caller asks for. */
const SEARCH_MAX_LIMIT = 500;

/**
 * Stop counting matches past this point.
 *
 * "More than five thousand" and "exactly 431,902" mean the same thing to
 * someone looking for a file, and the second costs a full scan that grows with
 * the index while the first does not.
 */
const SEARCH_COUNT_CAP = 5_000;

/**
 * Search the index (A4).
 *
 * Uses the exact query language of the treemap's highlight box (see
 * utils/searchQuery.ts), so `*.zip` means the same thing in both places.
 *
 * ── Why the two query shapes are built differently ──
 *
 * An extension query is an index seek on `(ext, size DESC)`: SQLite finds the
 * extension and walks it in size order, so the `ORDER BY` costs nothing and a
 * popular extension does not mean sorting hundreds of thousands of rows.
 *
 * A substring query cannot use a B-tree index at all — a leading `%` wildcard
 * has nothing to seek on — so it scans. That is a deliberate acceptance of the
 * §A4 constraint: FTS5 would make it an index lookup, but FTS is token-based
 * and would silently change what a search *means* (`part` would stop matching
 * `department.pdf`). Matching the existing syntax exactly is worth the scan,
 * and the scan is measured rather than assumed — see the benchmark in
 * tests/indexSearch.test.ts.
 */
export function searchIndex(rawQuery: string, opts: SearchOptions = {}): SearchResult {
  const started = Date.now();
  const handle = openIndex();
  const parsed = parseQuery(rawQuery);

  const roots = listRoots().filter((r) => r.state === 'ready' || r.state === 'stale');
  const staleRoots = roots.filter((r) => r.state !== 'ready').map((r) => r.path);

  if (parsed.kind === 'empty' || roots.length === 0) {
    return {
      query: rawQuery,
      hits: [],
      total: 0,
      countCapped: false,
      truncated: false,
      tookMs: Date.now() - started,
      roots: roots.map((r) => r.path),
      staleRoots,
    };
  }

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (parsed.kind === 'extension') {
    where.push('n.ext = ?', 'n.is_dir = 0');
    params.push(parsed.extension);
  } else {
    // ESCAPE is not optional: a query containing '%' or '_' would otherwise be
    // a wildcard, so searching for "100%" would match nearly everything.
    where.push("n.name LIKE ? ESCAPE '\\'");
    params.push('%' + escapeLike(parsed.needle) + '%');
  }

  const type = opts.type ?? 'all';
  if (type === 'file') where.push('n.is_dir = 0');
  else if (type === 'dir') where.push('n.is_dir = 1');

  if (opts.minSize !== undefined && opts.minSize > 0) {
    where.push('n.size >= ?');
    params.push(opts.minSize);
  }
  if (opts.olderThanDays !== undefined && opts.olderThanDays > 0) {
    where.push('n.mtime <= ?');
    params.push(Date.now() - opts.olderThanDays * 86_400_000);
  }
  if (opts.scope) {
    // Scope to a folder and everything beneath it. v3 stores no paths, so the
    // scope resolves to node ids — one per root that holds it — and the filter
    // is their id closure. Segment matching keeps the old separator guarantee:
    // '/data/app' cannot scope '/data/application'. When two roots overlap
    // (an outer and an inner both indexed), both contribute, exactly as the
    // old prefix match did.
    const scope = opts.scope;
    const scopePrefix = scope.endsWith(path.sep) ? scope : scope + path.sep;
    const scopeIds: number[] = [];
    for (const r of roots) {
      const id =
        r.path === scope || r.path.startsWith(scopePrefix)
          ? findNodeIdByPath(r.id, r.path, r.path) // the whole root lies inside the scope
          : findNodeIdByPath(r.id, r.path, scope); // null when the scope is outside this root
      if (id !== null) scopeIds.push(id);
    }
    if (scopeIds.length === 0) {
      return {
        query: rawQuery,
        hits: [],
        total: 0,
        countCapped: false,
        truncated: false,
        tookMs: Date.now() - started,
        roots: roots.map((r) => r.path),
        staleRoots,
      };
    }
    where.push(
      `n.id IN (
         WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE id IN (${scopeIds.map(() => '?').join(',')})
           UNION ALL
           SELECT c.id FROM nodes c JOIN sub ON c.parent_id = sub.id
         )
         SELECT id FROM sub
       )`,
    );
    params.push(...scopeIds);
  }

  const clause = where.join(' AND ');
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);

  // The id tiebreak replaces the old `n.path ASC`: with no stored path there
  // is nothing alphabetical to order equal sizes by without reconstructing a
  // path for every candidate row. Ids are enumeration order, which is just as
  // deterministic and stable across pages — and for a size-descending search
  // for disk hogs, the order among exact-size ties carries no meaning.
  const rows = handle
    .prepare(
      `SELECT n.id, n.name, n.ext, n.is_dir, n.size, n.mtime, r.path AS root_path
         FROM nodes n JOIN roots r ON r.id = n.root_id
        WHERE ${clause}
        ORDER BY n.size DESC, n.id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: number;
    name: string;
    ext: string;
    is_dir: number;
    size: number;
    mtime: number;
    root_path: string;
  }[];

  // Results are capped at a page, so rebuilding each hit's path is a bounded
  // ancestor walk — and hits are sibling-heavy, so the shared resolver cache
  // makes most of it free.
  const resolve = pathResolver();

  /* Counting matches, without paying for it twice.
   *
   * A page that came back short IS the whole answer — there is nothing after
   * it — so the count is free and exact.
   *
   * Otherwise the count is capped. An uncapped COUNT(*) is a second full scan:
   * measured at 17ms over 500k rows, which sounds harmless until the same query
   * runs against a 5M-file index, where it alone would exceed A4's whole 100ms
   * budget. The capped form stays ~7ms at any size. The trade is that a very
   * broad query reports "5,000+" instead of an exact figure — which `countCapped`
   * says outright, so the UI shows "5,000+" rather than a wrong number. */
  let total: number;
  let countCapped = false;
  if (rows.length < limit) {
    total = offset + rows.length;
  } else {
    const capped = (
      handle
        .prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM nodes n WHERE ${clause} LIMIT ?)`)
        .get(...params, SEARCH_COUNT_CAP) as { c: number }
    ).c;
    total = capped;
    countCapped = capped >= SEARCH_COUNT_CAP;
  }

  return {
    query: rawQuery,
    countCapped,
    hits: rows.map((row) => {
      const hitPath = resolve(row.id) ?? joinChild(row.root_path, row.name);
      return {
        name: row.name,
        path: hitPath,
        parentPath: path.dirname(hitPath),
        size: row.size,
        type: row.is_dir ? ('dir' as const) : ('file' as const),
        ...(row.is_dir === 0 && row.ext ? { extension: row.ext } : {}),
        modifiedAt: row.mtime,
        rootPath: row.root_path,
      };
    }),
    total,
    // More matches exist beyond this page. With a capped count `total` is a
    // floor, so a full page always implies more may follow.
    truncated: rows.length === limit || total > offset + rows.length,
    tookMs: Date.now() - started,
    roots: roots.map((r) => r.path),
    staleRoots,
  };
}

/**
 * Bring a stale root back to 'ready' by rebuilding it.
 *
 * Reconciliation is deliberately a rebuild rather than a diff: without a
 * journal sequence there is no way to know *what* was missed, and a diff that
 * assumes it knows would reintroduce exactly the silent wrongness this state
 * exists to prevent.
 */
export async function reconcile(rootPath: string, opts: BuildOptions = {}): Promise<IndexedRoot> {
  return buildIndex(rootPath, opts);
}
