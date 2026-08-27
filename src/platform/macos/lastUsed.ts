import { runText, CommandUnavailableError } from '../exec';
import { runPlist } from './plist';
import {
  ATIME_CAVEAT, lastUsedFromAtime, parseBsdMount, mountForPath, atimeSupportFromOptions, readAtime,
} from '../atime';
import type { CapabilityState, LastUsedInfo } from '../types';
import { mapConcurrent } from '../../utils/concurrency';

/**
 * Last-opened dates on macOS (v4 §1.1).
 *
 * ── What was measured on this Mac, before any of this was written ──
 *
 * The obvious implementation — batch `mdls -name kMDItemLastUsedDate -name
 * kMDItemUseCount` over the paths — does not work here, and would have shipped
 * a feature that silently returns nothing:
 *
 *  - `mdutil -s /` reports **"Indexing enabled"**, so Spotlight is on.
 *  - `mdimport -A` lists `kMDItemLastUsedDate` as a known attribute, so it is
 *    not that the attribute was removed.
 *  - And yet `mdfind 'kMDItemLastUsedDate > "2020-01-01"'` matches **zero
 *    files on the entire machine**, and `mdls` returns an empty dict for every
 *    path tried, including `/Applications/Safari.app`. Apple no longer
 *    populates it.
 *
 * A capability probe based on `mdutil` alone would therefore report this
 * feature as *available* and then answer "unknown" for every file forever —
 * the exact failure §2.4 exists to prevent. Availability is decided by
 * whether Spotlight actually **answers**, not by whether it is switched on.
 *
 *  - `mdls` costs **~0.36 ms per path** batched (2,000 paths in 717 ms), which
 *    on its own blows §2.5's 400 ms sidecar budget.
 *  - `lstat` costs **~0.0015 ms per path** (5,000 paths in 7.4 ms).
 *
 * So access time is the default source and Spotlight is an enrichment that has
 * to earn its 240x cost by demonstrating, on a bounded sample, that it has
 * anything to say. Access time is live here: a read advanced `atime` by two
 * seconds on this APFS volume, verified directly.
 *
 * ── The `mdls` batching traps ──
 *
 * 1. `mdls -plist - a b c` emits an **array of dicts, positionally matching
 *    the input paths**. That is the only thing tying an answer to a path —
 *    the dicts carry no path of their own.
 * 2. **One missing path destroys the whole batch.** With any argument that
 *    does not exist, `mdls` abandons the plist entirely, prints
 *    `could not find /x.` as plain text, and **exits 0**. Every valid path in
 *    that batch loses its answer, silently. Paths are therefore stat'd first
 *    and only the survivors are sent, and a result whose length does not match
 *    is discarded rather than mis-zipped.
 * 3. An attribute with no value is **absent from the dict**, not null. An
 *    empty dict is the normal case, not an error.
 */

/* ------------------------------ pure parsers ------------------------------ */

/** One `mdls -plist -` dict. Keys are absent, never null, when unset. */
export interface MdlsEntry {
  kMDItemLastUsedDate?: unknown;
  kMDItemUseCount?: unknown;
}

/**
 * Zip a positional `mdls` array back onto the paths that produced it.
 *
 * Returns null — meaning "this batch is unusable" — when the array is not an
 * array or its length does not match. Length mismatch is the observable
 * signature of trap 2 above, and guessing an alignment would attach one file's
 * date to another file's row.
 */
export function parseMdlsBatch(raw: unknown, paths: string[]): Map<string, { lastUsedMs: number; useCount: number | null }> | null {
  // With exactly ONE path, `mdls -plist -` emits a bare dict rather than a
  // one-element array — verified directly against the real tool.
  //
  // Requiring an array made every single-path batch return null, which the
  // probe below then memoised for the whole process as "Spotlight has nothing
  // to say". The most likely first request the UI makes — facts for one
  // selected file — therefore disabled Spotlight permanently and displayed a
  // sentence that was simply false.
  const rows = Array.isArray(raw) ? raw : (paths.length === 1 && raw && typeof raw === 'object' ? [raw] : null);
  if (!rows || rows.length !== paths.length) return null;

  const out = new Map<string, { lastUsedMs: number; useCount: number | null }>();
  for (let i = 0; i < paths.length; i++) {
    const entry = rows[i] as MdlsEntry | null;
    if (!entry || typeof entry !== 'object') continue;

    const when = entry.kMDItemLastUsedDate;
    // plutil renders plist dates as ISO strings. Accept only what genuinely
    // parses, so an unexpected shape becomes "unknown" rather than NaN.
    if (typeof when !== 'string') continue;
    const parsed = Date.parse(when);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;

    const rawCount = entry.kMDItemUseCount;
    const useCount = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0
      ? Math.round(rawCount)
      : null;

    out.set(paths[i], { lastUsedMs: parsed, useCount });
  }
  return out;
}

