import { promises as fsp } from 'fs';

import { platform } from '../platform';
import { wholeDiskOf } from '../platform/macos/diskutil';
import { getSnapshotAccounting } from './snapshotAccounting';
import { groupZombies } from './zombieHandles';
import { storeOf } from './scanStore';
import { formatBytes } from '../utils/formatBytes';
import type { ScanResult } from '../models/types';
import type { LogicalVolumeInfo, VolumeTopology } from '../platform/types';
import type { SnapshotAccounting } from './snapshotAccounting';
import type { ZombieReport } from './zombieHandles';

/**
 * The Missing Gigabytes (Phase 5) — one accounting statement for a volume.
 *
 * The most common real complaint on macOS is that the numbers do not add up:
 * the Finder says 188 GB used, a disk tool says 176 GB of files, and nothing
 * explains the difference. Every piece needed to explain it is already
 * computed somewhere in this app. This service puts them on one page and makes
 * them balance — or names the gap.
 *
 * ── The shape of the answer ──
 *
 * A receipt. Every line is bytes, the lines sum to the volume's used space, and
 * the residual has its own line called `unaccounted` rather than being quietly
 * spread across the others to make the arithmetic look clean. §5.2 is explicit
 * about this and it is the whole point of the feature: a statement that always
 * balances because it was forced to is not evidence of anything.
 *
 * ── The invariant, stated once ──
 *
 *   **sum(lines whose bytes are known) + unaccounted === volume used**
 *
 * exactly, in integer bytes, always. `assertBalances` proves it on every build
 * and `tests/missingGigabytes.test.ts` asserts it directly. A line whose bytes
 * cannot be measured contributes **nothing** to the sum and its real value is
 * therefore sitting inside `unaccounted` — so `unaccounted` names those lines
 * (`includes`) instead of letting the user assume the residual is a mystery.
 *
 * ── Why the reference number is the container, not the volume ──
 *
 * Measured on this Mac (macOS 15, APFS), not assumed:
 *
 *   statfs('/')                    → 494.38 GB total, 305.61 GB free
 *   statfs('/System/Volumes/Data') → 494.38 GB total, 305.61 GB free   (identical)
 *   diskutil info -plist /         → APFSContainerSize 494384795648
 *                                    APFSContainerFree 305612984320
 *
 * Both mount points report the *container's* shared pool, and diskutil agrees
 * with statfs to the byte. So "used" here means the container's used space —
 * which is correct, because that is the pool everything on this disk draws
 * from, and it is the number the Finder shows.
 *
 * It also means the sibling volumes are a real, large line. On this Mac the
 * container holds Preboot (9.04 GB), VM (2.15 GB), Update, and an unmounted
 * volume (1.30 GB) that no scan of `/` ever walks: ~12.5 GB that a
 * files-only tool simply loses. Naming it is most of this feature's value.
 *
 * ── What cannot be measured here, and is therefore stated ──
 *
 * **Purgeable space.** macOS exposes it only through
 * `NSURLVolumeAvailableCapacityForImportantUsageKey`, a native API. Checked,
 * not assumed: `diskutil info -plist`, `diskutil apfs list -plist` and
 * `system_profiler -json SPStorageDataType` were each read on this machine and
 * none carries a purgeable figure. §7 forbids native modules, so this line is
 * unavailable with that reason, its bytes live inside `unaccounted`, and
 * `unaccounted` says so. It never reads 0.
 */

export type StatementLineId =
  | 'scanned'
  | 'cloudPlaceholders'
  | 'snapshots'
  | 'purgeable'
  | 'openHandles'
  | 'otherVolumes'
  | 'unscannable'
  | 'unaccounted';

/** A remedy the user can act on, always routed at an endpoint that already exists. */
export interface StatementRemedy {
  /** Which existing gated action this is. The frontend maps it to its own flow. */
  action: 'purge-snapshots' | 'review-open-handles' | 'scan-volume';
  label: string;
  /** Stated up front so the gate is never a surprise mid-flow. */
  caveat: string;
}

