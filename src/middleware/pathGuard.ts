import { Request, Response, NextFunction } from 'express';
import { sanitizePath, isInside } from '../utils/pathSanitizer';
import { allScans } from '../services/diskScanner';
import { isVirtualPath } from '../services/containerScanner';
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

/**
 * The default batch cap for `paths` bodies.
 *
 * Every destructive route uses this. It is deliberately small: these bodies
 * become filesystem operations, and a person confirming "move 500 things to
 * the Trash" is still reviewing a list they could in principle read.
 */
export const DEFAULT_MAX_BODY_PATHS = 500;

/**
 * Sanitize req.body.paths (array of paths), capping the batch at `max`.
 *
 * Read-only routes may raise the cap — the v4 fact sidecar (§4.1) allows
 * 2,000, because it answers questions about paths rather than acting on them
 * and a treemap view can legitimately need facts for a whole screenful at
 * once. The cap is a parameter rather than a global so that raising it for a
 * read-only route cannot silently raise it for a destructive one.
 */
export function guardBodyPathsMax(max: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown> | undefined;
    const paths = body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      next(new AppError(400, 'PATHS_REQUIRED', 'Request body must include a non-empty "paths" array'));
      return;
    }
    if (paths.length > max) {
      next(new AppError(400, 'TOO_MANY_PATHS', `At most ${max} paths per request`));
      return;
    }
    (req.body as Record<string, unknown>).paths = paths.map((p) => sanitizePath(p));
    next();
  };
}

/** Sanitize req.body.paths (array of paths), capped at 500. */
export const guardBodyPaths = guardBodyPathsMax(DEFAULT_MAX_BODY_PATHS);

/**
 * Decode one query-string component the way express's default ("simple")
 * query parser does: `+` is a space, `%XX` is a byte, and a malformed escape
 * is left standing rather than throwing (querystring.parse never throws).
 * Used only to match a raw key against a guarded parameter name.
 */
function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Rewrite `req.url`'s query string so the sanitized values actually stick.
 *
 * express@5 keeps no query object on the request: `req.query` is a getter that
 * re-parses `req.url` on every single access and hands back a brand-new object
 * (express/lib/request.js). Assigning `req.query[name] = clean` therefore
 * mutates a throwaway and every handler downstream still reads the RAW value —
 * which is how one trailing slash on `?path=/…/Media/` reached findByPath
 * un-trimmed and 404'd a subtree that plainly existed. Editing the request's
 * own query string is the one change the getter cannot discard: it re-parses to
 * the clean value from here on, for every reader, without a single handler
 * having to know about any of this.
 *
 * Everything the guard does not own is copied through byte for byte — same
 * parameters, same order, same encoding — because a middleware that owns
 * `path` has no business re-spelling anyone else's parameter.
 */
function rewriteQueryValues(req: Request, cleaned: Map<string, string>): void {
  if (cleaned.size === 0) return;

  const qAt = req.url.indexOf('?');
  // No query string means nothing was read out of one either; inventing one
  // here could only differ from what the getter already returned.
  if (qAt === -1) return;

  const head = req.url.slice(0, qAt);
  let search = req.url.slice(qAt + 1);
  // A '#' in the request target starts a fragment: express parses the query
  // only up to it, so the tail has to be carried across untouched rather than
  // swallowed into (or dropped from) the rebuilt query string.
  let fragment = '';
  const hashAt = search.indexOf('#');
  if (hashAt !== -1) {
    fragment = search.slice(hashAt);
    search = search.slice(0, hashAt);
  }

  const rewritten = new Set<string>();
  const pairs = search.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const name = decodeQueryComponent(rawKey);
    const clean = cleaned.get(name);
    if (clean === undefined) return pair; // not ours — pass the raw bytes through
    rewritten.add(name);
    // encodeURIComponent escapes '?', '#', '&', '=', '%' and '+', so a path
    // containing any of them survives the round trip back through the parser.
    return `${rawKey}=${encodeURIComponent(clean)}`;
  });
  // A value the parser produced from something we could not find in the raw
  // string still has to reach handlers cleaned, so append it rather than
  // silently leaving the raw spelling in force.
  for (const [name, clean] of cleaned) {
    if (!rewritten.has(name)) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(clean)}`);
  }

  req.url = `${head}?${pairs.join('&')}${fragment}`;
}

/** Sanitize an optional ?path= / ?root= query parameter. */
export function guardQueryPath(...params: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cleaned = new Map<string, string>();
    for (const name of params) {
      const value = req.query[name];
      if (value === undefined) continue;
      // throws PathRejectedError -> errorHandler; a repeated parameter arrives
      // as an array and is rejected here, exactly as it always was.
      cleaned.set(name, sanitizePath(value));
    }
    rewriteQueryValues(req, cleaned);
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
    // Cloud entries never touch this filesystem — their deletes go through
    // POST /api/cloud/trash to the provider's own trash.
    if (p.startsWith('cloud://')) {
      next(new AppError(403, 'CLOUD_PATH', `"${p}" lives in a cloud account — use the provider's trash instead`));
      return;
    }
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
    // Entries inside a container exist in its directory listing, not on
    // disk — only the container itself can be trashed or opened.
    if (isVirtualPath(p)) {
      next(
        new AppError(
          403,
          'VIRTUAL_PATH',
          `"${p}" is inside an archive — act on the archive itself instead`
        )
      );
      return;
    }
  }
  next();
}
