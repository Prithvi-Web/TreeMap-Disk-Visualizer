import fs from 'fs';
import { formatCount } from '../utils/formatCount';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  FileNode,
  OffloadEntry,
  OffloadJob,
  ScanResult,
} from '../models/types';
import { storeOf, Flag } from './scanStore';
import { readJsonFile, writeJsonFile } from './storage';
import { moveToTrash } from './cleaner';
import { checkOpenHandles, describeConflicts } from './openHandleGuard';
import { diskUsage } from './diskUsage';
import { canonicalDirOf, isAppDataPath, isInside, isSpillPath, liesInside, PathRejectedError, realPlaceNow, sanitizePath } from '../utils/pathSanitizer';
import { copyWithHash, hashFile, CopyCancelled, CopyLeftBehind, partialNameFor, placeWithoutClobber, withinStallLimit } from '../utils/copyVerify';
import { describeFsError, meansAbsent } from '../utils/errno';
import { formatBytes } from '../utils/formatBytes';
import { AppError } from '../middleware/errorHandler';
import { assertNotAppDataPath, assertNotSpillPath } from '../middleware/pathGuard';
import { AsyncMutex } from '../utils/asyncMutex';
import { recordRestorePartial, restorePlacementHooks, whileRestoring } from './restoreLeftovers';
import { JUNK_FILES } from './emptyFolderCheck';
import { liveApfsContainers } from './apfsContainers';
import { mountedReadOnly } from '../utils/mountBoundaries';

/**
 * Offload — the third option next to "keep" and "trash" (Phase 7).
 *
 * Files are COPIED to the destination, every copy is READ BACK and its
 * SHA-256 compared against the hash streamed during the copy, and only when
 * every item verifies do the local originals go to the system Trash — never
 * a bare move. A failure before then (destination full, verify mismatch,
 * cancel) rolls back everything this job wrote and leaves local data
 * untouched; after it nothing is rolled back, and an original that cannot go
 * to the Trash, or is left in place, stays beside its verified copy.
 *
 * A manifest in the app-data dir records every offloaded file (original
 * path, destination, size, hash, date); a merged copy also lands at the
 * destination root so the drive is self-describing. Restore copies back,
 * re-verifies against the recorded hash (catching bit-rot on the external
 * drive), and marks the entry restored.
 */

const MANIFEST_FILE = 'offload-manifest.json';
/** Manifest copy written to each destination root. */
const DEST_MANIFEST = 'treemap-offload-manifest.json';
const MAX_MANIFEST_ENTRIES = 10_000;
const MAX_FILES_PER_JOB = 10_000;
/**
 * How long the record on a destination drive may take before the job goes on without it (FG3g review
 * F1.2). Written after the app-data record is saved and the manifest let go, so a drive that stops
 * answering holds nothing else — and with this, not the job either.
 */
const DEST_RECORD_STALL_MS = 60_000;
/** Keep a little headroom beyond the plan's byte total. */
const FREE_SPACE_MARGIN = 1.02;
const JOB_TTL_MS = 30 * 60_000;

/* ---------------- manifest store ---------------- */

interface ManifestStore {
  entries: OffloadEntry[];
  /** Per destination root: when we last saw it mounted. */
  destinations: Record<string, { lastSeenAt: number }>;
}

/**
 * Test-only: awaited each time the manifest has been read, before anything is done with it (FG3g M3):
 * a test holds one read-modify-write there to show what overlaps it. The suite's ForTests idiom:
 * returns the function that removes it.
 */
let afterManifestLoadForTests: (() => Promise<void>) | null = null;
export function setAfterManifestLoadForTests(hook: () => Promise<void>): () => void {
  afterManifestLoadForTests = hook;
  return () => { afterManifestLoadForTests = null; };
}

async function loadManifest(): Promise<ManifestStore> {
  const raw = await readJsonFile<Partial<ManifestStore>>(MANIFEST_FILE, {});
  if (afterManifestLoadForTests) await afterManifestLoadForTests();
  return {
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    destinations: raw.destinations && typeof raw.destinations === 'object' ? raw.destinations : {},
  };
}

/**
 * Trim to the cap by ageing out restored entries, the oldest first — never an active one (final review
 * F1.9). An active entry is the only way Restore finds a file whose original is in the Trash and whose
 * copy is on another drive: dropping the oldest of them, as this did once the record passed the cap (two
 * offloads of 6,000 and 5,000 files), lost files' way back with no word. So the cap bounds restored
 * entries only, and active ones are kept however many there are.
 */
export function trimManifest(entries: OffloadEntry[], cap: number): OffloadEntry[] {
  if (entries.length <= cap) return entries;
  const active = entries.filter((e) => !e.restoredAt);
  const room = Math.max(0, cap - active.length);
  const keptRestored = new Set(
    entries.filter((e) => e.restoredAt).sort((a, b) => b.offloadedAt - a.offloadedAt).slice(0, room),
  );
  return entries.filter((e) => !e.restoredAt || keptRestored.has(e));
}

async function saveManifest(store: ManifestStore): Promise<void> {
  store.entries = trimManifest(store.entries, MAX_MANIFEST_ENTRIES);
  await writeJsonFile(MANIFEST_FILE, store);
}

/**
 * Test-only: awaited with the destination root at the start of each write of the record on a drive
 * (FG3g review F1.2), so a test holds one there as a drive that stops answering. The suite's ForTests
 * idiom: returns the function that removes it.
 */
let destManifestWriteForTests: ((destRoot: string) => Promise<void>) | null = null;
export function setDestManifestWriteForTests(hook: (destRoot: string) => Promise<void>): () => void {
  destManifestWriteForTests = hook;
  return () => { destManifestWriteForTests = null; };
}

/**
 * Every read-modify-write of the manifest, one at a time (FG3g M3): load, change, save, with nothing
 * else's save in between. A restore loaded the manifest when it started, copied for as long as the
 * copies took and saved what it had loaded — so an offload that finished meanwhile was erased from
 * the record (its originals in the Trash, its copies at the destination, and Restore unable to list
 * them), and two overlapping restores lost each other's "restored". Every `saveManifest` call is
 * inside one (tests/offloadManifestLock.test.ts reads this file to hold it so); a read alone needs
 * none, since a save replaces the file whole. Never nested: see AsyncMutex. Nothing on another drive
 * is touched while it is held: the record on the destination is written after (FG3g review F1.2),
 * and the Offloaded tab looks at each destination before (FG3g review F2.6).
 *
 * The lock is this process's own (FG3h B). The MCP server is a second process that can offload into
 * the same app data, and nothing coordinates the two read-modify-writes. Each save goes through a
 * temp file named for its process and a rename (`writeJsonFile`, FG3g review F2.5), so the file is
 * always one whole document — never a torn one, which a reader takes for corrupt and starts again
 * from empty. Two saves in the same instant, one per process, keep only the later: the other's
 * entries are missing from the record (their copies stand at the destination, where the drive's own
 * record lists them unless its two writes crossed the same way; restoredAt lost is a restore offered
 * again, which refuses as occupied). Each read-modify-write here is a read and a write of one small
 * file, so the window is that long; AGENTS.md says so.
 */
const manifestLock = new AsyncMutex();

function withOffloadManifest<T>(fn: () => Promise<T>): Promise<T> {
  return manifestLock.run(fn);
}

/** Test-only: how many read-modify-writes of the manifest are waiting for the one under way (FG3g M3). */
export function offloadManifestWaitersForTests(): number {
  return manifestLock.waiting;
}

/**
 * The writes of one drive's own record, one at a time, by the destination's root (FG3g review F2.1).
 * A write reads the record, merges this destination's entries into it and renames a new one over
 * it, so two that overlapped — two offloads to one drive finishing close together, or one that
 * stalled after its read and went on after another's rename — each wrote what it had read, and the
 * later rename dropped the other's entry. Taken only around that write and never with the manifest
 * lock: a drive that stops answering holds the next write of its own record, and nothing else.
 */
const destRecordLocks = new Map<string, { lock: AsyncMutex; users: number }>();

async function withDestRecord<T>(destRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(destRoot);
  let slot = destRecordLocks.get(key);
  if (slot === undefined) {
    slot = { lock: new AsyncMutex(), users: 0 };
    destRecordLocks.set(key, slot);
  }
  slot.users++;
  try {
    return await slot.lock.run(fn);
  } finally {
    slot.users--;
    if (slot.users === 0) destRecordLocks.delete(key);
  }
}

/** A record on a drive this size or smaller is always read whole; a larger one only within `driveRecordLimit`. */
const MAX_DEST_MANIFEST_BYTES = 32 * 1024 * 1024;
let destRecordFloor = MAX_DEST_MANIFEST_BYTES;

/**
 * Test-only: a smaller size for the record on a drive that is always read whole (final review F2.4), so
 * a test shows the limit with a few entries rather than 32 MiB of them. The suite's ForTests idiom:
 * returns the function that removes it.
 */
export function setDestRecordFloorForTests(bytes: number): () => void {
  destRecordFloor = bytes;
  return () => { destRecordFloor = MAX_DEST_MANIFEST_BYTES; };
}

/**
 * Opening a new file exclusively: created here or not at all, never an existing name — a link at the
 * name fails with EEXIST rather than being followed, and so does a second name for another file.
 * `O_NOFOLLOW` too where the platform has it (not Windows, where O_EXCL alone refuses a link).
 */