/** One line of the receipt. */
export interface StatementLine {
  id: StatementLineId;
  label: string;
  /**
   * Bytes, signed — negative for a correction. **`null` means unknown**, and is
   * never rendered as a zero. A line that is genuinely zero (no snapshots
   * exist) carries `0`, which is a measurement, not an absence.
   */
  bytes: number | null;
  available: boolean;
  /** Present only when `available` is false. Shown verbatim, never rewritten. */
  reason?: string;
  /** What lands on this line, in plain English. */
  detail: string;
  /** A count where one is meaningful — snapshots, refused folders, processes. */
  count: number | null;
  /**
   * Facts that belong to this line but are not part of the arithmetic, because
   * the scan already applied them. Hard links are the case §5.2 names: the
   * walker zeroes every name after the first, so the tree total already counts
   * each inode once and correcting again here would subtract them twice.
   */
  notes: string[];
  remedy: StatementRemedy | null;
}

export interface StatementVolume {
  mountPoint: string;
  /** Container total and used, in bytes. */
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** How the figure was obtained, for the footnote. */
  mechanism: string;
  /**
   * The same fact in the user's words — "what macOS reports for Macintosh HD"
   * — with no call name and no mount path. `mechanism` stays for the API and
   * the tests; this is what the page prints.
   */
  mechanismLabel: string;
  /**
   * Blocks only root may use (ext4's 5% reserve): total − used − free. Zero
   * on APFS and Windows. Reported so used + free + reserved is the disk, and
   * the dashboard's "used" and this statement's "used" can be the same figure.
   */
  reservedBytes: number;
}

export interface AccountingStatement {
  scanId: string;
  rootPath: string;
  volume: StatementVolume;
  lines: StatementLine[];
  /**
   * The residual, signed. Positive: space the volume holds that no line
   * explained. Negative: TreeMap counted more than the volume says exists,
   * which shared storage (clones, reflinks) produces and which is stated as
   * such rather than clamped to zero.
   */
  unaccountedBytes: number;
  /**
   * Did the scan cover this whole volume? When false the residual necessarily
   * contains everything outside the scanned folder, and the UI leads with that
   * rather than presenting a mystery.
   */
  coversWholeVolume: boolean;
  /** Limitations that apply to the statement as a whole. Rendered verbatim. */
  caveats: string[];
  generatedAt: number;
}

/**
 * Everything the statement reads from outside itself.
 *
 * Injected rather than imported directly so the arithmetic can be proven
 * against fixtures for machines this one is not — a volume with snapshots, a
 * machine whose backup tool is missing, a statement that does not balance.
 * On this Mac only one of the interesting cases is reachable live, and a
 * receipt whose only proof is "it added up on the author's laptop" is not
 * proof of the invariant.
 */
export interface StatementSources {
  platform: NodeJS.Platform;
  topology(): Promise<VolumeTopology>;
  statfs(mountPoint: string): Promise<{ blocks: number; bfree: number; bavail: number; bsize: number }>;
  /** `stat().dev`, or null when the path cannot be read. */
  devOf(target: string): Promise<number | null>;
  snapshots(): Promise<SnapshotAccounting>;
  zombies(): Promise<ZombieReport>;
}

/** The real machine. */
export function liveSources(): StatementSources {
  return {
    platform: process.platform,
    topology: () => platform().getVolumeTopology(),
    async statfs(mountPoint: string) {
      const st = await fsp.statfs(mountPoint);
      return { blocks: Number(st.blocks), bfree: Number(st.bfree), bavail: Number(st.bavail), bsize: Number(st.bsize) };
    },
    devOf,
    snapshots: getSnapshotAccounting,
    zombies: leanZombieReport,
  };
}

/**
 * The held-space figures, without the part this page does not show.
 *
 * `zombieReport()` finishes by resolving each holder's `.app` bundle, which
 * costs **one `ps` per process** — and on this machine 305 processes are
 * holding a deleted file, so that is 305 subprocesses for a field the receipt
 * never prints. Measured: 568 ms with the enrichment, 226 ms without, and the
 * three numbers this line actually uses — total bytes, process count,
 * unknown-size count — came back identical both times.
 *
 * The Held-space view still calls the full `zombieReport()`, because it names
 * the applications and genuinely needs them.
 */
