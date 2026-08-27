import { runText, CommandUnavailableError, CommandFailedError } from '../exec';
import { runPlist } from './plist';
import { IO_SUBPROCESS_CONCURRENCY, chunk, mapConcurrent } from '../../utils/concurrency';
import type { DownloadOriginBatch, DownloadOriginBrief, ProvenanceInfo } from '../types';

/**
 * Download provenance on macOS (C3).
 *
 * Mechanism choice (§2.3): tier 3, system binaries — `mdls` for the origin URL
 * and `xattr` for the quarantine record. Both are structured reads: `mdls`
 * emits a plist that plutil converts to JSON (see ./plist.ts), and the
 * quarantine value is a fixed four-field record, not prose.
 *
 * ── Measured on macOS 15, against a real Chrome download ──
 *
 * - `kMDItemWhereFroms` is an *array*: element 0 is the direct download URL,
 *   element 1 (when present) is the page it was linked from. Mapping element 1
 *   to `referrer` is what makes the UI able to say "from docs.google.com"
 *   instead of showing a 900-character signed CDN URL.
 *
 * - `kMDItemDownloadedDate` reads `(null)` even on genuinely downloaded files,
 *   so relying on it alone — as the obvious implementation would — yields "no
 *   date" for most real downloads. `com.apple.quarantine` carries the truth:
 *   `flags;hexUnixSeconds;appName;uuid`. That gives both an accurate date *and*
 *   the downloading application, which `kMDItem*` never exposes. The Spotlight
 *   date is still read first and used when it is actually populated.
 *
 * Unavailable when: Spotlight indexing is off for the volume (external and
 * network disks commonly), in which case `mdls` returns nulls. The quarantine
 * xattr survives that, so a file can still report *when* and *by which app*
 * even with no URL — reported honestly rather than as a blank.
 *
 * SECURITY (§C3): the URL is untrusted input. It is never fetched, never
 * rendered as a live link without confirmation, escaped on render, and — per
 * §6's logging rule — never written to the log.
 */

interface MdlsPlist {
  kMDItemWhereFroms?: unknown;
  kMDItemDownloadedDate?: unknown;
}

/**
 * Parse a `com.apple.quarantine` value.
 *
 * Format: `flags;hexUnixSeconds;agentName;uuid` — e.g.
 * `0281;6a3cbf22;Chrome;E30D49EA-…`. Exported for unit testing, since fabricating
 * a real quarantine xattr in a test fixture is awkward and this is where the
 * date arithmetic can go wrong.
 */
export function parseQuarantine(raw: string): { downloadedAt: number | null; agent: string | null } {
  const parts = raw.trim().split(';');
  if (parts.length < 3) return { downloadedAt: null, agent: null };
  const seconds = Number.parseInt(parts[1], 16);
  const agent = parts[2]?.trim() || null;
  return {
    downloadedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    agent,
  };
}

/** Host of a URL, or null when it doesn't parse. Never throws on hostile input. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Pull the first string out of whatever shape kMDItemWhereFroms came back as. */
function stringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [];
}

async function readQuarantine(path: string): Promise<{ downloadedAt: number | null; agent: string | null }> {
  try {
    const raw = await runText('xattr', ['-p', 'com.apple.quarantine', '--', path], { timeoutMs: 5_000 });
    return parseQuarantine(raw);
  } catch {
    return { downloadedAt: null, agent: null }; // no quarantine record: not downloaded, or cleared
  }
}

export async function downloadOrigin(path: string): Promise<ProvenanceInfo | null> {
  let spotlight: MdlsPlist = {};
  try {
    spotlight = await runPlist<MdlsPlist>('mdls', [
      '-plist',
      '-',
      '-name',
      'kMDItemWhereFroms',
      '-name',
      'kMDItemDownloadedDate',
      '--',
      path,
    ]);
  } catch (err) {
    if (err instanceof CommandUnavailableError) return null;
    // Spotlight off for this volume — the quarantine record may still answer.
  }

  const froms = stringsFrom(spotlight.kMDItemWhereFroms);
  const url = froms[0] ?? null;
  const referrer = froms[1] ?? null;

  const quarantine = await readQuarantine(path);

  // mdls renders dates as ISO-ish strings once converted; accept only a value
  // that actually parses, so an unexpected shape becomes "unknown" not NaN.
  let downloadedAt: number | null = null;
  const rawDate = spotlight.kMDItemDownloadedDate;
  if (typeof rawDate === 'string') {
    const parsed = Date.parse(rawDate);
    if (Number.isFinite(parsed)) downloadedAt = parsed;
  }
  if (downloadedAt === null) downloadedAt = quarantine.downloadedAt;

  // Nothing at all is a real answer: "this file has no provenance record",
  // which the UI states outright rather than showing empty fields (§C3).
  if (url === null && downloadedAt === null && quarantine.agent === null) return null;

  return {
    url,
    host: hostOf(url),
    referrer,
    downloadedAt,
    mechanism: url !== null ? 'kMDItemWhereFroms + com.apple.quarantine' : 'com.apple.quarantine',
  };
}

/* ══════════════ Bulk download records for the Reclaim Score (v4 §3.1) ══════════════ */

