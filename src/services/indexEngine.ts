import Database from 'better-sqlite3';
import path from 'path';
import { promises as fsp, mkdirSync, unlinkSync } from 'fs';
import { appDataDir } from './storage';
import { trackWrite } from '../utils/backgroundWrites';
import { isEphemeral } from './portableMode';
import { platform } from '../platform';
import { exclusionsOf, isAtOrUnder, neverDescend, neverDescendPaths } from '../utils/mountBoundaries';
// `escapeLike` guards the one LIKE query left (the substring search): `_` and
// `%` are LIKE wildcards, and a real filename containing either must not
// become a pattern. Since v3, deletes and scopes work on node ids, so no
// path ever meets LIKE at all.
import { parseQuery, extensionOf, escapeLike } from '../utils/searchQuery';
import type { ChangeEvent, RawEntry, Unsubscribe } from '../platform/types';
import { onWatchDelivery } from '../platform/types';
import { holdWatchesOf, onWatchSetChange, watchesShareOneStream } from '../platform/watchRegistry';
import type { FileNode } from '../models/types';
import { meansAbsent, meansGone } from '../utils/errno';
import { formatCount } from '../utils/formatCount';
import { hardlinkKey } from './diskScanner';

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
  /**
   * Why a 'stale' root may be missing a change, as a sentence the UI shows as
   * it is. Present only when `state` is 'stale'. A root this process did not
   * mark stale was already stale when the index was opened — its watcher
   * ended with the process that built it. (A second TreeMap process opening
   * the same index marks every root stale the same way; the Electron shell
   * allows one instance, so that takes a development server beside it.)
   */
  staleReason?: string;
  error?: string;
}

/* Why a root is stale — one sentence per way a root gets there, shown as it is by the UI. */
const STALE_REASON = {
  /** Stale when the index was opened: nothing watched it while TreeMap was closed. */
  notWatchedWhileClosed: 'It wasn’t watched while TreeMap was closed, so a change made then may be missing.',
  /** Another watch in the process attached or closed on a platform where they share one stream (macOS). */
  sharedStream:
    'TreeMap started or stopped watching another folder, which on macOS briefly interrupts every folder it watches — a change made here in that moment may be missing.',
  /** The system ended this root's own watch. */
  watchEnded: 'The system stopped reporting changes in this folder, so a change made since then may be missing.',
  /** A change the filesystem would not answer for, past `MAX_CHANGE_ATTEMPTS`. */
  unreadableChange: 'A change here could not be read after several tries, so it may be missing.',
  /** A burst of changes the database would not take. */
  unwritableChange: 'A change here could not be written to the index, so it may be missing.',
  /** The "Stay on this drive" setting changed after the build read it (final review F1.5). */
  boundaryChanged:
    'The “Stay on this drive” setting has changed since this index was built, so a drive mounted inside this folder may be counted differently now.',
} as const;

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

    -- Folders whose capped build stopped at its cap (Track U review of U-1):
    -- the walk counted more than the build may write, so the page offers
    -- instead of starting the same doomed build after every scan. A table of
    -- its own, created where missing, so no schema_version bump (U-D4): an
    -- older TreeMap opening this file ignores it.
    CREATE TABLE IF NOT EXISTS cap_stops (
      path        TEXT PRIMARY KEY,
      max_entries INTEGER NOT NULL,
      stopped_at  INTEGER NOT NULL
    );
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
 * Discarding is always correct — and not by deleting here: each root is set
 * aside in one statement, out of every reader's sight, and its rows are
 * reclaimed in slices behind the open (`reclaimLater`). Deleting them here
 * blocked the first request after a restart for as long as the rows took
 * (17 µs a row).
 */
function discardIncompleteBuilds(): void {
  if (!db) return;
  reclaimLeftovers(db, true);
  // Every surviving root was built by a process that is no longer running, so
  // its watcher is gone and it may have missed changes. Honest state: stale.
  db.prepare("UPDATE roots SET state = 'stale' WHERE state = 'ready'").run();
}

/** Close the database (graceful shutdown, and between tests). */
export function closeIndex(): void {
  stopAllWatchers();
  // Every root is stale on the next open for the reason that open gives.
  staleReasons.clear();
  // And what each index leaves out is the next process's to work out again.
  rootExclusions.clear();
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
  /**
   * The most entries (the folder itself included) this build may write. Past
   * it the walk stops, what was written is discarded exactly as a cancel
   * discards it, the stop is remembered (`capStopFor`), and the build rejects
   * with `IndexCapReached`. The page sends `INDEX_AUTO_MAX_ENTRIES` with every
   * build it starts on its own; absent, nothing is capped (an explicit build).
   *
   * A capped build is written ASIDE: under a roots row of its own, at a path
   * no folder can have, swapped in for the folder's saved index only once it
   * has finished. Until then the saved root, its rows and its watcher are
   * untouched, so a build that stops at its cap, is cancelled, fails or dies
   * with the process leaves the saved index exactly as it was (the owner's
   * rule, plan U-Q4: a saved index is never deleted automatically).
   *
   * An explicit build — no `maxEntries`, a person's request — is NOT written
   * aside: it replaces the saved index up front, as it always has (U-D3).
   * Once its folder has been found listable (`refuseUnwalkable`), its first
   * transaction sets the saved root aside, out of every reader's sight, and
   * its rows are reclaimed while the build walks; an explicit build that is
   * cancelled or fails leaves the folder with no index.
   */
  maxEntries?: number;
  /**
   * The paths the walk must not enter (Track U, U-24): what a scan of the
   * folder is handed under the person's "Stay on this drive" setting
   * (`scanBoundary`) — the fixed never-descend folders and, under `stay`,
   * every drive mounted inside the folder. The route composes it from the
   * folder and the setting; absent, the fixed list alone, as before. Each is
   * left out of the index, as the fixed folders always were, and the root's
   * live watcher drops every change at or under one beneath the folder.
   */
  neverDescend?: readonly string[];
}

/**
 * The start of the path a capped build's roots row holds while it is being
 * written. Every indexed root is an absolute path (`/…`, `C:\…`, `\\…`), so
 * no folder's path begins like this: `getRoot` and `rootFor` can never
 * resolve to it, and `listRoots` and search leave it out.
 */
const ASIDE_PREFIX = 'building-aside:';
/** The first string after every string that starts with ASIDE_PREFIX (`:` + 1 is `;`). */
const ASIDE_PREFIX_END = `${ASIDE_PREFIX.slice(0, -1)}${String.fromCharCode(ASIDE_PREFIX.charCodeAt(ASIDE_PREFIX.length - 1) + 1)}`;
let asideSeq = 0;

/** Whether a roots row is a capped build still being written aside. */
function isAside(rootPath: string): boolean {
  return rootPath.startsWith(ASIDE_PREFIX);
}

/**
 * The most items a folder may hold for TreeMap to index it on its own after
 * a scan (plan U-1; the owner's answer to U-Q2 and U-Q3, 30 Sep 2026). Above
 * it the page does not start a build, and the server stops an automatic build
 * that passes it: the walk that builds the index does not honour the scan's
 * "don't scan" patterns, and the folder can grow between the scan and the
 * build, so the page's count alone is not a bound (U-D3).
 *
 * Why a bound at all: after every scan of a whole disk the page rebuilt its
 * index — 9.46M rows, 31 minutes with the event loop blocked 32 % of the
 * time, stalls up to 111 s, a 3.76 GB heap and a 2.63 GB database
 * (docs/engine/TRACK-U-DIAGNOSIS.md). The largest index recorded before that
 * was a 1,013,072-node home folder at 209 MB.
 */
export const INDEX_AUTO_MAX_ENTRIES = 1_000_000;

/**
 * A build stopped at its `maxEntries`. The job it ran for ends cancelled, not
 * failed — nothing went wrong, the folder is larger than TreeMap indexes on
 * its own — and this sentence is what it reports.
 */
export class IndexCapReached extends Error {
  constructor(readonly maxEntries: number) {
    super(capSentence(maxEntries));
    this.name = 'IndexCapReached';
  }
}

function capSentence(maxEntries: number): string {
  return `Stopped at ${formatCount(maxEntries)} items: more than TreeMap indexes on its own.`;
}

/** A folder whose last capped build stopped at its cap: the cap, when, and the sentence the build ended with. */
export interface CapStop {
  maxEntries: number;
  at: number;
  reason: string;
}

