import { promises as fsp } from 'fs';
import type { LastUsedInfo } from './types';

/**
 * Access times, and whether this machine's filesystems still record them
 * (v4 §1.1).
 *
 * Every parser here is pure and exported, because the interesting cases are
 * all in *other people's* tool output — a `noatime` mount, an NTFS volume with
 * last-access tracking switched off, a `/proc/mounts` line with an unusual
 * option order — and none of those can be produced on the machine running the
 * tests. The tool seam is the only place they can be covered honestly.
 *
 * The measurement that shaped this file: `lstat` costs **0.0015 ms/path** on
 * this Mac (5,000 paths in 7.4 ms), against **0.36 ms/path** for a batched
 * `mdls` (5,000 paths in ~1.8 s). That is a 240x difference, and it is why
 * access time is the default source and Spotlight is an enrichment that must
 * earn its cost rather than the other way round.
 */

/** Read one path's access and modification times. Never throws. */
export async function readAtime(path: string): Promise<{ atimeMs: number; mtimeMs: number } | null> {
  try {
    const st = await fsp.lstat(path);
    return { atimeMs: st.atimeMs, mtimeMs: st.mtimeMs };
  } catch {
    // Gone since the scan, or unreadable. The caller reports it as skipped —
    // never as a zero date.
    return null;
  }
}

/**
 * The caveat that must travel with every access-time answer.
 *
 * Stated in full, and in plain language, because an access time genuinely is
 * weaker evidence than "a person opened this" and the user is about to make
 * delete decisions with it.
 */
export const ATIME_CAVEAT =
  'This is the file’s access time, not a record of you opening it. ' +
  'Backups, search indexing, antivirus and preview generation all read files, ' +
  'so the date can be more recent than the last time you actually used it.';

/** An access-time answer, or the honest "nothing known" shape. */
export function lastUsedFromAtime(atimeMs: number | null): LastUsedInfo {
  if (atimeMs === null || !Number.isFinite(atimeMs) || atimeMs <= 0) {
    return { lastUsedMs: null, useCount: null, source: 'none' };
  }
  return { lastUsedMs: Math.round(atimeMs), useCount: null, source: 'atime', caveat: ATIME_CAVEAT };
}

/* ------------------------------ /proc/mounts ------------------------------ */

export interface MountEntry {
  mountPoint: string;
  filesystem: string;
  options: string[];
}

/**
 * Parse `/proc/mounts` (or `/etc/mtab`), which is whitespace-separated:
 *
 *     /dev/sda1 /home ext4 rw,relatime,errors=remount-ro 0 0
 *
 * Mount points are escaped octal for space, tab, newline and backslash —
 * `/mnt/my\040disk` is `/mnt/my disk`. Unescaping matters: a user whose backup
 * drive is called "My Passport" would otherwise never match their own mount.
 */
export function parseProcMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    entries.push({
      mountPoint: unescapeMountPoint(parts[1]),
      filesystem: parts[2],
      options: parts[3].split(','),
    });
  }
  return entries;
}

