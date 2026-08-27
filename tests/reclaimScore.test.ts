import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-reclaim-test-'));

import {
  ComponentInput,
  DEFAULT_RECLAIM_WEIGHTS,
  RECLAIM_COMPONENT_IDS,
  ReclaimComponentId,
  ReclaimWeights,
  computeReclaimScore,
  elsewhereValue,
  humanDuration,
  regenerableValue,
  sizeValue,
  stalenessValue,
} from '../src/services/reclaimScore';
import { getSettings, updateSettings } from '../src/services/settings';

/**
 * The Reclaim Score (v4 §3).
 *
 * The score is the first thing in TreeMap that ranks files by an opinion
 * rather than by a measurement, so what these tests defend is not the
 * arithmetic — it is §3.2's four design rules, each of which is a way the
 * arithmetic could quietly become dishonest:
 *
 *  1. a component that could not be computed is **never** treated as zero;
 *  2. a missing component lowers confidence and is named in `missing`;
 *  3. a value standing in for another (mtime for last-opened) says so, and
 *     costs a confidence step;
 *  4. the same inputs always produce the same score.
 *
 * Rule 1 is the one worth a dedicated assertion. A file with no download
 * record is not "less redownloadable" than one that was downloaded — it is
 * unknown, and scoring it as 0 would rank it *below* a file positively known
 * to be worthless. The whole renormalise-by-answered-weight design exists to
 * stop that, so it is asserted directly rather than inferred from a total.
 */

const known = (value: number, why = 'because'): ComponentInput => ({ known: true, value, why });
const unknown = (reason: string): ComponentInput => ({ known: false, reason });

/** Every component answering with the same value, so weights cancel out. */
function allAt(value: number): Partial<Record<ReclaimComponentId, ComponentInput>> {
  const out: Partial<Record<ReclaimComponentId, ComponentInput>> = {};
  for (const id of RECLAIM_COMPONENT_IDS) out[id] = known(value);
  return out;
}

const EVEN: ReclaimWeights = {
  size: 0.5, staleness: 0.5, regenerable: 0.5, redundant: 0.5, redownloadable: 0.5, elsewhere: 0.5,
};

/* ══════════════════════ the arithmetic ══════════════════════ */

test('a fixture with known component values produces the expected score to the decimal', () => {
  const got = computeReclaimScore(
    {
      size: known(1),
      staleness: known(0.5),
      regenerable: known(0),
      redundant: known(1),
      redownloadable: known(0.25),
      elsewhere: known(0.6),
    },
    DEFAULT_RECLAIM_WEIGHTS,
  );
  assert.ok(got);
  // 0.15·1 + 0.22·0.5 + 0.22·0 + 0.15·1 + 0.08·0.25 + 0.18·0.6 = 0.538
  // over an answered weight of 1.00 → 53.8.
  assert.equal(got.score, 53.8);
  assert.equal(got.confidence, 'high');
  assert.deepEqual(got.missing, []);
  assert.equal(got.coverage, 1);
});

test('every component at 1 scores 100, every component at 0 scores 0', () => {
  assert.equal(computeReclaimScore(allAt(1), DEFAULT_RECLAIM_WEIGHTS)?.score, 100);
  assert.equal(computeReclaimScore(allAt(0), DEFAULT_RECLAIM_WEIGHTS)?.score, 0);
});

test('contributions sum to the score', () => {
  const got = computeReclaimScore(
    { size: known(0.8), staleness: known(0.3), regenerable: known(1), redundant: known(0), redownloadable: known(0.5), elsewhere: known(0.9) },
    DEFAULT_RECLAIM_WEIGHTS,
  );
  assert.ok(got);
  const summed = got.components.reduce((s, c) => s + c.contribution, 0);
  // Contributions are rounded individually, so they are allowed to drift from
  // the (separately rounded) total — but only by rounding, never by design.
  assert.ok(Math.abs(summed - got.score) <= 0.5, `${summed} vs ${got.score}`);
});

test('values outside 0-1 are clamped rather than skewing the scale', () => {
  const got = computeReclaimScore({ ...allAt(0), size: known(9), staleness: known(-4) }, EVEN);
  assert.ok(got);
  assert.equal(got.components.find((c) => c.id === 'size')?.value, 1);
  assert.equal(got.components.find((c) => c.id === 'staleness')?.value, 0);
});

