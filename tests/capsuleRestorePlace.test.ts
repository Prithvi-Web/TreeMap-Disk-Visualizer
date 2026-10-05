import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleRestorePlace-data-');

import { getCapsuleJob, protectItems, startCapsuleRestore } from '../src/services/timeCapsule';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { AppError } from '../src/middleware/errorHandler';
import { waitFor } from './fixtures/waitFor';

/**
 * FG3f #5 (LOW). A Time Capsule restore checks once, when it starts, that the item's place is empty
 * — and then made the item's folder and its subfolders with `mkdir -p`, which goes on without a word
 * into a folder that appeared there since (or through a link to one), writes the item into it, and
 * recorded every such folder as its own, so a failure later removed one that was not. The start
 * check itself read a look that failed for any reason (EACCES, EIO) as "nothing there".
 *
 * Now only "nothing there" is free; the restore makes each folder of the item itself, without
 * recursion, recording only what it made, and stops at anything that appeared; and right before it
 * writes a member, the folder it writes into must still be a plain folder, not a link. "Since it
 * started" is made deterministic with the copy seam: the copy of an earlier file changes the disk.
 */

const SKIP_LINKS = process.platform === 'win32' ? 'links need a privilege on Windows' : false;
const SKIP_MODES = process.platform === 'win32' ? 'a folder’s mode does not stop a look on Windows'
  : process.getuid?.() === 0 ? 'running as root, a folder’s mode stops nothing' : false;

async function settled(jobId: string): Promise<{ status?: string; error?: string }> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', 'the restore settling');
  return getCapsuleJob(jobId) ?? {};
}

/** A file `a.txt` and a folder `proj` (holding `top.txt` and `sub/deep.txt`), captured, then removed. */
async function captured(label: string): Promise<{ dir: string; file: string; folder: string; ids: string[] }> {
  const dir = fileTempDir(`treemap-capsuleRestorePlace-${label}-`);
  const file = path.join(dir, 'a.txt');
  const folder = path.join(dir, 'proj');
  fs.writeFileSync(file, 'the file');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'top.txt'), 'top');
  fs.writeFileSync(path.join(folder, 'sub', 'deep.txt'), 'deep');
  const { outcomes } = await protectItems([{ path: file }, { path: folder }]);
  assert.ok(outcomes.every((o) => o.protected), JSON.stringify(outcomes));
  fs.rmSync(file);
  fs.rmSync(folder, { recursive: true });
  return { dir, file, folder, ids: outcomes.map((o) => o.entryId as string) };
}

/** Runs `change` once, during the restore's copy of `when`. */
function during(when: string, change: () => void): () => void {
  let done = false;
  return setCopyFaultForTests((dest) => {
    if (!done && dest === when) {
      done = true;
      change();
    }
    return null;
  });
}

test('a folder that appeared at the item’s place since the restore began is not written into, and not removed', async () => {
  const { file, folder, ids } = await captured('appeared');
  const unhook = during(file, () => fs.mkdirSync(folder)); // someone made a folder there meanwhile
  let job: { status?: string; error?: string };
  try {
    job = await settled((await startCapsuleRestore(ids)).jobId);
  } finally {
    unhook();
  }
  assert.equal(job.status, 'error', `not merged into it (${job.status})`);
  assert.match(job.error ?? '', /appeared/, job.error);
  assert.ok(job.error?.includes(folder), job.error);
  assert.ok(fs.existsSync(folder), 'the folder that appeared is still there');
  assert.deepEqual(fs.readdirSync(folder), [], 'and nothing was written into it');
});

test('a link to a folder that appeared at the item’s place is not written through', { skip: SKIP_LINKS }, async () => {
  const { file, folder, ids } = await captured('appeared-link');
  const elsewhere = fileTempDir('treemap-capsuleRestorePlace-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'theirs.txt'), 'not the restore’s');
  const unhook = during(file, () => fs.symlinkSync(elsewhere, folder));
  let job: { status?: string; error?: string };
  try {
    job = await settled((await startCapsuleRestore(ids)).jobId);
  } finally {
    unhook();
  }
  assert.equal(job.status, 'error', `not written through the link (${job.status})`);
  assert.deepEqual(fs.readdirSync(elsewhere), ['theirs.txt'], 'nothing landed where the link leads');
});

test('a folder of the item replaced by a link before a member is written into it stops the restore', { skip: SKIP_LINKS }, async () => {
  const { folder, ids } = await captured('swapped');
  const elsewhere = fileTempDir('treemap-capsuleRestorePlace-swapped-elsewhere-');
  const sub = path.join(folder, 'sub');
  // While top.txt is copied, the sub folder this restore just made is swapped for a link.
  const unhook = during(path.join(folder, 'top.txt'), () => {
    fs.rmdirSync(sub);
    fs.symlinkSync(elsewhere, sub);
  });
  let job: { status?: string; error?: string };
  try {
    job = await settled((await startCapsuleRestore([ids[1]])).jobId);
  } finally {
    unhook();
  }
  assert.equal(job.status, 'error', `not written through the link (${job.status})`);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'deep.txt did not land where the link leads');
  assert.match(job.error ?? '', /no longer a plain folder/, job.error);
});

test('a place that cannot be looked at is not taken for an empty one', { skip: SKIP_MODES }, async () => {
  const { dir, file, ids } = await captured('unlookable');
  fs.chmodSync(dir, 0o600); // its folder can be listed, not searched: a look at the place fails EACCES
  try {
    await assert.rejects(startCapsuleRestore([ids[0]]), (err: unknown) => {
      assert.ok(err instanceof AppError, String(err));
      assert.equal(err.code, 'PATH_UNREADABLE');
      assert.ok(err.message.includes(file), err.message);
      return true;
    });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.ok(!fs.existsSync(file), 'nothing was restored');
});

test('an undisturbed restore still puts back the file and the folder whole', async () => {
  const { file, folder, ids } = await captured('whole');
  const job = await settled((await startCapsuleRestore(ids)).jobId);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(fs.readFileSync(file, 'utf8'), 'the file');
  assert.equal(fs.readFileSync(path.join(folder, 'sub', 'deep.txt'), 'utf8'), 'deep');
});
