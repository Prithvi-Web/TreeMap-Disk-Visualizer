import { createReadStream } from "node:fs";
import readline from "node:readline";
import { ScanStore, NodeInput } from "./scanStore";

/**
 * NTFS MFT edges (NDJSON from the ntfs-mft-scan helper) -> PackedScanStore.
 *
 * One line = one (record, surviving FileName attribute) pair. The helper
 * (native/ntfs-mft-scan) has already:
 *   - dropped pure-DOS-namespace (8.3 short name) attributes, and
 *   - collapsed same-parent duplicate namespaces (e.g. a Posix + Win32 name
 *     for the same single link) to one representative each,
 * so a recordNo appearing under more than one DISTINCT parentRecordNo here is
 * always a genuine hardlink, never a namespace artifact. See
 * docs/superpowers/specs/2026-07-24-ntfs-mft-engine-design.md §3.1-3.2 for why.
 *
 * NTFS's root directory is always record 5 (ROOT_RECORD in ntfs-reader).
 * Newer helper builds may emit a leading `{"_meta":true,"targetRecordNo":N}`
 * line when `--root` filtered the dump to a subtree.
 */
export const ROOT_RECORD_NO = 5;

export interface NtfsMftEdge {
  recordNo: number;
  parentRecordNo: number;
  name: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
}

export interface NtfsMftMapStats {
  fileCount: number;
  dirCount: number;
  hardlinkedFiles: number;
  hardlinkedBytes: number;
}

export interface ParsedNtfsMftEdges {
  edgesByParent: Map<number, NtfsMftEdge[]>;
  /** From helper `_meta` line when present; otherwise null. */
  targetRecordNo: number | null;
}

function ingestEdgeLine(
  trimmed: string,
  byParent: Map<number, NtfsMftEdge[]>,
): number | null {
  const obj = JSON.parse(trimmed) as NtfsMftEdge & {
    _meta?: boolean;
    targetRecordNo?: number;
  };
  if (obj._meta === true) {
    return typeof obj.targetRecordNo === "number" ? obj.targetRecordNo : null;
  }
  const edge = obj as NtfsMftEdge;
  const list = byParent.get(edge.parentRecordNo);
  if (list) list.push(edge);
  else byParent.set(edge.parentRecordNo, [edge]);
  return null;
}

/** Parse NDJSON (one edge object per line; blank lines ignored) into an
 *  edgesByParent index. Never collapses by recordNo — every edge is kept.
 *  Skips `_meta` lines (returns them via parseNtfsMftEdgesDetailed). */
export function parseNtfsMftEdges(ndjson: string): Map<number, NtfsMftEdge[]> {
  return parseNtfsMftEdgesDetailed(ndjson).edgesByParent;
}

export function parseNtfsMftEdgesDetailed(ndjson: string): ParsedNtfsMftEdges {
  const byParent = new Map<number, NtfsMftEdge[]>();
  let targetRecordNo: number | null = null;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const metaTarget = ingestEdgeLine(trimmed, byParent);
    if (metaTarget !== null) targetRecordNo = metaTarget;
  }
  return { edgesByParent: byParent, targetRecordNo };
}

/**
 * Stream-parse an on-disk NDJSON dump (spec §3.1 — never hold the whole
 * payload as one V8 string). Same semantics as parseNtfsMftEdgesDetailed.
 */
export async function parseNtfsMftEdgesFile(
  filePath: string,
): Promise<ParsedNtfsMftEdges> {
  const byParent = new Map<number, NtfsMftEdge[]>();
  let targetRecordNo: number | null = null;
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const metaTarget = ingestEdgeLine(trimmed, byParent);
    if (metaTarget !== null) targetRecordNo = metaTarget;
  }
  return { edgesByParent: byParent, targetRecordNo };
}

/**
 * Resolve the record number for `components` (path parts under the volume
 * root, e.g. ['Users','foo','Documents']), starting from ROOT_RECORD_NO.
 * An empty array means "the whole volume" -> ROOT_RECORD_NO itself.
 * Name matching is case-insensitive: NTFS is case-insensitive-preserving by
 * default, so a literal === would fail to resolve a real folder whenever the
 * requested path's casing differs from the on-disk name.
 */
export function resolveTargetRecord(
  edgesByParent: Map<number, NtfsMftEdge[]>,
  components: string[],
): number | null {
  let current = ROOT_RECORD_NO;
  for (const part of components) {
    const children = edgesByParent.get(current);
    const match = children?.find(
      (e) => e.isDir && e.name.toLowerCase() === part.toLowerCase(),
    );
    if (!match) return null;
    current = match.recordNo;
  }
  return current;
}

/**
 * Insert every descendant of `targetRecordNo` as children of `parentId` in
 * `store` (parent-before-child, so every addNode call already has its
 * parent). `store`'s root node itself is NOT created here — the caller
 * constructs it from the target folder's own metadata, exactly the way
 * gduScanIntoStore builds `PackedScanStore`'s rootFields separately from the
 * shard mapper.
 */
export function buildNtfsMftStoreFromEdges(
  edgesByParent: Map<number, NtfsMftEdge[]>,
  targetRecordNo: number,
  store: ScanStore,
  parentId: number,
): { stats: NtfsMftMapStats } {
  const stats: NtfsMftMapStats = {
    fileCount: 0,
    dirCount: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
  };
  const seenRecordNos = new Set<number>();

  function addChildren(recordNo: number, storeParentId: number): void {
    const children = edgesByParent.get(recordNo);
    if (!children) return;

    for (const edge of children) {
      const isHidden = edge.name.charCodeAt(0) === 46;

      if (edge.isDir) {
        stats.dirCount++;
        const input: NodeInput = {
          name: edge.name,
          isDir: true,
          size: 0,
          modifiedAt: edge.mtimeMs,
          isHidden,
        };
        const dirId = store.addNode(storeParentId, input);
        addChildren(edge.recordNo, dirId);
        continue;
      }

      stats.fileCount++;
      const input: NodeInput = {
        name: edge.name,
        isDir: false,
        size: edge.size,
        modifiedAt: edge.mtimeMs,
        isHidden,
      };

      if (seenRecordNos.has(edge.recordNo)) {
        input.hardlinkDuplicate = true;
        input.size = 0;
        stats.hardlinkedFiles++;
        stats.hardlinkedBytes += edge.size;
      } else {
        seenRecordNos.add(edge.recordNo);
      }

      store.addNode(storeParentId, input);
    }
  }

  addChildren(targetRecordNo, parentId);
  return { stats };
}
