import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-realMachineGuard-data-');

import { nestedRunEnv } from './fixtures/nestedRun';
import {
  FORBID_REAL_TRASH_VARIABLE,
  RealMachineRefusal,
  takeRealMachineRefusalsForTests,
  underTestRunner,
} from '../src/services/realMachineGuard';
import { moveToTrash, setTrashStepForTests } from '../src/services/cleaner';
import { emptyTrash, emptyTrashCommands, getTrashInfo } from '../src/services/trash';
import { purgeSnapshots, setSnapshotPurgeStepForTests } from '../src/services/snapshotAccounting';
import { trashCloudPaths } from '../src/services/cloud/cloudScan';
import { PROVIDERS } from '../src/services/cloud/providers';
import { runGitGc, setGitGcStepForTests } from '../src/services/gitScanner';
import { createScanRecord } from '../src/services/diskScanner';
import { saveTokens } from '../src/services/cloud/oauth';
import { updateSettings } from '../src/services/settings';
import { sanitizePath } from '../src/utils/pathSanitizer';
import type { FileNode, ScanResult } from '../src/models/types';

/**
 * No test reaches the machine's real Trash, empties it, lists it, deletes its
 * snapshots, trashes a cloud file or runs a real `git gc`
 * (src/services/realMachineGuard.ts). Until 30 Sep 2026 nothing enforced that,
 * and on a Mac every run put files into the owner's real Trash:
 *  - tests/compressionAdvisor.test.ts, since 28 Jul 2026 (7ca541b): the three
 *    tests whose encode succeeds each trashed a 1,000-byte `holiday.mp4` from
 *    a `tm-enc-…` temp folder;
 *  - tests/cartCommit.test.ts, 26 Aug – 29 Sep 2026 (8c2389a, fixed by FG1):
 *    six 1 KiB files `f0.bin`…`f5.bin` from `tm-cart-chunked-…` folders.
 * tests/rateLimiterLanes.test.ts listed it, names and sizes, on every run
 * since 31 Aug 2026 (b001b69), through a boot's GET /api/trash/size.
 * Five more drove the machine's Trash step and trusted something to stop it:
 * a path that did not exist (openHandleGuard's "delete anyway",
 * polishServerErrors' plain-words reason), the Windows name refusal
 * (trashRefusal), or `lsof` seeing a held file (openHandleGuard's whole-batch
 * refusal, timeCapsule's held-open log) — which on a loaded machine it can
 * miss, as Autopilot's held-file test did on 24 Sep 2026, trashing its
 * 8 KiB `held.bin`. And tests/trashInfo.test.ts once emptied the Trash, about
 * eighteen times (Aug 2026). Every one of them now stands in for the Trash.
 *
 * Every call in this process that could reach the machine runs `disarmed`:
 * were the guard missing — a mutant — the attempt shows as a recorded call and
 * never happens. The Trash step is only ever asked about a path that does not
 * exist — in the children too, which no stub here can reach — so a missing
 * guard shows as the machine's own ENOENT rather than the guard's words; and
 * git gc only about a folder that is no repository. The children that show
 * each other door going ahead outside a test runner disarm the machine
 * themselves (tests/fixtures/disarmedMachine.ts), and prove it, first.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../scripts/run-tests.js') as {
  FORBID_REAL_TRASH: string;
  testEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cleanup(): void };
  runTests(opts: {
    files: string[];
    argv: string[];
    env: NodeJS.ProcessEnv;
    spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => { status: number | null };
  }): number;
};

const SRC = path.join(__dirname, '..', 'src');
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const TRASH_REFUSAL = (p: string): string => `a test reached the machine's real Trash: ${p} — use setTrashStepForTests`;
const EMPTY_REFUSAL = "a test reached the machine's real Trash: emptying it — point TREEMAP_TRASH_DIR at a folder the test owns";
const LIST_REFUSAL = "a test reached the machine's real Trash: listing it — point TREEMAP_TRASH_DIR at a folder the test owns";
const GC_REFUSAL = (repo: string): string => `a test reached a real git gc, which prunes for good: ${repo} — use setGitGcStepForTests`;
const PURGE_REFUSAL = "a test reached the machine's real Time Machine snapshots: deleting them — use setSnapshotPurgeStepForTests";

/**
 * Every provider whose trash the guard stands at, as it says it and as the stand-in contract names
 * it (TM_<ID>_API, which providers.ts reads), and the one request that provider's trash sends. Written
 * out rather than derived, so a guard that built the variable from anything but the id is caught.
 */
