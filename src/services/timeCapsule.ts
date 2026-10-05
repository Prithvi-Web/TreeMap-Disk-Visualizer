import { promises as fsp, type Stats } from 'fs';
import { formatCount } from '../utils/formatCount';
import path from 'path';
import crypto from 'crypto';
import {
  TimeCapsuleEntry,
  TimeCapsuleEvent,
  TimeCapsuleIndex,
  TimeCapsuleJob,
  TimeCapsuleStatus,
} from '../models/types';
import { appDataDir, readJsonFile, readJsonFileChecked, writeJsonFile } from './storage';
import { isEphemeral } from './portableMode';
import { moveToTrash } from './cleaner';
import { getSettings } from './settings';
import { diskUsage } from './diskUsage';
import { copyWithHash, hashFile, CopyCancelled, CopyLeftBehind, partialNameFor, placeWithoutClobber } from '../utils/copyVerify';
import { formatBytes } from '../utils/formatBytes';
import { AppError } from '../middleware/errorHandler';
import { describeFsError, meansAbsent } from '../utils/errno';
import { assertNotSpillPath } from '../middleware/pathGuard';
import { isSpillPath, PathRejectedError, sanitizePath } from '../utils/pathSanitizer';
import { ABSENT, afterReportedFailure, identityOf, UNKNOWN, type Identity } from '../utils/placeIdentity';
import { collapseBatch, deepestFirst, shallowestFirst } from './capsuleBatch';
import { restoreNameKeyFor } from '../utils/volumeNames';
import { AsyncMutex } from '../utils/asyncMutex';

/**
 * Time Capsule — recovery beyond the OS Trash (B3).
 *
 * The OS Trash is the app's safety net for everything a person deletes on
 * purpose. It is the wrong net for deletions a person did not watch happen:
 * Autopilot (B1) can run while nobody is looking, and emptying the Trash
 * afterwards — a routine, encouraged thing to do — destroys the only copy.
 *
 * So before any *automated* deletion, the item is copied into a capsule under
 * the app-data directory, every byte is read back and verified, and only then
 * does the original go to the Trash through the existing `Cleaner`. Emptying
 * the Trash then costs nothing: the capsule still has it.
 *
 * ── The rule that shapes everything here ──
 *
 * **Nothing is trashed that was not first protected.** Not "usually", not
 * "unless the capsule is full". If a copy cannot be made and verified, the
 * delete does not happen and the reason is recorded where the user will see it
 * (§B3: "warn rather than silently skipping protection"). A capsule that
 * quietly lets a delete through when it is full is worse than no capsule,
 * because the user believes they are covered.
 *
 * ── Capacity ──
 *
 * The capsule must never be the reason a disk fills up. Its ceiling is a
 * percentage of the volume's usable space, and it is enforced *before* each
 * copy, evicting the oldest protections to make room. An item bigger than the
 * whole cap is refused outright rather than being allowed to evict everything
 * else on its way to failing anyway.
 *
 * ── On-disk shape ──
 *
 *   <app-data>/timecapsule/<entry-id>/manifest.json   what was captured
 *   <app-data>/timecapsule/<entry-id>/data/<name>     the payload itself
 *   <app-data>/timecapsule.json                       the index
 *
 * The payload is written before the index records it, never the other way
 * round: a crash mid-capture leaves bytes with no index entry, which
 * `reconcileCapsule()` cleans up at startup. The reverse order would leave an
 * index promising a restore it cannot perform — a lie that survives restarts.
 */

const INDEX_FILE = 'timecapsule.json';
const CAPSULE_DIR = 'timecapsule';
const SCHEMA_VERSION = 1;

/** Bound on the visible history of evictions, expiries and refusals. */
const MAX_EVENTS = 200;
/** A single capture beyond this many files is refused rather than crawled. */
const MAX_FILES_PER_ENTRY = 50_000;
/** Cap used when the volume's free space cannot be read at all. */
const FALLBACK_CAP_BYTES = 1024 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60_000;
/**
 * How long one file's copy into the capsule may go without reading a byte before it is stopped
 * (FG3g M2). A capture holds the index from its load to its save, so a read that never answered — a
 * network volume gone quiet, a dying disk, a named pipe chosen for deletion — held every restore's
 * bookkeeping, every Forget, the expiry and every other run behind it for ever, and the Autopilot
 * policy that started it stayed "still running". Stopped, the copy fails like any other: its item is
 * not protected, so it is not deleted, and the capture goes on. A volume merely slow still answers
 * well within it.
 */
const CAPTURE_STALL_MS = 60_000;
/** How often expired entries are swept out. */
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

/* ---------------- on-disk index ---------------- */

interface CapsuleStore {
  version: number;
  entries: TimeCapsuleEntry[];
  events: TimeCapsuleEvent[];
}

/** One member of a captured item, as recorded in the entry's own manifest. */
interface ManifestMember {
  /** Path relative to the captured item's root. '' for a single file. */
  rel: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  /** SHA-256 of the content, or of the link target for a symlink. */
  hash: string;
  /** Symlinks only: what the link pointed at. */
  target?: string;
  /** Symlinks only: whether what it pointed at was a folder, when that could be seen (FG3f #9). */
  targetIsDir?: boolean;
  /**
   * Modification and access time, so a restore puts back the file that was
   * taken rather than a copy of it made today.
   *
   * Optional because manifests written before this existed do not carry it,
   * and a restore of one of those must still work — it simply leaves the
   * times as the restore wrote them, exactly as it always did.
   *
   * Not part of `digestOf`: the digest fingerprints *content*, and a file
   * whose timestamps could not be read is still the same file.
   */
  mtimeMs?: number;
  atimeMs?: number;
  /**
   * Permission bits (`mode & 0o777`) of a file or folder (FG3f #10): an executable script came back
   * not executable, a read-only file writable. Optional for the same reason as the times; not part
   * of `digestOf`.
   */
  mode?: number;
  /**
   * Files only: the file's id on its volume (`ino`) and its change time (`ctimeMs`) when it was
   * copied (FG3g M1), so the look right before its trash step sees a file rewritten with its size
   * and modification time put back (rsync -t, cp -p, touch -r, a volume with coarse times): any
   * write moves the change time, and nothing can set it back; a file saved the way editors save is
   * another file, with another id. Optional — a copy recorded before is compared on size and
   * modification time, as it always was — and not part of `digestOf`. Where a volume keeps no change
   * time of its own (FAT, exFAT) it is whatever Node reports there.
   */
  ino?: number;
  ctimeMs?: number;
}

interface EntryManifest {
  originalPath: string;
  name: string;
  members: ManifestMember[];
  /**
   * A captured folder's OWN timestamps.
   *
   * Kept beside the member list rather than in it: the walk never emits a
   * member for the item's own root, and adding one would change `digestOf`'s
   * input for every new entry while saying nothing about content. Absent for a
   * single file, whose own times are its member's, and for manifests written
   * before timestamps were recorded.
   */
  rootMtimeMs?: number;
  rootAtimeMs?: number;
  /** The captured folder's own permission bits (FG3f #10). */
  rootMode?: number;
}

export function capsuleRoot(): string {
  return path.join(appDataDir(), CAPSULE_DIR);
}

/**
 * The Time Capsule copies real file bytes somewhere before deleting them, and a
 * portable session that saves nothing has nowhere of its own to put them — the
 * drive is read-only, or (FG4) its TreeMap-Data folder was refused. Keeping them
 * on the host would be both a trace and a surprise — someone's files left on a
 * machine they were only troubleshooting. So the capsule is off, and callers
 * say so rather than silently protecting nothing — in words true of either cause
 * (FG4 review #23).
 */
export function capsuleAvailable(): { available: boolean; reason?: string } {
  if (isEphemeral()) {
    return {
      available: false,
      reason:
        'This portable session saves nothing, so there is nowhere to keep a recoverable copy — and TreeMap will not leave your files on this computer. Deletions still go to the system Trash.',
    };
  }
  return { available: true };
}

/**
 * The shape of every id `capture` gives an entry (`crypto.randomUUID()`, since the capsule's first
 * version), and so of every folder name TreeMap makes in the capsule.
 */
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` is one TreeMap gives an entry: only such an id ever names a folder (FG3). */
function isEntryId(id: unknown): id is string {
  return typeof id === 'string' && ENTRY_ID.test(id);
}

/** Said of an index record TreeMap did not write, wherever one is refused. */
const NOT_OURS = 'That Time Capsule record is not one TreeMap made';

/**
 * The folder of an entry's copy. The id comes from the index, a file on disk, and `rm -rf` is run on
 * this path when an entry is forgotten, expires or is evicted — so an id that is not the shape TreeMap
 * gives one is refused here, never joined: `../../../victim` once removed a folder outside app-data
 * (FG3).
 */
function entryDir(id: string): string {
  if (!isEntryId(id)) {
    throw new AppError(409, 'CAPSULE_RECORD_INVALID', `${NOT_OURS} (its id is not one TreeMap gives), so nothing on disk is touched for it.`);
  }
  return path.join(capsuleRoot(), id);
}

function payloadRoot(id: string): string {
  return path.join(entryDir(id), 'data');
}

/**
 * Thrown when the index exists and cannot be parsed. Never a fallback.
 *
 * An `AppError` so the reason survives the trip to the client. The generic
 * handler replaces an unmapped `Error`'s message with "Internal server error",
 * which would hide the one sentence that tells the user which file to fix —
 * and this is a state only they can clear.
 */
export class CapsuleIndexUnreadableError extends AppError {
  constructor(readonly detail: string) {
    super(
      500,
      'CAPSULE_INDEX_UNREADABLE',
      `The Time Capsule index (${INDEX_FILE}, in TreeMap's app-data folder) could not be read (${detail}). ` +
        'TreeMap will not change the capsule until it is repaired, because every entry in it is the only ' +
        'record of a file it is holding. Do NOT delete or move it — the recovery folders beside it are ' +
        'named by entries in that file, and without it they cannot be matched to anything. A copy of the ' +
        'unreadable file is kept alongside it with a .corrupt suffix.',
    );
    this.name = 'CapsuleIndexUnreadableError';
  }
}

/**
 * The capsule index, or a refusal — never a silent empty store.
 *
 * This is the ONE place the distinction can be enforced, and it has to be
 * here rather than at each caller. An unparseable index falling back to
 * `{ entries: [] }` does not merely lose a listing: every one of the six
 * writers below then persists that empty store over the real file, and the
 * next `reconcileCapsule` reads a perfectly valid index listing nothing and
 * deletes every payload on disk as an orphan.
 *
 * That is not the same bug as the one `reconcileCapsule` already guards — it
 * is the same ENDING reached through `protectItems`, through the restore
 * completion path, through the capture rollback. Guarding the sweep alone
 * left three other doors open, which is what happens when a rule is applied
 * at call sites instead of at the thing they all share.
 *
 * An ABSENT index is a genuine first run and still returns an empty store.
 */
async function loadStore(): Promise<CapsuleStore> {
  return (await loadStoreWithProvenance()).store;
}

/**
 * The store, plus whether it came from a file that was actually there.
 *
 * `parsed: false` means the index is ABSENT — a first run — and only
 * `reconcileCapsule` needs to know, because absence is the one thing that
 * looks identical to "the user has never protected anything" and is not:
 * a capsule root full of payload folders says otherwise.
 */
async function loadStoreWithProvenance(): Promise<{ store: CapsuleStore; parsed: boolean }> {
  const loaded = await readJsonFileChecked<Partial<CapsuleStore>>(INDEX_FILE);
  if (!loaded.ok && loaded.reason === 'corrupt') throw new CapsuleIndexUnreadableError(loaded.detail);
  const raw: Partial<CapsuleStore> = loaded.ok ? loaded.value : {};
  return {
    parsed: loaded.ok,
    store: {
      version: typeof raw.version === 'number' ? raw.version : SCHEMA_VERSION,
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      events: Array.isArray(raw.events) ? raw.events : [],
    },
  };
}

/**
 * Every read-modify-write of the index, one at a time (FG3f #2): load, change, save, with nothing
 * else's save in between. A capture that loaded the index, copied for minutes and saved it erased
 * whatever had been recorded meanwhile — another run's copies (a cart commit overlapping an Autopilot
 * run), a restore's "put back", a "Forget", an expiry. Every `saveStore` call is inside one
 * (tests/capsuleConcurrency.test.ts reads this file to hold it so); a read alone needs none, since
 * a save replaces the file whole (tmp + rename). Never nested: see AsyncMutex.
 */
const indexLock = new AsyncMutex();

function withCapsuleStore<T>(fn: () => Promise<T>): Promise<T> {
  return indexLock.run(fn);
}

/** Test-only: how many read-modify-writes of the index are waiting for the one under way (FG3f). */
export function capsuleStoreWaitersForTests(): number {
  return indexLock.waiting;
}

/**
 * Test-only: awaited by `protectItems` right after it has loaded the index, before it copies
 * anything (FG3f), with the run's id: a test holds a capture there to show what overlaps it. The
 * suite's ForTests idiom: returns the function that removes it.
 */
let afterIndexLoadForTests: ((runId: string) => Promise<void>) | null = null;
export function setAfterIndexLoadForTests(hook: (runId: string) => Promise<void>): () => void {
  afterIndexLoadForTests = hook;
  return () => { afterIndexLoadForTests = null; };
}

async function saveStore(store: CapsuleStore): Promise<void> {
  store.version = SCHEMA_VERSION;
  if (store.events.length > MAX_EVENTS) store.events = store.events.slice(0, MAX_EVENTS);
  // writeJsonFile is atomic (tmp + rename) and serialized per file, which is
  // what §6 asks of capsule writes.
  await writeJsonFile(INDEX_FILE, store);
}

function recordEvent(store: CapsuleStore, event: TimeCapsuleEvent): void {
  store.events.unshift(event); // newest first
  if (store.events.length > MAX_EVENTS) store.events.length = MAX_EVENTS;
}

/* ---------------- capacity ---------------- */

export interface CapsuleCapacity {
  usedBytes: number;
  capBytes: number;
  freeBytes: number | null;
  maxPercent: number;
  /** Set when the cap had to be guessed rather than derived. */
  note?: string;
}

export function usedBytesOf(entries: TimeCapsuleEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.hasPayload && e.heldBytes > 0 ? e.heldBytes : 0), 0);
}

/**
 * The capsule's ceiling right now.
 *
 * The percentage is taken over *usable* space — free space plus whatever the
 * capsule is already holding — not over free space alone. Using free space
 * alone makes the cap shrink as the capsule fills, so the capsule would evict
 * itself into an ever-smaller corner and the setting would mean something
 * different at every moment. Over usable space, "10%" means the same thing
 * whether the capsule is empty or full.
 */
export function capFor(freeBytes: number | null, usedBytes: number, maxPercent: number): number {
  if (freeBytes === null) return FALLBACK_CAP_BYTES;
  const usable = Math.max(0, freeBytes) + Math.max(0, usedBytes);
  return Math.floor((usable * maxPercent) / 100);
}

