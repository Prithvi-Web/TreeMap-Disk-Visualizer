import { runPowerShellJson, asArray, type PowerShellOptions } from './powershell';
import type { VolumeSnapshotRef } from '../types';

/**
 * Volume Shadow Copy enumeration on Windows (B4).
 *
 * Mechanism choice (§2.3): tier 3, but deliberately **`Get-CimInstance
 * Win32_ShadowCopy` rather than `vssadmin list shadows`**. Two reasons, both of
 * which matter:
 *
 *   1. `vssadmin` prints a localised human table — on a German or Japanese
 *      Windows its field labels are translated, so any parser written against
 *      the English output silently finds nothing. `Win32_ShadowCopy` returns
 *      typed properties with invariant names. §10 bans regex over human output
 *      precisely to avoid this class of bug.
 *   2. `vssadmin list shadows` **requires an elevated prompt**;
 *      `Win32_ShadowCopy` can be enumerated without one. §3.8 forbids requiring
 *      elevation for anything achievable without it, so listing never asks for
 *      admin. (Reading *from* a shadow copy is a separate matter — see below.)
 *
 * ── Reading a shadow copy's contents ──
 *
 * `DeviceObject` is a raw device path like
 * `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`. Windows will not open a
 * path beneath it directly; it has to be given a name first, which
 * `mklink /d` does as a directory symbolic link. Creating one needs either
 * administrator rights or Developer Mode, so restore-from-snapshot is the one
 * place TreeMap asks for elevation — at the moment the user invokes it, once,
 * with an explanation, exactly as §3.8 requires. Enumeration stays unelevated,
 * so the UI can honestly say "3 restore points cover this file" before asking
 * for anything.
 *
 * ⚠ **Not executed on Windows by the author** (written on macOS). The mapping
 * is pure and unit-tested; the live round-trip runs in CI on `windows-latest`.
 */

const SHADOW_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
@(Get-CimInstance -ClassName Win32_ShadowCopy |
  Select-Object ID, VolumeName, DeviceObject, @{ n = 'InstallDate'; e = { if ($_.InstallDate) { $_.InstallDate.ToUniversalTime().ToString('o') } } }) |
  ConvertTo-Json -Depth 3 -Compress
