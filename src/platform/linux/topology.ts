import { promises as fsp } from 'fs';
import { runJson, runText, reasonOf } from '../exec';
import type { LogicalVolumeInfo, PhysicalDiskInfo, VolumeTopology } from '../types';

/**
 * Volume topology on Linux (A5).
 *
 * Mechanism choice (§2.3): tier 3, system binaries — but every one of them in a
 * genuine JSON mode, so §10's "no regex over human output" holds throughout:
 *
 *   - `lsblk --json`      — the device tree: disks, partitions, LVM mappers,
 *                           md-RAID members, mount points, sizes, rotational flag
 *   - `lvs/vgs/pvs --reportformat json` — LVM logical→physical mapping
 *   - `zpool list -j`     — ZFS pools (JSON since zfs 2.2)
 *
 * `mdadm --detail` has **no** JSON mode, but `lsblk --json` already reports md
 * devices with their `children`, which is the mapping A5 needs — so mdadm is
 * not shelled out to at all rather than parsed as prose.
 *
 * The design point: `lsblk --json` alone answers the question on the vast
 * majority of machines, including plain single-disk ones, where it degrades to
 * exactly the "simple and uncluttered" 1:1 view A5 asks for. LVM and ZFS are
 * queried only when lsblk shows something that needs them, so a laptop with
 * neither installed pays for neither.
 */

interface LsblkNode {
  name?: string;
  path?: string;
  type?: string;
  size?: number | string;
  fstype?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  rota?: boolean;
  model?: string | null;
  fsavail?: number | string | null;
  fssize?: number | string | null;
  fsused?: number | string | null;
  children?: LsblkNode[];
}

interface LsblkDoc {
  blockdevices?: LsblkNode[];
}

/**
 * lsblk reports sizes as bytes with `--bytes`, but older builds emit strings
 * ("500G"). Only a genuine number is trusted; a string becomes `null` rather
 * than a guess, because a mis-parsed size is worse than an absent one.
 */
