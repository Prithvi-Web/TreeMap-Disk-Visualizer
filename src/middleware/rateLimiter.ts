import { Request, Response, NextFunction } from 'express';

/**
 * Token-bucket rate limiter, no external packages.
 *
 * Each client IP gets a bucket of `capacity` tokens refilled at
 * `refillPerSec` tokens/second. Every request costs one token; an empty
 * bucket means 429. Capacity above the refill rate allows short bursts
 * (the UI fires a few requests at once after a scan completes) while still
 * enforcing a sustained rate.
 *
 * There are two lanes, because one bucket could not serve both jobs:
 *
 *  - **api** (20 burst, 10/s) — the original limit, unchanged. It guards
 *    endpoints that walk trees, spawn scans or touch files.
 *  - **preview** (300 burst, 150/s) — thumbnails only. The near-duplicate strip
 *    legitimately requests one image per visible row, so a single screenful
 *    fires dozens at once. Measured on the shared bucket: 60 concurrent
 *    thumbnails returned **20 OK and 40 × 429**, and because an `<img>` has no
 *    way to retry, each 429 became a permanently broken thumbnail. The same
 *    storm also drained the tokens the app's own data calls needed, so drill-in
 *    and scan polling failed while the strip was loading. Separate buckets fix
 *    both directions at once.
 */

const SWEEP_INTERVAL_MS = 60_000;
/** Buckets idle longer than this are dropped to keep the map small. */
const IDLE_EXPIRY_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
}

interface Lane {
  capacity: number;
  refillPerSec: number;
  buckets: Map<string, Bucket>;
}

const apiLane: Lane = { capacity: 20, refillPerSec: 10, buckets: new Map() };
const previewLane: Lane = { capacity: 300, refillPerSec: 150, buckets: new Map() };
const lanes = [apiLane, previewLane];

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const lane of lanes) {
    for (const [ip, bucket] of lane.buckets) {
      if (now - bucket.lastRefill > IDLE_EXPIRY_MS) lane.buckets.delete(ip);
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

/**
 * Drop every bucket. Test-only: suites share one process, so without this an
 * earlier suite's requests starve a later one into 429s that look like bugs.
 */
export function resetRateLimiter(): void {
  for (const lane of lanes) lane.buckets.clear();
}

/**
 * Which lane a request belongs to. Mounted at `/api` the path arrives as
 * `/files/preview`; both spellings are accepted so the middleware behaves the
 * same whether it is mounted or called directly in a test.
 */
function laneFor(req: Request): Lane {
  const path = req.path || '';
  return path === '/files/preview' || path === '/api/files/preview' ? previewLane : apiLane;
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const lane = laneFor(req);
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();

  let bucket = lane.buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: lane.capacity, lastRefill: now };
    lane.buckets.set(ip, bucket);
  } else {
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(lane.capacity, bucket.tokens + elapsedSec * lane.refillPerSec);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    const retryAfterSec = Math.ceil((1 - bucket.tokens) / lane.refillPerSec);
    res
      .status(429)
      .set('Retry-After', String(retryAfterSec))
      .json({ error: 'Too many requests — slow down', code: 'RATE_LIMITED' });
    return;
  }

  bucket.tokens -= 1;
  next();
}
