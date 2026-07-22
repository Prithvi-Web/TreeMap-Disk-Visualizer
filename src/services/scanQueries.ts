import { FileNode } from '../models/types';
import { findNodeByPath } from '../utils/treemap';
import { pruneTree } from '../utils/pruneTree';
import { ScanStore, TreeSource, asStore, Flag } from './scanStore';

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

function project(store: ScanStore, id: number): FileHit {
  return {
    name: store.name(id),
    path: store.path(id),
    size: store.size(id),
    type: 'file',
    modifiedAt: store.modifiedAt(id),
    extension: store.extension(id),
    cloudProvider: store.cloudProvider(id),
    cloudPlaceholder: store.flag(id, Flag.CloudPlaceholder) || undefined,
  };
}

/**
 * Largest-N by size with flat memory — the same bounded insertion
 * collectLargestFiles uses, so a 4M-file scan never buffers 4M nodes.
 * Holds bare ids plus their size, nothing heavier.
 */
class TopN {
  private items: { id: number; size: number }[] = [];
  constructor(private readonly limit: number) {}

  add(id: number, size: number): void {
    if (this.limit <= 0) return;
    const items = this.items;
    if (items.length < this.limit) {
      items.push({ id, size });
      if (items.length === this.limit) items.sort((a, b) => b.size - a.size);
    } else if (size > items[items.length - 1].size) {
      items[items.length - 1] = { id, size };
      items.sort((a, b) => b.size - a.size);
    }
  }

  result(): number[] {
    return [...this.items].sort((a, b) => b.size - a.size).map((x) => x.id);
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
export function collectCloudPlaceholders(source: TreeSource, perProvider: number): CloudPlaceholderResult {
  const store = asStore(source);
  const groups = new Map<string, { count: number; totalSize: number; top: TopN }>();
  let totalCount = 0;
  let totalSize = 0;

  store.eachFile(store.rootId, (id) => {
    if (!store.flag(id, Flag.CloudPlaceholder)) return;
    const size = store.size(id);
    totalCount++;
    totalSize += size;
    const key = store.cloudProvider(id) ?? 'cloud';
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, totalSize: 0, top: new TopN(perProvider) };
      groups.set(key, g);
    }
    g.count++;
    g.totalSize += size;
    g.top.add(id, size);
  });

  return {
    totalCount,
    totalSize,
    groups: [...groups.entries()]
      .map(([provider, g]) => ({
        provider,
        count: g.count,
        totalSize: g.totalSize,
        files: g.top.result().map((id) => project(store, id)),
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
function dupKeyOf(store: ScanStore, id: number): string {
  return store.name(id) + ' ' + store.size(id);
}

/**
 * Files matching every enabled rule. `now` is injected so the age rule is
 * testable without freezing the clock.
 */
export function matchCustomRules(
  source: TreeSource,
  rules: CustomRules,
  limit: number,
  now: number,
): RuleMatchResult {
  const store = asStore(source);
  const exts = new Set((rules.exts ?? []).filter(Boolean));
  const useAge = typeof rules.maxAgeMs === 'number';
  const useSize = typeof rules.minBytes === 'number';
  const useExt = exts.size > 0;

  // The duplicate rule asks whether a name+size occurs more than once across
  // the WHOLE scan, so it needs its own full pass before anything is filtered.
  let dupKeys: Set<string> | null = null;
  if (rules.dup) {
    const counts = new Map<string, number>();
    store.eachFile(store.rootId, (id) => {
      const k = dupKeyOf(store, id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    dupKeys = new Set<string>();
    for (const [k, c] of counts) if (c > 1) dupKeys.add(k);
  }

  const top = new TopN(limit);
  let matched = 0;

  store.eachFile(store.rootId, (id) => {
    if (useAge && now - store.modifiedAt(id) < (rules.maxAgeMs as number)) return;
    if (useSize && store.size(id) < (rules.minBytes as number)) return;
    if (useExt && !exts.has(store.extension(id) ?? '')) return;
    if (dupKeys && !dupKeys.has(dupKeyOf(store, id))) return;
    matched++;
    top.add(id, store.size(id));
  });

  return { files: top.result().map((id) => project(store, id)), matched, truncated: matched > limit };
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
