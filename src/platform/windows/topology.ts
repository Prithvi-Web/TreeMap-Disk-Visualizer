import { runPowerShellJson, asArray } from './powershell';
import type { LogicalVolumeInfo, PhysicalDiskInfo, VolumeTopology } from '../types';

/**
 * Volume topology on Windows (A5), including Storage Spaces.
 *
 * Mechanism choice (§2.3): tier 3, PowerShell cmdlets with `ConvertTo-Json` —
 * a genuine structured mode, so no table output is parsed.
 *
 * Three queries, combined:
 *   - `Get-Disk`          — physical disks (or, on a Storage Spaces machine,
 *                           the virtual disks the OS presents)
 *   - `Get-Volume`        — mounted volumes with size and free space
 *   - `Get-PhysicalDisk` + `Get-VirtualDisk` — the Storage Spaces pool mapping,
 *                           which is the whole reason A5 exists on Windows
 *
 * On a plain single-disk laptop `Get-VirtualDisk` returns nothing and the
 * result collapses to one disk with its volumes beneath it — the "simple and
 * uncluttered" case A5 asks for, reached by the same code path rather than a
 * special case.
 *
 * ⚠ **Not executed on Windows by the author** (written on macOS). The mapping
 * below is pure and unit-tested against JSON shapes recorded from the
 * documented cmdlet output; the live round-trip runs in CI on `windows-latest`.
 */

const TOPOLOGY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$disks    = @(Get-Disk | Select-Object Number, FriendlyName, Size, BusType)
$volumes  = @(Get-Volume | Where-Object { $_.DriveLetter } |
               Select-Object DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining, Path)
$physical = @(Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, Size, MediaType)
$virtual  = @(Get-VirtualDisk | Select-Object FriendlyName, Size, ResiliencySettingName)
$partMap  = @(Get-Partition | Where-Object { $_.DriveLetter } |
               Select-Object DiskNumber, DriveLetter)
[pscustomobject]@{
  disks = $disks; volumes = $volumes; physical = $physical; virtual = $virtual; partitions = $partMap
} | ConvertTo-Json -Depth 5 -Compress
`;

interface PsDisk {
  Number?: number;
  FriendlyName?: string;
  Size?: number;
  BusType?: string;
}
interface PsVolume {
  DriveLetter?: string;
  FileSystemLabel?: string;
  FileSystem?: string;
  Size?: number;
  SizeRemaining?: number;
}
interface PsPhysical {
  DeviceId?: string | number;
  FriendlyName?: string;
  Size?: number;
  /** "HDD" | "SSD" | "SCM" | "Unspecified" */
  MediaType?: string;
}
interface PsVirtual {
  FriendlyName?: string;
  Size?: number;
  ResiliencySettingName?: string;
}
interface PsPartition {
  DiskNumber?: number;
  DriveLetter?: string;
}

export interface WindowsTopologyDoc {
  disks?: PsDisk | PsDisk[];
  volumes?: PsVolume | PsVolume[];
  physical?: PsPhysical | PsPhysical[];
  virtual?: PsVirtual | PsVirtual[];
  partitions?: PsPartition | PsPartition[];
}

/** "HDD" is the only value that positively means spinning media. */
function rotationalOf(mediaType: string | undefined): boolean | null {
  if (mediaType === 'HDD') return true;
  if (mediaType === 'SSD' || mediaType === 'SCM') return false;
  return null; // "Unspecified" genuinely means unknown, not "not rotational"
}

/**
 * Build the topology from the combined query.
 *
 * Pure and exported: a Storage Spaces pool, a multi-disk workstation and a
 * plain laptop are all just different documents, so all three are testable
 * from a machine that is none of them.
 */
export function mapWindowsTopology(doc: WindowsTopologyDoc): VolumeTopology {
  const physicalRaw = asArray(doc.physical);
  const disksRaw = asArray(doc.disks);
  const virtualRaw = asArray(doc.virtual);
  const partitions = asArray(doc.partitions);

  // Prefer Get-PhysicalDisk: on a Storage Spaces machine Get-Disk shows the
  // *virtual* disk, so treating that as hardware would report a pool of six
  // drives as one, which is precisely the question A5 exists to answer.
  const physicalDisks: PhysicalDiskInfo[] = physicalRaw.length
    ? physicalRaw.map((p) => ({
        id: `physical:${String(p.DeviceId ?? p.FriendlyName ?? '')}`,
        name: p.FriendlyName ?? null,
        sizeBytes: typeof p.Size === 'number' ? p.Size : null,
        rotational: rotationalOf(p.MediaType),
      }))
    : disksRaw.map((d) => ({
        id: `disk:${String(d.Number ?? '')}`,
        name: d.FriendlyName ?? null,
        sizeBytes: typeof d.Size === 'number' ? d.Size : null,
        rotational: null,
      }));

  // Drive letter → disk number, so a volume can name the hardware under it.
  const letterToDisk = new Map<string, number>();
  for (const part of partitions) {
    if (typeof part.DriveLetter === 'string' && typeof part.DiskNumber === 'number') {
      letterToDisk.set(part.DriveLetter.toUpperCase(), part.DiskNumber);
    }
  }

  const pooled = virtualRaw.length > 0;
  const allPhysicalIds = physicalDisks.map((d) => d.id);

  const logicalVolumes: LogicalVolumeInfo[] = asArray(doc.volumes).map((v) => {
    const letter = (v.DriveLetter ?? '').toUpperCase();
    const diskNumber = letterToDisk.get(letter);

    // On a pooled machine a volume genuinely spans every disk in the pool, so
    // attributing it to one would be a confident wrong answer. Off a pool, it
    // maps to exactly the disk its partition lives on.
    const backing = pooled
      ? allPhysicalIds
      : diskNumber !== undefined && physicalRaw.length === 0
        ? [`disk:${String(diskNumber)}`]
        : allPhysicalIds.length === 1
          ? allPhysicalIds
          : [];

    const size = typeof v.Size === 'number' ? v.Size : null;
    const remaining = typeof v.SizeRemaining === 'number' ? v.SizeRemaining : null;
    return {
      id: letter ? `${letter}:` : (v.FileSystemLabel ?? 'volume'),
      name: v.FileSystemLabel || (letter ? `${letter}:` : null),
      mountPoint: letter ? `${letter}:\\` : null,
      filesystem: v.FileSystem ?? null,
      sizeBytes: size,
      freeBytes: remaining,
      // An NTFS volume owns its space outright, so its own consumption really
      // is size minus free — there is no shared-pool ceiling to misread here.
      usedBytes: size !== null && remaining !== null ? size - remaining : null,
      physicalDiskIds: backing,
      kind: pooled ? 'storage-spaces' : 'simple',
    };
  });

  return {
    physicalDisks,
    logicalVolumes,
    mechanism: pooled ? 'Get-PhysicalDisk + Get-VirtualDisk + Get-Volume' : 'Get-Disk + Get-Volume',
  };
}

export async function volumeTopology(): Promise<VolumeTopology> {
  const doc = await runPowerShellJson<WindowsTopologyDoc>(TOPOLOGY_SCRIPT, { timeoutMs: 30_000 });
  return mapWindowsTopology(doc);
}
