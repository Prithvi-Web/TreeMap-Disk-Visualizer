import path from 'path';
import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import { platform } from '../../platform';
import { getSettings } from '../settings';
import { peekDuplicateJob, REPORTED_GROUPS } from '../duplicateFinder';
import { claimFor, scanInputsFor } from '../reclaimInputs';
import {
  ComponentInput,
  ReclaimComponentId,
  ReclaimScoreFact,
  computeReclaimScore,
  elsewhereValue,
  humanDuration,
  regenerableValue,
  sizeValue,
  stalenessValue,
} from '../reclaimScore';
import { lastUsedProvider } from './lastUsedProvider';
import { recoverabilityProvider } from './recoverabilityProvider';
import type { RecoverabilityFact } from '../recoverabilityTypes';
import type { LastUsedInfo } from '../../platform/types';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `reclaimScore` fact provider (v4 §3).
 *
 * This file gathers; `services/reclaimScore.ts` decides. The split is
 * deliberate — the arithmetic that turns six signals into a number is the
 * part worth testing exactly, and it cannot be tested exactly while it is
 * entangled with `mdls`, `git` and the rule packs.
 *
 * **Nothing new is scanned.** Every input already exists somewhere in
 * TreeMap: the scan tree for size and mtime, §1.1 for last-opened dates,
 * §1.2 for recoverability, the rule packs for regenerability, the duplicate
 * finder for redundancy, and the download record for origin. What this
 * provider adds is the join, and the discipline about what is *not* known.
 *
 * ── The three ways a component goes missing, and why they are different ──
 *
 * 1. **The mechanism cannot run here.** No git, no backup system, no
 *    Spotlight. The component is missing with the capability's own reason.
 * 2. **The mechanism ran and had nothing for this path.** The rule packs
 *    matched nothing; the download record is absent. That is a real zero,
 *    and it is scored as one.
 * 3. **The mechanism has not been asked yet.** Duplicate hashing has not run
 *    for this scan. That is *not* a zero — "no duplicate found" is only true
 *    once something looked — so it is missing, with a reason that says what
 *    would make it answerable.
 *
 * Collapsing 2 and 3 is the tempting mistake and the expensive one: it turns
 * "TreeMap has not checked" into "TreeMap checked and there is nothing", in a
 * number people use to decide what to delete.
 *
 * ── Cost ──
 *
 * The two fact providers this one composes are reached through the registry,
 * so a batch that the UI already fetched costs nothing here. The download
 * record uses the platform's **bulk** reader, which on macOS is one `xattr`
 * call per 500 paths (~101 ms for 2,000, measured) rather than the two
 * subprocesses per file the full C3 provenance path costs. See
 * `DownloadOriginBrief` for what that trade gives up.
 */

export type ReclaimScoreFactValue = ReclaimScoreFact;

/** Never treat the whole batch as failed because one signal was unavailable. */
async function safely<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch {
    return fallback;
  }
}

