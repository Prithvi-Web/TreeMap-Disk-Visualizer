import { promises as fsp, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { BaseProvider } from '../base';
import { commandExists, runJson } from '../exec';
import { openHandlesFor, openHandlesBatchFor } from './restartManager';
import { downloadOrigin, readDownloadOriginsWindows } from './zoneIdentifier';
import { volumeTopology } from './topology';
import { fileFactsBatch, toPlaceholderInfo } from './attributes';
import { listSnapshots as vssSnapshots, snapshotAvailability } from './vss';
import { relativeToVolume } from '../snapshotPaths';
import { registerShellIntegration, unregisterShellIntegration, isInstalled as winShellInstalled } from './shellIntegration';
import { runPowerShellJson } from './powershell';
import { readLastUsedWindows, probeLastUsedWindows } from './lastUsed';
import { readBackupMembershipWindows, probeBackupMembershipWindows } from './backup';
import { mapSmartctl, SmartctlJson } from '../macos';
import type {
  CapabilityState,
  BackupMembership,
  DownloadOriginBatch,
  LastUsedInfo,
  HardwareEncodeCapability,
  OpenHandleInfo,
  OpenHandleBatch,
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
 * Windows platform provider.
 *
 * | Capability     | Mechanism                                    | Tier |
 * |----------------|----------------------------------------------|------|
 * | fastEnumerate  | readdir + lstat (inherited)                  | —    |
 * | live changes   | ReadDirectoryChangesW via fs.watch (inherit) | 1    |
 * | open handles   | Restart Manager (RmGetList) via P/Invoke      | 1    |
 * | allocated size | GetCompressedFileSize, batched               | 1    |
 * | placeholders   | NTFS cloud reparse attributes, batched       | 1    |
 * | provenance     | Zone.Identifier ADS — plain file read         | 1    |
 * | topology       | Get-PhysicalDisk / Get-VirtualDisk / Get-Volume | 3 |
 * | snapshots      | Win32_ShadowCopy (+ mklink to read)          | 3    |
 * | SMART          | smartctl --json                              | 3    |
 * | shell menu     | reg.exe under HKCU — no admin                | 3    |
 * | MFT enumeration| unreachable — see probeFastEnumeration       | —    |
 * | zombie handles | unreachable — see probeZombieHandles         | —    |
 *
 * `subscribeToChanges` is inherited because Node's recursive `fs.watch` is
 * ReadDirectoryChangesW on Windows — the same kernel mechanism a hand-rolled
 * binding would reach. The USN Change Journal would additionally survive the
 * app not running, which is why A1's index carries a staleness guard rather
 * than trusting the watch to have seen everything.
 *
 * ⚠ **This file was written on macOS and has never been executed on Windows.**
 * Every pure part (parsers, bit arithmetic, argv construction) is unit-tested
 * in tests/platform.test.ts and runs on every OS; the live round-trips run in
 * CI on `windows-latest`. Anything that turns out to be wrong will surface
 * there rather than silently on a user's machine — and every method degrades to
 * "no information" rather than a wrong answer. Recorded in
 * docs/PLATFORM_NOTES.md.
 */
export class WindowsProvider extends BaseProvider {
  readonly platform: PlatformName = 'windows';

  /**
   * libuv leaves `Stats.blocks` at zero for every file on Windows, so a zero
   * there means "not reported", not "occupies nothing". Saying so keeps
   * enumeration from labelling every file on the drive as sparse; the real
   * figure comes from `GetCompressedFileSize` (see ./attributes.ts), which is
   * batched rather than paid per file during a walk.
   */
  override get blocksAreMeaningful(): boolean {
    return false;
  }

  /* ---------------- Open handles (B2) ---------------- */

  override async getOpenHandles(p: string): Promise<OpenHandleInfo[]> {
    return openHandlesFor([p]);
  }

  override async getOpenHandlesBatch(paths: string[]): Promise<OpenHandleBatch> {
    // The one provider that can genuinely be incomplete: Restart Manager caps
    // registration at RM_MAX_RESOURCES, and an unreadable subtree cannot be
    // registered at all. `openHandlesBatchFor` reports both.
    return openHandlesBatchFor(paths);
  }

  /**
   * Zombie handles are **not implemented on Windows**, deliberately.
   *
   * B5 says to pick one implementation and finish it rather than half-build
   * two. The two candidates are `NtQuerySystemInformation` handle enumeration
   * (an undocumented API needing a native addon) and a bundled `handle.exe`
   * (Sysinternals, whose licence forbids redistribution). Neither is reachable
   * here, and neither could be verified from this machine — so rather than ship
   * a guess, this reports nothing and probeZombieHandles() explains why.
   */
  override async getZombieHandles(): Promise<ZombieHandleInfo[]> {
    return [];
  }

  /* ---------------- Sizing (A2, A3) ---------------- */

  /**
   * Real allocated size via GetCompressedFileSize.
   *
   * `lstat().blocks` is 0 on Windows, so the base implementation's answer would
   * be the logical size — right for ordinary files, and wrong by the entire
   * saving for every compressed, sparse or cloud-backed one.
   */
  override async getAllocatedSize(p: string): Promise<number> {
    const facts = (await fileFactsBatch([p])).get(p);
    if (facts?.allocated !== null && facts?.allocated !== undefined) return facts.allocated;
    return (await fsp.lstat(p)).size;
  }

  override async getPlaceholderInfo(p: string): Promise<PlaceholderInfo | null> {
    const facts = (await fileFactsBatch([p])).get(p);
    return facts ? toPlaceholderInfo(facts) : null;
  }

  /** Batch form — one PowerShell call for a whole folder, not one per file. */
  async getPlaceholderInfoBatch(paths: string[]): Promise<Map<string, PlaceholderInfo | null>> {
    const facts = await fileFactsBatch(paths);
    return new Map(paths.map((p) => [p, facts.has(p) ? toPlaceholderInfo(facts.get(p)!) : null]));
  }

  /* ---------------- Provenance (C3) ---------------- */

  override async getDownloadOrigin(p: string): Promise<ProvenanceInfo | null> {
    return downloadOrigin(p);
  }

  override readDownloadOrigins(paths: string[]): Promise<DownloadOriginBatch> {
    return readDownloadOriginsWindows(paths);
  }

  /* ---------------- Topology (A5) ---------------- */

  override async getVolumeTopology(): Promise<VolumeTopology> {
    return volumeTopology();
  }

  /* ---------------- Snapshots (B4) ---------------- */

  override async listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
    return vssSnapshots(volume);
  }

  /**
   * Read one file out of a shadow copy.
   *
   * Windows will not open a path beneath a raw `\\?\GLOBALROOT\…` device, so
   * the shadow copy is given a name with `mklink /d`, the file is copied out,
   * and the link is removed. Creating a directory link needs administrator
   * rights or Developer Mode — the one place TreeMap asks for elevation, at the
   * moment the user invokes a restore, per §3.8. Listing snapshots stays
   * unelevated, so the UI can say what is recoverable before asking.
   */
  override async readFromSnapshot(snapshot: VolumeSnapshotRef, p: string): Promise<NodeJS.ReadableStream> {
    const device = await this.deviceObjectFor(snapshot.id);
    if (device === null) throw new Error('That restore point is no longer available');

    const linkDir = path.join(os.tmpdir(), `treemap-shadow-${Date.now().toString(36)}`);
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-restore-'));

    // mklink is a cmd.exe builtin, so it cannot be exec'd directly. The device
    // path comes from the OS, never from user input.
    await runPowerShellJson<unknown>(
      String.raw`cmd.exe /c mklink /d "$env:TREEMAP_LINK" "$env:TREEMAP_DEVICE\" | Out-Null; '{}'`,
      { timeoutMs: 20_000, env: { TREEMAP_LINK: linkDir, TREEMAP_DEVICE: device } },
    );

    try {
      const relative = p.replace(/^[A-Za-z]:\\/, '');
      await fsp.copyFile(path.join(linkDir, relative), path.join(staging, path.basename(p)));
    } finally {
      await fsp.rm(linkDir, { force: true, recursive: false }).catch(() => {});
    }

    const stream = createReadStream(path.join(staging, path.basename(p)));
    stream.once('close', () => {
      void fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    });
    return stream;
  }

  /* ---------------- Snapshot recovery (B4) ---------------- */

  /**
   * False. A shadow copy's contents live under a raw
   * `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN` path that Windows will
   * not open directly; naming it with `mklink /d` needs administrator rights
   * or Developer Mode. Enumeration stays unelevated, so TreeMap can say how
   * many restore points cover a file before asking for anything.
   */
  override canInspectSnapshotsUnprivileged(): boolean {
    return false;
  }

  /**
   * Copy a path out of the newest shadow copy that holds it.
   *
   * One link per snapshot, removed immediately: a left-behind directory link
   * into a shadow device is both confusing in Explorer and a handle on storage
   * the user cannot see.
   *
   * ⚠ Not executed on Windows by the author; the live round-trip runs in CI.
   */
  override async recoverFromSnapshots(
    snapshots: VolumeSnapshotRef[],
    originalPath: string,
    destination: string,
  ): Promise<SnapshotRecoveryResult> {
    const ordered = [...snapshots].sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
    const relative = relativeToVolume(originalPath, '');
    await fsp.mkdir(path.dirname(destination), { recursive: true });

    for (const snapshot of ordered) {
      const device = await this.deviceObjectFor(snapshot.id);
      if (device === null) continue;
      const linkDir = path.join(os.tmpdir(), `treemap-shadow-${Date.now().toString(36)}`);
      try {
        await runPowerShellJson<unknown>(
          String.raw`cmd.exe /c mklink /d "$env:TREEMAP_LINK" "$env:TREEMAP_DEVICE\" | Out-Null; '{}'`,
          { timeoutMs: 20_000, env: { TREEMAP_LINK: linkDir, TREEMAP_DEVICE: device } },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Refused for want of rights, rather than because the file is absent.
        if (/denied|privilege|elevat/i.test(message)) {
          return {
            restored: false,
            reason: 'Reading a restore point needs administrator rights (or Developer Mode). Nothing was changed.',
          };
        }
        continue;
      }

      try {
        const source = path.join(linkDir, relative);
        const st = await fsp.lstat(source).catch(() => null);
        if (!st) continue;
        await fsp.cp(source, destination, { recursive: true, preserveTimestamps: true });
        return { restored: true, fromSnapshotId: snapshot.id, sizeBytes: st.size };
      } finally {
        await fsp.rm(linkDir, { force: true, recursive: false }).catch(() => {});
      }
    }
    return {
      restored: false,
      reason: `None of the ${ordered.length} restore point${ordered.length === 1 ? '' : 's'} on this PC contain that path.`,
    };
  }

  private async deviceObjectFor(shadowId: string): Promise<string | null> {
    try {
      const raw = await runPowerShellJson<{ DeviceObject?: string } | null>(
        String.raw`Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $env:TREEMAP_ID } |
          Select-Object -First 1 DeviceObject | ConvertTo-Json -Compress`,
        { timeoutMs: 20_000, env: { TREEMAP_ID: shadowId } },
      );
      return raw?.DeviceObject ?? null;
    } catch {
      return null;
    }
  }

  /* ---------------- Drive health (C4) ---------------- */

  override async getSmartData(devicePath: string): Promise<SmartInfo | null> {
    try {
      return mapSmartctl(
        await runJson<SmartctlJson>('smartctl', ['--json', '-a', devicePath], { timeoutMs: 20_000 }),
        devicePath,
      );
    } catch {
      return null;
    }
  }

  /* ---------------- Shell integration (D2) ---------------- */

  override async registerShellIntegration(): Promise<ShellIntegrationResult> {
    return registerShellIntegration();
  }

  override async unregisterShellIntegration(): Promise<ShellIntegrationResult> {
    return unregisterShellIntegration();
  }

  override async shellIntegrationInstalled(): Promise<boolean> {
    return winShellInstalled();
  }

  /* ---------------- Capability probes ---------------- */

  override async probeFastEnumeration(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'readdir + lstat',
      degradedTo: 'readdir + lstat',
      reason:
        "Reading the drive's own file table directly (the trick that makes WizTree fast) needs low-level disk access TreeMap does not currently ship, so folders are read the ordinary way. Scans still work on every drive type, including USB sticks and network drives, where that trick does not apply at all.",
    };
  }

  override async probeLiveIndex(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'ReadDirectoryChangesW (via recursive fs.watch)',
      reason:
        'Changes made while TreeMap is running are picked up automatically. Changes made while it was closed are found by rechecking the folder rather than being missed.',
    };
  }

  override async probeCloneAwareSizing(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'GetCompressedFileSize',
      degradedTo: 'compressed/sparse sizing without hard-link grouping',
      reason:
        'Compressed and sparse files are measured by the space they really occupy. Files that share storage through hard links are not yet grouped, so a folder containing several names for the same file may be reported larger than it really is.',
    };
  }

  override async probePlaceholderDetection(): Promise<CapabilityState> {
    return { available: true, mechanism: 'NTFS cloud reparse attributes' };
  }

  override async probeOpenHandleGuard(): Promise<CapabilityState> {
    if (!(await commandExists('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']))) {
      return {
        available: false,
        mechanism: 'Restart Manager',
        reason: 'PowerShell is unavailable, so TreeMap cannot check whether a file is in use before deleting it.',
      };
    }
    return {
      available: true,
      mechanism: 'Restart Manager (RmGetList)',
      reason:
        'TreeMap asks Windows which programs have your files open — the same check Windows Update uses. No administrator rights are needed.',
    };
  }

  override async probeZombieHandles(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'handle enumeration',
      reason:
        'Windows does not let TreeMap see space held by files that were deleted while still in use. Restarting the program that was using them, or restarting the PC, releases that space.',
    };
  }

  override async probeSmartData(): Promise<CapabilityState> {
    if (!(await commandExists('smartctl'))) {
      return {
        available: false,
        mechanism: 'smartctl',
        reason:
          'Drive health reporting needs the smartmontools utility, which is not installed. You can download it from smartmontools.org.',
      };
    }
    return {
      available: true,
      mechanism: 'smartctl --json',
      reason: 'Reading drive health on Windows requires administrator rights; TreeMap will ask the first time you use it.',
    };
  }

  override async probeHardwareEncode(): Promise<HardwareEncodeCapability> {
    // A GPU that can *decode* AV1 usually cannot encode it, and substituting a
    // software encoder would be 10-50x slower (§C2). Nothing is claimed beyond
    // what a positive runtime answer supports, and TreeMap cannot yet obtain
    // one here, so only the universally safe claim is made.
    return {
      available: true,
      mechanism: 'Media Foundation',
      codecs: ['h264'],
      reason:
        'H.264 hardware encoding is available on essentially all current PCs. HEVC and AV1 depend on the exact graphics chip and are not offered until TreeMap can confirm them.',
    };
  }

  override async probeSnapshotRestore(): Promise<CapabilityState> {
    const { available, reason } = await snapshotAvailability();
    return available
      ? {
          available: true,
          mechanism: 'Win32_ShadowCopy',
          reason: 'Restoring a file from a restore point needs administrator rights; TreeMap will ask when you use it.',
        }
      : { available: false, mechanism: 'Win32_ShadowCopy', reason };
  }

  override async probeVolumeTopology(): Promise<CapabilityState> {
    return { available: true, mechanism: 'Get-PhysicalDisk + Get-Volume' };
  }

  override async probeProvenance(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'Zone.Identifier alternate data stream',
      reason:
        'Windows records the web address a file came from, but not the date. Files on USB sticks and network drives carry no record at all.',
    };
  }

  override async probeShellIntegration(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'HKCU Explorer context menu',
      reason: 'Adding "Scan with TreeMap" to the right-click menu applies to your account only and needs no administrator rights.',
    };
  }

  /**
   * NTFS last-access time, gated on whether Windows still updates it — see
   * ./lastUsed.ts. When it does not, this reports nothing rather than
   * substituting the modification date.
   */
  override readLastUsed(paths: string[]): Promise<Map<string, LastUsedInfo>> {
    return readLastUsedWindows(paths);
  }

  override probeLastUsed(): Promise<CapabilityState> {
    return probeLastUsedWindows();
  }

  /**
   * Read-only backup membership — see ./backup.ts. Never concludes that a
   * path IS backed up; a false "this is backed up" is the one error that
   * directly destroys data.
   */
  override readBackupMembership(paths: string[]): Promise<Map<string, BackupMembership>> {
    return readBackupMembershipWindows(paths);
  }

  override probeBackupMembership(): Promise<CapabilityState> {
    return probeBackupMembershipWindows();
  }
}
