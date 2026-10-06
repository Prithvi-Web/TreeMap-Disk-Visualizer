import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { underTestRunner } from './realMachineGuard';
import { isAtOrUnder, readMountTable, type MountTable } from '../utils/mountBoundaries';

/**
 * Is this folder still empty on disk? (Track U, U-4.)
 *
 * Empty Folders offers what a scan saw empty, and the scan's own records keep
 * out every folder it knows it did not list in full (`Flag.Unlisted`). What no
 * record can know is looked at here: the native memory path counts the folders
 * it could not read without naming them, a fast rescan takes a listing from its
 * cache, and anything can change between the scan and the click. So every
 * folder the answer offers is looked at once more, and every folder an
 * "only empty folders" delete is handed is looked at right before its own
 * Trash step.
 *
 * Empty means what Empty Folders means: nothing anywhere below the folder but
 * other folders and, with the junk rule, OS junk files (`.DS_Store` and kin). A
 * link is never followed: the folder itself must be a folder, and a link inside
 * it is content. Whatever cannot be shown empty is not empty — a folder that
 * refuses, does not answer within `EMPTY_CHECK_DEADLINE_MS`, or holds more than
 * `EMPTY_CHECK_MAX_ENTRIES` entries to look through — each with its reason in a
 * sentence.
 *
 * **A drive that does not answer (U-4b M1).** A stat on a dead network mount
 * never returns, and the race below only stops waiting for it: the call keeps a
 * thread of libuv's small I/O pool for as long as it hangs. So looks are made in
 * sessions — one per request (`emptyCheckSession`) — under three rules:
 *  - **Silence is remembered per folder and per drive (U-4c M1 / M-A).** A
 *    stat or listing that misses its deadline makes its folder silent until
 *    that call answers, and the root of the drive that folder is on is asked,
 *    with a deadline of its own: a root that misses too makes the drive silent
 *    until the root answers. While silent, no look anywhere — this request, a
 *    later one, the delete after the list — touches the folder or the drive;
 *    each answers "did not answer" at once. So one slow folder on a drive that
 *    answers is withheld alone, a dead mount nested in a folder silences its
 *    own drive and not the folder's, and a call that never settles holds only
 *    its folder. A call that answers at last lifts its silence (a spun-down
 *    disk woke); one that fails with the drive's own error (EIO, ESTALE, …)
 *    keeps it for `SILENT_DRIVE_MEMORY_MS`, while any other failure is an
 *    answer. A drive is told by the mount table (`driveFor`), as the scan's
 *    boundary is, never by a stat — a stat is what hangs. Its root is asked by
 *    one call at a time: a call that misses its deadline while the root is
 *    being asked waits for that answer.
 *  - **A drive holds at most `MAX_HELD_PER_DRIVE` calls that did not answer
 *    (the U-4c review, F1.1).** Each holds a thread of the pool. A drive with
 *    two of its calls still out — two slow folders, or a folder and its root —
 *    is silent until one of them answers, though its root answers: else a mount
 *    whose root answers while every folder below hangs would take one thread
 *    per folder asked, every request, until the pool was full.
 *  - **The first look on a drive goes alone, and so does every look on a
 *    drive with a call out.** Within a session, looks on a drive not yet heard
 *    from wait for that drive's first look to answer — or to go silent —
 *    before they start: one probe, not four at once. Across sessions, while
 *    one of a drive's calls is out unanswered, its looks go one at a time, so
 *    the next call to hang is the last one it holds.
 *  - **A session looks for `EMPTY_CHECK_BUDGET_MS` at most**, counting only
 *    while a look is running (a delete's Trash steps between its looks are not
 *    looking). A folder whose look the budget cut, or that came after it ran
 *    out, did not answer in time.
 * Imports nothing that imports the Trash pathway, so `cleaner.ts` can use it.
 */

/** Junk files that don't stop a folder from counting as empty. */
export const JUNK_FILES: ReadonlySet<string> = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);

/** How long one stat or listing may take before the folder is taken as not answering. */
export const EMPTY_CHECK_DEADLINE_MS = 2_000;

/**
 * The same wait under a test runner (U-4b L6): the tests' hang guard. Their
 * looks read real temp folders, and a loaded runner has stalled for 6.6 s
 * (Windows CI) — a folder must not read as a drive that went silent because
 * the machine running the test paused. A test of the deadline sets its own
 * (`deadlineMs`, or `deadline`).
 */
export const TEST_RUNNER_DEADLINE_MS = 120_000;

