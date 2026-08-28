import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { runText, CommandUnavailableError } from '../exec';
import type { VolumeSnapshotRef } from '../types';

/**
 * Local APFS snapshots on macOS (B4) via `tmutil`.
 *
 * Mechanism choice (§2.3): tier 3, a system binary. `tmutil` is the documented
 * interface to local Time Machine snapshots and has **no structured output
 * mode** — `listlocalsnapshots` prints one snapshot name per line under a
 * header. §2.3 permits parsing here precisely because no `--json` exists; the
 * parse reads whole lines against a fixed, Apple-defined prefix
 * (`com.apple.TimeMachine.`) rather than pattern-matching prose. Noted in
 * docs/PLATFORM_NOTES.md as required.
 *
 * The existing services/snapshotAccounting.ts already lists these for the
 * "space held by snapshots" number. This module goes further, to what B4 needs:
 * *mounting* a snapshot so a deleted file can be read back out of it.
 *
 * Mounting: `mount_apfs -s <snapshotName> <volume> <mountpoint>` attaches the
 * snapshot read-only. It is done lazily — only when a restore is actually
 * attempted — and unmounted immediately afterwards, because a left-behind
 * snapshot mount holds disk space that the user cannot free from Finder.
 *
 * Unavailable when: local snapshots are disabled (Time Machine never
 * configured), which is common on Macs whose owner uses no backup. Reported as
 * "no snapshots exist", which is true, rather than as an error.
 */

const SNAPSHOT_PREFIX = 'com.apple.TimeMachine.';

/**
 * Parse `tmutil listlocalsnapshots <volume>`.
 *
 * Exported for unit tests. Real output looks like:
 *
 *     Snapshots for disk /:
 *     com.apple.TimeMachine.2026-07-27-101500.local
 *
 * The header line and any blank lines are not snapshots; only lines carrying
 * Apple's own prefix are.
 */
export function parseSnapshotList(stdout: string, volume: string): VolumeSnapshotRef[] {
  const out: VolumeSnapshotRef[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(SNAPSHOT_PREFIX)) continue;
    out.push({
      id: line,
      name: line,
      takenAt: parseSnapshotDate(line),
      volume,
      // Snapshots are not readable until mounted; mountSnapshot() fills this in.
      accessPath: null,
    });
  }
  return out;
}

/**
 * `com.apple.TimeMachine.2026-07-27-101500.local` → epoch ms.
 *
 * The timestamp is local time, not UTC — constructing it through `Date.UTC`
 * would silently shift every snapshot by the machine's offset, which is exactly
 * the sort of quietly-wrong number §10 forbids.
 */
export function parseSnapshotDate(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The local snapshots on a volume.
 *
 * `tmutil` missing is a genuine "nothing to offer" and answers `[]`. Anything
 * else is rethrown, because the alternative is a lie the caller repeats: a
 * 15-second timeout, a kill, or an I/O error used to come back as an empty
 * list, and the recovery path turns an empty list into the sentence "This
 * system has no filesystem snapshots to recover from." Telling someone
 * looking for a lost file that there is nothing to recover from, when the
 * truth is that the question was not answered, is the one failure this
 * feature cannot afford — they stop looking.
 *
 * Both callers (`snapshotRecovery`) already catch, and now distinguish.
 */
export async function listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
  try {
    const stdout = await runText('tmutil', ['listlocalsnapshots', volume], { timeoutMs: 15_000 });
    return parseSnapshotList(stdout, volume);
  } catch (err) {
    if (err instanceof CommandUnavailableError) return []; // no Time Machine here at all
    throw err;
  }
}

export interface MountedSnapshot {
  mountPoint: string;
  unmount: () => Promise<void>;
}

/**
 * Mount one snapshot read-only and hand back its mount point.
 *
 * Always paired with `unmount()` by the caller (try/finally): an orphaned
 * snapshot mount is invisible in Finder but pins the snapshot's storage, so
 * leaking one turns a restore feature into a disk-space leak.
 */
export async function mountSnapshot(snapshot: VolumeSnapshotRef): Promise<MountedSnapshot> {
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-snap-'));
  try {
    await runText('mount_apfs', ['-s', snapshot.id, snapshot.volume, mountPoint], { timeoutMs: 30_000 });
  } catch (err) {
    await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return {
    mountPoint,
    unmount: async () => {
      await runText('umount', [mountPoint], { timeoutMs: 30_000 }).catch(() => {});
      await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
    },
  };
}