/** Undo the octal escaping the kernel applies to mount points. */
export function unescapeMountPoint(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * The mount that actually governs `path` — the longest matching mount point.
 *
 * Longest wins because mounts nest: `/` and `/home` both prefix
 * `/home/me/file`, and only `/home`'s options apply to it. Taking the first
 * match instead would read the root's options for every nested mount, which is
 * how a `noatime` data drive would be missed on a machine whose root is
 * `relatime`.
 */
export function mountForPath(entries: MountEntry[], path: string): MountEntry | null {
  let best: MountEntry | null = null;
  for (const entry of entries) {
    const mp = entry.mountPoint;
    const isPrefix = path === mp || path.startsWith(mp.endsWith('/') ? mp : mp + '/');
    if (!isPrefix) continue;
    if (!best || mp.length > best.mountPoint.length) best = entry;
  }
  return best;
}

export interface AtimeSupport {
  /** Whether access times move at all on this mount. */
  usable: boolean;
  /** Plain-English explanation. Present whenever `usable` is false, or precision is reduced. */
  reason?: string;
  /** The mount option that decided it, for the capability's mechanism string. */
  option: 'noatime' | 'relatime' | 'strictatime' | 'atime' | 'unknown';
}

/**
 * What a mount's options mean for last-used dates.
 *
 * `relatime` is the default on every modern Linux and is deliberately treated
 * as **usable**: it updates atime when the previous atime is older than mtime
 * or more than 24 hours old. That is precise to about a day — which is far
 * more precision than "not opened in fourteen months" needs, and calling it
 * unavailable would throw away a good signal to avoid a rounding error.
 *
 * `noatime` is genuinely fatal: the kernel never updates access times, so the
 * value on disk is whatever it was when the file was created or last written.
 * Reporting that as "last opened" would be a confidently wrong answer of
 * exactly the kind this project refuses to give.
 */
export function atimeSupportFromOptions(options: string[]): AtimeSupport {
  if (options.includes('noatime')) {
    return {
      usable: false,
      option: 'noatime',
      reason: 'This drive is mounted with "noatime", so the system never records when files are opened. TreeMap has no way to know how long something has gone unused here.',
    };
  }
  if (options.includes('relatime')) {
    return {
      usable: true,
      option: 'relatime',
      reason: 'This drive uses "relatime", so opening times are recorded to about the nearest day. That is precise enough to tell months apart, but not hours.',
    };
  }
  if (options.includes('strictatime')) return { usable: true, option: 'strictatime' };
  return { usable: true, option: 'atime' };
}

/* ------------------------------ macOS `mount` ------------------------------ */

/**
 * Parse BSD `mount` output:
 *
 *     /dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
 *     /dev/disk4s2 on /Volumes/Backup (hfs, local, nodev, noatime)
 *
 * macOS has no `/proc/mounts`, and `mount` has no structured mode — this is
 * one of the handful of genuinely unstructured tools §2.3 allows, and it is
 * parsed into the same MountEntry shape so `mountForPath` is shared rather
 * than reimplemented per OS.
 */
export function parseBsdMount(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const onAt = trimmed.indexOf(' on ');
    const openParen = trimmed.lastIndexOf(' (');
    if (onAt === -1 || openParen === -1 || openParen <= onAt) continue;
    if (!trimmed.endsWith(')')) continue;
    const mountPoint = trimmed.slice(onAt + 4, openParen);
    const options = trimmed
      .slice(openParen + 2, -1)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    // The first option is the filesystem type: "(apfs, local, journaled)".
    entries.push({ mountPoint, filesystem: options[0] ?? 'unknown', options });
  }
  return entries;
}

/* ------------------------------ Windows fsutil ------------------------------ */

/**
 * Parse `fsutil behavior query DisableLastAccess`.
 *
 * Output takes one of these forms depending on the Windows version:
 *
 *     DisableLastAccess = 1
 *     DisableLastAccess = 2  (System Managed, Enabled)
 *     DisableLastAccess = 0  (User Managed, Updates Enabled)
 *
 * The value is a **two-bit field, not a boolean**, and reading it as one is
 * precisely the mistake this parser exists to prevent:
 *
 *   0 — User Managed,   Updates Enabled   → atime is usable
 *   1 — User Managed,   Updates Disabled  → atime is frozen
 *   2 — System Managed, Updates Enabled   → atime is usable
 *   3 — System Managed, Updates Disabled  → atime is frozen
 *
 * Bit 0 is the disable flag; bit 1 only records *who* decides. So "usable" is
 * the **even** values — and the tempting shortcut, "non-zero means switched
 * off", would wrongly blank this feature on every machine reporting 2, which
 * is a common modern default.
 *
 * Windows has not made this simple. Last-access updates were disabled by
 * default from Vista onward for performance; Windows 10 1803 introduced the
 * System Managed modes, under which Windows keeps updates on for smaller
 * volumes (around 128 GB and below) and off for larger ones. That is why the
 * `raw` value is returned alongside the verdict rather than discarded: the
 * user-facing reason can say whether they turned this off or Windows did.
 *
 * Returns null when the output cannot be understood at all — which the caller
 * reports as unknown, never as "enabled".
 */
export function parseDisableLastAccess(text: string): { updatesEnabled: boolean; raw: number } | null {
  const match = /DisableLastAccess\s*=\s*(\d+)/i.exec(text);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isInteger(raw) || raw < 0 || raw > 3) return null;
  // Bit 0 is the disable flag; bit 1 only says who manages the setting.
  return { updatesEnabled: (raw & 1) === 0, raw };
}

/** The reason text for a Windows volume whose last-access tracking is off. */
export function windowsLastAccessReason(raw: number): string {
  const managed = (raw & 2) === 2 ? 'Windows manages this setting' : 'this setting was changed manually';
  return (
    'Windows is not recording when files are opened on this PC, so TreeMap cannot tell how long something has gone unused. ' +
    `(NTFS last-access updates are switched off — ${managed}. They have been off by default since Windows Vista, for performance.) ` +
    'TreeMap will not substitute the last-modified date, because "changed a year ago" is a different fact from "not opened in a year".'
  );
}
