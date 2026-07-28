import { runText, CommandUnavailableError } from '../exec';
import { runPlist } from './plist';
import type { ProvenanceInfo } from '../types';

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