/**
 * Test-only: the capsule's ceiling as a number rather than a share of this volume's live free space
 * (FG3f), so a test can make a batch the cap cannot hold whole, exactly, on any machine; null
 * measures again. The suite's ForTests idiom: returns the function that removes it.
 */
let capBytesForTests: number | null = null;
export function setCapsuleCapForTests(capBytes: number | null): () => void {
  capBytesForTests = capBytes;
  return () => { capBytesForTests = null; };
}

async function capacityOf(entries: TimeCapsuleEntry[], maxPercent: number): Promise<CapsuleCapacity> {
  const usedBytes = usedBytesOf(entries);
  if (capBytesForTests !== null) return { usedBytes, capBytes: capBytesForTests, freeBytes: null, maxPercent };
  let freeBytes: number | null = null;
  try {
    freeBytes = (await diskUsage(appDataDir())).free;
  } catch {
    freeBytes = null; // reported honestly below rather than assumed
  }
  return {
    usedBytes,
    capBytes: capFor(freeBytes, usedBytes, maxPercent),
    freeBytes,
    maxPercent,
    ...(freeBytes === null
      ? { note: `Free space on this volume couldn’t be read, so the capsule is limited to ${formatBytes(FALLBACK_CAP_BYTES)} to be safe.` }
      : {}),
  };
}

/**
 * Which entries must go for `incomingBytes` to fit, oldest capture first.
 *
 * Pure, and exported, because the interesting cases are all about ordering and
 * refusal rather than about files: an item larger than the entire cap must be
 * refused *without* evicting anything, or the capsule empties itself to make
 * room for something that was never going to fit.
 *
 * `pinned` entries count toward the cap and are never evicted (FG3f #1): the
 * copies of a run still under way. Its earlier items are in the Trash, or about
 * to be, and their copy is the only one — a batch bigger than the cap evicted
 * them for its later items and trashed them with no copy. An item that does not
 * fit beside what is pinned is refused, again without evicting anything.
 */
export function planEviction(
  entries: TimeCapsuleEntry[],
  capBytes: number,
  incomingBytes: number,
  pinned: (entry: TimeCapsuleEntry) => boolean = () => false,
): { evict: TimeCapsuleEntry[]; fits: boolean } {
  if (incomingBytes > capBytes) return { evict: [], fits: false };

  // Only entries whose removal frees something are worth sacrificing. A
  // zero-byte payload still has a payload, but evicting it buys nothing.
  const holding = entries.filter((e) => e.hasPayload && e.heldBytes > 0);
  let used = holding.reduce((sum, e) => sum + e.heldBytes, 0);
  if (used + incomingBytes <= capBytes) return { evict: [], fits: true };
  if (pinnedBytesOf(holding, pinned) + incomingBytes > capBytes) return { evict: [], fits: false };

  const byAge = holding.filter((e) => !pinned(e)).sort((a, b) => a.capturedAt - b.capturedAt); // oldest first
  const evict: TimeCapsuleEntry[] = [];
  for (const entry of byAge) {
    evict.push(entry);
    used -= entry.heldBytes;
    if (used + incomingBytes <= capBytes) break;
  }
  return { evict, fits: used + incomingBytes <= capBytes };
}

/** The bytes the pinned entries hold. */
function pinnedBytesOf(entries: TimeCapsuleEntry[], pinned: (entry: TimeCapsuleEntry) => boolean): number {
  return entries.reduce((sum, e) => sum + (e.hasPayload && e.heldBytes > 0 && pinned(e) ? e.heldBytes : 0), 0);
}

/**
 * Runs in this process whose copies are being made or whose trash step is under way, by run id
 * (FG3f #1), counted: a cart commit's chunks share one id. Their entries are pinned — never evicted
 * to make room — until the run's trash step is over, so a run never trashes an item whose copy it
 * or another run just evicted.
 */
const runsInFlight = new Map<string, number>();

async function whileInFlight<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  runsInFlight.set(runId, (runsInFlight.get(runId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (runsInFlight.get(runId) ?? 1) - 1;
    if (left > 0) runsInFlight.set(runId, left);
    else runsInFlight.delete(runId);
  }
}

/** Whether an entry belongs to a run still under way: never evicted. */
function ofRunInFlight(entry: TimeCapsuleEntry): boolean {
  return typeof entry.runId === 'string' && runsInFlight.has(entry.runId);
}

/**
 * The copies a restore job is reading, by entry id (FG3g H1): pinned from the moment the restore is
 * accepted until its job ends, however it ends. Only deletion runs were pinned, so a capture could
 * evict a copy a running restore had not reached yet — and "Forget" or the expiry sweep could remove
 * one — and the restore then stopped on a missing file, the copy it was putting back gone. A second
 * restore of a copy in here is refused, so one id is never held twice.
 */
const restoresInFlight = new Set<string>();

/**
 * Every removal of a copy a record still names (`dropPayload`, and a record dropped before its
 * folder is), and a restore's look at whether the copies it asks for are there before it pins them,
 * one at a time (FG3g H1): so a restore never accepts a copy whose removal is under way, and nothing
 * removes a copy a restore has accepted. Taken inside the index lock where both are held, never the
 * other way round; a restore is accepted under this lock alone, so it never waits for a capture's copying.
 */
const payloadLock = new AsyncMutex();

function withPayloadLock<T>(fn: () => Promise<T>): Promise<T> {
  return payloadLock.run(fn);
}

/** Test-only: how many removals of a copy, or restores being accepted, are waiting for the one under way (FG3g H1). */
export function capsulePayloadWaitersForTests(): number {
  return payloadLock.waiting;
}

/**
 * Test-only: awaited by a capture that must evict, with the ids it is about to evict, after planning
 * and before removing anything (FG3g H1): a test holds an eviction there to show what overlaps it.
 * The suite's ForTests idiom: returns the function that removes it.
 */
let beforeEvictionForTests: ((victims: string[]) => Promise<void>) | null = null;
export function setBeforeEvictionForTests(hook: (victims: string[]) => Promise<void>): () => void {
  beforeEvictionForTests = hook;
  return () => { beforeEvictionForTests = null; };
}

/** Whether an entry's copy is in use: by a deletion run under way, or by a restore. Never evicted. */
function inUse(entry: TimeCapsuleEntry): boolean {
  return ofRunInFlight(entry) || restoresInFlight.has(entry.id);
}

/** The refusal of a removal, or of a second restore, of a copy a restore is reading (FG3g H1). */
function restoreRunning(entry: TimeCapsuleEntry, what: string): AppError {
  return new AppError(409, 'RESTORE_RUNNING', `“${entry.name}” is being restored right now, so ${what}. Try again once that restore has finished.`);
}

/** The sentence for an item that does not fit: beside the copies still pinned, or at all. */
function doesNotFitSentence(bytes: number, capBytes: number, pinnedBytes: number, verb: 'was' | 'will be'): string {
  const beside = pinnedBytes > 0 && bytes <= capBytes
    ? `, and ${formatBytes(pinnedBytes)} of that holds copies in use — of items whose deletion is still under way, or being restored — which are never dropped to make room`
    : '';
  return `Protecting it needs ${formatBytes(bytes)}, but the Time Capsule can only hold ${formatBytes(capBytes)}${beside}. ` +
    `It ${verb} left alone rather than deleted without a backup.`;
}

/**
 * Delete an entry's payload and zero what it holds, answering the bytes that frees. The index record
 * stays. A record whose id TreeMap did not give has no folder of TreeMap's, so nothing on disk is
 * removed for it and nothing is freed; it is only zeroed.
 */
async function dropPayload(entry: TimeCapsuleEntry): Promise<number> {
  const freed = isEntryId(entry.id) ? entry.heldBytes : 0;
  if (isEntryId(entry.id)) await fsp.rm(entryDir(entry.id), { recursive: true, force: true });
  entry.heldBytes = 0;
  entry.hasPayload = false;
  return freed;
}

/* ---------------- capture ---------------- */

/** A file, directory or symlink to be copied, discovered under the item. */
interface WalkedMember {
  abs: string;
  rel: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  /** From the lstat the walk already performs; undefined when it could not. */
  mtimeMs?: number;
  atimeMs?: number;
  mode?: number;
  /** Files only, from the same lstat (FG3g M1). */
  ino?: number;
  ctimeMs?: number;
}

/**
 * Enumerate everything under `root` that has to be captured.
 *
 * Symlinks are recorded as links rather than followed. Following them would
 * copy the target's bytes into the capsule and — for a link pointing at a
 * parent — walk forever; recording the target reproduces the tree exactly on
 * restore, which matters because the folders this protects (node_modules,
 * virtualenvs) are full of them. Empty directories are recorded too, so a
 * restored tree has the same shape and not merely the same files.
 */
/**
 * Test-only: a failed look at one member of an item being walked (FG3d), as a volume having a bad
 * moment answers it. No test can make one file's look fail on every OS while its folder stays
 * readable. Answers the error that look fails with, or null to look at the disk. The suite's
 * ForTests idiom: returns the function that removes it.
 */
let memberLookFaultForTests: ((abs: string) => Error | null) | null = null;
export function setMemberLookFaultForTests(fault: (abs: string) => Error | null): () => void {
  memberLookFaultForTests = fault;
  return () => { memberLookFaultForTests = null; };
}

/**
 * A member's own lstat, during a walk: null when nothing is there (`meansAbsent`) — it went between
 * its folder's listing and this look, and there is nothing of it to protect. Any other failure says
 * nothing either way, and a copy without that member is not a copy of the item, so it fails the
 * walk: the item is not protected, and what is not protected is not deleted (FG3d). It was read as
 * gone: the member got no copy, its folder was still copied and trashed whole with it inside, and an
 * undo put the folder back without it and said everything was back.
 */
async function lstatMember(abs: string, rel: string): Promise<Stats | null> {
  try {
    const fault = memberLookFaultForTests?.(abs) ?? null;
    if (fault !== null) throw fault;
    return await fsp.lstat(abs);
  } catch (err) {
    if (meansAbsent(err)) return null;
    throw new AppError(409, 'CAPSULE_UNREADABLE',
      `TreeMap could not look at ${rel}, inside it (${describeFsError(err)}), so it cannot be protected whole, and what cannot be protected is not deleted.`);
  }
}

/**
 * A link member's target, during a walk: null when the link is gone (`meansAbsent`). Any other
 * failure fails the walk, as `lstatMember` does (FG3f #11): read as an empty target, a link that
 * could not be read was planned as protected, and the real copy then failed on it.
 */
async function readlinkMember(abs: string, rel: string): Promise<string | null> {
  try {
    const fault = memberLookFaultForTests?.(abs) ?? null;
    if (fault !== null) throw fault;
    return await fsp.readlink(abs);
  } catch (err) {
    if (meansAbsent(err)) return null;
    throw new AppError(409, 'CAPSULE_UNREADABLE',
      `TreeMap could not read the link ${rel}, inside it (${describeFsError(err)}), so it cannot be protected whole, and what cannot be protected is not deleted.`);
  }
}

async function walkItem(
  root: string,
  opts: { withDirTimes?: boolean } = {},
): Promise<{ members: WalkedMember[]; bytes: number; isFolder: boolean }> {
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink()) {
    const target = await fsp.readlink(root);
    return { members: [{ abs: root, rel: '', kind: 'symlink', size: Buffer.byteLength(target) }], bytes: 0, isFolder: false };
  }
  if (!stat.isDirectory()) {
    return {
      members: [{
        abs: root, rel: '', kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, atimeMs: stat.atimeMs, mode: stat.mode & 0o777,
        ino: stat.ino, ctimeMs: stat.ctimeMs,
      }],
      bytes: stat.size,
      isFolder: false,
    };
  }

  const members: WalkedMember[] = [];
  let bytes = 0;
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  while (queue.length) {
    const dir = queue.shift()!;
    if (dir.rel) members.push({ abs: dir.abs, rel: dir.rel, kind: 'dir', size: 0 });
    // The directory's own times, read once. A directory's mtime is the last
    // time its listing changed, which is a real fact about the folder and is
    // otherwise lost the moment a restore writes the first child into it.
    //
    // Only when a manifest is actually going to be written. It is one extra
    // lstat per directory — measured at 17 ms on a 3,001-directory tree, ~11%
    // of the walk — and the dry run has no use for the answer. That walk is
    // the one a person waits on with the confirmation dialog not yet open,
    // so it does not pay for something only the capture needs.
    if (opts.withDirTimes && dir.rel) {
      const dirStat = await fsp.lstat(dir.abs).catch(() => null);
      if (dirStat) {
        const entry = members[members.length - 1];
        entry.mtimeMs = dirStat.mtimeMs;
        entry.atimeMs = dirStat.atimeMs;
        entry.mode = dirStat.mode & 0o777;
      }
    }
    const dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(dir.abs, dirent.name);
      const rel = dir.rel ? path.join(dir.rel, dirent.name) : dirent.name;
      if (dirent.isSymbolicLink()) {
        const target = await readlinkMember(abs, rel);
        if (target === null) continue; // vanished mid-walk — nothing to protect
        members.push({ abs, rel, kind: 'symlink', size: Buffer.byteLength(target) });
      } else if (dirent.isDirectory()) {
        queue.push({ abs, rel });
      } else if (dirent.isFile()) {
        const st = await lstatMember(abs, rel);
        if (!st) continue; // vanished mid-walk — nothing to protect
        members.push({
          abs, rel, kind: 'file', size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs, mode: st.mode & 0o777, ino: st.ino, ctimeMs: st.ctimeMs,
        });
        bytes += st.size;
      }
      // Sockets, FIFOs and devices are deliberately skipped: they carry no
      // content to restore, and pretending otherwise would hang the copy.
      if (members.length > MAX_FILES_PER_ENTRY) {
        throw new AppError(413, 'CAPSULE_ITEM_TOO_COMPLEX',
          `That folder holds more than ${formatCount(MAX_FILES_PER_ENTRY)} items — too many to protect in one piece.`);
      }
    }
  }
  return { members, bytes, isFolder: true };
}

export interface ProtectionRequest {
  path: string;
  /** Why this was selected for deletion, in the rule's own words. */
  reason?: string;
  /** Where it is on the disk, when the batch could place it (`collapseBatch`): kept with its copy. */
  realPath?: string;
}

/** Where a restore writes an entry back to, and where an undo looks for it: where it was (FG3d #2, #3). */
function restorePlaceOf(entry: TimeCapsuleEntry): string {
  return entry.realPath ?? entry.originalPath;
}

export interface ProtectionOutcome {
  path: string;
  protected: boolean;
  entryId?: string;
  bytes: number;
  /** Stable code when protection was refused. */
  code?: string;
  /** User-facing explanation when protection was refused. */
  detail?: string;
}

