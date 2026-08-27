import { runText, CommandUnavailableError, CommandFailedError } from '../exec';
import type { DownloadOriginBatch, DownloadOriginBrief, ProvenanceInfo } from '../types';
import { IO_SUBPROCESS_CONCURRENCY, chunk, mapConcurrent } from '../../utils/concurrency';

/**
 * Download provenance on Linux (C3) via extended attributes.
 *
 * Mechanism choice (§2.3): tier 3, `getfattr` with `--only-values`, which emits
 * the raw attribute and nothing else — no prose to parse.
 *
 * ── The honesty requirement C3 calls out explicitly ──
 *
 * On Linux this data is *often simply absent*, and for a specific, nameable
 * reason: `user.xdg.origin.url` is a freedesktop convention that Chromium-based
 * browsers honour and **Firefox does not**. A file downloaded with Firefox has
 * no origin attribute at all, and never will.
 *
 * That distinction matters for the UI. "This file has no download record" is a
 * true statement about a Firefox download; "TreeMap could not read the download
 * record" would be false. So `absentReason` separates *nothing was ever
 * recorded* from *we could not look*, and C3's acceptance criterion — that a
 * file with no provenance says so rather than showing blanks — is met with the
 * right sentence rather than a generic one.
 *
 * SECURITY (§C3): the URL is untrusted input — never fetched, escaped on
 * render, and kept out of the logs entirely (§6).
 */

const ORIGIN_ATTR = 'user.xdg.origin.url';
const REFERRER_ATTR = 'user.xdg.referrer.url';

/** Read one xattr, or null when it isn't set. */
async function readAttr(path: string, attr: string): Promise<string | null> {
  try {
    const raw = await runText('getfattr', ['--only-values', '--absolute-names', '-n', attr, '--', path], {
      timeoutMs: 5_000,
    });
    const value = raw.trim();
    return value.length > 0 ? value : null;
  } catch {
    // getfattr exits non-zero when the attribute is absent, which is the
    // ordinary case — not an error worth surfacing.
    return null;
  }
}

/** Host of a URL, or null. Never throws, whatever the attribute contains. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export async function downloadOrigin(path: string): Promise<ProvenanceInfo | null> {
  const url = await readAttr(path, ORIGIN_ATTR);
  const referrer = await readAttr(path, REFERRER_ATTR);
  if (url === null && referrer === null) return null;

  return {
    url,
    host: hostOf(url),
    referrer,
    // No Linux convention records a download timestamp. Reporting the file's
    // own mtime here would be a plausible-looking lie: an edited file's mtime
    // has nothing to do with when it was downloaded.
    downloadedAt: null,
    mechanism: 'user.xdg.origin.url',
  };
}

/** Is the xattr tooling present at all? Distinguishes "absent" from "unreadable". */
export async function provenanceAvailable(): Promise<{ available: boolean; reason?: string }> {
  try {
    await runText('getfattr', ['--version'], { timeoutMs: 5_000 });
    return { available: true };
  } catch (err) {
    if (err instanceof CommandUnavailableError) {
      return {
        available: false,
        reason:
          'Reading where a file was downloaded from needs the attr package, which is not installed. Install it with your package manager (for example: sudo apt install attr).',
      };
    }
    return { available: true };
  }
}

/* ══════════════ Bulk download records for the Reclaim Score (v4 §3.1) ══════════════ */

/**
 * Paths per `getfattr` invocation. Chunked for ARG_MAX, as `mdls` and
 * `tmutil` are — a spawn that fails on argument length loses a whole batch
 * and records no reason for it.
 */
const GETFATTR_BATCH = 500;

/**
 * Decode one `getfattr` text value.
 *
 * The default `text` encoding wraps the value in double quotes and escapes
 * backslash, quote and every non-printable byte as a three-digit **octal**
 * sequence. Decimal would be the natural guess and would silently corrupt any
 * URL containing an escaped byte, so the radix is spelled out here.
 */
