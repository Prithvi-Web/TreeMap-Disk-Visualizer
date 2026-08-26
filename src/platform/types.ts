/**
 * TreeMap — platform abstraction layer, shared shapes.
 *
 * Twelve of the planned features need OS-native mechanisms. Rather than
 * scattering `process.platform === 'win32'` through the services (see
 * docs/PLATFORM_NOTES.md), every OS-specific mechanism lives behind the
 * PlatformProvider interface in ./index.ts and every shape it trades in is
 * declared here — once, with no `any`.
 *
 * Naming note: `VolumeSnapshotRef` is deliberately NOT called `SnapshotRef`.
 * `SnapshotRef` already means "one entry in TreeMap's own size history"
 * (src/models/types.ts) and the two would be silently confusable.
 */

/* ---------- Enumeration ---------- */

/** One filesystem entry as produced by a fast enumerator. */
export interface RawEntry {
  /** Absolute path. */
  path: string;
  /** Basename. */
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Logical size in bytes (`stat.size`). */
  size: number;
  /**
   * Bytes actually occupied on disk (`stat.blocks * 512`). Differs from `size`
   * for sparse files, compressed files, and cloud placeholders — which is
   * exactly what makes the A2/A3 accounting possible. `null` when the
   * enumerator could not obtain it.
   */
  allocatedSize: number | null;
  /** Unix epoch milliseconds. */
  modifiedAt: number;
  /** Device id and inode — the identity used to detect hard-link families. */
  dev: number;
  ino: number;
  /** Hard-link count. Values above 1 mean the inode has more than one name. */
  nlink: number;
}

export interface EnumerateOptions {
  /** Never leave the filesystem the root lives on (mount boundaries). */
  singleDevice?: boolean;
  /** Absolute paths (and their subtrees) to skip entirely. */
  skip?: (absolutePath: string) => boolean;
  /** Cooperative cancellation, polled between batches. */
  isCancelled?: () => boolean;
  /**
   * Concurrency override. When omitted the provider sizes it from the device's
   * own characteristics — on Linux that means reading
   * /sys/block/<dev>/queue/rotational rather than assuming one flat number for
   * spinning rust and NVMe alike.
   */
  concurrency?: number;
}

/* ---------- Change subscription ---------- */

export type ChangeKind = 'created' | 'modified' | 'deleted' | 'unknown';

export interface ChangeEvent {
  path: string;
  kind: ChangeKind;
  /** Unix epoch milliseconds the provider observed the change. */
  at: number;
}

export type Unsubscribe = () => void;

/* ---------- Open handles (B2) and zombie handles (B5) ---------- */

export interface OpenHandleInfo {
  /** The path from the caller's set that this handle blocks. */
  path: string;
  /** Process id holding it. */
  pid: number;
  /** Executable/display name, e.g. "Google Chrome". */
  processName: string;
  /**
   * The file actually held open, when it differs from `path` — i.e. when `path`
   * is a folder and the open file is inside it. Absent when they are the same.
   * Lets the warning say *which* file is in use rather than only the folder.
   */
  openPath?: string;
}

export interface ZombieHandleInfo {
  pid: number;
  processName: string;
  /** Path as last known; an unlinked inode may report a "(deleted)" suffix upstream, stripped here. */
  path: string;
  /** Bytes the unlinked inode still occupies, or null when unknowable. */
  bytes: number | null;
}

/* ---------- Copy-on-write / clone accounting (A2) ---------- */

/**
 * Opaque identity of a clone family: two paths sharing the same id share
 * extents. Stringly-typed on purpose — the underlying value is an APFS clone
 * id, an NTFS file id, or a hash of a Btrfs/XFS extent list depending on the
 * platform, and nothing outside the provider should interpret it.
 */
export interface CloneFamilyId {
  id: string;
  /** Which mechanism produced it, for honest UI labelling. */
  mechanism: string;
}

/* ---------- Placeholders and sparse files (A3) ---------- */

export interface PlaceholderInfo {
  /** Bytes the file claims. */
  logicalSize: number;
  /** Bytes actually resident on this machine. */
  localSize: number;
  /** Which sync client owns it, when detectable. */
  provider: 'icloud' | 'onedrive' | 'dropbox' | 'gdrive' | 'unknown';
  /** True when the content is not on this disk at all. */
  evicted: boolean;
  /** How this was determined, e.g. "SEEK_HOLE", "reparse tag", "xattr". */
  mechanism: string;
}

/* ---------- Drive health (C4) ---------- */

export interface SmartAttribute {
  id: number | null;
  name: string;
  /** Raw value as reported; units vary by attribute and are not normalised. */
  raw: number | null;
  /** Normalised current value, when the device reports one. */
  value: number | null;
}

