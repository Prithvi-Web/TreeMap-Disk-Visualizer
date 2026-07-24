import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ntfsMftScanIntoStore } from "../src/services/ntfsMftScanner";
import { ScanResult } from "../src/models/types";

function fakeScan(rootPath: string): ScanResult {
  return {
    scanId: "fallback-test",
    rootPath,
    status: "running",
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
    engine: "ntfs-mft",
    ioThreads: 1,
    incremental: false,
    cachedDirs: 0,
    walkedDirs: 0,
    hardlinkedFiles: 0,
    hardlinkedBytes: 0,
    cloudFiles: 0,
    cloudBytes: 0,
  } as ScanResult;
}

const EDGE = JSON.stringify({
  recordNo: 100,
  parentRecordNo: 5,
  name: "fx",
  size: 0,
  isDir: true,
  mtimeMs: 1,
});
const FILE = JSON.stringify({
  recordNo: 101,
  parentRecordNo: 100,
  name: "a.txt",
  size: 3,
  isDir: false,
  mtimeMs: 1,
});

test("broker unreachable falls back to runElevated / UAC path, not a hang or crash", async () => {
  const scan = fakeScan("C:\\fx");
  let elevatedCalls = 0;
  const store = await ntfsMftScanIntoStore(scan, "C", ["fx"], {
    preferBroker: true,
    runViaBroker: async () => {
      throw new Error("connection refused");
    },
    runElevated: async (outFile) => {
      elevatedCalls += 1;
      await fsp.writeFile(
        outFile,
        `{"_meta":true,"targetRecordNo":100}\n${EDGE}\n${FILE}\n`,
      );
    },
  });
  assert.ok(elevatedCalls >= 1, "must fall back to elevated helper");
  assert.ok(store.rootId >= 0);
});
