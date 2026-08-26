import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { parseFileHistoryConfig } from '../backupParsers';
import type { BackupMembership, CapabilityState } from '../types';

/**
 * Backup membership on Windows, via File History (v4 §1.2b).
 *
 * File History keeps its configuration at
 * `%LOCALAPPDATA%\Microsoft\Windows\FileHistory\Configuration\Config1.xml`,
 * which records whether it is switched on and which folders it protects.
 * Reading it needs no elevation and touches no backup volume, which is what
 * §1.2b asks for.
 *
 * **A protected folder still yields `pathCovered: 'unknown'`.** File History
 * protects a folder on a schedule; a file created since the last cycle, or one
 * that failed to copy, is inside a protected folder and absent from the
 * backup.
 *
 * This reader establishes nothing about exclusion — it reads the protected
 * folder list but does not match paths against it, because the config lists
 * user libraries whose real locations can be redirected. It therefore reports
 * `exclusionChecked: false`, and the composite words its verdict accordingly
 * rather than claiming this location is "not skipped".
 *
 * Never verified on a Windows machine; the parse seam is covered against
 * captured config XML.
 */

interface FileHistoryState {
  enabled: boolean;
  includedFolders: string[];
  reason?: string;
}

let cached: { at: number; value: FileHistoryState } | null = null;
const TTL_MS = 60_000;

/** Test seam — drops the cached File History lookup. */
export function resetWindowsBackupCacheForTests(): void {
  cached = null;
}

function configPath(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Microsoft', 'Windows', 'FileHistory', 'Configuration', 'Config1.xml');
}

async function state(): Promise<FileHistoryState> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  let value: FileHistoryState;
  try {
    const xml = await fsp.readFile(configPath(), 'utf8');
    const parsed = parseFileHistoryConfig(xml);
    value = parsed.enabled
      ? parsed
      : { ...parsed, reason: 'File History is set up on this PC but is currently switched off, so recent changes are not being backed up.' };
  } catch {
    value = {
      enabled: false,
      includedFolders: [],
      reason:
        'File History is not set up on this PC, so TreeMap cannot tell whether anything here has a second copy. It will say "unknown" rather than guess.',
    };
  }
  cached = { at: now, value };
  return value;
}

export async function readBackupMembershipWindows(paths: string[]): Promise<Map<string, BackupMembership>> {
  const fh = await state();
  const out = new Map<string, BackupMembership>();
  for (const p of paths) {
    out.set(p, {
      configured: fh.enabled,
      lastBackupMs: null,
      // Never 'yes'. A protected folder is a schedule, not a guarantee that
      // this file made it into a completed cycle.
      pathCovered: 'unknown',
      // The config's protected-folder list is parsed but never matched against
      // the path, so no exclusion check has actually happened.
      exclusionChecked: false,
      mechanism: 'File History',
      ...(fh.reason ? { reason: fh.reason } : {}),
    });
  }
  return out;
}

export async function probeBackupMembershipWindows(): Promise<CapabilityState> {
  const fh = await state();
  if (!fh.enabled) {
    return { available: false, mechanism: 'File History', reason: fh.reason ?? 'File History is not switched on for this PC.' };
  }
  return { available: true, mechanism: 'File History' };
}