/**
 * Parse `mdutil -s <volume>`:
 *
 *     /:
 *         Indexing enabled.
 *
 *     /Volumes/Backup:
 *         Indexing disabled.
 *
 *     /Volumes/Ext:
 *         Indexing and searching disabled.
 *
 * Anything not recognisably "enabled" counts as not enabled — an unreadable
 * answer must not be optimistically read as working.
 */
export function parseMdutilStatus(text: string): boolean {
  const lower = text.toLowerCase();
  if (/indexing\s+(and\s+searching\s+)?disabled/.test(lower)) return false;
  return /indexing\s+enabled/.test(lower);
}

/* ------------------------------ the reader ------------------------------ */

/**
 * How many paths the Spotlight usefulness probe is allowed to cost.
 *
 * 128 paths is roughly 50 ms — cheap enough to spend once per scan, large
 * enough that a folder of genuinely-used files will trip it. It is a sample,
 * and what it concludes is worded as a sample ("in a sample of N files…"),
 * never as a claim about the whole disk.
 */
const SPOTLIGHT_PROBE_PATHS = 128;

/**
 * How many `lstat` calls are in flight at once.
 *
 * Deliberately well above the subprocess ceiling: these go to Node's
 * filesystem threadpool rather than spawning anything, so they do not contend
 * for the cores a `xattr` process needs. Measured over 5,000 paths: 43.9 ms
 * sequential, 16.5 ms at this width.
 */
const ATIME_CONCURRENCY = 32;

/**
 * How many paths one `mdls` invocation is given.
 *
 * Unchunked, a 2,000-path batch of long paths can exceed ARG_MAX; the spawn
 * fails, `runMdls` catches it, and Spotlight silently drops out of the answer
 * with no reason recorded. `tmutil` is chunked for the same reason.
 */
const MDLS_BATCH = 200;

/** Cached per process: re-probing per batch would undo the point of probing. */
let spotlightVerdict: { productive: boolean; note: string } | null = null;

/** Test seam — resets the once-per-process Spotlight verdict. */
export function resetSpotlightVerdictForTests(): void {
  spotlightVerdict = null;
}

async function runMdls(paths: string[]): Promise<Map<string, { lastUsedMs: number; useCount: number | null }> | null> {
  try {
    const raw = await runPlist<unknown>('mdls', [
      '-plist', '-', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount', '--', ...paths,
    ]);
    return parseMdlsBatch(raw, paths);
  } catch {
    // Spotlight off, mdls absent, a timeout, or the plain-text error from a
    // vanished path. All of them mean "no Spotlight answer for this batch",
    // and the caller falls through to access times.
    return null;
  }
}

/**
 * Does Spotlight actually answer on this machine? Probed once, on real paths.
 *
 * Deliberately not inferred from `mdutil`: on this Mac indexing is enabled and
 * the attribute is known, and Spotlight still has nothing to say.
 */
async function spotlightIsProductive(samplePaths: string[]): Promise<{ productive: boolean; note: string }> {
  if (spotlightVerdict) return spotlightVerdict;

  const sample = samplePaths.slice(0, SPOTLIGHT_PROBE_PATHS);
  const hits = sample.length > 0 ? await runMdls(sample) : null;

  if (hits && hits.size > 0) {
    spotlightVerdict = { productive: true, note: '' };
  } else {
    spotlightVerdict = {
      productive: false,
      note:
        `Spotlight returned no “last opened” dates for a sample of ${sample.length} file${sample.length === 1 ? '' : 's'} here, ` +
        'so TreeMap is using file access times instead.',
    };
  }
  return spotlightVerdict;
}

/**
 * Read last-used information for a batch of paths.
 *
 * Paths that do not exist are simply absent from the returned map — the caller
 * counts them as skipped. A path present with `source: 'none'` is different
 * again: it exists, and nothing is known about when it was opened.
 */
