import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { Response } from 'express';
import { ScanStore, TreeSource, asStore } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { capabilityState } from '../platform/capabilities';
import { getCapabilities } from '../platform/capabilities';
import { moveToTrash } from './cleaner';
import { sseSend } from '../utils/sse';

const exec = promisify(execFile);

/**
 * compressionAdvisor — re-encode big old video to HEVC (§C2).
 *
 * This is the only feature in TreeMap that REWRITES a user's file rather than
 * moving or deleting it, so the whole design is about making that safe:
 *
 *  1. **Never overwrite in place.** The new file is encoded beside the original
 *     under a temp name. The original is untouched until the new one has been
 *     proven good.
 *  2. **Verify before anything is removed.** The encode is probed again: it has
 *     to open, its duration has to match the original within tolerance, its
 *     frame count has to be sane, and it has to actually be smaller. Any
 *     failure discards the encode and leaves the original exactly where it was.
 *  3. **The original goes to the Trash**, through `cleaner.moveToTrash` like
 *     every other deletion in the app — recoverable, guarded, audited.
 *  4. **Timestamps are preserved.** A photo library that loses its dates is a
 *     disaster, and "sort by date" is how people find things.
 *
 * Hardware encoders only. Software HEVC is 10–50× slower and would turn a
 * cleanup into an afternoon; software AV1 is worse still. **AV1 is offered only
 * where hardware encode genuinely exists** — most Apple Silicon decodes AV1 but
 * cannot encode it, and quietly substituting a software encoder would be the
 * kind of surprise that makes people distrust the tool. HEVC is the claim that
 * holds everywhere.
 *
 * ffmpeg is optional and not bundled. Where it is missing the feature says so,
 * with the command that installs it.
 */

/* ────────────────────────── types ────────────────────────── */

export interface MediaProbe {
  durationSeconds: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  bitrateBps: number | null;
  frameCount: number | null;
}

export interface EncoderAvailability {
  available: boolean;
  reason?: string;
  /** ffmpeg encoder name actually used, e.g. `hevc_videotoolbox`. */
  encoder: string | null;
  /** Codecs with genuine hardware ENCODE support on this machine. */
  hardwareCodecs: string[];
  mechanism: string;
}

export interface CompressionCandidate {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  codec: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Estimated size after re-encoding. An ESTIMATE — labelled as one in the UI. */
  estimatedBytes: number;
  estimatedSaving: number;
  /** Why this file is worth re-encoding, in plain English. */
  reason: string;
}

/** The seam every external tool call goes through, so the pipeline is testable. */
export interface MediaTools {
  availability(): Promise<EncoderAvailability>;
  probe(file: string): Promise<MediaProbe | null>;
  encode(
    input: string,
    output: string,
    encoder: string,
    durationSeconds: number | null,
    onProgress: (fraction: number) => void,
    /**
     * Hands the caller the live encoder process the moment it exists, so it can
     * be killed early — the same seam `gduScanner.runGdu` uses for its shards.
     * Without it an encode is only interruptible BETWEEN files, and a quit
     * mid-file would orphan an ffmpeg that keeps rewriting the user's video
     * with nothing left to reap it. Optional, because a fake in a test has no
     * process to hand over.
     */
    onSpawn?: (child: ChildProcess) => void,
  ): Promise<void>;
}

/* ────────────────────────── candidate selection ────────────────────────── */

/** Containers worth probing at all. */
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'wmv', 'mpg', 'mpeg', 'ts', 'flv', 'webm', '3gp']);
/** Codecs that HEVC meaningfully improves on. Already-efficient ones are skipped. */
const IMPROVABLE_CODECS = new Set(['h264', 'avc1', 'mpeg4', 'mpeg2video', 'msmpeg4v3', 'wmv3', 'vc1', 'vp8', 'mjpeg', 'prores', 'dvvideo']);
/** Below this, the effort and the quality loss are not worth the bytes. */
export const MIN_CANDIDATE_BYTES = 50 * 1024 * 1024;

/**
 * Expected size after re-encoding, as a FRACTION of the original.
 *
 * HEVC at visually-comparable quality lands near half of H.264 in practice, and
 * further below the older codecs. Deliberately conservative: an estimate that
 * undersells is a pleasant surprise, one that oversells is a complaint. ProRes
 * and DV are intermediate/tape formats and shrink enormously.
 */