/**
 * Copy one item into the capsule and verify every byte. Never trashes.
 *
 * `capBytes` is passed in rather than recomputed here because reading free
 * space shells out to `df`, and doing that once per item would put a
 * subprocess between every file of a hundred-item run. It is also the more
 * correct number: the cap is a share of *usable* space, and copying an item
 * into the capsule moves bytes from free into used without changing the sum,
 * so the ceiling genuinely is constant for the duration of a run.
 */
async function capture(
  store: CapsuleStore,
  request: ProtectionRequest,
  context: { runId: string; policyId?: string },
  capBytes: number,
  persist: () => Promise<void>,
): Promise<ProtectionOutcome> {
  const original = request.path;
  const name = path.basename(original);

  let walked: { members: WalkedMember[]; bytes: number; isFolder: boolean };
  try {
    walked = await walkItem(original, { withDirTimes: true });
  } catch (err) {
    const detail = err instanceof AppError ? err.message : `It could not be read (${err instanceof Error ? err.message : String(err)}).`;
    const code = err instanceof AppError ? err.code : 'CAPSULE_UNREADABLE';
    // An item that has already vanished needs no warning — there is nothing
    // left to protect and nothing was deleted. An item that is *there* but
    // unreadable (permissions, an I/O error) is a real refusal, and the user
    // should see it rather than wonder why that file never got cleaned up.
    const alreadyGone = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (!alreadyGone) {
      recordEvent(store, { at: Date.now(), kind: 'unprotected', name, originalPath: original, sizeBytes: 0, detail });
    }
    return { path: original, protected: false, bytes: 0, code, detail };
  }

  // Planned and made under the payload lock (FG3g H1), so the copies a restore has accepted are
  // pinned, and a restore never accepts one this eviction is removing.
  const room = await withPayloadLock(async () => {
    const plan = planEviction(store.entries, capBytes, walked.bytes, inUse);
    if (!plan.fits) return { fits: false, pinnedBytes: pinnedBytesOf(store.entries, inUse) };
    if (beforeEvictionForTests && plan.evict.length > 0) await beforeEvictionForTests(plan.evict.map((e) => e.id));
    // Make room first — the eviction is real and permanent, so it is recorded
    // where the user can see what it cost them.
    for (const victim of plan.evict) {
      await dropPayload(victim);
      recordEvent(store, {
        at: Date.now(),
        kind: 'evicted',
        name: victim.name,
        originalPath: victim.originalPath,
        sizeBytes: victim.sizeBytes,
        detail: `Removed from the Time Capsule to make room for ${name}. It can no longer be restored from here.`,
      });
    }
    // Saved at once (FG3g L1), not at the end of the capture: until then the index on disk offered
    // the evicted copies as restorable, and a restore or an undo of one was refused as unreadable.
    if (plan.evict.length > 0) await persist();
    return { fits: true, pinnedBytes: 0 };
  });
  if (!room.fits) {
    const detail = doesNotFitSentence(walked.bytes, capBytes, room.pinnedBytes, 'was');
    recordEvent(store, {
      at: Date.now(), kind: 'unprotected', name, originalPath: original, sizeBytes: walked.bytes, detail,
    });
    return { path: original, protected: false, bytes: walked.bytes, code: 'CAPSULE_FULL', detail };
  }

  const id = crypto.randomUUID();
  const dataRoot = payloadRoot(id);
  try {
    await fsp.mkdir(dataRoot, { recursive: true });
    // A folder's own directory is created up front so an item that contains
    // nothing at all still round-trips as a folder rather than vanishing.
    if (walked.isFolder) await fsp.mkdir(path.join(dataRoot, name), { recursive: true });
    const members: ManifestMember[] = [];

    for (const member of walked.members) {
      // '' means the item itself is a single file or link: it lands at
      // data/<name>, so the payload keeps its real name on disk.
      const destRel = member.rel === '' ? name : path.join(name, member.rel);
      const dest = path.join(dataRoot, destRel);

      if (member.kind === 'dir') {
        await fsp.mkdir(dest, { recursive: true });
        members.push({ rel: member.rel, kind: 'dir', size: 0, hash: '', ...timesOf(member), ...modeOf(member) });
        continue;
      }
      if (member.kind === 'symlink') {
        const target = await fsp.readlink(member.abs);
        // Whether it leads to a folder (FG3f #9), so a restore on Windows can make it as one. A link
        // that leads nowhere records nothing, and comes back as it was made before this was kept.
        const targetIsDir = await fsp.stat(member.abs).then((st) => st.isDirectory(), () => undefined);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.symlink(target, dest, linkTypeFor(target, targetIsDir));
        members.push({
          rel: member.rel,
          kind: 'symlink',
          size: Buffer.byteLength(target),
          hash: crypto.createHash('sha256').update(target).digest('hex'),
          target,
          ...(targetIsDir !== undefined ? { targetIsDir } : {}),
        });
        continue;
      }

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const hash = await copyWithHash(member.abs, dest, undefined, { stallMs: CAPTURE_STALL_MS });
      // Read back what actually landed. Hashing the source twice would agree
      // with itself even if the write was short or corrupted.
      const verify = await hashFile(dest);
      if (verify !== hash) {
        throw new Error(`the copy of ${member.rel || name} did not match what was read`);
      }
      members.push({ rel: member.rel, kind: 'file', size: member.size, hash, ...timesOf(member), ...modeOf(member), ...fileIdOf(member) });
    }

    // The captured folder's own times, read from the original before it goes.
    const rootTimes = walked.isFolder
      ? await fsp.lstat(original).then(
        (st) => ({ rootMtimeMs: st.mtimeMs, rootAtimeMs: st.atimeMs, rootMode: st.mode & 0o777 }),
        () => ({}),
      )
      : {};
    const manifest: EntryManifest = { originalPath: original, name, members, ...rootTimes };
    await fsp.writeFile(path.join(entryDir(id), 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const entry: TimeCapsuleEntry = {
      id,
      name,
      originalPath: original,
      kind: walked.isFolder ? 'folder' : 'file',
      sizeBytes: walked.bytes,
      heldBytes: walked.bytes,
      hasPayload: true,
      fileCount: members.filter((m) => m.kind === 'file').length,
      digest: digestOf(members),
      capturedAt: Date.now(),
      runId: context.runId,
      ...(context.policyId ? { policyId: context.policyId } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.realPath !== undefined && request.realPath !== original ? { realPath: request.realPath } : {}),
    };
    store.entries.push(entry);
    return { path: original, protected: true, entryId: id, bytes: walked.bytes };
  } catch (err) {
    // A half-written capture protects nothing. Remove it entirely so the
    // caller cannot mistake it for cover, and so reconcile has nothing to find.
    await fsp.rm(entryDir(id), { recursive: true, force: true }).catch(() => {});
    const detail = `It could not be copied into the Time Capsule (${err instanceof Error ? err.message : String(err)}), so it was left alone.`;
    recordEvent(store, {
      at: Date.now(), kind: 'unprotected', name, originalPath: original, sizeBytes: walked.bytes, detail,
    });
    return { path: original, protected: false, bytes: walked.bytes, code: 'CAPSULE_COPY_FAILED', detail };
  }
}

/** The recorded times, or nothing at all when the walk could not read them. */
function timesOf(member: WalkedMember): { mtimeMs?: number; atimeMs?: number } {
  if (typeof member.mtimeMs !== 'number' || !Number.isFinite(member.mtimeMs)) return {};
  return { mtimeMs: member.mtimeMs, ...(Number.isFinite(member.atimeMs) ? { atimeMs: member.atimeMs } : {}) };
}

/**
 * The type a restored link is made with (FG3f #9). Windows makes a link to a folder work only when it
 * is told the link is to one: 'dir' for a relative target, as the link was — or, for an absolute
 * target, a 'junction', which (unlike a 'dir' link) needs no privilege and is what npm makes there.
 * A link recorded as leading to something else is a 'file' link. One whose target's kind was not
 * recorded (a manifest written before it was, or a link that led nowhere) gets no type, so Node
 * looks at the target and picks one, exactly as before FG3f #9 (FG3g L2): a 'file' type there made a
 * link to a folder that does not open. Elsewhere the type means nothing and none is passed.
 */
export function linkTypeFor(target: string, targetIsDir: boolean | undefined, platform: NodeJS.Platform = process.platform): 'dir' | 'file' | 'junction' | undefined {
  if (platform !== 'win32' || targetIsDir === undefined) return undefined;
  if (!targetIsDir) return 'file';
  return path.win32.isAbsolute(target) ? 'junction' : 'dir';
}

/** The recorded permission bits, or nothing when the walk could not read them (FG3f #10). */
function modeOf(member: WalkedMember): { mode?: number } {
  return typeof member.mode === 'number' && Number.isInteger(member.mode) ? { mode: member.mode } : {};
}

/** A file's id and change time as the walk read them, each only when it is a number (FG3g M1). */
function fileIdOf(member: WalkedMember): { ino?: number; ctimeMs?: number } {
  return {
    ...(typeof member.ino === 'number' && Number.isFinite(member.ino) ? { ino: member.ino } : {}),
    ...(typeof member.ctimeMs === 'number' && Number.isFinite(member.ctimeMs) ? { ctimeMs: member.ctimeMs } : {}),
  };
}

/** One fingerprint over every member, order-independent of the walk. */
function digestOf(members: ManifestMember[]): string {
  const lines = members
    .map((m) => `${m.kind}:${m.rel}:${m.hash}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(lines).digest('hex');
}

/** The steps of discarding the copies of items the Trash refused, after the trash step. */
export type DiscardStep = 'load' | 'drop' | 'save';
let discardFault: DiscardStep | null = null;

/** Test-only: make one step of discarding unused copies fail, as a disk or a lock can; null clears it. */
export function setDiscardFaultForTests(step: DiscardStep | null): void {
  discardFault = step;
}

function failIfInjected(step: DiscardStep): void {
  if (discardFault === step) throw new Error(`a failure injected at the ${step} step (a test)`);
}

export interface ProtectAndTrashResult {
  runId: string;
  /** Every request, protected or not — but one inside another that went to the Trash with it (`covered`). */
  outcomes: ProtectionOutcome[];
  /** Paths that were protected and are now in the Trash (judged by the disk when the Trash reported otherwise). */
  trashed: string[];
  /**
   * Protected, then refused by the Trash, and the disk showed each still in place, untouched: their
   * capsule copies were dropped.
   */
  failedToTrash: { path: string; reason: string }[];
  /**
   * Protected, then reported as refused by the Trash, and the disk could not show where they are —
   * the look failed, or the trash step was stopped at its time limit and may yet finish (FG3b). Their
   * copies are KEPT, each marked so an undo puts it back only if its place is empty by then. Not in
   * `trashed`, `failedToTrash` or `skipped`.
   */
  unverified: { path: string; reason: string }[];
  /**
   * Requests inside another request of the batch (FG3b), by where each is on the disk (FG3c), or
   * that request spelled another way: no copy or trash step of their own. `by` is the outermost
   * request holding each, which is copied and trashed whole with it inside. When `by` is in
   * `trashed` they are in `wentWith` (or, should the disk still show one at its place, in `skipped`
   * saying so); when `by` is unverified so are they; when `by` was not deleted they are in
   * `skipped`, saying so.
   */
  covered: { path: string; by: string }[];
  /** Of `covered`, those in the Trash with the item holding them: the disk no longer shows them (FG3c). */
  wentWith: string[];
  /** Requests that were NOT deleted because they could not be protected. */
  skipped: ProtectionOutcome[];
  bytesProtected: number;
  /**
   * Set when the capsule itself is unavailable — a read-only portable session
   * has nowhere to keep a recoverable copy. Nothing was deleted.
   */
  unavailableReason?: string;
  /**
   * Set when discarding the copies of items the Trash refused did not finish:
   * a sentence for the person. It happens after the trash step, so it is
   * reported here rather than thrown — `trashed` and `runId` are still true.
   */
  cleanupError?: string;
}

/**
 * Copy items into the capsule and verify them. **Trashes nothing.**
 *
 * Separate from `protectAndTrash` so the capture half can be exercised — by
 * tests, and by anything that wants to know what protection would cost —
 * without a deletion happening. It is not a way to delete things: it has no
 * delete in it at all.
 */
export async function protectItems(
  requests: ProtectionRequest[],
  context: { runId?: string; policyId?: string } = {},
): Promise<{ runId: string; outcomes: ProtectionOutcome[] }> {
  const runId = context.runId ?? crypto.randomUUID();
  // In flight while it copies (FG3f #1): its own earlier copies are pinned, so a later item that
  // does not fit beside them is refused rather than making room by evicting them. And the index
  // is held from its load to its save (FG3f #2): another writer waits rather than having its
  // change saved over by this capture's.
  return whileInFlight(runId, () => withCapsuleStore(async () => {
    const settings = await getSettings();

    const store = await loadStore();
    if (afterIndexLoadForTests) await afterIndexLoadForTests(runId);
    const capacity = await capacityOf(store.entries, settings.timeCapsuleMaxPercent);
    const outcomes: ProtectionOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await capture(store, request, { runId, policyId: context.policyId }, capacity.capBytes, () => saveStore(store)));
    }
    // Persist the captures before anything is deleted. If the process dies at
    // this instant, the capsule holds copies of files that still exist — wasteful
    // but harmless. The opposite order could delete a file whose protection was
    // never recorded.
    await saveStore(store);
    return { runId, outcomes };
  }));
}

/** The run id a dry run gives the entries it stands in for the real run's copies (`planProtection`). */
const PLAN_RUN_ID = 'plan';

/** Pinned in a dry run: the items it has accepted, and the copies in use — by runs still under way, or restores (FG3g H1). */
function plannedOrInFlight(entry: TimeCapsuleEntry): boolean {
  return entry.runId === PLAN_RUN_ID || inUse(entry);
}

/** What a dry run says about one item it was asked to protect (v4 §4.4). */
export interface ProtectionForecast {
  path: string;
  /** Bytes the capsule would have to hold — the walked total, not a stat. */
  bytes: number;
  /** True when the capsule could take it, evicting older copies if it must. */
  willProtect: boolean;
  /** Stable code when it could not: CAPSULE_FULL, CAPSULE_UNREADABLE, … */
  code?: string;
  /** The same sentence the real run would record. */
  detail?: string;
}

export interface ProtectionPlan {
  available: boolean;
  /**
   * The capsule index as this plan would leave it — evictions applied, the
   * items it accepted added.
   *
   * Pass it back as `opts.carryOver` to continue planning where this call
   * stopped. A dry run writes nothing, so without it every call starts from
   * the capsule as it stands *now* and a cart planned in several batches is
   * optimistic: the later batches do not know the earlier ones would have
   * filled it. Never persisted — it exists only to chain calls.
   */
  carryOver: TimeCapsuleEntry[];
  /** Present only when available === false. Shown verbatim. */
  reason?: string;
  items: ProtectionForecast[];
  /** Bytes that would be protected, and so deleted. */
  bytesProtected: number;
  /** Bytes that would be left alone because they could not be protected. */
  bytesSkipped: number;
  /** Older protections that would be evicted to make room, oldest first. */
  evicts: { id: string; name: string; originalPath: string; bytes: number }[];
  capBytes: number;
  usedBytes: number;
}

/**
 * What `protectAndTrash` would do, having done none of it (v4 §4.4).
 *
 * §2.3 requires every destructive endpoint to offer a dry run that returns the
 * exact manifest "having acted on nothing, after passing through every
 * validation the real run would." For a capsule-backed delete the interesting
 * validation is capacity: an item too large to protect is **left undeleted**
 * rather than deleted unprotected, and the user has to be able to see that
 * before they commit, not discover it in a result summary afterwards.
 *
 * So this walks each item exactly as `capture` does — the same `walkItem`, so
 * the same byte total and the same complexity refusal — and simulates
 * `planEviction` cumulatively over a *copy* of the index, adding each item as
 * it is accepted. That accumulation is the part a naive predictor gets wrong:
 * ten 2 GB folders against a 15 GB cap protect seven and refuse three, not ten.
 *
 * It writes nothing: no capsule entries, no events, no payloads. The index is
 * read once and mutated only in memory.
 */
export async function planProtection(
  batch: string[],
  opts: { carryOver?: TimeCapsuleEntry[] } = {},
): Promise<ProtectionPlan> {
  // The batch as protectAndTrash takes it (FG3, FG3b, FG3c): each item once, and one inside another
  // item of the batch — by where it is on the disk — planned with the item that holds it, so the
  // plan is the run's.
  const { top, covered } = await collapseBatch(batch.map((p) => ({ path: p })));
  const paths = top.map((r) => r.path);
  const capsule = capsuleAvailable();
  const store = await loadStore();
  const settings = await getSettings();
  // The cap is a share of *usable* space and copying into the capsule moves
  // bytes from free to used without changing the sum, so it is constant for
  // the whole run — computed from the real index even when a carry-over is
  // supplied, exactly as `capture` computes it once for a batch.
  const capacity = await capacityOf(store.entries, settings.timeCapsuleMaxPercent);
  const startingEntries = opts.carryOver ?? store.entries;

  if (!capsule.available) {
    // Nothing would be protected, so nothing would be deleted. Every item says
    // so with the capsule's own reason rather than a per-item invention.
    const items: ProtectionForecast[] = [...paths, ...covered.map((c) => c.request.path)].map((path) => ({
      path, bytes: 0, willProtect: false, code: 'CAPSULE_UNAVAILABLE', detail: capsule.reason,
    }));
    return {
      available: false, reason: capsule.reason, items,
      bytesProtected: 0, bytesSkipped: 0, evicts: [], carryOver: startingEntries,
      capBytes: capacity.capBytes, usedBytes: capacity.usedBytes,
    };
  }

  // A shallow copy of the entry list, so the simulation can evict without the
  // real index ever changing. The entries themselves are never mutated.
  let simulated = [...startingEntries];
  const evicts: ProtectionPlan['evicts'] = [];
  const items: ProtectionForecast[] = [];
  let bytesProtected = 0;
  let bytesSkipped = 0;

  for (const path of paths) {
    let walked: { members: WalkedMember[]; bytes: number; isFolder: boolean };
    try {
      walked = await walkItem(path);
    } catch (err) {
      const alreadyGone = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      items.push({
        path,
        bytes: 0,
        willProtect: false,
        code: err instanceof AppError ? err.code : 'CAPSULE_UNREADABLE',
        detail: alreadyGone
          ? 'It is no longer there — nothing to delete.'
          : err instanceof AppError
            ? err.message
            : `It could not be read (${err instanceof Error ? err.message : String(err)}).`,
      });
      continue;
    }

    // As the real run pins its own copies (FG3f #1), the plan pins the items it has accepted (and,
    // through `carryOver`, those an earlier request of the same cart accepted), so it never plans
    // to drop a copy of this batch's own and never protects more than the cap.
    const { evict, fits } = planEviction(simulated, capacity.capBytes, walked.bytes, plannedOrInFlight);
    if (!fits) {
      bytesSkipped += walked.bytes;
      items.push({
        path,
        bytes: walked.bytes,
        willProtect: false,
        code: 'CAPSULE_FULL',
        detail: doesNotFitSentence(walked.bytes, capacity.capBytes, pinnedBytesOf(simulated, plannedOrInFlight), 'will be'),
      });
      continue;
    }
    for (const victim of evict) {
      evicts.push({ id: victim.id, name: victim.name, originalPath: victim.originalPath, bytes: victim.heldBytes });
    }
    const gone = new Set(evict.map((e) => e.id));
    simulated = simulated.filter((e) => !gone.has(e.id));
    // Stand in for the entry the real run would add, so the next item is
    // planned against a capsule that already holds this one.
    simulated.push({
      id: `plan:${path}`, name: path, originalPath: path, kind: walked.isFolder ? 'folder' : 'file',
      sizeBytes: walked.bytes, heldBytes: walked.bytes, hasPayload: true,
      fileCount: walked.members.filter((m) => m.kind === 'file').length,
      digest: '', capturedAt: Date.now(), runId: PLAN_RUN_ID,
    });
    bytesProtected += walked.bytes;
    items.push({ path, bytes: walked.bytes, willProtect: true });
  }
  // Each item inside another goes as that one goes, its bytes counted there.
  const forecastOf = new Map(items.map((item) => [item.path, item]));
  for (const { request, by, same } of covered) {
    const holder = forecastOf.get(by);
    const where = same ? `It is ${by}, spelled another way` : `It is inside ${by}`;
    items.push(holder?.willProtect
      ? { path: request.path, bytes: 0, willProtect: true, detail: `${where}, which is protected and deleted whole, with it.` }
      : {
        path: request.path, bytes: 0, willProtect: false, ...(holder?.code ? { code: holder.code } : {}),
        detail: `${where}, which will be left alone, so it will be too.`,
      });
  }

  return {
    available: true, items, bytesProtected, bytesSkipped, evicts,
    capBytes: capacity.capBytes, usedBytes: capacity.usedBytes,
    carryOver: simulated,
  };
}

/**
 * The one entry point for automated deletion: copy → verify → Trash.
 *
 * Everything that could not be protected is simply not deleted, and says why.
 * The Trash step goes through the existing `Cleaner`, so B2's open-file guard
 * applies here exactly as it does to a manual delete — there is no second
 * deletion pathway (§10).
 */
export async function protectAndTrash(
  batch: ProtectionRequest[],
  context: { runId?: string; policyId?: string; unattended?: boolean } = {},
): Promise<ProtectAndTrashResult> {
  const runId = context.runId ?? crypto.randomUUID();
  // In flight until its trash step is over (FG3f #1): what it copied is pinned — no capture, of
  // this run or another, evicts it to make room — so it never trashes an item whose copy is gone.
  return whileInFlight(runId, () => protectAndTrashInFlight(batch, { ...context, runId }));
}

async function protectAndTrashInFlight(
  batch: ProtectionRequest[],
  context: { runId: string; policyId?: string; unattended?: boolean },
): Promise<ProtectAndTrashResult> {
  // Nothing in TreeMap's own spill folder is protected or trashed (Phase 4 §S.5.3): refused
  // before anything is copied, whatever selected it.
  for (const r of batch) assertNotSpillPath(r.path);
  // One request per item (FG3), and none inside another (FG3b), judged by where each is on the
  // disk (FG3c, `collapseBatch`). The same path twice made two copies, one trash and one failure, and
  // the failure then discarded both copies of an item that was in the Trash. A folder and an item
  // inside it made two copies, and the item's own trash step failed — its folder had taken it — so
  // it was counted twice, and an undo that put the folder back then stopped on the item as "already
  // exists". Spelled apart (an alias of a folder, another case), they did so still; and a path
  // through a link out of a folder was taken for part of it, and reported trashed while it stayed.
  const { top: requests, covered, realPathOf } = await collapseBatch(batch);
  // Nowhere to keep a copy means nothing gets protected, and the caller must be
  // told before anything is deleted — not after.
  const capsule = capsuleAvailable();
  if (!capsule.available) {
    // Each with a code and the capsule's own sentence (FG3f #11): the rows carried a `reason` no
    // caller reads, so a cart's skipped list named the paths and said nothing about them.
    const outcomes: ProtectionOutcome[] = [...requests, ...covered.map((c) => c.request)].map((r) => ({
      path: r.path,
      protected: false,
      bytes: 0,
      code: 'CAPSULE_UNAVAILABLE',
      ...(capsule.reason ? { detail: capsule.reason } : {}),
    }));
    // Nothing is deleted: `skipped` is every request, and the reason says why.
    return {
      runId: '', outcomes, trashed: [], failedToTrash: [], unverified: [], covered: [], wentWith: [], skipped: outcomes, bytesProtected: 0,
      unavailableReason: capsule.reason,
    };
  }
  // Each copy keeps where its item is (FG3d #2, #3): reached through a link, a path's spelling may
  // lead nowhere once another item of the batch is in the Trash, or lead through folders a restore
  // would have to make up.
  const { runId, outcomes } = await protectItems(requests.map((r) => {
    const realPath = realPathOf.get(r.path);
    return realPath === undefined ? r : { ...r, realPath };
  }), context);

  const protectedOutcomes = outcomes.filter((o) => o.protected);
  // Deepest first (FG3c): an item spelled through a link inside another item is trashed before that
  // item takes the link away.
  const paths = deepestFirst(protectedOutcomes.map((o) => o.path));

  let trashed: string[] = [];
  let failedToTrash: { path: string; reason: string; stopped?: true; refused?: true; code?: string }[] = [];
  /** Set when TreeMap's own open-file check refused the batch: the Trash was never asked. */
  let heldBackBeforeTrash = false;
  /** Items TreeMap itself did not hand to the Trash, one by one (`refused`, FG3d #9). */
  const refusedByTreeMap = new Set<string>();
  const unverified: { path: string; reason: string }[] = [];
  // What stands at each path now, so a failure can be checked against the disk afterwards — and,
  // for an item that stays unconfirmed, by an undo later (`markUnverified`).
  const before = new Map<string, Identity>();
  /** Why TreeMap itself stopped an item at its own turn (`stopBeforeTrash`), by its code. */
  const stoppedBecause = new Map<string, string>();
  if (paths.length > 0) {
    for (const p of paths) before.set(p, await identityOf(p));
    const entryOf = new Map(protectedOutcomes.map((o) => [o.path, o.entryId]));
    try {
      const result = await moveToTrash(paths, {
        unattended: context.unattended === true,
        // At each item's own turn, right before its Trash step (FG3f): its copy is still there, and
        // it is still what was copied.
        checkEach: (p) => stopBeforeTrash(entryOf.get(p), p),
      });
      trashed = result.deleted;
      failedToTrash = result.failed;
    } catch (err) {
      // B2 refused the whole batch (something is open, or unattended and it could not check).
      // Nothing was deleted, so every copy just made is holding space for a file that still
      // exists — and it was TreeMap that held the batch back, before the Trash was asked (FG3c).
      failedToTrash = paths.map((p) => ({ path: p, reason: err instanceof Error ? err.message : String(err) }));
      heldBackBeforeTrash = true;
    }
    // A reported failure is judged by the disk (FG3, FG3b; `afterReportedFailure`): a trash step can
    // move the file and still report failure (osascript stopped at its time limit while Finder
    // finishes). Gone from its place: reported trashed, its copy kept for the undo. The same file
    // still there, the step having ended on its own: the refusal stands and the copy is discarded.
    // Anything else — a look that failed, a step stopped at its limit — shows neither, so the copy
    // is kept (it may be the only one) and the item is reported as not confirmed: a copy is never
    // discarded while it may be the only one, and an item is never called untouched unless the
    // disk showed it.
    const stillThere: { path: string; reason: string }[] = [];
    for (const failure of failedToTrash) if (failure.refused) refusedByTreeMap.add(failure.path);
    for (const failure of failedToTrash) {
      // Stopped by TreeMap's own look at its turn (FG3f): no Trash step was ever asked to move it,
      // so whatever stands at its place now, nothing this run did moved it — and its copy is gone
      // or not of what is there, so it is never counted as trashed.
      if (failure.refused && failure.code !== undefined) {
        stoppedBecause.set(failure.path, failure.code);
        stillThere.push({ path: failure.path, reason: failure.reason });
        continue;
      }
      // Looked at where the item is, not where its spelling now leads (FG3c): a path through a link
      // that another item took to the Trash no longer reaches it, though it has not moved.
      const now = await identityOf(realPathOf.get(failure.path) ?? failure.path);
      const verdict = afterReportedFailure(before.get(failure.path) ?? ABSENT, now, failure.stopped === true);
      if (verdict === 'gone') trashed.push(failure.path);
      else if (verdict === 'there') stillThere.push({ path: failure.path, reason: failure.reason });
      else unverified.push({ path: failure.path, reason: unverifiedSentence(failure.reason) });
    }
    failedToTrash = stillThere;
  }

  // Past the trash step nothing throws: what was trashed is the one fact the
  // caller must get back, with the run id an undo needs (FG1).
  if (unverified.length > 0) {
    const notConfirmed = new Set(unverified.map((u) => u.path));
    const kept = protectedOutcomes.filter((o) => notConfirmed.has(o.path));
    await markUnverified(kept, before);
    await dropSupersededUnverified(kept);
  }
  let cleanupError: string | undefined;
  if (failedToTrash.length > 0) {
    const refusedBecause = new Map(failedToTrash.map((f) => [f.path, f.reason]));
    const notDeleted = protectedOutcomes.filter((o) => refusedBecause.has(o.path));
    const problem = await discardUnusedCopies(notDeleted);
    for (const outcome of notDeleted) {
      // The Trash's own reason, per item (FG3b): the one thing a person can act on. Or TreeMap's own,
      // when the Trash was never asked: its check held the whole batch back (FG3c), or it refused
      // this one item itself, a name Windows would trim (FG3d #9) — a sentence of its own, whose
      // full stop is not doubled.
      const why = (refusedBecause.get(outcome.path) ?? '').replace(/[\s.]+$/, '');
      const byTreeMap = heldBackBeforeTrash || refusedByTreeMap.has(outcome.path);
      const refusal = `${byTreeMap ? 'TreeMap did not hand it to the Trash' : 'The Trash did not take it'}: ${why}. It is still in place, untouched`;
      const code = stoppedBecause.get(outcome.path);
      outcome.protected = false;
      outcome.code = code ?? 'NOT_DELETED';
      // A copy that was gone has nothing to discard but its record (FG3f #1).
      outcome.detail = problem !== null
        ? `${refusal}. Discarding its copy did not finish, so the Time Capsule may still list it.`
        : code === COPY_GONE
          ? `${refusal}.`
          : `${refusal}, and its copy was discarded.`;
    }
    if (problem !== null) {
      const items = `${formatCount(notDeleted.length)} item${notDeleted.length === 1 ? '' : 's'}`;
      cleanupError =
        `Discarding the Time Capsule copies of the ${items} the Trash refused did not finish (${problem}), so the Time Capsule may still list them. ` +
        'Everything listed as trashed was trashed, and can be put back.';
    }
  }

  // Each request inside another went as that one went — and one that went with it into the Trash
  // is listed so only when the disk no longer shows it at its place (FG3c).
  const trashedSet = new Set(trashed);
  const unverifiedBecause = new Map(unverified.map((u) => [u.path, u.reason]));
  const outcomeOf = new Map(outcomes.map((o) => [o.path, o]));
  const wentWith: string[] = [];
  for (const { request, by, same } of covered) {
    const where = same ? `It is ${by}, spelled another way` : `It is inside ${by}`;
    if (trashedSet.has(by)) {
      const now = await identityOf(request.path);
      if (now === ABSENT) wentWith.push(request.path); // in the Trash with it, protected by its copy
      else if (now === UNKNOWN) {
        unverified.push({ path: request.path, reason: `${where}, which went to the Trash, but its place could not be looked at to confirm it went too. The copy of ${by} holds it.` });
      } else {
        outcomes.push({
          path: request.path, protected: false, bytes: 0, code: 'NOT_DELETED',
          detail: `${where}, which the Trash reported taking, but it is still where it was, so it was not deleted.`,
        });
      }
      continue;
    }
    const holding = unverifiedBecause.get(by);
    if (holding !== undefined) {
      unverified.push({ path: request.path, reason: `${where}. ${holding}` });
      continue;
    }
    outcomes.push({
      path: request.path, protected: false, bytes: 0, code: outcomeOf.get(by)?.code ?? 'NOT_DELETED',
      detail: `${where}, which was not deleted, so it was left in place too.`,
    });
  }

  const stillProtected = outcomes.filter((o) => o.protected);
  return {
    runId,
    outcomes,
    trashed,
    failedToTrash,
    unverified,
    covered: covered.map(({ request, by }) => ({ path: request.path, by })),
    wentWith,
    skipped: outcomes.filter((o) => !o.protected),
    bytesProtected: stillProtected.reduce((sum, o) => sum + o.bytes, 0),
    ...(cleanupError ? { cleanupError } : {}),
  };
}

/** The code of an item left in place because its copy was gone by its own turn to be trashed (FG3f #1). */
const COPY_GONE = 'CAPSULE_COPY_GONE';

/** The code of an item left in place because it changed between its copy and its turn (FG3f #4). */
const CHANGED = 'CAPSULE_CHANGED';

/**
 * Why an item must not go to the Trash after all, asked at its own turn, right before its trash step
 * (FG3f), or null to go ahead. Never throws: a look that fails stops the item too — nothing is
 * deleted without a copy that was seen to be of it.
 *
 * #1 — its copy must still be where capture put it: what a run under way holds is never evicted
 * here, but another TreeMap process sharing this app data (the MCP server beside the app) knows
 * nothing of this run, and anything outside TreeMap can remove a folder. The copy's manifest is
 * written last by capture and goes with every removal of the folder.
 *
 * #4 — the item must still be what was copied: a file added, rewritten or replaced in a captured
 * folder between the copy and this turn was trashed with the folder and had no copy. Its metadata is
 * walked again (no bytes are read) and compared with the manifest. An item that is gone by its turn
 * goes on to its trash step, whose look at the disk says what became of it, as before.
 */
async function stopBeforeTrash(entryId: string | undefined, original: string): Promise<{ reason: string; code: string } | null> {
  const gone = { code: COPY_GONE, reason: 'its Time Capsule copy is no longer there, and nothing is deleted without one' };
  if (typeof entryId !== 'string' || !isEntryId(entryId)) return gone;
  let manifest: EntryManifest;
  try {
    manifest = await readManifest(entryId);
  } catch (err) {
    if (meansAbsent(err)) return gone;
    const why = err instanceof SyntaxError ? 'its record cannot be read' : describeFsError(err);
    return { code: COPY_GONE, reason: `its Time Capsule copy could not be looked at (${why}), and nothing is deleted without a copy that was seen` };
  }
  if (manifestRefusal(manifest) !== null) {
    return { code: COPY_GONE, reason: 'its Time Capsule copy\'s record is not one TreeMap wrote, and nothing is deleted without a copy that was seen' };
  }
  try {
    await fsp.lstat(original);
  } catch (err) {
    if (meansAbsent(err)) return null; // gone by its turn: the trash step's own look says what became of it
  }
  let walked: Awaited<ReturnType<typeof walkItem>>;
  try {
    walked = await walkItem(original);
  } catch (err) {
    if (meansAbsent(err)) return { code: CHANGED, reason: 'it changed after it was copied (something in it went while it was looked at again), so its copy is not of what is there now' };
    const why = err instanceof AppError ? err.message : describeFsError(err);
    return { code: 'CAPSULE_UNREADABLE', reason: `it could not be looked at again right before its deletion (${why})` };
  }
  const change = await changeSinceCopy(manifest, walked);
  return change === null ? null : { code: CHANGED, reason: `it changed after it was copied (${change}), so its copy is not of what is there now` };
}

/**
 * What differs between an item as its manifest records it and as it is walked now, as a phrase
 * naming the first difference and how many more, or null when nothing does (FG3f #4). Compared:
 * which members there are and their kinds, each file's size, modification time, id and change time
 * (FG3g M1: the last two where the copy recorded them), each link's target. Not compared: access
 * times (the copy itself read every file) and folders' own times. A change time that moved for a
 * reason other than content (a permission, an extended attribute) leaves the item in place too:
 * that costs a deletion, never a file.
 */
async function changeSinceCopy(manifest: EntryManifest, walked: Awaited<ReturnType<typeof walkItem>>): Promise<string | null> {
  const nameOf = (rel: string): string => (rel === '' ? manifest.name : rel);
  const recorded = new Map(manifest.members.map((m) => [m.rel, m]));
  const changes: string[] = [];
  for (const now of walked.members) {
    const was = recorded.get(now.rel);
    recorded.delete(now.rel);
    if (was === undefined) changes.push(`${nameOf(now.rel)} was added`);
    else if (was.kind !== now.kind) changes.push(`${nameOf(now.rel)} is no longer a ${was.kind === 'dir' ? 'folder' : was.kind}`);
    else if (now.kind === 'file' && (was.size !== now.size || (typeof was.mtimeMs === 'number' && was.mtimeMs !== now.mtimeMs))) {
      changes.push(`${nameOf(now.rel)} was modified`);
    } else if (now.kind === 'file' && typeof was.ino === 'number' && was.ino !== now.ino) {
      changes.push(`${nameOf(now.rel)} was replaced by another file`);
    } else if (now.kind === 'file' && typeof was.ctimeMs === 'number' && was.ctimeMs !== now.ctimeMs) {
      changes.push(`${nameOf(now.rel)} was changed`);
    } else if (now.kind === 'symlink' && was.target !== await fsp.readlink(now.abs).catch(() => null)) {
      changes.push(`${nameOf(now.rel)} points somewhere else`);
    }
  }
  for (const rel of recorded.keys()) changes.push(`${nameOf(rel)} was removed`);
  if (changes.length === 0) return null;
  return changes.length === 1 ? changes[0] : `${changes[0]}, and ${formatCount(changes.length - 1)} more change${changes.length === 2 ? '' : 's'}`;
}

/** What a person is told about an item whose trash step reported a failure the disk could not confirm. */
function unverifiedSentence(reason: string): string {
  return `The Trash reported: ${reason}. TreeMap could not confirm whether it is still in place, so its Time Capsule copy was kept — an undo puts it back only if it is gone.`;
}

/** Left in a copy's folder when its original's trash step could not be confirmed either way (FG3b). */
const UNVERIFIED_MARK = 'unverified';

/**
 * Mark the copies of items whose trash step the disk could not confirm, in each copy's own folder:
 * the copy is kept, and an undo puts it back only if its original place is empty by then
 * (`planUndoForRun`). The mark holds what stood at the place just before the trash step
 * (`before`, an `identityOf`, or null when nothing known stood there), so an undo that finds the
 * place occupied can tell "the same file, still in its place" from anything else (FG3c). After the
 * trash step, so it never throws; a mark that could not be written is logged, and leaves an
 * ordinary copy, which an undo treats as trashed.
 */
async function markUnverified(outcomes: ProtectionOutcome[], before: ReadonlyMap<string, Identity>): Promise<void> {
  for (const outcome of outcomes) {
    if (typeof outcome.entryId !== 'string') continue;
    const was = before.get(outcome.path);
    const mark: UnverifiedMark = {
      note: 'The Trash reported a failure the disk could not confirm; an undo puts this back only if its place is empty.',
      before: typeof was === 'string' ? was : null,
    };
    await fsp.writeFile(path.join(entryDir(outcome.entryId), UNVERIFIED_MARK), `${JSON.stringify(mark)}\n`).catch((err: unknown) => {
      console.error('[treemap] time capsule: a copy whose trash step could not be confirmed could not be marked:', err);
    });
  }
}

/** What an unverified mark holds (FG3c). A mark from before FG3c is a bare sentence: `before` null. */
interface UnverifiedMark {
  note: string;
  /** What stood at the item's place just before its trash step (`identityOf`), or null. */
  before: string | null;
}

/**
 * What a copy's unverified mark says stood at its place before the trash step, or null when the
 * copy carries no mark. A mark there that cannot be read as one this build writes still marks the
 * copy, with nothing known of what stood there (`before: null`).
 */
async function unverifiedMarkOf(id: string): Promise<Pick<UnverifiedMark, 'before'> | null> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(entryDir(id), UNVERIFIED_MARK), 'utf8');
  } catch (err) {
    return meansAbsent(err) ? null : { before: null };
  }
  try {
    const was = (JSON.parse(text) as { before?: unknown } | null)?.before;
    return { before: typeof was === 'string' ? was : null };
  } catch {
    return { before: null };
  }
}

/**
 * Drop older copies that this run's kept copies supersede (FG3b review): of the same original,
 * still marked unverified, and byte for byte the same (the same digest). A trash step that keeps
 * failing unconfirmed — an osascript that times out on every run — would otherwise keep one more
 * copy of an unchanged file each time, and evict older undo copies to make room. Only identical
 * content goes, so nothing is lost. After the trash step, so it never throws: a failure is logged,
 * and leaves the older copies as they were.
 */
async function dropSupersededUnverified(kept: ProtectionOutcome[]): Promise<void> {
  const keptIds = new Set(kept.map((o) => o.entryId).filter((id): id is string => typeof id === 'string'));
  if (keptIds.size === 0) return;
  try {
    // The records go under the payload lock (FG3g H1): a copy a restore is reading is never dropped.
    const superseded = await withCapsuleStore(async () => withPayloadLock(async () => {
      const store = await loadStore();
      const newestDigest = new Map(store.entries.filter((e) => keptIds.has(e.id)).map((e) => [e.originalPath, e.digest]));
      const found = new Set<string>();
      for (const e of store.entries) {
        if (keptIds.has(e.id) || !e.hasPayload || e.restoredAt || !isEntryId(e.id) || restoresInFlight.has(e.id)) continue;
        if (newestDigest.get(e.originalPath) !== e.digest) continue;
        if (await fsp.lstat(path.join(entryDir(e.id), UNVERIFIED_MARK)).then(() => true, () => false)) found.add(e.id);
      }
      if (found.size === 0) return found;
      store.entries = store.entries.filter((e) => !found.has(e.id));
      await saveStore(store);
      return found;
    }));
    for (const id of superseded) await fsp.rm(entryDir(id), { recursive: true, force: true });
  } catch (err) {
    console.error('[treemap] time capsule: older unconfirmed copies of the same files could not be dropped:', err);
  }
}

/** Left in a copy's folder when the Trash refused its original, which was never deleted. */
const NOT_DELETED_MARK = 'not-deleted';

/**
 * Discard the Time Capsule copies of items the Trash refused: copied, never deleted, so each copy
 * only holds space for a file that still exists. This runs after the trash step, where a throw
 * would lose the only record of what was deleted and the run id an undo needs, so it never
 * throws: it answers what went wrong in a few words, or null, and logs the detail.
 *
 * The order keeps an undo right whatever fails. Each copy is first marked as never deleted, in its
 * own folder, which needs no index write; the index then drops the entries in one atomic write;
 * only after that are the folders removed (one left behind is an orphan, which `reconcileCapsule`
 * sweeps). An undo passes over a marked copy (`listUndoableEntriesForRun`), so an index that could
 * not be read or written still leaves it putting back exactly what was trashed.
 */
async function discardUnusedCopies(outcomes: ProtectionOutcome[]): Promise<string | null> {
  const ids = new Set(outcomes.map((o) => o.entryId).filter((id): id is string => typeof id === 'string'));
  if (ids.size === 0) return null;
  let problem: string | null = null;
  const report = (step: string, err: unknown): void => {
    problem ??= err instanceof Error ? err.message : String(err);
    console.error(`[treemap] time capsule: discarding the copies of items the Trash refused did not finish (${step}):`, err);
  };
  for (const id of ids) {
    // Insurance only, so a mark that could not be written is logged rather than reported: the
    // steps below still discard the copy, and report if they cannot.
    await fsp.writeFile(path.join(entryDir(id), NOT_DELETED_MARK), 'The Trash refused the original, so it was never deleted.\n').catch((err: unknown) => {
      console.error('[treemap] time capsule: a copy of an item the Trash refused could not be marked:', err);
    });
  }
  // Read and written as one, with no other writer between (FG3f #2).
  const dropped = await withCapsuleStore(async () => {
    let store: CapsuleStore;
    try {
      failIfInjected('load');
      store = await loadStore();
    } catch (err) {
      report('reading the index', err);
      return false;
    }
    store.entries = store.entries.filter((e) => !ids.has(e.id));
    try {
      failIfInjected('save');
      await saveStore(store);
      return true;
    } catch (err) {
      report('writing the index', err);
      return false;
    }
  });
  if (!dropped) return problem; // the entries stay, each marked, so its folder stays too
  for (const id of ids) {
    try {
      failIfInjected('drop');
      await fsp.rm(entryDir(id), { recursive: true, force: true });
    } catch (err) {
      report('removing a copy', err);
    }
  }
  return problem;
}

/* ---------------- index (Time Capsule tab) ---------------- */

async function statusOf(store: CapsuleStore): Promise<TimeCapsuleStatus> {
  const settings = await getSettings();
  const capacity = await capacityOf(store.entries, settings.timeCapsuleMaxPercent);

  let available = true;
  let reason = capacity.note;
  try {
    await fsp.mkdir(capsuleRoot(), { recursive: true });
  } catch (err) {
    available = false;
    reason = `The Time Capsule folder can’t be created (${err instanceof Error ? err.message : String(err)}), so automatic deletions cannot be protected.`;
  }

  return {
    usedBytes: capacity.usedBytes,
    capBytes: capacity.capBytes,
    freeBytes: capacity.freeBytes,
    retentionDays: settings.timeCapsuleRetentionDays,
    maxPercent: settings.timeCapsuleMaxPercent,
    entryCount: store.entries.length,
    restorableCount: store.entries.filter((e) => e.hasPayload).length,
    available,
    ...(reason ? { reason } : {}),
  };
}

export async function getCapsuleIndex(): Promise<TimeCapsuleIndex> {
  const store = await loadStore();
  return {
    status: await statusOf(store),
    entries: [...store.entries].sort((a, b) => b.capturedAt - a.capturedAt),
    events: store.events,
  };
}

export async function getCapsuleEntry(id: string): Promise<TimeCapsuleEntry | undefined> {
  const store = await loadStore();
  return store.entries.find((e) => e.id === id);
}

/**
 * Forget one entry and its payload, at the user's request. Refused while a restore is reading its
 * copy (FG3g H1): forgotten then, it took the copy from under the restore.
 */
export async function deleteCapsuleEntry(id: string): Promise<{ deleted: boolean; bytesFreed: number }> {
  return withCapsuleStore(async () => withPayloadLock(async () => {
    const store = await loadStore();
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) throw new AppError(404, 'ENTRY_NOT_FOUND', 'That item is no longer in the Time Capsule');
    if (restoresInFlight.has(entry.id)) throw restoreRunning(entry, 'it cannot be forgotten now');
    const bytesFreed = await dropPayload(entry);
    store.entries = store.entries.filter((e) => e.id !== id);
    await saveStore(store);
    return { deleted: true, bytesFreed };
  }));
}

/* ---------------- retention + reconciliation ---------------- */

/**
 * Sweep out everything past the retention window. Returns how many went. A copy a restore is
 * reading is passed over until a later sweep (FG3g H1): swept now, it went from under the restore.
 */
export async function pruneExpired(now = Date.now()): Promise<{ removed: number; bytesFreed: number }> {
  const { timeCapsuleRetentionDays } = await getSettings();
  const cutoff = now - timeCapsuleRetentionDays * 86_400_000;

  return withCapsuleStore(async () => withPayloadLock(async () => {
    const store = await loadStore();
    const expired = store.entries.filter((e) => e.capturedAt < cutoff && !restoresInFlight.has(e.id));
    if (expired.length === 0) return { removed: 0, bytesFreed: 0 };

    let bytesFreed = 0;
    for (const entry of expired) {
      bytesFreed += await dropPayload(entry);
      recordEvent(store, {
        at: now,
        kind: 'expired',
        name: entry.name,
        originalPath: entry.originalPath,
        sizeBytes: entry.sizeBytes,
        detail: `Kept for ${timeCapsuleRetentionDays} days, then removed from the Time Capsule.`,
      });
    }
    const gone = new Set(expired);
    store.entries = store.entries.filter((e) => !gone.has(e));
    await saveStore(store);
    return { removed: expired.length, bytesFreed };
  }));
}

/**
 * Reconcile the index against what is actually on disk.
 *
 * Two directions, both real after a crash or a hand-edited app-data folder:
 * payload directories with no index entry are unreferenced bytes and are
 * removed; index entries whose payload has gone are downgraded to
 * "no longer restorable" and say so, rather than offering a Restore button
 * that cannot work.
 */
export async function reconcileCapsule(): Promise<{ orphansRemoved: number; entriesLost: number }> {
  const root = capsuleRoot();
  await fsp.mkdir(root, { recursive: true }).catch(() => {});
  // Held for the whole sweep (FG3f #2): a capture under way has written its copy's folder and not
  // yet its entry, and the sweep would take that folder for an orphan and remove it.
  return withCapsuleStore(async () => {
    // `loadStore` now REFUSES an unparseable index rather than answering with an
    // empty one, so this is the only place that has to know the difference —
    // and it knows it by being told, not by asking a second time.
    let store: CapsuleStore;
    let indexParsed: boolean;
    try {
      ({ store, parsed: indexParsed } = await loadStoreWithProvenance());
    } catch (err) {
      if (!(err instanceof CapsuleIndexUnreadableError)) throw err;
      const onDisk = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      const stranded = onDisk.filter((d) => d.isDirectory()).length;
      // Nothing is written, moved or deleted. Every one of those three was
      // measured to end with the payloads gone — writing the fallback makes the
      // next sweep delete them, and so does renaming the index aside, because an
      // absent index is a decided "first run". The sweep stays blocked until a
      // person acts. The cost is stale folders in one directory; the
      // alternative is destroying the only copy of files this app promised to
      // protect.
      console.error(
        `[treemap] capsule reconcile: ${err.message} ` +
          `${String(stranded)} recovery folders are on disk and were LEFT ALONE.`,
      );
      return { orphansRemoved: 0, entriesLost: 0 };
    }

    const known = new Set(store.entries.map((e) => e.id));
    let orphansRemoved = 0;
    // A directory listing that could not be read is not an empty capsule —
    // and `[]` here is harmless only because nothing is deleted from it.
    const onDisk = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    const payloadDirs = onDisk.filter((d) => d.isDirectory());

    // The one deletion in this function.
    //
    // "Every directory here is an orphan" is a conclusion drawn entirely from
    // the index, so it is only as good as the index — and one unreadable index
    // would `rm -rf` the protected copy of every file the user has ever deleted
    // through TreeMap, unattended, from a maintenance timer. `loadStore` is what
    // makes that impossible: it refuses an unparseable index rather than
    // answering with an empty one, and the caller above returns without
    // touching anything.
    //
    // What reaches here is an index that PARSED. Zero entries is then a decided
    // fact — a capsule the user emptied — and the sweep proceeds, so stale
    // directories are still cleaned up rather than accumulating for ever.
    // A MISSING index is not authority to delete either, and this is the half
    // that was left open: the refusal above covers a corrupt file, and the
    // remedy a user is most likely to reach for on being told a file is broken
    // is to move it out of the way — which makes it absent, which used to read
    // as a first run, which deleted every payload. Measured, from the exact
    // sentence this app printed.
    //
    // A real first run has no index AND no payload folders, so it loses
    // nothing. Payload folders with no index means the capsule has been used
    // and its record is gone: the folders are named by entries in that file, so
    // deleting them destroys the only copies while restoring them needs a human
    // either way.
    if (!indexParsed && payloadDirs.length > 0) {
      console.error(
        `[treemap] capsule reconcile: no index at ${path.join(appDataDir(), INDEX_FILE)}, but ` +
          `${String(payloadDirs.length)} recovery folders are on disk. They were LEFT ALONE — an index that is ` +
          'missing is not permission to delete what it would have described.',
      );
      return { orphansRemoved: 0, entriesLost: 0 };
    }

    for (const dirent of payloadDirs) {
      if (known.has(dirent.name)) continue;
      const orphanCapsuleDir = path.join(root, dirent.name);
      await fsp.rm(orphanCapsuleDir, { recursive: true, force: true }).catch(() => {});
      orphansRemoved++;
    }

    let entriesLost = 0;
    for (const entry of store.entries) {
      if (!entry.hasPayload) continue;
      // A record whose id TreeMap did not give never had a folder of TreeMap's, so it holds no copy
      // however the place its id spells looks — and that place is not looked at (FG3).
      if (!isEntryId(entry.id)) {
        entry.heldBytes = 0;
        entry.hasPayload = false;
        entriesLost++;
        recordEvent(store, {
          at: Date.now(),
          kind: 'lost',
          name: entry.name,
          originalPath: entry.originalPath,
          sizeBytes: entry.sizeBytes,
          detail: `${NOT_OURS} (its id is not one TreeMap gives), so it holds no copy that could be restored.`,
        });
        continue;
      }
      // "Could not stat it" is not "it is gone", and here the difference is
      // one-way: `hasPayload = false` is never revisited (the line above skips
      // such entries on every later sweep) and `startCapsuleRestore` refuses
      // them outright. So a single `EIO` from a capsule on an external or
      // network volume permanently retires a payload that is sitting there
      // intact — and writes a log line telling the user it cannot be restored,
      // which is not true.
      let missing: boolean;
      try {
        await fsp.stat(entryDir(entry.id));
        missing = false;
      } catch (err) {
        // `meansAbsent`, not the wider stat predicate: `hasPayload = false` is
        // ONE-WAY — later sweeps skip such entries and Restore refuses them — so
        // a wrong "gone" retires an intact payload for good.
        if (!meansAbsent(err)) continue; // ask again next sweep; the entry is already correct
        missing = true;
      }
      if (!missing) continue;
      entry.heldBytes = 0;
      entry.hasPayload = false;
      entriesLost++;
      recordEvent(store, {
        at: Date.now(),
        kind: 'lost',
        name: entry.name,
        originalPath: entry.originalPath,
        sizeBytes: entry.sizeBytes,
        detail: 'Its copy is missing from the Time Capsule folder, so it can no longer be restored.',
      });
    }

    // Never persist a store that came from an index we could not read: every
    // field of it is a fallback, and writing it makes the fallback the truth.
    if (orphansRemoved > 0 || entriesLost > 0) await saveStore(store);
    return { orphansRemoved, entriesLost };
  });
}

let maintenanceTimer: NodeJS.Timeout | null = null;

/** Start the background sweep (retention + reconciliation). */
export function startCapsuleMaintenance(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    void pruneExpired().catch((err: unknown) => console.error('[treemap] capsule prune failed:', err));
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref(); // never keeps the process alive on its own
  void reconcileCapsule().catch((err: unknown) => console.error('[treemap] capsule reconcile failed:', err));
  void pruneExpired().catch((err: unknown) => console.error('[treemap] capsule prune failed:', err));
}

export function stopCapsuleMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

/* ---------------- restore ---------------- */

const jobs = new Map<string, TimeCapsuleJob>();

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.finishedAt ?? job.startedAt) > JOB_TTL_MS) jobs.delete(id);
  }
}

export function getCapsuleJob(jobId: string): TimeCapsuleJob | undefined {
  return jobs.get(jobId);
}

export function cancelCapsuleJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.cancelled = true;
  return true;
}

export function cancelAllCapsuleJobs(): void {
  for (const job of jobs.values()) if (job.status === 'running') job.cancelled = true;
}

async function readManifest(id: string): Promise<EntryManifest> {
  const raw = await fsp.readFile(path.join(entryDir(id), 'manifest.json'), 'utf8');
  return JSON.parse(raw) as EntryManifest;
}

/**
 * Why a restore will not act on an index record, as a phrase, or null (FG3). The record is a file on
 * disk and a restore turns it into paths: its id names the folder the copy is read from, and its
 * original place is where the copy is written. Each is held to what capture records — an id TreeMap
 * gives, and a full path that `sanitizePath` answers unchanged (so no `..` and no system folder),
 * outside TreeMap's own spill folder. Not app-data: an undo puts back what TreeMap took from there.
 */
function recordRefusal(entry: TimeCapsuleEntry): string | null {
  if (!isEntryId(entry.id)) return 'its id is not one TreeMap gives';
  const original = placeRefusal('its original place', entry.originalPath);
  if (original !== null) return original;
  // Where it really was (FG3d #2, #3) is held to the same shape: a restore writes there.
  return entry.realPath === undefined ? null : placeRefusal('its real place', entry.realPath);
}

/** Why a recorded place is not one capture writes, as a phrase, or null. */
function placeRefusal(what: string, place: unknown): string | null {
  if (typeof place !== 'string' || !path.isAbsolute(place)) return `${what} is not a full path`;
  try {
    if (sanitizePath(place) !== place) return `${what}, ${place}, is not spelled as TreeMap records one`;
  } catch (err) {
    if (err instanceof PathRejectedError) return `${what}, ${place}, is a system folder TreeMap never writes`;
    throw err;
  }
  if (isSpillPath(place)) return `${what}, ${place}, is in TreeMap's own spill folder`;
  return null;
}

/** One name, as a folder lists it: what capture records for an item, and each step of a member's path. */
function isOneName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('\0') && path.basename(name) === name;
}

/**
 * Why a restore will not follow an entry's manifest, as a phrase, or null (FG3). Each file is read
 * from `data/<name>/<rel>` and written to `<original place>/<rel>`, so the name must be one name and
 * each member's path relative, as `path.join` spells it, and made of names — never leading out of
 * the copy or out of the item.
 *
 * Nor past a link the manifest records (FG3, FG3b): capture records a link and never what lies past
 * it. Names are compared with `keyOf`, the way the destination's volume compares them
 * (`restoreNameKeyFor`, FG3c), so `A/x` is past a link `a` where `a` and `A` are one name — and a
 * tree the volume holds, `lib` beside `Lib` on a case-sensitive one, is never refused. The check is
 * the early refusal only: the restore makes links last, so nothing is written through one whatever
 * the names fold to. Linear in the members: each member's own folders are looked up in the set of
 * links (`tally` counts the lookups), never every member against every link — a node_modules
 * capture holds thousands of links among tens of thousands of members. And each distinct name is
 * folded once (FG3d #5): `keyOf` follows Unicode code point by code point, on the event loop that
 * also serves the page, and 50,000 members under a few long folder names named those folders
 * 150,000 times — seconds of stall for one restore.
 */
export function manifestRefusal(
  manifest: EntryManifest,
  tally: { lookups: number } = { lookups: 0 },
  keyOf: (name: string) => string = (name) => name,
): string | null {
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.members)) return 'it lists no members';
  if (!isOneName(manifest.name)) return 'its name is not one name';
  for (const member of manifest.members as unknown[]) {
    const m = member as Partial<ManifestMember> | null;
    if (m === null || typeof m !== 'object' || !['file', 'dir', 'symlink'].includes(String(m.kind))) return 'a member is not one TreeMap records';
    const rel: unknown = m.rel;
    const inside = rel === '' || (typeof rel === 'string' && path.normalize(rel) === rel && rel.split(path.sep).every(isOneName));
    if (!inside) return 'a member’s path leads out of the item';
  }
  const members = manifest.members as ManifestMember[];
  const folded = new Map<string, string>();
  const key = (name: string): string => {
    let k = folded.get(name);
    if (k === undefined) {
      k = keyOf(name);
      folded.set(name, k);
    }
    return k;
  };
  const links = new Set<string>();
  for (const m of members) if (m.kind === 'symlink') links.add(m.rel.split(path.sep).map(key).join(path.sep));
  if (links.size === 0) return null;
  if (links.has('') && members.some((m) => m.rel !== '')) return 'a member lies past a link it records'; // the item itself is a link
  for (const m of members) {
    const names = m.rel.split(path.sep);
    let folder = '';
    for (let i = 0; i < names.length - 1; i++) {
      folder = i === 0 ? key(names[0]) : `${folder}${path.sep}${key(names[i])}`;
      tally.lookups++;
      if (links.has(folder)) return 'a member lies past a link it records';
    }
  }
  return null;
}

