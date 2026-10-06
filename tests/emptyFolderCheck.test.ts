import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-emptyFolderCheck-data-');

import {
  driveFor, driveOn, emptyCheckSession, EMPTY_CHECK_BUDGET_MS, EMPTY_CHECK_DEADLINE_MS, listsEntryTypes, lookBudgetMs, lookClock, MAX_HELD_PER_DRIVE,
  filesystemOn, openListing, setEmptyCheckForTests, setMountTableReaderForTests, SILENT_DRIVE_MEMORY_MS, stillEmptyFolder, type EmptyCheckDeps, type EmptyVerdict,
} from '../src/services/emptyFolderCheck';
import { HANG_GUARD_MS } from './fixtures/waitFor';

/**
 * U-4b M1, as the U-4b reviews narrowed it (U-4c M1 / M-A): a call that does
 * not answer must not take the I/O pool, and must not silence more than it
 * shows to be silent.
 *
 * A stat on a dead network mount never returns; the look's race only stops
 * waiting for it, and the call keeps a thread of libuv's pool while it hangs.
 * These pin the look's rules with drives of the test's own — under `/dead`
 * nothing answers, the drive's root included; under `/live` everything answers
 * at once — and a clock of its own, so nothing here waits on the real one:
 *  - a call that misses its deadline makes its folder silent until it
 *    answers, and the look asks the root of the drive that folder is on: a
 *    root that misses too makes the drive silent until the root answers;
 *  - silence is remembered across requests, and for a minute after a call
 *    fails with a drive's own error (EIO, ESTALE, …) — any other answer, an
 *    ENOENT or EACCES included, lifts it;
 *  - within a request, a drive's first look goes alone;
 *  - a request looks for 10 s at most, counting only while it looks.
 */

afterEach(() => setEmptyCheckForTests(null));

const reasonOf = (v: EmptyVerdict): string => (v.empty ? '' : v.reason);
const whyOf = (v: EmptyVerdict): string => (v.empty ? 'empty' : v.why);

