import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileTempDir } from './fixtures/dataDir';
import { nestedRunEnv } from './fixtures/nestedRun';
import { HANG_GUARD_MS } from './fixtures/waitFor';

/**
 * scripts/testFileWatchdog.cjs ends a test file whose thread never yields,
 * which Node 24's test runner no longer does itself (see the module). The
 * end-to-end check is testFileTimeout.test.ts, which meets whichever
 * mechanism the running Node has; these tests run the watchdog on every Node,
 * so CI's Node 20 exercises its code too. They count outcomes (how a process
 * ended, what it wrote), never durations; the spawn timeout is a hang guard.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const watchdog = require('../scripts/testFileWatchdog.cjs') as {
  ARMED: string;
  MAX_GRACE_MS: number;
  limitOf(execArgv: string[]): number | null;
  isTestFileProcess(env: NodeJS.ProcessEnv): boolean;
  shouldArm(at: { mainThread: boolean; env: NodeJS.ProcessEnv; execArgv: string[] }): boolean;
  delayFor(limit: number): number;
  lineFor(file: string, limit: number, nodeVersion: string): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../scripts/run-tests.js') as {
  WATCHDOG: string;
  runTests(opts: {
    files: string[];
    argv: string[];
    env: NodeJS.ProcessEnv;
    spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { status: number | null };
  }): number;
};

/** Blocks the main thread for good: nothing in the process can end it. */
const BLOCKS = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n';
/** Blocks the main thread for `ms`, then lets the process end on its own. */
const blocksFor = (ms: number): string => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`;

/**
 * An environment the test runner gives a test file's process, built from
 * nestedRunEnv: under npm test the watchdog watches this very file, so this
 * file's own environment holds the mark, which a runner's never does.
 */
function asTestFile(): NodeJS.ProcessEnv {
  return { ...nestedRunEnv(), NODE_TEST_CONTEXT: 'child-v8' };
}

/** An environment no test runner made. */
function notATestFile(): NodeJS.ProcessEnv {
  return nestedRunEnv();
}

/** Runs `script` as a file in a fresh Node that loads the watchdog, with `flags` in front. */
function runScript(dir: string, script: string, flags: string[], env: NodeJS.ProcessEnv): { file: string; r: SpawnSyncReturns<string> } {
  const file = path.join(dir, `script-${fs.readdirSync(dir).length}.cjs`);
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, ['--require', runner.WATCHDOG, ...flags, file], { env, encoding: 'utf8', timeout: HANG_GUARD_MS });
  return { file, r };
}

/** How the watchdog's SIGKILL shows: a signal on POSIX; on Windows, TerminateProcess with exit code 1. */
function assertKilled(r: SpawnSyncReturns<string>): void {
  if (process.platform === 'win32') assert.equal(r.status, 1, `ended by the watchdog: ${r.stderr}`);
  else assert.equal(r.signal, 'SIGKILL', `ended by the watchdog, not status ${r.status}: ${r.stderr}`);
}

/** A process that ended on its own, with nothing from the watchdog. */
function assertUntouched(r: SpawnSyncReturns<string>): void {
  assert.equal(r.signal, null, `not killed: ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /run-tests:/, 'the watchdog wrote nothing');
}

test('the limit is read from --test-timeout, and only a positive whole number is one', () => {
  assert.equal(watchdog.limitOf(['--test-timeout=1200000']), 1_200_000);
  assert.equal(watchdog.limitOf(['--require', 'x.cjs', '--test-timeout=30000', '--test-reporter=tap']), 30_000);
  for (const none of [[], ['--test'], ['--test-timeout='], ['--test-timeout=0'], ['--test-timeout=-5'], ['--test-timeout=1.5'], ['--test-timeout=abc'], ['--test-timeout=9007199254740992']]) {
    assert.equal(watchdog.limitOf(none), null, JSON.stringify(none));
  }
});

