import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-bootSpillSweep-data-');
process.env.TREEMAP_NO_GDU = '1';

import { describeSweep, startServer, setBootSaveTempSweepForTests, setBootSweepForTests, type RunningServer } from '../src/server';
import { SPILL_DIR } from '../src/services/spillSweep';
import { initPortableMode, isEphemeral, resetPortableMode } from '../src/services/portableMode';
import { waitFor } from './fixtures/waitFor';

/**
 * Phase 4 T17a (plan §S.5.3, T13c): `src/server.ts` sweeps `<appData>/scan-spill` once at
 * boot, through the one confined remover. The sweep never holds the boot up and never fails
 * it: an error is logged in one line and the server serves on. It is skipped in a read-only
 * portable session, whose app-data is not a folder TreeMap may write to, and its report is
 * one line of the log.
 *
 * App-data is this file's temp folder. Liveness is the real check: this process is alive,
 * and 2^31 − 1 is a pid no process has (tests/spillSweep.test.ts pins both).
 */

const SPILL = path.join(APP, SPILL_DIR);
const NEVER = 2 ** 31 - 1;
const UUID = '3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab';

/** A leftover as tm-store leaves one: mode 0600 in a 0700 folder. */
function leftover(pid: number, column: string, bytes: number): string {
  fs.mkdirSync(SPILL, { recursive: true, mode: 0o700 });
  fs.chmodSync(SPILL, 0o700);
  const file = path.join(SPILL, `${pid}-1790656308811-${UUID}-${column}`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** A save's temp file (`<name>.<pid>.tmp`, FG3g review F2.5) in app-data, as a save that `pid` began left it. */
function saveLeftover(pid: number, name: string): string {
  const file = path.join(APP, `${name}.${String(pid)}.tmp`);
  fs.writeFileSync(file, '{"half":');
  return file;
}

/** The lines the server logs about the spill sweep (or, with `about`, about anything it matches) while `fn` runs. */
async function sweepLines<T>(fn: () => Promise<T>, about: RegExp = /spill sweep/): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const { log, warn } = console;
  const keep = (args: unknown[]): void => {
    const line = args.map(String).join(' ');
    if (about.test(line)) lines.push(line);
  };
  console.log = (...args: unknown[]) => keep(args);
  console.warn = (...args: unknown[]) => keep(args);
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function boot(): Promise<RunningServer> {
  return startServer({ publicDir: path.join(__dirname, '..', 'public'), port: 0, host: '127.0.0.1' });
}

function get(port: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject);
  });
}

test('boot removes a dead process\'s leftover, keeps a live process\'s, and says so in one line', async () => {
  const dead = leftover(NEVER, 'size', 1000);
  const live = leftover(process.pid, 'mtime', 10);
  let running: RunningServer | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.spillSweep;
    });
    assert.equal(fs.existsSync(dead), false, 'the dead owner\'s leftover is gone');
    assert.equal(fs.existsSync(live), true, 'this live process\'s file is kept');
    assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /spill sweep: removed 1 file \(1\.0 KB\), kept 1$/);
  } finally {
    running?.shutdown();
  }
});

test('a sweep that throws does not stop the server: it serves, and the error is one line', async () => {
  let asked = 0;
  setBootSweepForTests((dir) => {
    asked++;
    assert.equal(dir, APP, 'the sweep is given app-data');
    throw new Error('the disk said no');
  });
  let running: RunningServer | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.spillSweep; // settles, never rejects
    });
    assert.equal(asked, 1, 'the sweep ran once');
    assert.equal(await get(running!.port, '/api/capabilities'), 200, 'and the server serves');
    assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /spill sweep failed and was skipped: the disk said no/);
  } finally {
    running?.shutdown();
    setBootSweepForTests(null);
  }
});

test('a sweep that rejects later does not stop the server either', async () => {
  setBootSweepForTests(async () => {
    await Promise.resolve();
    throw new Error('late failure');
  });
  let running: RunningServer | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.spillSweep;
    });
    assert.equal(await get(running!.port, '/api/capabilities'), 200);
    assert.deepEqual(lines.map((l) => /late failure/.test(l)), [true]);
  } finally {
    running?.shutdown();
    setBootSweepForTests(null);
  }
});

test('the boot does not wait for the sweep', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  setBootSweepForTests(async () => {
    await held;
    settled = true;
    return { removed: 0, bytes: 0, kept: 0, refused: [] };
  });
  let running: RunningServer | undefined;
  let booting: Promise<RunningServer> | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      booting = boot().then((server) => (running = server));
      await waitFor(() => running !== undefined, 'the boot, while its sweep is still running');
      assert.equal(settled, false, 'the server was up before the sweep finished');
      release();
      await running!.spillSweep;
    });
    assert.equal(settled, true);
    assert.equal(lines.length, 1);
  } finally {
    release();
    // Once the sweep is released a boot that waited for it resolves too, and is shut down.
    (running ?? (await booting))?.shutdown();
    setBootSweepForTests(null);
  }
});

