import crypto from 'crypto';
import { AppSettings, IgnoreEntry, ScheduleConfig, IgnoreScope, BudgetEntry, CloudCredentials } from '../models/types';
import { readJsonFile, writeJsonFile } from './storage';
import { compileIgnoreList, CompiledIgnore } from '../utils/glob';
import { DEFAULT_RECLAIM_WEIGHTS, RECLAIM_COMPONENT_IDS, ReclaimWeights } from './reclaimScore';
import { clearFactCacheForProvider } from './facts/registry';

/**
 * Settings — the user's ignore list and scheduled scans, persisted to
 * settings.json in the app-data dir. Cached in memory; every mutation
 * writes through.
 */

const SETTINGS_FILE = 'settings.json';
const MAX_IGNORE = 100;
const MAX_SCHEDULES = 20;
const MAX_BUDGETS = 100;
const SCOPES: IgnoreScope[] = ['scan', 'suggest', 'both'];

let cache: AppSettings | null = null;

function normalizeIgnore(raw: unknown): IgnoreEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: IgnoreEntry[] = [];
  for (const entry of raw.slice(0, MAX_IGNORE)) {
    const e = entry as Partial<IgnoreEntry>;
    if (typeof e?.pattern !== 'string') continue;
    const pattern = e.pattern.trim().slice(0, 500);
    if (!pattern || pattern.includes('\0')) continue;
    out.push({ pattern, scope: SCOPES.includes(e.scope as IgnoreScope) ? (e.scope as IgnoreScope) : 'both' });
  }
  return out;
}

function normalizeSchedules(raw: unknown): ScheduleConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleConfig[] = [];
  for (const entry of raw.slice(0, MAX_SCHEDULES)) {
    const e = entry as Partial<ScheduleConfig>;
    if (typeof e?.path !== 'string' || !e.path.trim()) continue;
    const hours = Number(e.intervalHours);
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
      path: e.path.trim(),
      intervalHours: Number.isFinite(hours) ? Math.min(720, Math.max(1, Math.round(hours))) : 24,
      thresholdPct: clampOptional(e.thresholdPct, 0, 100000),
      thresholdBytes: clampOptional(e.thresholdBytes, 0, Number.MAX_SAFE_INTEGER),
      enabled: e.enabled !== false,
      lastRunAt: typeof e.lastRunAt === 'number' ? e.lastRunAt : undefined,
    });
  }
  return out;
}

function clampOptional(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** One budget per path (last write wins), with a positive integer ceiling. */
function normalizeBudgets(raw: unknown): BudgetEntry[] {
  if (!Array.isArray(raw)) return [];
  const byPath = new Map<string, BudgetEntry>();
  for (const entry of raw.slice(0, MAX_BUDGETS * 4)) {
    const e = entry as Partial<BudgetEntry>;
    if (typeof e?.path !== 'string') continue;
    const path = e.path.trim().slice(0, 1000);
    const maxBytes = Number(e.maxBytes);
    if (!path || path.includes('\0') || !Number.isFinite(maxBytes) || maxBytes <= 0) continue;
    byPath.set(path, { path, maxBytes: Math.round(maxBytes) });
    if (byPath.size >= MAX_BUDGETS) break;
  }
  return [...byPath.values()];
}

/** Forecast alert threshold: 1–365 days, defaulting to 30. */
function normalizeForecastDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(365, Math.max(1, Math.round(n)));
}

/** Live-mode idle auto-pause: 1–120 minutes, defaulting to 10. */
function normalizeWatchIdle(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(120, Math.max(1, Math.round(n)));
}

/**
 * Time Capsule retention: 1–365 days, defaulting to the 30 §B3 specifies.
 *
 * Lowering it takes effect on the next sweep and can retire items captured
 * under the old value — retention is read live rather than stamped onto each
 * entry, so the setting always means what it says today.
 */
function normalizeCapsuleRetention(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(365, Math.max(1, Math.round(n)));
}

/**
 * Capsule ceiling as a percentage of the volume's usable space: 1–90, default
 * 10. The upper bound is not cosmetic — the capsule must never be the reason a
 * disk fills, and a user who types 100 would be asking for exactly that.
 */
function normalizeCapsulePercent(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(90, Math.max(1, Math.round(n)));
}

const CLOUD_PROVIDERS = ['gdrive', 'dropbox', 'onedrive'] as const;

