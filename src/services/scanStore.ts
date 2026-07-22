import { FileNode, ContainerKind } from '../models/types';
import { pruneTree, PruneResult, PruneOptions } from '../utils/pruneTree';

/**
 * ScanStore — the in-memory representation of one scan's tree.
 *
 * The browser only ever receives a tree pruned to a node budget; the
 * "millions of objects" problem lives entirely in the backend. This interface
 * is the narrow waist that lets the backend swap a tree of plain FileNode
 * objects (~330 bytes/node measured) for a packed Structure-of-Arrays store
 * (~40-60 bytes/node) without any API consumer noticing: at every boundary a
 * store materializes the exact same pruned FileNode JSON the frontend already
 * consumes — byte-identical, including property order.
 *
 * Contracts every implementation must honor:
 *
 *  - **Ids.** Every node has an integer id; the root's is `rootId`. Ids are
 *    stable only after `finalize()` — a packed implementation may renumber
 *    while flattening. Producers must not hold ids across finalize().
 *  - **Child order is insertion order.** pruneTree emits children in the
 *    array order the producer built, and that order rides into the wire JSON.
 *    Implementations must preserve it exactly — never re-sort storage.
 *  - **Absent optionals stay absent.** A field the producer never set must
 *    not materialize, not even as undefined-with-a-default.
 *  - **"Has children" is independent of type.** Expanded containers are
 *    `type: 'file'` nodes carrying virtual children; empty dirs carry an
 *    empty child list that must round-trip as `children: []`.
 *  - **Sizes are bytes in Float64** (exact within 2^53), timestamps are ms
 *    epoch in Float64. Never narrower.
 */

/* ------------------------------ Flags ------------------------------ */

/** Bit flags for the boolean facts of a node. Powers of two. */
export enum Flag {
  Dir = 1,
  /** A children array exists (dirs always; files only when a container was expanded). */
  HasChildArray = 2,
  Hidden = 4,
  HardlinkDup = 8,
  Symlink = 16,
  CloudPlaceholder = 32,
  GitRepo = 64,
  Virtual = 128,
  /** accessedAt was recorded for this node. */
  HasAccessed = 256,
  /** Tombstone: detached by removeNode(); skipped by every traversal. */
  Removed = 512,
}

export type CloudProviderName = 'icloud' | 'onedrive' | 'dropbox';

/** Everything a producer can say about one node, in one call. */
export interface NodeInput {
  name: string;
  isDir: boolean;
  /** Bytes for files; pass 0 for dirs — sumSizes() computes their totals. */
  size: number;
  /** Unix epoch milliseconds. */
  modifiedAt: number;
  isHidden: boolean;
  extension?: string;
  accessedAt?: number;
  hardlinkDuplicate?: boolean;
  isSymlink?: boolean;
  cloudPlaceholder?: boolean;
  cloudProvider?: CloudProviderName;
  gitRepo?: boolean;
  container?: ContainerKind;
  cloudId?: string;
  virtual?: boolean;
  logicalSize?: number;
}

export interface ScanStore {
  readonly rootId: number;
  /** Total ids ever assigned (tombstones included) — the iteration bound. */
  readonly count: number;
  /** The scan root's full path, verbatim. */
  readonly rootPath: string;
  /** The scan's path separator ('/' or '\\'), fixed per scan. */
  readonly sep: string;
  /** Bumped on every mutation — lets caches of materialized views invalidate. */
  readonly version: number;

  /* ---------- build (producers) ---------- */

  /** Append a child under `parent`; returns the new node's id. */
  addNode(parent: number, fields: NodeInput): number;
  /** Freeze the build: after this, ids are stable and reads are exact. */
  finalize(): void;
  /**
   * Bottom-up directory totals: dir size = Σ children sizes. Files keep their
   * own size even when they carry virtual children (containers). Idempotent;
   * call after the walk, before removals.
   */
  sumSizes(): void;

  /* ---------- read metadata (absent-aware) ---------- */

  name(id: number): string;
  /** Full path, reconstructed exactly as the producer would have written it. */
  path(id: number): string;
  size(id: number): number;
  isDir(id: number): boolean;
  nodeType(id: number): 'file' | 'dir';
  modifiedAt(id: number): number;
  flag(id: number, f: Flag): boolean;
  extension(id: number): string | undefined;
  accessedAt(id: number): number | undefined;
  container(id: number): ContainerKind | undefined;
  cloudProvider(id: number): CloudProviderName | undefined;
  cloudId(id: number): string | undefined;
  logicalSize(id: number): number | undefined;
  parent(id: number): number;

  /* ---------- mutate (walker gitRepo marking, watcher, cloud trash) ---------- */

  setSize(id: number, size: number): void;
  setModifiedAt(id: number, ms: number): void;
  setAccessedAt(id: number, ms: number | undefined): void;
  setFlag(id: number, f: Flag, on: boolean): void;
  /** Add `delta` to a node's size (watcher/cloud ancestor adjustments). */
  addToSize(id: number, delta: number): void;
  /** Detach a node (tombstone). Does NOT adjust ancestor sizes — callers do. */
  removeNode(id: number): void;

  /* ---------- traverse (id-based) ---------- */

  /** Live child count (tombstones excluded). */
  childCount(id: number): number;
  /** True when a children array exists — even an empty one. */
  hasChildArray(id: number): boolean;
  /** Live child ids in insertion order (bounded allocations only). */
  childIds(id: number): number[];
  /** Allocation-free iteration over live children in insertion order. */
  forEachChild(id: number, fn: (child: number) => void): void;
  /** First live child with this exact name, or -1. */
  childByName(id: number, name: string): number;
  /**
   * Visit every file at or below `id`, stopping at file nodes — a container
   * file is visited itself but its virtual listing is never descended into
   * (mirrors scanQueries.eachFile).
   */
  eachFile(id: number, fn: (fileId: number) => void): void;
  /** Visit `id` and everything below it (files, dirs, virtual entries). */
  eachNode(id: number, fn: (nodeId: number) => void): void;

  /* ---------- lookup ---------- */

  /** Id of the node with exactly this path, or -1. */
  findByPath(path: string): number;

