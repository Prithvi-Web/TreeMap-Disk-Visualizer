/**
 * The per-node fact layer (v4 §4.1).
 *
 * A **fact** is a derived, per-path attribute that is not in the scan tree:
 * last-used date, recoverability, reclaim score, a note, journal attribution.
 * Facts exist as a separate layer for one hard reason: the scan responses the
 * UI already consumes are under byte-identity lock
 * (`tests/goldenResponses.test.ts`), so not one field may be added to any of
 * them — not even an optional one, because key presence and key order are both
 * compared. Every new per-node fact therefore travels through the sidecar
 * route `POST /api/facts` and is joined to the tree client-side, by path.
 *
 * Three rules shape the interfaces below, and all three come from §2.4:
 *
 *  - **Unavailable is a first-class state.** A provider that cannot run on this
 *    machine says so, in a sentence a person can read, and returns nothing.
 *  - **Partial is stated, not hidden.** Every batch carries counts, so a caller
 *    can say "scored 41,200 of 58,900" instead of quietly reporting a smaller
 *    number as if it were the whole.
 *  - **Absent is not zero.** A path missing from `values` was not computable.
 *    Consumers must render that as unknown; a zero would be a claim the
 *    provider never made.
 */

/** Per-batch counts. Always populated, so a partial result can state itself. */
export interface FactStats {
  /** Paths asked for (after de-duplication). */
  requested: number;
  /** Paths this batch produced a value for. */
  computed: number;
  /**
   * Paths deliberately not attempted — outside the provider's domain, or
   * already known to be unanswerable. Not a failure.
   */
  skipped: number;
  /** Paths attempted that errored. A failure, and reported as one. */
  failed: number;
}

/** One provider's answer for one batch of paths. */
export interface FactBatch<T> {
  available: boolean;
  /**
   * Present only when `available === false`. Shown to the user verbatim, so it
   * must be a plain-English sentence naming the real reason — never a stack
   * trace and never a generic "unavailable".
   */
  reason?: string;
  /**
   * Path → fact. A path absent from this map was **not computable**; that is
   * not the same as a zero, and no consumer may treat it as one.
   */
  values: Map<string, T>;
  stats: FactStats;
}

/**
 * A source of one kind of fact.
 *
 * Providers are batched by design: the per-OS tools behind them (`mdls`,
 * `git`, `tmutil`) cost far more per invocation than per path, so computing
 * facts one path at a time would make the whole layer unusable at scale.
 */
export interface FactProvider<T> {
  /** Stable id, used in API requests, responses and settings. */
  readonly id: string;
  /** Human label for the UI. */
  readonly label: string;
  /**
   * Names an entry in `GET /api/platform/capabilities`. `null` means the
   * provider is always available — it depends on nothing this machine might
   * lack.
   */
  readonly capabilityKey: string | null;
  /** Compute facts for a batch of absolute paths within one scan. */
  compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<T>>;
}

/** An empty batch carrying a reason — the shape of "cannot answer here". */
export function unavailableBatch<T>(reason: string, requested: number): FactBatch<T> {
  return {
    available: false,
    reason,
    values: new Map<string, T>(),
    // Every requested path is skipped, not failed: nothing was attempted, so
    // nothing went wrong. Reporting these as failures would make an honest
    // "this machine cannot do that" look like a malfunction.
    stats: { requested, computed: 0, skipped: requested, failed: 0 },
  };
}
