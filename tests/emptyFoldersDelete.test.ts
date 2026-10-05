import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-emptyFoldersDelete-data-');
process.env.TREEMAP_NO_GDU = '1';

import { startScan } from '../src/services/diskScanner';
import { moveToTrash, setTrashStepForTests } from '../src/services/cleaner';
import { EMPTY_CHECK_BUDGET_MS, EMPTY_CHECK_DEADLINE_MS, EMPTY_CHECK_MAX_ENTRIES, lookDeadlineMs, setEmptyCheckForTests, stillEmptyFolder } from '../src/services/emptyFolderCheck';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { canLock } from './fixtures/nativeEdge';
import { HANG_GUARD_MS, waitFor, withinHangGuard } from './fixtures/waitFor';

/**
 * Track U, U-4: the last look before an empty folder goes to the Trash.
 *
 * Empty Folders offers what the scan saw empty, and the page sends the ticked
 * folders to `DELETE /api/files`. That route trashes whatever it is given, so a
 * folder that gained a file between the list and the click went with the file.
 * With `onlyEmptyFolders: true` every path is looked at once more, right before
 * its own Trash step: a folder that holds anything (OS junk such as `.DS_Store`
 * aside), that cannot be read, or that does not answer is left where it is and
 * reported in `failed[]` with `code: 'FOLDER_NOT_EMPTY'`. Without the flag the
 * route is what it was. Nothing reaches the machine's Trash: the step is
 * replaced for the whole file and records what it was handed.
 */

const ROOT = fs.realpathSync(fileTempDir('treemap-emptyFoldersDelete-'));
const at = (...p: string[]): string => path.join(ROOT, ...p);
for (const d of ['gained', 'still', 'junk', 'nest/a', 'filled', 'locked-holder/locked', 'many']) fs.mkdirSync(at(...d.split('/')), { recursive: true });
fs.writeFileSync(at('junk', '.DS_Store'), 'Finder');
fs.writeFileSync(at('a-file.txt'), 'not a folder');

const trashed: string[] = [];
let server: http.Server;
let port: number;

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
  });
  resetRateLimiter();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  // The paths must lie inside a root this server scanned.
  const scan = await startScan(ROOT);
  await waitFor(() => scan.status !== 'running', 'the scan of the delete fixture');
  assert.equal(scan.status, 'complete', scan.error);
  // A file arrives after the scan saw the folder empty.
  fs.writeFileSync(at('gained', 'arrived.txt'), 'after the list was drawn');
});

beforeEach(() => {
  trashed.length = 0;
});

after(async () => {
  setTrashStepForTests(null);
  setEmptyCheckForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(method: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: buf });
          }
        });
      },
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

const trash = (body: Record<string, unknown>) => send('DELETE', '/api/files', { ignoreOpenHandles: true, ...body });

