import type { NativeStore, WalkResult } from '../../native/index';
import { FLAG_DATALESS, FLAG_REFUSED_DIR, KIND_DIR, KIND_FILE, KIND_SYMLINK, REFUSAL_DENIED, REFUSAL_UNREADABLE, REFUSAL_VANISHED } from '../../src/services/scan/nativeEngine';
import { Flag, NodeInput, ObjectScanStore, PackedScanStore } from '../../src/services/scanStore';
import { makeProfile, makeRng, randomDir, randomFile, randomName, type Profile } from './storeFuzz';

/**
 * The trees, walk columns and native stores tests/nativeCompletion.test.ts
 * (Track U, U-35) builds the native completion's inputs from.
 *
 *  - a random tree with every field a producer can set, built into a store
 *    in three orders: breadth-first (the native ingest's, in which
 *    `finalize()` has nothing to renumber), a walker's (folders listed in the
 *    order their listings happen to finish) and depth-first;
 *  - walk columns as tm-walk hands them over, numbered as several workers
 *    interleave them, with every case the ingest decides: hard-link families
 *    across folders, cloud candidates, sparse and slack files, links, `.git`,
 *    refused folders, withheld times;
 *  - a native store as `storeTake` hands it over, with as many text
 *    candidates, cloud candidates and refused folders as a test asks for.
 */

/* ------------------------------ a tree, three build orders ------------------------------ */

export interface SpecNode {
  input: NodeInput;
  children?: SpecNode[];
}

export interface TreeSpec {
  profile: Profile;
  root: NodeInput;
  children: SpecNode[];
  /** Nodes below the root. */
  nodes: number;
}

/**
 * A random tree of `nodes` nodes below the root: storeFuzz's files and
 * folders (hidden names, extensions, containers, links, placeholders with
 * providers, hard-link duplicates, `.git` folders, access times or cloud ids
 * by profile), names with accents, CJK and emoji, and a few container entries
 * with a logical size. Every name is unique, so a path names one node.
 */
export function randomSpec(seed: number, nodes: number): TreeSpec {
  const rng = makeRng(seed);
  const profile = makeProfile(rng, seed);
  const root: NodeInput = {
    name: profile.rootPath.split(profile.sep).pop() || profile.rootPath,
    isDir: true,
    size: 0,
    modifiedAt: 1_700_000_000_000,
    isHidden: false,
  };
  const top: SpecNode = { input: root, children: [] };
  const dirs: SpecNode[] = [top];
  for (let serial = 0; serial < nodes; serial++) {
    const parent = dirs[Math.floor(rng() * dirs.length)];
    let base = randomName(rng, serial);
    if (serial % 37 === 5) base = `${base}\u{1F600}`;
    const isDir = rng() < 0.3;
    let input = isDir ? randomDir(rng, base, profile) : randomFile(rng, base, profile);
    if (!isDir && serial % 53 === 7) {
      // A container's entry carries only what a listing gives (emitFileNode's virtual branch).
      input = {
        name: `${base}.bin`, isDir: false, size: input.size, modifiedAt: input.modifiedAt, isHidden: base.startsWith('.'),
        extension: 'bin', virtual: true, logicalSize: Math.floor(rng() * 9_000_000),
      };
    }
    const node: SpecNode = isDir ? { input, children: [] } : { input };
    (parent.children as SpecNode[]).push(node);
    if (isDir) dirs.push(node);
  }
  return { profile, root, children: top.children as SpecNode[], nodes };
}

export type BuildOrder = 'breadthFirst' | 'walker' | 'depthFirst';

export interface Built {
  store: PackedScanStore;
  /** The parent of every node added, in the order added. */
  parents: number[];
}

/**
 * `spec` added to a new store in `order`, not finalized. A walker's order:
 * up to four folders are being listed at once and their listings finish in
 * any order, each folder's children added together when its listing does,
 * as `drainQueue` adds them.
 */
