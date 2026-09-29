import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-spillSweep-data-');

import {
  COLUMN_MAX,
  SCAN_ID_MAX,
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
 * `<pid>-<startMs>-<scanId>-<column>`, mode 0600, with one link. The sweep removes such a
 * file once its `<pid>` is dead, and keeps everything else. The owner allowed that removal on
 * 28 Sep 2026 (plan §S.11 Q1) for TreeMap's own files, only inside `scan-spill`, which is what
 * these tests hold it to. Liveness is a seam: a fake says which pids are alive, so nothing
 * here waits on a process or a clock.
 */

const UUID = '3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab';
/** Pids the fake calls alive. */
const LIVE = 424_242;
const DEAD = 131_313;
/** A pid no process has: past every system's range, and odd, which no Windows pid is. */
const NEVER = 2 ** 31 - 1;
const POSIX = process.platform !== 'win32';

/** A fresh app-data folder with its scan-spill folder made, mode 0700 as tm-store makes it. */
function appData(tag: string): { appDataDir: string; spillDir: string } {
  const appDataDir = fileTempDir(`treemap-spillSweep-${tag}-`);
  const spillDir = path.join(appDataDir, SPILL_DIR);
  fs.mkdirSync(spillDir, { mode: 0o700 });
  fs.chmodSync(spillDir, 0o700);
  return { appDataDir, spillDir };
}

function spillName(pid: number, column: string): string {
  return `${pid}-1790656308811-${UUID}-${column}`;
}

/** A leftover as tm-store would leave one: mode 0600 (the umask can only take bits away). */
function leftover(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
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
  // The bounds tm-store's SpillName keeps.
  assert.ok(parseSpillName(`1-2-${'a'.repeat(SCAN_ID_MAX)}-${'c'.repeat(COLUMN_MAX)}`));
  assert.ok(parseSpillName('2147483647-2-scan-col'), 'the largest pid a process can have');
  assert.ok(parseSpillName('12-0-scan-col'), 'a start of 0 is written "0"');
  for (const name of [
    '0-2-scan-col', // pid 0 is no process: process.kill(0) would ask the whole group
    '2147483648-2-scan-col',
    '12345678901-2-scan-col',
    '0000000012-1790656308811-scan-col', // tm-store never writes a leading zero
    '012-1790656308811-scan-col',
    '12-01790656308811-scan-col',
    '12-00-scan-col',
    `1-2-${'a'.repeat(SCAN_ID_MAX + 1)}-col`,
    `1-2-scan-${'c'.repeat(COLUMN_MAX + 1)}`,
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

test('the folder and the name bounds are tm-store\'s own', () => {
  const rust = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'treemap-core', 'crates', 'tm-store', 'src', 'spill.rs'),
    'utf8',
  );
  assert.match(rust, new RegExp(`pub const SPILL_DIR: &str = "${SPILL_DIR}";`));
  assert.match(rust, new RegExp(`pub const SCAN_ID_MAX: usize = ${SCAN_ID_MAX};`));
  assert.match(rust, new RegExp(`pub const COLUMN_MAX: usize = ${COLUMN_MAX};`));
});

/* ─────────────── The sweep ─────────────── */

test('the sweep removes only dead owners\' files, and says what it did', async () => {
  const { appDataDir, spillDir } = appData('dead');
  leftover(path.join(spillDir, spillName(DEAD, 'size')), Buffer.alloc(100, 1));
  leftover(path.join(spillDir, spillName(DEAD, 'names')), Buffer.alloc(250, 2));
  leftover(path.join(spillDir, spillName(LIVE, 'size')), 'a live scan\'s');
  leftover(path.join(spillDir, spillName(process.pid, 'size')), 'this process\'s');

  const report = await sweepSpillDir(appDataDir, { isAlive: onlyLive });

  assert.deepEqual(report, { removed: 2, bytes: 350, kept: 2, refused: [] });
  assert.deepEqual(namesIn(spillDir), [spillName(LIVE, 'size'), spillName(process.pid, 'size')].sort());
  assert.equal(fs.readFileSync(path.join(spillDir, spillName(LIVE, 'size')), 'utf8'), 'a live scan\'s');
});

test('a name that does not parse is kept, whatever its pid', async () => {
  const { appDataDir, spillDir } = appData('unparsed');
  const strangers = ['notes.txt', '0-1-scan-col', `${DEAD}-1-scan-col.bin`, `${DEAD}--scan-col`, `0${DEAD}-1-scan-col`];
  for (const name of strangers) leftover(path.join(spillDir, name), name);

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });

  assert.deepEqual(report, { removed: 0, bytes: 0, kept: strangers.length, refused: [] });
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

  assert.equal(report.removed, 0);
  assert.equal(report.kept, 1);
  assert.equal(report.refused.length, 1);
  assert.match(report.refused[0].reason, /is a link/);
  assert.ok(fs.lstatSync(path.join(spillDir, planted)).isSymbolicLink(), 'the link is left in place');
  assert.deepEqual(namesIn(outside), ['precious.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'the user\'s');
});

test('a link to a file is kept too, and the file it leads to is untouched', { skip: !POSIX && 'a file symlink needs privilege on Windows; the junction case covers it there' }, async () => {
  const { appDataDir, spillDir } = appData('filelink');
  const outside = fileTempDir('treemap-spillSweep-outsidefile-');
  const precious = path.join(outside, 'precious.bin');
  fs.writeFileSync(precious, 'the user\'s');
  const planted = spillName(DEAD, 'mtime');
  fs.symlinkSync(precious, path.join(spillDir, planted));

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });

  assert.equal(report.removed, 0);
  assert.match(report.refused[0]?.reason ?? '', /is a link/);
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
});