`;

interface RawShadowCopy {
  ID?: string;
  VolumeName?: string;
  DeviceObject?: string;
  /** CIM hands this back as an ISO-ish string once JSON-converted. */
  InstallDate?: string | { value?: string } | null;
}

/**
 * `InstallDate` arrives in more than one shape depending on the PowerShell
 * version: the ISO string the scripts now ask for, Windows PowerShell 5.1's
 * `\/Date(1756720800000)\/` wire format (bare, or inside a `{ value, DateTime }`
 * wrapper whose DateTime is culture-formatted text — never read), or a plain
 * date string. Anything that does not parse becomes null rather than an
 * invented date.
 */
export function parseInstallDate(value: RawShadowCopy['InstallDate']): number | null {
  const raw = typeof value === 'string' ? value : typeof value === 'object' && value ? value.value : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const wire = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(raw.trim());
  if (wire) return Number(wire[1]);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map Win32_ShadowCopy instances to snapshot references.
 *
 * `volumeFilter` keeps only shadow copies of the volume in question — a machine
 * with copies of C:, D: and E: must not offer to restore a C: file from a D:
 * snapshot, which would either fail confusingly or restore the wrong file.
 * Pure and exported for tests.
 */
export function mapShadowCopies(raw: unknown, volumeFilter?: string): VolumeSnapshotRef[] {
  const wanted = volumeFilter ? normalizeVolume(volumeFilter) : null;

  return asArray(raw as RawShadowCopy | RawShadowCopy[])
    .filter((s): s is RawShadowCopy & { ID: string } => typeof s.ID === 'string' && s.ID.length > 0)
    .filter((s) => wanted === null || normalizeVolume(s.VolumeName ?? '') === wanted)
    .map((s) => ({
      id: s.ID,
      name: s.ID,
      takenAt: parseInstallDate(s.InstallDate),
      volume: s.VolumeName ?? '',
      // Not readable until a directory link names it — mountShadowCopy() does
      // that, and only when a restore is actually attempted.
      accessPath: null,
    }))
    .sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
}

/**
 * Compare volumes irrespective of how they were written.
 *
 * `Win32_ShadowCopy.VolumeName` is a volume GUID path
 * (`\\?\Volume{…}\`) while callers pass `C:\`, so a naive string compare
 * matches nothing at all and the feature silently reports "no snapshots".
 * Anything that looks like a drive letter is reduced to that letter; GUID paths
 * are compared case-insensitively without their trailing separator.
 */
export function normalizeVolume(volume: string): string {
  const trimmed = volume.trim().replace(/[\\/]+$/, '');
  const letter = trimmed.match(/^([A-Za-z]):$/);
  if (letter) return letter[1].toUpperCase() + ':';
  return trimmed.toLowerCase();
}

export async function listSnapshots(volume: string): Promise<VolumeSnapshotRef[]> {
  try {
    const raw = await runPowerShellJson<unknown>(SHADOW_SCRIPT, { timeoutMs: 30_000 });
    return mapShadowCopies(raw, volume || undefined);
  } catch {
    return [];
  }
}

/** Are there any shadow copies at all, and if not, why not? */
export async function snapshotAvailability(): Promise<{ available: boolean; reason?: string }> {
  try {
    const raw = await runPowerShellJson<unknown>(SHADOW_SCRIPT, { timeoutMs: 30_000 });
    if (mapShadowCopies(raw).length === 0) {
      return {
        available: false,
        reason:
          'This PC has no restore points, so there is nothing to recover deleted files from. Restore points appear once System Protection is turned on in Windows.',
      };
    }
    return { available: true };
  } catch {
    return {
      available: false,
      reason: 'TreeMap could not read this PC\u2019s restore points, so recovering deleted files from them is unavailable.',
    };
  }
}

/* ───────────── Shadow storage: the bytes restore points hold (issue #33) ───────────── */

/**
 * `Win32_ShadowStorage.UsedSpace` is the figure `vssadmin list shadowstorage`
 * prints as "Used Shadow Copy Storage space" — but typed, and named the same
 * in every language. A Portuguese Windows prints "Espaço de armazenamento de
 * cópias de sombra usado: 7,98 GB", which no English regex and no
 * `parseFloat` reads (the decimal separator is a comma). Storage is reported
 * only to an administrator on most machines, so the script also asks Windows
 * whether this process IS one — a boolean, not a translated error message —
 * and catches the refusal as invariant fields (the error category and the
 * CIM status name are enum names, never localised). The restore points
 * themselves (`Win32_ShadowCopy`) are believed to list without elevation, so
 * the count is usually known even when the size is not — believed, not
 * proven: GitHub's Windows runners are administrators, so no CI run exercises
 * a standard user, and the mapping below refuses to read "nothing listed" as
 * a zero for one.
 *
 * Every step is inside its own `try`: under ConstrainedLanguage mode (an
 * App Control-managed PC) the `WindowsIdentity` type is not allowed and the
 * elevation probe throws, and a script that dies there would print a
 * localised error instead of an answer. Dates are asked for as ISO strings
 * because Windows PowerShell 5.1 otherwise serialises them as `\/Date(ms)\/`.
 * `Win32_Volume` maps volume GUIDs to drive letters so the receipt for C: can
 * leave D:'s shadow storage out. `-OperationTimeoutSec` makes a wedged VSS
 * service fail as data rather than as a killed process.
 */
export const STORAGE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Failure($e) {
  try { @{ id = "$($e.FullyQualifiedErrorId)"; category = "$($e.CategoryInfo.Category)"; native = "$($e.Exception.NativeErrorCode)"; hresult = $e.Exception.HResult } }
  catch { @{ id = 'unreadable-error' } }
}
$elevated = $null
try { $elevated = [bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) } catch { }
$volumes = @()
try { $volumes = @(Get-CimInstance -ClassName Win32_Volume -ErrorAction Stop -OperationTimeoutSec 10 | Select-Object DeviceID, DriveLetter) } catch { }
$copies = $null
$copiesFailure = $null
try {
  $copies = @(Get-CimInstance -ClassName Win32_ShadowCopy -ErrorAction Stop -OperationTimeoutSec 10 | Select-Object ID, VolumeName, @{ n = 'InstallDate'; e = { if ($_.InstallDate) { $_.InstallDate.ToUniversalTime().ToString('o') } } })
} catch { $copiesFailure = Failure $_ }
$storage = $null
$failure = $null
try {
  $storage = @(Get-CimInstance -ClassName Win32_ShadowStorage -ErrorAction Stop -OperationTimeoutSec 10 | Select-Object UsedSpace, AllocatedSpace, MaxSpace, @{ n = 'Volume'; e = { $_.Volume.DeviceID } })
} catch { $failure = Failure $_ }
@{ elevated = $elevated; volumes = $volumes; copies = $copies; copiesFailure = $copiesFailure; storage = $storage; failure = $failure } | ConvertTo-Json -Depth 4 -Compress
`;

/** Why the storage query did not answer, in fields Windows never translates. */
export interface ShadowStorageFailure {
  id?: string;
  category?: string;
  native?: string;
  hresult?: number;
}

