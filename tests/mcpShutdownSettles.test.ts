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
import { createMcpShutdown } from '../src/mcp/mcpShutdown';
import { buildMcpServer, trashCallsInFlight } from '../src/mcp/server';
import { startScan, getScan, createScanRecord } from '../src/services/diskScanner';
import { getDuplicateJob, peekDuplicateJob } from '../src/services/duplicateFinder';
import { prepareOffload, startOffload, getOffloadJob } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // the offload below goes to "another drive"

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

test('the MCP entry point shuts down through createMcpShutdown, which exits the process, on SIGINT, SIGTERM and stdin closing', () => {
  // The steps themselves are driven below; this only pins that the process uses them. index.ts
  // starts the server when it is loaded, so it is read, not imported.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'index.ts'), 'utf8');
  assert.match(source, /createMcpShutdown\(\{ exit: \(code\) => process\.exit\(code\) \}\)/);
  for (const signal of [/process\.on\('SIGINT', shutdown\)/, /process\.on\('SIGTERM', shutdown\)/, /process\.stdin\.on\('close', shutdown\)/]) {
    assert.match(source, signal);
  }
  assert.doesNotMatch(source, /process\.exit\(0\)/, 'no exit of its own beside the shutdown\'s');
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

/** The shutdown's own clock for these tests: time never runs out, and each look again waits one turn. Counted, never timed. */
const neverExpires = { now: () => 0, sleep: () => new Promise<void>((resolve) => setImmediate(resolve)), log: () => undefined };

test('the MCP shutdown waits for a trash_paths call in flight to answer before it exits (review F1.11)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-mcp-shutdown-trash-'));
  const target = path.join(root, 'b.bin');
  fs.writeFileSync(target, 'b');
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
  const client = new Client({ name: 'mcp-shutdown-trash', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const exits: number[] = [];
  let call: Promise<unknown> | null = null;
  try {
    await withOpenFileCheck('clear', async () => {
      call = client.callTool({ name: 'trash_paths', arguments: { paths: [target] } });
      await waitFor(() => stepEntered, 'the Trash step starting');
      const shutdown = createMcpShutdown({ ...neverExpires, exit: (code) => { exits.push(code); } });
      const done = shutdown();
      for (let turn = 0; turn < 50; turn++) await new Promise<void>((r) => setImmediate(r));
      assert.deepEqual(exits, [], 'no exit while the trash_paths call is in flight');
      release();
      await call;
      await withinHangGuard(done, 'the shutdown settling');
      assert.deepEqual(exits, [0], 'and one exit once it has answered');
    });
  } finally {
    release(); // a failed assertion above left the call waiting: let it answer before the client goes
    await (call as Promise<unknown> | null)?.catch(() => undefined);
    setTrashStepForTests(null);
    await client.close();
  }
});

test('the MCP shutdown cancels a running offload and exits once it has rolled back; a second signal starts no second shutdown (review F1.11)', async () => {
  const src = fs.realpathSync(fileTempDir('treemap-mcp-shutdown-offload-src-'));
  const file = path.join(src, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(65_536, 5));
  const dest = fs.realpathSync(fileTempDir('treemap-mcp-shutdown-offload-dest-'));
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: 65_536, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{ name: 'big.bin', path: file, size: 65_536, type: 'file', modifiedAt: Date.now(), isHidden: false }],
  };
  const trashedHere: string[] = [];
  setTrashStepForTests(async (p: string) => { trashedHere.push(p); });
  let jobId = '';
  const exits: Array<{ code: number; status: string | undefined }> = [];
  const shutdown = createMcpShutdown({ ...neverExpires, exit: (code) => { exits.push({ code, status: getOffloadJob(jobId)?.status }); } });
  try {
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [file], dest);
      const job = await startOffload(scan, [file], dest, prepared);
      jobId = job.jobId;
      // In the same turn the job started: its first step has not settled, so the cancel finds it running.
      assert.equal(job.status, 'running');
      const first = shutdown();
      const second = shutdown();
      await withinHangGuard(Promise.all([first, second]), 'the shutdown settling');
    });
  } finally {
    setTrashStepForTests(null);
  }
  assert.deepEqual(exits, [{ code: 0, status: 'cancelled' }], 'one exit, after the cancelled offload rolled back');
  assert.deepEqual(trashedHere, [], 'the original never went to the Trash');
  assert.ok(fs.existsSync(file), 'it is still in place');
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing of the copy is left at the destination');
});

test('the MCP shutdown cancels a running scan and duplicate hashing before it exits (hunt HF-L9)', async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-mcp-shutdown-cancel-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(4_096, 6));
  const running = createScanRecord(dir);
  const done = createScanRecord(dir);
  done.status = 'complete';
  done.root = {
    name: path.basename(dir), path: dir, size: 4_096, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{ name: 'a.bin', path: file, size: 4_096, type: 'file', modifiedAt: Date.now(), isHidden: false }],
  };
  const job = getDuplicateJob(done, 1);
  assert.equal(job.cancelled, false);
  const seen: Array<{ code: number; scanCancelled: boolean | undefined; jobCancelled: boolean }> = [];
  const shutdown = createMcpShutdown({
    ...neverExpires,
    exit: (code) => { seen.push({ code, scanCancelled: running.cancelled, jobCancelled: job.cancelled }); },
  });
  await withinHangGuard(shutdown(), 'the shutdown settling');
  assert.deepEqual(seen, [{ code: 0, scanCancelled: true, jobCancelled: true }], 'the scan and the hashing were cancelled before the exit');
  assert.equal(peekDuplicateJob(done.scanId), undefined, 'and the hashing job is forgotten');
});
