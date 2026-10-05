import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-emptyFolderCheck-data-');

import {
  driveFor, driveOn, emptyCheckSession, EMPTY_CHECK_BUDGET_MS, EMPTY_CHECK_DEADLINE_MS, lookBudgetMs,
  setEmptyCheckForTests, SILENT_DRIVE_MEMORY_MS, stillEmptyFolder, type EmptyCheckDeps, type EmptyVerdict,
} from '../src/services/emptyFolderCheck';
import { HANG_GUARD_MS } from './fixtures/waitFor';

/**
 * U-4b M1: a drive that does not answer must not take the I/O pool.
 *
 * A stat on a dead network mount never returns; the look's race only stops
 * waiting for it, and the call keeps a thread of libuv's pool while it hangs.
 * These pin the look's three rules with a drive of the test's own — a stat
 * under `/dead` never answers, one under `/live` answers at once — and a clock
 * of its own, so nothing here waits on the real one:
 *  - silence is remembered per drive, across requests, until the call that
 *    went silent answers (and for a minute after one that fails);
 *  - within a request, a drive's first look goes alone;
 *  - a request looks for 10 s at most, counting only while it looks.
 */

afterEach(() => setEmptyCheckForTests(null));

const reasonOf = (v: EmptyVerdict): string => (v.empty ? '' : v.reason);
const whyOf = (v: EmptyVerdict): string => (v.empty ? 'empty' : v.why);

/** Drives of the test's own. `stats` lists every stat asked; a `/dead` stat waits in `pending` until the test settles it. */
function twoDrives(over: Partial<EmptyCheckDeps> = {}) {
  const stats: string[] = [];
  const pending: Array<{ answer: () => void; fail: () => void }> = [];
  let lastWasDead = false;
  const deps: Partial<EmptyCheckDeps> = {
    driveOf: async (p) => (p.startsWith('/dead') ? 'dead' : 'live'),
    lstat: (p) => {
      stats.push(p);
      lastWasDead = p.startsWith('/dead');
      if (!lastWasDead) return Promise.resolve({ isDirectory: () => true });
      return new Promise((resolve, reject) => {
        pending.push({
          answer: () => resolve({ isDirectory: () => true }),
          fail: () => reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })),
        });
      });
    },
    opendir: async () => ({ read: async () => null, close: async () => {} }),
    // The call is started just before its deadline is asked for: a `/dead` stat's deadline has passed, any other never does.
    deadline: () => {
      const late = lastWasDead ? Promise.resolve() : new Promise<void>(() => {});
      lastWasDead = false;
      return { late, cancel: () => {} };
    },
    ...over,
  };
  return { stats, pending, deps };
}

