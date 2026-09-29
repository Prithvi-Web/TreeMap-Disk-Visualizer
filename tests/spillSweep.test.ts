import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-spillSweep-data-');

import {
  SPILL_DIR,
  parseSpillName,
  processIsAlive,
  removeSpillFile,
  sweepSpillDir,
} from '../src/services/spillSweep';

/**
 * Phase 4 T13c (design §S.5.3): the boot sweep of `<appData>/scan-spill`, and the one
 * function in the app that removes a spill file.
 *
 * tm-store leaves a spill file with no name the moment it makes it; only a crash inside
 * macOS's create→unlink moment, or a power loss on Windows, leaves one named
 * `<pid>-<startMs>-<scanId>-<column>`. The sweep removes such a file once its `<pid>` is
 * dead, and keeps everything else. The owner allowed that removal on 28 Sep 2026 (plan
 * §S.11 Q1) for TreeMap's own files, only inside `scan-spill`, which is what these tests
 * hold it to. Liveness is a seam: a fake says which pids are alive, so nothing here
 * waits on a process or a clock, and one test asks the real check about this process and
 * a child that has ended.
 */

const UUID = '3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab';
/** Pids the fake calls alive. */
const LIVE = 424_242;
const DEAD = 131_313;

/** A fresh app-data folder with its scan-spill folder made. */
function appData(tag: string): { appDataDir: string; spillDir: string } {
  const appDataDir = fileTempDir(`treemap-spillSweep-${tag}-`);
  const spillDir = path.join(appDataDir, SPILL_DIR);
  fs.mkdirSync(spillDir, { mode: 0o700 });
  return { appDataDir, spillDir };
}

function spillName(pid: number, column: string): string {
  return `${pid}-1790656308811-${UUID}-${column}`;
}

/** The names in `dir`, sorted. */
function namesIn(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

/** A link at `at` to the folder `target`: a junction on Windows, which needs no privilege. */
function linkFolder(target: string, at: string): void {
  fs.symlinkSync(target, at, 'junction');
}

const onlyLive = (pid: number): boolean => pid === LIVE || pid === process.pid;

/* ─────────────── Names ─────────────── */

test('a name is read as tm-store writes it, and nothing else is', () => {
  assert.deepEqual(parseSpillName(`12345-1790656308811-${UUID}-nameOff_1`), {
    pid: 12345,
    startMs: '1790656308811',
    scanId: UUID,
    column: 'nameOff_1',
  });
  // The bounds tm-store's SpillName keeps: a scan id of 64 bytes, a column of 32.
  assert.ok(parseSpillName(`1-2-${'a'.repeat(64)}-${'c'.repeat(32)}`));
  assert.ok(parseSpillName('2147483647-2-scan-col'), 'the largest pid a process can have');
  for (const name of [
    '0-2-scan-col', // pid 0 is no process: process.kill(0) would ask the whole group
    '2147483648-2-scan-col',
    '12345678901-2-scan-col',
    `1-2-${'a'.repeat(65)}-col`,
    `1-2-scan-${'c'.repeat(33)}`,
    '1-2-scan-col.bin',
    '1-2-sc.an-col',
    '1-2-scan-col\n',
    '1-2-scan-',
    '1-2--col',
    '1--scan-col',
    '-2-scan-col',
    'x1-2-scan-col',
    '1-2-scan',
    '1-2-sc an-col',
    '1-2-scän-col',
    'notes.txt',
    '',
  ]) {
    assert.equal(parseSpillName(name), null, JSON.stringify(name));
  }
});

/* ─────────────── The sweep ─────────────── */

test('the sweep removes only dead owners\' files, and says what it did', async () => {
  const { appDataDir, spillDir } = appData('dead');
  fs.writeFileSync(path.join(spillDir, spillName(DEAD, 'size')), Buffer.alloc(100, 1));
  fs.writeFileSync(path.join(spillDir, spillName(DEAD, 'names')), Buffer.alloc(250, 2));
  fs.writeFileSync(path.join(spillDir, spillName(LIVE, 'size')), 'a live scan\'s');
  fs.writeFileSync(path.join(spillDir, spillName(process.pid, 'size')), 'this process\'s');

  const report = await sweepSpillDir(appDataDir, { isAlive: onlyLive });

  assert.deepEqual(report, { removed: 2, bytes: 350, kept: 2 });
  assert.deepEqual(namesIn(spillDir), [spillName(LIVE, 'size'), spillName(process.pid, 'size')].sort());
  assert.equal(fs.readFileSync(path.join(spillDir, spillName(LIVE, 'size')), 'utf8'), 'a live scan\'s');
});

test('a name that does not parse is kept, whatever its pid', async () => {
  const { appDataDir, spillDir } = appData('unparsed');
  const strangers = ['notes.txt', '0-1-scan-col', `${DEAD}-1-scan-col.bin`, `${DEAD}--scan-col`];
  for (const name of strangers) fs.writeFileSync(path.join(spillDir, name), name);

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });

  assert.deepEqual(report, { removed: 0, bytes: 0, kept: strangers.length });
  assert.deepEqual(namesIn(spillDir), [...strangers].sort());
  for (const name of strangers) assert.equal(fs.readFileSync(path.join(spillDir, name), 'utf8'), name);
});

