import { Router, Request, Response } from 'express';
import { moveToTrash, openPath } from '../services/cleaner';
import { guardBodyPath, guardBodyPaths, requireInsideScanRoot } from '../middleware/pathGuard';

export const fileRouter = Router();

/**
 * DELETE /api/files  { paths: string[] }
 * Moves every path to the system trash (never hard-deletes).
 * -> { deleted: string[], failed: { path, reason }[] }
 */
fileRouter.delete('/files', guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { paths } = req.body as { paths: string[] };
  const result = await moveToTrash(paths);
  res.json(result);
});

/**
 * POST /api/files/open  { path: string, reveal?: boolean }
 * Opens the path with the OS default app; reveal=true highlights it in
 * Finder / Explorer / the file manager instead.
 */
fileRouter.post('/files/open', guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { path: target, reveal } = req.body as { path: string; reveal?: boolean };
  await openPath(target, reveal === true);
  res.json({ opened: target });
});
