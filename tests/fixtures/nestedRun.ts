/**
 * The environment for a test run, or a runner-started process, begun from
 * inside a test file: this file's own environment without what it carries
 * only because a run started it.
 *
 * - NODE_TEST_CONTEXT is the runner's: a process that inherits it reports to
 *   this file's runner instead of running files of its own.
 * - The watchdog's mark (scripts/testFileWatchdog.cjs, ARMED) is set by the
 *   watchdog that watches this file under `npm test`: a process started under
 *   it is never watched, so the files of a nested run would not be either.
 *
 * What it keeps, and puts in if it is missing, is npm test's own variable
 * (FORBID_REAL_TRASH, scripts/run-tests.js): NODE_TEST_CONTEXT was the one
 * sign of a test runner a file run with `--test` outside npm test had, and a
 * process begun from a test file is under a test runner too — so it refuses to
 * reach the machine's Trash (src/services/realMachineGuard.ts).
 *
 * Every nested run is built from this, so none has to remember either rule.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ARMED } = require('../../scripts/testFileWatchdog.cjs') as { ARMED: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FORBID_REAL_TRASH } = require('../../scripts/run-tests.js') as { FORBID_REAL_TRASH: string };

export function nestedRunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const fresh = { ...env };
  delete fresh.NODE_TEST_CONTEXT;
  delete fresh[ARMED];
  fresh[FORBID_REAL_TRASH] = '1';
  return fresh;
}
