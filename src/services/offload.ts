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

/**
 * Offload — the third option next to "keep" and "trash" (Phase 7).
 *
 * Files are COPIED to the destination, every copy is READ BACK and its
 * SHA-256 compared against the hash streamed during the copy, and only when
 * every item verifies do the local originals go to the system Trash — never
 * a bare move. Any failure (destination full, verify mismatch, cancel)
 * rolls back everything this job wrote and leaves local data untouched.
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

/** Trim to the cap: restored entries age out first, then the oldest. */
export function trimManifest(entries: OffloadEntry[], cap: number): OffloadEntry[] {
  if (entries.length <= cap) return entries;
  const keep = [...entries].sort((a, b) => {
    const aRestored = a.restoredAt ? 1 : 0;
    const bRestored = b.restoredAt ? 1 : 0;
    if (aRestored !== bRestored) return aRestored - bRestored; // active first
    return b.offloadedAt - a.offloadedAt; // then newest first
  });
  return keep.slice(0, cap);
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

/** The largest record on a drive this reads whole; a larger one is kept as it is, beside a new one. */
const MAX_DEST_MANIFEST_BYTES = 32 * 1024 * 1024;

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

/** Reads the open record whole, or says why not. Never throws. */
async function readDriveRecord(handle: fsp.FileHandle, size: number): Promise<DriveRecord> {
  if (size > MAX_DEST_MANIFEST_BYTES) return { unreadable: `it is larger than ${formatBytes(MAX_DEST_MANIFEST_BYTES)}` };
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
 * another machine, is kept. A record that cannot be read whole — too large, unreadable, not JSON,
 * not a list of entries — is never replaced: it is renamed aside, under a new name beside the new
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
        record = await readDriveRecord(handle, st.size);
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
 * at the destination. Pure over the scan tree — no filesystem access.
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
          if (!child.hardlinkDuplicate || child.size > 0) {
            plan.push({ src: child.path, dest: path.join(destBase, child.name), size: child.size });
          }
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
 * which Time Capsule uses too. Byte progress and cancellation are the only
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

/** The exact manifest an offload would execute — what dryRun reports. */
export interface PreparedOffload {
  plan: PlannedCopy[];
  bytesTotal: number;
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
  const nodes: FileNode[] = [];
  for (const p of paths) {
    const id = store.findByPath(p);
    if (id === -1) throw new AppError(404, 'PATH_NOT_FOUND', `"${p}" is not in this scan`);
    if (store.flag(id, Flag.Virtual)) throw new AppError(403, 'VIRTUAL_PATH', 'Entries inside an archive can’t be offloaded — offload the archive itself');
    nodes.push(store.prune(id, { maxNodes: Number.MAX_SAFE_INTEGER }).root);
  }
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

  // What's already on the drive, so a repeat offload renames around it instead
  // of failing every copy with EEXIST.
  const existingNames = await fsp.readdir(destDir).catch(() => [] as string[]);
  const plan = planOffload(nodes, destDir, existingNames);
  if (plan.length === 0) throw new AppError(400, 'NOTHING_TO_OFFLOAD', 'The selection contains no files');
  if (plan.length > MAX_FILES_PER_JOB) {
    throw new AppError(400, 'TOO_MANY_FILES', `That's ${formatCount(plan.length)} files — offload at most ${formatCount(MAX_FILES_PER_JOB)} at a time`);
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
  const openHandles = await checkOpenHandles(paths);
  if (openHandles.conflicts.length > 0) {
    throw new AppError(409, 'OPEN_HANDLE_CONFLICT', describeConflicts(openHandles.conflicts), {
      conflicts: openHandles.conflicts,
    });
  }

  return { plan, bytesTotal };
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
  const { plan, bytesTotal } = prepared ?? (await prepareOffload(scan, paths, destDir));

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

  void runOffload(job, plan, paths, destDir).catch((err: unknown) => {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });
  return job;
}

async function runOffload(job: OffloadJob, plan: PlannedCopy[], topPaths: string[], destDir: string): Promise<void> {
  const createdFiles: string[] = [];
  let createdDirs: string[] = [];
  const results: { src: string; dest: string; size: number; hash: string }[] = [];
  try {
    createdDirs = await ensureDirs(plan);
    for (const item of plan) {
      if (job.cancelled) throw new CopyCancelled();
      job.phase = 'copying';
      job.currentPath = item.src;
      const hash = await copyWithHash(item.src, item.dest, jobProgress(job, true));
      createdFiles.push(item.dest);

      job.phase = 'verifying';
      job.currentPath = item.dest;
      const readBack = await hashFile(item.dest, jobProgress(job, false));
      const verify = verifyHashForTests ? verifyHashForTests(item.dest, readBack) : readBack;
      if (verify !== hash) {
        throw new Error(`Verification failed for ${path.basename(item.dest)} — the destination copy doesn't match. Nothing was deleted.`);
      }
      const st = await fsp.stat(item.dest);
      results.push({ src: item.src, dest: item.dest, size: st.size, hash });
      job.filesDone++;
    }

    // Every copy verified — only now do the local originals go to the Trash.
    job.phase = 'trashing';
    job.currentPath = '';
    let trashed = { deleted: [] as string[], failed: [] as { path: string; reason: string }[] };
    try {
      trashed = await moveToTrash(topPaths);
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
    if (trashed.failed.length) {
      // Copies are safe at the destination; report the leftovers honestly.
      job.error = `Offloaded everything, but ${trashed.failed.length} original${trashed.failed.length === 1 ? '' : 's'} couldn't be moved to the Trash: ${trashed.failed[0].reason}`;
    }

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
      const writing = withDestRecord(destDir, () => writeDestManifest(destDir, onDrive)).catch((err: unknown) =>
        `The record on the destination could not be written (${describeFsError(err)}); the copies are in place, and TreeMap's own record of them is kept.`);
      const unwritten = await withinStallLimit(writing, DEST_RECORD_STALL_MS, () =>
        `The record on the destination was not written: the drive did not answer for ${Math.round(DEST_RECORD_STALL_MS / 1000)} seconds, ` +
        'so TreeMap went on without it. The copies are in place, and TreeMap\'s own record of them is kept.');
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
  for (const entry of entries) {
    if (job.cancelled) break;
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
      const placed = await placeWithoutClobber(partial, entry.originalPath, restorePlacementHooks(entry.originalPath)).catch(async (err: NodeJS.ErrnoException) => {
        throw await withoutPartial(partial, err.code === 'EEXIST' ? new Error(`something appeared at ${entry.originalPath} while it was being restored`) : err);
      });
      if (placed.partialLeft !== null) {
        console.error(`[treemap] a restored file is in place, but its temporary name ${partial} could not be removed: ${placed.partialLeft}`);
      }
      putBack.set(entry.id, Date.now());
      job.filesDone++;
    } catch (err) {
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
  } else if (job.cancelled) {
    job.status = 'cancelled';
  } else if (failures.length) {
    job.status = 'error';
    job.error = `${failures.length} of ${entries.length} couldn't be restored — ${failures[0]}`;
  } else {
    job.status = 'complete';
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
 * One look per drive at a time, and not counted with the calls the Time Capsule left waiting (FG3g
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
