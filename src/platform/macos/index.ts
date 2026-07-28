import { promises as fsp } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { BaseProvider } from '../base';
import { commandExists, runJson, reasonOf } from '../exec';
import { openHandlesFor, zombieHandles } from './lsofGuard';
import { downloadOrigin } from './provenance';
import { volumeTopology } from './diskutil';
import { listSnapshots as tmListSnapshots, mountSnapshot } from './tmutil';
import { recoverFromSnapshots as macRecoverFromSnapshots } from './snapshotRecover';
import { allocatedSize, placeholderInfo } from './allocation';
import {
  registerShellIntegration as installQuickAction,
  unregisterShellIntegration as removeQuickAction,
  isInstalled as quickActionInstalled,
} from './shellIntegration';
import type {
  CapabilityState,
  CloneFamilyId,
  HardwareEncodeCapability,
  OpenHandleInfo,
  PlaceholderInfo,
  PlatformName,
  ProvenanceInfo,
  ShellIntegrationResult,
  SmartInfo,
  VolumeSnapshotRef,
  SnapshotRecoveryResult,
  VolumeTopology,
  ZombieHandleInfo,
} from '../types';

/**
 * macOS platform provider.
 *
 * Mechanisms, and where each sits in §2.3's preference order:
 *
 * | Capability        | Mechanism                          | Tier |
 * |-------------------|------------------------------------|------|
 * | fastEnumerate     | readdir + lstat (inherited)        | —    |
 * | live changes      | fs.watch → FSEvents (inherited)    | 1    |
 * | open handles      | lsof -F                            | 3    |
 * | zombie handles    | lsof -F + inode comparison         | 3    |
 * | allocated size    | lstat().blocks                     | 1    |
 * | placeholders      | lstat().blocks + .icloud stubs     | 1    |
 * | provenance        | mdls -plist + com.apple.quarantine | 3    |
 * | topology          | diskutil list -plist               | 3    |
 * | snapshots         | tmutil + mount_apfs                | 3    |
 * | clone families    | none reachable — see ./allocation  | —    |
 * | SMART             | smartctl --json (not bundled yet)  | 3    |
 *
 * `subscribeToChanges` is inherited deliberately: Node's recursive `fs.watch`
 * *is* FSEvents on macOS, so a hand-rolled binding would add a native
 * dependency to reach the same kernel mechanism.
 */
export class MacOsProvider extends BaseProvider {
  readonly platform: PlatformName = 'macos';

  /* ---------------- Open and zombie handles (B2, B5) ---------------- */

  override async getOpenHandles(p: string): Promise<OpenHandleInfo[]> {
    return openHandlesFor([p]);
  }

  /** Batch form — one lsof call for the whole delete set, per §B2. */
  override async getOpenHandlesBatch(paths: string[]): Promise<OpenHandleInfo[]> {
    return openHandlesFor(paths);
  }

  override async getZombieHandles(): Promise<ZombieHandleInfo[]> {
    return zombieHandles();
  }

  /* ---------------- Sizing (A2, A3) ---------------- */

  override async getAllocatedSize(p: string): Promise<number> {
    return allocatedSize(p);
  }

  override async getPlaceholderInfo(p: string): Promise<PlaceholderInfo | null> {
    return placeholderInfo(p);
  }

  /**
   * Clone families need `getattrlist(ATTR_CMNEXT_CLONEID)`, which is not
   * reachable from Node and has no CLI equivalent. Returning null — rather than
   * guessing from size or mtime coincidence — is what keeps A2's numbers honest;
   * probeCloneAwareSizing() explains the consequence to the user.
   */
  override async getCloneFamily(_p: string): Promise<CloneFamilyId | null> {
    return null;
  }

  /* ---------------- Provenance (C3) ---------------- */

  override async getDownloadOrigin(p: string): Promise<ProvenanceInfo | null> {
    return downloadOrigin(p);
  }

  /* ---------------- Topology (A5) ---------------- */

  override async getVolumeTopology(): Promise<VolumeTopology> {
    return volumeTopology();
  }

  /* ---------------- Snapshots (B4) ---------------- */