/** How long a look waits for a stat or a listing here: 2 s, or the hang guard under a test runner. */
export function lookDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return underTestRunner(env) ? TEST_RUNNER_DEADLINE_MS : EMPTY_CHECK_DEADLINE_MS;
}

/** The most time the looks of one request may spend looking, together (U-4b M1). */
export const EMPTY_CHECK_BUDGET_MS = 10_000;

/**
 * The same budget under a test runner: `npm test`'s own limit for one test
 * (`--test-timeout=1200000`), well past the hang guard, so a test's look waits
 * its deadline and is never cut by a budget the runner's pauses ate.
 */
export const TEST_RUNNER_BUDGET_MS = 1_200_000;

/** How long a session may look here: 10 s, or npm test's per-test limit under a test runner. */
export function lookBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return underTestRunner(env) ? TEST_RUNNER_BUDGET_MS : EMPTY_CHECK_BUDGET_MS;
}

/** How long a drive stays silent after a call that went silent on it answers with a failure. */
export const SILENT_DRIVE_MEMORY_MS = 60_000;

/**
 * The most calls on one drive that missed their deadline and are still out
 * (the U-4c review, F1.1): at this many the drive is silent until one answers.
 */
export const MAX_HELD_PER_DRIVE = 2;

/** The most entries one look goes through, nested folders' included, before it stops short of proving a folder empty. */
export const EMPTY_CHECK_MAX_ENTRIES = 1_000;

/** Why a folder is not shown to be empty. */
export type NotEmptyWhy = 'content' | 'unreadable' | 'no-answer' | 'out-of-time' | 'too-many' | 'not-a-folder' | 'gone';

export type EmptyVerdict = { empty: true } | { empty: false; why: NotEmptyWhy; reason: string };

/**
 * The code an "only empty folders" delete refuses a folder with, by why the
 * look could not show it empty (U-4b L4) — each its own, so a caller can tell
 * a folder that holds something from one nobody could read or that did not
 * answer — or that TreeMap's own time for looking ran out on (`out-of-time`,
 * the U-4b review's L-5: no drive is to blame for that). A folder that is gone
 * is not refused: it fails as gone.
 */
export const NOT_EMPTY_CODES = {
  content: 'FOLDER_NOT_EMPTY',
  unreadable: 'FOLDER_UNREADABLE',
  'no-answer': 'FOLDER_NO_ANSWER',
  'out-of-time': 'FOLDER_NOT_CHECKED',
  'too-many': 'FOLDER_TOO_MANY_ENTRIES',
  'not-a-folder': 'NOT_A_FOLDER',
} as const satisfies Record<Exclude<NotEmptyWhy, 'gone'>, string>;

export type NotEmptyCode = (typeof NOT_EMPTY_CODES)[keyof typeof NOT_EMPTY_CODES];

const NOT_EMPTY_CODE_SET: ReadonlySet<string> = new Set(Object.values(NOT_EMPTY_CODES));

/** Is `code` one an "only empty folders" look refuses with? */
export function isNotEmptyCode(code: string | undefined): code is NotEmptyCode {
  return code !== undefined && NOT_EMPTY_CODE_SET.has(code);
}

/** An open folder, read an entry at a time: `fs.Dir`'s shape. */
export interface FolderListing {
  read(): Promise<Dirent | null>;
  close(): Promise<void>;
}

/** What a look reads the disk and the clock with; a test replaces any of them (`setEmptyCheckForTests`). */
export interface EmptyCheckDeps {
  lstat: (p: string) => Promise<{ isDirectory(): boolean }>;
  /**
   * A folder's listing, read an entry at a time (U-4b L5): the look reads only
   * as far as it needs — the first file, or one entry past `maxEntries`. On a
   * file system whose listings name each entry's type the disk is read that
   * far too (an `fs.Dir`). Elsewhere (`openListing`: a NAS, exFAT, an overlay,
   * a mount table that could not be read) the folder is read whole first, one
   * `readdir` on the I/O pool, and only the looking stops early: the cost of
   * keeping every stat off the event loop (U-4c L1; the U-4c review, F1.9).
   */
  opendir: (p: string) => Promise<FolderListing>;
  /** A deadline of `ms`: `late` settles when it passes; `cancel` lets it go once the answer came. */
  deadline: (ms: number) => { late: Promise<void>; cancel: () => void };
  /** How long one stat or listing may take (`lookDeadlineMs`). */
  deadlineMs: number;
  /** How long one session may spend looking (`lookBudgetMs`). */
  budgetMs: number;
  /** The clock the budget and a drive's silence are measured on. */
  now: () => number;
  /** Which drive a path is on (`driveFor`): looks on one drive share its silence. */
  driveOf: (p: string) => Promise<string>;
  maxEntries: number;
}

