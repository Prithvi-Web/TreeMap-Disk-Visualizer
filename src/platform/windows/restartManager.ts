import { promises as fsp } from 'fs';
import path from 'path';
import { runPowerShellJson, asArray } from './powershell';
import type { OpenHandleInfo } from '../types';

/**
 * Open-file detection on Windows (B2) via the Restart Manager API.
 *
 * Mechanism choice (§2.3): this is genuinely tier 1 — the real
 * `RmStartSession` / `RmRegisterResources` / `RmGetList` sequence B2 specifies,
 * the same API Windows Installer uses to ask "what do I need to close?". It is
 * reached by having PowerShell `Add-Type` the P/Invoke signatures, which avoids
 * both a native addon TreeMap would have to prebuild and a bundled
 * `handle.exe`. **No elevation is required** — Restart Manager reports the
 * caller's own session — which satisfies §3.8's rule that nothing demands
 * admin rights that can be done without them.
 *
 * Batch-aware by construction (§B2): `RmRegisterResources` takes the whole path
 * array in one call, so a 10,000-file delete is one session, not ten thousand.
 *
 * ── Notes on the parts that are easy to get wrong ──
 *
 * - `RmGetList` is called **twice**: once to learn how many entries there are
 *   (it returns ERROR_MORE_DATA, 234, with the count), then again with a
 *   correctly-sized buffer. Skipping the first call is the classic bug and
 *   silently truncates the answer.
 * - `RM_PROCESS_INFO` must be marshalled with the exact field layout and
 *   `CharSet.Unicode`, or the process names come back as mojibake.
 * - The session is closed in a `finally`, since a leaked Restart Manager
 *   session persists beyond the process.
 *
 * ⚠ **Not executed on Windows by the author.** This was written on macOS
 * against Microsoft's documented API. The pure parts — argument marshalling
 * into the script, and mapping its JSON to OpenHandleInfo — are unit-tested
 * here; the round-trip against a real locked file runs in CI on
 * `windows-latest` (see .github/workflows/test.yml). Recorded in
 * docs/PLATFORM_NOTES.md.
 */

/**
 * The PowerShell program. Kept as one constant so it can be asserted in tests
 * and reviewed as a whole rather than assembled from fragments.
 *
 * Paths arrive through `$env:TREEMAP_PATHS` as a newline-separated list, so no
 * path is ever interpolated into script text.
 */
export const RM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace TreeMap -Name Rm -UsingNamespace System.Runtime.InteropServices -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RM_PROCESS_INFO {
  public RM_UNIQUE_PROCESS Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]  public string strServiceShortName;
  public int ApplicationType;
  public uint AppStatus;
  public uint TSSessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
}

