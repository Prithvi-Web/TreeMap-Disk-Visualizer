import { lastFdaState, type FdaState } from './fdaState';

/**
 * The one builder of every sentence TreeMap says about Full Disk Access
 * (Track U, U-11). Imports nothing but the state holder, so `errno.ts` and
 * `errorHandler.ts` can use it without an import cycle.
 *
 * Why one builder: the copies it replaces each said "Give TreeMap Full Disk
 * Access" for every refusal, and that was false three ways. An EACCES is the
 * folder's own permissions (or another account's), which Full Disk Access
 * does not touch — the owner's own chmod-000 folder answered that way. A Mac
 * that already has it was told to grant it again. And in web mode
 * (`npm start`) the grant belongs to the app that started the server — the
 * terminal — not to TreeMap. The rule, per refusal:
 *
 *  - EACCES: the refusal sentence — Full Disk Access does not change it.
 *  - EPERM, or a count of refusals: by the probed state — not-granted names
 *    who to grant it to, granted gives the refusal sentence, and unknown (or
 *    no probe yet) says both, since TreeMap cannot tell which is true.
 *  - A count under not-granted (`code: null`) also says what granting will
 *    not open. The scan keeps no errno per refused folder, so a count can
 *    hold a folder closed by its own permissions, and the grant sentence
 *    alone sent that person round the loop: grant, relaunch, rescan, the
 *    same refusal (review F1.3).
 *
 * The page writes none of these: the capability carries the sentence for a
 * refused count (`fullDiskAccess.advice`) and the page shows it as is.
 */

/** Who the grant belongs to: TreeMap in the desktop app; in web mode, whatever started the server. */
export interface Grantee {
  name: string;
  /** TreeMap is the app the person quits and reopens. */
  desktop: boolean;
}

/** The grantee in web mode — the app whose permissions the server process inherits. */
export const WEB_GRANTEE = "the app that started TreeMap's server (for npm start, your terminal app)";

/** The refusals the builder distinguishes; anything else is worded as a count. */
export type AccessCode = 'EPERM' | 'EACCES' | null;

/**
 * Whose Full Disk Access this process runs under.
 *
 * The desktop app runs the server in its own process (Electron sets
 * `process.versions.electron`; a shell that runs it as a sidecar says so in
 * `TREEMAP_SHELL`), so the grant is TreeMap's. Anything else was started by
 * something else, and macOS judges the server by that app's grant.
 */
export function granteeFor(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Grantee {
  const desktop = Boolean(versions.electron) || Boolean(env.TREEMAP_SHELL);
  return desktop ? { name: 'TreeMap', desktop: true } : { name: WEB_GRANTEE, desktop: false };
}

/** An errno code as the builder reads it. */
export function accessCodeOf(code: unknown): AccessCode {
  return code === 'EPERM' || code === 'EACCES' ? code : null;
}

/**
 * What to do to grant it. The restart clause stays until the U-11 gate on the
 * owner's Mac shows whether macOS needs it (Track U plan, U-11 gate (b)).
 */
function grantSentence(grantee: Grantee, retry: string): string {
  const restart = grantee.desktop
    ? 'quit and reopen TreeMap'
    : "quit and reopen that app — quitting it stops TreeMap's server, so start the server again after —";
  return `Give ${grantee.name} Full Disk Access in System Settings › Privacy & Security › Full Disk Access, then ${restart} and ${retry}.`;
}

/** What refuses when Full Disk Access is not the answer. */
const REFUSAL =
  "macOS, another account, or the folder's own permissions refuse TreeMap here; Full Disk Access does not change that, " +
  'and TreeMap does not ask for administrator rights to get past them.';

/**
 * Said after the grant sentence when the refusal may not be macOS's privacy
 * gate at all: a count, or a refusal whose cause the caller cannot name. True
 * of a chmod-000 folder, another account's folder and a file locked in Finder.
 */
const NOT_PERMISSIONS =
  'Full Disk Access does not override permissions or locks that you or another account set on a folder or file.';

/**
 * The sentence for one refusal, or for a count of them (`code: null`, which
 * is also how a caller words a refusal whose cause it cannot name).
 *
 * `retry` is what the person does once it is fixed: "scan again" by default,
 * "try again" where the refused thing was an action.
 */
export function accessAdvice(input: { code: AccessCode; state: FdaState | null; grantee: Grantee; retry?: string }): string {
  const { code, state, grantee } = input;
  const retry = input.retry ?? 'scan again';
  if (code === 'EACCES' || state === 'granted') return REFUSAL;
  const grant = grantSentence(grantee, retry);
  if (state === 'not-granted') return code === 'EPERM' ? grant : `${grant} ${NOT_PERMISSIONS}`;
  const who = grantee.desktop ? 'it' : grantee.name;
  return `TreeMap could not tell whether ${who} has Full Disk Access. If not, ${grant.charAt(0).toLowerCase()}${grant.slice(1)} If it does, ${REFUSAL}`;
}

/** A scan refused without Full Disk Access, and it is on now. */
const ON_NOW = 'Full Disk Access is on now, so a new scan can read the folders macOS kept TreeMap out of.';

/**
 * The sentence for a scan's refused count, worded by the state the scan ran
 * under (`scanState`, stamped on the scan when it started) rather than the
 * state now (review F1.5). Granted while the app runs, the state now is
 * granted, and its sentence — Full Disk Access "does not change that" — is
 * false about refusals Full Disk Access caused; those are on now instead. A
 * scan with no recorded state (nothing had probed when it started, or a
 * record from before the stamp) is worded by the state now.
 */
export function scanAccessAdvice(input: {
  scanState: FdaState | null | undefined;
  nowState: FdaState | null;
  grantee: Grantee;
  retry?: string;
}): string {
  const state = input.scanState ?? input.nowState;
  if (state === 'not-granted' && input.nowState === 'granted') return ON_NOW;
  return accessAdvice({ code: null, state, grantee: input.grantee, retry: input.retry });
}

/** `accessAdvice` for this process now: the state the probe last found, and this process's grantee. */
export function accessAdviceNow(input: { code: AccessCode; retry?: string }): string {
  return accessAdvice({ ...input, state: lastFdaState(), grantee: granteeFor() });
}
