import crypto from 'crypto';
import { GrowthNotification, ScanResult, ScheduleConfig, Snapshot } from '../models/types';
import { startScan, getScan, scanRootPathOf } from './diskScanner';
import { getSettings, patchSchedule } from './settings';
import { runDuePolicies } from './autopilot';
import { boundaryKeyOf, listSnapshots, scanBoundaryKey } from './snapshots';
import { getForecast } from './forecast';
import { recordScanJournal } from './journal';
import { sanitizePath } from '../utils/pathSanitizer';
import { assertScanAllowed, getPolicy } from './policy';
import { formatBytes } from '../utils/formatBytes';

/**
 * Scheduler — recurring scans with growth alerts. A plain setInterval ticks
 * once a minute and starts any schedule that is due; node-cron would add a
 * dependency for no extra capability at this granularity (hours, not
 * cron-second precision).
 *
 * Scans only happen while the app is running — on the desktop the app sits
 * in the tray, so "daily" effectively means "first tick after 24h elapsed".
 * None starts in the first LAUNCH_HOLD_MS after the app opens (below).
 * Alerts go to the in-memory notification list (polled by the web UI) and to
 * any registered handler (the Electron main process shows a native
 * Notification).
 */

const TICK_MS = 60_000;
const SCAN_TIMEOUT_MS = 30 * 60_000;
const MAX_NOTIFICATIONS = 100;

/**
 * How long after the scheduler starts — the server starts it as it starts
 * listening, so as TreeMap opens — before any scheduled scan or Autopilot run
 * may start. The owner, 17 Oct 2026: "When you open TreeMap it automatically
 * runs a scan". A schedule that came due while the app was closed is the
 * person's own setting, but its catch-up run started the moment the app
 * opened; it now runs at the first tick after this hold, and so does any run
 * that falls due inside it. Autopilot rides the same tick and is held too: its
 * cooldown says a policy is due, never when TreeMap opened, so a policy whose
 * cooldown ran out while the app was closed ran at launch as well. The
 * settings sheet says this in its own words (110-modal-settings.html).
 */
export const LAUNCH_HOLD_MS = 10 * 60_000;

/** What a tick reads the time with and what it runs: the real ones, unless a test brings its own. */
interface SchedulerDeps {
  now: () => number;
  launchHoldMs: number;
  runScheduled: (sched: ScheduleConfig) => Promise<void>;
  runDuePolicies: () => Promise<unknown>;
}
const REAL_DEPS: SchedulerDeps = {
  now: () => Date.now(),
  launchHoldMs: LAUNCH_HOLD_MS,
  runScheduled: (sched) => runScheduled(sched),
  runDuePolicies: () => runDuePolicies(),
};
let deps: SchedulerDeps = REAL_DEPS;

/**
 * Tests: a clock, a hold and the two kinds of run of their own (any left out
 * stay real); null puts every real one back. Counted, never timed.
 */
export function setSchedulerForTests(over: Partial<SchedulerDeps> | null): void {
  deps = over ? { ...REAL_DEPS, ...over } : REAL_DEPS;
}

let timer: NodeJS.Timeout | null = null;
/** Nothing runs before this moment (deps.now()): LAUNCH_HOLD_MS after the scheduler last started. */
let heldUntil = 0;
/** The tick most recently begun, for a test to wait on. */
let lastTick: Promise<void> = Promise.resolve();
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
  heldUntil = deps.now() + deps.launchHoldMs; // nothing runs as TreeMap opens (LAUNCH_HOLD_MS)
  timer = setInterval(() => { lastTick = tick(); }, TICK_MS);
  timer.unref(); // never keep the process alive on its own
  lastTick = tick();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Tests: one tick now, resolved once it has decided what to start (what it starts runs on). */
export function tickForTests(): Promise<void> {
  lastTick = tick();
  return lastTick;
}

/** Tests: the tick most recently begun — startScheduler's own first one, say — once it has decided. */
export function lastTickForTests(): Promise<void> {
  return lastTick;
}

