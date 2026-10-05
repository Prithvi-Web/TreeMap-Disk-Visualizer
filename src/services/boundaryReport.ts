import type { ScanResult, Snapshot } from '../models/types';
import {
  dataVolumeAlias,
  exclusionsOf,
  isAtOrUnder,
  mountOutcome,
  type BoundaryMount,
  type BoundaryRule,
  type MountOutcome,
  type MountTableSource,
  type ScanBoundary,
} from '../utils/mountBoundaries';
import { storeOf } from './scanStore';
import { storageModeOf } from './storageMode';
import { boundaryKeyOf, scanBoundaryKey, snapshotBoundaryOf } from './snapshots';
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
  // A table that was read keeps its own sentence when it has one (Windows says why it has none).
  const reason = outcome.known ? record.reason : (record.reason ?? 'the mount table could not be read');
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
  throw boundaryChanged('scans', scanA.rootPath, snapshotBoundaryOf(scanA), snapshotBoundaryOf(scanB));
}

/**
 * The same refusal for two snapshots (Trends, Compare, and the "what's new"
 * banner after a scan, which says nothing rather than call a drive left out
 * "freed").
 */
export function assertSameSnapshotBoundary(a: Snapshot, b: Snapshot): void {
  if (boundaryKeyOf(a.boundary) === boundaryKeyOf(b.boundary)) return;
  throw boundaryChanged('snapshots', a.rootPath, a.boundary, b.boundary);
}

function boundaryChanged(what: string, rootPath: string, a: Snapshot['boundary'], b: Snapshot['boundary']): AppError {
  const drives = (list: readonly string[]): string => `${list.length} drive${list.length === 1 ? '' : 's'} mounted inside it`;
  const left = (out: Snapshot['boundary']): string => {
    if (out?.rule === 'stay') return `left out ${drives(out.notEntered)}`;
    if (out?.rule === 'cross' && out.entered.length > 0) return `went into ${drives(out.entered)}`;
    return 'left no drive out';
  };
  return new AppError(
    409,
    'BOUNDARY_CHANGED',
    `These two ${what} of ${rootPath} counted different disks: the first ${left(a)}, the second ${left(b)}. ` +
      'Comparing them would show a drive as files added or removed, so compare two made with the same "drives mounted inside" setting.',
  );
}

/* ───────────────────────────── GET /api/scan/:scanId/boundary (Track U, U-26) ───────────────────────────── */

/** At most this many listed drives in one answer; `mountsListed` says how many there are. */
export const BOUNDARY_MOUNTS_CAP = 50;

/** One listed drive, as the route answers it. */
export interface BoundaryMountRow {
  path: string;
  filesystem: string;
  /** What is mounted there: a device, or the folder a nullfs or bind mount shows again. */
  source: string;
  /** The walk got to the mount point: not under a folder no walk descends into, nor beneath a refused or skipped one. */
  reached: boolean;
  /** The walk went in (`cross`). */
  entered: boolean;
  /** The logical bytes the scan counted inside: null where it did not enter, or cannot look the total up. */
  bytes: number | null;
  /**
   * What is mounted there is a folder this scan listed — inside its root, and
   * not at or beneath a folder it never descended into — so a nullfs or bind
   * view of it shows files already counted. False for a device, and for a
   * folder under /Volumes or on a drive the scan did not enter (TS review R10).
   */
  sourceListed: boolean;
}

/** The route's answer. Every list is null — with `reason` — where it is not known, never empty (U-D13). */
export interface BoundaryResponse {
  scanId: string;
  rule: BoundaryRule | null;
  source: MountTableSource | null;
  reason: string | null;
  notEntered: BoundaryCount | null;
  entered: (BoundaryCount & { bytes: number | null; reason?: string }) | null;
  crossedUnlisted: BoundaryCount | null;
  mountsListed: number | null;
  mounts: BoundaryMountRow[] | null;
}

