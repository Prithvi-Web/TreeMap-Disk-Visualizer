import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanUpDataDir, fileTempDir, isolatedDataDir, removeTempDir } from './fixtures/dataDir';
import { resetBackgroundWrites, trackWrite } from '../src/utils/backgroundWrites';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The fixture every test file uses to point the app's data folder
 * (TREEMAP_DATA_DIR) at a folder of its own. Those folders used to outlive
 * their files: one full `npm test` left 41 of them in the system temp folder
 * (23 Sep 2026), thousands over a day of runs.
 */

test('removeTempDir removes a folder and everything in it, and answers null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fixture-remove-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'snapshots.json'), '{}');
  assert.equal(removeTempDir(dir), null);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(removeTempDir(dir), null, 'a folder already gone is nothing to report');
});

test('a folder that cannot be removed is reported in words, never thrown: the tests it served have finished', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fixture-held-'));
  const realRm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target: fs.PathLike, options?: fs.RmOptions) => {
    if (target === dir) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dir}'`), { code: 'EBUSY' });
    return realRm(target, options);
  });
  assert.equal(removeTempDir(dir), `[tests] ${dir} was left behind: EBUSY: resource busy or locked, rmdir '${dir}'`);
  t.mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleaning up waits for the app\'s background saves, so a late snapshot cannot bring the folder back', async () => {
  // A scan saves its snapshot and cache after it has answered (trackWrite in
  // diskScanner.ts); one that landed after the removal re-made the folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fixture-late-'));
  const late = trackWrite('saveSnapshot', (async () => {
    await delay(50);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snapshots.json'), '{}');
  })());
  assert.deepEqual(await cleanUpDataDir(dir), [], 'nothing to report');
  await late;
  assert.equal(fs.existsSync(dir), false, 'the save finished first, and the folder went after it');
});

test('a save that never finishes is named once the wait runs out, and the folder is removed anyway', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fixture-stuck-'));
  trackWrite('stuck save', new Promise<void>(() => {}));
  try {
    const notes = await cleanUpDataDir(dir, 30);
    assert.equal(notes.length, 1, notes.join('\n'));
    assert.match(notes[0], /^\[tests\] background saves still running after 30 ms: stuck save \(\d+ms\)$/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    resetBackgroundWrites();
  }
});

test('a test file leaves no folder behind when it ends: its app data, and a folder one of its tests made', () => {
  // The hook runs when the file's tests are done, so only a file of its own,
  // run as npm test runs one, can show it.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-fixture-child-'));
  try {
    const report = path.join(work, 'data-dir.txt');
    const child = path.join(work, 'child.test.ts');
    fs.writeFileSync(child, [
      "import { test } from 'node:test';",
      "import fs from 'node:fs';",
      `import { fileTempDir, isolatedDataDir } from ${JSON.stringify(path.join(__dirname, 'fixtures', 'dataDir'))};`,
      "const dir = isolatedDataDir('treemap-fixture-child-data-');",
      "test('writes into both', () => {",
      "  const inTest = fileTempDir('treemap-fixture-child-own-');",
      "  fs.writeFileSync(dir + '/snapshots.json', '{}');",
      "  fs.writeFileSync(inTest + '/a.txt', 'a');",
      "  fs.writeFileSync(process.env.REPORT_FILE as string, JSON.stringify([dir, inTest]));",
      "});",
    ].join('\n'));
    const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    // Without NODE_TEST_CONTEXT, which this runner sets: a child that inherits it
    // reports to this runner instead of running its own file.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const r = spawnSync(process.execPath, [tsxCli, '--test', child], { encoding: 'utf8', timeout: 120_000, env: { ...env, REPORT_FILE: report } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [dir, inTest] = JSON.parse(fs.readFileSync(report, 'utf8')) as [string, string];
    assert.match(path.basename(dir), /^treemap-fixture-child-data-/);
    assert.match(path.basename(inTest), /^treemap-fixture-child-own-/);
    for (const made of [dir, inTest]) assert.equal(fs.existsSync(made), false, `${made} outlived the file that made it`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('fileTempDir makes a new, empty folder under the system temp folder and leaves TREEMAP_DATA_DIR alone', () => {
  const before = process.env.TREEMAP_DATA_DIR;
  const dir = fileTempDir('treemap-fixture-own-');
  assert.equal(process.env.TREEMAP_DATA_DIR, before);
  assert.equal(path.dirname(dir), os.tmpdir());
  assert.match(path.basename(dir), /^treemap-fixture-own-[A-Za-z0-9]{6}$/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('isolatedDataDir points TREEMAP_DATA_DIR at a new, empty folder under the system temp folder', () => {
  const before = process.env.TREEMAP_DATA_DIR;
  try {
    const dir = isolatedDataDir('treemap-fixture-data-');
    assert.equal(process.env.TREEMAP_DATA_DIR, dir);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.match(path.basename(dir), /^treemap-fixture-data-[A-Za-z0-9]{6}$/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    if (before === undefined) delete process.env.TREEMAP_DATA_DIR;
    else process.env.TREEMAP_DATA_DIR = before;
  }
});
