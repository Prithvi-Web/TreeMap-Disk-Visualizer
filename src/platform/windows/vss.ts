import { runPowerShellJson, asArray } from './powershell';
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
  Select-Object ID, VolumeName, DeviceObject, InstallDate) |
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
 * version: a plain string, or a wrapper object. Anything that does not parse
 * becomes null rather than an invented date.
 */
export function parseInstallDate(value: RawShadowCopy['InstallDate']): number | null {
  const raw = typeof value === 'string' ? value : typeof value === 'object' && value ? value.value : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
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