/**
 * Copy an entry back to where it came from, re-verifying every byte.
 *
 * Refuses when something already occupies the original path: overwriting is
 * how a "restore" turns into data loss, and the user can move the current file
 * aside themselves if that is what they meant. Mirrors Offload's restore.
 */
/** Everything one automated run protected — the unit Autopilot's undo works in. */
export async function listCapsuleEntriesForRun(runId: string): Promise<TimeCapsuleEntry[]> {
  const store = await loadStore();
  return store.entries.filter((e) => e.runId === runId);
}

/**
 * Why an undo passed over a copy it holds (FG3c), each only what the disk showed:
 * - `never-deleted` — the Trash refused the item and the disk showed it untouched, at the commit;
 * - `in-place` — its trash step was not confirmed, and the same file (`identityOf`, recorded just
 *   before the step) stands at its place now;
 * - `occupied` — its trash step was not confirmed, and something stands at its place that TreeMap
 *   cannot show is the file it copied (another identity, or none was recorded);
 * - `unknown` — its trash step was not confirmed, and its place could not be looked at now.
 * Only the last three can still be put back by a later undo, once their place is empty.
 */
export type PassedOverWhy = 'never-deleted' | 'in-place' | 'occupied' | 'unknown';

export interface UndoPlan {
  /** Copies an undo puts back now. */
  undoable: TimeCapsuleEntry[];
  /** Copies held but not put back, each with what the disk showed. */
  passedOver: { entry: TimeCapsuleEntry; why: PassedOverWhy }[];
  /**
   * The run's records whose copy is gone and that were never put back (FG3f #3): evicted to make
   * room for later deletions, or missing from the capsule folder. No undo can put these back, and
   * an undo that leaves one says so rather than "everything is back".
   */
  lost: TimeCapsuleEntry[];
  /** How many of the run's records an undo has already put back (FG3f #11). */
  restored: number;
}