/** An error of the test's own making, with an errno code. */
const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: as the drive said`), { code });

/** Drives of the test's own. `stats` lists every stat asked; a `/dead` stat (its root's too) waits in `pending` until the test settles it. */
function twoDrives(over: Partial<EmptyCheckDeps> = {}) {
  const stats: string[] = [];
  const pending: Array<{ path: string; answer: () => void; fail: (code?: string) => void }> = [];
  let lastWasDead = false;
  const deps: Partial<EmptyCheckDeps> = {
    driveOf: async (p) => (p.startsWith('/dead') ? '/dead' : '/live'),
    lstat: (p) => {
      stats.push(p);
      lastWasDead = p.startsWith('/dead');
      if (!lastWasDead) return Promise.resolve({ isDirectory: () => true });
      return new Promise((resolve, reject) => {
        pending.push({
          path: p,
          answer: () => resolve({ isDirectory: () => true }),
          fail: (code = 'EIO') => reject(failure(code)),
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
  /** The oldest call still out on `p`, taken off the list for the test to settle. */
  const out = (p: string) => {
    const at = pending.findIndex((c) => c.path === p);
    assert.ok(at >= 0, `a call on ${p} is out`);
    return pending.splice(at, 1)[0];
  };
  return { stats, pending, deps, out };
}

/** Let every answer already given reach the code waiting on it. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a stat that does not answer, on a drive whose root does not answer either, silences the drive for every look after it, in later requests too; another drive is looked at as before', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  const first = await stillEmptyFolder('/dead/a', true);
  assert.equal(whyOf(first), 'no-answer');
  assert.match(reasonOf(first), /it did not answer within/);
  assert.deepEqual(drives.stats, ['/dead/a', '/dead'], 'the folder, then its drive\'s root, once');
  const next = await stillEmptyFolder('/dead/b', true);
  assert.equal(whyOf(next), 'no-answer', 'a later request is not offered the folder either');
  assert.match(reasonOf(next), /the drive it is on did not answer a moment ago/);
  assert.deepEqual(drives.stats, ['/dead/a', '/dead'], 'and the silent drive is not asked again: no third thread is held');
  assert.deepEqual(await stillEmptyFolder('/live/c', true), { empty: true }, 'another drive answers as before');
  assert.deepEqual(drives.stats, ['/dead/a', '/dead', '/live/c']);
});

test('a drive whose root answers at last is looked at again at once (a disk that was spinning up); the folder that hung waits for its own answer', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  assert.equal(whyOf(await stillEmptyFolder('/dead/a', true)), 'no-answer');
  drives.out('/dead').answer();
  await settle();
  const again = await stillEmptyFolder('/dead/a', true);
  assert.match(reasonOf(again), /^it did not answer a moment ago/, 'the folder whose own call is still out is not asked again');
  await stillEmptyFolder('/dead/b', true);
  // b hangs: with a's call that is two of the drive's calls out, so its root is not asked a third time (the U-4c review, F1.1).
  assert.deepEqual(drives.stats, ['/dead/a', '/dead', '/dead/b'], 'the drive\'s silence ended with its root\'s answer: b is asked');
  drives.out('/dead/a').answer();
  await settle();
  await stillEmptyFolder('/dead/a', true);
  assert.equal(drives.stats[3], '/dead/a', 'asked again once its own call answered');
});

test('a drive whose root fails at last with a drive\'s own error is left alone for a minute after the failure', async () => {
  let now = 1_000_000;
  const drives = twoDrives({ now: () => now });
  setEmptyCheckForTests(drives.deps);
  assert.equal(whyOf(await stillEmptyFolder('/dead/a', true)), 'no-answer');
  now += 5 * 60_000; // the failure comes long after the silence began
  drives.out('/dead').fail('EIO');
  await settle();
  now += SILENT_DRIVE_MEMORY_MS - 1;
  assert.match(reasonOf(await stillEmptyFolder('/dead/b', true)), /did not answer a moment ago/);
  assert.deepEqual(drives.stats, ['/dead/a', '/dead'], 'still left alone just short of a minute after the failure');
  now += 1;
  await stillEmptyFolder('/dead/c', true);
  assert.deepEqual(drives.stats.slice(0, 3), ['/dead/a', '/dead', '/dead/c'], 'and asked again once the minute is up');
  assert.equal(SILENT_DRIVE_MEMORY_MS, 60_000);
});

test('R3: a late call that fails with an answer — ENOENT, EACCES, EPERM, ENOTDIR — lifts the silence at once; only a drive\'s own errors keep it', async () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']) {
    const drives = twoDrives({ now: () => 0 });
    setEmptyCheckForTests(drives.deps);
    assert.equal(whyOf(await stillEmptyFolder('/dead/slow', true)), 'no-answer');
    drives.out('/dead').fail(code); // the root answers at last: with an error, but an answer
    drives.out('/dead/slow').fail(code); // and so does the folder: removed meanwhile, or refused
    await settle();
    await stillEmptyFolder('/dead/slow', true);
    assert.deepEqual(drives.stats.slice(0, 3), ['/dead/slow', '/dead', '/dead/slow'], `${code}: the drive and the folder are both heard again at once`);
  }
  for (const code of ['EIO', 'ETIMEDOUT', 'ENOTCONN', 'ESTALE', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN', 'ENXIO']) {
    const drives = twoDrives({ now: () => 0 });
    setEmptyCheckForTests(drives.deps);
    await stillEmptyFolder('/dead/slow', true);
    drives.out('/dead').fail(code);
    drives.out('/dead/slow').fail(code);
    await settle();
    assert.match(reasonOf(await stillEmptyFolder('/dead/fine', true)), /the drive it is on did not answer a moment ago/, `${code}: the drive stays silent`);
    assert.deepEqual(drives.stats, ['/dead/slow', '/dead'], `${code}: nothing more is asked`);
  }
});

test('R3: a slow folder on a drive whose root answers is withheld alone — the next folder on the same, responsive drive is looked at', async () => {
  // The U-4b reviews' M-A: on macOS everything under home is the drive "/", so one slow listing (a
  // dataless iCloud folder, a busy pool during a rescan) once withheld every folder on it.
  let lastSlow = false;
  let slowHangs = true;
  let failSlow: (code: string) => void = () => {};
  const stats: string[] = [];
  setEmptyCheckForTests({
    driveOf: async () => '/',
    lstat: (p) => {
      stats.push(p);
      lastSlow = p === '/x/slow' && slowHangs;
      if (!lastSlow) return Promise.resolve(aFolder);
      return new Promise((_, reject) => { failSlow = (code) => reject(failure(code)); });
    },
    opendir: async () => ({ read: async () => null, close: async () => {} }),
    deadline: () => {
      const late = lastSlow ? Promise.resolve() : new Promise<void>(() => {});
      lastSlow = false;
      return { late, cancel: () => {} };
    },
  });
  const slow = await stillEmptyFolder('/x/slow', true);
  assert.match(reasonOf(slow), /it did not answer within/);
  assert.deepEqual(await stillEmptyFolder('/x/fine', true), { empty: true }, 'the drive answered: only the slow folder is withheld');
  assert.match(reasonOf(await stillEmptyFolder('/x/slow', true)), /it did not answer a moment ago/, 'and it is not asked again while its call is out');
  failSlow('ENOENT'); // removed meanwhile: an answer
  slowHangs = false; // and made again, answering now
  await settle();
  assert.equal(whyOf(await stillEmptyFolder('/x/slow', true)), 'empty', 'asked again at once');
  assert.deepEqual(stats, ['/x/slow', '/', '/x/fine', '/x/slow']);
});

/** Every listing hangs, its deadline passed, until the test fails it; stats (the drive's root's too) answer at once. On a clock of the test's own. */
function listingsHang() {
  let now = 0;
  const asked: string[] = [];
  let failListing: (code: string) => void = () => {};
  let lastHung = false;
  setEmptyCheckForTests({
    now: () => now,
    driveOf: async () => '/nas',
    lstat: async (p) => { asked.push(`stat ${p}`); lastHung = false; return aFolder; },
    opendir: (p) => {
      asked.push(`list ${p}`);
      lastHung = true;
      return new Promise((_, reject) => { failListing = (code) => reject(failure(code)); });
    },
    deadline: () => {
      const late = lastHung ? Promise.resolve() : new Promise<void>(() => {});
      lastHung = false;
      return { late, cancel: () => {} };
    },
  });
  return { asked, fail: (code: string) => failListing(code), advance: (ms: number) => { now += ms; } };
}

/** A listing of `offered` hangs, then fails with a drive's own error: `next` is not asked for a minute; after ENOENT, at once. */
async function silenceAfterListingFails(offered: string, next: string, said: RegExp): Promise<void> {
  for (const code of ['ETIMEDOUT', 'EIO']) {
    const h = listingsHang();
    assert.equal(whyOf(await stillEmptyFolder(offered, true)), 'no-answer');
    h.fail(code);
    await settle();
    const asked = h.asked.length;
    h.advance(SILENT_DRIVE_MEMORY_MS - 1);
    assert.match(reasonOf(await stillEmptyFolder(next, true)), said, `${offered}, ${code}`);
    assert.equal(h.asked.length, asked, `${offered}, ${code}: nothing is asked within the minute`);
    h.advance(1);
    await stillEmptyFolder(next, true);
    assert.equal(h.asked[asked], `stat ${next}`, `${offered}, ${code}: asked again once the minute is up`);
  }
  const h = listingsHang();
  await stillEmptyFolder(offered, true);
  h.fail('ENOENT');
  await settle();
  const asked = h.asked.length;
  await stillEmptyFolder(next, true);
  assert.equal(h.asked[asked], `stat ${next}`, `${offered}, ENOENT: an answer, so asked again at once`);
}

// A listing's failure reaches the silence wrapped (it could not be opened: NotOpened), unlike a stat's (U-4c review, F1.7).
test('a drive\'s own root offered, whose listing hangs and then fails with the drive\'s own error, keeps the drive silent a minute; ENOENT lifts it at once (U-4c review, F1.7)', async () => {
  await silenceAfterListingFails('/nas', '/nas/inner', /the drive it is on did not answer a moment ago/);
});

test('a folder whose listing hangs and then fails with the drive\'s own error is not asked for a minute; ENOENT lifts it at once (U-4c review, F1.7)', async () => {
  await silenceAfterListingFails('/nas/a', '/nas/a', /^it did not answer a moment ago/);
});

/** A listing of the test's own that hands out `entries`, then the end. */
const listingOf = (entries: Dirent[]) => {
  const rest = [...entries];
  return { read: async () => rest.shift() ?? null, close: async () => {} };
};

/**
 * Calls of the test's own: a stat or listing of a path `hangs` names never
 * answers, and its deadline has passed; every other answers at once (a folder,
 * listing `contents[p]`), and its deadline never passes. `asked` lists them.
 */
function hangsAt(hangs: (p: string) => boolean, contents: Record<string, Dirent[]>, driveOf: (p: string) => string) {
  const asked: string[] = [];
  let lastHung = false;
  const call = <T>(kind: string, p: string, answer: () => T): Promise<T> => {
    asked.push(`${kind} ${p}`);
    lastHung = hangs(p);
    return lastHung ? new Promise<T>(() => { /* stopped answering */ }) : Promise.resolve(answer());
  };
  setEmptyCheckForTests({
    driveOf: async (p) => driveOf(p),
    lstat: (p) => call('stat', p, () => aFolder),
    opendir: (p) => call('list', p, () => listingOf(contents[p] ?? [])),
    deadline: () => {
      const late = lastHung ? Promise.resolve() : new Promise<void>(() => {});
      lastHung = false;
      return { late, cancel: () => {} };
    },
  });
  return asked;
}

const onNas = (p: string): string => (p.startsWith('/x/outer/mnt') || p.startsWith('/nas') ? '/nas' : '/');

test('R1: a dead mount nested inside a candidate silences the mount\'s own drive, never the candidate\'s: a healthy folder elsewhere is offered', async () => {
  const asked = hangsAt((p) => p === '/x/outer/mnt' || p === '/nas', { '/x/outer': [dirent('mnt', true)] }, onNas);
  const outer = await stillEmptyFolder('/x/outer', true);
  assert.equal(whyOf(outer), 'no-answer');
  assert.match(reasonOf(outer), /the folder mnt inside it did not answer within/);
  assert.deepEqual(await stillEmptyFolder('/x/healthy', true), { empty: true }, 'on the boot drive, which never touched the nas');
  assert.match(reasonOf(await stillEmptyFolder('/nas/share', true)), /the drive it is on did not answer a moment ago/, 'the nas itself is silent');
  assert.deepEqual(asked, ['stat /x/outer', 'list /x/outer', 'list /x/outer/mnt', 'stat /nas', 'stat /x/healthy', 'list /x/healthy']);
});

test('R1: a nested folder that hangs on a drive whose root answers is withheld alone, and not asked again while its call is out', async () => {
  const asked = hangsAt((p) => p === '/x/outer/mnt', { '/x/outer': [dirent('mnt', true)] }, onNas);
  assert.match(reasonOf(await stillEmptyFolder('/x/outer', true)), /the folder mnt inside it did not answer within/);
  assert.deepEqual(await stillEmptyFolder('/x/healthy', true), { empty: true });
  assert.deepEqual(await stillEmptyFolder('/nas/other', true), { empty: true }, 'the nas answered for its root: it is not silent');
  const again = await stillEmptyFolder('/x/outer', true);
  assert.match(reasonOf(again), /the folder mnt inside it did not answer a moment ago/);
  assert.equal(asked.filter((a) => a === 'list /x/outer/mnt').length, 1, 'one thread held, not one per look');
});

test('a folder that is its drive\'s own root and does not answer is not asked twice: its silence is the drive\'s', async () => {
  // An empty share's mount point offered as an empty folder: asking "the root" again would hold a second thread on the same dead path.
  const asked = hangsAt((p) => p.startsWith('/nas'), {}, (p) => (p.startsWith('/nas') ? '/nas' : '/'));
  assert.equal(whyOf(await stillEmptyFolder('/nas', true)), 'no-answer');
  assert.deepEqual(asked, ['stat /nas'], 'one call on the dead root, not two');
  assert.match(reasonOf(await stillEmptyFolder('/nas/inner', true)), /the drive it is on did not answer a moment ago/, 'and the drive is silent');
  assert.deepEqual(asked, ['stat /nas']);
});

test('a look never starts a call on a drive that went silent, even one it meets below the folder it began on (U-4b review, L-2)', async () => {
  const asked = hangsAt((p) => p.startsWith('/nas'), { '/x/top': [dirent('mnt', true)] }, (p) => (p.startsWith('/x/top/mnt') || p.startsWith('/nas') ? '/nas' : '/'));
  assert.equal(whyOf(await stillEmptyFolder('/nas/a', true)), 'no-answer');
  assert.deepEqual(asked, ['stat /nas/a', 'stat /nas'], 'the nas and its root went silent');
  const top = await stillEmptyFolder('/x/top', true);
  assert.equal(whyOf(top), 'no-answer');
  assert.match(reasonOf(top), /the folder mnt inside it is on a drive that did not answer a moment ago/);
  assert.deepEqual(asked, ['stat /nas/a', 'stat /nas', 'stat /x/top', 'list /x/top'], 'the silent drive was not asked for mnt');
});

test('a call whose wait the budget cut short, and whose deadline then passed, says the budget ran out: its folder is held, its drive never asked about', async () => {
  // The U-4b review's test gap: the branch where the deadline fires while the wait is shorter than a deadline.
  let now = 0;
  const asked: string[] = [];
  setEmptyCheckForTests({
    deadlineMs: 2_000,
    budgetMs: 3_000,
    now: () => now,
    driveOf: async () => '/slow',
    lstat: async (p) => { asked.push(`stat ${p}`); now += 2_500; return aFolder; }, // answers, after 2.5 s of the clock
    opendir: (p) => { asked.push(`list ${p}`); return new Promise(() => { /* still listing */ }); },
    // Only a wait shorter than a whole deadline — one the budget cut — passes.
    deadline: (ms) => ({ late: ms < 2_000 ? Promise.resolve() : new Promise<void>(() => {}), cancel: () => {} }),
  });
  const cut = await stillEmptyFolder('/slow/a', true);
  assert.match(reasonOf(cut), /the 3 seconds TreeMap gives to looking at folders again ran out/);
  assert.deepEqual(asked, ['stat /slow/a', 'list /slow/a'], 'the drive\'s root is not asked: a cut wait says nothing about the drive');
  assert.match(reasonOf(await stillEmptyFolder('/slow/a', true)), /^it did not answer a moment ago/, 'its listing is still out: not asked again');
  await stillEmptyFolder('/slow/b', true);
  assert.deepEqual(asked.slice(2), ['stat /slow/b', 'list /slow/b'], 'the drive is not silent');
  // Each cut listing is still out, holding a thread: two of them, and the drive is asked nothing more (the U-4c review, F1.1).
  assert.match(reasonOf(await stillEmptyFolder('/slow/c', true)), /the drive it is on did not answer a moment ago/);
  assert.deepEqual(asked.slice(4), [], 'c is not asked');
});

/* ─────────────── a drive holds at most two calls that did not answer (U-4c review, F1.1 / F1.3 / F1.8) ─────────────── */

test('many folders that hang on a drive whose root answers leave at most two calls out, whatever the number of folders: the drive is then asked nothing more', async () => {
  // A hard mount whose server died while the root's attributes are cached, or a File Provider root:
  // the root answers, every folder below hangs. Each call that hangs keeps a thread of libuv's pool
  // (8 to 16 threads); one GET once started about 17 of them, and every later request more.
  const started: string[] = [];
  const rootAsked: string[] = [];
  let lastHung = false;
  setEmptyCheckForTests({
    driveOf: async () => '/Volumes/nas',
    lstat: (p) => {
      if (p === '/Volumes/nas') { rootAsked.push(p); lastHung = false; return Promise.resolve(aFolder); }
      started.push(p);
      lastHung = true;
      return new Promise(() => { /* never answers */ });
    },
    opendir: async () => listingOf([]),
    deadline: () => {
      const late = lastHung ? Promise.resolve() : new Promise<void>(() => {});
      lastHung = false;
      return { late, cancel: () => {} };
    },
  });
  // GET /api/empty-folders' second looks: one session, four looks at a time.
  const session = emptyCheckSession(true);
  const paths = Array.from({ length: 200 }, (_, i) => `/Volumes/nas/f${i}`);
  const verdicts: EmptyVerdict[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < paths.length) {
      const i = next++;
      verdicts[i] = await session.look(paths[i]);
    }
  }));
  assert.deepEqual(started, ['/Volumes/nas/f0', '/Volumes/nas/f1'], 'the first folder, alone; then, its call still out, the next alone; then nothing');
  assert.deepEqual(rootAsked, ['/Volumes/nas'], 'the root is asked once, for the first: the second makes two calls out, and that is the drive silent');
  assert.ok(verdicts.every((v) => whyOf(v) === 'no-answer'), 'none is offered');
  assert.equal(verdicts.filter((v) => /the drive it is on did not answer a moment ago/.test(reasonOf(v))).length, 198, 'the rest are not asked');
  // A later request — another GET, a delete — asks nothing either while both calls are out.
  assert.match(reasonOf(await stillEmptyFolder('/Volumes/nas/later', true)), /the drive it is on did not answer a moment ago/);
  assert.equal(started.length, 2, 'two threads held in all, not one per folder');
  assert.equal(MAX_HELD_PER_DRIVE, 2);
});

test('a second folder that hangs on one drive silences it until one of the two answers; the first alone does not', async () => {
  const out = new Map<string, () => void>();
  const stats: string[] = [];
  let lastSlow = false;
  setEmptyCheckForTests({
    driveOf: async () => '/',
    lstat: (p) => {
      stats.push(p);
      lastSlow = p.startsWith('/x/slow');
      if (!lastSlow) return Promise.resolve(aFolder);
      return new Promise((resolve) => { out.set(p, () => resolve(aFolder)); });
    },
    opendir: async () => listingOf([]),
    deadline: () => {
      const late = lastSlow ? Promise.resolve() : new Promise<void>(() => {});
      lastSlow = false;
      return { late, cancel: () => {} };
    },
  });
  assert.match(reasonOf(await stillEmptyFolder('/x/slow1', true)), /it did not answer within/);
  assert.deepEqual(await stillEmptyFolder('/x/fine', true), { empty: true }, 'one slow folder on a drive that answers is withheld alone (M-A)');
  assert.match(reasonOf(await stillEmptyFolder('/x/slow2', true)), /it did not answer within/);
  const held = await stillEmptyFolder('/x/fine', true);
  assert.match(reasonOf(held), /the drive it is on did not answer a moment ago/, 'two calls out on the drive: it is asked nothing more');
  assert.deepEqual(stats, ['/x/slow1', '/', '/x/fine', '/x/slow2'], 'and its root is not asked about the second: that would be a third thread');
  out.get('/x/slow1')!();
  await settle();
  assert.deepEqual(await stillEmptyFolder('/x/fine', true), { empty: true }, 'one of the two answered: the drive is asked again');
  assert.deepEqual(stats.slice(4), ['/x/fine']);
  out.get('/x/slow2')!();
  await settle();
  assert.match(reasonOf(await stillEmptyFolder('/x/slow3', true)), /it did not answer within/);
  assert.deepEqual(stats.slice(5), ['/x/slow3', '/'], 'none out, one hangs: its drive\'s root is asked afresh');
});

test('a drive\'s own root offered while the drive already holds a call, and hanging, keeps the drive silent until that root answers', async () => {
  // The root is asked about once as a probe (it answers), then offered as an empty folder (it hangs).
  const stats: string[] = [];
  const answerOf = new Map<string, () => void>();
  let rootAsked = 0;
  let lastHung = false;
  setEmptyCheckForTests({
    driveOf: async (p) => (p.startsWith('/nas') ? '/nas' : '/'),
    lstat: (p) => {
      stats.push(p);
      lastHung = p === '/nas/a' || (p === '/nas' && ++rootAsked > 1);
      if (!lastHung) return Promise.resolve(aFolder);
      return new Promise((resolve) => { answerOf.set(p, () => resolve(aFolder)); });
    },
    opendir: async () => listingOf([]),
    deadline: () => {
      const late = lastHung ? Promise.resolve() : new Promise<void>(() => {});
      lastHung = false;
      return { late, cancel: () => {} };
    },
  });
  assert.match(reasonOf(await stillEmptyFolder('/nas/a', true)), /it did not answer within/);
  assert.match(reasonOf(await stillEmptyFolder('/nas', true)), /it did not answer within/);
  assert.deepEqual(stats, ['/nas/a', '/nas', '/nas'], 'a hangs, the probe of the root answers; then the root itself, offered, hangs');
  answerOf.get('/nas/a')!(); // a answers at last: one call out on the drive, and it is the root's own
  await settle();
  assert.match(reasonOf(await stillEmptyFolder('/nas/b', true)), /the drive it is on did not answer a moment ago/);
  assert.deepEqual(stats.slice(3), [], 'b is not asked while the drive\'s own root has not answered');
  answerOf.get('/nas')!();
  await settle();
  assert.deepEqual(await stillEmptyFolder('/nas/b', true), { empty: true }, 'the root answered: the drive is heard again');
});

test('four looks at once that hang on a drive heard from ask its root once, not four times', async () => {
  const stats: string[] = [];
  let lastHung = false;
  setEmptyCheckForTests({
    driveOf: async () => '/d',
    lstat: (p) => {
      stats.push(p);
      lastHung = p !== '/d/ok';
      return lastHung ? new Promise(() => { /* the folders and the root hang */ }) : Promise.resolve(aFolder);
    },
    opendir: async () => listingOf([]),
    deadline: () => {
      const late = lastHung ? Promise.resolve() : new Promise<void>(() => {});
      lastHung = false;
      return { late, cancel: () => {} };
    },
  });
  const session = emptyCheckSession(true);
  assert.deepEqual(await session.look('/d/ok'), { empty: true }, 'the drive is heard from');
  const verdicts = await Promise.all(['/d/h1', '/d/h2', '/d/h3', '/d/h4'].map((p) => session.look(p)));
  assert.deepEqual(verdicts.map(whyOf), ['no-answer', 'no-answer', 'no-answer', 'no-answer']);
  assert.equal(stats.filter((p) => p === '/d').length, 1, `one probe of the root (${stats.join(' ')})`);
});

test('a call that misses its deadline while the drive\'s root is being asked waits for that answer: one probe of a root at a time', async () => {
  // Nothing answers, and no deadline passes, until the test says: the order is the test's own.
  const calls: Array<{ path: string; answer: () => void }> = [];
  const deadlines: Array<{ of: string; pass: () => void }> = [];
  let last = '';
  setEmptyCheckForTests({
    driveOf: async () => '/d',
    lstat: (p) => {
      last = p;
      if (p === '/d/ok') return Promise.resolve(aFolder);
      return new Promise((resolve) => { calls.push({ path: p, answer: () => resolve(aFolder) }); });
    },
    opendir: async () => { last = ''; return listingOf([]); },
    deadline: () => {
      let pass = (): void => {};
      const late = new Promise<void>((resolve) => { pass = resolve; });
      deadlines.push({ of: last, pass });
      last = '';
      return { late, cancel: () => {} };
    },
  });
  const passDeadlineOf = (p: string): void => {
    const at = deadlines.findIndex((x) => x.of === p);
    assert.ok(at >= 0, `a deadline for ${p} is waiting`);
    deadlines.splice(at, 1)[0].pass();
  };
  const callsOn = (p: string) => calls.filter((c) => c.path === p);
  const session = emptyCheckSession(true);
  assert.deepEqual(await session.look('/d/ok'), { empty: true }, 'the drive is heard from');
  const a = session.look('/d/h1');
  const b = session.look('/d/h2');
  await turns(20);
  assert.deepEqual(calls.map((c) => c.path), ['/d/h1', '/d/h2'], 'both looks started');
  passDeadlineOf('/d/h1');
  await turns(20);
  assert.equal(callsOn('/d').length, 1, 'h1 missed its deadline: the root is asked');
  callsOn('/d/h1')[0].answer(); // h1 answers at last, while the root is still being asked
  await turns(20);
  passDeadlineOf('/d/h2');
  await turns(20);
  assert.equal(callsOn('/d').length, 1, 'h2 missed its deadline too: it waits for the root\'s answer rather than ask it again');
  passDeadlineOf('/d');
  assert.match(reasonOf(await a), /it did not answer within/);
  assert.match(reasonOf(await b), /it did not answer within/);
  assert.equal(callsOn('/d').length, 1);
});

test('within a request, the first look on a drive goes alone: four at once ask a silent drive once', async () => {
  const drives = twoDrives();
  setEmptyCheckForTests(drives.deps);
  const session = emptyCheckSession(true);
  const verdicts = await Promise.all(['/dead/1', '/dead/2', '/dead/3', '/dead/4'].map((p) => session.look(p)));
  assert.deepEqual(verdicts.map(whyOf), ['no-answer', 'no-answer', 'no-answer', 'no-answer']);
  assert.deepEqual(drives.stats, ['/dead/1', '/dead'], 'one probe and its drive\'s root, then the silence answers for the rest');
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
  const waits: string[] = [];
  const stats: string[] = [];
  let last = '';
  setEmptyCheckForTests({
    deadlineMs: EMPTY_CHECK_DEADLINE_MS,
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    driveOf: async () => { last = 'drive'; return 'slow'; },
    // Each stat takes 3 s of the session's clock, and answers.
    lstat: async (p) => { last = 'stat'; stats.push(p); now += 3_000; return { isDirectory: () => true }; },
    opendir: async () => { last = 'list'; return { read: async () => null, close: async () => {} }; },
    deadline: (ms) => { waits.push(`${last} ${ms}`); return { late: new Promise<void>(() => {}), cancel: () => {} }; },
  });
  const session = emptyCheckSession(true);
  const verdicts: EmptyVerdict[] = [];
  for (const p of ['/s/a', '/s/b', '/s/c', '/s/d', '/s/e']) {
    verdicts.push(await session.look(p));
    now += 100_000; // a Trash step between looks: not looking, so not counted
  }
  assert.deepEqual(verdicts.map(whyOf), ['empty', 'empty', 'empty', 'out-of-time', 'out-of-time'], '9 s of looking, then 12 s: d is cut, e never starts — TreeMap\'s time, not the drive (L-5)');
  assert.deepEqual(stats, ['/s/a', '/s/b', '/s/c', '/s/d'], 'nothing is asked once the 10 s are spent');
  assert.match(reasonOf(verdicts[4]), /the 10 seconds TreeMap gives to looking at folders again ran out/);
  assert.deepEqual(waits, [
    'drive 10000', 'stat 2000', 'list 2000',
    'drive 7000', 'stat 2000', 'list 2000',
    'drive 4000', 'stat 2000', 'list 1000',
    'drive 1000', 'stat 1000',
  ], 'each call waits 2 s, or what is left of the 10 s when that is less; the drive lookup waits what is left (U-4c L3)');
});

/** Let `n` turns of the event loop pass: a count, never a time. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('the drive lookup counts in the budget: the first in a minute may wait on the mount table (U-4b review, L3)', async () => {
  let now = 0;
  const stats: string[] = [];
  setEmptyCheckForTests({
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    driveOf: async () => { now += 4_000; return '/s'; }, // /sbin/mount, read again, may take up to 5 s
    lstat: async (p) => { stats.push(p); now += 3_000; return aFolder; },
    opendir: async () => listingOf([]),
    deadline: () => ({ late: new Promise<void>(() => {}), cancel: () => {} }),
  });
  const session = emptyCheckSession(true);
  assert.equal(whyOf(await session.look('/s/a')), 'empty', '7 s of the 10');
  const b = await session.look('/s/b');
  assert.match(reasonOf(b), /the 10 seconds TreeMap gives to looking at folders again ran out/, 'its lookup ran the 10 s out');
  assert.deepEqual(stats, ['/s/a'], 'b itself was never asked');
});

test('a drive lookup that does not answer is cut by the budget, never waited for unbounded (U-4b review, L3)', async () => {
  setEmptyCheckForTests({
    driveOf: () => new Promise<string>(() => { /* the mount table read hangs */ }),
    deadline: () => ({ late: Promise.resolve(), cancel: () => {} }), // the budget's deadline has passed
  });
  const verdict = await Promise.race([stillEmptyFolder('/s/hang', true), turns(50).then(() => null)]);
  assert.ok(verdict, 'the look answered: it did not wait for the lookup');
  assert.match(reasonOf(verdict), /ran out before it made sure this one is empty/);
});

test('waiting for another request\'s first look on a drive counts in this request\'s budget (U-4b review, L3)', async () => {
  let now = 0;
  const events: string[] = [];
  let answerA: () => void = () => {};
  let last = '';
  setEmptyCheckForTests({
    deadlineMs: EMPTY_CHECK_BUDGET_MS, // so a call's wait is what is left of the budget, and shows it
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    driveOf: async () => '/x',
    lstat: (p) => {
      last = `stat ${p}`;
      if (p !== '/x/a') return Promise.resolve(aFolder);
      return new Promise((resolve) => { answerA = () => resolve(aFolder); });
    },
    opendir: async (p) => { last = `list ${p}`; return listingOf([]); },
    deadline: (ms) => { events.push(`${last}: wait ${ms}`); last = ''; return { late: new Promise<void>(() => {}), cancel: () => {} }; },
  });
  const a = emptyCheckSession(true).look('/x/a'); // request A's look goes first on the drive, and hangs
  await turns(5);
  const b = emptyCheckSession(true).look('/x/b'); // request B's waits for it
  await turns(5);
  now += 6_000; // six seconds of B's waiting
  answerA();
  assert.equal(whyOf(await a), 'empty');
  assert.equal(whyOf(await b), 'empty');
  assert.ok(events.includes('stat /x/b: wait 4000'), `B's own stat had the 4 s its budget had left (${events.join(' | ')})`);
});

