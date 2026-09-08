import { runPowerShellJson, asArray } from './powershell';
import type { LogicalVolumeInfo, PhysicalDiskInfo, VolumeTopology } from '../types';

/**
 * Volume topology on Windows (A5), including Storage Spaces.
 *
 * Mechanism choice (§2.3): tier 3, PowerShell cmdlets with `ConvertTo-Json` —
 * a genuine structured mode, so no table output is parsed.
 *
 * Five queries, combined:
 *   - `Get-PhysicalDisk` — the hardware: name, size, SSD or HDD
 *   - `Get-Disk`         — the disk objects Windows partitions (a plain disk is
 *                          its hardware; a Storage Space is a virtual disk)
 *   - `Get-Partition`    — which disk number each drive letter lives on
 *   - `Get-Volume`       — mounted volumes with size and free space
 *   - `Get-VirtualDisk`  — each space, with the disk it presents and the
 *                          drives beneath it, found by piping the space into
 *                          `Get-Disk` and `Get-PhysicalDisk` (their
 *                          `-VirtualDisk` parameter follows the CIM association)
 *
 * The join that matters (issue #35): a volume → its partition's disk number →
 * that disk's hardware. A disk is matched to its hardware by `UniqueId`, then
 * `SerialNumber` — both documented on both cmdlets — and last by the observed
 * correspondence DeviceId = disk Number, which Windows does not document as an
 * equivalence and which a pool member's DeviceId is never allowed to satisfy.
 * An identifier two records share identifies neither. A letter the partition
 * map does not know is shown as unplaced, never guessed onto a disk.
 *
 * The mapper is pure and unit-tested against hand-built shapes modelled on the
 * reporter's machine (two SSDs), a boot SSD beside a mirror, a plain laptop
 * and a pool — not captures from real Windows output. Authored on macOS.
 * `tests/platformCrossOs.test.ts` carries a live round-trip gated to win32 that
 * the windows-latest leg of test.yml runs; it checks the identifier assumption
 * on a plain disk against real output. Nothing in CI exercises the Storage
 * Spaces association output.
 */

export const TOPOLOGY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$disks    = @(Get-Disk | Select-Object Number, FriendlyName, Size, BusType, UniqueId, SerialNumber)
$volumes  = @(Get-Volume | Where-Object { $_.DriveLetter -and ([string]$_.DriveType) -ne 'CD-ROM' } |
               Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType, Size, SizeRemaining, Path)
$physical = @(Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, Size, MediaType, UniqueId, SerialNumber)
$virtual  = @(Get-VirtualDisk | ForEach-Object {
  $vd = $_
  [pscustomobject]@{
    FriendlyName = $vd.FriendlyName; Size = $vd.Size; ResiliencySettingName = $vd.ResiliencySettingName
    DiskNumber = ($vd | Get-Disk | Select-Object -First 1).Number
    PhysicalDiskIds = @($vd | Get-PhysicalDisk | ForEach-Object { [string]$_.DeviceId })
  }
})
$partMap  = @(Get-Partition | Where-Object { $_.DriveLetter } |
               Select-Object DiskNumber, DriveLetter)
