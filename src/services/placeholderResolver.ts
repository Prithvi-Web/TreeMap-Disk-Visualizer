import { platform } from '../platform';
import type { PlaceholderInfo } from '../platform/types';

/**
 * PlaceholderResolver (A3) — telling "in the cloud" from "on this disk".
 *
 * Cloud sync clients (iCloud Drive, OneDrive Files On-Demand, Dropbox Smart
 * Sync) leave behind files that report a full size while occupying almost no
 * space locally. Tools that read only the reported size conclude a 4 GB video
 * is filling the disk when it is not there at all — DaisyDisk has a documented
 * bug of exactly this kind, and it is the concrete correctness win A3 exists
 * for.
 *
 * ── The rule: two sizes, never conflated ──
 *
 * A placeholder has a **cloud size** (what it claims, what you would download)
 * and a **local size** (what it costs you today). Collapsing them into one
 * number is the bug. Every surface either shows both or is explicit about which
 * one it is showing.
 *
 * ── Why this does not read `stat.blocks` directly ──
 *
 * The scanner previously decided placeholder status from `stat.blocks === 0`
 * plus a path match against known sync folders. That is correct on macOS and
 * Linux and **unreliable on Windows**, where libuv does not report a real
 * allocated-block count: depending on its build it either leaves the field at
 * zero — which would flag *every* file under OneDrive as evicted, making a
 * fully-synced folder look free — or derives it from the size, in which case a
 * genuine placeholder is never detected at all. Both are wrong, and the failure
 * is silent either way.
 *
 * So detection goes through `PlatformProvider.getPlaceholderInfo`, where each OS
 * uses the mechanism that is actually correct there: allocated blocks and
 * `.icloud` stubs on macOS, allocated blocks on Linux, and the NTFS cloud
 * reparse attributes (`RECALL_ON_DATA_ACCESS`, `RECALL_ON_OPEN`, `OFFLINE`)
 * plus `GetCompressedFileSize` on Windows. `tests/placeholderResolver.test.ts`
 * records what `stat.blocks` actually does on each platform so CI answers the
 * Windows question rather than leaving it to inference.
 */

export type CloudProvider = 'icloud' | 'onedrive' | 'dropbox' | 'gdrive';

/** What a file costs now, and what it would cost if downloaded. */
export interface PlaceholderVerdict {
  /** Bytes the file claims — what downloading it would cost. */
  cloudBytes: number;
  /** Bytes it occupies on this machine right now. */
  localBytes: number;
  /** Which sync client owns it, when inferable from its location. */
  provider: CloudProvider | null;
  /** True when the content is not on this machine at all. */
  evicted: boolean;
  /**
   * True for a file that occupies less than it claims for a reason that is
   * NOT cloud sync — a sparse VM disk, a database, an NTFS-compressed file.
   * Kept distinct because calling one of those "safe to remove, it's in the
   * cloud" would be dangerously wrong.
   */
  sparseNotCloud: boolean;
  mechanism: string;
}

/**
 * Which sync client a path belongs to, or null.
 *
 * Path-based because the alternative is vendor-specific client integration that
 * breaks on every update. Being wrong here only mislabels *which* cloud a file
 * belongs to — the byte accounting above is independent of it and stays correct
 * either way.
 *
 * Deliberately anchored to a path separator: matching a bare "Dropbox"
 * substring would claim a file called `my-Dropbox-notes.txt` sitting on the
 * Desktop.
 */