/**
 * What an undo of one run does with each copy it holds: its entries that still hold a copy and are
 * not restored yet. A copy marked as never deleted (`discardUnusedCopies`) is passed over: its
 * original was never deleted, and a restore over it would be refused. A copy marked as not
 * confirmed (`markUnverified`, FG3b) is decided by the disk now: put back when nothing stands at its
 * place — the Trash took it after all — and passed over otherwise, still in the Time Capsule, with
 * what the look showed (`PassedOverWhy`): never "still in its place" unless it is the same file.
 */
export async function planUndoForRun(runId: string): Promise<UndoPlan> {
  const plan: UndoPlan = { undoable: [], passedOver: [], lost: [], restored: 0 };
  const marked = (id: string, mark: string): Promise<boolean> => fsp.lstat(path.join(entryDir(id), mark)).then(() => true, () => false);
  for (const entry of await listCapsuleEntriesForRun(runId)) {
    if (entry.restoredAt) {
      plan.restored++;
      continue;
    }
    // A record TreeMap did not make holds no copy of TreeMap's, and would refuse the whole undo (FG3).
    if (!isEntryId(entry.id)) continue;
    // Its copy is gone (FG3f #3): passed over in silence, it let an undo say everything was back.
    if (!entry.hasPayload) {
      plan.lost.push(entry);
      continue;
    }
    if (await marked(entry.id, NOT_DELETED_MARK)) {
      plan.passedOver.push({ entry, why: 'never-deleted' });
      continue;
    }
    const mark = await unverifiedMarkOf(entry.id);
    if (mark !== null) {
      // Looked at where the item was, not where its spelling leads now (FG3d #3).
      const now = await identityOf(restorePlaceOf(entry));
      if (now !== ABSENT) {
        const why: PassedOverWhy = now === UNKNOWN ? 'unknown' : mark.before !== null && now === mark.before ? 'in-place' : 'occupied';
        plan.passedOver.push({ entry, why });
        continue;
      }
    }
    plan.undoable.push(entry);
  }
  // Shallowest first (FG3c): an item reached through a folder or link another item of this undo
  // puts back is restored after it, never into a folder made up on the way.
  plan.undoable = shallowestFirst(plan.undoable);
  return plan;
}