const CLOUD_PROVIDERS: Readonly<Record<string, { name: string; variable: string; request: { method: string; url: string; body: unknown } }>> = {
  gdrive: { name: 'Google Drive', variable: 'TM_GDRIVE_API', request: { method: 'PATCH', url: '/files/id%3Aa', body: { trashed: true } } },
  dropbox: { name: 'Dropbox', variable: 'TM_DROPBOX_API', request: { method: 'POST', url: '/files/delete_v2', body: { path: 'id:a' } } },
  onedrive: { name: 'OneDrive', variable: 'TM_ONEDRIVE_API', request: { method: 'DELETE', url: '/me/drive/items/id%3Aa', body: null } },
};
const cloudFile = (id: string): string => `cloud://${id}/a.txt`;
const CLOUD_REFUSAL = (id: string): string =>
  `a test reached ${CLOUD_PROVIDERS[id].name}'s real trash: ${cloudFile(id)} — point ${CLOUD_PROVIDERS[id].variable} at a stand-in server`;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface Disarmed<T> {
  /** What `act` settled to: its value, or what it threw. */
  outcome: T | Error;
  /** Every way to the machine `act` tried: a child process, a listing, an lstat, a request. */
  calls: string[];
  /** What was written to stderr meanwhile. */
  stderr: string;
}

/**
 * Runs `act` with every way the doors reach the machine watched and disarmed.
 * A child process (the Finder, tmutil, PowerShell, gio) is recorded and
 * refused before it starts; a directory listing is recorded and refused, so no
 * Trash is ever listed; a request is recorded and refused; an lstat is
 * recorded and made — only ever of a path that does not exist. PATH names an
 * empty folder and HOME a folder of this file's own besides, so a command or a
 * home folder reached some other way is not the machine's either. Listings
 * and lstats inside `allowed` (a stand-in's own folder) go ahead unrecorded.
 */
async function disarmed<T>(act: () => Promise<T>, allowed?: string): Promise<Disarmed<T>> {
  const calls: string[] = [];
  let stderr = '';
  const proto = childProcess.ChildProcess.prototype as unknown as { spawn: (options: { file: string; args?: string[] }) => unknown };
  const fsp = fs.promises as unknown as Record<'readdir' | 'lstat', (...args: unknown[]) => Promise<unknown>>;
  const saved = {
    spawn: proto.spawn,
    readdir: fsp.readdir,
    lstat: fsp.lstat,
    fetch: globalThis.fetch,
    write: process.stderr.write,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  const noCommands = fileTempDir('treemap-guard-no-commands-');
  const home = fileTempDir('treemap-guard-home-');
  const ours = (p: unknown): boolean => allowed !== undefined && inside(allowed, String(p));
  proto.spawn = function spawnRefused(options) {
    calls.push(`spawn ${[options.file, ...(options.args ?? []).slice(1)].join(' ')}`);
    throw Object.assign(new Error(`the machine is disarmed: ${options.file} was not started`), { code: 'EDISARMED' });
  };
  fsp.readdir = async (...args) => {
    if (ours(args[0])) return saved.readdir.apply(fs.promises, args);
    calls.push(`readdir ${String(args[0])}`);
    throw Object.assign(new Error(`the machine is disarmed: ${String(args[0])} was not listed`), { code: 'EACCES' });
  };
  fsp.lstat = async (...args) => {
    if (!ours(args[0])) calls.push(`lstat ${String(args[0])}`);
    return saved.lstat.apply(fs.promises, args);
  };
  globalThis.fetch = (async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error('the machine is disarmed: no request was sent');
  }) as typeof fetch;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.env.PATH = noCommands;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const outcome = await act().catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    return { outcome, calls, stderr };
  } finally {
    proto.spawn = saved.spawn;
    fsp.readdir = saved.readdir;
    fsp.lstat = saved.lstat;
    globalThis.fetch = saved.fetch;
    process.stderr.write = saved.write;
    restoreEnv('PATH', saved.PATH);
    restoreEnv('HOME', saved.HOME);
    restoreEnv('USERPROFILE', saved.USERPROFILE);
  }
}

function describe(outcome: unknown): string {
  return outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : JSON.stringify(outcome);
}

