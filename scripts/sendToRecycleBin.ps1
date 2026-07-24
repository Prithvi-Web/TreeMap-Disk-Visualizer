# Send a file or directory to the Recycle Bin (FOF_ALLOWUNDO).
# Strategy:
#   1) SHFileOperation with IntPtr pFrom (string layout often returns 124)
#   2) Shell.Application Recycle Bin MoveHere (handles some 124 cases)
#   3) For directories: recycle top-level children individually, then the folder
# Locked files (GPU caches, etc.) surface as IN_USE instead of opaque 124.
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Path not found: $Path"
}

# Prefer .NET FullName over Resolve-Path (avoids PowerShell provider prefixes).
$full = (Get-Item -LiteralPath $Path).FullName

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TreemapRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    public IntPtr pFrom;
    public IntPtr pTo;
    public ushort fFlags;
    public int fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public IntPtr lpszProgressTitle;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHFileOperation(ref SHFILEOPSTRUCT fileOp);

  const uint FO_DELETE = 3;
  const ushort FOF_SILENT = 0x0004;
  const ushort FOF_NOCONFIRMATION = 0x0010;
  const ushort FOF_ALLOWUNDO = 0x0040;
  const ushort FOF_NOERRORUI = 0x0400;

  // Returns 0 on success, non-zero SHFileOperation code otherwise.
  public static int TrySendToRecycleBin(string path) {
    IntPtr pFrom = Marshal.StringToHGlobalUni(path + "\0");
    try {
      var op = new SHFILEOPSTRUCT {
        hwnd = IntPtr.Zero,
        wFunc = FO_DELETE,
        pFrom = pFrom,
        pTo = IntPtr.Zero,
        fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI),
        fAnyOperationsAborted = 0,
        hNameMappings = IntPtr.Zero,
        lpszProgressTitle = IntPtr.Zero,
      };
      int rc = SHFileOperation(ref op);
      if (rc != 0) return rc;
      if (op.fAnyOperationsAborted != 0) return -1;
      return 0;
    } finally {
      Marshal.FreeHGlobal(pFrom);
    }
  }
}
'@

function Test-StillExists([string]$p) {
  return (Test-Path -LiteralPath $p)
}

function Invoke-ShRecycle([string]$p) {
  return [TreemapRecycle]::TrySendToRecycleBin($p)
}

function Invoke-ComRecycle([string]$p) {
  # Flags: 4=no progress, 16=Yes to All, 64=preserve undo, 1024=no error UI
  $flags = 4 + 16 + 64 + 1024
  $shell = New-Object -ComObject Shell.Application
  $bin = $shell.NameSpace(0xa)
  if ($null -eq $bin) { throw "Could not open Recycle Bin namespace" }
  $bin.MoveHere($p, $flags)
  # MoveHere is async-ish; give the shell a moment on large folders.
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ((Test-StillExists $p) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

function Invoke-ChildRecycle([string]$dir) {
  $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
  $failed = 0
  foreach ($child in $children) {
    $cp = $child.FullName
    $rc = Invoke-ShRecycle $cp
    if ((Test-StillExists $cp) -and $rc -ne 0) {
      try { Invoke-ComRecycle $cp } catch { }
    }
    if (Test-StillExists $cp) { $failed++ }
  }
  # Drop the folder if empty (or try recycling the remainder).
  if (-not (Test-StillExists $dir)) { return 0 }
  $left = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
  if ($left.Count -eq 0) {
    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    return 0
  }
  $rc = Invoke-ShRecycle $dir
  if (-not (Test-StillExists $dir)) { return 0 }
  try { Invoke-ComRecycle $dir } catch { }
  if (-not (Test-StillExists $dir)) { return 0 }
  return $failed
}

$shCode = Invoke-ShRecycle $full
if (-not (Test-StillExists $full)) { exit 0 }

# SH often returns 124 (DE_INVALIDFILES) for locked/busy trees; try COM next.
try { Invoke-ComRecycle $full } catch { }
if (-not (Test-StillExists $full)) { exit 0 }

$isDir = (Get-Item -LiteralPath $full -Force).PSIsContainer
if ($isDir) {
  $childFails = Invoke-ChildRecycle $full
  if (-not (Test-StillExists $full)) { exit 0 }
  throw "IN_USE: some files are locked by another program (close apps using this folder, e.g. NVIDIA/GPU, and try again). Remaining locked items: $childFails. SH code was $shCode."
}

if ($shCode -ne 0) {
  throw "IN_USE: file is locked by another program (close the app using it and try again). SHFileOperation code $shCode."
}

throw "IN_USE: path still exists after Recycle Bin move (locked or denied): $full"