async function leanZombieReport(): Promise<ZombieReport> {
  return { ...groupZombies(await platform().getZombieHandles()), scannedAt: Date.now() };
}

/**
 * Which volumes the scan's own filesystem covers, and which one to name.
 *
 * **Matched by device id, never by path prefix.** This is the macOS firmlink
 * trap, and it is not subtle: `/Users` is a firmlink onto the writable volume,
 * so a path like `/Users/me/Desktop` is under the mount point `/` by string
 * comparison while physically living on `/System/Volumes/Data`. Prefix matching
 * therefore attributes a home-folder scan to the sealed 12 GB system volume,
 * and the 163 GB volume the files are actually on is then booked as somebody
 * else's — which is exactly the wrong answer, off by the size of the disk.
 *
 * Measured on this Mac:
 *
 *   stat('/').dev                                        = 16777233
 *   stat('/System/Volumes/Data').dev                      = 16777233   (same)
 *   stat('/Users/me/…').dev                               = 16777233   (same)
 *   stat('/System/Volumes/VM').dev                        = 16777232   (different)
 *
 * The kernel presents the firmlinked system+data pair as **one** device, which
 * is precisely the unit a scan of `/` walks. So grouping mount points by device
 * id gets firmlinks right without naming a single one of them — and it stays
 * right on Linux and Windows, where each filesystem simply has its own device
 * and the group is a single volume.
 */
export interface ScanVolume {
  /** The volume to name in the statement — the outermost mount point on this device. */
  primary: LogicalVolumeInfo;
  /** Every mounted volume on the same device, including `primary`. */
  onSameDevice: LogicalVolumeInfo[];
}

/** `stat().dev`, or null when the path cannot be read. */
async function devOf(target: string): Promise<number | null> {
  try {
    return (await fsp.stat(target)).dev;
  } catch {
    return null;
  }
}

export async function resolveScanVolume(
  volumes: readonly LogicalVolumeInfo[],
  rootPath: string,
  readDev: (target: string) => Promise<number | null> = devOf,
): Promise<ScanVolume | null> {
  const mounted = volumes.filter((v) => v.mountPoint !== null);
  const rootDev = await readDev(rootPath);
  if (rootDev !== null) {
    const devs = await Promise.all(mounted.map((v) => readDev(v.mountPoint as string)));
    const onSameDevice = mounted.filter((_, i) => devs[i] === rootDev);
    if (onSameDevice.length > 0) {
      // The outermost mount point is the one a user recognises as "the disk":
      // `/` rather than `/System/Volumes/Data`, both of which are this device.
      const primary = onSameDevice.reduce((a, b) =>
        (a.mountPoint as string).length <= (b.mountPoint as string).length ? a : b,
      );
      return { primary, onSameDevice };
    }
  }
  // Fallback: the device could not be read (a path that vanished, a permission
  // wall on the mount point itself). Longest matching mount point is the best
  // remaining guess, and it is only ever reached when the exact answer is gone.
  const byPrefix = volumeForPath(mounted, rootPath);
  return byPrefix ? { primary: byPrefix, onSameDevice: [byPrefix] } : null;
}

/** Which mounted volume does this path live on, by path alone? Longest mount point wins. */
export function volumeForPath(volumes: readonly LogicalVolumeInfo[], target: string): LogicalVolumeInfo | null {
  let best: LogicalVolumeInfo | null = null;
  for (const v of volumes) {
    if (!v.mountPoint) continue;
    if (!isUnder(target, v.mountPoint)) continue;
    if (!best || v.mountPoint.length > (best.mountPoint ?? '').length) best = v;
  }
  return best;
}

/**
 * Which separator does this path use?
 *
 * Read off the path itself, never off the host. `path.sep` was the first
 * version and it is wrong twice over: it makes a pure function's answer depend
 * on which machine is asking, and it is simply incorrect for the POSIX-shaped
 * paths a Windows host really does handle — a `cloud://` scan root has forward
 * slashes whatever the OS is. It also broke every macOS-shaped fixture the
 * moment the suite ran on Windows, which is how this was found.
 *
 * Being lenient — treating both separators as boundaries everywhere — would be
 * worse than either: `\` is a legal character in a POSIX filename, so a file
 * genuinely named `a\b` inside `/x` would be reported as living under `/x/a`.
 * The separator is a property of the path, so it is read from the path.
 */