export function buildPacked(spec: TreeSpec, order: BuildOrder, seed = 1): Built {
  const store = new PackedScanStore(spec.profile.rootPath, spec.profile.sep, spec.root);
  const parents: number[] = [];
  const add = (parent: number, node: SpecNode): number => {
    parents.push(parent);
    return store.addNode(parent, node.input);
  };
  if (order === 'depthFirst') {
    const grow = (parent: number, kids: SpecNode[]): void => {
      for (const kid of kids) {
        const id = add(parent, kid);
        if (kid.children) grow(id, kid.children);
      }
    };
    grow(store.rootId, spec.children);
    return { store, parents };
  }
  const rng = makeRng(seed * 31 + 7);
  const pending: Array<{ id: number; kids: SpecNode[] }> = [{ id: store.rootId, kids: spec.children }];
  while (pending.length > 0) {
    const pick = order === 'walker' ? Math.floor(rng() * Math.min(4, pending.length)) : 0;
    const [{ id, kids }] = pending.splice(pick, 1);
    for (const kid of kids) {
      const childId = add(id, kid);
      if (kid.children) pending.push({ id: childId, kids: kid.children });
    }
  }
  return { store, parents };
}

/** `spec` in the object store, the oracle every packed build is held to. */
export function buildObject(spec: TreeSpec): ObjectScanStore {
  const store = new ObjectScanStore(spec.profile.rootPath, spec.profile.sep, spec.root);
  const grow = (parent: number, kids: SpecNode[]): void => {
    for (const kid of kids) {
      const id = store.addNode(parent, kid.input);
      if (kid.children) grow(id, kid.children);
    }
  };
  grow(store.rootId, spec.children);
  return store;
}

/** Whether every node came under a parent no smaller than the one before it. */
export function parentsNeverDecrease(parents: readonly number[]): boolean {
  for (let i = 1; i < parents.length; i++) if (parents[i] < parents[i - 1]) return false;
  return true;
}

/** The UTF-8 bytes of the names below the root of `spec`, as the store keeps them. */
export function nameBytesBelowRoot(spec: TreeSpec): number {
  let bytes = 0;
  const visit = (kids: SpecNode[]): void => {
    for (const kid of kids) {
      bytes += Buffer.byteLength(kid.input.name, 'utf8');
      if (kid.children) visit(kid.children);
    }
  };
  visit(spec.children);
  return bytes;
}

/* ------------------------------ walk columns, as several workers number them ------------------------------ */

interface WalkNode {
  name: Buffer;
  kind: number;
  dataless: boolean;
  refusal: number;
  size: number;
  alloc: number;
  mtime: number;
  atime: number;
  family: number;
  children: WalkNode[];
}

export interface FuzzColumnsOptions {
  /** Entries below the root. */
  entries: number;
  /** Walk workers listing at once. */
  workers: number;
  /** Names with a byte that is not UTF-8, as Linux allows. */
  invalidUtf8?: boolean;
}

/** Names a folder can take that the cloud rule names a provider for. */
const CLOUD_FOLDERS = ['com~apple~CloudDocs', 'OneDrive', 'Dropbox'];
const FILE_NAMES = ['f.txt', 'R.TAR.GZ', 'é.Png', '文', '.hidden', '\u{1F600}.mp4', 'a.ZIP', 'b.dmg', 'NOEXT', 'x.', 'y.icloud'];

/**
 * Walk columns for a random tree of `entries` entries below the root, as
 * tm-walk hands them over: index 0 the root, every parent before its
 * children, and the entries numbered as `workers` workers interleave their
 * listings, so a folder's children are not contiguous and a later folder's
 * may come first. Each listing is in the file system's own order (shuffled),
 * which the ingest sorts by name bytes where libuv sorts a readdir listing.
 * Hard-link families span folders; files under a cloud provider's folder
 * that claim bytes with none allocated are cloud candidates, as are files the
 * walk flags dataless; elsewhere such a file is sparse, and one with more
 * allocated than it claims is slack. Some folders are refused (denied,
 * vanished, unreadable) and list nothing; some times are withheld (NaN), and
 * some access times are zero.
 */
