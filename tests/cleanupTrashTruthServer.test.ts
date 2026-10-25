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
import { getCapsuleJob, setSourceCallForTests } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { describeConflicts } from '../src/services/openHandleGuard';
import { readProvenance } from '../src/services/provenanceTracker';
import { parse } from '../src/services/query/parse';
import {
  linuxTrashLocations, windowsTrashNote, recycleInfoOriginalName, listAccountBin, resolveTrashLocations, getTrashInfo, clearFreedesktopTrash, liveDriveTrashFs,
  parseWindowsTrashDrives, WINDOWS_TRASH_DRIVES_SCRIPT, runTrashEmptiers, emptyTrashCommands,
} from '../src/services/trash';
import type { EmptyTrashResult } from '../src/services/trash';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { describeFsError } from '../src/utils/errno';
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

test('a folder that is still there is never called gone because a folder inside it vanished while it was read: it is left in place and stays in the cart (review F1.1/F1.13)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-nested-gone-'));
  const trash = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-nested-gone-trash-'));
  setTrashStepForTests(async (p) => fsp.rename(p, path.join(trash, path.basename(p))));
  const cache = path.join(dir, 'cache');
  const sub = path.join(cache, 'sub');
  await fsp.mkdir(sub, { recursive: true });
  await fsp.writeFile(path.join(cache, 'keep.bin'), Buffer.alloc(256, 1));
  await fsp.writeFile(path.join(sub, 'x.bin'), Buffer.alloc(256, 2));
  // The inner folder's listing fails as one removed between its parent's listing and its own does.
  const vanished = () => Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, scandir '${sub}'`), { code: 'ENOENT' }));
  const restore = setSourceCallForTests((what, abs) => (what === 'readdir' && abs === sub ? vanished() : null));
  try {
    const plan = await planCartCommit([cache]);
    const planned = plan.items.find((i) => i.path === cache);
    assert.equal(planned?.willDelete, false, 'control: it cannot be protected whole as it stands');
    assert.notEqual(planned?.code, 'ITEM_GONE', 'the dry run does not call a folder that is there gone');
    assert.equal(planned?.code, 'CAPSULE_UNREADABLE', 'it is a folder that changed while it was read');
    assert.match(planned?.reason ?? '', /went away while TreeMap was reading it/, 'and says so');

    const committed = await commitCart([cache]);
    assert.deepEqual(committed.trashed, [], 'control: nothing went');
    const skipped = committed.skipped.find((s) => s.path === cache);
    assert.notEqual(skipped?.code, 'ITEM_GONE', 'nor does the commit');
    assert.equal(skipped?.code, 'CAPSULE_UNREADABLE');
    assert.match(skipped?.reason ?? '', /went away while TreeMap was reading it.*left in place/, 'it says it was left in place');
    assert.equal(fs.existsSync(path.join(cache, 'keep.bin')), true, 'control: it is still on the disk');

    // The second look at the item itself gets no answer: that is no proof it is gone either.
    restore();
    let looks = 0;
    const silent = () => Promise.reject(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' }));
    const restore2 = setSourceCallForTests((what, abs) => {
      if (what === 'readdir' && abs === sub) return vanished();
      if (what === 'lstat' && abs === cache && ++looks === 2) return silent();
      return null;
    });
    try {
      const unsure = (await planCartCommit([cache])).items.find((i) => i.path === cache);
      assert.equal(looks, 2, 'control: the item was looked at again');
      assert.notEqual(unsure?.code, 'ITEM_GONE', 'a look that got no answer does not make it gone');
    } finally {
      restore2();
    }
  } finally {
    restore();
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

test('on Windows the listing says which drives it reads when it could not list them, so the Empty Trash sheet never quotes a floor as exact (C67)', () => {
  const note = windowsTrashNote(['C:', 'D:', 'E:']);
  assert.match(note, /could not list this computer\u2019s drives/, 'why it reads only these');
  assert.match(note, /C:, D: and E:/);
  assert.match(note, /every drive/, 'and that emptying it empties every drive\'s');
});

test('on Windows the listing reads the Recycle Bin of every local drive the computer has, so an empty one reads as empty; only drives it could not list make it a floor (review F1.6)', async () => {
  const inputs = (windowsDrives: string[] | null) => ({ platform: 'win32' as const, dataHome: '', uid: null, mounts: null, fs: liveDriveTrashFs, windowsDrives });
  const all = await resolveTrashLocations(inputs(['C:', 'F:']));
  assert.deepEqual(all.dirs, ['C:\\$Recycle.Bin', 'F:\\$Recycle.Bin'], 'each local drive\'s Recycle Bin');
  assert.equal(all.note, null, 'every local drive read is a whole listing, which can say the Recycle Bin is empty');
  const unlisted = await resolveTrashLocations(inputs(null));
  assert.deepEqual(unlisted.dirs, ['C:\\$Recycle.Bin', 'D:\\$Recycle.Bin', 'E:\\$Recycle.Bin'], 'control: the drives it falls back to');
  assert.equal(unlisted.note, windowsTrashNote(['C:', 'D:', 'E:']), 'drives it could not list: the listing says it is a floor');

  assert.deepEqual(parseWindowsTrashDrives(['C:', 'f:', 'C:', 'junk', 7, 'Z:\\']), ['C:', 'F:'], 'drive letters only, each once');
  assert.deepEqual(parseWindowsTrashDrives('D:'), ['D:'], 'one drive: ConvertTo-Json prints a bare string');
  assert.equal(parseWindowsTrashDrives([]), null, 'no drive named is no list');
  assert.equal(parseWindowsTrashDrives({ Name: 'C:' }), null, 'control: nor is anything else');
  // A mapped drive whose server is gone must not stall the Dashboard: the type is asked first, and only a local drive is asked whether it is ready.
  assert.match(WINDOWS_TRASH_DRIVES_SCRIPT, /GetDrives\(\)/);
  assert.match(WINDOWS_TRASH_DRIVES_SCRIPT, /\(\$_\.DriveType -eq 'Fixed' -or \$_\.DriveType -eq 'Removable'\) -and \$_\.IsReady/, 'local drives only, and only they are asked IsReady');
});

test('on Linux the Trash includes each local drive\'s own Trash folders, never a kernel table or a network share, and an unreadable mount table is said (C67)', () => {
  const mounts = [
    { mountPoint: '/', filesystem: 'ext4', options: [] }, { mountPoint: '/media/u/USB', filesystem: 'vfat', options: [] },
    { mountPoint: '/proc', filesystem: 'proc', options: [] }, { mountPoint: '/mnt/nas', filesystem: 'nfs4', options: [] },
    { mountPoint: '/mnt/dav', filesystem: 'davfs', options: [] }, { mountPoint: '/mnt/cloud', filesystem: 'fuse.rclone', options: [] },
  ];
  const got = linuxTrashLocations('/home/u/.local/share', 1000, mounts);
  assert.equal(got.home, '/home/u/.local/share/Trash/files');
  assert.deepEqual(got.drives, ['/', '/media/u/USB'], 'local disks only: a network share or a FUSE filesystem a dead server holds is never looked in (review F1.2)');
  assert.equal(got.note, null, 'a table read is a whole list');
  const unread = linuxTrashLocations('/home/u/.local/share', 1000, null);
  assert.deepEqual(unread.drives, [], 'no table, no drive to name');
  assert.equal(unread.home, '/home/u/.local/share/Trash/files', 'the home Trash still counts');
  assert.match(unread.note ?? '', /another drive/, 'and what is not counted is said');
  assert.deepEqual(linuxTrashLocations('/d', null, mounts).drives, [], 'no uid, no per-drive folder to name');
});

/* ═════════ Review F1.2/F1.9/F1.12 — a drive's Trash is read and emptied only where it is really this user's ═════════ */

const POSIX_ONLY = process.platform === 'win32' ? 'a drive Trash folder is freedesktop (Linux) behaviour: links and the sticky bit are posix' : false;

test('the Linux Trash never reads or empties through a link on a drive: a linked .Trash-<uid>, files or info folder, a .Trash without the sticky bit, another user\'s folder and a network drive are not this user\'s Trash (review F1.2/F1.9/F1.12)', { skip: POSIX_ONLY }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-drivetrash-'));
  try {
    const uid = process.getuid!();
    const mk = (p: string, files: Record<string, string> = {}): string => {
      fs.mkdirSync(p, { recursive: true });
      for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(p, n), c);
      return p;
    };
    const victim = (n: string): string => mk(path.join(root, `victim-${n}`), { 'precious.txt': 'p' });
    const dataHome = path.join(root, 'xdg');
    const home = mk(path.join(dataHome, 'Trash', 'files'), { 'old.txt': 'o' });
    const homeInfo = mk(path.join(dataHome, 'Trash', 'info'), { 'old.txt.trashinfo': 'i' });
    const drive = (n: string): string => mk(path.join(root, 'media', n));
    const A = drive('A'); mk(path.join(A, `.Trash-${uid}`)); fs.symlinkSync(victim('a'), path.join(A, `.Trash-${uid}`, 'files'));
    const B = drive('B'); const vb = victim('b'); mk(path.join(vb, 'files'), { 'keep.txt': 'k' }); fs.symlinkSync(vb, path.join(B, `.Trash-${uid}`));
    const C = drive('C'); const cFiles = mk(path.join(C, '.Trash', String(uid), 'files'), { 'x.txt': 'x' }); fs.chmodSync(path.join(C, '.Trash'), 0o777);
    const D = drive('D');
    const dShared = mk(path.join(D, '.Trash', String(uid), 'files'), { 'y.txt': 'y' }); fs.chmodSync(path.join(D, '.Trash'), 0o1777);
    const dOwn = mk(path.join(D, `.Trash-${uid}`, 'files'), { 'z.txt': 'z' });
    const dInfo = mk(path.join(D, `.Trash-${uid}`, 'info'), { 'z.txt.trashinfo': 'i' });
    const F = drive('F'); const fFiles = mk(path.join(F, `.Trash-${uid}`, 'files'), { 'f.txt': 'f' }); fs.symlinkSync(victim('f'), path.join(F, `.Trash-${uid}`, 'info'));
    const N = drive('N'); const nFiles = mk(path.join(N, `.Trash-${uid}`, 'files'), { 'n.txt': 'n' });
    const mounts = [...[A, B, C, D, F].map((m) => ({ mountPoint: m, filesystem: 'ext4', options: [] })), { mountPoint: N, filesystem: 'fuse.rclone', options: [] }];
    const locate = () => resolveTrashLocations({ platform: 'linux', dataHome, uid, mounts, fs: liveDriveTrashFs });

    const locs = await locate();
    assert.deepEqual(locs.dirs, [home, dShared, dOwn, fFiles], 'the home Trash and the drive folders that are really this user\'s, nothing through a link');
    assert.deepEqual(locs.problems, [], 'control: nothing failed to answer');
    const info = await getTrashInfo({ locations: locs, platform: 'linux' });
    assert.deepEqual(info.items.map((i) => i.name).sort(), ['f.txt', 'old.txt', 'y.txt', 'z.txt'], 'no file a link leads to is listed as a Trash item');
    assert.equal(info.complete, true, 'control: every place it empties was read');

    const failed: EmptyTrashResult['failed'] = [];
    await clearFreedesktopTrash(failed, locate);
    assert.deepEqual(failed, [], 'control: the emptier ran clean');
    for (const cleared of [home, homeInfo, dShared, dOwn, dInfo, fFiles]) assert.deepEqual(fs.readdirSync(cleared), [], `${path.relative(root, cleared)} emptied, as gio empties it`);
    assert.deepEqual(fs.readdirSync(path.join(root, 'victim-a')), ['precious.txt'], 'a linked files folder is never followed');
    assert.deepEqual(fs.readdirSync(path.join(vb, 'files')), ['keep.txt'], 'nor a linked .Trash-<uid>');
    assert.deepEqual(fs.readdirSync(path.join(root, 'victim-f')), ['precious.txt'], 'nor a linked info folder');
    assert.deepEqual(fs.readdirSync(cFiles), ['x.txt'], 'a .Trash without the sticky bit is not a Trash (the freedesktop spec)');
    assert.deepEqual(fs.readdirSync(nFiles), ['n.txt'], 'a network drive is never looked in');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('on Linux without gio, the freedesktop fallback that empties the Trash clean is an emptied Trash, with no failure left over from gio (HC-L3)', { skip: POSIX_ONLY }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-hcl3-'));
  try {
    const files = path.join(root, 'Trash', 'files');
    fs.mkdirSync(files, { recursive: true });
    fs.mkdirSync(path.join(root, 'Trash', 'info'));
    fs.writeFileSync(path.join(files, 'old.bin'), Buffer.alloc(3000));
    fs.writeFileSync(path.join(root, 'Trash', 'info', 'old.bin.trashinfo'), 'i');
    const locate = async () => ({ dirs: [files], problems: [], note: null } as unknown as Awaited<ReturnType<typeof resolveTrashLocations>>);
    const noGio = async (cmd: string): Promise<void> => { throw new Error(`spawn ${cmd} ENOENT`); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const clean = await runTrashEmptiers(emptyTrashCommands('linux'), noGio, (failed) => clearFreedesktopTrash(failed, locate));
      assert.deepEqual(clean, { ran: true, failed: [] }, 'the fallback emptied it: gio\'s absence is no failure');
      assert.deepEqual(fs.readdirSync(files), [], 'and the Trash is empty');
      // A fallback that fails is no emptied Trash, and its own failure is what is said: gio's absence is no
      // reason the Trash stayed full once the fallback ran, and the toast prints the first (review HC2-L2, HC2-L6).
      const failing = await runTrashEmptiers(emptyTrashCommands('linux'), noGio, async (failed) => { failed.push({ location: files, reason: 'Permission denied' }); });
      assert.deepEqual(failing, { ran: false, failed: [{ location: files, reason: 'Permission denied' }] });
      // Control: gio that runs is the emptier, and no fallback runs.
      let fallbacks = 0;
      const gio = await runTrashEmptiers(emptyTrashCommands('linux'), async () => {}, async () => { fallbacks++; });
      assert.deepEqual({ ...gio, fallbacks }, { ran: true, failed: [], fallbacks: 0 });
    } finally {
      console.warn = warn;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

const RUNS_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test('on Linux without gio, a freedesktop fallback that could not read a Trash folder, or was told a drive\'s Trash did not answer, is no emptied Trash (review F1.4)', { skip: POSIX_ONLY || (RUNS_AS_ROOT && 'root reads a folder whose mode is 000') }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-f14-'));
  const files = path.join(root, 'Trash', 'files');
  type Locations = Awaited<ReturnType<typeof resolveTrashLocations>>;
  const at = (dirs: string[], problems: string[]) => async () => ({ dirs, problems, note: null } as unknown as Locations);
  const noGio = async (cmd: string): Promise<void> => { throw new Error(`spawn ${cmd} ENOENT`); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    fs.mkdirSync(files, { recursive: true });
    fs.mkdirSync(path.join(root, 'Trash', 'info'));
    fs.writeFileSync(path.join(files, 'old.bin'), Buffer.alloc(3000));
    // A Trash folder this user may not read: nothing in it was seen, let alone removed.
    fs.chmodSync(files, 0o000);
    let locked;
    try {
      locked = await runTrashEmptiers(emptyTrashCommands('linux'), noGio, (failed) => clearFreedesktopTrash(failed, at([files], [])));
    } finally {
      fs.chmodSync(files, 0o755);
    }
    assert.equal(locked.ran, false, `a Trash folder that could not be read was not emptied: ${JSON.stringify(locked)}`);
    assert.deepEqual(locked.failed.map((f) => f.location), [files], 'the unread folder is said, first — not gio\'s absence (review HC2-L2)');
    assert.ok(locked.failed.every((f) => typeof f.reason === 'string' && f.reason.length > 0), 'each with its reason');
    assert.ok(fs.existsSync(path.join(files, 'old.bin')), 'and the file is still there');

    // A drive's Trash folder that did not answer as the locations were listed: it may hold a Trash, which nothing emptied.
    const unanswered = await runTrashEmptiers(emptyTrashCommands('linux'), noGio, (failed) => clearFreedesktopTrash(failed, at([], ['EIO'])));
    assert.equal(unanswered.ran, false, `a drive's Trash that did not answer was not emptied: ${JSON.stringify(unanswered)}`);
    assert.equal(unanswered.failed.length, 1, 'the drive that did not answer is said, and gio\'s absence is not (review HC2-L2)');
    assert.equal(unanswered.failed[0].reason, describeFsError({ code: 'EIO' }), 'the drive\'s failure is said in words, first, where the toast reads it');

    // Control: a Trash folder that is not there is nothing to clear, not a failure.
    const absent = await runTrashEmptiers(emptyTrashCommands('linux'), noGio, (failed) => clearFreedesktopTrash(failed, at([path.join(root, 'nowhere', 'files')], [])));
    assert.deepEqual(absent, { ran: true, failed: [] }, 'an absent Trash folder is an empty one');
  } finally {
    console.warn = warn;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a drive Trash folder another account owns is not this user\'s, and the drive is not reported unreadable (review F1.12)', async () => {
  const dir = (uid: number) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700, uid });
  const fakeFs = {
    lstat: async (p: string) => {
      if (p === '/media/u/X/.Trash-1000') return dir(0);
      if (p === '/media/u/X/.Trash-1000/files') return dir(0);
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
  };
  const got = await resolveTrashLocations({ platform: 'linux', dataHome: '/home/u/.local/share', uid: 1000, mounts: [{ mountPoint: '/media/u/X', filesystem: 'ext4', options: [] }], fs: fakeFs });
  assert.deepEqual(got.dirs, ['/home/u/.local/share/Trash/files'], 'a .Trash-1000 that root owns is not this user\'s Trash');
  assert.deepEqual(got.problems, []);
});

