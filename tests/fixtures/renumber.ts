import { Flag, NodeInput, PackedScanStore, StoreColumns } from '../../src/services/scanStore';
import { makeRng } from './storeFuzz';

/**
 * Renumbers a finalized PackedScanStore the way the Phase 4 walk will number
 * one (design §S.2): each folder's children take one consecutive block of
 * ids, reserved when that folder is listed, and folders are listed in any
 * order in which a folder's own id already exists. Breadth-first numbering
 * (what `finalize()` gives) is the one schedule that always lists the
 * earliest-numbered folder next; `renumberStore` picks the next folder at
 * random, last-in-first, or first-in-first.
 *
 * The result is a fresh store that adopts the new columns through
 * `adoptColumns`, so it is read through the same code as a store the native
 * build hands over. The invariants the design names hold by construction and
 * are checked on every call (`checkBlockInvariants`):
 *
 *  - I1: the root is id 0, with parent -1;
 *  - I2: each folder's children occupy [childStart, childStart + childCnt),
 *        in the source's child order;
 *  - I3: parent[id] < id;
 *  - I4: names are laid out in id order, so nameOff never decreases.
 *
 * The extension dictionary is shuffled too (entry 0 stays the empty "no
 * extension"), so an extension's id differs while its text does not, and
 * every column gets a random number of spare rows, as the native build's do.
 */

export type Schedule = 'random' | 'depthFirst' | 'breadthFirst';

export interface RenumberOptions {
  /** Which listed folder takes the next block of ids. Default 'random'. */
  schedule?: Schedule;
  /**
   * 'zeroed' writes 0 as every folder's size, so the caller must run
   * `sumSizes()` on the result and the totals are computed under the new
   * numbering; 'kept' copies the source's totals. Default 'kept'.
   */
  folderTotals?: 'kept' | 'zeroed';
}

export interface Renumbering {
  /** The renumbered store, finalized. */
  store: PackedScanStore;
  /** The source's id → the new id. */
  newIdOf: Int32Array;
  /** How many ids differ from the source's. */
  moved: number;
  /** The columns the store adopted (it holds these very arrays). */
  columns: StoreColumns;
}

/** Every flag a column carries; `Removed` is refused before any is read. */
const FLAG_BITS = [
  Flag.Dir, Flag.HasChildArray, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink,
  Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed,
];
/** The store's own numbering of container kinds and cloud providers (scanStore.ts). */
const CONTAINER_ID: Record<string, number> = { zip: 1, tar: 2, tgz: 3, iso: 4, dmg: 5, photos: 6, docker: 7 };
const CLOUD_ID: Record<string, number> = { icloud: 1, onedrive: 2, dropbox: 3 };
/** The most spare rows and spare name bytes the columns are given. */
const MAX_HEADROOM_ROWS = 8;
const MAX_NAME_ROOM = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The source's ids in the order the schedule lists them, each with its
 * children: every node that has a child array is listed once, after its own
 * id was reserved in its parent's block.
 */
function listingOrder(source: PackedScanStore, schedule: Schedule, rng: () => number): Array<{ folder: number; kids: number[] }> {
  const listings: Array<{ folder: number; kids: number[] }> = [];
  // Folders whose ids exist and that are not listed yet: ready[head..]. The
  // first-in-first schedule advances `head`; the others take one entry and
  // move the last into its place, which keeps `head` at 0.
  const ready: number[] = [source.rootId];
  let head = 0;
  while (head < ready.length) {
    let at = head;
    if (schedule === 'depthFirst') at = ready.length - 1;
    else if (schedule === 'random') at = head + Math.floor(rng() * (ready.length - head));
    const folder = ready[at];
    if (schedule === 'breadthFirst') {
      head++;
    } else {
      ready[at] = ready[ready.length - 1];
      ready.pop();
    }
    const kids = source.childIds(folder);
    listings.push({ folder, kids });
    for (const kid of kids) if (source.hasChildArray(kid)) ready.push(kid);
  }
  return listings;
}

