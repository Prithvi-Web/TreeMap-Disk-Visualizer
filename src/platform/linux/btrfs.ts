import { runText, CommandUnavailableError } from '../exec';
import type { VolumeSnapshotRef } from '../types';

/**
 * Btrfs snapshots (B4) and reflink awareness (A2) on Linux.
 *
 * Mechanism choice (§2.3): tier 3, the `btrfs` binary. It has **no JSON mode**
 * in the versions shipping on current distributions, so `subvolume list -s` is
 * parsed by field position. §2.3 permits this precisely because no structured
 * mode exists, and it is recorded in docs/PLATFORM_NOTES.md as required. The
 * parse keys off the tool's own fixed field labels (`ID`, `otime`, `path`)
 * rather than pattern-matching prose.
 *
 * Reflinks (A2): grouping files that share extents needs `FS_IOC_FIEMAP`, an
 * ioctl unreachable from Node. `filefrag -v` exposes the same extent map from
 * userspace, but it is one subprocess per file — usable for an on-demand
 * "what does this file really cost" tooltip, hopeless for sizing a whole tree.
 * So whole-tree sizing on Btrfs uses allocated blocks (exact per file, but
 * counting shared extents once per referencing file) and says so, exactly as
 * the macOS clone case does. No confident wrong number.
 */

/**
 * Parse `btrfs subvolume list -s <path>`.
 *
 * Real output, one snapshot per line:
 *
 *     ID 256 gen 30 cgen 30 top level 5 otime 2026-07-27 10:15:00 path snaps/home-2026-07-27
 *
 * Exported for unit tests — the only way to cover this from a machine without
 * Btrfs. Fields after `otime` are a date and a time, and `path` runs to the end
 * of the line, so a snapshot path containing spaces survives.
 */
export function parseSubvolumeList(stdout: string, volume: string): VolumeSnapshotRef[] {
  const out: VolumeSnapshotRef[] = [];

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('ID ')) continue;

    const pathIndex = line.indexOf(' path ');
    if (pathIndex === -1) continue;
    const subvolPath = line.slice(pathIndex + ' path '.length).trim();
    if (subvolPath.length === 0) continue;

    const idMatch = line.match(/^ID (\d+)/);
    const id = idMatch ? idMatch[1] : subvolPath;

    // otime is "YYYY-MM-DD HH:MM:SS", local time — parsing it as UTC would
    // shift every snapshot by the machine's offset.
    let takenAt: number | null = null;
    const otime = line.match(/ otime (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (otime) {
      const [, y, mo, d, h, mi, s] = otime;
      const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
      if (Number.isFinite(t)) takenAt = t;
    }

    out.push({
      id,
      name: subvolPath,
      takenAt,
      volume,
      // Btrfs snapshots are ordinary subvolumes already present in the tree —
      // unlike APFS and VSS they need no mount step, so their contents are
      // readable immediately.
      accessPath: subvolPath.startsWith('/') ? subvolPath : `${volume.replace(/\/$/, '')}/${subvolPath}`,
    });
  }
  return out;
}

export async function listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
  try {
    const stdout = await runText('btrfs', ['subvolume', 'list', '-s', volume], { timeoutMs: 15_000 });
    return parseSubvolumeList(stdout, volume);
  } catch (err) {
    if (err instanceof CommandUnavailableError) return [];
    return []; // not a Btrfs volume, or no permission — nothing to offer
  }
}

/** Is Btrfs snapshot support usable here, and if not, why not? */
export async function snapshotAvailability(volume = '/'): Promise<{ available: boolean; reason?: string }> {
  try {
    await runText('btrfs', ['--version'], { timeoutMs: 5_000 });
  } catch {
    return {
      available: false,
      reason:
        'Recovering deleted files from snapshots needs a Btrfs filesystem and the btrfs tools, which are not present on this system.',
    };
  }
  const snaps = await listSnapshots(volume);
  if (snaps.length === 0) {
    return {
      available: false,
      reason: 'This system has no Btrfs snapshots, so there is nothing to recover deleted files from.',
    };
  }
  return { available: true };
}
