import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANG_GUARD_MS, waitFor } from './fixtures/waitFor';

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

test('waitFor fails naming what it waited for once its limit runs out, and never earlier', async () => {
  const started = Date.now();
  await assert.rejects(waitFor(() => false, 'the scan to finish', 5, 60), /the scan to finish did not happen within 60 ms/);
  assert.ok(Date.now() - started >= 60, 'not before the limit');
});

test('a condition that throws fails the wait with that error, at once', async () => {
  await assert.rejects(waitFor(() => { throw new Error('boom'); }, 'x', 1, 10_000), /boom/);
});
