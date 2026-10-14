import { listExternalVolumes, ExternalVolume } from './portableMode';
import { diskUsage } from './diskUsage';
import { liveApfsContainers, sameSpaceAs, statDevice } from './apfsContainers';

/**
 * volumes — attached external drives for the offload dock (§8.3).
 *
 * Discovery is portableMode's `listExternalVolumes` (the same heuristic the
 * portable picker uses: being wrong costs one extra click, never a write) and
 * capacity is diskUsage's syscall-first answer. The one rule this module adds:
 * a drive whose stats cannot be read is still LISTED — freeBytes/totalBytes
 * null plus the reason — because the user can see it plugged in, and a dock
 * that silently hides it would be lying by omission. diskUsage already refuses
 * to fabricate `0 B free` for a locked or empty volume; that refusal arrives
 * here as the reason string.
 */

export interface VolumeInfo {
  name: string;
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Present only when the stats could not be read. */
  reason?: string;
}

interface VolumeProviders {
  list: () => ExternalVolume[];
  usage: (target: string) => Promise<{ total: number; free: number }>;
  /**
   * Which of `paths` share the space of one of `anchors` — the same device, or another APFS volume of
   * its container (review F1.5, F2.1).
   */
  sameSpace: (anchors: readonly string[], paths: readonly string[]) => Promise<ReadonlySet<string>>;
}

/** Which of `paths` share the space of one of `anchors`, read off this machine's devices and mount table. */
export async function volumesSharingSpace(anchors: readonly string[], paths: readonly string[]): Promise<Set<string>> {
  return paths.length && anchors.length ? sameSpaceAs(anchors, paths, await liveApfsContainers(), statDevice) : new Set();
}

/** What a volume is judged against when no folder is named: this computer's own disk. */
const THIS_COMPUTERS_DISK = ['/'];

const realProviders: VolumeProviders = {
  list: () => listExternalVolumes(),
  usage: (target) => diskUsage(target),
  sameSpace: volumesSharingSpace,
};

let providers: VolumeProviders = realProviders;

/**
 * Test-only: swap discovery/stat for fakes so refusals can be driven. A provider left out keeps the
 * real one (review F2.2), so a test that stands in for the drive listing alone still runs the real
 * same-space judgement — the wiring GET /api/volumes depends on is then under test, not a stub.
 */
export function setVolumeProviders(next: Partial<VolumeProviders> | null): void {
  providers = next ? { ...realProviders, ...next } : realProviders;
}

/**
 * Why the volume list is structurally empty on this platform, or null where
 * discovery works. An empty dock backed by a missing mechanism must say so —
 * a Windows agent reading `{ volumes: [] }` with no reason would conclude no
 * drives are attached, which nobody measured.
 */
export function volumesUnavailableReason(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    return 'Windows drive discovery is not implemented yet, so no drives are listed on this platform — not a statement that none are attached.';
  }
  return null;
}

/**
 * Every attached external volume that is another drive for the folders in `from`, stats where
 * readable, sorted by name. A volume sharing one's space — on its device, or another APFS volume of its
 * container — is no other drive for the files in it (review F1.5): an offload onto it frees nothing,
 * and the server refuses one (DEST_SAME_VOLUME). Judged against the files' own folders, not this
 * computer's disk alone (review F2.1): for files on an external drive, a volume sharing that drive's
 * container is left out and this computer's own sibling volume — /Volumes/Dev — is another drive.
 * With no folder named, against this computer's own disk.
 */
export async function listVolumes(from: readonly string[] = THIS_COMPUTERS_DISK): Promise<VolumeInfo[]> {
  const listed = providers.list();
  const sharing = await providers.sameSpace(from, listed.map((v) => v.path));
  const found = listed.filter((v) => !sharing.has(v.path));
  const out = await Promise.all(
    found.map(async (v): Promise<VolumeInfo> => {
      try {
        const { total, free } = await providers.usage(v.path);
        return { name: v.name, path: v.path, freeBytes: free, totalBytes: total };
      } catch (err) {
        return {
          name: v.name,
          path: v.path,
          freeBytes: null,
          totalBytes: null,
          reason: `free space could not be read: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );
  // Deterministic order whatever the mount enumeration did; path breaks a
  // same-name tie (two drives can both be called "Untitled"). The locale is
  // pinned so "deterministic" holds across machines, not just per-process.
  out.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.path.localeCompare(b.path, 'en'));
  return out;
}
