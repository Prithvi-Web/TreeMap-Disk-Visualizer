/**
 * The writes that outlive the answer they belong to.
 *
 * A scan finishes, the walk is done, and the request returns — and only then
 * does the snapshot get written, unawaited, because a durability step has no
 * business holding up an answer that is already correct. That is the right
 * call, and it is why `POST /api/scan?wait=true` is fast.
 *
 * It also means the app keeps mutating state after it has said it is finished.
 * `GET /api/agent/summary` reads the snapshot store for its forecast, so two
 * reads taken either side of that write disagree: `snapshotCount` 0 then 1, and
 * a forecast sentence that changes with it. Nothing is broken — the system
 * really is in two different states at those two moments — but a test asserting
 * "two reads are identical" has no way to be honest about it without knowing
 * when the writing has stopped.
 *
 * Windows CI found exactly that (run 33484895590), where macOS and Linux were
 * green and the same test had passed the run before. It cost an afternoon to
 * establish it was a real race and not a flaky runner.
 *
 * So the writes announce themselves. Registering costs one map entry and no
 * awaiting; in exchange `settled()` gives tests a real answer to "has the
 * background finished?" instead of polling an endpoint and hoping, and
 * `pending()` names what is still running when something hangs.
 *
 * This changes no timing in production: nothing here awaits anything, and a
 * caller that never calls `settled()` behaves exactly as it did before.
 */

interface Entry {
  label: string;
  startedAt: number;
}

let nextId = 1;
const inflight = new Map<number, Entry>();

/** Resolvers waiting for the map to empty. */
const waiters: (() => void)[] = [];

function release(): void {
  if (inflight.size > 0) return;
  // Copy first: a waiter's continuation may register more work synchronously,
  // and it must queue on the NEXT drain rather than being dropped from this one.
  const due = waiters.splice(0, waiters.length);
  for (const w of due) w();
}

/**
 * Register a promise that the caller is deliberately not awaiting.
 *
 * The promise is passed through untouched — this attaches its own observer and
 * hands `p` straight back, so `.catch` handlers, rejection behaviour and timing
 * are exactly what they were. Callers keep owning their own error handling;
 * this is a ledger, not a supervisor.
 */
export function trackWrite<T>(label: string, p: Promise<T>): Promise<T> {
  const id = nextId++;
  inflight.set(id, { label, startedAt: Date.now() });
  const done = (): void => {
    inflight.delete(id);
    release();
  };
  p.then(done, done);
  return p;
}

/**
 * Test-facing: resolve once no tracked write is in flight.
 *
 * Loops rather than resolving on the first drain, because one write can start
 * another — the empty state has to hold across a turn of the microtask queue
 * before it means anything.
 */
export async function settled(): Promise<void> {
  for (;;) {
    if (inflight.size === 0) {
      await Promise.resolve();
      if (inflight.size === 0) return;
      continue;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

/** What is still running, for a diagnostic when something does not settle. */
export function pending(): string[] {
  return [...inflight.values()].map((e) => `${e.label} (${Date.now() - e.startedAt}ms)`);
}

/**
 * Test-only: suites share one process, and a write left in flight by an earlier
 * test would make a later `settled()` wait for something it never started.
 */
export function resetBackgroundWrites(): void {
  inflight.clear();
  release();
}
