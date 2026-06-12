import { execFile } from 'child_process';
import path from 'path';

/**
 * Disk capacity for the volume containing a path — shared by the /api/system
 * endpoint and the desktop tray (which shows free space in the menu bar).
 */

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Parse `df -k <path>`: 1024-byte blocks; columns 2 and 4 are total/available. */
async function unixDiskUsage(target: string): Promise<{ total: number; free: number }> {
  const stdout = await exec('df', ['-k', target]);
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) throw new Error('Unexpected df output');
  // The data line can wrap when the device name is long — take the last line.
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available ... — find the first numeric run.
  const numbers = cols.filter((c) => /^\d+$/.test(c)).map(Number);
  if (numbers.length < 3) throw new Error('Unexpected df output');
  return { total: numbers[0] * 1024, free: numbers[2] * 1024 };
}

async function windowsDiskUsage(target: string): Promise<{ total: number; free: number }> {
  const drive = path.parse(path.resolve(target)).root.replace(/\\$/, ''); // "C:"
  const ps = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json`;
  const stdout = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const parsed = JSON.parse(stdout) as { Size: number; FreeSpace: number };
  return { total: Number(parsed.Size) || 0, free: Number(parsed.FreeSpace) || 0 };
}

export async function diskUsage(target: string): Promise<{ total: number; free: number }> {
  return process.platform === 'win32' ? windowsDiskUsage(target) : unixDiskUsage(target);
}
