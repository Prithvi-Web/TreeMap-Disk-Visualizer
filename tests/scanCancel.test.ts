import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startScan, getScan, cancelScan } from "../src/services/diskScanner";

async function settle(scanId: string, timeoutMs = 30_000) {
  const start = Date.now();
  await new Promise<void>((r, reject) => {
    const iv = setInterval(() => {
      const s = getScan(scanId);
      if (!s || s.status !== "running") {
        clearInterval(iv);
        r();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("scan did not leave running in time"));
      }
    }, 25);
  });
  return getScan(scanId)!;
}

test("cancelScan stops a running walker scan", async () => {
  // Deep-ish temp tree so the walk is still running when we cancel.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "scan-cancel-"));
  process.env.TREEMAP_NO_GDU = "1";
  process.env.TREEMAP_NO_NTFS_MFT = "1";
  try {
    for (let i = 0; i < 40; i++) {
      const d = path.join(root, `d${i}`);
      await fsp.mkdir(d);
      await fsp.writeFile(path.join(d, "f.txt"), "x".repeat(16));
    }
    const started = await startScan(root, { incremental: false });
    assert.equal(cancelScan(started.scanId), true);
    const s = await settle(started.scanId);
    assert.equal(s.status, "cancelled");
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    delete process.env.TREEMAP_NO_NTFS_MFT;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