export function boundaryResponse(scan: ScanResult): BoundaryResponse {
  const report = boundaryReport(scan);
  const base = { scanId: scan.scanId, rule: report.rule, source: report.source, reason: report.reason };
  const record = scan.boundary;
  if (!record) return { ...base, notEntered: null, entered: null, crossedUnlisted: null, mountsListed: null, mounts: null };
  const crossedUnlisted = { count: report.crossedUnlisted.count, examples: report.crossedUnlisted.examples };
  if (!report.known || record.mounts === null) return { ...base, notEntered: null, entered: null, crossedUnlisted, mountsListed: null, mounts: null };
  const o = report.outcome;
  const reached = new Set([...o.notEntered, ...o.entered, ...o.enteredWithin].map((m) => m.path));
  const entered = new Set([...o.entered, ...o.enteredWithin].map((m) => m.path));
  const sizeOf = enteredSizes(scan);
  const sourceListed = listedFolderTest(record, scan.rootPath);
  const all = [...record.mounts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const mounts = all.slice(0, BOUNDARY_MOUNTS_CAP).map((m) => ({
    path: m.path,
    filesystem: m.filesystem,
    source: m.source,
    reached: reached.has(m.path),
    entered: entered.has(m.path),
    bytes: entered.has(m.path) && sizeOf ? sizeOf(m.path) : null,
    sourceListed: sourceListed(m.source),
  }));
  const { mounts: _enteredMounts, ...enteredCount } = report.entered;
  return {
    ...base,
    notEntered: { count: report.notEntered.count, examples: report.notEntered.examples },
    entered: enteredCount,
    crossedUnlisted,
    mountsListed: all.length,
    mounts,
  };
}

/**
 * Whether a mount's source is a folder the scan listed: a path (never a
 * device's name) inside the root, and not at or beneath one of the scan's
 * exclusions. On macOS a source the table spells on the Data volume is asked
 * in the root's spelling too, as the walk met it.
 */
function listedFolderTest(record: ScanBoundary, root: string): (source: string) => boolean {
  const exclusions = exclusionsOf(record, root);
  const listed = (p: string): boolean => isAtOrUnder(root, p) && !exclusions.some((x) => isAtOrUnder(x, p));
  return (source) => {
    if (!source.startsWith('/')) return false;
    const spellings = process.platform === 'darwin' ? [source, ...dataVolumeAlias(source)] : [source];
    return spellings.some(listed);
  };
}

/** A folder's total by path, where the tree holds one for every folder; null where it does not (yet). */
function enteredSizes(scan: ScanResult): ((p: string) => number | null) | null {
  if (storageModeOf(scan) !== 'memory' || scan.status !== 'complete' || (!scan.store && !scan.root)) return null;
  const store = storeOf(scan);
  return (p) => {
    const id = store.findByPath(p);
    return id === -1 ? null : store.size(id);
  };
}

const lastName = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p;

/** Up to five names, then how many more. */
function namesOf(examples: readonly string[], count: number): string {
  const names = examples.map(lastName).join(', ');
  return count > examples.length ? `${names} and ${count - examples.length} more` : names;
}

/**
 * The sentence an agent reads beside a scan's totals (MCP `scan_path`): the
 * drives the scan did not enter, entered, or could not know about. Null when
 * there is nothing to say — no drive mounted inside, or no boundary at all.
 */
export function drivesSentence(scan: ScanResult): string | null {
  const report = boundaryReport(scan);
  if (report.rule === null) return null;
  if (!report.known) {
    return `TreeMap could not read the list of mounted drives (${report.reason ?? 'no reason given'}), so a drive mounted inside this folder may have been counted as part of it.`;
  }
  const s = (n: number): string => (n === 1 ? '' : 's');
  if (report.notEntered.count > 0) {
    return `${report.notEntered.count} drive${s(report.notEntered.count)} mounted inside ${report.notEntered.count === 1 ? 'was' : 'were'} not entered: ${namesOf(report.notEntered.examples, report.notEntered.count)}. Their files are not counted; PUT /api/settings { "scanBoundary": "cross" } includes them in the next scan.`;
  }
  if (report.entered.count > 0) {
    return `${report.entered.count} drive${s(report.entered.count)} mounted inside ${report.entered.count === 1 ? 'was' : 'were'} entered and counted: ${namesOf(report.entered.examples, report.entered.count)} (scanBoundary is "cross").`;
  }
  return null;
}
