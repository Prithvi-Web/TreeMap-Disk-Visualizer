import { Request, Response, NextFunction } from 'express';

/**
 * idempotency — honor an Idempotency-Key header on destructive POST/DELETE
 * routes so a retried request (flaky network, impatient agent) can never
 * double-execute. In-memory map + sweeper, mirroring rateLimiter's style.
 *
 * Semantics: the first request with a given key executes normally and its
 * successful (2xx) JSON response is remembered; any repeat inside the TTL
 * gets the stored response replayed verbatim with an `Idempotency-Replayed:
 * true` header. Failures are NOT remembered — a retry after an error should
 * genuinely retry. Without the header the middleware is a pass-through.
 */

const TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface CachedResponse {
  at: number;
  status: number;
  body: unknown;
}

const cache = new Map<string, CachedResponse>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

/** Test-only: suites share a process. */
export function resetIdempotencyCache(): void {
  cache.clear();
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['idempotency-key'];
  const key = typeof header === 'string' ? header.trim() : '';
  if (!key) {
    next(); // no key — today's behavior, verbatim
    return;
  }
  // Scope the key to method+path so one key accidentally reused across
  // different operations can't replay the wrong response.
  const cacheKey = `${req.method} ${req.baseUrl}${req.path} ${key}`;

  const hit = cache.get(cacheKey);
  if (hit) {
    res.setHeader('Idempotency-Replayed', 'true');
    res.status(hit.status).json(hit.body);
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300 && !cache.has(cacheKey)) {
      cache.set(cacheKey, { at: Date.now(), status: res.statusCode, body });
    }
    return originalJson(body);
  }) as Response['json'];

  next();
}