test('a drive lookup for a folder met below the one looked at is cut by the budget too (U-4b review, L3)', async () => {
  let last = '';
  setEmptyCheckForTests({
    driveOf: (p) => {
      last = p === '/x/top' ? 'drive' : '';
      return p === '/x/top' ? Promise.resolve('/') : new Promise<string>(() => { /* the lookup for inner hangs */ });
    },
    lstat: async () => { last = 'stat'; return aFolder; },
    opendir: async (p) => { last = 'list'; return listingOf(p === '/x/top' ? [dirent('inner', true)] : []); },
    // Only the hanging lookup's wait has its deadline pass.
    deadline: () => {
      const late = last === '' ? Promise.resolve() : new Promise<void>(() => {});
      last = 'used';
      return { late, cancel: () => {} };
    },
  });
  const verdict = await Promise.race([stillEmptyFolder('/x/top', true), turns(50).then(() => null)]);
  assert.ok(verdict, 'the look answered: it did not wait for the lookup');
  assert.match(reasonOf(verdict), /ran out before it made sure this one is empty/);
});

test('a wait for another request\'s first look on a drive ends when this request\'s budget does (U-4b review, L3)', async () => {
  let last = '';
  setEmptyCheckForTests({
    driveOf: async () => { last = 'drive'; return '/x'; },
    lstat: (p) => { last = `stat ${p}`; return new Promise(() => { /* request A's look hangs, and its deadline never passes */ }); },
    // Only a wait no call was just started for — the wait for another look — has its deadline pass.
    deadline: () => {
      const late = last === '' ? Promise.resolve() : new Promise<void>(() => {});
      last = '';
      return { late, cancel: () => {} };
    },
  });
  void emptyCheckSession(true).look('/x/a');
  await turns(5);
  const b = await Promise.race([emptyCheckSession(true).look('/x/b'), turns(50).then(() => null)]);
  assert.ok(b, 'request B answered while A still waits');
  assert.match(reasonOf(b), /ran out before it made sure this one is empty/);
});