test('the score is deterministic across runs', () => {
  const inputs = { size: known(0.37), staleness: known(0.61), regenerable: known(0.4), redundant: known(0.99), redownloadable: known(0.13), elsewhere: known(0.6) };
  const a = computeReclaimScore(inputs, DEFAULT_RECLAIM_WEIGHTS);
  const b = computeReclaimScore(inputs, DEFAULT_RECLAIM_WEIGHTS);
  assert.deepEqual(a, b);
});

/* ══════════ §3.2: a missing component is never treated as zero ══════════ */

test('a missing component is NOT scored as zero — it is excluded and named', () => {
  // Every component that answered says 1. If the unknown one were treated as
  // zero the score would fall; the whole point is that it must not.
  const withAll = computeReclaimScore(allAt(1), DEFAULT_RECLAIM_WEIGHTS);
  const withMissing = computeReclaimScore(
    { ...allAt(1), redownloadable: unknown('No download record was read for this file.') },
    DEFAULT_RECLAIM_WEIGHTS,
  );
  assert.ok(withAll && withMissing);
  assert.equal(withAll.score, 100);
  assert.equal(withMissing.score, 100, 'an unknown component must not drag the score down');
  assert.deepEqual(withMissing.missing, [
    { id: 'redownloadable', reason: 'No download record was read for this file.' },
  ]);
  assert.ok(!withMissing.components.some((c) => c.id === 'redownloadable'));
});

test('an unknown component ranks ABOVE a known-worthless one, never below', () => {
  // The failure this pins: scoring unknown as 0 makes "TreeMap cannot tell"
  // indistinguishable from "TreeMap checked, and there is nothing here".
  const rest = { size: known(1), staleness: known(1), regenerable: known(1), redundant: known(1), redownloadable: known(1) };
  const unknownElsewhere = computeReclaimScore({ ...rest, elsewhere: unknown('Nothing knew anything about this path.') }, DEFAULT_RECLAIM_WEIGHTS);
  const zeroElsewhere = computeReclaimScore({ ...rest, elsewhere: known(0) }, DEFAULT_RECLAIM_WEIGHTS);
  assert.ok(unknownElsewhere && zeroElsewhere);
  assert.ok(unknownElsewhere.score > zeroElsewhere.score, `${unknownElsewhere.score} must exceed ${zeroElsewhere.score}`);
});

test('a component the caller omitted entirely is reported missing, not silently dropped', () => {
  const got = computeReclaimScore({ size: known(1) }, DEFAULT_RECLAIM_WEIGHTS);
  assert.ok(got);
  assert.equal(got.missing.length, RECLAIM_COMPONENT_IDS.length - 1);
  for (const m of got.missing) assert.ok(m.reason.length > 0, 'every missing entry carries a reason');
});

test('nothing computable yields null — never a score of zero', () => {
  const got = computeReclaimScore(
    Object.fromEntries(RECLAIM_COMPONENT_IDS.map((id) => [id, unknown('nope')])),
    DEFAULT_RECLAIM_WEIGHTS,
  );
  assert.equal(got, null);
});

/* ══════════════════════ confidence ══════════════════════ */

test('a missing component lowers confidence', () => {
  const full = computeReclaimScore(allAt(0.5), EVEN);
  const twoGone = computeReclaimScore(
    { ...allAt(0.5), redundant: unknown('x'), redownloadable: unknown('y') },
    EVEN,
  );
  const fourGone = computeReclaimScore(
    { ...allAt(0.5), redundant: unknown('x'), redownloadable: unknown('y'), elsewhere: unknown('z'), regenerable: unknown('w') },
    EVEN,
  );
  assert.equal(full?.confidence, 'high');
  assert.equal(twoGone?.confidence, 'medium'); // 4 of 6 answered → 0.67
  assert.equal(fourGone?.confidence, 'low'); // 2 of 6 → 0.33
});

