import { Snapshot, ForecastGrower, ForecastResult } from '../models/types';
import { listSnapshots } from './snapshots';
import { diskUsage } from './diskUsage';

/**
 * Forecast — "when does this disk fill up?" from snapshot history.
 *
 * Two least-squares fits over (takenAt, totalSize): an ordinary linear one
 * and a recent-weighted one whose point weights halve every HALF_LIFE_DAYS.
 * The weighted slope drives the projection — recent behaviour matters more —
 * while agreement between the two fits feeds the confidence score.
 *
 * Honesty gates (never a bogus number): fewer than MIN_SNAPSHOTS scans or a
 * history shorter than MIN_SPAN_DAYS → 'insufficient'; a weighted fit that
 * explains too little of the variance → 'erratic'; flat or negative growth →
 * 'stable' / 'shrinking'.
 */

const MIN_SNAPSHOTS = 5;
const MIN_SPAN_DAYS = 2;
const HALF_LIFE_DAYS = 7;
const MIN_R2 = 0.3;
/** Beyond ~10 years the number is noise — call it stable. */
const MAX_FORECAST_DAYS = 3650;
/** |slope| below this is measurement noise, not a trend. */
const STABLE_BYTES_PER_DAY = 1_048_576;
const TOP_GROWERS = 5;
/** Growers below this rate aren't culprits worth naming. */
const GROWER_MIN_BYTES_PER_DAY = 1_048_576;
const DAY_MS = 86_400_000;

export interface GrowthFit {
  /** Fitted slope in bytes/day. */
  slopePerDay: number;
  /** Weighted coefficient of determination (0–1). */
  r2: number;
}

/**
 * (Weighted) least-squares line through (t, v) points. halfLifeDays null =
 * plain linear fit; otherwise a point's weight halves per half-life of age.
 */
export function fitGrowth(points: { t: number; v: number }[], halfLifeDays: number | null, now: number): GrowthFit {
  if (points.length < 2) return { slopePerDay: 0, r2: 0 };
  const w = points.map((p) => (halfLifeDays ? Math.pow(0.5, (now - p.t) / (halfLifeDays * DAY_MS)) : 1));
  let sw = 0, swx = 0, swy = 0;
  points.forEach((p, i) => { sw += w[i]; swx += w[i] * p.t; swy += w[i] * p.v; });
  const mx = swx / sw, my = swy / sw;
  let num = 0, den = 0;
  points.forEach((p, i) => { const dx = p.t - mx; num += w[i] * dx * (p.v - my); den += w[i] * dx * dx; });
  if (den === 0) return { slopePerDay: 0, r2: 0 };
  const slope = num / den;
  let ssRes = 0, ssTot = 0;
  points.forEach((p, i) => {
    const pred = my + slope * (p.t - mx);
    ssRes += w[i] * (p.v - pred) ** 2;
    ssTot += w[i] * (p.v - my) ** 2;
  });
  // A perfectly flat series is a perfect fit of slope 0, not a failed one.
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slopePerDay: slope * DAY_MS, r2 };
}