function separatorOf(p: string): string {
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? '\\' : '/';
}

/** Is `target` at or beneath `dir`? Segment-wise, so `/Volumes/Disk2` is not under `/Volumes/Disk`. */
function isUnder(target: string, dir: string): boolean {
  if (target === dir) return true;
  const sep = separatorOf(dir);
  const base = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(base);
}

/**
 * The volumes sharing one storage pool with `volume`.
 *
 * **APFS only, and that is a correctness rule rather than a missing feature.**
 * This line exists because `statfs` on an APFS volume reports the *container's*
 * pool, so sibling volumes really are inside the total being reconciled. On
 * ext4, NTFS and friends `statfs` reports that filesystem alone: adding a
 * sibling's usage there would add bytes the total never contained, and the
 * statement would fail to balance by exactly that amount. So elsewhere the
 * answer is "nothing shares this pool", which is true of how the number was
 * obtained.
 *
 * Container membership is read off the device identifier: `disk3s5` and
 * `disk3s1s1` both live in container `disk3`, while `disk1s1` does not.
 * `wholeDiskOf` is the mapping the topology reader already uses and tests, and
 * it is the only field in `diskutil list`'s answer that distinguishes
 * containers at all — every volume there reports the same *physical* disk,
 * because one SSD backs all three containers on this machine.
 */
export function containerSiblings(
  volumes: readonly LogicalVolumeInfo[],
  volume: LogicalVolumeInfo,
  plat: NodeJS.Platform = process.platform,
): LogicalVolumeInfo[] {
  if (plat !== 'darwin') return [];
  const container = wholeDiskOf(volume.id);
  return volumes.filter((v) => v.id !== volume.id && wholeDiskOf(v.id) === container);
}

/**
 * Build the statement.
 *
 * Every source is best-effort and independently degradable: a snapshot tool
 * that is missing must not cost the user the other seven lines. Each `catch`
 * therefore produces an unavailable line carrying the real error text — §10's
 * "unavailable is a first-class state", applied per line rather than per page.
 */