/** Cloud app credentials: plain strings per provider, empty entries dropped. */
function normalizeCloud(raw: unknown): AppSettings['cloud'] {
  const out: AppSettings['cloud'] = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of CLOUD_PROVIDERS) {
    const c = (raw as Record<string, Partial<CloudCredentials>>)[id];
    if (!c || typeof c.clientId !== 'string') continue;
    const clientId = c.clientId.trim().slice(0, 300);
    if (!clientId) continue;
    const clientSecret = typeof c.clientSecret === 'string' ? c.clientSecret.trim().slice(0, 300) : '';
    out[id] = { clientId, ...(clientSecret ? { clientSecret } : {}) };
  }
  return out;
}

/**
 * Reclaim Score weights: each component 0-1, unknown keys dropped, missing
 * keys filled from the defaults (v4 §3.2).
 *
 * An all-zero set is refused back to the defaults rather than stored. Zero on
 * one component means "do not count this"; zero on every component means
 * there is no score at all, and silently turning the whole feature off
 * through a settings write is not a state anyone asked for. Turning it off is
 * a job for a visible switch, not for six sliders that all happen to be down.
 */
/**
 * The cleanup cart's optional target, in bytes (v4 §4.1).
 *
 * `null` is a real answer and the default: no target set, no meter shown.
 * Anything unparseable or non-positive resolves to `null` rather than to a
 * number, because a meter filling toward a goal nobody typed would be a claim
 * about an intention the user never expressed. Capped at 1 PiB so a stray
 * keystroke cannot produce a meter that can never move.
 */
const MAX_GOAL_BYTES = 1024 ** 5;
function normalizeGoalBytes(raw: unknown): number | null {
  // Typed before it is coerced. `Number(true)` is 1, so a stray boolean would
  // otherwise become a one-byte target: a meter permanently at 100%, from a
  // value nobody typed. Only a number or the string form of one is a target.
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_GOAL_BYTES, Math.round(n));
}

function normalizeReclaimWeights(raw: unknown): ReclaimWeights {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RECLAIM_WEIGHTS };
  const src = raw as Record<string, unknown>;
  const out = { ...DEFAULT_RECLAIM_WEIGHTS };
  let sum = 0;
  for (const id of RECLAIM_COMPONENT_IDS) {
    const n = Number(src[id]);
    // Absent or unparseable keeps the default; present-and-invalid does too,
    // because a NaN weight would propagate into every score in the app.
    if (Number.isFinite(n) && n >= 0) out[id] = Math.min(1, Math.round(n * 1000) / 1000);
    sum += out[id];
  }
  return sum > 0 ? out : { ...DEFAULT_RECLAIM_WEIGHTS };
}

export async function getSettings(): Promise<AppSettings> {
  if (!cache) {
    const raw = await readJsonFile<Partial<AppSettings>>(SETTINGS_FILE, {});
    cache = {
      ignore: normalizeIgnore(raw.ignore),
      schedules: normalizeSchedules(raw.schedules),
      budgets: normalizeBudgets(raw.budgets),
      forecastThresholdDays: normalizeForecastDays(raw.forecastThresholdDays),
      watchIdleMinutes: normalizeWatchIdle(raw.watchIdleMinutes),
      timeCapsuleRetentionDays: normalizeCapsuleRetention(raw.timeCapsuleRetentionDays),
      timeCapsuleMaxPercent: normalizeCapsulePercent(raw.timeCapsuleMaxPercent),
      cloud: normalizeCloud(raw.cloud),
      reclaimWeights: normalizeReclaimWeights(raw.reclaimWeights),
      cleanupGoalBytes: normalizeGoalBytes(raw.cleanupGoalBytes),
      // v4 §9.3 — anything but an explicit false means on: the equivalents
      // are cosmetic, and a malformed settings file should not silently
      // remove a default-on feature.
      humanScaleUnits: raw.humanScaleUnits !== false,
      // Only boolean true counts: a truthy string in a hand-edited file must
      // not silence a tour the user never saw (v4 §9.2).
      tourDone: raw.tourDone === true,
    };
  }
  return cache;
}