export interface SmartInfo {
  devicePath: string;
  modelName: string | null;
  serialRedacted: boolean;
  /** 0–100 where reported; null when the device exposes no wear indicator. */
  percentageUsed: number | null;
  powerOnHours: number | null;
  reallocatedSectors: number | null;
  /** The device's own overall self-assessment, verbatim. Never editorialised. */
  selfAssessmentPassed: boolean | null;
  temperatureCelsius: number | null;
  attributes: SmartAttribute[];
}

/* ---------- Download provenance (C3) ---------- */

export interface ProvenanceInfo {
  /** Full origin URL. Untrusted input — never fetched, always escaped on render. */
  url: string | null;
  /** Host portion of `url`, precomputed so the UI need not parse untrusted text. */
  host: string | null;
  /** Referrer, where the platform records one separately. */
  referrer: string | null;
  /** Unix epoch milliseconds the item was downloaded, when recorded. */
  downloadedAt: number | null;
  /** Which mechanism produced it, e.g. "kMDItemWhereFroms". */
  mechanism: string;
}

/* ---------- Last-used dates (v4 §1.1) ---------- */

/**
 * When a path was last *opened*, as distinct from last modified.
 *
 * "Downloaded fourteen months ago, never opened" is the highest-signal fact on
 * a disk, and mtime cannot express it — a file written once and read daily has
 * the same mtime as one written once and forgotten.
 *
 * `source` is part of the value, not metadata about it, because the three
 * sources answer subtly different questions and the UI must be able to say
 * which one it is showing:
 *
 *  - `spotlight` — macOS's own record of an application opening the item, and
 *    the only source that can also supply a **use count**.
 *  - `atime` — the filesystem's access time. Genuine, but it moves for reasons
 *    that are not a person opening the file: backups, indexers, antivirus and
 *    thumbnail generation all read files. Always carries a `caveat`.
 *  - `none` — nothing is known. `lastUsedMs` is null, and that null must never
 *    be rendered as a date or as zero.
 */
export interface LastUsedInfo {
  /** Unix epoch milliseconds, or null when genuinely unknown. Never 0-for-unknown. */
  lastUsedMs: number | null;
  /** How many times the item has been opened, where the OS counts. Usually null. */
  useCount: number | null;
  source: 'spotlight' | 'atime' | 'none';
  /** Shown verbatim beside the date whenever the source needs qualifying. */
  caveat?: string;
}

/* ---------- Backup membership (v4 §1.2b) ---------- */

/**
 * Whether a backup system on this machine covers a path.
 *
 * **`pathCovered: 'yes'` is the most dangerous value in TreeMap.** A false
 * "this is backed up" directly causes data loss — someone reads it, deletes
 * the only copy, and the backup never had it. So it is produced only by a
 * mechanism that genuinely checked the backup's own contents, and the macOS,
 * Linux and Windows readers as written **never produce it at all**: they can
 * see that a backup is configured and that a path is not excluded, and neither
 * of those is proof that any completed backup contains it.
 *
 * `'unknown'` is therefore the correct and common answer, and a dedicated test
 * asserts no code path promotes it.
 */
export interface BackupMembership {
  /** Is any backup system set up on this machine at all? */
  configured: boolean;
  /** When the last backup completed, where that is knowable. */
  lastBackupMs: number | null;
  /**
   * 'no' means positively excluded — it will never be backed up.
   * 'unknown' means not excluded, which is not the same as covered.
   * 'yes' requires having checked the backup's contents.
   */
  pathCovered: 'yes' | 'no' | 'unknown';
  /**
   * Did the reader actually establish that this path is NOT on an exclusion
   * list, or did it simply never look?
   *
   * A separate flag rather than folding both into `pathCovered: 'unknown'`,
   * because the composite's wording depends on it. "does not skip this
   * location" is a claim only macOS can make, and only when the lookup
   * succeeded — on Linux there is no exclusion list at all, and on Windows the
   * protected-folder list is read but not matched against. Collapsing the two
   * made every file on a Linux box with a restic config say "probably a second
   * copy".
   */
  exclusionChecked: boolean;
  /** e.g. "Time Machine", "File History", "restic", "none". */
  mechanism: string;
  /** Present when the reader could not run at all. */
  reason?: string;
}

/* ---------- Volume topology (A5) ---------- */

export interface PhysicalDiskInfo {
  /** Stable device identifier, e.g. "disk0", "/dev/sda", "PhysicalDisk0". */
  id: string;
  name: string | null;
  sizeBytes: number | null;
  /** True for spinning media where detectable; null when unknown. */
  rotational: boolean | null;
}

