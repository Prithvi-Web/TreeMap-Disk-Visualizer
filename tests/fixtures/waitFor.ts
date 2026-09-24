/**
 * How long a test waits for work to finish before it calls the work hung: a
 * guard against hanging, never a measurement. A deadline sized to a fast
 * machine fails on a busy one — with every core of this Mac busy, 52 tests
 * failed that way (24 Sep 2026), "scan did not complete in time" after 10 s
 * among them — and proves nothing a longer one would not.
 */
export const HANG_GUARD_MS = 120_000;

/**
 * Polls `done` every `pollMs` until it answers true. Fails, naming `what`,
 * once `limitMs` has passed without it; an error `done` throws fails the wait
 * at once.
 */
export async function waitFor(
  done: () => boolean | Promise<boolean>,
  what: string,
  pollMs = 10,
  limitMs = HANG_GUARD_MS,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await done()) return;
    if (Date.now() - started >= limitMs) throw new Error(`${what} did not happen within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