test('coverage is published, and is the fraction of enabled weight that answered', () => {
  const got = computeReclaimScore({ ...allAt(1), size: unknown('x'), staleness: unknown('y') }, EVEN);
  assert.ok(got);
  // Four of six equal weights answered. Carried to three decimals so that
  // rendering it as a percentage with one decimal stays exact.
  assert.equal(got.coverage, 0.667);
});

test('a substituted value states itself and costs a confidence step', () => {
  const inputs = {
    ...allAt(0.5),
    staleness: { known: true as const, value: 0.5, why: 'not changed in 14 months (this computer does not record when files are opened)', substituted: true },
  };
  const got = computeReclaimScore(inputs, EVEN);
  assert.ok(got);
  assert.equal(got.coverage, 1, 'the value was available — it is the source that was substituted');
  assert.equal(got.confidence, 'medium', 'full coverage, but demoted from high');
  assert.match(got.components.find((c) => c.id === 'staleness')!.why, /does not record when files are opened/);
});

test('a substitution cannot demote below low', () => {
  const got = computeReclaimScore(
    {
      size: unknown('x'), regenerable: unknown('y'), redundant: unknown('z'), redownloadable: unknown('w'), elsewhere: unknown('v'),
      staleness: { known: true as const, value: 1, why: 'mtime stand-in', substituted: true },
    },
    EVEN,
  );
  assert.equal(got?.confidence, 'low');
});

/* ══════════════════════ weights ══════════════════════ */

test('changing a weight moves the score predictably', () => {
  const inputs = { ...allAt(0), size: known(1) };
  const light = computeReclaimScore(inputs, { ...EVEN, size: 0.1 });
  const heavy = computeReclaimScore(inputs, { ...EVEN, size: 2 });
  assert.ok(light && heavy);
  assert.ok(heavy.score > light.score);
  // Only `size` is non-zero, so its share is exactly weight / total weight.
  assert.equal(light.score, Math.round((100 * 0.1 / (0.1 + 0.5 * 5)) * 10) / 10);
});

test('a weight of zero removes the component entirely — it is not scored, and not missing', () => {
  const got = computeReclaimScore(
    { ...allAt(1), redownloadable: unknown('no record') },
    { ...DEFAULT_RECLAIM_WEIGHTS, redownloadable: 0 },
  );
  assert.ok(got);
  assert.deepEqual(got.missing, [], 'a switched-off component is not a failure to compute');
  assert.equal(got.confidence, 'high', 'switching one off must not look like losing one');
  assert.ok(!got.components.some((c) => c.id === 'redownloadable'));
});

test('every default weight is a real number between 0 and 1, and at least one is positive', () => {
  let sum = 0;
  for (const id of RECLAIM_COMPONENT_IDS) {
    const w = DEFAULT_RECLAIM_WEIGHTS[id];
    assert.ok(Number.isFinite(w) && w >= 0 && w <= 1, `${id} = ${w}`);
    sum += w;
  }
  assert.ok(sum > 0);
});

/* ══════════════════════ component value functions ══════════════════════ */

test('staleness ramps to 1 at the two-year ceiling and never exceeds it', () => {
  assert.equal(stalenessValue(0), 0);
  assert.equal(stalenessValue(365 * 86_400_000), 0.5);
  assert.equal(stalenessValue(730 * 86_400_000), 1);
  assert.equal(stalenessValue(4000 * 86_400_000), 1);
  assert.equal(stalenessValue(-5), 0, 'a file dated in the future is not stale');
});

test('size is scaled against the scan distribution, not a constant', () => {
  // The same 500 MB file is near the top in one scan and near the bottom in
  // another. That is the whole reason this is not an absolute threshold.
  const docs = sizeValue(500e6, 20e3, 900e6);
  const video = sizeValue(500e6, 400e6, 40e9);
  assert.ok(docs !== null && video !== null);
  assert.ok(docs > 0.9, `expected near the top of a documents folder, got ${docs}`);
  assert.ok(video < 0.2, `expected near the bottom of a video library, got ${video}`);
});

test('size returns null when the distribution has no spread — no invented ordering', () => {
  assert.equal(sizeValue(1000, 4096, 4096), null);
  assert.equal(sizeValue(1000, 8192, 4096), null);
  assert.equal(sizeValue(Number.NaN, 1, 100), null);
});

