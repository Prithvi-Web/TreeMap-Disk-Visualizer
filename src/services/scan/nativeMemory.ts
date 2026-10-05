import type { NativeStore, NativeStoreArrays, NativeStoreShape, StoreStartOptions } from '../../../native/index';
import { CONTAINER_RULES } from '../../utils/containerKind';
import { statToInput } from './nodeInput';
import { Flag, PackedScanStore, containerKindId } from '../scanStore';
import { cloudProviderFor } from '../cloudFolders';
import { keepSmallest, markUnlisted } from '../scanRefusals';
import { platform } from '../../platform';
import type { ScanModule } from './native';
import type { EntryProjection } from './projection';
import type { ScanResult } from '../../models/types';
import { formatCount } from '../../utils/formatCount';
import { cpuMicros, runInSlices, type CompletionSliceOptions, type SliceOutcome, type SliceWork } from './completionSlices';

/**
 * The native engine's memory path (Phase 4, T8c; every native scan's since
 * T10, `nativeStorageFor`). The walk feeds tm-store's memory sink, which builds
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
 *
 * A scan runs those passes a slice at a time (`adoptNativeStoreInSlices`,
 * Track U, U-35), the event loop turning between slices, and writes the
 * record once, after the last; the order, and so every sum, is the same as
 * in one go (`adoptNativeStore`).
 */

const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;
const SORT_CHILDREN = platform().platform !== 'windows';

/**
 * `T_mem`: the entries memory mode is planned for in both runtimes (the
 * owner's 5,000,000, Phase 4 Q3; T9's measurement, 26 Sep 2026: 533 MB at 5M
 * in plain Node, 547 MB in Electron, under the 700 MB ceiling). A tree known
 * to be above it is never walked again from zero in the built-in walker
 * after a native failure (P4-14, `noRestartRefusal`).
 */
export const T_MEM_ENTRIES = 5_000_000;
/**
 * T16's margin over `T_mem` (P4-4a, U-D18): the default room is this many
 * times `T_mem`, and a previous scan's count is weighed against `T_mem` at
 * this many times itself.
 */
export const T_MEM_MARGIN = 1.25;
/**
 * Rows the memory sink reserves by default, the headroom among them: 1.25 ×
 * `T_mem`. A walk with more entries, or more bytes of names than
 * `NAME_BYTES_PER_ROW` a row, ends at its ceiling, and `runNativeWalk` walks
 * it again on the columns path (T10) until T12's conversions carry it on —
 * unless its projection sized the room first (`memoryRoomFor`, U-31).
 */
export const MEMORY_CAP_ROWS = T_MEM_MARGIN * T_MEM_ENTRIES;
/** Name bytes the sink reserves a row: address space, resident only where names are written (names average 13–21 bytes). */
const NAME_BYTES_PER_ROW = 128;
/**
 * How much room a tree gets for its projected entries (Track U, U-31; the
 * owner's U-Q15, 2 Oct 2026): a stated policy, not a measurement. A row
 * reserved and never written costs only address space — its pages are never
 * touched, so never resident (P4-11) — while a row too few costs a whole
 * second walk. Interim: T16's chooser replaces it, and the room goes back to
 * 1.25 × `T_mem` as the conversion trigger.
 */
export const RESERVE_FACTOR = 2;
/** The most rows the store can number: its ids are signed 32-bit. */
const MAX_ROOM_ROWS = 2 ** 31 - 1;
/** The most name bytes its 32-bit name offsets reach. */
const MAX_NAME_BYTES = 2 ** 32 - 1;

/** The memory sink's room: rows reserved, the headroom among them, and name bytes. */
export interface MemoryRoom {
  capRows: number;
  /** Rows kept free after the scan's for the watcher and container expansion: 1 % of the reservation, at least 1,024 (P4-6). */
  headroomRows: number;
  nameBytes: number;
  /** `default`: `MEMORY_CAP_ROWS` (or a test's); `projection`: more, sized from the tree's projected entries (U-31). */
  sizedBy: 'default' | 'projection';
}

