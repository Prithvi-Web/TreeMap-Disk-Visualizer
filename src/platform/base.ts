import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { neverDescend } from '../utils/mountBoundaries';
import type { PlatformProvider } from './index';
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
  VolumeTopology,
  ZombieHandleInfo,
} from './types';

/**
 * BaseProvider — everything the three platforms genuinely share.
 *
 * The point of putting real work here rather than in three copies is that a
 * fallback implemented once cannot drift into three subtly different fallbacks.
 * Each OS subclass overrides only the methods where its native mechanism beats
 * (or differs from) what is below, and each override documents its mechanism at
 * the top of its own file, per §2.3.
 *
 * Anything genuinely unavailable on a platform returns an empty result plus a
 * capability `reason` — never a thrown "not supported on this platform"
 * (§10, anti-pattern 3).
 */
export abstract class BaseProvider implements PlatformProvider {
  abstract readonly platform: PlatformName;

  /* ------------------------------------------------------------------ *
   * Enumeration
   * ------------------------------------------------------------------ */

  /**
   * Portable streaming enumerator: `readdir(withFileTypes)` + `lstat`, run in
   * device-aware waves.
   *
   * Concurrency is deliberately NOT one flat number. The README's existing
   * finding — that oversizing concurrency makes scans *slower* through kernel
   * metadata-lock contention — applies here too, and the right width differs by
   * an order of magnitude between spinning rust and NVMe. Subclasses override
   * `enumerateConcurrency` with whatever their OS can actually tell them.
   *
   * Yields directories before their contents, so a consumer can build a tree in
   * one pass without buffering.
   */
  async *fastEnumerate(root: string, opts: EnumerateOptions = {}): AsyncIterable<RawEntry> {
    const rootStat = await fsp.lstat(root);
    const rootDev = rootStat.dev;
    const concurrency = opts.concurrency ?? (await this.enumerateConcurrency(root));

    const rootEntry = this.toRawEntry(root, path.basename(root) || root, rootStat);
    yield rootEntry;

    let frontier: string[] = [root];

    while (frontier.length > 0) {
      if (opts.isCancelled?.()) return;

      const wave = frontier.splice(0, concurrency);
      const next: string[] = [];

      const batches = await Promise.all(
        wave.map(async (dir): Promise<RawEntry[]> => {
          let dirents: fs.Dirent[];
          try {
            dirents = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            return []; // unreadable or vanished mid-walk — not fatal
          }
          const out: RawEntry[] = [];
          for (const dirent of dirents) {
            const full = dir === '/' ? '/' + dirent.name : path.join(dir, dirent.name);
            if (opts.skip?.(full)) continue;
            let st: fs.Stats;
            try {
              st = await fsp.lstat(full);
            } catch {
              continue; // vanished between readdir and lstat
            }
            if (opts.singleDevice && st.dev !== rootDev) continue;
            const entry = this.toRawEntry(full, dirent.name, st);
            out.push(entry);
            if (entry.isDir && !entry.isSymlink && !neverDescend(full)) next.push(full);
          }
          return out;
        }),
      );

      // Cancellation is polled *while* yielding, not only between waves. One
      // wave over a directory holding a million entries is a single batch, so
      // checking only at the top of the loop would leave cancel unresponsive
      // for the whole of it — §6 requires every long operation to be
      // genuinely cancellable, not cancellable-at-the-next-convenient-moment.
      for (const batch of batches) {
        for (const entry of batch) {
          if (opts.isCancelled?.()) return;
          yield entry;
        }
      }
      frontier = next.concat(frontier);
    }
  }

  /**
   * Whether `Stats.blocks` means anything on this platform.
   *
   * On macOS and Linux it is the POSIX count of 512-byte blocks actually
   * allocated, and **zero is a meaningful answer** — it is precisely what a
   * fully sparse file or an evicted cloud placeholder reports. On Windows
   * libuv leaves it at zero for every file, where the same zero means nothing
   * at all. Collapsing those two cases is how a Windows drive would report
   * every file as sparse, or a macOS sparse file as ordinary; the Windows
   * provider overrides this to false and supplies the real figure through
   * `GetCompressedFileSize` instead.
   */
  protected get blocksAreMeaningful(): boolean {
    return true;
  }

  /** Shape a Node `Stats` into a RawEntry. One place, so the fields cannot drift. */
  protected toRawEntry(full: string, name: string, st: fs.Stats): RawEntry {
    return {
      path: full,
      name,
      isDir: st.isDirectory(),
      isSymlink: st.isSymbolicLink(),
      size: st.size,
      allocatedSize:
        this.blocksAreMeaningful && typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : null,
      modifiedAt: Math.round(st.mtimeMs),
      dev: st.dev,
      ino: st.ino,
      nlink: st.nlink,
    };
  }

  /**
   * How many directories to read at once. The portable answer is CPU-derived;
   * Linux overrides it with the device's real rotational flag and queue depth.
   */
  protected async enumerateConcurrency(_root: string): Promise<number> {
    return Math.max(4, Math.min(32, os.cpus().length * 2));
  }

  /* ------------------------------------------------------------------ *
   * Change subscription
   * ------------------------------------------------------------------ */

