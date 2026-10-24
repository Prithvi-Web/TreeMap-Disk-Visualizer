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
 *
 * The desktop shell closes that last gap (hunt C10): it sets
 * TREEMAP_SESSION_COOKIE, a secret apart from the token, and puts a
 * `treemap_session` cookie of that value into its own browser session before
 * its window loads the page. With it set, serving the page hands out no
 * cookie, and the only cookie that is a session is that one — so a local
 * program that loads the page, under this account or another, learns nothing,
 * and the cookie's value is never the bearer token.
 */

const COOKIE_NAME = 'treemap_token';
const SESSION_COOKIE_NAME = 'treemap_session';

/** Constant-time comparison; hashing first equalizes lengths. */
function tokensMatch(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieToken(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
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
  // The desktop's window session, when the shell configured one; else the page's token cookie.
  const session = process.env.TREEMAP_SESSION_COOKIE;
  const fromCookie = session ? cookieToken(req.headers.cookie, SESSION_COOKIE_NAME) : cookieToken(req.headers.cookie, COOKIE_NAME);
  if (fromCookie !== null && tokensMatch(fromCookie, session || token)) {
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
  // A desktop window brings its own session cookie: a page load is handed nothing (hunt C10).
  if (process.env.TREEMAP_SESSION_COOKIE) {
    next();
    return;
  }
  if (token && req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`);
  }
  next();
}
