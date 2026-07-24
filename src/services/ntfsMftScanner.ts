import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sudoPrompt from 'sudo-prompt'; // top-level import, matching this codebase's style — not a lazy require()
import { ScanResult } from '../models/types';
import { PackedScanStore, ScanStore } from './scanStore';
import { parseNtfsMftEdges, resolveTargetRecord, buildNtfsMftStoreFromEdges } from './ntfsMftMapper';

const execFileAsync = promisify(execFile);

/** Backstop against a wedged elevated helper — mirrors gdu's SHARD_TIMEOUT_MS.
 *  sudo-prompt gives no killable handle, so this can only stop US from
 *  waiting forever; the orphaned process, if still running, finishes on its
 *  own in its own temp dir and its output is simply never consumed. */
const ELEVATED_RUN_TIMEOUT_MS = 5 * 60 * 1000;

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

export interface NtfsMftScanOverrides {
  /** Real implementation (Task 5 wiring) spawns ntfs-mft-scan.exe via
   *  sudo-prompt; tests inject a fake that just writes NDJSON to outFile. */
  runElevated?: (outFile: string, driveLetter: string) => Promise<void>;
}

function runElevatedViaSudoPrompt(outFile: string, driveLetter: string, binPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidDriveLetter(driveLetter)) {
      reject(new Error(`refusing to elevate with an invalid drive letter: ${driveLetter}`));
      return;
    }
    // sudo-prompt's API takes a shell command STRING, not an argv array —
    // the one place in this codebase that can't use execFile's argv safety.
    // Both interpolated values are strictly constrained: driveLetter is
    // validated above (single letter only), outFile is always one WE
    // generated via fsp.mkdtemp — never user input.
    const cmd = `"${binPath}" --volume ${driveLetter} --out "${outFile}"`;
    const timer = setTimeout(() => reject(new Error('ntfs-mft-scan timed out')), ELEVATED_RUN_TIMEOUT_MS);
    sudoPrompt.exec(cmd, { name: 'TreeMap' }, (err: Error | null) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Build a store for `scan.rootPath` (a folder under drive `driveLetter`,
 * split into `pathComponents` relative to the volume root) via a full-volume
 * MFT read. Throws on any failure — callers (Task 5) fall back to gdu/walker.
 */
export async function ntfsMftScanIntoStore(
  scan: ScanResult,
  driveLetter: string,
  pathComponents: string[],
  overrides: NtfsMftScanOverrides = {},
): Promise<ScanStore> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-ntfs-mft-'));
  const outFile = path.join(tmpDir, 'edges.ndjson');
  try {
    if (overrides.runElevated) {
      await overrides.runElevated(outFile, driveLetter);
    } else {
      const bin = await findNtfsMftBinary();
      if (!bin) throw new Error('ntfs-mft-scan binary not found');
      await runElevatedViaSudoPrompt(outFile, driveLetter, bin);
    }

    const ndjson = await fsp.readFile(outFile, 'utf8');
    const edges = parseNtfsMftEdges(ndjson);
    const targetRecordNo = resolveTargetRecord(edges, pathComponents);
    if (targetRecordNo === null) {
      throw new Error(`could not resolve ${scan.rootPath} in the MFT edge set`);
    }

    const rootName = pathComponents.length ? pathComponents[pathComponents.length - 1] : `${driveLetter}:\\`;
    const store = new PackedScanStore(scan.rootPath, '\\', {
      name: rootName,
      isDir: true,
      size: 0,
      modifiedAt: Date.now(),
      isHidden: false,
    });

    const { stats } = buildNtfsMftStoreFromEdges(edges, targetRecordNo, store, store.rootId);
    scan.fileCount = stats.fileCount;
    scan.dirCount = stats.dirCount + 1; // +1 for the root itself
    scan.hardlinkedFiles = stats.hardlinkedFiles;
    scan.hardlinkedBytes = stats.hardlinkedBytes;
    scan.scanned = scan.fileCount + scan.dirCount;

    store.finalize();
    store.sumSizes();
    return store;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