export const reclaimScoreProvider: FactProvider<ReclaimScoreFactValue> = {
  id: 'reclaimScore',
  label: 'Reclaim score',
  // No single capability gates the score: it is built from six signals, any
  // of which can be missing on a given machine, and it states which ones
  // were. Gating the whole thing on one of them would hide the other five.
  capabilityKey: null,

  async compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<ReclaimScoreFactValue>> {
    const scan = getScan(scanId);
    if (!scan) {
      return unavailableBatch('That scan has expired. Scan the folder again to score it.', paths.length);
    }
    if (scan.status === 'running') {
      return unavailableBatch('That scan is still running — nothing can be scored until it finishes.', paths.length);
    }
    if (!scan.store && !scan.root) {
      return unavailableBatch(scan.error ?? 'That scan did not complete, so there is nothing to score.', paths.length);
    }

    const store = storeOf(scan);
    const weights = (await getSettings()).reclaimWeights;

    // Only paths this scan actually contains can be scored: size, mtime and
    // depth all come from the tree. One absent from it is skipped, never
    // scored from thin air.
    const known: string[] = [];
    let skipped = 0;
    const idOf = new Map<string, number>();
    for (const p of paths) {
      const id = store.findByPath(p);
      if (id === -1) { skipped++; continue; }
      idOf.set(p, id);
      known.push(p);
    }
    if (known.length === 0) {
      return {
        available: true,
        values: new Map(),
        stats: { requested: paths.length, computed: 0, skipped, failed: 0 },
      };
    }

    /* ---- gather, concurrently: each of these mostly waits on a subprocess ---- */

    // A component whose weight is 0 is excluded from the score entirely
    // (`computeReclaimScore` drops it), so computing it is work that cannot
    // change the answer. Skipping it is not an optimisation bolted on top of
    // the model — it is the model's own rule, applied one step earlier.
    //
    // This is the one lever that removes whole subprocess trees rather than
    // making them faster: turning `redownloadable` off in Settings stops
    // `xattr` being spawned at all.
    const wants = (id: ReclaimComponentId): boolean => (Number(weights[id]) || 0) > 0;
    const needsLastUsed = wants('staleness');
    const needsRecoverability = wants('elsewhere');
    const needsOrigins = wants('redownloadable');

    const [inputs, lastUsed, recoverability, origins] = await Promise.all([
      scanInputsFor(scanId),
      needsLastUsed ? safely(lastUsedProvider.compute(scanId, known, signal), null) : Promise.resolve(null),
      needsRecoverability ? safely(recoverabilityProvider.compute(scanId, known, signal), null) : Promise.resolve(null),
      needsOrigins ? safely(platform().readDownloadOrigins(known), null) : Promise.resolve(null),
    ]);

    if (signal.aborted) {
      return {
        available: true,
        values: new Map(),
        stats: { requested: paths.length, computed: 0, skipped: paths.length, failed: 0 },
      };
    }

    /* ---- the duplicate picture, established once for the whole batch ---- */

    const dupes = duplicatePicture(scanId);

    const now = Date.now();
    const values = new Map<string, ReclaimScoreFactValue>();
    let failed = 0;

    for (const p of known) {
      const id = idOf.get(p)!;
      const bytes = store.size(id);
      const parts: Partial<Record<ReclaimComponentId, ComponentInput>> = {};

      /* size */
      if (wants('size')) {
        const sv = sizeValue(bytes, inputs.sizes.p50, inputs.sizes.p99);
        parts.size = sv === null
          ? { known: false, reason: 'Every file in this scan is about the same size, so size cannot rank them.' }
          : {
              known: true,
              value: sv,
              why: `${formatBytesPlain(bytes)}, against a typical ${formatBytesPlain(inputs.sizes.p50)} in this scan`,
            };
      }

      // Components whose weight is 0 are left out of `parts` entirely rather
      // than filled in with a placeholder: `computeReclaimScore` skips a
      // zero-weight component before it ever looks at its input, so an
      // absent entry and a computed one are indistinguishable to the score —
      // and an absent one costs nothing to produce.

      /* staleness */
      if (needsLastUsed) parts.staleness = stalenessOf(p, store.modifiedAt(id), lastUsed, now);

      /* regenerable */
      if (wants('regenerable')) parts.regenerable = regenerableOf(p, inputs, store.rootPath);

      /* redundant */
      if (wants('redundant')) parts.redundant = dupes.forPath(p, bytes);

      /* redownloadable */
      if (needsOrigins) parts.redownloadable = redownloadableOf(p, origins, now);

      /* elsewhere */
      if (needsRecoverability) parts.elsewhere = elsewhereOf(p, recoverability);

      const score = computeReclaimScore(parts, weights);
      if (score === null) {
        // Nothing at all could be computed. Absent from `values`, per the
        // layer's rule — a zero here would read as "worth nothing".
        failed++;
        continue;
      }
      values.set(p, score);
    }

    return {
      available: true,
      values,
      stats: { requested: paths.length, computed: values.size, skipped, failed },
    };
  },
};

/* ────────────────────────────── components ────────────────────────────── */

