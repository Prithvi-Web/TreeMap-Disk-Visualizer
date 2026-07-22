import { Router, Request, Response } from 'express';
import { requireScan, clampInt } from './scanRoutes';
import { getSettings, updateSettings, getIgnoreMatchers } from '../services/settings';
import { collectCleanupSuggestions } from '../services/cleanupRules';
import { collectCloudPlaceholders, matchCustomRules, CustomRules } from '../services/scanQueries';
import { storeOf } from '../services/scanStore';
import { collectBrowserProfiles } from '../services/browserProfiles';
import { listNotifications } from '../services/scheduler';
import { sanitizePath } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';
import { ScheduleConfig, BudgetEntry } from '../models/types';

/**
 * settingsRoutes — user settings (ignore list + scheduled scans), smart
 * cleanup suggestions, and growth notifications from the scheduler.
 */

export const settingsRouter = Router();

/** GET /api/settings -> { ignore, schedules } */
settingsRouter.get('/settings', async (_req: Request, res: Response) => {
  res.json(await getSettings());
});

/**
 * PUT /api/settings  { ignore?, schedules? }
 * Replaces whichever lists are present; schedule paths are sanitized with
 * the same rules as scan paths.
 */
settingsRouter.put('/settings', async (req: Request, res: Response) => {
  const body = req.body as { ignore?: unknown; schedules?: unknown; budgets?: unknown; forecastThresholdDays?: unknown; watchIdleMinutes?: unknown; cloud?: unknown };
  if (body.ignore === undefined && body.schedules === undefined && body.budgets === undefined
      && body.forecastThresholdDays === undefined && body.watchIdleMinutes === undefined && body.cloud === undefined) {
    throw new AppError(400, 'NOTHING_TO_UPDATE', 'Body must include "ignore", "schedules", "budgets", "forecastThresholdDays", "watchIdleMinutes" and/or "cloud"');
  }
  if (body.schedules !== undefined) {
    if (!Array.isArray(body.schedules)) {
      throw new AppError(400, 'BAD_SCHEDULES', '"schedules" must be an array');
    }
    for (const sched of body.schedules as Partial<ScheduleConfig>[]) {
      if (typeof sched?.path !== 'string') {
        throw new AppError(400, 'BAD_SCHEDULES', 'Every schedule needs a "path"');
      }
      sched.path = sanitizePath(sched.path); // throws PathRejectedError -> errorHandler
    }
  }
  if (body.budgets !== undefined) {
    if (!Array.isArray(body.budgets)) {
      throw new AppError(400, 'BAD_BUDGETS', '"budgets" must be an array');
    }
    for (const budget of body.budgets as Partial<BudgetEntry>[]) {
      if (typeof budget?.path !== 'string') {
        throw new AppError(400, 'BAD_BUDGETS', 'Every budget needs a "path"');
      }
      budget.path = sanitizePath(budget.path); // throws PathRejectedError -> errorHandler
    }
  }
  res.json(await updateSettings(body));
});

/** GET /api/cleanup/suggestions?scanId= — smart suggestions for a scan. */
settingsRouter.get('/cleanup/suggestions', async (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.store && !scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  const ignore = await getIgnoreMatchers('suggest');
  res.json({ scanId: scan.scanId, groups: collectCleanupSuggestions(storeOf(scan), ignore) });
});

/** GET /api/cleanup/browser-profiles?scanId= — per-profile cache breakdown. */
settingsRouter.get('/cleanup/browser-profiles', (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.store && !scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  res.json({ scanId: scan.scanId, profiles: collectBrowserProfiles(storeOf(scan)) });
});

/**
 * GET /api/cleanup/cloud-safe?scanId=&perProvider=300
 *
 * Online-only files, grouped by provider. Counts and byte totals are exact for
 * the whole scan while the per-provider file lists are capped, so the UI can
 * state its headline numbers truthfully. The browser holds a pruned tree and
 * can no longer work this out for itself.
 */
settingsRouter.get('/cleanup/cloud-safe', (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.store && !scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  const perProvider = clampInt(req.query.perProvider, 300, 1, 2000);
  res.json({ scanId: scan.scanId, ...collectCloudPlaceholders(storeOf(scan), perProvider) });
});

/**
 * GET /api/cleanup/rules?scanId=&maxAgeMs=&minBytes=&exts=jpg,png&dup=1&limit=500
 *
 * Files matching the user's custom Clean Up rules. Enabled rules are ANDed;
 * omitted ones don't filter. `dup` means "this name+size occurs more than once
 * in the scan", which is why it has to run here — the pruned tree the browser
 * holds would miss most of the duplicates.
 */
settingsRouter.get('/cleanup/rules', (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.store && !scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');

  const rules: CustomRules = {};
  if (req.query.maxAgeMs !== undefined) rules.maxAgeMs = Math.max(0, Number(req.query.maxAgeMs) || 0);
  if (req.query.minBytes !== undefined) rules.minBytes = Math.max(0, Number(req.query.minBytes) || 0);
  if (typeof req.query.exts === 'string' && req.query.exts.trim()) {
    rules.exts = req.query.exts
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
  }
  if (req.query.dup === '1' || req.query.dup === 'true') rules.dup = true;

  // No rules would match the entire disk — never what the user meant.
  if (rules.maxAgeMs === undefined && rules.minBytes === undefined && !rules.exts?.length && !rules.dup) {
    throw new AppError(400, 'NO_RULES', 'Enable at least one rule');
  }

  const limit = clampInt(req.query.limit, 500, 1, 2000);
  res.json({ scanId: scan.scanId, ...matchCustomRules(storeOf(scan), rules, limit, Date.now()) });
});

/** GET /api/notifications?since=<epoch ms> — scheduler growth alerts. */
settingsRouter.get('/notifications', (req: Request, res: Response) => {
  const since = Number(req.query.since) || 0;
  res.json({ now: Date.now(), notifications: listNotifications(since) });
});