export function providerForPath(p: string): CloudProvider | null {
  const normalized = p.replace(/\\/g, '/');
  if (/(^|\/)Library\/Mobile Documents\//i.test(normalized)) return 'icloud';
  if (/com~apple~CloudDocs/i.test(normalized)) return 'icloud';
  if (/(^|\/)iCloud ?Drive([^/]*)?\//i.test(normalized)) return 'icloud';
  if (/(^|\/)OneDrive([^/]*)?\//i.test(normalized)) return 'onedrive';
  if (/(^|\/)Dropbox([^/]*)?\//i.test(normalized)) return 'dropbox';
  if (/(^|\/)Google ?Drive([^/]*)?\//i.test(normalized)) return 'gdrive';
  return null;
}

/**
 * iCloud names an evicted file `.<original>.icloud`, so the name on disk is not
 * the name the user knows. Recovering it is what lets the UI say
 * "Report.pdf — not downloaded" instead of showing a mystery dotfile.
 */
export function decodeStubName(name: string): string | null {
  if (!name.startsWith('.') || !name.endsWith('.icloud')) return null;
  const inner = name.slice(1, -'.icloud'.length);
  return inner.length > 0 ? inner : null;
}

/**
 * Classify one file.
 *
 * `logicalSize` is passed in rather than re-stat'ed because callers already
 * have it, and a scan of a million files cannot afford a second stat each.
 */
export async function resolve(filePath: string, logicalSize: number): Promise<PlaceholderVerdict | null> {
  const info: PlaceholderInfo | null = await platform().getPlaceholderInfo(filePath);
  if (!info) return null;
  return fromPlatformInfo(filePath, logicalSize, info);
}

/**
 * Shape a platform verdict into the app's own.
 *
 * Pure and exported: this is where "occupies less than it claims" is split into
 * *cloud* and *merely sparse*, which is the distinction that keeps a VM disk
 * image from being offered up as free space.
 */
export function fromPlatformInfo(
  filePath: string,
  logicalSize: number,
  info: PlaceholderInfo,
): PlaceholderVerdict {
  const provider = providerForPath(filePath) ?? (info.provider === 'unknown' ? null : info.provider);
  const cloudBytes = Math.max(logicalSize, info.logicalSize);

  // A file can only be a cloud placeholder if it belongs to a sync folder. The
  // platform layer reports "occupies less than it claims", which is necessary
  // but not sufficient — sparse files do that too, and mislabelling one as
  // cloud-backed invites the user to delete something irreplaceable.
  const isCloud = provider !== null;

  return {
    cloudBytes,
    localBytes: info.localSize,
    provider,
    evicted: isCloud && info.evicted,
    sparseNotCloud: !isCloud && info.localSize < cloudBytes,
    mechanism: info.mechanism,
  };
}

/** Totals a scan or index carries alongside its byte counts. */
export interface PlaceholderTotals {
  /** Files identified as cloud placeholders. */
  fileCount: number;
  /** What those files claim in total — the download cost. */
  cloudBytes: number;
  /** What they actually occupy locally right now. */
  localBytes: number;
  /**
   * cloudBytes − localBytes: the space a naive tool would report as used that
   * is not actually on this machine. This is the number A3 exists to surface.
   */
  notOnThisMachine: number;
}

export function emptyTotals(): PlaceholderTotals {
  return { fileCount: 0, cloudBytes: 0, localBytes: 0, notOnThisMachine: 0 };
}

/** Fold one verdict into a running total. */
export function addToTotals(totals: PlaceholderTotals, verdict: PlaceholderVerdict): void {
  if (verdict.provider === null) return; // sparse-but-local is not cloud storage
  totals.fileCount++;
  totals.cloudBytes += verdict.cloudBytes;
  totals.localBytes += verdict.localBytes;
  totals.notOnThisMachine += Math.max(0, verdict.cloudBytes - verdict.localBytes);
}

/* ------------------------------ cloud residency (v4 §1.2c) ------------------------------ */

/**
 * The sync root a path sits under, or null.
 *
 * Returns the deepest directory whose name still matches a provider pattern,
 * so the UI can name the folder rather than only the vendor.
 */
export function syncRootFor(p: string): string | null {
  if (providerForPath(p) === null) return null;
  const normalized = p.replace(/\\/g, '/');
  const markers = [
    /^(.*?\/Library\/Mobile Documents\/[^/]+)\//i,
    /^(.*?\/[^/]*iCloud ?Drive[^/]*)\//i,
    /^(.*?\/OneDrive[^/]*)\//i,
    /^(.*?\/Dropbox[^/]*)\//i,
    /^(.*?\/Google ?Drive[^/]*)\//i,
  ];
  for (const marker of markers) {
    const m = marker.exec(normalized);
    if (m) return m[1];
  }
  return null;
}

/**
 * Does a remote copy of this path exist? (v4 §1.2c)
 *
 * Extends A3's "is this a placeholder" to the question that actually decides
 * whether deleting is safe. Four states, and the two extremes are the point:
 *
 *  - `placeholder`   — the content is not on this disk at all; it is in the
 *                      account. Safe.
 *  - `synced-local`  — present here and uploaded. Safe.
 *  - `local-only`    — **present here and NOT uploaded.** A file sitting in a
 *                      Dropbox folder looks backed up to a person; while the
 *                      client is still syncing, or has stalled, it is not.
 *                      Deleting it loses it.
 *  - `unknown`       — not in a sync folder, or the client's state could not
 *                      be read.
 *
 * **Reads only the sync client's own local state. Never calls a network API** —
 * that is the same standard the existing cloud integrations meet, and §1.2c
 * states it explicitly.
 *
 * The honest limit, and why `synced-local` is conservative: what can be read
 * locally is whether the file is a placeholder and whether it is fully
 * resident. A fully-resident file in a sync folder is *usually* uploaded, but
 * a client that is mid-upload or stalled reports the same thing. Where the
 * per-OS layer cannot distinguish those, this returns `unknown` rather than
 * `synced-local`, because `synced-local` maps to a `proven` verdict and
 * `proven` must never rest on an assumption.
 */
export async function cloudResidency(filePath: string, logicalSize: number): Promise<{
  syncRoot: string | null;
  provider: CloudProvider | null;
  state: 'placeholder' | 'synced-local' | 'local-only' | 'unknown';
}> {
  const provider = providerForPath(filePath);
  const syncRoot = syncRootFor(filePath);
  if (provider === null) return { syncRoot: null, provider: null, state: 'unknown' };

  const verdict = await resolve(filePath, logicalSize);
  if (!verdict) return { syncRoot, provider, state: 'unknown' };

  // Evicted: the bytes are in the account and not here. The strongest possible
  // evidence that a remote copy exists, because the local copy does not.
  if (verdict.evicted) return { syncRoot, provider, state: 'placeholder' };

  // Resident in a sync folder. Uploaded, or merely not uploaded yet — and the
  // local state alone cannot always tell. Reported as unknown rather than
  // guessed at in either direction, because one direction ('synced-local')
  // becomes a "proven, safe to delete" and the other becomes a false alarm.
  return { syncRoot, provider, state: 'unknown' };
}