/** In place: a Fisher-Yates shuffle of `items[from..]`. */
function shuffleFrom<T>(items: T[], from: number, rng: () => number): void {
  for (let i = items.length - 1; i > from; i--) {
    const j = from + Math.floor(rng() * (i - from + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

/**
 * Renumbers `source` by a block schedule drawn from `seed`. Refuses what a
 * renumbering through `adoptColumns` would silently lose: tombstoned nodes,
 * and the `cloudId` and `logicalSize` values, which are not columns.
 */
export function renumberStore(source: PackedScanStore, seed: number, options: RenumberOptions = {}): Renumbering {
  const rng = makeRng(seed);
  const schedule = options.schedule ?? 'random';
  const n = source.count;
  const listings = listingOrder(source, schedule, rng);

  const newIdOf = new Int32Array(n).fill(-1);
  const blockOf = new Map<number, { start: number; count: number }>();
  newIdOf[source.rootId] = 0;
  let next = 1;
  for (const { folder, kids } of listings) {
    blockOf.set(folder, { start: next, count: kids.length });
    for (let k = 0; k < kids.length; k++) newIdOf[kids[k]] = next + k;
    next += kids.length;
  }
  if (next !== n) {
    throw new Error(`renumberStore: ${next} of the store's ${n} ids are reachable from the root; a tombstoned or detached node cannot be renumbered`);
  }
  const oldOf = new Int32Array(n);
  for (let old = 0; old < n; old++) oldOf[newIdOf[old]] = old;

  const headroom = Math.floor(rng() * (MAX_HEADROOM_ROWS + 1));
  const capacity = n + headroom;
  const parent = new Int32Array(capacity);
  const size = new Float64Array(capacity);
  const mtime = new Float64Array(capacity);
  let atime: Float64Array | null = null;
  const flags = new Uint16Array(capacity);
  const ext = new Uint16Array(capacity);
  const container = new Uint8Array(capacity);
  const cloudProv = new Uint8Array(capacity);
  const nameOff = new Uint32Array(capacity + 1);
  const childStart = new Uint32Array(capacity);
  const childCnt = new Uint32Array(capacity);

  // The dictionary: every extension text once, then shuffled past entry 0.
  const extTexts = [''];
  const seenExt = new Set<string>();
  for (let old = 0; old < n; old++) {
    const e = source.extension(old);
    if (e !== undefined && !seenExt.has(e)) {
      seenExt.add(e);
      extTexts.push(e);
    }
  }
  if (extTexts.length > 0xffff) throw new Error('renumberStore: more extensions than one dictionary holds');
  shuffleFrom(extTexts, 1, rng);
  const extIdOf = new Map(extTexts.map((text, id) => [text, id] as [string, number]));

  const nameParts: Uint8Array[] = [];
  let namesLen = 0;
  for (let id = 0; id < n; id++) {
    const old = oldOf[id];
    if (source.flag(old, Flag.Removed)) throw new Error(`renumberStore: node ${old} is tombstoned`);
    if (source.cloudId(old) !== undefined || source.logicalSize(old) !== undefined) {
      throw new Error(`renumberStore: node ${old} (${source.path(old)}) carries a cloudId or logicalSize, which adoptColumns has no column for`);
    }
    parent[id] = id === 0 ? -1 : newIdOf[source.parent(old)];
    let bits = 0;
    for (const f of FLAG_BITS) if (source.flag(old, f)) bits |= f;
    flags[id] = bits;
    size[id] = options.folderTotals === 'zeroed' && (bits & Flag.Dir) !== 0 ? 0 : source.size(old);
    mtime[id] = source.modifiedAt(old);
    const accessed = source.accessedAt(old);
    if (accessed !== undefined) (atime ??= new Float64Array(capacity))[id] = accessed;
    const e = source.extension(old);
    ext[id] = e === undefined ? 0 : (extIdOf.get(e) as number);
    const kind = source.container(old);
    container[id] = kind ? CONTAINER_ID[kind] : 0;
    const provider = source.cloudProvider(old);
    cloudProv[id] = provider ? CLOUD_ID[provider] : 0;
    const name = source.name(old);
    const bytes = encoder.encode(name);
    if (decoder.decode(bytes) !== name) throw new Error(`renumberStore: the name of node ${old} does not survive UTF-8`);
    nameParts.push(bytes);
    nameOff[id] = namesLen;
    namesLen += bytes.length;
    const block = blockOf.get(old);
    if (block) {
      childStart[id] = block.start;
      childCnt[id] = block.count;
    }
  }
  nameOff[n] = namesLen;
  const names = new Uint8Array(namesLen + Math.floor(rng() * (MAX_NAME_ROOM + 1)));
  let at = 0;
  for (const part of nameParts) {
    names.set(part, at);
    at += part.length;
  }

  const columns: StoreColumns = {
    n, capacity, parent, size, mtime, atime, flags, ext, container, cloudProv,
    nameOff, names, namesLen, childStart, childCnt, extDict: extTexts, extOverflow: [],
  };
  checkBlockInvariants(columns);

  const rootInput: NodeInput = {
    name: source.name(source.rootId),
    isDir: source.isDir(source.rootId),
    size: 0,
    modifiedAt: source.modifiedAt(source.rootId),
    isHidden: source.flag(source.rootId, Flag.Hidden),
  };
  const store = new PackedScanStore(source.rootPath, source.sep, rootInput);
  store.adoptColumns(columns);

  let moved = 0;
  for (let old = 0; old < n; old++) if (newIdOf[old] !== old) moved++;
  return { store, newIdOf, moved, columns };
}

/**
 * Throws, naming the first node that breaks it, unless the columns hold
 * I1-I4 (see the module comment): one O(n) pass over the first `n` rows.
 */
export function checkBlockInvariants(cols: StoreColumns): void {
  const { n } = cols;
  if (n < 1) throw new Error('I1: no rows');
  if (cols.parent[0] !== -1) throw new Error(`I1: the root's parent is ${cols.parent[0]}, not -1`);
  if (cols.nameOff[0] !== 0) throw new Error(`I4: the first name starts at ${cols.nameOff[0]}, not 0`);
  if (cols.nameOff[n] !== cols.namesLen) throw new Error(`I4: the names end at ${cols.nameOff[n]}, not namesLen ${cols.namesLen}`);
  for (let id = 0; id < n; id++) {
    if (cols.nameOff[id + 1] < cols.nameOff[id]) throw new Error(`I4: nameOff falls from ${cols.nameOff[id]} to ${cols.nameOff[id + 1]} after node ${id}`);
    const start = cols.childStart[id];
    const count = cols.childCnt[id];
    if (count > 0 && (start <= id || start + count > n)) {
      throw new Error(`I2/I3: node ${id}'s children [${start}, ${start + count}) are not ids after it inside the ${n} rows`);
    }
    for (let c = start; c < start + count; c++) {
      if (cols.parent[c] !== id) throw new Error(`I2: node ${c} lies in node ${id}'s block but its parent is ${cols.parent[c]}`);
    }
    if (id === 0) continue;
    const p = cols.parent[id];
    if (p < 0 || p >= id) throw new Error(`I3: node ${id}'s parent is ${p}`);
    const ps = cols.childStart[p];
    if (id < ps || id >= ps + cols.childCnt[p]) {
      throw new Error(`I2: node ${id} lies outside its parent ${p}'s block [${ps}, ${ps + cols.childCnt[p]})`);
    }
  }
}
