import { test, after } from 'node:test';
import { skipOrFailOnCi } from './fixtures/ciSkip';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-scan-mft-mode-test-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { setMftWalkForTests, startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { settled } from '../src/utils/backgroundWrites';
import type { ScanResult } from '../src/models/types';
import type { MftOutcome } from '../src/services/scan/nativeEngine';

/**
 * The NTFS turbo mode as `startScan` runs it (the pre-landing review of 23 Sep
 * 2026 found this block untested). The mode needs Windows, a drive and an
 * elevated helper, so the walk is stood in for (setMftWalkForTests), and
 * Windows only while `startScan` decides — synchronously, before its walk —
 * which engine runs; the walk itself then runs as this machine.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-scan-mft-mode-root-'));
fs.writeFileSync(path.join(ROOT, 'a.bin'), 'aaaa');
fs.writeFileSync(path.join(ROOT, 'b.bin'), 'bb');

after(() => {
  setMftWalkForTests(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

async function done(scan: ScanResult): Promise<ScanResult> {
  const deadline = Date.now() + 20_000;
  while (scan.status === 'running') {
    if (Date.now() > deadline) assert.fail('the scan did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
  await settled();
  return scan;
}

/**
 * A turbo walk that records its calls and answers `outcome` — keeping the
 * real one's contract: a walk that was used hands back a finished store (a
 * stand-in that did not once made every save fail on "finalize() first",
 * so nothing was kept whatever the code under test did).
 */
function standIn(outcome: MftOutcome, touch: (scan: ScanResult) => void = () => {}) {
  const calls: string[] = [];
  setMftWalkForTests(async (scan, store, rootPath) => {
    calls.push(rootPath);
    touch(scan);
    if (outcome.used) {
      store.finalize();
      store.sumSizes();
    }
    return outcome;
  });
  return calls;
}

async function scanWithTurbo(opts: Parameters<typeof startScan>[1], root = ROOT): Promise<ScanResult> {
  const scan = await asWindows(async () => {
    await updateSettings({ engine: 'ntfs-mft' });
    return startScan(root, opts);
  });
  return done(scan);
}

/** What app data holds for ROOT: the fast-rescan caches, the snapshot trees and the snapshots taken of it. */
function kept(): { caches: string[]; snapshotsOfRoot: number } {
  const files = fs.readdirSync(DATA_DIR);
  const store = files.includes('snapshots.json')
    ? (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'snapshots.json'), 'utf8')) as { snapshots?: Array<{ rootPath?: string }> })
    : { snapshots: [] };
  return {
    caches: files.filter((f) => f.startsWith('mtime-cache-') || f.startsWith('snapshot-trees-')),
    snapshotsOfRoot: (store.snapshots ?? []).filter((s) => s.rootPath === ROOT).length,
  };
}

test('what an ordinary scan keeps is seen here: the check below can fail', async () => {
  setMftWalkForTests(null);
  const scan = await done(await startScan(ROOT, {}));
  assert.equal(scan.status, 'complete', scan.error);
  const seen = kept();
  assert.ok(seen.caches.length > 0 && seen.snapshotsOfRoot === 1, JSON.stringify(seen));
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { recursive: true, force: true });
});

test('a scan started from the window may use the mode, and what it read as administrator is never kept: no fast-rescan cache, no snapshot', async () => {
  const calls = standIn({ used: true, reason: 'the stand-in read the table' });
  const scan = await scanWithTurbo({ interactive: true });
  assert.equal(scan.status, 'complete', scan.error);
  assert.deepEqual(calls, [ROOT], 'the mode ran once');
  assert.equal(scan.engine, 'ntfs-mft');
  // The table holds what this user cannot list (other accounts' folders);
  // kept, it would come back in the next unelevated rescan and in the
  // snapshot history, after a yes given "for this one scan only".
  assert.deepEqual(kept(), { caches: [], snapshotsOfRoot: 0 });
});