/* ═════════ Review F1.10 — a drive this user may not enter holds no Trash of theirs ═════════ */

test('a drive whose root this user may not enter, such as /boot/efi, holds no Trash of theirs and leaves the listing whole; a drive that fails to answer is said (review F1.10)', async () => {
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const fakeFs = {
    lstat: async (p: string) => {
      if (p.startsWith('/boot/efi/')) throw fail('EACCES');
      if (p.startsWith('/media/u/Bad/')) throw fail('EIO');
      throw fail('ENOENT');
    },
  };
  const inputs = (mountPoint: string, filesystem: string) => ({ platform: 'linux' as const, dataHome: '/home/u/.local/share', uid: 1000, mounts: [{ mountPoint, filesystem, options: [] }], fs: fakeFs });
  const efi = await resolveTrashLocations(inputs('/boot/efi', 'vfat'));
  assert.deepEqual(efi.dirs, ['/home/u/.local/share/Trash/files'], 'control: only the home Trash');
  assert.deepEqual(efi.problems, [], 'a folder this user may not enter is not their Trash, and not a failure');
  const bad = await resolveTrashLocations(inputs('/media/u/Bad', 'ext4'));
  assert.ok(bad.problems.length > 0 && bad.problems.every((c) => c === 'EIO'), `a drive that fails to answer may hold this user's Trash, so it is said (${JSON.stringify(bad.problems)})`);

  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-f110-'));
  try {
    const whole = await getTrashInfo({ locations: { dirs: [empty], note: null, problems: [] }, platform: 'linux' });
    assert.equal(whole.complete, true, 'control: an empty Trash read whole is complete');
    const short = await getTrashInfo({ locations: { dirs: [empty], note: null, problems: ['EIO'] }, platform: 'linux' });
    assert.equal(short.complete, false, 'a drive that did not answer leaves the listing a floor');
    assert.equal(short.incompleteReason, 'Part of the Trash could not be read (EIO).');
  } finally {
    await fsp.rm(empty, { recursive: true, force: true });
  }
});

