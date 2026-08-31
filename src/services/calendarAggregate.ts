import fs from 'fs';
import { TreeSource, asStore } from './scanStore';
import { STAT_CAP as QUERY_STAT_CAP } from './query/execute';

/**
 * calendarAggregate — per-local-day activity for the calendar view.
 *
 * The client tree is pruned and carries `modifiedAt` only, and the golden lock
 * forbids adding per-node fields — so the calendar is served whole from here
 * instead. Two channels:
 *
 *  - `modified` comes from the scan tree via eachFile + modifiedAt: free and
 *    exact for every file, always returned.
 *  - `created` is opt-in, because no scan records creation times — each one
 *    costs a separate statSync. The reads are capped, and everything the cap,
 *    a permission, or the filesystem withheld is said out loud in `degraded`
 *    (same contract as src/services/query/execute.ts).
 *
 * Buckets are LOCAL days — the process timezone decides where midnight falls,
 * DST included, which is why new Date().getFullYear/Month/Date does the
 * bucketing and no arithmetic on "24 hours" appears anywhere in this file.
 * Days are emitted only when at least one counted file landed on them: a day
 * the cap prevented reading is absent, never reported as zero.
 */

/** THE query engine's `created:` stat budget — shared, not copied, so the two cannot drift. */
export const STAT_CAP = QUERY_STAT_CAP;

export interface CalendarDay {
  /** Local calendar day, 'YYYY-MM-DD'. */
  date: string;
  bytes: number;
  count: number;
}

export interface CalendarResult {
  /** Every file in the scan, bucketed by mtime. Ascending by date. */
  modified: CalendarDay[];
  /** Only when requested — files whose birthtime was actually read. */
  created?: CalendarDay[];
  /** What the created channel could not read, in prose. Empty when nothing degraded. */
  degraded: { provider: string; reason: string }[];
}

export interface CalendarOptions {
  /** Stat birthtimes and add the `created` channel (default false). */
  includeCreated?: boolean;
  /** Tests only: override the stat budget. */
  statCap?: number;
  /** Tests only: override the birthtime read. Must throw on an unreadable path. */
  birthtimeOf?: (path: string) => number;
}

/**
 * The local day this instant falls on. Date's accessors answer in the process
 * timezone, so DST days of 23 or 25 hours bucket correctly by construction.
 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function add(days: Map<string, { bytes: number; count: number }>, key: string, bytes: number): void {
  const entry = days.get(key);
  if (entry) {
    entry.bytes += bytes;
    entry.count++;
  } else {
    days.set(key, { bytes, count: 1 });
  }
}

/** YYYY-MM-DD sorts lexicographically in date order — deterministic by key. */
function toSortedDays(days: Map<string, { bytes: number; count: number }>): CalendarDay[] {
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { bytes, count }]) => ({ date, bytes, count }));
}

// birthtimeMs is 0 on filesystems that do not record a creation time.
const statBirthtime = (p: string): number => fs.statSync(p).birthtimeMs;

export function aggregateCalendar(source: TreeSource, opts: CalendarOptions = {}): CalendarResult {
  const store = asStore(source);
  const statCap = opts.statCap ?? STAT_CAP;
  const birthtimeOf = opts.birthtimeOf ?? statBirthtime;

  const modified = new Map<string, { bytes: number; count: number }>();
  const created = new Map<string, { bytes: number; count: number }>();
  const degraded = new Map<string, string>();

  let statsSpent = 0;
  let statsCapped = 0;
  let statsFailed = 0;
  let statsUnknown = 0;
  let mtimeUnknown = 0;

  store.eachFile(store.rootId, (id) => {
    // diskScanner's rule, held here too: a timestamp of 0 (or worse) means
    // "never recorded" — skipped and reported, never bucketed onto 1969/1970
    // as if that were a real day of work.
    const mtime = store.modifiedAt(id);
    if (mtime > 0) add(modified, localDayKey(mtime), store.size(id));
    else mtimeUnknown++;

    if (!opts.includeCreated) return;
    if (statsSpent >= statCap) {
      statsCapped++;
      return;
    }
    statsSpent++;
    let birth: number;
    try {
      birth = birthtimeOf(store.path(id));
    } catch {
      // Unreadable — a permission the process lacks. Counted, and reported, so
      // it does not become a silent gap in the calendar.
      statsFailed++;
      return;
    }
    // Unknown, never "day zero": a 0 (or garbage) birthtime must not bucket
    // every such file onto 1970-01-01 as if that were a real day of work.
    if (!(birth > 0)) {
      statsUnknown++;
      return;
    }
    add(created, localDayKey(birth), store.size(id));
  });

  if (statsCapped > 0) {
    degraded.set('created', `Creation dates were read for ${statsSpent.toLocaleString()} files; ${statsCapped.toLocaleString()} more were skipped. No scan records creation times, so each one costs a separate read.`);
  }
  if (statsFailed > 0) {
    degraded.set('createdUnreadable', `${statsFailed.toLocaleString()} file${statsFailed === 1 ? '' : 's'} could not be read to find a creation date, so they are not in the created days.`);
  }
  if (statsUnknown > 0) {
    degraded.set('createdUnknown', `${statsUnknown.toLocaleString()} file${statsUnknown === 1 ? ' has' : 's have'} no recorded creation time on this filesystem, so they are not in the created days.`);
  }
  if (mtimeUnknown > 0) {
    degraded.set('modifiedUnknown', `${mtimeUnknown.toLocaleString()} file${mtimeUnknown === 1 ? ' has' : 's have'} no recorded modification time, so they are not in the modified days.`);
  }

  return {
    modified: toSortedDays(modified),
    ...(opts.includeCreated ? { created: toSortedDays(created) } : {}),
    degraded: [...degraded].map(([provider, reason]) => ({ provider, reason })),
  };
}