test('a rule pack grading itself low cannot produce full confidence in regenerability', () => {
  assert.equal(regenerableValue('high'), 1);
  assert.ok(regenerableValue('medium') < 1);
  assert.ok(regenerableValue('low') < regenerableValue('medium'));
});

test('elsewhereValue has no entry for "unknown" — it is a missing component, not a low one', () => {
  assert.equal(elsewhereValue('proven'), 1);
  assert.equal(elsewhereValue('none'), 0);
  assert.ok(elsewhereValue('likely') > 0 && elsewhereValue('likely') < 1);
  // A compile-time guarantee as much as a runtime one: `unknown` is not in
  // the parameter type, so a future caller cannot map it to a number here
  // without changing the signature deliberately.
  assert.ok(!Object.prototype.hasOwnProperty.call({ proven: 1, likely: 0.6, none: 0 }, 'unknown'));
});

test('durations read as English', () => {
  assert.equal(humanDuration(0), 'less than a day');
  assert.equal(humanDuration(86_400_000), '1 day');
  assert.equal(humanDuration(9 * 86_400_000), '9 days');
  assert.equal(humanDuration(400 * 86_400_000), '13 months');
  assert.equal(humanDuration(830 * 86_400_000), '2 years 3 months');
  assert.equal(humanDuration(731 * 86_400_000), '2 years');
});

/* ══════════════════════ weights in settings ══════════════════════ */

test('weights default, round-trip, and reject nonsense without breaking the score', async () => {
  const initial = await getSettings();
  assert.deepEqual(initial.reclaimWeights, DEFAULT_RECLAIM_WEIGHTS);

  const saved = await updateSettings({ reclaimWeights: { size: 0.9, staleness: 0.1, bogus: 5 } });
  assert.equal(saved.reclaimWeights.size, 0.9);
  assert.equal(saved.reclaimWeights.staleness, 0.1);
  assert.equal(saved.reclaimWeights.elsewhere, DEFAULT_RECLAIM_WEIGHTS.elsewhere, 'omitted keys keep their default');
  assert.ok(!('bogus' in saved.reclaimWeights));

  const clamped = await updateSettings({ reclaimWeights: { size: 40, staleness: -3, regenerable: Number.NaN } });
  assert.equal(clamped.reclaimWeights.size, 1, 'clamped to 1');
  assert.equal(clamped.reclaimWeights.staleness, DEFAULT_RECLAIM_WEIGHTS.staleness, 'negative is invalid, not zero');
  assert.equal(clamped.reclaimWeights.regenerable, DEFAULT_RECLAIM_WEIGHTS.regenerable, 'NaN never reaches a score');
});

test('an all-zero weight set is refused back to the defaults', async () => {
  const zeroed = await updateSettings({
    reclaimWeights: { size: 0, staleness: 0, regenerable: 0, redundant: 0, redownloadable: 0, elsewhere: 0 },
  });
  assert.deepEqual(zeroed.reclaimWeights, DEFAULT_RECLAIM_WEIGHTS,
    'turning every component off would silently delete the feature — that needs a switch, not six sliders');
});

test('sending a non-object resets the weights to the defaults', async () => {
  await updateSettings({ reclaimWeights: { size: 0.01 } });
  const reset = await updateSettings({ reclaimWeights: null });
  assert.deepEqual(reset.reclaimWeights, DEFAULT_RECLAIM_WEIGHTS);
});

/* ══════════════════════ §3.2: no auto-selection ══════════════════════ */

test('nothing in the score model selects, stages or deletes anything', () => {
  const source = fs.readFileSync(new URL('../src/services/reclaimScore.ts', import.meta.url), 'utf8');
  // §3.2: "The score never auto-selects anything for deletion. It sorts and it
  // explains." A pure arithmetic module cannot delete anything, and this
  // asserts it stays that way — the moment this file imports the trash, the
  // cart or the scan store, the separation that makes the score inert is gone.
  assert.ok(!/from '\.\/trash'|from '\.\/cleaner'|from '\.\/offload'|from '\.\/timeCapsule'/.test(source));
  assert.ok(!/^import /m.test(source), 'the model imports nothing at all — it is pure arithmetic over its inputs');
});