[pscustomobject]@{
  disks = $disks; volumes = $volumes; physical = $physical; virtual = $virtual; partitions = $partMap
} | ConvertTo-Json -Depth 5 -Compress
`;

interface PsDisk {
  Number?: number | null;
  FriendlyName?: string | null;
  Size?: number | null;
  BusType?: string | number | null;
  UniqueId?: string | null;
  SerialNumber?: string | null;
}
interface PsVolume {
  DriveLetter?: string | null;
  FileSystemLabel?: string | null;
  FileSystem?: string | null;
  DriveType?: string | number | null;
  Size?: number | null;
  SizeRemaining?: number | null;
}
interface PsPhysical {
  DeviceId?: string | number | null;
  FriendlyName?: string | null;
  Size?: number | null;
  /** "HDD" | "SSD" | "SCM" | "Unspecified", or the numeric code behind it */
  MediaType?: string | number | null;
  UniqueId?: string | null;
  SerialNumber?: string | null;
}
interface PsVirtual {
  FriendlyName?: string | null;
  Size?: number | null;
  ResiliencySettingName?: string | null;
  /** The disk object this space presents (`$vd | Get-Disk`). */
  DiskNumber?: number | null;
  /** The drives beneath it (`$vd | Get-PhysicalDisk`), as DeviceIds. */
  PhysicalDiskIds?: string | string[] | null;
}
interface PsPartition {
  DiskNumber?: number | null;
  DriveLetter?: string | null;
}

export interface WindowsTopologyDoc {
  disks?: PsDisk | PsDisk[] | null;
  volumes?: PsVolume | PsVolume[] | null;
  physical?: PsPhysical | PsPhysical[] | null;
  virtual?: PsVirtual | PsVirtual[] | null;
  partitions?: PsPartition | PsPartition[] | null;
}

/** Identifiers as keys: trimmed, case-folded, and empty means none. */
function keyOf(id: string | number | null | undefined): string | null {
  const s = id === null || id === undefined ? '' : String(id).trim().toUpperCase();
  return s === '' ? null : s;
}

/** "HDD" (code 3) is the only value that positively means spinning media. */
function rotationalOf(mediaType: string | number | null | undefined): boolean | null {
  const m = keyOf(mediaType);
  if (m === 'HDD' || m === '3') return true;
  if (m === 'SSD' || m === '4' || m === 'SCM' || m === '5') return false;
  return null; // "Unspecified" genuinely means unknown, not "not rotational"
}
/** MSFT_Disk.BusType 16, shown as "Storage Spaces". */
const isStorageSpaces = (busType: string | number | null | undefined): boolean => {
  const b = keyOf(busType);
  return b === 'STORAGE SPACES' || b === 'SPACES' || b === '16';
};
/** MSFT_Volume.DriveType 5: a disc, not disk storage. */
const isOpticalDrive = (driveType: string | number | null | undefined): boolean => {
  const d = keyOf(driveType);
  return d === 'CD-ROM' || d === 'CDROM' || d === '5';
};
/** A locked BitLocker volume or a RAW one reports no filesystem, and its free space is not a number to trust. */
const isReadableFilesystem = (fs: string | null | undefined): boolean => {
  const f = keyOf(fs);
  return f !== null && f !== 'UNKNOWN' && f !== 'RAW';
};

/** What a disk number resolves to: the disks shown for it, and what kind of volume sits on it. */
interface Backing {
  ids: string[];
  kind: 'simple' | 'storage-spaces';
}

/** Keys that appear on exactly one record; a key two records share identifies neither. */
function onceOnly<T>(records: T[], pick: (r: T) => string | number | null | undefined): Map<string, T> {
  const seen = new Map<string, T | null>();
  for (const r of records) {
    const k = keyOf(pick(r));
    if (k !== null) seen.set(k, seen.has(k) ? null : r);
  }
  const out = new Map<string, T>();
  for (const [k, r] of seen) if (r !== null) out.set(k, r);
  return out;
}

interface Hardware {
  shown: PhysicalDiskInfo[];
  /** ids of the Get-PhysicalDisk records, in order; `shown` may later grow stand-ins. */
  ids: string[];
  byUnique: Map<string, string>;
  bySerial: Map<string, string>;
  byDevice: Map<string, string>;
  /** DeviceIds a space names as members — pooled drives, never plain disks. */
  poolMembers: Set<string>;
}

/** The hardware, as Get-PhysicalDisk reports it, with the keys a disk can be matched on. */
function indexHardware(physicalRaw: PsPhysical[], virtualRaw: PsVirtual[]): Hardware {
  const shown: PhysicalDiskInfo[] = [];
  const ids: string[] = [];
  const taken = new Set<string>();
  physicalRaw.forEach((p, i) => {
    const label = [p.DeviceId, p.UniqueId, p.FriendlyName]
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .find((x) => x !== '') ?? `#${i}`;
    // Two records that would share an id would share one card, each showing the other's volumes.
    const id = taken.has(`physical:${label}`) ? `physical:${label}#${i}` : `physical:${label}`;
    taken.add(id);
    ids.push(id);
    shown.push({
      id,
      name: p.FriendlyName ?? null,
      sizeBytes: typeof p.Size === 'number' ? p.Size : null,
      rotational: rotationalOf(p.MediaType),
    });
  });
  const index = (pick: (p: PsPhysical) => string | number | null | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, p] of onceOnly(physicalRaw, pick)) out.set(k, ids[physicalRaw.indexOf(p)]);
    return out;
  };
  const poolMembers = new Set<string>();
  for (const v of virtualRaw) {
    for (const m of asArray(v.PhysicalDiskIds)) {
      const k = keyOf(m);
      if (k !== null) poolMembers.add(k);
    }
  }
  return { shown, ids, byUnique: index((p) => p.UniqueId), bySerial: index((p) => p.SerialNumber), byDevice: index((p) => p.DeviceId), poolMembers };
}

interface Placement {
  backingByNumber: Map<number, Backing>;
  pooled: boolean;
  /** Disk number of the hardware a plain disk claimed, for telling same-model drives apart. */
  numberOf: Map<string, string>;
  /** The one place a volume can be when the partition map is empty, if there is exactly one. */
  singlePlace: Backing | null;
}

