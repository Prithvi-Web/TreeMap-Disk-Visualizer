import path from 'path';
import { BudgetEntry, ForecastResult, Snapshot, SnapshotTreeNode } from '../models/types';
import { computeForecast } from './forecast';
import { listSnapshotRoots, listSnapshots, readSnapshotTrees } from './snapshots';
import { samePath } from '../utils/osPaths';

/**
 * Budget gauges (v4 §9.4) — "when will this folder blow its budget?"
 *
 * The projection is computeForecast, reused verbatim: the folder's size
 * history plays the part of the volume's usage and the remaining headroom
 * (maxBytes − currentBytes) plays the part of free space. That reuse is the
 * point, not a shortcut — the disk-full forecast already refuses to invent a
 * number when history is thin, erratic, or shrinking, and a budget breach
 * date must pass through exactly those gates. One honesty policy, not two.
 *
 * History is harder for a budget than for a scan root, because most budget
 * folders are never scanned directly. Two sources, never mixed:
 *   - the folder's own snapshots, when it has been scanned as a root
 *     (exact, wins outright);
 *   - the shallow per-snapshot trees stored for ancestor roots, walked down
 *     to the budget folder (approximate coverage — those trees keep only the
 *     largest 2–3 levels, so some snapshots simply never recorded it).
 */

const DAY_MS = 86_400_000;

export interface BudgetHistorySeries {
  /** (takenAt, bytes) points, oldest first. */
  points: { t: number; v: number }[];
  source: 'own-scans' | 'ancestor-trees' | 'none';
  /** Present for ancestor-derived series: what this history can and cannot claim. */
  caveat?: string;
}

export interface BudgetProjection {
  status: 'over' | ForecastResult['status'];
  /** Human-readable explanation whenever status !== 'ok'. */
  reason?: string;
  /** 0–1, straight from computeForecast; 1 for the measured 'over' fact. */
  confidence: number;
  /** Fitted growth of the folder, bytes/day (0 when nothing was fitted). */
  bytesPerDay: number;
  /** Days until the budget is breached at the fitted rate — status 'ok' only. */
  breachInDays?: number;
  /** Unix epoch ms of the projected breach — status 'ok' only. */
  breachAtMs?: number;
}

export interface BudgetGauge {
  path: string;
  /** Basename, for display. */
  name: string;
  maxBytes: number;
  /** Recursive size in the current scan; null when the folder is not inside it. */
  actualBytes: number | null;
  /** actualBytes / maxBytes; null whenever actualBytes is (absent ≠ zero). */
  ratio: number | null;
  projection: BudgetProjection & {
    seriesSource: BudgetHistorySeries['source'];
    seriesPoints: number;
    caveat?: string;
  };
}

/**
 * The relative path from `rootPath` down to `childPath` as name segments, or
 * null when the child does not sit strictly below the root. path.relative is
 * deliberately not used for this: on Windows it folds case but on macOS it
 * does not, while both filesystems do — so the shared prefix is compared
 * segment by segment with samePath, which knows the platform's case rule.
 */
function relativeSegments(rootPath: string, childPath: string): string[] | null {
  const rootSegs = path.normalize(rootPath).split(path.sep).filter(Boolean);
  const childSegs = path.normalize(childPath).split(path.sep).filter(Boolean);
  // Strictly below means at least one extra segment; equality is not enough.
  if (childSegs.length <= rootSegs.length) return null;
  for (let i = 0; i < rootSegs.length; i++) {
    if (!samePath(rootSegs[i], childSegs[i])) return null;
  }
  return childSegs.slice(rootSegs.length);
}