/** `run` was refused with `message`, said so on stderr, and touched nothing. */
function assertRefused<T>(run: Disarmed<T>, message: string): void {
  assert.ok(run.outcome instanceof RealMachineRefusal, `the door refused, instead of: ${describe(run.outcome)} (calls: ${JSON.stringify(run.calls)})`);
  assert.equal(run.outcome.message, message);
  assert.equal(run.outcome.code, 'TEST_REACHED_REAL_MACHINE', 'a route answers the refusal with its own code');
  assert.deepEqual(run.calls, [], 'the refusal came before any call to the machine');
  assert.match(run.stderr, /\[treemap\] REFUSED under a test runner: /, 'and it was said on stderr as it happened');
  assert.ok(run.stderr.includes(message), `naming the door: ${run.stderr}`);
  assert.deepEqual(takeRealMachineRefusalsForTests(), [message], 'it is held for the exit check, once');
}

/* ─────────────── Knowing a test runner ─────────────── */

test("a test runner is known by npm test's own variable or by node:test's context, each alone", () => {
  assert.equal(underTestRunner({ [FORBID_REAL_TRASH_VARIABLE]: '1' }), true, "npm test's variable alone (a child that nestedRunEnv() stripped of node:test's context)");
  assert.equal(underTestRunner({ NODE_TEST_CONTEXT: 'child-v8' }), true, "node:test's context alone (a file run with --test outside npm test; Node 20 and 24 both set child-v8)");
  assert.equal(underTestRunner({ NODE_TEST_CONTEXT: 'child' }), true, "node:test's older context value");
  for (const production of [{}, { [FORBID_REAL_TRASH_VARIABLE]: '' }, { NODE_TEST_CONTEXT: '' }, { PATH: '/usr/bin', HOME: '/Users/someone', TREEMAP_DATA_DIR: '/tmp/data' }]) {
    assert.equal(underTestRunner(production), false, `production sets neither: ${JSON.stringify(production)}`);
  }
  assert.equal(underTestRunner(), true, 'this file runs under a test runner (npm test, or --test): outside one nothing is guarded');
});

test('npm test forbids the real Trash in every run, with a data folder of its own or the one the caller chose', () => {
  assert.equal(runner.FORBID_REAL_TRASH, FORBID_REAL_TRASH_VARIABLE, 'the runner and the guard name one variable');
  const fresh = runner.testEnvironment({ PATH: process.env.PATH });
  try {
    assert.equal(fresh.env[FORBID_REAL_TRASH_VARIABLE], '1', 'a run given a data folder of its own');
  } finally {
    fresh.cleanup();
  }
  const chosen = runner.testEnvironment({ PATH: process.env.PATH, TREEMAP_DATA_DIR: fileTempDir('treemap-guard-chosen-data-') });
  assert.equal(chosen.env[FORBID_REAL_TRASH_VARIABLE], '1', 'a run whose caller chose the data folder');

  const started: NodeJS.ProcessEnv[] = [];
  runner.runTests({
    files: ['tests/a.test.ts'],
    argv: [],
    env: { PATH: process.env.PATH },
    spawn: (_cmd, _args, opts) => {
      started.push(opts.env);
      return { status: 0 };
    },
  });
  assert.equal(started[0]?.[FORBID_REAL_TRASH_VARIABLE], '1', "the run's test runner is started with it, and every process of the run inherits it");
});