  override async listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
    return tmListSnapshots(volume || '/');
  }

  /**
   * Read one file out of a snapshot.
   *
   * The snapshot is mounted, the file copied to a temp location, and the
   * snapshot unmounted *before* the stream is handed back. Streaming directly
   * off the mount would mean the caller's lifetime decides when the mount is
   * released — and a consumer that abandons the stream would pin snapshot
   * storage indefinitely. Copy-then-unmount keeps that bounded.
   */
  override async readFromSnapshot(snapshot: VolumeSnapshotRef, p: string): Promise<NodeJS.ReadableStream> {
    const mounted = await mountSnapshot(snapshot);
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-restore-'));
    const relative = p.startsWith(snapshot.volume) ? p.slice(snapshot.volume.length) : p;
    const source = path.join(mounted.mountPoint, relative);
    const target = path.join(staging, path.basename(p));
    try {
      await fsp.copyFile(source, target);
    } finally {
      await mounted.unmount();
    }
    const stream = createReadStream(target);
    stream.once('close', () => {
      void fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    });
    return stream;
  }

  /* ---------------- Snapshot recovery (B4) ---------------- */

  /**
   * False, and measured rather than assumed: `mount_apfs -s <snap> /` answers
   * "Resource busy" and the Data volume answers "Operation not permitted".
   * There is no unprivileged route to a local snapshot's contents on macOS, so
   * TreeMap can say which snapshots cover a period but not what is inside one
   * until the user authorizes the read.
   */
  override canInspectSnapshotsUnprivileged(): boolean {
    return false;
  }

  override async recoverFromSnapshots(
    snapshots: VolumeSnapshotRef[],
    originalPath: string,
    destination: string,
  ): Promise<SnapshotRecoveryResult> {
    return macRecoverFromSnapshots(snapshots, originalPath, destination);
  }

  /* ---------------- Drive health (C4) ---------------- */

  override async getSmartData(devicePath: string): Promise<SmartInfo | null> {
    try {
      const doc = await runJson<SmartctlJson>('smartctl', ['--json', '-a', devicePath], { timeoutMs: 20_000 });
      return mapSmartctl(doc, devicePath);
    } catch {
      return null;
    }
  }

  /* ---------------- Capability probes ---------------- */

  override async probeFastEnumeration(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'readdir + lstat, device-aware concurrency',
      degradedTo: 'readdir + lstat',
      reason:
        "macOS's bulk-enumeration call (getattrlistbulk) needs native code TreeMap does not ship, so folders are read the ordinary way. Scans are still fast; the first scan of a very large drive takes a little longer than it could.",
    };
  }

  override async probeLiveIndex(): Promise<CapabilityState> {
    return { available: true, mechanism: 'FSEvents (via recursive fs.watch)' };
  }

  override async probeCloneAwareSizing(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'ATTR_CMNEXT_CLONEID',
      degradedTo: 'allocated blocks, reconciled against the volume total',
      reason:
        'TreeMap cannot yet tell which files on this Mac share storage with each other (APFS clones). Sizes are measured from the space each file actually occupies and checked against the volume total, so the headline number is right — but a folder full of clones may still be reported larger than it really is.',
    };
  }

  override async probePlaceholderDetection(): Promise<CapabilityState> {
    return { available: true, mechanism: 'allocated blocks + .icloud stub detection' };
  }

  override async probeOpenHandleGuard(): Promise<CapabilityState> {
    if (!(await commandExists('lsof', ['-v']))) {
      return {
        available: false,
        mechanism: 'lsof',
        reason: 'The lsof tool is missing from this Mac, so TreeMap cannot check whether a file is in use before deleting it.',
      };
    }
    return {
      available: true,
      mechanism: 'lsof',
      reason:
        "TreeMap can see files opened by your own programs. Files held open by another user account or by a system service won't be reported.",
    };
  }

  override async probeZombieHandles(): Promise<CapabilityState> {
    if (!(await commandExists('lsof', ['-v']))) {
      return { available: false, mechanism: 'lsof', reason: 'The lsof tool is missing from this Mac.' };
    }
    return { available: true, mechanism: 'lsof + inode comparison' };
  }

  override async probeSmartData(): Promise<CapabilityState> {
    if (!(await commandExists('smartctl'))) {
      return {
        available: false,
        mechanism: 'smartctl',
        reason:
          'Drive health reporting needs the smartmontools utility, which is not installed. You can add it with Homebrew: brew install smartmontools',
      };
    }
    return { available: true, mechanism: 'smartctl --json' };
  }

  override async probeHardwareEncode(): Promise<HardwareEncodeCapability> {
    return hardwareEncodeCapability();
  }

  override async probeSnapshotRestore(): Promise<CapabilityState> {
    const snaps = await tmListSnapshots('/');
    if (snaps.length === 0) {
      return {
        available: false,
        mechanism: 'tmutil + mount_apfs',
        reason:
          'This Mac has no local Time Machine snapshots, so there is nothing to recover deleted files from. Snapshots appear automatically once Time Machine is turned on.',
      };
    }
    return { available: true, mechanism: 'tmutil + mount_apfs' };
  }

  override async probeVolumeTopology(): Promise<CapabilityState> {
    return { available: true, mechanism: 'diskutil list -plist' };
  }

  override async probeShellIntegration(): Promise<CapabilityState> {
    // `isInstalled` is async — awaiting it matters, since a Promise is always
    // truthy and the reason would never appear.
    const installed = await quickActionInstalled();
    return {
      available: true,
      mechanism: 'Finder Quick Action',
      ...(installed
        ? {}
        : {
            reason:
              'Adds "Scan with TreeMap" to Finder’s right-click menu for folders. It applies to your account only and needs no administrator rights; Finder may take a moment, or a log-out, to show it.',
          }),
    };
  }

  /* ---------------- Shell integration (D2) ---------------- */

  override async registerShellIntegration(): Promise<ShellIntegrationResult> {
    return installQuickAction();
  }

  override async unregisterShellIntegration(): Promise<ShellIntegrationResult> {
    return removeQuickAction();
  }

  override async probeProvenance(): Promise<CapabilityState> {
    return { available: true, mechanism: 'kMDItemWhereFroms + com.apple.quarantine' };
  }
}