function realDeadline(ms: number): { late: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return { late, cancel: () => clearTimeout(timer) };
}

/**
 * Which drive `p` is on, by its spelling (U-4b M1): the deepest mount point the
 * table lists at or above it, or `/` when none does or the table could not be
 * read; on Windows, the drive or share the path names. Two folders on one drive
 * may get two names (a firmlink's two spellings) — they then go silent apart,
 * no worse than before — and two drives the table does not tell apart share
 * one, which only withholds more.
 */
export function driveFor(p: string, mountPoints: readonly string[] | null, platform: NodeJS.Platform): string {
  if (platform === 'win32') return windowsDriveKey(p);
  let drive = '/';
  for (const m of mountPoints ?? []) if (m.length > drive.length && isAtOrUnder(m, p)) drive = m;
  return drive;
}

/**
 * The clock looks are timed on — the budget, a silence's minute, the mount
 * table's freshness: monotonic (U-4b review, L3). A wall clock stepped back
 * stretched them, stepped forward spent them.
 */
export function lookClock(): number {
  return performance.now();
}

/**
 * A Windows path's drive or share as one key, however the path spells it (the
 * U-4b review, L4): `/` read as `\`, case folded, and the extended-length
 * prefixes taken off — under `\\?\UNC\` every share once had the one key
 * `\\?\UNC\`, and `C:/x` and `C:\x` were two drives.
 */
