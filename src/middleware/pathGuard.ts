import { Request, Response, NextFunction } from 'express';
import { sanitizePath, isInside } from '../utils/pathSanitizer';
import { allScans } from '../services/diskScanner';
import { AppError } from './errorHandler';

/**
 * pathGuard — validates every user-supplied path before it reaches a route.
 *
 * Two flavors:
 *  - `guardBodyPaths` / `guardQueryPath`: sanitize (resolve, de-traverse,
 *    blocklist) and rewrite the value in place so handlers only ever see
 *    clean absolute paths.
 *  - `requireInsideScanRoot`: for destructive/OS-touching endpoints — the
 *    path must additionally live inside the root of a scan this server
 *    actually performed. The server never trashes or opens anything it
 *    hasn't been pointed at first.
 */

/** Sanitize req.body.path (single path field). */
export function guardBodyPath(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || body.path === undefined) {
    next(new AppError(400, 'PATH_REQUIRED', 'Request body must include "path"'));
    return;
  }
  body.path = sanitizePath(body.path); // throws PathRejectedError -> errorHandler
  next();
}

/** Sanitize req.body.paths (array of paths). */
export function guardBodyPaths(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    next(new AppError(400, 'PATHS_REQUIRED', 'Request body must include a non-empty "paths" array'));
    return;
  }
  if (paths.length > 500) {
    next(new AppError(400, 'TOO_MANY_PATHS', 'At most 500 paths per request'));
    return;
  }
  (req.body as Record<string, unknown>).paths = paths.map((p) => sanitizePath(p));
  next();
}

/** Sanitize an optional ?path= / ?root= query parameter. */
export function guardQueryPath(...params: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const name of params) {
      const value = req.query[name];
      if (value === undefined) continue;
      req.query[name] = sanitizePath(value);
    }
    next();
  };
}

/** Is `p` inside the root of any scan this server has run (and not evicted)? */
export function insideAnyScanRoot(p: string): boolean {
  return allScans().some((scan) => isInside(scan.rootPath, p));
}

/** Reject body paths that fall outside every known scan root. */
export function requireInsideScanRoot(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as { path?: string; paths?: string[] };
  const candidates = body.paths ?? (body.path !== undefined ? [body.path] : []);
  for (const p of candidates) {
    if (!insideAnyScanRoot(p)) {
      next(
        new AppError(
          403,
          'OUTSIDE_SCAN_ROOT',
          `"${p}" is outside every scanned root — scan its folder first`
        )
      );
      return;
    }
  }
  next();
}