const EXCLUSIVE_NEW_FILE = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
/**
 * Reading a file without following a link at its own name, where the platform can say so, and
 * without waiting on a FIFO swapped in after the name was looked at (`O_NONBLOCK`; a regular file
 * reads as ever).
 */
const READ_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** Why a name on the drive is not a plain file of one name, as a sentence, or null when it is (or is absent). */
function notPlainFile(st: fs.Stats | fs.BigIntStats | undefined, file: string): string | null {
  if (st === undefined) return null;
  if (st.isSymbolicLink()) return `${file} is a link`;
  if (!st.isFile()) return `${file} is not a file`;
  if (Number(st.nlink) > 1) return `${file} is also another file's name (a hard link)`;
  return null;
}

/** The record on the drive, as read: its entries and any other fields, verbatim — or why it cannot be read whole. */
type DriveRecord = { fields: Record<string, unknown>; entries: unknown[] } | { unreadable: string };

/**
 * The largest record on a drive this reads whole (final review F2.4): 32 MiB, or twice what this
 * destination's own entries come to as the record writes them, whichever is more. The record grows with
 * every file offloaded there, and TreeMap's own record keeps every file still offloaded (F1.9): past a
 * fixed 32 MiB — some 50,000 files — every offload set TreeMap's own record aside as one it could not
 * read, a new copy of it left on the drive each time. Twice this machine's own entries is the scale it
 * already holds them at; a record larger still — another machine's, or one someone put there — is kept
 * as it is, beside a new one.
 */
function driveRecordLimit(allEntries: OffloadEntry[], destRoot: string): number {
  const own = serializeRecord({ fields: {}, entries: [] }, allEntries, destRoot) ?? '';
  return Math.max(destRecordFloor, 2 * Buffer.byteLength(own, 'utf8'));
}

