import { FileNode } from '../models/types';
import { findNodeByPath } from '../utils/treemap';
import { pruneTree } from '../utils/pruneTree';
import { ScanStore } from './scanStore';

/**
 * Aggregate queries the UI used to answer by walking the whole tree itself.
 *
 * The tree the browser now receives is pruned to a node budget, so anything
 * that must be exact across the *entire* scan has to be answered here, where
 * the real tree lives. Computing these client-side against a pruned tree would
 * produce confidently wrong numbers — a worse failure than not answering.
 *
 * Every walk below visits real on-disk files only. Like collectLargestFiles in
 * diskScanner, they stop at a `file` node, which means they never descend into
 * an expanded container: its entries are a listing rather than files on disk,
 * and requireInsideScanRoot refuses to trash them anyway.
 */

/**
 * One file, shaped as the cleanup UIs render it. `type` is always 'file' —
 * these walks only ever visit files — but it's carried explicitly because the
 * UI's icon and cart helpers branch on it, and a missing field that happens to
 * be falsy is luck rather than design.
 */
export interface FileHit {
  name: string;
  path: string;
  size: number;
  type: 'file';
  modifiedAt: number;
  extension?: string;
  cloudProvider?: 'icloud' | 'onedrive' | 'dropbox';
  cloudPlaceholder?: boolean;
}

function project(n: FileNode): FileHit {
  return {
    name: n.name,
    path: n.path,
    size: n.size,
    type: 'file',
    modifiedAt: n.modifiedAt,
    extension: n.extension,
    cloudProvider: n.cloudProvider,
    cloudPlaceholder: n.cloudPlaceholder,
  };
}

/** Visit every real file in the scan, skipping container listings. */
function eachFile(root: FileNode, fn: (n: FileNode) => void): void {
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      fn(node);
      return;
    }
    if (node.children) for (const c of node.children) visit(c);
  };
  visit(root);
}

/**
 * Largest-N by size with flat memory — the same bounded insertion
 * collectLargestFiles uses, so a 4M-file scan never buffers 4M nodes.
 */
class TopN {
  private items: FileNode[] = [];
  constructor(private readonly limit: number) {}

  add(n: FileNode): void {
    if (this.limit <= 0) return;
    const items = this.items;
    if (items.length < this.limit) {
      items.push(n);
      if (items.length === this.limit) items.sort((a, b) => b.size - a.size);
    } else if (n.size > items[items.length - 1].size) {
      items[items.length - 1] = n;
      items.sort((a, b) => b.size - a.size);
    }
  }

  result(): FileNode[] {
    return [...this.items].sort((a, b) => b.size - a.size);
  }
}

/* ------------------------- Cloud placeholders ------------------------- */

export interface CloudGroup {
  provider: string;
  /** Exact count across the whole scan, not just the files returned. */
  count: number;
  /** Exact total bytes across the whole scan. */
  totalSize: number;
  /** Largest files first, capped at perProvider. */
  files: FileHit[];
}

export interface CloudPlaceholderResult {
  totalCount: number;
  totalSize: number;
  groups: CloudGroup[];
}

/**
 * Online-only files, grouped by provider. Counts and byte totals are exact for
 * the whole scan; only the per-group file *lists* are capped, so the UI can
 * state "12,431 files (840 GB)" truthfully while rendering the top few hundred.
 */
export function collectCloudPlaceholders(root: FileNode, perProvider: number): CloudPlaceholderResult {
  const groups = new Map<string, { count: number; totalSize: number; top: TopN }>();
  let totalCount = 0;
  let totalSize = 0;

  eachFile(root, (n) => {
    if (!n.cloudPlaceholder) return;
    totalCount++;
    totalSize += n.size;
    const key = n.cloudProvider ?? 'cloud';
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, totalSize: 0, top: new TopN(perProvider) };
      groups.set(key, g);
    }
    g.count++;
    g.totalSize += n.size;
    g.top.add(n);
  });

  return {
    totalCount,
    totalSize,
    groups: [...groups.entries()]
      .map(([provider, g]) => ({
        provider,
        count: g.count,
        totalSize: g.totalSize,
        files: g.top.result().map(project),
      }))
      .sort((a, b) => b.totalSize - a.totalSize),
  };
}

/* --------------------------- Custom rules ---------------------------- */

export interface CustomRules {
  /** Match files at least this old (ms). Omit to not filter by age. */
  maxAgeMs?: number;
  /** Match files at least this large. Omit to not filter by size. */
  minBytes?: number;
  /** Match only these extensions (lower-case, no dot). Omit/empty to not filter. */
  exts?: string[];
  /** Match only files whose name+size occurs more than once in the scan. */
  dup?: boolean;
}

export interface RuleMatchResult {
  /** Largest first, capped at `limit`. */
  files: FileHit[];
  /** Exact number of matches across the scan, before the cap. */
  matched: number;
  truncated: boolean;
}

/** Duplicate identity, matching the UI's original rule: same name AND size. */
function dupKey(n: FileNode): string {
  return n.name + ' ' + n.size;
}

/**
 * Files matching every enabled rule. `now` is injected so the age rule is
 * testable without freezing the clock.
 */
export function matchCustomRules(
  root: FileNode,
  rules: CustomRules,
  limit: number,
  now: number,
): RuleMatchResult {
  const exts = new Set((rules.exts ?? []).filter(Boolean));
  const useAge = typeof rules.maxAgeMs === 'number';
  const useSize = typeof rules.minBytes === 'number';
  const useExt = exts.size > 0;

  // The duplicate rule asks whether a name+size occurs more than once across
  // the WHOLE scan, so it needs its own full pass before anything is filtered.
  let dupKeys: Set<string> | null = null;
  if (rules.dup) {
    const counts = new Map<string, number>();
    eachFile(root, (n) => {
      const k = dupKey(n);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    dupKeys = new Set<string>();
    for (const [k, c] of counts) if (c > 1) dupKeys.add(k);
  }

  const top = new TopN(limit);
  let matched = 0;

  eachFile(root, (n) => {
    if (useAge && now - n.modifiedAt < (rules.maxAgeMs as number)) return;
    if (useSize && n.size < (rules.minBytes as number)) return;
    if (useExt && !exts.has(n.extension ?? '')) return;
    if (dupKeys && !dupKeys.has(dupKey(n))) return;
    matched++;
    top.add(n);
  });

  return { files: top.result().map(project), matched, truncated: matched > limit };
}

/* ------------------------ Batch node lookup -------------------------- */

/**
 * Resolve paths to node metadata, for UI that holds a path but may not hold
 * the node — the cleanup cart persists paths across sessions, and selection
 * totals must not silently read a missing node as zero bytes.
 *
 * Values are metadata only (pruneTree at a budget of 1), so a directory comes
 * back with its true recursive size and a `pruned` mark rather than children.
 * A path that isn't in this scan resolves to null, which is a real answer.
 */
export function lookupNodes(root: FileNode, paths: string[]): Record<string, FileNode | null> {
  const out: Record<string, FileNode | null> = {};
  for (const p of paths) {
    const node = findNodeByPath(root, p);
    out[p] = node ? pruneTree(node, { maxNodes: 1 }).root : null;
  }
  return out;
}

/** lookupNodes for store-backed scans — same shape, same absent-is-null answer. */
export function lookupNodesInStore(store: ScanStore, paths: string[]): Record<string, FileNode | null> {
  const out: Record<string, FileNode | null> = {};
  for (const p of paths) {
    const id = store.findByPath(p);
    out[p] = id === -1 ? null : store.materialize(id);
  }
  return out;
}
