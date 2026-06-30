import { Router, Request, Response } from 'express';
import path from 'path';
import { listInstalledApps, findLeftovers, appRoots } from '../services/apps';
import {
  brewAvailable, masAvailable, upgradeMas, openApp, appUpdates, upgradeCaskAdopt, upgradeCaskInTerminal,
} from '../services/updater';
import { guardQueryPath } from '../middleware/pathGuard';
import { isInside } from '../utils/pathSanitizer';
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

/**
 * GET /api/updater — every installed app, each tagged with an available update
 * detected from Homebrew's cask catalog, the Mac App Store (mas), or Sparkle.
 */
appRouter.get('/updater', async (_req: Request, res: Response) => {
  if (process.platform !== 'darwin') {
    res.json({ brewAvailable: false, masAvailable: false, apps: [] });
    return;
  }
  const [hasBrew, hasMas, apps] = await Promise.all([brewAvailable(), masAvailable(), appUpdates()]);
  res.json({ brewAvailable: hasBrew, masAvailable: hasMas, apps });
});

/** POST /api/updater/cask-upgrade { token } — `brew install --cask --adopt --force <token>`. */
appRouter.post('/updater/cask-upgrade', async (req: Request, res: Response) => {
  requireMac();
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !/^[a-z0-9][a-z0-9@+._-]*$/i.test(token)) {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid Homebrew cask token');
  }
  res.json(await upgradeCaskAdopt(token));
});

/** POST /api/updater/cask-terminal { token } — finish a sudo-needing cask update in Terminal. */
appRouter.post('/updater/cask-terminal', async (req: Request, res: Response) => {
  requireMac();
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !/^[a-z0-9][a-z0-9@+._-]*$/i.test(token)) {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid Homebrew cask token');
  }
  await upgradeCaskInTerminal(token);
  res.json({ opened: true });
});

/** POST /api/updater/mas-upgrade { id } — `mas upgrade <id>`. */
appRouter.post('/updater/mas-upgrade', async (req: Request, res: Response) => {
  requireMac();
  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw new AppError(400, 'INVALID_ID', 'Invalid App Store id');
  }
  res.json(await upgradeMas(id));
});

/** POST /api/updater/open { path } — launch a .app so it runs its own updater. */
appRouter.post('/updater/open', async (req: Request, res: Response) => {
  requireMac();
  const raw = (req.body as { path?: unknown } | undefined)?.path;
  if (typeof raw !== 'string' || !raw.endsWith('.app')) {
    throw new AppError(400, 'INVALID_PATH', 'Path must be an app bundle');
  }
  const inAppsDir = appRoots().some((root) => isInside(root, raw));
  if (!inAppsDir) {
    throw new AppError(403, 'OUTSIDE_APPS', 'Only apps in /Applications can be opened here');
  }
  await openApp(raw);
  res.json({ opened: true });
});