/** Resolve every disk number to what backs it: hardware, a stand-in, or a space's members. */
function placeDisks(disksRaw: PsDisk[], partitions: PsPartition[], virtualRaw: PsVirtual[], hw: Hardware): Placement {
  const backingByNumber = new Map<number, Backing>();
  const claimed = new Set<string>();
  const numberOf = new Map<string, string>();
  const spacesByNumber = new Map<number, PsVirtual>();
  for (const v of virtualRaw) if (typeof v.DiskNumber === 'number') spacesByNumber.set(v.DiskNumber, v);
  const diskUnique = onceOnly(disksRaw, (d) => d.UniqueId);
  const diskSerial = onceOnly(disksRaw, (d) => d.SerialNumber);

  const hardwareFor = (number: number, d: PsDisk | undefined): string | undefined => {
    if (d) {
      const u = keyOf(d.UniqueId);
      const byUnique = u !== null && diskUnique.has(u) ? hw.byUnique.get(u) : undefined;
      if (byUnique !== undefined) return byUnique;
      const s = keyOf(d.SerialNumber);
      const bySerial = s !== null && diskSerial.has(s) ? hw.bySerial.get(s) : undefined;
      if (bySerial !== undefined) return bySerial;
    }
    const n = String(number);
    return hw.poolMembers.has(n) ? undefined : hw.byDevice.get(n); // a pool member is never a plain disk
  };

  /** A plain disk resolves to its hardware, or — when nothing matches — to itself, shown. */
  const plain = (number: number, d: PsDisk | undefined): Backing => {
    const hardware = hardwareFor(number, d);
    if (hardware !== undefined) {
      claimed.add(hardware);
      numberOf.set(hardware, String(number));
      return { ids: [hardware], kind: 'simple' };
    }
    const own = `disk:${String(number)}`;
    if (!hw.shown.some((s) => s.id === own)) {
      hw.shown.push({
        id: own,
        name: d?.FriendlyName ?? `Disk ${String(number)}`,
        sizeBytes: typeof d?.Size === 'number' ? d.Size : null,
        rotational: null, // no hardware record, so no claim about the media
      });
      numberOf.set(own, String(number));
    }
    return { ids: [own], kind: 'simple' };
  };

  // Spaces resolve after every plain disk has claimed its hardware, so a space
  // whose members the association did not name falls back to the drives no
  // plain disk owns, and no further.
  const spaces: Array<{ number: number; space: PsVirtual | undefined }> = [];
  let pooled = virtualRaw.length > 0;
  for (const d of disksRaw) {
    if (typeof d.Number !== 'number') continue;
    const space = spacesByNumber.get(d.Number);
    if (space !== undefined || isStorageSpaces(d.BusType)) {
      pooled = true;
      spaces.push({ number: d.Number, space });
      continue;
    }
    backingByNumber.set(d.Number, plain(d.Number, d));
  }
  for (const [number, space] of spacesByNumber) {
    if (!spaces.some((s) => s.number === number)) spaces.push({ number, space });
  }
  for (const part of partitions) {
    if (typeof part.DiskNumber !== 'number' || backingByNumber.has(part.DiskNumber)) continue;
    if (spaces.some((s) => s.number === part.DiskNumber)) continue;
    backingByNumber.set(part.DiskNumber, plain(part.DiskNumber, undefined));
  }

  const unclaimed = hw.ids.filter((id) => !claimed.has(id));
  const spaceBacking = (space: PsVirtual | undefined): Backing => {
    const members = asArray(space?.PhysicalDiskIds)
      .map((m) => hw.byDevice.get(keyOf(m) ?? ''))
      .filter((id): id is string => id !== undefined);
    return { ids: members.length ? members : unclaimed, kind: 'storage-spaces' };
  };
  for (const { number, space } of spaces) backingByNumber.set(number, spaceBacking(space));

  const plainBackings = [...backingByNumber.values()].filter((b) => b.kind === 'simple');
  const singlePlace: Backing | null =
    plainBackings.length === 1 && spaces.length === 0 ? plainBackings[0]
      : plainBackings.length === 0 && spaces.length === 1 ? backingByNumber.get(spaces[0].number) ?? null
        : plainBackings.length === 0 && spaces.length === 0 && virtualRaw.length === 1 ? spaceBacking(virtualRaw[0])
          : plainBackings.length === 0 && spaces.length === 0 && hw.shown.length === 1 ? { ids: [hw.shown[0].id], kind: 'simple' }
            : null;
  return { backingByNumber, pooled, numberOf, singlePlace };
}

