import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The size of the burst a boot fires at the server.
 *
 * Recorded from the browser's own performance timeline: a page load makes ~25
 * API requests, and `/api/platform/topology` is in there TWICE, 160 ms apart —
 * once for the Disk Layout card, once for Drive Health, which reads a device
 * name out of the same answer. That endpoint spawns `diskutil`/`lsblk`, at ~90
 * ms a call, so the duplicate cost the first paint ~90 ms of a child process
 * and a second token of the strict rate limit for an answer already on hand.
 *
 * The fix shares one in-flight (or just-landed) answer between the two cards.
 * The sharing window is the thing that has to be right, so it is exercised as
 * a function against a stubbed clock rather than matched as text.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

type Answer = (force?: boolean) => Promise<unknown>;

/**
 * The real `topologyAnswer` from the shipped page, wired to a stub fetcher and
 * a clock the test moves by hand. `Date` is shadowed inside the wrapper so the
 * function's own `Date.now()` reads the stub.
 */
function harness(): { answer: Answer; calls: string[]; tick: (ms: number) => void; fail: (e: Error | null) => void } {
  const src = slice('const TOPOLOGY_SHARE_MS', 'async function loadTopology(');
  const calls: string[] = [];
  const clock = { t: 1_000_000 };
  const failure: { e: Error | null } = { e: null };
  const api = (url: string): Promise<unknown> => {
    calls.push(url);
    return failure.e ? Promise.reject(failure.e) : Promise.resolve({ physicalDisks: [], logicalVolumes: [] });
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('api', 'clock', `'use strict';
    const Date = { now: () => clock.t };
    ${src}
    return topologyAnswer;`) as (a: unknown, c: unknown) => Answer;
  return {
    answer: factory(api, clock),
    calls,
    tick: (ms: number) => { clock.t += ms; },
    fail: (e: Error | null) => { failure.e = e; },
  };
}

test('two cards asking for the disk layout in one paint make one request', async () => {
  const h = harness();
  const first = h.answer();
  h.tick(160); // the measured gap between the two cards
  const second = h.answer();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.calls.length, 1, 'the layout is read once, not once per card');
  assert.equal(a, b, 'and both cards get the same answer object, not two readings');
});

test('past one paint the layout is read again — this shares an answer, it does not cache one', async () => {
  const h = harness();
  await h.answer();
  h.tick(3001);
  await h.answer();
  assert.equal(h.calls.length, 2, 'a later paint must not be handed a stale disk layout');
});

test('a control that means "look again" always looks again', async () => {
  const h = harness();
  await h.answer();
  h.tick(10);
  await h.answer(true);
  assert.equal(h.calls.length, 2, 'force bypasses the share window entirely');
});

test('a failed read is never shared — the next caller gets a real attempt', async () => {
  const h = harness();
  h.fail(new Error('diskutil exited 1'));
  await assert.rejects(h.answer(), /diskutil exited 1/);
  // Settle the internal catch before the next call looks at the shared slot.
  await Promise.resolve();
  await Promise.resolve();
  h.fail(null);
  h.tick(10);
  await h.answer();
  assert.equal(h.calls.length, 2, 'a card must not inherit another card’s failure');
});

test('the Disk Layout card reads fresh, and Drive Health rides its answer', () => {
  // Which side forces matters: the card is what the re-check and refresh
  // buttons drive, so it must never be handed a shared answer; Drive Health
  // only wants a device name out of a layout it does not own.
  const load = slice('async function loadTopology(', 'function renderTopologyBlocked(');
  assert.match(load, /topologyAnswer\(true\)/, 'the card always re-reads');
  assert.doesNotMatch(load, /api\('\/api\/platform\/topology'\)/, 'and does not bypass the shared reader');

  const health = slice('async function loadDriveHealth(', 'function renderDriveHealth(');
  assert.match(health, /topologyAnswer\(\)/, 'Drive Health shares whatever the card just read');
  assert.doesNotMatch(health, /api\('\/api\/platform\/topology'\)/, 'and never issues its own second read');
});