test('only a process a test runner started for a file is watched, never the runner itself', () => {
  assert.equal(watchdog.isTestFileProcess({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(watchdog.isTestFileProcess({ NODE_TEST_CONTEXT: 'child' }), true);
  for (const env of [{}, { NODE_TEST_CONTEXT: '' }, { NODE_TEST_CONTEXT: 'parent' }]) {
    assert.equal(watchdog.isTestFileProcess(env), false, JSON.stringify(env));
  }
});

test('a watchdog starts only on the main thread of a test file given a limit', () => {
  const file = { NODE_TEST_CONTEXT: 'child-v8' };
  const limited = ['--test-timeout=200'];
  assert.equal(watchdog.shouldArm({ mainThread: true, env: file, execArgv: limited }), true);
  assert.equal(watchdog.shouldArm({ mainThread: false, env: file, execArgv: limited }), false, 'a worker thread');
  assert.equal(watchdog.shouldArm({ mainThread: true, env: {}, execArgv: limited }), false, 'not a test file');
  assert.equal(watchdog.shouldArm({ mainThread: true, env: file, execArgv: [] }), false, 'no limit');
  assert.equal(watchdog.shouldArm({ mainThread: true, env: { ...file, [watchdog.ARMED]: '4242' }, execArgv: limited }), false, 'started under a watched file');
});

test('the watchdog waits out the limit and then a fifth of it more, never more than five seconds more', () => {
  assert.equal(watchdog.MAX_GRACE_MS, 5_000);
  assert.equal(watchdog.delayFor(1), 2);
  assert.equal(watchdog.delayFor(300), 360);
  assert.equal(watchdog.delayFor(20_000), 24_000);
  assert.equal(watchdog.delayFor(30_000), 35_000);
  assert.equal(watchdog.delayFor(1_200_000), 1_205_000);
});

test('a test file whose thread never yields is ended, and the line names the file and the limit it met', () => {
  const dir = fileTempDir('treemap-watchdog-');
  const { file, r } = runScript(dir, BLOCKS, ['--test-timeout=200'], asTestFile());
  assertKilled(r);
  assert.equal(r.stderr, watchdog.lineFor(file, 200, process.version));
  assert.match(r.stderr, /^run-tests: .*script-0\.cjs was ended after the 200 ms per-file limit/);
});

test('a test file that finishes is never kept waiting for its watchdog', () => {
  const dir = fileTempDir('treemap-watchdog-');
  // The limit is short enough that a watchdog that kept the process alive
  // would end it well inside the hang guard, as a kill instead of an exit.
  assertUntouched(runScript(dir, 'process.exitCode = 0;\n', ['--test-timeout=2000'], asTestFile()).r);
});

test('a process no test runner started is never watched, whatever its flags say', () => {
  const dir = fileTempDir('treemap-watchdog-');
  // Outlives a 200 ms limit tenfold and then ends by itself.
  assertUntouched(runScript(dir, blocksFor(2_000), ['--test-timeout=200'], notATestFile()).r);
});

test('a test file given no limit is never watched', () => {
  const dir = fileTempDir('treemap-watchdog-');
  assertUntouched(runScript(dir, blocksFor(2_000), [], asTestFile()).r);
});

test('a watched test file marks its own environment, and a process not watched does not', () => {
  const dir = fileTempDir('treemap-watchdog-');
  const printMark = `process.stdout.write(String(process.env.${watchdog.ARMED}));\n`;
  const watched = runScript(dir, printMark, ['--test-timeout=60000'], asTestFile()).r;
  assertUntouched(watched);
  assert.equal(watched.stdout, String(watched.pid), 'the mark names the watched process');
  const notWatched = runScript(dir, printMark, ['--test-timeout=60000'], notATestFile()).r;
  assertUntouched(notWatched);
  assert.equal(notWatched.stdout, 'undefined');
});

test("a process started under a watched file's mark is never watched, though it carries the runner context and a limit", () => {
  const dir = fileTempDir('treemap-watchdog-');
  // Outlives its 200 ms limit and grace tenfold and then ends by itself.
  assertUntouched(runScript(dir, blocksFor(2_400), ['--test-timeout=200'], { ...asTestFile(), [watchdog.ARMED]: '4242' }).r);
});

test('a child a watched test file forks is never watched, though fork hands it the runner context and a limit', () => {
  const dir = fileTempDir('treemap-watchdog-');
  const child = path.join(dir, 'forked.cjs');
  fs.writeFileSync(child, blocksFor(2_400));
  // fork() hands the child this file's flags and environment; its limit is
  // lowered to 200 ms here so that, watched, it would be ended long before it
  // finishes on its own.
  const parent =
    "const { fork } = require('node:child_process');\n" +
    "const execArgv = process.execArgv.filter((a) => !a.startsWith('--test-timeout=')).concat('--test-timeout=200');\n" +
    `fork(${JSON.stringify(child)}, { execArgv }).on('exit', (code, signal) => process.stdout.write(JSON.stringify({ code, signal })));\n`;
  const { r } = runScript(dir, parent, ['--test-timeout=60000'], asTestFile());
  assertUntouched(r);
  assert.deepEqual(JSON.parse(r.stdout), { code: 0, signal: null }, 'the forked child ended on its own');
});

test('a run clears the mark, so a run started inside a watched test file watches its own files', () => {
  const seen: NodeJS.ProcessEnv[] = [];
  runner.runTests({
    files: ['tests/a.test.ts'],
    argv: [],
    env: { PATH: process.env.PATH, [watchdog.ARMED]: '4242' },
    spawn: (_cmd, _args, opts) => {
      seen.push(opts.env);
      return { status: 0 };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][watchdog.ARMED], undefined);
});

test('every run loads the watchdog before the test runner starts', () => {
  assert.ok(fs.existsSync(runner.WATCHDOG), runner.WATCHDOG);
  const seen: string[][] = [];
  runner.runTests({
    files: ['tests/a.test.ts'],
    argv: ['--test-timeout=5'],
    env: { PATH: process.env.PATH },
    spawn: (_cmd, args) => {
      seen.push(args);
      return { status: 0 };
    },
  });
  assert.equal(seen.length, 1);
  const args = seen[0];
  const at = args.indexOf('--require');
  assert.ok(at >= 0 && args[at + 1] === runner.WATCHDOG, `--require ${runner.WATCHDOG} in ${JSON.stringify(args)}`);
  assert.ok(at < args.indexOf('--test'), 'before --test, where Node takes it for itself and every file');
});