function stalenessOf(
  p: string,
  mtimeMs: number,
  lastUsed: FactBatch<LastUsedInfo> | null,
  now: number,
): ComponentInput {
  const info = lastUsed?.available ? lastUsed.values.get(p) : undefined;

  if (info && info.lastUsedMs !== null) {
    const age = now - info.lastUsedMs;
    const opened = info.source === 'spotlight' ? 'not opened' : 'not read';
    const count = info.useCount !== null && info.useCount > 0 ? ` (opened ${info.useCount} times in total)` : '';
    return { known: true, value: stalenessValue(age), why: `${opened} in ${humanDuration(age)}${count}` };
  }

  // §3.1 permits falling back to mtime; §1.1 forbids doing it quietly. The
  // fallback is stated in the sentence a person reads AND flagged, which
  // costs the whole score a confidence step. Without the flag the caveat
  // would be decorative — true, present, and changing nothing.
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return { known: false, reason: 'This file has no usable date, so TreeMap cannot tell how long it has been sitting there.' };
  }
  const age = now - mtimeMs;
  const because = lastUsed?.available === false && lastUsed.reason
    ? lastUsed.reason
    : 'this computer does not record when this file was last opened';
  return {
    known: true,
    value: stalenessValue(age),
    why: `not changed in ${humanDuration(age)} — ${because} so the last-changed date is used instead`,
    substituted: true,
  };
}

function regenerableOf(
  p: string,
  inputs: Awaited<ReturnType<typeof scanInputsFor>>,
  scanRoot: string,
): ComponentInput {
  if (!inputs.claims.available) {
    return { known: false, reason: inputs.claims.reason ?? 'The cleanup rules could not be read, so TreeMap cannot tell whether this rebuilds itself.' };
  }
  const claim = claimFor(inputs.claims, p);
  if (!claim) {
    // The rules ran and matched nothing. A real zero — TreeMap looked.
    return { known: true, value: 0, why: 'no cleanup rule recognises this as something that rebuilds itself' };
  }
  // `matchReasonFor` already returns a finished sentence ending in a full
  // stop, and several rule titles are just the folder name — joining them
  // with a dash produced "node_modules - A folder named node_modules.,
  // restored with npm install". Sentences, in the same voice the Smart
  // Suggestions "why" panel already uses ("Put it back with:").
  const restore = claim.restoreCommand ? ` Put it back with \`${claim.restoreCommand}\`.` : '';
  // Relative to the scan root, because the absolute form wrapped over three
  // lines of the breakdown panel and buried the sentence that matters. The
  // panel already names the file; what this line has to add is WHICH folder
  // upstream is the one that rebuilds — "alpha/node_modules", not 140
  // characters of temp directory.
  const where = claim.claimedPath === p
    ? ''
    : `It sits inside ${displayPath(claim.claimedPath, scanRoot)}, which TreeMap recognises. `;
  return {
    known: true,
    value: regenerableValue(claim.confidence),
    why: `${where}${claim.why}${restore}`,
  };
}

function redownloadableOf(
  p: string,
  origins: Awaited<ReturnType<ReturnType<typeof platform>['readDownloadOrigins']>> | null,
  now: number,
): ComponentInput {
  if (!origins || !origins.available) {
    return { known: false, reason: origins?.reason ?? 'TreeMap cannot read where files were downloaded from on this computer.' };
  }
  if (origins.unchecked.has(p)) {
    return { known: false, reason: 'The download record for this file could not be read.' };
  }
  const brief = origins.origins.get(p);
  if (!brief) {
    // Checked, and there is genuinely no record. A real zero — and the
    // mechanism is named, because "no record" means different things per OS.
    return { known: true, value: 0, why: `no download record (${origins.mechanism})` };
  }
  const who = brief.agent ? `downloaded by ${brief.agent}` : brief.host ? `downloaded from ${brief.host}` : 'downloaded';
  const when = brief.downloadedAt !== null ? ` ${humanDuration(now - brief.downloadedAt)} ago` : '';
  return { known: true, value: 1, why: `${who}${when} — you could get it again` };
}

