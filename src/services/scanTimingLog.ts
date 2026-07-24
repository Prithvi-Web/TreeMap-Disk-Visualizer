import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ScanResult } from "../models/types";

/**
 * Dev-oriented scan timing journal — wall-clock + optional NTFS helper phases.
 *
 * On by default for the standalone/dev server so every scan leaves a durable
 * record for v2-spec work. Opt out with TREEMAP_SCAN_TIMING=0. Force on with
 * TREEMAP_SCAN_TIMING=1 (useful in packaged builds).
 *
 * Writes one JSON object per line to logs/scan-timings.jsonl (repo root in
 * `tsx`/dev) and mirrors a one-line summary to the server console.
 */

export interface ScanTimingPhase {
  /** Milliseconds since helper start. */
  tMs: number;
  msg: string;
}

export interface ScanTimingExtras {
  ntfsMftRequested?: boolean;
  helperPhases?: ScanTimingPhase[];
  helperMs?: number;
  ndjsonBytes?: number;
  parseBuildMs?: number;
}

export interface ScanTimingRecord {
  ts: string;
  scanId: string;
  rootPath: string;
  status: string;
  engine?: string;
  engineDetail?: string;
  incremental?: boolean;
  durationMs: number;
  fileCount?: number;
  dirCount?: number;
  scanned?: number;
  ntfsMftRequested?: boolean;
  helperMs?: number;
  ndjsonBytes?: number;
  parseBuildMs?: number;
  helperPhases?: ScanTimingPhase[];
}

const extrasByScan = new Map<string, ScanTimingExtras>();

export function scanTimingEnabled(): boolean {
  const v = process.env.TREEMAP_SCAN_TIMING;
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  // Default on for the Node/tsx server; off when Electron sets resourcesPath
  // (packaged) unless explicitly forced above.
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  return !resources;
}

/** Repo-root logs/ when running from src/ or dist/; overridable. */
export function scanTimingLogPath(): string {
  if (process.env.TREEMAP_SCAN_TIMING_FILE)
    return process.env.TREEMAP_SCAN_TIMING_FILE;
  // src/services -> ../.. = repo root; dist/services -> ../.. = package root
  return path.join(__dirname, "..", "..", "logs", "scan-timings.jsonl");
}

export function mergeScanTimingExtras(
  scanId: string,
  patch: ScanTimingExtras,
): void {
  const prev = extrasByScan.get(scanId) ?? {};
  extrasByScan.set(scanId, { ...prev, ...patch });
}

/** Parse helper `--log` lines shaped like `+1234ms opening volume \\.\C:`. */
export function parseHelperPhaseLog(text: string): ScanTimingPhase[] {
  const out: ScanTimingPhase[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^\+(\d+)ms\s+(.*)$/.exec(trimmed);
    if (!m) {
      out.push({ tMs: -1, msg: trimmed });
      continue;
    }
    out.push({ tMs: Number(m[1]), msg: m[2] });
  }
  return out;
}

export async function recordScanTiming(scan: ScanResult): Promise<void> {
  if (!scanTimingEnabled()) {
    extrasByScan.delete(scan.scanId);
    return;
  }
  const extras = extrasByScan.get(scan.scanId);
  extrasByScan.delete(scan.scanId);

  const finishedAt = scan.finishedAt ?? Date.now();
  const durationMs = Math.max(0, finishedAt - scan.startedAt);
  const record: ScanTimingRecord = {
    ts: new Date(finishedAt).toISOString(),
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    status: scan.status,
    engine: scan.engine,
    engineDetail: scan.engineDetail,
    incremental: scan.incremental,
    durationMs,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    scanned: scan.scanned,
    ntfsMftRequested: extras?.ntfsMftRequested,
    helperMs: extras?.helperMs,
    ndjsonBytes: extras?.ndjsonBytes,
    parseBuildMs: extras?.parseBuildMs,
    helperPhases: extras?.helperPhases,
  };

  const summary =
    `[treemap] timing ${scan.status} engine=${scan.engine ?? "?"} ` +
    `${(durationMs / 1000).toFixed(1)}s scanned=${scan.scanned} ` +
    `path=${JSON.stringify(scan.rootPath)}` +
    (extras?.helperMs != null
      ? ` helper=${(extras.helperMs / 1000).toFixed(1)}s`
      : "") +
    (extras?.helperPhases?.length
      ? ` phases=${extras.helperPhases.length}`
      : "");
  console.info(summary);
  if (extras?.helperPhases?.length) {
    for (const p of extras.helperPhases) {
      const stamp =
        p.tMs < 0 ? "     ?ms" : `+${String(p.tMs).padStart(6, " ")}ms`;
      console.info(`[treemap] ntfs-phase ${stamp}  ${p.msg}`);
    }
  }

  const file = scanTimingLogPath();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    console.info(`[treemap] timing saved → ${file}`);
  } catch (err) {
    console.warn("[treemap] timing log write failed:", err);
  }
}

/** Fire-and-forget wrapper for call sites that must not await. */
export function recordScanTimingAsync(scan: ScanResult): void {
  void recordScanTiming(scan).catch((err: unknown) => {
    console.warn("[treemap] timing log failed:", err);
  });
}

/** Ensure the logs directory exists at server boot (dev). */
export function ensureScanTimingLogReady(): void {
  if (!scanTimingEnabled()) return;
  const file = scanTimingLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    console.info(
      `[treemap] scan timing log → ${file} (set TREEMAP_SCAN_TIMING=0 to disable)`,
    );
  } catch {
    /* best-effort */
  }
}