/** Replace ignore list and/or schedules (input is re-validated here). */
export async function updateSettings(patch: { ignore?: unknown; schedules?: unknown; budgets?: unknown; forecastThresholdDays?: unknown; watchIdleMinutes?: unknown; timeCapsuleRetentionDays?: unknown; timeCapsuleMaxPercent?: unknown; cloud?: unknown; reclaimWeights?: unknown; cleanupGoalBytes?: unknown; humanScaleUnits?: unknown; tourDone?: unknown }): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ignore: patch.ignore !== undefined ? normalizeIgnore(patch.ignore) : current.ignore,
    schedules: patch.schedules !== undefined ? normalizeSchedules(patch.schedules) : current.schedules,
    budgets: patch.budgets !== undefined ? normalizeBudgets(patch.budgets) : current.budgets,
    forecastThresholdDays: patch.forecastThresholdDays !== undefined
      ? normalizeForecastDays(patch.forecastThresholdDays)
      : current.forecastThresholdDays,
    watchIdleMinutes: patch.watchIdleMinutes !== undefined
      ? normalizeWatchIdle(patch.watchIdleMinutes)
      : current.watchIdleMinutes,
    timeCapsuleRetentionDays: patch.timeCapsuleRetentionDays !== undefined
      ? normalizeCapsuleRetention(patch.timeCapsuleRetentionDays)
      : current.timeCapsuleRetentionDays,
    timeCapsuleMaxPercent: patch.timeCapsuleMaxPercent !== undefined
      ? normalizeCapsulePercent(patch.timeCapsuleMaxPercent)
      : current.timeCapsuleMaxPercent,
    cloud: patch.cloud !== undefined ? normalizeCloud(patch.cloud) : current.cloud,
    // Sending `null` is how Settings' "Reset to defaults" button asks for
    // them back: the normalizer rejects a non-object to the defaults, so the
    // reset needs no second endpoint and no client-side copy of the numbers
    // that could drift from the ones the server actually uses.
    reclaimWeights: patch.reclaimWeights !== undefined
      ? normalizeReclaimWeights(patch.reclaimWeights)
      : current.reclaimWeights,
    // `null` clears the target — the same "send null to reset" shape the
    // weights use, so Settings needs no second endpoint to turn it off.
    cleanupGoalBytes: patch.cleanupGoalBytes !== undefined
      ? normalizeGoalBytes(patch.cleanupGoalBytes)
      : current.cleanupGoalBytes,
    humanScaleUnits: patch.humanScaleUnits !== undefined
      ? patch.humanScaleUnits !== false
      : current.humanScaleUnits,
    tourDone: patch.tourDone !== undefined
      ? patch.tourDone === true
      : current.tourDone,
  };
  // Preserve lastRunAt across edits that didn't intend to reset it.
  if (patch.schedules !== undefined) {
    for (const sched of next.schedules) {
      if (sched.lastRunAt === undefined) {
        const prev = current.schedules.find((s) => s.id === sched.id);
        if (prev?.lastRunAt) sched.lastRunAt = prev.lastRunAt;
      }
    }
  }
  // A reclaim score is derived from these weights, and the fact layer caches
  // it for thirty minutes keyed only on scan and path. Changing a weight
  // therefore makes every cached score an answer to a question nobody is
  // asking any more — and the breakdown beside it would list components the
  // user had just switched off. Compared rather than cleared unconditionally,
  // so saving an unrelated setting does not throw the cache away.
  const weightsChanged = RECLAIM_COMPONENT_IDS.some(
    (id) => current.reclaimWeights[id] !== next.reclaimWeights[id],
  );

  cache = next;
  await writeJsonFile(SETTINGS_FILE, cache);
  if (weightsChanged) clearFactCacheForProvider('reclaimScore');
  return cache;
}

/** Internal helper for the scheduler: update one schedule's bookkeeping. */
export async function patchSchedule(id: string, patch: Partial<ScheduleConfig>): Promise<void> {
  const current = await getSettings();
  const sched = current.schedules.find((s) => s.id === id);
  if (!sched) return;
  Object.assign(sched, patch);
  await writeJsonFile(SETTINGS_FILE, current);
}

/** Compiled matchers for a scope, ready for the scanner / suggester. */
export async function getIgnoreMatchers(scope: 'scan' | 'suggest'): Promise<CompiledIgnore[]> {
  const settings = await getSettings();
  const patterns = settings.ignore
    .filter((e) => e.scope === scope || e.scope === 'both')
    .map((e) => e.pattern);
  return compileIgnoreList(patterns);
}
