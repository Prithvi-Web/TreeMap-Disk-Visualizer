import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleChanged-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleIndex, getCapsuleJob, setMemberLookFaultForTests } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, undoCartRun } from '../src/services/cartCommit';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3f #4 (MEDIUM). Nothing looked at an item again between its capture and its trash step, so a
 * file added, rewritten or replaced in a captured folder meanwhile was trashed with the folder and
 * had no copy: an undo put back the folder as it was copied, without it. Now, right before each
 * item's own trash step, its metadata is walked again and compared with its copy's manifest; an
 * item that differs is left in place (skipped, code CAPSULE_CHANGED, saying what changed) and its
 * copy discarded.
 *
 * "Meanwhile" is made deterministic here: the trash step of an earlier item of the same batch
 * changes the later one before its turn. Nothing reaches the machine's Trash: the trash step moves
 * each file into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleChanged-trash-');
let trashCalls = 0;
/** Run inside the trash step, before it moves `p`. */
let duringTrash: ((p: string) => void) | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    duringTrash?.(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

beforeEach(() => {
  duringTrash = null;
});

/** A folder `proj` holding two files, and a file `first.txt` beside it that is trashed before it. */
function batch(label: string): { first: string; proj: string } {
  const dir = fileTempDir(`treemap-capsuleChanged-${label}-`);
  const first = path.join(dir, 'aa', 'first.txt'); // deeper, so trashed first
  fs.mkdirSync(path.dirname(first));
  fs.writeFileSync(first, 'the first item');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), 'read me');
  fs.writeFileSync(path.join(proj, 'src', 'main.c'), 'int main(void) { return 0; }\n');
  return { first, proj };
}

async function commitChanging(first: string, item: string, change: () => void): Promise<Awaited<ReturnType<typeof commitCart>>> {
  duringTrash = (p) => {
    if (p === first) change();
  };
  return withOpenFileCheck('clear', () => commitCart([first, item]));
}

async function assertLeftInPlace(result: Awaited<ReturnType<typeof commitCart>>, item: string, what: RegExp): Promise<void> {
  assert.ok(!result.trashed.includes(item), `${path.basename(item)} was not trashed (${JSON.stringify(result.trashed)})`);
  assert.ok(fs.existsSync(item), 'it is still where it was');
  const row = result.skipped.find((s) => s.path === item);
  assert.equal(row?.code, 'CAPSULE_CHANGED', JSON.stringify(result.skipped));
  assert.match(row?.reason ?? '', /changed after it was copied/, row?.reason);
  assert.match(row?.reason ?? '', what, row?.reason);
  assert.match(row?.reason ?? '', /its copy was discarded/, row?.reason);
  const entries = (await getCapsuleIndex()).entries.filter((e) => e.runId === result.runId);
  assert.equal(entries.some((e) => e.originalPath === item), false, 'its copy is not kept for an undo');
}

test('a file added to a captured folder before its trash step leaves the folder in place, with the file', async () => {
  const { first, proj } = batch('added');
  const added = path.join(proj, 'src', 'new.c');
  const result = await commitChanging(first, proj, () => fs.writeFileSync(added, 'written after the copy'));
  await assertLeftInPlace(result, proj, /src[\\/]new\.c/);
  assert.equal(fs.readFileSync(added, 'utf8'), 'written after the copy', 'and the new file is there, untouched');
  assert.deepEqual(result.trashed, [first], 'the item that did not change went');
});

test('a file rewritten in a captured folder, same size, before its trash step leaves the folder in place', async () => {
  const { first, proj } = batch('rewritten');
  const main = path.join(proj, 'src', 'main.c');
  const result = await commitChanging(first, proj, () => {
    fs.writeFileSync(main, 'int main(void) { return 1; }\n');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(main, later, later);
  });
  await assertLeftInPlace(result, proj, /src[\\/]main\.c/);
  assert.equal(fs.readFileSync(main, 'utf8'), 'int main(void) { return 1; }\n');
});

test('a file removed from a captured folder before its trash step leaves the folder in place', async () => {
  const { first, proj } = batch('removed');
  const result = await commitChanging(first, proj, () => fs.rmSync(path.join(proj, 'README.md')));
  await assertLeftInPlace(result, proj, /README\.md/);
});

