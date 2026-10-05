import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { underTestRunner } from './realMachineGuard';
import { isAtOrUnder, readMountTable } from '../utils/mountBoundaries';

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
 *  - **Silence is remembered per drive.** A stat or listing that misses its
 *    deadline makes its drive silent: until that call answers, no look anywhere
 *    — this request, a later one, the delete after the list — touches the
 *    drive; each answers "did not answer" at once. A call that answers at last
 *    lifts the silence (a spun-down disk woke); one that fails after its
 *    silence keeps it for `SILENT_DRIVE_MEMORY_MS`. A drive is told by the
 *    mount table (`driveFor`), as the scan's boundary is, never by a stat —
 *    a stat is what hangs. So a silent drive holds at most one thread per call
 *    that went silent on it, and never another.
 *  - **The first look on a drive goes alone.** Within a session, looks on a
 *    drive not yet heard from wait for that drive's first look to answer — or
 *    to go silent — before they start: one probe, not four at once.
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

/** The most entries one look goes through, nested folders' included, before it stops short of proving a folder empty. */
export const EMPTY_CHECK_MAX_ENTRIES = 1_000;

/** Why a folder is not shown to be empty. */
export type NotEmptyWhy = 'content' | 'unreadable' | 'no-answer' | 'too-many' | 'not-a-folder' | 'gone';

export type EmptyVerdict = { empty: true } | { empty: false; why: NotEmptyWhy; reason: string };

/**
 * The code an "only empty folders" delete refuses a folder with, by why the
 * look could not show it empty (U-4b L4) — each its own, so a caller can tell
 * a folder that holds something from one nobody could read or that did not
 * answer. A folder that is gone is not refused: its Trash step says so.
 */
export const NOT_EMPTY_CODES = {
  content: 'FOLDER_NOT_EMPTY',
  unreadable: 'FOLDER_UNREADABLE',
  'no-answer': 'FOLDER_NO_ANSWER',
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
   * A folder's listing, read an entry at a time (U-4b L5): a folder of a
   * million entries is read only as far as the look needs — the first file, or
   * one entry past `maxEntries` — never whole before the limit applies.
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
  if (platform === 'win32') return path.win32.parse(p).root.toLowerCase() || p;
  let drive = '/';
  for (const m of mountPoints ?? []) if (m.length > drive.length && isAtOrUnder(m, p)) drive = m;
  return drive;
}

/** How long a read mount table is used before it is read again: a drive attached since is a new name. */
const MOUNT_TABLE_FRESH_MS = 60_000;
let mountTable: { readAt: number; points: string[] | null } | null = null;
let mountTableRead: Promise<string[] | null> | null = null;

/** The mount points of this machine, read at most once a minute; null when the table cannot be read. */
async function currentMountPoints(): Promise<string[] | null> {
  if (mountTable && Date.now() - mountTable.readAt < MOUNT_TABLE_FRESH_MS) return mountTable.points;
  mountTableRead ??= readMountTable(process.platform)
    .then((t) => t.entries?.map((e) => e.mountPoint) ?? null, () => null)
    .then((points) => {
      mountTable = { readAt: Date.now(), points };
      mountTableRead = null;
      return points;
    });
  return mountTableRead;
}

/** Which drive `p` is on, on this machine (`driveFor` over its mount table). */
export async function driveOn(p: string): Promise<string> {
  return driveFor(p, process.platform === 'win32' ? null : await currentMountPoints(), process.platform);
}

const REAL: EmptyCheckDeps = {
  lstat: (p) => fsp.lstat(p),
  opendir: (p) => fsp.opendir(p),
  deadline: realDeadline,
  deadlineMs: lookDeadlineMs(),
  budgetMs: lookBudgetMs(),
  now: () => Date.now(),
  driveOf: driveOn,
  maxEntries: EMPTY_CHECK_MAX_ENTRIES,
};

let deps: EmptyCheckDeps = REAL;

/* ───────────────────────────── silent drives ───────────────────────────── */

/** A drive a call went silent on: `pending` calls still out on it; `failedAt` once one answered with a failure. */
interface Silence {
  pending: number;
  failedAt: number | null;
}

/** Process-wide: a silent drive is silent for every session, a later request's included. */
const silentDrives = new Map<string, Silence>();

/** The first look on each drive that is running now, any session's: a look on a drive not yet heard from waits for it. */
const probing = new Map<string, Promise<void>>();

function isSilent(d: EmptyCheckDeps, drive: string): boolean {
  const s = silentDrives.get(drive);
  if (!s) return false;
  if (s.pending > 0 || (s.failedAt !== null && d.now() - s.failedAt < SILENT_DRIVE_MEMORY_MS)) return true;
  silentDrives.delete(drive);
  return false;
}

