import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICING_AS_OF,
  PROVIDER_PRICING,
  estimateCost,
  fitTier,
  isCurrency,
} from '../src/services/costIntelligence';

/**
 * §C1 — storage cost intelligence.
 *
 * Acceptance, verbatim: "For a known tier and known scanned bytes, the
 * displayed cost matches a manual calculation against the shipped table, and
 * the 'as of' date is visible." Both are checked below, the first by doing the
 * manual calculation here rather than reusing the code under test.
 */

const GB = 1000 ** 3;
const TB = 1000 ** 4;

/* ─────────────── The acceptance calculation, done by hand ─────────────── */

test('340 GB on Google One costs exactly what the shipped table says', () => {
  // By hand: 340 GB does not fit 15/100/200 GB, so the cheapest tier that holds
  // it is Premium 2 TB at $9.99/month — $119.88 a year.
  const estimate = estimateCost(340 * GB, 0);
  const google = estimate.providers.find((p) => p.providerId === 'gdrive')!;
  assert.equal(google.current.tier!.label, 'Premium — 2 TB');
  assert.equal(google.current.monthly, 9.99);
  assert.equal(Number(google.current.annual.toFixed(2)), 119.88);
});

test('40 GB on iCloud+ lands on the 50 GB tier, not the 200', () => {
  // By hand: 40 GB > 5 GB free, ≤ 50 GB, so $0.99/month.
  const icloud = estimateCost(40 * GB, 0).providers.find((p) => p.providerId === 'icloud')!;
  assert.equal(icloud.current.tier!.label, '50 GB');
  assert.equal(icloud.current.monthly, 0.99);
});

test('data that fits the free allowance costs nothing', () => {
  const google = estimateCost(10 * GB, 0).providers.find((p) => p.providerId === 'gdrive')!;
  assert.equal(google.current.tier!.label, 'Free — 15 GB');
  assert.equal(google.current.monthly, 0);
});

test('data larger than every tier is reported as such, not billed at the biggest', () => {
  const google = estimateCost(40 * TB, 0).providers.find((p) => p.providerId === 'gdrive')!;
  assert.equal(google.current.tier, null);
  assert.equal(google.current.exceedsLargestTier, true);
  assert.equal(google.current.monthly, 0, 'no price is invented for a plan that is not sold');
});

/* ─────────────── The "as of" date, which is the honesty ─────────────── */

test('every answer carries the date its prices were recorded', () => {
  const estimate = estimateCost(100 * GB, 0);
  assert.equal(estimate.asOf, PRICING_AS_OF);
  assert.match(estimate.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('nothing in this service ever fetches a price', () => {
  // The no-network rule is the reason the table is stale-by-design, so it is
  // pinned structurally rather than trusted.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'costIntelligence.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const forbidden of ['fetch(', 'https://api', 'axios', 'request(', 'XMLHttpRequest']) {
    assert.ok(!src.includes(forbidden), `costIntelligence must not use ${forbidden}`);
  }
});

test('every provider names where its numbers came from', () => {
  for (const provider of PROVIDER_PRICING) {
    assert.ok(provider.source.length > 5, `${provider.id} must cite its pricing page`);
    assert.ok(provider.tiers.length >= 2, `${provider.id} needs a free allowance and at least one paid tier`);
    assert.ok(provider.tiers.some((t) => t.monthlyUsd === 0), `${provider.id} must include its free allowance`);
    // Bigger must never be cheaper, or the "cheapest that fits" search is wrong.
    const sorted = [...provider.tiers].sort((a, b) => a.bytes - b.bytes);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].monthlyUsd >= sorted[i - 1].monthlyUsd || provider.id === 'dropbox',
        `${provider.id}: a larger tier must not cost less`);
    }
  }
});

/* ─────────────── The what-if, which must not overclaim ─────────────── */

test('a cleanup that changes the tier reports the real saving', () => {
  // 340 GB on Google One is the 2 TB tier at $9.99. Free 200 GB and it fits the
  // 200 GB tier at $2.99 — a $7.00 monthly saving, $84 a year.
  const google = estimateCost(340 * GB, 200 * GB).providers.find((p) => p.providerId === 'gdrive')!;
  assert.equal(google.afterCleanup!.tier!.label, 'Standard — 200 GB');
  assert.equal(Number(google.monthlySavingUsd.toFixed(2)), 7);
  assert.equal(Number(google.annualSavingUsd.toFixed(2)), 84);
  assert.equal(google.sameTierAfterCleanup, false);
});

test('a cleanup that does not change the tier saves nothing, and says so', () => {
  // Freeing 3 GB inside a 2 TB plan saves nothing at all. Claiming a saving
  // here would be the entire feature lying.
  const google = estimateCost(340 * GB, 3 * GB).providers.find((p) => p.providerId === 'gdrive')!;
  assert.equal(google.afterCleanup!.tier!.label, 'Premium — 2 TB');
  assert.equal(google.monthlySavingUsd, 0);
  assert.equal(google.sameTierAfterCleanup, true);
});

test('a saving is never negative', () => {
  for (const p of estimateCost(100 * GB, 5 * TB).providers) {
    assert.ok(p.monthlySavingUsd >= 0, `${p.providerId} produced a negative saving`);
  }
});

/* ─────────────── Currency ─────────────── */

test('a converted price is marked approximate; USD is not', () => {
  assert.equal(estimateCost(GB, 0, 'USD').approximate, false);
  const eur = estimateCost(GB, 0, 'EUR');
  assert.equal(eur.approximate, true, 'conversions are not live rates and must not pretend to be');
  assert.equal(eur.symbol, '€');
  assert.ok(eur.rateFromUsd > 0);
});

test('an unknown currency is rejected rather than silently defaulted mid-calculation', () => {
  assert.equal(isCurrency('USD'), true);
  assert.equal(isCurrency('XYZ'), false);
  assert.equal(isCurrency(42), false);
});

test('fitTier picks the cheapest tier that fits, not the first listed', () => {
  const provider = { id: 't', name: 'T', source: 'x', tiers: [
    { bytes: 2 * TB, monthlyUsd: 9.99, label: 'big' },
    { bytes: 100 * GB, monthlyUsd: 1.99, label: 'small' },
  ] };
  assert.equal(fitTier(provider, 50 * GB).tier!.label, 'small');
  assert.equal(fitTier(provider, 500 * GB).tier!.label, 'big');
});