/**
 * Whether the last capped build of exactly `rootPath` stopped at its cap,
 * or null. Kept in the index database, so a restart does not forget it, until
 * a build of that folder completes (`rebuild`) or its index is deleted
 * (`deleteIndex`). The page reads it from `GET /api/index/status?path=` and
 * offers instead of starting the same doomed build after every scan.
 */
export function capStopFor(rootPath: string): CapStop | null {
  const row = openIndex().prepare('SELECT max_entries, stopped_at FROM cap_stops WHERE path = ?').get(rootPath) as
    | { max_entries: number; stopped_at: number }
    | undefined;
  return row ? { maxEntries: row.max_entries, at: row.stopped_at, reason: capSentence(row.max_entries) } : null;
}

/**
 * How many rows each write transaction of a build holds (plan U-15): about
 * 26 ms of the thread a transaction at the measured 52 µs a row, against
 * about 260 ms for the 5,000 it was (arithmetic). The event loop turns after
 * every one, so no request waits behind more than one.
 */
export const INDEX_BATCH_ROWS = 500;

/**
 * How many node ids a build without a cap sets aside (U-D6): 2^32, which
 * keeps every id below 2^53 — exact in a JavaScript number — for 2^21 such
 * builds (arithmetic). A capped build sets aside its cap and one more.
 */
const UNCAPPED_ID_STRIDE = 2 ** 32;

/** What a build stops with when its walk hands over more entries than it set ids aside for. */
function strideSentence(stride: number): string {
  return `The index build stopped at ${formatCount(stride)} items, the most it set aside room for.`;
}

/** Lets the event loop turn: every timer, request and reply queued behind the build runs before it goes on. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ------------------------------------------------------------------ *
 * Reclaiming a root's rows (Track U review of the index, M1)
 * ------------------------------------------------------------------ */

/**
 * How many rows one statement reclaiming a root's rows deletes: about 26 ms
 * of the thread at the measured 17 µs a row — the budget of one build write
 * (INDEX_BATCH_ROWS) — where deleting a root's rows in one statement took
 * 17.2 s for 1,000,000 rows (the real schema and its nine indexes), with
 * every request, and in the desktop app the window, waiting behind it.
 */
export const INDEX_RECLAIM_ROWS = 1_500;

/**
 * The start of the path a root takes once it is no folder's index any more
 * — replaced by a build swapped in, discarded at a cap, a cancel or a
 * failure, or left building by a process that ended — while its rows are
 * reclaimed. It begins with ASIDE_PREFIX, so every reader that leaves a
 * capped build out (`listRoots`, `rootFor`, search's range seek) leaves it
 * out too, and the root's own id makes it unique.
 */
const DISCARD_PREFIX = `${ASIDE_PREFIX}discard:`;

/**
 * Takes root `rootId` out of every reader's sight in one statement, and
 * frees the folder's path for a build of it. Its rows stay where they are
 * for `reclaimLater`. It reads 'building' from now on, so a process that
 * ends before its rows are gone leaves it for the next open to reclaim.
 */
function setAside(handle: Database.Database, rootId: number): void {
  handle.prepare("UPDATE roots SET path = ?, state = 'building' WHERE id = ?").run(`${DISCARD_PREFIX}${String(rootId)}`, rootId);
}

/** Tests only: what a test can see of the reclaim of a root's rows, and where it can hold one. */
export interface ReclaimSeams {
  /** Fewer rows a slice than INDEX_RECLAIM_ROWS. */
  rows?: number;
  /** Before each slice of `rootId`'s rows, numbered from 1. A promise holds the reclaim until it settles. */
  beforeSlice?: (rootId: number, slice: number) => void | Promise<void>;
  /** After each slice: how many rows it deleted. */
  afterSlice?: (rootId: number, slice: number, rows: number) => void;
}

let reclaimSeams: ReclaimSeams | null = null;

/** Tests only: see into, and hold, every reclaim through `seams`; null restores it as it ships. */
export function setReclaimSeamsForTests(seams: ReclaimSeams | null): void {
  reclaimSeams = seams;
}

/** The reclaim running for each root, and the index it runs in. */
const reclaiming = new Map<number, { handle: Database.Database; done: Promise<void> }>();
/** Every reclaim not yet settled, whichever index it ran in. */
const unsettledReclaims = new Set<Promise<void>>();

/** One root's reclaim: the index it runs in, its next slice's number less one, and its promise with how to settle it. */
interface Reclaim {
  handle: Database.Database;
  rootId: number;
  slices: number;
  seams: ReclaimSeams | null;
  done: Promise<void>;
  settle: () => void;
}

/**
 * Every reclaim not yet finished, oldest first: ONE queue, whatever the
 * number of roots (review of 5 Oct 2026, L-2). Each reclaim looping on its
 * own ran one slice each in the same turn of the event loop — six roots at
 * once, six slices, about 150 ms between two polls at the real slice — so
 * one pump runs one slice a turn, of the oldest, between them all.
 */
const reclaimQueue: Reclaim[] = [];
let reclaimPumping = false;

/**
 * One slice of `job`'s rows — at most INDEX_RECLAIM_ROWS in one statement —
 * and, once nothing is left under it, its root row: last, so `ON DELETE
 * CASCADE` finds nothing to delete. Answers whether the reclaim is over.
 * It is over, quietly, when the index it was given has been closed: the
 * root still reads 'building', and the next open reclaims the rest.
 */
async function reclaimSlice(job: Reclaim): Promise<boolean> {
  const rows = job.seams?.rows ?? INDEX_RECLAIM_ROWS;
  const n = ++job.slices;
  await job.seams?.beforeSlice?.(job.rootId, n);
  if (db !== job.handle) return true;
  // The root it was given, still set aside under its own id — never one
  // that took the id after the whole index was removed under this reclaim.
  // roots.id is AUTOINCREMENT, so an id never comes round today; the reclaim
  // does not rest on that alone (review of 5 Oct 2026, L-5).
  const stillAside = job.handle.prepare('SELECT 1 FROM roots WHERE id = ? AND path = ?').get(job.rootId, `${DISCARD_PREFIX}${String(job.rootId)}`);
  if (stillAside === undefined) return true;
  const { changes } = job.handle
    .prepare('DELETE FROM nodes WHERE rowid IN (SELECT rowid FROM nodes WHERE root_id = ? LIMIT ?)')
    .run(job.rootId, rows);
  job.seams?.afterSlice?.(job.rootId, n, changes);
  if (changes < rows) {
    // Nothing is left under it: the slice took fewer than it asked for.
    job.handle.prepare('DELETE FROM roots WHERE id = ?').run(job.rootId);
    return true;
  }
  return false;
}

/** Runs the queue to its end: a turn of the event loop, then one slice of the oldest reclaim. Never rejects. */
async function pumpReclaims(): Promise<void> {
  reclaimPumping = true;
  try {
    while (reclaimQueue.length > 0) {
      await yieldToLoop();
      const job = reclaimQueue[0];
      let over: boolean;
      try {
        over = await reclaimSlice(job);
      } catch (err) {
        console.error(`[treemap] the rows of an index that was replaced or discarded (root ${String(job.rootId)}) were not all reclaimed; the next build, delete or start reclaims the rest:`, err);
        over = true;
      }
      if (over) {
        reclaimQueue.shift();
        unsettledReclaims.delete(job.done);
        if (reclaiming.get(job.rootId)?.done === job.done) reclaiming.delete(job.rootId);
        job.settle();
      }
    }
  } finally {
    reclaimPumping = false;
  }
}

/**
 * Reclaims root `rootId`'s rows behind the caller, in its turn in the one
 * queue (`pumpReclaims`). Nothing waits on it; a failure is logged, and the
 * root, still 'building' and set aside, is reclaimed by the next build,
 * delete or open (`reclaimLeftovers`).
 */
function reclaimLater(handle: Database.Database, rootId: number): void {
  if (reclaiming.get(rootId)?.handle === handle) return;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  reclaimQueue.push({ handle, rootId, slices: 0, seams: reclaimSeams, done, settle });
  reclaiming.set(rootId, { handle, done });
  unsettledReclaims.add(done);
  trackWrite('index-reclaim', done); // tracked, so `settled()` waits for it; `done` never rejects
  // Tracked too, so `settled()` waits for the pump as for each reclaim; it never rejects.
  if (!reclaimPumping) trackWrite('index-reclaim-pump', pumpReclaims());
}

