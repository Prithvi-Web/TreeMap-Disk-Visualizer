import fs from 'fs';
import { createReadStream, promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { BaseProvider } from '../base';
import { commandExists, runJson } from '../exec';
import { openHandlesFor, zombieHandles } from './procFdGuard';
import { volumeTopology, isRotational, queueDepth, topologyReason } from './topology';
import { downloadOrigin, provenanceAvailable, readDownloadOriginsLinux } from './provenance';
import { listSnapshots as btrfsSnapshots, snapshotAvailability } from './btrfs';
import { relativeToVolume } from '../snapshotPaths';
import { registerShellIntegration, unregisterShellIntegration, isInstalled as linuxShellInstalled } from './shellIntegration';
import { readLastUsedLinux, probeLastUsedLinux } from './lastUsed';
import { readBackupMembershipLinux, probeBackupMembershipLinux } from './backup';
import { mapSmartctl, SmartctlJson } from '../macos';
import type {
  CapabilityState,
  BackupMembership,
  DownloadOriginBatch,
  LastUsedInfo,
  ChangeEvent,
  HardwareEncodeCapability,
  OpenHandleInfo,
  OpenHandleBatch,
  PlaceholderInfo,
  PlatformName,
  ProvenanceInfo,
  ShellIntegrationResult,
  SmartInfo,
  Unsubscribe,
  VolumeSnapshotRef,
  SnapshotEntryInfo,
  SnapshotRecoveryResult,
  VolumeTopology,
  ZombieHandleInfo,
} from '../types';
import { meansGone } from '../../utils/errno';
import { notifyWatchDelivery } from '../types';

/**
 * Linux platform provider.
 *
 * | Capability     | Mechanism                                | Tier |
 * |----------------|------------------------------------------|------|
 * | fastEnumerate  | readdir + lstat, sized from sysfs        | 1    |
 * | live changes   | per-directory inotify (see below)        | 1    |
 * | open handles   | /proc/<pid>/fd — no subprocess           | 1    |
 * | zombie handles | /proc + kernel's own (deleted) marker    | 1    |
 * | allocated size | lstat().blocks                           | 1    |
 * | topology       | lsblk --json (+ zpool list -j)           | 3    |
 * | provenance     | getfattr user.xdg.origin.url             | 3    |
 * | snapshots      | btrfs subvolume list -s                  | 3    |
 * | SMART          | smartctl --json                          | 3    |
 * | shell menus    | Nautilus / Dolphin / Thunar, per-user     | —    |
 * | reflink groups | FS_IOC_FIEMAP — unreachable; see ./btrfs | —    |
 */
export class LinuxProvider extends BaseProvider {
  readonly platform: PlatformName = 'linux';

  /* ---------------- Enumeration ---------------- */

  /**
   * Size the walk from the device, not from a constant.
   *
   * The README's existing finding — that oversized concurrency makes scans
   * *slower* through kernel metadata-lock contention — is why this is not just
   * "more threads on faster disks". A rotational disk is punished hardest by a
   * wide walk (every extra outstanding request is another seek), so it gets a
   * deliberately narrow one; an NVMe queue rewards depth up to a point and is
   * capped well below its nominal `nr_requests`, which is a hardware limit, not
   * a useful concurrency target.
   */
  protected override async enumerateConcurrency(root: string): Promise<number> {
    const device = await this.deviceNameFor(root);
    if (device === null) return super.enumerateConcurrency(root);

    const rotational = await isRotational(device);
    if (rotational === true) return 4;
    if (rotational === false) {
      const depth = await queueDepth(device);
      const fromCpu = Math.max(8, Math.min(32, os.cpus().length * 2));
      return depth === null ? fromCpu : Math.max(8, Math.min(fromCpu, Math.floor(depth / 8)));
    }
    return super.enumerateConcurrency(root);
  }

  /**
   * Which /sys/block entry backs `root`.
   *
   * `st.dev` gives major:minor; sysfs names the device by that pair. Partitions
   * (`sda1`, `nvme0n1p2`) carry no `queue/` directory of their own, so the
   * lookup walks up to the parent whole device — otherwise every partition
   * would silently fall back to the CPU-derived default.
   */
  private async deviceNameFor(root: string): Promise<string | null> {
    try {
      const st = await fsp.lstat(root);
      const major = Math.floor(st.dev / 256);
      const minor = st.dev % 256;
      const link = await fsp.readlink(`/sys/dev/block/${String(major)}:${String(minor)}`);
      const name = path.basename(link);
      if (await fsp.access(`/sys/block/${name}/queue`).then(() => true, () => false)) return name;
      // A partition: its parent directory under /sys/block is the whole device.
      const parent = path.basename(path.dirname(link));
      if (await fsp.access(`/sys/block/${parent}/queue`).then(() => true, () => false)) return parent;
      return null;
    } catch {
      return null;
    }
  }

  /* ---------------- Live changes ---------------- */

  /**
   * Recursive watching on Linux, built from per-directory watches.
   *
   * `fs.watch(recursive: true)` is genuinely recursive only on macOS and
   * Windows. Node gained a Linux emulation, but it walks the tree once at setup
   * and does **not** watch directories created afterwards — so a build output
   * folder created after the watch starts is invisible, which for a live disk
   * index is the single most important case to catch.
   *
   * So this watches each directory itself and adds a watch whenever a new one
   * appears. That is what inotify natively provides; `fanotify` with
   * `FAN_REPORT_FID` would cover a whole mount with one descriptor, but needs
   * `CAP_SYS_ADMIN` (root), and §3.8 forbids requiring elevation for something
   * achievable without it. The capability note states the trade honestly: the
   * per-directory approach can exhaust `max_user_watches` on very large trees.
   */
  override subscribeToChanges(root: string, onChange: (e: ChangeEvent) => void): Unsubscribe {
    const watchers = new Map<string, fs.FSWatcher>();
    let closed = false;

    const watchDir = (dir: string): void => {
      if (closed || watchers.has(dir)) return;
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_type, filename) => {
          // Reported at the OS callback, like the base provider — see
          // `notifyWatchDelivery`. `root`, not `dir`: the consumer keys on the
          // root it subscribed to, not on whichever nested directory fired.
          notifyWatchDelivery(root);
          if (closed || filename === null) return;
          const full = path.join(dir, filename);
          fsp.lstat(full).then(
            (st) => {
              onChange({ path: full, kind: 'modified', at: Date.now() });
              // A directory that just appeared needs its own watch, or nothing
              // inside it will ever be seen.
              if (st.isDirectory()) watchDir(full);
            },
            (err: unknown) => {
              // Same rule as the base provider: only a real absence is a
              // deletion. An `EMFILE` here says nothing about whether the
              // path is still there, and the index acts on what it is told.
              if (!meansGone(err)) {
                onChange({ path: full, kind: 'unknown', at: Date.now() });
                // The watch is dropped even though the path may still exist.
                // Keeping it would hold an inotify watch open under exactly
                // the descriptor-exhaustion condition that produced the
                // failure, and `max_user_watches` is this provider's known
                // ceiling. `watchDir` is idempotent, so the next event under
                // the parent re-establishes it; a missed subtree in the
                // meantime is what index staleness already covers.
                const unreadable = watchers.get(full);
                if (unreadable) {
                  unreadable.close();
                  watchers.delete(full);
                }
                return;
              }
              onChange({ path: full, kind: 'deleted', at: Date.now() });
              const gone = watchers.get(full);
              if (gone) {
                gone.close();
                watchers.delete(full);
              }
            },
          );
        });
      } catch (err) {
        // The ROOT failing is the caller's boolean: `startWatcher` promises
        // "a watch attached", and with the root unwatched nothing under it is
        // ever seen. A subdirectory failing is a different thing — the tree is
        // still watched, just not exhaustively — and stays a silent
        // best-effort miss that index staleness covers.
        if (dir === root) throw err;
        return; // watch limit reached or permission denied — index staleness covers it
      }
      watcher.on('error', () => {
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
    };

    const seed = async (dir: string, depth: number): Promise<void> => {
      if (closed || depth > 24) return; // a runaway symlink loop must not exhaust the watch budget
      watchDir(dir);
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (closed) return;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await seed(path.join(dir, entry.name), depth + 1);
      }
    };

    // The root's own watch is established SYNCHRONOUSLY, before returning, so
    // the unsubscribe handed back corresponds to a watch that exists. `seed`
    // walking the subtree stays async — on a large tree it is slow, and events
    // in the root are what matter first — but a caller that gets a subscription
    // back must not have to hope one appears later.
    watchDir(root);
    void seed(root, 0);

    return () => {
      closed = true;
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
      }
      watchers.clear();
    };
  }

  /* ---------------- Handles ---------------- */

  override async getOpenHandles(p: string): Promise<OpenHandleInfo[]> {
    return openHandlesFor([p]);
  }

  override async getOpenHandlesBatch(paths: string[]): Promise<OpenHandleBatch> {
    // Complete by construction: the /proc sweep covers every path, so there is nothing to truncate.
    // A probe that FAILS throws, and `checkOpenHandles` turns that into
    // `checked: false` rather than an empty, confident answer.
    return { handles: await openHandlesFor(paths), complete: true };
  }

  override async getZombieHandles(): Promise<ZombieHandleInfo[]> {
    return zombieHandles();
  }

  /* ---------------- Sizing ---------------- */

  /**
   * Sparse and placeholder detection from allocated blocks.
   *
   * Same rule as macOS: `blocks === 0 && size > 0` is a placeholder; merely
   * *smaller* than logical size is an ordinary sparse file (a VM image, a
   * database) and is not labelled as cloud.
   */
  override async getPlaceholderInfo(p: string): Promise<PlaceholderInfo | null> {
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;

    const blocks = typeof st.blocks === 'number' ? st.blocks : -1;
    const localSize = blocks >= 0 ? blocks * 512 : st.size;
    if (localSize >= st.size) return null;

    const evicted = blocks === 0 && st.size > 0;
    return {
      logicalSize: st.size,
      localSize,
      provider: /\/OneDrive/.test(p) ? 'onedrive' : /\/Dropbox/.test(p) ? 'dropbox' : 'unknown',
      evicted,
      mechanism: 'allocated blocks (lstat)',
    };
  }

  /* ---------------- Topology, provenance, snapshots ---------------- */

  override async getVolumeTopology(): Promise<VolumeTopology> {
    return volumeTopology();
  }

  override async getDownloadOrigin(p: string): Promise<ProvenanceInfo | null> {
    return downloadOrigin(p);
  }

  override readDownloadOrigins(paths: string[]): Promise<DownloadOriginBatch> {
    return readDownloadOriginsLinux(paths);
  }

  override async listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
    return btrfsSnapshots(volume || '/');
  }

  /**
   * Btrfs snapshots are ordinary subvolumes already present in the tree, so —
   * unlike APFS and VSS — nothing has to be mounted to read one.
   */
  override async readFromSnapshot(snapshot: VolumeSnapshotRef, p: string): Promise<NodeJS.ReadableStream> {
    if (snapshot.accessPath === null) {
      throw new Error('That snapshot is not currently readable');
    }
    const relative = p.startsWith(snapshot.volume) ? p.slice(snapshot.volume.length) : p;
    return createReadStream(path.join(snapshot.accessPath, relative));
  }

  /* ---------------- Snapshot recovery (B4) ---------------- */

  /**
   * True — and Linux is the only platform where it is. A btrfs snapshot is an
   * ordinary subvolume sitting in the filesystem, so TreeMap can confirm "your
   * file is in this snapshot, 4.2 MB, modified Tuesday" with no privileges at
   * all. macOS must mount and Windows must name a shadow device; both need
   * authorization first.
   */
  override canInspectSnapshotsUnprivileged(): boolean {
    return true;
  }

  override async inspectSnapshot(snapshot: VolumeSnapshotRef, p: string): Promise<SnapshotEntryInfo | null> {
    if (snapshot.accessPath === null) return null;
    try {
      const st = await fsp.lstat(path.join(snapshot.accessPath, relativeToVolume(p, snapshot.volume)));
      return { sizeBytes: st.size, modifiedAt: st.mtimeMs, isDirectory: st.isDirectory() };
    } catch {
      return null; // not in this snapshot — an answer, not a failure
    }
  }

  override async recoverFromSnapshots(
    snapshots: VolumeSnapshotRef[],
    originalPath: string,
    destination: string,
  ): Promise<SnapshotRecoveryResult> {
    const ordered = [...snapshots].sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
    for (const snapshot of ordered) {
      if (snapshot.accessPath === null) continue;
      const source = path.join(snapshot.accessPath, relativeToVolume(originalPath, snapshot.volume));
      const st = await fsp.lstat(source).catch(() => null);
      if (!st) continue;
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      // recursive handles a directory; a plain file takes the same call.
      await fsp.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      return { restored: true, fromSnapshotId: snapshot.id, sizeBytes: st.size };
    }
    return {
      restored: false,
      reason: `None of the ${ordered.length} btrfs snapshot${ordered.length === 1 ? '' : 's'} on this system contain that path.`,
    };
  }

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

  /* ---------------- Shell integration ---------------- */

  override async registerShellIntegration(): Promise<ShellIntegrationResult> {
    return registerShellIntegration();
  }

  override async unregisterShellIntegration(): Promise<ShellIntegrationResult> {
    return unregisterShellIntegration();
  }

  override async shellIntegrationInstalled(): Promise<boolean> {
    return linuxShellInstalled();
  }

  /* ---------------- Capability probes ---------------- */

  override async probeFastEnumeration(): Promise<CapabilityState> {
    return { available: true, mechanism: 'readdir + lstat, concurrency sized from /sys/block' };
  }

  override async probeLiveIndex(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'inotify (per-directory watches)',
      degradedTo: 'inotify',
      reason:
        "Live updates use one watch per folder. That covers everything, including folders created later, but very large trees can hit the system's watch limit — TreeMap notices and rechecks the folder instead of missing changes silently.",
    };
  }

  override async probeCloneAwareSizing(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'FS_IOC_FIEMAP',
      degradedTo: 'allocated blocks',
      reason:
        'TreeMap cannot yet tell which files share storage with each other (Btrfs or XFS reflinks). Each file is measured by the space it occupies, so a folder full of shared copies may be reported larger than it really is.',
    };
  }

  override async probePlaceholderDetection(): Promise<CapabilityState> {
    return { available: true, mechanism: 'allocated blocks (lstat)' };
  }

  override async probeOpenHandleGuard(): Promise<CapabilityState> {
    if (!(await fsp.access('/proc/self/fd').then(() => true, () => false))) {
      return {
        available: false,
        mechanism: '/proc',
        reason: 'This system does not expose /proc, so TreeMap cannot check whether a file is in use before deleting it.',
      };
    }
    return {
      available: true,
      mechanism: '/proc/<pid>/fd',
      reason:
        "TreeMap can see files opened by your own programs. Files held open by another user account or by a system service won't be reported unless TreeMap is run as root.",
    };
  }

  override async probeZombieHandles(): Promise<CapabilityState> {
    const ok = await fsp.access('/proc/self/fd').then(() => true, () => false);
    return ok
      ? { available: true, mechanism: '/proc/<pid>/fd' }
      : { available: false, mechanism: '/proc', reason: 'This system does not expose /proc.' };
  }

  override async probeSmartData(): Promise<CapabilityState> {
    if (!(await commandExists('smartctl'))) {
      return {
        available: false,
        mechanism: 'smartctl',
        reason:
          'Drive health reporting needs the smartmontools package, which is not installed. Install it with your package manager (for example: sudo apt install smartmontools).',
      };
    }
    return {
      available: true,
      mechanism: 'smartctl --json',
      reason: 'Reading drive health may require administrator rights; TreeMap will ask the first time you use it.',
    };
  }

  override async probeHardwareEncode(): Promise<HardwareEncodeCapability> {
    // VAAPI exposes a render node per GPU. Its presence proves a GPU is
    // reachable; it does not prove which codecs that GPU can *encode*, and
    // claiming AV1 on that basis is exactly the mistake §C2 calls out.
    const hasRenderNode = await fsp
      .readdir('/dev/dri')
      .then((entries) => entries.some((e) => e.startsWith('renderD')))
      .catch(() => false);

    if (!hasRenderNode) {
      return {
        available: false,
        mechanism: 'VAAPI',
        codecs: [],
        reason: 'No graphics device with video-encoding support was found, so re-encoding videos is not offered.',
      };
    }
    return {
      available: true,
      mechanism: 'VAAPI',
      codecs: ['h264'],
      reason:
        'H.264 hardware encoding is available. HEVC and AV1 depend on the exact graphics chip and are not offered until TreeMap can confirm them.',
    };
  }

  override async probeSnapshotRestore(): Promise<CapabilityState> {
    const { available, reason } = await snapshotAvailability('/');
    return available
      ? { available: true, mechanism: 'btrfs subvolume list' }
      : { available: false, mechanism: 'btrfs subvolume list', reason };
  }

  override async probeVolumeTopology(): Promise<CapabilityState> {
    const reason = await topologyReason();
    return reason === null
      ? { available: true, mechanism: 'lsblk --json' }
      : { available: false, mechanism: 'lsblk --json', reason };
  }

  override async probeProvenance(): Promise<CapabilityState> {
    const { available, reason } = await provenanceAvailable();
    if (!available) return { available: false, mechanism: 'user.xdg.origin.url', reason };
    return {
      available: true,
      mechanism: 'user.xdg.origin.url',
      reason:
        "Firefox does not record where a file was downloaded from on Linux, so files it downloaded will honestly show no origin rather than a wrong one.",
    };
  }

  override async probeShellIntegration(): Promise<CapabilityState> {
    const present: string[] = [];
    if (await commandExists('nautilus', ['--version'])) present.push('Files (Nautilus)');
    if (await commandExists('dolphin', ['--version'])) present.push('Dolphin');
    if (await commandExists('thunar', ['--version'])) present.push('Thunar');

    if (present.length === 0) {
      return {
        available: false,
        mechanism: 'per-user file-manager actions',
        reason:
          'None of the supported file managers (Files, Dolphin, Thunar) were found, so there is nowhere to add a "Scan with TreeMap" entry.',
      };
    }
    return { available: true, mechanism: `per-user actions for ${present.join(', ')}` };
  }

  /**
   * Access time, gated on the mount's own options — see ./lastUsed.ts. A
   * `noatime` mount reports nothing rather than presenting a frozen creation
   * date as a last-opened date.
   */
  override readLastUsed(paths: string[]): Promise<Map<string, LastUsedInfo>> {
    return readLastUsedLinux(paths);
  }

  override probeLastUsed(): Promise<CapabilityState> {
    return probeLastUsedLinux();
  }

  /**
   * Read-only backup membership — see ./backup.ts. Never concludes that a
   * path IS backed up; a false "this is backed up" is the one error that
   * directly destroys data.
   */
  override readBackupMembership(paths: string[]): Promise<Map<string, BackupMembership>> {
    return readBackupMembershipLinux(paths);
  }

  override probeBackupMembership(): Promise<CapabilityState> {
    return probeBackupMembershipLinux();
  }
}