export async function buildStatement(
  scan: ScanResult,
  sources: StatementSources = liveSources(),
): Promise<AccountingStatement> {
  const rootPath = scan.rootPath;
  const plat = sources.platform;

  const topology = await sources.topology();
  const resolved = await resolveScanVolume(topology.logicalVolumes, rootPath, sources.devOf);
  if (!resolved) {
    throw new Error(
      `no mounted volume contains ${rootPath} — the disk layout does not describe where this scan lives, so nothing can be reconciled against it`,
    );
  }
  const volume = resolved.primary;
  const mountPoint = volume.mountPoint as string;

  // The pool everything on this container draws from. statfs is the reference
  // because it is the same number the Finder shows and it agrees with diskutil
  // to the byte (measured; see the header).
  const st = await sources.statfs(mountPoint);
  const blockSize = st.bsize;
  const totalBytes = st.blocks * blockSize;
  const freeBytes = st.bavail * blockSize;
  const usedBytes = (st.blocks - st.bfree) * blockSize;
  const reservedBytes = Math.max(0, (st.bfree - st.bavail) * blockSize);

  // A scan covers the whole volume only when it started AT a mount point of the
  // scan's own device. Anything deeper is a folder, however large.
  const coversWholeVolume = resolved.onSameDevice.some((v) => v.mountPoint === rootPath);

  const lines: StatementLine[] = [];
  const caveats: string[] = [];

  /* ── Scanned files ─────────────────────────────────────────────────────── */

  const store = storeOf(scan);
  const scannedBytes = store.size(store.rootId);
  const hardlinked = scan.hardlinkedBytes ?? 0;
  const scannedNotes: string[] = [];
  if (hardlinked > 0) {
    scannedNotes.push(
      `Files here have more than one name, and ${formatBytes(hardlinked)} would be counted twice by a tool that adds every name up. The scan counts each file once, so that is already left out here — it is not a separate line.`,
    );
  }
  scannedNotes.push(
    'Copy-on-write clones cannot be told apart from real copies without native code, which TreeMap does not ship: a clone reports its full size and its own inode, exactly as a genuine copy does. Where clones exist, this line is an over-count and the difference lands in Unaccounted below.',
  );
  lines.push({
    id: 'scanned',
    label: 'Files TreeMap scanned',
    bytes: scannedBytes,
    available: true,
    detail: coversWholeVolume
      ? 'Everything the scan walked, which is this whole volume.'
      : `Everything the scan walked. The scan started at ${rootPath}, which is only part of this volume.`,
    count: scan.fileCount,
    notes: scannedNotes,
    remedy: coversWholeVolume
      ? null
      : {
          action: 'scan-volume',
          label: `Scan all of ${mountPoint}`,
          caveat: 'A full-volume scan takes longer, and is the only way this statement can account for every file.',
        },
  });

  /* ── Cloud placeholders ────────────────────────────────────────────────── */

  const cloudBytes = scan.cloudBytes ?? 0;
  lines.push({
    id: 'cloudPlaceholders',
    label: 'Online-only files counted above but not on the disk',
    bytes: -cloudBytes,
    available: true,
    detail:
      cloudBytes > 0
        ? 'Cloud placeholders report their full size but occupy almost no blocks. The line above counted them; this takes them back off.'
        : 'No cloud placeholders were found in this scan, so nothing is taken back off.',
    count: scan.cloudFiles ?? 0,
    notes: [],
    remedy: null,
  });

  /* ── Filesystem snapshots ──────────────────────────────────────────────── */

  lines.push(await snapshotLine(sources));

  /* ── Purgeable ─────────────────────────────────────────────────────────── */

  lines.push(purgeableLine(plat));

  /* ── Space held by open handles ────────────────────────────────────────── */

  lines.push(await openHandleLine(sources));

  /* ── Other volumes in the same container ──────────────────────────────── */

  lines.push(otherVolumesLine(topology.logicalVolumes, volume, resolved.onSameDevice, plat));

  /* ── What the scan was refused ─────────────────────────────────────────── */

  lines.push(unscannableLine(scan));

  /* ── The residual ──────────────────────────────────────────────────────── */

  const known = lines.reduce((sum, l) => sum + (l.bytes ?? 0), 0);
  const unaccountedBytes = usedBytes - known;
  const unknownLines = lines.filter((l) => l.bytes === null);

  const includes = unknownLines.map((l) => l.label);
  if (!coversWholeVolume) includes.unshift(`everything on ${mountPoint} outside ${rootPath}`);
  includes.push('space shared by copy-on-write clones, which cannot be attributed without native code');

  lines.push({
    id: 'unaccounted',
    label: 'Unaccounted',
    bytes: unaccountedBytes,
    available: true,
    detail:
      `The volume holds this much that no line above explained. It is shown rather than absorbed, because a statement ` +
      `that always balances is not evidence of anything. What is sitting in here: ${includes.join('; ')}.`,
    count: null,
    notes: [],
    remedy: null,
  });

  if (!coversWholeVolume) {
    caveats.push(
      `This scan started at ${rootPath}, not at ${mountPoint}, so everything else on the volume is inside Unaccounted. Scan the whole volume for a statement that accounts for every file.`,
    );
  }
  if (plat !== 'darwin' && plat !== 'win32' && plat !== 'linux') {
    caveats.push(`TreeMap has no per-volume accounting for ${plat}; only the filesystem's own totals are shown.`);
  }

  const statement: AccountingStatement = {
    scanId: scan.scanId,
    rootPath,
    volume: {
      mountPoint,
      totalBytes,
      usedBytes,
      freeBytes,
      mechanism: `statfs(${mountPoint}) — the shared pool this volume draws from`,
      mechanismLabel: describeMechanism(volume, plat),
      reservedBytes,
    },
    lines,
    unaccountedBytes,
    coversWholeVolume,
    caveats,
    generatedAt: Date.now(),
  };

  assertBalances(statement);
  return statement;
}

/* ─────────────────────────── the individual lines ─────────────────────────── */

