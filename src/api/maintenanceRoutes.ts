import { Router, Request, Response } from 'express';
import { runMaintenance, listLoginItems, setLoginItemEnabled, getAppIconPng } from '../services/maintenance';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';

/**
 * maintenanceRoutes — the macOS "Maintenance" (Speed) tool: a few safe, no-sudo
 * upkeep actions plus user login-item management. No new delete path; nothing
 * destructive. macOS only.
 */

export const maintenanceRouter = Router();

const RUN_ACTIONS = new Set(['flush-dns', 'rebuild-launchservices']);

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Maintenance is only available on macOS');
  }
}

function isAutomationDenied(msg: string): boolean {
  return /-1743|not authori|not allowed to send/i.test(msg);
}

/** POST /api/maintenance/run { action } → { id, ok, message } */
maintenanceRouter.post('/maintenance/run', async (req: Request, res: Response) => {
  requireMac();
  const action = String((req.body as { action?: unknown })?.action ?? '');
  if (!RUN_ACTIONS.has(action)) {
    throw new AppError(400, 'UNKNOWN_ACTION', `Unknown maintenance action "${action}"`);
  }
  res.json(await runMaintenance(action));
});

/** GET /api/maintenance/app-icon?path=<app.app> → image/png (404 if none). */
maintenanceRouter.get('/maintenance/app-icon', guardQueryPath('path'), async (req: Request, res: Response) => {
  const appPath = req.query.path as string | undefined;
  if (!appPath) { res.status(400).end(); return; }
  try {
    const png = await getAppIconPng(appPath);
    res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
  } catch {
    res.status(404).end(); // frontend falls back to a letter tile
  }
});

/** GET /api/maintenance/login-items → { items } */
maintenanceRouter.get('/maintenance/login-items', async (_req: Request, res: Response) => {
  requireMac();
  try {
    res.json({ items: await listLoginItems() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAutomationDenied(msg)) {
      throw new AppError(
        403,
        'AUTOMATION_DENIED',
        'TreeMap needs permission to control System Events. Allow it in System Settings → Privacy & Security → Automation.'
      );
    }
    throw new AppError(500, 'LOGIN_ITEMS_FAILED', msg);
  }
});

/** POST /api/maintenance/login-items { name, path, enabled } → { ok } */
maintenanceRouter.post('/maintenance/login-items', async (req: Request, res: Response) => {
  requireMac();
  const { name, path, enabled } = (req.body ?? {}) as { name?: string; path?: string; enabled?: boolean };
  if (!name || !path) {
    throw new AppError(400, 'LOGIN_ITEM_INVALID', 'name and path are required');
  }
  try {
    await setLoginItemEnabled(name, path, enabled !== false);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAutomationDenied(msg)) {
      throw new AppError(
        403,
        'AUTOMATION_DENIED',
        'TreeMap needs permission to control System Events. Allow it in System Settings → Privacy & Security → Automation.'
      );
    }
    throw new AppError(500, 'LOGIN_ITEM_FAILED', msg);
  }
});
