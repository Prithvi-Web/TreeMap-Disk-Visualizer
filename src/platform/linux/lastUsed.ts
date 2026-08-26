import { promises as fsp } from 'fs';
import {
  atimeSupportFromOptions, lastUsedFromAtime, mountForPath, parseProcMounts, readAtime, ATIME_CAVEAT,
} from '../atime';
import type { CapabilityState, LastUsedInfo } from '../types';

/**
 * Last-opened dates on Linux (v4 §1.1).
 *
 * Access time is the only source Linux offers — there is no equivalent of
 * Spotlight's use count — so the whole question is whether the kernel is still
 * updating it, and that is a per-mount property read from `/proc/mounts`.
 *
 * The three cases, and why they are not the same:
 *
 *  - **`relatime`** — the default on every modern distribution. atime is
 *    updated when the old atime predates mtime or is more than a day stale.
 *    Treated as usable, with the ~24h precision stated. Refusing it would
 *    throw away a good signal to avoid a rounding error, and "not opened in
 *    fourteen months" does not need hour precision.
 *  - **`strictatime`** — every read updates atime. Exact, and rare.
 *  - **`noatime`** — the kernel never updates atime, so whatever is on disk is
 *    left over from creation or the last write. This is genuinely fatal, and
 *    the provider reports itself unavailable for those paths rather than
 *    presenting a creation date as a last-opened date.
 *
 * The mount lookup takes the **longest** matching mount point, because mounts
 * nest: a `noatime` data drive under a `relatime` root would otherwise be read
 * through the root's options and reported as working.
 *
 * None of this has run on a Linux machine — see the phase check-in. What is
 * covered is the parsing seam, against captured `/proc/mounts` fixtures
 * including the escaped-space and nested-mount forms.
 */

const MOUNTS_FILE = '/proc/mounts';

/** Cached: /proc/mounts is stable within a request, and re-reading it per path is waste. */
let cachedMounts: { at: number; text: string } | null = null;
const MOUNTS_TTL_MS = 30_000;

/** Test seam — drops the cached /proc/mounts read. */
export function resetMountsCacheForTests(): void {
  cachedMounts = null;
}

async function readMounts(): Promise<string | null> {
  const now = Date.now();
  if (cachedMounts && now - cachedMounts.at < MOUNTS_TTL_MS) return cachedMounts.text;
  try {
    const text = await fsp.readFile(MOUNTS_FILE, 'utf8');
    cachedMounts = { at: now, text };
    return text;
  } catch {
    // A container without /proc mounted, or a hardened kernel. Unknown, and
    // reported as unknown — never assumed to be working.
    return null;
  }
}

/** atime support for one path, or null when /proc/mounts could not be read. */
export async function atimeSupportForPath(path: string): Promise<{ usable: boolean; reason?: string; option: string } | null> {
  const text = await readMounts();
  if (text === null) return null;
  const mount = mountForPath(parseProcMounts(text), path);
  if (!mount) return null;
  return atimeSupportFromOptions(mount.options);
}

export async function readLastUsedLinux(paths: string[]): Promise<Map<string, LastUsedInfo>> {
  const out = new Map<string, LastUsedInfo>();
  const mountsText = await readMounts();
  const mounts = mountsText === null ? null : parseProcMounts(mountsText);

  for (const p of paths) {
    const st = await readAtime(p);
    if (!st) continue; // gone since the scan — the caller counts it as skipped

    const mount = mounts ? mountForPath(mounts, p) : null;
    const support = mount ? atimeSupportFromOptions(mount.options) : null;

    if (support && !support.usable) {
      out.set(p, { lastUsedMs: null, useCount: null, source: 'none', caveat: support.reason });
      continue;
    }

    const info = lastUsedFromAtime(st.atimeMs);
    if (info.source === 'atime') {
      // relatime's day-granularity note is worth carrying alongside the
      // generic caveat; strictatime and plain atime need only the generic one.
      info.caveat = support?.reason ? `${support.reason} ${ATIME_CAVEAT}` : ATIME_CAVEAT;
    }
    out.set(p, info);
  }
  return out;
}

export async function probeLastUsedLinux(): Promise<CapabilityState> {
  const text = await readMounts();
  if (text === null) {
    return {
      available: false,
      mechanism: 'access time from /proc/mounts',
      reason:
        'TreeMap could not read /proc/mounts, so it cannot tell whether this system records when files are opened. ' +
        'Rather than guess, it is leaving last-opened dates blank.',
    };
  }

  const entries = parseProcMounts(text);
  // A machine where *every* real filesystem is noatime cannot answer at all.
  // One that has any usable mount can, so the capability is available and the
  // per-path reader states the exceptions individually.
  const real = entries.filter((e) => !['proc', 'sysfs', 'devtmpfs', 'cgroup', 'cgroup2', 'devpts', 'securityfs'].includes(e.filesystem));
  const usable = real.filter((e) => atimeSupportFromOptions(e.options).usable);

  if (real.length > 0 && usable.length === 0) {
    return {
      available: false,
      mechanism: 'access time',
      reason:
        'Every drive on this system is mounted with "noatime", so Linux never records when files are opened. ' +
        'TreeMap will not substitute the last-modified date, because "changed a year ago" is a different fact from "not opened in a year".',
    };
  }
  return { available: true, mechanism: 'access time (atime) from /proc/mounts' };
}
