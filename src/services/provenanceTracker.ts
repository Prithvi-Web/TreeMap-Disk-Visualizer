import fs from 'fs';
import { platform } from '../platform';
import { capabilityState } from '../platform/capabilities';
import { LastUsedInfo, ProvenanceInfo } from '../platform/types';

/**
 * provenanceTracker — where a file came from (§C3).
 *
 * The platform layer already knows how to read each OS's record:
 * `com.apple.metadata:kMDItemWhereFroms` plus `com.apple.quarantine` on macOS,
 * the `Zone.Identifier` alternate data stream on Windows, and the
 * `user.xdg.origin.url` xattr on Linux. This adds the two things the app needs
 * around it: the file's own last-opened time, and an honest answer when there
 * is simply nothing recorded.
 *
 * **"No provenance" is a real answer, not an error.** Files you made yourself
 * have none, and Firefox on Linux does not write the xattr at all. Saying
 * "nothing was recorded, and here is why that is normal" is the difference
 * between a useful panel and one people learn to distrust.
 *
 * Every URL that comes out of here is untrusted input. It is never fetched,
 * never resolved, and never handed to the UI as anything but text to escape.
 */

export interface ProvenanceResult {
  path: string;
  /** True when this OS can read provenance at all. */
  supported: boolean;
  /** Present when `supported` is false — why not, in plain English. */
  unsupportedReason?: string;
  /** True when a record was actually found for this file. */
  found: boolean;
  url: string | null;
  host: string | null;
  referrer: string | null;
  downloadedAt: number | null;
  /** Which OS mechanism answered, e.g. "kMDItemWhereFroms". */
  mechanism: string | null;
  /** Last time the file was opened, from its atime. Null when unknown — or not opened since it last changed. */
  lastOpenedAt: number | null;
  /**
   * Set when a null `lastOpenedAt` is UNKNOWN, with why (hunt C92): the file's
   * dates could not be read, its access time is not recorded, or its drive or
   * this computer records no openings (asked of the file: review F1.16). Absent
   * with a null date, this file's openings are recorded and none came after its
   * last change.
   */
  lastOpenedUnknown?: string;
  /** Why there is no record, when there is none. */
  absentReason?: string;
}

/**
 * Some filesystems mount `noatime`, and some tools rewrite it. An atime that
 * equals the mtime tells us nothing — treat it as unknown rather than claiming
 * the file was last opened exactly when it was last written.
 */
function lastOpened(st: fs.Stats): number | null {
  if (!Number.isFinite(st.atimeMs) || st.atimeMs <= 0) return null;
  if (Math.abs(st.atimeMs - st.mtimeMs) < 1000) return null;
  return st.atimeMs;
}

/** Why a file might legitimately have no origin recorded, phrased for a person. */
function absentReasonFor(mechanism: string): string {
  if (mechanism.includes('xdg')) {
    return 'Nothing was recorded. On Linux only some browsers save where a download came from — Firefox, notably, does not.';
  }
  if (mechanism.includes('Zone')) {
    return 'Nothing was recorded. Windows saves this for files downloaded by a browser; files you created, copied from a local drive, or unzipped often have none.';
  }
  return 'Nothing was recorded. macOS saves this for browser downloads; files you created yourself, or copied from another drive, have none.';
}

/** Why this computer keeps no record of openings, or null when it keeps one (the lastUsed capability's verdict). */
async function openingsNotRecorded(): Promise<string | null> {
  try {
    const cap = await capabilityState('lastUsed');
    return cap.available ? null : cap.reason ?? 'This computer does not record when files are opened.';
  } catch {
    return 'TreeMap could not tell whether this computer records when files are opened.';
  }
}

/** The per-file last-opened reader (`platform().readLastUsed`), injected so a test stands in for a drive. */
export type ReadLastUsed = (paths: string[]) => Promise<Map<string, LastUsedInfo>>;

/**
 * Why THIS file's last opening is not known, or null when its openings are recorded (hunt C92;
 * review F1.5, F1.16). Asked of the file, never only of the computer: one drive mounted `noatime`
 * records no openings while the rest of the computer does, and an access time of 0 records none
 * anywhere. The per-file reader is the one the `lastUsed` fact reads, so the two agree.
 */
async function openingsNotRecordedFor(filePath: string, st: fs.Stats, readLastUsed: ReadLastUsed): Promise<string | null> {
  if (!Number.isFinite(st.atimeMs) || st.atimeMs <= 0) return 'This file’s access time is not recorded.';
  let info: LastUsedInfo | undefined;
  try {
    info = (await readLastUsed([filePath])).get(filePath);
  } catch {
    return openingsNotRecorded();
  }
  if (info === undefined) return 'TreeMap could not read this file\'s dates.';
  if (info.source !== 'none') return null;
  return info.caveat ?? (await openingsNotRecorded()) ?? 'This computer does not record when this file is opened.';
}

export async function readProvenance(filePath: string, readLastUsed: ReadLastUsed = (paths) => platform().readLastUsed(paths)): Promise<ProvenanceResult> {
  const provider = platform();
  const state = await capabilityState('provenance');

  let st: fs.Stats | null = null;
  try {
    st = await fs.promises.lstat(filePath);
  } catch {
    st = null;
  }

  const base: ProvenanceResult = {
    path: filePath,
    supported: state.available,
    unsupportedReason: state.available ? undefined : state.reason,
    found: false,
    url: null,
    host: null,
    referrer: null,
    downloadedAt: null,
    mechanism: state.mechanism || null,
    lastOpenedAt: st ? lastOpened(st) : null,
  };
  // A null date is a finding only where openings are recorded and the dates were read (hunt C92).
  if (base.lastOpenedAt === null) {
    const unknown = st === null ? 'TreeMap could not read this file\'s dates.' : await openingsNotRecordedFor(filePath, st, readLastUsed);
    if (unknown) base.lastOpenedUnknown = unknown;
  }

  if (!state.available) return base;

  let info: ProvenanceInfo | null = null;
  try {
    info = await provider.getDownloadOrigin(filePath);
  } catch {
    info = null; // an unreadable xattr is "no record", not a failure to report
  }

  if (!info || (!info.url && !info.downloadedAt)) {
    return { ...base, absentReason: absentReasonFor(state.mechanism || '') };
  }

  return {
    ...base,
    found: true,
    url: info.url,
    host: info.host,
    referrer: info.referrer,
    downloadedAt: info.downloadedAt,
    mechanism: info.mechanism || state.mechanism || null,
  };
}
