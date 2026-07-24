import { Request, Response, NextFunction } from 'express';

/**
 * corsMiddleware — opt-in CORS for the /api surface, no dependency needed
 * (the whole policy is a handful of headers, so the MIT `cors` package would
 * buy nothing but a lockfile entry).
 *
 * Off by default: with TREEMAP_ALLOWED_ORIGINS unset this is a pure
 * pass-through and no CORS header is ever emitted — exactly today's
 * behavior. Set it to a comma-separated origin list
 * (e.g. "https://tools.example.com,http://localhost:5173") to let browser
 * apps on those origins call the API; anything else stays blocked by the
 * browser as before. The env var is read per-request so tests can toggle it.
 */

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = process.env.TREEMAP_ALLOWED_ORIGINS;
  if (!raw) {
    next(); // CORS not configured — today's behavior, verbatim
    return;
  }
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    // Preflight ends here; an unlisted origin gets 204 with no allow-headers,
    // which the browser reads as "no".
    res.status(204).end();
    return;
  }
  next();
}
