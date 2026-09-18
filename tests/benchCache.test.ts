import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheState, defaultPurge, PURGE_PROCEDURES } from '../bench/lib/cache';

/**
 * Phase 1 bench harness, Task 3: a run is labelled cold only when the purge
 * procedure itself succeeded; warm needs a warm-up pass and, on macOS, a tree
 * that fits inside kern.maxvnodes; anything else is said out loud.
 *
 * Every test injects its purge. `defaultPurge()` is never called for this
 * machine's platform here: with a cached sudo ticket it would really flush
 * the owner's disk cache, and a unit test has no business doing that.
 */

test('a run is labelled cold only when the purge procedure itself succeeded', async () => {
  const ok = await cacheState({ requested: 'cold', purge: async () => ({ ok: true, command: 'sudo -n purge' }), entries: 1000, maxVnodes: 250000, warmedUp: false });
  assert.equal(ok.state, 'cold');
  const failed = await cacheState({ requested: 'cold', purge: async () => ({ ok: false, command: 'sudo -n purge', error: 'a password is required' }), entries: 1000, maxVnodes: 250000, warmedUp: false });
  assert.equal(failed.state, 'unknown');
  assert.match(failed.reason, /password/);
});

test('warm needs a warm-up pass and a tree that fits the vnode cache', async () => {
  const warm = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 200_000, maxVnodes: 251_127, warmedUp: true });
  assert.equal(warm.state, 'warm');
  const mixed = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 1_000_000, maxVnodes: 251_127, warmedUp: true });
  assert.equal(mixed.state, 'mixed');
  assert.match(mixed.reason, /1,000,000.*251,127/);
  const notWarmed = await cacheState({ requested: 'warm', purge: async () => ({ ok: false, command: '' }), entries: 10, maxVnodes: 251_127, warmedUp: false });
  assert.equal(notWarmed.state, 'unknown');
});

/* Beyond the plan's tests: the platform table behind defaultPurge, checked
   without running anything, and the two branches that never spawn a process. */
test('the default purge is a printable table: sudo -n purge on macOS, sync then drop_caches on Linux, a refusal on Windows, and a stated gap elsewhere', async () => {
  assert.deepEqual(PURGE_PROCEDURES.darwin.steps, [{ file: 'sudo', args: ['-n', 'purge'] }]);
  assert.equal(PURGE_PROCEDURES.darwin.command, 'sudo -n purge');
  assert.deepEqual(PURGE_PROCEDURES.linux.steps, [
    { file: 'sync', args: [] },
    { file: 'sudo', args: ['-n', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'] },
  ]);
  assert.deepEqual(await defaultPurge('win32'), { ok: false, command: 'RAMMap → Empty Standby List', error: 'no unattended procedure on Windows' });
  const other = await defaultPurge('freebsd');
  assert.equal(other.ok, false);
  assert.match(other.error ?? '', /freebsd/);
});

test('a purge step that fails reports the command and the error, never success', async () => {
  const { runProcedure } = await import('../bench/lib/cache');
  const missing = runProcedure({ command: 'nowhere', steps: [{ file: '/nonexistent/purge-binary', args: [] }] });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /nonexistent/);
  const failing = runProcedure({ command: 'sh -c exit 3', steps: [{ file: 'sh', args: ['-c', 'echo boom >&2; exit 3'] }] });
  assert.equal(failing.ok, false);
  assert.match(failing.error ?? '', /boom/);
  const passing = runProcedure({ command: 'true', steps: [{ file: 'sh', args: ['-c', 'exit 0'] }] });
  assert.equal(passing.ok, true);
});

test('the vnode rule in every reason is the one constant, not a repeated literal', async () => {
  const { cacheState, VNODE_FILL_LIMIT } = await import('../bench/lib/cache');
  const pct = `${Math.round(VNODE_FILL_LIMIT * 100)}%`;
  const warm = await cacheState({ requested: 'warm', entries: 10, maxVnodes: 1000, warmedUp: true });
  assert.ok(warm.reason.includes(pct), warm.reason);
  const mixed = await cacheState({ requested: 'warm', entries: 999, maxVnodes: 1000, warmedUp: true });
  assert.ok(mixed.reason.includes(pct), mixed.reason);
  const linux = await cacheState({ requested: 'warm', entries: 10, warmedUp: true });
  assert.equal(linux.state, 'warm');
  assert.match(linux.reason, /not verified|no fixed/);
});