async function snapshotLine(sources: StatementSources): Promise<StatementLine> {
  const remedy: StatementRemedy = {
    action: 'purge-snapshots',
    label: 'Delete local snapshots',
    caveat:
      'Needs an explicit confirmation. Time Machine recreates local snapshots on its next backup, so this frees space now rather than permanently.',
  };
  try {
    const acc = await sources.snapshots();
    if (!acc.available) {
      return {
        id: 'snapshots',
        label: 'Filesystem snapshots',
        bytes: null,
        available: false,
        reason: acc.reason ?? 'snapshot tooling is not available on this system',
        detail: 'Snapshots pin blocks that no directory walk can see, so any space they hold is inside Unaccounted.',
        count: null,
        notes: [],
        remedy: null,
      };
    }
    const count = acc.snapshots.length;
    // Zero snapshots is a measurement — the tool ran and found none — so this
    // line legitimately reads 0. One or more snapshots is the opposite case:
    // `tmutil listlocalsnapshots` names them and does not size them, so the
    // bytes are genuinely unknown and must not be shown as anything.
    if (count === 0) {
      return {
        id: 'snapshots',
        label: 'Filesystem snapshots',
        bytes: 0,
        available: true,
        detail: 'There are no local snapshots on this volume, so they hold nothing.',
        count: 0,
        notes: [],
        remedy: null,
      };
    }
    if (acc.totalBytes !== null) {
      return {
        id: 'snapshots',
        label: 'Filesystem snapshots',
        bytes: acc.totalBytes,
        available: true,
        detail: `${String(count)} snapshot${count === 1 ? '' : 's'} pin blocks that a directory walk never sees.`,
        count,
        notes: [],
        remedy: acc.canPurge ? remedy : null,
      };
    }
    return {
      id: 'snapshots',
      label: 'Filesystem snapshots',
      bytes: null,
      available: false,
      reason: `${String(count)} snapshot${count === 1 ? ' exists' : 's exist'}, but the operating system names them without sizing them, so how much they hold cannot be read here.`,
      detail: 'Snapshots pin blocks that no directory walk can see, so the space they hold is inside Unaccounted.',
      count,
      notes: [],
      remedy: acc.canPurge ? remedy : null,
    };
  } catch (err) {
    return {
      id: 'snapshots',
      label: 'Filesystem snapshots',
      bytes: null,
      available: false,
      reason: msg(err),
      detail: 'Snapshots pin blocks that no directory walk can see, so any space they hold is inside Unaccounted.',
      count: null,
      notes: [],
      remedy: null,
    };
  }
}

/**
 * Purgeable space — unavailable everywhere, for a different reason per OS.
 *
 * This line exists precisely so that the thing macOS users are most often
 * confused by is named rather than absent. An absent line reads as "TreeMap
 * did not think of this"; an unavailable one reads as "TreeMap knows, and here
 * is why it cannot tell you".
 */
export function purgeableLine(plat: NodeJS.Platform): StatementLine {
  const reason =
    plat === 'darwin'
      ? 'macOS reports purgeable space only through a native API (NSURLVolumeAvailableCapacityForImportantUsageKey). diskutil, diskutil apfs and system_profiler were each checked on this machine and none carries the figure, and TreeMap ships no native code — so this cannot be measured here.'
      : plat === 'win32'
        ? 'Windows has no purgeable-space concept; space reclaimable by Storage Sense is not reported as used, so there is nothing to account for on this line.'
        : 'This filesystem has no purgeable-space concept, so there is nothing to account for on this line.';
  return {
    id: 'purgeable',
    label: 'Purgeable',
    bytes: null,
    available: false,
    reason,
    detail:
      plat === 'darwin'
        ? 'Space macOS counts as used but will free automatically when the disk fills — caches, downloaded content and old snapshots. On this machine it is one of the largest things sitting inside Unaccounted.'
        : 'Space the operating system counts as used but would free automatically under pressure.',
    count: null,
    notes: [],
    remedy: null,
  };
}