test("a nested run's environment carries npm test's variable in place of node:test's context, which it takes out", () => {
  // A file run with --test outside npm test has only node:test's context; nestedRunEnv() takes that
  // out, so without the variable put back a child it starts would be unguarded.
  const nested = nestedRunEnv({ PATH: '/usr/bin', NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(nested.NODE_TEST_CONTEXT, undefined, "node:test's context is still taken out");
  assert.equal(nested[FORBID_REAL_TRASH_VARIABLE], '1', "npm test's variable is put in its place");
  assert.equal(underTestRunner(nested), true, 'so a child started with it is under a test runner');
});

/* ─────────────── The Trash step ─────────────── */

test('the Trash step refuses under a test runner before any call to the machine, and the refusal is no per-path failure', async () => {
  const missing = path.join(fileTempDir('treemap-guard-trash-'), 'never-made.bin');
  assertRefused(await disarmed(() => moveToTrash([missing], { ignoreOpenHandles: true })), TRASH_REFUSAL(missing));
});

test('with setTrashStepForTests in place, a delete goes to the stand-in and nothing is refused', async () => {
  const missing = path.join(fileTempDir('treemap-guard-trash-'), 'never-made.bin');
  const stoodIn: string[] = [];
  setTrashStepForTests(async (p) => {
    stoodIn.push(p);
  });
  try {
    const run = await disarmed(() => moveToTrash([missing], { ignoreOpenHandles: true }));
    assert.deepEqual(run.outcome, { deleted: [missing], failed: [] }, describe(run.outcome));
    assert.deepEqual(stoodIn, [missing], 'the stand-in was asked, once');
    assert.deepEqual(run.calls, [], 'and nothing else');
  } finally {
    setTrashStepForTests(null);
  }
  assert.deepEqual(takeRealMachineRefusalsForTests(), []);
});

/* ─────────────── Empty Trash ─────────────── */

test('emptying the Trash refuses under a test runner before the Trash is even listed', async () => {
  const saved = process.env.TREEMAP_TRASH_DIR;
  delete process.env.TREEMAP_TRASH_DIR;
  try {
    assertRefused(await disarmed(() => emptyTrash()), EMPTY_REFUSAL);
  } finally {
    restoreEnv('TREEMAP_TRASH_DIR', saved);
  }
});

test('with TREEMAP_TRASH_DIR in place, emptying clears that folder and reaches nothing else', async () => {
  const standIn = fileTempDir('treemap-guard-trash-dir-');
  fs.writeFileSync(path.join(standIn, 'old.bin'), Buffer.alloc(1024));
  const saved = process.env.TREEMAP_TRASH_DIR;
  process.env.TREEMAP_TRASH_DIR = standIn;
  try {
    const run = await disarmed(() => emptyTrash(), standIn);
    assert.ok(!(run.outcome instanceof Error), describe(run.outcome));
    assert.equal(run.outcome.emptied, true, describe(run.outcome));
    assert.deepEqual(fs.readdirSync(standIn), [], 'the stand-in folder is what was emptied');
    assert.deepEqual(run.calls, [], 'no listing of any other Trash, and no emptier');
  } finally {
    restoreEnv('TREEMAP_TRASH_DIR', saved);
  }
  assert.deepEqual(takeRealMachineRefusalsForTests(), []);
});

/* ─────────────── Listing the Trash ─────────────── */

test('listing the Trash refuses under a test runner before any Trash is read', async () => {
  const saved = process.env.TREEMAP_TRASH_DIR;
  delete process.env.TREEMAP_TRASH_DIR;
  try {
    assertRefused(await disarmed(() => getTrashInfo()), LIST_REFUSAL);
  } finally {
    restoreEnv('TREEMAP_TRASH_DIR', saved);
  }
});

test('with TREEMAP_TRASH_DIR in place, listing reads that folder and nothing else', async () => {
  const standIn = fileTempDir('treemap-guard-trash-dir-');
  fs.writeFileSync(path.join(standIn, 'old.bin'), Buffer.alloc(1024));
  const saved = process.env.TREEMAP_TRASH_DIR;
  process.env.TREEMAP_TRASH_DIR = standIn;
  try {
    const run = await disarmed(() => getTrashInfo(), standIn);
    assert.ok(!(run.outcome instanceof Error), describe(run.outcome));
    assert.deepEqual(run.outcome.items, [{ name: 'old.bin', path: path.join(standIn, 'old.bin'), size: 1024 }], describe(run.outcome));
    assert.deepEqual(run.calls, [], 'no other Trash was listed');
  } finally {
    restoreEnv('TREEMAP_TRASH_DIR', saved);
  }
  assert.deepEqual(takeRealMachineRefusalsForTests(), []);
});

/* ─────────────── Time Machine's local snapshots ─────────────── */

test("deleting the machine's local snapshots refuses under a test runner before tmutil is run", async () => {
  assertRefused(await disarmed(() => purgeSnapshots()), PURGE_REFUSAL);
});

test('with setSnapshotPurgeStepForTests in place, a purge goes to the stand-in', async () => {
  let asked = 0;
  setSnapshotPurgeStepForTests(async () => {
    asked++;
    return { ok: true, deleted: 2, failed: 0 };
  });
  try {
    const run = await disarmed(() => purgeSnapshots());
    assert.deepEqual(run.outcome, { ok: true, deleted: 2, failed: 0 }, describe(run.outcome));
    assert.equal(asked, 1, 'the stand-in was asked, once');
    assert.deepEqual(run.calls, [], 'and tmutil never was');
  } finally {
    setSnapshotPurgeStepForTests(null);
  }
  assert.deepEqual(takeRealMachineRefusalsForTests(), []);
});

/* ─────────────── A cloud provider's trash ─────────────── */

/** A completed scan of provider `id` holding one file, as trashCloudPaths reads one. */
function cloudScan(id: string): ScanResult & { root: FileNode } {
  const file: FileNode = { name: 'a.txt', path: cloudFile(id), size: 10, type: 'file', modifiedAt: 0, isHidden: false, cloudId: 'id:a' };
  const root: FileNode = { name: CLOUD_PROVIDERS[id].name, path: `cloud://${id}`, size: 10, type: 'dir', modifiedAt: 0, isHidden: false, children: [file] };
  return { rootPath: `cloud://${id}`, status: 'complete', root } as unknown as ScanResult & { root: FileNode };
}

/** Runs `act` with every provider's stand-in variable unset but those in `set`, and puts them back after. */
async function withCloudVariables<T>(set: Record<string, string>, act: () => Promise<T>): Promise<T> {
  const saved = Object.values(CLOUD_PROVIDERS).map(({ variable }) => [variable, process.env[variable]] as const);
  for (const [variable] of saved) delete process.env[variable];
  Object.assign(process.env, set);
  try {
    return await act();
  } finally {
    for (const [variable, value] of saved) restoreEnv(variable, value);
  }
}

test('the guard stands at the trash of every cloud provider there is, each tested below', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), Object.keys(CLOUD_PROVIDERS).sort());
  for (const [id, { name }] of Object.entries(CLOUD_PROVIDERS)) assert.equal(PROVIDERS[id as keyof typeof PROVIDERS].name, name);
});

