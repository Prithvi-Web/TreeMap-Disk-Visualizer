import fs from 'node:fs';

/** How many times the sentinel is rewritten before a watch is called silent, and how long each rewrite waits. */
const SENTINEL_WRITES = 5;
const WAIT_PER_WRITE_MS = 1_000;
const POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type WatchReadiness =
  /** The OS reported something for the root; `baseline` is its event count once it had. */
  | { live: true; writes: number; baseline: number }
  /** Nothing was reported for any of `writes` rewrites across `waitedMs`. */
  | { live: false; writes: number; waitedMs: number };

/**
 * Proves a root's OS watch is delivering before a test makes the change the
 * test is about.
 *
 * A watch is not live the moment it attaches. On macOS the process's one
 * FSEventStream is rebuilt around a new watch on another thread, starting
 * "since now", and a write that lands before the rebuilt stream starts is
 * never reported. Measured on the owner's Mac (28 Sep 2026) with four other
 * processes writing a file every 2 ms, as parallel test files do in a full
 * run: a write made straight after attaching went unreported in 6 of 100
 * attaches, and 5 of 60 on a second run; made 20 ms or more after attaching,
 * 0 of 180. With nothing else writing, 0 of 100 — and other processes
 * attaching and closing watches cost nothing on their own (0 of 100): it is
 * the machine's write load, not their watches. Every watch that missed its
 * first write reported the next one. The live tests wrote once,
 * 5–12 ms after attaching (traced), then waited 12–15 s for an event that had
 * already been lost — which read as "a watch that attaches and says nothing"
 * (HANDOFF.md) and skipped.
 *
 * So, before the real change: rewrite a file the index already holds with its
 * own bytes — no size or count moves — and wait for the OS to report anything
 * for the root, rewriting again if it does not. The count it returns is the
 * baseline the real change's events are measured from.
 *
 * `delivered` is `watcherEventCount` for the root, passed in rather than
 * imported so this file never loads the app's code ahead of a test file's own
 * `isolatedDataDir`.
 */
export async function awaitWatchLive(sentinel: string, delivered: () => number | null): Promise<WatchReadiness> {
  const started = Date.now();
  const bytes = fs.readFileSync(sentinel);
  const before = delivered();
  if (before === null) throw new Error(`no watcher is attached for ${sentinel}; nothing can report it`);
  for (let writes = 1; writes <= SENTINEL_WRITES; writes += 1) {
    fs.writeFileSync(sentinel, bytes);
    const until = Date.now() + WAIT_PER_WRITE_MS;
    while (Date.now() < until) {
      const now = delivered();
      if (now === null) throw new Error(`the watcher for ${sentinel} was stopped while waiting for it`);
      if (now > before) return { live: true, writes, baseline: now };
      await sleep(POLL_MS);
    }
  }
  return { live: false, writes: SENTINEL_WRITES, waitedMs: Date.now() - started };
}

/** The skip message for a watch the handshake could not get a word out of — measured, not assumed. */
export function silentWatchReason(root: string, readiness: { writes: number; waitedMs: number }): string {
  return (
    `the OS watch on ${root} reported none of ${String(readiness.writes)} rewrites of a file inside it ` +
    `over ${String(readiness.waitedMs)} ms, so no change there can be observed. The watch attached without ` +
    'error and stayed silent — a platform failure, not an index one. See HANDOFF.md, "a watch that attaches and says nothing".'
  );
}
