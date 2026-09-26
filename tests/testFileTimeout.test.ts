import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileTempDir } from './fixtures/dataDir';
import { nestedRunEnv } from './fixtures/nestedRun';
import { HANG_GUARD_MS } from './fixtures/waitFor';

/**
 * A test file that never returns must cost the run one named failure, never
 * the run. On Node 20 (CI's version) a failing `assert.ok(x)` with no message
 * rebuilds its message by re-reading the .ts file and parsing it at the
 * position of tsx's compiled code; in a large file that search does not come
 * back. Seen 25 Sep 2026 in tests/mcp.test.ts's "missing_gigabytes is inert",
 * on a machine whose disk layout the statement cannot place: still running
 * after 120 s on Node 20, reported in 1 s on Node 22. Node's runner prints
 * files in order, so that one file also held back the results of every file
 * after it, and CI's test step had no limit short of GitHub's six hours.
 * `npm test` passes --test-timeout, which Node 20's runner (CI's) enforces
 * per file from the parent process as well as per test inside it. Node 24's
 * runner gives a file's test no timeout in the parent (runner.js sets it to
 * null) and only forwards the flag to the file, where a blocked thread cannot
 * act on it, so there run-tests.js's watchdog (scripts/testFileWatchdog.cjs,
 * testFileWatchdog.test.ts) ends the file instead.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../scripts/run-tests.js') as {
  runTests(opts: {
    files: string[];
    argv: string[];
    env: NodeJS.ProcessEnv;
    spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { status: number | null };
  }): number;
};

const testScript = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts.test;

test('npm test gives every test file a time limit, far above the slowest honest one', () => {
  const limit = /--test-timeout=(\d+)(?:\s|$)/.exec(testScript);
  assert.ok(limit, `npm test passes --test-timeout (the script is: ${testScript})`);
  const ms = Number(limit[1]);
  assert.ok(ms >= 10 * 60_000, `at least ten minutes, well above any honest file on a loaded runner, not ${ms} ms`);
  assert.ok(ms <= 30 * 60_000, `at most half an hour, so a hang costs one file and not the job, not ${ms} ms`);
});

test('a file that blocks is ended and named by the runner, and the file after it still reports', () => {
  const dir = fileTempDir('treemap-test-timeout-');
  // Blocks its thread without spinning a core (no busy loop): nothing inside
  // the file can end it, so only the runner in the parent process can.
  const blocked = path.join(dir, 'a-blocks.test.mjs');
  const after = path.join(dir, 'b-after.test.mjs');
  fs.writeFileSync(blocked, "import { test } from 'node:test';\ntest('blocks its thread', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });\n");
  fs.writeFileSync(after, "import { test } from 'node:test';\ntest('runs after the blocked file', () => {});\n");
  let out = '';
  // A runner started from inside a test file skips its files unless it is
  // told it is a run of its own (nestedRunEnv).
  const env: NodeJS.ProcessEnv = { ...nestedRunEnv(), TREEMAP_DATA_DIR: dir };
  // npm test's own path: run-tests.js, tsx's runner under this Node, the
  // flags passed through; only the output is captured instead of inherited.
  // The limit also covers the file after the blocked one, which has to start
  // Node and tsx inside it while the whole suite runs beside it, so it is
  // generous: thirty seconds, which the blocked file then spends waiting.
  const limitMs = 30_000;
  const status = runner.runTests({
    files: [blocked, after],
    argv: [`--test-timeout=${limitMs}`, '--test-reporter=tap'],
    env,
    spawn: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { ...opts, stdio: 'pipe', encoding: 'utf8', timeout: HANG_GUARD_MS });
      out = `${r.stdout}${r.stderr}`;
      return { status: r.status };
    },
  });
  assert.equal(status, 1, `the run fails, and says so:\n${out}`);
  assert.match(out, /^not ok \d+ - [^\n]*a-blocks\.test\.mjs$/m, 'the blocked file is reported as failed');
  // Which mechanism ends the file is the running Node's, and each is held to
  // it where it is known: Node 20 (CI's) ends the file itself, inside the
  // grace the watchdog leaves it, so no watchdog line may appear; Node 24's
  // runner never ends a file, so the watchdog must, naming the file and the
  // limit. Both name the limit the file met. The order of the watchdog's line
  // and the runner's report in the output is Node's, so it is not relied on.
  const byRunner = new RegExp(`not ok \\d+ - [^\\n]*a-blocks\\.test\\.mjs[\\s\\S]*?test timed out after ${limitMs}ms`).test(out);
  const byWatchdog = out.includes(`a-blocks.test.mjs was ended after the ${limitMs} ms per-file limit`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major <= 20) assert.ok(byRunner && !byWatchdog, `Node ${process.version} ends the file itself, before the watchdog would:\n${out}`);
  else if (major >= 24) assert.ok(byWatchdog && !byRunner, `Node ${process.version}'s runner does not end a file, so the watchdog does:\n${out}`);
  else assert.ok(byRunner !== byWatchdog, `exactly one mechanism ends the file on Node ${process.version}:\n${out}`);
  assert.match(out, /^ok \d+ - runs after the blocked file$/m, 'and the file after it still ran and reported');
});
