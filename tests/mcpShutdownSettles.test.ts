import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-mcp-shutdown-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { shutdownWhenSettled, SHUTDOWN_GRACE_MS } from '../src/mcp/shutdown';
import { buildMcpServer, trashCallsInFlight } from '../src/mcp/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * Hunt C58: when the MCP client closed stdin (or sent SIGINT/SIGTERM) the server exited in the
 * same tick it set the cancel flags, so a running offload never got its cooperative rollback or
 * its bookkeeping, and a trash_paths call cut off part-way wrote no audit line. Now shutdown cancels,
 * then waits — bounded — until no offload is running and no trash_paths call is in flight, and only
 * then exits. Counted on the shutdown's own clock, never timed.
 */

function fakeClock() {
  let now = 0;
  let sleeps = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { sleeps++; now += ms; await new Promise((r) => setImmediate(r)); },
    sleeps: () => sleeps,
  };
}

test('shutdown cancels first, waits while work is still settling, and exits once it has', async () => {
  const clock = fakeClock();
  const events: string[] = [];
  let busyFor = 3;
  await shutdownWhenSettled({
    cancel: () => { events.push('cancel'); },
    busy: () => { if (busyFor > 0) { busyFor--; events.push('busy'); return true; } return false; },
    exit: (code) => { events.push(`exit ${code}`); },
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(events, ['cancel', 'busy', 'busy', 'busy', 'exit 0'], 'no exit while an offload or a trash call is still settling');
});

test('shutdown exits after its grace period even if something never settles, and says so', async () => {
  const clock = fakeClock();
  let exited: number | null = null;
  const said: string[] = [];
  await shutdownWhenSettled({
    cancel: () => undefined,
    busy: () => true,
    exit: (code) => { exited = code; },
    now: clock.now,
    sleep: clock.sleep,
    log: (line) => { said.push(line); },
  });
  assert.equal(exited, 0);
  assert.ok(clock.now() >= SHUTDOWN_GRACE_MS, 'it waited out the whole grace period on its own clock');
  assert.ok(clock.sleeps() > 1, 'it looked again more than once');
  assert.match(said.join('\n'), /still settling/, 'the exit that did not wait says so on stderr');
});

test('the MCP entry point shuts down through shutdownWhenSettled, watching offloads and trash_paths calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'index.ts'), 'utf8');
  assert.match(source, /shutdownWhenSettled\(/);
  assert.match(source, /anyOffloadJobRunning\(\)/);
  assert.match(source, /trashCallsInFlight\(\)/);
  assert.doesNotMatch(source, /cancelAllOffloadJobs\(\);\s*process\.exit\(0\)/, 'no exit in the same tick as the cancel');
});

test('a trash_paths call counts as in flight until it answers', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-mcp-shutdown-root-'));
  const target = path.join(root, 'a.bin');
  fs.writeFileSync(target, 'a');
  await updateSettings({ engine: 'walker' });
  const s = await startScan(root, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the scan');
  let release: () => void = () => undefined;
  let stepEntered = false;
  setTrashStepForTests(async () => {
    stepEntered = true;
    await new Promise<void>((r) => { release = r; });
  });
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-shutdown', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await withOpenFileCheck('clear', async () => {
      assert.equal(trashCallsInFlight(), 0);
      const call = client.callTool({ name: 'trash_paths', arguments: { paths: [target] } });
      await waitFor(() => stepEntered, 'the Trash step starting');
      assert.equal(trashCallsInFlight(), 1, 'the call is in flight while its Trash step runs');
      release();
      await call;
      assert.equal(trashCallsInFlight(), 0, 'and not once it has answered');
    });
  } finally {
    setTrashStepForTests(null);
    await client.close();
  }
});