export interface ShadowStorageMeasurement {
  /** Whether this process runs as an administrator, as Windows itself answers; null when it could not be asked. */
  elevated: boolean | null;
  /** Volume GUID paths and their drive letters, so storage and copies can be scoped to one drive. */
  volumes: { deviceId: string; letter: string | null }[];
  /** The restore points Windows lists. Empty when none, or when the listing failed (see copiesKnown). */
  copies: { id: string; volume: string; takenAt: number | null }[];
  /** False when the listing itself failed: an empty `copies` then means "could not ask", never "none". */
  copiesKnown: boolean;
  /** The listing's refusal; null when it answered. */
  copiesFailure: ShadowStorageFailure | null;
  /**
   * One row per shadow storage association (a protected volume), with the
   * bytes it uses — null when that row's figure was not a number. The whole
   * field is null when the storage query did not answer.
   */
  storage: { volume: string; usedBytes: number | null }[] | null;
  /** The storage query's refusal; null when it answered. */
  failure: ShadowStorageFailure | null;
}

interface RawStorage {
  UsedSpace?: unknown;
  AllocatedSpace?: unknown;
  MaxSpace?: unknown;
  Volume?: unknown;
}

interface RawVolume {
  DeviceID?: unknown;
  DriveLetter?: unknown;
}

interface RawMeasurement {
  elevated?: unknown;
  volumes?: RawVolume | RawVolume[] | null;
  copies?: RawShadowCopy | RawShadowCopy[] | null;
  copiesFailure?: ShadowStorageFailure | null;
  storage?: RawStorage | RawStorage[] | null;
  failure?: ShadowStorageFailure | null;
}

const NO_OUTPUT: ShadowStorageFailure = { id: 'no-output', category: 'InvalidResult' };

function failureOf(value: unknown): ShadowStorageFailure | null {
  return value && typeof value === 'object' ? (value as ShadowStorageFailure) : null;
}

/**
 * A UInt64 arrives as a number, or — from some PowerShell versions — as a
 * string. Anything else is not a byte count. (Above 2^53 bytes, ~9 PB, the
 * number would already have lost precision inside JSON.parse; no real shadow
 * storage is within a thousandfold of that.)
 */
function bytesOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Map the script's JSON to a measurement. Pure and exported for tests.
 *
 * A sum with a hole in it is not a sum: one association whose UsedSpace is not
 * a number makes the total unknown rather than smaller. Output that is not the
 * script's object at all — empty, or a stray value — is "nothing reported",
 * never zero, and says nothing about elevation either (`elevated: null`).
 */
export function mapShadowStorage(raw: unknown): ShadowStorageMeasurement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { elevated: null, volumes: [], copies: [], copiesKnown: false, copiesFailure: NO_OUTPUT, storage: null, failure: NO_OUTPUT };
  }
  const r = raw as RawMeasurement;
  const elevated = r.elevated === true ? true : r.elevated === false ? false : null;
  const volumes = asArray(r.volumes)
    .filter((v): v is RawVolume & { DeviceID: string } => typeof v === 'object' && v !== null && typeof v.DeviceID === 'string' && v.DeviceID.length > 0)
    .map((v) => ({ deviceId: v.DeviceID, letter: typeof v.DriveLetter === 'string' && v.DriveLetter.length > 0 ? v.DriveLetter : null }));
  const copiesKnown = r.copies !== null && r.copies !== undefined;
  const copies = asArray(r.copies)
    .filter((c): c is RawShadowCopy & { ID: string } => typeof c === 'object' && c !== null && typeof c.ID === 'string' && c.ID.length > 0)
    .map((c) => ({ id: c.ID, volume: c.VolumeName ?? '', takenAt: parseInstallDate(c.InstallDate) }));
  const copiesFailure = copiesKnown ? null : failureOf(r.copiesFailure) ?? NO_OUTPUT;
  const failure = failureOf(r.failure);
  const storage =
    r.storage === null || r.storage === undefined
      ? null
      : asArray(r.storage).map((entry) => {
          const row = entry && typeof entry === 'object' ? entry : {};
          return { volume: typeof row.Volume === 'string' ? row.Volume : '', usedBytes: bytesOf(row.UsedSpace) };
        });
  return { elevated, volumes, copies, copiesKnown, copiesFailure, storage, failure };
}

/** Run the storage script; `run` is injectable so a test can stand in for PowerShell. */
export async function measureShadowStorage(run: (script: string, opts?: PowerShellOptions) => Promise<unknown> = runPowerShellJson): Promise<ShadowStorageMeasurement> {
  return mapShadowStorage(await run(STORAGE_SCRIPT, { timeoutMs: 30_000 }));
}