/** Reads the open record whole when it is no larger than `limit`, or says why not. Never throws. */
async function readDriveRecord(handle: fsp.FileHandle, size: number, limit: number): Promise<DriveRecord> {
  if (size > limit) return { unreadable: `it is larger than ${formatBytes(limit)}` };
  let text: string;
  try {
    text = await handle.readFile('utf8');
  } catch (err) {
    return { unreadable: describeFsError(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { unreadable: 'it is not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    return { unreadable: 'it is not a list of entries' };
  }
  const { entries, ...fields } = parsed as { entries: unknown[] } & Record<string, unknown>;
  return { fields, entries };
}

/**
 * The record to write: the drive's entries as they stand, each of this destination's replaced by its
 * own newer self (the same id), and the rest of this destination's added — as JSON, or null when
 * JSON.stringify cannot write it back (nested past the depth it recurses through).
 */
function serializeRecord(record: { fields: Record<string, unknown>; entries: unknown[] }, allEntries: OffloadEntry[], destRoot: string): string | null {
  const mine = new Map(allEntries.filter((e) => e.destRoot === destRoot).map((e) => [e.id, e]));
  const merged = record.entries.map((e) => {
    const id = e !== null && typeof e === 'object' ? (e as { id?: unknown }).id : undefined;
    const newer = typeof id === 'string' ? mine.get(id) : undefined;
    if (newer === undefined) return e;
    mine.delete(newer.id);
    return newer;
  });
  merged.push(...mine.values());
  try {
    return JSON.stringify({ ...record.fields, entries: merged }, null, 2);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * Merge this destination's entries into the record on the drive itself, and answer a sentence when
 * there is something the person should hear, or null.
 *
 * The drive is a folder someone else may have prepared (a shared or second-hand drive), so the
 * write never reopens a name that already exists there (FG3): the new record goes to a temp made
 * exclusively under a random name (`EXCLUSIVE_NEW_FILE`), is flushed, and is renamed onto the
 * record's name — a rename replaces a link at the destination, it never writes through one. The
 * record's own name must be absent or a plain file of one name; anything else (a link, a second
 * name for another file, a FIFO) is refused and never read, since reading it would follow it.
 *
 * Nothing in TreeMap reads this record back — restores read the app-data manifest — so nothing in
 * it is followed, and nothing in it is dropped (FG3b): every entry already there is carried as it
 * stands, one of this destination's replaced only by its own newer self (the same id), with no look
 * at the disk per entry. An entry written while the drive was mounted under another name, or by
 * another machine, is kept. A record that cannot be read whole — too large (`driveRecordLimit`),
 * unreadable, not JSON, not a list of entries — is never replaced: it is renamed aside, under a new name beside the new
 * record, and the answer says so.
 */
async function writeDestManifest(destRoot: string, allEntries: OffloadEntry[]): Promise<string | null> {
  if (destManifestWriteForTests) await destManifestWriteForTests(destRoot);
  const file = path.join(destRoot, DEST_MANIFEST);
  const notWritten = (why: string): string => `The record on the destination was not written: ${why}, and TreeMap does not replace what it did not make.`;
  let tmpPath: string | null = null;
  /** Set once a record that could not be read whole has been renamed aside: its new name, and why. */
  let aside: { name: string; why: string } | null = null;
  const asideNote = (then: string): string | null => (aside === null ? null
    : `The record already on the destination could not be read whole (${aside.why}), so it was kept as it is, as ${aside.name}${then}`);
  try {
    const refused = notPlainFile(await fsp.lstat(file).catch(() => undefined), file);
    if (refused) return notWritten(refused);
    let record: DriveRecord = { fields: {}, entries: [] };
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(file, READ_NO_FOLLOW);
    } catch (err) {
      // Absent: the first record on this drive. Anything else (a link swapped in, no permission)
      // is a record that is there and could not be read, which is never replaced.
      if (!meansAbsent(err)) return notWritten(`${file} could not be opened (${describeFsError(err)})`);
    }
    if (handle) {
      try {
        const st = await handle.stat();
        const changed = notPlainFile(st, file);
        if (changed) return notWritten(changed);
        record = await readDriveRecord(handle, st.size, st.size > destRecordFloor ? driveRecordLimit(allEntries, destRoot) : destRecordFloor);
      } finally {
        await handle.close();
      }
    }
    const setAside = async (why: string): Promise<void> => {
      const name = `${DEST_MANIFEST.replace(/\.json$/, '')}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`;
      await fsp.rename(file, path.join(destRoot, name));
      aside = { name, why };
      record = { fields: {}, entries: [] };
    };
    if ('unreadable' in record) await setAside(record.unreadable);
    // Written out before anything is made on the drive (FG3c): a record JSON reads but cannot write
    // back — nested past what JSON.stringify recurses through — is set aside like one it cannot read,
    // rather than leaving the drive's record unwritten on every offload after.
    let text = serializeRecord(record as { fields: Record<string, unknown>; entries: unknown[] }, allEntries, destRoot);
    if (text === null) {
      await setAside('it is nested too deeply to write back');
      text = serializeRecord({ fields: {}, entries: [] }, allEntries, destRoot) as string;
    }
    tmpPath = path.join(destRoot, `.${DEST_MANIFEST}.${crypto.randomUUID()}.tmp`);
    const out = await fsp.open(tmpPath, EXCLUSIVE_NEW_FILE, 0o644);
    try {
      await out.writeFile(text, 'utf8');
      await out.sync();
    } finally {
      await out.close();
    }
    await fsp.rename(tmpPath, file);
    tmpPath = null;
    return asideNote(', beside a new one.');
  } catch (err) {
    // The app-data manifest is authoritative; the drive copy is best-effort — and a failure is
    // still said (FG3c), whether or not a record was set aside first.
    console.error('[treemap] destination manifest write failed:', err);
    return asideNote(`; a new one could not be written (${describeFsError(err)}).`)
      ?? `The record on the destination could not be written (${describeFsError(err)}); the copies are in place, and TreeMap's own record of them is kept.`;
  } finally {
    if (tmpPath) await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Why a restore will not write where an offload record says, as a sentence, or null (FG3). A record
 * is held to the shape TreeMap writes: its paths are text and absolute, its original place is one
 * `sanitizePath` accepts, never TreeMap's own spill folder nor anywhere in app-data, and its copy lies
 * inside the destination it was offloaded to.
 */
export function restoreRefusal(entry: OffloadEntry): string | null {
  const { originalPath, destPath, destRoot } = entry as { originalPath: unknown; destPath: unknown; destRoot: unknown };
  if (typeof originalPath !== 'string' || typeof destPath !== 'string' || typeof destRoot !== 'string'
    || !path.isAbsolute(originalPath) || !path.isAbsolute(destPath)) {
    return 'its record is not a record TreeMap wrote, so nothing was written';
  }
  try {
    if (sanitizePath(originalPath) !== originalPath) return 'its record is not a record TreeMap wrote, so nothing was written';
  } catch (err) {
    if (err instanceof PathRejectedError) return `${originalPath} is a system folder TreeMap never writes`;
    throw err;
  }
  if (isSpillPath(originalPath)) return `${originalPath} is in TreeMap's own spill folder, which TreeMap never writes`;
  if (isAppDataPath(originalPath)) return `${originalPath} is in TreeMap's own app-data folder, where no restore writes`;
  if (!liesInside(destRoot, destPath)) return 'its copy is outside the destination it was offloaded to';
  return null;
}

/* ---------------- planning (pure — tested) ---------------- */

export interface PlannedCopy {
  src: string;
  dest: string;
  size: number;
}

/** "report.pdf" → "report (offloaded 2).pdf" until the name is free. */
export function destNameFor(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} (offloaded ${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Expand selected nodes (files and folders) into a flat copy plan. Folder
 * selections keep their internal structure under a folder of the same name
 * at the destination. Pure over the scan tree — no filesystem access: a hard
 * link's second name is planned at the scan's 0, and sized by `prepareOffload`.
 *
 * `existingNames` are the entries already at `destDir`. Copies open with 'wx'
 * and never clobber, so a name that is already taken there would fail the whole
 * job with EEXIST — renaming around it (report.pdf → "report (offloaded 2).pdf")
 * is what lets a second offload to the same drive succeed. Matching is
 * case-insensitive because the destination is often FAT/exFAT or APFS.
 */
export function planOffload(nodes: FileNode[], destDir: string, existingNames: string[] = []): PlannedCopy[] {
  const plan: PlannedCopy[] = [];
  const takenTop = new Set<string>(existingNames.map((n) => n.toLowerCase()));
  for (const node of nodes) {
    const topName = destNameFor(node.name, takenTop);
    takenTop.add(topName.toLowerCase());
    if (node.type === 'file') {
      plan.push({ src: node.path, dest: path.join(destDir, topName), size: node.size });
      continue;
    }
    const walk = (dir: FileNode, destBase: string): void => {
      for (const child of dir.children ?? []) {
        if (child.virtual) continue; // archive contents aren't real files
        if (child.type === 'file') {
          // Every name, a hard link's second name too (hunt C07): the folder goes to the Trash whole, so a
          // name with no copy went with it — the copy, the record and Restore all lacked it. Such a name
          // is planned at the scan's 0 here and at the file's real size by `prepareOffload`.
          plan.push({ src: child.path, dest: path.join(destBase, child.name), size: child.size });
        } else {
          walk(child, path.join(destBase, child.name));
        }
      }
    };
    walk(node, path.join(destDir, topName));
  }
  return plan;
}

/* ---------------- jobs ---------------- */

const jobs = new Map<string, OffloadJob>();

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.finishedAt ?? job.startedAt) > JOB_TTL_MS) jobs.delete(id);
  }
}

export function getOffloadJob(jobId: string): OffloadJob | undefined {
  return jobs.get(jobId);
}

export function cancelOffloadJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.cancelled = true;
  return true;
}

export function cancelAllOffloadJobs(): void {
  for (const job of jobs.values()) if (job.status === 'running') job.cancelled = true;
}

/** Whether any offload is still running — cancelled ones roll back first (hunt C58: MCP shutdown waits for it). */
export function anyOffloadJobRunning(): boolean {
  for (const job of jobs.values()) if (job.status === 'running') return true;
  return false;
}

/* ---------------- copy + verify machinery ---------------- */

/**
 * Test-only: wrap the read-back verification so a mismatch can be forced
 * deterministically (tests/offloadDrop.test.ts proves the rollback promise
 * end-to-end). The suite's ForTests idiom — returns a restore function, and
 * production never sets it.
 */
let verifyHashForTests: ((destPath: string, realHash: string) => string) | null = null;
export function setOffloadVerifyForTests(fn: (destPath: string, realHash: string) => string): () => void {
  verifyHashForTests = fn;
  return () => { verifyHashForTests = null; };
}

/**
 * Bind a job to the shared copy/verify primitive (src/utils/copyVerify.ts),
 * which the Undo Vault uses too. Byte progress and cancellation are the only
 * job-shaped parts; the copy semantics themselves live in one place.
 */
function jobProgress(job: OffloadJob, countBytes: boolean): { onBytes?: (n: number) => void; isCancelled: () => boolean } {
  return {
    ...(countBytes ? { onBytes: (n: number) => { job.bytesDone += n; } } : {}),
    isCancelled: () => job.cancelled,
  };
}

/** mkdir -p for every distinct parent in the plan; returns dirs we created. */
async function ensureDirs(plan: PlannedCopy[]): Promise<string[]> {
  const created: string[] = [];
  const wanted = [...new Set(plan.map((p) => path.dirname(p.dest)))].sort((a, b) => a.length - b.length);
  for (const dir of wanted) {
    const made = await fsp.mkdir(dir, { recursive: true });
    if (made) created.push(made); // deepest new ancestor actually created
  }
  return created;
}

/**
 * Undo everything this job wrote at the destination. Answers what it could not remove, each with
 * why (FG3f #7): swallowed, a removal that failed let a stopped job say everything was rolled back.
 */
async function rollback(created: string[], createdDirs: string[], job: OffloadJob): Promise<{ at: string; why: string }[]> {
  job.phase = 'rolling-back';
  const left: { at: string; why: string }[] = [];
  for (const f of created.reverse()) {
    await fsp.rm(f, { force: true }).catch((err: unknown) => { left.push({ at: f, why: messageOf(err) }); });
  }
  for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
    await fsp.rm(d, { recursive: true, force: true }).catch((err: unknown) => { left.push({ at: d, why: messageOf(err) }); });
  }
  return left;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A stopped offload that could not remove everything it had copied, as a sentence (FG3f #7): what
 * stopped it, and the first thing left at the destination. The originals are never touched before
 * every copy verifies, so none was deleted.
 */
function offloadLeftBehindSentence(err: unknown, cancelled: boolean, left: { at: string; why: string }[]): string {
  const cause = err instanceof CopyLeftBehind ? err.cause : err;
  const what = cancelled || cause instanceof CopyCancelled ? 'The offload was cancelled' : `The offload stopped (${messageOf(cause)})`;
  const more = left.length > 1 ? ` and ${formatCount(left.length - 1)} more thing${left.length === 2 ? '' : 's'} it had copied` : '';
  return `${what}, but what it had already copied to ${left[0].at}${more} could not be removed (${left[0].why}). ` +
    `Remove ${left.length === 1 ? 'it' : 'them'} from the destination yourself; nothing was deleted from this computer.`;
}

/* ---------------- offload ---------------- */

/**
 * Test-only: read the destination's free space through a fake.
 *
 * The same ForTests idiom as `setOffloadVerifyForTests` above, and needed for
 * the same reason: no test can arrange for a real volume to have exactly
 * 20 MB free on macOS, Windows and Linux, and the sentence this drives is
 * about small numbers. Patching the module's export is not an option — tsx
 * compiles these modules to CommonJS with getter-only exports, so the
 * assignment silently does nothing and the test would quietly read the
 * runner's real disk instead.
 */
let diskUsageForTests: typeof diskUsage | null = null;
export function setOffloadDiskUsageForTests(fn: typeof diskUsage): () => void {
  diskUsageForTests = fn;
  return () => { diskUsageForTests = null; };
}

/**
 * Where `p` really is, as its names: realpath's answer (every link followed, the last name too, each
 * name as the volume stores it — so another case of a folder is that folder), or where it lives when
 * realpath cannot answer — a folder a copy will make (`canonicalDirOf`: the links in its parents
 * resolved). Compared exactly, never folded: on a volume that keeps case, `Photos` and `photos` are two
 * folders, and an offload from one to the other is no copy into itself.
 */
function placeNamesOf(p: string): string[] {
  const at = realPlaceNow(p) ?? path.normalize(canonicalDirOf(p));
  const { root } = path.parse(at);
  return [root, ...at.slice(root.length).split(path.sep).filter((name) => name.length > 0)];
}

/** Whether the names `inner` are `outer`'s, or lie beneath them. */
function namesWithin(outer: string[], inner: string[]): boolean {
  return outer.length <= inner.length && outer.every((name, i) => name === inner[i]);
}

/** The first link a selected node is or holds (archive contents aside), as the scan spells it; null when none. */
function firstLinkIn(node: FileNode): string | null {
  if (node.isSymlink === true) return node.path;
  for (const child of node.children ?? []) {
    if (child.virtual) continue;
    const link = firstLinkIn(child);
    if (link !== null) return link;
  }
  return null;
}

function destInsideSource(): AppError {
  return new AppError(400, 'DEST_INSIDE_SOURCE', 'The destination is inside a folder being offloaded');
}

/** Which end of an offload a device is asked about. */
export type OffloadEnd = 'source' | 'destination';

/** The device `p` really lives on (st_dev, every link followed), or null when it cannot be read. */
function realDeviceOf(p: string): Promise<bigint | null> {
  return fsp.stat(p, { bigint: true }).then((st) => st.dev, () => null);
}

/**
 * Test-only: answer the device each end lives on. Every folder a test can make is on the runner's one
 * drive, so a test that means an offload to ANOTHER drive says so here; the same-drive refusal itself
 * is driven against the real disk. The suite's ForTests idiom: returns the function that removes it.
 */
let deviceOfForTests: ((p: string, end: OffloadEnd) => Promise<bigint | null>) | null = null;
export function setOffloadDeviceForTests(fn: ((p: string, end: OffloadEnd) => Promise<bigint | null>) | null): () => void {
  deviceOfForTests = fn;
  return () => { deviceOfForTests = null; };
}

/**
 * Test-only: answer the APFS container each device draws its space from (review F1.5) — a test cannot
 * add a volume to the runner's container. The real answer is the mount table's (apfsContainers.ts).
 * Returns the function that removes it.
 */
let containersForTests: (() => Promise<ReadonlyMap<bigint, string>>) | null = null;
export function setOffloadContainersForTests(fn: (() => Promise<ReadonlyMap<bigint, string>>) | null): () => void {
  containersForTests = fn;
  return () => { containersForTests = null; };
}

/**
 * Refuses an offload into the drive the selection already lives on (fourth browser pass, E01). Every
 * copy would land on that drive and every original go to that drive's Trash, so it frees nothing: the
 * space is used twice until the Trash is emptied. Judged by the device each end really is on, so a
 * link or another spelling of a folder cannot disguise it — and on a Mac by the APFS container each
 * device is a volume of, because the volumes of one container are separate devices sharing one pool
 * of free space (review F1.5); the container is read only when the devices differ. A device that
 * cannot be read is not called the same: a source that cannot be read fails its own copy before
 * anything is trashed. Nor is a container that cannot be read: the devices then decide alone.
 */
async function assertAnotherDrive(topPaths: readonly string[], destDir: string): Promise<void> {
  const deviceOf = deviceOfForTests ?? realDeviceOf;
  const destDevice = await deviceOf(destDir, 'destination');
  if (destDevice === null) return;
  let containers: ReadonlyMap<bigint, string> | null = null;
  const sameSpace = async (device: bigint): Promise<boolean> => {
    if (device === destDevice) return true;
    containers ??= await (containersForTests ?? (() => liveApfsContainers()))();
    const container = containers.get(device);
    return container !== undefined && container === containers.get(destDevice);
  };
  for (const source of topPaths) {
    const sourceDevice = await deviceOf(source, 'source');
    if (sourceDevice === null || !(await sameSpace(sourceDevice))) continue;
    throw new AppError(
      400,
      'DEST_SAME_VOLUME',
      `"${path.basename(destDir) || destDir}" is on the same drive as "${path.basename(source) || source}". An offload copies each file ` +
        'and then moves the original to the Trash, so on the same drive it frees nothing — the copies take as much space again, ' +
        'and the originals keep theirs in the Trash. Pick a folder on another drive. Nothing was copied or deleted.',
    );
  }
}

/**
 * Refuses a destination this process may not write into (sixth browser pass H02): a sealed or
 * read-only volume, or a folder whose permissions do not let this user add to it. The dry run planned
 * such a destination and said "Copy, verify, then trash", and the real run failed at its first copy —
 * where AGENTS.md promises a dry run that succeeds means the real run would act. Asked of the folder
 * itself (write and search, which adding an entry needs), nothing written. Any other failure of the
 * ask refuses too, saying it could not be confirmed: refusing is the safe answer to "cannot tell".
 *
 * A read-only drive is said to be one before permission is blamed (seventh browser pass J54): macOS
 * answers the ask with EACCES, not EROFS, for a root-owned folder on a sealed read-only volume (an iOS
 * Simulator's), so a refusal for permission asks the mount table whether the drive is mounted
 * read-only. The table only words the refusal — the ask decides it — so a table that cannot be read,
 * or a wrong reading of one, never refuses a folder the ask allows.
 *
 * Not on Windows: a folder's write permission there is an ACL, which fs.access does not read — it
 * reports every folder writable, read-only drives' included — so the check would promise what it
 * cannot know. There the real run's first copy finds it, and the job rolls back with nothing trashed.
 */
async function assertDestWritable(destDir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fsp.access(destDir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const denied = code === 'EACCES' || code === 'EPERM';
    const readOnly = code === 'EROFS' || (denied && (await mountedReadOnly(destDir).catch(() => null)) === true);
    const why = readOnly
      ? 'it is on a drive that is read-only'
      : denied
        ? 'you do not have permission to add files to it'
        : `TreeMap could not confirm it may write there (${code ?? (err instanceof Error ? err.message : String(err))})`;
    throw new AppError(
      400,
      'DEST_NOT_WRITABLE',
      `"${path.basename(destDir) || destDir}" cannot be written to: ${why}. An offload copies every file into the destination ` +
        'before anything is moved to the Trash, so this one could copy nothing. Pick a folder you can write to. Nothing was copied or deleted.',
    );
  }
}

/** The exact manifest an offload would execute — what dryRun reports. */
export interface PreparedOffload {
  plan: PlannedCopy[];
  bytesTotal: number;
  /** What the scan listed of the selection: each selected folder, and every file it listed under one (final review F1.5). */
  listed: ListedSelection;
  /**
   * The selection's outermost items, each once, in the order given: what goes to the Trash once every
   * copy verifies (final review F1.8). An item inside another selected one is in its plan already.
   */
  topPaths: string[];
}

/**
 * `nodes` without any that lies inside another of them, or repeats one (final review F1.8): a folder
 * and a file inside it are one set of files. Planned both ways, the file was copied twice, counted
 * twice in the confirm and the free-space check, recorded twice, and its own trash step failed once the
 * folder's had taken it ("it is no longer there"). The paths are the scan's own spellings.
 */
function outermostNodes(nodes: FileNode[]): FileNode[] {
  const selected = new Set(nodes.map((n) => n.path));
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.path)) return false;
    seen.add(node.path);
    for (let dir = path.dirname(node.path); ; dir = path.dirname(dir)) {
      if (selected.has(dir)) return false;
      if (path.dirname(dir) === dir) return true; // reached the file system's root
    }
  });
}

