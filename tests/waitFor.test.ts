import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANG_GUARD_MS, HangGuardExpired, waitFor, withinHangGuard, type WaitClock } from './fixtures/waitFor';
import { watchBrings } from './fixtures/watchReady';

/**
 * The one wait every test uses for work to finish: a guard against hanging,
 * never a measurement. With every core of this Mac busy, 52 tests failed on
 * deadlines sized to a fast machine (24 Sep 2026); a guard only has to end a
 * run that would otherwise never end.
 */

test('the hang guard is generous: minutes, not the seconds a fast machine needs', () => {
  assert.ok(HANG_GUARD_MS >= 60_000, `${HANG_GUARD_MS} ms`);
});

test('waitFor resolves as soon as the condition holds, sync or async', async () => {
  let calls = 0;
  await waitFor(() => ++calls >= 3, 'three calls', 1);
  assert.equal(calls, 3);
  let asyncCalls = 0;
  await waitFor(async () => ++asyncCalls >= 2, 'two async calls', 1);
  assert.equal(asyncCalls, 2);
});

/** A clock of the test's own: time passes only when waitFor waits, so its polls are counted, never timed. */
function steppedClock(): { clock: WaitClock; slept: number[]; elapsed: () => number } {
  let now = 1_000;
  const slept: number[] = [];
  return {
    clock: { now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } },
    slept,
    elapsed: () => now - 1_000,
  };
}

test('waitFor fails naming what it waited for once its limit runs out, and never earlier', async () => {
  const { clock, slept, elapsed } = steppedClock();
  let polls = 0;
  await assert.rejects(
    waitFor(() => { polls++; return false; }, 'the scan to finish', 5, 60, clock),
    (err: unknown) => err instanceof HangGuardExpired && /the scan to finish did not happen within 60 ms/.test(err.message),
  );
  assert.equal(polls, 13, 'asked at 0, 5, … 60 ms on its clock: the thirteenth answer is the one at the limit');
  assert.deepEqual(slept, Array<number>(12).fill(5), 'a wait of pollMs between answers, and none after the last');
  assert.equal(elapsed(), 60, 'it gave up at the limit, not before it');
});

test('an answer that comes at the limit still counts', async () => {
  const { clock } = steppedClock();
  let polls = 0;
  await waitFor(() => ++polls === 13, 'the thirteenth answer', 5, 60, clock);
  assert.equal(polls, 13, 'the condition is asked before the limit is');
});

test('a condition that throws fails the wait with that error, at once', async () => {
  await assert.rejects(waitFor(() => { throw new Error('boom'); }, 'x', 1, 10_000), (err: unknown) => !(err instanceof HangGuardExpired) && /boom/.test((err as Error).message));
});

test('watchBrings answers false only when the hang guard ran out, so a silent watch is triaged, and a condition that throws still fails', async () => {
  const { clock, slept } = steppedClock();
  assert.equal(await watchBrings(() => false, 'a change that never lands', clock), false);
  assert.equal(slept.reduce((sum, ms) => sum + ms, 0), HANG_GUARD_MS, 'it gave up at the hang guard and no sooner');
  let polls = 0;
  assert.equal(await watchBrings(() => ++polls === 3, 'a change that lands', steppedClock().clock), true);
  assert.equal(polls, 3);
  await assert.rejects(watchBrings(() => { throw new Error('the index is closed'); }, 'x', steppedClock().clock), /the index is closed/);
});

test('withinHangGuard hands back what the promise settles with, and names a promise that never settles', async () => {
  assert.equal(await withinHangGuard(Promise.resolve(42), 'an answer'), 42);
  await assert.rejects(withinHangGuard(Promise.reject(new Error('the shard failed')), 'a failure'), /the shard failed/);
  await assert.rejects(
    withinHangGuard(new Promise<never>(() => undefined), 'a shard that never ends', 5),
    (err: unknown) => err instanceof HangGuardExpired && /a shard that never ends did not happen within 5 ms/.test(err.message),
  );
});
