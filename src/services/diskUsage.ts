import { execFile } from "child_process";
import path from "path";

/**
 * Disk capacity for the volume containing a path — shared by the /api/system
 * endpoint and the desktop tray (which shows free space in the menu bar).
 */

/** One mounted volume (Windows drive letter, or a Unix mount point). */
export interface VolumeInfo {
  /** Absolute mount root, e.g. `C:\` or `/`. */
  mount: string;
  /** Volume label when available. */
  name: string;
  total: number;
  free: number;
  /** Filesystem name when known (NTFS, FAT32, …). */
  fs: string;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 10_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

/** Parse `df -k <path>`: 1024-byte blocks; columns 2 and 4 are total/available. */
async function unixDiskUsage(
  target: string,
): Promise<{ total: number; free: number }> {
  const stdout = await exec("df", ["-k", target]);
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) throw new Error("Unexpected df output");
  // The data line can wrap when the device name is long — take the last line.
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available ... — find the first numeric run.
  const numbers = cols.filter((c) => /^\d+$/.test(c)).map(Number);
  if (numbers.length < 3) throw new Error("Unexpected df output");
  return { total: numbers[0] * 1024, free: numbers[2] * 1024 };
}

async function windowsDiskUsage(
  target: string,
): Promise<{ total: number; free: number }> {
  const drive = path.parse(path.resolve(target)).root.replace(/\\$/, ""); // "C:"
  const ps = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json`;
  const stdout = await exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    ps,
  ]);
  const parsed = JSON.parse(stdout) as { Size: number; FreeSpace: number };
  return {
    total: Number(parsed.Size) || 0,
    free: Number(parsed.FreeSpace) || 0,
  };
}

export async function diskUsage(
  target: string,
): Promise<{ total: number; free: number }> {
  return process.platform === "win32"
    ? windowsDiskUsage(target)
    : unixDiskUsage(target);
}

/**
 * List local volumes the user can scan. On Windows this is every fixed/
 * removable drive letter (so D:, E:, … show up beside C:). On Unix, a single
 * row for `/` plus the home volume when it differs — enough for the storage
 * list without parsing every mount.
 */
export async function listVolumes(): Promise<VolumeInfo[]> {
  if (process.platform === "win32") return listWindowsVolumes();
  return listUnixVolumes();
}

async function listWindowsVolumes(): Promise<VolumeInfo[]> {
  const ps =
    "Get-CimInstance Win32_LogicalDisk | " +
    "Where-Object { $_.DriveType -in 2,3 -and $_.Size -gt 0 } | " +
    "Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem | ConvertTo-Json -Compress";
  try {
    const stdout = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    const parsed = JSON.parse(stdout) as
      | Array<{
          DeviceID: string;
          VolumeName?: string;
          Size: number;
          FreeSpace: number;
          FileSystem?: string;
        }>
      | {
          DeviceID: string;
          VolumeName?: string;
          Size: number;
          FreeSpace: number;
          FileSystem?: string;
        };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r) => r && r.DeviceID)
      .map((r) => ({
        mount: r.DeviceID.endsWith("\\") ? r.DeviceID : `${r.DeviceID}\\`,
        name: (r.VolumeName || "").trim(),
        total: Number(r.Size) || 0,
        free: Number(r.FreeSpace) || 0,
        fs: (r.FileSystem || "").trim(),
      }))
      .sort((a, b) => a.mount.localeCompare(b.mount));
  } catch {
    return [];
  }
}

async function listUnixVolumes(): Promise<VolumeInfo[]> {
  const out: VolumeInfo[] = [];
  try {
    const root = await unixDiskUsage("/");
    out.push({
      mount: "/",
      name: "Root",
      total: root.total,
      free: root.free,
      fs: "",
    });
  } catch {
    /* ignore */
  }
  try {
    const home = process.env.HOME || "";
    if (home && home !== "/") {
      const usage = await unixDiskUsage(home);
      // Skip if it's the same volume as `/` (same total+free is a decent signal).
      if (
        !out.length ||
        out[0].total !== usage.total ||
        out[0].free !== usage.free
      ) {
        out.push({
          mount: home,
          name: "Home",
          total: usage.total,
          free: usage.free,
          fs: "",
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}