/** The selected folders, and every file the scan listed under them (each one copied, a hard link's second name too). */
interface ListedSelection {
  folders: string[];
  files: Set<string>;
}

/** The selection as the scan listed it (`ListedSelection`). Archive contents are listings, not files on the disk. */
function listedSelection(nodes: FileNode[]): ListedSelection {
  const folders: string[] = [];
  const files = new Set<string>();
  const walk = (dir: FileNode): void => {
    for (const child of dir.children ?? []) {
      if (child.virtual) continue;
      if (child.type === 'file') files.add(child.path);
      else walk(child);
    }
  };
  for (const node of nodes) {
    if (node.type === 'file') continue;
    folders.push(node.path);
    walk(node);
  }
  return { folders, files };
}

/**
 * Each hard link's second name in the selection (hunt C07, C44): a file the scan counted under the first
 * of its names it met, giving this one size 0 and `hardlinkDuplicate`. Archive contents are listings.
 */
function hardLinkSecondNames(nodes: FileNode[]): Set<string> {
  const names = new Set<string>();
  const walk = (node: FileNode): void => {
    if (node.virtual) return;
    if (node.type === 'file') {
      if (node.hardlinkDuplicate === true) names.add(node.path);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  nodes.forEach(walk);
  return names;
}

/**
 * The plan with each hard link's second name at the size its file really is (hunt C44): a copy of it is
 * a whole file, and planned at the scan's 0 it read "0 B will be copied" while the free-space check and
 * the agent policy's byte cap let any size through. Looked at with lstat, never through a link (a
 * selection holding one is refused before this); a name that cannot be looked at keeps the scan's size,
 * and its copy then fails before anything is trashed.
 */
async function withRealSizes(plan: PlannedCopy[], secondNames: ReadonlySet<string>): Promise<PlannedCopy[]> {
  if (secondNames.size === 0) return plan;
  const sized: PlannedCopy[] = [];
  for (const copy of plan) {
    if (!secondNames.has(copy.src)) {
      sized.push(copy);
      continue;
    }
    const st = await fsp.lstat(copy.src).catch(() => null);
    sized.push(st !== null && st.isFile() ? { ...copy, size: st.size } : copy);
  }
  return sized;
}

/**
 * The first thing on the disk under `folder` that the scan did not list, or null when it listed
 * everything there (final review F1.5). An offload copies what the scan listed and then trashes the
 * selected folder whole, so anything else in it — a "Don't scan" match, a folder the scan could not
 * read, a drive it did not enter, a file made since — went to the Trash with no copy. A folder that
 * cannot be looked into is such a thing too: what it holds is unknown. OS junk (`JUNK_FILES`: .DS_Store
 * and the like, which the OS writes into any folder it shows) is not held against it. Links are not
 * followed: a link is one entry, which the scan lists as one.
 */
async function firstUnlisted(folder: string, files: ReadonlySet<string>): Promise<{ at: string; why: string } | null> {
  const pending = [folder];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { at: dir, why: `it could not be looked into (${describeFsError(err)})` };
    }
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(at);
      else if (!files.has(at) && !JUNK_FILES.has(entry.name.toLowerCase())) return { at, why: 'the scan did not list it' };
    }
  }
  return null;
}

/**
 * Resolve and validate an offload selection into its exact copy plan.
 * Read-only: stats the destination and lists its entries, but writes nothing.
 * Every check startOffload enforces happens here, so a dry run fails exactly
 * where a real run would.
 */