test('a scan-spill that is itself a link is never looked into, and the report says why', async () => {
  const appDataDir = fileTempDir('treemap-spillSweep-linkeddir-');
  const outside = fileTempDir('treemap-spillSweep-elsewhere-');
  const stranger = spillName(DEAD, 'size');
  leftover(path.join(outside, stranger), 'not in scan-spill');
  linkFolder(outside, path.join(appDataDir, SPILL_DIR));

  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });
  assert.equal(report.removed, 0);
  assert.equal(report.kept, 0);
  assert.match(report.unreadable ?? '', /not a folder of its own/);
  const direct = await removeSpillFile(appDataDir, path.join(appDataDir, SPILL_DIR, stranger));
  assert.equal(direct.removed, false);
  assert.match(direct.reason ?? '', /not a folder of its own/);
  assert.equal(fs.readFileSync(path.join(outside, stranger), 'utf8'), 'not in scan-spill');
});

test('a scan-spill that is a file is not looked into, and the report says why', async () => {
  const appDataDir = fileTempDir('treemap-spillSweep-filedir-');
  fs.writeFileSync(path.join(appDataDir, SPILL_DIR), 'not a folder');
  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });
  assert.equal(report.removed, 0);
  assert.match(report.unreadable ?? '', /not a folder of its own/);
  assert.equal(fs.readFileSync(path.join(appDataDir, SPILL_DIR), 'utf8'), 'not a folder');
});

test('an app-data folder with no scan-spill sweeps nothing, and that is not an error', async () => {
  const appDataDir = fileTempDir('treemap-spillSweep-none-');
  assert.deepEqual(await sweepSpillDir(appDataDir, { isAlive: () => false }), { removed: 0, bytes: 0, kept: 0, refused: [] });
});

test('an app-data folder given as a relative path is refused', async () => {
  const report = await sweepSpillDir(path.join('relative', 'app-data'), { isAlive: () => false });
  assert.match(report.unreadable ?? '', /not an absolute path/);
  const direct = await removeSpillFile(path.join('relative', 'app-data'), path.join('relative', 'app-data', SPILL_DIR, spillName(DEAD, 'x')));
  assert.match(direct.reason ?? '', /not an absolute path/);
});

test('a scan-spill other users can write to is not looked into', { skip: !POSIX && 'POSIX permissions' }, async () => {
  const { appDataDir, spillDir } = appData('open');
  const name = spillName(DEAD, 'size');
  leftover(path.join(spillDir, name), 'left');
  fs.chmodSync(spillDir, 0o777);
  const report = await sweepSpillDir(appDataDir, { isAlive: () => false });
  assert.match(report.unreadable ?? '', /can be written by other users/);
  assert.deepEqual(namesIn(spillDir), [name]);
});

test('a scan-spill another user owns is not looked into', { skip: !POSIX && 'POSIX owners' }, async () => {
  const { appDataDir, spillDir } = appData('owner');
  const name = spillName(DEAD, 'size');
  leftover(path.join(spillDir, name), 'left');
  const getuid = process.getuid!;
  process.getuid = () => getuid() + 1;
  try {
    const report = await sweepSpillDir(appDataDir, { isAlive: () => false });
    assert.match(report.unreadable ?? '', /scan-spill belongs to user/, 'the folder is what is refused');
  } finally {
    process.getuid = getuid;
  }
  assert.deepEqual(namesIn(spillDir), [name]);
});