for (const [id, { variable, request }] of Object.entries(CLOUD_PROVIDERS)) {
  test(`trashing a ${id} file refuses under a test runner, naming ${variable}, before the provider's token is read or a request is sent`, async () => {
    await withCloudVariables({}, async () => {
      assertRefused(await disarmed(() => trashCloudPaths(cloudScan(id), [cloudFile(id)])), CLOUD_REFUSAL(id));
    });
  });

  test(`with ${variable} pointed at a stand-in server, and no other provider's, a ${id} cloud trash goes there`, async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || 'null') as unknown });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const standIn = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      await withCloudVariables({ [variable]: standIn }, async () => {
        await updateSettings({ cloud: { [id]: { clientId: 'stand-in-client' } } });
        await saveTokens(id, { accessToken: 'stand-in-token', expiresAt: 0 });
        const result = await trashCloudPaths(cloudScan(id), [cloudFile(id)]);
        assert.deepEqual(result, { deleted: [cloudFile(id)], failed: [] });
      });
      assert.deepEqual(requests, [{ ...request, auth: 'Bearer stand-in-token' }], 'the stand-in got the one request');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.deepEqual(takeRealMachineRefusalsForTests(), []);
  });
}

/* ─────────────── git gc, which prunes for good ─────────────── */

/**
 * A folder inside a scanned root, as runGitGc demands of a repository. It is
 * not a repository at all: were the guard missing and git somehow started
 * after all, git would refuse it.
 */
