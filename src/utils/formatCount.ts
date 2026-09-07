/**
 * Numbers and dates, written the way the rest of the interface writes them.
 *
 * The interface is in English, and `formatBytes` already prints an English
 * decimal point ("1.2 GB") whatever the machine's locale, so counts use
 * English grouping too: "1,234". A bare `toLocaleString()` followed the
 * machine instead — on a Portuguese Windows it printed "1.234 shapes" beside
 * "1.2 GB", the same dot meaning thousands in one and tenths in the other, and
 * on an Arabic one it printed Arabic-Indic digits inside English sentences
 * (issue #34). Every number a person reads goes through here or the page's
 * own `formatCount` (src/ui/app/000-prelude.js), which does the same thing; a
 * test that hard-codes "1,234" is therefore right on every machine, and the
 * suite runs under a Portuguese locale in CI to prove it.
 *
 * Dates are English for the same reason ("Sep 6, 2026" inside an English
 * sentence). What stays the machine's is its time zone and its 12- or 24-hour
 * clock: a reader's habit, not a dialect.
 */
export const UI_LOCALE = 'en-US';

/** 'h12' on a machine whose clock says 10:31 PM, 'h23' where it says 22:31. */
export function machineHourCycle(): 'h11' | 'h12' | 'h23' | 'h24' {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle ?? 'h23';
}

/**
 * A count. Nothing (null, undefined) is 0; a numeric string is its number; a
 * number that is not one (NaN, Infinity) prints the dash the page prints for
 * no date, so a broken calculation is seen as broken rather than read as
 * "none" — this app has printed a measured value as 0 before.
 */
export function formatCount(n: number | string | null | undefined): string {
  const v = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
  if (v === null || v === undefined) return '0';
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString(UI_LOCALE) : '–';
}
