import { promises as fsp } from 'fs';
import type { MountEntry } from '../platform/atime';
import { readMountTable } from '../utils/mountBoundaries';

/**
 * Which APFS container a volume draws its free space from (fourth browser pass E01, review F1.5).
 *
 * On a Mac the volumes of one APFS container — the Data volume, VM, Preboot, and any volume a person
 * adds such as `/Volumes/Dev` — are separate devices (each its own st_dev) that share ONE pool of free
 * space: `df` reports the same "Available" for every one of them. A copy onto a sibling volume
 * therefore frees nothing, exactly as a copy onto the same volume does, while a device comparison
 * calls them different drives. Two partitions of one physical disk are the opposite case: separate
 * file systems with space of their own, so only APFS is grouped here.
 *
 * Read off the mount table, which names each mounted volume's device: an APFS volume is
 * `/dev/disk<N>s<M>` (its snapshot `/dev/disk<N>s<M>s<K>`, as the sealed root is mounted) in the
 * container `disk<N>`. `mount` reads the kernel's table — no disk arbitration daemon, so not the
 * empty answers `diskutil` can give under load (platform/macos/diskutil.ts).
 */

/** The device (st_dev) a path really lives on, every link followed, or null when it cannot be read. */
export type DeviceOf = (p: string) => Promise<bigint | null>;

/** An APFS volume's device, and its container: disk3s5 → disk3, the snapshot disk3s1s1 → disk3. */
const APFS_VOLUME = /^\/dev\/(disk\d+)s\d+(?:s\d+)?$/;

/** The device a path is on, by stat (links followed); null when it cannot be read. */
export function statDevice(p: string): Promise<bigint | null> {
  return fsp.stat(p, { bigint: true }).then((st) => st.dev, () => null);
}

/**
 * The container each mounted APFS volume belongs to, keyed by the device its mount point is on. An
 * entry of another file system, one whose device the table does not name as an APFS volume (a nullfs
 * view, a map), or one whose mount point cannot be read is left out: its device alone decides.
 */
export async function apfsContainerByDevice(entries: readonly MountEntry[], deviceOf: DeviceOf): Promise<Map<bigint, string>> {
  const found = await Promise.all(entries.map(async (entry): Promise<[bigint, string] | null> => {
    if (entry.filesystem !== 'apfs') return null;
    const volume = APFS_VOLUME.exec(entry.source ?? '');
    if (!volume) return null;
    const device = await deviceOf(entry.mountPoint);
    return device === null ? null : [device, volume[1]];
  }));
  return new Map(found.filter((pair): pair is [bigint, string] => pair !== null));
}

/**
 * This machine's containers, read fresh (a volume added since the last call is in this one). Empty
 * anywhere but macOS, and when the table cannot be read — the devices then decide alone, as they did
 * before containers were known.
 */
export async function liveApfsContainers(platform: NodeJS.Platform = process.platform): Promise<Map<bigint, string>> {
  if (platform !== 'darwin') return new Map();
  const table = await readMountTable(platform);
  return table.entries ? apfsContainerByDevice(table.entries, statDevice) : new Map();
}

/**
 * The `paths` that draw on the same APFS container as `anchor` (the root, for "this computer's own
 * disk"). A path whose device is no known APFS volume, or an anchor whose container is not known,
 * shares space with nothing this can name.
 */
export async function sameSpaceAs(
  anchor: string,
  paths: readonly string[],
  containers: ReadonlyMap<bigint, string>,
  deviceOf: DeviceOf,
): Promise<Set<string>> {
  const anchorDevice = await deviceOf(anchor);
  const container = anchorDevice === null ? undefined : containers.get(anchorDevice);
  if (container === undefined) return new Set();
  const devices = await Promise.all(paths.map((p) => deviceOf(p)));
  return new Set(paths.filter((_, i) => {
    const device = devices[i];
    return device !== null && containers.get(device) === container;
  }));
}
