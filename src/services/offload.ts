import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import {
  FileNode,
  OffloadEntry,
  OffloadJob,
  ScanResult,
} from '../models/types';
import { storeOf, Flag } from './scanStore';
import { readJsonFile, writeJsonFile } from './storage';
import { moveToTrash } from './cleaner';
import { diskUsage } from './diskUsage';
import { isInside } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';

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
/** Keep a little headroom beyond the plan's byte total. */
const FREE_SPACE_MARGIN = 1.02;
const JOB_TTL_MS = 30 * 60_000;

/* ---------------- manifest store ---------------- */

interface ManifestStore {
  entries: OffloadEntry[];
  /** Per destination root: when we last saw it mounted. */
  destinations: Record<string, { lastSeenAt: number }>;
}

async function loadManifest(): Promise<ManifestStore> {
  const raw = await readJsonFile<Partial<ManifestStore>>(MANIFEST_FILE, {});
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

/** Merge this destination's entries into the manifest copy on the drive itself. */
async function writeDestManifest(destRoot: string, allEntries: OffloadEntry[]): Promise<void> {
  try {
    const file = path.join(destRoot, DEST_MANIFEST);
    let existing: OffloadEntry[] = [];
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { entries?: OffloadEntry[] };
      if (Array.isArray(raw.entries)) existing = raw.entries;
    } catch { /* first write to this drive, or unreadable — start fresh */ }
    const mine = allEntries.filter((e) => e.destRoot === destRoot);
    const byId = new Map(existing.map((e) => [e.id, e]));
    for (const e of mine) byId.set(e.id, e);
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ entries: [...byId.values()] }, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    // The app-data manifest is authoritative; the drive copy is best-effort.
    console.error('[treemap] destination manifest write failed:', err);
  }
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

class JobCancelled extends Error {
  constructor() { super('Cancelled'); }
}

/* ---------------- copy + verify machinery ---------------- */

/** Copy src → dest, returning the SHA-256 of the bytes that flowed through. */
async function copyWithHash(src: string, dest: string, job: OffloadJob): Promise<string> {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(src);
  const writer = fs.createWriteStream(dest, { flags: 'wx' }); // never clobber
  reader.on('data', (chunk: string | Buffer) => {
    hash.update(chunk);
    job.bytesDone += chunk.length;
    if (job.cancelled) reader.destroy(new JobCancelled());
  });
  await pipeline(reader, writer);
  return hash.digest('hex');
}

/** SHA-256 of a file on disk (used for the read-back verify + restore). */
export async function hashFile(filePath: string, job?: OffloadJob): Promise<string> {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(filePath);
  reader.on('data', (chunk: string | Buffer) => {
    hash.update(chunk);
    if (job?.cancelled) reader.destroy(new JobCancelled());
  });
  await new Promise<void>((resolve, reject) => {
    reader.on('end', resolve);
    reader.on('error', reject);
  });
  return hash.digest('hex');
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

/** Undo everything this job wrote at the destination. */
async function rollback(created: string[], createdDirs: string[], job: OffloadJob): Promise<void> {
  job.phase = 'rolling-back';
  for (const f of created.reverse()) {
    try { await fsp.rm(f, { force: true }); } catch { /* best effort */ }
  }
  for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try { await fsp.rm(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/* ---------------- offload ---------------- */

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
  // A destination inside a selected folder (or vice versa) would eat itself.
  for (const node of nodes) {
    if (node.path === destDir || isInside(node.path, destDir)) {
      throw new AppError(400, 'DEST_INSIDE_SOURCE', 'The destination is inside a folder being offloaded');
    }
    if (isInside(destDir, node.path)) {
      throw new AppError(400, 'SOURCE_INSIDE_DEST', 'That selection already lives inside the destination');
    }
  }
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
    throw new AppError(400, 'TOO_MANY_FILES', `That's ${plan.length.toLocaleString()} files — offload at most ${MAX_FILES_PER_JOB.toLocaleString()} at a time`);
  }
  const bytesTotal = plan.reduce((s, p) => s + p.size, 0);

  const { free } = await diskUsage(destDir).catch(() => ({ free: 0 }));
  if (free < bytesTotal * FREE_SPACE_MARGIN) {
    throw new AppError(400, 'DEST_FULL', `Not enough space at the destination — need ${(bytesTotal / 1073741824).toFixed(1)} GB, only ${(free / 1073741824).toFixed(1)} GB free`);
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
      if (job.cancelled) throw new JobCancelled();
      job.phase = 'copying';
      job.currentPath = item.src;
      const hash = await copyWithHash(item.src, item.dest, job);
      createdFiles.push(item.dest);

      job.phase = 'verifying';
      job.currentPath = item.dest;
      const verify = await hashFile(item.dest, job);
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
    const trashed = await moveToTrash(topPaths);
    if (trashed.failed.length) {
      // Copies are safe at the destination; report the leftovers honestly.
      job.error = `Offloaded everything, but ${trashed.failed.length} original${trashed.failed.length === 1 ? '' : 's'} couldn't be moved to the Trash: ${trashed.failed[0].reason}`;
    }

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
    await writeDestManifest(destDir, store.entries);

    job.phase = 'done';
    job.status = 'complete';
    job.finishedAt = Date.now();
  } catch (err) {
    await rollback(createdFiles, createdDirs, job);
    job.status = err instanceof JobCancelled || job.cancelled ? 'cancelled' : 'error';
    if (job.status === 'error') job.error = err instanceof Error ? err.message : String(err);
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

async function runRestore(job: OffloadJob, entries: OffloadEntry[]): Promise<void> {
  const failures: string[] = [];
  const store = await loadManifest();
  for (const entry of entries) {
    if (job.cancelled) break;
    try {
      job.phase = 'copying';
      job.currentPath = entry.destPath;
      const existing = await fsp.stat(entry.originalPath).catch(() => null);
      if (existing) throw new Error(`something already exists at ${entry.originalPath}`);
      const source = await fsp.stat(entry.destPath).catch(() => null);
      if (!source) throw new Error('the offloaded copy is missing — is the drive connected?');

      await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true });
      const hash = await copyWithHash(entry.destPath, entry.originalPath, job);

      job.phase = 'verifying';
      if (hash !== entry.hash) {
        await fsp.rm(entry.originalPath, { force: true }); // don't leave a damaged copy
        throw new Error('verification failed — the offloaded copy no longer matches its recorded fingerprint');
      }
      const live = store.entries.find((e) => e.id === entry.id);
      if (live) live.restoredAt = Date.now();
      job.filesDone++;
    } catch (err) {
      failures.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await saveManifest(store);
  job.phase = 'done';
  job.finishedAt = Date.now();
  if (job.cancelled) {
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

export async function getOffloadIndex(): Promise<OffloadIndex> {
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
  let touched = false;
  const destinations = [...roots.entries()].map(([root, agg]) => {
    const mounted = fs.existsSync(root);
    if (mounted) {
      store.destinations[root] = { lastSeenAt: Date.now() };
      touched = true;
    }
    return {
      root,
      mounted,
      lastSeenAt: store.destinations[root]?.lastSeenAt ?? 0,
      ...agg,
    };
  }).sort((a, b) => b.totalBytes - a.totalBytes);
  if (touched) await saveManifest(store);
  return { destinations, entries: [...store.entries].sort((a, b) => b.offloadedAt - a.offloadedAt) };
}

/** Manifest lookup for the reveal endpoint (only manifest paths may open). */
export async function getOffloadEntry(id: string): Promise<OffloadEntry | undefined> {
  const store = await loadManifest();
  return store.entries.find((e) => e.id === id);
}