export function fuzzColumns(seed: number, opts: FuzzColumnsOptions): WalkResult {
  const rng = makeRng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
  const time = (): number => (rng() < 0.03 ? Number.NaN : 1_600_000_000_000 + rng() * 1e11);
  const root: WalkNode = { name: Buffer.from('root'), kind: KIND_DIR, dataless: false, refusal: 0, size: 0, alloc: 0, mtime: time(), atime: time(), family: -1, children: [] };
  const folders: Array<{ node: WalkNode; cloud: boolean; names: Set<string> }> = [{ node: root, cloud: false, names: new Set() }];
  const files: WalkNode[] = [];
  for (let serial = 0; serial < opts.entries; serial++) {
    const at = pick(folders);
    const roll = rng();
    let name: string;
    let kind = KIND_FILE;
    if (roll < 0.22) {
      kind = KIND_DIR;
      name = !at.names.has('.git') && rng() < 0.06 ? '.git' : rng() < 0.15 ? `${pick(CLOUD_FOLDERS)} ${serial}` : `d${serial}`;
    } else {
      if (roll > 0.97) kind = KIND_SYMLINK;
      const base = pick(FILE_NAMES);
      const dot = base.indexOf('.', 1);
      name = dot > 0 ? `${base.slice(0, dot)}${serial}${base.slice(dot)}` : `${base}${serial}`;
    }
    at.names.add(name);
    let bytes = Buffer.from(name, 'utf8');
    if (opts.invalidUtf8 && serial % 29 === 3) bytes = Buffer.concat([bytes, Buffer.from([0xff])]);
    const size = kind === KIND_DIR ? 0 : rng() < 0.1 ? 0 : Math.floor(rng() * 2_000_000);
    const cloudy = at.cloud || /CloudDocs|OneDrive|Dropbox/.test(name);
    // Under a provider's folder most files hold nothing locally: the ingest's cloud guesses.
    const shape = rng();
    const unallocated = at.cloud ? 0.5 : 0.12;
    const alloc = kind === KIND_DIR ? 0 : shape < unallocated ? 0 : shape < unallocated + 0.06 ? size + 8_192 : Math.ceil(size / 4_096) * 4_096;
    const node: WalkNode = {
      name: bytes,
      kind,
      dataless: kind === KIND_FILE && rng() < 0.03,
      refusal: kind === KIND_DIR && rng() < 0.05 ? pick([REFUSAL_DENIED, REFUSAL_VANISHED, REFUSAL_UNREADABLE]) : 0,
      size,
      alloc,
      mtime: time(),
      atime: rng() < 0.05 ? 0 : time(),
      family: -1,
      children: [],
    };
    at.node.children.push(node);
    if (kind === KIND_DIR && node.refusal === 0) folders.push({ node, cloud: cloudy, names: new Set() });
    if (kind === KIND_FILE) files.push(node);
  }
  // Hard-link families of two or three names, the names anywhere (most in different folders), one file's size each.
  let families = 0;
  for (let k = 0; k + 3 < files.length && families < Math.max(1, Math.floor(files.length / 40)); k += 1 + Math.floor(rng() * 30)) {
    const members = [files[k], files[Math.floor(rng() * files.length)], ...(rng() < 0.3 ? [files[Math.floor(rng() * files.length)]] : [])];
    if (new Set(members).size !== members.length || members.some((m) => m.family !== -1)) continue;
    for (const m of members) {
      m.family = families;
      m.size = members[0].size;
      m.alloc = members[0].alloc;
    }
    families++;
  }
  for (const f of folders) {
    const kids = f.node.children;
    for (let i = kids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [kids[i], kids[j]] = [kids[j], kids[i]];
    }
  }

  // Number the entries as `workers` workers interleave their listings.
  const order: WalkNode[] = [root];
  const parent: number[] = [0];
  const queue: Array<{ node: WalkNode; index: number }> = [{ node: root, index: 0 }];
  const busy: Array<{ index: number; left: WalkNode[] }> = [];
  let dirsListed = 0;
  while (queue.length > 0 || busy.length > 0) {
    while (busy.length < opts.workers && queue.length > 0) {
      const job = queue.shift() as { node: WalkNode; index: number };
      if (job.node.refusal !== 0) continue;
      dirsListed++;
      busy.push({ index: job.index, left: [...job.node.children] });
    }
    if (busy.length === 0) break;
    const w = Math.floor(rng() * busy.length);
    const worker = busy[w];
    for (let k = 1 + Math.floor(rng() * 4); k > 0 && worker.left.length > 0; k--) {
      const node = worker.left.shift() as WalkNode;
      const index = order.length;
      order.push(node);
      parent.push(worker.index);
      if (node.kind === KIND_DIR) queue.push({ node, index });
    }
    if (worker.left.length === 0) busy.splice(w, 1);
  }

  const n = order.length;
  const nameOff = new Uint32Array(n + 1);
  let off = 0;
  order.forEach((node, i) => { nameOff[i] = off; off += node.name.length; });
  nameOff[n] = off;
  const hardlinks: Array<[number, number]> = [];
  const refusals: Array<[number, number]> = [];
  let dataless = 0;
  order.forEach((node, i) => {
    if (node.family !== -1) hardlinks.push([i, node.family]);
    if (node.refusal !== 0) refusals.push([i, node.refusal]);
    if (node.dataless) dataless++;
  });
  return {
    parent: Uint32Array.from(parent),
    nameOff,
    names: new Uint8Array(Buffer.concat(order.map((node) => node.name))),
    kind: Uint8Array.from(order.map((node) => node.kind)),
    flags: Uint8Array.from(order.map((node) => (node.dataless ? FLAG_DATALESS : 0) | (node.refusal !== 0 ? FLAG_REFUSED_DIR : 0))),
    size: Float64Array.from(order.map((node) => node.size)),
    allocBytes: Float64Array.from(order.map((node) => node.alloc)),
    mtimeMs: Float64Array.from(order.map((node) => node.mtime)),
    atimeMs: Float64Array.from(order.map((node) => node.atime)),
    hardlinkNode: Uint32Array.from(hardlinks.map(([node]) => node)),
    hardlinkFamily: Uint32Array.from(hardlinks.map(([, family]) => family)),
    refusalNode: Uint32Array.from(refusals.map(([node]) => node)),
    refusalWhy: Uint8Array.from(refusals.map(([, why]) => why)),
    stats: {
      dirsListed, entries: n - 1, wallMs: 1, cpuSeconds: 0.001, fastPath: 'bulk', workersPeak: opts.workers, climbSteps: 0,
      deniedEntries: Math.floor(rng() * 3), unreadableEntries: Math.floor(rng() * 3), dataless,
    },
  };
}

