import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, hash32 } from '../bench/lib/prng';
import { median, resolutionBand, spreadPct, formatMs } from '../bench/lib/stats';

/**
 * Phase 1 bench harness, Task 1: the one source of determinism and the
 * measurement arithmetic. The band rule is the one scripts/bench-v4.ts uses
 * (sigma ≈ IQR/1.349, SE of the median ≈ 1.2533·sigma/√n, band = 2·SE/median).
 */

test('the same seed yields the same sequence, a different seed a different one', () => {
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  for (const x of sa) assert.ok(x >= 0 && x < 1);
});

test('hash32 mixes both inputs', () => {
  assert.notEqual(hash32(1, 2), hash32(2, 1));
  assert.equal(hash32(5, 9), hash32(5, 9));
});

test('median of odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('spread is (max - min) / median, in percent', () => {
  assert.equal(spreadPct([100, 110, 90]), 20);
});

test('the resolution band is the two-SE IQR estimate of the median, in percent', () => {
  // seven identical runs: zero band
  assert.equal(resolutionBand([5, 5, 5, 5, 5, 5, 5]), 0);
  // a wide spread produces a wider band than a narrow one
  assert.ok(resolutionBand([90, 95, 100, 105, 110, 115, 120]) > resolutionBand([99, 99.5, 100, 100.5, 101, 101.5, 102]));
});

/* Beyond the plan's tests: the guards that keep a broken measurement from
   printing as a confident number. A single run has no resolution; a zero
   median has no percentage; an empty list is a caller bug, not a statistic. */
test('a measurement that cannot be resolved says so: one run or a non-positive median gives an infinite band and spread, an empty list is refused', () => {
  assert.equal(resolutionBand([100]), Infinity);
  assert.equal(resolutionBand([0, 0, 0]), Infinity);
  assert.equal(spreadPct([0, 0, 0]), Infinity);
  assert.throws(() => median([]), /empty/);
  assert.equal(formatMs(1234.56), '1234.6 ms');
});

test('the band is two standard errors of the median from IQR/1.349, worked by hand', () => {
  // sorted [90,95,100,105,110]: q25 95, q75 105, IQR 10, sigma 7.4129, SE 1.2533·7.4129/√5 = 4.1549, band 8.3098%
  assert.ok(Math.abs(resolutionBand([90, 95, 100, 105, 110]) - 8.3098) < 0.001);
});

test('two runs have no band either: an interquartile range needs three points', () => {
  assert.equal(resolutionBand([100, 101]), Number.POSITIVE_INFINITY);
});