  /* ---------- graft (containers, watcher-created files) ---------- */

  /**
   * Build `children` (FileNode subtrees, e.g. a container listing) into the
   * store and attach them under `parentId`, replacing nothing — the parent
   * must not already have live children. Sizes are copied verbatim; the
   * parent's own size is untouched.
   */
  ingestSubtree(parentId: number, children: FileNode[]): void;

  /* ---------- materialize bounded output (the API boundary) ---------- */

  /** Same result, invariants and child order as pruneTree on the object tree. */
  prune(id: number, opts: PruneOptions): PruneResult;
  /** Metadata-only node — exactly pruneTree(node, {maxNodes: 1}).root. */
  materialize(id: number): FileNode;
  /**
   * Optional fast path for prune: one childless FileNode with the exact
   * emitFileNode property order, reusing `knownPath` when the caller already
   * built it. Implementations may omit it; pruneStore falls back to accessors.
   */
  bareNode?(id: number, knownPath?: string): FileNode;
}

/* --------------------- shared FileNode emission --------------------- */

/**
 * Every field of one node, gathered for emission. `path` is already
 * reconstructed; children/pruned are appended by the prune walk afterwards.
 */
export interface NodeBag extends NodeInput {
  path: string;
}

/**
 * Build a FileNode with properties inserted in the exact order the original
 * producers used, so JSON.stringify output is byte-identical to the legacy
 * object tree. Three real-world orders exist:
 *
 *  - container-virtual entries:  … isHidden, virtual, logicalSize?, extension?
 *  - cloud nodes:                … isHidden, cloudId?, extension?
 *  - walker/gdu nodes:           … isHidden, accessedAt?, extension?,
 *                                container?, isSymlink?, cloudPlaceholder?,
 *                                cloudProvider?, hardlinkDuplicate?, gitRepo?
 *
 * The branches never overlap: virtual entries carry none of the walker flags,
 * and cloud nodes carry only cloudId/extension.
 */
export function emitFileNode(bag: NodeBag): FileNode {
  const node: FileNode = {
    name: bag.name,
    path: bag.path,
    size: bag.size,
    type: bag.isDir ? 'dir' : 'file',
    modifiedAt: bag.modifiedAt,
    isHidden: bag.isHidden,
  };
  if (bag.virtual) {
    node.virtual = true;
    if (bag.logicalSize !== undefined) node.logicalSize = bag.logicalSize;
    if (bag.extension !== undefined) node.extension = bag.extension;
    return node;
  }
  if (bag.cloudId !== undefined) node.cloudId = bag.cloudId;
  if (bag.accessedAt !== undefined) node.accessedAt = bag.accessedAt;
  if (bag.extension !== undefined) node.extension = bag.extension;
  if (bag.container !== undefined) node.container = bag.container;
  if (bag.isSymlink) node.isSymlink = true;
  if (bag.cloudPlaceholder) node.cloudPlaceholder = true;
  if (bag.cloudProvider !== undefined) node.cloudProvider = bag.cloudProvider;
  if (bag.hardlinkDuplicate) node.hardlinkDuplicate = true;
  if (bag.gitRepo) node.gitRepo = true;
  return node;
}

/** Child path = parent path + separator + name, except under a root like "/" or "C:\". */
export function joinPath(parentPath: string, sep: string, name: string): string {
  return parentPath.endsWith(sep) ? parentPath + name : parentPath + sep + name;
}

/* --------------------- shared store-side pruning --------------------- */

/**
 * pruneTree ported to store ids: identical heap discipline (a binary max-heap
 * with the same >=/> comparisons, fed jobs in the same order) so the pop
 * sequence — and therefore the emitted JSON — matches the object version
 * byte for byte.
 */
interface StoreJob {
  srcId: number;
  srcSize: number;
  copy: FileNode;
}

class StoreSizeHeap {
  private a: StoreJob[] = [];

  get size(): number {
    return this.a.length;
  }

  push(job: StoreJob): void {
    const a = this.a;
    a.push(job);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].srcSize >= a[i].srcSize) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): StoreJob | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as StoreJob;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].srcSize > a[m].srcSize) m = l;
        if (r < a.length && a[r].srcSize > a[m].srcSize) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Copy one store node to a childless FileNode (the copyNode equivalent). */
function materializeBare(store: ScanStore, id: number, knownPath?: string): FileNode {
  if (store.bareNode) return store.bareNode(id, knownPath);
  const bag: NodeBag = {
    name: store.name(id),
    path: knownPath ?? store.path(id),
    size: store.size(id),
    isDir: store.isDir(id),
    modifiedAt: store.modifiedAt(id),
    isHidden: store.flag(id, Flag.Hidden),
    extension: store.extension(id),
    accessedAt: store.accessedAt(id),
    hardlinkDuplicate: store.flag(id, Flag.HardlinkDup),
    isSymlink: store.flag(id, Flag.Symlink),
    cloudPlaceholder: store.flag(id, Flag.CloudPlaceholder),
    cloudProvider: store.cloudProvider(id),
    gitRepo: store.flag(id, Flag.GitRepo),
    container: store.container(id),
    cloudId: store.cloudId(id),
    virtual: store.flag(id, Flag.Virtual),
    logicalSize: store.logicalSize(id),
  };
  return emitFileNode(bag);
}

/** Expanded containers drill in like dirs (pruneTree.isExpandable on ids). */
function isExpandableId(store: ScanStore, id: number): boolean {
  return (
    (store.isDir(id) || store.container(id) !== undefined) &&
    store.hasChildArray(id) &&
    store.childCount(id) > 0
  );
}