function windowsDriveKey(p: string): string {
  let q = p.replace(/\//g, '\\');
  if (/^\\\\[?.]\\UNC\\/i.test(q)) q = `\\\\${q.slice('\\\\?\\UNC\\'.length)}`;
  else if (/^\\\\[?.]\\[a-z]:/i.test(q)) q = q.slice('\\\\?\\'.length);
  return (path.win32.parse(q).root || q).toLowerCase();
}

/** How long a read mount table is used before it is read again: a drive attached since is a new name. */
const MOUNT_TABLE_FRESH_MS = 60_000;

/** A mount the table lists: where, and the file system's type as the table names it (`apfs`, `nfs`, …). */
interface Mount {
  mountPoint: string;
  filesystem: string;
}

let mountTable: { readAt: number; mounts: Mount[] | null } | null = null;
let mountTableRead: Promise<Mount[] | null> | null = null;
const READ_MOUNT_TABLE = (): Promise<MountTable> => readMountTable(process.platform);
let readTable: () => Promise<MountTable> = READ_MOUNT_TABLE;
let mountClock: () => number = lookClock;

/** Tests only: read the mount table with `read`, timed on `now`; null puts the machine's table back. Either way the next lookup reads afresh. */
export function setMountTableReaderForTests(read: (() => Promise<MountTable>) | null, now: () => number = lookClock): void {
  readTable = read ?? READ_MOUNT_TABLE;
  mountClock = read ? now : lookClock;
  mountTable = null;
  mountTableRead = null;
}

/** The mounts of this machine, read at most once a minute; null when the table cannot be read. */
async function currentMounts(): Promise<Mount[] | null> {
  if (mountTable && mountClock() - mountTable.readAt < MOUNT_TABLE_FRESH_MS) return mountTable.mounts;
  mountTableRead ??= readTable()
    .then((t) => t.entries?.map((e) => ({ mountPoint: e.mountPoint, filesystem: e.filesystem })) ?? null, () => null)
    .then((mounts) => {
      mountTable = { readAt: mountClock(), mounts };
      mountTableRead = null;
      return mounts;
    });
  return mountTableRead;
}

/** Which drive `p` is on, on this machine (`driveFor` over its mount table). */
export async function driveOn(p: string): Promise<string> {
  if (process.platform === 'win32') return driveFor(p, null, 'win32');
  return driveFor(p, (await currentMounts())?.map((m) => m.mountPoint) ?? null, process.platform);
}

/** The type of the file system `p` is on, as this machine's mount table names it; null where the table does not say (and on Windows). */
export async function filesystemOn(p: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  let deepest: Mount | null = null;
  for (const m of (await currentMounts()) ?? []) {
    if ((deepest === null || m.mountPoint.length > deepest.mountPoint.length) && isAtOrUnder(m.mountPoint, p)) deepest = m;
  }
  return deepest?.filesystem ?? null;
}

/* ───────────────────────────── listings ───────────────────────────── */

/**
 * File systems whose listings name every entry's type (U-4c L1). Where one
 * does not, Node's `Dir.read()` learns an entry's type with `lstatSync` — on
 * the event loop, so a slow or dead network drive would stop the whole server
 * with no deadline able to fire — and an entry removed between the listing and
 * that stat rejects the read with the entry's own ENOENT. Only these are read
 * an entry at a time; anything else, or a drive the table does not name, is
 * read whole by `readdir`, which stats an untyped entry on the I/O pool, where
 * the deadline races it.
 */
const TYPED_LISTINGS: ReadonlySet<string> = new Set(['apfs', 'hfs', 'ext2', 'ext3', 'ext4', 'btrfs', 'tmpfs', 'zfs', 'f2fs']);

/** Does a listing on this file system name every entry's type? Always on Windows, whose listings carry each entry's attributes. */
export function listsEntryTypes(filesystem: string | null, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return true;
  return filesystem !== null && TYPED_LISTINGS.has(filesystem.toLowerCase());
}

/** What `openListing` opens a folder with; a test brings its own. */
export interface ListingDeps {
  platform: NodeJS.Platform;
  filesystemOf: (p: string) => Promise<string | null>;
  opendir: (p: string) => Promise<FolderListing>;
  readdir: (p: string) => Promise<Dirent[]>;
}

const LIVE_LISTING: ListingDeps = {
  platform: process.platform,
  filesystemOf: (p) => filesystemOn(p),
  opendir: (p) => fsp.opendir(p),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
};

/**
 * `p`'s listing, to be read an entry at a time: opened as an `fs.Dir` where its
 * file system names each entry's type (U-4b L5: a folder of a million entries
 * is read only as far as the look needs), else read whole with `readdir` and
 * handed out an entry at a time (U-4c L1). Either way no stat runs on the
 * event loop. The whole read is the price (the U-4c review, F1.9): a folder
 * of a million entries on a share is listed in full, on one pool thread,
 * before its first entry settles the look, and an entry the listing did not
 * type is stat'ed on the pool. Node offers no listing read in parts that
 * keeps such an entry's stat off the event loop.
 */
export async function openListing(p: string, ld: ListingDeps = LIVE_LISTING): Promise<FolderListing> {
  if (listsEntryTypes(await ld.filesystemOf(p), ld.platform)) return ld.opendir(p);
  const entries = await ld.readdir(p);
  let next = 0;
  return {
    read: async () => (next < entries.length ? entries[next++] : null),
    close: async () => { /* nothing is held open */ },
  };
}

const REAL: EmptyCheckDeps = {
  lstat: (p) => fsp.lstat(p),
  opendir: (p) => openListing(p),
  deadline: realDeadline,
  deadlineMs: lookDeadlineMs(),
  budgetMs: lookBudgetMs(),
  now: lookClock,
  driveOf: driveOn,
  maxEntries: EMPTY_CHECK_MAX_ENTRIES,
};

let deps: EmptyCheckDeps = REAL;

/* ───────────────────────────── silence ───────────────────────────── */

/**
 * What a call went silent on — a drive, or one folder: `pending` calls still
 * out there; `failedAt` once one of them failed with a drive's own error.
 */
interface Silence {
  pending: number;
  failedAt: number | null;
}

/** Process-wide, by drive (`driveOf`): a silent drive is silent for every session, a later request's included. */
const silentDrives = new Map<string, Silence>();

/** Process-wide, by path: a folder whose own call is still out is not asked again, by any session (U-4c M-A). */
const silentFolders = new Map<string, Silence>();

/** The first look on each drive that is running now, any session's: a look on a drive not yet heard from waits for it. */
const probing = new Map<string, Promise<void>>();

/** The call asking each drive's root that is running now (the U-4c review, F1.8): another call that misses its deadline waits for its answer. */
const askingRoot = new Map<string, Promise<void>>();

/** A drive's calls that missed their deadline and are still out: each holds a thread of the I/O pool. */
interface Held {
  calls: number;
}

/** Process-wide, by drive (the U-4c review, F1.1). */
const heldOn = new Map<string, Held>();

/** `op`, on `drive`, missed its deadline: it is counted against the drive until it settles. */
function hold(drive: string, op: Promise<unknown>): void {
  let held = heldOn.get(drive);
  if (!held) {
    held = { calls: 0 };
    heldOn.set(drive, held);
  }
  const h = held;
  h.calls++;
  const release = (): void => {
    h.calls--;
    if (h.calls === 0 && heldOn.get(drive) === h) heldOn.delete(drive);
  };
  op.then(release, release);
}

/** How many of `drive`'s calls missed their deadline and are still out. */
function heldCalls(drive: string): number {
  return heldOn.get(drive)?.calls ?? 0;
}

/**
 * The failures that are the drive's own (U-4c M1): the device, its transport,
 * its server. Only these keep a silence for `SILENT_DRIVE_MEMORY_MS` once the
 * call answers. Any other — ENOENT, EACCES, EPERM, ENOTDIR — is an answer:
 * the drive is there, and said something.
 */
const DRIVE_ERRORS: ReadonlySet<string> = new Set(['EIO', 'ESTALE', 'ETIMEDOUT', 'ENXIO', 'EHOSTDOWN', 'ENOTCONN', 'EHOSTUNREACH', 'ENETDOWN']);

function silentIn(map: Map<string, Silence>, key: string, d: EmptyCheckDeps): boolean {
  const s = map.get(key);
  if (!s) return false;
  if (s.pending > 0 || (s.failedAt !== null && d.now() - s.failedAt < SILENT_DRIVE_MEMORY_MS)) return true;
  map.delete(key);
  return false;
}

/** Is `drive` not to be asked now: its root did not answer, or it holds `MAX_HELD_PER_DRIVE` calls already? */
function isSilent(d: EmptyCheckDeps, drive: string): boolean {
  return silentIn(silentDrives, drive, d) || heldCalls(drive) >= MAX_HELD_PER_DRIVE;
}

/** `op` missed its wait on `key`: silent until `op` answers, and for a minute after it fails with a drive's own error. */
function hush(map: Map<string, Silence>, key: string, d: EmptyCheckDeps, op: Promise<unknown>): void {
  let s = map.get(key);
  if (!s) {
    s = { pending: 0, failedAt: null };
    map.set(key, s);
  }
  const silence = s;
  silence.pending++;
  // An answer at last lifts the silence once no call is out (`silentIn` then lets it go).
  const failed = (err: unknown): void => {
    silence.pending--;
    if (DRIVE_ERRORS.has(codeOf(err instanceof NotOpened ? err.failure : err))) silence.failedAt = d.now();
  };
  op.then(() => { silence.pending--; }, failed);
}

/** Tests only: replace what a look reads with; null puts the real disk and clock back. Either way every drive and folder is heard afresh. */
export function setEmptyCheckForTests(over: Partial<EmptyCheckDeps> | null): void {
  deps = over ? { ...REAL, ...over } : REAL;
  silentDrives.clear();
  silentFolders.clear();
  probing.clear();
  askingRoot.clear();
  heldOn.clear();
}

/* ───────────────────────────── one look ───────────────────────────── */

const LATE = Symbol('late');
const SPENT = Symbol('spent');
/** Never started: the folder or the drive it is on went silent before this call's turn (the U-4b review, L-2). */
const HUSHED = Symbol('hushed');

/** A wait as a sentence says it: "2 seconds", or "1 ms" for a test's. */
function waitWords(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
}

function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'an error';
}

