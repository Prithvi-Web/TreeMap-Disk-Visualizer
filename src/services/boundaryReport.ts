import type { ScanResult } from '../models/types';
import { mountOutcome, type BoundaryMount, type BoundaryRule, type MountOutcome, type MountTableSource } from '../utils/mountBoundaries';
import { storeOf } from './scanStore';
import { storageModeOf } from './storageMode';
import { scanBoundaryKey, snapshotBoundaryOf } from './snapshots';
import { AppError } from '../middleware/errorHandler';

/**
 * What a scan did at the drives mounted inside its folder (Track U, U-24), in
 * the words every reader shares: the boundary route (U-26), the Dashboard's
 * note (U-27) and the Missing Gigabytes line (U-28).
 *
 * Every count comes from the scan's boundary and its walk's own records
 * (`mountOutcome`), never from the shape of the tree. Only the BYTES inside
 * the drives a scan entered are read from the tree, and only where the tree
 * holds a row for every folder; anywhere else they are `null` with the reason.
 */

/** Example paths beside a count: the five smallest, sorted. */
export const BOUNDARY_REPORT_EXAMPLES = 5;

export interface BoundaryCount {
  count: number;
  examples: string[];
}

export interface BoundaryReport {
  /** The rule the scan ran under; null when the record has no boundary at all. */
  rule: BoundaryRule | null;
  source: MountTableSource | null;
  /** Why nothing below is known: no boundary on the record, or a mount table that could not be read. */
  reason: string | null;
  /** False when the mount table could not be read, or the record has none: no list below is a reading. */
  known: boolean;
  /** stay: the drives mounted inside that the walk reached and did not enter. */
  notEntered: BoundaryCount & { mounts: BoundaryMount[] };
  /** cross: the outermost drives the walk entered, and the logical bytes the scan counted inside them. */
  entered: BoundaryCount & { mounts: BoundaryMount[]; bytes: number | null; reason?: string };
  /** Folders the built-in walker went into on another device that the table did not list. */
  crossedUnlisted: BoundaryCount;
  /** The full outcome, for readers that list every mount. */
  outcome: MountOutcome;
}

const NO_RECORD =
  'this scan was made without a mount boundary (a cloud listing, or a record from before TreeMap read the mount table), so which drives it entered is not known';

function counted(mounts: readonly BoundaryMount[]): BoundaryCount {
  return { count: mounts.length, examples: mounts.map((m) => m.path).sort().slice(0, BOUNDARY_REPORT_EXAMPLES) };
}

/** The logical bytes the scan counted inside the outermost entered drives, or null with the reason. */
function enteredBytes(scan: ScanResult, mounts: readonly BoundaryMount[]): { bytes: number | null; reason?: string } {
  if (mounts.length === 0) return { bytes: 0 };
  const mode = storageModeOf(scan);
  if (mode !== 'memory') {
    return { bytes: null, reason: `this scan is kept in ${mode} mode, which does not look a folder's total up by its path yet` };
  }
  if (scan.status !== 'complete' || (!scan.store && !scan.root)) {
    return { bytes: null, reason: 'the scan has not finished, so its totals are not known yet' };
  }
  const store = storeOf(scan);
  let bytes = 0;
  for (const m of mounts) {
    const id = store.findByPath(m.path);
    if (id === -1) return { bytes: null, reason: `${m.path} is not in the scan's tree, so what the scan counted inside it is not known` };
    bytes += store.size(id);
  }
  return { bytes };
}

export function boundaryReport(scan: ScanResult): BoundaryReport {
  const record = scan.boundary;
  if (!record) {
    const none = mountOutcome({ rule: 'stay', source: 'none', reason: null, mounts: null, fixed: [], neverDescend: [], walk: { crossedUnlisted: { count: 0, examples: [] }, refusedAbove: new Set(), skipped: new Set() } });
    return {
      rule: null,
      source: null,
      reason: NO_RECORD,
      known: false,
      notEntered: { count: 0, examples: [], mounts: [] },
      entered: { count: 0, examples: [], mounts: [], bytes: null, reason: NO_RECORD },
      crossedUnlisted: { count: 0, examples: [] },
      outcome: none,
    };
  }
  const outcome = mountOutcome(record);
  const reason = outcome.known ? null : (record.reason ?? 'the mount table could not be read');
  const entered = outcome.known ? enteredBytes(scan, outcome.entered) : { bytes: null, reason: reason ?? undefined };
  return {
    rule: record.rule,
    source: record.source,
    reason,
    known: outcome.known,
    notEntered: { ...counted(outcome.notEntered), mounts: outcome.notEntered },
    entered: { ...counted(outcome.entered), mounts: outcome.entered, ...entered },
    crossedUnlisted: { count: record.walk.crossedUnlisted.count, examples: [...record.walk.crossedUnlisted.examples] },
    outcome,
  };
}

/**
 * Comparing two scans that stopped at different drives would read a drive as
 * files added or removed (Track U, U-24): refused, the route and the MCP tool
 * alike, with the reason. `scanBoundaryKey` is the same key history uses.
 */
export function assertSameBoundary(scanA: ScanResult, scanB: ScanResult): void {
  if (scanBoundaryKey(scanA) === scanBoundaryKey(scanB)) return;
  const left = (s: ScanResult): string => {
    const out = snapshotBoundaryOf(s);
    return out && out.rule === 'stay' ? `left out ${out.notEntered.length} drive${out.notEntered.length === 1 ? '' : 's'} mounted inside it` : 'counted every drive mounted inside it';
  };
  throw new AppError(
    409,
    'BOUNDARY_CHANGED',
    `These two scans of ${scanA.rootPath} counted different disks: the first ${left(scanA)}, the second ${left(scanB)}. ` +
      'Comparing them would show a drive as files added or removed, so compare two scans made with the same "drives mounted inside" setting.',
  );
}
