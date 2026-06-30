import { Router, Request, Response } from 'express';
import path from 'path';
import { listInstalledApps, findLeftovers, appRoots } from '../services/apps';
import { brewAvailable, outdatedCasks, upgradeCask } from '../services/updater';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';

/**
 * appRoutes — the macOS "Applications" category: Uninstaller (/api/apps*) and
 * Updater (/api/updater*).
 *
 * Uninstaller never introduces a new delete path: `GET /api/apps/leftovers`
 * runs `findLeftovers`, which `startScan`s the bundle + each leftover (so the
 * existing `DELETE /api/files` authorizes them), then the frontend trashes via
 * that same endpoint. The endpoint additionally pins the target to a top-level
 * *.app inside /Applications or ~/Applications, so /System apps can't be reached.
 */

export const appRouter = Router();

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'The Applications tools are only available on macOS');
  }
}

/** GET /api/apps — installed apps ([] on non-macOS). */
appRouter.get('/apps', async (_req: Request, res: Response) => {
  res.json({ apps: await listInstalledApps() });
});

/**
 * GET /api/apps/leftovers?path=<.app>
 * Analyze one app for uninstall. The path is sanitized by guardQueryPath, then
 * pinned to a top-level bundle directly inside a known app root.
 */
appRouter.get(
  '/apps/leftovers',
  guardQueryPath('path'),
  async (req: Request, res: Response) => {
    requireMac();
    const target = req.query.path;
    if (typeof target !== 'string') {
      throw new AppError(400, 'PATH_REQUIRED', 'A "path" query parameter is required');
    }
    const isTopLevelApp =
      target.toLowerCase().endsWith('.app') && appRoots().includes(path.dirname(target));
    if (!isTopLevelApp) {
      throw new AppError(
        400,
        'INVALID_APP_PATH',
        'Path must be an application directly inside /Applications or ~/Applications'
      );
    }
    res.json(await findLeftovers(target));
  }
);

/** GET /api/updater — outdated Homebrew casks ({available:false} if no brew). */
appRouter.get('/updater', async (_req: Request, res: Response) => {
  if (process.platform !== 'darwin' || !(await brewAvailable())) {
    res.json({ available: false, casks: [] });
    return;
  }
  res.json({ available: true, casks: await outdatedCasks() });
});

/** POST /api/updater/upgrade { token } — `brew upgrade --cask <token>`. */
appRouter.post('/updater/upgrade', async (req: Request, res: Response) => {
  requireMac();
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !/^[a-z0-9][a-z0-9@+._-]*$/i.test(token)) {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid Homebrew cask token');
  }
  res.json(await upgradeCask(token));
});
