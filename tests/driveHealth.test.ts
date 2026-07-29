import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlook, projectWearExhaustion, getDriveHealth } from '../src/services/driveHealthMonitor';
import { SmartInfo } from '../src/platform/types';
import { ForecastResult } from '../src/models/types';

/**
 * §C4 — SMART health.
 *
 * Acceptance: "On real hardware with SMART support, correct attributes on all
 * three OSes; on unsupported hardware, an explicit can't-know state."
 *
 * smartctl is NOT installed on this machine, so the can't-know half is the one
 * that runs for real here — and it is the half most likely to be got wrong, so
 * that is fortunate rather than a gap. The attribute mapping itself is covered
 * by the platform suite (`mapSmartctl`).
 *
 * The rule every test below defends: **report, never editorialise.** A false
 * "your drive is dying" is a serious harm.
 */

function smart(over: Partial<SmartInfo> = {}): SmartInfo {
  return {
    devicePath: '/dev/disk0',
    modelName: 'APPLE SSD AP1024Z',
    serialRedacted: true,
    percentageUsed: null,
    powerOnHours: null,
    reallocatedSectors: null,
    selfAssessmentPassed: null,
    temperatureCelsius: null,
    attributes: [],
    ...over,
  };
}

function forecast(over: Partial<ForecastResult> = {}): ForecastResult {
  return {
    path: '/', status: 'ok', fullInDays: 400, confidence: 0.8, bytesPerDay: 1e9,
    freeBytes: 4e11, snapshotCount: 12, spanDays: 30, topGrowers: [], ...over,
  };
}

/* ─────────────── Wear projection ─────────────── */

test('wear is projected from the drive’s own indicator and power-on hours', () => {
  // 10% used over 8,760 hours (a year) ⇒ the remaining 90% takes nine more.
  const days = projectWearExhaustion(smart({ percentageUsed: 10, powerOnHours: 8760 }));
  assert.ok(days !== null);
  assert.equal(Math.round(days / 365), 9);
});

test('wear is not projected from numbers that cannot support it', () => {
  // Each of these would otherwise produce a confident "never" or an infinity.
  assert.equal(projectWearExhaustion(smart({ percentageUsed: null, powerOnHours: 8760 })), null, 'no indicator');
  assert.equal(projectWearExhaustion(smart({ percentageUsed: 10, powerOnHours: null })), null, 'no hours');
  assert.equal(projectWearExhaustion(smart({ percentageUsed: 0, powerOnHours: 8760 })), null, 'no measurable wear yet');
  assert.equal(projectWearExhaustion(smart({ percentageUsed: 10, powerOnHours: 0 })), null, 'brand new');
  assert.equal(projectWearExhaustion(smart({ percentageUsed: 100, powerOnHours: 8760 })), 0, 'already at the rating');
});

/* ─────────────── The correlation, which is the point of C4 ─────────────── */

test('when space runs out first, the summary says so', () => {
  const outlook = buildOutlook(smart({ percentageUsed: 2, powerOnHours: 8760 }), forecast({ fullInDays: 120 }));
  assert.equal(outlook.firstLimit, 'space');
  assert.match(outlook.summary, /runs out of space in about 4 months/);
  assert.match(outlook.summary, /space is the limit you reach first/);
});

test('when wear runs out first, the summary says that instead', () => {
  const outlook = buildOutlook(smart({ percentageUsed: 80, powerOnHours: 8760 }), forecast({ fullInDays: 3000 }));
  assert.equal(outlook.firstLimit, 'wear');
  assert.match(outlook.summary, /wear limit arrives first/);
});

test('one figure alone is stated as one figure, never completed by a guess', () => {
  const noWear = buildOutlook(smart(), forecast({ fullInDays: 200 }));
  assert.equal(noWear.wearExhaustedInDays, null);
  assert.equal(noWear.firstLimit, null, 'no winner can be declared between one number and nothing');
  assert.match(noWear.summary, /no wear indicator/);

  const noForecast = buildOutlook(smart({ percentageUsed: 10, powerOnHours: 8760 }), forecast({ status: 'insufficient', fullInDays: undefined }));
  assert.equal(noForecast.spaceFullInDays, null);
  assert.match(noForecast.summary, /not enough scan history/);

  const neither = buildOutlook(null, null);
  assert.equal(neither.firstLimit, null);
  assert.match(neither.summary, /Neither figure can be projected yet/);
});

test('nothing anywhere renders a verdict about the drive', () => {
  // The specific harm §C4 names. Every phrasing the module can emit is checked
  // against the vocabulary that would scare someone into buying hardware.
  const cases = [
    buildOutlook(smart({ percentageUsed: 99, powerOnHours: 40000, reallocatedSectors: 900, selfAssessmentPassed: false }), forecast({ fullInDays: 5 })),
    buildOutlook(smart({ percentageUsed: 1, powerOnHours: 10 }), forecast()),
    buildOutlook(null, null),
  ];
  for (const outlook of cases) {
    for (const word of ['failing', 'dying', 'imminent', 'urgent', 'replace it', 'back up now', 'critical']) {
      assert.ok(!outlook.summary.toLowerCase().includes(word), `summary must not say "${word}": ${outlook.summary}`);
    }
  }
});

/* ─────────────── The can't-know state, which is what this machine has ─────────────── */

test('a machine without smartctl gets an explicit reason and a way to fix it', async () => {
  const result = await getDriveHealth('/dev/disk0', null);
  if (result.available) return; // a machine that does have it answers for real
  assert.equal(result.smart, null);
  assert.ok(result.reason, 'silence is not an option');
  assert.ok(result.reason.length > 30, 'and the reason must be a sentence, not a code');
  assert.ok(result.mechanism, 'the mechanism that would have been used is still named');
  assert.ok(result.outlook, 'the forecast half is still answered');
});

test('no device named is a distinct answer from no smartctl', async () => {
  const result = await getDriveHealth(null, null);
  assert.equal(result.available, false);
  assert.ok(result.reason);
  assert.equal(result.devicePath, null);
});

test('the drive’s own self-assessment is passed through untouched', () => {
  // Whatever the device says about itself is the device's statement, not ours.
  for (const verdict of [true, false, null]) {
    const info = smart({ selfAssessmentPassed: verdict });
    assert.equal(info.selfAssessmentPassed, verdict);
  }
});
