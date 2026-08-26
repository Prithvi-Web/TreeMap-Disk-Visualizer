import { platform } from '../../platform';
import { capabilityState } from '../../platform/capabilities';
import type { LastUsedInfo } from '../../platform/types';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `lastUsed` fact provider (v4 §1.1).
 *
 * **Why this fact is worth a whole per-OS layer.** "Downloaded fourteen months
 * ago, never opened" is the single highest-signal statement a disk tool can
 * make, and modification time cannot express it: a file written once and read
 * every day and a file written once and forgotten have identical mtimes.
 * TreeMap has shipped fifteen views without ever asking the question.
 *
 * Everything OS-specific lives behind `platform().readLastUsed()`. What lives
 * here is the part that must be identical on all three: the honesty rules.
 *
 *  - A path that could not be read is **absent** from `values`, and counted as
 *    `skipped`. It is never `lastUsedMs: 0`, which would render as 1 January
 *    1970 and read as "ancient, delete it".
 *  - A path that exists but whose last-opened date is genuinely unknown comes
 *    back with `source: 'none'` and `lastUsedMs: null` — **present, and
 *    explicitly unknown**. That is a different statement from absent, and the
 *    distinction survives to the UI: absent means "we could not look", none
 *    means "we looked and this machine does not record it".
 *  - **mtime is never substituted.** Not on Windows with last-access tracking
 *    off, not on a `noatime` mount, not anywhere. §3.1 permits an mtime
 *    fallback for the reclaim score's staleness component *only* with the
 *    fallback stated at the point of display; it is not this provider's job to
 *    quietly perform it here, where the substitution would be invisible.
 */

export type LastUsedFact = LastUsedInfo;

export const lastUsedProvider: FactProvider<LastUsedFact> = {
  id: 'lastUsed',
  label: 'Last-opened dates',
  capabilityKey: 'lastUsed',

  async compute(_scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<LastUsedFact>> {
    // The capability is the machine-wide verdict: Windows with last-access
    // updates switched off, or a system whose every mount is noatime. Asking
    // per path would be 2,000 identical subprocess calls to learn one fact.
    const capability = await capabilityState('lastUsed');
    if (!capability.available) {
      return unavailableBatch(
        capability.reason ?? 'This computer does not record when files are opened.',
        paths.length,
      );
    }

    if (signal.aborted) {
      return {
        available: true,
        values: new Map(),
        stats: { requested: paths.length, computed: 0, skipped: paths.length, failed: 0 },
      };
    }

    const read = await platform().readLastUsed(paths);

    const values = new Map<string, LastUsedFact>();
    for (const p of paths) {
      const info = read.get(p);
      // Absent from the platform's map means the path could not be stat'd at
      // all — deleted since the scan, or unreadable. Leaving it out of
      // `values` is what makes `skipped` mean something.
      if (info) values.set(p, info);
    }

    return {
      available: true,
      values,
      stats: {
        requested: paths.length,
        computed: values.size,
        skipped: paths.length - values.size,
        // A path the platform layer could not read is skipped rather than
        // failed: a file that has been deleted since the scan is an ordinary
        // event, not a malfunction, and colouring it as one would make normal
        // use look broken.
        failed: 0,
      },
    };
  },
};
