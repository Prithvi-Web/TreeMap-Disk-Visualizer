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
 * Every nested run is built from this, so none has to remember either rule.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ARMED } = require('../../scripts/testFileWatchdog.cjs') as { ARMED: string };

export function nestedRunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const fresh = { ...env };
  delete fresh.NODE_TEST_CONTEXT;
  delete fresh[ARMED];
  return fresh;
}
