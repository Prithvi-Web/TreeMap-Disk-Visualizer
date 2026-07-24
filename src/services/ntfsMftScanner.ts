import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ScanResult } from "../models/types";
import { PackedScanStore, ScanStore } from "./scanStore";
import {
  parseNtfsMftEdgesFile,
  resolveTargetRecord,
  buildNtfsMftStoreFromEdges,
} from "./ntfsMftMapper";

const execFileAsync = promisify(execFile);

/** Backstop against a wedged elevated helper — mirrors gdu's SHARD_TIMEOUT_MS.
 *  After UAC consent, Start-Process -Wait owns the child; this timeout only
 *  stops us from waiting forever if elevation or the helper wedges. */
const ELEVATED_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** A single drive letter, nothing else — the only value ever interpolated
 *  into the elevated PowerShell argument list, so it must be airtight. */
export function isValidDriveLetter(s: string): boolean {
  return /^[A-Za-z]$/.test(s);
}

/** Escape a string for PowerShell single-quoted literals ('' = one '). */
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
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
    const { stdout } = await execFileAsync("fsutil", [
      "fsinfo",
      "volumeinfo",
      `${driveLetter}:`,
    ]);
    if (/File System Name\s*:\s*NTFS/i.test(stdout)) return true;
  } catch {
    /* fall through — volumeinfo can require elevation on some hosts */
  }
  try {
    const { stdout } = await execFileAsync("wmic", [
      "logicaldisk",
      "where",
      `DeviceID='${driveLetter}:'`,
      "get",
      "FileSystem",
      "/value",
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
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const out: string[] = [];
  if (resources)
    out.push(path.join(resources, "ntfs-mft-scan", "ntfs-mft-scan.exe"));
  out.push(
    path.join(__dirname, "..", "..", "ntfs-mft-scan", "ntfs-mft-scan.exe"),
  );
  return out;
}

/** No $PATH fallback: unlike gdu, this binary is never something a
 *  contributor installs system-wide — it only ever comes from this repo's
 *  own build step (Task 8). */
export async function findNtfsMftBinary(
  opts: FindOptions = {},
): Promise<string | null> {
  const candidates = opts.bundledPath
    ? [opts.bundledPath]
    : bundledCandidates();
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
  /** Real implementation spawns ntfs-mft-scan.exe via UAC (PowerShell
   *  Start-Process -Verb RunAs). Tests inject a fake that writes NDJSON. */
  runElevated?: (outFile: string, driveLetter: string) => Promise<void>;
}

/**
 * Elevate via Windows UAC. Avoids the deprecated `sudo-prompt` package, which
 * calls removed Node APIs (`util.isObject`) and crashes on Node 25+.
 *
 * driveLetter is validated (single A–Z); binPath/outFile are ours (bundled
 * binary + mkdtemp path) and are PowerShell single-quote escaped.
 */
/** Join path components into a helper `--root` value, or null for whole volume. */
export function ntfsMftRootArg(components: string[]): string | null {
  if (!components.length) return null;
  for (const c of components) {
    if (!c || c === "." || c === ".." || /[\\/\0]/.test(c)) {
      throw new Error(
        `refusing unsafe MFT root component: ${JSON.stringify(c)}`,
      );
    }
  }
  return components.join("\\");
}

async function runElevatedViaUac(
  outFile: string,
  driveLetter: string,
  binPath: string,
  rootRelative: string | null,
): Promise<void> {
  if (!isValidDriveLetter(driveLetter)) {
    throw new Error(
      `refusing to elevate with an invalid drive letter: ${driveLetter}`,
    );
  }
  // -WindowStyle Hidden: without it, the console-subsystem helper pops a
  // blank black window for the whole MFT read (looks wedged; isn't).
  const argList = rootRelative
    ? `@('--volume',${psSingleQuote(driveLetter)},'--root',${psSingleQuote(rootRelative)},'--out',${psSingleQuote(outFile)})`
    : `@('--volume',${psSingleQuote(driveLetter)},'--out',${psSingleQuote(outFile)})`;
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$p = Start-Process -FilePath ${psSingleQuote(binPath)} -ArgumentList ${argList} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    `if ($null -eq $p) { throw 'UAC elevation was cancelled or failed' }`,
    `if ($p.ExitCode -ne 0) { exit $p.ExitCode }`,
  ].join("; ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: ELEVATED_RUN_TIMEOUT_MS, windowsHide: true },
    );
  } catch (err) {
    const e = err as Error & { killed?: boolean; code?: string };
    if (e.killed || e.code === "ETIMEDOUT") {
      throw new Error("ntfs-mft-scan timed out");
    }
    throw err;
  }
}