/** A test's room: rows reserved and, optionally, name bytes a row and the `T_mem` its scans are weighed against. */
export interface MemoryRoomForTests {
  capRows: number;
  nameBytesPerRow?: number;
  tMem?: number;
}

let roomForTests: MemoryRoomForTests | null = null;

/**
 * The room a memory-mode walk is given for a tree projected at `entries`
 * (U-31): `RESERVE_FACTOR` times the projection where that is more than the
 * default room (`MEMORY_CAP_ROWS`, or a test's), else the default; no more
 * rows than the store's ids number, and no more name bytes than its offsets
 * reach. An unknown projection — null, or anything but a positive finite
 * number — gets the default.
 */
export function memoryRoomFor(projection: { entries: number | null } | null): MemoryRoom {
  const base = roomForTests?.capRows ?? MEMORY_CAP_ROWS;
  const nameBytesPerRow = roomForTests?.nameBytesPerRow ?? NAME_BYTES_PER_ROW;
  const entries = projection?.entries;
  const wanted = typeof entries === 'number' && Number.isFinite(entries) && entries > 0
    ? Math.max(base, Math.ceil(RESERVE_FACTOR * entries))
    : base;
  const capRows = Math.min(wanted, MAX_ROOM_ROWS);
  return {
    capRows,
    headroomRows: Math.max(1_024, Math.ceil(capRows / 100)),
    nameBytes: Math.min(capRows * nameBytesPerRow, MAX_NAME_BYTES),
    sizedBy: capRows > base ? 'projection' : 'default',
  };
}

/** The default room a memory-mode walk is given (`MEMORY_CAP_ROWS`, or a test's): `memoryRoomFor` with no projection. */
export function memoryRoom(): MemoryRoom {
  return memoryRoomFor(null);
}

/** Tests only: less room, so a small tree can reach a ceiling — its rows' or its names'; null restores the real room. */
export function setMemoryRoomForTests(room: MemoryRoomForTests | null): void {
  roomForTests = room;
}

/** `T_mem` as a scan is weighed against it: `T_MEM_ENTRIES`, or a test's. */
export function memoryTMem(): number {
  return roomForTests?.tMem ?? T_MEM_ENTRIES;
}

