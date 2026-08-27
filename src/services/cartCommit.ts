import { AppError } from '../middleware/errorHandler';
import { checkOpenHandles, type OpenHandleReport } from './openHandleGuard';
import { knownSizeOf } from './policy';
import {
  listCapsuleEntriesForRun,
  planProtection,
  protectAndTrash,
  startCapsuleRestore,
  type ProtectionPlan,
} from './timeCapsule';
import type { TimeCapsuleJob } from '../models/types';

/**
 * The cleanup cart's commit (v4 §4.4).
 *
 * The cart has always trashed its contents directly. §4.4 routes it through
 * the **Time Capsule** instead, which changes one thing that matters: the
 * whole batch becomes a single undoable run, so "Undo this run" puts every
 * file back at its original path even after the Trash has been emptied.
 *
 * ── What that costs, stated plainly ──
 *
 * The capsule copies and verifies every byte before anything is deleted, and
 * it has a ceiling — a share of the volume's usable space (10% by default).
 * Anything that does not fit is **left undeleted rather than deleted
 * unprotected**. That is §4.4's rule and it is the right one: a capsule that
 * quietly lets a delete through when it is full is worse than no capsule,
 * because the user believes they are covered. It does mean a very large cart
 * can come back saying "I deleted nine of these twelve and here is why", and
 * the manifest says so *before* the commit rather than after.
 *
 * ── No new deletion pathway ──
 *
 * Nothing here deletes. `protectAndTrash` is the single call that does, and it
 * goes through the existing `Cleaner`, so B2's open-file guard applies exactly
 * as it does to a manual delete (§10, and `tests/openHandleGuard.test.ts` pins
 * the four files allowed to remove anything — this is not one of them).
 */

/** A cap on one commit, so a runaway client cannot ask for an unbounded walk. */
export const MAX_CART_PATHS = 500;

export interface CartManifestItem {
  path: string;
  /** Bytes the capsule would have to hold. `null` when the item is unreadable. */
  bytes: number | null;
  /** Will this be deleted? False items are named with a reason. */
  willDelete: boolean;
  code?: string;
  reason?: string;
}

export interface CartDryRun {
  dryRun: true;
  items: CartManifestItem[];
  /** Bytes that would actually be freed. */
  bytesWouldFree: number;
  /** Bytes that would be left behind, because they could not be protected. */
  bytesSkipped: number;
  /** Older Time Capsule copies that would be evicted to make room. */
  evicts: ProtectionPlan['evicts'];
  capsule: { available: boolean; reason?: string; capBytes: number; usedBytes: number };
  /** B2's preflight: what a program is holding open right now. */
  openHandles: OpenHandleReport;
}

export interface CartCommitResult {
  dryRun: false;
  /** Ties this batch to its Time Capsule copies; the id "Undo this run" takes. */
  runId: string;
  trashed: string[];
  bytesFreed: number;
  /** Items that were not deleted, each with the reason it was left alone. */
  skipped: { path: string; code?: string; reason?: string }[];
  /** Protected, then refused by the Trash; their copies were dropped. */
  failedToTrash: { path: string; reason: string }[];
  /** True when the capsule itself is unavailable. Nothing was deleted. */
  capsuleUnavailable?: string;
}

/** Reject a badly-shaped request before anything walks the disk. */
export function assertCartPaths(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new AppError(400, 'PATHS_REQUIRED', 'Body must include a non-empty "paths" array of strings');
  }
  if (paths.length > MAX_CART_PATHS) {
    throw new AppError(400, 'TOO_MANY_PATHS', `At most ${MAX_CART_PATHS} items per commit`);
  }
}

/**
 * The exact manifest, having acted on nothing.
 *
 * Every check the real run makes has already run by the time this returns: the
 * capsule's availability, the per-item walk (so an unreadable or absurdly
 * complex folder is named here rather than at commit time), the cumulative
 * capacity arithmetic including which older copies would be evicted, and B2's
 * open-handle preflight.
 *
 * The open-handle report is *reported*, not enforced. A dry run describes; it
 * never refuses. The commit is where a held file stops the batch.
 */
export async function planCartCommit(paths: string[]): Promise<CartDryRun> {
  const plan = await planProtection(paths);
  const openHandles = await checkOpenHandles(paths);

  const items: CartManifestItem[] = plan.items.map((item) => ({
    path: item.path,
    // The walked total when we have one; otherwise the scan's own figure, and
    // null when neither knows — never a zero standing in for "unknown".
    bytes: item.bytes > 0 ? item.bytes : knownSizeOf(item.path),
    willDelete: item.willProtect,
    ...(item.code ? { code: item.code } : {}),
    ...(item.detail ? { reason: item.detail } : {}),
  }));

  return {
    dryRun: true,
    items,
    bytesWouldFree: plan.bytesProtected,
    bytesSkipped: plan.bytesSkipped,
    evicts: plan.evicts,
    capsule: {
      available: plan.available,
      ...(plan.reason ? { reason: plan.reason } : {}),
      capBytes: plan.capBytes,
      usedBytes: plan.usedBytes,
    },
    openHandles,
  };
}

/**
 * Protect, verify, then trash — as one run.
 *
 * `reason` is stamped onto every capsule entry so the Time Capsule tab can say
 * where an item came from months later, the way an Autopilot run does.
 */
export async function commitCart(paths: string[]): Promise<CartCommitResult> {
  const result = await protectAndTrash(
    paths.map((path) => ({ path, reason: 'staged in the cleanup cart' })),
  );

  const trashed = new Set(result.trashed);
  const bytesFreed = result.outcomes
    .filter((o) => trashed.has(o.path))
    .reduce((sum, o) => sum + o.bytes, 0);

  return {
    dryRun: false,
    runId: result.runId,
    trashed: result.trashed,
    bytesFreed,
    skipped: result.skipped.map((o) => ({
      path: o.path,
      ...(o.code ? { code: o.code } : {}),
      ...(o.detail ? { reason: o.detail } : {}),
    })),
    failedToTrash: result.failedToTrash,
    ...(result.unavailableReason ? { capsuleUnavailable: result.unavailableReason } : {}),
  };
}

/**
 * Put a whole commit back, from the Time Capsule.
 *
 * Refuses loudly when the capsule no longer holds the run — evicted, or past
 * its retention window — rather than reporting a partial success that leaves
 * the user unsure what came back. Same wording and same failure mode as
 * Autopilot's undo, because it is the same guarantee.
 */
export async function undoCartRun(runId: string): Promise<{ jobId: string; entryCount: number; bytesTotal: number }> {
  if (typeof runId !== 'string' || !runId) {
    throw new AppError(400, 'RUN_ID_REQUIRED', 'Body must include the "runId" the commit returned');
  }
  const entries = (await listCapsuleEntriesForRun(runId)).filter((e) => e.hasPayload && !e.restoredAt);
  if (entries.length === 0) {
    throw new AppError(409, 'CAPSULE_EMPTY',
      'The Time Capsule no longer holds the copies from that commit, so it cannot be undone. ' +
      'Copies are kept for a limited time and can be evicted to make room.');
  }
  const job: TimeCapsuleJob = await startCapsuleRestore(entries.map((e) => e.id));
  return { jobId: job.jobId, entryCount: entries.length, bytesTotal: job.bytesTotal };
}
