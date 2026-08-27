import { promises as fsp } from 'fs';
import type { DownloadOriginBatch, DownloadOriginBrief, ProvenanceInfo } from '../types';

/**
 * Download provenance on Windows (C3) via the `Zone.Identifier` alternate data
 * stream.
 *
 * Mechanism choice (§2.3): **tier 1 — no subprocess at all.** NTFS exposes an
 * alternate data stream as `<path>:<stream>`, and Node's ordinary `readFile`
 * opens it directly. So this is a plain file read, which also makes it the one
 * Windows mechanism in this layer that is fully unit-testable from any OS: the
 * parser below takes a string.
 *
 * The stream is INI-shaped:
 *
 *     [ZoneTransfer]
 *     ZoneId=3
 *     ReferrerUrl=https://example.com/page
 *     HostUrl=https://cdn.example.com/file.zip
 *
 * `HostUrl` is the file's own URL; `ReferrerUrl` is the page it came from.
 * Mapping them the other way round — easy to do, since "referrer" sounds like
 * the source — makes the UI show a CDN URL as the page the user visited.
 *
 * Windows records no download *timestamp* here. The file's mtime is not one
 * (an edit changes it), so `downloadedAt` is honestly null rather than a
 * plausible-looking guess.
 *
 * SECURITY (§C3): these values are attacker-controllable — a downloaded file
 * carries whatever URL the server chose. Never fetched, escaped on render, and
 * kept out of the logs (§6).
 */

const STREAM_SUFFIX = ':Zone.Identifier';

/**
 * Parse a Zone.Identifier stream.
 *
 * Tolerates what real streams actually contain: CRLF endings, a UTF-16 BOM,
 * keys in any case, values containing `=`, and unknown extra keys.
 * Exported — this is the whole mechanism, so testing it is testing the feature.
 */
export function parseZoneIdentifier(raw: string): { hostUrl: string | null; referrerUrl: string | null; zoneId: number | null } {
  let hostUrl: string | null = null;
  let referrerUrl: string | null = null;
  let zoneId: number | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    // Values are URLs and contain '=' freely, so split on the FIRST '=' only.
    const value = trimmed.slice(eq + 1).trim();
    if (value.length === 0) continue;

    if (key === 'hosturl') hostUrl = value;
    else if (key === 'referrerurl') referrerUrl = value;
    else if (key === 'zoneid') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) zoneId = n;
    }
  }
  return { hostUrl, referrerUrl, zoneId };
}

/** Host of a URL, or null. Never throws on hostile input. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export async function downloadOrigin(path: string): Promise<ProvenanceInfo | null> {
  let raw: string;
  try {
    // A BOM is common here; 'utf8' leaves it as U+FEFF, stripped below.
    raw = await fsp.readFile(path + STREAM_SUFFIX, 'utf8');
  } catch {
    // No stream: the file was not downloaded, or lives on a filesystem with no
    // alternate data streams (FAT32, exFAT, a network share). Either way there
    // is genuinely nothing recorded — which the UI states outright.
    return null;
  }

  const { hostUrl, referrerUrl } = parseZoneIdentifier(raw.replace(/^﻿/, ''));
  if (hostUrl === null && referrerUrl === null) return null;

  // HostUrl is the file's own address; ReferrerUrl is the page it came from.
  const url = hostUrl ?? referrerUrl;
  return {
    url,
    host: hostOf(url),
    referrer: hostUrl !== null ? referrerUrl : null,
    downloadedAt: null,
    mechanism: 'Zone.Identifier alternate data stream',
  };
}

/* ══════════════ Bulk download records for the Reclaim Score (v4 §3.1) ══════════════ */

/**
 * How many streams are read at once.
 *
 * These are plain file reads, so the limit is file descriptors rather than
 * process spawns — 64 keeps a 2,000-path batch well inside any default
 * handle budget while still saturating the disk queue.
 */
const ZONE_CONCURRENCY = 64;

/**
 * Download records for many paths at once.
 *
 * Windows is the cheap case: there is no subprocess to batch, because an
 * alternate data stream is an ordinary file. The whole reader is `readFile`
 * run with a concurrency limit.
 *
 * The distinction that matters is which error means what. `ENOENT` on the
 * stream is the ordinary answer — the file was not downloaded, or it lives on
 * a filesystem with no alternate data streams — and that is *checked, no
 * record*. Anything else (a permission refusal, an I/O error) is **unknown**,
 * and goes to `unchecked` so the score reports the component as missing
 * rather than as "this was never downloaded".
 */
export async function readDownloadOriginsWindows(paths: string[]): Promise<DownloadOriginBatch> {
  const origins = new Map<string, DownloadOriginBrief>();
  const unchecked = new Set<string>();
  const mechanism = 'Zone.Identifier alternate data stream';

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const p = paths[next++];
      let raw: string;
      try {
        raw = await fsp.readFile(p + STREAM_SUFFIX, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT: no stream, which is a real "not downloaded". Anything else
        // is a failure to look, and must not be scored as an absence.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') unchecked.add(p);
        continue;
      }
      const { hostUrl, referrerUrl } = parseZoneIdentifier(raw.replace(/^﻿/, ''));
      const url = hostUrl ?? referrerUrl;
      if (url === null) continue; // a stream with no URL records nothing
      origins.set(p, {
        host: hostOf(url),
        // No Windows mechanism records a download timestamp. The file's own
        // mtime would be a plausible-looking lie — an edited file's mtime has
        // nothing to do with when it was downloaded.
        downloadedAt: null,
        agent: null,
        mechanism,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(ZONE_CONCURRENCY, paths.length) }, worker));
  return { available: true, origins, unchecked, mechanism };
}