/** Keep the SSE progress stream alive while the elevated helper runs with
 *  scanned===0 (otherwise the UI freezes at "0 items · 0.0s"). */
function startNtfsMftHeartbeat(
  scan: ScanResult,
  outFile: string,
  phase: () => string,
): () => void {
  const t0 = Date.now();
  const tick = () => {
    const secs = Math.round((Date.now() - t0) / 1000);
    let bytes = 0;
    try {
      bytes = fs.statSync(outFile).size;
    } catch {
      /* file not created yet — Mft::new can take a while before File::create */
    }
    const sizePart =
      bytes > 0 ? ` · ${(bytes / (1024 * 1024)).toFixed(0)} MB written` : "";
    scan.currentPath = `${phase()}… ${secs}s${sizePart}`;
  };
  tick();
  const id = setInterval(tick, 500);
  return () => clearInterval(id);
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
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "treemap-ntfs-mft-"));
  const outFile = path.join(tmpDir, "edges.ndjson");
  let stopHeartbeat: (() => void) | undefined;
  try {
    if (overrides.runElevated) {
      stopHeartbeat = startNtfsMftHeartbeat(
        scan,
        outFile,
        () => "Reading NTFS MFT",
      );
      await overrides.runElevated(outFile, driveLetter);
    } else {
      const bin = await findNtfsMftBinary();
      if (!bin) throw new Error("ntfs-mft-scan binary not found");
      const rootRelative = ntfsMftRootArg(pathComponents);
      console.info(
        `[treemap] ntfs-mft: elevating ${bin} for volume ${driveLetter}:` +
          (rootRelative ? ` root=${rootRelative}` : " (whole volume)") +
          " (UAC)…",
      );
      stopHeartbeat = startNtfsMftHeartbeat(
        scan,
        outFile,
        () => "Reading NTFS MFT (admin)",
      );
      const tElev = Date.now();
      await runElevatedViaUac(outFile, driveLetter, bin, rootRelative);
      let outBytes = 0;
      try {
        outBytes = (await fsp.stat(outFile)).size;
      } catch {
        /* ignore */
      }
      console.info(
        `[treemap] ntfs-mft: helper finished in ${((Date.now() - tElev) / 1000).toFixed(1)}s` +
          ` (${(outBytes / (1024 * 1024)).toFixed(1)} MB NDJSON)`,
      );
    }

    stopHeartbeat?.();
    stopHeartbeat = startNtfsMftHeartbeat(
      scan,
      outFile,
      () => "Parsing MFT edges",
    );
    // Stream line-by-line — never load a multi-hundred-MB dump as one string.
    const { edgesByParent, targetRecordNo: metaTarget } =
      await parseNtfsMftEdgesFile(outFile);
    const targetRecordNo =
      metaTarget ?? resolveTargetRecord(edgesByParent, pathComponents);
    if (targetRecordNo === null) {
      throw new Error(`could not resolve ${scan.rootPath} in the MFT edge set`);
    }

    stopHeartbeat?.();
    stopHeartbeat = startNtfsMftHeartbeat(
      scan,
      outFile,
      () => "Building folder tree from MFT",
    );

    const rootName = pathComponents.length
      ? pathComponents[pathComponents.length - 1]
      : `${driveLetter}:\\`;
    const store = new PackedScanStore(scan.rootPath, "\\", {
      name: rootName,
      isDir: true,
      size: 0,
      modifiedAt: Date.now(),
      isHidden: false,
    });

    const { stats } = buildNtfsMftStoreFromEdges(
      edgesByParent,
      targetRecordNo,
      store,
      store.rootId,
    );
    scan.fileCount = stats.fileCount;
    scan.dirCount = stats.dirCount + 1; // +1 for the root itself
    scan.hardlinkedFiles = stats.hardlinkedFiles;
    scan.hardlinkedBytes = stats.hardlinkedBytes;
    scan.scanned = scan.fileCount + scan.dirCount;
    scan.currentPath = scan.rootPath;

    store.finalize();
    store.sumSizes();
    return store;
  } finally {
    stopHeartbeat?.();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