/* ═════════ Review F1.14 — what the floor does to the listing, and Windows' account folders, are under test ═════════ */

test('a listing that does not read every place the emptier clears is a floor and says why; on Windows each account folder is listed by the files in it (review F1.14)', async () => {
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-f114-'));
  try {
    const sid = path.join(bin, 'S-1-5-21-1-2-3-1001');
    await fsp.mkdir(sid);
    await fsp.writeFile(path.join(sid, '$RAB12CD.docx'), Buffer.alloc(4000, 1));
    await fsp.writeFile(path.join(sid, '$IAB12CD.docx'), infoV2('C:\\Users\\u\\report.docx'));
    const read = await getTrashInfo({ locations: { dirs: [bin], note: null, problems: [] }, platform: 'win32' });
    assert.deepEqual(read.items.map((i) => [i.name, i.size]), [['report.docx', 4000]], 'the deleted file is the item, by its own name; the account folder is not');
    assert.equal(read.complete, true, 'control: no note, nothing unread');
    assert.equal(read.incompleteReason, undefined);
    const floor = await getTrashInfo({ locations: { dirs: [bin], note: 'TreeMap counts the Recycle Bin on drive C: only.', problems: [] }, platform: 'win32' });
    assert.equal(floor.complete, false, 'a note says the listing is a floor, so it is not complete');
    assert.equal(floor.incompleteReason, 'TreeMap counts the Recycle Bin on drive C: only.', 'and the note is the reason');
    assert.equal(floor.totalBytes, read.totalBytes, 'control: the same bytes were counted');
  } finally {
    await fsp.rm(bin, { recursive: true, force: true });
  }
});

