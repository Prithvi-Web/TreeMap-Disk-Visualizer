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
 * What `waitFor` throws when the hang guard ends a wait — its own class, so a
 * caller that triages a wait that never ended (a silent OS watch) can tell it
 * from an error `done` threw.
 */
export class HangGuardExpired extends Error {
  constructor(what: string, limitMs: number) {
    super(`${what} did not happen within ${limitMs} ms`);
    this.name = 'HangGuardExpired';
  }
}

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
    if (clock.now() - started >= limitMs) throw new HangGuardExpired(what, limitMs);
    await clock.sleep(pollMs);
  }
}

/**
 * `promise`, bounded only by the hang guard: its outcome, or HangGuardExpired
 * naming `what` once `limitMs` has passed without one. The one race against a
 * timer a test may run — a race against a shorter timer is a wall-clock bound
 * (tests/noWallClockBounds.test.ts). The timer is cleared as soon as the
 * promise settles, so a guard never holds a test process open.
 */
export async function withinHangGuard<T>(promise: Promise<T>, what: string, limitMs = HANG_GUARD_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HangGuardExpired(what, limitMs)), limitMs);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
