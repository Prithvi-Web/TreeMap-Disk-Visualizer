import { readJsonFile, writeJsonFile } from './storage';
import { ActivityEvent, ActivityKind, ActivitySummary } from '../models/types';

/**
 * activity — persisted cumulative cleaner activity for the Dashboard's
 * "Lifetime impact" tiles + "Recent activity" feed. Same dependency-free JSON
 * pattern as snapshots/settings (`activity.json` in the app-data dir), chosen
 * over localStorage so the totals survive across browsers and the desktop app.
 *
 * Tools POST a delta after a confirmed-successful action (uninstall, update,
 * fast-clean, …); we never record an intended action, only a completed one.
 */

const FILE = 'activity.json';
/** Cap the recent-activity log; tiles keep the running totals regardless. */
const MAX_LOG = 200;

const ALLOWED_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'fast-clean',
  'system-junk',
  'uninstall',
  'update',
  'large-old',
]);

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === 'string' && ALLOWED_KINDS.has(v as ActivityKind);
}

function empty(): ActivitySummary {
  return {
    firstRecordedAt: null,
    totalBytesRecovered: 0,
    junkItemsCleaned: 0,
    appsUninstalled: 0,
    programsUpdated: 0,
    log: [],
  };
}

export async function getActivity(): Promise<ActivitySummary> {
  const stored = await readJsonFile<ActivitySummary>(FILE, empty());
  // Defensive normalize — the file is user-visible and could be hand-edited.
  return {
    ...empty(),
    ...stored,
    log: Array.isArray(stored.log) ? stored.log : [],
  };
}

export interface ActivityDelta {
  kind: ActivityKind;
  label?: string;
  bytes?: number;
  items?: number;
}

export async function recordActivity(delta: ActivityDelta): Promise<ActivitySummary> {
  const summary = await getActivity();
  const now = Date.now();

  const num = (v: unknown): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const event: ActivityEvent = {
    at: now,
    kind: delta.kind,
    label: String(delta.label ?? '').slice(0, 200),
    bytes: num(delta.bytes),
    items: num(delta.items),
  };

  if (summary.firstRecordedAt == null) summary.firstRecordedAt = now;
  summary.totalBytesRecovered += event.bytes;
  if (event.kind === 'uninstall') {
    summary.appsUninstalled += 1; // one event = one app removed
  } else if (event.kind === 'update') {
    summary.programsUpdated += 1;
  } else {
    summary.junkItemsCleaned += event.items; // fast-clean / system-junk / large-old
  }

  summary.log.unshift(event);
  if (summary.log.length > MAX_LOG) summary.log.length = MAX_LOG;

  await writeJsonFile(FILE, summary);
  return summary;
}
