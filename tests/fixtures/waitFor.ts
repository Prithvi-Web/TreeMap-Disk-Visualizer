/**
 * How long a test waits for work to finish before it calls the work hung: a
 * guard against hanging, never a measurement. A deadline sized to a fast
 * machine fails on a busy one — with every core of this Mac busy, 52 tests
 * failed that way (24 Sep 2026), "scan did not complete in time" after 10 s
 * among them — and proves nothing a longer one would not.
 */
export const HANG_GUARD_MS = 120_000;

/** What `waitFor` reads the time with and waits by: the real clock, unless a test of `waitFor` itself brings one. */
export interface WaitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Polls `done` every `pollMs` until it answers true. Fails, naming `what`,
 * once `limitMs` has passed without it; an error `done` throws fails the wait
 * at once. This is the one wait in the suite that may end by the clock, and
 * only to end a hang.
 */
export async function waitFor(
  done: () => boolean | Promise<boolean>,
  what: string,
  pollMs = 10,
  limitMs = HANG_GUARD_MS,
  clock: WaitClock = REAL_CLOCK,
): Promise<void> {
  const started = clock.now();
  for (;;) {
    if (await done()) return;
    if (clock.now() - started >= limitMs) throw new Error(`${what} did not happen within ${limitMs} ms`);
    await clock.sleep(pollMs);
  }
}