function repoInsideAScan(): string {
  const root = fileTempDir('treemap-guard-gc-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  createScanRecord(root);
  return repo;
}

test('git gc refuses under a test runner before git is started', async () => {
  const repo = repoInsideAScan();
  assertRefused(await disarmed(() => runGitGc(repo)), GC_REFUSAL(sanitizePath(repo)));
});

test('with setGitGcStepForTests in place, git gc goes to the stand-in', async () => {
  const repo = repoInsideAScan();
  const asked: string[] = [];
  setGitGcStepForTests(async (r) => {
    asked.push(r);
    return { stdout: 'packed', stderr: '' };
  });
  try {
    const run = await disarmed(() => runGitGc(repo));
    assert.deepEqual(run.outcome, { ok: true, output: 'packed' }, describe(run.outcome));
    assert.deepEqual(asked, [sanitizePath(repo)], 'the stand-in was asked, once, about the repository');
    assert.deepEqual(run.calls, [], 'and git never was');
  } finally {
    setGitGcStepForTests(null);
  }
  assert.deepEqual(takeRealMachineRefusalsForTests(), []);
});

/* ─────────────── A child a test starts ─────────────── */

/**
 * Runs a fresh process, as a test starts a server or a worker, that asks the
 * Trash step to trash a path that does not exist and swallows whatever comes
 * back — so only the guard's own exit check can still fail it. The process is
 * a plain tsx run, never `--test`; with `viaFixture` it first loads
 * tests/fixtures/dataDir.ts, as a test file does. What it was answered is
 * written to a file, since a process that loads the fixture also loads
 * node:test, which prints its own report on stdout.
 */
function childAsksTheTrash(env: NodeJS.ProcessEnv, viaFixture = false): { status: number | null; outcome: string; stderr: string; missing: string } {
  const dir = fileTempDir('treemap-guard-child-');
  const missing = path.join(dir, 'never-made.bin');
  const answered = path.join(dir, 'answered.txt');
  const script = path.join(dir, 'child.ts');
  fs.writeFileSync(script, [
    ...(viaFixture ? [`import ${JSON.stringify(path.join(__dirname, 'fixtures', 'dataDir'))};`] : []),
    "import fs from 'node:fs';",
    `import { moveToTrash } from ${JSON.stringify(path.join(SRC, 'services', 'cleaner'))};`,
    'void moveToTrash([process.argv[2]], { ignoreOpenHandles: true }).then(',
    '  (result) => fs.writeFileSync(process.argv[3], JSON.stringify(result)),',
    '  (err: Error) => fs.writeFileSync(process.argv[3], `${err.name}: ${err.message}`),',
    ');',
  ].join('\n'));
  const r = spawnSync(process.execPath, [TSX_CLI, script, missing, answered], { env, encoding: 'utf8', timeout: 120_000 });
  const outcome = fs.existsSync(answered) ? fs.readFileSync(answered, 'utf8') : `(nothing answered; stdout: ${r.stdout})`;
  return { status: r.status, outcome, stderr: r.stderr, missing };
}

/** This process's environment with neither signal, as a hand-built `env`, or a plain run outside npm test, has it. */
function withNeither(): NodeJS.ProcessEnv {
  const neither = nestedRunEnv();
  delete neither[FORBID_REAL_TRASH_VARIABLE];
  delete neither.NODE_TEST_CONTEXT;
  return neither;
}

/** The child was refused, said so as it happened and again at its end, and failed although it swallowed the refusal. */
function assertChildRefused(label: string, child: ReturnType<typeof childAsksTheTrash>): void {
  const refusal = TRASH_REFUSAL(child.missing);
  assert.equal(child.outcome, `RealMachineRefusal: ${refusal}`, `${label}: the child was refused, not ${child.outcome} (stderr: ${child.stderr})`);
  assert.ok(child.stderr.includes(`[treemap] REFUSED under a test runner: ${refusal}`), `${label}: said on stderr as it happened: ${child.stderr}`);
  assert.match(child.stderr, /ends with exit code 1: under a test runner it refused 1 call /, `${label}: and said again at its end`);
  assert.equal(child.status, 1, `${label}: the child fails although it swallowed the refusal`);
}

test("a child a test starts refuses too — with the test's environment, with a nested run's, or with only node:test's context — and a refusal it swallows still fails it", () => {
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ["the test's own environment (...process.env)", { ...process.env }],
    ["nestedRunEnv() of an environment with neither signal, as a nested run starts one: only npm test's variable, put back", nestedRunEnv(withNeither())],
    ["only node:test's context", { ...withNeither(), NODE_TEST_CONTEXT: 'child-v8' }],
  ];
  for (const [label, env] of cases) assertChildRefused(label, childAsksTheTrash(env));
});

test('a file run with neither signal — a plain tsx run, outside npm test — refuses once it loads the data-folder fixture, as every test file that loads the app must (testDataIsolation.test.ts)', () => {
  // The control: the same child without the fixture is production, and its door goes ahead — to
  // the lstat of a path that does not exist, which fails there.
  const plain = childAsksTheTrash(withNeither());
  assert.equal(plain.status, 0, `outside a test runner nothing is refused: ${plain.stderr}`);
  const control = JSON.parse(plain.outcome) as { deleted: string[]; failed: Array<{ path: string; reason: string }> };
  assert.deepEqual(control.deleted, []);
  assert.deepEqual(control.failed.map((f) => f.path), [plain.missing], 'the door went ahead and failed on the missing path');
  assertChildRefused('a plain run that loads tests/fixtures/dataDir.ts', childAsksTheTrash(withNeither(), true));
});

/* ─────────────── Outside a test runner, every door goes ahead ─────────────── */

