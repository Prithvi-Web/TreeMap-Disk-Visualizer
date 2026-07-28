import { runPowerShellJson, asArray } from './powershell';
import type { PlaceholderInfo } from '../types';

/**
 * Placeholder, sparse and compressed-file accounting on Windows (A3, A2).
 *
 * ── Why this can't be done from Node alone ──
 *
 * On macOS and Linux, `lstat().blocks` gives the bytes a file really occupies,
 * so sparse files and evicted cloud placeholders size themselves correctly with
 * no extra work. **On Windows libuv leaves `blocks` at 0**, and `size` is
 * always the logical size — a OneDrive Files On-Demand placeholder claiming
 * 4.2 GB while occupying nothing looks identical to a real 4.2 GB file. That is
 * the exact mis-sizing A3 exists to fix, and it cannot be seen from `fs.stat`.
 *
 * So Windows needs two things NTFS knows and Node does not surface:
 *
 *   - **File attributes** — `OFFLINE` (0x1000), `RECALL_ON_OPEN` (0x40000) and
 *     `RECALL_ON_DATA_ACCESS` (0x400000) are precisely the cloud-placeholder
 *     flags; `SPARSE_FILE` (0x200) and `COMPRESSED` (0x800) explain the rest.
 *   - **`GetCompressedFileSize`** — the actual allocated size, which is what
 *     A2 asks be reported for compressed and sparse files instead of the
 *     logical size.
 *
 * ── Batched on purpose ──
 *
 * One PowerShell invocation costs ~200 ms in startup alone, so a per-file call
 * would make a folder of 5,000 files unusable. Everything here takes an array
 * and issues exactly one call, mirroring the batching rule B2 imposes on the
 * open-handle guard.
 *
 * ⚠ **Not executed on Windows by the author** (written on macOS). The bit
 * arithmetic and the JSON mapping are pure and unit-tested here; the live
 * round-trip runs in CI on `windows-latest`.
 */

/* NTFS file attribute bits, from the Win32 documentation. */
export const FILE_ATTRIBUTE = {
  SPARSE_FILE: 0x0000_0200,
  REPARSE_POINT: 0x0000_0400,
  COMPRESSED: 0x0000_0800,
  OFFLINE: 0x0000_1000,
  RECALL_ON_OPEN: 0x0004_0000,
  RECALL_ON_DATA_ACCESS: 0x0040_0000,
} as const;

const ATTRIBUTES_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace TreeMap -Name Fs -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);
'@

$targets = @()
if ($env:TREEMAP_PATHS) {
  $targets = @($env:TREEMAP_PATHS -split ([char]10) | Where-Object { $_.Trim() -ne '' })
}

$out = @()
foreach ($t in $targets) {
  $item = Get-Item -LiteralPath $t -Force
  if (-not $item) { continue }
  $high = [uint32]0
  $low  = [TreeMap.Fs]::GetCompressedFileSizeW($t, [ref]$high)
  # 0xFFFFFFFF is the documented failure sentinel; treat it as "unknown".
  $alloc = $null
  if ($low -ne 4294967295) { $alloc = ([double]$high * 4294967296) + [double]$low }
  $out += [pscustomobject]@{
    path       = $t
    length     = $(if ($item.PSIsContainer) { $null } else { $item.Length })
    attributes = [int]$item.Attributes
    allocated  = $alloc
  }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

export interface WindowsFileFacts {
  path: string;
  /** Logical size in bytes; null for directories. */
  length: number | null;
  /** Raw FILE_ATTRIBUTE_* bitmask. */
  attributes: number;
  /** Bytes actually allocated, from GetCompressedFileSize; null when unknown. */
  allocated: number | null;
}

interface RawFacts {
  path?: string;
  length?: number | null;
  attributes?: number;
  allocated?: number | null;
}

/** Does this attribute mask mark a cloud placeholder? Pure — the core of A3. */
export function isCloudPlaceholder(attributes: number): boolean {
  return (
    (attributes & FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS) !== 0 ||
    (attributes & FILE_ATTRIBUTE.RECALL_ON_OPEN) !== 0 ||
    (attributes & FILE_ATTRIBUTE.OFFLINE) !== 0
  );
}

export function isSparse(attributes: number): boolean {
  return (attributes & FILE_ATTRIBUTE.SPARSE_FILE) !== 0;
}

export function isCompressed(attributes: number): boolean {
  return (attributes & FILE_ATTRIBUTE.COMPRESSED) !== 0;
}

/** Normalise the script's JSON. Pure, so the whole mapping is testable. */
export function mapFileFacts(raw: unknown): WindowsFileFacts[] {
  return asArray(raw as RawFacts | RawFacts[])
    .filter((r): r is RawFacts & { path: string } => typeof r.path === 'string')
    .map((r) => ({
      path: r.path,
      length: typeof r.length === 'number' ? r.length : null,
      attributes: typeof r.attributes === 'number' ? r.attributes : 0,
      allocated: typeof r.allocated === 'number' ? r.allocated : null,
    }));
}

/**
 * Turn one file's facts into a PlaceholderInfo, or null when it is an ordinary
 * fully-resident file.
 *
 * A merely *sparse* file (a VM disk, a database) is deliberately not reported
 * as a cloud placeholder — only the recall/offline attributes mean that. Its
 * size is still corrected by `allocated`, it just isn't mislabelled as cloud.
 */
export function toPlaceholderInfo(facts: WindowsFileFacts): PlaceholderInfo | null {
  const logicalSize = facts.length ?? 0;
  const cloud = isCloudPlaceholder(facts.attributes);
  const localSize = facts.allocated ?? (cloud ? 0 : logicalSize);

  if (!cloud && localSize >= logicalSize) return null;

  return {
    logicalSize,
    localSize,
    provider: providerForPath(facts.path),
    evicted: cloud && localSize === 0,
    mechanism: cloud
      ? 'cloud reparse attributes (RECALL_ON_DATA_ACCESS / OFFLINE)'
      : isCompressed(facts.attributes)
        ? 'GetCompressedFileSize (NTFS compression)'
        : 'GetCompressedFileSize (sparse file)',
  };
}

/** Which sync client owns a path, inferred from its location. */
export function providerForPath(p: string): PlaceholderInfo['provider'] {
  if (/\\OneDrive/i.test(p)) return 'onedrive';
  if (/\\Dropbox/i.test(p)) return 'dropbox';
  if (/\\Google Drive|\\GoogleDrive/i.test(p)) return 'gdrive';
  if (/\\iCloudDrive/i.test(p)) return 'icloud';
  return 'unknown';
}

/** One PowerShell call for a whole batch of paths. */
export async function fileFactsBatch(paths: string[]): Promise<Map<string, WindowsFileFacts>> {
  if (paths.length === 0) return new Map();
  try {
    const raw = await runPowerShellJson<unknown>(ATTRIBUTES_SCRIPT, {
      timeoutMs: 60_000,
      env: { TREEMAP_PATHS: paths.join('\n') },
    });
    return new Map(mapFileFacts(raw).map((f) => [f.path, f]));
  } catch {
    return new Map(); // no information is honest; a wrong size is not
  }
}
