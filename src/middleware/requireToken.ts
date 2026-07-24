import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * requireToken — optional bearer/API-key auth for the /api surface.
 *
 * Enforced ONLY when the TREEMAP_TOKEN environment variable is set; with it
 * unset (the desktop and default case) every request passes through exactly
 * as today. The env var is read per-request, mirroring how storage.ts reads
 * TREEMAP_DATA_DIR, so tests can toggle it without rebuilding the app.
 *
 * Two accepted credentials:
 *  - `Authorization: Bearer <token>` — for agents and API clients;
 *  - the `treemap_token` cookie — set automatically when the server serves
 *    its own UI page (see uiAuthCookie). Cookies ride along on same-origin
 *    fetch() and, crucially, on EventSource, which cannot send headers — so
 *    the human UI and its SSE streams keep working unmodified (R2).
 *
 * The threat model is documented in AGENTS.md: the token gates API access
 * for non-browser clients and, with SameSite=Strict + CORS off by default,
 * blocks cross-site browser access. Anyone who can load the UI page itself
 * gets a session — if the port is exposed beyond localhost, front it with a
 * reverse proxy that authenticates page loads too.
 */

const COOKIE_NAME = 'treemap_token';

/** Constant-time comparison; hashing first equalizes lengths. */
function tokensMatch(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null; // malformed percent-encoding — treat as absent
      }
    }
  }
  return null;
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.TREEMAP_TOKEN;
  if (!token) {
    next(); // auth not configured — today's behavior, verbatim
    return;
  }
  // Browsers never attach credentials to CORS preflights.
  if (req.method === 'OPTIONS') {
    next();
    return;
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && tokensMatch(auth.slice(7).trim(), token)) {
    next();
    return;
  }
  const fromCookie = cookieToken(req.headers.cookie);
  if (fromCookie !== null && tokensMatch(fromCookie, token)) {
    next();
    return;
  }
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .json({ error: 'Authentication required — send Authorization: Bearer <TREEMAP_TOKEN>', code: 'UNAUTHORIZED' });
}

/**
 * When token auth is enabled, serving the UI page hands the browser its
 * session cookie so the frozen frontend (plain fetch('/api/…') and
 * EventSource, no auth code) keeps working. HttpOnly: the page's JS never
 * needs to read it. SameSite=Strict: other sites can never ride on it.
 */
export function uiAuthCookie(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.TREEMAP_TOKEN;
  if (token && req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`);
  }
  next();
}
