import Database from 'better-sqlite3';
import path from 'path';
import { promises as fsp, mkdirSync, unlinkSync } from 'fs';
import { appDataDir } from './storage';
import { platform } from '../platform';
import { neverDescend } from '../utils/mountBoundaries';
// `escapeLike` is shared with the search layer: `_` and `%` are LIKE wildcards,
// and a real path containing either must not become a pattern. One
// implementation, so the delete path and the search path cannot disagree.
import { parseQuery, extensionOf, escapeLike } from '../utils/searchQuery';
import type { ChangeEvent, Unsubscribe } from '../platform/types';
import type { FileNode } from '../models/types';

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
 */
const SCHEMA_VERSION = 2;

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

    CREATE TABLE IF NOT EXISTS nodes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id   INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      parent_id INTEGER,
      name      TEXT NOT NULL,
      path      TEXT NOT NULL,
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

    -- Drill-in: children of a directory.
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    -- Path lookup, and the uniqueness that makes incremental upsert correct.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_path ON nodes(root_id, path);
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

  const file = indexDbPath();
  // The app-data directory is created lazily elsewhere (storage.ts writes it on
  // first save), so on a fresh machine it may not exist yet — and better-sqlite3
  // refuses to create a database in a missing directory.
  mkdirSync(appDataDir(), { recursive: true });
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
    `INSERT INTO nodes (root_id, parent_id, name, path, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
     VALUES (@root_id, @parent_id, @name, @path, @ext, @is_dir, @size, @allocated, @mtime, @flags, @ino, @nlink)
     ON CONFLICT(root_id, path) DO UPDATE SET
       size = excluded.size, allocated = excluded.allocated, mtime = excluded.mtime,
       flags = excluded.flags, ino = excluded.ino, nlink = excluded.nlink`,
  );
  const insertMany = handle.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) insert.run(row);
  });

  /** path → node id, so a child can name its parent without a query per row. */
  const idByPath = new Map<string, number>();
  /** Inodes already counted, so a hard link is not double-counted. */
  const seenInodes = new Set<number>();

  let processed = 0;
  let fileCount = 0;
  let dirCount = 0;
  let pending: Record<string, unknown>[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    insertMany(pending);
    // Ids are assigned by SQLite, so they are read back once per batch rather
    // than once per row.
    const paths = pending.map((r) => r.path as string);
    const placeholders = paths.map(() => '?').join(',');
    const rows = handle
      .prepare(`SELECT id, path FROM nodes WHERE root_id = ? AND path IN (${placeholders})`)
      .all(rootId, ...paths) as { id: number; path: string }[];
    for (const row of rows) idByPath.set(row.path, row.id);
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

      pending.push({
        root_id: rootId,
        parent_id: parentPath === null ? null : (idByPath.get(parentPath) ?? null),
        name: entry.name,
        path: entry.path,
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
 * Live updates
 * ------------------------------------------------------------------ */

const watchers = new Map<string, Unsubscribe>();

/** Changes are applied in bursts: a build writes thousands of events at once. */
const FLUSH_MS = 400;

interface PendingChange {
  path: string;
  kind: ChangeEvent['kind'];
}

const pendingByRoot = new Map<string, Map<string, PendingChange>>();
const flushTimers = new Map<string, NodeJS.Timeout>();

export function startWatcher(rootPath: string): boolean {
  if (watchers.has(rootPath)) return true;
  try {
    const unsubscribe = platform().subscribeToChanges(rootPath, (event) => {
      let queue = pendingByRoot.get(rootPath);
      if (!queue) {
        queue = new Map();
        pendingByRoot.set(rootPath, queue);
      }
      // Last write for a path wins: a file created then deleted inside one
      // window is a delete, and applying both in order costs a wasted stat.
      queue.set(event.path, { path: event.path, kind: event.kind });

      if (!flushTimers.has(rootPath)) {
        flushTimers.set(
          rootPath,
          setTimeout(() => {
            flushTimers.delete(rootPath);
            void applyPendingChanges(rootPath);
          }, FLUSH_MS),
        );
      }
    });
    watchers.set(rootPath, unsubscribe);
    return true;
  } catch {
    return false; // watch could not be established; the root stays stale
  }
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

  const touchedParents = new Set<string>();
  let applied = 0;

  for (const change of queue.values()) {
    let stat: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
    try {
      stat = await fsp.lstat(change.path);
    } catch {
      stat = null; // gone
    }

    if (stat === null) {
      // Deleting a directory takes its whole subtree with it.
      const prefix = change.path.endsWith(path.sep) ? change.path : change.path + path.sep;
      handle
        .prepare('DELETE FROM nodes WHERE root_id = ? AND (path = ? OR path LIKE ? ESCAPE \'\\\')')
        .run(root.id, change.path, escapeLike(prefix) + '%');
      applied++;
    } else {
      const isDir = stat.isDirectory();
      const parentPath = path.dirname(change.path);
      const parent = handle.prepare('SELECT id FROM nodes WHERE root_id = ? AND path = ?').get(root.id, parentPath) as
        | { id: number }
        | undefined;
      let flags = 0;
      if (stat.isSymbolicLink()) flags |= FLAG.SYMLINK;
      if (path.basename(change.path).charCodeAt(0) === 46) flags |= FLAG.HIDDEN;

      handle
        .prepare(
          `INSERT INTO nodes (root_id, parent_id, name, path, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(root_id, path) DO UPDATE SET
             size = excluded.size, allocated = excluded.allocated, mtime = excluded.mtime, flags = excluded.flags`,
        )
        .run(
          root.id,
          parent?.id ?? null,
          path.basename(change.path),
          change.path,
          isDir ? '' : extensionOf(path.basename(change.path)),
          isDir ? 1 : 0,
          isDir ? 0 : stat.size,
          typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : null,
          Math.round(stat.mtimeMs),
          flags,
          stat.ino,
          stat.nlink,
        );
      applied++;
    }
    touchedParents.add(path.dirname(change.path));
  }

  if (applied > 0) resumAncestors(handle, root.id, rootPath, touchedParents);
  return applied;
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
  const childSum = handle.prepare(
    'SELECT COALESCE(SUM(size), 0) total FROM nodes WHERE parent_id = (SELECT id FROM nodes WHERE root_id = ? AND path = ?)',
  );
  const setSize = handle.prepare('UPDATE nodes SET size = ? WHERE root_id = ? AND path = ?');

  const apply = handle.transaction(() => {
    for (const dir of ordered) {
      const { total } = childSum.get(rootId, dir) as { total: number };
      setSize.run(total, rootId, dir);
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
  path: string;
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
  const startRow = handle.prepare('SELECT * FROM nodes WHERE root_id = ? AND path = ?').get(root.id, target) as
    | NodeRow
    | undefined;
  if (!startRow) return null;

  const childrenOf = handle.prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY size DESC');

  // How many names for each multi-linked inode live inside this root (A2).
  // Fetched once for the whole root rather than per node: the alternative is a
  // COUNT query per file, which on a large tree is thousands of round trips.
  const familySizes = new Map<number, number>();
  for (const row of handle
    .prepare('SELECT ino, COUNT(*) c FROM nodes WHERE root_id = ? AND is_dir = 0 AND nlink > 1 GROUP BY ino')
    .all(root.id) as { ino: number; c: number }[]) {
    familySizes.set(row.ino, row.c);
  }

  const startNode = toFileNode(startRow, familySizes);
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

    const rows = childrenOf.all(current.row.id) as NodeRow[];
    if (rows.length === 0) {
      // An empty directory MUST carry `children: []`, not undefined — the
      // empty-folder finder keys off exactly that distinction.
      current.node.children = [];
      continue;
    }
    if (nodes + rows.length > maxNodes) {
      // Withhold whole directories only: half a directory would break
      // invariant 1 and silently under-report the folder.
      current.node.pruned = true;
      prunedDirs++;
      continue;
    }

    current.node.children = [];
    for (const row of rows) {
      const child = toFileNode(row, familySizes);
      current.node.children.push(child);
      nodes++;
      if (row.is_dir) frontier.push({ row, node: child });
    }
  }

  return { root: startNode, nodes, prunedDirs };
}

function toFileNode(row: NodeRow, familySizes: Map<number, number>): FileNode {
  const node: FileNode = {
    name: row.name,
    path: row.path,
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
    // Scope to a folder and everything beneath it. The separator on the prefix
    // stops '/data/app' from also scoping '/data/application'.
    const prefix = opts.scope.endsWith(path.sep) ? opts.scope : opts.scope + path.sep;
    where.push("(n.path = ? OR n.path LIKE ? ESCAPE '\\')");
    params.push(opts.scope, escapeLike(prefix) + '%');
  }

  const clause = where.join(' AND ');
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const rows = handle
    .prepare(
      `SELECT n.name, n.path, n.ext, n.is_dir, n.size, n.mtime, r.path AS root_path
         FROM nodes n JOIN roots r ON r.id = n.root_id
        WHERE ${clause}
        ORDER BY n.size DESC, n.path ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    name: string;
    path: string;
    ext: string;
    is_dir: number;
    size: number;
    mtime: number;
    root_path: string;
  }[];

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
    hits: rows.map((row) => ({
      name: row.name,
      path: row.path,
      parentPath: path.dirname(row.path),
      size: row.size,
      type: row.is_dir ? 'dir' : 'file',
      ...(row.is_dir === 0 && row.ext ? { extension: row.ext } : {}),
      modifiedAt: row.mtime,
      rootPath: row.root_path,
    })),
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
