import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cleanupTrashTruthServer-data-');

import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';

import { collectCleanupSuggestions, ITEMS_PER_RULE } from '../src/services/cleanupRules';
import { FileNode } from '../src/models/types';
import { planCartCommit, commitCart, undoCartRun } from '../src/services/cartCommit';
import { getCapsuleJob } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { describeConflicts } from '../src/services/openHandleGuard';
import { linuxTrashLocations, windowsTrashNote, recycleInfoOriginalName, listAccountBin } from '../src/services/trash';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { createApp } from '../src/server';
import { isRestoreCopyFor } from './fixtures/restoreCopy';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt group C (24 Oct 2026), the server's half: the figures and sentences
 * the page prints about Clean Up, the cart, the Trash and the Undo Vault are
 * the server's, so they are pinned where they are made.
 */

const ROOT = path.resolve('/scanroot');
let uid = 0;
function file(name: string, size: number, at: string): FileNode {
  return { name, path: path.join(at, name), size, type: 'file', modifiedAt: Date.now(), isHidden: false, extension: (name.split('.').pop() || '').toLowerCase() };
}
function dir(name: string, children: (at: string) => FileNode[], at: string): FileNode {
  const here = path.join(at, name);
  const kids = children(here);
  return { name, path: here, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
}

/* ═════════ C62 — a group counts every match, as its total does ═════════ */

test('a Smart suggestions group counts every match beside its capped list, so the badge can say how many (C62)', () => {
  const N = ITEMS_PER_RULE + 50;
  const kids = Array.from({ length: N }, (_, i) => dir(`p${i}`, (at) => [dir('__pycache__', (a) => [file(`x${uid++}.pyc`, 1000 + i, a)], at)], ROOT));
  const root: FileNode = { name: 'scanroot', path: ROOT, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids };
  const py = collectCleanupSuggestions(root, []).find((g) => g.id === 'regen-pycache');
  assert.ok(py, 'control: the rule matched');
  assert.equal(py.items.length, ITEMS_PER_RULE, 'control: the list is capped');
  assert.equal(py.count, N, 'the count is every match, as totalSize is');
  const one = collectCleanupSuggestions({ ...root, children: kids.slice(0, 1), size: kids[0].size }, []).find((g) => g.id === 'regen-pycache');
  assert.equal(one?.count, 1, 'and a single match is one');
});

/* ═════════ C74 — an item already gone has a code of its own, and a sentence ═════════ */

test('an item already gone is ITEM_GONE with "no longer there", in the dry run and in the commit, never a raw ENOENT (C74)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-gone-'));
  const trash = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-gone-trash-'));
  setTrashStepForTests(async (p) => fsp.rename(p, path.join(trash, path.basename(p))));
  try {
    const real = path.join(dir, 'real.bin');
    await fsp.writeFile(real, Buffer.alloc(512, 1));
    const missing = path.join(dir, 'never-existed.bin');
    const plan = await planCartCommit([real, missing]);
    const planned = plan.items.find((i) => i.path === missing);
    assert.equal(planned?.willDelete, false, 'control: nothing to delete');
    assert.equal(planned?.code, 'ITEM_GONE', 'the dry run names it gone');
    assert.match(planned?.reason ?? '', /no longer there/);

    const committed = await commitCart([real, missing]);
    assert.deepEqual(committed.trashed, [real], `control: the real one went (${JSON.stringify(committed)})`);
    const skipped = committed.skipped.find((s) => s.path === missing);
    assert.equal(skipped?.code, 'ITEM_GONE', 'and so does the commit');
    assert.equal(skipped?.reason, 'It is no longer there — nothing to delete.', 'in the same words, never the system\'s ENOENT');
  } finally {
    setTrashStepForTests(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(trash, { recursive: true, force: true });
  }
});

/* ═════════ C75 — an undo stopped part-way counts what it put back, and its stream says so ═════════ */

function streamEnd(port: number, url: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve(buf.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))));
    }).on('error', reject);
  });
}