test('a link planted in scan-spill is kept, and what it leads to is untouched', async () => {
  const { appDataDir, spillDir } = appData('link');
  const outside = fileTempDir('treemap-spillSweep-outside-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'the user\'s');
  const planted = spillName(DEAD, 'parent');
  linkFolder(outside, path.join(spillDir, planted));

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });

  assert.deepEqual(report, { removed: 0, bytes: 0, kept: 1 });
  assert.ok(fs.lstatSync(path.join(spillDir, planted)).isSymbolicLink(), 'the link is left in place');
  assert.deepEqual(namesIn(outside), ['precious.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'the user\'s');

  const direct = await removeSpillFile(appDataDir, path.join(spillDir, planted));
  assert.equal(direct.removed, false);
  assert.match(direct.reason ?? '', /is a link/);
});

test('a link to a file is kept too, and the file it leads to is untouched', { skip: process.platform === 'win32' && 'a file symlink needs privilege on Windows; the junction case covers it there' }, async () => {
  const { appDataDir, spillDir } = appData('filelink');
  const outside = fileTempDir('treemap-spillSweep-outsidefile-');
  const precious = path.join(outside, 'precious.bin');
  fs.writeFileSync(precious, 'the user\'s');
  const planted = spillName(DEAD, 'mtime');
  fs.symlinkSync(precious, path.join(spillDir, planted));

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });

  assert.deepEqual(report, { removed: 0, bytes: 0, kept: 1 });
  assert.ok(fs.lstatSync(path.join(spillDir, planted)).isSymbolicLink(), 'the link is left in place');
  assert.equal(fs.readFileSync(precious, 'utf8'), 'the user\'s');
});

test('a folder named as a spill file is refused, as not a regular file', async () => {
  const { appDataDir, spillDir } = appData('folder');
  const named = spillName(DEAD, 'childCnt');
  fs.mkdirSync(path.join(spillDir, named));
  fs.writeFileSync(path.join(spillDir, named, 'inside.txt'), 'kept');

  const outcome = await removeSpillFile(appDataDir, path.join(spillDir, named));

  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /not a regular file/);
  assert.equal(fs.readFileSync(path.join(spillDir, named, 'inside.txt'), 'utf8'), 'kept');
  assert.deepEqual(await sweepSpillDir(appDataDir, { isAlive: () => false }), { removed: 0, bytes: 0, kept: 1 });
});

test('a scan-spill that is itself a link is never looked into', async () => {
  const appDataDir = fileTempDir('treemap-spillSweep-linkeddir-');
  const outside = fileTempDir('treemap-spillSweep-elsewhere-');
  const stranger = spillName(DEAD, 'size');
  fs.writeFileSync(path.join(outside, stranger), 'not in scan-spill');
  linkFolder(outside, path.join(appDataDir, SPILL_DIR));

  assert.deepEqual(await sweepSpillDir(appDataDir, { isAlive: () => false }), { removed: 0, bytes: 0, kept: 0 });
  const direct = await removeSpillFile(appDataDir, path.join(appDataDir, SPILL_DIR, stranger));
  assert.equal(direct.removed, false);
  assert.match(direct.reason ?? '', /not a folder of its own/);
  assert.equal(fs.readFileSync(path.join(outside, stranger), 'utf8'), 'not in scan-spill');
});

test('an app-data folder with no scan-spill sweeps nothing', async () => {
  const appDataDir = fileTempDir('treemap-spillSweep-none-');
  assert.deepEqual(await sweepSpillDir(appDataDir, { isAlive: () => false }), { removed: 0, bytes: 0, kept: 0 });
});

/* ─────────────── The remover ─────────────── */