test('a captured file replaced by another before its trash step is left in place', async () => {
  const { first } = batch('replaced');
  const dir = fileTempDir('treemap-capsuleChanged-replaced-file-');
  const notes = path.join(dir, 'notes.txt');
  fs.writeFileSync(notes, 'the notes as copied');
  const result = await commitChanging(first, notes, () => {
    fs.rmSync(notes);
    fs.writeFileSync(notes, 'the notes as saved again, longer');
  });
  await assertLeftInPlace(result, notes, /notes\.txt/);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'the notes as saved again, longer');
});

test('an item that did not change is trashed, and its undo puts it back whole', async () => {
  const { first, proj } = batch('unchanged');
  const result = await commitChanging(first, proj, () => undefined);
  assert.deepEqual([...result.trashed].sort(), [first, proj].sort());
  const job = await undoCartRun(result.runId);
  await waitFor(() => getCapsuleJob(job.jobId)?.status !== 'running', 'the undo');
  assert.equal(getCapsuleJob(job.jobId)?.status, 'complete', getCapsuleJob(job.jobId)?.error);
  assert.equal(fs.readFileSync(path.join(proj, 'src', 'main.c'), 'utf8'), 'int main(void) { return 0; }\n');
});

test('a file whose size changed while its modification time was set back is still seen as changed', async () => {
  const { first, proj } = batch('size');
  const main = path.join(proj, 'src', 'main.c');
  // Whole seconds, so setting them back after the rewrite gives exactly the time the copy recorded.
  const WHEN = 1_700_000_000;
  fs.utimesSync(main, WHEN, WHEN);
  const result = await commitChanging(first, proj, () => {
    fs.writeFileSync(main, 'int main(void) { return 0; } /* and a comment */\n');
    fs.utimesSync(main, WHEN, WHEN); // as `touch -r` or an rsync -t would
    assert.equal(fs.statSync(main).mtimeMs, WHEN * 1000, 'the time is exactly as it was copied');
  });
  await assertLeftInPlace(result, proj, /src[\\/]main\.c was modified/);
});

test('a folder member that turned from a file into a folder is seen as changed', async () => {
  const { first, proj } = batch('kind');
  const readme = path.join(proj, 'README.md');
  const result = await commitChanging(first, proj, () => {
    fs.rmSync(readme);
    fs.mkdirSync(readme);
  });
  await assertLeftInPlace(result, proj, /README\.md is no longer a file/);
});

test('a link in a captured folder that now points somewhere else is seen as changed', { skip: process.platform === 'win32' ? 'links need a privilege on Windows' : false }, async () => {
  const { first, proj } = batch('link');
  const link = path.join(proj, 'current');
  fs.symlinkSync('src', link);
  const result = await commitChanging(first, proj, () => {
    fs.rmSync(link);
    fs.symlinkSync('README.md', link);
  });
  await assertLeftInPlace(result, proj, /current points somewhere else/);
});

test('an item that cannot be looked at again before its trash step is left in place, and says so', async () => {
  const { first, proj } = batch('unreadable');
  const readme = path.join(proj, 'README.md');
  let restore: (() => void) | null = null;
  try {
    const result = await commitChanging(first, proj, () => {
      restore = setMemberLookFaultForTests((abs) => (abs === readme ? Object.assign(new Error('i/o error (a test)'), { code: 'EIO' }) : null));
    });
    assert.ok(!result.trashed.includes(proj), JSON.stringify(result.trashed));
    assert.ok(fs.existsSync(proj));
    const row = result.skipped.find((s) => s.path === proj);
    assert.equal(row?.code, 'CAPSULE_UNREADABLE', JSON.stringify(result.skipped));
    assert.match(row?.reason ?? '', /could not be looked at again right before its deletion/, row?.reason);
  } finally {
    (restore as (() => void) | null)?.();
  }
});

test('an item gone by its own turn goes on to its trash step, which judges it as before: gone, its copy kept for an undo', async () => {
  const { first, proj } = batch('gone');
  const elsewhere = fileTempDir('treemap-capsuleChanged-moved-away-');
  const result = await commitChanging(first, proj, () => fs.renameSync(proj, path.join(elsewhere, 'proj')));
  assert.ok(result.trashed.includes(proj), `judged by the disk, it left its place (${JSON.stringify(result)})`);
  const entry = (await getCapsuleIndex()).entries.find((e) => e.runId === result.runId && e.originalPath === proj);
  assert.equal(entry?.hasPayload, true, 'and its copy is kept, as it always was');
});
