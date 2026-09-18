/**
 * The checks that make a benchmark number mean something: an engine that is
 * fast and wrong has measured nothing. Every suite runs these against the
 * corpus manifest and a failure is printed beside the timing, never hidden.
 */
import fs from 'node:fs';

/** The parts of a corpus manifest the checks read — structural, so any generator can supply them. */
export interface PlantedTotals { dirs: number; files: number; logicalBytes: number }
export interface PlantedGroup { content: number; size: number; paths: string[] }
export interface PlantedDuplicates { root: string; duplicateGroups: PlantedGroup[] }

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

export function checkScanAgainstManifest(
  manifest: PlantedTotals,
  scan: ScanCounts,
): ManifestCheck {
  const notes: string[] = [];
  const expect = (field: string, got: number, want: number): void => {
    if (got !== want) notes.push(`${field}: the scan reported ${got.toLocaleString('en-US')}, the manifest planted ${want.toLocaleString('en-US')}`);
  };
  expect('fileCount', scan.fileCount, manifest.files);
  expect('dirCount', scan.dirCount, manifest.dirs);
  expect('scanned', scan.scanned, manifest.files + manifest.dirs);
  expect('logicalBytes', scan.rootSize, manifest.logicalBytes);
  return { ok: notes.length === 0, notes };
}

export interface ReportedGroup {
  size: number;
  files: Array<{ path: string }>;
}

export interface DuplicateCheck extends ManifestCheck {
  recall: number;
  precision: number;
  falsePositives: number;
  missedGroups: number;
  expectedGroups: number;
}

function sameBytes(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Recall: every planted group at or above `minSize` must be reported with all
 * its members in one reported group. Precision: every reported group must be
 * byte-identical throughout, proven by reading the files — the prompt's
 * "verified by byte comparison in the test", applied to the benchmark too.
 */
export function checkDuplicatesAgainstManifest(
  manifest: PlantedDuplicates,
  groups: ReportedGroup[],
  minSize: number,
): DuplicateCheck {
  const notes: string[] = [];
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.files.forEach((f) => groupOf.set(f.path, i)));

  const expected = manifest.duplicateGroups.filter((g) => g.size >= minSize);
  let missed = 0;
  for (const planted of expected) {
    const ids = new Set(planted.paths.map((p) => groupOf.get(p)));
    if (ids.size !== 1 || ids.has(undefined)) {
      missed++;
      if (notes.length < 20) notes.push(`missed: planted group of ${planted.paths.length} × ${planted.size} B (${planted.paths[0]}) was not reported whole`);
    }
  }

  let falsePositives = 0;
  for (const g of groups) {
    const first = g.files[0]?.path;
    if (!first) continue;
    for (const f of g.files.slice(1)) {
      if (!sameBytes(first, f.path)) {
        falsePositives++;
        if (notes.length < 20) notes.push(`false positive: ${first} and ${f.path} were reported as duplicates but their bytes differ`);
        break;
      }
    }
  }

  const recall = expected.length === 0 ? 1 : (expected.length - missed) / expected.length;
  const precision = groups.length === 0 ? 1 : (groups.length - falsePositives) / groups.length;
  return {
    ok: missed === 0 && falsePositives === 0,
    recall,
    precision,
    falsePositives,
    missedGroups: missed,
    expectedGroups: expected.length,
    notes,
  };
}
