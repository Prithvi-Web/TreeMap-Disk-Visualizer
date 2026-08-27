/**
 * The Reclaim Score model (v4 §3.1).
 *
 * **Why this exists.** Every one of TreeMap's fifteen views sorts by size, and
 * nobody's real question is "what is biggest" — it is "what is safest to
 * delete". Those are different orderings, and the second one is the useful
 * one. A 40 GB `node_modules` in a fully-pushed repository and a 40 GB video
 * that exists nowhere else are the same rectangle on a treemap and opposite
 * answers to the only question that matters.
 *
 * Everything this file needs is already computed elsewhere: the scan supplies
 * sizes, §1.1 supplies last-opened dates, §1.2 supplies recoverability, the
 * rule packs supply regenerability, the duplicate finder supplies redundancy
 * and the provenance reader supplies origin. Nothing new is scanned. This is
 * arithmetic over facts that already exist, and it is deliberately a **pure
 * module**: no I/O, no clock of its own, no platform calls. The provider in
 * `facts/reclaimScoreProvider.ts` gathers the inputs; this file only decides
 * what they add up to, which is the part worth being able to test exactly.
 *
 * ── The rule that shapes every line below ──
 *
 * §3.2: **a missing component is never treated as zero.** A file with no
 * download record is not "less redownloadable" than one that was downloaded —
 * it is *unknown*, and a zero would be a claim nobody made. So the score is
 * computed over the components that actually answered, renormalised by their
 * own weight, and the ones that could not answer are listed by name with
 * their reasons and pull the confidence down. A file scored on two of six
 * components and a file scored on all six do not get to look alike.
 *
 * That renormalisation is the whole design. The obvious implementation —
 * multiply every weight by its value and sum, with unknowns contributing 0 —
 * silently ranks an unknown file below a known-worthless one, which is
 * exactly backwards: unknown means "TreeMap cannot tell you", and the UI has
 * to be able to say so.
 */

/** The six things a reclaim score is made of. */
export type ReclaimComponentId =
  | 'size'
  | 'staleness'
  | 'regenerable'
  | 'redundant'
  | 'redownloadable'
  | 'elsewhere';

/** Every component id, in display order. Exhaustive by construction. */
export const RECLAIM_COMPONENT_IDS: readonly ReclaimComponentId[] = [
  'size',
  'staleness',
  'regenerable',
  'redundant',
  'redownloadable',
  'elsewhere',
] as const;

/** Human labels, shown in the breakdown panel and the settings editor. */
export const RECLAIM_COMPONENT_LABELS: Record<ReclaimComponentId, string> = {
  size: 'Size',
  staleness: 'How long since it was used',
  regenerable: 'Rebuilds itself',
  redundant: 'Another copy on this disk',
  redownloadable: 'Came from somewhere',
  elsewhere: 'A copy exists elsewhere',
};

/**
 * What one component contributes — or, explicitly, why it could not.
 *
 * The two cases are separate types rather than a nullable value on purpose:
 * `known: false` carries a *reason*, and the type system will not let a
 * caller produce an unknown component without writing one. A reason that can
 * be forgotten becomes a reason that is forgotten.
 */
export type ComponentInput =
  | {
      known: true;
      /** 0–1. Clamped here, so a provider bug cannot skew a score off-scale. */
      value: number;
      /** Plain English, shown verbatim, e.g. "not opened in 2 years 3 months". */
      why: string;
      /**
       * True when this value came from a stand-in rather than the real signal
       * — today, only staleness falling back from last-opened to last-changed.
       *
       * §3.1 permits that fallback and §1.1 forbids doing it quietly, so it is
       * a flag with consequences: it is stated in `why`, and it costs the
       * whole score a confidence step. A substituted input that ranked as
       * confidently as a measured one would make the caveat decorative.
       */
      substituted?: boolean;
    }
  | { known: false; reason: string };

/** How much each component counts. 0–1 each; they do not have to sum to 1. */
export type ReclaimWeights = Record<ReclaimComponentId, number>;