async function openHandleLine(sources: StatementSources): Promise<StatementLine> {
  const remedy: StatementRemedy = {
    action: 'review-open-handles',
    label: 'See what is holding it',
    caveat:
      'TreeMap only asks a program to quit. It refuses system processes, itself and its own parent, and a program that declines is reported as still running rather than force-killed.',
  };
  try {
    const report = await sources.zombies();
    if (report.processes.length === 0) {
      return {
        id: 'openHandles',
        label: 'Held by programs still running',
        bytes: 0,
        available: true,
        detail: 'Nothing on this machine is holding a deleted file open, so no space is being held back.',
        count: 0,
        notes: [],
        remedy: null,
      };
    }
    const notes: string[] = [];
    if (report.unknownSizeCount > 0) {
      notes.push(
        `${String(report.unknownSizeCount)} held file${report.unknownSizeCount === 1 ? '' : 's'} could not be sized, so this line is a floor, not a total. The remainder is in Unaccounted.`,
      );
    }
    return {
      id: 'openHandles',
      label: 'Held by programs still running',
      bytes: report.totalBytes,
      available: true,
      detail:
        'Files that were deleted while a program still had them open. The space is not returned until that program lets go, and no directory walk can see them.',
      count: report.processes.length,
      notes,
      remedy,
    };
  } catch (err) {
    return {
      id: 'openHandles',
      label: 'Held by programs still running',
      bytes: null,
      available: false,
      reason: msg(err),
      detail: 'Deleted files a program still holds open. Their space is not returned until the program lets go.',
      count: null,
      notes: [],
      remedy: null,
    };
  }
}

function otherVolumesLine(
  volumes: readonly LogicalVolumeInfo[],
  volume: LogicalVolumeInfo,
  onSameDevice: readonly LogicalVolumeInfo[],
  plat: NodeJS.Platform,
): StatementLine {
  // "Other" means a different filesystem in the same pool. The firmlinked twin
  // is the same filesystem seen twice, and booking it here would double-count
  // the largest volume on the machine.
  const ours = new Set(onSameDevice.map((v) => v.id));
  const siblings = containerSiblings(volumes, volume, plat).filter((v) => !ours.has(v.id));
  const sized = siblings.filter((v) => v.usedBytes !== null);
  const unsized = siblings.filter((v) => v.usedBytes === null);

  if (siblings.length === 0) {
    return {
      id: 'otherVolumes',
      label: 'Other volumes sharing this disk space',
      bytes: 0,
      available: true,
      detail:
        plat === 'darwin'
          ? 'Nothing else shares this storage pool, so no space is going anywhere else.'
          : "This filesystem's total covers only itself — other filesystems on the same drive are not inside the number above, so there is nothing to subtract here.",
      count: 0,
      notes: [],
      remedy: null,
    };
  }
  if (sized.length === 0) {
    return {
      id: 'otherVolumes',
      label: 'Other volumes sharing this disk space',
      bytes: null,
      available: false,
      reason: `${String(siblings.length)} other volume${siblings.length === 1 ? '' : 's'} share this pool, but the system did not report how much any of them uses.`,
      detail: 'Volumes in the same container draw on one pool of free space, and a scan of one never walks the others.',
      count: siblings.length,
      notes: [],
      remedy: null,
    };
  }

  const bytes = sized.reduce((sum, v) => sum + (v.usedBytes ?? 0), 0);
  const notes = sized
    .slice()
    .sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))
    .map((v) => `${v.name ?? v.id} (${v.mountPoint ?? 'not mounted'}) — ${formatBytes(v.usedBytes ?? 0)}`);
  if (unsized.length > 0) {
    notes.push(
      `${String(unsized.length)} more volume${unsized.length === 1 ? '' : 's'} in this pool reported no usage figure, so anything they hold is in Unaccounted.`,
    );
  }
  return {
    id: 'otherVolumes',
    label: 'Other volumes sharing this disk space',
    bytes,
    available: true,
    detail:
      'Volumes in the same container draw on one shared pool of free space. A scan of one volume never walks the others, but their bytes still come out of the same total.',
    count: sized.length,
    notes,
    remedy: null,
  };
}

/**
 * Engines that count what they were refused.
 *
 * The walker does, because it sees every `readdir` rejection itself. **gdu does
 * not**, and that was measured rather than assumed: pointed at a directory with
 * mode 000, `gdu -o-` exits 0 and emits it as an ordinary *empty* directory —
 * no error key, no annotation, byte-identical in shape to a directory that
 * genuinely has nothing in it. `gdu --help` offers no flag that changes this.
 *
 * So on a gdu scan the count is not zero, it is unknown, and the line says so.
 * Printing "0 refused" from an engine that cannot tell would be precisely the
 * confidently-wrong answer this whole view exists to eliminate.
 */