/** The copies an undo of one run puts back now (`planUndoForRun`). */
export async function listUndoableEntriesForRun(runId: string): Promise<TimeCapsuleEntry[]> {
  return (await planUndoForRun(runId)).undoable;
}

/** Whether a later undo may still put this copy back: its trash step was not confirmed. */
export function stillUndoable(why: PassedOverWhy): boolean {
  return why !== 'never-deleted';
}

/**
 * The copies of unconfirmed items an undo passed over, as rows for its answer — or nothing, when
 * there are none. The copies a later undo may still put back, each saying what the disk showed.
 */
export function passedOverOf(plan: UndoPlan): { passedOver?: { path: string; reason: string }[] } {
  const rows = plan.passedOver
    .filter((p) => stillUndoable(p.why))
    .map((p) => ({ path: p.entry.originalPath, reason: passedOverReason(p.why) }));
  return rows.length > 0 ? { passedOver: rows } : {};
}

/** Said of an item of the run whose copy the Time Capsule no longer holds (FG3f #3). */
export const COPY_GONE_SENTENCE =
  'Its Time Capsule copy is gone — removed to make room for later deletions, or missing from the capsule folder — ' +
  'so it cannot be put back from here. If it was deleted, look for it in the system Trash.';

/**
 * The run's items an undo cannot put back because their copy is gone, as rows for its answer — or
 * nothing, when there are none (FG3f #3).
 */
