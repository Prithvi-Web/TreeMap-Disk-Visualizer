/**
 * Human-readable byte formatting: 1536 -> "1.5 KB".
 * Uses binary (1024) steps, matching what Finder/Explorer users expect
 * closely enough for a disk visualizer.
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
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Rounding can carry a value that is just under 1024 up to exactly 1024.0
  // of its unit — "1024.0 KB", "1024 GB free" — which no unit system prints.
  // When the rounded figure reaches 1024, it is one of the next unit.
  const rounded = Number(value.toFixed(unit === 0 ? 0 : decimals));
  if (rounded >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
