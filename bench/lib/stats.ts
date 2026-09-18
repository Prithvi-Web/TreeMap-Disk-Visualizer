/**
 * The measurement arithmetic — pure functions over a list of run times.
 *
 * The resolution band is the rule scripts/bench-v4.ts established: not
 * max-minus-min (one scheduler hiccup sets that), but the standard error of
 * the *median* from a robust IQR-based dispersion estimate, reported at 2 SE.
 * A measurement that cannot be resolved (one run, a zero median) says so with
 * `Infinity` rather than printing a confident zero, and an empty list is a
 * caller bug, not a statistic.
 */

/** IQR → sigma for a normal distribution (the 25th–75th percentile span is 1.349 sigma). */
const IQR_TO_SIGMA = 1.349;
/** The median's standard error is 1.2533 · sigma / √n (√(π/2) times the mean's). */
const MEDIAN_SE_FACTOR = 1.2533;
/** Reported at two standard errors — roughly a 95% band. */
const BAND_SE_MULTIPLE = 2;

function sortedCopy(values: number[]): number[] {
  if (values.length === 0) throw new RangeError('a statistic of an empty list is not a number');
  return [...values].sort((a, b) => a - b);
}

/** The middle value, or the mean of the two middle values. Throws on an empty list. */
export function median(values: number[]): number {
  const sorted = sortedCopy(values);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Full observed range as a percentage of the median: (max − min) / median · 100. Infinity when the median is not positive. */
export function spreadPct(values: number[]): number {
  const m = median(values);
  if (m <= 0) return Infinity;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return ((max - min) / m) * 100;
}

/** Linear-interpolated quantile of an ascending list, q in [0, 1]. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The resolution of the median as a percentage of itself:
 * sigma ≈ IQR / 1.349, SE ≈ 1.2533 · sigma / √n, band = 2 · SE / median · 100.
 * Infinity when fewer than two runs were taken or the median is not positive.
 */
export function resolutionBand(values: number[]): number {
  const m = median(values);
  if (m <= 0 || values.length < 2) return Infinity;
  const sorted = sortedCopy(values);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const sigma = iqr / IQR_TO_SIGMA;
  const se = (MEDIAN_SE_FACTOR * sigma) / Math.sqrt(values.length);
  return ((BAND_SE_MULTIPLE * se) / m) * 100;
}

export const formatMs = (n: number): string => `${n.toFixed(1)} ms`;
