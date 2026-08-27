import { FactBatch, FactProvider, FactStats } from './types';

/**
 * The fact registry, its batching, and its TTL cache (v4 §4.1).
 *
 * One provider per kind of fact, resolved by id. Providers are computed
 * concurrently and **isolated from each other**: a provider that throws is
 * reported as unavailable carrying its own message, and never takes down the
 * others in the same request. That isolation is why this layer is a registry
 * rather than a hand-written switch in the route — a fact that shells out to
 * `mdls` or `git` will fail sometimes, and one failing signal must not blank
 * the panel.
 */

const providers = new Map<string, FactProvider<unknown>>();

/**
 * Register a provider. Throws on a duplicate id rather than replacing it: two
 * providers answering to one name is a bug that would otherwise surface as
 * facts that change depending on module import order.
 */
export function registerFactProvider<T>(provider: FactProvider<T>): void {
  if (providers.has(provider.id)) {
    throw new Error(`fact provider "${provider.id}" is already registered`);
  }
  providers.set(provider.id, provider as FactProvider<unknown>);
}

/** Remove a provider, and forget everything it cached. */
export function unregisterFactProvider(id: string): boolean {
  const had = providers.delete(id);
  // Leaving the entries behind kept them counting against the cap until their
  // TTL, and a provider re-registered under the same id would have been served
  // the previous one's values.
  if (had) {
    const marker = SEP + id + SEP;
    for (const k of cache.keys()) if (k.includes(marker)) cache.delete(k);
  }
  return had;
}

export function getFactProvider(id: string): FactProvider<unknown> | undefined {
  return providers.get(id);
}

/** Every registered provider id, sorted — the list an error message names. */
export function factProviderIds(): string[] {
  return [...providers.keys()].sort();
}

/* ------------------------------- the cache ------------------------------- */

/**
 * Matches the scan TTL in diskScanner.ts: a fact describes a scan's tree, and
 * outliving the scan it describes would let a stale value answer for a path
 * that has since been deleted.
 */
const FACT_TTL_MS = 30 * 60 * 1000;

/**
 * Hard entry cap. "Cache everything forever" is how a long-running desktop
 * app develops a slow leak.
 *
 * **This counts entries, not bytes, and the two are not close.** A cached
 * recoverability fact is not the ~50 bytes a scanned node costs: it carries a
 * `why` array of full sentences, a git object and an `unavailable` list, so
 * one to two kilobytes each is realistic. 100,000 of those would retain on the
 * order of 100–200 MB, which is not a bound worth having. Ten thousand is five
 * full batches at the 2,000-path request cap — far more than any screen shows
 * at once — and keeps the worst case in the tens of megabytes.
 */
const MAX_CACHE_ENTRIES = 10_000;

/**
 * The live limits. Mutable only through `setFactCacheLimitsForTests`.
 *
 * A seam rather than a constant because both behaviours worth proving —
 * expiry and cap eviction — are otherwise unreachable from a test: one needs
 * thirty minutes to pass, the other a hundred thousand entries. Following the
 * `setMediaTools()` precedent, the seam is named for what it is so nobody
 * mistakes it for a tuning knob.
 */
let ttlMs = FACT_TTL_MS;
let maxEntries = MAX_CACHE_ENTRIES;

/** Shrink the TTL or the cap for a test. Returns a restore function. */
export function setFactCacheLimitsForTests(limits: { ttlMs?: number; maxEntries?: number }): () => void {
  const previous = { ttlMs, maxEntries };
  if (limits.ttlMs !== undefined) ttlMs = limits.ttlMs;
  if (limits.maxEntries !== undefined) maxEntries = limits.maxEntries;
  return () => {
    ttlMs = previous.ttlMs;
    maxEntries = previous.maxEntries;
  };
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * Cache key separator: NUL, the one byte a POSIX path cannot contain, so no
 * combination of scan id, provider id and path can collide with another by
 * shifting the boundary between them. Written as an escape rather than typed
 * literally — a raw control byte in source is invisible in review.
 */
const SEP = '\u0000';

/**
 * Key: scanId, provider id, path.
 *
 * The scan id is part of the key because the same path in a later scan can
 * have a different answer — a file that grew, a repo that was pushed since.
 * Sharing one entry across scans would serve the previous scan's verdict as
 * if it were current.
 *
 * Only **computed** values are cached. A path the provider could not answer
 * for is deliberately not remembered as a miss: the cause is usually
 * transient (a tool timed out, a permission was refused) and caching it would
 * turn a momentary failure into a thirty-minute one. The cost is that
 * repeatedly asking about a genuinely unanswerable path re-attempts it.
 */
const cache = new Map<string, CacheEntry>();

const keyFor = (scanId: string, providerId: string, path: string): string =>
  scanId + SEP + providerId + SEP + path;

/**
 * Drop expired entries, then oldest-first until back under the cap.
 *
 * Eviction is FIFO by insertion, not LRU: a Map iterates in insertion order,
 * so this costs nothing extra, and facts are re-derivable — evicting a hot
 * entry costs one recomputation, never a wrong answer.
 */
function sweep(now: number): void {
  for (const [k, entry] of cache) {
    if (now - entry.at > ttlMs) cache.delete(k);
  }
  if (cache.size <= maxEntries) return;
  const excess = cache.size - maxEntries;
  let dropped = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (++dropped >= excess) break;
  }
}

