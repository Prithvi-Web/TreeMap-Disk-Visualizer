import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decideRefreshStrategy,
  JournalApplyGapError,
  applyJournalEvents,
  loadVolumeIndex,
  saveVolumeIndex,
  deleteVolumeIndex,
  indexPathForVolume,
  INDEX_FORMAT_VERSION,
} from "../src/services/ntfsMftWarmPath";
import { saveIndex } from "../src/services/ntfsMftIndexStore";

test("corrupt/unreadable persisted index is treated as no-checkpoint (full reindex)", async () => {
  const prev = process.env.TREEMAP_DATA_DIR;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "treemap-warm-"));
  process.env.TREEMAP_DATA_DIR = dir;
  try {
    const file = indexPathForVolume("Z");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from("not-an-index"));
    const loaded = await loadVolumeIndex("Z");
    assert.equal(loaded, null);
    const strategy = decideRefreshStrategy(null, {
      volumeSerialNumber: 1,
      usnJournalId: 1n,
      firstUsn: 0n,
      nextUsn: 1n,
    });
    assert.equal(strategy.strategy, "full-reindex");
    assert.equal(strategy.reason, "no-checkpoint");
  } finally {
    if (prev === undefined) delete process.env.TREEMAP_DATA_DIR;
    else process.env.TREEMAP_DATA_DIR = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("JournalApplyGapError is distinguishable for full-reindex fallback", () => {
  assert.throws(
    () =>
      applyJournalEvents(
        [{ recordNo: 1, parentRecordNo: 5, name: "a", size: 0, isDir: false, mtimeMs: 0 }],
        [{ recordNo: 99, reason: "data-extend", size: 1, mtimeMs: 1 }],
      ),
    (err: unknown) => err instanceof JournalApplyGapError,
  );
});

test("deleteVolumeIndex removes a saved checkpoint file", async () => {
  const prev = process.env.TREEMAP_DATA_DIR;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "treemap-warm-"));
  process.env.TREEMAP_DATA_DIR = dir;
  try {
    await saveVolumeIndex(
      "Y",
      {
        volumeSerialNumber: 1,
        usnJournalId: 1n,
        lastUsnProcessed: 1n,
        formatVersion: INDEX_FORMAT_VERSION,
      },
      [],
    );
    assert.equal((await loadVolumeIndex("Y"))?.checkpoint.formatVersion, 1);
    await deleteVolumeIndex("Y");
    assert.equal(await loadVolumeIndex("Y"), null);
  } finally {
    if (prev === undefined) delete process.env.TREEMAP_DATA_DIR;
    else process.env.TREEMAP_DATA_DIR = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("mismatched format version on disk loads as no-checkpoint", async () => {
  const prev = process.env.TREEMAP_DATA_DIR;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "treemap-warm-"));
  process.env.TREEMAP_DATA_DIR = dir;
  try {
    const file = indexPathForVolume("X");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await saveIndex(
      file,
      {
        volumeSerialNumber: 1,
        usnJournalId: 1n,
        lastUsnProcessed: 1n,
        formatVersion: 999,
      },
      [],
    );
    assert.equal(await loadVolumeIndex("X"), null);
  } finally {
    if (prev === undefined) delete process.env.TREEMAP_DATA_DIR;
    else process.env.TREEMAP_DATA_DIR = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