/** Whether the columns' parents ever decrease: the workers interleaved, as the fuzz means them to. */
export function columnParentsDecrease(cols: WalkResult): boolean {
  for (let i = 2; i < cols.parent.length; i++) if (cols.parent[i] < cols.parent[i - 1]) return true;
  return false;
}

/* ------------------------------ a native store, as storeTake hands it over ------------------------------ */

export interface TakenSpec {
  /** Folders under the root that are listed, each holding `filesPerFolder` files. */
  folders: number;
  filesPerFolder: number;
  /** Refused folders under the root, after the listed ones: each one a `deniedDirs` entry. */
  denied: number;
  /** Every `textEvery`-th file has a name with an accent and a dot: a text candidate (0: none). */
  textEvery: number;
  /** Every `cloudEvery`-th file is a cloud candidate (0: none). */
  cloudEvery: number;
  seed: number;
  /** Rows of headroom past the tree. */
  headroom?: number;
}

/** Folder names: a third under a cloud provider's folder name, so the cloud rule names one. */
function folderName(i: number): string {
  switch (i % 6) {
    case 1: return `com~apple~CloudDocs ${i}`;
    case 3: return `OneDrive ${i}`;
    case 5: return `Dropbox ${i}`;
    default: return `d${i}`;
  }
}

/**
 * A native store for a tree numbered breadth-first: the root (0); the listed
 * folders (1 … folders); the refused ones after them, empty; then each listed
 * folder's files in turn. A third of the folders sit under a cloud provider's
 * name. Text candidates carry no extension and no container (the build leaves
 * them to Node); every fourth cloud candidate is already the walk's own
 * placeholder and every seventh a later name of a hard-linked file. One
 * sparse term `(0, total)`, as the build gives when the order cannot show.
 */
