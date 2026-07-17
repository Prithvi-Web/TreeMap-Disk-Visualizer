import { FileNode } from '../models/types';

/**
 * Bound a scanned tree to a payload the UI can actually hold.
 *
 * A full tree of ~3.5M+ nodes cannot even be serialized (V8 caps a single
 * string at ~512 MB), and the browser cannot hold one regardless. So the tree
 * that crosses to the UI is pruned to a node budget, and directories whose
 * children were withheld are marked `pruned` so the client can fetch them on
 * demand via the subtree endpoint.
 *
 * Two invariants make this safe for the UI to consume:
 *
 *  1. **Whole-directory granularity.** If a returned directory has `children`,
 *     that array holds *every* child of the real directory. A folder is never
 *     shown half-empty, and a node never carries both `children` and `pruned`.
 *  2. **Sizes stay exact.** `size` is copied from the real scan, so a pruned
 *     directory still reports its true recursive total. Only the *detail*
 *     below it is missing, never the magnitude.
 *
 * Directories are expanded largest-first, so the big things a disk tool exists
 * to find are present at every depth, and what gets withheld is small corners
 * that are cheap to fetch if the user ever looks at them.
 */

export interface PruneOptions {
  /**
   * Soft cap on emitted nodes. A directory's children are all-or-nothing
   * (invariant 1), so the result can overshoot by at most the fanout of the
   * last directory expanded.
   */
  maxNodes: number;
}

export interface PruneResult {
  root: FileNode;
  /** Nodes in the returned tree. */
  nodes: number;
  /** Directories marked `pruned` — i.e. whose children were withheld. */
  prunedDirs: number;
}

/**
 * Expanded containers (zip/tar/dmg…) are file nodes carrying virtual children,
 * and drill into exactly like directories — treemap.ts treats them the same.
 */
function isExpandable(n: FileNode): boolean {
  return (n.type === 'dir' || !!n.container) && !!n.children && n.children.length > 0;
}

/** Copy a node without its children. Spread keeps future FileNode fields. */
function copyNode(n: FileNode): FileNode {
  const { children, ...rest } = n;
  void children;
  return { ...rest };
}

interface Job {
  src: FileNode;
  copy: FileNode;
}

/** Binary max-heap on subtree size — expands the biggest directory first. */
class SizeHeap {
  private a: Job[] = [];

  get size(): number {
    return this.a.length;
  }

  push(job: Job): void {
    const a = this.a;
    a.push(job);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].src.size >= a[i].src.size) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): Job | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as Job;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].src.size > a[m].src.size) m = l;
        if (r < a.length && a[r].src.size > a[m].src.size) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function pruneTree(root: FileNode, options: PruneOptions): PruneResult {
  const maxNodes = Math.max(1, options.maxNodes);
  const rootCopy = copyNode(root);
  let nodes = 1;
  let prunedDirs = 0;

  const heap = new SizeHeap();

  /** Queue a directory as *withheld for now*; expanding it clears the mark. */
  const defer = (src: FileNode, copy: FileNode): void => {
    if (!isExpandable(src)) {
      // An empty directory has nothing to withhold. Keep its empty list, or
      // the UI could not tell "this folder is empty" from "children withheld"
      // — a distinction TreeMap's empty-folder finder depends on.
      if (src.children && src.children.length === 0) copy.children = [];
      return;
    }
    copy.pruned = true;
    prunedDirs++;
    heap.push({ src, copy });
  };

  defer(root, rootCopy);

  while (heap.size > 0 && nodes < maxNodes) {
    const { src, copy } = heap.pop() as Job;
    const kids = src.children as FileNode[];

    const copies = kids.map(copyNode);
    copy.children = copies;
    delete copy.pruned; // invariant 1: never both
    prunedDirs--;
    nodes += copies.length;

    for (let i = 0; i < kids.length; i++) defer(kids[i], copies[i]);
  }

  // Anything still in the heap keeps the `pruned` mark defer() gave it.
  return { root: rootCopy, nodes, prunedDirs };
}
