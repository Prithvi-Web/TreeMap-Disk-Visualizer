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

/**
 * Test files that load the app's code and deliberately leave TREEMAP_DATA_DIR
 * unset for a test, each with the reason. Such a file saves and restores the
 * variable around that test itself.
 */
const DEFAULT_DATA_DIR_ALLOWED: Readonly<Record<string, string>> = {};

/** A static import, a require or a dynamic import of the app's own code. */
const LOADS_APP_CODE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"]\.\.\/src\//;
/**
 * A line that starts in column 0 with the fixture's call (alone, as
 * `const X = isolatedDataDir(`, or as `if (!process.env.TREEMAP_DATA_DIR)
 * isolatedDataDir(`) or with an assignment to the variable itself. An
 * assignment inside a helper is indented, so it does not count: it points the
 * folder away for that helper's test only.
 */
const POINTS_DATA_DIR = /^(?:(?:const|let)\s+\w+\s*=\s*|if\s*\(\s*!process\.env\.TREEMAP_DATA_DIR\s*\)\s*)?isolatedDataDir\(|^process\.env\.TREEMAP_DATA_DIR\s*=(?!=)/;
/** Block comments at the start of a line that close on that line; the indent before them is kept. */
const LEADING_BLOCK_COMMENTS = /^(\s*)(?:\/\*.*?\*\/\s*)+/;
/**
 * A line that, with those removed, starts with a comment token: `//`, `/*`
 * or a doc comment's `*`. Text inside strings, and a line inside a block
 * comment that does not start with `*`, are not told apart from code.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function hasCodeLine(source: string, pattern: RegExp): boolean {
  return source.split('\n').some((line) => {
    const code = line.replace(LEADING_BLOCK_COMMENTS, '$1');
    return !COMMENT_LINE.test(code) && pattern.test(code);
  });
}

const loadsAppCode = (source: string): boolean => hasCodeLine(source, LOADS_APP_CODE);
const pointsDataDirAway = (source: string): boolean => hasCodeLine(source, POINTS_DATA_DIR);

test('only a statement at the top of a file points its data folder away; an assignment inside a helper does not', () => {
  for (const topLevel of [
    "isolatedDataDir('treemap-x-data-');",
    "const DATA_DIR = isolatedDataDir('treemap-x-data-');",
    "if (!process.env.TREEMAP_DATA_DIR) isolatedDataDir('treemap-x-route-');",
    'process.env.TREEMAP_DATA_DIR = DATA_DIR;',
    "/* for the whole file */ isolatedDataDir('treemap-x-data-');",
  ]) assert.equal(pointsDataDirAway(topLevel), true, topLevel);

  // storageCorrupt.test.ts's helper before 24 Sep 2026, the only assignment
  // in that file: it pointed the folder away for one test, then assigned
  // `prior` back, which stores the string "undefined" when prior is unset.
  const helperOnly = [
    'function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {',
    "  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-corrupt-'));",
    '  const prior = process.env.TREEMAP_DATA_DIR;',
    '  process.env.TREEMAP_DATA_DIR = dir;',
    '  return fn(dir).finally(() => {',
    '    process.env.TREEMAP_DATA_DIR = prior;',
    '  });',
    '}',
  ].join('\n');
  for (const notTopLevel of [
    helperOnly,
    "  isolatedDataDir('treemap-x-data-');",
    "  /* for this test */ isolatedDataDir('treemap-x-data-');",
    'process.env.TREEMAP_DATA_DIR === DATA_DIR;',
    "// isolatedDataDir('treemap-x-data-');",
    // A child's source held in a string, as dataDirFixture.test.ts writes one.
    "      \"const dir = isolatedDataDir('treemap-fixture-child-data-');\",",
  ]) assert.equal(pointsDataDirAway(notTopLevel), false, notTopLevel);
});

// The app's folder, spelled so that the examples below, which are strings,
// do not make this file one that loads the app's code in the guard's eyes.
const SRC = '../' + 'src/';

test('code after a block comment closed on the same line is code; a comment is not', () => {
  assert.equal(loadsAppCode(`/* the store */ import { writeJsonFile } from '${SRC}services/storage';`), true);
  for (const comment of [
    `// import { writeJsonFile } from '${SRC}services/storage';`,
    `/* import { writeJsonFile } from '${SRC}services/storage'; */`,
    ` * import { writeJsonFile } from '${SRC}services/storage';`,
  ]) assert.equal(loadsAppCode(comment), false, comment);
});

test('the pattern for loading the app\'s code sees each form a test file loads it in', () => {
  for (const line of [
    `import { estimateCost } from '${SRC}services/costIntelligence';`,
    `} from '${SRC}services/compressionAdvisor';`,
    `const { getTrashInfo } = await import('${SRC}services/trash');`,
    `const storage = require('${SRC}services/storage');`,
  ]) assert.equal(loadsAppCode(line), true, line);
});

test('every test file that loads the app\'s code points its data folder away from the owner\'s, or says why it does not', () => {
  // `npm test` sets TREEMAP_DATA_DIR for the whole run, but `npx tsx --test
  // tests/x.test.ts` does not: a file that never points the variable
  // anywhere saves every scan it runs into the owner's real app data.
  const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.ts')).sort();
  const loadsApp = files.filter((name) => loadsAppCode(fs.readFileSync(path.join(__dirname, name), 'utf8')));
  // One file for each form the tests load the app's code in, so a pattern
  // that loses a form fails here rather than dropping those files from view.
  // No test file loads it with require() (24 Sep 2026); the test above holds
  // that form.
  for (const [name, form] of [
    ['apiContract.test.ts', 'a one-line static import'],
    ['costIntelligence.test.ts', 'a static import across lines, and nothing else'],
    ['trashInfo.test.ts', 'a dynamic import(), and nothing else'],
  ]) assert.ok(loadsApp.includes(name), `the pattern misses ${name}, which loads the app's code with ${form}`);

  const unpointed = loadsApp.filter((name) =>
    !pointsDataDirAway(fs.readFileSync(path.join(__dirname, name), 'utf8'))
    && !Object.hasOwn(DEFAULT_DATA_DIR_ALLOWED, name));
  assert.deepEqual(unpointed, [], `these files load the app's code without isolatedDataDir( or an assignment to process.env.TREEMAP_DATA_DIR at the top of the file: ${unpointed.join(', ')}`);

  for (const [name, reason] of Object.entries(DEFAULT_DATA_DIR_ALLOWED)) {
    assert.ok(reason.trim().length > 0, `${name} is allowed the default data folder without a reason`);
    assert.ok(loadsApp.includes(name), `${name} is allowed the default data folder but does not load the app's code`);
  }
});