/** Fastest-growing top-level entries across the snapshot history. */
function collectTopGrowers(snaps: Snapshot[], now: number): ForecastGrower[] {
  const series = new Map<string, { name: string; points: { t: number; v: number }[] }>();
  for (const snap of snaps) {
    for (const e of snap.topEntries) {
      let s = series.get(e.path);
      if (!s) { s = { name: e.name, points: [] }; series.set(e.path, s); }
      s.points.push({ t: snap.takenAt, v: e.size });
    }
  }
  const latest = new Set(snaps[snaps.length - 1].topEntries.map((e) => e.path));
  const growers: ForecastGrower[] = [];
  for (const [path, s] of series) {
    if (!latest.has(path) || s.points.length < 3) continue; // gone, or too thin to fit
    const fit = fitGrowth(s.points, HALF_LIFE_DAYS, now);
    if (fit.slopePerDay >= GROWER_MIN_BYTES_PER_DAY) {
      growers.push({ name: s.name, path, bytesPerDay: Math.round(fit.slopePerDay) });
    }
  }
  return growers.sort((a, b) => b.bytesPerDay - a.bytesPerDay).slice(0, TOP_GROWERS);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure forecast over a root's snapshots — everything testable lives here. */
export function computeForecast(
  snaps: Snapshot[],
  freeBytes: number,
  now = Date.now(),
): Omit<ForecastResult, 'path'> {
  const sorted = [...snaps].sort((a, b) => a.takenAt - b.takenAt);
  const count = sorted.length;
  const spanDays = count >= 2 ? (sorted[count - 1].takenAt - sorted[0].takenAt) / DAY_MS : 0;
  const base = {
    confidence: 0,
    bytesPerDay: 0,
    freeBytes,
    snapshotCount: count,
    spanDays: round2(spanDays),
    topGrowers: [] as ForecastGrower[],
  };

  if (count < MIN_SNAPSHOTS || spanDays < MIN_SPAN_DAYS) {
    return {
      ...base,
      status: 'insufficient',
      reason: `Not enough history yet — ${count} scan${count === 1 ? '' : 's'} over ${spanDays < 0.05 ? 'less than an hour' : `${round2(spanDays)} day${spanDays === 1 ? '' : 's'}`}. Forecasting needs at least ${MIN_SNAPSHOTS} scans spanning ${MIN_SPAN_DAYS}+ days.`,
    };
  }

  const points = sorted.map((s) => ({ t: s.takenAt, v: s.totalSize }));
  const linear = fitGrowth(points, null, now);
  const weighted = fitGrowth(points, HALF_LIFE_DAYS, now);
  const slope = weighted.slopePerDay;

  // Confidence: fit quality × history richness × how much both fits agree.
  const spanFactor = Math.min(1, spanDays / 14);
  const countFactor = Math.min(1, count / 10);
  const denom = Math.max(Math.abs(linear.slopePerDay), Math.abs(slope), 1);
  const agreement = 1 - Math.min(1, Math.abs(linear.slopePerDay - slope) / denom);
  const confidence = round2(weighted.r2 * spanFactor * countFactor * (0.5 + 0.5 * agreement));

  const bytesPerDay = Math.round(slope);
  const topGrowers = collectTopGrowers(sorted, now);

  if (Math.abs(slope) < STABLE_BYTES_PER_DAY) {
    return { ...base, status: 'stable', confidence, bytesPerDay, topGrowers, reason: 'Usage is essentially flat — no fill-up in sight.' };
  }
  if (slope < 0) {
    return { ...base, status: 'shrinking', confidence, bytesPerDay, topGrowers, reason: 'Usage is trending down — no fill-up in sight.' };
  }
  if (weighted.r2 < MIN_R2) {
    return { ...base, status: 'erratic', confidence, bytesPerDay, topGrowers, reason: 'Growth is too erratic between scans to project honestly.' };
  }
  const fullInDays = freeBytes / slope;
  if (!Number.isFinite(fullInDays) || fullInDays > MAX_FORECAST_DAYS) {
    return { ...base, status: 'stable', confidence, bytesPerDay, topGrowers, reason: 'At the current rate the disk won’t fill for years.' };
  }
  return { ...base, status: 'ok', fullInDays: round2(fullInDays), confidence, bytesPerDay, topGrowers };
}

/** Forecast for a scanned root: snapshot history + the volume's free space. */
export async function getForecast(rootPath: string): Promise<ForecastResult> {
  const [snaps, usage] = await Promise.all([
    listSnapshots(rootPath),
    diskUsage(rootPath).catch(() => null),
  ]);
  if (!usage) {
    return {
      path: rootPath,
      status: 'insufficient',
      confidence: 0,
      bytesPerDay: 0,
      freeBytes: 0,
      snapshotCount: snaps.length,
      spanDays: 0,
      topGrowers: [],
      reason: 'Could not read the volume’s free space.',
    };
  }
  return { path: rootPath, ...computeForecast(snaps, usage.free) };
}
