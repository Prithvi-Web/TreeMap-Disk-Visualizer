import { Router, Request, Response } from 'express';
import { clampInt } from './scanRoutes';
import { readJournal } from '../services/journal';

/**
 * journalRoutes — reading the disk journal back. Read-only by design:
 * entries are written by the journal service off the scheduler's own scans
 * (src/services/journal.ts), never over HTTP, so no request can forge or
 * rewrite the machine's history.
 */

export const journalRouter = Router();

/** GET /api/journal?limit=100 — the disk journal, newest first. */
journalRouter.get('/journal', async (req: Request, res: Response) => {
  const limit = clampInt(req.query.limit, 100, 1, 1000);
  res.json({ entries: await readJournal(limit) });
});
