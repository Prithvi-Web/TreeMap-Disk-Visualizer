import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-forecastSpanWords-data-');

import { Snapshot } from '../src/models/types';
import { computeForecast } from '../src/services/forecast';

/**
 * The forecast's "not enough history" sentence says how long the history spans (hunt C84, C90). It
 * called anything under 0.05 days — 72 minutes — "less than an hour", so scans 65 minutes apart read
 * "over less than an hour"; and it chose "day" or "days" on the unrounded span, so two scans 24 hours
 * and 4 minutes apart read "over 1 days". The sentence reaches the Dashboard and MCP `forecast`.
 */

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function snapsAt(minutesAgo: number[]): Snapshot[] {
  return minutesAgo.map((m, i) => ({
    id: `s${i}`, rootPath: '/r', takenAt: NOW - m * MIN, totalSize: 1_000_000 + i, fileCount: 1, dirCount: 1, topEntries: [],
  }));
}

const reasonFor = (minutesAgo: number[]): string => computeForecast(snapsAt(minutesAgo), 10_000_000, NOW).reason ?? '';

test('a span of an hour or more is never called "less than an hour"', () => {
  for (const span of [60, 65, 71]) {
    const reason = reasonFor([span, 0]);
    assert.doesNotMatch(reason, /less than an hour/, `${span} minutes: ${reason}`);
    assert.match(reason, /2 scans over about 1 hour\./, `${span} minutes: ${reason}`);
  }
  assert.match(reasonFor([59, 0]), /2 scans over less than an hour\./);
});

test('a span under a day is said in hours, the plural chosen on the figure shown', () => {
  assert.match(reasonFor([150, 0]), /2 scans over about 3 hours\./);
  assert.match(reasonFor([23 * 60 + 56, 0]), /2 scans over 1 day\./, 'rounds to a day: said as one');
});

test('"day" or "days" is chosen on the rounded figure: 24 hours and 4 minutes is "1 day", never "1 days"', () => {
  const reason = reasonFor([24 * 60 + 4, 0]);
  assert.match(reason, /2 scans over 1 day\./, reason);
  assert.doesNotMatch(reason, /1 days/, reason);
  assert.match(reasonFor([36 * 60, 0]), /2 scans over 1\.5 days\./);
});
