import type { NativeStore, NativeStoreArrays, NativeStoreShape, StoreStartOptions } from '../../../native/index';
import { CONTAINER_RULES } from '../../utils/containerKind';
import { statToInput } from './nodeInput';
import { Flag, PackedScanStore, containerKindId } from '../scanStore';
import { cloudProviderFor } from '../cloudFolders';
import { noteRefused } from '../scanRefusals';
import { platform } from '../../platform';
import type { ScanModule } from './native';
import type { ScanResult } from '../../models/types';

/**
 * The native engine's memory path (Phase 4, T8c; behind `runNativeWalk`'s
 * `storage` until T10). The walk feeds tm-store's memory sink, which builds
 * the finalized store — `PackedScanStore`'s own columns — while it runs and
 * seals it as it ends; `storeTake` hands it over and the store the scanner
 * made adopts it in place (`adoptColumns`), no row copied. The native build
 * decides every row by `statToInput`'s rules but two things it leaves to Node
 * (design P4-3), which this module does, in the ingest's own order, so the
 * scan is `ingestColumns`' byte for byte:
 *
 *  - a name with a non-ASCII byte and a dot (a text candidate): its extension
 *    and container, by `statToInput`, whose lower-casing is JavaScript's;
 *  - a file that claims bytes with none allocated, or that the walk flagged
 *    dataless (a cloud candidate): the cloud rule on its path. A provider makes
 *    a guess a placeholder; with none, where blocks mean anything and it is
 *    not a later hard-link name, it is sparse.
 *
 * Then the byte totals the order of a float sum decides — `cloudBytes` over
 * the candidates that end up placeholders, `sparseBytes` over the build's
 * terms and Node's sparse guesses — are summed from 0 in breadth-first order,
 * the ingest's; the refused folders are named by path; the counters land on
 * the scan record, unset wherever the ingest leaves them unset.
 */

const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;
const SORT_CHILDREN = platform().platform !== 'windows';

/**
 * Rows the memory sink reserves, the headroom among them: 1.25 × the 5M rows
 * memory mode is designed for (§S.1.4). Provisional: T9 measures `T_mem` per
 * runtime and sets it. A walk with more entries fails with the ceiling's
 * sentence (T12's conversions are what carry it on).
 */
export const MEMORY_CAP_ROWS = 6_250_000;
/** Rows kept free after the scan's for the watcher and container expansion: 1 % of the reservation, at least 1,024 (P4-6). */
export const MEMORY_HEADROOM_ROWS = Math.max(1_024, Math.ceil(MEMORY_CAP_ROWS / 100));
/** Name bytes the sink reserves: address space, resident only where names are written. */
export const MEMORY_NAME_BYTES = MEMORY_CAP_ROWS * 128;

/**
 * How the memory sink builds `store`'s tree: the scanner's own root, this
 * platform's rules and the table `detectContainerKind` reads. Two of these
 * reach a scan only rarely: `rootMtimeMs` stands in for the root's time only
 * where the walk withheld it, and `sortChildren` is the reference build's
 * re-sort — the sink keeps the walk's listing order, which the POSIX listers
 * sort themselves and Windows keeps as listed, as the ingest does.
 */
export function memoryStoreOptions(store: PackedScanStore): StoreStartOptions {
  return {
    rootName: store.name(store.rootId),
    rootMtimeMs: store.modifiedAt(store.rootId),
    blocksAreMeaningful: BLOCKS_ARE_MEANINGFUL,
    sortChildren: SORT_CHILDREN,
    containerRules: CONTAINER_RULES.map((rule) => ({
      text: rule.text,
      wholeName: rule.wholeName,
      folders: rule.folders,
      kind: containerKindId(rule.kind),
    })),
    headroomRows: MEMORY_HEADROOM_ROWS,
    capRows: MEMORY_CAP_ROWS,
    nameBytes: MEMORY_NAME_BYTES,
  };
}

/** Arrays as long as `shape` says, for `storeTakeInto` to fill: zeros until it does. */
export function allocateStoreArrays(shape: NativeStoreShape): NativeStoreArrays {
  const rows = shape.capacity;
  return {
    parent: new Int32Array(rows),
    size: new Float64Array(rows),
    mtime: new Float64Array(rows),
    ...(shape.atime ? { atime: new Float64Array(rows) } : {}),
    flags: new Uint16Array(rows),
    ext: new Uint16Array(rows),
    container: new Uint8Array(rows),
    cloudProv: new Uint8Array(rows),
    nameOff: new Uint32Array(rows + 1),
    names: new Uint8Array(shape.namesRoom),
    childStart: new Uint32Array(rows),
    childCnt: new Uint32Array(rows),
    extOverflowIds: new Uint32Array(shape.extOverflow),
    cloudCandidates: new Uint32Array(shape.cloudCandidates),
    textCandidates: new Uint32Array(shape.textCandidates),
    sparseTermIds: new Uint32Array(shape.sparseTerms),
    sparseTermBytes: new Float64Array(shape.sparseTerms),
  };
}

/**
 * A finished memory-mode scan's store. Where this runtime lets an array be
 * the store's own memory — plain Node — it is taken as it is (`storeTake`:
 * nothing copied). Where it does not — the app's Electron, whose memory cage
 * refuses external buffers — it is copied into arrays made here, on libuv's
 * pool (`storeTakeInto`, Phase 4 T9c), where `storeTake` would have napi-rs
 * copy every column on this thread (RISKS R92).
 */
export async function takeNativeStore(mod: ScanModule, handle: number): Promise<NativeStore> {
  const { externalBuffersAllowed, storeShape, storeTakeInto, storeTake } = mod;
  if (externalBuffersAllowed?.call(mod) === false && storeShape && storeTakeInto) {
    return storeTakeInto.call(mod, handle, allocateStoreArrays(storeShape.call(mod, handle)));
  }
  if (!storeTake) throw new Error('the native module has no storeTake(), so it cannot hand over a memory-mode store; rebuild it with npm run build:native');
  return storeTake.call(mod, handle);
}

/**
 * `taken` adopted by `store` — which holds just its root, as the scanner made
 * it — with Node's passes over it and the scan record filled as
 * `ingestColumns` fills it (see the module docs).
 */
export function adoptNativeStore(scan: ScanResult, store: PackedScanStore, taken: NativeStore): void {
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
  for (const id of counters.deniedDirs) noteRefused(scan, store.path(id));
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

/**
 * The breadth-first places of `wanted`'s rows — the ids a breadth-first
 * numbering gives them — from the store's own child ranges: the root is 0,
 * each folder's children take the next places in child order, folder after
 * folder in the order they are reached. Walks every folder once.
 */
export function breadthFirstPlaces(childStart: Uint32Array, childCnt: Uint32Array, wanted: readonly number[]): Map<number, number> {
  const want = new Set(wanted);
  const places = new Map<number, number>();
  if (want.has(0)) places.set(0, 0);
  const queue: number[] = [0];
  let next = 1;
  for (let head = 0; head < queue.length; head++) {
    const folder = queue[head];
    const start = childStart[folder];
    const count = childCnt[folder];
    for (let k = 0; k < count; k++) {
      const child = start + k;
      if (want.has(child)) places.set(child, next + k);
      if (childCnt[child] > 0) queue.push(child);
    }
    next += count;
  }
  return places;
}