export interface LogicalVolumeInfo {
  /** Stable identifier for the logical volume. */
  id: string;
  name: string | null;
  /** Where it is mounted, when it is. */
  mountPoint: string | null;
  filesystem: string | null;
  /**
   * Capacity ceiling. For volumes that share a pool (APFS containers, Storage
   * Spaces, ZFS) this is the *shared* ceiling, so summing it across siblings
   * double-counts — sum `usedBytes` instead.
   */
  sizeBytes: number | null;
  /** Space available to this volume. Shared across pool siblings — do not sum. */
  freeBytes: number | null;
  /**
   * Bytes this volume itself consumes — the number that is safe to sum across
   * siblings sharing a pool. `null` when the platform cannot report it, which
   * the UI must show as unknown rather than as zero.
   */
  usedBytes: number | null;
  /** ids of the PhysicalDiskInfo entries backing this volume. */
  physicalDiskIds: string[];
  /** e.g. "apfs", "lvm", "md-raid", "zfs", "storage-spaces", "simple". */
  kind: string;
}

export interface VolumeTopology {
  physicalDisks: PhysicalDiskInfo[];
  logicalVolumes: LogicalVolumeInfo[];
  /** Mechanism used, for the capability note. */
  mechanism: string;
}

/* ---------- Snapshot recovery (B4) ---------- */

/** What a snapshot holds for one path, when that can be established. */
export interface SnapshotEntryInfo {
  sizeBytes: number;
  modifiedAt: number;
  isDirectory: boolean;
}

/**
 * The result of recovering a path out of the newest snapshot that has it.
 *
 * `cancelled` is separate from a failure on purpose: a user who dismisses an
 * authorization prompt has given an answer, and showing them a red error for
 * doing so would be wrong.
 */
export interface SnapshotRecoveryResult {
  restored: boolean;
  /** Which snapshot the bytes came from. */
  fromSnapshotId?: string;
  sizeBytes?: number;
  /** Present when nothing was restored — always set in that case. */
  reason?: string;
  cancelled?: boolean;
}

/* ---------- Filesystem snapshots (B4) ---------- */

export interface VolumeSnapshotRef {
  /** Platform-native snapshot identifier. */
  id: string;
  /** Display label. */
  name: string;
  /** Unix epoch milliseconds, when derivable from the snapshot itself. */
  takenAt: number | null;
  /** The volume the snapshot covers. */
  volume: string;
  /**
   * Path prefix through which the snapshot's contents can be read, once
   * mounted. `null` means the snapshot exists but is not currently readable
   * without an explicit mount step.
   */
  accessPath: string | null;
}

/* ---------- Shell integration (D2) ---------- */

export interface ShellIntegrationResult {
  installed: boolean;
  /** Which integrations were installed or removed, e.g. ["nautilus", "dolphin"]. */
  targets: string[];
  /** Human-readable explanation when nothing could be installed. */
  reason?: string;
}

/* ---------- Capability detection (§2.2) ---------- */

/**
 * The three honest states every capability-gated feature renders. A capability
 * is never simply absent: it is available, unavailable *with a reason a
 * non-technical user can act on*, or degraded to a named fallback.
 */
export interface CapabilityState {
  available: boolean;
  /** The mechanism in use, or the one that would be used if available. */
  mechanism: string;
  /** Present whenever `available` is false, or a fallback is in play. */
  reason?: string;
  /** Set when running on a named fallback rather than the first-choice mechanism. */
  degradedTo?: string;
}

export interface HardwareEncodeCapability extends CapabilityState {
  /** Codecs with genuine *hardware encode* support. Decode-only never counts. */
  codecs: string[];
}

/**
 * One entry per capability-gated feature. Every field is detected at runtime —
 * kernel version, filesystem, hardware and privilege all vary independently of
 * `process.platform`, so nothing here may be inferred from the OS alone.
 */
export interface Capabilities {
  platform: PlatformName;
  fastEnumeration: CapabilityState;
  liveIndex: CapabilityState;
  cloneAwareSizing: CapabilityState;
  placeholderDetection: CapabilityState;
  openHandleGuard: CapabilityState;
  zombieHandles: CapabilityState;
  smartData: CapabilityState;
  hardwareEncode: HardwareEncodeCapability;
  snapshotRestore: CapabilityState;
  volumeTopology: CapabilityState;
  provenance: CapabilityState;
  shellIntegration: CapabilityState;
  /** v4 §1.1 — last-opened dates, from Spotlight or from access times. */
  lastUsed: CapabilityState;
  /** v4 §1.2a — git ahead/dirty/pushed state for paths inside a work tree. */
  gitStatus: CapabilityState;
  /** v4 §1.2b — whether a backup system on this machine covers a path. */
  backupMembership: CapabilityState;
  /** v4 §1.2c — whether a sync client holds a remote copy of a path. */
  cloudResidency: CapabilityState;
}

export type PlatformName = 'windows' | 'macos' | 'linux';

/** Keys the frontend may use in a view's `capabilityKey` (§3.4). */
export type CapabilityKey = Exclude<keyof Capabilities, 'platform'>;