export function unrestorableOf(plan: UndoPlan): { unrestorable?: { path: string; reason: string }[] } {
  const rows = plan.lost.map((entry) => ({ path: entry.originalPath, reason: COPY_GONE_SENTENCE }));
  return rows.length > 0 ? { unrestorable: rows } : {};
}

/** One passed-over copy, as a sentence about its item (FG3c). */
export function passedOverReason(why: PassedOverWhy): string {
  switch (why) {
    case 'never-deleted': return 'The Trash refused it, so it was never deleted.';
    case 'in-place': return 'It is still in its place, so there was nothing to put back; its copy stays in the Time Capsule.';
    case 'occupied':
      return 'Something stands where it was that TreeMap cannot show is the item it copied — the original may be in the Trash. ' +
        'An undo never overwrites, so its copy stays in the Time Capsule until its place is empty.';
    case 'unknown': return 'Its place could not be looked at, so it was not put back; its copy stays in the Time Capsule.';
  }
}

/**
 * The refusal of an undo with nothing to put back now (FG3c): CAPSULE_EMPTY when the run holds no
 * copy at all, and otherwise NOTHING_TO_UNDO, saying of each passed-over copy only what the disk
 * showed — "still in its place" for the same file, and never for another file or a look that failed.
 */
export function nothingToUndo(noun: 'commit' | 'run', plan: UndoPlan): AppError {
  // Undone already, as far as it can be (FG3f #11): a second undo of a commit that is back said the
  // capsule had lost it.
  if (plan.passedOver.length === 0 && plan.restored > 0) {
    const lost = plan.lost.length;
    return new AppError(409, 'ALREADY_UNDONE', lost === 0
      ? `That ${noun} has already been undone.`
      : `That ${noun} has already been undone as far as it can be: ${formatCount(lost)} item${lost === 1 ? '' : 's'} could not be put back, ` +
        'because the Time Capsule no longer holds a copy of them.');
  }
  if (plan.passedOver.length === 0) {
    return new AppError(409, 'CAPSULE_EMPTY',
      `The Time Capsule no longer holds the copies from that ${noun}, so it cannot be undone. ` +
      'Copies are kept for a limited time and can be evicted to make room.');
  }
  const count = (why: PassedOverWhy): number => plan.passedOver.filter((p) => p.why === why).length;
  const items = (n: number): string => `${formatCount(n)} item${n === 1 ? '' : 's'}`;
  const [inPlace, never, occupied, unknown] = (['in-place', 'never-deleted', 'occupied', 'unknown'] as const).map(count);
  if (inPlace === plan.passedOver.length) {
    return new AppError(409, 'NOTHING_TO_UNDO',
      `Everything that ${noun} copied is still in its place, so there is nothing to put back. Its copies stay in the Time Capsule.`);
  }
  const parts: string[] = [];
  if (inPlace > 0) parts.push(`${items(inPlace)} still in ${inPlace === 1 ? 'its' : 'their'} place`);
  if (never > 0) parts.push(`${items(never)} the Trash refused, so never deleted`);
  if (occupied > 0) {
    parts.push(`${items(occupied)} where something now stands that TreeMap cannot show is what it copied — the original may be in the Trash`);
  }
  if (unknown > 0) parts.push(`${items(unknown)} whose place could not be looked at`);
  return new AppError(409, 'NOTHING_TO_UNDO',
    `Nothing from that ${noun} can be put back now: ${parts.join('; ')}. ` +
    'An undo never overwrites what stands at an item\'s place, so the copies stay in the Time Capsule.');
}

/**
 * Restore one or more entries as a single job.
 *
 * Takes a list rather than one id because undoing an Autopilot run has to put
 * back everything that run removed, and doing that as N separate jobs would
 * give the user N progress dialogs and no single answer about whether the undo
 * worked. A single-entry restore is just a list of one.
 *
 * Every entry is validated up front: if any one of them cannot be restored,
 * nothing starts. A partial undo that silently skipped two of five items would
 * be exactly the kind of half-applied operation §B2 refuses elsewhere.
 */
export interface RestoreOptions {
  /**
   * Run once every entry is back, before the job says it is complete (FG3d #8): what depends on the
   * restore's real outcome — an Autopilot run marked undone — is recorded from it, never from the
   * job's start, and is on disk by the time anything reads "complete". Not run for a job that fails
   * or is cancelled. A failure here is logged: the bytes are home either way.
   */
  beforeComplete?: () => Promise<void>;
}

export async function startCapsuleRestore(entryIds: string[], options: RestoreOptions = {}): Promise<TimeCapsuleJob> {
  pruneJobs();
  if (entryIds.length === 0) throw new AppError(400, 'NOTHING_TO_RESTORE', 'No items to restore');
  // Accepted under the payload lock, and its copies pinned before the lock is let go (FG3g H1): no
  // removal of a copy is under way while they are looked at, and none starts until the job ends.
  return withPayloadLock(async () => {
    const store = await loadStore();
    const planned: { entry: TimeCapsuleEntry; manifest: EntryManifest }[] = [];

    // Each once: the same id twice was put back, then read again from the copy its first turn removed.
    for (const id of new Set(entryIds)) {
      const entry = store.entries.find((e) => e.id === id);
      if (!entry) throw new AppError(404, 'ENTRY_NOT_FOUND', 'That item is no longer in the Time Capsule');
      if (entry.restoredAt) throw new AppError(409, 'ALREADY_RESTORED', `“${entry.name}” has already been restored`);
      if (restoresInFlight.has(entry.id)) throw restoreRunning(entry, 'it is not started a second time');
      if (!entry.hasPayload) {
        throw new AppError(409, 'PAYLOAD_GONE', `The Time Capsule no longer holds a copy of “${entry.name}”`);
      }
      const refused = recordRefusal(entry);
      if (refused) throw new AppError(409, 'CAPSULE_RECORD_INVALID', `${NOT_OURS} (${refused}), so nothing was restored.`);
      const place = restorePlaceOf(entry);
      // Only "nothing is there" is free (FG3f #5): a look that failed for another reason (EACCES, EIO)
      // says nothing either way, and was read as an empty place.
      const occupied = await fsp.lstat(place).then(() => true, (err: unknown) => {
        if (meansAbsent(err)) return false;
        throw new AppError(409, 'PATH_UNREADABLE',
          `TreeMap could not look at ${place} (${describeFsError(err)}), so it cannot tell whether something stands there, and a restore never writes over what is there. Nothing was restored.`);
      });
      if (occupied) {
        throw new AppError(409, 'PATH_OCCUPIED',
          `Something already exists at ${place}. Move it aside first — restoring will never overwrite what is there now.`);
      }
      const manifest = await readManifest(id).catch((err: unknown) => {
        // Its folder is gone (FG3g L1): evicted, expired or removed outside TreeMap. That is no copy,
        // not a record that cannot be read.
        if (meansAbsent(err)) throw new AppError(409, 'PAYLOAD_GONE', `The Time Capsule no longer holds a copy of “${entry.name}”`);
        return null;
      });
      if (!manifest) {
        throw new AppError(409, 'MANIFEST_UNREADABLE', `The record of what was captured for “${entry.name}” can’t be read, so it can’t be verified on restore`);
      }
      const stray = manifestRefusal(manifest, undefined, await restoreNameKeyFor(path.dirname(place)));
      if (stray) {
        throw new AppError(409, 'CAPSULE_RECORD_INVALID',
          `The record of what was captured for “${entry.name}” is not one TreeMap wrote (${stray}), so nothing was restored.`);
      }
      planned.push({ entry, manifest });
    }

    const job: TimeCapsuleJob = {
      jobId: crypto.randomUUID(),
      entryId: planned[0].entry.id,
      entryIds: planned.map((p) => p.entry.id),
      status: 'running',
      phase: 'copying',
      fileCount: planned.reduce((sum, p) => sum + p.manifest.members.filter((m) => m.kind === 'file').length, 0),
      filesDone: 0,
      bytesTotal: planned.reduce((sum, p) => sum + p.entry.sizeBytes, 0),
      bytesDone: 0,
      currentPath: '',
      cancelled: false,
      startedAt: Date.now(),
    };
    jobs.set(job.jobId, job);

    // Pinned in the same turn as the last look at them, and let go when the job ends (`runRestoreAll`).
    for (const { entry } of planned) restoresInFlight.add(entry.id);
    void runRestoreAll(job, planned, options.beforeComplete).catch((err: unknown) => {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    });
    return job;
  });
}

/**
 * Restore every planned entry in turn.
 *
 * One failure fails the job and stops: the remaining entries keep their copies,
 * so the user can fix whatever went wrong and undo again. Entries already put
 * back stay put back — they are at their correct paths, and pulling them out
 * again would be a second destructive act nobody asked for.
 *
 * A cancel stops what is left to put back (FG3d #8): one that arrives once the
 * last entry is home stops nothing, and the job says complete, as it is.
 */
async function runRestoreAll(
  job: TimeCapsuleJob,
  planned: { entry: TimeCapsuleEntry; manifest: EntryManifest }[],
  beforeComplete?: () => Promise<void>,
): Promise<void> {
  try {
    await restoreEach(job, planned, beforeComplete);
  } finally {
    // However the job ended — complete, failed, cancelled, or thrown — its copies are no longer in
    // use by it (FG3g H1). One put back is restored; one it did not reach is held as before.
    for (const { entry } of planned) restoresInFlight.delete(entry.id);
  }
}

