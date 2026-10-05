import type { MountTable } from '../../src/utils/mountBoundaries';

/**
 * Mount tables as the operating systems print them (Track U, U-23).
 *
 * DIAGNOSIS_MAC_MOUNT is the `mount` output of the Mac the Track U diagnosis
 * ran on (macOS 27, 2 Oct 2026), redacted: the account name that `mounted by`
 * carries is replaced by `someone`, and the per-user hash in the
 * `/private/var/folders` path by a placeholder. Everything else is verbatim —
 * the four mounts a scan of `/` crossed (the simulator runtime bundle, the two
 * iOS Simulator volumes and the Clocks app's nullfs wrapper) and the system
 * mounts that sit under folders no walk descends into.
 */

/** The placeholder that stands for the per-user `/private/var/folders/<a>/<hash>` part. */
export const FOLDERS_PLACEHOLDER = '/private/var/folders/zz/USER_TEMP_PLACEHOLDER';

export const CLOCKS_NULLFS = `${FOLDERS_PLACEHOLDER}/X/4B95722A-8BD9-5BD6-B120-9A62AAC0CDE6`;
export const SIM_RUNTIME_BUNDLE = '/Library/Developer/CoreSimulator/Cryptex/Images/bundle/SimRuntimeBundle-AC21E6AE-F214-44AE-899C-FF1E68367344';
export const IOS_22E238 = '/Library/Developer/CoreSimulator/Volumes/iOS_22E238';
export const IOS_23F77 = '/Library/Developer/CoreSimulator/Volumes/iOS_23F77';

/** The four mounts a scan of `/` crossed on the diagnosis Mac, sorted. */
export const CROSSED_AT_ROOT = [SIM_RUNTIME_BUNDLE, IOS_22E238, IOS_23F77, CLOCKS_NULLFS].sort();

/** The system mounts under the fixed never-descend folders (`/dev`, `/System/Volumes`), sorted. */
export const SYSTEM_MOUNTS_AT_ROOT = [
  '/dev',
  '/System/Volumes/VM',
  '/System/Volumes/Preboot',
  '/System/Volumes/Update',
  '/System/Volumes/xarts',
  '/System/Volumes/iSCPreboot',
  '/System/Volumes/Hardware',
  '/System/Volumes/Data',
  '/System/Volumes/Data/home',
].sort();

export const DIAGNOSIS_MAC_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)',
  '/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)',
  '/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)',
  '/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  `/Applications/Clocks.app/Wrapper on ${CLOCKS_NULLFS} (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by someone)`,
  `/dev/disk5s1 on ${SIM_RUNTIME_BUNDLE} (apfs, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)`,
  `/dev/disk7s1 on ${IOS_22E238} (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)`,
  `/dev/disk9s1 on ${IOS_23F77} (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)`,
  '',
].join('\n');

/** `/usr/share/firmlinks` on the same Mac, verbatim (tab-separated: the root's spelling, then the Data volume's). */
export const DIAGNOSIS_MAC_FIRMLINKS = [
  '/AppleInternal\tAppleInternal',
  '/Applications\tApplications',
  '/Library\tLibrary',
  '/System/Library/Caches\tSystem/Library/Caches',
  '/System/Library/Assets\tSystem/Library/Assets',
  '/System/Library/PreinstalledAssets\tSystem/Library/PreinstalledAssets',
  '/System/Library/AssetsV2\tSystem/Library/AssetsV2',
  '/System/Library/PreinstalledAssetsV2\tSystem/Library/PreinstalledAssetsV2',
  '/System/Library/CoreServices/CoreTypes.bundle/Contents/Library\tSystem/Library/CoreServices/CoreTypes.bundle/Contents/Library',
  '/System/Library/Speech\tSystem/Library/Speech',
  '/Users\tUsers',
  '/Volumes\tVolumes',
  '/cores\tcores',
  '/opt\topt',
  '/pkg\tpkg',
  '/private\tprivate',
  '/usr/local\tusr/local',
  '/usr/libexec/cups\tusr/libexec/cups',
  '/usr/share/snmp\tusr/share/snmp',
  '',
].join('\n');

/**
 * A Linux `/proc/mounts`: a separate `/home`, a backup drive whose name the
 * kernel escapes (`\040` is a space), Docker's file bind mount of
 * `/etc/hosts`, and the pseudo filesystems under the fixed list.
 */
export const LINUX_PROC_MOUNTS = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'udev /dev devtmpfs rw,nosuid,relatime,size=8087432k,nr_inodes=2021858,mode=755 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=1627196k,mode=755 0 0',
  '/dev/sda2 / ext4 rw,relatime,errors=remount-ro 0 0',
  '/dev/sda3 /home ext4 rw,noatime 0 0',
  '/dev/sdb1 /mnt/my\\040disk ext4 rw,strictatime 0 0',
  '/dev/sda2 /etc/hosts ext4 rw,relatime 0 0',
  '',
].join('\n');

/**
 * A table, as `readMountTable` answers it, that names exactly `paths` as
 * mount points — ordinary folders a test made, so nothing is mounted. For
 * `setBoundaryDepsForTests({ readTable })`.
 */
export function mountTableNaming(paths: readonly string[]): MountTable {
  return {
    source: 'mount',
    entries: paths.map((p) => ({ mountPoint: p, filesystem: 'apfs', options: ['apfs', 'local'], source: '/dev/disk99s1' })),
    reason: null,
  };
}
