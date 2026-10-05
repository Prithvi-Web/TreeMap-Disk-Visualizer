import type { EmptyFoldersAnswer, ScanResult } from '../models/types';
import { findEmptyFolders } from './diskScanner';
import { storeOf } from './scanStore';
import { emptyCheckSession } from './emptyFolderCheck';

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
 * The answer keeps the shape it had and only adds: `withheld` always,
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

export async function emptyFoldersForScan(scan: ScanResult, ignoreJunk: boolean): Promise<EmptyFoldersAnswer> {
  if (scan.engine === 'gdu-turbo') {
    return { folders: [], totalCount: 0, truncated: false, withheld: 0, reason: GDU_EMPTY_FOLDERS_REASON };
  }
  const found = findEmptyFolders(storeOf(scan), ignoreJunk);
  // A cloud provider's listing lives at the provider: there is no folder on this disk to look at again.
  const still = scan.engine === 'cloud'
    ? found.folders.map(() => true)
    : await secondLooks(found.folders.map((f) => f.path), ignoreJunk);
  const folders: EmptyFoldersAnswer['folders'] = [];
  let withheld = 0;
  let totalCount = found.totalCount;
  found.folders.forEach((f, i) => {
    if (still[i]) {
      folders.push({ name: f.name, path: f.path });
    } else {
      withheld++;
      totalCount -= f.counted;
    }
  });
  return { folders, totalCount, truncated: found.truncated, withheld };
}

/**
 * Each path looked at again, in order: true where it is still an empty folder.
 * One session: a silent drive's folders, and every folder past the session's
 * budget, answer at once without being asked.
 */
async function secondLooks(paths: readonly string[], ignoreJunk: boolean): Promise<boolean[]> {
  const session = emptyCheckSession(ignoreJunk);
  const still = paths.map(() => false);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++;
      still[i] = (await session.look(paths[i])).empty;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SECOND_LOOKS_AT_ONCE, paths.length) }, worker));
  return still;
}
