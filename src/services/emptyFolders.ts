import type { EmptyFoldersAnswer, ScanResult } from '../models/types';
import { findEmptyFolders } from './diskScanner';
import { storeOf } from './scanStore';
import { emptyCheckSession, type EmptyVerdict } from './emptyFolderCheck';

/**
 * GET /api/empty-folders, answered (Track U, U-4): never a folder the scan did
 * not or could not list.
 *
 *  - The scan's own records come first: a folder marked not listed
 *    (`Flag.Unlisted`, set where each engine knows) is never a candidate, nor
 *    is any folder above it (`findEmptyFolders`).
 *  - Then every folder the answer would offer is looked at again on disk, a
 *    few at a time, in one session of looks (`emptyCheckSession`, U-4b M1).
 *    One that holds something now, refuses, or does not answer is left out and
 *    counted in `withheld`, and every empty folder at or under it leaves
 *    `totalCount`. A drive that does not answer is asked once — its first
 *    folder goes alone — and every other folder on it is left out unasked,
 *    now and in the requests after, until that call answers; the looks stop
 *    after 10 s. This is what catches what no record can: the native memory
 *    path's unreadable folders (counted, never named), a listing a fast rescan
 *    took from its cache, a change since the scan.
 *  - A gdu scan offers none (`reason`): gdu shows a folder it was refused, and
 *    one whose only entry was a mount point its `-x` dropped, as an empty
 *    folder, so its tree cannot tell an empty folder from one it never read.
 *    U-12 lifts this once gdu's refusals are read from its log.
 *
 * The answer keeps the shape it had and only adds: `withheld` always, with
 * `withheldBy` saying how many were left out for each reason (the U-4b
 * review, L-5: the page said "did not answer" for TreeMap's own 10 s), and
 * `reason` only for a scan that offers nothing because of what it is.
 */

/** Folders looked at again at the same time: the look is a stat and a listing or two, and a silent drive must not take the I/O pool. */
const SECOND_LOOKS_AT_ONCE = 4;

/** Why a gdu scan offers no empty folder: the response's `reason`, shown as is by the page. */
export const GDU_EMPTY_FOLDERS_REASON =
  'This scan ran on gdu, which shows a folder it could not read, and a folder holding only a mounted drive, as an empty folder, ' +
  'so TreeMap cannot tell which folders are really empty and offers none. ' +
  // Not "Automatic": where the native module is missing, Automatic runs gdu again.
  'Scan again with Settings › Scan engine set to Built-in walker to see them.';

export async function emptyFoldersForScan(
  scan: ScanResult,
  ignoreJunk: boolean,
  paused: { covers(p: string): boolean; holds(p: string): boolean } = { covers: () => false, holds: () => false },
): Promise<EmptyFoldersAnswer> {
  if (scan.engine === 'gdu-turbo') {
    return { folders: [], totalCount: 0, truncated: false, withheld: 0, withheldBy: {}, reason: GDU_EMPTY_FOLDERS_REASON };
  }
  // A second name the system gives a path (macOS /.nofollow, /.resolve, /.vol), which a walk of /
  // lists as an empty folder, is never among them nor counted: `findEmptyFolders` owns it like a
  // tool's folder, before its list is cut (the SEC-2 review, F4; the SEC-3 brief, item 7).
  const found = findEmptyFolders(storeOf(scan), ignoreJunk);
  // Never one inside a folder a note pauses, nor one holding a paused folder, which its Trash step would
  // take too (the hunt, C39): neither offered nor counted, as the note sheet promises.
  const candidates = found.folders.filter((f) => !paused.covers(f.path) && !paused.holds(f.path));
  const kept = new Set(candidates);
  const pausedCount = found.folders.reduce((n, f) => (kept.has(f) ? n : n + f.counted), 0);
  // A cloud provider's listing lives at the provider: there is no folder on this disk to look at again.
  const verdicts: EmptyVerdict[] = scan.engine === 'cloud'
    ? candidates.map(() => ({ empty: true }))
    : await secondLooks(candidates.map((f) => f.path), ignoreJunk);
  const folders: EmptyFoldersAnswer['folders'] = [];
  let withheld = 0;
  // Why each was left out, counted (the U-4b review, L-5): the page says it rather than guessing.
  const withheldBy: EmptyFoldersAnswer['withheldBy'] = {};
  let totalCount = found.totalCount - pausedCount;
  candidates.forEach((f, i) => {
    const verdict = verdicts[i];
    if (verdict.empty) {
      folders.push({ name: f.name, path: f.path });
    } else {
      withheld++;
      withheldBy[verdict.why] = (withheldBy[verdict.why] ?? 0) + 1;
      totalCount -= f.counted;
    }
  });
  return { folders, totalCount, truncated: found.truncated, withheld, withheldBy };
}

/**
 * Each path looked at again, in order: its verdict. One session: a silent
 * drive's folders, and every folder past the session's budget, answer at once
 * without being asked.
 */
async function secondLooks(paths: readonly string[], ignoreJunk: boolean): Promise<EmptyVerdict[]> {
  const session = emptyCheckSession(ignoreJunk);
  const still: EmptyVerdict[] = paths.map(() => ({ empty: false, why: 'out-of-time', reason: 'not looked at' }));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++;
      still[i] = await session.look(paths[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SECOND_LOOKS_AT_ONCE, paths.length) }, worker));
  return still;
}