test('a scan nobody started from the window never raises the prompt: it lists the folders and says why', async () => {
  const calls = standIn({ used: true, reason: 'must not run' });
  const scan = await scanWithTurbo({});
  assert.equal(scan.status, 'complete', scan.error);
  assert.deepEqual(calls, [], 'the scheduler, autopilot, peers, MCP and API calls without the flag are never the reason a prompt appears');
  assert.notEqual(scan.engine, 'ntfs-mft');
  assert.match(scan.engineReason ?? '', /only for a scan started from the TreeMap window/);
  // A rule, not a failure. (Standing in Windows also sends the native
  // loader looking for a Windows module, a fallback of its own here.)
  assert.doesNotMatch(scan.fallbackReason ?? '', /NTFS turbo/, 'a rule, not a failure');
});

test('a mode that was not used leaves no count of its own behind: the folders are listed afresh, and its reason is carried', async () => {
  const why = 'the NTFS turbo mode (stand-in) was not used: the helper exited with code 3';
  standIn({ used: false, failed: true, reason: why }, (scan) => { scan.fileCount = 999; scan.scanned = 999; });
  const scan = await scanWithTurbo({ interactive: true });
  assert.equal(scan.status, 'complete', scan.error);
  assert.equal(scan.fileCount, 2, 'the listing’s own count, not the failed mode’s');
  assert.ok((scan.engineReason ?? '').includes(why), scan.engineReason);
  assert.ok((scan.fallbackReason ?? '').includes(why), 'a failure is a fallback');
});

test('the mode’s rules keep it out, each with its reason: a single-file root and an incremental rescan', async () => {
  const calls = standIn({ used: true, reason: 'must not run' });
  const single = await scanWithTurbo({ interactive: true }, path.join(ROOT, 'a.bin'));
  assert.match(single.engineReason ?? '', /the root is a single file/);
  const incremental = await scanWithTurbo({ interactive: true, incremental: true });
  assert.match(incremental.engineReason ?? '', /incremental rescan/);
  assert.deepEqual(calls, [], 'neither asked');
  await asWindows(() => updateSettings({ engine: 'auto' }));
});

test('when the native engine scans instead, as on any Windows machine, the mode’s clause is still in the reason', async (t) => {
  // The first Windows CI run: with a real native module the clause was lost,
  // because it went only into the reasons the legacy engines give. Here the
  // decision is Windows' and the module is this machine's own.
  const prebuilt = path.join(__dirname, '..', 'native', 'prebuilt', `${os.platform()}-${os.arch()}`, 'treemap_core.node');
  if (!fs.existsSync(prebuilt)) return skipOrFailOnCi(t, 'no native module built for this machine');
  const calls = standIn({ used: true, reason: 'must not run' });
  resetNativeForTests();
  setNativeLoadOverrideForTests({ path: prebuilt });
  try {
    const scan = await scanWithTurbo({});
    assert.equal(scan.status, 'complete', scan.error);
    assert.deepEqual(calls, []);
    assert.equal(scan.engine, 'native', scan.engineReason ?? '');
    assert.match(scan.engineReason ?? '', /only for a scan started from the TreeMap window/);
  } finally {
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
  }
});

test('POST /api/scan passes the window’s interactive flag on, and a request without it never asks', async () => {
  const calls = standIn({ used: true, reason: 'the stand-in read the table' });
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const post = async (body: object) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/scan?wait=true&waitMs=20000`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { engine?: string; engineReason?: string } };
  };
  try {
    const plain = await asWindows(async () => {
      await updateSettings({ engine: 'ntfs-mft' });
      return post({ path: ROOT });
    });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.deepEqual(calls, [], 'an API call without the flag never asks');
    assert.match(plain.body.engineReason ?? '', /only for a scan started from the TreeMap window/);
    const fromWindow = await asWindows(() => post({ path: ROOT, interactive: true }));
    assert.equal(fromWindow.status, 200, JSON.stringify(fromWindow.body));
    assert.deepEqual(calls, [ROOT], 'the window’s request may');
    assert.equal(fromWindow.body.engine, 'ntfs-mft');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await asWindows(() => updateSettings({ engine: 'auto' }));
  }
});
