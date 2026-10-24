/**
 * How the MCP process ends (hunt C58). It used to exit in the same tick it set the cancel flags,
 * so a running offload never ran its cooperative rollback or saved its record — partial copies
 * stayed on the destination with no record, originals already in the Trash had no entry for
 * Restore — and a trash_paths call cut off part-way wrote no audit line. Now it cancels, then waits
 * until no offload is running and no trash_paths call is in flight, and only then exits; bounded,
 * so a step that never settles cannot keep a closed session's process alive for good.
 */

/** The longest shutdown waits for work to settle before it exits anyway. */
export const SHUTDOWN_GRACE_MS = 60_000;
/** How often it looks again. */
const SHUTDOWN_POLL_MS = 100;

export interface ShutdownSteps {
  /** Ask every job to stop: scans, duplicate hashing, offloads (which then roll back). */
  cancel: () => void;
  /** Whether anything is still settling: an offload running, a trash_paths call in flight. */
  busy: () => boolean;
  exit: (code: number) => void;
  /** The clock it waits on; a test passes its own. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where it says it gave up waiting (stderr: stdout is the MCP protocol channel). */
  log?: (line: string) => void;
}

export async function shutdownWhenSettled(steps: ShutdownSteps): Promise<void> {
  const now = steps.now ?? Date.now;
  const sleep = steps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = steps.log ?? ((line: string) => console.error(line));
  steps.cancel();
  const deadline = now() + SHUTDOWN_GRACE_MS;
  while (steps.busy()) {
    if (now() >= deadline) {
      log(`[treemap-mcp] exiting after ${SHUTDOWN_GRACE_MS / 1000} s with work still settling (an offload rolling back, or a trash_paths call)`);
      break;
    }
    await sleep(SHUTDOWN_POLL_MS);
  }
  steps.exit(0);
}
