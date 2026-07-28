import { promises as fsp } from 'fs';
import { runPlist } from './plist';
import type { PhysicalDiskInfo, LogicalVolumeInfo, VolumeTopology } from '../types';

/**
 * Volume topology on macOS (A5) via `diskutil list -plist`.
 *
 * Mechanism choice (§2.3): tier 3, a system binary in its structured mode.
 *
 * ── Measured shape (macOS 15) ──
 *
 * `diskutil list -plist` answers the whole question in ONE call, which matters
 * because the obvious implementation — `diskutil info` per volume — is a
 * subprocess per volume and this machine alone has eleven. Entries in
 * `AllDisksAndPartitions` are of two kinds, distinguished by whether they carry
 * `APFSPhysicalStores`:
 *
 *   - **Real hardware** (`disk0`): has `Partitions`, no `APFSPhysicalStores`.
 *   - **Synthesised APFS containers** (`disk1`…`disk3`): carry
 *     `APFSPhysicalStores` naming the *partition* they live on (`disk0s2`), and
 *     `APFSVolumes` with mount points and used capacity.
 *
 * So a container's backing hardware is its physical store with the partition
 * suffix stripped: `disk0s2` → `disk0`. Getting that wrong is what produces the
 * classic wrong answer — attributing a volume to a partition as if partitions
 * were drives, so a Mac with one SSD appears to have four.
 *
 * A plain single-disk machine therefore still renders as one physical disk with
 * its volumes beneath it, which is the "clean 1:1 mapping, no clutter" A5 asks
 * for — not a hidden panel.
 *
 * Unavailable when: `diskutil` cannot be run (it is part of the base system, so
 * effectively never) — reported as a reason, not a throw.
 */

interface DiskutilVolume {
  DeviceIdentifier?: string;
  VolumeName?: string;
  MountPoint?: string;
  CapacityInUse?: number;
  Size?: number;
  Content?: string;
}

interface DiskutilEntry {
  DeviceIdentifier?: string;
  Size?: number;
  Content?: string;
  Partitions?: DiskutilVolume[];
  APFSVolumes?: DiskutilVolume[];
  APFSPhysicalStores?: { DeviceIdentifier?: string }[];
}

interface DiskutilList {
  AllDisksAndPartitions?: DiskutilEntry[];
}

/**
 * `disk0s2` → `disk0`; `disk3s1s1` → `disk3`.
 *
 * Exported for tests: APFS snapshot volumes carry a doubled suffix
 * (`disk3s1s1`), and a naive "strip the last sN" would leave `disk3s1`, which
 * is a partition rather than a drive.
 */
export function wholeDiskOf(deviceIdentifier: string): string {
  const m = deviceIdentifier.match(/^(disk\d+)/);
  return m ? m[1] : deviceIdentifier;
}

/**
 * Build the topology from a parsed `diskutil list -plist` document.
 *
 * Pure, and exported, so the mapping can be asserted against recorded fixtures
 * from machines this one is not — a Fusion drive, a multi-disk Mac Pro — which
 * is the only way to test the interesting cases here.
 */