/** Each volume, on the disk its partition names — or honestly on none. */
function attributeVolumes(volumesRaw: PsVolume[], partitions: PsPartition[], placement: Placement): LogicalVolumeInfo[] {
  const letterToDisk = new Map<string, number>();
  for (const part of partitions) {
    const letter = keyOf(part.DriveLetter);
    if (letter !== null && typeof part.DiskNumber === 'number') letterToDisk.set(letter, part.DiskNumber);
  }
  return volumesRaw.filter((v) => !isOpticalDrive(v.DriveType)).map((v) => {
    const letter = keyOf(v.DriveLetter) ?? '';
    const diskNumber = letterToDisk.get(letter);
    const known = diskNumber === undefined ? undefined : placement.backingByNumber.get(diskNumber);
    // A letter the partition map does not know: when the map is empty it may
    // simply be missing, and a machine with one place to be still places it.
    // When the map knows other letters but not this one, the volume is not an
    // ordinary partition (a dynamic-disk volume, a RAM disk) and any disk
    // named for it would be a confident wrong answer.
    const backing: Backing = known
      ?? (partitions.length === 0 && placement.singlePlace ? placement.singlePlace : { ids: [], kind: 'simple' });

    // A locked or unreadable volume reports 0 or nothing for its figures; 0 is
    // not a size and its free space is not a number to subtract from.
    const size = typeof v.Size === 'number' && v.Size > 0 ? v.Size : null;
    const remaining = isReadableFilesystem(v.FileSystem) && typeof v.SizeRemaining === 'number' ? v.SizeRemaining : null;
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
      physicalDiskIds: backing.ids,
      kind: backing.kind,
    };
  });
}

/** Two drives of the same model are told apart by the number Disk Management gives them. */
function withDistinctNames(shown: PhysicalDiskInfo[], numberOf: Map<string, string>, hw: Hardware, physicalRaw: PsPhysical[]): PhysicalDiskInfo[] {
  const counts = new Map<string, number>();
  for (const d of shown) if (d.name) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  return shown.map((d) => {
    if (!d.name || (counts.get(d.name) ?? 0) < 2) return d;
    const i = hw.ids.indexOf(d.id);
    const number = numberOf.get(d.id) ?? (i >= 0 ? keyOf(physicalRaw[i].DeviceId) : null);
    return number === null || number === undefined ? d : { ...d, name: `${d.name} (Disk ${number})` };
  });
}

/** What the reading could not establish, said through the capability note the panel renders. */
function degradationOf(disksRaw: PsDisk[], physicalRaw: PsPhysical[], partitions: PsPartition[], volumes: LogicalVolumeInfo[]): VolumeTopology['degraded'] {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (partitions.length === 0 && volumes.length > 0 && Math.max(disksRaw.length, physicalRaw.length) > 1) {
    missing.push('Get-Partition');
    reasons.push('Windows did not say which disk each drive letter lives on, so the volumes are listed without their disks.');
  }
  if (physicalRaw.length === 0 && disksRaw.length > 0) {
    missing.push('Get-PhysicalDisk');
    reasons.push('Windows did not describe the drives themselves, so whether each is an SSD or a hard disk is not shown.');
  }
  if (!reasons.length) return undefined;
  return {
    degradedTo: ['Get-Disk', 'Get-Partition', 'Get-PhysicalDisk', 'Get-Volume'].filter((c) => !missing.includes(c)).join(' + '),
    reason: reasons.join(' '),
  };
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

  const hardware = indexHardware(physicalRaw, virtualRaw);
  const placement = placeDisks(disksRaw, partitions, virtualRaw, hardware);
  const logicalVolumes = attributeVolumes(asArray(doc.volumes), partitions, placement);
  const physicalDisks = withDistinctNames(hardware.shown, placement.numberOf, hardware, physicalRaw);
  const degraded = degradationOf(disksRaw, physicalRaw, partitions, logicalVolumes);

  return {
    physicalDisks,
    logicalVolumes,
    mechanism: `Get-Disk + Get-Partition + Get-PhysicalDisk + Get-Volume${placement.pooled ? ' + Get-VirtualDisk' : ''}`,
    ...(degraded ? { degraded } : {}),
  };
}

/** The raw combined query, exported so the live test on Windows can inspect the shapes it maps. */
export function readWindowsTopologyDoc(): Promise<WindowsTopologyDoc> {
  return runPowerShellJson<WindowsTopologyDoc>(TOPOLOGY_SCRIPT, { timeoutMs: 30_000 });
}

export async function volumeTopology(): Promise<VolumeTopology> {
  return mapWindowsTopology(await readWindowsTopologyDoc());
}
