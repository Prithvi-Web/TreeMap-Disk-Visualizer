import { platform } from './index';
import type { Capabilities, CapabilityState } from './types';

/**
 * Runtime capability detection (§2.2).
 *
 * The rule this file exists to enforce: **never assume, always detect.** What a
 * mechanism needs is rarely just an OS. It is a filesystem (MFT parsing works
 * on NTFS and not on the exFAT stick next to it), a kernel version
 * (FAN_REPORT_FID wants ≥ 5.1), specific hardware (AV1 *encode* exists on a
 * minority of the chips that can decode it), a reachable device (smartctl often
 * cannot see through a USB enclosure or into a VM), or a privilege the user has
 * not granted. Deriving any of those from `process.platform` produces a feature
 * that works on the developer's machine and lies on everyone else's.
 *
 * Every probe is wrapped: a probe that throws becomes an *unavailable*
 * capability carrying the reason, never an exception that takes the endpoint —
 * or the app — down with it (§6, failure isolation).
 *
 * Caching: probes shell out, and the frontend asks for this on every load, so
 * the result is memoized. The TTL is short enough that plugging in a drive or
 * granting a permission shows up without a restart, and `invalidate()` is
 * called from the places that knowingly change the answer.
 */

const CACHE_TTL_MS = 30_000;

let cached: { at: number; value: Capabilities } | null = null;
let inFlight: Promise<Capabilities> | null = null;

/**
 * Run one probe, converting any failure into an honest unavailable state.
 *
 * `label` is used only to build a fallback reason, so a probe that throws still
 * produces a sentence a non-technical user can read — which is the whole point
 * of the three-state rule.
 */
async function safeProbe<T extends CapabilityState>(
  label: string,
  probe: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await probe();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...fallback, available: false, reason: `${label} could not be checked on this system (${reason}).` };
  }
}

async function detect(): Promise<Capabilities> {
  const p = platform();

  const unavailable = (mechanism: string): CapabilityState => ({ available: false, mechanism });

  // Probes are independent, so they run concurrently — a serial chain would
  // make the frontend's first paint wait on the slowest shell-out.
  const [
    fastEnumeration,
    liveIndex,
    cloneAwareSizing,
    placeholderDetection,
    openHandleGuard,
    zombieHandles,
    smartData,
    hardwareEncode,
    snapshotRestore,
    volumeTopology,
    provenance,
    shellIntegration,
  ] = await Promise.all([
    safeProbe('Fast scanning', () => p.probeFastEnumeration(), unavailable('readdir')),
    safeProbe('Live updates', () => p.probeLiveIndex(), unavailable('fs.watch')),
    safeProbe('Shared-storage sizing', () => p.probeCloneAwareSizing(), unavailable('none')),
    safeProbe('Cloud placeholder detection', () => p.probePlaceholderDetection(), unavailable('none')),
    safeProbe('Open-file checking', () => p.probeOpenHandleGuard(), unavailable('none')),
    safeProbe('Held-space detection', () => p.probeZombieHandles(), unavailable('none')),
    safeProbe('Drive health', () => p.probeSmartData(), unavailable('smartctl')),
    safeProbe('Hardware video encoding', () => p.probeHardwareEncode(), {
      ...unavailable('none'),
      codecs: [] as string[],
    }),
    safeProbe('Snapshot recovery', () => p.probeSnapshotRestore(), unavailable('none')),
    safeProbe('Disk layout', () => p.probeVolumeTopology(), unavailable('none')),
    safeProbe('Download history', () => p.probeProvenance(), unavailable('none')),
    safeProbe('File manager integration', () => p.probeShellIntegration(), unavailable('none')),
  ]);

  return {
    platform: p.platform,
    fastEnumeration,
    liveIndex,
    cloneAwareSizing,
    placeholderDetection,
    openHandleGuard,
    zombieHandles,
    smartData,
    hardwareEncode,
    snapshotRestore,
    volumeTopology,
    provenance,
    shellIntegration,
  };
}

/**
 * This machine's capabilities.
 *
 * Concurrent callers share one detection pass rather than each starting their
 * own storm of subprocesses — the frontend's first load asks for this from
 * several places at once.
 */
export async function getCapabilities(): Promise<Capabilities> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;

  inFlight = detect()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cache — after granting a permission, or installing a missing tool. */
export function invalidateCapabilities(): void {
  cached = null;
}

/**
 * Is one capability usable right now?
 *
 * Endpoints gated on a capability call this and return
 * `409 CAPABILITY_UNAVAILABLE` with the reason when it answers false, so the
 * frontend never has to infer availability from an empty result.
 */
export async function capabilityState(key: Exclude<keyof Capabilities, 'platform'>): Promise<CapabilityState> {
  const caps = await getCapabilities();
  return caps[key];
}