/** What a look needs from the session it runs in. */
interface LookContext {
  d: EmptyCheckDeps;
  /** The drive the folder looked at is on. */
  drive: string;
  /** Milliseconds of the session's budget left. */
  left: () => number;
}

/** Where a call goes: a folder, and the drive that folder is on (U-4c M1: a nested mount is a drive of its own). */
interface Where {
  folder: string;
  drive: string;
}

/**
 * `start()`'s answer; LATE when its deadline passes first, SPENT when the
 * session's budget does (or was gone before it started, when nothing is
 * started), HUSHED — nothing started — when the folder or its drive went
 * silent before this call's turn. A call left waiting makes its folder silent
 * until it answers; one that missed its whole deadline has the folder's drive
 * asked about too (`askRoot`). A later rejection of the call is handled by
 * the race.
 */
async function answered<T>(ctx: LookContext, where: Where, start: () => Promise<T>): Promise<T | typeof LATE | typeof SPENT | typeof HUSHED> {
  const left = ctx.left();
  if (left <= 0) return SPENT;
  if (silentIn(silentFolders, where.folder, ctx.d) || isSilent(ctx.d, where.drive)) return HUSHED;
  const wait = Math.min(ctx.d.deadlineMs, left);
  let op: Promise<T>;
  try {
    op = start();
  } catch (err) {
    op = Promise.reject(err);
  }
  const deadline = ctx.d.deadline(wait);
  let answer: T | typeof LATE;
  try {
    answer = await Promise.race([op, deadline.late.then((): typeof LATE => LATE)]);
  } finally {
    deadline.cancel();
  }
  if (answer !== LATE) return answer;
  // Still out: this folder is not asked again until the call answers, and the thread it holds counts against its drive.
  hush(silentFolders, where.folder, ctx.d, op);
  hold(where.drive, op);
  // A wait the budget cut short says nothing of the drive.
  if (wait < ctx.d.deadlineMs) return SPENT;
  await askRoot(ctx, where, op);
  return LATE;
}

