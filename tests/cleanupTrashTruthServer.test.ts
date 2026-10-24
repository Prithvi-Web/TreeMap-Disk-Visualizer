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
