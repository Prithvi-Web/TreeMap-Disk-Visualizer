import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { idempotency } from '../middleware/idempotency';
import { findDeleted, restoreFromSnapshot } from '../services/snapshotRecovery';
import { appendAudit, tokenIdFor } from '../services/audit';
import { diskUsage } from '../services/diskUsage';
import { listVolumes, volumesUnavailableReason } from '../services/volumes';
import { getTrashInfo, emptyTrash } from '../services/trash';
import { getSnapshotAccounting, purgeSnapshots } from '../services/snapshotAccounting';
import { SystemInfo } from '../models/types';

export const systemRouter = Router();

/* ------------------------------ Routes ------------------------------ */

/** GET /api/system -> platform, hostname, disk totals, suggested folders. */
systemRouter.get('/system', async (_req: Request, res: Response) => {
  const homeDir = os.homedir();
  const { total, free, used } = await diskUsage(homeDir);

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
    usedDisk: used,
    homeDir,
    commonDirs,
  };
  res.json(info);
});

/**
 * GET /api/volumes -> { volumes: [{ name, path, freeBytes, totalBytes }] }
 * Attached external drives for the offload dock (§8.3), sorted by name. A
 * drive whose capacity cannot be read still appears — nulls plus a reason —
 * so the dock shows the drive honestly rather than hiding it.
 */
systemRouter.get('/volumes', async (_req: Request, res: Response) => {
  const reason = volumesUnavailableReason();
  res.json({ volumes: await listVolumes(), ...(reason ? { reason } : {}) });
});

/** GET /api/trash/size -> { totalBytes, itemCount, paths, items } across all trash locations. */
systemRouter.get('/trash/size', async (_req: Request, res: Response) => {
  res.json(await getTrashInfo());
});

/**
 * POST /api/trash/empty { confirm:true } -> empty the system Trash / Recycle
 * Bin. Irreversible, so it demands the same explicit confirm flag as the
 * snapshot purge — the UI additionally gates it behind a confirm dialog.
 */
systemRouter.post('/trash/empty', idempotency, async (req: Request, res: Response) => {
  const { confirm } = req.body as { confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Pass { confirm: true } to empty the Trash');
  }
  const result = await emptyTrash();
  await appendAudit({ action: 'trash.empty', source: 'http', tokenId: tokenIdFor('http'), paths: [], bytes: null, dryRun: false, outcome: 'ok' });
  res.json(result);
});

/** GET /api/system/snapshots -> OS snapshot accounting (APFS/Btrfs/VSS), best-effort. */
systemRouter.get('/system/snapshots', async (_req: Request, res: Response) => {
  res.json(await getSnapshotAccounting());
});

/** POST /api/system/snapshots/purge { confirm:true } -> delete local snapshots (macOS). */
systemRouter.post('/system/snapshots/purge', idempotency, async (req: Request, res: Response) => {
  const { confirm } = req.body as { confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(400, 'CONFIRM_REQUIRED', 'Pass { confirm: true } to purge local snapshots');
  }
  const result = await purgeSnapshots();
  await appendAudit({ action: 'snapshots.purge', source: 'http', tokenId: tokenIdFor('http'), paths: [], bytes: null, dryRun: false, outcome: 'ok' });
  res.json(result);
});

/**
 * GET /api/system/snapshots/find-deleted?path= — which snapshots could still
 * hold a path the user has lost (B4).
 *
 * ── Why not `/api/snapshots/find-deleted`, which §B4 names? ──
 *
 * `/api/snapshots` is already TreeMap's *scan history* — the snapshots Trends
 * charts and Compare diffs. These are *filesystem* snapshots, an unrelated
 * thing that happens to share a word, and they already have a home at
 * `/api/system/snapshots`. Putting a filesystem-snapshot operation inside the
 * scan-history namespace would leave two meanings of "snapshot" under one path.
 * The same resolution as `/api/platform/capabilities` in A5; recorded in
 * docs/PLATFORM_NOTES.md.
 *
 * Costs nothing and asks for nothing: listing snapshots is unprivileged on all
 * three platforms, so the user always learns what might be recoverable before
 * being asked for a password.
 */
systemRouter.get('/system/snapshots/find-deleted', guardQueryPath('path'), async (req: Request, res: Response) => {
  const target = req.query.path as string | undefined;
  if (!target) throw new AppError(400, 'PATH_REQUIRED', 'Give the path you are looking for');
  res.json(await findDeleted(target));
});

/**
 * POST /api/system/snapshots/restore { path, destination?, overwrite? }
 *
 * Writes the recovered copy *beside* the original by default, never over it:
 * a file from a three-week-old snapshot is older than whatever holds that path
 * now, so overwriting by default would replace newer work with older.
 *
 * On macOS and Windows this is the one call that asks for an administrator
 * password, at the moment it is invoked (§3.8). A dismissed prompt comes back
 * as `AUTHORIZATION_DECLINED` — an answer, not a fault.
 */
systemRouter.post('/system/snapshots/restore', idempotency, async (req: Request, res: Response) => {
  const body = req.body as { path?: unknown; destination?: unknown; overwrite?: unknown };
  if (typeof body.path !== 'string' || !body.path.trim()) {
    throw new AppError(400, 'PATH_REQUIRED', 'Give the path you want back');
  }
  try {
    const outcome = await restoreFromSnapshot({
      path: body.path,
      ...(typeof body.destination === 'string' && body.destination.trim() ? { destination: body.destination } : {}),
      overwrite: body.overwrite === true,
    });
    await appendAudit({
      action: 'snapshots.restore', source: 'http', tokenId: tokenIdFor('http'),
      paths: [outcome.restoredTo], bytes: outcome.sizeBytes, dryRun: false, outcome: 'ok',
    });
    res.json(outcome);
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({
        action: 'snapshots.restore', source: 'http', tokenId: tokenIdFor('http'),
        paths: [String(body.path)], bytes: null, dryRun: false, outcome: 'refused', code: err.code,
      });
    }
    throw err;
  }
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
