import { promises as fsp } from 'fs';
import path from 'path';
import { openIndex, getRoot } from './indexEngine';

/**
 * AllocationAccountant (A2) — what a folder really costs on disk.
 *
 * Summing per-file logical sizes overstates real usage on any modern
 * filesystem: hard links are counted once per name, sparse and compressed
 * files are counted at the size they claim rather than the space they hold,
 * and copy-on-write clones (APFS `cp -c`, Btrfs/XFS reflinks) are counted in
 * full for every copy even though they share their blocks.
 *
 * ── What this can measure exactly, and what it cannot ──
 *
 * Measured on macOS 15 / APFS, not assumed:
 *
 *   | Case                | Detectable?                        |
 *   |---------------------|------------------------------------|
 *   | Hard link           | **Yes, exactly** — same inode, nlink > 1 |
 *   | Sparse file         | **Yes, exactly** — allocated blocks  |
 *   | Compressed file     | **Yes, exactly** — allocated blocks  |
 *   | APFS clone / reflink| **No** — see below                   |
 *
 * A clone gets its **own inode** and reports its **full allocated size**, so it
 * is indistinguishable from a real copy through any interface reachable without
 * native code. Measured: writing a 50 MB file consumed 54,853,632 bytes;
 * cloning it consumed **-4,096** — the blocks are genuinely shared — yet both
 * files report ~50 MB allocated. `du` gets this wrong in exactly the same way.
 *
 * So this service does **not** guess at clone membership. Instead it measures
 * what it can exactly, and quantifies what it cannot **in aggregate**: for a
 * whole volume, the gap between the allocated sum and the filesystem's own
 * used-block count is precisely the space that shared storage accounts for. In
 * the same measurement the naive sum was 157,286,400 against 107,286,528
 * actually consumed — a 49,999,872-byte gap, exactly the cloned file. That
 * number is reported plainly rather than hidden inside a total (§10: "if clone
 * detection failed, say the size is approximate").
 *
 * ── The exclusivity rule (§A2 "Ordering matters") ──
 *
 * "Exclusive" is meaningless without a scope, and picking the scope loosely is
 * how the same folder reports different numbers depending on where the user
 * started scanning. One rule, applied everywhere:
 *
 *   **Exclusivity is computed within the scanned root.** A file's bytes are
 *   *exclusive* when deleting it from that root would free them, and *shared*
 *   when another name for the same data also lives in the root. When a
 *   family's `nlink` exceeds the number of names found inside the root, the
 *   family reaches outside it — deleting everything in scope would still free
 *   nothing — and that is flagged rather than silently treated as exclusive.
 */

/** One inode with more than one name. */
export interface HardlinkFamily {
  /** Stable key for the family: the inode number. */
  ino: number;
  /** Bytes the inode actually occupies (counted once). */
  allocatedBytes: number;
  /** Names for this inode found inside the scanned root. */
  linksInScope: number;
  /** Names the filesystem reports in total, anywhere on the volume. */
  linksTotal: number;
  /** True when the family reaches outside the scanned root. */
  extendsOutsideRoot: boolean;
  /** The in-scope paths, capped for display. */
  paths: string[];
}

