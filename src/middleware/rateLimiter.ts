import { Request, Response, NextFunction } from 'express';

/**
 * Token-bucket rate limiter, no external packages.
 *
 * Each client IP gets a bucket of `CAPACITY` tokens refilled at
 * `REFILL_PER_SEC` tokens/second. Every request costs one token; an empty
 * bucket means 429. Capacity above the refill rate allows short bursts
 * (the UI fires a few requests at once after a scan completes) while still
 * enforcing 10 req/s sustained.
 */

const REFILL_PER_SEC = 10;
const CAPACITY = 20;
const SWEEP_INTERVAL_MS = 60_000;
/** Buckets idle longer than this are dropped to keep the map small. */
const IDLE_EXPIRY_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
}

const buckets = new Map<string, Bucket>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_EXPIRY_MS) buckets.delete(ip);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: CAPACITY, lastRefill: now };
    buckets.set(ip, bucket);
  } else {
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSec * REFILL_PER_SEC);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    const retryAfterSec = Math.ceil((1 - bucket.tokens) / REFILL_PER_SEC);
    res
      .status(429)
      .set('Retry-After', String(retryAfterSec))
      .json({ error: 'Too many requests — slow down', code: 'RATE_LIMITED' });
    return;
  }

  bucket.tokens -= 1;
  next();
}
