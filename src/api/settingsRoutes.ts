import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import { getSettings, updateSettings, getIgnoreMatchers } from '../services/settings';
import { collectCleanupSuggestions } from '../services/cleanupRules';
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
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  const ignore = await getIgnoreMatchers('suggest');
  res.json({ scanId: scan.scanId, groups: collectCleanupSuggestions(scan.root, ignore) });
});

/** GET /api/cleanup/browser-profiles?scanId= — per-profile cache breakdown. */
settingsRouter.get('/cleanup/browser-profiles', (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  res.json({ scanId: scan.scanId, profiles: collectBrowserProfiles(scan.root) });
});

/** GET /api/notifications?since=<epoch ms> — scheduler growth alerts. */
settingsRouter.get('/notifications', (req: Request, res: Response) => {
  const since = Number(req.query.since) || 0;
  res.json({ now: Date.now(), notifications: listNotifications(since) });
});