async function restoreEach(
  job: TimeCapsuleJob,
  planned: { entry: TimeCapsuleEntry; manifest: EntryManifest }[],
  beforeComplete?: () => Promise<void>,
): Promise<void> {
  /** Dates and permissions that could not be set back (FG3f #10): the restore finishes, and says so. */
  const misses: string[] = [];
  for (const { entry, manifest } of planned) {
    if (job.cancelled) {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      return;
    }
    await runRestore(job, entry, manifest, misses);
    if (job.status === 'error' || job.status === 'cancelled') return;
  }
  if (beforeComplete) {
    await beforeComplete().catch((err: unknown) => {
      console.error('[treemap] time capsule: recording what a completed restore finished did not succeed:', err);
    });
  }
  // A completed job that carries a sentence: the progress stream sends it as the `complete` event's
  // warning, beside "restored", the way an offload says its originals stayed.
  if (misses.length > 0) {
    const more = misses.length > 1 ? `, and ${formatCount(misses.length - 1)} more` : '';
    job.error = `Everything was put back byte for byte, but ${misses[0]} could not be set back${more}.`;
  }
  job.phase = 'done';
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/**
 * Put a member's recorded timestamps back.
 *
 * Never a reason to undo a restore: the bytes are already home and verified,
 * and a filesystem that refuses `utimes` (or a manifest written before
 * timestamps were recorded) must not turn a successful restore into a failed
 * one. A file with the wrong date is a much smaller problem than a file that
 * was rolled back for it. But never silent either (FG3f #10): a failure is
 * answered as a phrase, and the job finishes with a warning naming it.
 * Modification and access times only — no system lets a program set a file's
 * creation date back, and nothing here claims to.
 *
 * Symlinks are skipped: `lutimes` is not available everywhere, and a link's
 * own timestamps carry nothing the target's do not.
 */
/**
 * Test-only: a failure of setting a restored item's dates or permissions back (FG3f #10), as a
 * volume that refuses `utimes` or `chmod` answers. Error to fail it, null for the real call. The
 * suite's ForTests idiom: returns the function that removes it.
 */
let restoreMetaFaultForTests: ((dest: string, what: 'times' | 'mode') => Error | null) | null = null;
export function setRestoreMetaFaultForTests(fault: (dest: string, what: 'times' | 'mode') => Error | null): () => void {
  restoreMetaFaultForTests = fault;
  return () => { restoreMetaFaultForTests = null; };
}

async function applyRecordedTimes(dest: string, member: ManifestMember): Promise<string | null> {
  if (member.kind === 'symlink') return null;
  if (typeof member.mtimeMs !== 'number') return null; // an older manifest
  const mtime = new Date(member.mtimeMs);
  const atime = typeof member.atimeMs === 'number' ? new Date(member.atimeMs) : mtime;
  try {
    const fault = restoreMetaFaultForTests?.(dest, 'times') ?? null;
    if (fault) throw fault;
    await fsp.utimes(dest, atime, mtime);
    return null;
  } catch (err) {
    return `the dates of ${dest} (${describeFsError(err)})`;
  }
}

/**
 * Put a member's recorded permission bits back (FG3f #10), the way `applyRecordedTimes` puts its
 * dates back: never a reason to undo a restore whose bytes are home, and never silent — a failure is
 * answered, and the job finishes with a warning naming it. Links are skipped (a link's own mode
 * means nothing on most systems), and so is a manifest written before modes were recorded.
 */
async function applyRecordedMode(dest: string, member: ManifestMember): Promise<string | null> {
  if (member.kind === 'symlink' || typeof member.mode !== 'number') return null;
  try {
    const fault = restoreMetaFaultForTests?.(dest, 'mode') ?? null;
    if (fault) throw fault;
    await fsp.chmod(dest, member.mode & 0o777);
    return null;
  } catch (err) {
    return `the permissions of ${dest} (${describeFsError(err)})`;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A restore that stopped and could not remove everything it had made, as a sentence (FG3d #1): what
 * stopped it, and the first thing left at the item's place, which a retry would find occupied.
 */
function leftBehindSentence(err: unknown, left: { at: string; why: string }[]): string {
  const cause = err instanceof CopyLeftBehind ? err.cause : err;
  const what = cause instanceof CopyCancelled ? 'The restore was cancelled' : `The restore stopped (${messageOf(cause)})`;
  const more = left.length > 1 ? ` and ${formatCount(left.length - 1)} more thing${left.length === 2 ? '' : 's'} it had made` : '';
  return `${what}, but what it had already made at ${left[0].at}${more} could not be removed (${left[0].why}). ` +
    `Remove ${left.length === 1 ? 'it' : 'them'} before trying again; the copy stays in the Time Capsule.`;
}

async function runRestore(job: TimeCapsuleJob, entry: TimeCapsuleEntry, manifest: EntryManifest, misses: string[]): Promise<void> {
  const noteMiss = (miss: string | null): void => {
    if (miss !== null) misses.push(miss);
  };
  const dataRoot = payloadRoot(entry.id);
  // Where it was (FG3d #2): its real place when capture recorded one, the path it was asked for otherwise.
  const place = restorePlaceOf(entry);
  // Named for the invariant that makes removing them safe: every path in
  // these lists was created by THIS restore, moments ago. Nothing here ever
  // removes a file that existed before the restore started — the occupied-path
  // check refuses outright rather than clearing the way.
  const writtenByThisRestore: string[] = [];
  const dirsCreatedByThisRestore: string[] = [];

  // A folder made on the way to a member (`mkdir -p`) is this restore's too, and goes with it on a
  // failure (FG3c): left behind, it held the original place, and every retry was refused there.
  const makeParentOf = async (dest: string): Promise<void> => {
    const first = await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (first === undefined) return;
    for (let at = path.dirname(dest); ; at = path.dirname(at)) {
      dirsCreatedByThisRestore.push(at);
      if (at === first || path.dirname(at) === at) break;
    }
  };

  // A folder of the item, made by this restore and never one already there (FG3f #5): `mkdir -p`
  // went on without a word into a folder that had appeared since the restore began, or through a
  // link to one, wrote the item into it, and recorded it as made here — so a later failure removed it.
  const makeOwnFolder = async (dir: string): Promise<void> => {
    try {
      await fsp.mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      throw new Error(`Something appeared at ${dir} since this restore began (or the volume reads its name as one this restore already used), ` +
        'and a restore never writes into or over what is there, so it stopped.');
    }
    dirsCreatedByThisRestore.push(dir);
  };
  // The folder a member inside the item is written into must still be a plain folder (FG3f #5): this
  // restore made it, and a link put in its place since would take the member somewhere else.
  const assertPlainFolder = async (dir: string): Promise<void> => {
    const st = await fsp.lstat(dir);
    if (!st.isDirectory()) {
      throw new Error(`${dir}, which this restore made to write into, is no longer a plain folder (something replaced it since), so it stopped rather than write through it.`);
    }
  };

  try {
    await makeParentOf(place);
    // The item's own directory comes first, so a folder that held nothing at
    // all still comes back as a folder rather than as nothing.
    if (entry.kind === 'folder') await makeOwnFolder(place);
    // Then its subdirectories, shallowest first, so each is made in one this restore made and file
    // writes never race their own parents.
    const dirDepth = (m: ManifestMember): number => m.rel.split(path.sep).length;
    for (const member of manifest.members.filter((m) => m.kind === 'dir').sort((a, b) => dirDepth(a) - dirDepth(b))) {
      await makeOwnFolder(path.join(place, member.rel));
    }

    // Files, then links, the deepest first (FG3b): a link is made only once every file and folder is
    // in place, and before any link that could hold its folder — capture never records anything
    // past a link — so nothing this restore makes, a link included, is made through a link it made,
    // whatever the manifest's names fold to.
    const files = manifest.members.filter((m) => m.kind !== 'dir' && m.kind !== 'symlink');
    const depth = (m: ManifestMember): number => (m.rel === '' ? 0 : m.rel.split(path.sep).length);
    const links = manifest.members.filter((m) => m.kind === 'symlink').sort((a, b) => depth(b) - depth(a));
    for (const member of [...files, ...links]) {
      if (job.cancelled) throw new CopyCancelled();

      const from = path.join(dataRoot, member.rel === '' ? manifest.name : path.join(manifest.name, member.rel));
      const dest = member.rel === '' ? place : path.join(place, member.rel);
      await makeParentOf(dest);
      if (member.rel !== '') await assertPlainFolder(path.dirname(dest));

      if (member.kind === 'symlink') {
        await fsp.symlink(member.target ?? '', dest, linkTypeFor(member.target ?? '', member.targetIsDir)).catch((err: NodeJS.ErrnoException) => {
          // Something this restore made stands at the link's name as the volume reads names: the
          // record names a member past its own link, which capture never writes (FG3c).
          if (err.code !== 'EEXIST') throw err;
          throw new Error(`The record of what was captured for “${entry.name}” names ${member.rel || manifest.name} as a link where this restore already put a file or folder of that name, as this volume reads names — capture never records that, so it was not restored.`);
        });
        writtenByThisRestore.push(dest);
        continue;
      }

      job.phase = 'copying';
      job.currentPath = dest;
      // Written beside its name and put there only once it verifies (FG3f #8): a quit or a kill
      // part-way leaves no part-copied file at the person's own name.
      const partial = partialNameFor(dest);
      const hash = await copyWithHash(from, partial, {
        onBytes: (n) => { job.bytesDone += n; },
        isCancelled: () => job.cancelled,
      });
      writtenByThisRestore.push(partial);

      job.phase = 'verifying';
      if (hash !== member.hash) {
        throw new Error(`${member.rel || manifest.name} no longer matches the fingerprint recorded when it was protected`);
      }
      await placeWithoutClobber(partial, dest).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
        throw new Error(`Something appeared at ${dest} since this restore began, and a restore never writes over what is there, so it stopped.`);
      });
      writtenByThisRestore[writtenByThisRestore.length - 1] = dest;
      noteMiss(await applyRecordedMode(dest, member));
      noteMiss(await applyRecordedTimes(dest, member));
      job.filesDone++;
    }

    // Directories last, and deepest first: writing a child updates its
    // parent's mtime, so a folder stamped before its contents were restored
    // would immediately be re-stamped with the time of the restore. Sorting by
    // descending path length is enough — a child's path is always longer than
    // the parent it sits in.
    const dirMembers = manifest.members
      .filter((m) => m.kind === 'dir')
      .sort((a, b) => b.rel.length - a.rel.length);
    // Its permissions with its dates, after everything inside it (FG3f #10): a read-only folder made
    // read-only before its contents were written would refuse them.
    for (const member of dirMembers) {
      noteMiss(await applyRecordedTimes(path.join(place, member.rel), member));
      noteMiss(await applyRecordedMode(path.join(place, member.rel), member));
    }
    // The item's own folder is the shallowest of all, so it comes last.
    if (entry.kind === 'folder') {
      const own: ManifestMember = {
        rel: '', kind: 'dir', size: 0, hash: '',
        ...(typeof manifest.rootMtimeMs === 'number' ? { mtimeMs: manifest.rootMtimeMs, atimeMs: manifest.rootAtimeMs } : {}),
        ...(typeof manifest.rootMode === 'number' ? { mode: manifest.rootMode } : {}),
      };
      noteMiss(await applyRecordedTimes(place, own));
      noteMiss(await applyRecordedMode(place, own));
    }

    // Deliberately does NOT mark the job complete: a job can cover several
    // entries, and only runRestoreAll knows when the last one is home.
  } catch (err) {
    // Leave nothing half-restored at the destination, and keep the capsule copy
    // so the user can try again once they've fixed whatever failed. A file the
    // copy had begun is gone already (copyWithHash removes what it made, FG3d #1);
    // anything this restore made that could not be removed is named, and the job
    // is then an error, never a cancel — the page says "nothing was left
    // half-written" of a cancelled one.
    job.phase = 'rolling-back';
    const left: { at: string; why: string }[] = err instanceof CopyLeftBehind ? [{ at: err.dest, why: err.why }] : [];
    for (const writtenByThisRestore_file of writtenByThisRestore.reverse()) {
      await fsp.rm(writtenByThisRestore_file, { force: true }).catch((e: unknown) => {
        left.push({ at: writtenByThisRestore_file, why: messageOf(e) });
      });
    }
    for (const dirsCreatedByThisRestore_dir of [...dirsCreatedByThisRestore].sort((a, b) => b.length - a.length)) {
      // rmdir, not rm -r: it removes the directory only if it ended up empty,
      // so anything that was not ours is left exactly where it is. One that still
      // holds something is not named: whatever of ours it holds is named above.
      await fsp.rmdir(dirsCreatedByThisRestore_dir).catch((e: NodeJS.ErrnoException) => {
        if (!meansAbsent(e) && e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') left.push({ at: dirsCreatedByThisRestore_dir, why: messageOf(e) });
      });
    }

    const cancelled = left.length === 0 && (err instanceof CopyCancelled || job.cancelled);
    job.status = cancelled ? 'cancelled' : 'error';
    if (!cancelled) job.error = left.length === 0 ? messageOf(err) : leftBehindSentence(err, left);
    job.phase = 'done';
    job.finishedAt = Date.now();
    return;
  }

  /**
   * Bookkeeping, and it lives OUT here for a reason.
   *
   * The bytes are home and hash-verified by this point. These two calls only
   * tidy up after that: they reclaim the capsule's own scratch copy and write
   * the index. Both are filesystem writes that can fail for reasons that have
   * nothing to do with the user's file — an antivirus scanner still holding
   * the copy we just read, a directory momentarily locked, a full disk.
   *
   * They used to sit inside the `try` above, whose `catch` deletes every file
   * the restore just wrote. So a failure to delete OUR OWN temporary copy
   * un-restored the user's data and reported the restore as failed. That is
   * the same shape as the `startWatcher` bug the handoff records: a subsystem
   * reporting failure for something that had already succeeded — except this
   * one takes the file with it.
   *
   * A failure here is logged and nothing else. The capsule keeping a redundant
   * copy costs space; rolling back costs the user their file.
   */
  try {
    // With no other writer of the index between its load and its save (FG3f #2): a capture under
    // way saved over "put back" and left the record promising a copy this restore had removed.
    await withCapsuleStore(async () => withPayloadLock(async () => {
      const store = await loadStore();
      const live = store.entries.find((e) => e.id === entry.id);
      if (live) {
        live.restoredAt = Date.now();
        await dropPayload(live);
      }
      await saveStore(store);
    }));
  } catch (err) {
    console.error('[treemap] capsule bookkeeping after a successful restore failed:', err);
  }
}
