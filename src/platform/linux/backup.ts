import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { backupToolsFromPaths, linuxBackupReason } from '../backupParsers';
import type { BackupMembership, CapabilityState } from '../types';

/**
 * Backup membership on Linux (v4 §1.2b).
 *
 * Linux has no single backup system, so the only honest question is "does a
 * backup tool appear to be set up on this machine" — answered from the
 * presence of its configuration in the documented locations, plus restic's
 * own `RESTIC_REPOSITORY` environment variable.
 *
 * §1.2b states the limit outright and so does this module: **the presence of
 * a repository is not proof that a given file is inside it.** `pathCovered`
 * is therefore always `'unknown'` here — there is no equivalent of macOS's
 * exclusion list to prove even a negative — and the reason string says so in
 * the user's own words rather than implying coverage.
 *
 * Never verified on a Linux machine; the detection is covered through
 * `backupToolsFromPaths` against a synthetic presence map.
 */

interface ToolPresence {
  restic: boolean;
  borg: boolean;
  borgmatic: boolean;
  timeshift: boolean;
}

let cached: { at: number; value: string[] } | null = null;
const TTL_MS = 60_000;

/** Test seam — drops the cached tool detection. */
export function resetLinuxBackupCacheForTests(): void {
  cached = null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Configuration locations, per each tool's own documentation. */
export async function detectBackupTools(home = os.homedir()): Promise<string[]> {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const present: ToolPresence = {
    restic:
      Boolean(process.env.RESTIC_REPOSITORY) ||
      (await exists(path.join(xdg, 'restic'))) ||
      (await exists(path.join(home, '.restic'))),
    borg: (await exists(path.join(xdg, 'borg'))) || (await exists(path.join(home, '.config', 'borg'))),
    borgmatic:
      (await exists(path.join(xdg, 'borgmatic'))) ||
      (await exists('/etc/borgmatic/config.yaml')) ||
      (await exists('/etc/borgmatic.d')),
    timeshift: await exists('/etc/timeshift/timeshift.json'),
  };
  return backupToolsFromPaths(present as unknown as Record<string, boolean>);
}

async function tools(): Promise<string[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const value = await detectBackupTools();
  cached = { at: now, value };
  return value;
}

export async function readBackupMembershipLinux(paths: string[]): Promise<Map<string, BackupMembership>> {
  const found = await tools();
  const out = new Map<string, BackupMembership>();
  const membership: BackupMembership = {
    configured: found.length > 0,
    lastBackupMs: null,
    // Always unknown, by design: nothing short of reading the repository could
    // upgrade it, and reading the repository is out of scope for a read-only
    // membership check.
    pathCovered: 'unknown',
    mechanism: found.length > 0 ? found.join(' + ') : 'none',
    reason: linuxBackupReason(found),
  };
  for (const p of paths) out.set(p, { ...membership });
  return out;
}

export async function probeBackupMembershipLinux(): Promise<CapabilityState> {
  const found = await tools();
  if (found.length === 0) {
    return { available: false, mechanism: 'restic / borg / borgmatic / Timeshift config', reason: linuxBackupReason(found) };
  }
  return { available: true, mechanism: `${found.join(' + ')} configuration present`, reason: linuxBackupReason(found) };
}
