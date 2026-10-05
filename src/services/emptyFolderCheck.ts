import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { underTestRunner } from './realMachineGuard';

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
 * sentence. Imports no service, so the Trash pathway (`cleaner.ts`) can use it.
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

/** The most entries one look goes through, nested folders' included, before it stops short of proving a folder empty. */
export const EMPTY_CHECK_MAX_ENTRIES = 1_000;

/** Why a folder is not shown to be empty. */
export type NotEmptyWhy = 'content' | 'unreadable' | 'no-answer' | 'too-many' | 'not-a-folder' | 'gone';

export type EmptyVerdict = { empty: true } | { empty: false; why: NotEmptyWhy; reason: string };

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

const REAL: EmptyCheckDeps = {
  lstat: (p) => fsp.lstat(p),
  opendir: (p) => fsp.opendir(p),
  deadline: realDeadline,
  deadlineMs: lookDeadlineMs(),
  maxEntries: EMPTY_CHECK_MAX_ENTRIES,
};

let deps: EmptyCheckDeps = REAL;

/** Tests only: replace what a look reads with; null puts the real disk and clock back. */
export function setEmptyCheckForTests(over: Partial<EmptyCheckDeps> | null): void {
  deps = over ? { ...REAL, ...over } : REAL;
}

const LATE = Symbol('late');

/** `op`'s answer, or LATE when the deadline passes first. A later rejection of `op` is handled by the race. */
async function answered<T>(d: EmptyCheckDeps, op: Promise<T>): Promise<T | typeof LATE> {
  const deadline = d.deadline(d.deadlineMs);
  try {
    return await Promise.race([op, deadline.late.then((): typeof LATE => LATE)]);
  } finally {
    deadline.cancel();
  }
}

/** A wait as a sentence says it: "2 seconds", or "1 ms" for a test's. */
function waitWords(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
}

function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'an error';
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

/**
 * Whether `dir` is still an empty folder on disk: `{ empty: true }`, or why
 * not. `ignoreJunk` is Empty Folders' junk rule. Never throws.
 */
export async function stillEmptyFolder(dir: string, ignoreJunk: boolean): Promise<EmptyVerdict> {
  const d = deps;
  const notEmpty = (why: NotEmptyWhy, reason: string): EmptyVerdict => ({ empty: false, why, reason });
  const named = (folder: string): string => (folder === dir ? 'it' : `the folder ${path.relative(dir, folder)} inside it`);
  let top: { isDirectory(): boolean } | typeof LATE;
  try {
    top = await answered(d, d.lstat(dir));
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
    return notEmpty('unreadable', `it could not be looked at (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
  }
  if (top === LATE) return notEmpty('no-answer', `it did not answer within ${waitWords(d.deadlineMs)}, so TreeMap cannot tell that it is empty`);
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
    let listed: void | typeof LATE;
    try {
      listed = await answered(d, readListing(d, folder, visit, () => gaveUp));
    } catch (err) {
      if (folder === dir && codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
      return notEmpty('unreadable', `${named(folder)} could not be read (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
    }
    if (listed === LATE) {
      gaveUp = true;
      return notEmpty('no-answer', `${named(folder)} did not answer within ${waitWords(d.deadlineMs)}, so TreeMap cannot tell that it is empty`);
    }
    if (found) return found;
  }
  return { empty: true };
}