/**
 * Forget cached facts — all of them, or one scan's.
 *
 * Called when a scan is replaced by a rescan of the same root: the tree
 * changed underneath, so every derived value describing it is suspect.
 */
export function clearFactCache(scanId?: string): void {
  if (scanId === undefined) {
    cache.clear();
    return;
  }
  const prefix = scanId + SEP;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/**
 * Forget one provider's cached facts, across every scan.
 *
 * Needed because a fact can depend on something other than the tree it
 * describes. The reclaim score is computed from user-editable weights, so
 * changing them makes every cached score wrong — not stale by a little, but
 * an answer to a question nobody is asking any more. Without this the app
 * showed old scores for up to the full thirty-minute TTL, with breakdowns
 * listing components the user had just switched off.
 *
 * Deliberately per-provider rather than a blanket clear: dropping `lastUsed`
 * and `recoverability` too would re-run `mdls` and `git` over everything on
 * screen to answer a question that has not changed.
 */
export function clearFactCacheForProvider(providerId: string): void {
  const marker = SEP + providerId + SEP;
  for (const k of cache.keys()) if (k.includes(marker)) cache.delete(k);
}

/** Entry count — for tests and the bench harness, not for callers. */
export function factCacheSize(): number {
  return cache.size;
}

/* ----------------------------- computation ----------------------------- */

/** One provider's answer, as it appears on the wire. */
export interface ProviderResult {
  available: boolean;
  reason?: string;
  stats: FactStats;
  /** Path to fact. An absent path was not computable — never read it as zero. */
  values: Record<string, unknown>;
}

/**
 * Run one provider over `paths`, serving what the cache already holds.
 *
 * Never throws: every failure becomes an unavailable result carrying the
 * error's own message, because the caller is computing several providers at
 * once and one bad signal must not lose the good ones.
 */
async function runProvider(
  provider: FactProvider<unknown>,
  scanId: string,
  paths: string[],
  signal: AbortSignal,
): Promise<ProviderResult> {
  const now = Date.now();
  const values: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const p of paths) {
    const hit = cache.get(keyFor(scanId, provider.id, p));
    if (hit && now - hit.at <= ttlMs) values[p] = hit.value;
    else missing.push(p);
  }
  const cached = paths.length - missing.length;

  // Everything was already known: answer without touching the provider at all.
  if (missing.length === 0) {
    return {
      available: true,
      stats: { requested: paths.length, computed: cached, skipped: 0, failed: 0 },
      values,
    };
  }

  let batch: FactBatch<unknown>;
  try {
    batch = await provider.compute(scanId, missing, signal);
  } catch (err) {
    // §2.4: the reason is shown verbatim, so it must read as a sentence.
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      reason: `${provider.label} could not be read on this computer (${message}).`,
      stats: { requested: paths.length, computed: 0, skipped: 0, failed: paths.length },
      values: {},
    };
  }

  // A provider that reports itself unavailable is describing this machine
  // right now, not one path. Mixing that verdict with values cached from when
  // it still worked would present stale facts as current, so the whole result
  // is unavailable and carries the provider's own reason.
  if (!batch.available) {
    return {
      available: false,
      reason: batch.reason ?? `${provider.label} is not available on this computer.`,
      stats: { requested: paths.length, computed: 0, skipped: paths.length, failed: 0 },
      values: {},
    };
  }

  for (const [p, value] of batch.values) {
    values[p] = value;
    cache.set(keyFor(scanId, provider.id, p), { at: now, value });
  }
  sweep(now);

  return {
    available: true,
    stats: {
      requested: paths.length,
      // Cache hits were computed too — by an earlier request. Counting only
      // the fresh ones would understate coverage and make a fully-answered
      // batch look partial.
      computed: cached + batch.stats.computed,
      skipped: batch.stats.skipped,
      failed: batch.stats.failed,
    },
    values,
  };
}

/**
 * Compute several providers over one batch of paths.
 *
 * Providers run concurrently — they mostly wait on subprocesses — and each is
 * independently guarded, so the result always holds one entry per requested
 * provider id.
 */
export async function computeFacts(
  scanId: string,
  paths: string[],
  providerIds: string[],
  signal: AbortSignal,
): Promise<Record<string, ProviderResult>> {
  // De-duplicate while preserving request order, so `requested` counts real
  // work rather than repetition — a caller sending the same path twice must
  // not be able to inflate the coverage figure it is about to show a person.
  const unique = [...new Set(paths)];

  const entries = await Promise.all(
    providerIds.map(async (id): Promise<[string, ProviderResult]> => {
      const provider = providers.get(id);
      // The route rejects unknown ids before this runs; this branch exists so
      // a direct caller still gets one entry per id rather than a crash.
      if (!provider) {
        return [id, {
          available: false,
          reason: `No fact provider named "${id}" is registered.`,
          stats: { requested: unique.length, computed: 0, skipped: unique.length, failed: 0 },
          values: {},
        }];
      }
      return [id, await runProvider(provider, scanId, unique, signal)];
    }),
  );

  const out: Record<string, ProviderResult> = {};
  for (const [id, result] of entries) out[id] = result;
  return out;
}