/* ═════════ C92 — provenance says when a last-opened date is unknown, and why ═════════ */


test('provenance names why a last-opened date is unknown: a file it cannot read gives a reason, never a bare null (C92)', async () => {
  const gone = await readProvenance(path.join(os.tmpdir(), `tm-hc-no-such-${process.pid}.bin`));
  assert.equal(gone.lastOpenedAt, null, 'control: no date');
  assert.match(gone.lastOpenedUnknown ?? '', /could not read/, 'and why');
});

test('provenance asks about the file itself: an access time not recorded, or a drive that records no openings, is unknown with why, never "not opened since it was saved" (review F1.5/F1.16)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-hc-lastopened-'));
  try {
    const f = path.join(dir, 'report.pdf');
    await fsp.writeFile(f, 'x');
    const t = new Date('2026-01-02T03:04:05Z');
    const answer = (info: { lastUsedMs: number | null; source: 'spotlight' | 'atime' | 'none'; caveat?: string }) =>
      async (paths: string[]) => new Map(paths.map((p) => [p, { useCount: null, ...info }]));
    const recorded = answer({ lastUsedMs: t.getTime(), source: 'atime' });

    await fsp.utimes(f, 0, t);
    const zero = await readProvenance(f, recorded);
    assert.equal(zero.lastOpenedAt, null, 'control: no date');
    assert.equal(zero.lastOpenedUnknown, 'This file\u2019s access time is not recorded.', 'an access time of 0 is not recorded, whatever the rest of the computer does (F1.5)');

    await fsp.utimes(f, t, t);
    const noatime = 'This drive is mounted noatime, so it does not record when files are opened.';
    const frozen = await readProvenance(f, answer({ lastUsedMs: null, source: 'none', caveat: noatime }));
    assert.equal(frozen.lastOpenedAt, null, 'control: no date');
    assert.equal(frozen.lastOpenedUnknown, noatime, 'a file on a drive that records no openings is unknown, in the drive\'s own words (F1.16)');

    const fine = await readProvenance(f, recorded);
    assert.equal(fine.lastOpenedUnknown, undefined, 'control: where this file\'s openings are recorded, a null date is "not opened since it was saved"');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ═════════ Review F1.21 — a saved view runs from Clean Up with its own terms, files only ═════════ */

test('a saved view sent from Clean Up parses as the view and files only - an open quote included (review F1.21)', async () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const head = 'async function findBySavedView(scanId) {';
  const at = page.indexOf(head);
  assert.notEqual(at, -1, 'control: the page has it');
  let depth = 0;
  let end = -1;
  for (let i = at + head.length - 1; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const src = page.slice(at, end);
  for (const view of ['name:"my report', 'path:"a b', 'name:foo"', 'size>100mb or ext:iso', 'name:"q" ext:pdf']) {
    let sent = '';
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const find = new Function('selectedSavedView', 'toast', 'api', `${src}\nreturn findBySavedView;`)(
      () => ({ q: view }), () => {},
      async (_url: string, opts: { body: string }) => { sent = JSON.parse(opts.body).q; return { hits: [], total: 0, truncated: false }; },
    ) as (scanId: string) => Promise<unknown>;
    await find('s1');
    const alone = parse(view);
    const asSent = parse(sent);
    assert.ok(alone.ok, `control: the view parses alone: ${view}`);
    assert.ok(asSent.ok, `as sent it parses too: ${sent} (${asSent.ok ? '' : asSent.error})`);
    assert.ok(asSent.ast.kind === 'and', `control: the view and files only: ${sent}`);
    assert.deepEqual(asSent.ast.left, alone.ast, `the view's own terms, unchanged: ${view}`);
    const files = parse('type:file');
    assert.ok(files.ok);
    assert.deepEqual(asSent.ast.right, files.ast, 'and files only');
  }
});