export async function readLastUsedMac(paths: string[]): Promise<Map<string, LastUsedInfo>> {
  const out = new Map<string, LastUsedInfo>();
  if (paths.length === 0) return out;

  // Stat first. This does three jobs at once: it establishes which paths still
  // exist (trap 2 — one missing path would destroy the whole mdls batch), it
  // supplies the access time that is the default source, and it costs
  // essentially nothing.
  // Concurrent rather than a sequential await per path. Node's filesystem
  // threadpool is four wide by default and a serial loop uses one of it:
  // measured over 5,000 paths, 43.9 ms sequential against 16.5 ms at 32 in
  // flight. Higher than IO_SUBPROCESS_CONCURRENCY on purpose — these are
  // threadpool lstat calls, not subprocesses, so they do not contend for
  // cores the way a spawned `xattr` does.
  const stats = await mapConcurrent(paths, ATIME_CONCURRENCY, (p) => readAtime(p));
  const alive: string[] = [];
  const atimes = new Map<string, number>();
  for (let i = 0; i < paths.length; i++) {
    const st = stats[i];
    if (!st) continue;
    alive.push(paths[i]);
    atimes.set(paths[i], st.atimeMs);
  }
  if (alive.length === 0) return out;

  // Per path, not per batch.
  //
  // Taking the first survivor's mount for everything meant a batch spanning a
  // normal volume and a `noatime` one either presented the noatime volume's
  // frozen atime as a last-opened date — mtime substitution, which §1.1
  // forbids outright — or, with the order reversed, blanked every good answer
  // in the batch. Mount options are cached, so asking per path is cheap.
  const noatimeByPath = new Map<string, string | null>();
  const reasons = await mapConcurrent(alive, ATIME_CONCURRENCY, (p) => noatimeReason(p));
  for (let i = 0; i < alive.length; i++) noatimeByPath.set(alive[i], reasons[i]);

  const verdict = await spotlightIsProductive(alive);

  let spotlight: Map<string, { lastUsedMs: number; useCount: number | null }> | null = null;
  if (verdict.productive) {
    spotlight = new Map();
    for (let i = 0; i < alive.length; i += MDLS_BATCH) {
      const chunk = await runMdls(alive.slice(i, i + MDLS_BATCH));
      if (chunk) for (const [k, v] of chunk) spotlight.set(k, v);
    }
  }

  for (const p of alive) {
    const hit = spotlight?.get(p);
    if (hit) {
      out.set(p, { lastUsedMs: hit.lastUsedMs, useCount: hit.useCount, source: 'spotlight' });
      continue;
    }
    const noatime = noatimeByPath.get(p) ?? null;
    if (noatime) {
      // Access times are frozen on this volume, so the number lstat returned
      // is not a last-used date. Saying nothing is the only honest answer.
      out.set(p, { lastUsedMs: null, useCount: null, source: 'none', caveat: noatime });
      continue;
    }
    const fallback = lastUsedFromAtime(atimes.get(p) ?? null);
    if (fallback.source === 'atime' && verdict.note) {
      fallback.caveat = `${verdict.note} ${ATIME_CAVEAT}`;
    }
    out.set(p, fallback);
  }
  return out;
}

/** Mount table, cached briefly: asking per path must not mean a subprocess per path. */
let mountCache: { at: number; entries: ReturnType<typeof parseBsdMount> } | null = null;
const MOUNT_TTL_MS = 30_000;

/** Test seam — drops the cached mount table. */
export function resetMountCacheForTests(): void { mountCache = null; }

/** `noatime` on this path's volume, as a reason string — or null when fine. */
async function noatimeReason(samplePath: string): Promise<string | null> {
  try {
    const now = Date.now();
    if (!mountCache || now - mountCache.at > MOUNT_TTL_MS) {
      mountCache = { at: now, entries: parseBsdMount(await runText('mount', [], { timeoutMs: 5_000 })) };
    }
    const entries = mountCache.entries;
    const mount = mountForPath(entries, samplePath);
    if (!mount) return null;
    const support = atimeSupportFromOptions(mount.options);
    return support.usable ? null : (support.reason ?? null);
  } catch {
    // `mount` is not something a Mac lacks; if it fails, assume nothing and
    // let the access time speak with its usual caveat.
    return null;
  }
}

/* ------------------------------ the probe ------------------------------ */

/**
 * The `lastUsed` capability on macOS.
 *
 * Reports *available* whenever some source can answer, and names which one —
 * because reporting unavailable here would mean this Mac, where access times
 * work perfectly well, showed nothing at all. `degradedTo` carries the
 * distinction rather than a boolean pretending there is only one mechanism.
 */
export async function probeLastUsedMac(): Promise<CapabilityState> {
  let indexing = false;
  try {
    indexing = parseMdutilStatus(await runText('mdutil', ['-s', '/'], { timeoutMs: 5_000 }));
  } catch (err) {
    if (!(err instanceof CommandUnavailableError)) indexing = false;
  }

  if (!indexing) {
    return {
      available: true,
      mechanism: 'file access time',
      degradedTo: 'file access time',
      reason:
        'Spotlight indexing is switched off for this disk, so macOS is not recording which files you open. ' +
        'TreeMap falls back to file access times, which are close but also move when a backup or search index reads a file.',
    };
  }
  return {
    available: true,
    mechanism: 'Spotlight (kMDItemLastUsedDate), falling back to file access time',
  };
}
