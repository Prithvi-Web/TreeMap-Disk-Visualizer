import {
  CapabilityState,
  ChangeEvent,
  CloneFamilyId,
  EnumerateOptions,
  HardwareEncodeCapability,
  LogicalVolumeInfo,
  OpenHandleInfo,
  PlaceholderInfo,
  PlatformName,
  ProvenanceInfo,
  RawEntry,
  ShellIntegrationResult,
  SmartInfo,
  Unsubscribe,
  VolumeSnapshotRef,
  SnapshotEntryInfo,
  SnapshotRecoveryResult,
  VolumeTopology,
  ZombieHandleInfo,
} from './types';

/**
 * PlatformProvider — the one seam between TreeMap's services and the operating
 * system's native mechanisms.
 *
 * Rule for callers: services import `platform()` from here and nothing else.
 * A `process.platform` check inside a service is an anti-pattern (§10) — the
 * differences belong on this side of the seam, where they are documented,
 * capability-detected and testable.
 *
 * Rule for implementers: no method throws "not supported on this platform".
 * A mechanism that isn't available returns an empty/`null` result, and its
 * matching `probe*` method explains why in language a non-technical user can
 * act on. That pairing is what lets every capability-gated panel render one of
 * the three honest states in §2.2 instead of a blank box.
 */
export interface PlatformProvider {
  readonly platform: PlatformName;

  /* Enumeration and live changes */
  fastEnumerate(root: string, opts?: EnumerateOptions): AsyncIterable<RawEntry>;
  subscribeToChanges(root: string, onChange: (e: ChangeEvent) => void): Unsubscribe;

  /* Open handles (B2) and zombie handles (B5) */
  getOpenHandles(path: string): Promise<OpenHandleInfo[]>;
  /**
   * The same question for a whole delete set, in ONE pass (§B2).
   *
   * On the interface rather than an implementation detail because the
   * difference is not an optimisation: checking 10,000 files individually means
   * 10,000 subprocesses, which §B2 calls out as unusably slow. Every provider
   * answers a batch with a single enumeration.
   */
  getOpenHandlesBatch(paths: string[]): Promise<OpenHandleInfo[]>;
  getZombieHandles(): Promise<ZombieHandleInfo[]>;

  /* Byte-accurate sizing (A2) and placeholders (A3) */
  getCloneFamily(path: string): Promise<CloneFamilyId | null>;
  getAllocatedSize(path: string): Promise<number>;
  getPlaceholderInfo(path: string): Promise<PlaceholderInfo | null>;

  /* Drive health (C4) and provenance (C3) */
  getSmartData(devicePath: string): Promise<SmartInfo | null>;
  getDownloadOrigin(path: string): Promise<ProvenanceInfo | null>;

  /* Volume topology (A5) and snapshots (B4) */
  listLogicalVolumes(): Promise<LogicalVolumeInfo[]>;
  getVolumeTopology(): Promise<VolumeTopology>;
  listSnapshots(volume: string): Promise<VolumeSnapshotRef[]>;
  readFromSnapshot(snapshot: VolumeSnapshotRef, path: string): Promise<NodeJS.ReadableStream>;

  /* ---- Snapshot recovery (B4) ---- */

  /**
   * Can a snapshot's contents be examined without asking for a password?
   *
   * True only on Linux, where a btrfs snapshot is an ordinary readable
   * subvolume. macOS must mount the snapshot and Windows must name the shadow
   * device, and both of those need elevation — so on those platforms TreeMap
   * can honestly say "these snapshots cover the period" but not "your file is
   * in this one" until the user authorizes the read.
   */
  canInspectSnapshotsUnprivileged(): boolean;

  /** What this snapshot holds at `path`, or null. Only meaningful when
   *  `canInspectSnapshotsUnprivileged()` is true. */
  inspectSnapshot(snapshot: VolumeSnapshotRef, path: string): Promise<SnapshotEntryInfo | null>;

  /**
   * Copy `originalPath` out of the newest snapshot that holds it, to
   * `destination`.
   *
   * Takes the whole candidate list rather than one snapshot because on macOS
   * every mount costs an authorization prompt: searching six snapshots one
   * call at a time would ask the user for their password six times. One call,
   * one prompt, newest first.
   */
  recoverFromSnapshots(
    snapshots: VolumeSnapshotRef[],
    originalPath: string,
    destination: string,
  ): Promise<SnapshotRecoveryResult>;

  /* Shell integration (D2) — reversible from the same place it is installed */
  registerShellIntegration(): Promise<ShellIntegrationResult>;
  unregisterShellIntegration(): Promise<ShellIntegrationResult>;

  /* Capability probes — one per capability-gated feature (§2.2) */
  probeFastEnumeration(): Promise<CapabilityState>;
  probeLiveIndex(): Promise<CapabilityState>;
  probeCloneAwareSizing(): Promise<CapabilityState>;
  probePlaceholderDetection(): Promise<CapabilityState>;
  probeOpenHandleGuard(): Promise<CapabilityState>;
  probeZombieHandles(): Promise<CapabilityState>;
  probeSmartData(): Promise<CapabilityState>;
  probeHardwareEncode(): Promise<HardwareEncodeCapability>;
  probeSnapshotRestore(): Promise<CapabilityState>;
  probeVolumeTopology(): Promise<CapabilityState>;
  probeProvenance(): Promise<CapabilityState>;
  probeShellIntegration(): Promise<CapabilityState>;
}

/** Map Node's platform string onto the three TreeMap supports. */
export function platformNameOf(p: NodeJS.Platform = process.platform): PlatformName | null {
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  return null;
}

let cached: PlatformProvider | null = null;

/**
 * The provider for this machine, built once.
 *
 * Requires are lazy and inside the branch so that, for example, the Windows
 * implementation's module-level constants are never evaluated on a Mac.
 *
 * An unrecognised platform (FreeBSD, AIX) gets the portable base rather than a
 * crash: TreeMap's core — walk, treemap, trash — works there today, and losing
 * the native extras is a capability state, not a reason to refuse to boot.
 */
export function platform(): PlatformProvider {
  if (cached) return cached;
  const name = platformNameOf();
  if (name === 'macos') {
    cached = new (require('./macos').MacOsProvider)() as PlatformProvider;
  } else if (name === 'windows') {
    cached = new (require('./windows').WindowsProvider)() as PlatformProvider;
  } else if (name === 'linux') {
    cached = new (require('./linux').LinuxProvider)() as PlatformProvider;
  } else {
    cached = new (require('./portable').PortableProvider)() as PlatformProvider;
  }
  return cached;
}

/** Tests only: drop the memoized provider (and any capability cache with it). */
export function resetPlatformForTests(): void {
  cached = null;
}

export * from './types';