/**
 * The roots this process's builds are writing, each with the index it
 * writes in, the folder it builds, and whether that folder's index was
 * removed under it (`deleteIndex`): such a build stops at its next look, as
 * a cancelled one does, rather than bring the index back (Track U review
 * L3b, L6).
 */
const activeBuilds = new Map<number, { handle: Database.Database; root: string; aborted: boolean }>();

/**
 * The roots this process's builds could not discard (Track U review L1),
 * each with the index it is in: its own, so a later build or delete may
 * reclaim it though no path says whose it is (an explicit build's root holds
 * the folder's path).
 */
const discardFailed = new Map<number, Database.Database>();

/** The process a capped build's aside path names (`building-aside:<pid>:<seq>:<folder>`), or null. */
function asidePid(rootPath: string): number | null {
  if (!isAside(rootPath) || rootPath.startsWith(DISCARD_PREFIX)) return null;
  const match = /^(\d+):/.exec(rootPath.slice(ASIDE_PREFIX.length));
  const pid = match ? Number(match[1]) : 0;
  return pid > 0 ? pid : null;
}

/** Whether process `pid` is running. EPERM: it is, as someone else. */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether no build anywhere can still be writing root `row` (review of
 * 5 Oct 2026, L-1): it is already set aside for reclaiming, this process
 * could not discard it, or it is a capped build whose process is this one
 * (and none of its builds is writing it) or has ended. Another process's
 * build — a development server beside the app — is none of these until
 * that process ends, whichever folder it builds.
 */
function certainlyLeft(handle: Database.Database, row: { id: number; path: string }): boolean {
  if (row.path.startsWith(DISCARD_PREFIX)) return true;
  if (discardFailed.get(row.id) === handle) return true;
  const pid = asidePid(row.path);
  return pid !== null && (pid === process.pid || !processRunning(pid));
}

/**
 * Sets aside and reclaims the roots left 'building' in `handle` that no
 * build of this process is writing there. At an open (`atOpen`) every one is
 * left: whatever wrote it before the index was opened is not writing it now
 * (the rule since the first index). At the start of a build and in
 * `deleteIndex` — retrying a discard that failed (Track U review L1) — only
 * one `certainlyLeft`: another process may be writing the rest.
 */
function reclaimLeftovers(handle: Database.Database, atOpen: boolean): void {
  const building = handle.prepare("SELECT id, path FROM roots WHERE state = 'building'").all() as { id: number; path: string }[];
  for (const row of building) {
    if (activeBuilds.get(row.id)?.handle === handle) continue;
    if (!atOpen && !certainlyLeft(handle, row)) continue;
    if (!row.path.startsWith(DISCARD_PREFIX)) setAside(handle, row.id);
    discardFailed.delete(row.id);
    reclaimLater(handle, row.id);
  }
}

/** Resolves once no root's rows are being reclaimed (tests; nothing in the app waits on a reclaim). */
export async function reclaimsSettled(): Promise<void> {
  while (unsettledReclaims.size > 0) await Promise.all([...unsettledReclaims]);
}

/** One row of `nodes` as a build writes it, its id chosen by the build (U-D6). */
interface NodeInsert {
  id: number;
  root_id: number;
  parent_id: number | null;
  name: string;
  ext: string;
  is_dir: 0 | 1;
  size: number;
  allocated: number | null;
  mtime: number;
  flags: number;
  ino: number;
  nlink: number;
}

/**
 * Tests only: what a test can see of a build, and where it can hold one
 * (tests/indexBuildBounds.test.ts). Absent, a build runs as it ships.
 */
export interface BuildSeams {
  /** After each write transaction has committed: its number from 1, and its rows. A promise holds the build until it settles. */
  afterWrite?: (transaction: number, rows: number) => void | Promise<void>;
  /** The node ids the build set aside (U-D6): the first, and how many. */
  onReserve?: (base: number, stride: number) => void;
  /** Fewer ids to set aside than the build would, so a walk can pass them. */
  stride?: number;
  /** Once the walk has ended: how many slots each of the build's per-folder columns holds. */
  onFolders?: (slots: number[]) => void;
}

let buildSeams: BuildSeams | null = null;

/** Tests only: see into, and hold, every build through `seams`; null restores the build as it ships. */
export function setBuildSeamsForTests(seams: BuildSeams | null): void {
  buildSeams = seams;
}

/**
 * Sets `stride` node ids aside for one build and returns the first (U-D6).
 *
 * The build writes each row at `base + ordinal`, the entry's number in the
 * walk, so it can name a folder's id before the folder's row exists. Live
 * watchers of other roots insert on the same connection with AUTOINCREMENT
 * while it runs (`applyPendingChanges`, `ensureParents`), and an id they took
 * inside the range would collide with a row the build writes later. Raising
 * `sqlite_sequence` past the range, in the transaction that inserts the
 * build's root, gives every AUTOINCREMENT insert after it an id above the
 * range; the build's own ids, inside it, leave the sequence where it is.
 */
function reserveIds(handle: Database.Database, stride: number): number {
  const row = handle.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'nodes'").get() as { seq: number } | undefined;
  const base = (row?.seq ?? 0) + 1;
  const last = base + stride - 1;
  if (!Number.isSafeInteger(last)) throw new Error('The index has no room left for another build: remove the index, then build it again.');
  if (row) handle.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'nodes'").run(last);
  else handle.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('nodes', ?)").run(last);
  return base;
}

/**
 * What a build keeps for each folder it meets, by rank — the order it met
 * them, which is the walk's order — in typed columns of one slot a folder,
 * and the folders' names. A file is never kept: it is written as it comes,
 * and its bytes are added to its folder's running total here. So what a
 * build holds grows with its folders, not with its entries (plan U-15), and
 * once the walk has ended one pass, deepest first, carries every folder's
 * total into its parent's: no row is read back and none written twice.
 */
class FolderTable {
  length = 0;
  private capacity = 1024;
  private ordinal = new Float64Array(this.capacity);
  private parentRank = new Int32Array(this.capacity);
  private total = new Float64Array(this.capacity);
  /** NaN where the walk could not say (`allocatedSize` null). */
  private allocated = new Float64Array(this.capacity);
  private mtime = new Float64Array(this.capacity);
  private ino = new Float64Array(this.capacity);
  private nlink = new Float64Array(this.capacity);
  private flags = new Uint8Array(this.capacity);
  private readonly names: string[] = [];
  /** The last folder looked up by its number: a folder's entries are handed over together, so most lookups repeat it. */
  private lastOrdinal = -1;
  private lastRank = -1;

  /** Keeps `entry`, a folder, as the next rank. */
  add(entry: RawEntry, flags: number): void {
    if (this.length === this.capacity) this.grow();
    const rank = this.length;
    // The parent is looked up before this folder takes its slot: it was handed over first.
    const parentRank = entry.parentOrdinal < 0 ? -1 : this.rankOf(entry.parentOrdinal);
    this.length++;
    this.ordinal[rank] = entry.ordinal;
    this.parentRank[rank] = parentRank;
    this.total[rank] = 0;
    this.allocated[rank] = entry.allocatedSize ?? Number.NaN;
    this.mtime[rank] = entry.modifiedAt;
    this.ino[rank] = entry.ino;
    this.nlink[rank] = entry.nlink;
    this.flags[rank] = flags;
    this.names.push(entry.name);
  }

  /** Adds `bytes` to the running total of the folder numbered `ordinal`. */
  addBytes(ordinal: number, bytes: number): void {
    this.total[this.rankOf(ordinal)] += bytes;
  }

  /**
   * Carries every folder's total into its parent's, deepest first — a folder
   * always ranks after the folder it is in — and returns the root's total.
   */
  carryTotalsUp(): number {
    for (let rank = this.length - 1; rank > 0; rank--) this.total[this.parentRank[rank]] += this.total[rank];
    return this.total[0];
  }

  /** The row of the folder at `rank`, with its total. */
  row(rank: number, base: number, rootId: number): NodeInsert {
    const parentRank = this.parentRank[rank];
    const allocated = this.allocated[rank];
    return {
      id: base + this.ordinal[rank],
      root_id: rootId,
      parent_id: parentRank < 0 ? null : base + this.ordinal[parentRank],
      name: this.names[rank],
      // Directories have no extension in this language, matching the
      // frontend's `n.type === 'file'` guard.
      ext: '',
      is_dir: 1,
      size: this.total[rank],
      allocated: Number.isNaN(allocated) ? null : allocated,
      mtime: this.mtime[rank],
      flags: this.flags[rank],
      ino: this.ino[rank],
      nlink: this.nlink[rank],
    };
  }