/** pruneTree, but reading a ScanStore. Same invariants, same output bytes. */
export function pruneStore(store: ScanStore, id: number, options: PruneOptions): PruneResult {
  const maxNodes = Math.max(1, options.maxNodes);
  const rootCopy = materializeBare(store, id);
  let nodes = 1;
  let prunedDirs = 0;

  const heap = new StoreSizeHeap();

  const defer = (srcId: number, copy: FileNode): void => {
    if (!isExpandableId(store, srcId)) {
      if (store.hasChildArray(srcId) && store.childCount(srcId) === 0) copy.children = [];
      return;
    }
    copy.pruned = true;
    prunedDirs++;
    heap.push({ srcId, srcSize: store.size(srcId), copy });
  };

  defer(id, rootCopy);

  while (heap.size > 0 && nodes < maxNodes) {
    const { srcId, copy } = heap.pop() as StoreJob;

    const kidIds = store.childIds(srcId);
    // Children reuse the parent's already-built path — O(1) per node instead
    // of an O(depth) walk, which is what keeps prune fast on packed stores.
    const base = copy.path.endsWith(store.sep) ? copy.path : copy.path + store.sep;
    const copies = kidIds.map((k) => materializeBare(store, k, base + store.name(k)));
    copy.children = copies;
    delete copy.pruned; // invariant: never both
    prunedDirs--;
    nodes += copies.length;

    for (let i = 0; i < kidIds.length; i++) defer(kidIds[i], copies[i]);
  }

  return { root: rootCopy, nodes, prunedDirs };
}

/* ------------------- ObjectScanStore (reference) ------------------- */

/**
 * The oracle: wraps a real FileNode tree and answers every ScanStore method
 * by delegating to the exact logic the app runs today (pruneTree,
 * insertion-order children, literal paths). Trivially correct — used for
 * differential testing against PackedScanStore, and as the reference for
 * interface semantics.
 */
export class ObjectScanStore implements ScanStore {
  readonly rootId = 0;
  readonly rootPath: string;
  readonly sep: string;
  version = 0;

  private nodes: FileNode[] = [];
  private ids = new Map<FileNode, number>();
  private parents: number[] = [];
  private removed = new Set<number>();

  /** Build-mode: start from a root described like any other node. */
  constructor(rootPath: string, sep: string, rootFields: NodeInput) {
    this.rootPath = rootPath;
    this.sep = sep;
    const root = emitFileNode({ ...rootFields, path: rootPath });
    if (rootFields.isDir) root.children = [];
    this.register(root, -1);
  }

  /** Wrap-mode: index an existing tree (ids assigned in pre-order). */
  static wrap(root: FileNode, sep?: string): ObjectScanStore {
    const store = Object.create(ObjectScanStore.prototype) as ObjectScanStore;
    (store as { rootId: number }).rootId = 0;
    (store as { rootPath: string }).rootPath = root.path;
    (store as { sep: string }).sep = sep ?? (root.path.includes('\\') ? '\\' : '/');
    store.nodes = [];
    store.ids = new Map();
    store.parents = [];
    store.removed = new Set();
    store.register(root, -1);
    return store;
  }

  private register(node: FileNode, parent: number): number {
    const id = this.nodes.length;
    this.nodes.push(node);
    this.parents.push(parent);
    this.ids.set(node, id);
    if (node.children) for (const c of node.children) this.register(c, id);
    return id;
  }

  private node(id: number): FileNode {
    const n = this.nodes[id];
    if (!n) throw new RangeError(`ObjectScanStore: no node ${id}`);
    return n;
  }

  get count(): number {
    return this.nodes.length;
  }

  /* ---------- build ---------- */

  addNode(parent: number, fields: NodeInput): number {
    this.version++;
    const p = this.node(parent);
    const node = emitFileNode({ ...fields, path: joinPath(p.path, this.sep, fields.name) });
    if (fields.isDir) node.children = [];
    if (!p.children) p.children = [];
    p.children.push(node);
    return this.register(node, parent);
  }

  finalize(): void {
    /* object ids are stable from the start */
  }

  sumSizes(): void {
    this.version++;
    const sum = (n: FileNode): number => {
      if (n.type === 'file' || !n.children) return n.size;
      let total = 0;
      for (const c of n.children) total += sum(c);
      n.size = total;
      return total;
    };
    sum(this.node(this.rootId));
  }

  /* ---------- read ---------- */

  name(id: number): string {
    return this.node(id).name;
  }

  path(id: number): string {
    return this.node(id).path;
  }

  size(id: number): number {
    return this.node(id).size;
  }

  isDir(id: number): boolean {
    return this.node(id).type === 'dir';
  }

  nodeType(id: number): 'file' | 'dir' {
    return this.node(id).type;
  }

  modifiedAt(id: number): number {
    return this.node(id).modifiedAt;
  }

  flag(id: number, f: Flag): boolean {
    const n = this.node(id);
    switch (f) {
      case Flag.Dir: return n.type === 'dir';
      case Flag.HasChildArray: return n.children !== undefined;
      case Flag.Hidden: return n.isHidden;
      case Flag.HardlinkDup: return n.hardlinkDuplicate === true;
      case Flag.Symlink: return n.isSymlink === true;
      case Flag.CloudPlaceholder: return n.cloudPlaceholder === true;
      case Flag.GitRepo: return n.gitRepo === true;
      case Flag.Virtual: return n.virtual === true;
      case Flag.HasAccessed: return n.accessedAt !== undefined;
      case Flag.Removed: return this.removed.has(id);
      default: return false;
    }
  }

  extension(id: number): string | undefined {
    return this.node(id).extension;
  }

  accessedAt(id: number): number | undefined {
    return this.node(id).accessedAt;
  }

  container(id: number): ContainerKind | undefined {
    return this.node(id).container;
  }

  cloudProvider(id: number): CloudProviderName | undefined {
    return this.node(id).cloudProvider;
  }

  cloudId(id: number): string | undefined {
    return this.node(id).cloudId;
  }

  logicalSize(id: number): number | undefined {
    return this.node(id).logicalSize;
  }

  parent(id: number): number {
    return this.parents[id] ?? -1;
  }

  /* ---------- mutate ---------- */

  setSize(id: number, size: number): void {
    this.version++;
    this.node(id).size = size;
  }

  setModifiedAt(id: number, ms: number): void {
    this.version++;
    this.node(id).modifiedAt = ms;
  }

  setAccessedAt(id: number, ms: number | undefined): void {
    this.version++;
    const n = this.node(id);
    if (ms === undefined) delete n.accessedAt;
    else n.accessedAt = ms;
  }