/* ---------------- smartctl mapping, shared shape ---------------- */

export interface SmartctlJson {
  model_name?: string;
  power_on_time?: { hours?: number };
  temperature?: { current?: number };
  smart_status?: { passed?: boolean };
  nvme_smart_health_information_log?: { percentage_used?: number };
  ata_smart_attributes?: { table?: { id?: number; name?: string; value?: number; raw?: { value?: number } }[] };
}

/**
 * Map smartctl's JSON to SmartInfo.
 *
 * Shared by all three providers — the JSON schema is smartctl's, not the OS's,
 * so three copies would be three chances to drift.
 *
 * Deliberately omits the serial number: §6 forbids putting identifying data in
 * exportable diagnostics, and a drive serial is exactly that.
 */
export function mapSmartctl(doc: SmartctlJson, devicePath: string): SmartInfo {
  const table = doc.ata_smart_attributes?.table ?? [];
  const reallocated = table.find((a) => (a.name ?? '').toLowerCase().includes('reallocated_sector'));
  return {
    devicePath,
    modelName: doc.model_name ?? null,
    serialRedacted: true,
    percentageUsed: doc.nvme_smart_health_information_log?.percentage_used ?? null,
    powerOnHours: doc.power_on_time?.hours ?? null,
    reallocatedSectors: reallocated?.raw?.value ?? null,
    selfAssessmentPassed: doc.smart_status?.passed ?? null,
    temperatureCelsius: doc.temperature?.current ?? null,
    attributes: table.map((a) => ({
      id: a.id ?? null,
      name: a.name ?? '',
      raw: a.raw?.value ?? null,
      value: a.value ?? null,
    })),
  };
}

/**
 * Hardware video encode support (C2).
 *
 * Apple Silicon has VideoToolbox HEVC and H.264 encode across the line. AV1
 * *encode* exists only on M3 Pro/Max and newer; every other Apple chip has AV1
 * **decode** only. Claiming AV1 encode where it does not exist would push the
 * user onto a software encoder 10–50× slower — §C2 calls that out explicitly —
 * so AV1 is never claimed here without a positive runtime answer from
 * VideoToolbox, which TreeMap cannot currently obtain. HEVC is the honest
 * universal claim.
 */
export async function hardwareEncodeCapability(): Promise<HardwareEncodeCapability> {
  const arch = os.arch();
  if (arch === 'arm64') {
    return {
      available: true,
      mechanism: 'VideoToolbox',
      codecs: ['hevc', 'h264'],
      reason:
        'HEVC and H.264 are hardware-accelerated on this Mac. AV1 encoding is not offered because only the newest Apple chips support it and TreeMap cannot yet confirm which one this is.',
    };
  }
  try {
    // Intel Macs: QuickSync presence is what decides it, and there is no
    // cheap probe, so this stays conservative rather than optimistic.
    return {
      available: true,
      mechanism: 'VideoToolbox',
      codecs: ['h264'],
      reason: 'H.264 is hardware-accelerated on this Mac. HEVC support varies by model and is not assumed.',
    };
  } catch (err) {
    return { available: false, mechanism: 'VideoToolbox', codecs: [], reason: reasonOf(err) };
  }
}