/**
 * Default weights.
 *
 * These blend two different questions, because the score answers both: *is it
 * safe to delete* (elsewhere, regenerable, redundant, redownloadable) and *is
 * it worth deleting* (size, staleness). Safety carries the larger share —
 * getting "worth it" wrong wastes a moment, getting "safe" wrong loses a file.
 *
 * They sum to 1.00, which is legibility rather than arithmetic: the score
 * renormalises by whatever weight actually answered, so any set of positive
 * numbers works. Users edit these in Settings, and a score whose weights
 * cannot be inspected or changed is an oracle — §3.2 rules those out.
 */
export const DEFAULT_RECLAIM_WEIGHTS: ReclaimWeights = {
  size: 0.15,
  staleness: 0.22,
  regenerable: 0.22,
  redundant: 0.15,
  redownloadable: 0.08,
  elsewhere: 0.18,
};

/** One component, as it appears in the breakdown. */
export interface ReclaimComponent {
  id: ReclaimComponentId;
  label: string;
  /** The weight in force when this score was computed. */
  weight: number;
  /** This file's normalised value for the component, 0–1. */
  value: number;
  /** Points out of 100 this component contributed to the total. */
  contribution: number;
  why: string;
}

export type ReclaimConfidence = 'high' | 'medium' | 'low';

export interface ReclaimScoreFact {
  /** 0–100, one decimal place. Higher means safer and more worthwhile. */
  score: number;
  /** Only components that answered, in display order. */
  components: ReclaimComponent[];
  confidence: ReclaimConfidence;
  /**
   * Components that could not be computed, with the reason for each.
   *
   * Never empty when something is missing, and never populated with a zero —
   * these are the components the score did **not** include.
   */
  missing: { id: ReclaimComponentId; reason: string }[];
  /**
   * The share of the enabled weight that actually answered, 0–1.
   *
   * Published rather than kept internal because it is what `confidence`
   * means, and a UI that shows a band without the number behind it is asking
   * to be trusted rather than checked.
   */
  coverage: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0);

/** One decimal place, so two runs over the same inputs are byte-identical. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Combine component inputs into a score.
 *
 * Returns `null` when nothing could be computed — no enabled component
 * answered. That is a deliberate third outcome rather than a zero: the
 * provider drops the path from its `values` map, so it reads as "TreeMap
 * could not score this" instead of "TreeMap scored this as worthless".
 *
 * A weight of 0 removes a component from the score **entirely**: it is not
 * listed as present, not listed as missing, and does not count toward
 * coverage. Switching a component off in Settings must not look like a
 * failure to compute it.
 */
export function computeReclaimScore(
  inputs: Partial<Record<ReclaimComponentId, ComponentInput>>,
  weights: ReclaimWeights,
): ReclaimScoreFact | null {
  const components: ReclaimComponent[] = [];
  const missing: { id: ReclaimComponentId; reason: string }[] = [];

  let answeredWeight = 0;
  let enabledWeight = 0;
  let substituted = false;

  // Two passes, because `contribution` is a share of the answered weight and
  // that total is not known until every input has been seen.
  const answered: { id: ReclaimComponentId; weight: number; value: number; why: string }[] = [];

  for (const id of RECLAIM_COMPONENT_IDS) {
    const weight = Number.isFinite(weights[id]) ? Math.max(0, weights[id]) : 0;
    if (weight === 0) continue; // switched off — not part of this score at all
    enabledWeight += weight;

    const input = inputs[id];
    if (!input) {
      // A caller that simply forgot a component still has to be reported
      // honestly; silence here would be indistinguishable from a zero.
      missing.push({ id, reason: `${RECLAIM_COMPONENT_LABELS[id]} was not computed for this file.` });
      continue;
    }
    if (!input.known) {
      missing.push({ id, reason: input.reason });
      continue;
    }
    const value = clamp01(input.value);
    answeredWeight += weight;
    if (input.substituted) substituted = true;
    answered.push({ id, weight, value, why: input.why });
  }

  if (answeredWeight === 0) return null;

  let total = 0;
  for (const a of answered) {
    const contribution = round1((100 * a.weight * a.value) / answeredWeight);
    total += 100 * a.weight * a.value;
    components.push({
      id: a.id,
      label: RECLAIM_COMPONENT_LABELS[a.id],
      weight: a.weight,
      value: a.value,
      contribution,
      why: a.why,
    });
  }

  const coverage = enabledWeight === 0 ? 0 : answeredWeight / enabledWeight;

  return {
    // Computed from the unrounded total rather than by summing the rounded
    // contributions: rounding six numbers and adding them drifts from the
    // real score by up to half a point, and the breakdown would then not
    // quite add up to the badge above it.
    score: round1(total / answeredWeight),
    components,
    confidence: confidenceFor(coverage, substituted),
    missing,
    coverage: round1(coverage * 100) / 100,
  };
}