  setFlag(id: number, f: Flag, on: boolean): void {
    this.version++;
    const n = this.node(id);
    switch (f) {
      case Flag.Hidden: n.isHidden = on; break;
      case Flag.HardlinkDup: if (on) n.hardlinkDuplicate = true; else delete n.hardlinkDuplicate; break;
      case Flag.Symlink: if (on) n.isSymlink = true; else delete n.isSymlink; break;
      case Flag.CloudPlaceholder: if (on) n.cloudPlaceholder = true; else delete n.cloudPlaceholder; break;
      case Flag.GitRepo: if (on) n.gitRepo = true; else delete n.gitRepo; break;
      case Flag.Virtual: if (on) n.virtual = true; else delete n.virtual; break;
      default:
        throw new Error(`setFlag: ${Flag[f]} is structural, not settable`);
    }
  }

  addToSize(id: number, delta: number): void {
    this.version++;
    this.node(id).size += delta;
  }

  removeNode(id: number): void {
    if (id === this.rootId) throw new Error('removeNode: cannot remove the root');
    if (this.removed.has(id)) return;
    this.version++;
    this.removed.add(id);
    const target = this.node(id);
    const parent = this.nodes[this.parents[id]];
    if (parent?.children) {
      parent.children = parent.children.filter((c) => c !== target);
    }
  }

  /* ---------- traverse ---------- */

  childCount(id: number): number {
    return this.node(id).children?.length ?? 0;
  }

  hasChildArray(id: number): boolean {
    return this.node(id).children !== undefined;
  }

  childIds(id: number): number[] {
    const kids = this.node(id).children;
    if (!kids) return [];
    return kids.map((c) => this.ids.get(c) as number);
  }

  forEachChild(id: number, fn: (child: number) => void): void {
    const kids = this.node(id).children;
    if (!kids) return;
    for (const c of kids) fn(this.ids.get(c) as number);
  }

  childByName(id: number, name: string): number {
    const kids = this.node(id).children;
    if (!kids) return -1;
    for (const c of kids) {
      if (c.name === name) return this.ids.get(c) as number;
    }
    return -1;
  }

  eachFile(id: number, fn: (fileId: number) => void): void {
    const visit = (n: FileNode): void => {
      if (n.type === 'file') {
        fn(this.ids.get(n) as number);
        return;
      }
      if (n.children) for (const c of n.children) visit(c);
    };
    visit(this.node(id));
  }

  eachNode(id: number, fn: (nodeId: number) => void): void {
    const stack: FileNode[] = [this.node(id)];
    while (stack.length) {
      const n = stack.pop()!;
      fn(this.ids.get(n) as number);
      if (n.children) {
        for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
      }
    }
  }

  /* ---------- lookup ---------- */

  findByPath(path: string): number {
    const root = this.node(this.rootId);
    const found = this.findIn(root, path);
    return found ? (this.ids.get(found) as number) : -1;
  }