test('a folder that gained a file since the list is left where it is; the empty ones go', async () => {
  const r = await trash({ paths: [at('gained'), at('still'), at('junk'), at('nest')], onlyEmptyFolders: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted, [at('still'), at('junk'), at('nest')], 'an empty folder, one holding only junk, and one holding only an empty folder');
  assert.equal(r.body.failed.length, 1);
  const [refusal] = r.body.failed;
  assert.equal(refusal.path, at('gained'));
  assert.equal(refusal.code, 'FOLDER_NOT_EMPTY');
  assert.equal(refusal.refused, true, 'TreeMap never handed it to the Trash');
  assert.match(refusal.reason, /arrived\.txt/, 'the reason names what is in it now');
  assert.deepEqual(trashed, [at('still'), at('junk'), at('nest')], 'the Trash step was never asked about the folder that is not empty');
});

test('a folder holding a folder that cannot be read is refused', { skip: !canLock && 'a folder cannot be made unlistable here (Windows, or running as root)' }, async () => {
  fs.chmodSync(at('locked-holder', 'locked'), 0o000);
  try {
    const r = await trash({ paths: [at('locked-holder')], onlyEmptyFolders: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.deleted, []);
    assert.equal(r.body.failed[0].code, 'FOLDER_NOT_EMPTY');
    assert.match(r.body.failed[0].reason, /could not be read/);
    assert.deepEqual(trashed, []);
  } finally {
    fs.chmodSync(at('locked-holder', 'locked'), 0o755);
  }
});

test('a folder that is gone is not "not empty": it goes on to the Trash step, which says what it says', async () => {
  // The check refuses what it can show is not an empty folder; a path that is no
  // longer there is the Trash step's to report, as it always was.
  const r = await trash({ paths: [at('never-was')], onlyEmptyFolders: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.failed.some((f: { code?: string }) => f.code === 'FOLDER_NOT_EMPTY'), 'not refused as not empty');
  assert.deepEqual(trashed, [at('never-was')], 'handed to the Trash step (this file\'s stand-in, which reports success)');
});

test('a file is not an empty folder', async () => {
  const r = await trash({ paths: [at('a-file.txt')], onlyEmptyFolders: true });
  assert.equal(r.body.failed[0].code, 'FOLDER_NOT_EMPTY');
  assert.match(r.body.failed[0].reason, /not a folder/);
  assert.deepEqual(trashed, []);
});

test('without the flag the route trashes what it is given, as before', async () => {
  const r = await trash({ paths: [at('gained')] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted, [at('gained')]);
  assert.deepEqual(trashed, [at('gained')], 'a caller that did not ask for the check gets none');
});

test('a dry run with the flag names what the real run would leave, and touches nothing', async () => {
  const r = await trash({ paths: [at('gained'), at('still')], onlyEmptyFolders: true, dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.wouldTrash.map((w: { path: string }) => w.path), [at('still')], 'only what the real run would trash');
  assert.equal(r.body.notEmpty.length, 1);
  assert.equal(r.body.notEmpty[0].path, at('gained'));
  assert.equal(r.body.notEmpty[0].code, 'FOLDER_NOT_EMPTY');
  assert.match(r.body.notEmpty[0].reason, /arrived\.txt/);
  assert.deepEqual(trashed, [], 'a dry run trashes nothing');
});

test('a dry run without the flag says nothing about emptiness', async () => {
  const r = await trash({ paths: [at('gained')], dryRun: true });
  assert.equal(r.body.notEmpty, undefined, 'the manifest is what it was');
  assert.deepEqual(r.body.wouldTrash.map((w: { path: string }) => w.path), [at('gained')]);
});

test('onlyEmptyFolders that is not a boolean is refused before anything happens', async () => {
  const r = await trash({ paths: [at('still')], onlyEmptyFolders: 'yes' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ONLY_EMPTY_FOLDERS_INVALID');
  assert.deepEqual(trashed, []);
});

test('moveToTrash itself looks again, right before each folder\'s own Trash step', async () => {
  // The first folder's step fills the second: the look must come at the second's turn, not before the batch.
  const first = at('still');
  const second = at('filled');
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    if (p === first) fs.writeFileSync(path.join(second, 'late.txt'), 'written while the batch ran');
  });
  try {
    const result = await moveToTrash([first, second], { ignoreOpenHandles: true, onlyEmptyFolders: true });
    assert.deepEqual(result.deleted, [first]);
    assert.equal(result.failed[0].path, second);
    assert.equal(result.failed[0].code, 'FOLDER_NOT_EMPTY');
    assert.deepEqual(trashed, [first]);
  } finally {
    setTrashStepForTests(async (p) => {
      trashed.push(p);
    });
  }
});

/* ─────────────── a drive that does not answer (U-4b M1) ─────────────── */

const passedDeadline = (): { late: Promise<void>; cancel: () => void } => ({ late: Promise.resolve(), cancel: () => {} });

/** Every stat hangs, as on a dead network mount; `asked` counts the threads such stats would hold. */
function deadDrive(): { asked: () => number } {
  let asked = 0;
  setEmptyCheckForTests({
    lstat: () => {
      asked++;
      return new Promise(() => { /* a drive that stopped answering */ });
    },
    deadline: passedDeadline,
    driveOf: async () => 'the one drive',
  });
  return { asked: () => asked };
}

const twenty = Array.from({ length: 20 }, (_, i) => at(`quiet-${i}`));

test('a delete of twenty folders on a drive that does not answer asks it once, and moves none of them', async () => {
  const drive = deadDrive();
  try {
    const r = await trash({ paths: twenty, onlyEmptyFolders: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.deleted, []);
    assert.equal(r.body.failed.length, 20);
    for (const f of r.body.failed) {
      assert.equal(f.refused, true, 'never handed to the Trash');
      assert.match(f.reason, /did not answer/);
    }
    assert.equal(drive.asked(), 1, 'the first silence answers for the other nineteen: one thread held, not twenty');
    assert.deepEqual(trashed, []);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('a dry run on that drive asks it once, and the real run after it does not ask again', async () => {
  const drive = deadDrive();
  try {
    const dry = await trash({ paths: twenty, onlyEmptyFolders: true, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.notEmpty.length, 20);
    assert.deepEqual(dry.body.wouldTrash, []);
    assert.equal(drive.asked(), 1);
    const real = await trash({ paths: twenty, onlyEmptyFolders: true });
    assert.equal(real.body.failed.length, 20);
    assert.equal(drive.asked(), 1, 'the silence the dry run met is carried into the delete');
    assert.deepEqual(trashed, []);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('a delete looks for 10 s at most, and its Trash steps between looks are not looking', async () => {
  const five = ['b1', 'b2', 'b3', 'b4', 'b5'].map((n) => at('budget', n));
  for (const p of five) fs.mkdirSync(p, { recursive: true });
  let now = 0;
  setEmptyCheckForTests({
    budgetMs: EMPTY_CHECK_BUDGET_MS,
    now: () => now,
    driveOf: async () => 'slow drive',
    lstat: async (p) => { now += 3_000; return fs.promises.lstat(p); }, // each look takes 3 s of the clock
  });
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    now += 60_000; // a slow Trash: a minute a folder, none of it spent looking
  });
  try {
    const result = await moveToTrash(five, { ignoreOpenHandles: true, onlyEmptyFolders: true });
    assert.deepEqual(result.deleted, five.slice(0, 3), '9 s of looking: three folders');
    assert.deepEqual(result.failed.map((f) => f.path), five.slice(3), 'the fourth look ran past 10 s, the fifth never started');
    for (const f of result.failed) assert.match(f.reason, /10 seconds TreeMap gives to looking at folders again ran out/);
    assert.deepEqual(trashed, five.slice(0, 3));
    // A dry run is one request too: one budget for all its looks.
    now = 0;
    setEmptyCheckForTests({
      budgetMs: EMPTY_CHECK_BUDGET_MS,
      now: () => now,
      driveOf: async () => 'slow drive',
      lstat: async (p) => { now += 3_000; return fs.promises.lstat(p); },
    });
    const dry = await trash({ paths: five, onlyEmptyFolders: true, dryRun: true });
    assert.deepEqual(dry.body.wouldTrash.map((w: { path: string }) => w.path), five.slice(0, 3));
    assert.deepEqual(dry.body.notEmpty.map((n: { path: string }) => n.path), five.slice(3));
  } finally {
    setEmptyCheckForTests(null);
    setTrashStepForTests(async (p) => {
      trashed.push(p);
    });
  }
});

/* ─────────────── the look itself ─────────────── */

test('the look: what makes a folder not empty, each with its reason', async () => {
  assert.deepEqual(await stillEmptyFolder(at('still'), true), { empty: true });
  assert.deepEqual(await stillEmptyFolder(at('junk'), true), { empty: true }, 'junk does not count, with the junk rule');
  const junkCounts = await stillEmptyFolder(at('junk'), false);
  assert.equal(junkCounts.empty, false, 'and counts without it');
  const gained = await stillEmptyFolder(at('gained'), true);
  assert.equal(gained.empty === false && gained.why, 'content');
  const gone = await stillEmptyFolder(at('never-was'), true);
  assert.equal(gone.empty === false && gone.why, 'gone');
  const notFolder = await stillEmptyFolder(at('a-file.txt'), true);
  assert.equal(notFolder.empty === false && notFolder.why, 'not-a-folder');
  const link = at('link-to-still');
  fs.symlinkSync(at('still'), link, 'junction');
  try {
    const viaLink = await stillEmptyFolder(link, true);
    assert.equal(viaLink.empty === false && viaLink.why, 'not-a-folder', 'a link is never followed: it is not the folder that was offered');
  } finally {
    fs.unlinkSync(link);
  }
});

test('the look stops after so many entries, and a folder it could not finish is not empty', async () => {
  assert.equal(EMPTY_CHECK_MAX_ENTRIES, 1000);
  const wide = at('many');
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(wide, `d${i}`), { recursive: true });
  setEmptyCheckForTests({ maxEntries: 4 });
  try {
    const cut = await stillEmptyFolder(wide, true);
    assert.equal(cut.empty === false && cut.why, 'too-many');
  } finally {
    setEmptyCheckForTests(null);
  }
  assert.deepEqual(await stillEmptyFolder(wide, true), { empty: true }, 'five empty folders are well within the real limit');
});

/**
 * A listing of `n` entries handed out one read at a time, as `fs.Dir` hands them, counting the reads:
 * a folder of a million entries must not be read whole before the look gives up on it (U-4b L5).
 */
function countedListing(target: string, n: number, kind: 'dir' | 'file') {
  const seen = { reads: 0, closed: false };
  const entry = (i: number): fs.Dirent => ({
    name: `e${i}`, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => false,
  }) as unknown as fs.Dirent;
  const opendir = async (p: string) => {
    assert.equal(p, target, 'only the folder offered is opened: the look stops before any folder inside it');
    return {
      read: async () => (seen.reads < n ? entry(seen.reads++) : (seen.reads++, null)),
      close: async () => { seen.closed = true; },
    };
  };
  return { seen, opendir };
}

test('the look reads a listing only as far as it needs, and closes it', async () => {
  const target = at('wide-on-another-drive');
  const isFolder = () => Promise.resolve({ isDirectory: () => true });
  const folders = countedListing(target, 10_000, 'dir');
  setEmptyCheckForTests({ lstat: isFolder, opendir: folders.opendir });
  try {
    const cut = await stillEmptyFolder(target, true);
    assert.equal(cut.empty === false && cut.why, 'too-many');
    assert.equal(folders.seen.reads, EMPTY_CHECK_MAX_ENTRIES + 1, 'one entry past the limit is read, not all 10,000');
    assert.equal(folders.seen.closed, true, 'and the listing is closed');
    const files = countedListing(target, 10_000, 'file');
    setEmptyCheckForTests({ lstat: isFolder, opendir: files.opendir });
    const full = await stillEmptyFolder(target, true);
    assert.equal(full.empty === false && full.why, 'content');
    assert.equal(files.seen.reads, 1, 'the first file settles it');
    assert.equal(files.seen.closed, true);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('a look waits 2 s for a stat or a listing — under a test runner, as long as the hang guard (U-4b L6)', async () => {
  // A loaded runner once stalled 6.6 s (Windows CI): a real temp folder must not read as a drive that went silent.
  assert.equal(EMPTY_CHECK_DEADLINE_MS, 2000);
  assert.equal(lookDeadlineMs({}), EMPTY_CHECK_DEADLINE_MS, 'the app waits 2 s');
  assert.equal(lookDeadlineMs({ NODE_TEST_CONTEXT: 'child-v8' }), HANG_GUARD_MS, 'node:test');
  assert.equal(lookDeadlineMs({ TREEMAP_FORBID_REAL_TRASH: '1' }), HANG_GUARD_MS, 'npm test, and any file that loads the data-dir fixture');
  // And the looks in this file are given that deadline: each stat and listing asks for it.
  const asked: number[] = [];
  setEmptyCheckForTests({ deadline: (ms) => { asked.push(ms); return { late: new Promise<void>(() => {}), cancel: () => {} }; } });
  try {
    assert.deepEqual(await stillEmptyFolder(at('nest'), true), { empty: true });
    assert.ok(asked.length >= 2, `the stat and the listings each had a deadline (${asked.length})`);
    assert.deepEqual([...new Set(asked)], [HANG_GUARD_MS]);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('the real timer ends a look that does not answer', async () => {
  setEmptyCheckForTests({ lstat: () => new Promise(() => { /* never answers */ }), deadlineMs: 1 });
  try {
    const silent = await withinHangGuard(stillEmptyFolder(at('still'), true), 'a look on the real 1 ms timer');
    assert.equal(silent.empty === false && silent.why, 'no-answer');
    assert.match(silent.empty === false ? silent.reason : '', /did not answer within 1 ms/);
  } finally {
    setEmptyCheckForTests(null);
  }
});

test('a look that does not answer is not empty, whether the stat or the listing goes silent', async () => {
  const never = (): Promise<never> => new Promise(() => { /* a drive that stopped answering */ });
  const passed = (): { late: Promise<void>; cancel: () => void } => ({ late: Promise.resolve(), cancel: () => {} });
  try {
    setEmptyCheckForTests({ lstat: never, deadline: passed });
    const statSilent = await stillEmptyFolder(at('still'), true);
    assert.equal(statSilent.empty === false && statSilent.why, 'no-answer', 'the folder\'s own stat');
    // The stat answers at once (an answer already there wins the race); the listing never does.
    setEmptyCheckForTests({ lstat: () => Promise.resolve({ isDirectory: () => true }), opendir: never, deadline: passed });
    const listSilent = await stillEmptyFolder(at('still'), true);
    assert.equal(listSilent.empty === false && listSilent.why, 'no-answer', 'its listing');
    assert.match(listSilent.empty === false ? listSilent.reason : '', /did not answer/);
  } finally {
    setEmptyCheckForTests(null);
  }
});