export function decodeGetfattrValue(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\(\\|"|[0-7]{3})/g, (_m, esc: string) => {
    if (esc === '\\') return '\\';
    if (esc === '"') return '"';
    return String.fromCharCode(Number.parseInt(esc, 8));
  });
}

/**
 * Parse a multi-file `getfattr` dump.
 *
 *     # file: /home/me/a.zip
 *     user.xdg.origin.url="https://example.com/a.zip"
 *
 *     # file: /home/me/b.iso
 *     user.xdg.origin.url="https://mirror.example.org/b.iso"
 *
 * Files with no such attribute produce **no block at all** — their complaint
 * goes to stderr — and `getfattr` then exits non-zero. As with `xattr` on
 * macOS and `lsof` before it, the exit code carries no information here and
 * stdout carries all of it.
 *
 * Returned paths are whatever the `# file:` header said, so the caller must
 * pass `--absolute-names`; without it getfattr strips the leading slash and
 * nothing would match the requested paths.
 */
export function parseGetfattrBatch(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;

  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^#\s*file:\s*(.+)$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current === null || line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== ORIGIN_ATTR) continue;
    const value = decodeGetfattrValue(line.slice(eq + 1));
    // First wins: a duplicated attribute in one block is malformed output,
    // and taking the last would let trailing junk overwrite a good value.
    if (value.length > 0 && !out.has(current)) out.set(current, value);
  }
  return out;
}

/** One chunk, tolerating the exit-non-zero-with-good-stdout case. */
async function runGetfattr(paths: string[]): Promise<Map<string, string> | null> {
  try {
    const raw = await runText('getfattr', ['-n', ORIGIN_ATTR, '--absolute-names', '--', ...paths], {
      timeoutMs: 10_000,
    });
    return parseGetfattrBatch(raw);
  } catch (err) {
    if (err instanceof CommandUnavailableError) return null;
    if (err instanceof CommandFailedError) return parseGetfattrBatch(err.stdout);
    return null;
  }
}

/**
 * Download records for a batch of paths.
 *
 * Carries the caveat this module already states for the single-file reader,
 * and it matters more here because the score would otherwise read an absence
 * as evidence: `user.xdg.origin.url` is a freedesktop convention that
 * Chromium-based browsers honour and **Firefox does not**. A file downloaded
 * with Firefox has no attribute and never will, so "no record" on Linux is a
 * weaker statement than on macOS or Windows — which is why the mechanism name
 * travels with every answer and is shown in the score's breakdown.
 */
export async function readDownloadOriginsLinux(paths: string[]): Promise<DownloadOriginBatch> {
  const origins = new Map<string, DownloadOriginBrief>();
  const unchecked = new Set<string>();
  const mechanism = 'user.xdg.origin.url';
  if (paths.length === 0) return { available: true, origins, unchecked, mechanism };

  // Concurrent for the same reason as the macOS reader: `getfattr` sits in
  // blocking syscalls, and one chunk at a time leaves the other cores idle.
  // The 2.3x this bought on macOS was measured; on Linux it is inferred from
  // the identical shape, and is recorded as inferred rather than measured.
  const batches = chunk(paths, GETFATTR_BATCH);
  const results = await mapConcurrent(batches, IO_SUBPROCESS_CONCURRENCY, (batch) => runGetfattr(batch));

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const values = results[b];
    if (values === null) {
      for (const p of batch) unchecked.add(p);
      continue;
    }
    for (const p of batch) {
      const url = values.get(p);
      if (url === undefined) continue; // checked, no record
      origins.set(p, {
        host: hostOf(url),
        // No Linux convention records a download timestamp; see above.
        downloadedAt: null,
        agent: null,
        mechanism,
      });
    }
  }

  if (unchecked.size === paths.length) {
    return {
      available: false,
      reason:
        'getfattr is not installed, so TreeMap cannot read where a file was downloaded from. '
        + 'Install the attr package to enable it.',
      origins,
      unchecked,
      mechanism,
    };
  }
  return { available: true, origins, unchecked, mechanism };
}