function elsewhereOf(p: string, recoverability: FactBatch<RecoverabilityFact> | null): ComponentInput {
  if (!recoverability || !recoverability.available) {
    return { known: false, reason: recoverability?.reason ?? 'TreeMap could not check whether a copy of this exists elsewhere.' };
  }
  const fact = recoverability.values.get(p);
  if (!fact) {
    return { known: false, reason: 'TreeMap could not check whether a copy of this exists elsewhere.' };
  }
  if (fact.elsewhere === 'unknown') {
    // The single most important line in this file. `unknown` means git, the
    // backup system and the sync client all had nothing to say — it does NOT
    // mean "no copy exists". Scoring it as 0 would rank a file nobody can
    // vouch for identically to one positively known to exist nowhere else,
    // in the number people use to decide what to delete.
    const why = fact.unavailable.length > 0
      ? fact.unavailable.map((u) => u.reason).join(' ')
      : 'Nothing on this computer could say whether a copy of this exists anywhere else.';
    return { known: false, reason: why };
  }
  const why = fact.why.length > 0
    ? fact.why.map((r) => r.text).join(' ')
    : fact.elsewhere === 'none'
      ? 'nothing here holds another copy of this'
      : 'a copy exists elsewhere';
  return { known: true, value: elsewhereValue(fact.elsewhere), why };
}

/* ─────────────────────────── the duplicate picture ─────────────────────────── */

/**
 * What the duplicate finder can say about this scan right now.
 *
 * Three separate reasons the answer may be "unknown", and all three are worth
 * distinguishing because each one has a different thing the user could do:
 *
 *  - hashing has never run → open the Duplicates view;
 *  - hashing ran but skipped this file for being below its minimum size →
 *    lower the minimum;
 *  - hashing ran and found more groups than it reports (the top 500) → this
 *    file's absence from the list proves nothing.
 */
function duplicatePicture(scanId: string): { forPath: (p: string, bytes: number) => ComponentInput } {
  const job = peekDuplicateJob(scanId);

  if (!job || job.status !== 'complete' || !job.groups) {
    const reason = !job
      ? 'TreeMap has not looked for duplicates in this scan yet — open the Duplicates view to check.'
      : job.status === 'running'
        ? 'TreeMap is still looking for duplicates in this scan.'
        : job.error ?? 'The duplicate search for this scan did not finish.';
    return { forPath: () => ({ known: false, reason }) };
  }

  // Every copy except the one the group recommends keeping. The group's files
  // are sorted newest first, and the newest is the keeper — deleting IT would
  // not be reclaiming a redundant copy, it would be choosing which copy to
  // lose. So the keeper scores 0 for redundancy, not 1.
  const redundant = new Map<string, { count: number; size: number }>();
  const keepers = new Set<string>();
  for (const group of job.groups) {
    group.files.forEach((f, i) => {
      if (i === 0) keepers.add(f.path);
      else redundant.set(f.path, { count: group.count, size: group.size });
    });
  }

  const truncated = (job.groupCount ?? 0) > REPORTED_GROUPS;

  return {
    forPath: (p: string, bytes: number): ComponentInput => {
      const hit = redundant.get(p);
      if (hit) {
        return {
          known: true,
          value: 1,
          why: `${hit.count} identical copies of this exist in the scan — this is not the newest one`,
        };
      }
      if (keepers.has(p)) {
        return { known: true, value: 0, why: 'other copies of this exist, but this is the newest one — the copy to keep' };
      }
      if (bytes < job.minSize) {
        return {
          known: false,
          reason: `Files under ${formatBytesPlain(job.minSize)} were not checked for duplicates in this scan.`,
        };
      }
      if (truncated) {
        // The list is the top 500 groups by reclaimable bytes. Absence from
        // it is not evidence of anything when there are more.
        return {
          known: false,
          reason: `This scan found ${job.groupCount} groups of duplicates and TreeMap lists the largest ${REPORTED_GROUPS}, so it cannot say whether this file is in one.`,
        };
      }
      return { known: true, value: 0, why: 'no identical copy of this was found in the scan' };
    },
  };
}

/**
 * A path as it should read inside a sentence: relative to the scan root.
 *
 * Falls back to the absolute path when the two are unrelated — a claim from
 * outside the scanned tree is not something to quietly shorten into
 * ambiguity.
 */
function displayPath(target: string, scanRoot: string): string {
  if (!scanRoot) return target;
  const rel = path.relative(scanRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return target;
  return rel;
}

/**
 * Bytes for a sentence, not for a table.
 *
 * The frontend's `formatBytes` is the one the UI uses and §2.2 forbids a
 * second one there; this is server-side, where the `why` strings are built,
 * and it exists so those sentences read in plain English rather than shipping
 * a raw byte count to be formatted by something that cannot see the sentence.
 */
function formatBytesPlain(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  const shown = unit === 0 ? String(Math.round(value)) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}
