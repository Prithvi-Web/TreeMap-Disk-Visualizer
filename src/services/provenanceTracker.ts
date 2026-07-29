import fs from 'fs';
import { platform } from '../platform';
import { capabilityState } from '../platform/capabilities';
import { ProvenanceInfo } from '../platform/types';

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
  /** Last time the file was opened, from its atime. Null when unknown. */
  lastOpenedAt: number | null;
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

export async function readProvenance(filePath: string): Promise<ProvenanceResult> {
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