export async function prepareOffload(
  scan: ScanResult,
  paths: string[],
  destDir: string,
): Promise<PreparedOffload> {
  // Resolve every selected path in the scan (also rejects typos early). Each
  // selection materializes as a bounded subtree for the copy planner — the
  // same magnitude as the plan itself, never the whole scan.
  const store = storeOf(scan);
  const resolved: FileNode[] = [];
  for (const p of paths) {
    const id = store.findByPath(p);
    if (id === -1) throw new AppError(404, 'PATH_NOT_FOUND', `"${p}" is not in this scan`);
    if (store.flag(id, Flag.Virtual)) throw new AppError(403, 'VIRTUAL_PATH', 'Entries inside an archive can’t be offloaded — offload the archive itself');
    resolved.push(store.prune(id, { maxNodes: Number.MAX_SAFE_INTEGER }).root);
  }
  // Each selection once, by its outermost item (final review F1.8).
  const nodes = outermostNodes(resolved);
  const topPaths = nodes.map((n) => n.path);
  // A link is never copied through: opened, it was copied as whatever it names — from outside every
  // scanned root too, sized as the link's own few bytes for the free-space check and the byte cap — and
  // a link to a folder failed the whole job (the final review, F1.10). The scan lists a link as itself.
  for (const node of nodes) {
    const link = firstLinkIn(node);
    if (link !== null) {
      throw new AppError(
        400,
        'LINK_IN_SELECTION',
        `"${link}" is a link. An offload copies each file, verifies the copy and then trashes the original, and a link would be ` +
          'copied as whatever it names, from wherever that is. Leave the link out of the selection, or offload what it names instead.',
      );
    }
  }
  // A destination inside a selected folder (or vice versa) would eat itself: the copy is verified,
  // then the selection is trashed with the copy in it. Judged where each really is (`placeNamesOf`),
  // as the text alone let another case, a link or the Data volume's long spelling of a folder inside
  // the selection through — the dry run too (the final review, F1.9, F1.14).
  const destNames = placeNamesOf(destDir);
  const sourceNames = nodes.map((node) => placeNamesOf(node.path));
  nodes.forEach((node, i) => {
    if (node.path === destDir || isInside(node.path, destDir) || namesWithin(sourceNames[i], destNames)) {
      throw destInsideSource();
    }
    if (isInside(destDir, node.path) || namesWithin(destNames, sourceNames[i])) {
      throw new AppError(400, 'SOURCE_INSIDE_DEST', 'That selection already lives inside the destination');
    }
  });
  const destStat = await fsp.stat(destDir).catch(() => null);
  if (!destStat || !destStat.isDirectory()) {
    throw new AppError(400, 'DEST_NOT_A_FOLDER', 'The destination must be an existing folder');
  }
  // On the drive the selection is on, an offload frees nothing (E01) — asked before anything is
  // planned, so a dry run refuses it as surely as a real run.
  await assertAnotherDrive(topPaths, destDir);
  // Nor into a destination nothing can be copied into (H02), asked the same way. After the drive:
  // a folder on the same drive is refused for what the offload would cost, whoever may write there.
  await assertDestWritable(destDir);

  // What's already on the drive, so a repeat offload renames around it instead
  // of failing every copy with EEXIST.
  const existingNames = await fsp.readdir(destDir).catch(() => [] as string[]);
  const plan = await withRealSizes(planOffload(nodes, destDir, existingNames), hardLinkSecondNames(nodes));
  if (plan.length === 0) throw new AppError(400, 'NOTHING_TO_OFFLOAD', 'The selection contains no files');
  if (plan.length > MAX_FILES_PER_JOB) {
    throw new AppError(400, 'TOO_MANY_FILES', `That's ${formatCount(plan.length)} files — offload at most ${formatCount(MAX_FILES_PER_JOB)} at a time`);
  }
  // A selected folder is trashed whole once its copies verify, so it may hold nothing the scan did
  // not list: that would go to the Trash with no copy (final review F1.5). Asked here, so a dry run
  // refuses it too, before anything is written.
  const listed = listedSelection(nodes);
  for (const folder of listed.folders) {
    const unlisted = await firstUnlisted(folder, listed.files);
    if (unlisted !== null) {
      throw new AppError(409, 'OFFLOAD_NOT_FULLY_LISTED',
        `${path.basename(folder)} holds ${path.relative(folder, unlisted.at) || path.basename(folder)}, and ${unlisted.why} — ` +
        'a "Don\'t scan" pattern, a folder the scan could not read, a drive it did not enter, or something made since. ' +
        'Offloading the folder would move that to the Trash with no copy, so nothing was copied or deleted. ' +
        'Rescan it, or offload what is inside it instead.');
    }
  }
  // Nothing is ever copied into TreeMap's own spill folder (Phase 4 §S.5.3): not at `dest`,
  // which the route refuses, and not at any target the plan makes under it. A selected folder
  // named like the spill folder, sent into app-data, would become it; one named in a way only
  // the file system folds (ſ for s) would land in it (T17a's security review). Nor into app-data
  // (FG1): `dest` is refused there by the route, and a link inside `dest` that a planned name
  // reaches under a fold (ſtuff for stuff) is found here, where each target's folders are resolved.
  // About 33 µs a target (measured), so about a third of a second at the MAX_FILES_PER_JOB cap: paid
  // once, before anything is copied, which is where a refusal belongs.
  // And no copy lands in the selection: a planned name the volume folds onto a link in `dest` (ſtuff
  // for stuff) leads wherever that link does, the selection included (F1.9).
  const folderLands = new Map<string, boolean>(); // one realpath a destination folder, not one a file
  for (const copy of plan) {
    assertNotSpillPath(copy.dest);
    assertNotAppDataPath(copy.dest);
    const folder = path.dirname(copy.dest);
    let inSource = folderLands.get(folder);
    if (inSource === undefined) {
      const lands = placeNamesOf(folder);
      inSource = sourceNames.some((source) => namesWithin(source, lands));
      folderLands.set(folder, inSource);
    }
    if (inSource) throw destInsideSource();
  }
  const bytesTotal = plan.reduce((s, p) => s + p.size, 0);

  // `null`, never `{ free: 0 }`. Substituting zero here tells the user
  // "only 0.0 GB free" about a drive that may be empty — a specific, false
  // number about their own hardware, produced by a `catch`. `diskUsage` was
  // deliberately changed to reject rather than return zero for exactly this
  // reason (see its comment, and the two Windows CI failures behind it);
  // re-inventing the zero at the call site puts the bug straight back.
  // `forecast.ts` handles the same call the honest way and is the model.
  const readUsage = diskUsageForTests ?? diskUsage;
  const usage = await readUsage(destDir).catch(() => null);
  if (usage === null) {
    throw new AppError(
      400,
      'DEST_SPACE_UNKNOWN',
      "Could not read how much free space the destination has, so this offload was not started. The drive may be disconnected or busy — check it and try again.",
    );
  }
  if (usage.free < bytesTotal * FREE_SPACE_MARGIN) {
    // Both figures through the shared formatter. Dividing by 1073741824 and
    // printing one decimal turned every offload under about 50 MB into
    // "need 0.0 GB, only 0.0 GB free" — two zeroes about numbers that are not
    // zero, in the app whose whole promise is that its numbers are true.
    //
    // And the check refuses at bytesTotal × FREE_SPACE_MARGIN, not at
    // bytesTotal, so a drive holding slightly MORE than the plan is still
    // refused. Naming the raw total alone produced a sentence that contradicted
    // itself — "need 30.0 MB, only 30.3 MB free" — so the headroom is said out
    // loud rather than left for the user to disbelieve.
    throw new AppError(
      400,
      'DEST_FULL',
      `Not enough space at the destination — this needs ${formatBytes(bytesTotal)} plus a little room to spare, and only ${formatBytes(usage.free)} is free`,
    );
  }

  // B2, up front. `moveToTrash` guards the originals at the end of the job
  // anyway, but discovering the conflict there means the user waited through a
  // multi-gigabyte verified copy to be told a file was open. Asking now costs
  // one enumeration and lets them close the app before anything is written.
  // Copying a file that is open is safe in itself — only the delete is at risk.
  const openHandles = await checkOpenHandles(topPaths);
  if (openHandles.conflicts.length > 0) {
    throw new AppError(409, 'OPEN_HANDLE_CONFLICT', describeConflicts(openHandles.conflicts), {
      conflicts: openHandles.conflicts,
    });
  }

  return { plan, bytesTotal, listed, topPaths };
}

export async function startOffload(
  scan: ScanResult,
  paths: string[],
  destDir: string,
  /** A plan already produced by prepareOffload — skips re-planning (callers
   *  that ran policy checks on the plan's byte total pass it back in). */
  prepared?: PreparedOffload,
): Promise<OffloadJob> {
  pruneJobs();
  const { plan, bytesTotal, listed, topPaths } = prepared ?? (await prepareOffload(scan, paths, destDir));

  const job: OffloadJob = {
    jobId: crypto.randomUUID(),
    kind: 'offload',
    status: 'running',
    phase: 'checking',
    destRoot: destDir,
    fileCount: plan.length,
    filesDone: 0,
    bytesTotal,
    bytesDone: 0,
    currentPath: '',
    cancelled: false,
    startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);

  void runOffload(job, plan, topPaths, destDir, listed).catch((err: unknown) => {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });
  return job;
}

/**
 * Whether `src` is one of `tops` or lies inside one. Each planned file was named under its selected item
 * (`planOffload`), so this walks up the file's own folders: a look per level, never one per selected
 * item for each of up to MAX_FILES_PER_JOB files.
 */
