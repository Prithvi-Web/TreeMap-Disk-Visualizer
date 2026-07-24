import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseHelperPhaseLog,
  recordScanTiming,
  mergeScanTimingExtras,
  scanTimingLogPath,
} from "../src/services/scanTimingLog";
import { ScanResult } from "../src/models/types";

test("parseHelperPhaseLog reads +ms lines and keeps bare lines", () => {
  const phases = parseHelperPhaseLog(
    [
      "+0ms start",
      "+120ms opening volume \\\\.\\C:",
      "weird",
      "+45000ms done — 12 edges",
    ].join("\n"),
  );
  assert.deepEqual(phases, [
    { tMs: 0, msg: "start" },
    { tMs: 120, msg: "opening volume \\\\.\\C:" },
    { tMs: -1, msg: "weird" },
    { tMs: 45000, msg: "done — 12 edges" },
  ]);
});

test("recordScanTiming appends a JSONL row when enabled", async () => {
  const prev = process.env.TREEMAP_SCAN_TIMING;
  const prevFile = process.env.TREEMAP_SCAN_TIMING_FILE;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "treemap-timing-"));
  const file = path.join(tmp, "scan-timings.jsonl");
  process.env.TREEMAP_SCAN_TIMING = "1";
  process.env.TREEMAP_SCAN_TIMING_FILE = file;
  try {
    const scan = {
      scanId: "timing-test",
      rootPath: "C:\\Users\\test",
      status: "complete",
      scanned: 10,
      fileCount: 8,
      dirCount: 2,
      currentPath: "C:\\Users\\test",
      startedAt: Date.now() - 1500,
      finishedAt: Date.now(),
      createdAt: Date.now(),
      cancelled: false,
      engine: "turbo-walker",
      incremental: false,
    } as ScanResult;
    mergeScanTimingExtras(scan.scanId, {
      ntfsMftRequested: false,
      helperPhases: [{ tMs: 0, msg: "start" }],
    });
    await recordScanTiming(scan);
    assert.equal(scanTimingLogPath(), file);
    const lines = (await fsp.readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]) as {
      engine: string;
      durationMs: number;
      helperPhases: unknown[];
    };
    assert.equal(row.engine, "turbo-walker");
    assert.ok(row.durationMs >= 1000);
    assert.equal(row.helperPhases.length, 1);
  } finally {
    if (prev === undefined) delete process.env.TREEMAP_SCAN_TIMING;
    else process.env.TREEMAP_SCAN_TIMING = prev;
    if (prevFile === undefined) delete process.env.TREEMAP_SCAN_TIMING_FILE;
    else process.env.TREEMAP_SCAN_TIMING_FILE = prevFile;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
