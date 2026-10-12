/**
 * The last Full Disk Access state the capability probe found (Track U, U-11).
 *
 * No imports, on purpose: `errno.ts` and `errorHandler.ts` read it to word a
 * refusal, and reaching the probe from there would close the cycle
 * errno → capabilities → platform → base → errno. The probe writes it
 * (`capabilities.ts`, under the capability cache); everyone else only reads.
 * `null` means no probe has answered in this process yet — the MCP server
 * started on its own, say — and is worded exactly as `unknown` is.
 */

/** Whether macOS lets TreeMap into the folders it protects: a yes, a no, or "could not tell". */
export type FdaState = 'granted' | 'not-granted' | 'unknown';

let last: FdaState | null = null;

/** Record what the probe found; `null` forgets it. */
export function rememberFdaState(state: FdaState | null): void {
  last = state;
}

/** What the probe last found, or null when nothing has asked. */
export function lastFdaState(): FdaState | null {
  return last;
}
