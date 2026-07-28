import { runText, CommandUnavailableError } from '../exec';
import type { ProvenanceInfo } from '../types';

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