/** Walk a stored snapshot tree down name segments; null when any hop is missing. */
function descend(tree: SnapshotTreeNode, segments: string[]): SnapshotTreeNode | null {
  let node: SnapshotTreeNode = tree;
  for (const seg of segments) {
    const next = (node.c ?? []).find((child) => samePath(child.n, seg));
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * The size history available for one budget folder. Own snapshots win
 * outright over ancestor-derived points — exact beats approximate, and the
 * two are never mixed into one series because a fit over mixed measurement
 * kinds would be neither.
 */
export async function budgetHistorySeries(budgetPath: string): Promise<BudgetHistorySeries> {
  const own = await listSnapshots(budgetPath);
  if (own.length > 0) {
    return { points: own.map((s) => ({ t: s.takenAt, v: s.totalSize })), source: 'own-scans' };
  }

  // No direct history — look for scanned roots the budget folder sits under
  // and read its size out of their stored per-snapshot trees. A tree's sizes
  // are full recursive weights even where smaller children were pruned, so
  // every point found this way is a real measurement; the approximation is
  // in the coverage, not the values.
  const roots = await listSnapshotRoots();
  const points: { t: number; v: number }[] = [];
  for (const root of roots) {
    const segments = relativeSegments(root.rootPath, budgetPath);
    if (!segments) continue;
    const [snaps, trees] = await Promise.all([
      listSnapshots(root.rootPath),
      readSnapshotTrees(root.rootPath),
    ]);
    for (const s of snaps) {
      const tree = trees[s.id];
      if (!tree) continue;
      const node = descend(tree, segments);
      if (node) points.push({ t: s.takenAt, v: node.s });
    }
  }
  if (points.length === 0) return { points: [], source: 'none' };
  points.sort((a, b) => a.t - b.t);
  return {
    points,
    source: 'ancestor-trees',
    caveat:
      'This history is read from the shallow snapshot trees of scans above this folder, which keep only the largest 2–3 levels — so it covers just the snapshots that recorded this folder.',
  };
}

/**
 * Project when a budget will be breached, through computeForecast's own
 * gates. Every non-'ok' status passes through with the forecast's own reason
 * string — nothing here rephrases, weakens, or second-guesses a refusal.
 */
export function computeBudgetProjection(
  budget: { path: string; maxBytes: number },
  currentBytes: number,
  series: { t: number; v: number }[],
  now = Date.now(),
): BudgetProjection {
  // Already at or past the limit is a measurement, not a forecast — report
  // the fact with full confidence and invent no projection on top of it.
  if (currentBytes >= budget.maxBytes) {
    return {
      status: 'over',
      reason: 'This folder is already at or past its budget limit — there is nothing left to project.',
      confidence: 1,
      bytesPerDay: 0,
    };
  }

  // Dress the series up as snapshots so computeForecast can be reused
  // verbatim, with the remaining headroom standing in for free disk space.
  const snaps: Snapshot[] = series.map((p, i) => ({
    id: `series-${i}`,
    rootPath: budget.path,
    takenAt: p.t,
    totalSize: p.v,
    fileCount: 0,
    dirCount: 0,
    topEntries: [],
  }));
  const f = computeForecast(snaps, budget.maxBytes - currentBytes, now);
  if (f.status === 'ok' && f.fullInDays !== undefined) {
    return {
      status: 'ok',
      confidence: f.confidence,
      bytesPerDay: f.bytesPerDay,
      breachInDays: f.fullInDays,
      breachAtMs: now + Math.round(f.fullInDays * DAY_MS),
    };
  }
  return { status: f.status, reason: f.reason, confidence: f.confidence, bytesPerDay: f.bytesPerDay };
}

/**
 * One gauge per budget: how full it is now and when it is projected to
 * breach. `actualBytesFor` answers from the current scan; null means the
 * folder is not inside that scan, and per §2.4 that is reported as unknown —
 * never as zero, which would read as an empty folder comfortably in budget.
 */
export async function budgetGauges(
  budgets: BudgetEntry[],
  actualBytesFor: (path: string) => number | null,
): Promise<BudgetGauge[]> {
  return Promise.all(
    budgets.map(async (b) => {
      const series = await budgetHistorySeries(b.path);
      // The caveat key is spread in only when it exists, so a caveat-free
      // gauge carries no `caveat: undefined` for consumers to trip on.
      const meta = {
        seriesSource: series.source,
        seriesPoints: series.points.length,
        ...(series.caveat !== undefined && { caveat: series.caveat }),
      };
      const base = {
        path: b.path,
        // A budget on a bare root ('/', 'C:\\') has no basename — fall back
        // to the path itself rather than displaying an empty name.
        name: path.basename(b.path) || b.path,
        maxBytes: b.maxBytes,
      };
      const actual = actualBytesFor(b.path);
      if (actual === null) {
        return {
          ...base,
          actualBytes: null,
          ratio: null,
          projection: {
            status: 'insufficient' as const,
            reason: 'This folder is not inside the current scan, so its size here is unknown.',
            confidence: 0,
            bytesPerDay: 0,
            ...meta,
          },
        };
      }
      return {
        ...base,
        actualBytes: actual,
        // A zero-byte ceiling would make the ratio infinite — that budget is
        // always simply 'over', and the meter shows no honest percentage.
        ratio: b.maxBytes > 0 ? actual / b.maxBytes : null,
        projection: { ...computeBudgetProjection(b, actual, series.points), ...meta },
      };
    }),
  );
}
