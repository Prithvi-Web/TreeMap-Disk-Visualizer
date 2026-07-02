import crypto from 'crypto';
import { GrowthNotification, ScheduleConfig } from '../models/types';
import { startScan, getScan } from './diskScanner';
import { getSettings, patchSchedule } from './settings';
import { listSnapshots } from './snapshots';
import { getForecast } from './forecast';
import { sanitizePath } from '../utils/pathSanitizer';
import { formatBytes } from '../utils/formatBytes';

/**
 * Scheduler — recurring scans with growth alerts. A plain setInterval ticks
 * once a minute and starts any schedule that is due; node-cron would add a
 * dependency for no extra capability at this granularity (hours, not
 * cron-second precision).
 *
 * Scans only happen while the app is running — on the desktop the app sits
 * in the tray, so "daily" effectively means "first tick after 24h elapsed".
 * Alerts go to the in-memory notification list (polled by the web UI) and to
 * any registered handler (the Electron main process shows a native
 * Notification).
 */

const TICK_MS = 60_000;
const SCAN_TIMEOUT_MS = 30 * 60_000;
const MAX_NOTIFICATIONS = 100;

let timer: NodeJS.Timeout | null = null;
const inFlight = new Set<string>();
const notifications: GrowthNotification[] = [];

type AlertHandler = (n: GrowthNotification) => void;
const alertHandlers: AlertHandler[] = [];

/** Register a native-notification hook (used by the Electron main process). */
export function onGrowthAlert(fn: AlertHandler): void {
  alertHandlers.push(fn);
}

/** Notifications newer than `since` (epoch ms), oldest first. */
export function listNotifications(since = 0): GrowthNotification[] {
  return notifications.filter((n) => n.at > since);
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref(); // never keep the process alive on its own
  void tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  let schedules: ScheduleConfig[];
  try {
    schedules = (await getSettings()).schedules;
  } catch {
    return;
  }
  const now = Date.now();
  for (const sched of schedules) {
    if (!sched.enabled || inFlight.has(sched.id)) continue;
    const due = !sched.lastRunAt || now - sched.lastRunAt >= sched.intervalHours * 3_600_000;
    if (!due) continue;
    inFlight.add(sched.id);
    void runScheduled(sched)
      .catch((err: unknown) => console.error('[treemap] scheduled scan failed:', err))
      .finally(() => inFlight.delete(sched.id));
  }
}

/** Record a notification and fan it out to native handlers. */
function pushNotification(n: Omit<GrowthNotification, 'id' | 'at'>): void {
  const notification: GrowthNotification = { id: crypto.randomUUID(), at: Date.now(), ...n };
  notifications.push(notification);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  for (const fn of alertHandlers) {
    try {
      fn(notification);
    } catch {
      /* a broken handler must not break the scheduler */
    }
  }
}

/** Per root, don't repeat the disk-full warning more often than this. */
const FORECAST_REALERT_MS = 20 * 3_600_000;
const lastForecastAlert = new Map<string, number>();

/** After a scheduled scan: warn when the disk-full forecast crosses the threshold. */
async function maybeForecastAlert(target: string): Promise<void> {
  try {
    const { forecastThresholdDays } = await getSettings();
    const f = await getForecast(target);
    if (f.status !== 'ok' || f.fullInDays === undefined || f.fullInDays > forecastThresholdDays) return;
    const last = lastForecastAlert.get(target) ?? 0;
    if (Date.now() - last < FORECAST_REALERT_MS) return;
    lastForecastAlert.set(target, Date.now());
    const days = Math.max(1, Math.round(f.fullInDays));
    const culprits = f.topGrowers.slice(0, 3).map((g) => g.name).join(', ');
    pushNotification({
      path: target,
      message: `At current growth, the disk holding ${target} is full in ~${days} day${days === 1 ? '' : 's'}` +
        (culprits ? ` — top culprits: ${culprits}` : ''),
      prevSize: f.freeBytes,
      newSize: f.freeBytes,
      delta: f.bytesPerDay,
    });
  } catch {
    /* forecasting is best-effort — never fail the scheduled scan */
  }
}

async function runScheduled(sched: ScheduleConfig): Promise<void> {
  // Stamp lastRunAt up front so a failing path can't retry every minute.
  await patchSchedule(sched.id, { lastRunAt: Date.now() });

  const target = sanitizePath(sched.path); // throws on blocked/invalid paths
  const history = await listSnapshots(target);
  const prev = history[history.length - 1];

  const scan = await startScan(target);
  await waitForScan(scan.scanId);
  const done = getScan(scan.scanId);
  if (!done || done.status !== 'complete' || !done.root) return;

  await maybeForecastAlert(target);
  if (!prev) return; // first record of this folder — nothing to compare against

  const delta = done.root.size - prev.totalSize;
  const pct = prev.totalSize > 0 ? (delta / prev.totalSize) * 100 : 0;
  const overBytes = sched.thresholdBytes !== undefined && delta >= sched.thresholdBytes;
  const overPct = sched.thresholdPct !== undefined && pct >= sched.thresholdPct;
  if (!overBytes && !overPct) return;

  pushNotification({
    path: target,
    message: `${target} grew by ${formatBytes(delta)} (${pct.toFixed(1)}%) since the previous scan`,
    prevSize: prev.totalSize,
    newSize: done.root.size,
    delta,
  });
}

function waitForScan(scanId: string): Promise<void> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = (): void => {
      const scan = getScan(scanId);
      if (!scan || scan.status !== 'running' || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(check, 1000).unref();
    };
    check();
  });
}
