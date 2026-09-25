import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileTempDir } from './fixtures/dataDir';
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
 * `npm test` passes --test-timeout, which the runner enforces per file from
 * the parent process as well as per test inside it.
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
  // told it is a run of its own: this process's NODE_TEST_CONTEXT is not
  // handed on.
  const env: NodeJS.ProcessEnv = { ...process.env, TREEMAP_DATA_DIR: dir };
  delete env.NODE_TEST_CONTEXT;
  // npm test's own path: run-tests.js, tsx's runner under this Node, the
  // flags passed through; only the output is captured instead of inherited.
  // The limit also covers the file after the blocked one, so it is generous:
  // ten seconds, far above a slow runner starting a trivial file.
  const status = runner.runTests({
    files: [blocked, after],
    argv: ['--test-timeout=10000', '--test-reporter=tap'],
    env,
    spawn: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { ...opts, stdio: 'pipe', encoding: 'utf8', timeout: HANG_GUARD_MS });
      out = `${r.stdout}${r.stderr}`;
      return { status: r.status };
    },
  });
  assert.equal(status, 1, `the run fails, and says so:\n${out}`);
  assert.match(out, /not ok \d+ - [^\n]*a-blocks\.test\.mjs[\s\S]*?test timed out after 10000ms/, 'the blocked file is named, with the limit it met');
  assert.match(out, /^ok \d+ - runs after the blocked file$/m, 'and the file after it still ran and reported');
});
