'use strict';
/*
 * testFileWatchdog — ends a test file that outlives its time limit, on every Node version.
 *
 * `npm test` gives every test file a time limit (`--test-timeout`, package.json),
 * so a file that never returns costs the run one named failure instead of the
 * whole job. Node 20 enforces that limit from the runner's own process: the
 * file's test times out there, and the runner ends the file's process. Node 24
 * does not: its runner gives each file's test no timeout
 * (`this.timeout = null` in internal/test_runner/runner.js) and only forwards
 * the flag to the file's own process, which applies it test by test on its
 * main thread — so a test that blocks that thread (a synchronous loop,
 * `Atomics.wait`, a hang inside `assert`) is never ended, and the run waits
 * for that file forever while the files after it never report.
 *
 * run-tests.js loads this module into every process of a run (`--require`).
 * It watches the main thread of a process the runner started for a test file
 * (NODE_TEST_CONTEXT, which the runner sets) that was given a limit. A worker
 * thread, which a blocked main thread cannot hold up, waits the limit plus a
 * grace that leaves Node its own say where Node has one, then writes one line
 * naming the file and the limit straight to stderr and ends the process with
 * SIGKILL: a SIGTERM handler the file's code installed (the app's entry points
 * install one, src/index.ts and src/mcp/index.ts) would have to run on the
 * blocked thread. The runner then reports the file as failed and runs the next.
 * The worker is unref'd, so a file that finishes never waits for it.
 *
 * `fork()` and `spawn` hand a child the parent's flags and environment, the
 * runner's context and limit included, so a watched file marks its own
 * environment (ARMED) and a process started under that mark is never watched:
 * only the runner starts test files. run-tests.js clears the mark for a run
 * of its own.
 */
const { isMainThread, Worker } = require('node:worker_threads');

/** The variable a watched test file sets in its own environment, so whatever it starts is never watched. */
const ARMED = 'TREEMAP_TEST_WATCHDOG';
/** The most grace the watchdog gives Node's own limit, in ms. */
const MAX_GRACE_MS = 5_000;

/**
 * The per-file limit in `execArgv` (`--test-timeout=N`), or null when there
 * is none or it is not a positive whole number. A run with no limit hands
 * every file `--test-timeout=0`, which means none. The runner passes a file
 * the one value it resolved, so the first flag is the one in force.
 */
function limitOf(execArgv) {
  const flag = execArgv.find((arg) => arg.startsWith('--test-timeout='));
  if (flag === undefined) return null;
  const ms = Number(flag.slice('--test-timeout='.length));
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** Whether this environment is one the test runner gives a test file's process. */
function isTestFileProcess(env) {
  return typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.startsWith('child');
}

/**
 * Whether to watch a thread: the main thread of a process the runner started
 * for a test file, given a limit, and not started under a watched file's mark.
 * A worker thread inherits its process's flags, so it is left to the one
 * watchdog its main thread starts.
 */
function shouldArm({ mainThread, env, execArgv }) {
  return mainThread && isTestFileProcess(env) && env[ARMED] === undefined && limitOf(execArgv) !== null;
}

/** How long the watchdog waits for a file limited to `limit` ms: the limit, then a fifth of it, at most MAX_GRACE_MS. */
function delayFor(limit) {
  return limit + Math.min(MAX_GRACE_MS, Math.ceil(limit / 5));
}

/** The line the watchdog writes before it ends `file`. */
function lineFor(file, limit, nodeVersion) {
  return `run-tests: ${file} was ended after the ${limit} ms per-file limit (--test-timeout): it was still running, and the test runner of Node ${nodeVersion} does not end a test file itself\n`;
}

/** Starts the watchdog for this process; returns the worker, or null when this process is not one to watch. */
function arm() {
  if (!shouldArm({ mainThread: isMainThread, env: process.env, execArgv: process.execArgv })) return null;
  process.env[ARMED] = String(process.pid);
  const limit = limitOf(process.execArgv);
  const worker = new Worker(
    `const fs = require('node:fs');
     const { workerData } = require('node:worker_threads');
     setTimeout(() => {
       fs.writeSync(2, workerData.line);
       process.kill(workerData.pid, 'SIGKILL');
     }, workerData.delay);`,
    { eval: true, workerData: { pid: process.pid, delay: delayFor(limit), line: lineFor(process.argv[1] ?? 'a test file', limit, process.version) } },
  );
  worker.unref();
  return worker;
}

arm();

module.exports = { ARMED, MAX_GRACE_MS, limitOf, isTestFileProcess, shouldArm, delayFor, lineFor };