export function expectedRatio(codec: string | null): number {
  switch ((codec || '').toLowerCase()) {
    case 'prores':
    case 'dvvideo':
      return 0.15;
    case 'mpeg2video':
    case 'msmpeg4v3':
    case 'wmv3':
    case 'vc1':
    case 'mpeg4':
      return 0.35;
    default:
      return 0.55; // h264 and friends
  }
}

export function estimateFor(size: number, codec: string | null): { estimatedBytes: number; estimatedSaving: number } {
  const estimatedBytes = Math.round(size * expectedRatio(codec));
  return { estimatedBytes, estimatedSaving: Math.max(0, size - estimatedBytes) };
}

/** Files in the scan worth probing, largest first, before any tool is run. */
export function shortlistFromScan(source: TreeSource, ignore: CompiledIgnore[], limit = 200): Array<{ path: string; name: string; size: number; modifiedAt: number }> {
  const store: ScanStore = asStore(source);
  const out: Array<{ path: string; name: string; size: number; modifiedAt: number }> = [];
  const visit = (node: number, nodePath: string): void => {
    for (const child of store.childIds(node)) {
      const name = store.name(child);
      const childPath = store.childPath(child, nodePath);
      if (matchesAny(ignore, childPath, name)) continue;
      if (store.isDir(child)) { visit(child, childPath); continue; }
      if (store.size(child) < MIN_CANDIDATE_BYTES) continue;
      const ext = store.extension(child);
      if (!ext || !VIDEO_EXT.has(ext)) continue;
      out.push({ path: childPath, name, size: store.size(child), modifiedAt: store.modifiedAt(child) });
    }
  };
  visit(store.rootId, store.rootPath);
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

/** True when re-encoding this file is worth offering. */
export function isWorthEncoding(probe: MediaProbe | null): boolean {
  if (!probe || !probe.videoCodec) return false;
  return IMPROVABLE_CODECS.has(probe.videoCodec.toLowerCase());
}

/* ────────────────────────── verification ────────────────────────── */

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Is the encode good enough to replace the original?
 *
 * Every check here exists because its absence would let a broken file replace a
 * good one. Duration is the important one: a truncated encode is the classic
 * ffmpeg failure and it looks perfectly fine until you play the end.
 */
export function verifyEncode(
  original: MediaProbe | null,
  encoded: MediaProbe | null,
  originalBytes: number,
  encodedBytes: number,
): VerificationResult {
  if (!encoded) return { ok: false, reason: 'the new file could not be opened' };
  if (encodedBytes <= 0) return { ok: false, reason: 'the new file is empty' };
  if (encodedBytes >= originalBytes) {
    return { ok: false, reason: 'the new file is not smaller than the original' };
  }
  if (original?.durationSeconds && encoded.durationSeconds) {
    const drift = Math.abs(original.durationSeconds - encoded.durationSeconds);
    // A second, or 1% for long films — anything more means it was cut short.
    const allowed = Math.max(1, original.durationSeconds * 0.01);
    if (drift > allowed) {
      return {
        ok: false,
        reason: `the new file is ${drift.toFixed(1)}s ${encoded.durationSeconds < original.durationSeconds ? 'shorter' : 'longer'} than the original`,
      };
    }
  } else if (original?.durationSeconds && !encoded.durationSeconds) {
    return { ok: false, reason: 'the new file reports no duration' };
  }
  if (original?.frameCount && encoded.frameCount) {
    const ratio = encoded.frameCount / original.frameCount;
    if (ratio < 0.98 || ratio > 1.02) {
      return { ok: false, reason: `the new file has ${encoded.frameCount} frames where the original has ${original.frameCount}` };
    }
  }
  return { ok: true };
}

/* ────────────────────────── the real tools ────────────────────────── */

async function which(bin: string): Promise<boolean> {
  try {
    await exec(bin, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The encoder ffmpeg should use for `codec` on this platform. */
export function encoderFor(codec: 'hevc' | 'av1', platform: NodeJS.Platform): string {
  if (platform === 'darwin') return codec === 'hevc' ? 'hevc_videotoolbox' : 'av1_videotoolbox';
  if (platform === 'win32') return codec === 'hevc' ? 'hevc_qsv' : 'av1_qsv';
  return codec === 'hevc' ? 'hevc_vaapi' : 'av1_vaapi';
}

const realTools: MediaTools = {
  async availability(): Promise<EncoderAvailability> {
    const caps = await getCapabilities();
    const hw = caps.hardwareEncode;
    const state = await capabilityState('hardwareEncode');
    if (!(await which('ffprobe')) || !(await which('ffmpeg'))) {
      return {
        available: false,
        reason:
          'Re-encoding video needs ffmpeg, which is not installed. On a Mac you can add it with Homebrew: brew install ffmpeg. ' +
          'Everything else in TreeMap works without it.',
        encoder: null,
        hardwareCodecs: hw.codecs ?? [],
        mechanism: state.mechanism,
      };
    }
    if (!hw.available || !(hw.codecs ?? []).includes('hevc')) {
      return {
        available: false,
        // Software HEVC is 10–50× slower; offering it silently would turn a
        // cleanup into an afternoon.
        reason:
          hw.reason ||
          'This machine has no hardware HEVC encoder. TreeMap only offers hardware encoding, because doing it in software takes many times longer.',
        encoder: null,
        hardwareCodecs: hw.codecs ?? [],
        mechanism: state.mechanism,
      };
    }
    return {
      available: true,
      encoder: encoderFor('hevc', process.platform),
      hardwareCodecs: hw.codecs ?? [],
      mechanism: state.mechanism,
    };
  },

  async probe(file: string): Promise<MediaProbe | null> {
    try {
      const { stdout } = await exec(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
          'stream=codec_name,width,height,nb_frames,bit_rate:format=duration,bit_rate',
          '-of', 'json', file],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const doc = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
      const stream = doc.streams?.[0] ?? {};
      return {
        durationSeconds: num(doc.format?.duration),
        videoCodec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
        width: num(stream.width),
        height: num(stream.height),
        bitrateBps: num(stream.bit_rate) ?? num(doc.format?.bit_rate),
        frameCount: num(stream.nb_frames),
      };
    } catch {
      return null;
    }
  },

  encode(input, output, encoder, durationSeconds, onProgress, onSpawn): Promise<void> {
    return new Promise((resolve, reject) => {
      // `-map_metadata 0` carries creation dates and EXIF-equivalent tags over;
      // the file's own mtime is restored separately by the caller.
      const args = [
        '-nostdin', '-y', '-i', input,
        '-map', '0', '-map_metadata', '0', '-movflags', 'use_metadata_tags+faststart',
        '-c:v', encoder, '-tag:v', 'hvc1', '-b:v', '0', '-q:v', '55',
        '-c:a', 'copy', '-c:s', 'copy',
        '-progress', 'pipe:1', '-loglevel', 'error',
        output,
      ];
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      onSpawn?.(child);
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const m = /^out_time_ms=(\d+)/.exec(line.trim());
          if (m && durationSeconds) {
            onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSeconds));
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with ${code}`));
      });
    });
  },
};

let tools: MediaTools = realTools;
/** Test-only: swap the external tools for a fake so the pipeline can be driven. */
export function setMediaTools(next: MediaTools | null): void {
  tools = next ?? realTools;
}
export function mediaTools(): MediaTools {
  return tools;
}

/* ────────────────────────── the encode pipeline ────────────────────────── */

export interface EncodeOutcome {
  path: string;
  ok: boolean;
  originalBytes: number;
  newBytes: number;
  savedBytes: number;
  /** Present when `ok` is false. */
  error?: string;
}

/** A temp name beside the original, so promoting it is a same-directory rename. */
function tempNameFor(file: string, seq: number): string {
  return path.join(path.dirname(file), `.treemap-encode-${process.pid}-${seq}${path.extname(file) || '.mp4'}`);
}

/**
 * Re-encode ONE file. The ordering here is the safety guarantee:
 *
 *   encode beside → probe the result → verify → trash original → rename into
 *   place → restore timestamps
 *
 * Any failure before the trash step leaves the original untouched and removes
 * only the encode we ourselves just wrote.
 */
export async function encodeOne(
  file: string,
  encoder: string,
  seq: number,
  onProgress: (fraction: number) => void,
  /** Passed straight through to the encoder seam so a caller can kill it. */
  onSpawn?: (child: ChildProcess) => void,
): Promise<EncodeOutcome> {
  const media = mediaTools();
  const original = await fs.promises.stat(file);
  const originalBytes = original.size;
  const base: EncodeOutcome = { path: file, ok: false, originalBytes, newBytes: 0, savedBytes: 0 };

  const before = await media.probe(file);
  const temp = tempNameFor(file, seq);

  const discard = async (): Promise<void> => {
    // Removes only the file THIS function just created — never a user's.
    await fs.promises.unlink(temp).catch(() => undefined);
  };

  try {
    await media.encode(file, temp, encoder, before?.durationSeconds ?? null, onProgress, onSpawn);
  } catch (err) {
    await discard();
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  let newBytes = 0;
  try {
    newBytes = (await fs.promises.stat(temp)).size;
  } catch {
    await discard();
    return { ...base, error: 'the encoder produced no file' };
  }

  const after = await media.probe(temp);
  const verdict = verifyEncode(before, after, originalBytes, newBytes);
  if (!verdict.ok) {
    await discard();
    return { ...base, newBytes, error: `Kept the original — ${verdict.reason}.` };
  }

  // Only now is anything of the user's touched, and it goes to the Trash.
  const trashed = await moveToTrash([file]);
  if (!trashed.deleted.includes(file)) {
    await discard();
    const why = trashed.failed.find((f) => f.path === file)?.reason || 'the original could not be moved to the Trash';
    return { ...base, newBytes, error: `Kept the original — ${why}.` };
  }

  try {
    await fs.promises.rename(temp, file);
  } catch (err) {
    // The original is in the Trash and the encode is beside it. Nothing is
    // lost, but the user must be told exactly where both are.
    return {
      ...base,
      newBytes,
      error:
        `The original is in the Trash and the re-encoded file is at ${temp}, because it could not be renamed into place ` +
        `(${err instanceof Error ? err.message : String(err)}). Nothing was lost.`,
    };
  }
  // A photo library that loses its dates is a disaster.
  await fs.promises.utimes(file, original.atime, original.mtime).catch(() => undefined);

  return { path: file, ok: true, originalBytes, newBytes, savedBytes: originalBytes - newBytes };
}

/* ────────────────────────── the background job ────────────────────────── */

export interface EncodeJob {
  jobId: string;
  status: 'running' | 'complete' | 'error';
  total: number;
  done: number;
  /** 0–1 through the file currently encoding. */
  currentFraction: number;
  currentPath: string | null;
  results: EncodeOutcome[];
  savedBytes: number;
  error?: string;
  cancelled: boolean;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, EncodeJob>();
/**
 * The ffmpeg a running job currently owns, by jobId — kept beside the job
 * rather than on it, because `GET /api/compression/:jobId/result` serializes
 * the job straight to the client and a live subprocess is not job state a
 * browser should ever be handed.
 */
const activeChildren = new Map<string, ChildProcess>();
/** Jobs older than this are forgotten, like scans. */
const JOB_TTL_MS = 60 * 60_000;

export function getEncodeJob(jobId: string): EncodeJob | undefined {
  return jobs.get(jobId);
}

export function cancelEncodeJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  // The file currently encoding finishes its own verify/promote cycle — killing
  // ffmpeg mid-write and then promoting would be exactly the bug this feature
  // is built to avoid. Nothing after it is started.
  job.cancelled = true;
  return true;
}

/**
 * Kill the ffmpeg a job has in flight, if it has one.
 *
 * The kill surfaces as a rejected `media.encode`, which `encodeOne` already
 * treats as a failed encode: it discards the temp file it was writing and
 * leaves the original exactly where it was. So this adds no new failure path
 * — it just stops the wait. Returns false when there was nothing to kill,
 * which is the ordinary case (a job between files, or an already-finished one).
 */
export function abortEncodeChild(jobId: string): boolean {
  const child = activeChildren.get(jobId);
  if (!child) return false;
  activeChildren.delete(jobId);
  // SIGKILL, like the gdu shards: SIGTERM asks ffmpeg to finish and flush a
  // trailer, and shutdown has no time left to wait for that.
  child.kill('SIGKILL');
  return true;
}

/**
 * Cancel every running encode. Called on SIGTERM/SIGINT and on Electron quit,
 * alongside cancelAllScans and the rest.
 *
 * Shutdown differs from the user pressing Cancel, which is why the kill lives
 * here and not in `cancelEncodeJob`: a user who cancels is still sitting in
 * front of a running app, so the file already encoding is allowed to finish
 * its verify/promote cycle and actually save them the bytes. On shutdown there
 * is nobody left to finish it for — the process is going away, and an ffmpeg
 * that outlives it would keep rewriting the user's video unsupervised while
 * the event loop refuses to drain.
 *
 * Returns how many jobs were running, for the shutdown log.
 */
export function cancelAllEncodeJobs(): number {
  let cancelled = 0;
  for (const jobId of [...jobs.keys()]) {
    // One cancellation path, not two: cancelEncodeJob owns what "cancelled"
    // means and skips anything that is not running.
    if (!cancelEncodeJob(jobId)) continue;
    cancelled++;
    abortEncodeChild(jobId);
  }
  return cancelled;
}

/** Test-only: suites share a process and a leaked job would outlive its files. */
export function resetEncodeJobs(): void {
  jobs.clear();
  activeChildren.clear();
}

function sweepJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function startEncodeJob(jobId: string, paths: string[], encoder: string): EncodeJob {
  sweepJobs();
  const job: EncodeJob = {
    jobId, status: 'running', total: paths.length, done: 0, currentFraction: 0,
    currentPath: null, results: [], savedBytes: 0, cancelled: false, startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  void (async () => {
    try {
      let seq = 0;
      for (const file of paths) {
        if (job.cancelled) break;
        job.currentPath = file;
        job.currentFraction = 0;
        let outcome: EncodeOutcome;
        try {
          outcome = await encodeOne(
            file, encoder, seq++,
            (f) => { job.currentFraction = f; },
            // Registered for exactly as long as the process exists, so a
            // shutdown between files never signals a stale pid.
            (child) => { activeChildren.set(jobId, child); },
          );
        } finally {
          activeChildren.delete(jobId);
        }
        job.results.push(outcome);
        if (outcome.ok) job.savedBytes += outcome.savedBytes;
        job.done++;
        job.currentFraction = 1;
      }
      job.status = 'complete';
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.currentPath = null;
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

/* ────────────────────────── progress SSE clients ────────────────────────── */

/**
 * The live `/api/compression/:jobId/progress` streams, so shutdown can drain
 * them the way it already drains scan, watch, offload, index and capsule
 * streams. The registry lives here rather than in insightRoutes because that
 * router also serves a dozen unrelated endpoints, and because the encode job
 * it reports on lives here.
 *
 * The poll timer is held with the response deliberately: an SSE endpoint whose
 * interval is never cleared keeps the event loop alive after `server.close()`,
 * which is the difference between a process that exits on SIGTERM and one the
 * user has to kill.
 */
interface EncodeSseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<EncodeSseClient>();

function closeEncodeClient(client: EncodeSseClient): void {
  // Idempotent: the route hands its release to `req.on('close')`, which fires
  // the moment a drain ends the response — so the second call is the norm,
  // not an error, and must not end an already-ended stream again.
  if (!sseClients.delete(client)) return;
  clearInterval(client.timer);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/**
 * Register one progress stream and its poll timer. Returns the release to call
 * when the stream ends on its own — the client disconnecting, or the job
 * finishing — so shutdown never finds a stale entry.
 */
export function registerEncodeClient(res: Response, timer: NodeJS.Timeout): () => void {
  const client: EncodeSseClient = { res, timer };
  sseClients.add(client);
  return () => closeEncodeClient(client);
}

/** Called on SIGTERM by the graceful-shutdown path, like every other stream. */
export function drainEncodeClients(): void {
  for (const client of [...sseClients]) {
    try {
      sseSend(client.res, { type: 'shutdown' });
    } catch {
      /* socket already dead — the rest still have to be released */
    }
    closeEncodeClient(client);
  }
}

export function activeEncodeSseCount(): number {
  return sseClients.size;
}