function bytesOf(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** lsblk moved from `mountpoint` to a `mountpoints` array; support both. */
function mountOf(node: LsblkNode): string | null {
  if (typeof node.mountpoint === 'string' && node.mountpoint.length > 0) return node.mountpoint;
  const first = (node.mountpoints ?? []).find((m): m is string => typeof m === 'string' && m.length > 0);
  return first ?? null;
}

/**
 * Flatten lsblk's device tree into physical disks and logical volumes.
 *
 * Pure and exported: this is the only way to test the interesting layouts —
 * LVM on md-RAID, LUKS over LVM, a plain laptop — from a machine that has none
 * of them. Fixtures recorded from real `lsblk --json` output drive the tests.
 */
export function mapLsblk(doc: LsblkDoc): VolumeTopology {
  const physicalDisks: PhysicalDiskInfo[] = [];
  const logicalVolumes: LogicalVolumeInfo[] = [];

  const walk = (node: LsblkNode, backingDisks: string[]): void => {
    const id = node.path ?? node.name;
    if (!id) return;
    const type = node.type ?? '';

    if (type === 'disk') {
      physicalDisks.push({
        id,
        name: node.model ?? null,
        sizeBytes: bytesOf(node.size),
        // `rota` is the kernel's own answer from /sys/block/*/queue/rotational —
        // detected, never inferred from the device name.
        rotational: typeof node.rota === 'boolean' ? node.rota : null,
      });
      for (const child of node.children ?? []) walk(child, [id]);
      return;
    }

    // Anything mountable is a logical volume as far as A5 is concerned:
    // partitions, LVM logical volumes, md arrays, LUKS mappings.
    const mountPoint = mountOf(node);
    const isContainerOnly = (node.children ?? []).length > 0 && mountPoint === null;

    if (!isContainerOnly) {
      const total = bytesOf(node.fssize) ?? bytesOf(node.size);
      logicalVolumes.push({
        id,
        name: node.name ?? null,
        mountPoint,
        filesystem: node.fstype ?? null,
        sizeBytes: total,
        freeBytes: bytesOf(node.fsavail),
        // FSUSED is the kernel's own statvfs-derived figure. It is NOT
        // fssize − fsavail: fsavail excludes ext4's root reserve, and that
        // subtraction would book the reserve as data. Absent column → null.
        usedBytes: bytesOf(node.fsused),
        physicalDiskIds: backingDisks,
        kind: kindOf(type),
      });
    }

    // An md array or LVM group spans several disks, so children inherit the
    // union of everything above them — that union is what makes "which physical
    // drive is actually filling up" answerable at all.
    for (const child of node.children ?? []) walk(child, backingDisks);
  };

  for (const device of doc.blockdevices ?? []) walk(device, []);
  return { physicalDisks, logicalVolumes, mechanism: 'lsblk --json' };
}

function kindOf(lsblkType: string): string {
  switch (lsblkType) {
    case 'lvm':
      return 'lvm';
    case 'raid0':
    case 'raid1':
    case 'raid5':
    case 'raid6':
    case 'raid10':
      return 'md-raid';
    case 'crypt':
      return 'luks';
    case 'part':
      return 'partition';
    default:
      return lsblkType || 'simple';
  }
}

/**
 * Is a block device spinning media?
 *
 * Read straight from sysfs rather than guessed. This is what A1 sizes its
 * enumeration concurrency from: the right width for an NVMe queue is an order
 * of magnitude away from the right width for a 5400 rpm disk, and the README's
 * existing finding — that oversized concurrency is *slower* through kernel
 * metadata-lock contention — makes the difference matter in both directions.
 */
export async function isRotational(deviceName: string): Promise<boolean | null> {
  try {
    const raw = await fsp.readFile(`/sys/block/${deviceName}/queue/rotational`, 'utf8');
    return raw.trim() === '1';
  } catch {
    return null;
  }
}

/** Device queue depth, when the kernel exposes it. */
export async function queueDepth(deviceName: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(`/sys/block/${deviceName}/queue/nr_requests`, 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function volumeTopology(): Promise<VolumeTopology> {
  // --bytes forces numeric sizes; -O asks for every column, so a build that
  // lacks one of them simply omits it rather than failing the whole call.
  const doc = await runJson<LsblkDoc>('lsblk', ['--json', '--bytes', '-O'], { timeoutMs: 15_000 }).catch(
    async () => runJson<LsblkDoc>('lsblk', ['--json', '--bytes'], { timeoutMs: 15_000 }),
  );
  const topology = mapLsblk(doc);

  // ZFS pools are invisible to lsblk (they are not block devices), so a
  // ZFS-root machine would otherwise show its data volumes as missing entirely.
  try {
    const zfs = await runJson<ZpoolDoc>('zpool', ['list', '-j'], { timeoutMs: 10_000 });
    topology.logicalVolumes.push(...mapZpool(zfs));
    if (topology.logicalVolumes.some((v) => v.kind === 'zfs')) topology.mechanism = 'lsblk --json + zpool list -j';
  } catch {
    /* no ZFS on this machine, or a build predating `-j` — nothing to add */
  }

  return topology;
}

interface ZpoolDoc {
  pools?: Record<
    string,
    {
      name?: string;
      properties?: { size?: { value?: string }; free?: { value?: string }; allocated?: { value?: string } };
    }
  >;
}

/** Map `zpool list -j` (zfs ≥ 2.2) into logical volumes. Pure, for tests. */
export function mapZpool(doc: ZpoolDoc): LogicalVolumeInfo[] {
  const out: LogicalVolumeInfo[] = [];
  for (const [key, pool] of Object.entries(doc.pools ?? {})) {
    const name = pool.name ?? key;
    out.push({
      id: `zfs:${name}`,
      name,
      mountPoint: `/${name}`,
      filesystem: 'zfs',
      sizeBytes: bytesOf(pool.properties?.size?.value ?? null),
      freeBytes: bytesOf(pool.properties?.free?.value ?? null),
      // `allocated` is zpool's own raw-space figure, the counterpart of `free`.
      usedBytes: bytesOf(pool.properties?.allocated?.value ?? null),
      physicalDiskIds: [],
      kind: 'zfs',
    });
  }
  return out;
}

/** Human-readable note about what could not be determined, for the capability. */
export async function topologyReason(): Promise<string | null> {
  try {
    await runText('lsblk', ['--version'], { timeoutMs: 5_000 });
    return null;
  } catch (err) {
    return `Disk layout needs the lsblk tool, which is not available (${reasonOf(err)}).`;
  }
}