async function tick(): Promise<void> {
  // Held as TreeMap opens: a run that came due while it was closed waits for
  // the first tick after LAUNCH_HOLD_MS, Autopilot's included.
  if (deps.now() < heldUntil) return;
  // Autopilot policies ride this same tick rather than starting a second timer
  // (§B1: extend the Scheduler, don't duplicate it). Its own cooldown decides
  // when a policy is actually due, so checking every minute costs nothing.
  void deps.runDuePolicies().catch((err: unknown) => console.error('[treemap] autopilot tick failed:', err));

  let schedules: ScheduleConfig[];
  try {
    schedules = (await getSettings()).schedules;
  } catch {
    return;
  }
  const now = deps.now();
  for (const sched of schedules) {
    if (!sched.enabled || inFlight.has(sched.id)) continue;
    const due = !sched.lastRunAt || now - sched.lastRunAt >= sched.intervalHours * 3_600_000;
    if (!due) continue;
    inFlight.add(sched.id);
    void deps.runScheduled(sched)
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

/**
 * One scheduled scan, start to finish (`tick`, when it falls due). Exported
 * for its tests. agent-policy.json's allowedRoots "confines both scanning and
 * destruction", and a scan is the entry ticket to acting on what it listed,
 * so a scheduled one is held to it as a scan asked for now is (POST /api/scan,
 * the MCP scan_path tool, Autopilot, a paired peer): a schedule saved before
 * the policy narrowed is refused 403 POLICY_ROOT_NOT_ALLOWED each time it
 * falls due, nothing is scanned, and the tick logs why (the SEC-2c review,
 * F2.5). PUT /api/settings refuses a new one outside them as it is saved.
 */
export async function runScheduled(sched: ScheduleConfig): Promise<void> {
  // Stamp lastRunAt up front so a failing path can't retry every minute.
  await patchSchedule(sched.id, { lastRunAt: Date.now() });

  const target = sanitizePath(sched.path); // throws on blocked/invalid paths
  assertScanAllowed(await getPolicy(), target);
  // The folder the scan is rooted at, which its snapshot is saved under: a
  // link to a folder is scanned as that folder (QA D78), and read by the
  // link's path the history held none of it — no growth alert, no forecast.
  const root = await scanRootPathOf(target);
  const history = await listSnapshots(root);
  const prev = history[history.length - 1];

  // Eco whatever the setting says: nobody asked for this scan right now, so
  // it must never be the reason the computer feels slow (Phase 2, §8.5).
  const scan = await startScan(target, { budget: 'eco' });
  await waitForScan(scan.scanId);
  const done = getScan(scan.scanId);
  if (!done || done.status !== 'complete' || !done.store) return;

  await maybeForecastAlert(root);
  if (!prev) return; // first record of this folder — nothing to compare against

  // The disk journal (§7.3) is fed HERE, from the scan this tick already ran,
  // and nowhere else — deliberately not from the live watcher: a permanent
  // watcher subscription would keep every watched root's OS watchers alive
  // forever (watcher.ts subscribe() only lets a session go idle when its last
  // listener leaves). §B1: the journal rides the one existing timer.
  await recordScanJournal(done, prev).catch((err: unknown) => console.error('[treemap] journal record failed:', err));
  const alert = growthAlertFor(sched, target, prev, done);
  if (alert) pushNotification(alert);
}

/**
 * The growth alert a scheduled scan of `target` raises against the previous
 * snapshot, or null. None across a change of boundary (Track U, U-24): a
 * drive mounted inside the folder that joined or left the count would read as
 * the folder growing or shrinking by the size of a whole disk.
 */
export function growthAlertFor(sched: ScheduleConfig, target: string, prev: Snapshot, done: ScanResult): Omit<GrowthNotification, 'id' | 'at'> | null {
  if (!done.store) return null;
  // Another folder's snapshot is no previous size of this one: a link the
  // scheduler resolved and the scan then followed elsewhere (QA D78).
  if (prev.rootPath !== done.rootPath) return null;
  if (scanBoundaryKey(done) !== boundaryKeyOf(prev.boundary)) return null;
  const newSize = done.store.size(done.store.rootId);
  const delta = newSize - prev.totalSize;
  const pct = prev.totalSize > 0 ? (delta / prev.totalSize) * 100 : 0;
  const overBytes = sched.thresholdBytes !== undefined && delta >= sched.thresholdBytes;
  const overPct = sched.thresholdPct !== undefined && pct >= sched.thresholdPct;
  if (!overBytes && !overPct) return null;
  return {
    path: target,
    message: `${target} grew by ${formatBytes(delta)} (${pct.toFixed(1)}%) since the previous scan`,
    prevSize: prev.totalSize,
    newSize,
    delta,
  };
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
      // Deliberately ref'd: this timer is the ONLY thing that resolves the
      // promise, so an unref'd one lets the event loop drain mid-wait and the
      // await above never continues — which is exactly what took CI down on
      // every OS ("Promise resolution is still pending but the event loop has
      // already resolved"). A server never noticed because its listen handle
      // kept the loop alive. The deadline bounds how long this can hold the
      // process: SCAN_TIMEOUT_MS, then it resolves regardless.
      setTimeout(check, 1000);
    };
    check();
  });
}