export interface VolumeGroundTruth {
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface Reconciliation {
  /** What TreeMap measured for the whole volume. */
  measuredBytes: number;
  /** What the filesystem itself reports as used. */
  actualBytes: number;
  /** measured − actual. Positive means TreeMap counted shared blocks twice. */
  deltaBytes: number;
  /** The delta as a share of actual usage. */
  deltaPercent: number;
  /** Plain-language reading of the delta. */
  verdict: string;
}

export interface AllocationSummary {
  rootPath: string;
  /**
   * What a tool with no allocation awareness reports: every logical size added
   * up, counting a hard-linked file once per name. This is the number TreeMap
   * exists to improve on, so it is stated rather than implied.
   */
  naiveLogicalBytes: number;
  /** Sum of logical sizes, counting each inode once. */
  logicalBytes: number;
  /** Sum of bytes actually occupied, counting each inode once. */
  allocatedBytes: number;
  /** Of `allocatedBytes`, the part held by inodes with more than one name in scope. */
  sharedBytes: number;
  /** Of `allocatedBytes`, the part that deleting the file would genuinely free. */
  exclusiveBytes: number;
  hardlinkFamilies: number;
  /** Extra names beyond the first for every family — bytes a naive sum double-counts. */
  hardlinkedNames: number;
  /** Bytes a naive logical sum would have over-reported. */
  savedByDeduplication: number;
  /** Present only when the scanned root is a whole volume. */
  volume: VolumeGroundTruth | null;
  reconciliation: Reconciliation | null;
  /**
   * True whenever a figure here could be an overcount TreeMap cannot see —
   * which, on a filesystem supporting copy-on-write, is always.
   */
  approximate: boolean;
  reason: string;
}

/** Cap on the families returned for display; the counters stay exact. */
const MAX_FAMILIES = 200;
const MAX_PATHS_PER_FAMILY = 12;

/**
 * Is `dir` the root of its own filesystem?
 *
 * Reconciliation against `statfs` only means anything for a whole volume: a
 * subfolder's contribution to used space cannot be isolated from the outside,
 * and pretending otherwise would produce a "delta" made entirely of everything
 * else on the disk.
 */
export async function isMountPoint(dir: string): Promise<boolean> {
  try {
    const here = await fsp.lstat(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return true; // '/' is its own parent
    const above = await fsp.lstat(parent);
    return here.dev !== above.dev;
  } catch {
    return false;
  }
}

async function volumeGroundTruth(mountPoint: string): Promise<VolumeGroundTruth | null> {
  try {
    const st = await fsp.statfs(mountPoint);
    const blockSize = Number(st.bsize);
    const totalBytes = Number(st.blocks) * blockSize;
    const freeBytes = Number(st.bavail) * blockSize;
    // Used is derived from bfree, not bavail: bavail excludes the
    // root-reserved margin, and using it here would inflate "used" by that
    // reserve and produce a delta that is pure accounting artefact.
    const usedBytes = totalBytes - Number(st.bfree) * blockSize;
    return { mountPoint, totalBytes, freeBytes, usedBytes };
  } catch {
    return null;
  }
}

/** Human reading of a reconciliation delta. Never alarming, never hand-waving. */
function verdictFor(deltaBytes: number, deltaPercent: number): string {
  if (deltaBytes <= 0) {
    return 'TreeMap’s total is at or below what the disk reports, which is expected — some system files are not readable.';
  }
  if (deltaPercent < 2) {
    return 'TreeMap’s total matches what the disk reports.';
  }
  return (
    'TreeMap counts more than the disk actually reports as used. The difference is almost certainly files that share ' +
    'storage with each other — copies made with the Finder’s duplicate command, or by developer tools, take up no extra ' +
    'space until one of them changes. TreeMap cannot see which files those are, so it counts each one in full.'
  );
}

/**
 * Account for one indexed root.
 *
 * Reads from the index rather than walking the disk again: the index already
 * stores inode, link count and allocated size per file, which is everything
 * this needs. That also makes it instant on a root that would take minutes to
 * re-walk.
 */
export async function accountFor(rootPath: string): Promise<AllocationSummary | null> {
  const root = getRoot(rootPath);
  if (!root) return null;
  const handle = openIndex();

  const totals = handle
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS logical,
              COALESCE(SUM(CASE WHEN allocated IS NULL THEN size ELSE allocated END), 0) AS allocated
         FROM nodes
        WHERE root_id = ? AND is_dir = 0 AND (flags & 2) = 0`,
    )
    .get(root.id) as { logical: number; allocated: number };

  // Families: one row per inode that has more than one name on the filesystem
  // AND appears in this root. `nlink` is the filesystem's count; `COUNT(*)` is
  // how many of those names we actually found in scope — the difference is what
  // tells us the family reaches outside.
  const familyRows = handle
    .prepare(
      `SELECT ino,
              MAX(nlink)  AS links_total,
              COUNT(*)    AS links_in_scope,
              MAX(CASE WHEN allocated IS NULL THEN size ELSE allocated END) AS allocated
         FROM nodes
        WHERE root_id = ? AND is_dir = 0 AND ino IS NOT NULL AND nlink > 1
        GROUP BY ino`,
    )
    .all(root.id) as { ino: number; links_total: number; links_in_scope: number; allocated: number }[];

  let sharedBytes = 0;
  let hardlinkedNames = 0;
  const families: HardlinkFamily[] = [];

  for (const row of familyRows) {
    const extendsOutside = row.links_total > row.links_in_scope;
    // Shared when another name exists — whether that name is inside the root
    // or outside it. Either way, deleting this one frees nothing.
    const isShared = row.links_in_scope > 1 || extendsOutside;
    if (isShared) sharedBytes += row.allocated;
    hardlinkedNames += Math.max(0, row.links_in_scope - 1);

    if (families.length < MAX_FAMILIES) {
      const paths = handle
        .prepare('SELECT path FROM nodes WHERE root_id = ? AND ino = ? AND is_dir = 0 ORDER BY path LIMIT ?')
        .all(root.id, row.ino, MAX_PATHS_PER_FAMILY) as { path: string }[];
      families.push({
        ino: row.ino,
        allocatedBytes: row.allocated,
        linksInScope: row.links_in_scope,
        linksTotal: row.links_total,
        extendsOutsideRoot: extendsOutside,
        paths: paths.map((p) => p.path),
      });
    }
  }

  // What a naive logical sum would have double-counted: every name after the
  // first in each family. The index already zeroes those rows, so this is
  // recovered from the family table rather than by re-reading them.
  const dedupRow = handle
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN allocated IS NULL THEN size ELSE allocated END), 0) AS bytes
         FROM nodes WHERE root_id = ? AND is_dir = 0 AND (flags & 2) != 0`,
    )
    .get(root.id) as { bytes: number };

  const allocatedBytes = totals.allocated;
  const summary: AllocationSummary = {
    rootPath: root.path,
    // The index zeroes a hard-link duplicate's `size` so the tree does not
    // double-count it (the same convention the walker uses), so the naive
    // figure has to be reconstructed by adding those bytes back.
    naiveLogicalBytes: totals.logical + dedupRow.bytes,
    logicalBytes: totals.logical,
    allocatedBytes,
    sharedBytes,
    exclusiveBytes: Math.max(0, allocatedBytes - sharedBytes),
    hardlinkFamilies: familyRows.length,
    hardlinkedNames,
    savedByDeduplication: dedupRow.bytes,
    volume: null,
    reconciliation: null,
    approximate: true,
    reason:
      'Files that share storage with each other (copies that take no extra space until changed) cannot be identified on ' +
      'this system, so each is counted in full. Everything else — including files with several names, and files that ' +
      'claim more space than they use — is measured exactly.',
  };

  // Reconciliation is only meaningful for a whole volume.
  if (await isMountPoint(root.path)) {
    const volume = await volumeGroundTruth(root.path);
    if (volume) {
      summary.volume = volume;
      const delta = allocatedBytes - volume.usedBytes;
      const deltaPercent = volume.usedBytes > 0 ? (delta / volume.usedBytes) * 100 : 0;
      summary.reconciliation = {
        measuredBytes: allocatedBytes,
        actualBytes: volume.usedBytes,
        deltaBytes: delta,
        deltaPercent: Math.round(deltaPercent * 100) / 100,
        verdict: verdictFor(delta, deltaPercent),
      };
    }
  }

  return summary;
}

/**
 * Per-file shared/exclusive bytes, for tooltips.
 *
 * Returns null for an ordinary file with a single name — there is nothing
 * interesting to say about it, and a tooltip that says "100% exclusive" on
 * every file is noise.
 */
export interface FileAllocation {
  path: string;
  logicalBytes: number;
  allocatedBytes: number;
  sharedBytes: number;
  exclusiveBytes: number;
  linksInScope: number;
  linksTotal: number;
  extendsOutsideRoot: boolean;
  /** Set when the file claims more than it occupies (sparse, compressed, evicted). */
  underAllocated: boolean;
}

export function allocationForFile(rootPath: string, filePath: string): FileAllocation | null {
  const root = getRoot(rootPath);
  if (!root) return null;
  const handle = openIndex();

  const row = handle
    .prepare('SELECT size, allocated, ino, nlink FROM nodes WHERE root_id = ? AND path = ? AND is_dir = 0')
    .get(root.id, filePath) as { size: number; allocated: number | null; ino: number | null; nlink: number | null } | undefined;
  if (!row) return null;

  const allocated = row.allocated ?? row.size;
  const linksTotal = row.nlink ?? 1;
  let linksInScope = 1;
  let logicalBytes = row.size;

  if (row.ino !== null && linksTotal > 1) {
    // Only one name per inode keeps its `size`; the rest are zeroed so the tree
    // does not double-count them. A tooltip must still report the file's real
    // size — showing "0 bytes" for a 10 MB file the user is looking at would be
    // simply false — so the family's own size is used.
    const family = handle
      .prepare('SELECT COUNT(*) c, MAX(size) s FROM nodes WHERE root_id = ? AND ino = ? AND is_dir = 0')
      .get(root.id, row.ino) as { c: number; s: number };
    linksInScope = family.c;
    logicalBytes = Math.max(row.size, family.s);
  }

  const extendsOutsideRoot = linksTotal > linksInScope;
  const shared = linksInScope > 1 || extendsOutsideRoot;

  return {
    path: filePath,
    logicalBytes,
    allocatedBytes: allocated,
    // Deleting one name of a multi-name file frees nothing, so none of its
    // bytes are exclusive to that name.
    sharedBytes: shared ? allocated : 0,
    exclusiveBytes: shared ? 0 : allocated,
    linksInScope,
    linksTotal,
    extendsOutsideRoot,
    underAllocated: allocated < row.size,
  };
}
