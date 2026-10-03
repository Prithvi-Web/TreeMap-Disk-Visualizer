import type { EmptyFoldersAnswer, ScanResult } from '../models/types';
import { findEmptyFolders } from './diskScanner';
import { storeOf } from './scanStore';
import { stillEmptyFolder } from './emptyFolderCheck';

/**
 * GET /api/empty-folders, answered (Track U, U-4): never a folder the scan did
 * not or could not list.
 *
 *  - The scan's own records come first: a folder marked not listed
 *    (`Flag.Unlisted`, set where each engine knows) is never a candidate, nor
 *    is any folder above it (`findEmptyFolders`).
 *  - Then every folder the answer would offer is looked at again on disk
 *    (`stillEmptyFolder`), a few at a time. One that holds something now,
 *    refuses, or does not answer is left out and counted in `withheld`, and
 *    every empty folder at or under it leaves `totalCount`. The first folder
 *    that does not answer stops the rest from being asked — each would wait on
 *    the same silent drive, holding a thread of the I/O pool — and they are
 *    left out too. This is what catches what no record can: the native memory
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
  'Scan again with Settings › Scan engine set to Automatic or Built-in walker to see them.';

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

/** Each path looked at again, in order: true where it is still an empty folder. A path never asked is false. */
async function secondLooks(paths: readonly string[], ignoreJunk: boolean): Promise<boolean[]> {
  const still = paths.map(() => false);
  let next = 0;
  let silent = false;
  const worker = async (): Promise<void> => {
    while (!silent && next < paths.length) {
      const i = next++;
      const verdict = await stillEmptyFolder(paths[i], ignoreJunk);
      if (verdict.empty) still[i] = true;
      else if (verdict.why === 'no-answer') silent = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SECOND_LOOKS_AT_ONCE, paths.length) }, worker));
  return still;
}
