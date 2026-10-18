import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir, fileTempDir } from './fixtures/dataDir';
isolatedDataDir('treemap-schedulerLaunchHold-data-');

import { updateSettings } from '../src/services/settings';
import {
  LAUNCH_HOLD_MS,
  lastTickForTests,
  setSchedulerForTests,
  startScheduler,
  stopScheduler,
  tickForTests,
} from '../src/services/scheduler';

/**
 * The owner, 17 Oct 2026: "When you open TreeMap it automatically runs a scan
 * of the entire disk." Two things started a walk the moment the app opened.
 * The page's boot restore is the page's (tests/coreScanFlow.test.ts); this is
 * the other: startScheduler ticked at once, so a schedule that came due while
 * the app was closed started its scan at launch, and so did an Autopilot
 * policy whose cooldown ran out meanwhile (runDuePolicies rides the same tick,
 * and its cooldown only says a policy is due, never when TreeMap opened).
 *
 * Both now wait LAUNCH_HOLD_MS after the scheduler starts — the server starts
 * it as it starts listening. The clock is injected and every assertion counts
 * calls: nothing here waits for time to pass.
 */

const root = fileTempDir('treemap-schedulerLaunchHold-folder-');
fs.writeFileSync(path.join(root, 'a.txt'), 'a');

/** The scheduler with a clock the test moves, and its two kinds of run counted instead of run. */
function counted(start: number) {
  let clock = start;
  const ran = { scheduled: [] as string[], policies: 0 };
  const fakes = {
    now: () => clock,
    runScheduled: async (s: { id: string }) => { ran.scheduled.push(s.id); },
    runDuePolicies: async () => { ran.policies++; return []; },
  };
  setSchedulerForTests(fakes);
  /** The same fakes with a hold of the test's own (the seam puts back every real dependency it is not handed). */
  const hold = (launchHoldMs: number) => setSchedulerForTests({ ...fakes, launchHoldMs });
  return { ran, set: (t: number) => { clock = t; }, hold };
}

test('a schedule that came due while TreeMap was closed, and Autopilot, wait LAUNCH_HOLD_MS after the scheduler starts — then run at the next tick', async () => {
  assert.equal(LAUNCH_HOLD_MS, 10 * 60_000, 'ten minutes');
  // Due since long before the app opened: last run at the epoch's first millisecond.
  await updateSettings({ schedules: [{ id: 'hold-due', path: root, intervalHours: 24, enabled: true, lastRunAt: 1 }] });
  const T0 = 1_800_000_000_000;
  const h = counted(T0);
  try {
    startScheduler();
    await lastTickForTests();
    assert.deepEqual(h.ran, { scheduled: [], policies: 0 }, 'the tick at start runs nothing: the app has just opened');
    h.set(T0 + LAUNCH_HOLD_MS - 1);
    await tickForTests();
    assert.deepEqual(h.ran, { scheduled: [], policies: 0 }, 'nor does a tick a millisecond before the hold ends');
    h.set(T0 + LAUNCH_HOLD_MS);
    await tickForTests();
    assert.deepEqual(h.ran, { scheduled: ['hold-due'], policies: 1 }, 'the first tick at the end of the hold runs the due schedule and asks Autopilot');
    h.set(T0 + LAUNCH_HOLD_MS + 60_000);
    await tickForTests();
    assert.equal(h.ran.policies, 2, 'from then on every tick asks Autopilot, whose own cooldown decides');
  } finally {
    stopScheduler();
    setSchedulerForTests(null);
    await updateSettings({ schedules: [] });
  }
});

test('the hold is counted from each start of the scheduler, and a hold of 0 (tests) runs a due schedule at the first tick', async () => {
  await updateSettings({ schedules: [{ id: 'hold-zero', path: root, intervalHours: 24, enabled: true, lastRunAt: 1 }] });
  const T0 = 1_800_000_000_000;
  const h = counted(T0);
  try {
    startScheduler();
    await lastTickForTests();
    stopScheduler();
    h.set(T0 + LAUNCH_HOLD_MS - 1);
    startScheduler(); // started again a moment before the first hold ended: its own hold begins now
    await lastTickForTests();
    h.set(T0 + LAUNCH_HOLD_MS);
    await tickForTests();
    assert.deepEqual(h.ran, { scheduled: [], policies: 0 }, 'the second start holds for its own LAUNCH_HOLD_MS');
    stopScheduler();
    h.hold(0);
    startScheduler();
    await lastTickForTests();
    assert.deepEqual(h.ran, { scheduled: ['hold-zero'], policies: 1 }, 'with no hold the first tick runs it');
  } finally {
    stopScheduler();
    setSchedulerForTests(null);
    await updateSettings({ schedules: [] });
  }
});

test('the settings sheet says when a schedule that came due while TreeMap was closed runs, in the hold\'s own minutes', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = page.indexOf('<div class="set-h" style="margin-top:22px;"><span data-icon="calendar"></span>Scheduled scans</div>');
  assert.notEqual(at, -1, 'the Scheduled scans heading is in the sheet');
  const lead = page.slice(at, page.indexOf('</div>', page.indexOf('<div class="muted"', at)));
  const minutes = LAUNCH_HOLD_MS / 60_000;
  assert.match(lead, new RegExp(`A scan that came due while TreeMap was closed runs about ${minutes} minutes after it opens, not the moment it opens\\.`), lead);
});

test('the Autopilot policy editor says the same of a policy\'s run, beside its "Run at most once every" days', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = page.indexOf('<label for="apCooldown">Run at most once every</label>');
  assert.notEqual(at, -1, 'the cooldown row is in the policy editor');
  const after = page.slice(at, page.indexOf('id="apDryRunFirst"', at));
  const minutes = LAUNCH_HOLD_MS / 60_000;
  assert.match(after, new RegExp(`<div class="muted" id="apLaunchHold"[^>]*>A run that came due while TreeMap was closed runs about ${minutes} minutes after it opens, not the moment it opens\\.</div>`), after);
});