/**
 * A call on `drive` missed its whole deadline (U-4c M-A): is it that folder,
 * or the drive? The drive's own root is asked, with a deadline of its own. A
 * root that misses it too makes the drive silent until the root answers; one
 * that answers — an error is an answer — shows the drive is there, and only
 * the folder that hung stays silent. So one slow folder (a dataless iCloud
 * folder, a busy pool) no longer silences every folder on its drive, and a
 * call that never settles holds only its own folder. A drive not known, or
 * one whose root is the folder that hung, cannot be asked anything new: the
 * drive is silent with that call. With the budget spent, the next request asks.
 * A drive already silent — its root missed, or it holds `MAX_HELD_PER_DRIVE`
 * calls — is not asked; nor is a root being asked already (the U-4c review,
 * F1.8): this call waits for that answer, as far as its budget goes.
 */
async function askRoot(ctx: LookContext, { folder, drive }: Where, op: Promise<unknown>): Promise<void> {
  const { d } = ctx;
  if (isSilent(d, drive)) return;
  if (drive === '' || drive === folder) {
    hush(silentDrives, drive, d, op);
    return;
  }
  const asking = askingRoot.get(drive);
  if (asking) {
    await budgeted(ctx, asking);
    return;
  }
  const wait = Math.min(d.deadlineMs, ctx.left());
  if (wait <= 0) return;
  const mine = probeRoot(d, drive, wait);
  askingRoot.set(drive, mine);
  try {
    await mine;
  } finally {
    if (askingRoot.get(drive) === mine) askingRoot.delete(drive);
  }
}

/** Ask `drive`'s root, waiting `wait`: a root that misses it makes the drive silent until it answers. Never rejects. */
async function probeRoot(d: EmptyCheckDeps, drive: string, wait: number): Promise<void> {
  let probe: Promise<unknown>;
  try {
    probe = d.lstat(drive);
  } catch (err) {
    probe = Promise.reject(err);
  }
  const deadline = d.deadline(wait);
  try {
    const late = await Promise.race([probe.then(() => false, () => false), deadline.late.then(() => true)]);
    if (late) hush(silentDrives, drive, d, probe);
  } finally {
    deadline.cancel();
  }
}

/**
 * `work`, or SPENT once what is left of the session's budget runs out first
 * (U-4b review, L3): a drive lookup — the first a minute may wait on `mount` —
 * and a wait for another look's first call on a drive are bounded by the
 * budget, as every call is. `work` never rejects.
 */
async function budgeted<T>(ctx: Pick<LookContext, 'd' | 'left'>, work: Promise<T>): Promise<T | typeof SPENT> {
  const left = ctx.left();
  if (left <= 0) return SPENT;
  const deadline = ctx.d.deadline(left);
  try {
    return await Promise.race([work, deadline.late.then((): typeof SPENT => SPENT)]);
  } finally {
    deadline.cancel();
  }
}

/** Which drive `p` is on, or '' when that cannot be told. */
async function driveSafely(d: EmptyCheckDeps, p: string): Promise<string> {
  try {
    return await d.driveOf(p);
  } catch {
    return '';
  }
}

/** The sentence for a folder whose own call is still out from an earlier look. */
const folderSilent = (named: string): EmptyVerdict =>
  notEmpty('no-answer', `${named} did not answer a moment ago, so TreeMap did not ask again and cannot tell that it is empty`);

/** The sentence for a folder on a drive that went silent. */
const DRIVE_SILENT = 'the drive it is on did not answer a moment ago, so TreeMap did not look at it again and cannot tell that it is empty';

/**
 * A listing that could not be opened, and why (`failure`): told apart from a
 * read that fails once it is open, which never says the folder itself is gone
 * — an entry that vanished mid-listing rejects a read with its own ENOENT
 * (U-4c L1).
 */
class NotOpened extends Error {
  constructor(readonly failure: unknown) {
    super('the listing could not be opened');
  }
}

/**
 * Read `folder`'s listing an entry at a time, handing each to `visit` until it
 * answers true (enough is known) or the listing ends; then close it. Once
 * `gaveUp()` is true — the look stopped waiting for this listing — nothing more
 * is read or visited, and the listing is closed when its read in flight
 * answers. The close is not awaited: what it says changes nothing the look
 * decided, and a close that hangs must not hold the look.
 */