test('an undo that fails part-way counts the items it put back, and its progress stream says how many of how many (C75)', async () => {
  // Its real path: a restore writes where each item really was (macOS's tmpdir is under a link).
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-undo-')));
  const trash = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-undo-trash-'));
  const files = ['a', 'b'].map((d) => path.join(dir, d, 'f.bin'));
  for (const f of files) { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, Buffer.alloc(4096, 2)); }
  setTrashStepForTests(async (p) => fsp.rename(p, path.join(trash, path.basename(path.dirname(p)) + '-' + path.basename(p))));
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  let removeFault = (): void => {};
  try {
    const committed = await commitCart(files);
    assert.equal(committed.trashed.length, 2, `control: both went (${JSON.stringify(committed)})`);
    // The first file restored comes back; the second one's copy fails.
    let first: string | null = null;
    removeFault = setCopyFaultForTests((dest) => {
      const f = files.find((x) => isRestoreCopyFor(dest, x));
      if (!f) return null;
      first ??= f;
      return f === first ? null : new Error('the disk stopped answering (a test)');
    });
    const { jobId } = await undoCartRun(committed.runId);
    await waitFor(() => { const j = getCapsuleJob(jobId); return j !== undefined && j.status !== 'running'; }, 'the undo job settling', 25);
    const job = getCapsuleJob(jobId)!;
    assert.equal(job.status, 'error', `the case under test: the second restore failed (${job.error})`);
    assert.equal(files.filter((f) => fs.existsSync(f)).length, 1, 'control: one is back');
    assert.equal(job.entriesDone, 1, 'the job counts the item it put back');
    const events = await streamEnd((server.address() as { port: number }).port, `/api/timecapsule/jobs/${jobId}/progress`);
    const end = events[events.length - 1];
    assert.equal(end.type, 'error', JSON.stringify(events));
    assert.equal(end.entriesDone, 1, 'the stream says how many were put back');
    assert.equal(end.entryCount, 2, 'of how many');
  } finally {
    removeFault();
    setTrashStepForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(trash, { recursive: true, force: true });
  }
});

/* ═════════ C76 — describeConflicts agrees with what it counts ═════════ */


test('the open-file sentence is plural when it names several files or programs (C76)', () => {
  const c = (processName: string, openPath: string) => ({ path: '/p', pid: processName.length, processName, openPath });
  assert.equal(describeConflicts([c('Chrome', '/p/a'), c('Mail', '/p/b'), c('Mail', '/p/c')]),
    'Chrome and Mail have 3 of the files you’re deleting open right now. Deleting them may not free the space until those programs close them.');
  assert.equal(describeConflicts([c('Code', '/p/a'), c('Code', '/p/b')]),
    'Code has 2 of the files you’re deleting open right now. Deleting them may not free the space until that program closes them.');
  assert.equal(describeConflicts([c('TextEdit', '/p/a'), c('Preview', '/p/a')]),
    'TextEdit and Preview have a file you’re deleting open right now. Deleting it may not free the space until those programs close it.');
  assert.equal(describeConflicts([c('Code', '/p/a')]),
    'Code has a file you’re deleting open right now. Deleting it may not free the space until that program closes it.', 'control: one of each, as before');
});

/* ═════════ C67 — the Trash listing covers what the emptier clears, or says it does not ═════════ */

/** A Windows `$I` record, version 2 (Windows 10 and later): header, size, time, name length, name. */
function infoV2(original: string): Buffer {
  const name = Buffer.from(original + '\0', 'utf16le');
  const head = Buffer.alloc(28);
  head.writeBigInt64LE(2n, 0); head.writeBigInt64LE(1234n, 8); head.writeBigInt64LE(0n, 16); head.writeInt32LE(original.length + 1, 24);
  return Buffer.concat([head, name]);
}
/** Version 1 (Vista to 8.1): the name in a fixed 520-byte field. */
function infoV1(original: string): Buffer {
  const b = Buffer.alloc(24 + 520);
  b.writeBigInt64LE(1n, 0); b.writeBigInt64LE(1234n, 8);
  Buffer.from(original, 'utf16le').copy(b, 24);
  return b;
}

