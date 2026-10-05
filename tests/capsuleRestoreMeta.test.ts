import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleRestoreMeta-data-');

import { getCapsuleJob, protectItems, setRestoreMetaFaultForTests, startCapsuleRestore } from '../src/services/timeCapsule';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { waitFor } from './fixtures/waitFor';

/**
 * FG3f #10 (LOW). A restore put back each file's bytes and its modification and access times, but
 * not its permissions: an executable script came back not executable, a read-only file writable, a
 * private folder open — and the cart said it put things back "with their original dates", which a
 * person reads as every date, creation included, which nothing sets back. And a date that could not
 * be set back was swallowed, so a restore said it was whole when it was not.
 *
 * Now the permission bits of every file and folder are recorded and put back (a folder's last, with
 * its dates, so a read-only folder never stops its own contents), the cart says what is restored,
 * and a date or permission that could not be set back finishes the restore with a warning naming it.
 */

const SKIP_MODES = process.platform === 'win32' ? 'Windows keeps no POSIX permission bits' : false;
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

async function settled(jobId: string): Promise<{ status?: string; error?: string }> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', 'the restore settling');
  return getCapsuleJob(jobId) ?? {};
}

/** A folder with an executable, a read-only file and a private subfolder, captured and removed. */
async function captured(label: string): Promise<{ root: string; run: string; ro: string; priv: string; id: string }> {
  const dir = fileTempDir(`treemap-capsuleRestoreMeta-${label}-`);
  const root = path.join(dir, 'tool');
  const run = path.join(root, 'run.sh');
  const ro = path.join(root, 'notes.txt');
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(run, '#!/bin/sh\necho hi\n');
  fs.writeFileSync(ro, 'read only');
  fs.writeFileSync(path.join(priv, 'key.txt'), 'secret');
  fs.chmodSync(run, 0o750);
  fs.chmodSync(ro, 0o444);
  fs.chmodSync(priv, 0o500); // its own contents must still come back into it
  fs.chmodSync(root, 0o710);
  const { outcomes } = await protectItems([{ path: root }]);
  assert.equal(outcomes[0].protected, true, outcomes[0].detail);
  fs.chmodSync(priv, 0o700);
  fs.rmSync(root, { recursive: true });
  return { root, run, ro, priv, id: outcomes[0].entryId as string };
}

test('a restore puts back each file’s and folder’s permissions, a read-only folder’s contents included', { skip: SKIP_MODES }, async () => {
  const { root, run, ro, priv, id } = await captured('modes');
  try {
    const job = await settled((await startCapsuleRestore([id])).jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.error, undefined, 'and nothing to warn about');
    assert.equal(modeOf(run).toString(8), '750', 'the script is executable again');
    assert.equal(modeOf(ro).toString(8), '444', 'the read-only file is read-only again');
    assert.equal(modeOf(priv).toString(8), '500', 'the private folder is private again');
    assert.equal(fs.readFileSync(path.join(priv, 'key.txt'), 'utf8'), 'secret', 'with its contents back inside it');
    assert.equal(modeOf(root).toString(8), '710', 'and so is the item’s own folder');
  } finally {
    if (fs.existsSync(priv)) fs.chmodSync(priv, 0o700);
  }
});

test('a date that cannot be set back finishes the restore with a warning naming it, never in silence', async () => {
  const { root, priv, id } = await captured('times-fault');
  const notes = path.join(root, 'notes.txt');
  const unfault = setRestoreMetaFaultForTests((dest, what) => (dest === notes && what === 'times'
    ? Object.assign(new Error('operation not permitted (a test)'), { code: 'EPERM' }) : null));
  let job: { status?: string; error?: string };
  let jobId = '';
  try {
    jobId = (await startCapsuleRestore([id])).jobId;
    job = await settled(jobId);
  } finally {
    unfault();
    if (fs.existsSync(priv)) fs.chmodSync(priv, 0o700);
  }
  assert.equal(job.status, 'complete', 'the bytes are home, verified: the restore is not undone for a date');
  assert.ok((job.error ?? '').includes(notes), `the warning names it (${job.error})`);
  assert.match(job.error ?? '', /could not be set back/, job.error);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'read only');

  // And the progress stream's last event carries it, so the page shows it beside "restored".
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as { port: number };
    const last = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/api/timecapsule/jobs/${jobId}/progress` }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          const line = buf.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            req.destroy();
            resolve(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        });
      });
      req.on('error', reject);
    });
    assert.equal(last.type, 'complete');
    assert.equal(last.warning, job.error, 'the stream carries the warning');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

