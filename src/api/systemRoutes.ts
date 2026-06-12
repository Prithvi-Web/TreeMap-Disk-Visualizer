import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { diskUsage } from '../services/diskUsage';
import { SystemInfo } from '../models/types';

export const systemRouter = Router();

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
