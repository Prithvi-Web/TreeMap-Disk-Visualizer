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
 * There are three lanes, because one bucket could not serve three jobs. A lane
 * is chosen by what the request COSTS THE SERVER, never by who is asking:
 *
 *  - **api** (20 burst, 10/s) — the original limit, unchanged, and the default
 *    for everything not named below. It guards endpoints that walk trees,
 *    spawn scans or child processes, or touch files.
 *  - **preview** (300 burst, 150/s) — thumbnails only. The near-duplicate strip
 *    legitimately requests one image per visible row, so a single screenful
 *    fires dozens at once. Measured on the shared bucket: 60 concurrent
 *    thumbnails returned **20 OK and 40 × 429**, and because an `<img>` has no
 *    way to retry, each 429 became a permanently broken thumbnail. The same
 *    storm also drained the tokens the app's own data calls needed, so drill-in
 *    and scan polling failed while the strip was loading.
 *  - **meta** (120 burst, 60/s) — cheap read-only metadata: GETs answered from
 *    data already resident (the in-memory scan registry, the snapshot and
 *    settings stores, one packed-store size lookup) in work bounded by a
 *    constant. Measured on the shared bucket: an ordinary page load fires ~25
 *    API requests, and a load that coincides with a scan completing fires ~12
 *    more in the same tick — four came back 429 (`POST /api/index/build`,
 *    `GET /api/forecast`, `GET /api/scan/:id/budgets`,
 *    `GET /api/snapshots/compare`) and only landed on the client's retry, which
 *    cost first-paint latency and printed red in the console during a normal
 *    action. Two thirds of that burst was metadata pricing itself as if it
 *    walked a disk. Moving it out is what buys the expensive endpoints their
 *    tokens back; the strict lane's own allowance is untouched.
 *
 * The meta lane is an ALLOWLIST, and deliberately so: a route added tomorrow is
 * guarded strictly until someone has looked at what it costs. Membership is by
 * exact path (or an id-bearing pattern) and GET only — a PUT to a path whose
 * GET is cheap is a write, and writes are never in this lane.
 */

const SWEEP_INTERVAL_MS = 60_000;
/** Buckets idle longer than this are dropped to keep the map small. */
const IDLE_EXPIRY_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
}

interface Lane {
  name: string;
  capacity: number;
  refillPerSec: number;
  buckets: Map<string, Bucket>;
}

const apiLane: Lane = { name: 'api', capacity: 20, refillPerSec: 10, buckets: new Map() };
const previewLane: Lane = { name: 'preview', capacity: 300, refillPerSec: 150, buckets: new Map() };
const metaLane: Lane = { name: 'meta', capacity: 120, refillPerSec: 60, buckets: new Map() };
const lanes = [apiLane, previewLane, metaLane];

/**
 * Cheap read-only metadata, by exact path. Each answers from something already
 * in memory or from one small store file; none walks a tree, spawns a process,
 * or traverses the filesystem.
 */
const META_PATHS = new Set([
  '/capabilities',       // the agent manifest, plus a capability probe cached for 30s
  '/cloud/status',       // the token store
  '/cost/estimate',      // one O(1) size lookup against a shipped price table
  '/cost/pricing',       // the shipped table itself
  '/forecast',           // stored snapshot rows and one statfs
  '/index/status',       // one index row
  '/notes',              // the notes store
  '/notifications',      // the in-memory notification ring
  '/openapi.json',       // generated from a constant, no I/O
  '/platform/portable',  // process state
  '/policy',             // one small JSON file
  '/queries',            // the saved-query store
  '/query/fields',       // the static grammar
  '/scans',              // the in-memory scan registry
  '/settings',           // one small JSON file
  '/snapshots',          // stored snapshot rows
  '/snapshots/compare',  // two store lookups and a diff of top-level entries
  '/system',             // one statfs and a fixed list of stats
]);

/**
 * The same, for paths carrying an id. Progress polls belong here because a
 * long job's caller hits them on a timer for its whole duration; the RESULT
 * endpoints deliberately do not, because the result is the real payload.
 * Budgets are a handful of `findByPath` lookups, not a walk.
 */
const META_PATTERNS = [
  /^\/scan\/[^/]+\/progress$/,
  /^\/scan\/[^/]+\/budgets$/,
  /^\/scan\/[^/]+\/budget-gauges$/,
  /^\/index\/[^/]+\/progress$/,
  /^\/offload\/[^/]+\/progress$/,
  /^\/compression\/[^/]+\/progress$/,
  /^\/timecapsule\/jobs\/[^/]+\/progress$/,
];

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
 * Mounted at `/api` the path arrives as `/files/preview`; called directly in a
 * test it arrives as `/api/files/preview`. Both spellings normalise to one so
 * the middleware behaves the same either way. A query string is not part of
 * the decision — cost is a property of the endpoint.
 */
function normalize(pathOrUrl: string): string {
  const p = (pathOrUrl || '').split('?')[0];
  return p.startsWith('/api/') ? p.slice(4) : p;
}

function laneFor(method: string, pathOrUrl: string): Lane {
  const path = normalize(pathOrUrl);
  if (path === '/files/preview') return previewLane;
  if (method === 'GET' && (META_PATHS.has(path) || META_PATTERNS.some((re) => re.test(path)))) return metaLane;
  return apiLane;
}

/**
 * The lane table, for the two callers that must not restate it by hand:
 * `GET /api/capabilities`, which publishes the limits to agents, and the test
 * that pins a boot burst against the classification it actually gets.
 */
export const rateLimitLanes = {
  /** Which lane a method+URL falls in. */
  laneName(method: string, pathOrUrl: string): string {
    return laneFor(method, pathOrUrl).name;
  },
  /** Every lane's published shape, strictest first. */
  describe(): { name: string; burst: number; sustainedPerSecond: number; covers: string }[] {
    return [
      { name: 'api', burst: apiLane.capacity, sustainedPerSecond: apiLane.refillPerSec,
        covers: 'everything not listed below — scans, tree walks, file access, writes' },
      { name: 'meta', burst: metaLane.capacity, sustainedPerSecond: metaLane.refillPerSec,
        covers: 'GETs of cheap read-only metadata: status, settings, snapshots, progress polls' },
      { name: 'preview', burst: previewLane.capacity, sustainedPerSecond: previewLane.refillPerSec,
        covers: 'GET /api/files/preview thumbnails, which a single screenful requests dozens of' },
    ];
  },
};

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const lane = laneFor(req.method, req.path || '');
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
