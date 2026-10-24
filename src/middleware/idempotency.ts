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
 *
 * A repeat that arrives while the first request with its key is still running
 * — the usual retry, sent after a client timeout — waits for that request to
 * answer, then replays its answer, or genuinely retries when it failed (hunt
 * C50). A client that gives up does not end the wait: only the first
 * request's own answer does.
 */

const TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface CachedResponse {
  at: number;
  status: number;
  body: unknown;
}

const cache = new Map<string, CachedResponse>();
/** Requests running now, by cache key: settled when the request answers, however it answers. */
const inFlight = new Map<string, Promise<void>>();

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
  inFlight.clear();
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
  void admit(res, next, cacheKey).catch(next);
}

async function admit(res: Response, next: NextFunction, cacheKey: string): Promise<void> {
  for (;;) {
    const hit = cache.get(cacheKey);
    if (hit) {
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(hit.status).json(hit.body);
      return;
    }
    const running = inFlight.get(cacheKey);
    if (running === undefined) break;
    // Settled by its answer: a success is in the cache now, and a failure lets this one run.
    await running;
  }

  let settle!: () => void;
  const answered = new Promise<void>((resolve) => { settle = resolve; });
  inFlight.set(cacheKey, answered);
  const done = (): void => {
    if (inFlight.get(cacheKey) === answered) inFlight.delete(cacheKey);
    settle();
  };
  // 'finish' too, for an answer that is not JSON; never 'close', which a client that gave up fires
  // while the first request still runs.
  res.once('finish', done);

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300 && !cache.has(cacheKey)) {
      cache.set(cacheKey, { at: Date.now(), status: res.statusCode, body });
    }
    try {
      return originalJson(body);
    } finally {
      done();
    }
  }) as Response['json'];

  next();
}
