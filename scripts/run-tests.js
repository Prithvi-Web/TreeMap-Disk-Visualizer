#!/usr/bin/env node
/*
 * Cross-shell test runner.
 *
 * `tsx --test tests/*.test.ts` relies on the SHELL expanding the glob. That
 * happens under zsh/bash (macOS, Linux) but not under cmd.exe or PowerShell —
 * npm on Windows hands tsx the literal string `tests/*.test.ts`, and Node 20's
 * test runner cannot discover .ts files on its own. The suite therefore never
 * ran on Windows CI at all.
 *
 * This expands the list in JS instead, so `npm test` means exactly the same
 * thing on every OS and in every shell. Extra arguments pass straight through:
 * `npm test -- --test-name-pattern="foo"` still works.
 */
const { mkdtempSync, readdirSync, rmSync } = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

/**
 * The environment the test run gets. With no TREEMAP_DATA_DIR set, the run
 * gets a data folder of its own under the temp folder, removed by `cleanup`:
 * a test file that never pointed the app's data folder anywhere otherwise
 * saved every scan it ran into the owner's real one (on 24 Sep 2026, 719 of
 * the 2,605 snapshots in the owner's TreeMap history were the tests' own temp
 * folders). A folder the caller chose is used as it is and never removed.
 */
function testEnvironment(env) {
  if (env.TREEMAP_DATA_DIR) return { env: { ...env }, cleanup() {} };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'treemap-test-run-data-'));
  return {
    env: { ...env, TREEMAP_DATA_DIR: dir },
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * Runs tsx's test runner over `files` with `argv` in front, in the
 * environment `testEnvironment` gives, and returns its exit status; the run's
 * own data folder is removed however the run ends. `spawn` is spawnSync's
 * shape, so a test can stand in for the child.
 */
function runTests({ files, argv, env, spawn }) {
  // Resolve tsx's real entry point and run it under this same Node — spawning
  // the .cmd shim on Windows is exactly the kind of shell dependence this
  // script exists to remove.
  const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const run = testEnvironment(env);
  try {
    const result = spawn(process.execPath, [tsxCli, '--test', ...argv, ...files], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: run.env,
    });
    return result.status ?? 1;
  } finally {
    run.cleanup();
  }
}

function main() {
  const files = readdirSync(path.join(repoRoot, 'tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => path.join('tests', name));

  if (files.length === 0) {
    console.error('run-tests: no tests/*.test.ts files found');
    process.exit(1);
  }
  process.exit(runTests({ files, argv: process.argv.slice(2), env: process.env, spawn: spawnSync }));
}

module.exports = { testEnvironment, runTests };

if (require.main === module) main();
