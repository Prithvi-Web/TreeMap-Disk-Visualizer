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
 *  - And yet `mdfind 'kMDItemLastUsedDate > "2020-01-01"'` matched **zero
 *    files on the entire machine** when this was written, and `mdls` returned
 *    an empty dict for every path tried, including `/Applications/Safari.app`.
 *  - Measured again on macOS 27 (review F1.2/F1.3, HC2-L3): for a path
 *    Spotlight does not index, `mdls` reports a `kMDItemLastUsedDate` that is
 *    its content modification date, with no use count. A file touched to 2019
 *    is "last used" in 2019, an append from a shell moves the date on and a
 *    read does not. An indexed file no app has opened (`/etc/hosts`) gets no
 *    date at all, and bundles and documents an app opened get a date with a
 *    use count (`/Applications/Claude.app`). A stand-in date is no record of
 *    an opening, so a last-used date within a second of the file's own
 *    modification or creation date, with no use count, is dropped and the
 *    file falls through to its access time (`parseMdlsBatch`).
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
  kMDItemContentModificationDate?: unknown;
  kMDItemContentCreationDate?: unknown;
  kMDItemFSContentChangeDate?: unknown;
  kMDItemFSCreationDate?: unknown;
}

/**
 * The file's own dates, as Spotlight gives them beside its last-used date (review F1.2/F1.3).
 *
 * For a path Spotlight does not index, mdls reports `kMDItemLastUsedDate` as the content
 * modification date, with no use count — measured on macOS 27 (review HC2-L3). A last-used date within a second of any of these
 * is therefore Spotlight's stand-in, not an opening: taken as one, the modification time became the
 * last-opened date, which §1.1 forbids outright. Within a second, because plist dates carry whole
 * seconds while the file system keeps fractions.
 */
const STAND_IN_DATE_KEYS = [
  'kMDItemContentModificationDate', 'kMDItemContentCreationDate', 'kMDItemFSContentChangeDate', 'kMDItemFSCreationDate',
] as const;
const SAME_SECOND_MS = 1000;

/** Is this last-used date only one of the file's own modification or creation dates? */
function isStandInDate(entry: MdlsEntry, lastUsedMs: number): boolean {
  return STAND_IN_DATE_KEYS.some((key) => {
    const raw = entry[key];
    const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isFinite(at) && Math.abs(at - lastUsedMs) < SAME_SECOND_MS;
  });
}

/**
 * Zip a positional `mdls` array back onto the paths that produced it.
 *
 * Returns null — meaning "this batch is unusable" — when the array is not an
 * array or its length does not match. Length mismatch is the observable
 * signature of trap 2 above, and guessing an alignment would attach one file's
 * date to another file's row.
 */
