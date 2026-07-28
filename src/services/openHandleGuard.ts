import { platform } from '../platform';
import { capabilityState } from '../platform/capabilities';
import type { OpenHandleInfo } from '../platform/types';

/**
 * OpenHandleGuard (B2) — is anything about to be deleted still in use?
 *
 * Deleting a file another program has open is not a hypothetical annoyance: on
 * Windows it fails outright, and on macOS and Linux it succeeds in a way that
 * is arguably worse — the name disappears while the blocks stay allocated until
 * the holder exits, so the user frees nothing and cannot see why. Either way
 * they deserve to be told *before* it happens, and told which program.
 *
 * ── Where this lives, and why it matters ──
 *
 * §B2 requires the guard to be wired into the **existing** `Cleaner` delete
 * pathway rather than beside it, so every current and future deletion inherits
 * it. That is exactly how it is wired: `moveToTrash` calls this, so the Clean
 * Up view, the cart, the Grid, the MCP tool, Offload's trash-the-originals
 * step, and the automation features still to be built (B1 Autopilot, B3 Time
 * Capsule) are all covered without any of them knowing this file exists. There
 * is no second delete path to keep in sync — §10 bans one.
 *
 * ── The honest-answer rule ──
 *
 * A guard that cannot check must never answer "nothing is open". Three states
 * are reported, never conflated (§2.2):
 *
 *   - `checked: true`, no conflicts — genuinely clear, as far as this user's
 *     own processes go.
 *   - `checked: true`, `complete: false` — the mechanism worked but could not
 *     cover everything (Windows registration cap, unreadable subtree).
 *   - `checked: false` — the mechanism is unavailable, with the capability's
 *     own reason. The delete is still allowed: refusing every deletion because
 *     `lsof` is missing would be worse than the risk it guards against.
 */

/** One "this is in use" finding, as the API and UI see it. */
export interface OpenHandleConflict {
  /** The path from the delete set that is blocked. */
  path: string;
  pid: number;
  processName: string;
  /** The file actually held open, when it sits inside `path`. */
  openPath?: string;
}

export interface OpenHandleReport {
  conflicts: OpenHandleConflict[];
  /** False when the check could not run at all; `reason` then says why. */
  checked: boolean;
  /** False when the check ran but could not cover the whole set. */
  complete: boolean;
  /** How the answer was obtained, or why it could not be — for the UI. */
  reason?: string;
  /** Milliseconds the check took, for the batch-performance criterion. */
  elapsedMs: number;
}

/** An empty set is trivially clear — don't spawn anything to prove it. */
const NOTHING: OpenHandleReport = { conflicts: [], checked: true, complete: true, elapsedMs: 0 };

/**
 * Which of `paths` (or anything beneath them) is currently held open.
 *
 * One enumeration pass covers the whole set, per §B2 — the cost is flat in the
 * number of paths, so a 10,000-file delete costs the same as a one-file delete.
 */
export async function checkOpenHandles(paths: string[]): Promise<OpenHandleReport> {
  if (paths.length === 0) return NOTHING;

  const state = await capabilityState('openHandleGuard');
  if (!state.available) {
    return {
      conflicts: [],
      checked: false,
      complete: false,
      reason: state.reason ?? 'TreeMap cannot check whether these files are in use on this computer.',
      elapsedMs: 0,
    };
  }

  const startedAt = Date.now();
  let handles: OpenHandleInfo[];
  try {
    handles = await platform().getOpenHandlesBatch(paths);
  } catch (err) {
    // A broken probe must not block a delete, and must not pretend to be a
    // clean bill of health either (§6, failure isolation).
    return {
      conflicts: [],
      checked: false,
      complete: false,
      reason: `TreeMap couldn’t check whether these files are in use (${err instanceof Error ? err.message : String(err)}).`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    conflicts: handles
      .filter((h) => h.pid !== process.pid) // our own read of a file is not a conflict
      .map((h) => ({
        path: h.path,
        pid: h.pid,
        processName: h.processName,
        ...(h.openPath && h.openPath !== h.path ? { openPath: h.openPath } : {}),
      })),
    checked: true,
    complete: true,
    ...(state.reason ? { reason: state.reason } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * One line naming who is holding things, written for someone who is not going
 * to read a table of PIDs.
 *
 * Kept here rather than in the UI because the same sentence has to appear in an
 * API error message, in the MCP tool's answer and in the confirmation dialog —
 * three surfaces that must not drift into three different wordings (§6,
 * internationalisation-readiness: user-facing strings in one place).
 */
export function describeConflicts(conflicts: readonly OpenHandleConflict[]): string {
  const names = [...new Set(conflicts.map((c) => c.processName))];
  const fileCount = new Set(conflicts.map((c) => c.openPath ?? c.path)).size;

  const who =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, 2).join(', ')} and ${String(names.length - 2)} other program${names.length - 2 === 1 ? '' : 's'}`;

  const what = fileCount === 1 ? 'a file you’re deleting' : `${String(fileCount)} of the files you’re deleting`;
  return `${who} ${names.length === 1 ? 'has' : 'have'} ${what} open right now. Deleting it may not free the space until that program closes it.`;
}
