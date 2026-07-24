# Send a file or directory to the Recycle Bin via SHFileOperation (FOF_ALLOWUNDO).
# Used instead of Microsoft.VisualBasic.FileIO.FileSystem::Delete*, which is
# unreliable from non-interactive PowerShell (Node spawns with -NonInteractive
# + windowsHide) and surfaces "The system call level is not correct".
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Path not found: $Path"
}

$full = (Resolve-Path -LiteralPath $Path).Path

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TreemapRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    public string pFrom;
    public string pTo;
    public ushort fFlags;
    public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public string lpszProgressTitle;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHFileOperation(ref SHFILEOPSTRUCT fileOp);

  const uint FO_DELETE = 3;
  const ushort FOF_SILENT = 0x0004;
  const ushort FOF_NOCONFIRMATION = 0x0010;
  const ushort FOF_ALLOWUNDO = 0x0040;
  const ushort FOF_NOERRORUI = 0x0400;

  public static void SendToRecycleBin(string path) {
    // pFrom must be double-null-terminated.
    var op = new SHFILEOPSTRUCT {
      wFunc = FO_DELETE,
      pFrom = path + "\0\0",
      fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI),
    };
    int rc = SHFileOperation(ref op);
    if (rc != 0) {
      throw new Exception("SHFileOperation failed with code " + rc);
    }
    if (op.fAnyOperationsAborted) {
      throw new Exception("SHFileOperation aborted");
    }
  }
}
'@

[TreemapRecycle]::SendToRecycleBin($full)
