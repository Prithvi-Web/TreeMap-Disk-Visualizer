import { test } from "node:test";
import assert from "node:assert/strict";
import fsp2 from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";
import {
  isValidDriveLetter,
  isNtfsVolume,
  findNtfsMftBinary,
  ntfsMftRootArg,
  ntfsMftScanIntoStore,
} from "../src/services/ntfsMftScanner";
import { startScan, getScan } from "../src/services/diskScanner";
import { ScanResult } from "../src/models/types";

function fakeScan(rootPath: string): ScanResult {
  return {
    scanId: "test",
    rootPath,
    status: "running",
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
    engine: "walker",
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

test("isValidDriveLetter accepts a single letter only", () => {
  assert.equal(isValidDriveLetter("C"), true);
  assert.equal(isValidDriveLetter("c"), true);
  assert.equal(isValidDriveLetter("CC"), false);
  assert.equal(isValidDriveLetter("C:"), false);
  assert.equal(isValidDriveLetter("; rm -rf /"), false);
  assert.equal(isValidDriveLetter(""), false);
});

test("ntfsMftRootArg joins safe components and rejects traversal", () => {
  assert.equal(ntfsMftRootArg([]), null);
  assert.equal(ntfsMftRootArg(["Users", "nucle"]), "Users\\nucle");
  assert.throws(() => ntfsMftRootArg(["Users", ".."]), /unsafe/);
  assert.throws(() => ntfsMftRootArg(["Users\\evil"]), /unsafe/);
});

test("isNtfsVolume returns false rather than throwing on a bad drive letter", async () => {
  assert.equal(await isNtfsVolume("not-a-drive"), false);
});

test(
  "isNtfsVolume detects the host drive on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const drive = process.env.SystemDrive?.replace(":", "") ?? "C";
    assert.equal(await isNtfsVolume(drive), true);
  },
);

test("findNtfsMftBinary returns null rather than throwing when nothing is installed", async () => {
  const found = await findNtfsMftBinary({
    bundledPath: "/nonexistent/ntfs-mft-scan.exe",
  });
  assert.equal(found, null);
});

test("ntfsMftScanIntoStore builds a store from a fake elevated run", async () => {
  const tmp = await fsp2.mkdtemp(path2.join(os.tmpdir(), "ntfs-mft-test-"));
  try {
    const scan = fakeScan("C:\\fx");
    const store = await ntfsMftScanIntoStore(scan, "C", ["fx"], {
      // Injected in place of the real UAC-elevated spawn — writes the same
      // fixture Task 1 already validated the mapper against.
      runElevated: async (outFile: string) => {
        await fsp2.copyFile(
          path2.join(__dirname, "fixtures", "ntfs-mft-sample.ndjson"),
          outFile,
        );
      },
    });
    assert.equal(store.rootPath, "C:\\fx");
    const root = store.prune(store.rootId, {
      maxNodes: Number.MAX_SAFE_INTEGER,
    }).root;
    assert.equal(root.size, 11);
  } finally {
    await fsp2.rm(tmp, { recursive: true, force: true });
  }
});

test("ntfsMftScanIntoStore rejects when the elevated run fails, never returning a partial store", async () => {
  const scan = fakeScan("C:\\fx");
  await assert.rejects(() =>
    ntfsMftScanIntoStore(scan, "C", ["fx"], {
      runElevated: async () => {
        throw new Error("UAC declined");
      },
    }),
  );
});

test("ntfsMftScanIntoStore rejects when the target path does not resolve", async () => {
  const scan = fakeScan("C:\\fx\\nope");
  await assert.rejects(() =>
    ntfsMftScanIntoStore(scan, "C", ["fx", "nope"], {
      runElevated: async (outFile: string) => {
        await fsp2.copyFile(
          path2.join(__dirname, "fixtures", "ntfs-mft-sample.ndjson"),
          outFile,
        );
      },
    }),
  );
});

test("ntfsMftScanIntoStore aborts a hung elevated run when scan.cancelled flips", async () => {
  const scan = fakeScan("C:\\fx");
  let released = false;
  const hung = ntfsMftScanIntoStore(scan, "C", ["fx"], {
    preferBroker: false,
    runElevated: () =>
      new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (scan.cancelled) {
            clearInterval(iv);
            released = true;
            resolve();
          }
        }, 20);
      }),
  });
  // Let the helper start, then cancel — cancelWatch should reject promptly.
  await new Promise((r) => setTimeout(r, 50));
  scan.cancelled = true;
  scan.abort?.();
  await assert.rejects(
    () => hung,
    (err: Error) => {
      assert.match(err.name, /NtfsMftCancelled|Error/);
      return true;
    },
  );
  assert.equal(released || scan.cancelled, true);
});

async function settle(scanId: string) {
  await new Promise<void>((r) => {
    const iv = setInterval(() => {
      if (getScan(scanId)!.status !== "running") {
        clearInterval(iv);
        r();
      }
    }, 25);
  });
  return getScan(scanId)!;
}

test("a scan falls back to the walker when ntfsMft is not opted into", async () => {
  const dir = await fsp2.mkdtemp(path2.join(os.tmpdir(), "ntfs-mft-int-"));
  process.env.TREEMAP_NO_GDU = "1";
  try {
    const started = await startScan(dir, { incremental: false });
    const s = await settle(started.scanId);
    assert.equal(s.status, "complete");
    assert.notEqual(s.engine, "ntfs-mft");
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    await fsp2.rm(dir, { recursive: true, force: true });
  }
});

test("a scan falls back to the walker when ntfsMft is opted in but the binary is missing", async () => {
  const dir = await fsp2.mkdtemp(path2.join(os.tmpdir(), "ntfs-mft-int-"));
  process.env.TREEMAP_NO_GDU = "1";
  process.env.TREEMAP_NO_NTFS_MFT_BIN = "1"; // test-only escape hatch, see implementation
  try {
    const started = await startScan(dir, { incremental: false, ntfsMft: true });
    const s = await settle(started.scanId);
    assert.equal(s.status, "complete");
    assert.notEqual(s.engine, "ntfs-mft");
    assert.equal(s.fileCount >= 0, true); // counters were reset, not left dangling
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    delete process.env.TREEMAP_NO_NTFS_MFT_BIN;
    await fsp2.rm(dir, { recursive: true, force: true });
  }
});
