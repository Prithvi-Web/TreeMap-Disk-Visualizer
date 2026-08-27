import { Router, Request, Response } from 'express';
import { guardBodyPaths, requireInsideScanRoot } from '../middleware/pathGuard';
import { idempotency } from '../middleware/idempotency';
import { getPolicy, assertPathsAllowed, assertBytesCap, knownSizeOf } from '../services/policy';
import { appendAudit, tokenIdFor } from '../services/audit';
import {
  assertCartPaths,
  commitCart,
  planCartCommit,
  undoCartRun,
} from '../services/cartCommit';
import { AppError } from '../middleware/errorHandler';

/**
 * cartRoutes — committing the cleanup cart through the Time Capsule (v4 §4.4).
 *
 * Deliberately a *second* route rather than a flag on `DELETE /api/files`. The
 * two do different things: `DELETE /api/files` moves things to the Trash, and
 * this protects them first, so the whole batch becomes one undoable run. Making
 * it a flag would put a capsule-backed and a plain delete behind one endpoint
 * whose safety story depends on a boolean — and `GET /api/capabilities` marks
 * destructive endpoints individually, so an agent would have no way to tell
 * which behaviour it was asking for.
 *
 * Everything §2.3 requires of a destructive endpoint is here and is copied from
 * `offloadRoutes.ts`: the scanned-root rule, path sanitisation, `agent-policy.json`,
 * the audit trail, `Idempotency-Key`, and a `dryRun` that returns the exact
 * manifest having acted on nothing.
 */

export const cartRouter = Router();

/**
 * POST /api/cart/commit  { paths: string[], dryRun?: boolean }
 *
 * With `dryRun: true`, returns the manifest — every path, its bytes, whether it
 * would be deleted and, when it would not, why — plus the Time Capsule copies
 * that would be evicted to make room and B2's open-handle preflight. Nothing is
 * touched.
 *
 * Without it: copy → verify → Trash, as one run. The response carries a `runId`
 * that `POST /api/cart/undo` takes.
 *
 * The refusal that matters: anything too large for the capsule is **left
 * undeleted** and named in `skipped`, never deleted unprotected.
 */
cartRouter.post('/cart/commit', idempotency, guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const body = req.body as { paths?: unknown; dryRun?: unknown };
  assertCartPaths(body.paths);
  const paths = body.paths;
  const dryRun = body.dryRun === true;

  // The scan's own figures, for the policy caps. The capsule's walk produces
  // the exact totals, but a cap has to be checked *before* the walk — a policy
  // that refuses 500 GB should not first spend minutes measuring it.
  const totalKnownBytes = paths.reduce((sum, p) => sum + (knownSizeOf(p) ?? 0), 0);
  const policy = await getPolicy();
  try {
    assertPathsAllowed(policy, paths);
    assertBytesCap(policy, totalKnownBytes);
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({
        action: 'cart.commit', source: 'http', tokenId: tokenIdFor('http'),
        paths, bytes: totalKnownBytes, dryRun, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }

  if (dryRun) {
    const plan = await planCartCommit(paths);
    await appendAudit({
      action: 'cart.commit', source: 'http', tokenId: tokenIdFor('http'),
      paths, bytes: plan.bytesWouldFree, dryRun: true, outcome: 'ok',
    });
    res.json(plan);
    return;
  }

  let result;
  try {
    result = await commitCart(paths);
  } catch (err) {
    // B2 refusing the batch is a real outcome and belongs in the audit trail
    // beside the policy refusals above, or the log shows a delete that simply
    // never happened with no record of why.
    if (err instanceof AppError) {
      await appendAudit({
        action: 'cart.commit', source: 'http', tokenId: tokenIdFor('http'),
        paths, bytes: totalKnownBytes, dryRun: false, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }

  await appendAudit({
    action: 'cart.commit', source: 'http', tokenId: tokenIdFor('http'),
    paths: result.trashed, bytes: result.bytesFreed, dryRun: false,
    outcome: result.skipped.length === 0 && result.failedToTrash.length === 0 ? 'ok' : 'error',
    ...(result.skipped.length > 0 || result.failedToTrash.length > 0 ? { code: 'PARTIAL_COMMIT' } : {}),
  });
  res.json(result);
});

/**
 * POST /api/cart/undo  { runId }  → 202 { jobId, entryCount, bytesTotal }
 *
 * Restores everything one commit deleted, from the Time Capsule, back to the
 * paths it came from. Progress streams over the capsule's own SSE endpoint —
 * `GET /api/timecapsule/jobs/{jobId}/progress` — because it is the capsule's
 * restore, not a second one (§10: no new pathway).
 *
 * Idempotency-Key'd, so a retried undo cannot start a second restore of the
 * same run.
 */
cartRouter.post('/cart/undo', idempotency, async (req: Request, res: Response) => {
  const { runId } = req.body as { runId?: unknown };
  try {
    const job = await undoCartRun(String(runId ?? ''));
    await appendAudit({
      action: 'cart.undo', source: 'http', tokenId: tokenIdFor('http'),
      paths: [], bytes: job.bytesTotal, dryRun: false, outcome: 'ok',
    });
    res.status(202).json(job);
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({
        action: 'cart.undo', source: 'http', tokenId: tokenIdFor('http'),
        paths: [], bytes: null, dryRun: false, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }
});
