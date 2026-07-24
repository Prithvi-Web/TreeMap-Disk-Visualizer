/**
 * Warm-path helpers for the persisted NTFS MFT index (Plan #2).
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { appDataDir } from "./storage";
import {
  INDEX_FORMAT_VERSION,
  IndexCheckpoint,
  IndexRecord,
  loadIndex,
  saveIndex,
} from "./ntfsMftIndexStore";
import { decideRefreshStrategy } from "./ntfsMftInvalidation";
import {
  applyJournalEvents,
  JournalApplyGapError,
  JournalEvent,
} from "./ntfsMftJournalApply";
import { NtfsMftEdge } from "./ntfsMftMapper";

export type IndexFreshness = "cold-mft" | "warm-index" | "warm-incremental";

export function indexDir(): string {
  return path.join(appDataDir(), "ntfs-mft-index");
}

export function indexPathForVolume(driveLetter: string): string {
  return path.join(indexDir(), `${driveLetter.toUpperCase()}.idx`);
}

export async function loadVolumeIndex(
  driveLetter: string,
): Promise<{ checkpoint: IndexCheckpoint; records: IndexRecord[] } | null> {
  const file = indexPathForVolume(driveLetter);
  try {
    return await loadIndex(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[treemap] ntfs-mft: treating unreadable index as no-checkpoint (${file}): ${msg}`,
    );
    return null;
  }
}

export async function saveVolumeIndex(
  driveLetter: string,
  checkpoint: IndexCheckpoint,
  records: IndexRecord[],
): Promise<void> {
  const dir = indexDir();
  await fsp.mkdir(dir, { recursive: true });
  await saveIndex(indexPathForVolume(driveLetter), checkpoint, records);
}

export async function deleteVolumeIndex(driveLetter: string): Promise<void> {
  try {
    await fsp.unlink(indexPathForVolume(driveLetter));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

export function edgesToIndexRecords(
  edgesByParent: Map<number, NtfsMftEdge[]>,
): IndexRecord[] {
  const out: IndexRecord[] = [];
  for (const edges of edgesByParent.values()) {
    for (const e of edges) {
      out.push({
        recordNo: e.recordNo,
        parentRecordNo: e.parentRecordNo,
        name: e.name,
        size: e.size,
        isDir: e.isDir,
        mtimeMs: e.mtimeMs,
      });
    }
  }
  return out;
}

export function indexRecordsToEdgesByParent(
  records: IndexRecord[],
): Map<number, NtfsMftEdge[]> {
  const byParent = new Map<number, NtfsMftEdge[]>();
  for (const r of records) {
    const edge: NtfsMftEdge = {
      recordNo: r.recordNo,
      parentRecordNo: r.parentRecordNo,
      name: r.name,
      size: r.size,
      isDir: r.isDir,
      mtimeMs: r.mtimeMs,
    };
    const list = byParent.get(r.parentRecordNo);
    if (list) list.push(edge);
    else byParent.set(r.parentRecordNo, [edge]);
  }
  return byParent;
}

export function parseUsnInfoJson(text: string): {
  volumeSerialNumber: number;
  usnJournalId: bigint;
  firstUsn: bigint;
  nextUsn: bigint;
} {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) throw new Error("empty usn-info output");
  const obj = JSON.parse(line) as {
    volumeSerialNumber: number;
    usnJournalId: string;
    firstUsn: string;
    nextUsn: string;
  };
  return {
    volumeSerialNumber: obj.volumeSerialNumber,
    usnJournalId: BigInt(obj.usnJournalId),
    firstUsn: BigInt(obj.firstUsn),
    nextUsn: BigInt(obj.nextUsn),
  };
}

export function parseUsnReadEvents(ndjson: string): {
  events: JournalEvent[];
  nextUsn: bigint | null;
} {
  const events: JournalEvent[] = [];
  let nextUsn: bigint | null = null;
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const obj = JSON.parse(line) as {
      _meta?: boolean;
      nextUsn?: string;
      fileId?: number;
      parentId?: number;
      name?: string;
      reason?: JournalEvent["reason"];
      timestampMs?: number;
    };
    if (obj._meta) {
      if (typeof obj.nextUsn === "string") nextUsn = BigInt(obj.nextUsn);
      continue;
    }
    if (typeof obj.fileId !== "number" || !obj.reason) continue;
    events.push({
      recordNo: obj.fileId,
      parentRecordNo: obj.parentId,
      name: obj.name,
      reason: obj.reason,
      mtimeMs: obj.timestampMs,
    });
  }
  return { events, nextUsn };
}

export {
  decideRefreshStrategy,
  JournalApplyGapError,
  applyJournalEvents,
  INDEX_FORMAT_VERSION,
};
