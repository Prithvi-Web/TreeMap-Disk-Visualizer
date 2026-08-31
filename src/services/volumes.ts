import { listExternalVolumes, ExternalVolume } from './portableMode';
import { diskUsage } from './diskUsage';

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
}

const realProviders: VolumeProviders = {
  list: () => listExternalVolumes(),
  usage: (target) => diskUsage(target),
};

let providers: VolumeProviders = realProviders;

/** Test-only: swap discovery/stat for fakes so refusals can be driven. */
export function setVolumeProviders(next: VolumeProviders | null): void {
  providers = next ?? realProviders;
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

/** Every attached external volume, stats where readable, sorted by name. */
export async function listVolumes(): Promise<VolumeInfo[]> {
  const found = providers.list();
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