/**
 * Production parity for the doors past the Trash step, whose control is the
 * plain child above: each door, in a fresh process with neither signal — as
 * the real app runs it — goes ahead to the machine and answers as the machine
 * lets it. Under a test runner a door that refused always looks exactly like
 * the guard, so only a process outside one can tell them apart; and such a
 * door would break Empty Trash, the Trash's size, the snapshot purge, a cloud
 * file's trash or git gc for everyone.
 *
 * With the guard off nothing stands between a door and the machine but the
 * child's own disarming (tests/fixtures/disarmedMachine.ts): every child
 * process, every listing outside the child's own folder and every request is
 * recorded and refused, and the child proves so before it reaches the door.
 * Besides, PATH names an empty folder, HOME a folder of this file's own
 * outside the child's (so a listing of its Trash is refused too), and the
 * data folder is the child's, holding no cloud account.
 */
interface DoorAnswer {
  value?: unknown;
  error?: string;
  notDisarmed?: string;
  calls?: string[];
}

interface Door {
  /** The door's own imports, from src/. */
  imports: string[];
  /** Statements run before the machine is disarmed. */
  setup?: string[];
  /** The body of an async function that goes through the door and returns its answer. */
  act: string;
}

const SRC_MODULE = (rel: string): string => JSON.stringify(path.join(SRC, ...rel.split('/')));

function childAtTheDoor(door: Door): { status: number | null; stderr: string; answer: DoorAnswer; home: string } {
  const own = fileTempDir('treemap-guard-door-');
  const home = fileTempDir('treemap-guard-door-home-');
  const noCommands = fileTempDir('treemap-guard-door-no-commands-');
  const data = path.join(own, 'data');
  fs.mkdirSync(data);
  const answered = path.join(own, 'answered.json');
  const script = path.join(own, 'child.ts');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `import { disarmTheMachine } from ${JSON.stringify(path.join(__dirname, 'fixtures', 'disarmedMachine'))};`,
    ...door.imports,
    'const [answered, own] = process.argv.slice(2);',
    ...(door.setup ?? []),
    'void disarmTheMachine(own).then(async (calls) => {',
    '  const write = (answer: object): void => fs.writeFileSync(answered, JSON.stringify({ ...answer, calls }));',
    '  try {',
    `    write({ value: await (async () => { ${door.act} })() });`,
    '  } catch (err) {',
    '    write({ error: `${(err as Error).name}: ${(err as Error).message}` });',
    '  }',
    '}, (err: Error) => fs.writeFileSync(answered, JSON.stringify({ notDisarmed: err.message })));',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = withNeither();
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
  for (const name of ['TREEMAP_TRASH_DIR', 'XDG_DATA_HOME', ...Object.values(CLOUD_PROVIDERS).map((p) => p.variable)]) delete env[name];
  Object.assign(env, { PATH: noCommands, HOME: home, USERPROFILE: home, TREEMAP_DATA_DIR: data });
  const r = spawnSync(process.execPath, [TSX_CLI, script, answered, own], { env, encoding: 'utf8', timeout: 120_000 });
  const answer = fs.existsSync(answered) ? (JSON.parse(fs.readFileSync(answered, 'utf8')) as DoorAnswer) : { error: `(nothing answered; stdout: ${r.stdout})` };
  return { status: r.status, stderr: r.stderr, answer, home };
}

/** The child went through the door — no refusal, said or thrown — and ended well. */
function assertWentAhead(label: string, child: ReturnType<typeof childAtTheDoor>): DoorAnswer & { calls: string[] } {
  const { answer } = child;
  assert.equal(answer.notDisarmed, undefined, `${label}: the child stopped before the door, its machine not disarmed: ${String(answer.notDisarmed)}`);
  assert.doesNotMatch(child.stderr, /\[treemap\] REFUSED/, `${label}: outside a test runner nothing is refused: ${child.stderr}`);
  assert.equal(answer.error, undefined, `${label}: the door answered, rather than throwing: ${String(answer.error)}`);
  assert.equal(child.status, 0, `${label}: and the child ended well: ${child.stderr}`);
  return { ...answer, calls: answer.calls ?? [] };
}

test('outside a test runner, listing the Trash goes ahead: to the listing, which the disarmed machine refuses', () => {
  const child = childAtTheDoor({ imports: [`import { getTrashInfo } from ${SRC_MODULE('services/trash')};`], act: 'return getTrashInfo();' });
  const { value, calls } = assertWentAhead('listing', child);
  const firstTrash = process.platform === 'darwin' ? path.join(child.home, '.Trash')
    : process.platform === 'win32' ? path.join('C:\\', '$Recycle.Bin')
      : path.join(child.home, '.local', 'share', 'Trash', 'files');
  assert.ok(calls.includes(`readdir ${firstTrash}`), `the Trash was listed, where this platform keeps it: ${JSON.stringify(calls)}`);
  const info = value as { available: boolean; complete: boolean; itemCount: number };
  assert.deepEqual([info.available, info.complete, info.itemCount], [true, false, 0], `and the answer says it could not read it: ${JSON.stringify(value)}`);
});

