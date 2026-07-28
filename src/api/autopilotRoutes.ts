import { Router, Request, Response } from 'express';
import {
  listPolicies,
  savePolicies,
  getPolicy,
  approvePolicy,
  normalizePolicy,
  simulatePolicy,
  listRuns,
  getRun,
  undoRun,
} from '../services/autopilot';
import { idempotency } from '../middleware/idempotency';
import { appendAudit, tokenIdFor } from '../services/audit';
import { AppError } from '../middleware/errorHandler';

/**
 * autopilotRoutes — standing cleanup policies, their run history, and undo (B1).
 *
 * Note what is *not* here: nothing on this router deletes anything. A run is
 * started by the scheduler, and the only deletion in the whole feature happens
 * inside `protectAndTrash` — which copies to the Time Capsule, verifies, checks
 * the open-file guard, and then trashes. The HTTP surface configures and
 * inspects; it never becomes a second way to destroy things.
 *
 * `POST /policies/:id/approve` is not in §B1's endpoint list but the feature it
 * describes cannot work without it: "first run of any new policy is always a
 * dry run, **surfaced for approval**" needs somewhere for that approval to go.
 */

export const autopilotRouter = Router();

/** GET /api/autopilot/policies — every configured policy. */
autopilotRouter.get('/autopilot/policies', async (_req: Request, res: Response) => {
  res.json({ policies: await listPolicies() });
});

/**
 * PUT /api/autopilot/policies { policies: [] } — replace the whole list.
 *
 * Every policy is re-validated here: a match that would select every file, or
 * a path pointing at the root of the disk, is refused rather than saved and
 * left to misbehave later. Editing a policy's scope also revokes the approval
 * the old scope earned.
 */
autopilotRouter.put('/autopilot/policies', async (req: Request, res: Response) => {
  const body = req.body as { policies?: unknown };
  if (body.policies === undefined) {
    throw new AppError(400, 'NOTHING_TO_UPDATE', 'Body must include a "policies" array');
  }
  const policies = await savePolicies(body.policies);
  await appendAudit({
    action: 'autopilot.policies', source: 'http', tokenId: tokenIdFor('http'),
    paths: policies.map((p) => p.path), bytes: null, dryRun: false, outcome: 'ok',
  });
  res.json({ policies });
});

/**
 * POST /api/autopilot/policies/:id/approve — let a policy start deleting.
 *
 * Only reachable after the mandatory first dry run has produced a run record
 * the user could actually read.
 */
autopilotRouter.post('/autopilot/policies/:id/approve', async (req: Request, res: Response) => {
  const policy = await approvePolicy(String(req.params.id));
  await appendAudit({
    action: 'autopilot.approve', source: 'http', tokenId: tokenIdFor('http'),
    paths: [policy.path], bytes: null, dryRun: false, outcome: 'ok',
  });
  res.json({ policy });
});

/**
 * POST /api/autopilot/simulate — exactly what a policy would delete.
 *
 * Takes either `{ policyId }` for a saved policy or `{ policy }` for one still
 * being edited, so the builder can preview before anything is saved. Writes
 * nothing and never touches the policy's schedule.
 */
autopilotRouter.post('/autopilot/simulate', async (req: Request, res: Response) => {
  const body = req.body as { policyId?: unknown; policy?: unknown };

  let policy;
  if (typeof body.policyId === 'string') {
    policy = await getPolicy(body.policyId);
    if (!policy) throw new AppError(404, 'POLICY_NOT_FOUND', 'No such policy');
  } else if (body.policy !== undefined) {
    // Validated exactly as a saved one would be, so a preview cannot describe
    // something that could never be saved.
    policy = normalizePolicy(body.policy);
  } else {
    throw new AppError(400, 'POLICY_REQUIRED', 'Body must include "policyId" or "policy"');
  }

  const result = await simulatePolicy(policy);
  await appendAudit({
    action: 'autopilot.simulate', source: 'http', tokenId: tokenIdFor('http'),
    paths: [policy.path], bytes: result.bytesWouldDelete, dryRun: true, outcome: 'ok',
  });
  res.json(result);
});

/** GET /api/autopilot/runs?limit= — run history, newest first. */
autopilotRouter.get('/autopilot/runs', async (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  res.json({ runs: await listRuns(limit) });
});

/**
 * POST /api/autopilot/runs/:id/undo → 202 { jobId }
 *
 * Puts back everything the run deleted, from the Time Capsule, as one verified
 * restore job. Refuses outright when the capsule no longer holds the run rather
 * than restoring part of it and reporting success.
 */
autopilotRouter.post('/autopilot/runs/:id/undo', idempotency, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const run = await getRun(id);
  try {
    const result = await undoRun(id);
    await appendAudit({
      action: 'autopilot.undo', source: 'http', tokenId: tokenIdFor('http'),
      paths: run ? run.items.map((i) => i.path) : [], bytes: run?.bytesDeleted ?? null,
      dryRun: false, outcome: 'ok',
    });
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({
        action: 'autopilot.undo', source: 'http', tokenId: tokenIdFor('http'),
        paths: [], bytes: null, dryRun: false, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }
});
