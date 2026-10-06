/**
 * Human-readable byte formatting: 1500 -> "1.5 KB".
 *
 * Decimal units, as Finder counts them and as the query grammar reads `kb`,
 * `mb` and `gb`: 1 KB = 1,000 bytes, 1 MB = 1,000,000 bytes and
 * 1 GB = 1,000,000,000 bytes (the owner's answer to QA D09, 5 Oct 2026). So
 * 3,200,000,000 bytes read "3.2 GB" here, in Finder, and match `size>3gb`.
 * Until 5.2.0 this divided by 1024 under the same labels, which put every
 * figure about 7% under Finder's and made a 700,000,000-byte file read
 * "667.6 MB" while matching `size>680mb`.
 *
 * The page carries its own copy of this function (src/ui/app/000-prelude.js)
 * and the two must agree byte for byte — tests/polishServerNumbers.test.ts
 * evaluates the page's copy against this one.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(n: number, decimals = 1): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';

  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  // Rounding can carry a value that is just under 1000 up to exactly 1000.0
  // of its unit — "1000.0 KB", "1000 GB free" — which no unit system prints.
  // When the rounded figure reaches 1000, it is one of the next unit.
  const rounded = Number(value.toFixed(unit === 0 ? 0 : decimals));
  if (rounded >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

/** One megabyte as formatBytes counts it — the "1 MB" floor of the largest-files and largest-folders lists. */
export const ONE_MB = 1_000_000;
