import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';

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

/** The most entries one look goes through, nested folders' included, before it stops short of proving a folder empty. */
export const EMPTY_CHECK_MAX_ENTRIES = 1_000;

/** Why a folder is not shown to be empty. */
export type NotEmptyWhy = 'content' | 'unreadable' | 'no-answer' | 'too-many' | 'not-a-folder' | 'gone';

export type EmptyVerdict = { empty: true } | { empty: false; why: NotEmptyWhy; reason: string };

/** What a look reads the disk and the clock with; a test replaces any of them (`setEmptyCheckForTests`). */
export interface EmptyCheckDeps {
  lstat: (p: string) => Promise<{ isDirectory(): boolean }>;
  readdir: (p: string) => Promise<Dirent[]>;
  /** A deadline of `ms`: `late` settles when it passes; `cancel` lets it go once the answer came. */
  deadline: (ms: number) => { late: Promise<void>; cancel: () => void };
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
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  deadline: realDeadline,
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
  const deadline = d.deadline(EMPTY_CHECK_DEADLINE_MS);
  try {
    return await Promise.race([op, deadline.late.then((): typeof LATE => LATE)]);
  } finally {
    deadline.cancel();
  }
}

function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'an error';
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
  if (top === LATE) return notEmpty('no-answer', `it did not answer within ${EMPTY_CHECK_DEADLINE_MS / 1000} seconds, so TreeMap cannot tell that it is empty`);
  if (!top.isDirectory()) return notEmpty('not-a-folder', 'it is not a folder any more');
  const queue = [dir];
  let examined = 0;
  for (let i = 0; i < queue.length; i++) {
    const folder = queue[i];
    let entries: Dirent[] | typeof LATE;
    try {
      entries = await answered(d, d.readdir(folder));
    } catch (err) {
      if (folder === dir && codeOf(err) === 'ENOENT') return notEmpty('gone', 'it is no longer there');
      return notEmpty('unreadable', `${named(folder)} could not be read (${codeOf(err)}), so TreeMap cannot tell that it is empty`);
    }
    if (entries === LATE) {
      return notEmpty('no-answer', `${named(folder)} did not answer within ${EMPTY_CHECK_DEADLINE_MS / 1000} seconds, so TreeMap cannot tell that it is empty`);
    }
    for (const ent of entries) {
      examined++;
      if (examined > d.maxEntries) {
        return notEmpty('too-many', `it holds more than ${d.maxEntries} entries to look through, so TreeMap did not finish making sure it is empty`);
      }
      const full = path.join(folder, ent.name);
      // A folder's entry, never a link to one: a Dirent reports a link as a link.
      if (ent.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (ignoreJunk && ent.isFile() && JUNK_FILES.has(ent.name.toLowerCase())) continue;
      return notEmpty('content', `it holds ${path.relative(dir, full)} now, so it is not empty`);
    }
  }
  return { empty: true };
}