/** A failure's words, whatever was thrown, without a closing full stop: a value with no string form still gives a reason. */
function reasonOf(err: unknown): string {
  try {
    return (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
  } catch {
    return 'a failure with no description';
  }
}

/** The folder a stalled walk last reported (`lastSeenAt`, set by `runNativeWalk`'s stall), or null. */
function lastSeenAtOf(err: unknown): string | null {
  try {
    const seen = (err as { lastSeenAt?: unknown } | null)?.lastSeenAt;
    return typeof seen === 'string' ? seen : null;
  } catch {
    return null;
  }
}

/**
 * P4-14 now (Track U, U-32; the owner's U-Q16, 2 Oct 2026): the error a
 * native scan that failed fails with, instead of being walked again from
 * zero in the built-in walker — or null, where that restart stands, as
 * today. The tree is known to be above `T_mem` when the scan has counted more
 * than it, or when the previous scan of the folder counted enough that, at
 * T16's margin, it is (U-D18). The used-inode hint is never such a fact.
 *
 * No ceiling clause: every room numbers more than `T_mem` entries before its
 * ceiling, so a walk that met one has counted past `T_mem` — unless a single
 * listing larger than the margin (1,187,500 entries in the default room), or
 * the names' room, met it first: an edge the plan records and this does not
 * handle.
 *
 * The error says how to scan anyway (the Scan engine setting). A walk that
 * stalled names the folder it last reported (`lastSeenAt`), as only that: the
 * walk samples its path when a listing starts, at most every 50 ms, so at a
 * stall it is often a folder another worker finished.
 */
export function noRestartRefusal(err: unknown, scanned: number, projection: EntryProjection | null, tMem: number = memoryTMem()): Error | null {
  let lead: string;
  if (scanned > tMem) {
    lead = `The native engine failed part-way past ${formatCount(tMem)} items`;
  } else if (projection?.source === 'previousScan' && projection.entries !== null && T_MEM_MARGIN * projection.entries > tMem) {
    lead = `The native engine failed on a folder whose last scan counted ${formatCount(projection.entries)} items`;
  } else {
    return null;
  }
  const sentences = [
    `${lead}: ${reasonOf(err)}.`,
    'TreeMap does not restart a scan this large in the built-in walker on its own: it would walk the tree again from zero at a fraction of the speed.',
  ];
  const seen = lastSeenAtOf(err);
  if (seen !== null) {
    sentences.push(
      `The walk was last seen at ${seen}, which may not be the folder that stopped answering. While a folder does not answer, every scan this large fails this way.`,
      'To scan it anyway, set Scan engine to Built-in walker in Settings, or add the folder that does not answer to "Don\'t scan", which also hands the scan to the built-in walker; either way the scan is slower.',
    );
  } else {
    sentences.push('To scan it anyway, set Scan engine to Built-in walker in Settings; the scan is slower.');
  }
  return new Error(sentences.join(' '));
}

/**
 * How the memory sink builds `store`'s tree: the scanner's own root, this
 * platform's rules and the table `detectContainerKind` reads. Two of these
 * reach a scan only rarely: `rootMtimeMs` stands in for the root's time only
 * where the walk withheld it, and `sortChildren` is the reference build's
 * re-sort — the sink keeps the walk's listing order, which the POSIX listers
 * sort themselves and Windows keeps as listed, as the ingest does. `room` is
 * the sink's room: the default, or one sized from the tree's projection.
 */
export function memoryStoreOptions(store: PackedScanStore, room: MemoryRoom = memoryRoom()): StoreStartOptions {
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
    headroomRows: room.headroomRows,
    capRows: room.capRows,
    nameBytes: room.nameBytes,
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
 * Candidates and refused folders the adopt decides in one slice (Track U,
 * U-35): the slice the cleanup walk and the dashboard's lists take. Each
 * cloud candidate and refused folder builds its whole path, so a slice of
 * them costs more than a slice of a walk's nodes.
 */
export const ADOPT_SLICE_ITEMS = 16_384;

/**
 * `taken` adopted by `store` — which holds just its root, as the scanner made
 * it — with Node's passes over it and the scan record filled as
 * `ingestColumns` fills it (see the module docs), in one go.
 */
export function adoptNativeStore(scan: ScanResult, store: PackedScanStore, taken: NativeStore): void {
  const adoption = beginAdoption(scan, store, taken);
  adoption.step(Number.POSITIVE_INFINITY);
  adoption.finish();
}

/**
 * The same adopt with Node's passes in slices of `ADOPT_SLICE_ITEMS` (U-35),
 * the event loop turning between them, so a whole disk's thousands of
 * candidates never hold the main thread at once. The scan record is written
 * once, after the last slice: until then it reads as the walk left it. A
 * cancel between two slices ends the adopt there, with nothing written.
 */
export async function adoptNativeStoreInSlices(scan: ScanResult, store: PackedScanStore, taken: NativeStore, options: CompletionSliceOptions = {}): Promise<SliceOutcome> {
  const begun = process.cpuUsage();
  const adoption = beginAdoption(scan, store, taken);
  let used = cpuMicros(process.cpuUsage(begun));
  const sliced = await runInSlices(adoption, options, ADOPT_SLICE_ITEMS);
  used += sliced.cpuMicros;
  if (!sliced.completed) return { completed: false, cpuMicros: used };
  const finishing = process.cpuUsage();
  adoption.finish();
  return { completed: true, cpuMicros: used + cpuMicros(process.cpuUsage(finishing)) };
}

/** `taken`'s columns adopted by `store`, and Node's passes over them ready to run. */
function beginAdoption(scan: ScanResult, store: PackedScanStore, taken: NativeStore): Adoption {
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
  return new Adoption(scan, store, taken);
}

/**
 * Node's passes over an adopted store as work that can stop between any two
 * of its items: the text candidates, then the cloud candidates, then the
 * refused folders, each list in its own order — the order the passes always
 * took, so every sum is the same sum, from 0 (U-35). What the passes find is
 * kept here; only `finish` writes the scan record.
 */
class Adoption implements SliceWork {
  private next = 0;
  private readonly textEnd: number;
  private readonly cloudEnd: number;
  private readonly total: number;
  private cloudFiles: number;
  /** In breadth-first order, the ingest's: `cloudBytes` is summed in it from 0. */
  private cloudBytes = 0;
  private readonly guesses: number[] = [];
  /**
   * The refused folders passed so far: how many, and the five smallest paths
   * (`keepSmallest`, the record's own rule) — never every path, which for a
   * scan refused tens of thousands of folders would be megabytes held across
   * every turn of the adopt. `finish` adds both to the record.
   */
  private deniedCount = 0;
  private readonly deniedExamples: string[] = [];

  constructor(
    private readonly scan: ScanResult,
    private readonly store: PackedScanStore,
    private readonly taken: NativeStore,
  ) {
    this.textEnd = taken.textCandidates.length;
    this.cloudEnd = this.textEnd + taken.cloudCandidates.length;
    this.total = this.cloudEnd + taken.counters.deniedDirs.length;
    this.cloudFiles = taken.counters.cloudFiles;
  }

  get done(): boolean {
    return this.next >= this.total;
  }

  step(budget: number): void {
    const end = Math.min(this.total, this.next + budget);
    const { store, taken } = this;
    for (; this.next < end && this.next < this.textEnd; this.next++) {
      const id = taken.textCandidates[this.next];
      const input = statToInput(store.name(id), store.isDir(id), 0, 0);
      store.setExtension(id, input.extension);
      store.setContainer(id, input.container);
    }
    for (; this.next < end && this.next < this.cloudEnd; this.next++) {
      this.cloudCandidate(taken.cloudCandidates[this.next - this.textEnd]);
    }
    for (; this.next < end; this.next++) {
      const id = taken.counters.deniedDirs[this.next - this.cloudEnd];
      this.deniedCount++;
      keepSmallest(this.deniedExamples, store.path(id));
      markUnlisted(store, id); // never listed, so never offered as empty (U-4)
    }
  }

  private cloudCandidate(id: number): void {
    const store = this.store;
    const provider = cloudProviderFor(store.path(id));
    if (store.flag(id, Flag.CloudPlaceholder)) {
      // The walk's own placeholder, counted by the build: Node names its provider.
      if (provider) store.setCloudProvider(id, provider);
      this.cloudBytes += store.size(id);
    } else if (provider) {
      store.setFlag(id, Flag.CloudPlaceholder, true);
      store.setCloudProvider(id, provider);
      this.cloudFiles += 1;
      this.cloudBytes += store.size(id);
    } else if (BLOCKS_ARE_MEANINGFUL && !store.flag(id, Flag.HardlinkDup)) {
      this.guesses.push(id);
    }
  }

  /** The scan record, filled as `ingestColumns` fills it, unset wherever it leaves a field unset. */
  finish(): void {
    const { scan, store, taken } = this;
    const counters = taken.counters;
    if (counters.hardlinkedFiles > 0) {
      scan.hardlinkedFiles = counters.hardlinkedFiles;
      scan.hardlinkedBytes = counters.hardlinkedBytes;
    }
    if (this.cloudFiles > 0) {
      scan.cloudFiles = this.cloudFiles;
      scan.cloudBytes = this.cloudBytes;
    }
    const sparseFiles = counters.sparseFiles + this.guesses.length;
    if (sparseFiles > 0) {
      scan.sparseFiles = sparseFiles;
      scan.sparseBytes = sparseTotal(store, taken, this.guesses);
    }
    if (counters.slackBytes > 0) scan.slackBytes = counters.slackBytes;
    if (this.deniedCount > 0) {
      // What `noteRefused` once a folder would leave: the count added to, and
      // the five smallest of the record's paths and these (each of the five
      // smallest overall is among the five smallest of its own part).
      scan.deniedDirs = (scan.deniedDirs ?? 0) + this.deniedCount;
      scan.deniedExamples = scan.deniedExamples ?? [];
      for (const example of this.deniedExamples) keepSmallest(scan.deniedExamples, example);
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