const ENGINES_THAT_COUNT_REFUSALS: ReadonlySet<string> = new Set(['walker', 'turbo-walker']);

/**
 * What the scan was refused.
 *
 * Bytes are `null` and always will be: a directory that will not open has an
 * unknowable size, and so does a file whose `lstat` was denied. The count is
 * the entire truth available, and reporting it as a count with no bytes is the
 * honest shape — a byte estimate here would be invented.
 */
function unscannableLine(scan: ScanResult): StatementLine {
  const engine = scan.engine ?? 'walker';
  if (!ENGINES_THAT_COUNT_REFUSALS.has(engine)) {
    return {
      id: 'unscannable',
      label: 'Refused to the scan',
      bytes: null,
      available: false,
      reason: `This scan was produced by the ${engine} engine, which reports a folder it was refused as an ordinary empty folder — so how many were refused, and how much they hold, cannot be known from it.`,
      detail: 'Folders and files the operating system would not let this scan read.',
      count: null,
      notes: [
        'A scan run by the built-in walker counts these exactly. Set TREEMAP_NO_GDU=1 to force it, at some cost in speed.',
      ],
      remedy: null,
    };
  }
  const denied = (scan.deniedDirs ?? 0) + (scan.deniedEntries ?? 0);
  const broken = (scan.unreadableDirs ?? 0) + (scan.unreadableEntries ?? 0);
  const total = denied + broken;

  if (total === 0) {
    return {
      id: 'unscannable',
      label: 'Refused to the scan',
      bytes: 0,
      available: true,
      detail: 'Nothing refused this scan, so there is no hidden space on that account.',
      count: 0,
      notes: [],
      remedy: null,
    };
  }
  const notes: string[] = [];
  if (denied > 0) notes.push(`${String(denied)} refused permission — granting Full Disk Access usually resolves these.`);
  if (broken > 0) notes.push(`${String(broken)} could not be read for another reason, such as a mount that stopped responding.`);
  return {
    id: 'unscannable',
    label: 'Refused to the scan',
    bytes: null,
    available: false,
    reason: `${String(total)} item${total === 1 ? ' was' : 's were'} refused, and something that will not open cannot be sized. How much they hold is unknown, and it is inside Unaccounted.`,
    detail: 'Folders and files the operating system would not let this scan read.',
    count: total,
    notes,
    remedy: null,
  };
}

/* ────────────────────────────────── helpers ────────────────────────────────── */

/**
 * Prove the receipt adds up, on every build of it.
 *
 * §5.2 asks for this invariant to be asserted directly. Asserting it *here*,
 * rather than only in the test file, means a future line that forgets to
 * participate in the sum fails immediately and loudly instead of shipping a
 * statement that is quietly wrong by exactly its own size.
 */
export function assertBalances(s: AccountingStatement): void {
  const sum = s.lines.reduce((acc, l) => acc + (l.bytes ?? 0), 0);
  if (sum !== s.volume.usedBytes) {
    throw new Error(
      `the accounting statement does not balance: lines sum to ${String(sum)} but the volume reports ${String(s.volume.usedBytes)} used (off by ${String(s.volume.usedBytes - sum)})`,
    );
  }
}

// Bytes in notes go through the shared formatBytes (binary units), the same
// function the page uses for every line and chip: a private decimal
// formatter here made "9.1 GB" sit under an "11.6 GB" row it was part of.

function osName(plat: NodeJS.Platform): string {
  if (plat === 'darwin') return 'macOS';
  if (plat === 'win32') return 'Windows';
  if (plat === 'linux') return 'Linux';
  return 'the operating system';
}

/** The footnote's opening in plain words: which disk, according to whom. */
function describeMechanism(volume: LogicalVolumeInfo, plat: NodeJS.Platform): string {
  const name = volume.name && volume.name.trim() ? volume.name.trim() : 'this disk';
  return `what ${osName(plat)} reports for ${name}`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