test('an unreadable scan-spill is reported, not taken for an empty one', { skip: (!POSIX || process.getuid?.() === 0) && 'root reads every folder; Windows has no mode 000' }, async () => {
  const { appDataDir, spillDir } = appData('unreadable');
  fs.chmodSync(spillDir, 0o000);
  try {
    const report = await sweepSpillDir(appDataDir, { isAlive: () => false });
    assert.equal(report.removed, 0);
    assert.match(report.unreadable ?? '', /cannot be listed/);
  } finally {
    fs.chmodSync(spillDir, 0o700);
  }
});

/* ─────────────── The remover ─────────────── */

test('a path outside scan-spill is refused, however it is spelled', async () => {
  const { appDataDir, spillDir } = appData('outside');
  const elsewhere = fileTempDir('treemap-spillSweep-away-');
  const name = spillName(DEAD, 'ext');
  const inSub = path.join(spillDir, 'sub');
  fs.mkdirSync(inSub);
  for (const dir of [elsewhere, inSub]) leftover(path.join(dir, name), 'not directly in scan-spill');
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

test('a name tm-store would not give is refused inside scan-spill too', async () => {
  const { appDataDir, spillDir } = appData('stranger');
  for (const name of ['settings.json', `0000${DEAD}-1790656308811-${UUID}-size`]) {
    const target = path.join(spillDir, name);
    leftover(target, '{}');
    const outcome = await removeSpillFile(appDataDir, target);
    assert.equal(outcome.removed, false, name);
    assert.match(outcome.reason ?? '', /not a name TreeMap gives a spill file/, name);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  }
});

test('a file with another name is refused: a hard link planted in scan-spill leaves the user\'s file alone', async () => {
  const { appDataDir, spillDir } = appData('hardlink');
  const outside = fileTempDir('treemap-spillSweep-linked-');
  const precious = path.join(outside, 'precious.bin');
  leftover(precious, 'the user\'s');
  const planted = path.join(spillDir, spillName(DEAD, 'size'));
  fs.linkSync(precious, planted);

  const outcome = await removeSpillFile(appDataDir, planted);

  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /has 2 names/);
  assert.ok(fs.existsSync(planted), 'the planted name is left');
  assert.equal(fs.readFileSync(precious, 'utf8'), 'the user\'s');
});

test('a file with permissions tm-store does not give is refused', { skip: !POSIX && 'POSIX permissions' }, async () => {
  const { appDataDir, spillDir } = appData('mode');
  const target = path.join(spillDir, spillName(DEAD, 'size'));
  fs.writeFileSync(target, 'someone\'s');
  fs.chmodSync(target, 0o644);
  const outcome = await removeSpillFile(appDataDir, target);
  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /permissions 644, beyond the 600/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'someone\'s');
});

test('a file another user owns is refused', { skip: !POSIX && 'POSIX owners' }, async () => {
  const { appDataDir, spillDir } = appData('fileowner');
  const name = spillName(DEAD, 'size');
  const target = path.join(spillDir, name);
  leftover(target, 'someone\'s');
  // The folder is this user's; the file is taken to be another's by moving this process's
  // own uid under the folder check's feet: the folder is read first, the file after.
  const getuid = process.getuid!;
  const own = getuid();
  let calls = 0;
  process.getuid = () => (calls++ === 0 ? own : own + 1);
  try {
    const outcome = await removeSpillFile(appDataDir, target);
    assert.equal(outcome.removed, false);
    assert.ok((outcome.reason ?? '').startsWith(`${name} belongs to user`), `the file is what is refused: ${outcome.reason}`);
  } finally {
    process.getuid = getuid;
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'someone\'s');
});

test('a file replaced after it was checked is left alone', async () => {
  const { appDataDir, spillDir } = appData('replaced');
  const name = spillName(DEAD, 'flags');
  const target = path.join(spillDir, name);
  leftover(target, 'the leftover');
  const impostor = path.join(spillDir, 'impostor');

  const outcome = await removeSpillFile(appDataDir, target, {
    window: () => {
      // Another process puts a file of its own at the name.
      leftover(impostor, 'not TreeMap\'s');
      fs.renameSync(impostor, target);
    },
  });

  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /replaced after it was checked/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'not TreeMap\'s', 'the other file is untouched');
});