export function mapTopology(doc: DiskutilList): VolumeTopology {
  const entries = doc.AllDisksAndPartitions ?? [];
  const physicalDisks: PhysicalDiskInfo[] = [];
  const logicalVolumes: LogicalVolumeInfo[] = [];

  for (const entry of entries) {
    const id = entry.DeviceIdentifier;
    if (!id) continue;
    const isContainer = Array.isArray(entry.APFSPhysicalStores) && entry.APFSPhysicalStores.length > 0;

    if (!isContainer) {
      physicalDisks.push({
        id,
        name: entry.Content ?? null,
        sizeBytes: typeof entry.Size === 'number' ? entry.Size : null,
        // diskutil list does not carry SolidState; the provider fills it in
        // separately only for disks it actually needs it for.
        rotational: null,
      });
    }

    // Which hardware backs this entry's volumes.
    const backing = isContainer
      ? [...new Set((entry.APFSPhysicalStores ?? []).map((s) => wholeDiskOf(s.DeviceIdentifier ?? '')).filter(Boolean))]
      : [id];

    for (const vol of entry.APFSVolumes ?? []) {
      if (!vol.DeviceIdentifier) continue;
      logicalVolumes.push({
        id: vol.DeviceIdentifier,
        name: vol.VolumeName ?? null,
        mountPoint: vol.MountPoint ?? null,
        filesystem: 'apfs',
        sizeBytes: typeof entry.Size === 'number' ? entry.Size : null,
        freeBytes: null, // container-level, filled by enrichTopology from statfs
        // The volume's own consumption, straight from the same diskutil call.
        // This — not Size, which is the shared container ceiling — is the number
        // that may be summed across the volumes of one container.
        usedBytes: typeof vol.CapacityInUse === 'number' ? vol.CapacityInUse : null,
        physicalDiskIds: backing,
        kind: 'apfs',
      });
    }

    // Non-APFS partitions (HFS+, exFAT, FAT32, Windows volumes on a Boot Camp
    // Mac). Skipping these would make an external exFAT drive invisible in a
    // panel whose whole job is "which drive is filling up".
    for (const part of entry.Partitions ?? []) {
      if (!part.DeviceIdentifier) continue;
      // APFS container partitions are represented by their container entry.
      if ((part.Content ?? '').startsWith('Apple_APFS')) continue;
      logicalVolumes.push({
        id: part.DeviceIdentifier,
        name: part.VolumeName ?? null,
        mountPoint: part.MountPoint ?? null,
        filesystem: part.Content ?? null,
        sizeBytes: typeof part.Size === 'number' ? part.Size : null,
        freeBytes: null,
        usedBytes: null, // a dedicated partition's usage comes from statfs, in enrichTopology
        physicalDiskIds: [wholeDiskOf(part.DeviceIdentifier)],
        kind: 'partition',
      });
    }
  }

  // A booted Mac lists the system volume twice: as the volume itself (disk3s1)
  // and as the sealed snapshot it actually boots from (disk3s1s1), each carrying
  // the same CapacityInUse. They are one store seen two ways, and keeping both
  // would book the system volume's bytes twice in any per-disk sum — so the
  // pair collapses to the mounted view (the snapshot, on every booted machine).
  const byId = new Map(logicalVolumes.map((v) => [v.id, v]));
  const dropped = new Set<string>();
  for (const vol of logicalVolumes) {
    const doubled = vol.id.match(/^(disk\d+s\d+)s\d+$/);
    if (!doubled) continue;
    const base = byId.get(doubled[1]);
    if (!base) continue;
    // Prefer dropping the unmounted member; when both are mounted (mid-update),
    // the base volume's mount is transient machinery, so it is still the one
    // that goes.
    dropped.add(!vol.mountPoint && base.mountPoint ? vol.id : base.id);
  }

  return {
    physicalDisks,
    logicalVolumes: logicalVolumes.filter((v) => !dropped.has(v.id)),
    mechanism: 'diskutil list -plist',
  };
}

/** The slice of `diskutil info -plist <disk>` the enrichment reads. */
interface DiskutilInfo {
  MediaName?: string;
  SolidState?: boolean;
}

/**
 * Fill in what `diskutil list` does not carry: the disk's real product name
 * ("APPLE SSD AP0512Z" rather than "GUID_partition_scheme"), whether it spins,
 * and per-volume free space.
 *
 * Two sources, both best-effort — a probe that fails leaves its field null
 * rather than failing the topology (§6, failure isolation):
 *
 *   - `diskutil info -plist <disk>`, once per physical disk (one or two on
 *     almost every machine, so the subprocess-per-volume trap the mapper's
 *     header warns about does not apply here).
 *   - `statfs` on each mounted volume, same field semantics as A2's
 *     reconciliation: free is `bavail` (what a user can actually write), used
 *     is derived from `bfree` so the root reserve is not misread as data.
 *
 * On APFS, statfs reports the *container's* shared free space for every volume
 * in it — that genuinely is the space available to each volume, but summing
 * `freeBytes` across siblings double-counts. `usedBytes` from diskutil's
 * per-volume CapacityInUse is kept in preference to a statfs-derived figure for
 * exactly that reason: statfs "used" on an APFS volume would be the whole
 * container's, and every volume would look like it consumed everything.
 */
export async function enrichTopology(topology: VolumeTopology): Promise<VolumeTopology> {
  await Promise.all([
    ...topology.physicalDisks.map(async (disk) => {
      try {
        const info = await runPlist<DiskutilInfo>('diskutil', ['info', '-plist', disk.id]);
        if (typeof info.MediaName === 'string' && info.MediaName.length > 0) disk.name = info.MediaName;
        if (typeof info.SolidState === 'boolean') disk.rotational = !info.SolidState;
      } catch {
        /* the disk stays as diskutil list described it */
      }
    }),
    ...topology.logicalVolumes.map(async (volume) => {
      if (!volume.mountPoint) return; // unmounted: nothing to ask the filesystem
      try {
        const st = await fsp.statfs(volume.mountPoint);
        const blockSize = Number(st.bsize);
        volume.freeBytes = Number(st.bavail) * blockSize;
        if (volume.usedBytes === null) {
          volume.usedBytes = (Number(st.blocks) - Number(st.bfree)) * blockSize;
        }
      } catch {
        /* stays null — shown as unknown, never as zero */
      }
    }),
  ]);
  return topology;
}

export async function volumeTopology(): Promise<VolumeTopology> {
  const doc = await runPlist<DiskutilList>('diskutil', ['list', '-plist']);
  const topology = await enrichTopology(mapTopology(doc));
  topology.mechanism = 'diskutil list -plist + statfs';
  return topology;
}