test('the clock a look is timed on is monotonic: performance.now, never the wall clock (U-4b review, L3)', () => {
  // A step of the wall clock back once stretched the budget and a drive's silence; forward, spent it.
  Object.defineProperty(performance, 'now', { value: () => 42, configurable: true, writable: true });
  try {
    assert.equal(lookClock(), 42, 'read from performance.now');
  } finally {
    delete (performance as unknown as { now?: unknown }).now;
  }
});

/** Run `body` with performance.now reading the test's own count, put back after. */
async function onPerformanceNow(body: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  let tick = 0;
  Object.defineProperty(performance, 'now', { value: () => tick, configurable: true, writable: true });
  try {
    await body((ms) => { tick += ms; });
  } finally {
    delete (performance as unknown as { now?: unknown }).now;
  }
}

test('a session given no clock of its own is timed on that clock: its budget is spent by performance.now (U-4c review, F1.6)', async () => {
  // Every other budget and silence test brings its own `now`; this one leaves the real binding in place.
  await onPerformanceNow(async (advance) => {
    setEmptyCheckForTests({
      budgetMs: EMPTY_CHECK_BUDGET_MS,
      driveOf: async () => '/s',
      lstat: async () => { advance(3_000); return aFolder; },
      opendir: async () => listingOf([]),
      deadline: () => ({ late: new Promise<void>(() => {}), cancel: () => {} }),
    });
    const session = emptyCheckSession(true);
    const whys: string[] = [];
    for (const p of ['/s/a', '/s/b', '/s/c', '/s/d']) whys.push(whyOf(await session.look(p)));
    assert.deepEqual(whys, ['empty', 'empty', 'empty', 'out-of-time'], '3 s of performance.now a look: the fourth runs the 10 s out');
  });
});

