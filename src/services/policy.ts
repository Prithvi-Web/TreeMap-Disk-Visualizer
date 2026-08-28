import { AgentPolicy } from '../models/types';
import path from 'path';
import { appDataDir, readJsonFileChecked } from './storage';
import { isInside } from '../utils/pathSanitizer';
import { allScans } from './diskScanner';
import { storeOf } from './scanStore';
import { AppError } from '../middleware/errorHandler';
import { formatBytes } from '../utils/formatBytes';

/**
 * policy — user-editable guard rails for what agents (and the HTTP API) may
 * scan and destroy, layered ON TOP of the existing safety model
 * (requireInsideScanRoot, trash-only deletes). The policy file is read fresh
 * on every enforcement so edits take effect immediately, and an absent or
 * empty file imposes no restriction at all — today's behavior, verbatim.
 *
 * The file is agent-policy.json in the app-data directory, edited by the
 * human (deliberately NOT writable through the API — a policy an agent could
 * rewrite for itself would be theatre):
 *
 *   {
 *     "allowedRoots": ["/Users/me/Downloads", "/Users/me/projects"],
 *     "protectedPaths": ["/Users/me/projects/keep-forever"],
 *     "maxBytesPerOperation": 10737418240
 *   }
 */

export const POLICY_FILE = 'agent-policy.json';

/**
 * Read and normalize the policy; malformed FIELDS fall back to "no
 * restriction", but an unreadable or unparseable FILE does not.
 *
 * The difference is the whole security posture. Every enforcement below
 * short-circuits on an empty policy — `assertScanAllowed` returns immediately
 * when `allowedRoots` is empty, the `protectedPaths` loop never runs, and
 * `assertBytesCap` returns when the cap is null. So "the policy file could
 * not be read" and "the user configured no restrictions" produce byte-
 * identical behaviour: every guard rail off, silently.
 *
 * An ABSENT file genuinely means no restrictions, and is documented above as
 * today's behaviour. A file that is there and will not parse is a different
 * fact, and this boundary fails closed on it: refusing an operation is
 * recoverable, and quietly permitting one is not.
 */
export async function getPolicy(): Promise<AgentPolicy> {
  const loaded = await readJsonFileChecked<Partial<AgentPolicy>>(POLICY_FILE);
  if (!loaded.ok && loaded.reason === 'corrupt') {
    // 500, not 403. Nothing about the CALLER is forbidden — the server cannot
    // determine authorization at all — and a 403 here is indistinguishable in
    // logs and on the MCP surface from a genuine policy denial. The path is in
    // the message because "fix or remove the file" is useless without it.
    throw new AppError(
      500,
      'POLICY_UNREADABLE',
      `The policy file at ${path.join(appDataDir(), POLICY_FILE)} could not be read (${loaded.detail}), so TreeMap refused this operation ` +
        'rather than acting as if you had set no limits. Fix or remove that file.',
    );
  }
  const raw: Partial<AgentPolicy> = loaded.ok ? loaded.value : {};
  return {
    allowedRoots: Array.isArray(raw.allowedRoots)
      ? raw.allowedRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
    protectedPaths: Array.isArray(raw.protectedPaths)
      ? raw.protectedPaths.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
    maxBytesPerOperation:
      typeof raw.maxBytesPerOperation === 'number' && Number.isFinite(raw.maxBytesPerOperation) && raw.maxBytesPerOperation > 0
        ? raw.maxBytesPerOperation
        : null,
  };
}

/** Scans are the entry ticket to everything else — gate them first. */
export function assertScanAllowed(policy: AgentPolicy, rootPath: string): void {
  if (policy.allowedRoots.length === 0) return;
  if (policy.allowedRoots.some((root) => isInside(root, rootPath))) return;
  throw new AppError(
    403,
    'POLICY_ROOT_NOT_ALLOWED',
    `"${rootPath}" is outside the allowed roots — edit agent-policy.json (allowedRoots) to widen them`,
  );
}

/**
 * Destructive targets must lie inside an allowed root and must not touch a
 * protected path — in either direction: trashing a folder that CONTAINS a
 * protected path would delete it just as surely.
 */
export function assertPathsAllowed(policy: AgentPolicy, paths: string[]): void {
  if (policy.allowedRoots.length > 0) {
    for (const p of paths) {
      if (!policy.allowedRoots.some((root) => isInside(root, p))) {
        throw new AppError(
          403,
          'POLICY_ROOT_NOT_ALLOWED',
          `"${p}" is outside the allowed roots — edit agent-policy.json (allowedRoots) to widen them`,
        );
      }
    }
  }
  for (const p of paths) {
    for (const protectedPath of policy.protectedPaths) {
      if (isInside(protectedPath, p) || isInside(p, protectedPath)) {
        throw new AppError(
          403,
          'POLICY_PROTECTED_PATH',
          `"${p}" touches the protected path "${protectedPath}" — remove it from agent-policy.json to allow this`,
        );
      }
    }
  }
}

/** The per-operation byte cap; null bytes (unknown size) pass — honesty over guessing. */
export function assertBytesCap(policy: AgentPolicy, bytes: number | null): void {
  if (policy.maxBytesPerOperation === null || bytes === null) return;
  if (bytes <= policy.maxBytesPerOperation) return;
  throw new AppError(
    403,
    'POLICY_BYTES_EXCEEDED',
    `This operation covers ${formatBytes(bytes)}, over the ${formatBytes(policy.maxBytesPerOperation)} per-operation cap in agent-policy.json`,
  );
}

/** Recursive size of `p` according to any completed scan that contains it. */
export function knownSizeOf(p: string): number | null {
  for (const scan of allScans()) {
    if (scan.status !== 'complete' || (!scan.store && !scan.root)) continue;
    const store = storeOf(scan);
    const id = store.findByPath(p);
    if (id !== -1) return store.size(id);
  }
  return null;
}
