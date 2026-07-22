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
function materializeBare(store: ScanStore, id: number): FileNode {
  const bag: NodeBag = {
    name: store.name(id),
    path: store.path(id),
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
    const copies = kidIds.map((k) => materializeBare(store, k));
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
    this.node(id).size = size;
  }

  setModifiedAt(id: number, ms: number): void {
    this.node(id).modifiedAt = ms;
  }

  setAccessedAt(id: number, ms: number | undefined): void {
    const n = this.node(id);
    if (ms === undefined) delete n.accessedAt;
    else n.accessedAt = ms;
  }

  setFlag(id: number, f: Flag, on: boolean): void {
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
    this.node(id).size += delta;
  }

  removeNode(id: number): void {
    if (id === this.rootId) throw new Error('removeNode: cannot remove the root');
    if (this.removed.has(id)) return;
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