function isUnder(src: string, tops: ReadonlySet<string>): boolean {
  if (tops.size === 0) return false;
  for (let at = src; ;) {
    if (tops.has(at)) return true;
    const up = path.dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/** How an original was right before its copy was made (hunt C06), compared again right before its trash step. */
interface SourceLook {
  size: bigint;
  mtimeNs: bigint;
  atimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  mode: number;
}

function sourceLookOf(st: fs.BigIntStats): SourceLook {
  return { size: st.size, mtimeNs: st.mtimeNs, atimeNs: st.atimeNs, ctimeNs: st.ctimeNs, ino: st.ino, mode: Number(st.mode) };
}

/** Milliseconds from a time in nanoseconds, as Node computes a plain stat's `…Ms`. */
function msOfNs(ns: bigint): number {
  return Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6;
}

/**
 * A file's dates and permissions, as an offload records them (hunt C45): the permission bits only where
 * the system has them — Windows has none, a mode there being only the read-only attribute.
 */
interface FileMeta {
  mode?: number;
  mtimeMs: number;
  atimeMs: number;
}

function fileMetaOf(look: SourceLook): FileMeta {
  return {
    ...(process.platform === 'win32' ? {} : { mode: look.mode & 0o777 }),
    mtimeMs: msOfNs(look.mtimeNs),
    atimeMs: msOfNs(look.atimeNs),
  };
}

/**
 * Test-only: a failure of giving a file its recorded dates or permissions (hunt C45), as a drive that
 * cannot hold them (exFAT, some network shares) answers. Error to fail it, null for the real call. The
 * suite's ForTests idiom: returns the function that removes it.
 */
let fileMetaFaultForTests: ((p: string, what: 'times' | 'mode') => Error | null) | null = null;
export function setOffloadFileMetaFaultForTests(fault: (p: string, what: 'times' | 'mode') => Error | null): () => void {
  fileMetaFaultForTests = fault;
  return () => { fileMetaFaultForTests = null; };
}

/**
 * Gives the file at `p` the dates and permissions in `meta` (hunt C45): an offload's copy its original's,
 * and a restored file the ones its record keeps. Never a reason to undo a copy whose bytes verified, and
 * never silent: answers what could not be set (a drive that cannot hold them), or null.
 */
async function applyFileMeta(p: string, meta: { mode?: unknown; mtimeMs?: unknown; atimeMs?: unknown }): Promise<string | null> {
  const missed: string[] = [];
  if (typeof meta.mode === 'number' && Number.isInteger(meta.mode) && process.platform !== 'win32') {
    try {
      const fault = fileMetaFaultForTests?.(p, 'mode') ?? null;
      if (fault) throw fault;
      await fsp.chmod(p, meta.mode & 0o777);
    } catch (err) {
      missed.push(`its permissions (${describeFsError(err)})`);
    }
  }
  if (typeof meta.mtimeMs === 'number' && Number.isFinite(meta.mtimeMs)) {
    const mtime = new Date(meta.mtimeMs);
    const atime = typeof meta.atimeMs === 'number' && Number.isFinite(meta.atimeMs) ? new Date(meta.atimeMs) : mtime;
    try {
      const fault = fileMetaFaultForTests?.(p, 'times') ?? null;
      if (fault) throw fault;
      await fsp.utimes(p, atime, mtime);
    } catch (err) {
      missed.push(`its dates (${describeFsError(err)})`);
    }
  }
  return missed.length === 0 ? null : `${p}: ${missed.join(' and ')}`;
}

/** A job's word on files whose dates or permissions could not be set, or null when there are none. */
function metaMissSentence(misses: readonly string[], where: 'copies' | 'restored'): string | null {
  if (misses.length === 0) return null;
  const n = misses.length;
  return where === 'copies'
    ? `The dates or permissions of ${formatCount(n)} cop${n === 1 ? 'y' : 'ies'} could not be set at the destination (${misses[0]}${n > 1 ? `, and ${formatCount(n - 1)} more` : ''}); ` +
      'each copy\'s contents verified, and TreeMap\'s record keeps the originals\' dates and permissions for Restore.'
    : `The dates or permissions of ${formatCount(n)} restored file${n === 1 ? '' : 's'} could not be set back (${misses[0]}${n > 1 ? `, and ${formatCount(n - 1)} more` : ''}); ` +
      'each file\'s contents verified.';
}

/** The codes of a selected item left in place by its look right before its trash step (hunt C06). */
const ORIGINAL_CHANGED = 'OFFLOAD_ORIGINAL_CHANGED';
const ORIGINAL_UNREADABLE = 'OFFLOAD_ORIGINAL_UNREADABLE';

/** Each selected item's planned files, by the item (`topPaths`): a file selected on its own is its own one. */
function plannedUnder(plan: readonly PlannedCopy[], topPaths: readonly string[]): Map<string, string[]> {
  const tops = new Set(topPaths);
  const under = new Map<string, string[]>();
  for (const { src } of plan) {
    for (let at = src; ;) {
      if (tops.has(at)) {
        const files = under.get(at) ?? [];
        files.push(src);
        under.set(at, files);
        break;
      }
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
  }
  return under;
}

/**
 * Why a selected item must not go to the Trash after all, asked at its own turn right before its trash
 * step (hunt C06), or null to go ahead. The copies are all made first and the originals trashed at the
 * end of the job — on a large offload, hours later — so a file edited in between (an app still saving,
 * or one that saves by writing a new file and renaming it over the old) went to the Trash while its
 * copy, the one Restore brings back, held the earlier version. Every planned file of the item is looked
 * at again (lstat, no bytes read) and compared with its look right before its copy was made: its size,
 * modified time and file id (a definite change), or its change time alone ("may have changed": a
 * rewrite with its size and modified time put back moves it, and so does a new permission or
 * attribute). A file of a folder that is gone is a change too; a file selected on its own that is gone
 * goes on to its trash step, whose own look says what became of it. As the Undo Vault's CAPSULE_CHANGED.
 */
async function changedSinceCopy(top: string, files: readonly string[], looks: ReadonlyMap<string, SourceLook>): Promise<{ reason: string; code: string } | null> {
  const nameOf = (src: string): string => (src === top ? 'it' : path.relative(top, src));
  let changeTimeOnly: string | null = null;
  for (const src of files) {
    const was = looks.get(src);
    if (was === undefined) continue;
    let now: fs.BigIntStats;
    try {
      now = await fsp.lstat(src, { bigint: true });
    } catch (err) {
      if (meansAbsent(err)) {
        if (src === top) return null;
        return { code: ORIGINAL_CHANGED, reason: `${nameOf(src)} was removed after its copy was made` };
      }
      return { code: ORIGINAL_UNREADABLE, reason: `${nameOf(src)} could not be looked at again right before its trash step (${describeFsError(err)})` };
    }
    if (!now.isFile() || now.size !== was.size || now.mtimeNs !== was.mtimeNs || now.ino !== was.ino) {
      return { code: ORIGINAL_CHANGED, reason: `${nameOf(src)} changed after its copy was made (the copy holds it as it was then)` };
    }
    if (changeTimeOnly === null && now.ctimeNs !== was.ctimeNs) changeTimeOnly = nameOf(src);
  }
  if (changeTimeOnly === null) return null;
  return {
    code: ORIGINAL_CHANGED,
    reason: `${changeTimeOnly} may have changed after its copy was made (its change time moved, as it does for a rewrite whose size ` +
      'and modified time were put back, and for a new permission or attribute)',
  };
}

async function runOffload(job: OffloadJob, plan: PlannedCopy[], topPaths: string[], destDir: string, listed: ListedSelection): Promise<void> {
  const createdFiles: string[] = [];
  let createdDirs: string[] = [];
  const results: { src: string; dest: string; size: number; hash: string; meta: FileMeta }[] = [];
  /** Each original as it was right before its copy was made (hunt C06). */
  const looks = new Map<string, SourceLook>();
  /** Copies whose dates or permissions could not be set (hunt C45). */
  const metaMisses: string[] = [];
  try {
    createdDirs = await ensureDirs(plan);
    for (const item of plan) {
      if (job.cancelled) throw new CopyCancelled();
      job.phase = 'copying';
      job.currentPath = item.src;
      const look = sourceLookOf(await fsp.lstat(item.src, { bigint: true }));
      looks.set(item.src, look);
      const hash = await copyWithHash(item.src, item.dest, jobProgress(job, true));
      createdFiles.push(item.dest);

      job.phase = 'verifying';
      job.currentPath = item.dest;
      const readBack = await hashFile(item.dest, jobProgress(job, false));
      const verify = verifyHashForTests ? verifyHashForTests(item.dest, readBack) : readBack;
      if (verify !== hash) {
        throw new Error(`Verification failed for ${path.basename(item.dest)} — the destination copy doesn't match. Nothing was deleted.`);
      }
      // The copy keeps its original's dates and permissions (hunt C45); one a drive cannot hold is said.
      // Readable by this user whatever they are — an original another account owns can be readable
      // here with no owner bits — so Restore can always read it back; the record keeps them exact.
      const meta = fileMetaOf(look);
      const missed = await applyFileMeta(item.dest, meta.mode === undefined ? meta : { ...meta, mode: meta.mode | 0o400 });
      if (missed !== null) metaMisses.push(missed);
      const st = await fsp.stat(item.dest);
      results.push({ src: item.src, dest: item.dest, size: st.size, hash, meta });
      job.filesDone++;
    }

    // Every copy verified — only now do the local originals go to the Trash.
    job.phase = 'trashing';
    job.currentPath = '';
    // Each selected folder is looked at once more (final review F1.5): what was made in it since the
    // plan was checked has no copy, and the folder goes to the Trash whole. Such a folder is left in
    // place, its verified copies standing and recorded, as for an original something holds open.
    const leftInPlace: { folder: string; at: string; why: string }[] = [];
    for (const folder of listed.folders) {
      const unlisted = await firstUnlisted(folder, listed.files);
      if (unlisted !== null) leftInPlace.push({ folder, ...unlisted });
    }
    const held = new Set(leftInPlace.map((l) => l.folder));
    const toTrash = topPaths.filter((p) => !held.has(p));
    let trashed: { deleted: string[]; failed: { path: string; reason: string; code?: string }[] } = { deleted: [], failed: [] };
    // And each item once more at its own turn, right before its trash step (hunt C06): one holding a file
    // that is not what was copied is left in place, its verified copies standing and recorded.
    const filesOf = plannedUnder(plan, topPaths);
    try {
      if (toTrash.length > 0) trashed = await moveToTrash(toTrash, { checkEach: (top) => changedSinceCopy(top, filesOf.get(top) ?? [], looks) });
    } catch (err) {
      // B2 refused: something got opened between the pre-flight and here.
      //
      // Rolling back would delete copies that were made and verified — an
      // expensive, surprising undo for a condition the user can fix by closing
      // an app. So this follows the path the failed-trash case below already
      // takes: the copies stand and are recorded, the originals stay, and the
      // job says exactly that. Rethrowing anything else keeps real failures
      // rolling back as before.
      if (!(err instanceof AppError) || err.code !== 'OPEN_HANDLE_CONFLICT') throw err;
      job.error = `Everything was copied and verified to ${destDir}, but the originals are still here: ${err.message}`;
    }
    const changed = trashed.failed.filter((f) => f.code === ORIGINAL_CHANGED || f.code === ORIGINAL_UNREADABLE);
    const failedToTrash = trashed.failed.filter((f) => !changed.includes(f));
    if (failedToTrash.length) {
      // Copies are safe at the destination; report the leftovers honestly.
      job.error = `Offloaded everything, but ${failedToTrash.length} original${failedToTrash.length === 1 ? '' : 's'} couldn't be moved to the Trash: ${failedToTrash[0].reason}`;
    }
    if (leftInPlace.length > 0) {
      const [first] = leftInPlace;
      const more = leftInPlace.length > 1 ? ` (and ${formatCount(leftInPlace.length - 1)} more folder${leftInPlace.length === 2 ? '' : 's'})` : '';
      const kept =
        `${path.basename(first.folder)} was left in place${more}: it now holds ${path.relative(first.folder, first.at) || path.basename(first.folder)}, ` +
        `which was not copied (${first.why === 'the scan did not list it' ? 'it was made after the offload was planned' : first.why}), ` +
        `so it was not moved to the Trash. Its verified copies stand at ${destDir}.`;
      job.error = job.error ? `${job.error} Also: ${kept}` : kept;
    }
    if (changed.length > 0) {
      const [first] = changed;
      const more = changed.length > 1 ? ` (and ${formatCount(changed.length - 1)} more item${changed.length === 2 ? '' : 's'})` : '';
      const kept = `${path.basename(first.path)} was left in place${more}: ${first.reason}, so it was not moved to the Trash. Its verified copies stand at ${destDir}.`;
      job.error = job.error ? `${job.error} Also: ${kept}` : kept;
    }
    const metaWord = metaMissSentence(metaMisses, 'copies');
    if (metaWord !== null) job.error = job.error ? `${job.error} Also: ${metaWord}` : metaWord;
    // Every selected item the Trash did not take — a folder left in place, an original found open, one
    // the Trash refused or did not answer about — is still here: its copies are recorded as such, so
    // the Offloaded tab never counts them as space freed (final review F3.2).
    const gone = new Set(trashed.deleted);
    const keptTops = new Set(topPaths.filter((p) => !gone.has(p)));

    // BOOKKEEPING, past the point of no return — and therefore never a reason
    // to roll back.
    //
    // Everything above has already happened: the copies are written and their
    // SHA-256 verified, and the originals are in the Trash. The outer `catch`
    // calls `rollback`, which deletes every copy this job created — so a
    // throw from here would delete the verified destination copies while the
    // only other copies sit in a Trash the user is about to empty, having
    // just been told the offload failed.
    //
    // It is not hypothetical. `loadManifest` reads a JSON file, and
    // `readJsonFile` now rethrows an undecidable errno rather than answering
    // "empty" — `EMFILE` in a process that opens thousands of files to scan a
    // disk, or `ENOSPC` on the app-data volume from `saveManifest`. This is
    // the same reasoning the OPEN_HANDLE_CONFLICT branch above already
    // applies, and it holds with more force here because the originals are
    // already gone.
    let onDrive: OffloadEntry[] | null = null;
    try {
      // Loaded, added to and saved with no other writer between (FG3g M3) — and only that (FG3g
      // review F1.2): the destination's own copy of the record is written after the manifest is let
      // go. Written inside, a drive that stopped answering held every other offload's record — saved
      // only after its originals are in the Trash — and every restore's, and the Offloaded tab.
      onDrive = await withOffloadManifest(async () => {
        const store = await loadManifest();
        const now = Date.now();
        for (const r of results) {
          store.entries.push({
            id: crypto.randomUUID(),
            name: path.basename(r.src),
            originalPath: r.src,
            destPath: r.dest,
            destRoot: destDir,
            size: r.size,
            hash: r.hash,
            offloadedAt: now,
            ...(isUnder(r.src, keptTops) ? { originalKept: true as const } : {}),
            ...r.meta,
          });
        }
        store.destinations[destDir] = { lastSeenAt: now };
        await saveManifest(store);
        return store.entries.filter((e) => e.destRoot === destDir);
      });
    } catch (err) {
      // The files are where they should be; only the record of them failed.
      // Say so precisely, because it is the record that Restore reads.
      //
      // APPENDED, never assigned: `job.error` may already say the originals
      // are still on disk (an OPEN_HANDLE_CONFLICT, or a trash that reported
      // failures). Overwriting it would replace a true warning with the false
      // claim that the originals were trashed, and lose the more important
      // half.
      const bookkeeping =
        `The offload record could not be saved (${err instanceof Error ? err.message : String(err)}). ` +
        `The files are copied and verified at ${destDir}; Restore may not list them until this is fixed.`;
      job.error = job.error ? `${job.error} Also: ${bookkeeping}` : bookkeeping;
    }
    if (onDrive !== null) {
      // This destination's entries as just saved, merged into the drive's own record — one write of
      // that record at a time (FG3g review F2.1). Best effort, and never a reason to roll back; a drive
      // that does not answer is left to finish on its own, the limit counting the wait for its turn.
      // Nothing here may throw: past the trash step a throw rolls back, deleting the verified copies.
      // Not counted with the calls the Undo Vault left waiting (final review F1.6): one write of a
      // drive's record at a time bounds what is left waiting here to one call per drive — a later one
      // only waits its turn — and counted, two offloads to a quiet drive stopped every capsule copy,
      // so every cart commit and Autopilot deletion on every volume, until the drive answered.
      const writing = withDestRecord(destDir, () => writeDestManifest(destDir, onDrive)).catch((err: unknown) =>
        `The record on the destination could not be written (${describeFsError(err)}); the copies are in place, and TreeMap's own record of them is kept.`);
      const unwritten = await withinStallLimit(writing, DEST_RECORD_STALL_MS, () =>
        `The record on the destination was not written: the drive did not answer for ${Math.round(DEST_RECORD_STALL_MS / 1000)} seconds, ` +
        'so TreeMap went on without it. The copies are in place, and TreeMap\'s own record of them is kept.', { counted: false });
      if (unwritten) job.error = job.error ? `${job.error} Also: ${unwritten}` : unwritten;
    }

    job.phase = 'done';
    job.status = 'complete';
    job.finishedAt = Date.now();
  } catch (err) {
    // What the copy itself could not remove (CopyLeftBehind), and what the rollback could not: a job
    // that leaves anything behind is an error naming it, never "cancelled — everything rolled back".
    const left = [
      ...(err instanceof CopyLeftBehind ? [{ at: err.dest, why: err.why }] : []),
      ...await rollback(createdFiles, createdDirs, job),
    ];
    const cancelled = err instanceof CopyCancelled || job.cancelled;
    job.status = cancelled && left.length === 0 ? 'cancelled' : 'error';
    if (job.status === 'error') job.error = left.length > 0 ? offloadLeftBehindSentence(err, cancelled, left) : messageOf(err);
    job.finishedAt = Date.now();
  }
}

/* ---------------- restore ---------------- */

export async function startRestore(ids: string[]): Promise<OffloadJob> {
  pruneJobs();
  const store = await loadManifest();
  const entries = ids
    .map((id) => store.entries.find((e) => e.id === id))
    .filter((e): e is OffloadEntry => !!e && !e.restoredAt);
  if (entries.length === 0) throw new AppError(404, 'NOTHING_TO_RESTORE', 'No matching offloaded files to restore');

  const job: OffloadJob = {
    jobId: crypto.randomUUID(),
    kind: 'restore',
    status: 'running',
    phase: 'checking',
    destRoot: entries[0].destRoot,
    fileCount: entries.length,
    filesDone: 0,
    bytesTotal: entries.reduce((s, e) => s + e.size, 0),
    bytesDone: 0,
    currentPath: '',
    cancelled: false,
    startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);

  void runRestore(job, entries).catch((err: unknown) => {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });
  return job;
}

/**
 * Removes a restore's temporary file after `cause` stopped it, answering the error to throw: `cause`
 * itself, or — when the file could not be removed — a CopyLeftBehind naming it (FG3g L5). The
 * removal's failure was swallowed, so a restore that left its temporary file beside the name said
 * only why it stopped, never what it left there.
 */
async function withoutPartial(partial: string, cause: unknown): Promise<unknown> {
  return fsp.rm(partial, { force: true }).then(
    () => cause,
    (err: unknown) => new CopyLeftBehind(partial, describeFsError(err), cause),
  );
}

/** Recorded as a restore under way (FG3g L4): the start-up sweep never removes its temporary files. */
function runRestore(job: OffloadJob, entries: OffloadEntry[]): Promise<void> {
  return whileRestoring(() => restoreEntries(job, entries));
}

async function restoreEntries(job: OffloadJob, entries: OffloadEntry[]): Promise<void> {
  const failures: string[] = [];
  /** Restores that stopped and could not remove what they had begun writing (FG3f #7). */
  const leftBehind: string[] = [];
  /**
   * What this restore put back, by entry id, and when: recorded on a fresh read of the manifest at
   * the end (FG3g M3), never on the document as it stood when the restore began.
   */
  const putBack = new Map<string, number>();
  /** Restored files whose recorded dates or permissions could not be set back (hunt C45). */
  const metaMisses: string[] = [];
  /** Whether the Cancel stopped anything (hunt C49): a file left untried, or a copy it cut short. */
  let stopped = false;
  for (const entry of entries) {
    if (job.cancelled) {
      stopped = true;
      break;
    }
    try {
      // The record says where to write; it is held to the shape TreeMap writes first (FG3).
      const refused = restoreRefusal(entry);
      if (refused) throw new Error(refused);
      job.phase = 'copying';
      job.currentPath = entry.destPath;
      const existing = await fsp.stat(entry.originalPath).catch(() => null);
      if (existing) throw new Error(`something already exists at ${entry.originalPath}`);
      const source = await fsp.stat(entry.destPath).catch(() => null);
      if (!source) throw new Error('the offloaded copy is missing — is the drive connected?');

      await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true });
      // Written beside its name and put there only once it verifies (FG3f #8): a quit or a kill
      // part-way leaves no part-copied file at the person's own name.
      const partial = partialNameFor(entry.originalPath);
      const hash = await copyWithHash(entry.destPath, partial, jobProgress(job, true), { onCreated: (made) => recordRestorePartial(partial, made) });

      job.phase = 'verifying';
      if (hash !== entry.hash) {
        // Don't leave a damaged copy — and one that could not be removed is named, never forgotten.
        throw await withoutPartial(partial, new Error('verification failed — the offloaded copy no longer matches its recorded fingerprint'));
      }
      // The original's dates and permissions, from the record (hunt C45): set on the verified file before
      // it is put in place, so it arrives with them. Never a reason to fail a restore whose bytes verified.
      const missed = await applyFileMeta(partial, entry);
      if (missed !== null) metaMisses.push(missed.replace(partial, entry.originalPath));
      const placed = await placeWithoutClobber(partial, entry.originalPath, restorePlacementHooks(entry.originalPath)).catch(async (err: NodeJS.ErrnoException) => {
        throw await withoutPartial(partial, err.code === 'EEXIST' ? new Error(`something appeared at ${entry.originalPath} while it was being restored`) : err);
      });
      if (placed.partialLeft !== null) {
        console.error(`[treemap] a restored file is in place, but its temporary name ${partial} could not be removed: ${placed.partialLeft}`);
      }
      putBack.set(entry.id, Date.now());
      job.filesDone++;
    } catch (err) {
      if (err instanceof CopyCancelled) stopped = true;
      (err instanceof CopyLeftBehind ? leftBehind : failures).push(`${entry.name}: ${messageOf(err)}`);
    }
  }
  if (putBack.size > 0) {
    await withOffloadManifest(async () => {
      const store = await loadManifest();
      for (const live of store.entries) {
        const at = putBack.get(live.id);
        if (at !== undefined) live.restoredAt = at;
      }
      await saveManifest(store);
    });
  }
  job.phase = 'done';
  job.finishedAt = Date.now();
  if (leftBehind.length > 0) {
    // Never "cancelled": a cancel that left a part-copied file is not one that left nothing.
    job.status = 'error';
    job.error = `${leftBehind.length} of ${entries.length} could not be restored, and what was begun could not be removed — ${leftBehind[0]}. Remove it before trying again; its offloaded copy is untouched.`;
  } else if (stopped) {
    // The Cancel stopped it before every file was tried (hunt C49): `filesDone` says how many were put
    // back, and they stay where they are — a restore never takes back what it put back. A Cancel that
    // came after every file was tried stopped nothing: the restore ends as what it did says.
    job.status = 'cancelled';
  } else if (failures.length) {
    job.status = 'error';
    job.error = `${failures.length} of ${entries.length} couldn't be restored — ${failures[0]}`;
  } else {
    job.status = 'complete';
    const metaWord = metaMissSentence(metaMisses, 'restored');
    if (metaWord !== null) job.error = metaWord;
  }
}

/* ---------------- index (Offloaded tab) ---------------- */

export interface OffloadIndex {
  destinations: {
    root: string;
    mounted: boolean;
    lastSeenAt: number;
    totalBytes: number;
    activeCount: number;
    restoredCount: number;
  }[];
  entries: OffloadEntry[];
}

/**
 * Test-only: a stand-in for the Offloaded tab's look at whether a destination is there (FG3g review
 * F2.6) — a promise of the answer, one that does not settle for a drive that stopped answering — or
 * null for the real look. The suite's ForTests idiom: returns the function that removes it.
 */
let destinationLookForTests: ((root: string) => Promise<boolean> | null) | null = null;
export function setDestinationLookForTests(look: (root: string) => Promise<boolean> | null): () => void {
  destinationLookForTests = look;
  return () => { destinationLookForTests = null; };
}

/** How long the Offloaded tab waits for a destination to answer before showing it as not connected (FG3g review F2.6). */
const DESTINATION_LOOK_STALL_MS = 10_000;

/**
 * Each destination's answer while its look is still out, by root (FG3g review F3.3): a view meanwhile
 * shares it — not connected, once the limit passed — and starts no other look at that drive.
 */
const destinationLooksOut = new Map<string, Promise<boolean>>();

/**
 * Whether a destination's folder is there now. A look at another drive, so it is bounded: one that
 * does not answer within the limit is shown as not connected, its look left to return on its own.
 * One look per drive at a time, and not counted with the calls the Undo Vault left waiting (FG3g
 * review F3.3): each view of the tab started a fresh look, each one left waiting counted there, and
 * two quiet drives — or one viewed twice — stopped every cart commit and Autopilot deletion with a
 * sentence that blamed the volume being deleted from, while the looks held worker threads unbounded.
 */
function destinationMounted(root: string): Promise<boolean> {
  const out = destinationLooksOut.get(root);
  if (out !== undefined) return out;
  const look = destinationLookForTests?.(root) ?? fsp.stat(root).then(() => true, () => false);
  const answer = withinStallLimit(look, DESTINATION_LOOK_STALL_MS, () => false, { counted: false });
  destinationLooksOut.set(root, answer);
  const returned = (): void => {
    if (destinationLooksOut.get(root) === answer) destinationLooksOut.delete(root);
  };
  look.then(returned, returned);
  return answer;
}

export async function getOffloadIndex(): Promise<OffloadIndex> {
  // Read, and each destination looked at, with no lock held (FG3g review F2.6): a read alone needs
  // none, and the look — at another drive, perhaps one that stopped answering — ran inside the lock as
  // a synchronous stat, holding the event loop and every offload's record save and restore's with it.
  const store = await loadManifest();
  const roots = new Map<string, { totalBytes: number; activeCount: number; restoredCount: number }>();
  for (const e of store.entries) {
    const agg = roots.get(e.destRoot) ?? { totalBytes: 0, activeCount: 0, restoredCount: 0 };
    if (e.restoredAt) {
      agg.restoredCount++;
    } else {
      agg.activeCount++;
      agg.totalBytes += e.size;
    }
    roots.set(e.destRoot, agg);
  }
  const looked = await Promise.all([...roots.entries()].map(async ([root, agg]) => ({ root, agg, mounted: await destinationMounted(root) })));
  const seenAt = Date.now();
  const seen = looked.filter((d) => d.mounted).map((d) => d.root);
  if (seen.length > 0) {
    // "Last seen" is a write, so it is one read-modify-write of the manifest (FG3g M3), on a fresh
    // read: whatever was saved since the read above is kept.
    await withOffloadManifest(async () => {
      const fresh = await loadManifest();
      for (const root of seen) fresh.destinations[root] = { lastSeenAt: seenAt };
      await saveManifest(fresh);
    });
  }
  const destinations = looked.map(({ root, agg, mounted }) => ({
    root,
    mounted,
    lastSeenAt: mounted ? seenAt : store.destinations[root]?.lastSeenAt ?? 0,
    ...agg,
  })).sort((a, b) => b.totalBytes - a.totalBytes);
  return { destinations, entries: [...store.entries].sort((a, b) => b.offloadedAt - a.offloadedAt) };
}

/** Manifest lookup for the reveal endpoint (only manifest paths may open). */
export async function getOffloadEntry(id: string): Promise<OffloadEntry | undefined> {
  const store = await loadManifest();
  return store.entries.find((e) => e.id === id);
}

/**
 * The record of each of `ids`, in order (undefined where there is none), from one read of the manifest
 * (final review F2.2): a restore request of up to 500 ids looked each one up with a read of the whole
 * manifest — seconds of reads before anything began, once the record held tens of thousands of entries.
 */
export async function getOffloadEntries(ids: readonly string[]): Promise<(OffloadEntry | undefined)[]> {
  const byId = new Map<string, OffloadEntry>();
  for (const e of (await loadManifest()).entries) if (!byId.has(e.id)) byId.set(e.id, e);
  return ids.map((id) => byId.get(id));
}