test('the mount table read with no clock of the test\'s own is kept a minute of that clock: performance.now (U-4c review, F1.6)', { skip: process.platform === 'win32' && 'Windows keeps no mount table to read' }, async () => {
  let reads = 0;
  await onPerformanceNow(async (advance) => {
    setMountTableReaderForTests(async () => {
      reads++;
      return { source: 'mount', entries: [{ mountPoint: '/', filesystem: 'apfs', options: [] }], reason: null };
    });
    try {
      await driveOn('/x');
      advance(59_999);
      await driveOn('/y');
      assert.equal(reads, 1, 'kept for the minute');
      advance(1);
      await driveOn('/z');
      assert.equal(reads, 2, 'read again once a minute of performance.now has passed');
    } finally {
      setMountTableReaderForTests(null);
    }
  });
});

/* ─────────────── "gone" is only ever the folder itself (U-4c L1) ─────────────── */

const enoent = (syscall: string): NodeJS.ErrnoException => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall}`), { code: 'ENOENT' });
const aFolder = { isDirectory: () => true };
const dirent = (name: string, isDir: boolean): Dirent => ({ name, isDirectory: () => isDir, isFile: () => !isDir }) as unknown as Dirent;

test('an entry that vanishes while the listing is read is not the folder gone: Dir.read() rejecting ENOENT leaves it unreadable', async () => {
  // Node's Dir.read() stats an entry of a file system that gives no entry types; one removed between
  // the listing and that stat rejects the read with ITS ENOENT, while the folder still holds the rest.
  setEmptyCheckForTests({
    driveOf: async () => '/',
    lstat: async () => aFolder,
    opendir: async () => ({ read: async () => { throw enoent('lstat'); }, close: async () => {} }),
  });
  const verdict = await stillEmptyFolder('/x/holder', true);
  assert.equal(whyOf(verdict), 'unreadable', JSON.stringify(verdict));
  assert.match(reasonOf(verdict), /could not be read \(ENOENT\)/);
});

test('a folder whose opening fails ENOENT is gone only when a fresh stat of it fails ENOENT too', async () => {
  const stats: string[] = [];
  let thereOnSecondLook = true;
  setEmptyCheckForTests({
    driveOf: async () => '/',
    lstat: async (p) => {
      stats.push(p);
      if (stats.length > 1 && !thereOnSecondLook) throw enoent('lstat');
      return aFolder;
    },
    opendir: async () => { throw enoent('opendir'); },
  });
  const there = await stillEmptyFolder('/x/odd', true);
  assert.equal(whyOf(there), 'unreadable', 'still there when looked at again: not gone, and not shown empty');
  assert.deepEqual(stats, ['/x/odd', '/x/odd'], 'its own stat, then the fresh one');
  stats.length = 0;
  thereOnSecondLook = false;
  const gone = await stillEmptyFolder('/x/odd', true);
  assert.equal(whyOf(gone), 'gone', 'opening and the fresh stat agree');
  assert.deepEqual(stats, ['/x/odd', '/x/odd']);
});

test('a folder inside the one looked at that is not there any more makes it unreadable, never gone', async () => {
  setEmptyCheckForTests({
    driveOf: async () => '/',
    lstat: async () => aFolder,
    opendir: async (p) => {
      if (p !== '/x/top') throw enoent('opendir');
      const rest = [dirent('inner', true)];
      return { read: async () => rest.shift() ?? null, close: async () => {} };
    },
  });
  const verdict = await stillEmptyFolder('/x/top', true);
  assert.equal(whyOf(verdict), 'unreadable');
  assert.match(reasonOf(verdict), /the folder inner inside it could not be read \(ENOENT\)/);
});

test('a listing is read an entry at a time only where the file system names each entry\'s type; elsewhere whole, its stats off the event loop', async () => {
  // Node's Dir.read() stats an untyped entry with lstatSync, on the event loop: a slow or dead
  // network drive would stop the whole server, and no deadline could fire (the U-4b review, L1).
  for (const fsType of ['apfs', 'hfs', 'ext4', 'ext3', 'btrfs', 'tmpfs', 'zfs', 'f2fs']) {
    assert.equal(listsEntryTypes(fsType, 'linux'), true, `${fsType} names every entry's type`);
  }
  for (const fsType of ['nfs', 'smbfs', 'macfuse', 'fuse.sshfs', 'xfs', 'webdav', 'msdos', 'exfat', 'cifs', 'unknown']) {
    assert.equal(listsEntryTypes(fsType, 'darwin'), false, `${fsType}: not known to name entry types`);
  }
  assert.equal(listsEntryTypes(null, 'darwin'), false, 'a mount table that could not be read: read whole');
  assert.equal(listsEntryTypes(null, 'win32'), true, 'Windows names every entry\'s type');
  const calls: string[] = [];
  const via = (fsType: string | null) => ({
    platform: 'darwin' as NodeJS.Platform,
    filesystemOf: async () => fsType,
    opendir: async (p: string) => { calls.push(`opendir ${p}`); return { read: async () => null, close: async () => {} }; },
    readdir: async (p: string) => { calls.push(`readdir ${p}`); return [dirent('a', false), dirent('b', true)]; },
  });
  await openListing('/n/x', via('nfs'));
  await openListing('/u/x', via(null));
  await openListing('/a/x', via('apfs'));
  assert.deepEqual(calls, ['readdir /n/x', 'readdir /u/x', 'opendir /a/x']);
  const whole = await openListing('/n/y', via('smbfs'));
  assert.deepEqual([(await whole.read())?.name, (await whole.read())?.name, await whole.read()], ['a', 'b', null], 'served an entry at a time, then the end');
  await whole.close();
});