/**
 * How much of this score is actually measured.
 *
 * Bands rather than a raw fraction because the UI has to put a word next to
 * the number, and "0.63" is not a word. The substitution demotion is what
 * keeps §1.1's rule alive downstream: a staleness value standing on
 * last-changed instead of last-opened is a weaker claim, and it says so
 * without needing the reader to notice the caveat text.
 */
function confidenceFor(coverage: number, substituted: boolean): ReclaimConfidence {
  const base: ReclaimConfidence = coverage >= 0.8 ? 'high' : coverage >= 0.5 ? 'medium' : 'low';
  if (!substituted) return base;
  return base === 'high' ? 'medium' : 'low';
}

/* ------------------------- component value functions ------------------------- */

/**
 * How old is old?
 *
 * Two years maps to the top of the scale. Chosen, not tuned: it is the point
 * past which "I might still want this" stops being a common answer, and it
 * keeps the ramp readable — a file untouched for a year scores half.
 */
export const STALENESS_CEILING_DAYS = 730;

/** Age in days → 0–1, linear to the ceiling. */
export function stalenessValue(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  return clamp01(ageMs / (STALENESS_CEILING_DAYS * 86_400_000));
}

/**
 * Size → 0–1, log-scaled against **this scan's own distribution**.
 *
 * Not against a constant, and the difference is the point: 500 MB is a large
 * file in a documents folder and a rounding error in a video library. The
 * median file in the scan sits at 0 and the 99th percentile at 1, so the
 * component always spends its whole range on the tree actually in front of
 * the user.
 *
 * Log rather than linear because file sizes span nine orders of magnitude; on
 * a linear scale one 40 GB file would flatten every other file in the scan to
 * indistinguishable zero.
 */
export function sizeValue(bytes: number, p50: number, p99: number): number | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  // A distribution with no spread cannot rank anything. Returning 0.5 for
  // every file would be inventing an ordering out of nothing.
  if (!(p99 > p50)) return null;
  const lo = Math.log10(p50 + 1);
  const hi = Math.log10(p99 + 1);
  return clamp01((Math.log10(bytes + 1) - lo) / (hi - lo));
}

/**
 * A rule pack's own confidence → 0–1.
 *
 * The rule packs already grade themselves, and that grade is the honest
 * ceiling for this component: a `low`-confidence rule saying a folder
 * regenerates is not the same evidence as `npm install` restoring
 * `node_modules` exactly.
 */
export function regenerableValue(confidence: 'high' | 'medium' | 'low'): number {
  return confidence === 'high' ? 1 : confidence === 'medium' ? 0.7 : 0.4;
}

/**
 * The recoverability verdict → 0–1.
 *
 * `unknown` is absent from this table on purpose — it is not a low value, it
 * is *no value*, and the provider reports it as a missing component. Encoding
 * it here as 0 would be the single most dangerous line in the file: it would
 * rank a file nobody can vouch for identically to one positively known to
 * exist nowhere else.
 */
export function elsewhereValue(verdict: 'proven' | 'likely' | 'none'): number {
  return verdict === 'proven' ? 1 : verdict === 'likely' ? 0.6 : 0;
}

/* ------------------------------ plain English ------------------------------ */

/**
 * "2 years 3 months", "14 months", "6 days".
 *
 * Written here rather than reached for from a date library because §7 rules
 * out new dependencies, and because the phrasing is part of the product: the
 * breakdown is meant to read like a sentence a person would say.
 */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'no time at all';
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return 'less than a day';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.4375);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rem = months - years * 12;
  const y = `${years} year${years === 1 ? '' : 's'}`;
  return rem === 0 ? y : `${y} ${rem} month${rem === 1 ? '' : 's'}`;
}
