import { Router, Request, Response } from 'express';
import { requireScan } from './scanRoutes';
import { getSettings, updateSettings } from '../services/settings';
import { budgetSnapshot, engineCapabilities, pauseScan, resumeScan, validateEngineBudget, PauseOutcome } from '../services/engineBudget';
import { AppError } from '../middleware/errorHandler';

/**
 * engineRoutes — the scanning budget's HTTP surface (Phase 2, Task 5).
 *
 *  - GET  /api/engine/capabilities — the native core's status and the seven
 *    mechanisms it can use here, each named or absent with a reason
 *  - GET  /api/engine/budget — the setting, what it resolves to right now,
 *    who holds it (`source`), and the governor's snapshot when there is one
 *  - PUT  /api/engine/budget — change it; running scans follow at their next
 *    batch. The same setting `PUT /api/settings` writes as `engineBudget`.
 *  - POST /api/scan/:id/pause, /resume — for a running scan
 *
 * Every response states `source`, so a client can tell a budget the machine
 * is holding from one the Node shim is approximating.
 */

export const engineRouter = Router();

/** GET /api/engine/capabilities — probes only, nothing changes. */
engineRouter.get('/engine/capabilities', (_req: Request, res: Response) => {
  res.json(engineCapabilities());
});

/** GET /api/engine/budget */
engineRouter.get('/engine/budget', async (_req: Request, res: Response) => {
  // On a cold start the persisted setting reaches the budget module through
  // settings' own load, so it is loaded before the state is read.
  await getSettings();
  res.json(budgetSnapshot());
});

/**
 * PUT /api/engine/budget  { preset?, cpuPercent? }
 *
 * Either key or both; an omitted key keeps its value. Validated strictly
 * (400 BAD_SETTING), then written through settings so the two routes can never
 * hold different copies.
 */
engineRouter.put('/engine/budget', async (req: Request, res: Response) => {
  const current = (await getSettings()).engineBudget;
  const checked = validateEngineBudget(req.body, current);
  if (!checked.ok) throw new AppError(400, 'BAD_SETTING', checked.reason);
  await updateSettings({ engineBudget: checked.value });
  res.json(budgetSnapshot());
});

/** The wire shape of a pause or resume reply: `ScanPauseOutcome` in openapi.ts, key for key. */
export interface ScanPauseReply {
  scanId: string;
  status: string;
  paused: boolean;
  supported: boolean;
  reason?: string;
  source: PauseOutcome['source'];
}

/** The pause outcome with the record's status beside it, `reason` only when there is one. */
function pauseReply(outcome: PauseOutcome, status: string): ScanPauseReply {
  return {
    scanId: outcome.scanId,
    status,
    paused: outcome.paused,
    supported: outcome.supported,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    source: outcome.source,
  };
}

/**
 * POST /api/scan/:scanId/pause — the walker stops counting within a batch,
 * a gdu shard is stopped in place. `paused: false` comes with a reason: the
 * scan had finished, or its engine cannot be paused here (gdu on Windows).
 */
engineRouter.post('/scan/:scanId/pause', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  res.json(pauseReply(pauseScan(scan), scan.status));
});

/** POST /api/scan/:scanId/resume */
engineRouter.post('/scan/:scanId/resume', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  res.json(pauseReply(resumeScan(scan), scan.status));
});