/** Let every answer already given reach the code waiting on it. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a stat that does not answer silences its drive for every look after it, in later requests too; another drive is looked at as before', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  const first = await stillEmptyFolder('/dead/a', true);
  assert.equal(whyOf(first), 'no-answer');
  assert.match(reasonOf(first), /it did not answer within/);
  const next = await stillEmptyFolder('/dead/b', true);
  assert.equal(whyOf(next), 'no-answer', 'a later request is not offered the folder either');
  assert.match(reasonOf(next), /the drive it is on did not answer a moment ago/);
  assert.deepEqual(drives.stats, ['/dead/a'], 'and the silent drive is not asked again: no second thread is held');
  assert.deepEqual(await stillEmptyFolder('/live/c', true), { empty: true }, 'another drive answers as before');
  assert.deepEqual(drives.stats, ['/dead/a', '/live/c']);
});

test('a drive that answers at last is looked at again at once (a disk that was spinning up)', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  assert.equal(whyOf(await stillEmptyFolder('/dead/a', true)), 'no-answer');
  drives.pending[0].answer();
  await settle();
  await stillEmptyFolder('/dead/b', true);
  assert.deepEqual(drives.stats, ['/dead/a', '/dead/b'], 'the silence ended with the answer');
});

test('a drive whose silent call fails at last is left alone for a minute after the failure', async () => {
  let now = 1_000_000;
  const drives = twoDrives({ now: () => now });
  setEmptyCheckForTests(drives.deps);
  assert.equal(whyOf(await stillEmptyFolder('/dead/a', true)), 'no-answer');
  now += 5 * 60_000; // the failure comes long after the silence began
  drives.pending[0].fail();
  await settle();
  now += SILENT_DRIVE_MEMORY_MS - 1;
  assert.match(reasonOf(await stillEmptyFolder('/dead/b', true)), /did not answer a moment ago/);
  assert.deepEqual(drives.stats, ['/dead/a'], 'still left alone just short of a minute after the failure');
  now += 1;
  await stillEmptyFolder('/dead/c', true);
  assert.deepEqual(drives.stats, ['/dead/a', '/dead/c'], 'and asked again once the minute is up');
  assert.equal(SILENT_DRIVE_MEMORY_MS, 60_000);
});

test('within a request, the first look on a drive goes alone: four at once ask a silent drive once', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  const session = emptyCheckSession(true);
  const verdicts = await Promise.all(['/dead/1', '/dead/2', '/dead/3', '/dead/4'].map((p) => session.look(p)));
  assert.deepEqual(verdicts.map(whyOf), ['no-answer', 'no-answer', 'no-answer', 'no-answer']);
  assert.deepEqual(drives.stats, ['/dead/1'], 'one probe, then the silence answers for the rest');
  // A drive that answers is looked at by all four together once heard from.
  const live = await Promise.all(['/live/1', '/live/2', '/live/3', '/live/4'].map((p) => session.look(p)));
  assert.deepEqual(live.map(whyOf), ['empty', 'empty', 'empty', 'empty']);
});

test('a request looks for 10 s at most, counting only while it looks; the wait it gives a call is what is left', async () => {
  assert.equal(EMPTY_CHECK_BUDGET_MS, 10_000);
  assert.equal(lookBudgetMs({}), EMPTY_CHECK_BUDGET_MS);
  // Under a test runner, npm test's own per-test limit: past the hang guard each call waits, so the budget never cuts a test's look.
  assert.equal(lookBudgetMs({ NODE_TEST_CONTEXT: 'child-v8' }), 1_200_000);
  assert.ok(lookBudgetMs({ TREEMAP_FORBID_REAL_TRASH: '1' }) > HANG_GUARD_MS);
  let now = 0;
  const waits: number[] = [];
  const stats: string[] = [];
  setEmptyCheckForTests({
    deadlineMs: EMPTY_CHECK_DEADLINE_MS,
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    driveOf: async () => 'slow',
    // Each stat takes 3 s of the session's clock, and answers.
    lstat: async (p) => { stats.push(p); now += 3_000; return { isDirectory: () => true }; },
    opendir: async () => ({ read: async () => null, close: async () => {} }),
    deadline: (ms) => { waits.push(ms); return { late: new Promise<void>(() => {}), cancel: () => {} }; },
  });
  const session = emptyCheckSession(true);
  const verdicts: EmptyVerdict[] = [];
  for (const p of ['/s/a', '/s/b', '/s/c', '/s/d', '/s/e']) {
    verdicts.push(await session.look(p));
    now += 100_000; // a Trash step between looks: not looking, so not counted
  }
  assert.deepEqual(verdicts.map(whyOf), ['empty', 'empty', 'empty', 'no-answer', 'no-answer'], '9 s of looking, then 12 s: d is cut, e never starts');
  assert.deepEqual(stats, ['/s/a', '/s/b', '/s/c', '/s/d'], 'nothing is asked once the 10 s are spent');
  assert.match(reasonOf(verdicts[4]), /the 10 seconds TreeMap gives to looking at folders again ran out/);
  assert.deepEqual(waits, [2000, 2000, 2000, 2000, 2000, 1000, 1000], 'each call waits 2 s, or what is left of the 10 s when that is less');
});

test('which drive a path is on: the deepest mount point listed above it, by name; a Windows path\'s own drive', () => {
  const table = ['/', '/System/Volumes/Data', '/Volumes/Backup', '/Volumes/Backup/inner'];
  assert.equal(driveFor('/Volumes/Backup/inner/a/b', table, 'darwin'), '/Volumes/Backup/inner');
  assert.equal(driveFor('/Volumes/Backup/x', table, 'darwin'), '/Volumes/Backup');
  assert.equal(driveFor('/Volumes/Backup2/x', table, 'darwin'), '/', 'name by name: Backup2 is not under Backup');
  assert.equal(driveFor('/Users/me/empty', table, 'linux'), '/');
  assert.equal(driveFor('/Volumes/Backup/x', null, 'darwin'), '/', 'a table that could not be read: one drive for everything, which only withholds more');
  assert.equal(driveFor('D:\\a\\b', null, 'win32'), 'd:\\');
  assert.equal(driveFor('\\\\server\\share\\a', null, 'win32'), '\\\\server\\share\\');
});

test('on this machine, a path\'s drive comes from its own mount table', { skip: !['darwin', 'linux', 'win32'].includes(process.platform) && 'no mount table is read here' }, async () => {
  if (process.platform === 'win32') {
    assert.equal(await driveOn('C:\\Windows\\System32'), 'c:\\');
  } else if (process.platform === 'darwin') {
    // macOS 10.15 and later mount the Data volume there; / is the system volume.
    assert.equal(await driveOn('/System/Volumes/Data/private/tmp'), '/System/Volumes/Data');
    assert.equal(await driveOn('/usr/bin'), '/');
  } else {
    assert.equal(await driveOn('/proc/self/status'), '/proc', '/proc is its own mount on every Linux');
  }
});
