import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** A single drive letter, nothing else — the only value ever interpolated
 *  into the sudo-prompt shell string in Task 4, so it must be airtight. */
export function isValidDriveLetter(s: string): boolean {
  return /^[A-Za-z]$/.test(s);
}

/**
 * True if `driveLetter`'s volume is NTFS. Runs BEFORE any elevation is
 * attempted, so it must never itself require admin rights.
 *
 * Prefers `fsutil fsinfo volumeinfo` (plan/spec §3.6). On some Windows hosts
 * that call returns Access Denied without elevation even though the tool is
 * otherwise present — fall back to unprivileged `wmic logicaldisk` so a real
 * NTFS volume is not misclassified as ineligible. driveLetter is validated
 * above, so interpolating it into the WMIC where-clause stays argv-safe.
 * Any failure (bad input, missing drive, non-Windows) returns false rather
 * than throwing — this feeds an eligibility gate, not an error path.
 */
export async function isNtfsVolume(driveLetter: string): Promise<boolean> {
  if (!isValidDriveLetter(driveLetter)) return false;
  try {
    const { stdout } = await execFileAsync('fsutil', ['fsinfo', 'volumeinfo', `${driveLetter}:`]);
    if (/File System Name\s*:\s*NTFS/i.test(stdout)) return true;
  } catch {
    /* fall through — volumeinfo can require elevation on some hosts */
  }
  try {
    const { stdout } = await execFileAsync('wmic', [
      'logicaldisk',
      'where',
      `DeviceID='${driveLetter}:'`,
      'get',
      'FileSystem',
      '/value',
    ]);
    return /FileSystem\s*=\s*NTFS/i.test(stdout);
  } catch {
    return false;
  }
}

export interface FindOptions {
  bundledPath?: string;
}

/** Where a bundled ntfs-mft-scan.exe might live — see bundledCandidates in
 *  gduScanner.ts for why both the packaged and dev-relative path are checked. */
function bundledCandidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const out: string[] = [];
  if (resources) out.push(path.join(resources, 'ntfs-mft-scan', 'ntfs-mft-scan.exe'));
  out.push(path.join(__dirname, '..', '..', 'ntfs-mft-scan', 'ntfs-mft-scan.exe'));
  return out;
}

/** No $PATH fallback: unlike gdu, this binary is never something a
 *  contributor installs system-wide — it only ever comes from this repo's
 *  own build step (Task 8). */
export async function findNtfsMftBinary(opts: FindOptions = {}): Promise<string | null> {
  const candidates = opts.bundledPath ? [opts.bundledPath] : bundledCandidates();
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
