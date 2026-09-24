import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * No test run may write into the owner's real app data. On 24 Sep 2026 the
 * owner's TreeMap history held 719 snapshots of the tests' own temp folders
 * (of 2,605): files that never pointed TREEMAP_DATA_DIR anywhere saved every
 * scan they ran into ~/Library/Application Support/TreeMap. `npm test` now
 * gives the whole run a data folder of its own unless one is set.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../scripts/run-tests.js') as {
  testEnvironment(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cleanup(): void };
  runTests(opts: {
    files: string[];
    argv: string[];
    env: NodeJS.ProcessEnv;
    spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => { status: number | null };
  }): number;
};

test('npm test gives a run with no data folder one of its own under the temp folder, and removes it afterwards', () => {
  const outer: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/Users/someone' };
  const { env, cleanup } = runner.testEnvironment(outer);
  const dir = env.TREEMAP_DATA_DIR;
  assert.ok(dir, 'the run has a data folder');
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep), `${dir} is under the temp folder`);
  assert.ok(fs.statSync(dir).isDirectory(), 'and it exists');
  assert.equal(env.PATH, outer.PATH, 'the rest of the environment passes through');
  assert.equal(outer.TREEMAP_DATA_DIR, undefined, 'the caller\'s environment is not changed');
  fs.writeFileSync(path.join(dir, 'snapshots.json'), '[]');
  cleanup();
  assert.equal(fs.existsSync(dir), false, 'the folder is gone after the run');
});

test('a data folder the caller chose is kept, and never removed', () => {
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-chosen-data-'));
  try {
    const { env, cleanup } = runner.testEnvironment({ TREEMAP_DATA_DIR: chosen });
    assert.equal(env.TREEMAP_DATA_DIR, chosen);
    cleanup();
    assert.ok(fs.existsSync(chosen), 'the caller\'s folder is theirs');
  } finally {
    fs.rmSync(chosen, { recursive: true, force: true });
  }
});

test('the test child runs with the run\'s data folder, which is gone once the child ends, whatever its status', () => {
  const seen: Array<{ dir: string | undefined; existed: boolean; args: string[] }> = [];
  const status = runner.runTests({
    files: ['tests/a.test.ts'],
    argv: ['--test-name-pattern=x'],
    env: { PATH: process.env.PATH },
    spawn: (_cmd, args, opts) => {
      const dir = opts.env.TREEMAP_DATA_DIR;
      seen.push({ dir, existed: dir !== undefined && fs.existsSync(dir), args });
      return { status: 3 };
    },
  });
  assert.equal(status, 3, 'the child\'s status is the run\'s');
  assert.equal(seen.length, 1);
  const [{ dir, existed, args }] = seen;
  assert.ok(dir && existed, `the child saw its own existing data folder: ${dir}`);
  assert.deepEqual(args.slice(-3), ['--test', '--test-name-pattern=x', 'tests/a.test.ts']);
  assert.equal(fs.existsSync(dir), false, 'removed after the child ended');

  let thrownDir: string | undefined;
  assert.throws(() => runner.runTests({
    files: [], argv: [], env: {},
    spawn: (_cmd, _args, opts) => {
      thrownDir = opts.env.TREEMAP_DATA_DIR;
      throw new Error('spawn failed');
    },
  }), /spawn failed/);
  assert.ok(thrownDir && !fs.existsSync(thrownDir), 'removed even when the child could not start');
});