test('a file removed and made again at its name after the check is left alone', async () => {
  const { appDataDir, spillDir } = appData('remade');
  const target = path.join(spillDir, spillName(DEAD, 'size'));
  leftover(target, 'the leftover');
  const outcome = await removeSpillFile(appDataDir, target, {
    window: () => {
      if (process.platform === 'linux') {
        // The remover holds the checked file open, so ext4 cannot hand its inode number to
        // the new file.
        const held = fs.readdirSync('/proc/self/fd').some((fd) => {
          try {
            return fs.readlinkSync(path.join('/proc/self/fd', fd)) === fs.realpathSync.native(target);
          } catch {
            return false;
          }
        });
        assert.ok(held, 'the checked file is held open while it is compared');
      }
      fs.unlinkSync(target);
      leftover(target, 'made again');
    },
  });
  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /replaced after it was checked/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'made again');
});

test('a folder or a link put at the name after the check is left alone', async () => {
  const { appDataDir, spillDir } = appData('swapped');
  const outside = fileTempDir('treemap-spillSweep-swapped-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'the user\'s');
  for (const [column, swap] of [
    ['asfolder', (target: string) => fs.mkdirSync(target)],
    ['aslink', (target: string) => linkFolder(outside, target)],
  ] as const) {
    const target = path.join(spillDir, spillName(DEAD, column));
    leftover(target, 'the leftover');
    const outcome = await removeSpillFile(appDataDir, target, {
      window: () => {
        fs.unlinkSync(target);
        swap(target);
      },
    });
    assert.equal(outcome.removed, false, column);
    assert.match(outcome.reason ?? '', /replaced after it was checked/, column);
    assert.ok(fs.existsSync(target), `${column}: what was put there is left`);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'the user\'s');
});

test('a file gone after the check is reported gone', async () => {
  const { appDataDir, spillDir } = appData('gone');
  const target = path.join(spillDir, spillName(DEAD, 'size'));
  leftover(target, 'the leftover');
  const outcome = await removeSpillFile(appDataDir, target, { window: () => fs.unlinkSync(target) });
  assert.equal(outcome.removed, false);
  assert.match(outcome.reason ?? '', /went away before it could be removed/);
});

test('the remover removes a dead owner\'s leftover and says how many bytes it held', async () => {
  const { appDataDir, spillDir } = appData('removes');
  const target = path.join(spillDir, spillName(DEAD, 'atime'));
  leftover(target, Buffer.alloc(4096, 7));
  assert.deepEqual(await removeSpillFile(appDataDir, target), { removed: true, bytes: 4096 });
  assert.deepEqual(namesIn(spillDir), []);
});

/* ─────────────── Liveness ─────────────── */

test('the real liveness check: this process is alive, and a pid no process has is not', async () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(NEVER), false);

  const { appDataDir, spillDir } = appData('real');
  leftover(path.join(spillDir, spillName(process.pid, 'size')), 'ours');
  leftover(path.join(spillDir, spillName(NEVER, 'size')), 'no one\'s');
  assert.deepEqual(await sweepSpillDir(appDataDir), { removed: 1, bytes: 8, kept: 1, refused: [] });
  assert.deepEqual(namesIn(spillDir), [spillName(process.pid, 'size')]);
});

test('only "no such process" reads as dead: another user\'s process and any doubt keep the file', () => {
  const kill = process.kill;
  const answer = (code: string | undefined) => {
    process.kill = (() => {
      throw Object.assign(new Error(`kill: ${code}`), code === undefined ? {} : { code });
    }) as typeof process.kill;
  };
  try {
    answer('ESRCH');
    assert.equal(processIsAlive(DEAD), false);
    answer('EPERM');
    assert.equal(processIsAlive(DEAD), true, 'another user\'s process is alive');
    answer('EINVAL');
    assert.equal(processIsAlive(DEAD), true);
    answer(undefined);
    assert.equal(processIsAlive(DEAD), true);
  } finally {
    process.kill = kill;
  }
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
  // The last check and the removal run together: nothing between them yields to other work.
  const lastCheck = source.lastIndexOf('lstatSync(target', at);
  assert.ok(lastCheck > remover, 'the removal follows a check of the name');
  assert.doesNotMatch(source.slice(lastCheck, at), /\bawait\b/, 'nothing between the last check and the removal awaits');

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