[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

[DllImport("rstrtmgr.dll")]
public static extern int RmEndSession(uint pSessionHandle);

[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
  uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);

[DllImport("rstrtmgr.dll")]
public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
  [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
'@

# Split on LF by character code: no backtick escape to get wrong, and no path
# is ever interpolated into this script's text.
$targets = @()
if ($env:TREEMAP_PATHS) {
  $targets = @($env:TREEMAP_PATHS -split ([char]10) | Where-Object { $_.Trim() -ne '' })
}
if ($targets.Count -eq 0) { '[]'; exit 0 }

$session = [uint32]0
$key = [Guid]::NewGuid().ToString()
$rc = [TreeMap.Rm]::RmStartSession([ref]$session, 0, $key)
if ($rc -ne 0) { '[]'; exit 0 }

try {
  $rc = [TreeMap.Rm]::RmRegisterResources($session, [uint32]$targets.Count, $targets, 0, [IntPtr]::Zero, 0, $null)
  if ($rc -ne 0) { '[]'; exit 0 }

  # First call learns the count (returns ERROR_MORE_DATA = 234).
  $needed = [uint32]0
  $count  = [uint32]0
  $reasons = [uint32]0
  $rc = [TreeMap.Rm]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reasons)
  if ($needed -eq 0) { '[]'; exit 0 }

  $count = $needed
  $infos = [Array]::CreateInstance([TreeMap.Rm+RM_PROCESS_INFO], [int]$needed)
  $rc = [TreeMap.Rm]::RmGetList($session, [ref]$needed, [ref]$count, $infos, [ref]$reasons)
  if ($rc -ne 0) { '[]'; exit 0 }

  $out = @()
  for ($i = 0; $i -lt $count; $i++) {
    $out += [pscustomobject]@{
      pid  = $infos[$i].Process.dwProcessId
      name = $infos[$i].strAppName
    }
  }
  $out | ConvertTo-Json -Compress -Depth 3
} finally {
  [void][TreeMap.Rm]::RmEndSession($session)
}
`;

interface RmEntry {
  pid?: number;
  name?: string;
}

/**
 * Map the script's JSON to OpenHandleInfo.
 *
 * Restart Manager answers "which applications hold *any* of these resources",
 * not which application holds which file — so every reported process is
 * attributed to the whole batch. For a single-path check (the common UI case:
 * "Chrome has this file open") that is exactly right. For a batch it is
 * honestly broader, and the confirmation dialog says "one or more of the
 * selected files" rather than naming a specific one it cannot know.
 *
 * Pure and exported so this contract is testable without Windows.
 */
export function mapRestartManagerOutput(raw: unknown, paths: string[]): OpenHandleInfo[] {
  const entries = asArray(raw as RmEntry | RmEntry[]);
  const representative = paths[0] ?? '';
  const seen = new Set<number>();
  const out: OpenHandleInfo[] = [];

  for (const entry of entries) {
    const pid = typeof entry.pid === 'number' ? entry.pid : null;
    if (pid === null || pid === 0) continue;
    // Our own process holding a handle is not a conflict worth warning about.
    if (pid === process.pid) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push({
      path: representative,
      pid,
      processName: (entry.name ?? '').trim() || `process ${String(pid)}`,
    });
  }
  return out;
}

/**
 * Ceiling on files registered with Restart Manager for one check.
 *
 * Registering a resource is not free, and a delete set can name a folder
 * holding a hundred thousand files. The cap keeps the check bounded; when it
 * bites, `expandForRegistration` says so rather than letting a partial answer
 * pass for a complete one.
 */
export const RM_MAX_RESOURCES = 2000;

/**
 * Turn the delete set into the file list Restart Manager needs.
 *
 * Unlike `lsof` and `/proc`, Restart Manager has no "list everything open"
 * mode — it answers only about resources explicitly registered. So the
 * descendant coverage those platforms get for free (a file open *inside* a
 * folder being trashed) has to be produced here, by walking the folders.
 *
 * `complete: false` means the walk hit the cap or could not read part of the
 * tree, so a clean result means "nothing found among what we could register",
 * not "nothing is open". The service turns that into an honest partial state
 * instead of a false all-clear.
 *
 * Exported and dependency-free (plain `fs`), so the walk is unit-tested on any
 * OS even though it only runs on Windows.
 */
export async function expandForRegistration(
  paths: string[],
  max = RM_MAX_RESOURCES,
): Promise<{ files: string[]; complete: boolean }> {
  const files: string[] = [];
  let complete = true;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= max) { complete = false; return; }
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      complete = false; // unreadable subtree — cannot claim it is clear
      return;
    }
    for (const entry of entries) {
      if (files.length >= max) { complete = false; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };

  for (const p of paths) {
    if (files.length >= max) { complete = false; break; }
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue; // already gone; nothing can hold it open
    }
    if (st.isDirectory()) await walk(p);
    else files.push(p);
  }
  return { files, complete };
}

export async function openHandlesFor(paths: string[]): Promise<OpenHandleInfo[]> {
  if (paths.length === 0) return [];
  const { files } = await expandForRegistration(paths);
  if (files.length === 0) return [];
  try {
    const raw = await runPowerShellJson<unknown>(RM_SCRIPT, {
      timeoutMs: 30_000,
      env: { TREEMAP_PATHS: files.join('\n') },
    });
    return mapRestartManagerOutput(raw, paths);
  } catch {
    // A failure here must not block a delete; it degrades to "no information",
    // which the capability state already tells the user about.
    return [];
  }
}
