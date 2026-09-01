import { Router, Request, Response } from 'express';
import { requireScan, clampInt } from './scanRoutes';
import { getSettings, updateSettings, getIgnoreMatchers } from '../services/settings';
import { suppressedNoteRoots } from '../services/notes';
import { collectCleanupSuggestions } from '../services/cleanupRules';
import { ruleCatalogStatus } from '../services/rulePacks';
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
  const body = req.body as { ignore?: unknown; schedules?: unknown; budgets?: unknown; forecastThresholdDays?: unknown; watchIdleMinutes?: unknown; timeCapsuleRetentionDays?: unknown; timeCapsuleMaxPercent?: unknown; cloud?: unknown; reclaimWeights?: unknown; cleanupGoalBytes?: unknown; humanScaleUnits?: unknown; tourDone?: unknown };
  if (body.ignore === undefined && body.schedules === undefined && body.budgets === undefined
      && body.forecastThresholdDays === undefined && body.watchIdleMinutes === undefined
      && body.timeCapsuleRetentionDays === undefined && body.timeCapsuleMaxPercent === undefined
      && body.cloud === undefined && body.reclaimWeights === undefined
      && body.cleanupGoalBytes === undefined && body.humanScaleUnits === undefined
      && body.tourDone === undefined) {
    throw new AppError(400, 'NOTHING_TO_UPDATE', 'Body must include "ignore", "schedules", "budgets", "forecastThresholdDays", "watchIdleMinutes", "timeCapsuleRetentionDays", "timeCapsuleMaxPercent", "cloud", "reclaimWeights", "cleanupGoalBytes", "humanScaleUnits" and/or "tourDone"');
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
  // "Anything but explicit false means on" is a forgiveness rule for
  // hand-edited FILES; API input is validated like every other field —
  // a truthy string must not silently switch a setting on.
  if (body.humanScaleUnits !== undefined && typeof body.humanScaleUnits !== 'boolean') {
    throw new AppError(400, 'BAD_SETTING', '"humanScaleUnits" must be true or false');
  }
  if (body.tourDone !== undefined && typeof body.tourDone !== 'boolean') {
    throw new AppError(400, 'BAD_SETTING', '"tourDone" must be true or false');
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
  // §6 failure isolation: a malformed rule pack breaks this one feature, with
  // the reason shown, rather than the request or the app. A half-loaded catalog
  // is never served — silently dropping rules people rely on is the worse bug.
  const catalog = ruleCatalogStatus();
  if (!catalog.ok) {
    res.json({ scanId: scan.scanId, groups: [], available: false, reason: catalog.reason });
    return;
  }
  const ignore = await getIgnoreMatchers('suggest');
  // v4 §9.5 — a folder with a suppressing note is left out, subtree and all.
  // A notes.json that cannot be read degrades this surface with the reason
  // (same shape as a malformed rule pack) rather than serving a list the
  // notes were supposed to be filtering — fail closed, stated.
  let noted: string[];
  try {
    noted = await suppressedNoteRoots();
  } catch (err) {
    res.json({ scanId: scan.scanId, groups: [], available: false, reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({
    scanId: scan.scanId,
    groups: collectCleanupSuggestions(storeOf(scan), ignore, catalog.catalog, undefined, noted),
    available: true,
    catalog: { schemaVersion: catalog.catalog.schemaVersion, packs: catalog.catalog.packs },
  });
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
// Note-suppression (v4 §9.5) is DELIBERATELY not applied to the custom-rules
// matcher below (nor to browser-profiles / cloud-safe above): these lists are
// the user's own explicit filters, typed in by hand for this one look — not
// the engine volunteering deletions. The note pauses what the machine
// suggests, never what the person asks to see.

/**
 * A threshold rule's value, or undefined when the parameter is not a threshold.
 *
 * `Math.max(0, Number(x) || 0)` could not express "this is not a rule": junk, an
 * empty string, a negative and an explicit 0 all collapsed to 0 — a number, so
 * the rule was installed, so the NO_RULES guard below saw an enabled rule and
 * waved the request through. One typo in the age box therefore offered up every
 * file in the scan for deletion, which is precisely the outcome that guard
 * exists to prevent.
 *
 * Both parameters are floors — "at least this old", "at least this big" — so a
 * zero or negative floor excludes nothing and is indistinguishable from omitting
 * the rule; Infinity (`1e999`) is not a threshold either. Only a finite positive
 * number is a rule. A repeated parameter arrives as an array and is likewise not
 * a threshold, so it is rejected by type rather than coerced through NaN.
 */
function positiveRule(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

settingsRouter.get('/cleanup/rules', (req: Request, res: Response) => {
  const scan = requireScan(req, req.query.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.store && !scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');

  const rules: CustomRules = {};
  // Only a value that is genuinely a threshold becomes a rule — see positiveRule.
  const maxAgeMs = positiveRule(req.query.maxAgeMs);
  if (maxAgeMs !== undefined) rules.maxAgeMs = maxAgeMs;
  const minBytes = positiveRule(req.query.minBytes);
  if (minBytes !== undefined) rules.minBytes = minBytes;
  // `exts` needs no equivalent guard: the empty entries are filtered out here and
  // the NO_RULES check below tests `.length`, so "exts=,,," already arrives as no
  // rule rather than as a rule matching nothing.
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

  // `limit` has no equivalent hole: clampInt answers unparseable input with the
  // default and pins the result into [1, 2000], so it can never arrive as 0.
  const limit = clampInt(req.query.limit, 500, 1, 2000);
  res.json({ scanId: scan.scanId, ...matchCustomRules(storeOf(scan), rules, limit, Date.now()) });
});

/** GET /api/notifications?since=<epoch ms> — scheduler growth alerts. */
settingsRouter.get('/notifications', (req: Request, res: Response) => {
  // `|| 0` is honest here, unlike the rule thresholds above: 0 is this
  // parameter's own default ("everything the scheduler has recorded"), so junk
  // degrades to exactly the answer an absent `since` gives, and there is no
  // guard behind it for a bogus value to slip past.
  const since = Number(req.query.since) || 0;
  res.json({ now: Date.now(), notifications: listNotifications(since) });
});