export function parseMdlsBatch(
  raw: unknown,
  paths: string[],
  tally?: { dated: number },
): Map<string, { lastUsedMs: number; useCount: number | null }> | null {
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
    // Spotlight gave this row a date, an opening or a stand-in: the probe reads that it answers (review HC2-L1).
    if (tally) tally.dated++;

    const rawCount = entry.kMDItemUseCount;
    const useCount = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0
      ? Math.round(rawCount)
      : null;

    // A date Spotlight counted uses for is a recorded opening, whatever it equals. One with no use
    // count that is only the file's own modification or creation date is no opening (review
    // F1.2/F1.3): the path is left out, and falls through to its access time with that caveat.
    if (!(useCount !== null && useCount > 0) && isStandInDate(entry, parsed)) continue;

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
 * 128 paths is roughly 50 ms — cheap enough to spend on each request until
 * Spotlight has shown it records openings here, large enough that a folder of
 * genuinely-used files will trip it. It is a sample, and what it concludes is
 * worded as a sample ("…any of a sample of N files here…"), never as a claim
 * about the whole disk.
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

/**
 * Cached per process, once it holds for every request (spotlightIsProductive): Spotlight recorded an
 * opening here, or `mdls` failed to answer MDLS_FAILURES_BEFORE_OFF probes in a row.
 */
let spotlightVerdict: { productive: boolean; note: string } | null = null;

/**
 * How many probes in a row `mdls` may fail to answer before it is not asked again in this process.
 * One failure is often a file that vanished between the stat and `mdls` (trap 2), or a slow moment;
 * three in a row is an `mdls` that does not work here, and each try can cost its whole timeout.
 */
const MDLS_FAILURES_BEFORE_OFF = 3;
let mdlsFailuresInARow = 0;

/** Test seam — resets the once-per-process Spotlight verdict and the count of probes mdls did not answer. */
export function resetSpotlightVerdictForTests(): void {
  spotlightVerdict = null;
  mdlsFailuresInARow = 0;
}

/** Runs `mdls` with these arguments and answers its plist as JSON. */
type MdlsRunner = (args: string[]) => Promise<unknown>;
const realMdlsRunner: MdlsRunner = (args) => runPlist<unknown>('mdls', args);
let mdlsRunner: MdlsRunner = realMdlsRunner;

/**
 * Test seam — stands in for `mdls -plist -`; returns a function that puts the real one back. The real
 * one, not whatever was installed before: node:test runs a test's after hooks first in, first out, so
 * a test that installs two stubs would otherwise restore the first stub last (review F1.3/F1.10 of HZ).
 */
export function setMdlsRunnerForTests(fn: MdlsRunner): () => void {
  mdlsRunner = fn;
  return () => { mdlsRunner = realMdlsRunner; };
}

async function runMdls(
  paths: string[],
  tally?: { dated: number },
): Promise<Map<string, { lastUsedMs: number; useCount: number | null }> | null> {
  try {
    // The file's own dates come too: a last-used date that is only one of them is no opening (review F1.2/F1.3).
    const raw = await mdlsRunner([
      '-plist', '-', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount',
      ...STAND_IN_DATE_KEYS.flatMap((key) => ['-name', key]), '--', ...paths,
    ]);
    return parseMdlsBatch(raw, paths, tally);
  } catch {
    // Spotlight off, mdls absent, a timeout, or the plain-text error from a
    // vanished path. All of them mean "no Spotlight answer for this batch",
    // and the caller falls through to access times.
    return null;
  }
}

/** What one request's probe found: whether to ask its other files, and what it already learnt of its sample. */
interface SpotlightProbe {
  /** Spotlight recorded an opening here (kept for the process). */
  productive: boolean;
  /** Said beside an access time that stands in, or '' when Spotlight answers here. */
  note: string;
  /** Ask the request's files past the sample too. */
  askRest: boolean;
  /** How many of the request's first files the probe asked, and the openings it found among them. */
  sampled: number;
  hits: Map<string, { lastUsedMs: number; useCount: number | null }> | null;
}

/**
 * Does Spotlight actually answer on this machine? Probed on real paths. Only an answer that holds for
 * every request is kept for the process: Spotlight recorded an opening, or `mdls` failed to answer
 * three probes running. A sample with no opening decides nothing for the next request, whose files
 * may be opened ones — on macOS 27 only files an app opened have records (review HC2-L1, F1.2/F1.5 of HZ).
 *
 * Deliberately not inferred from `mdutil`: on this Mac indexing is enabled and
 * the attribute is known, and Spotlight still has nothing to say — or, on
 * macOS 27, says only the files' own modification dates, which
 * `parseMdlsBatch` does not count as openings (review F1.2/F1.3).
 */
async function spotlightIsProductive(samplePaths: string[]): Promise<SpotlightProbe> {
  if (spotlightVerdict) return { ...spotlightVerdict, askRest: spotlightVerdict.productive, sampled: 0, hits: null };

  const sample = samplePaths.slice(0, SPOTLIGHT_PROBE_PATHS);
  const files = `${sample.length} file${sample.length === 1 ? '' : 's'}`;
  const tally = { dated: 0 };
  const hits = sample.length > 0 ? await runMdls(sample, tally) : null;

  if (!hits) {
    // mdls did not answer: said as that, never as "no record" (review F1.5 of HZ).
    mdlsFailuresInARow++;
    const off = mdlsFailuresInARow >= MDLS_FAILURES_BEFORE_OFF;
    const note = off
      ? `Spotlight did not answer the last ${MDLS_FAILURES_BEFORE_OFF} times TreeMap asked, so TreeMap is using file access times instead.`
      : `Spotlight did not answer for a sample of ${files} here, so TreeMap is using file access times instead.`;
    if (off) spotlightVerdict = { productive: false, note };
    return { productive: false, note, askRest: false, sampled: sample.length, hits: null };
  }
  mdlsFailuresInARow = 0;
  if (hits.size > 0) {
    spotlightVerdict = { productive: true, note: '' };
    return { productive: true, note: '', askRest: true, sampled: sample.length, hits };
  }
  return {
    productive: false,
    note: `Spotlight gave no record of an app opening any of a sample of ${files} here, so TreeMap is using file access times instead.`,
    // Dates that were all stand-ins are a folder Spotlight does not index, and say nothing of the
    // request's other files: they are asked too, so an opened one among them has its opening. A sample
    // given no date at all costs the request no more than the probe (review F1.2 of HZ).
    askRest: tally.dated > 0,
    sampled: sample.length,
    hits,
  };
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

  const probe = await spotlightIsProductive(alive);
  let note = probe.note;

  let spotlight: Map<string, { lastUsedMs: number; useCount: number | null }> | null = null;
  if (probe.askRest) {
    // The sample's answers are kept, so no file is asked twice.
    spotlight = new Map(probe.hits ?? []);
    for (let i = probe.sampled; i < alive.length; i += MDLS_BATCH) {
      const chunk = await runMdls(alive.slice(i, i + MDLS_BATCH));
      if (chunk) for (const [k, v] of chunk) spotlight.set(k, v);
    }
    // An opening found past the sample shows Spotlight records them here.
    if (spotlight.size > 0) {
      spotlightVerdict = { productive: true, note: '' };
      note = '';
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
    if (fallback.source === 'atime' && note) {
      fallback.caveat = `${note} ${ATIME_CAVEAT}`;
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
