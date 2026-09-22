import type { CapabilityState } from './types';
import type { ScanModuleOutcome } from '../services/scan/native';

/**
 * The words a platform contributes to its "Fast scanning" capability.
 *
 * The sentence itself is decided here, from the native loader's real
 * outcome, so no platform can claim a mechanism this build does not have —
 * or, since Phase 3, deny one it does. A claim the app prints is held to
 * the same bar as a number: it comes from what was measured (the load),
 * never from the build's opinion of itself.
 */
export interface FastEnumerationWords {
  /** The platform's bulk-listing call, as the native scan core makes it: `getattrlistbulk`, `getdents64`, `FileIdExtdDirectoryInfo`. */
  call: string;
  /** The ordinary path the legacy walker takes, in the words the capability table has always used. */
  legacy: string;
  /** The short name of that path, for `degradedTo`. */
  legacyShort: string;
  /** A platform sentence appended in both states (Windows: the file-table trick is not part of this build). */
  note?: string;
}

/** The "Fast scanning" capability for `outcome` — the loader's answer, never a guess. */
export function fastEnumerationState(outcome: ScanModuleOutcome, words: FastEnumerationWords): CapabilityState {
  const note = words.note ? ` ${words.note}` : '';
  if (outcome.available) {
    return {
      available: true,
      mechanism: `${words.call} (native scan core)`,
      reason:
        `Folders are listed in bulk by TreeMap's native scan core — one ${words.call} call per folder instead of one call per file — ` +
        'when the Scan engine setting is Automatic or Native. A scan the core cannot take is read the ordinary way, ' +
        `and the Dashboard names the engine that ran and why.${note}`,
    };
  }
  return {
    available: true,
    mechanism: words.legacy,
    degradedTo: words.legacyShort,
    reason:
      `${words.call} lives in TreeMap's native scan core, which did not load on this machine (${outcome.reason}), ` +
      'so folders are read the ordinary way. Scans still work; the first scan of a very large drive takes longer ' +
      `than it could.${note}`,
  };
}
