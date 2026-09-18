import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMachine } from '../bench/lib/machine';
import { snapshotUsage, diffUsage } from '../bench/lib/rusage';

/**
 * The benchmark harness records every number with the conditions it was taken
 * under. Two modules supply those conditions: the machine record (what the
 * hardware, OS, Node and commit were) and the usage snapshot (what the process
 * itself consumed). What is pinned here is honesty, not magnitude: a snapshot
 * either carries bytes read or says why it cannot, and a difference between
 * two snapshots is never negative — a counter that went backwards is a bug in
 * the measurement, and the harness refuses to print it as a result.
 */

test('the machine record names what every number depends on', async () => {
  const m = await describeMachine();
  assert.ok(m.cpuModel.length > 0);
  assert.ok(m.cores >= 1);
  assert.ok(m.memoryBytes > 0);
  assert.equal(typeof m.platform, 'string');
  assert.match(m.node, /^v\d+/);
  assert.match(m.commit, /^[0-9a-f]{7,40}$|^unknown$/);
  assert.ok(['A', 'B', 'C'].includes(m.tier));
  if (process.platform === 'darwin') assert.ok((m.maxVnodes ?? 0) > 0);
});

test('a usage snapshot carries CPU seconds and peak RSS, and either bytes read or a stated reason', async () => {
  const s = await snapshotUsage();
  assert.ok(s.cpuSeconds >= 0);
  assert.ok(s.peakRssBytes > 0);
  if (s.bytesRead === null) assert.ok(s.bytesReadReason.length > 10);
  else assert.ok(s.bytesRead >= 0);
});

test('diffUsage never reports a negative delta', async () => {
  const a = await snapshotUsage();
  const b = await snapshotUsage();
  const d = diffUsage(a, b);
  assert.ok(d.cpuSeconds >= 0);
  if (d.bytesRead !== null) assert.ok(d.bytesRead >= 0);
});

test('diffUsage throws when a counter went backwards instead of reporting a negative number', async () => {
  const a = await snapshotUsage();
  assert.throws(
    () => diffUsage({ ...a, cpuSeconds: 9 }, { ...a, cpuSeconds: 1 }),
    /usage went backwards/,
  );
});
