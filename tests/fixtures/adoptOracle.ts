import type { NativeStore } from '../../native/index';
import { statToInput } from '../../src/services/scan/nodeInput';
import { breadthFirstPlaces } from '../../src/services/scan/nativeMemory';
import { Flag, PackedScanStore } from '../../src/services/scanStore';
import { cloudProviderFor } from '../../src/services/cloudFolders';
import { markUnlisted, noteRefused } from '../../src/services/scanRefusals';
import { platform } from '../../src/platform';
import type { ScanResult } from '../../src/models/types';

/**
 * The memory path's adopt as it was before Track U's U-35 sliced it:
 * `adoptNativeStore` and `sparseTotal` from src/services/scan/nativeMemory.ts
 * at af1bfa9 — dafeab4's, with U-4's mark on every refused folder
 * (`markUnlisted`, 8521fb7) — copied verbatim (only `export` added to the
 * function and the oracle's name). tests/nativeCompletion.test.ts holds the
 * sliced adopt and the drained one to it, record field for record field and
 * store column for store column, `Flag.Unlisted` among the flags, so a slice
 * boundary can never change an answer, nor lose U-4's mark.
 */

const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;

/**
 * `taken` adopted by `store` — which holds just its root, as the scanner made
 * it — with Node's passes over it and the scan record filled as
 * `ingestColumns` fills it (see the module docs).
 */
export function oracleAdoptNativeStore(scan: ScanResult, store: PackedScanStore, taken: NativeStore): void {
  store.adoptColumns({
    n: taken.n,
    capacity: taken.capacity,
    parent: taken.parent,
    size: taken.size,
    mtime: taken.mtime,
    atime: taken.atime ?? null,
    flags: taken.flags,
    ext: taken.ext,
    container: taken.container,
    cloudProv: taken.cloudProv,
    nameOff: taken.nameOff,
    names: taken.names,
    namesLen: taken.namesLen,
    childStart: taken.childStart,
    childCnt: taken.childCnt,
    extDict: taken.extDict,
    extOverflow: Array.from(taken.extOverflowIds, (id, k): [number, string] => [id, taken.extOverflowTexts[k]]),
  });
  for (const id of taken.textCandidates) {
    const input = statToInput(store.name(id), store.isDir(id), 0, 0);
    store.setExtension(id, input.extension);
    store.setContainer(id, input.container);
  }
  const counters = taken.counters;
  let cloudFiles = counters.cloudFiles;
  let cloudBytes = 0;
  const guesses: number[] = [];
  // In breadth-first order, the ingest's: `cloudBytes` is summed in it from 0.
  for (const id of taken.cloudCandidates) {
    const provider = cloudProviderFor(store.path(id));
    if (store.flag(id, Flag.CloudPlaceholder)) {
      // The walk's own placeholder, counted by the build: Node names its provider.
      if (provider) store.setCloudProvider(id, provider);
      cloudBytes += store.size(id);
    } else if (provider) {
      store.setFlag(id, Flag.CloudPlaceholder, true);
      store.setCloudProvider(id, provider);
      cloudFiles += 1;
      cloudBytes += store.size(id);
    } else if (BLOCKS_ARE_MEANINGFUL && !store.flag(id, Flag.HardlinkDup)) {
      guesses.push(id);
    }
  }
  if (counters.hardlinkedFiles > 0) {
    scan.hardlinkedFiles = counters.hardlinkedFiles;
    scan.hardlinkedBytes = counters.hardlinkedBytes;
  }
  if (cloudFiles > 0) {
    scan.cloudFiles = cloudFiles;
    scan.cloudBytes = cloudBytes;
  }
  const sparseFiles = counters.sparseFiles + guesses.length;
  if (sparseFiles > 0) {
    scan.sparseFiles = sparseFiles;
    scan.sparseBytes = sparseTotal(store, taken, guesses);
  }
  if (counters.slackBytes > 0) scan.slackBytes = counters.slackBytes;
  for (const id of counters.deniedDirs) {
    noteRefused(scan, store.path(id));
    markUnlisted(store, id); // never listed, so never offered as empty (U-4)
  }
  // The build counts the folders that vanished or could not be read without
  // naming them, so none can be marked here: Empty Folders' second look on disk
  // is what keeps such a folder out (U-4, emptyFolders.ts).
  if (counters.vanishedDirs > 0) scan.vanishedDirs = counters.vanishedDirs;
  if (counters.unreadableDirs > 0) scan.unreadableDirs = counters.unreadableDirs;
  const stats = taken.stats;
  scan.deniedEntries = stats.deniedEntries;
  scan.unreadableEntries = stats.unreadableEntries;
  scan.walkedDirs = stats.dirsListed + counters.deniedDirs.length + counters.vanishedDirs + counters.unreadableDirs;
  scan.cachedDirs = 0;
  scan.placeholdersSkipped = stats.dataless;
  scan.scanned = taken.n;
  scan.dirCount = counters.dirs;
  scan.fileCount = counters.files;
}

/**
 * `sparseBytes` as the ingest sums it: from 0, in breadth-first order, the
 * build's terms and Node's `guesses` interleaved. Where the build found the
 * order cannot show — every shortfall a whole number, the total below 2^53 —
 * it gave one term, `(0, total)`, or none, and the guesses are added in any
 * order; otherwise the two lists are merged by breadth-first place, which
 * block ids no longer give (RISKS R91).
 */
function sparseTotal(store: PackedScanStore, taken: NativeStore, guesses: readonly number[]): number {
  const termIds = taken.sparseTermIds;
  if (termIds.length === 0 || (termIds.length === 1 && termIds[0] === 0)) {
    let total = termIds.length === 1 ? taken.sparseTermBytes[0] : 0;
    for (const id of guesses) total += store.size(id);
    return total;
  }
  const items: Array<[number, number]> = [];
  termIds.forEach((id, k) => items.push([id, taken.sparseTermBytes[k]]));
  for (const id of guesses) items.push([id, store.size(id)]);
  const places = breadthFirstPlaces(taken.childStart, taken.childCnt, items.map(([id]) => id));
  items.sort((a, b) => (places.get(a[0]) ?? 0) - (places.get(b[0]) ?? 0));
  let total = 0;
  for (const [, bytes] of items) total += bytes;
  return total;
}