export function syntheticTaken(spec: TakenSpec): NativeStore {
  const rng = makeRng(spec.seed);
  const files = spec.folders * spec.filesPerFolder;
  const n = 1 + spec.folders + spec.denied + files;
  const capacity = n + (spec.headroom ?? 16);
  const parent = new Int32Array(capacity);
  const size = new Float64Array(capacity);
  const mtime = new Float64Array(capacity);
  const atime = new Float64Array(capacity);
  const flags = new Uint16Array(capacity);
  const ext = new Uint16Array(capacity);
  const childStart = new Uint32Array(capacity);
  const childCnt = new Uint32Array(capacity);
  const names: string[] = ['root'];
  const dir = Flag.Dir | Flag.HasChildArray;
  parent[0] = -1;
  flags[0] = dir;
  childStart[0] = 1;
  childCnt[0] = spec.folders + spec.denied;
  const firstFile = 1 + spec.folders + spec.denied;
  for (let f = 1; f <= spec.folders + spec.denied; f++) {
    const listed = f <= spec.folders;
    names.push(listed ? folderName(f) : `locked ${f}`);
    parent[f] = 0;
    flags[f] = dir;
    childStart[f] = listed ? firstFile + (f - 1) * spec.filesPerFolder : firstFile + files;
    childCnt[f] = listed ? spec.filesPerFolder : 0;
  }
  const textCandidates: number[] = [];
  const cloudCandidates: number[] = [];
  let walkPlaceholders = 0;
  let duplicates = 0;
  for (let k = 0; k < files; k++) {
    const id = firstFile + k;
    const folder = 1 + Math.floor(k / spec.filesPerFolder);
    parent[id] = folder;
    childStart[id] = n;
    size[id] = 1 + Math.floor(rng() * 5_000_000);
    if (spec.textEvery > 0 && k % spec.textEvery === 0) {
      names.push(`${['é', 'ü', '文'][k % 3]}${k}.${['TAR.GZ', 'Zip', 'txt'][k % 3]}`);
      textCandidates.push(id);
    } else {
      names.push(`f${k}.bin`);
      ext[id] = 1;
    }
    if (spec.cloudEvery > 0 && k % spec.cloudEvery === 0) {
      cloudCandidates.push(id);
      const c = cloudCandidates.length;
      if (c % 4 === 0) {
        flags[id] |= Flag.CloudPlaceholder;
        walkPlaceholders++;
      } else if (c % 7 === 0) {
        flags[id] |= Flag.HardlinkDup;
        duplicates++;
      }
    }
  }
  for (let id = 0; id < n; id++) {
    mtime[id] = 1_600_000_000_000 + Math.floor(rng() * 1e11);
    atime[id] = 1_600_000_000_000 + Math.floor(rng() * 1e11);
  }
  const encoder = new TextEncoder();
  const encoded = names.map((name) => encoder.encode(name));
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  encoded.forEach((bytes, id) => { nameOff[id] = at; at += bytes.length; });
  for (let id = n; id <= capacity; id++) nameOff[id] = at;
  const pool = new Uint8Array(at + 64);
  encoded.forEach((bytes, id) => pool.set(bytes, nameOff[id]));
  const deniedDirs = Array.from({ length: spec.denied }, (_, j) => 1 + spec.folders + j);
  return {
    n,
    capacity,
    parent,
    size,
    mtime,
    atime,
    flags,
    ext,
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names: pool,
    namesLen: at,
    childStart,
    childCnt,
    extDict: ['', 'bin'],
    extOverflowIds: new Uint32Array(0),
    extOverflowTexts: [],
    cloudCandidates: Uint32Array.from(cloudCandidates),
    textCandidates: Uint32Array.from(textCandidates),
    sparseTermIds: new Uint32Array([0]),
    sparseTermBytes: new Float64Array([4_096 * 3]),
    counters: {
      dirs: 1 + spec.folders + spec.denied,
      files,
      hardlinkedFiles: duplicates,
      hardlinkedBytes: duplicates * 1_000,
      cloudFiles: walkPlaceholders,
      cloudBytes: 0,
      sparseFiles: 2,
      sparseBytes: 4_096 * 3,
      slackBytes: 8_192,
      deniedDirs,
      vanishedDirs: 1,
      unreadableDirs: 2,
    },
    stats: {
      dirsListed: 1 + spec.folders, entries: n - 1, wallMs: 1, cpuSeconds: 0.25, fastPath: 'bulk', workersPeak: 4, climbSteps: 0,
      deniedEntries: 3, unreadableEntries: 1, dataless: walkPlaceholders,
    },
  };
}
