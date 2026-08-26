import { runText, CommandUnavailableError } from '../exec';
import { membershipFromTmutil, parseDestinationInfo, parseIsExcluded, parseLatestBackup } from '../backupParsers';
import type { BackupMembership, CapabilityState } from '../types';

/**
 * Backup membership on macOS, via `tmutil` (v4 §1.2b).
 *
 * Read-only, and deliberately shallow: §1.2b forbids mounting or traversing
 * the backup destination, so the three questions asked are the three that can
 * be answered without touching it — is a destination configured, when did the
 * last backup complete, and is this path on the exclusion list.
 *
 * ── Measured on this Mac ──
 *
 *  - `tmutil destinationinfo` → `tmutil: No destinations configured.`,
 *    **exit code 0**.
 *  - `tmutil latestbackup` → `Failed to mount destination…`, **also exit 0**.
 *    Exit codes are therefore worthless here and the text is what is parsed.
 *  - `tmutil isexcluded a b c` batches, and **echoes each path back** on its
 *    own `[Included]`/`[Excluded]` line — so answers are matched by name, not
 *    by array position. That makes it immune to the alignment trap that makes
 *    `mdls` batching dangerous (see ./lastUsed.ts).
 *
 * And the finding that matters most: on this machine, with no destination
 * configured at all, `tmutil isexcluded ~/Desktop` still answers
 * **`[Included]`**. "Included" means "not on the exclusion list" — nothing
 * more. Reading it as "backed up" would tell someone with no backups at all
 * that their files are safe.
 */

/** How many paths one `tmutil isexcluded` invocation is given. */
const EXCLUDE_BATCH = 200;

interface Destination {
  configured: boolean;
  lastBackupMs: number | null;
}

let cached: { at: number; value: Destination } | null = null;
const TTL_MS = 60_000;

/** Test seam — drops the cached destination lookup. */
export function resetBackupCacheForTests(): void {
  cached = null;
}

async function destination(): Promise<Destination> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  let configured = false;
  try {
    configured = parseDestinationInfo(await runText('tmutil', ['destinationinfo'], { timeoutMs: 8_000 })).configured;
  } catch {
    configured = false;
  }

  let lastBackupMs: number | null = null;
  if (configured) {
    try {
      lastBackupMs = parseLatestBackup(await runText('tmutil', ['latestbackup'], { timeoutMs: 15_000 }));
    } catch {
      // Configured but the drive is not attached. A real state — null date,
      // never a fabricated one.
      lastBackupMs = null;
    }
  }

  const value = { configured, lastBackupMs };
  cached = { at: now, value };
  return value;
}

export async function readBackupMembershipMac(paths: string[]): Promise<Map<string, BackupMembership>> {
  const out = new Map<string, BackupMembership>();
  if (paths.length === 0) return out;

  const dest = await destination();

  // Exclusion is per path, so it is asked only when a destination exists —
  // otherwise every answer is 'unknown' anyway and the subprocess is waste.
  const excluded = new Map<string, boolean>();
  if (dest.configured) {
    for (let i = 0; i < paths.length; i += EXCLUDE_BATCH) {
      const batch = paths.slice(i, i + EXCLUDE_BATCH);
      try {
        const text = await runText('tmutil', ['isexcluded', ...batch], { timeoutMs: 20_000 });
        for (const [p, isExcluded] of parseIsExcluded(text)) excluded.set(p, isExcluded);
      } catch {
        // This batch is unknown. Leaving it out of the map is what keeps
        // 'unknown' meaning unknown rather than silently meaning 'included'.
      }
    }
  }

  for (const p of paths) {
    out.set(p, membershipFromTmutil(dest.configured, dest.lastBackupMs, excluded.get(p)));
  }
  return out;
}

export async function probeBackupMembershipMac(): Promise<CapabilityState> {
  try {
    const dest = await destination();
    if (!dest.configured) {
      return {
        available: false,
        mechanism: 'Time Machine (tmutil)',
        reason:
          'Time Machine has no backup disk set up on this Mac, so TreeMap cannot tell whether anything here has a second copy. ' +
          'It will say "unknown" rather than guess.',
      };
    }
    return { available: true, mechanism: 'Time Machine (tmutil)' };
  } catch (err) {
    if (err instanceof CommandUnavailableError) {
      return { available: false, mechanism: 'Time Machine (tmutil)', reason: 'The tmutil tool is not available, so backup status cannot be checked.' };
    }
    return { available: false, mechanism: 'Time Machine (tmutil)', reason: 'Backup status could not be checked on this Mac.' };
  }
}