test('a read-only portable session sweeps nothing: its app-data is not TreeMap\'s to write', async () => {
  const dead = leftover(NEVER, 'names', 5);
  const deadSave = saveLeftover(NEVER, 'settings.json'); // nor a save's temp file (FG3g review F3.2)
  // Read-only as the D3 tests make one: the data folder inside a regular file, so every OS
  // refuses it. process.env still names APP, so an unskipped sweep would remove `dead`.
  const blocker = path.join(fileTempDir('treemap-bootSpillSweep-ro-'), 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  resetPortableMode();
  initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(blocker, 'data') } as NodeJS.ProcessEnv);
  let running: RunningServer | undefined;
  try {
    assert.equal(isEphemeral(), true, 'the session really is read-only');
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.spillSweep;
      await running.saveTempSweep;
    });
    assert.equal(fs.existsSync(dead), true, 'nothing was swept');
    assert.equal(fs.existsSync(deadSave), true, 'not even a save\'s temp file');
    assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /spill sweep skipped: this portable session is read-only/);
  } finally {
    running?.shutdown();
    resetPortableMode();
    initPortableMode({ TREEMAP_DATA_DIR: APP } as NodeJS.ProcessEnv);
  }
});

test('the one line says what the sweep did, names at most three refusals, and says when it could not look', () => {
  assert.equal(describeSweep({ removed: 0, bytes: 0, kept: 0, refused: [] }), 'spill sweep: removed 0 files (0 B), kept 0');
  const refused = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, reason: `${name} is not a regular file` }));
  assert.equal(
    describeSweep({ removed: 2, bytes: 2048, kept: 6, refused }),
    'spill sweep: removed 2 files (2.0 KB), kept 6; refused a (a is not a regular file); b (b is not a regular file); c (c is not a regular file) and 2 more',
  );
  assert.equal(
    describeSweep({ removed: 0, bytes: 0, kept: 0, refused: [], unreadable: 'the folder can be written by other users' }),
    'spill sweep: the folder was not looked into: the folder can be written by other users',
  );
});

/* ─────────────── FG3g review F3.2, F3.7: saves' temp files a dead process left ─────────────── */

test('boot removes a save\'s temp file a dead process left in app-data, and keeps one of a live process', async () => {
  const dead = saveLeftover(NEVER, 'offload-manifest.json');
  const live = saveLeftover(process.pid, 'timecapsule.json');
  let running: RunningServer | undefined;
  try {
    running = await boot();
    await running.saveTempSweep;
    assert.equal(fs.existsSync(dead), false, 'the dead process\'s temp file is gone');
    assert.equal(fs.existsSync(live), true, 'this live process\'s is kept');
  } finally {
    running?.shutdown();
    fs.rmSync(live, { force: true });
  }
});

/* ─────────────── the final review, F1.3: the save sweep's failures, its skip, and that nothing waits on it ─────────────── */

/** What the server logs about saves' temp files. */
const SAVE_SWEEP = /temporary file/;

test('a save\'s temp file the sweep could not remove is left and named, one line each, and the server serves', async () => {
  setBootSaveTempSweepForTests(async () => ({
    removed: ['settings.json.4242.tmp'],
    failed: [
      { name: 'offload-manifest.json.4243.tmp', why: 'EACCES: permission denied (a test)' },
      { name: 'timecapsule.json.4244.tmp', why: 'EBUSY: resource busy (a test)' },
    ],
  }));
  let running: RunningServer | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.saveTempSweep;
    }, SAVE_SWEEP);
    assert.equal(await get(running!.port, '/api/capabilities'), 200, 'the server serves');
    assert.deepEqual(lines, [
      '[treemap] removed 1 temporary file a save left when a TreeMap process stopped part-way',
      '[treemap] left offload-manifest.json.4243.tmp, a save\'s temporary file, which could not be removed: EACCES: permission denied (a test)',
      '[treemap] left timecapsule.json.4244.tmp, a save\'s temporary file, which could not be removed: EBUSY: resource busy (a test)',
    ]);
  } finally {
    running?.shutdown();
    setBootSaveTempSweepForTests(null);
  }
});

test('a save sweep that fails does not stop the server: its promise settles, never rejects, and the failure is one line', async () => {
  setBootSaveTempSweepForTests(async () => {
    await Promise.resolve();
    throw Object.assign(new Error('EACCES: permission denied, scandir (a test)'), { code: 'EACCES' });
  });
  let running: RunningServer | undefined;
  try {
    const { lines } = await sweepLines(async () => {
      running = await boot();
      await running.saveTempSweep; // settles, never rejects
    }, SAVE_SWEEP);
    assert.equal(await get(running!.port, '/api/capabilities'), 200, 'and the server serves');
    assert.deepEqual(lines, ['[treemap] the sweep of saves\' temporary files failed and was skipped: EACCES: permission denied, scandir (a test)']);
  } finally {
    running?.shutdown();
    setBootSaveTempSweepForTests(null);
  }
});

test('the boot does not wait for the save sweep', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  setBootSaveTempSweepForTests(async () => {
    await held;
    settled = true;
    return { removed: [], failed: [] };
  });
  let running: RunningServer | undefined;
  let booting: Promise<RunningServer> | undefined;
  try {
    booting = boot().then((server) => (running = server));
    await waitFor(() => running !== undefined, 'the boot, while its save sweep is still running');
    assert.equal(settled, false, 'the server was up before the save sweep finished');
    release();
    await running!.saveTempSweep;
    assert.equal(settled, true);
  } finally {
    release();
    (running ?? (await booting))?.shutdown();
    setBootSaveTempSweepForTests(null);
  }
});