test("outside a test runner, emptying the Trash goes ahead: to the machine's own emptier, which the disarmed machine does not start", () => {
  const child = childAtTheDoor({ imports: [`import { emptyTrash } from ${SRC_MODULE('services/trash')};`], act: 'return emptyTrash();' });
  const { value, calls } = assertWentAhead('emptying', child);
  const [{ cmd, args }] = emptyTrashCommands();
  assert.ok(calls.includes(`spawn ${[cmd, ...args].join(' ')}`), `the emptier was asked for: ${JSON.stringify(calls)}`);
  const result = value as { emptied: boolean; failed: Array<{ location: string }> };
  assert.equal(result.emptied, false, JSON.stringify(value));
  assert.equal(result.failed[0]?.location, cmd, `and the answer names it as what did not run: ${JSON.stringify(value)}`);
});

test("outside a test runner, deleting the machine's local snapshots goes ahead: to tmutil on a Mac, which the disarmed machine does not start, and to the platform's own answer elsewhere", () => {
  const child = childAtTheDoor({ imports: [`import { purgeSnapshots } from ${SRC_MODULE('services/snapshotAccounting')};`], act: 'return purgeSnapshots();' });
  const { value, calls } = assertWentAhead('purge', child);
  if (process.platform === 'darwin') {
    assert.deepEqual(calls, ['spawn tmutil listlocalsnapshots /'], 'tmutil was asked for the snapshots to delete');
    assert.deepEqual(value, { ok: true, deleted: 0, failed: 0 }, 'and, told of none, deleted none');
  } else {
    assert.deepEqual(calls, []);
    assert.deepEqual(value, { ok: false, deleted: 0, failed: 0, error: 'Purging snapshots is only supported on macOS' });
  }
});

test("outside a test runner, trashing a cloud file goes ahead for every provider: to the provider's own answer, that no account of it is set up here", () => {
  const act = [
    'const answers: Record<string, string> = {};',
    `for (const id of ${JSON.stringify(Object.keys(CLOUD_PROVIDERS))}) {`,
    "  const file = { name: 'a.txt', path: `cloud://${id}/a.txt`, size: 10, type: 'file', modifiedAt: 0, isHidden: false, cloudId: 'id:a' };",
    "  const root = { name: id, path: `cloud://${id}`, size: 10, type: 'dir', modifiedAt: 0, isHidden: false, children: [file] };",
    "  const scan = { rootPath: `cloud://${id}`, status: 'complete', root } as unknown as Parameters<typeof trashCloudPaths>[0];",
    '  answers[id] = await trashCloudPaths(scan, [file.path]).then((r) => JSON.stringify(r), (err: Error & { code?: string }) => `${err.code ?? err.name}: ${err.message}`);',
    '}',
    'return answers;',
  ].join('\n');
  const child = childAtTheDoor({ imports: [`import { trashCloudPaths } from ${SRC_MODULE('services/cloud/cloudScan')};`], act });
  const { value, calls } = assertWentAhead('cloud trash', child);
  assert.deepEqual(value, Object.fromEntries(Object.entries(CLOUD_PROVIDERS).map(([id, { name }]) => [id, `NO_CLIENT_ID: Add your ${name} app's client ID in Settings first`])));
  assert.deepEqual(calls, [], 'no request was even attempted');
});

test('outside a test runner, git gc goes ahead: to git, which the disarmed machine does not start', () => {
  const root = fileTempDir('treemap-guard-door-gc-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const child = childAtTheDoor({
    imports: [`import { runGitGc } from ${SRC_MODULE('services/gitScanner')};`, `import { createScanRecord } from ${SRC_MODULE('services/diskScanner')};`],
    setup: [`createScanRecord(${JSON.stringify(root)});`],
    act: `return runGitGc(${JSON.stringify(repo)});`,
  });
  const { value, calls } = assertWentAhead('git gc', child);
  assert.deepEqual(calls, [`spawn git -C ${sanitizePath(repo)} gc --aggressive --prune=now`], 'git was asked to gc the repository, and nothing else');
  assert.deepEqual(value, { ok: false, error: 'the machine is disarmed: git was not started' }, "and the answer is git's not running");
});
