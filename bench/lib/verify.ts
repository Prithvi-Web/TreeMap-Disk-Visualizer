/**
 * The checks that make a benchmark number mean something: an engine that is
 * fast and wrong has measured nothing. Every suite runs these against the
 * corpus manifest, on every run, and a failure is printed beside the timing.
 */
import fs from 'node:fs';

/** The parts of a corpus manifest the checks read — structural, so any generator can supply them. */
export interface PlantedTotals { dirs: number; files: number; logicalBytes: number }
export interface PlantedGroup { content: number; size: number; paths: string[] }
export interface HardlinkFamily { target: string; links: string[] }
export interface PlantedDuplicates { root: string; duplicateGroups: PlantedGroup[]; hardlinkFamilies?: HardlinkFamily[] }

const MAX_NOTES = 20;

export interface ScanCounts {
  fileCount: number;
  /** Directories including the root — both engines count the root itself. */
  dirCount: number;
  /** The root node's recursive logical size. */
  rootSize: number;
  scanned: number;
}

export interface ManifestCheck {
  ok: boolean;
  notes: string[];
}

const count = (n: number): string => n.toLocaleString('en-US');

export function checkScanAgainstManifest(manifest: PlantedTotals, scan: ScanCounts): ManifestCheck {
  const notes: string[] = [];
  const expect = (field: string, got: number, want: number): void => {
    if (got !== want) notes.push(`${field}: the scan reported ${count(got)}, the manifest planted ${count(want)}`);
  };
  expect('fileCount', scan.fileCount, manifest.files);
  expect('dirCount', scan.dirCount, manifest.dirs);
  expect('scanned', scan.scanned, manifest.files + manifest.dirs);
  expect('logicalBytes', scan.rootSize, manifest.logicalBytes);
  return { ok: notes.length === 0, notes };
}

/** Every measured run must report what the first did; a count that drifts between runs is a defect, not noise. */
export function checkRunsAgree(runs: ScanCounts[]): ManifestCheck {
  const notes: string[] = [];
  const first = runs[0];
  if (!first) return { ok: false, notes: ['no runs to compare'] };
  runs.forEach((r, i) => {
    for (const field of ['fileCount', 'dirCount', 'scanned', 'rootSize'] as const) {
      if (r[field] !== first[field]) notes.push(`run ${i + 1} reported ${field} ${count(r[field])} where run 1 reported ${count(first[field])}`);
    }
  });
  return { ok: notes.length === 0, notes };
}

export interface ReportedGroup {
  size: number;
  files: Array<{ path: string }>;
}

export interface DuplicateCheckOptions {
  /** How many groups the finder found in total when it reports only its top N; enables the truncation rule. */
  groupCount?: number;
}

export interface DuplicateCheck extends ManifestCheck {
  recall: number;
  precision: number;
  falsePositives: number;
  missedGroups: number;
  /** Planted groups the finder could have reported (all of them, or the ones above its report cut). */
  expectedGroups: number;
  reportedGroups: number;
  /** Reported groups whose members all share one inode: bytes identical, reclaimable nothing. */
  sharedStorageGroups: number;
  truncated: boolean;
}

type ByteVerdict = { same: true } | { same: false; reason: string };