test('where listings may leave entry types out, a folder is read whole before any limit applies: the cost of keeping every stat off the event loop (U-4c review, F1.9)', { skip: process.platform === 'win32' && 'every Windows listing names its entries\' types: Windows never reads a folder whole' }, async () => {
  // Through the live listing (no deps of the test's own): an fs.Dir only where the table names a file
  // system whose listings carry each entry's type; elsewhere one readdir hands over every entry at once,
  // so the first entry settling a look, or the 1,000-entry limit, stops only the looking.
  const base = fs.realpathSync(fileTempDir('treemap-emptyFolderCheck-wide-'));
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(base, `f${i}`), '');
  const handed: number[] = [];
  const spied = fs.promises as unknown as Record<'readdir', (...args: unknown[]) => Promise<unknown[]>>;
  const realReaddir = spied.readdir;
  spied.readdir = async (...args: unknown[]) => {
    const entries = await realReaddir.apply(fs.promises, args);
    if (args[0] === base) handed.push(entries.length);
    return entries;
  };
  const firstOf = async (): Promise<void> => {
    const listing = await openListing(base);
    assert.ok(await listing.read(), 'an entry');
    await listing.close();
  };
  const tableSays = (filesystem: string): void =>
    setMountTableReaderForTests(async () => ({ source: 'mount', entries: [{ mountPoint: '/', filesystem, options: [] }], reason: null }));
  try {
    tableSays('smbfs');
    await firstOf();
    assert.deepEqual(handed, [40], 'one readdir, every entry, though one was read');
    handed.length = 0;
    tableSays('apfs');
    await firstOf();
    assert.deepEqual(handed, [], 'an fs.Dir, read an entry at a time');
  } finally {
    spied.readdir = realReaddir;
    setMountTableReaderForTests(null);
  }
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
  // One drive, one key, however it is spelled (the U-4b review, L4): separators, case, and the
  // extended-length prefixes, under which every share once shared the key \\?\UNC\.
  for (const spelling of ['C:\\x', 'C:/x', 'c:\\x\\y', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '//?/C:/x']) {
    assert.equal(driveFor(spelling, null, 'win32'), 'c:\\', spelling);
  }
  for (const spelling of ['\\\\server\\share\\a', '//server/share/a', '\\\\SERVER\\Share\\a', '\\\\?\\UNC\\server\\share\\a', '//?/UNC/server/share/a']) {
    assert.equal(driveFor(spelling, null, 'win32'), '\\\\server\\share\\', spelling);
  }
  assert.notEqual(driveFor('\\\\?\\UNC\\other\\share\\a', null, 'win32'), driveFor('\\\\?\\UNC\\server\\share\\a', null, 'win32'), 'two shares are two drives');
});

