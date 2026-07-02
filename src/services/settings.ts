import crypto from 'crypto';
import { AppSettings, IgnoreEntry, ScheduleConfig, IgnoreScope, BudgetEntry } from '../models/types';
import { readJsonFile, writeJsonFile } from './storage';
import { compileIgnoreList, CompiledIgnore } from '../utils/glob';

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

export async function getSettings(): Promise<AppSettings> {
  if (!cache) {
    const raw = await readJsonFile<Partial<AppSettings>>(SETTINGS_FILE, {});
    cache = {
      ignore: normalizeIgnore(raw.ignore),
      schedules: normalizeSchedules(raw.schedules),
      budgets: normalizeBudgets(raw.budgets),
      forecastThresholdDays: normalizeForecastDays(raw.forecastThresholdDays),
    };
  }
  return cache;
}

/** Replace ignore list and/or schedules (input is re-validated here). */
export async function updateSettings(patch: { ignore?: unknown; schedules?: unknown; budgets?: unknown; forecastThresholdDays?: unknown }): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ignore: patch.ignore !== undefined ? normalizeIgnore(patch.ignore) : current.ignore,
    schedules: patch.schedules !== undefined ? normalizeSchedules(patch.schedules) : current.schedules,
    budgets: patch.budgets !== undefined ? normalizeBudgets(patch.budgets) : current.budgets,
    forecastThresholdDays: patch.forecastThresholdDays !== undefined
      ? normalizeForecastDays(patch.forecastThresholdDays)
      : current.forecastThresholdDays,
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
  cache = next;
  await writeJsonFile(SETTINGS_FILE, cache);
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