async function readListing(d: EmptyCheckDeps, folder: string, visit: (ent: Dirent) => boolean, gaveUp: () => boolean): Promise<void> {
  let listing: FolderListing;
  try {
    listing = await d.opendir(folder);
  } catch (err) {
    throw new NotOpened(err);
  }
  try {
    for (;;) {
      if (gaveUp()) return;
      const ent = await listing.read();
      if (ent === null || gaveUp() || visit(ent)) return;
    }
  } finally {
    listing.close().catch(() => { /* already closed, or the drive went away: nothing to do */ });
  }
}

const notEmpty = (why: NotEmptyWhy, reason: string): EmptyVerdict => ({ empty: false, why, reason });

function budgetSpent(d: EmptyCheckDeps): EmptyVerdict {
  return notEmpty('out-of-time', `the ${waitWords(d.budgetMs)} TreeMap gives to looking at folders again ran out before it made sure this one is empty`);
}

/** Opening `dir` said it is not there: so it is gone if a fresh stat says so too; anything else is not shown empty (U-4c L1). */
async function goneUnlessThere(ctx: LookContext, dir: string): Promise<EmptyVerdict> {
  let again: { isDirectory(): boolean } | typeof LATE | typeof SPENT | typeof HUSHED;
  try {
    again = await answered(ctx, { folder: dir, drive: ctx.drive }, () => ctx.d.lstat(dir));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
    return notEmpty('unreadable', `it could not be looked at (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
  }
  if (again === LATE) return notEmpty('no-answer', `it did not answer within ${waitWords(ctx.d.deadlineMs)}, so TreeMap cannot tell that it is empty`);
  if (again === SPENT) return budgetSpent(ctx.d);
  if (again === HUSHED) return notEmpty('no-answer', DRIVE_SILENT);
  return notEmpty('unreadable', 'it could not be opened (ENOENT), though it is there, so TreeMap cannot tell that it is empty');
}

/** The look itself: the folder's own stat, then every listing below it, each raced against its deadline and the budget. */
async function lookAt(ctx: LookContext, dir: string, ignoreJunk: boolean): Promise<EmptyVerdict> {
  const { d } = ctx;
  const named = (folder: string): string => (folder === dir ? 'it' : `the folder ${path.relative(dir, folder)} inside it`);
  const silent = (folder: string): EmptyVerdict =>
    notEmpty('no-answer', `${named(folder)} did not answer within ${waitWords(d.deadlineMs)}, so TreeMap cannot tell that it is empty`);
  /** Not asked: the folder's own call, or its drive, went silent before its turn. */
  const hushed = (folder: string, drive: string): EmptyVerdict => {
    if (silentIn(silentFolders, folder, d)) return folderSilent(named(folder));
    if (folder === dir) return notEmpty('no-answer', DRIVE_SILENT);
    return notEmpty('no-answer', `${named(folder)} is on a drive that did not answer a moment ago, so TreeMap did not ask it again and cannot tell that it is empty`);
  };
  let top: { isDirectory(): boolean } | typeof LATE | typeof SPENT | typeof HUSHED;
  try {
    top = await answered(ctx, { folder: dir, drive: ctx.drive }, () => d.lstat(dir));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
    return notEmpty('unreadable', `it could not be looked at (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
  }
  if (top === LATE) return silent(dir);
  if (top === SPENT) return budgetSpent(d);
  if (top === HUSHED) return hushed(dir, ctx.drive);
  if (!top.isDirectory()) return notEmpty('not-a-folder', 'it is not a folder any more');
  const queue = [dir];
  let examined = 0;
  for (let i = 0; i < queue.length; i++) {
    const folder = queue[i];
    let found: EmptyVerdict | null = null;
    // Each entry as it is read: the first that settles the question ends the listing (L5).
    const visit = (ent: Dirent): boolean => {
      examined++;
      if (examined > d.maxEntries) {
        found = notEmpty('too-many', `it holds more than ${d.maxEntries} entries to look through, so TreeMap did not finish making sure it is empty`);
        return true;
      }
      const full = path.join(folder, ent.name);
      // A folder's entry, never a link to one: a Dirent reports a link as a link.
      if (ent.isDirectory()) {
        queue.push(full);
        return false;
      }
      if (ignoreJunk && ent.isFile() && JUNK_FILES.has(ent.name.toLowerCase())) return false;
      found = notEmpty('content', `it holds ${path.relative(dir, full)} now, so it is not empty`);
      return true;
    };
    let gaveUp = false;
    let listed: void | typeof LATE | typeof SPENT | typeof HUSHED;
    // A folder below may be a mount of its own: its silence is its own drive's (U-4c M1).
    const drive = folder === dir ? ctx.drive : await budgeted(ctx, driveSafely(d, folder));
    if (drive === SPENT) return budgetSpent(d);
    try {
      listed = await answered(ctx, { folder, drive }, () => readListing(d, folder, visit, () => gaveUp));
    } catch (err) {
      const failure = err instanceof NotOpened ? err.failure : err;
      // Gone only when the folder itself could not be opened for not being there, and a fresh stat
      // agrees (U-4c L1): a read's ENOENT is an entry's, and the folder may hold the rest.
      if (err instanceof NotOpened && folder === dir && codeOf(failure) === 'ENOENT') return goneUnlessThere(ctx, dir);
      return notEmpty('unreadable', `${named(folder)} could not be read (${codeOf(failure)}), so TreeMap cannot tell that it is empty`);
    }
    if (listed === HUSHED) return hushed(folder, drive);
    if (listed === LATE || listed === SPENT) {
      gaveUp = true;
      return listed === LATE ? silent(folder) : budgetSpent(d);
    }
    if (found) return found;
  }
  return { empty: true };
}

/* ───────────────────────────── sessions ───────────────────────────── */

/** The looks one request makes: they share a budget, and each drive's first look goes alone. */
export interface EmptyCheckSession {
  /** Whether `dir` is still an empty folder on disk: `{ empty: true }`, or why not. Never throws. */
  look(dir: string): Promise<EmptyVerdict>;
}

/**
 * A session of looks for one request (U-4b M1): GET /api/empty-folders' second
 * look, a dry run, or an "only empty folders" delete. `ignoreJunk` is Empty
 * Folders' junk rule. The session keeps the dependencies it began with.
 */
export function emptyCheckSession(ignoreJunk: boolean): EmptyCheckSession {
  const d = deps;
  let spent = 0;
  let running = 0;
  let runningSince = 0;
  /** Drives a look of this session has heard from: its other looks there need not wait. */
  const heard = new Set<string>();
  const left = (): number => d.budgetMs - (spent + (running > 0 ? d.now() - runningSince : 0));
  /** `work`, counted in the budget while it runs: the drive lookup and a wait for another look are looking too (L3). */
  const timed = async (work: () => Promise<EmptyVerdict>): Promise<EmptyVerdict> => {
    if (running++ === 0) runningSince = d.now();
    try {
      return await work();
    } finally {
      if (--running === 0) spent += d.now() - runningSince;
    }
  };
  const lookOn = (drive: string, dir: string): Promise<EmptyVerdict> => lookAt({ d, drive, left }, dir, ignoreJunk);
  return {
    async look(dir: string): Promise<EmptyVerdict> {
      if (left() <= 0) return budgetSpent(d);
      return timed(async () => {
        const drive = await budgeted({ d, left }, driveSafely(d, dir));
        if (drive === SPENT) return budgetSpent(d);
        for (;;) {
          if (isSilent(d, drive)) return notEmpty('no-answer', DRIVE_SILENT);
          // While one of the drive's calls is out unanswered, its looks go one at a time (the U-4c review, F1.1).
          if (heard.has(drive) && heldCalls(drive) === 0) return lookOn(drive, dir);
          const first = probing.get(drive);
          if (!first) break;
          // Ends when that look answers or goes silent; this request's own budget bounds the wait.
          if ((await budgeted({ d, left }, first)) === SPENT) return budgetSpent(d);
        }
        // This look is the drive's first, or the one look on a drive with a call out: the others wait for it.
        let done = (): void => {};
        const mine = new Promise<void>((resolve) => { done = resolve; });
        probing.set(drive, mine);
        try {
          const verdict = await lookOn(drive, dir);
          if (!isSilent(d, drive)) heard.add(drive);
          return verdict;
        } finally {
          if (probing.get(drive) === mine) probing.delete(drive);
          done();
        }
      });
    },
  };
}

/**
 * Whether `dir` is still an empty folder on disk: `{ empty: true }`, or why
 * not — one look, in a session of its own. `ignoreJunk` is Empty Folders' junk
 * rule. Never throws.
 */
export async function stillEmptyFolder(dir: string, ignoreJunk: boolean): Promise<EmptyVerdict> {
  return emptyCheckSession(ignoreJunk).look(dir);
}