test('a mount table that cannot be read puts every path on one drive, "/", and has every listing read whole; it is read again only after a minute (U-4b review, INFO)', { skip: process.platform === 'win32' && 'Windows keeps no mount table to read' }, async () => {
  let reads = 0;
  let now = 0;
  const clock = (): number => now;
  setMountTableReaderForTests(async () => { reads++; throw new Error('mount: could not be run'); }, clock);
  try {
    assert.equal(await driveOn('/Volumes/Backup/x'), '/', 'one drive for everything, which only withholds more');
    assert.equal(await filesystemOn('/Volumes/Backup/x'), null);
    assert.equal(listsEntryTypes(await filesystemOn('/Users/me'), process.platform), false, 'so every listing is read whole');
    assert.equal(reads, 1, 'the failure is kept for the minute, not read again for each path');
    now += 60_000;
    await driveOn('/x');
    assert.equal(reads, 2, 'and read again once the minute is up');
    setMountTableReaderForTests(async () => { reads++; return { source: 'mount', entries: null, reason: 'the table could not be parsed' }; }, clock);
    assert.equal(await driveOn('/Volumes/Backup/x'), '/', 'a table read as unknown is the same');
    assert.equal(await filesystemOn('/Volumes/Backup/x'), null);
    setMountTableReaderForTests(async () => ({
      source: 'mount',
      entries: [{ mountPoint: '/', filesystem: 'apfs', options: [] }, { mountPoint: '/Volumes/Backup', filesystem: 'smbfs', options: [] }],
      reason: null,
    }), clock);
    assert.equal(await driveOn('/Volumes/Backup/x'), '/Volumes/Backup');
    assert.equal(await filesystemOn('/Volumes/Backup/x'), 'smbfs', 'a network share: read whole');
    assert.equal(await filesystemOn('/Users/me'), 'apfs', 'the boot drive: an entry at a time');
  } finally {
    setMountTableReaderForTests(null);
  }
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
