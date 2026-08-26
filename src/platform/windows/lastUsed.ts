import { runText, CommandUnavailableError } from '../exec';
import { lastUsedFromAtime, parseDisableLastAccess, readAtime, windowsLastAccessReason, ATIME_CAVEAT } from '../atime';
import type { CapabilityState, LastUsedInfo } from '../types';

/**
 * Last-opened dates on Windows (v4 §1.1).
 *
 * NTFS records a last-access time, and Windows has largely stopped updating
 * it: `DisableLastAccess` has defaulted to off since Vista for performance,
 * and Windows 10 1803 added System Managed modes that keep updates on for
 * smaller volumes and off for larger ones.
 *
 * **The rule this file exists to enforce: when last-access updates are off,
 * TreeMap says so and offers nothing.** It does not fall back to the
 * modification time. "Changed a year ago" and "not opened in a year" are
 * different facts, and quietly swapping one for the other would put a wrong
 * reason underneath a delete button — which is the specific harm §2.4 is
 * written against. On macOS and Linux the fallback to access time is honest
 * because access time really does track opening; here there is no such
 * fallback available, so the honest answer is nothing.
 *
 * `fsutil behavior query DisableLastAccess` is a machine-wide setting, queried
 * once and cached. Its value is a two-bit field, parsed in ../atime.ts — where
 * the four cases and the reason the obvious reading is wrong are documented.
 *
 * None of this has run on a Windows machine — see the phase check-in. What is
 * covered is the parsing seam, against captured `fsutil` output for all four
 * values plus the unparseable form.
 */

interface LastAccessState {
  updatesEnabled: boolean;
  /** Present when updates are off, or when the setting could not be read. */
  reason?: string;
  raw: number | null;
}

let cached: { at: number; value: LastAccessState } | null = null;
const TTL_MS = 60_000;

/** Test seam — drops the cached fsutil answer. */
export function resetLastAccessCacheForTests(): void {
  cached = null;
}

/** Query the machine-wide NTFS last-access setting. Never throws. */
export async function lastAccessState(): Promise<LastAccessState> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  let value: LastAccessState;
  try {
    const text = await runText('fsutil', ['behavior', 'query', 'DisableLastAccess'], { timeoutMs: 5_000 });
    const parsed = parseDisableLastAccess(text);
    if (!parsed) {
      value = {
        updatesEnabled: false,
        raw: null,
        reason:
          'TreeMap could not read whether Windows is recording when files are opened, so it is leaving last-opened dates blank rather than guessing.',
      };
    } else if (!parsed.updatesEnabled) {
      value = { updatesEnabled: false, raw: parsed.raw, reason: windowsLastAccessReason(parsed.raw) };
    } else {
      value = { updatesEnabled: true, raw: parsed.raw };
    }
  } catch (err) {
    const detail = err instanceof CommandUnavailableError
      ? 'the fsutil tool is not available'
      : 'the check did not complete';
    value = {
      updatesEnabled: false,
      raw: null,
      reason:
        `TreeMap could not check whether Windows records when files are opened (${detail}), ` +
        'so it is leaving last-opened dates blank rather than guessing.',
    };
  }

  cached = { at: now, value };
  return value;
}

export async function readLastUsedWindows(paths: string[]): Promise<Map<string, LastUsedInfo>> {
  const out = new Map<string, LastUsedInfo>();
  const state = await lastAccessState();

  for (const p of paths) {
    const st = await readAtime(p);
    if (!st) continue; // gone since the scan — the caller counts it as skipped

    if (!state.updatesEnabled) {
      // The atime on disk is real, but frozen — it is whatever it was when the
      // file was created or last written. Reporting it as "last opened" would
      // be a confidently wrong answer, so nothing is reported.
      out.set(p, { lastUsedMs: null, useCount: null, source: 'none', caveat: state.reason });
      continue;
    }
    const info = lastUsedFromAtime(st.atimeMs);
    if (info.source === 'atime') info.caveat = ATIME_CAVEAT;
    out.set(p, info);
  }
  return out;
}

export async function probeLastUsedWindows(): Promise<CapabilityState> {
  const state = await lastAccessState();
  if (!state.updatesEnabled) {
    return {
      available: false,
      mechanism: 'NTFS last-access time',
      reason: state.reason ?? 'Windows is not recording when files are opened on this PC.',
    };
  }
  return { available: true, mechanism: 'NTFS last-access time' };
}
