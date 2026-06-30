import { Router, Request, Response } from 'express';
import { getActivity, recordActivity, isActivityKind } from '../services/activity';
import { AppError } from '../middleware/errorHandler';

/**
 * activityRoutes — the Dashboard activity hub.
 *  GET  /api/activity         → the persisted summary (tiles + recent log)
 *  POST /api/activity {kind, label?, bytes?, items?} → record one completed
 *       action and return the updated summary. Called by the cleaner tools
 *       after a confirmed success (uninstall / update / fast-clean / …).
 */
export const activityRouter = Router();

activityRouter.get('/activity', async (_req: Request, res: Response) => {
  res.json(await getActivity());
});

activityRouter.post('/activity', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { kind?: unknown; label?: unknown; bytes?: unknown; items?: unknown };
  if (!isActivityKind(body.kind)) {
    throw new AppError(400, 'INVALID_KIND', 'Unknown activity kind');
  }
  const summary = await recordActivity({
    kind: body.kind,
    label: typeof body.label === 'string' ? body.label : undefined,
    bytes: typeof body.bytes === 'number' ? body.bytes : undefined,
    items: typeof body.items === 'number' ? body.items : undefined,
  });
  res.json(summary);
});
