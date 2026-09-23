/**
 * The pacing of the NTFS turbo mode's elevation prompt (M6).
 *
 * W6-1 asks for administrator permission for one scan at a time, and the
 * security review of M6 (23 Sep 2026) found what a prompt per scan allows:
 * anything that can start scans — a schedule, a script, an agent retrying a
 * scan that fell back — could raise the prompt again and again until someone
 * clicks yes to make it stop. So one prompt is open at a time, and after the
 * person says no — to the app's own sentence or to Windows' prompt — no scan
 * asks for {@link MFT_DECLINE_QUIET_MS}.
 *
 * Only time ends the quiet period, or a restart: the state is the session's,
 * in memory. Nothing reachable through the API ends it early. An earlier
 * version let choosing the mode again in Settings end it, and the second
 * security review of M6 found why that cannot stand: PUT /api/settings is
 * open to anything that can reach the API, without an audit line, so the
 * very loop the quiet period stops could re-arm the prompt at will.
 */

/** How long after a decline no scan asks. */
export const MFT_DECLINE_QUIET_MS = 10 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

let asking = false;
/** When the person last said no (the scan's clock), or null. */
let declinedAt: number | null = null;

/**
 * Why a scan may not ask now, as the sentence its reason carries, or null
 * when it may. A clock set back since the decline ends the quiet period
 * rather than stretching it: asking is the mode's designed behaviour.
 */
export function mftPromptBlocked(now: number): string | null {
  if (asking) return 'another scan is asking Windows for administrator permission right now, and only one scan asks at a time';
  if (declinedAt === null) return null;
  const since = now - declinedAt;
  if (since < 0 || since >= MFT_DECLINE_QUIET_MS) return null;
  const left = Math.max(1, Math.ceil((MFT_DECLINE_QUIET_MS - since) / MINUTE_MS));
  return `administrator permission was declined, so TreeMap does not ask again for ${left} more minute${left === 1 ? '' : 's'}, or until TreeMap restarts`;
}

/** A scan is about to ask: until {@link mftPromptEnded}, no other scan does. */
export function mftPromptStarted(): void {
  asking = true;
}

/** The prompt is over; `declined` when the person said no, at `now`. */
export function mftPromptEnded(declined: boolean, now: number): void {
  asking = false;
  if (declined) declinedAt = now;
}

/** Test-only: no prompt open, no decline remembered. */
export function resetMftPromptForTests(): void {
  asking = false;
  declinedAt = null;
}