  /** The exact findNodeByPath logic from utils/treemap. */
  private findIn(root: FileNode, targetPath: string): FileNode | null {
    if (root.path === targetPath) return root;
    if ((root.type !== 'dir' && !root.container) || !root.children) return null;
    for (const child of root.children) {
      if (targetPath === child.path || targetPath.startsWith(child.path + this.sepOf(child.path))) {
        const found = this.findIn(child, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  private sepOf(p: string): string {
    return p.includes('\\') ? '\\' : '/';
  }

  /* ---------- graft ---------- */

  ingestSubtree(parentId: number, children: FileNode[]): void {
    this.version++;
    const parent = this.node(parentId);
    if (parent.children && parent.children.length > 0) {
      throw new Error('ingestSubtree: parent already has children');
    }
    parent.children = children;
    for (const c of children) this.register(c, parentId);
  }

  /* ---------- materialize ---------- */

  prune(id: number, opts: PruneOptions): PruneResult {
    // Delegate to the battle-tested object implementation — this is the oracle.
    return pruneTree(this.node(id), opts);
  }

  materialize(id: number): FileNode {
    return pruneTree(this.node(id), { maxNodes: 1 }).root;
  }
}

/* --------------------- PackedScanStore (SoA) --------------------- */

const CONTAINER_KINDS: readonly ContainerKind[] = ['zip', 'tar', 'tgz', 'iso', 'dmg', 'photos', 'docker'];
const CONTAINER_ID: Record<string, number> = { zip: 1, tar: 2, tgz: 3, iso: 4, dmg: 5, photos: 6, docker: 7 };
const CLOUD_PROVIDERS: readonly CloudProviderName[] = ['icloud', 'onedrive', 'dropbox'];
const CLOUD_ID: Record<string, number> = { icloud: 1, onedrive: 2, dropbox: 3 };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const INITIAL_CAP = 1024;
const INITIAL_POOL = 16 * 1024;

/**
 * The packed Structure-of-Arrays store: one scan's whole tree in a handful of
 * typed arrays (~40-60 bytes/node measured vs ~330 for the object tree), so a
 * 100M-entry scan fits in RAM. Pure JS + TypedArrays — no native modules.
 *
 * Layout after finalize():
 *  - Nodes are renumbered breadth-first, so every node's children occupy one
 *    consecutive id range (childStart/childCount — no child list needed) and
 *    `parent[id] < id` always holds, which makes sumSizes a single reverse
 *    linear pass with no recursion and no stack-overflow risk on deep trees.
 *  - Names live in one UTF-8 pool; a node's name is nameOff[id]..nameOff[id+1].
 *    Paths are never stored — they reconstruct by walking parent links, which
 *    removes the single biggest memory cost of the object tree.
 *  - Rare fields (accessedAt, logicalSize, cloudId) are sparse or lazily
 *    allocated so scans that never produce them never pay for them.
 *  - Nodes added after finalize (container grafts, watcher-created files) hang
 *    off a per-parent overflow list, appended after the ranged children so
 *    insertion order — and therefore emitted JSON — is preserved.
 *
 * Ids are only stable after finalize(): producers must not hold ids across it.
 */
export class PackedScanStore implements ScanStore {
  readonly rootId = 0;
  readonly rootPath: string;
  readonly sep: string;
  version = 0;

  private n = 0;
  private cap = 0;
  private finalized = false;

  private parentArr!: Int32Array;
  private sizeArr!: Float64Array;
  private mtimeArr!: Float64Array;
  private flagsArr!: Uint16Array;
  private extArr!: Uint16Array;
  private containerArr!: Uint8Array;
  private cloudProvArr!: Uint8Array;
  private nameOff!: Uint32Array; // length cap+1; name i = bytes [nameOff[i], nameOff[i+1])
  private nameBytes!: Uint8Array;
  private namePoolLen = 0;

  /** Build-time adjacency (freed by finalize). */
  private firstChild!: Int32Array | null;
  private lastChild!: Int32Array | null;
  private nextSibling!: Int32Array | null;

  /** Post-finalize adjacency: consecutive ranges + per-parent overflow. */
  private childStart!: Uint32Array;
  private childCnt!: Uint32Array;
  private extraChildren = new Map<number, number[]>();
  /** Tombstoned children per parent, so childCount stays O(1)-ish honest. */
  private removedUnder = new Map<number, number>();

  /** Lazily allocated: only walker scans record atime. */
  private atimeArr: Float64Array | null = null;
  private logicalMap = new Map<number, number>();
  private cloudIdMap = new Map<number, string>();

  /** Interned extensions; index 0 = "no extension". */
  private extDict: string[] = [''];
  private extLookup = new Map<string, number>();
  /** Overflow for the (never observed) >65535-distinct-extensions case. */
  private extOverflow: Map<number, string> | null = null;

  constructor(rootPath: string, sep: string, rootFields: NodeInput) {
    this.rootPath = rootPath;
    this.sep = sep;
    this.allocate(INITIAL_CAP);
    this.firstChild = new Int32Array(INITIAL_CAP).fill(-1);
    this.lastChild = new Int32Array(INITIAL_CAP).fill(-1);
    this.nextSibling = new Int32Array(INITIAL_CAP).fill(-1);
    this.writeNode(-1, rootFields);
  }

  get count(): number {
    return this.n;
  }

  /* ---------- storage plumbing ---------- */

  private allocate(cap: number): void {
    this.cap = cap;
    this.parentArr = new Int32Array(cap);
    this.sizeArr = new Float64Array(cap);
    this.mtimeArr = new Float64Array(cap);
    this.flagsArr = new Uint16Array(cap);
    this.extArr = new Uint16Array(cap);
    this.containerArr = new Uint8Array(cap);
    this.cloudProvArr = new Uint8Array(cap);
    this.nameOff = new Uint32Array(cap + 1);
    this.nameBytes = new Uint8Array(INITIAL_POOL);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const copy = <T extends Int32Array | Float64Array | Uint16Array | Uint8Array | Uint32Array>(
      src: T,
      dst: T,
    ): T => {
      dst.set(src as never);
      return dst;
    };
    this.parentArr = copy(this.parentArr, new Int32Array(cap));
    this.sizeArr = copy(this.sizeArr, new Float64Array(cap));
    this.mtimeArr = copy(this.mtimeArr, new Float64Array(cap));
    this.flagsArr = copy(this.flagsArr, new Uint16Array(cap));
    this.extArr = copy(this.extArr, new Uint16Array(cap));
    this.containerArr = copy(this.containerArr, new Uint8Array(cap));
    this.cloudProvArr = copy(this.cloudProvArr, new Uint8Array(cap));
    this.nameOff = copy(this.nameOff, new Uint32Array(cap + 1));
    if (this.atimeArr) this.atimeArr = copy(this.atimeArr, new Float64Array(cap));
    if (this.finalized) {
      this.childStart = copy(this.childStart, new Uint32Array(cap));
      this.childCnt = copy(this.childCnt, new Uint32Array(cap));
    } else {
      this.firstChild = copy(this.firstChild as Int32Array, new Int32Array(cap).fill(-1));
      this.lastChild = copy(this.lastChild as Int32Array, new Int32Array(cap).fill(-1));
      this.nextSibling = copy(this.nextSibling as Int32Array, new Int32Array(cap).fill(-1));
    }
    this.cap = cap;
  }

  private appendName(name: string): void {
    // encodeInto with guaranteed headroom (UTF-8 is at most 3 bytes per UTF-16 unit).
    const need = this.namePoolLen + name.length * 3;
    if (need > this.nameBytes.length) {
      let len = this.nameBytes.length;
      while (len < need) len *= 2;
      const bigger = new Uint8Array(len);
      bigger.set(this.nameBytes);
      this.nameBytes = bigger;
    }
    const { written } = utf8Encoder.encodeInto(name, this.nameBytes.subarray(this.namePoolLen));
    this.namePoolLen += written;
  }

  private internExt(ext: string | undefined, id: number): number {
    if (ext === undefined) return 0;
    let extId = this.extLookup.get(ext);
    if (extId === undefined) {
      if (this.extDict.length >= 0xffff) {
        (this.extOverflow ??= new Map()).set(id, ext);
        return 0xffff;
      }
      extId = this.extDict.length;
      this.extDict.push(ext);
      this.extLookup.set(ext, extId);
    }
    return extId;
  }

  private writeNode(parent: number, fields: NodeInput): number {
    if (this.n === this.cap) this.grow();
    const id = this.n++;
    this.parentArr[id] = parent;
    this.sizeArr[id] = fields.size;
    this.mtimeArr[id] = fields.modifiedAt;
    let flags = 0;
    if (fields.isDir) flags |= Flag.Dir | Flag.HasChildArray;
    if (fields.isHidden) flags |= Flag.Hidden;
    if (fields.hardlinkDuplicate) flags |= Flag.HardlinkDup;
    if (fields.isSymlink) flags |= Flag.Symlink;
    if (fields.cloudPlaceholder) flags |= Flag.CloudPlaceholder;
    if (fields.gitRepo) flags |= Flag.GitRepo;
    if (fields.virtual) flags |= Flag.Virtual;
    if (fields.accessedAt !== undefined) {
      flags |= Flag.HasAccessed;
      (this.atimeArr ??= new Float64Array(this.cap))[id] = fields.accessedAt;
    }
    this.flagsArr[id] = flags;
    this.extArr[id] = this.internExt(fields.extension, id);
    this.containerArr[id] = fields.container ? (CONTAINER_ID[fields.container] ?? 0) : 0;
    this.cloudProvArr[id] = fields.cloudProvider ? (CLOUD_ID[fields.cloudProvider] ?? 0) : 0;
    if (fields.logicalSize !== undefined) this.logicalMap.set(id, fields.logicalSize);
    if (fields.cloudId !== undefined) this.cloudIdMap.set(id, fields.cloudId);
    this.appendName(fields.name);
    this.nameOff[id + 1] = this.namePoolLen;
    return id;
  }

  private check(id: number): void {
    if (id < 0 || id >= this.n) throw new RangeError(`PackedScanStore: no node ${id}`);
  }

  /* ---------- build ---------- */

  addNode(parent: number, fields: NodeInput): number {
    this.version++;
    this.check(parent);
    const id = this.writeNode(parent, fields);
    if (this.finalized) {
      let extras = this.extraChildren.get(parent);
      if (!extras) {
        extras = [];
        this.extraChildren.set(parent, extras);
      }
      extras.push(id);
    } else {
      const last = (this.lastChild as Int32Array)[parent];
      if (last === -1) (this.firstChild as Int32Array)[parent] = id;
      else (this.nextSibling as Int32Array)[last] = id;
      (this.lastChild as Int32Array)[parent] = id;
    }
    return id;
  }

  finalize(): void {
    if (this.finalized) return;
    const n = this.n;
    const first = this.firstChild as Int32Array;
    const next = this.nextSibling as Int32Array;

    // Breadth-first renumbering: children get consecutive new ids, assigned
    // as their parent is visited, so ranges need no separate child list.
    const bfsOld = new Uint32Array(n); // old id at each new position
    const oldToNew = new Int32Array(n);
    const childStart = new Uint32Array(n);
    const childCnt = new Uint32Array(n);
    let assigned = 1;
    for (let newIdx = 0; newIdx < n; newIdx++) {
      const old = bfsOld[newIdx];
      childStart[newIdx] = assigned;
      let cnt = 0;
      for (let c = first[old]; c !== -1; c = next[c]) {
        oldToNew[c] = assigned;
        bfsOld[assigned] = c;
        assigned++;
        cnt++;
      }
      childCnt[newIdx] = cnt;
    }

    // Permute every column into right-sized arrays (also trims capacity).
    const parentArr = new Int32Array(n);
    const sizeArr = new Float64Array(n);
    const mtimeArr = new Float64Array(n);
    const flagsArr = new Uint16Array(n);
    const extArr = new Uint16Array(n);
    const containerArr = new Uint8Array(n);
    const cloudProvArr = new Uint8Array(n);
    const nameOff = new Uint32Array(n + 1);
    const nameBytes = new Uint8Array(this.namePoolLen);
    const atimeArr = this.atimeArr ? new Float64Array(n) : null;

    let namePos = 0;
    for (let newIdx = 0; newIdx < n; newIdx++) {
      const old = bfsOld[newIdx];
      parentArr[newIdx] = old === 0 ? -1 : oldToNew[this.parentArr[old]];
      sizeArr[newIdx] = this.sizeArr[old];
      mtimeArr[newIdx] = this.mtimeArr[old];
      flagsArr[newIdx] = this.flagsArr[old];
      extArr[newIdx] = this.extArr[old];
      containerArr[newIdx] = this.containerArr[old];
      cloudProvArr[newIdx] = this.cloudProvArr[old];
      if (atimeArr) atimeArr[newIdx] = (this.atimeArr as Float64Array)[old];
      const from = this.nameOff[old];
      const to = this.nameOff[old + 1];
      nameBytes.set(this.nameBytes.subarray(from, to), namePos);
      nameOff[newIdx] = namePos;
      namePos += to - from;
    }
    nameOff[n] = namePos;

    if (this.logicalMap.size > 0) {
      const rekeyed = new Map<number, number>();
      for (const [old, v] of this.logicalMap) rekeyed.set(oldToNew[old], v);
      this.logicalMap = rekeyed;
    }
    if (this.cloudIdMap.size > 0) {
      const rekeyed = new Map<number, string>();
      for (const [old, v] of this.cloudIdMap) rekeyed.set(oldToNew[old], v);
      this.cloudIdMap = rekeyed;
    }
    if (this.extOverflow && this.extOverflow.size > 0) {
      const rekeyed = new Map<number, string>();
      for (const [old, v] of this.extOverflow) rekeyed.set(oldToNew[old], v);
      this.extOverflow = rekeyed;
    }

    this.parentArr = parentArr;
    this.sizeArr = sizeArr;
    this.mtimeArr = mtimeArr;
    this.flagsArr = flagsArr;
    this.extArr = extArr;
    this.containerArr = containerArr;
    this.cloudProvArr = cloudProvArr;
    this.nameOff = nameOff;
    this.nameBytes = nameBytes;
    this.namePoolLen = namePos;
    this.atimeArr = atimeArr;
    this.childStart = childStart;
    this.childCnt = childCnt;
    this.cap = n;
    this.firstChild = null;
    this.lastChild = null;
    this.nextSibling = null;
    this.finalized = true;
  }

  sumSizes(): void {
    this.version++;
    this.requireFinal();
    const n = this.n;
    const flags = this.flagsArr;
    const sizes = this.sizeArr;
    const parents = this.parentArr;
    for (let id = 0; id < n; id++) {
      if (flags[id] & Flag.Dir) sizes[id] = 0;
    }
    // parent[id] < id (BFS order; post-finalize appends also satisfy it), so
    // one reverse pass sums every directory bottom-up. A child adds to its
    // parent only when the parent is a dir — a container file keeps its own
    // disk size no matter what virtual listing hangs beneath it.
    for (let id = n - 1; id >= 1; id--) {
      if (flags[id] & Flag.Removed) continue;
      const p = parents[id];
      if (flags[p] & Flag.Dir) sizes[p] += sizes[id];
    }
  }

  private requireFinal(): void {
    if (!this.finalized) throw new Error('PackedScanStore: finalize() first');
  }

  /* ---------- read ---------- */

  name(id: number): string {
    this.check(id);
    const from = this.nameOff[id];
    const to = this.nameOff[id + 1];
    const len = to - from;
    // Fast path: short ASCII names decode without a TextDecoder call.
    if (len <= 32) {
      let ascii = true;
      for (let i = from; i < to; i++) {
        if (this.nameBytes[i] > 127) {
          ascii = false;
          break;
        }
      }
      if (ascii) {
        let s = '';
        for (let i = from; i < to; i++) s += String.fromCharCode(this.nameBytes[i]);
        return s;
      }
    }
    return utf8Decoder.decode(this.nameBytes.subarray(from, to));
  }

  path(id: number): string {
    this.check(id);
    if (id === this.rootId) return this.rootPath;
    const segments: string[] = [];
    for (let cur = id; cur !== this.rootId; cur = this.parentArr[cur]) {
      segments.push(this.name(cur));
    }
    segments.reverse();
    const base = this.rootPath.endsWith(this.sep) ? this.rootPath : this.rootPath + this.sep;
    return base + segments.join(this.sep);
  }

  size(id: number): number {
    this.check(id);
    return this.sizeArr[id];
  }

  isDir(id: number): boolean {
    this.check(id);
    return (this.flagsArr[id] & Flag.Dir) !== 0;
  }

  nodeType(id: number): 'file' | 'dir' {
    return this.isDir(id) ? 'dir' : 'file';
  }

  modifiedAt(id: number): number {
    this.check(id);
    return this.mtimeArr[id];
  }

  flag(id: number, f: Flag): boolean {
    this.check(id);
    return (this.flagsArr[id] & f) !== 0;
  }

  extension(id: number): string | undefined {
    this.check(id);
    const extId = this.extArr[id];
    if (extId === 0) return undefined;
    if (extId === 0xffff && this.extOverflow) {
      const hit = this.extOverflow.get(id);
      if (hit !== undefined) return hit;
    }
    return this.extDict[extId];
  }

  accessedAt(id: number): number | undefined {
    this.check(id);
    if (!(this.flagsArr[id] & Flag.HasAccessed) || !this.atimeArr) return undefined;
    return this.atimeArr[id];
  }

  container(id: number): ContainerKind | undefined {
    this.check(id);
    const k = this.containerArr[id];
    return k === 0 ? undefined : CONTAINER_KINDS[k - 1];
  }

  cloudProvider(id: number): CloudProviderName | undefined {
    this.check(id);
    const p = this.cloudProvArr[id];
    return p === 0 ? undefined : CLOUD_PROVIDERS[p - 1];
  }

  cloudId(id: number): string | undefined {
    this.check(id);
    return this.cloudIdMap.get(id);
  }

  logicalSize(id: number): number | undefined {
    this.check(id);
    return this.logicalMap.get(id);
  }

  parent(id: number): number {
    this.check(id);
    return this.parentArr[id];
  }

  /* ---------- mutate ---------- */

  setSize(id: number, size: number): void {
    this.version++;
    this.check(id);
    this.sizeArr[id] = size;
  }

  setModifiedAt(id: number, ms: number): void {
    this.version++;
    this.check(id);
    this.mtimeArr[id] = ms;
  }

  setAccessedAt(id: number, ms: number | undefined): void {
    this.version++;
    this.check(id);
    if (ms === undefined) {
      this.flagsArr[id] &= ~Flag.HasAccessed;
      return;
    }
    (this.atimeArr ??= new Float64Array(this.cap))[id] = ms;
    this.flagsArr[id] |= Flag.HasAccessed;
  }

  setFlag(id: number, f: Flag, on: boolean): void {
    this.version++;
    this.check(id);
    if (f === Flag.Dir || f === Flag.HasChildArray || f === Flag.HasAccessed || f === Flag.Removed) {
      throw new Error(`setFlag: flag ${f} is structural, not settable`);
    }
    if (on) this.flagsArr[id] |= f;
    else this.flagsArr[id] &= ~f;
  }

  addToSize(id: number, delta: number): void {
    this.version++;
    this.check(id);
    this.sizeArr[id] += delta;
  }

  removeNode(id: number): void {
    this.version++;
    this.check(id);
    if (id === this.rootId) throw new Error('removeNode: cannot remove the root');
    if (this.flagsArr[id] & Flag.Removed) return;
    this.flagsArr[id] |= Flag.Removed;
    const p = this.parentArr[id];
    this.removedUnder.set(p, (this.removedUnder.get(p) ?? 0) + 1);
  }

  /* ---------- traverse ---------- */

  childCount(id: number): number {
    this.check(id);
    this.requireFinal();
    const ranged = id < this.childStart.length ? this.childCnt[id] : 0;
    const extras = this.extraChildren.get(id)?.length ?? 0;
    return ranged + extras - (this.removedUnder.get(id) ?? 0);
  }

  hasChildArray(id: number): boolean {
    this.check(id);
    return (this.flagsArr[id] & Flag.HasChildArray) !== 0;
  }

  childIds(id: number): number[] {
    const out: number[] = [];
    this.forEachChild(id, (c) => out.push(c));
    return out;
  }

  forEachChild(id: number, fn: (child: number) => void): void {
    this.check(id);
    this.requireFinal();
    const flags = this.flagsArr;
    if (id < this.childStart.length) {
      const start = this.childStart[id];
      const end = start + this.childCnt[id];
      for (let c = start; c < end; c++) {
        if (!(flags[c] & Flag.Removed)) fn(c);
      }
    }
    const extras = this.extraChildren.get(id);
    if (extras) {
      for (const c of extras) {
        if (!(flags[c] & Flag.Removed)) fn(c);
      }
    }
  }

  childByName(id: number, name: string): number {
    this.check(id);
    this.requireFinal();
    const bytes = utf8Encoder.encode(name);
    let hit = -1;
    this.forEachChild(id, (c) => {
      if (hit === -1 && this.nameEquals(c, bytes)) hit = c;
    });
    return hit;
  }

  private nameEquals(id: number, bytes: Uint8Array): boolean {
    const from = this.nameOff[id];
    if (this.nameOff[id + 1] - from !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
      if (this.nameBytes[from + i] !== bytes[i]) return false;
    }
    return true;
  }

  eachFile(id: number, fn: (fileId: number) => void): void {
    this.check(id);
    this.requireFinal();
    // Iterative pre-order matching the recursive reference: files are visited
    // and never descended into, so container listings stay invisible.
    const stack: number[] = [id];
    while (stack.length) {
      const cur = stack.pop() as number;
      if (!(this.flagsArr[cur] & Flag.Dir)) {
        fn(cur);
        continue;
      }
      const kids = this.childIds(cur);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  eachNode(id: number, fn: (nodeId: number) => void): void {
    this.check(id);
    this.requireFinal();
    const stack: number[] = [id];
    while (stack.length) {
      const cur = stack.pop() as number;
      fn(cur);
      const kids = this.childIds(cur);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  /* ---------- lookup ---------- */

  findByPath(path: string): number {
    this.requireFinal();
    if (path === this.rootPath) return this.rootId;
    const base = this.rootPath.endsWith(this.sep) ? this.rootPath : this.rootPath + this.sep;
    if (!path.startsWith(base)) return -1;
    const segments = path.slice(base.length).split(this.sep).map((s) => utf8Encoder.encode(s));
    if (segments.length === 0) return -1;

    // Explicit-stack DFS with sibling backtracking (duplicate names resolve
    // exactly as findNodeByPath does: first matching child whose subtree
    // resolves wins), and no recursion so depth can't overflow the stack.
    interface Frame {
      node: number;
      /** Candidate children of `node` matching segments[depth], in order. */
      candidates: number[];
      next: number;
    }
    const candidatesFor = (node: number, depth: number): number[] => {
      // Only dirs and containers can be descended into (findNodeByPath's guard).
      if (!(this.flagsArr[node] & Flag.Dir) && this.containerArr[node] === 0) return [];
      if (!(this.flagsArr[node] & Flag.HasChildArray)) return [];
      const seg = segments[depth];
      const out: number[] = [];
      this.forEachChild(node, (c) => {
        if (this.nameEquals(c, seg)) out.push(c);
      });
      return out;
    };

    const stack: Frame[] = [{ node: this.rootId, candidates: candidatesFor(this.rootId, 0), next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.candidates.length) {
        stack.pop();
        continue;
      }
      const child = frame.candidates[frame.next++];
      if (stack.length === segments.length) return child;
      stack.push({ node: child, candidates: candidatesFor(child, stack.length), next: 0 });
    }
    return -1;
  }

  /* ---------- graft ---------- */

  ingestSubtree(parentId: number, children: FileNode[]): void {
    this.version++;
    this.check(parentId);
    this.requireFinal();
    if (this.childCount(parentId) > 0) {
      throw new Error('ingestSubtree: parent already has children');
    }
    this.flagsArr[parentId] |= Flag.HasChildArray;
    const graft = (parent: number, node: FileNode): void => {
      const id = this.addNode(parent, fileNodeToInput(node));
      if (node.children) {
        this.flagsArr[id] |= Flag.HasChildArray;
        for (const c of node.children) graft(id, c);
      }
    };
    for (const c of children) graft(parentId, c);
  }

  /* ---------- materialize ---------- */

  prune(id: number, opts: PruneOptions): PruneResult {
    this.check(id);
    this.requireFinal();
    return pruneStore(this, id, opts);
  }

  materialize(id: number): FileNode {
    return this.prune(id, { maxNodes: 1 }).root;
  }

  /**
   * Column-direct materialization for prune's hot loop — no accessor calls,
   * no intermediate bag. Property order matches emitFileNode exactly (the
   * differential fuzz compares the two byte for byte).
   */
  bareNode(id: number, knownPath?: string): FileNode {
    const flags = this.flagsArr[id];
    const node: FileNode = {
      name: this.name(id),
      path: knownPath ?? this.path(id),
      size: this.sizeArr[id],
      type: flags & Flag.Dir ? 'dir' : 'file',
      modifiedAt: this.mtimeArr[id],
      isHidden: (flags & Flag.Hidden) !== 0,
    };
    if (flags & Flag.Virtual) {
      node.virtual = true;
      const logical = this.logicalMap.get(id);
      if (logical !== undefined) node.logicalSize = logical;
      const ext = this.extArr[id];
      if (ext !== 0) node.extension = this.extension(id);
      return node;
    }
    const cid = this.cloudIdMap.get(id);
    if (cid !== undefined) node.cloudId = cid;
    if (flags & Flag.HasAccessed && this.atimeArr) node.accessedAt = this.atimeArr[id];
    const ext = this.extArr[id];
    if (ext !== 0) node.extension = this.extension(id);
    const kind = this.containerArr[id];
    if (kind !== 0) node.container = CONTAINER_KINDS[kind - 1];
    if (flags & Flag.Symlink) node.isSymlink = true;
    if (flags & Flag.CloudPlaceholder) node.cloudPlaceholder = true;
    const prov = this.cloudProvArr[id];
    if (prov !== 0) node.cloudProvider = CLOUD_PROVIDERS[prov - 1];
    if (flags & Flag.HardlinkDup) node.hardlinkDuplicate = true;
    if (flags & Flag.GitRepo) node.gitRepo = true;
    return node;
  }
}

/** Every FileNode field, restated as a NodeInput (graft/cache ingestion). */
export function fileNodeToInput(n: FileNode): NodeInput {
  return {
    name: n.name,
    isDir: n.type === 'dir',
    size: n.size,
    modifiedAt: n.modifiedAt,
    isHidden: n.isHidden,
    extension: n.extension,
    accessedAt: n.accessedAt,
    hardlinkDuplicate: n.hardlinkDuplicate,
    isSymlink: n.isSymlink,
    cloudPlaceholder: n.cloudPlaceholder,
    cloudProvider: n.cloudProvider,
    gitRepo: n.gitRepo,
    container: n.container,
    cloudId: n.cloudId,
    virtual: n.virtual,
    logicalSize: n.logicalSize,
  };
}