/**
 * How many paths one `xattr` invocation is given.
 *
 * ARG_MAX is 1 MiB on macOS and 2,000 absolute paths measured 255 KB, so this
 * is not tight — but `mdls` and `tmutil` are both chunked for exactly this
 * reason, and a spawn that fails on ARG_MAX loses the whole batch silently.
 *
 * Deliberately left at 500 after measuring: the batch-size axis is nearly
 * flat (one spawn for 5,000 paths took 155 ms against 167 ms for ten, so a
 * spawn is ~1.2 ms and the cost is the syscalls inside it). Raising this
 * would have bought about 7% while pushing argv toward ARG_MAX on deeply
 * nested trees. The 2.3x is in running the chunks concurrently instead —
 * see `IO_SUBPROCESS_CONCURRENCY`.
 */
const XATTR_BATCH = 500;

/**
 * Parse `xattr -p com.apple.quarantine -- <paths…>`.
 *
 * ── Three shapes, all verified against the real tool on macOS 15 ──
 *
 * 1. **Many paths** → one `\<path\>: \<value\>` line per file that has the
 *    attribute. Files without it produce nothing on stdout; their errors go
 *    to stderr.
 * 2. **Exactly one path** → the bare value, with **no path prefix at all** —
 *    the same shape trap `mdls` has, and the same fix: know how many paths
 *    were sent.
 * 3. **Any file lacking the attribute makes `xattr` exit 1**, which is the
 *    ordinary case rather than a failure. The exit code carries no
 *    information here; only stdout does. This is the `lsof` situation the
 *    exec helper's `CommandFailedError` was written for.
 *
 * Lines are matched against the paths that were actually requested rather
 * than split on the first colon: a filename may contain `: `, and splitting
 * would attach one file's download record to another file's row.
 */
export function parseXattrBatch(stdout: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const text = stdout.replace(/\r\n/g, '\n');

  if (paths.length === 1) {
    const value = text.trim();
    if (value.length > 0) out.set(paths[0], value);
    return out;
  }

  // Longest first, so a path that is a prefix of another cannot claim its
  // line — /a/b.txt must not swallow the record for /a/b.txt.download.
  const byLength = [...paths].sort((a, b) => b.length - a.length);

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const match = byLength.find((p) => line.startsWith(p + ': '));
    if (!match) continue;
    const value = line.slice(match.length + 2).trim();
    // An empty attribute is not a record. Storing it would make a file with a
    // blank quarantine value look like a download whose date nobody knows.
    if (value.length > 0 && !out.has(match)) out.set(match, value);
  }
  return out;
}

/** One chunk, tolerating the exit-1-with-good-stdout case. */
async function runXattr(paths: string[]): Promise<Map<string, string> | null> {
  try {
    const raw = await runText('xattr', ['-p', 'com.apple.quarantine', '--', ...paths], { timeoutMs: 10_000 });
    return parseXattrBatch(raw, paths);
  } catch (err) {
    if (err instanceof CommandUnavailableError) return null;
    // Exit 1 means "at least one of these files has no quarantine record",
    // which is the normal case — every file that DOES have one is already on
    // stdout. Reading the exit code as failure here would report a whole
    // batch as unknown whenever a single ordinary file appeared in it.
    if (err instanceof CommandFailedError) return parseXattrBatch(err.stdout, paths);
    return null;
  }
}

/**
 * Download records for a batch of paths, from the quarantine xattr alone.
 *
 * No `mdls`, so no origin URL — see `DownloadOriginBrief` for why. What this
 * does supply is the downloading application and an accurate date, which is
 * what the score's `why` line needs to read as a sentence: "downloaded by
 * Chrome 14 months ago".
 */
export async function readDownloadOriginsMac(paths: string[]): Promise<DownloadOriginBatch> {
  const origins = new Map<string, DownloadOriginBrief>();
  const unchecked = new Set<string>();
  const mechanism = 'com.apple.quarantine';
  if (paths.length === 0) return { available: true, origins, unchecked, mechanism };

  // Concurrent, because each `xattr` sits in blocking filesystem syscalls and
  // one-at-a-time leaves the other cores idle. Measured: 168 ms sequential
  // versus 74 ms at four in flight, over 5,000 paths.
  const batches = chunk(paths, XATTR_BATCH);
  const results = await mapConcurrent(batches, IO_SUBPROCESS_CONCURRENCY, (batch) => runXattr(batch));

  // Folded back in input order, so the answer does not depend on which chunk
  // happened to finish first.
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const values = results[b];
    if (values === null) {
      // The whole chunk is unknown, not recordless. Which files in it had a
      // download record is exactly what we failed to learn.
      for (const p of batch) unchecked.add(p);
      continue;
    }
    for (const p of batch) {
      const raw = values.get(p);
      if (raw === undefined) continue; // checked, no record — a real answer
      const { downloadedAt, agent } = parseQuarantine(raw);
      if (downloadedAt === null && agent === null) continue; // unparseable is no record
      origins.set(p, { host: null, downloadedAt, agent, mechanism });
    }
  }

  // `xattr` missing entirely would be extraordinary on macOS, but if every
  // chunk failed there is nothing to report and saying so beats implying the
  // whole batch was downloaded by nobody.
  if (unchecked.size === paths.length) {
    return {
      available: false,
      reason: 'The quarantine records that say where a file was downloaded from could not be read on this Mac.',
      origins,
      unchecked,
      mechanism,
    };
  }
  return { available: true, origins, unchecked, mechanism };
}