function sameBytes(a: string, b: string): ByteVerdict {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return { same: false, reason: 'their sizes differ' };
    return fs.readFileSync(a).equals(fs.readFileSync(b)) ? { same: true } : { same: false, reason: 'their bytes differ' };
  } catch (err: unknown) {
    return { same: false, reason: `a reported path could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

function oneInode(paths: string[]): boolean {
  try {
    const ids = new Set(paths.map((p) => { const s = fs.statSync(p); return `${s.dev}:${s.ino}`; }));
    return ids.size === 1;
  } catch {
    return false;
  }
}

/**
 * Recall: every planted group at or above `minSize` that the finder could
 * have reported must be reported whole. When the finder reports only its top
 * N groups by reclaimable bytes (`groupCount` above the reported count), the
 * expected set is the planted groups whose reclaimable bytes strictly exceed
 * the smallest reported group's, and the finder's total count must equal the
 * planted count at or above `minSize`. Hard-link names are canonicalised to
 * their family's target first: an engine gives the bytes to whichever name
 * its directory listing returned first, which need not be the planted one.
 * Precision: every reported group must be byte-identical throughout, proven
 * by reading the files; a reported group that is one inode under two names
 * shares storage and is never reclaimable, so it counts against precision.
 */
export function checkDuplicatesAgainstManifest(
  manifest: PlantedDuplicates,
  groups: ReportedGroup[],
  minSize: number,
  opts: DuplicateCheckOptions = {},
): DuplicateCheck {
  const notes: string[] = [];
  const note = (text: string): void => { if (notes.length < MAX_NOTES) notes.push(text); };

  const alias = new Map<string, string>();
  for (const family of manifest.hardlinkFamilies ?? []) for (const link of family.links) alias.set(link, family.target);
  const canon = (p: string): string => alias.get(p) ?? p;

  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.files.forEach((f) => groupOf.set(canon(f.path), i)));

  const plantedAtOrAbove = manifest.duplicateGroups.filter((g) => g.size >= minSize);
  const truncated = opts.groupCount !== undefined && opts.groupCount > groups.length;
  const reclaimable = (size: number, members: number): number => size * (members - 1);
  const cut = truncated ? Math.min(...groups.map((g) => reclaimable(g.size, g.files.length))) : Number.NEGATIVE_INFINITY;
  const reportedWhole = (planted: PlantedGroup): boolean => {
    const ids = new Set(planted.paths.map((p) => groupOf.get(canon(p))));
    return ids.size === 1 && !ids.has(undefined);
  };
  // Above the cut a planted group must have been reported. At the cut it was
  // reportable, and counts when it was reported; an unreported tie at the cut
  // is ambiguous (the finder had to choose among equals) and is not expected.
  const expected = truncated
    ? plantedAtOrAbove.filter((g) => { const r = reclaimable(g.size, g.paths.length); return r > cut || (r === cut && reportedWhole(g)); })
    : plantedAtOrAbove;

  let missed = 0;
  for (const planted of expected) {
    if (!reportedWhole(planted)) {
      missed++;
      note(`missed: planted group of ${planted.paths.length} × ${count(planted.size)} B (${planted.paths[0]}) was not reported whole`);
    }
  }

  let countMismatch = false;
  if (opts.groupCount !== undefined && opts.groupCount !== plantedAtOrAbove.length) {
    countMismatch = true;
    note(`the finder counted ${count(opts.groupCount)} groups in total; the corpus planted ${count(plantedAtOrAbove.length)} at or above ${count(minSize)} B`);
  }

  let falsePositives = 0;
  let sharedStorageGroups = 0;
  for (const g of groups) {
    const paths = g.files.map((f) => f.path);
    const first = paths[0];
    if (first === undefined) continue;
    let bad = false;
    for (const other of paths.slice(1)) {
      const verdict = sameBytes(first, other);
      if (!verdict.same) {
        note(`false positive: ${first} and ${other} were reported as duplicates but ${verdict.reason}`);
        bad = true;
        break;
      }
    }
    if (bad) {
      falsePositives++;
      continue;
    }
    if (paths.length > 1 && oneInode(paths)) {
      sharedStorageGroups++;
      note(`shares storage: ${first} and ${paths.length - 1} other name(s) are one inode reported as a reclaimable duplicate group`);
    }
  }

  if (plantedAtOrAbove.length === 0) {
    const foundNothing = groups.length === 0 && (opts.groupCount ?? 0) === 0;
    if (!foundNothing) note(`the corpus planted no duplicates at or above ${count(minSize)} B, yet the finder reported ${count(groups.length)} group(s)`);
    return {
      ok: foundNothing,
      recall: 1,
      precision: groups.length === 0 ? 1 : (groups.length - falsePositives - sharedStorageGroups) / groups.length,
      falsePositives,
      missedGroups: 0,
      expectedGroups: 0,
      reportedGroups: groups.length,
      sharedStorageGroups,
      truncated,
      notes,
    };
  }

  const recall = expected.length === 0 ? 1 : (expected.length - missed) / expected.length;
  const precision = groups.length === 0 ? 1 : (groups.length - falsePositives - sharedStorageGroups) / groups.length;
  return {
    ok: missed === 0 && falsePositives === 0 && sharedStorageGroups === 0 && !countMismatch && (groups.length > 0 || expected.length === 0),
    recall,
    precision,
    falsePositives,
    missedGroups: missed,
    expectedGroups: expected.length,
    reportedGroups: groups.length,
    sharedStorageGroups,
    truncated,
    notes,
  };
}