  /** How many slots the columns hold, and how many names: one a folder (tests/indexBuildBounds.test.ts). */
  slots(): number[] {
    return [this.length, this.names.length];
  }

  /** The rank of the folder numbered `ordinal`. Numbers ascend with rank, so a binary search. */
  private rankOf(ordinal: number): number {
    if (ordinal === this.lastOrdinal) return this.lastRank;
    let lo = 0;
    let hi = this.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.ordinal[mid];
      if (at === ordinal) {
        this.lastOrdinal = ordinal;
        this.lastRank = mid;
        return mid;
      }
      if (at < ordinal) lo = mid + 1;
      else hi = mid - 1;
    }
    // The enumerator hands every folder over before anything in it. A row
    // whose folder is unknown would be invisible to every tree read, so a
    // broken walk fails the build loudly instead of quietly shrinking it.
    throw new Error(`index build: the folder numbered ${String(ordinal)} was never handed over`);
  }

  private grow(): void {
    this.capacity *= 2;
    const widen = <T extends Float64Array | Int32Array | Uint8Array>(old: T, make: (n: number) => T): T => {
      const next = make(this.capacity);
      next.set(old);
      return next;
    };
    this.ordinal = widen(this.ordinal, (n) => new Float64Array(n));
    this.parentRank = widen(this.parentRank, (n) => new Int32Array(n));
    this.total = widen(this.total, (n) => new Float64Array(n));
    this.allocated = widen(this.allocated, (n) => new Float64Array(n));
    this.mtime = widen(this.mtime, (n) => new Float64Array(n));
    this.ino = widen(this.ino, (n) => new Float64Array(n));
    this.nlink = widen(this.nlink, (n) => new Float64Array(n));
    this.flags = widen(this.flags, (n) => new Uint8Array(n));
  }
}

/**
 * Build (or rebuild) the index for `root`.
 *
 * The whole point of the state machine: rows land under `state='building'`, and
 * only the final statement flips it to 'ready'. A reader therefore never sees a
 * partial tree as usable (no reader serves a building root, plan U-7), and a
 * crash leaves a row that startup discards.
 *
 * The build walks once (plan U-15). Each file is written as the walk hands it
 * over, at the id it set aside for it (`base + ordinal`, U-D6), and its bytes
 * go to its folder's running total; the folders are written last, each once,
 * with its total. It keeps no map from paths and never reads a row back; it
 * writes at most INDEX_BATCH_ROWS rows a transaction, reports progress after
 * every one, and lets the event loop turn between them.
 */
export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<IndexedRoot> {
  // A rebuild replaces the rows, so the watcher on the old ones goes and a
  // new one attaches when the build is done. On macOS the OS watch underneath
  // is HELD across that rather than closed and reopened: there, closing or
  // opening any watch interrupts every other watch in the process, which
  // would leave every other indexed folder stale (see `onWatchSetChange`
  // below) — and the UI rebuilds a folder's index after every scan of it.
  // Holding is safe there because FSEvents watches a path, not a folder:
  // measured, a held watch kept reporting a folder deleted and made again at
  // the same path (20 of 20). Elsewhere nothing is held and the rebuild
  // reopens the watch as it always did — which also replaces a watch the
  // system dropped without a word (inotify does, for a folder deleted and
  // made again). Changes made during the build still reach no one, exactly
  // as before: the hold hears nothing.
  const releaseHold =
    opts.live !== false && watchers.has(root) && watchesShareOneStream()
      ? holdWatchesOf(watchOwner(root), `index-rebuild:${root}`)
      : null;
  try {
    return await rebuild(root, opts);
  } finally {
    releaseHold?.();
  }
}

/**
 * Refuses, with a sentence, a root the walk could not list — before a build
 * writes anything (Track U review of the index, M-1). The walk itself takes
 * a folder it cannot list for an empty one, so without this an explicit
 * build, which sets the saved index aside in its first transaction (U-D3),
 * traded it for an error (a root that is gone) or for an index of nothing (a
 * folder TreeMap may not list); a capped build swapped the empty one in. The
 * test is the one a scan makes of its root: lstat it, and open it when it is
 * a folder — lstat alone passes for a folder this user may not list.
 */
async function refuseUnwalkable(root: string): Promise<void> {
  try {
    const st = await fsp.lstat(root);
    if (st.isDirectory()) await (await fsp.opendir(root)).close();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const why = meansAbsent(err)
      ? 'there is nothing at that path'
      : code === 'EACCES' || code === 'EPERM'
        ? 'TreeMap is not allowed to open it'
        : `it could not be opened (${code ?? (err instanceof Error ? err.message : String(err))})`;
    throw new Error(`TreeMap could not index ${root}: ${why}. Nothing was changed: its saved index, if it has one, is kept.`);
  }
}