  /**
   * Portable live-change subscription via `fs.watch(recursive: true)`.
   *
   * This is a genuine native mechanism on two of three platforms — Node maps it
   * onto FSEvents on macOS and ReadDirectoryChangesW on Windows — so the macOS
   * and Windows providers inherit it rather than reimplementing it. Linux
   * overrides it, because recursive fs.watch is emulated there and misses
   * subtrees created after the watch starts.
   *
   * `fs.watch` reports *that* something changed, never what kind. One lstat
   * separates the only distinction that can be made without prior state —
   * "still there" from "gone" — so a delete is observed rather than inferred.
   * Telling *created* from *modified* needs to know whether the path existed
   * before, which is the index's knowledge, not the watcher's; the index
   * promotes 'modified' to 'created' when it holds no prior entry.
   */
  subscribeToChanges(root: string, onChange: (e: ChangeEvent) => void): Unsubscribe {
    let watcher: fs.FSWatcher | null = null;
    let closed = false;

    try {
      watcher = fs.watch(root, { recursive: true, persistent: false }, (_type, filename) => {
        if (closed || filename === null) return;
        const full = path.join(root, filename);
        fsp
          .lstat(full)
          .then(() => onChange({ path: full, kind: 'modified', at: Date.now() }))
          .catch(() => onChange({ path: full, kind: 'deleted', at: Date.now() }));
      });
      watcher.on('error', () => {
        /* the watch is best-effort; a dropped watch surfaces as index staleness */
      });
    } catch {
      // Watch could not be established at all (permissions, unsupported fs).
      // The IndexEngine's staleness guard is what covers this case.
      return () => {};
    }

    return () => {
      closed = true;
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Defaults — each is "honestly nothing", overridden where real
   * ------------------------------------------------------------------ */

  async getOpenHandles(_path: string): Promise<OpenHandleInfo[]> {
    return [];
  }

  /**
   * Batch form. The default delegates per path rather than returning `[]`, so a
   * provider that implements only the single-path mechanism still answers a
   * batch correctly — an unknown platform reporting "nothing is open" would be
   * a confident wrong answer in the one place §B2 exists to prevent it.
   */
  async getOpenHandlesBatch(paths: string[]): Promise<OpenHandleInfo[]> {
    const out: OpenHandleInfo[] = [];
    for (const p of paths) out.push(...(await this.getOpenHandles(p)));
    return out;
  }

  async getZombieHandles(): Promise<ZombieHandleInfo[]> {
    return [];
  }

  async getCloneFamily(_path: string): Promise<CloneFamilyId | null> {
    return null;
  }

  /**
   * Bytes actually occupied. The portable answer (`st.blocks * 512`) is exact
   * on macOS and Linux; Windows overrides it because libuv does not fill
   * `blocks` there.
   */
  async getAllocatedSize(p: string): Promise<number> {
    const st = await fsp.lstat(p);
    return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : st.size;
  }

  async getPlaceholderInfo(_path: string): Promise<PlaceholderInfo | null> {
    return null;
  }

  async getSmartData(_devicePath: string): Promise<SmartInfo | null> {
    return null;
  }

  async getDownloadOrigin(_path: string): Promise<ProvenanceInfo | null> {
    return null;
  }

  async listLogicalVolumes(): Promise<LogicalVolumeInfo[]> {
    return (await this.getVolumeTopology()).logicalVolumes;
  }

  async getVolumeTopology(): Promise<VolumeTopology> {
    return { physicalDisks: [], logicalVolumes: [], mechanism: 'none' };
  }

  async listSnapshots(_volume: string): Promise<VolumeSnapshotRef[]> {
    return [];
  }

  async readFromSnapshot(_snapshot: VolumeSnapshotRef, _path: string): Promise<NodeJS.ReadableStream> {
    throw new Error('No filesystem snapshot mechanism is available on this system');
  }

  async registerShellIntegration(): Promise<ShellIntegrationResult> {
    return { installed: false, targets: [], reason: 'Shell integration is not available on this system' };
  }

  async unregisterShellIntegration(): Promise<ShellIntegrationResult> {
    return { installed: false, targets: [], reason: 'Nothing was installed' };
  }

  /* ------------------------------------------------------------------ *
   * Capability probes — subclasses override the ones they can satisfy
   * ------------------------------------------------------------------ */

  async probeFastEnumeration(): Promise<CapabilityState> {
    return {
      available: true,
      mechanism: 'readdir + lstat (device-aware concurrency)',
    };
  }

  async probeLiveIndex(): Promise<CapabilityState> {
    return { available: true, mechanism: 'fs.watch (recursive)' };
  }

  async probeCloneAwareSizing(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'This system exposes no way to identify files that share storage, so folder sizes are logical sums.',
    };
  }

  async probePlaceholderDetection(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'Cloud placeholder files cannot be distinguished from ordinary files on this system.',
    };
  }

  async probeOpenHandleGuard(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'TreeMap cannot check which programs have a file open on this system, so deletes proceed without that warning.',
    };
  }

  async probeZombieHandles(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'Space held by deleted-but-still-open files cannot be measured on this system.',
    };
  }

  async probeSmartData(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'smartctl',
      reason: 'Drive health reporting needs smartmontools, which is not available here.',
    };
  }

  /**
   * Hardware *encode* only. Decode support never counts here: offering AV1
   * because the chip can decode it would silently drop the user onto a software
   * encoder 10–50× slower (§C2).
   */
  async probeHardwareEncode(): Promise<HardwareEncodeCapability> {
    return {
      available: false,
      mechanism: 'none',
      codecs: [],
      reason: 'TreeMap could not confirm hardware video encoding on this system, so re-encoding is not offered.',
    };
  }

  async probeSnapshotRestore(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'This system has no filesystem snapshots TreeMap can read.',
    };
  }

  async probeVolumeTopology(): Promise<CapabilityState> {
    return { available: false, mechanism: 'none', reason: 'Disk layout information is not available on this system.' };
  }

  async probeProvenance(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'This system does not record where downloaded files came from.',
    };
  }

  async probeShellIntegration(): Promise<CapabilityState> {
    return {
      available: false,
      mechanism: 'none',
      reason: 'No supported file manager was found to add a "Scan with TreeMap" entry to.',
    };
  }
}