test('a path outside scan-spill is refused, however it is spelled', async () => {
  const { appDataDir, spillDir } = appData('outside');
  const elsewhere = fileTempDir('treemap-spillSweep-away-');
  const name = spillName(DEAD, 'ext');
  const inSub = path.join(spillDir, 'sub');
  fs.mkdirSync(inSub);
  for (const dir of [elsewhere, inSub]) fs.writeFileSync(path.join(dir, name), 'not directly in scan-spill');
  const spellings = [
    path.join(elsewhere, name),
    path.join(inSub, name),
    // Not normalised: the remover must resolve it, not trust its text.
    `${spillDir}${path.sep}..${path.sep}..${path.sep}${path.basename(elsewhere)}${path.sep}${name}`,
  ];
  for (const file of spellings) {
    const outcome = await removeSpillFile(appDataDir, file);
    assert.equal(outcome.removed, false, file);
    assert.match(outcome.reason ?? '', /not directly inside/, file);
  }
  assert.equal(fs.readFileSync(path.join(elsewhere, name), 'utf8'), 'not directly in scan-spill');
  assert.equal(fs.readFileSync(path.join(inSub, name), 'utf8'), 'not directly in scan-spill');
});

test('a file replaced after it was checked is left alone', async () => {
  const { appDataDir, spillDir } = appData('replaced');
  const name = spillName(DEAD, 'flags');
  const target = path.join(spillDir, name);
  fs.writeFileSync(target, 'the leftover');
  const impostor = path.join(spillDir, 'impostor');

  const outcome = await removeSpillFile(appDataDir, target, {
    window: () => {
      // Another process puts a file of its own at the name.
      fs.writeFileSync(impostor, 'not TreeMap\'s');
      fs.renameSync(impostor, target);
    },
  });

  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /replaced after it was checked/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'not TreeMap\'s', 'the other file is untouched');
});

test('a name tm-store would not give is refused inside scan-spill too', async () => {
  const { appDataDir, spillDir } = appData('stranger');
  const target = path.join(spillDir, 'settings.json');
  fs.writeFileSync(target, '{}');
  const outcome = await removeSpillFile(appDataDir, target);
  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /not a name TreeMap gives a spill file/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('the remover removes a dead owner\'s leftover and says how many bytes it held', async () => {
  const { appDataDir, spillDir } = appData('removes');
  const target = path.join(spillDir, spillName(DEAD, 'atime'));
  fs.writeFileSync(target, Buffer.alloc(4096, 7));
  assert.deepEqual(await removeSpillFile(appDataDir, target), { removed: true, bytes: 4096 });
  assert.deepEqual(namesIn(spillDir), []);
});

/* ─────────────── Liveness, for real ─────────────── */

test('the real liveness check: this process is alive, and a child that has ended is not', async () => {
  // The child is Node itself, with this process's environment, so under Electron-as-Node it
  // runs as Node too; it has exited by the time spawnSync returns.
  const child = spawnSync(process.execPath, ['-e', ''], { env: process.env, stdio: 'ignore' });
  assert.equal(child.status, 0, 'the child ran and ended');
  assert.ok(typeof child.pid === 'number' && child.pid > 0);
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(child.pid), false);
  // Another user's process answers EPERM, and doubt reads as alive: pid 1 (launchd, init)
  // or, on Windows, 4 (System), which always exist.
  assert.equal(processIsAlive(process.platform === 'win32' ? 4 : 1), true);

  const { appDataDir, spillDir } = appData('real');
  fs.writeFileSync(path.join(spillDir, spillName(process.pid, 'size')), 'ours');
  fs.writeFileSync(path.join(spillDir, spillName(child.pid, 'size')), 'the ended child\'s');
  assert.deepEqual(await sweepSpillDir(appDataDir), { removed: 1, bytes: 17, kept: 1 });
  assert.deepEqual(namesIn(spillDir), [spillName(process.pid, 'size')]);
});

/* ─────────────── One remover ─────────────── */

test('removeSpillFile is the one place that removes a spill file, and nothing else names scan-spill', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const own = path.join(srcDir, 'services', 'spillSweep.ts');
  const source = fs.readFileSync(own, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
  const removals = [...source.matchAll(/\b(unlink|rm|rmdir|unlinkSync|rmSync|rmdirSync)\s*\(/g)];
  assert.equal(removals.length, 1, `spillSweep.ts removes in exactly one place: ${removals.map((m) => m[0]).join(', ')}`);
  const remover = source.indexOf('export async function removeSpillFile');
  const next = source.indexOf('\nexport ', remover + 1);
  const at = removals[0].index ?? -1;
  assert.ok(remover >= 0 && at > remover && (next < 0 || at < next), 'and that place is inside removeSpillFile');

  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|cjs|mjs)$/.test(entry.name) && full !== own && fs.readFileSync(full, 'utf8').includes('scan-spill')) {
        offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], 'other code reaches the folder through SPILL_DIR and this module');
});