async function rebuild(root: string, opts: BuildOptions): Promise<IndexedRoot> {
  // Before anything is written or set aside.
  await refuseUnwalkable(root);
  const handle = openIndex();
  const provider = platform();
  const seams = buildSeams;

  // A capped build is written aside (`BuildOptions.maxEntries`): the saved
  // root keeps its rows, its watcher and its reason for being stale until
  // this build has finished and is swapped in. An explicit build replaces it
  // up front, as it always has (U-D3: an explicit build is unchanged).
  const aside = opts.maxEntries !== undefined;
  const buildPath = aside ? `${ASIDE_PREFIX}${process.pid}:${++asideSeq}:${root}` : root;

  // A discard that failed before is retried here (Track U review L1), and
  // a capped build whose process has ended is reclaimed; another process's
  // build is left alone (review of 5 Oct 2026, L-1).
  reclaimLeftovers(handle, false);

  // The node ids this build sets aside (U-D6): its cap and one more — the
  // walk stops on the entry past the cap — or 2^32 without one, and never
  // more than 2^32: the route accepts any whole number as a cap, and a cap
  // of 2^53 would leave no room for this build or any after it. A walk that
  // reaches 2^32 entries stops at the stride check below either way.
  const stride =
    seams?.stride ?? (opts.maxEntries !== undefined ? Math.min(opts.maxEntries + 1, UNCAPPED_ID_STRIDE) : UNCAPPED_ID_STRIDE);
  let base = 0;

  // Replace any previous index for this root atomically — or, aside, leave it
  // where it is — and set the build's ids aside in the transaction that
  // inserts its 'building' row.
  // An explicit build sets the saved root aside here, in one statement, and
  // its rows are reclaimed in slices while this build walks (M1).
  const replacedFirst = handle
    .transaction((): number | null => {
      let prior: { id: number } | undefined;
      if (!aside) {
        prior = handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number } | undefined;
        if (prior) setAside(handle, prior.id);
      }
      handle
        .prepare("INSERT INTO roots (path, state, mechanism) VALUES (?, 'building', ?)")
        .run(buildPath, 'readdir + lstat');
      base = reserveIds(handle, stride);
      return prior?.id ?? null;
    })
    .call(null);
  seams?.onReserve?.(base, stride);
  if (!aside) {
    // After the commit, never before it: a build that cannot begin leaves
    // the saved root its watcher and its reason for being stale (L1).
    stopWatcher(root); // a rebuild invalidates any watcher on the old rows
    staleReasons.delete(root); // and whatever made the old rows stale
  }
  if (replacedFirst !== null) {
    rootExclusions.delete(replacedFirst);
    reclaimLater(handle, replacedFirst);
  }

  const rootId = (handle.prepare('SELECT id FROM roots WHERE path = ?').get(buildPath) as { id: number }).id;
  const self = { handle, root, aborted: false };
  activeBuilds.set(rootId, self);
  /** Whether to stop: cancelled by the caller, or the folder's index removed under it. */
  const stopped = (): boolean => self.aborted || (opts.isCancelled?.() ?? false);
  /**
   * Drops what this build wrote: out of every reader's sight at once, its
   * rows reclaimed in slices behind it (M1), the folder's path free for the
   * next build.
   */
  const discard = (): void => {
    // An index closed under the build — a quit: the server cancels every
    // build, then closes the index — is not a failure. The root still reads
    // 'building', and the next open reclaims it, as `reclaimSlice` leaves a
    // closed index (review of 5 Oct 2026, L-3).
    if (db !== handle) return;
    try {
      setAside(handle, rootId);
      reclaimLater(handle, rootId);
    } catch (err) {
      // Left 'building', out of sight wherever it was: the next build, a
      // delete or the next open discards it (L1) — known here as this
      // process's own, whatever its path says (L-1). The build still ends
      // with its own answer — a stop, a cancel, its own failure.
      discardFailed.set(rootId, handle);
      console.error(`[treemap] an index build of ${root} could not be discarded; the next build, delete or start discards it:`, err);
    }
  };

  // Every row is written at `base + ordinal`, its entry's number in the walk,
  // and names its folder the same way: no row is ever read back to learn an
  // id, and nothing maps paths to ids (plan U-15).
  const insert = handle.prepare(
    `INSERT INTO nodes (id, root_id, parent_id, name, ext, is_dir, size, allocated, mtime, flags, ino, nlink)
     VALUES (@id, @root_id, @parent_id, @name, @ext, @is_dir, @size, @allocated, @mtime, @flags, @ino, @nlink)`,
  );
  const insertAll = handle.transaction((rows: NodeInsert[]) => {
    for (const row of rows) insert.run(row);
  });

  /** What the walk leaves out (U-24): the boundary the caller composed, or the fixed list. */
  const leftOut = opts.neverDescend ? new Set(opts.neverDescend) : null;
  /**
   * Files already counted, by device and id (`hardlinkKey`), so a hard link is
   * not double-counted. An id alone is one number on two drives, and a double
   * cannot tell two NTFS ids past 2^53 apart: either would zero a file as
   * another's hard link (the LEFT brief, item 4).
   */
  const seenInodes = new Set<string>();
  /** The folders met so far, each with the running total of what is in it; written last. */
  const folders = new FolderTable();

  /** Entries the walk has handed over (what the cap counts, and what an error reports). */
  let processed = 0;
  /** Rows written so far: what every progress event reports, so the count moves on every write. */
  let written = 0;
  let transactions = 0;
  let fileCount = 0;
  let dirCount = 0;
  /** Files waiting for their write: never more than INDEX_BATCH_ROWS. */
  let files: NodeInsert[] = [];
  let lastPath = root;
  /** The bytes of the walked path when it is itself a file, and so has no folder to sum into. */
  let rootFileBytes = 0;
  /** Set once the walk has passed `opts.maxEntries`: it stops, and the build is discarded. */
  let capped = false;
  /** Set once the build is the folder's index: nothing after that may undo it (Track U review L2). */
  let committed = false;

  /** One write transaction, then its progress event, then a turn of the event loop. */
  const write = async (rows: NodeInsert[], phase: BuildProgress['phase'], currentPath: string): Promise<void> => {
    insertAll(rows);
    written += rows.length;
    transactions++;
    opts.onProgress?.({ phase, processed: written, currentPath });
    await seams?.afterWrite?.(transactions, rows.length);
    await yieldToLoop();
  };

  try {
    for await (const entry of provider.fastEnumerate(root, {
      isCancelled: stopped,
      skip: leftOut ? (p) => leftOut.has(p) : (p) => neverDescend(p),
    })) {
      // One entry more than the build may write: stop the walk here (leaving
      // the loop ends the enumerator) rather than write it.
      if (opts.maxEntries !== undefined && processed >= opts.maxEntries) {
        capped = true;
        break;
      }
      // Every row's id is `base + ordinal`, so an entry without a number of
      // its own (a provider that does not number its walk) would land
      // outside the ids this build set aside, on another build's.
      if (!Number.isInteger(entry.ordinal) || entry.ordinal < 0) {
        throw new Error(`index build: the walk handed over ${entry.path} without a number of its own`);
      }
      if (entry.ordinal >= stride) throw new Error(strideSentence(stride));

      let size = entry.size;
      let flags = 0;
      if (entry.isSymlink) flags |= FLAG.SYMLINK;
      if (entry.name.charCodeAt(0) === 46) flags |= FLAG.HIDDEN;

      // Hard links: count the first name, zero the rest, exactly as the walker
      // does — otherwise a Time Machine-style tree reports several times its
      // real size.
      if (!entry.isDir && !entry.isSymlink && entry.nlink > 1) {
        const key = await hardlinkKey(entry.path, entry);
        if (seenInodes.has(key)) {
          flags |= FLAG.HARDLINK_DUPLICATE;
          size = 0;
        } else {
          seenInodes.add(key);
        }
      }
      // A file claiming bytes it does not occupy is a cloud placeholder.
      if (!entry.isDir && entry.allocatedSize === 0 && entry.size > 0) flags |= FLAG.PLACEHOLDER;

      processed++;
      lastPath = entry.path;
      if (entry.isDir) {
        // Kept, and written once the walk has ended, with its total.
        folders.add(entry, flags);
        dirCount++;
        continue;
      }

      fileCount++;
      if (entry.parentOrdinal < 0) rootFileBytes = size;
      else folders.addBytes(entry.parentOrdinal, size);
      files.push({
        id: base + entry.ordinal,
        root_id: rootId,
        parent_id: entry.parentOrdinal < 0 ? null : base + entry.parentOrdinal,
        name: entry.name,
        ext: extensionOf(entry.name),
        is_dir: 0,
        size,
        allocated: entry.allocatedSize,
        mtime: entry.modifiedAt,
        flags,
        ino: entry.ino,
        nlink: entry.nlink,
      });
      if (files.length >= INDEX_BATCH_ROWS) {
        const batch = files;
        files = [];
        await write(batch, 'enumerating', entry.path);
      }
    }

    if (capped || stopped()) {
      discard();
      if (capped) rememberCapStop(handle, root, opts.maxEntries!);
      throw capped ? new IndexCapReached(opts.maxEntries!) : new Error('cancelled');
    }
    if (files.length > 0) {
      const batch = files;
      files = [];
      await write(batch, 'enumerating', lastPath);
    }
    seams?.onFolders?.(folders.slots());

    // Every folder's total carried into its parent's in one pass, deepest
    // first; then each folder is written once, with its total. The root
    // stays 'building' until the last of them, and no reader serves a
    // building root (plan U-7), so the folders written last are never read
    // as missing.
    const totalSize = folders.length > 0 ? folders.carryTotalsUp() : rootFileBytes;
    for (let start = 0; start < folders.length; start += INDEX_BATCH_ROWS) {
      if (stopped()) {
        discard();
        throw new Error('cancelled');
      }
      const end = Math.min(start + INDEX_BATCH_ROWS, folders.length);
      const batch: NodeInsert[] = [];
      for (let rank = start; rank < end; rank++) batch.push(folders.row(rank, base, rootId));
      await write(batch, 'summing', root);
    }

    // A cancel, or the folder's index removed, that arrived during the last
    // write stops the build here: after this nothing would undo the swap,
    // and a removed index would come back (Track U review L3b).
    if (stopped()) {
      discard();
      throw new Error('cancelled');
    }
    // The swap: in one transaction the saved root is set aside — one
    // statement, no row deleted — and this build takes the folder's path.
    // The saved rows are reclaimed in slices afterwards (M1). For a capped
    // build, until the swap they are the folder's index, untouched (U-Q4);
    // an explicit build set them aside in its first transaction (U-D3).
    const replaced = handle
      .transaction((): number | null => {
        let prior: { id: number } | undefined;
        if (aside) {
          prior = handle.prepare('SELECT id FROM roots WHERE path = ?').get(root) as { id: number } | undefined;
          if (prior) setAside(handle, prior.id);
        }
        handle
          .prepare(
            `UPDATE roots SET path = ?, state = 'ready', built_at = ?, file_count = ?, dir_count = ?, total_size = ?, error = NULL
             WHERE id = ?`,
          )
          .run(root, Date.now(), fileCount, dirCount, totalSize, rootId);
        // A build that finished is the answer to whether the folder fits.
        handle.prepare('DELETE FROM cap_stops WHERE path = ?').run(root);
        return prior?.id ?? null;
      })
      .call(null);
    committed = true;
    if (aside) {
      // The saved root's watcher goes once the swap has committed, never
      // before: a swap that fails leaves the saved root its watcher and its
      // reason for being stale (L1). On macOS its OS watch is held across
      // this by `buildIndex`, and handed to the watcher started below.
      stopWatcher(root);
      staleReasons.delete(root);
    }
    if (replaced !== null) {
      rootExclusions.delete(replaced);
      reclaimLater(handle, replaced);
    }
    // What this index leaves out, for its watcher, whenever it is started.
    rootExclusions.set(rootId, exclusionsUnder(root, opts.neverDescend));

    opts.onProgress?.({ phase: 'done', processed: written, currentPath: root });
    if (opts.live !== false) startWatcher(root);
    return getRoot(root)!;
  } catch (err) {
    // Committed, this build is the folder's index: a throw after that (the
    // caller's own progress handler, say) must not discard it (L2).
    if (committed) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message !== 'cancelled' && !(err instanceof IndexCapReached)) {
      if (aside) {
        // Nothing half-written is kept, and the saved index stays the
        // folder's. A database that has gone away (closed under the build, a
        // process ending) leaves the row 'building', which the next open
        // discards; `discard` logs any failure.
        discard();
      } else {
        handle.prepare("UPDATE roots SET state = 'error', error = ? WHERE id = ?").run(message, rootId);
      }
    }
    // How far the walk got: an error is reported in entries, not rows.
    opts.onProgress?.({ phase: 'error', processed, currentPath: root });
    throw err;
  } finally {
    activeBuilds.delete(rootId);
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

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function listRoots(): IndexedRoot[] {
  const handle = openIndex();
  const rows = handle.prepare('SELECT * FROM roots ORDER BY path').all() as Record<string, unknown>[];
  // A capped build still being written aside is no folder's index yet.
  return rows.filter((row) => !isAside(String(row.path))).map(toIndexedRoot);
}

export function getRoot(rootPath: string): IndexedRoot | null {
  const handle = openIndex();
  const row = handle.prepare('SELECT * FROM roots WHERE path = ?').get(rootPath) as Record<string, unknown> | undefined;
  return row ? toIndexedRoot(row) : null;
}

function toIndexedRoot(row: Record<string, unknown>): IndexedRoot {
  const rootPath = String(row.path);
  const state = String(row.state) as IndexState;
  return {
    id: Number(row.id),
    path: rootPath,
    state,
    builtAt: row.built_at === null ? null : Number(row.built_at),
    fileCount: Number(row.file_count),
    dirCount: Number(row.dir_count),
    totalSize: Number(row.total_size),
    mechanism: String(row.mechanism),
    live: watchers.has(rootPath),
    ...(state === 'stale' ? { staleReason: staleReasons.get(rootPath) ?? STALE_REASON.notWatchedWhileClosed } : {}),
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

  // A build of what is removed stops at its next look instead of bringing
  // it back, whoever removes it (L3b, L6). Its rows — gone here, or written
  // aside — are discarded with it.
  for (const build of activeBuilds.values()) {
    if (build.handle === handle && (rootPath === undefined || build.root === rootPath)) build.aborted = true;
  }

  if (rootPath === undefined) {
    stopAllWatchers();
    staleReasons.clear();
    rootExclusions.clear();
    // The folders' indexes: never a build written aside, nor a root set
    // aside while its rows are reclaimed (Track U review L6).
    removed = (
      handle.prepare('SELECT COUNT(*) c FROM roots WHERE path < ? OR path >= ?').get(ASIDE_PREFIX, ASIDE_PREFIX_END) as { c: number }
    ).c;
    handle.prepare('DELETE FROM nodes').run();
    handle.prepare('DELETE FROM roots').run();
    handle.prepare('DELETE FROM cap_stops').run();
    // No row is left, so no id is in use: the next build sets its ids aside
    // from 1 again (U-D6). This is what makes the sentence a build with no
    // room left ends with — "remove the index, then build it again" — true.
    handle.prepare("DELETE FROM sqlite_sequence WHERE name = 'nodes'").run();
  } else {
    stopWatcher(rootPath);
    staleReasons.delete(rootPath);
    // Deleting a folder's index starts it afresh: its next scan may build again.
    handle.prepare('DELETE FROM cap_stops WHERE path = ?').run(rootPath);
    // A discard that failed before is retried here too (L1), behind the delete.
    reclaimLeftovers(handle, false);
    const row = handle.prepare('SELECT id FROM roots WHERE path = ?').get(rootPath) as { id: number } | undefined;
    if (!row) return 0;
    rootExclusions.delete(row.id);
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
 * Whether `root`'s index holds `absPath` as a link (final review F1.4). The
 * index records a link as the one entry it is and never follows it (M-1),
 * while a scan of a link to a folder walks the folder it points to (D78), so
 * such a row is never a folder the index can show for that path: served, the
 * instant paint was a one-tile map of the link's own bytes. The root's own
 * row counts too — the one-row index a build of a link's own path makes.
 */
export function indexedAsLink(root: Pick<IndexedRoot, 'id' | 'path'>, absPath: string): boolean {
  const id = findNodeIdByPath(root.id, root.path, absPath);
  if (id === null) return false;
  const row = openIndex().prepare('SELECT flags FROM nodes WHERE id = ?').get(id) as { flags: number } | undefined;
  return row !== undefined && (row.flags & FLAG.SYMLINK) !== 0;
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

/**
 * The paths beneath its folder each index leaves out (Track U, U-24), by
 * its root's id — the index, not the folder: a later build of the folder is
 * another index — set by the build that made it in this process. Its
 * watcher drops a change at or under one, as Live mode does for a scan
 * (`watcher.ts`), so a drive the build did not enter never comes into the
 * index through its watcher.
 */
const rootExclusions = new Map<number, readonly string[]>();

/**
 * What an index of `rootPath` leaves out beneath it: `exclusionsOf`, the scanned-root rule's own reading, over
 * the list its build was handed, else the fixed list — so a root on macOS's Data volume also leaves out the fixed
 * folders as that volume spells them, whatever the list (the SEC-1 review's notes: a private copy of the filter
 * read the list alone).
 */
function exclusionsUnder(rootPath: string, list: readonly string[] | undefined): string[] {
  return exclusionsOf(list === undefined ? undefined : { neverDescend: [...list], fixed: neverDescendPaths() }, rootPath);
}

/** How a root's watcher is named in the watch registry, so its own watches can be told from the rest. */
function watchOwner(rootPath: string): string {
  return `index:${rootPath}`;
}

/**
 * Why each root this process marked stale is stale — the cause that took it
 * from 'ready', until a rebuild takes it back. Not stored: a root that is stale
 * when the index is opened is stale because nothing watched it while TreeMap
 * was closed, whatever made it stale before.
 */
const staleReasons = new Map<string, string>();

/**
 * Changes are applied in bursts: a build writes thousands of events at once.
 * Exported for tests/indexEngine.test.ts, which holds it to §A1's two seconds
 * by count: one change, one flush, this long after it.
 */
export const FLUSH_MS = 400;

/**
 * What a flush timer is set and cleared with: the real clock, unless a test
 * brings its own to count the flushes a change schedules and the delay of
 * each (tests/indexEngine.test.ts) — the part of §A1's latency the engine
 * controls, counted instead of timed.
 */
export interface FlushTimers {
  set: (flush: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_FLUSH_TIMERS: FlushTimers = {
  set: (flush, ms) => setTimeout(flush, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

let flushClock: FlushTimers = REAL_FLUSH_TIMERS;

/** Tests only: set and clear flush timers through `timers`; null restores the real clock. */
export function setFlushTimersForTests(timers: FlushTimers | null): void {
  flushClock = timers ?? REAL_FLUSH_TIMERS;
}

/**
 * Is `p` the app's own state — the index database and its write-ahead log,
 * settings, snapshots, thumbnails?
 *
 * On macOS the app-data directory lives under the user's home, and the home
 * folder is the root most people scan. Without this the live index reacted
 * to itself: every flush wrote the WAL, the watcher reported the WAL, the
 * next flush applied that "change" and wrote the WAL again — for ever, at
 * the flush cadence, each turn re-rolling the root. Measured on the owner's
 * machine as 20–60% CPU in the main process with the window closed,
 * eighteen minutes after the last scan. The files stay in the index at
 * their build-time sizes; they are the one thing the index is allowed to be
 * stale about, because it is the thing changing them.
 *
 * Case-folded off Linux: the directory on disk may be `treemap` (Electron's
 * userData, created first) while `appDataDir()` says `TreeMap`, and on a
 * case-insensitive volume those are one directory.
 */
function isOwnState(p: string): boolean {
  const own = appDataDir();
  const fold = (s: string): string => (process.platform === 'linux' ? s : s.toLowerCase());
  const prefix = fold(own.endsWith(path.sep) ? own : own + path.sep);
  const target = fold(p);
  return target === fold(own) || target.startsWith(prefix);
}

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

/**
 * A directory's own `lstat` could not be resolved — the one failure inside
 * `ensureParents` that is worth retrying.
 *
 * Tagged rather than sniffed. The first version of this check asked whether
 * the error carried a string `code`, on the reasoning that a filesystem errno
 * has one and a database fault does not. Measured against the driver, that is
 * backwards: `SqliteError` ALWAYS carries a code (`SQLITE_FULL`,
 * `SQLITE_BUSY`, `SQLITE_CORRUPT`), so disk-full and corruption were retried
 * five times and then reported as index staleness — a wrong diagnosis of a
 * condition that will not clear — while the one error it did rethrow was the
 * code-less `TypeError: The database connection is not open`.
 */
class UnresolvedParentError extends Error {
  constructor(cause: unknown) {
    super('a parent directory could not be resolved', { cause });
    this.name = 'UnresolvedParentError';
  }
}

const pendingByRoot = new Map<string, Map<string, PendingChange>>();
const flushTimers = new Map<string, unknown>();

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

// Registered once, at the PROVIDER's OS callback rather than at this module's
// subscriber. The difference decides what a missed update means: counting
// downstream would let a regression inside `subscribeToChanges` itself — a
// swallowed event, a mis-joined path — report zero, and the acceptance test
// that reads this would skip green on a real bug.
onWatchDelivery((root) => {
  if (!watchers.has(root)) return; // a late callback must not resurrect an entry
  eventsSeenByRoot.set(root, (eventsSeenByRoot.get(root) ?? 0) + 1);
});

/**
 * The process's set of OS watches changed. On macOS that alone can cost a
 * live root a change while its own watcher stays attached and healthy: every
 * watch in the process shares one FSEventStream, rebuilt "since now" whenever
 * any watch attaches or closes, and a change made during the rebuild is
 * reported to nobody (watchRegistry.ts has the mechanism and the numbers).
 * There is no sequence number to replay from, so the only honest answer is
 * the one in the "Drift" note above: every OTHER live root can no longer be
 * vouched for, and says so.
 *
 * A root's own watch attaching or closing is its own lifecycle. Closing is
 * what `live: false` already reports. Attaching is where its watch begins:
 * a new watch is not live the instant it attaches, and a change in that
 * first moment belongs to the same gap every build has between reading a
 * folder and watching it — not to an interruption of a watch that was
 * running. The system ENDING its own watch is another matter, on every
 * platform: nothing will be reported for that root again.
 *
 * Nothing is rebuilt automatically. A rebuild is a full walk, and the churn
 * that remains is rare: on macOS the index hands a root's watch over across
 * its own rebuilds (`buildIndex`), and Live mode shares the index's watch of
 * a folder (the registry keeps one OS watch per folder and kind, and on
 * macOS both watch a folder with one recursive watch), so what is left is a
 * folder being watched for the first time, or no longer at all. The UI
 * rebuilds every indexed folder it opens (a scan runs behind every
 * index-first paint), which is what brings a stale root back.
 */
onWatchSetChange((change) => {
  if (!db) return;
  for (const rootPath of [...watchers.keys()]) {
    if (change.owners.includes(watchOwner(rootPath))) {
      if (change.kind === 'errored' && change.path === rootPath) {
        markStaleByPath(rootPath, STALE_REASON.watchEnded);
        stopWatcher(rootPath); // `live` must stop claiming a watch that is gone
      }
      continue;
    }
    if (watchesShareOneStream()) markStaleByPath(rootPath, STALE_REASON.sharedStream);
  }
});

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
/** The backoff level a root's pending flush was scheduled at. */
const flushLevels = new Map<string, number>();

function scheduleFlush(rootPath: string, attempts = 0): void {
  // Capped at 4x. The backoff exists to relieve pressure, not to make the
  // index slow to notice things: doubling all the way to the attempt limit
  // would put the last retry twelve seconds after the change, which is well
  // outside what "live" should mean. 400, 800, then 1,600 ms three times —
  // about six seconds of patience in total.
  const level = Math.min(attempts, 2);
  if (flushTimers.has(rootPath)) {
    // A pending flush at a LOWER level does not hold. Returning early here is
    // what made the backoff a no-op in the scenario it was written for: under
    // EMFILE a fresh watcher event arrives with `attempts: 0`, asks for
    // 400 ms, wins, and every subsequent retry early-returns onto it. The
    // timer is replaced rather than a scan of the queue being run per event —
    // that scan cost 756 ms of blocked event loop on a 20,000-event burst,
    // inside the `fs.watch` callback.
    if ((flushLevels.get(rootPath) ?? 0) >= level) return;
    flushClock.clear(flushTimers.get(rootPath));
  }
  const delay = FLUSH_MS * Math.pow(2, level);
  flushLevels.set(rootPath, level);
  flushTimers.set(
    rootPath,
    flushClock.set(() => {
      flushLevels.delete(rootPath);
      flushTimers.delete(rootPath);
      // Caught here, and it has to be: this is a bare timer callback, so a
      // rejection has nobody above it. `applyPendingChanges` can now throw —
      // a database fault propagates by design — and there is no
      // `unhandledRejection` handler outside the packaged Electron build, so
      // under `npm start` or the MCP server that would take the process down.
      // The burst is lost, which the staleness guard already covers; the
      // process is not.
      trackWrite('applyPendingChanges', applyPendingChanges(rootPath).catch((err: unknown) => {
        // The queue is taken and deleted before any work, so a throw from
        // inside the burst loses every remaining change. The comment here
        // used to say "the staleness guard already covers it" — nothing did:
        // `retryOrMarkStale` is never reached on that path, so a `SQLITE_FULL`
        // would evaporate into one log line while the index went on
        // reporting itself fresh. Marking it here is what makes the claim in
        // that sentence true.
        const root = getRoot(rootPath);
        if (root) markRootStale(rootPath, root.id, root.builtAt, STALE_REASON.unwritableChange);
        console.error(`[treemap] index flush failed for ${rootPath}, root marked stale:`, err);
      }));
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
  const attempts = Math.max(change.attempts, prior ? prior.attempts : 0);
  queue.set(change.path, { ...change, attempts });
  // The merged count for THIS path only. Scanning the whole queue for the
  // worst was O(n^2) across a burst — measured at 756 ms of blocked event
  // loop for 20,000 events, synchronously inside the `fs.watch` callback,
  // which is every HTTP response and SSE heartbeat stalled for that long.
  // `scheduleFlush` now raises an existing timer's delay instead, which is
  // O(1) and is what actually makes the backoff hold.
  scheduleFlush(rootPath, attempts);
}

/**
 * Whether an index whose top row is `row` is one file — a file, or a link
 * (never followed, M-1). It holds nothing a watch could add to, and a watch
 * on a link reports the folder it points at, whose changes would be written
 * under a row that is no folder.
 */
function indexedAsLeaf(row: { is_dir: number | null } | undefined): boolean {
  return row !== undefined && row.is_dir !== null && row.is_dir !== 1;
}

/**
 * Attach a live watcher to the index of `rootPath`. A change at or under a
 * path its build left out is dropped (U-24): the build's own list when this
 * process built the index, else `neverDescendList` — the route's reading of
 * the boundary for an index an earlier process built — else the fixed list.
 */
export function startWatcher(rootPath: string, neverDescendList?: readonly string[]): boolean {
  if (watchers.has(rootPath)) return true;
  const row = openIndex()
    .prepare('SELECT r.id, n.is_dir FROM roots r LEFT JOIN nodes n ON n.root_id = r.id AND n.parent_id IS NULL WHERE r.path = ?')
    .get(rootPath) as { id: number; is_dir: number | null } | undefined;
  if (indexedAsLeaf(row)) return false;
  const excluded = (row ? rootExclusions.get(row.id) : undefined) ?? exclusionsUnder(rootPath, neverDescendList);
  try {
    const unsubscribe = platform().subscribeToChanges(
      rootPath,
      (event) => {
        if (isOwnState(event.path)) return; // the index must never chase its own writes
        if (excluded.some((x) => isAtOrUnder(x, event.path))) return; // another drive, or a folder the build left out
        enqueueChange(rootPath, { path: event.path, kind: event.kind, attempts: 0 });
      },
      watchOwner(rootPath),
    );
    // Set only once the watch is established. Setting it before
    // `subscribeToChanges` leaked an entry for every root whose watch failed,
    // because `stopAllWatchers` iterates `watchers`, which never held it.
    watchers.set(rootPath, unsubscribe);
    eventsSeenByRoot.set(rootPath, 0);
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
  markRootStale(rootPath, rootId, builtAt, STALE_REASON.unreadableChange);
  return false;
}

/**
 * Record that this root may have missed a change.
 *
 * `built_at` is part of the predicate, not decoration. `rootId` is read before
 * a burst's awaits, and `buildIndex` DELETEs the roots row and INSERTs a new
 * one — SQLite reuses a rowid when the deleted row held the maximum — so a
 * flush still in flight when a rebuild finishes could mark a freshly rebuilt
 * index stale, and `AND state = 'ready'` would not stop it because a rebuilt
 * root is exactly that.
 */
function markRootStale(rootPath: string, rootId: number, builtAt: number | null, reason: string): void {
  if (!db || builtAt === null) return;
  try {
    const { changes } = db
      .prepare("UPDATE roots SET state = 'stale' WHERE id = ? AND built_at = ? AND state = 'ready'")
      .run(rootId, builtAt);
    // Only the cause that took it from 'ready' is its reason: a root already
    // stale keeps the one it has.
    if (changes > 0) staleReasons.set(rootPath, reason);
  } catch (err) {
    // A database that has gone away is marked stale on the next open anyway;
    // one that refused the write (busy, full) leaves the root saying 'ready',
    // and that must at least be on record.
    console.error(`[treemap] could not mark ${rootPath} stale (${reason}):`, err);
  }
}

/**
 * The "Stay on this drive" rule changed (final review F1.5). An index built
 * under the other rule leaves out a drive mounted inside its folder that a
 * scan now walks, or holds one a scan now leaves out, and nothing records
 * which rule it was built under: so every ready root — or only
 * `rootPath`'s — is marked stale with that reason, and the page's next scan
 * of the folder rebuilds it under the rule it has now. An index not open in
 * this process needs nothing: every root is stale when it is opened.
 */
export function markBoundaryChanged(rootPath?: string): void {
  if (!db) return;
  try {
    const rows = (rootPath === undefined
      ? db.prepare("SELECT id, path, built_at FROM roots WHERE state = 'ready'").all()
      : db.prepare("SELECT id, path, built_at FROM roots WHERE state = 'ready' AND path = ?").all(rootPath)) as Array<{ id: number; path: string; built_at: number | null }>;
    for (const row of rows) markRootStale(row.path, row.id, row.built_at, STALE_REASON.boundaryChanged);
  } catch (err) {
    console.error('[treemap] could not mark the saved indexes stale after "Stay on this drive" changed:', err);
  }
}

/** `markRootStale` for a root known only by its path — the watch-set listener's case. */
function markStaleByPath(rootPath: string, reason: string): void {
  if (!db) return;
  try {
    const row = db.prepare('SELECT id, built_at FROM roots WHERE path = ?').get(rootPath) as
      | { id: number; built_at: number | null }
      | undefined;
    if (row) markRootStale(rootPath, row.id, row.built_at, reason);
  } catch (err) {
    console.error(`[treemap] could not mark ${rootPath} stale (${reason}):`, err);
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
  if (flushTimers.has(rootPath)) {
    flushClock.clear(flushTimers.get(rootPath));
    flushTimers.delete(rootPath);
  }
  flushLevels.delete(rootPath);
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
  /* How many file and directory rows this burst adds or removes. The root's
     counts are kept by delta, not by re-counting: a `SUM(is_dir)` over the
     whole root ran once per flush, and on a million-row index that was the
     idle CPU the owner measured — O(table) for a single log file growing. */
  const delta = { files: 0, dirs: 0 };

  // Deleting a directory takes its whole subtree with it. v3 stores no
  // paths, so "the subtree" is the id closure of the node — which also makes
  // the old LIKE-wildcard escaping hazard structurally impossible. RETURNING
  // hands back what went, so the counts can move by exactly that much.
  const deleteSubtree = handle.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT ?
       UNION ALL
       SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
     )
     DELETE FROM nodes WHERE id IN (SELECT id FROM sub) RETURNING is_dir`,
  );
  const removeSubtree = (nodeId: number): void => {
    for (const row of deleteSubtree.all(nodeId) as { is_dir: number }[]) {
      if (row.is_dir) delta.dirs--;
      else delta.files--;
    }
  };
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
      // `meansAbsent`, not `meansGone`. `errno.ts` states the rule — the
      // narrow set wherever the answer decides whether stored state may be
      // discarded — and this is the site in this file that runs
      // `deleteSubtree`. It was the one place the rule was written for and
      // not applied to. The "retry loop that never clears" justification for
      // the wider set does not hold here either: this path is bounded by
      // MAX_CHANGE_ATTEMPTS, after which the root is marked stale, and stale
      // is the right answer for a path that cannot be resolved. Deleting its
      // subtree from the index is not.
      if (meansAbsent(err)) stat = null;
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
        removeSubtree(nodeId);
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
          removeSubtree(nodeId);
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
          parentId = await ensureParents(handle, root.id, rootPath, path.dirname(change.path), delta);
        } catch (err) {
          // Only the tagged case is retried. `ensureParents` also runs SQL and
          // recurses, so a database fault reaches here too and must propagate
          // rather than be re-asked five times and relabelled as staleness.
          if (!(err instanceof UnresolvedParentError)) throw err;
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
          if (isDir) delta.dirs++;
          else delta.files++;
          applied++;
        }
      }
    }
    touchedParents.add(path.dirname(change.path));
  }

  if (applied > 0 && stillOpen()) resumAncestors(handle, root.id, rootPath, touchedParents, delta);
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
  made: { dirs: number },
): Promise<number | null> {
  const known = findNodeIdByPath(rootId, rootPath, dirPath);
  if (known !== null) return known;
  // The root's own node missing is a rebuild problem, not a watcher one.
  if (dirPath === rootPath) return null;
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (!dirPath.startsWith(prefix)) return null;

  const parentId = await ensureParents(handle, rootId, rootPath, path.dirname(dirPath), made);
  if (parentId === null) return null;

  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(dirPath);
  } catch (err) {
    // Vanished again already — nothing to hang the child on.
    if (meansGone(err)) return null;
    // Anything else is undecidable, and returning null here would report
    // "there is no such directory" on the strength of a descriptor shortage.
    // Tagged so the caller can retry THIS and nothing else.
    throw new UnresolvedParentError(err);
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
  made.dirs++;
  return Number(info.lastInsertRowid);
}


/**
 * Re-sum only the directories on the path from each touched folder to the root.
 *
 * The alternative — re-running the whole roll-up — is O(tree) per change burst,
 * which on a multi-million-file root turns a single file write into seconds of
 * work. The root's file and directory counts move by the burst's `delta` for
 * the same reason: a fresh `SUM(is_dir)` over the root is a full table walk,
 * and this runs up to twice a second while anything under the root changes.
 */
function resumAncestors(
  handle: Database.Database,
  rootId: number,
  rootPath: string,
  touched: Set<string>,
  delta: { files: number; dirs: number },
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
    handle
      .prepare('UPDATE roots SET total_size = ?, file_count = file_count + ?, dir_count = dir_count + ? WHERE id = ?')
      .run(rootSize?.size ?? 0, delta.files, delta.dirs, rootId);
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

  // Never a row of a capped build still being written aside: it is no
  // folder's index yet, and its rows would be found twice beside the saved
  // index's, under a path no folder has. The prefix is matched as a range,
  // so SQLite seeks it in the unique index on roots.path instead of scanning
  // the roots table: every path that starts with ASIDE_PREFIX sorts at or
  // after it, and before ASIDE_PREFIX_END.
  //
  // And only rows of the roots this search reports: 'ready' or 'stale',
  // never one still being built or one whose build failed (plan U-7, U-D5).
  // A building root's rows are the part of a walk written so far, its
  // folders not yet summed; found and counted, they read as an answer. The
  // filter sits in the shared clause, so the count of a full page leaves
  // them out as well as the page. The unary `+` keeps the term out of
  // SQLite's choice of index: without it the list of ids drives a walk of
  // `idx_nodes_size` root by root instead of the plans tests/indexSearch.test.ts
  // pins (the extension seek, the one scan of the nodes).
  const where: string[] = [
    'n.root_id NOT IN (SELECT id FROM roots WHERE path >= ? AND path < ?)',
    `+n.root_id IN (${roots.map(() => '?').join(', ')})`,
  ];
  const params: (string | number)[] = [ASIDE_PREFIX, ASIDE_PREFIX_END, ...roots.map((r) => r.id)];

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