/** `op` missed its wait on `drive`: the drive is silent until `op` answers, and for a while after a failure. */
function wentSilent(d: EmptyCheckDeps, drive: string, op: Promise<unknown>): void {
  let s = silentDrives.get(drive);
  if (!s) {
    s = { pending: 0, failedAt: null };
    silentDrives.set(drive, s);
  }
  const silence = s;
  silence.pending++;
  // An answer at last lifts the silence once no call is out (`isSilent` then lets the drive go);
  // a failure keeps it for a minute from the failure.
  const answered = (failed: boolean): void => {
    silence.pending--;
    if (failed) silence.failedAt = d.now();
  };
  op.then(() => answered(false), () => answered(true));
}

/** Tests only: replace what a look reads with; null puts the real disk and clock back. Either way every drive is heard afresh. */
export function setEmptyCheckForTests(over: Partial<EmptyCheckDeps> | null): void {
  deps = over ? { ...REAL, ...over } : REAL;
  silentDrives.clear();
  probing.clear();
}

/* ───────────────────────────── one look ───────────────────────────── */

const LATE = Symbol('late');
const SPENT = Symbol('spent');

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
  drive: string;
  /** Milliseconds of the session's budget left. */
  left: () => number;
}

/**
 * `start()`'s answer; LATE when its deadline passes first, SPENT when the
 * session's budget does (or was gone before it started, when nothing is
 * started). A call left waiting makes its drive silent until it answers. A
 * later rejection of the call is handled by the race.
 */
async function answered<T>(ctx: LookContext, start: () => Promise<T>): Promise<T | typeof LATE | typeof SPENT> {
  const left = ctx.left();
  if (left <= 0) return SPENT;
  const wait = Math.min(ctx.d.deadlineMs, left);
  let op: Promise<T>;
  try {
    op = start();
  } catch (err) {
    op = Promise.reject(err);
  }
  const deadline = ctx.d.deadline(wait);
  try {
    const answer = await Promise.race([op, deadline.late.then((): typeof LATE => LATE)]);
    if (answer !== LATE) return answer;
    wentSilent(ctx.d, ctx.drive, op);
    return wait < ctx.d.deadlineMs ? SPENT : LATE;
  } finally {
    deadline.cancel();
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
  const listing = await d.opendir(folder);
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
  return notEmpty('no-answer', `the ${waitWords(d.budgetMs)} TreeMap gives to looking at folders again ran out before it made sure this one is empty`);
}

/** The look itself: the folder's own stat, then every listing below it, each raced against its deadline and the budget. */
async function lookAt(ctx: LookContext, dir: string, ignoreJunk: boolean): Promise<EmptyVerdict> {
  const { d } = ctx;
  const named = (folder: string): string => (folder === dir ? 'it' : `the folder ${path.relative(dir, folder)} inside it`);
  const silent = (folder: string): EmptyVerdict =>
    notEmpty('no-answer', `${named(folder)} did not answer within ${waitWords(d.deadlineMs)}, so TreeMap cannot tell that it is empty`);
  let top: { isDirectory(): boolean } | typeof LATE | typeof SPENT;
  try {
    top = await answered(ctx, () => d.lstat(dir));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
    return notEmpty('unreadable', `it could not be looked at (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
  }
  if (top === LATE) return silent(dir);
  if (top === SPENT) return budgetSpent(d);
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
    let listed: void | typeof LATE | typeof SPENT;
    try {
      listed = await answered(ctx, () => readListing(d, folder, visit, () => gaveUp));
    } catch (err) {
      if (folder === dir && codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
      return notEmpty('unreadable', `${named(folder)} could not be read (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
    }
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
  const timed = async (drive: string, dir: string): Promise<EmptyVerdict> => {
    if (running++ === 0) runningSince = d.now();
    try {
      return await lookAt({ d, drive, left }, dir, ignoreJunk);
    } finally {
      if (--running === 0) spent += d.now() - runningSince;
    }
  };
  const driveSilent = (): EmptyVerdict =>
    notEmpty('no-answer', 'the drive it is on did not answer a moment ago, so TreeMap did not look at it again and cannot tell that it is empty');

  return {
    async look(dir: string): Promise<EmptyVerdict> {
      if (left() <= 0) return budgetSpent(d);
      let drive: string;
      try {
        drive = await d.driveOf(dir);
      } catch {
        drive = '';
      }
      for (;;) {
        if (isSilent(d, drive)) return driveSilent();
        if (heard.has(drive)) return timed(drive, dir);
        const first = probing.get(drive);
        if (!first) break;
        await first; // ends when that look answers or goes silent: it is bounded by its own deadline
      }
      // This look is the drive's first: the others wait for it.
      let done = (): void => {};
      const mine = new Promise<void>((resolve) => { done = resolve; });
      probing.set(drive, mine);
      try {
        const verdict = await timed(drive, dir);
        if (!isSilent(d, drive)) heard.add(drive);
        return verdict;
      } finally {
        if (probing.get(drive) === mine) probing.delete(drive);
        done();
      }
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
