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
const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const files = readdirSync(path.join(repoRoot, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join('tests', name));

if (files.length === 0) {
  console.error('run-tests: no tests/*.test.ts files found');
  process.exit(1);
}

// Resolve tsx's real entry point and run it under this same Node — spawning
// the .cmd shim on Windows is exactly the kind of shell dependence this
// script exists to remove.
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [tsxCli, '--test', ...process.argv.slice(2), ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