test('a Windows Recycle Bin record names the file that was deleted, in both record versions, and a broken one names nothing (C67)', () => {
  assert.equal(recycleInfoOriginalName(infoV2('C:\\Users\\u\\Documents\\report.docx')), 'report.docx');
  assert.equal(recycleInfoOriginalName(infoV1('D:\\photos\\cat.jpg')), 'cat.jpg');
  assert.equal(recycleInfoOriginalName(Buffer.alloc(10)), null, 'too short to be a record');
  assert.equal(recycleInfoOriginalName(infoV2('x').subarray(0, 30)), null, 'a name cut short');
});

test('a Windows account\'s Recycle Bin folder is listed by the files in it, each by its own name; another account\'s is not this user\'s Trash (C67)', async () => {
  const sid = path.win32.join('C:\\', '$Recycle.Bin', 'S-1-5-21-1-2-3-1001');
  const files: Record<string, Buffer> = { [path.win32.join(sid, '$IAB12CD.docx')]: infoV2('C:\\Users\\u\\report.docx') };
  const deps = {
    join: path.win32.join,
    readdir: async (dir: string) => {
      if (dir !== sid) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return [
        { name: '$RAB12CD.docx', isDirectory: () => false, isSymbolicLink: () => false },
        { name: '$IAB12CD.docx', isDirectory: () => false, isSymbolicLink: () => false },
        { name: '$RZZ9.folder', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'desktop.ini', isDirectory: () => false, isSymbolicLink: () => false },
      ];
    },
    lstat: async (p: string) => ({ size: p.endsWith('$IAB12CD.docx') ? 100 : p.endsWith('desktop.ini') ? 50 : 4000 }),
    readFile: async (p: string) => { if (p in files) return files[p]; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    dirSize: async () => 9000,
  };
  const mine = await listAccountBin(sid, deps);
  assert.deepEqual(mine.items.map((i) => [i.name, i.size]), [['report.docx', 4000], ['$RZZ9.folder', 9000]],
    'each deleted file is an item, by its own name where its record gives one; the account folder is not an item');
  assert.equal(mine.bytes, 4000 + 9000 + 100 + 50, 'every byte the folder holds is counted');
  const theirs = await listAccountBin(path.win32.join('C:\\', '$Recycle.Bin', 'S-1-5-21-1-2-3-1002'), deps);
  assert.deepEqual(theirs, { items: [], bytes: 0, unreadable: false }, 'another account\'s folder: not this user\'s Trash, and not a failure');
});

test('on Windows the listing says which drives it reads, so the Empty Trash sheet never quotes a floor as exact (C67)', () => {
  const note = windowsTrashNote(['C:', 'D:', 'E:']);
  assert.match(note, /C:, D: and E:/);
  assert.match(note, /every drive/, 'and that emptying it empties every drive\'s');
});

test('on Linux the Trash includes each drive\'s own Trash folders, never a kernel table or a network share, and an unreadable mount table is said (C67)', () => {
  const mounts = [
    { mountPoint: '/', filesystem: 'ext4', options: [] }, { mountPoint: '/media/u/USB', filesystem: 'vfat', options: [] },
    { mountPoint: '/proc', filesystem: 'proc', options: [] }, { mountPoint: '/mnt/nas', filesystem: 'nfs4', options: [] },
  ];
  const got = linuxTrashLocations('/home/u/.local/share', 1000, mounts);
  assert.deepEqual(got.dirs, [
    '/home/u/.local/share/Trash/files',
    '/.Trash/1000/files', '/.Trash-1000/files',
    '/media/u/USB/.Trash/1000/files', '/media/u/USB/.Trash-1000/files',
  ]);
  assert.equal(got.note, null, 'a table read is a whole list');
  const unread = linuxTrashLocations('/home/u/.local/share', 1000, null);
  assert.deepEqual(unread.dirs, ['/home/u/.local/share/Trash/files'], 'the home Trash still counts');
  assert.match(unread.note ?? '', /another drive/, 'and what is not counted is said');
  assert.deepEqual(linuxTrashLocations('/d', null, mounts).dirs, ['/d/Trash/files'], 'no uid, no per-drive folder to name');
});
