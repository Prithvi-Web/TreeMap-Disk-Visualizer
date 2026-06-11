import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { SystemInfo } from '../models/types';

export const systemRouter = Router();

/* ---------------- Disk capacity (df / PowerShell, parsed cleanly) ---------------- */

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

async function diskUsage(target: string): Promise<{ total: number; free: number }> {
  return process.platform === 'win32' ? windowsDiskUsage(target) : unixDiskUsage(target);
}

/* ------------------------------ Routes ------------------------------ */

/** GET /api/system -> platform, hostname, disk totals, suggested folders. */
systemRouter.get('/system', async (_req: Request, res: Response) => {
  const homeDir = os.homedir();
  const { total, free } = await diskUsage(homeDir);

  const candidates = [
    homeDir,
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'Pictures'),
    path.join(homeDir, 'Music'),
    path.join(homeDir, process.platform === 'darwin' ? 'Movies' : 'Videos'),
  ];
  const commonDirs: string[] = [];
  for (const dir of candidates) {
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory()) commonDirs.push(dir);
    } catch {
      /* missing on this machine — skip */
    }
  }

  const info: SystemInfo = {
    platform: process.platform,
    hostname: os.hostname(),
    totalDisk: total,
    freeDisk: free,
    homeDir,
    commonDirs,
  };
  res.json(info);
});

/**
 * GET /api/fs/list?path=<dir>
 * Subdirectories of a folder — powers the Browse picker in the UI.
 * Defaults to the home directory when no path is given.
 */
systemRouter.get('/fs/list', guardQueryPath('path'), async (req: Request, res: Response) => {
  const target = (req.query.path as string | undefined) ?? os.homedir();

  const stat = await fsp.stat(target); // ENOENT/EACCES -> errorHandler
  if (!stat.isDirectory()) {
    throw new AppError(400, 'NOT_A_DIRECTORY', 'Path is not a directory');
  }

  const entries = await fsp.readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .slice(0, 500)
    .map((e) => ({
      name: e.name,
      path: path.join(target, e.name),
      isHidden: e.name.startsWith('.'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(target);
  res.json({
    path: target,
    parent: parent === target ? null : parent,
    dirs,
  });
});
