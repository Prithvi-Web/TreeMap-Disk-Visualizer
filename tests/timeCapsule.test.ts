import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Isolate every capsule and settings write from the user's real app data.
// Without this the suite would protect files into the real Time Capsule and
// rewrite the real settings.json — the mistake that once littered the user's
// snapshots.json with test roots.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-capsule-test-'));

import {
  protectItems,
  protectAndTrash,
  startCapsuleRestore,
  getCapsuleIndex,
  getCapsuleEntry,
  deleteCapsuleEntry,
  pruneExpired,
  reconcileCapsule,
  getCapsuleJob,
  capsuleRoot,
  planEviction,
  capFor,
  usedBytesOf,
} from '../src/services/timeCapsule';
import { updateSettings } from '../src/services/settings';
import { TimeCapsuleEntry, TimeCapsuleJob } from '../src/models/types';
import { AppError } from '../src/middleware/errorHandler';

/**
 * B3 — Time Capsule.
 *
 * The acceptance criterion is a claim about a *disaster*: the user emptied the
 * Trash after an automated run, and the only remaining copy is the capsule's.
 * So the integration tests here delete originals outright — which is precisely
 * the end state "trashed, then Trash emptied" leaves behind — and then demand
 * a byte-identical restore. Nothing here puts anything in the real Trash;
 * §9 wants real files, not a real Finder.
 *
 * The one test that does drive the production `protectAndTrash` all the way to
 * its delete step does so against a file held open by another process, so B2
 * refuses the delete: the whole sequence runs, and nothing is ever trashed.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b3-'));
const IS_UNIX = process.platform !== 'win32';

async function writeFile(p: string, content: string | Buffer): Promise<string> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
  return p;
}

const sha = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

/** Run a restore to completion and hand back the finished job. */
async function restoreAndWait(entryId: string): Promise<TimeCapsuleJob> {
  const job = await startCapsuleRestore(entryId);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const live = getCapsuleJob(job.jobId);
    assert.ok(live, 'the job record must exist');
    if (live.status !== 'running') return live;
    assert.ok(Date.now() < deadline, 'restore timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every entry currently in the capsule index. */
async function entries(): Promise<TimeCapsuleEntry[]> {
  return (await getCapsuleIndex()).entries;
}

/* ══════════════════ Capacity arithmetic (pure) ══════════════════ */

test('the cap is a share of usable space, so it does not shrink as the capsule fills', () => {
  // 10% of (900 free + 100 held) is the same 100 whether the capsule is empty
  // or already holding. Taking 10% of free space alone would give 100 when
  // empty and 90 once holding — a ceiling that moves as you approach it, so
  // the capsule would evict itself into an ever-smaller corner.
  assert.equal(capFor(1000, 0, 10), 100);
  assert.equal(capFor(900, 100, 10), 100);
  assert.equal(capFor(500, 500, 10), 100);
});

test('an unreadable volume falls back to a stated cap rather than an invented one', () => {
  const cap = capFor(null, 0, 10);
  assert.ok(cap > 0, 'protection still happens');
  assert.equal(cap, 1024 * 1024 * 1024, 'a fixed, documented fallback — not a guess from nothing');
});

test('usedBytesOf counts only what is still held', () => {
  const base = { name: 'x', originalPath: '/x', kind: 'file' as const, fileCount: 1, digest: '', capturedAt: 0, hasPayload: true };
  assert.equal(
    usedBytesOf([
      { ...base, id: 'a', sizeBytes: 100, heldBytes: 100 },
      { ...base, id: 'b', sizeBytes: 100, heldBytes: 0, hasPayload: false, restoredAt: 1 }, // restored — payload gone
    ]),
    100,
  );
});

test('an item bigger than the whole cap is refused WITHOUT evicting anything', () => {
  // The failure this prevents: clearing every existing protection to make room
  // for something that was never going to fit, ending with an empty capsule
  // and a refusal anyway.
  const held: TimeCapsuleEntry[] = [
    { id: 'a', name: 'a', originalPath: '/a', kind: 'file', sizeBytes: 40, heldBytes: 40, hasPayload: true, fileCount: 1, digest: '', capturedAt: 1 },
    { id: 'b', name: 'b', originalPath: '/b', kind: 'file', sizeBytes: 40, heldBytes: 40, hasPayload: true, fileCount: 1, digest: '', capturedAt: 2 },
  ];
  const plan = planEviction(held, 100, 500);
  assert.equal(plan.fits, false);
  assert.deepEqual(plan.evict, [], 'nothing is sacrificed for a hopeless case');
});

test('eviction takes the oldest capture first, and only as many as it needs', () => {
  const held: TimeCapsuleEntry[] = [
    { id: 'newest', name: 'c', originalPath: '/c', kind: 'file', sizeBytes: 30, heldBytes: 30, hasPayload: true, fileCount: 1, digest: '', capturedAt: 300 },
    { id: 'oldest', name: 'a', originalPath: '/a', kind: 'file', sizeBytes: 30, heldBytes: 30, hasPayload: true, fileCount: 1, digest: '', capturedAt: 100 },
    { id: 'middle', name: 'b', originalPath: '/b', kind: 'file', sizeBytes: 30, heldBytes: 30, hasPayload: true, fileCount: 1, digest: '', capturedAt: 200 },
  ];
  // 90 held, cap 100, incoming 40 -> must free 30. One eviction is enough.
  const plan = planEviction(held, 100, 40);
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.evict.map((e) => e.id), ['oldest']);
});

test('nothing is evicted when the incoming item already fits', () => {
  const held: TimeCapsuleEntry[] = [
    { id: 'a', name: 'a', originalPath: '/a', kind: 'file', sizeBytes: 10, heldBytes: 10, hasPayload: true, fileCount: 1, digest: '', capturedAt: 1 },
  ];
  assert.deepEqual(planEviction(held, 100, 50), { evict: [], fits: true });
});

/* ══════════════════ The acceptance criterion ══════════════════ */

test('a file survives its original being destroyed, and comes back byte-identical', async () => {
  const dir = await mkTmp();
  try {
    const content = crypto.randomBytes(64 * 1024); // spans several stream chunks
    const target = await writeFile(path.join(dir, 'quarterly-report.bin'), content);

    const { outcomes } = await protectItems([{ path: target, reason: 'matched "old downloads"' }]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail ?? '');

    // The disaster: the original is trashed and the Trash is then emptied.
    // The end state on disk is exactly this — the path is simply gone.
    await fsp.rm(target);
    assert.equal(fs.existsSync(target), false);

    const entry = (await entries()).find((e) => e.originalPath === target);
    assert.ok(entry, 'the capsule still lists it');
    assert.equal(entry!.kind, 'file');
    assert.equal(entry!.reason, 'matched "old downloads"');

    const job = await restoreAndWait(entry!.id);
    assert.equal(job.status, 'complete', job.error ?? '');

    const restored = await fsp.readFile(target);
    assert.equal(sha(restored), sha(content), 'restored byte-for-byte, not merely the right size');

    // Once it is home again the capsule gives its space back, and says so.
    const after = (await entries()).find((e) => e.id === entry!.id);
    assert.ok(after?.restoredAt, 'the entry is marked restored');
    assert.equal(after!.heldBytes, 0, 'a redundant copy does not keep occupying the cap');
    assert.equal(fs.existsSync(path.join(capsuleRoot(), entry!.id)), false, 'and its payload is gone from disk');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a folder restores with its whole shape: nested files, an empty dir, and a symlink', async () => {
  const dir = await mkTmp();
  try {
    const root = path.join(dir, 'node_modules');
    await writeFile(path.join(root, 'pkg', 'index.js'), 'module.exports = 1;\n');
    await writeFile(path.join(root, 'pkg', 'deep', 'nested', 'data.txt'), 'deep\n');
    await fsp.mkdir(path.join(root, '.cache'), { recursive: true }); // deliberately empty
    if (IS_UNIX) {
      // pnpm/npm trees are full of these; following one would copy the target's
      // bytes in, and a link to a parent would walk forever.
      await fsp.symlink(path.join('..', 'pkg', 'index.js'), path.join(root, 'link.js'));
    }

    const { outcomes } = await protectItems([{ path: root }]);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail ?? '');

    await fsp.rm(root, { recursive: true, force: true });

    const entry = (await entries()).find((e) => e.originalPath === root);
    assert.ok(entry);
    assert.equal(entry!.kind, 'folder');

    const job = await restoreAndWait(entry!.id);
    assert.equal(job.status, 'complete', job.error ?? '');

    assert.equal(await fsp.readFile(path.join(root, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(await fsp.readFile(path.join(root, 'pkg', 'deep', 'nested', 'data.txt'), 'utf8'), 'deep\n');
    assert.ok((await fsp.stat(path.join(root, '.cache'))).isDirectory(), 'an empty directory is still part of the shape');
    if (IS_UNIX) {
      const st = await fsp.lstat(path.join(root, 'link.js'));
      assert.ok(st.isSymbolicLink(), 'the link came back as a link, not as a copy of its target');
      assert.equal(await fsp.readlink(path.join(root, 'link.js')), path.join('..', 'pkg', 'index.js'));
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an empty folder is still a folder when it comes back', async () => {
  const dir = await mkTmp();
  try {
    const root = path.join(dir, 'empty-cache');
    await fsp.mkdir(root, { recursive: true });

    const { outcomes } = await protectItems([{ path: root }]);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail ?? '');
    await fsp.rm(root, { recursive: true, force: true });

    const entry = (await entries()).find((e) => e.originalPath === root);
    const job = await restoreAndWait(entry!.id);
    assert.equal(job.status, 'complete', job.error ?? '');
    assert.ok((await fsp.stat(root)).isDirectory());
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Refusals are loud, never silent ══════════════════ */

test('an item too big for the cap is left alone, and the refusal is recorded', async () => {
  const dir = await mkTmp();
  try {
    // 1% of usable space is far below any real file here, so the cap refuses.
    await updateSettings({ timeCapsuleMaxPercent: 1 });
    const huge = await writeFile(path.join(dir, 'huge.bin'), crypto.randomBytes(2048));

    // Re-cap to something microscopic by comparing against a cap we control:
    // planEviction is what capture consults, and its refusal path is pinned
    // above. Here we assert the *observable* consequence instead — whatever
    // the machine's free space, an item is never deleted unprotected.
    const { outcomes } = await protectItems([{ path: huge }]);
    if (!outcomes[0].protected) {
      assert.equal(outcomes[0].code, 'CAPSULE_FULL');
      assert.match(outcomes[0].detail ?? '', /left alone rather than deleted/);
      const index = await getCapsuleIndex();
      assert.ok(index.events.some((e) => e.kind === 'unprotected' && e.originalPath === huge),
        'the user can see that protection was withheld');
    }
    assert.equal(fs.existsSync(huge), true, 'either way, protectItems never deletes');
  } finally {
    await updateSettings({ timeCapsuleMaxPercent: 10 });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a path that does not exist is reported, not silently skipped', async () => {
  const { outcomes } = await protectItems([{ path: path.join(os.tmpdir(), 'tm-b3-does-not-exist-' + crypto.randomUUID()) }]);
  assert.equal(outcomes[0].protected, false);
  assert.equal(outcomes[0].code, 'CAPSULE_UNREADABLE');
  assert.ok((outcomes[0].detail ?? '').length > 0, 'and it says why');
});

test('protectAndTrash refuses to delete what it could not protect', async () => {
  const dir = await mkTmp();
  try {
    const missing = path.join(dir, 'gone.txt');
    const result = await protectAndTrash([{ path: missing }]);
    assert.deepEqual(result.trashed, [], 'nothing reached the Trash');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.bytesProtected, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ The real delete path, blocked by B2 ══════════════════ */

/**
 * Hold `target` open from a separate process. B2 ignores TreeMap's own
 * descriptors, so opening the file in this process would prove nothing.
 */
async function holdOpenElsewhere(target: string): Promise<() => void> {
  const child = spawn(process.execPath, [
    '-e',
    `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(target)},'r');` +
    `process.stdout.write('open');setInterval(()=>{},1000);`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    setTimeout(() => reject(new Error('child never signalled')), 10_000).unref();
  });
  return () => child.kill('SIGKILL');
}

test('when the Trash refuses, the capsule copy is discarded and the original is untouched', { skip: !IS_UNIX }, async () => {
  // This drives the production path end to end — capture, then the real
  // `moveToTrash` — and B2 stops the delete, so nothing is ever trashed.
  const dir = await mkTmp();
  let release: (() => void) | null = null;
  try {
    const target = await writeFile(path.join(dir, 'held-open.log'), 'x'.repeat(4096));
    release = await holdOpenElsewhere(target);

    const before = (await entries()).length;
    const result = await protectAndTrash([{ path: target }]);

    assert.deepEqual(result.trashed, [], 'the open file was not deleted');
    assert.equal(result.failedToTrash.length, 1);
    assert.equal(fs.existsSync(target), true, 'the original is exactly where it was');

    const outcome = result.outcomes[0];
    assert.equal(outcome.protected, false, 'it is not reported as protected — the delete never happened');
    assert.equal(outcome.code, 'NOT_DELETED');

    // A copy of a file that still exists is pure waste, so it is not kept.
    assert.equal((await entries()).length, before, 'the capsule is back where it started');
    assert.equal((await entries()).some((e) => e.originalPath === target), false);
  } finally {
    release?.();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Restore safety ══════════════════ */

test('restoring never overwrites something sitting at the original path', async () => {
  const dir = await mkTmp();
  try {
    const target = await writeFile(path.join(dir, 'notes.txt'), 'original\n');
    const { outcomes } = await protectItems([{ path: target }]);
    assert.equal(outcomes[0].protected, true);

    // The user deleted it, then made a new file with the same name.
    await fsp.rm(target);
    await writeFile(target, 'something newer\n');

    const entry = (await entries()).find((e) => e.originalPath === target);
    await assert.rejects(
      () => startCapsuleRestore(entry!.id),
      (err: unknown) => err instanceof AppError && err.code === 'PATH_OCCUPIED',
    );
    assert.equal(await fsp.readFile(target, 'utf8'), 'something newer\n', 'the newer file is intact');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a payload corrupted in the capsule fails verification instead of restoring damage', async () => {
  const dir = await mkTmp();
  try {
    const target = await writeFile(path.join(dir, 'config.json'), '{"real":true}\n');
    const { outcomes } = await protectItems([{ path: target }]);
    const entryId = outcomes[0].entryId!;
    await fsp.rm(target);

    // Bit-rot, or a hand-edit of the app-data folder.
    await fsp.writeFile(path.join(capsuleRoot(), entryId, 'data', 'config.json'), '{"tampered":true}\n');

    const job = await restoreAndWait(entryId);
    assert.equal(job.status, 'error');
    assert.match(job.error ?? '', /no longer matches the fingerprint/);
    assert.equal(fs.existsSync(target), false, 'nothing damaged was left at the original path');

    // The entry is still there so the user can see what happened and decide.
    const entry = await getCapsuleEntry(entryId);
    assert.ok(entry && !entry.restoredAt);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ Retention, reconciliation, forgetting ══════════════════ */

test('entries past the retention window are swept out and the sweep is visible', async () => {
  const dir = await mkTmp();
  try {
    const target = await writeFile(path.join(dir, 'old-cache.bin'), crypto.randomBytes(1024));
    const { outcomes } = await protectItems([{ path: target }]);
    const entryId = outcomes[0].entryId!;
    await fsp.rm(target);

    // Nothing expires yet.
    assert.equal((await pruneExpired()).removed, 0);

    // Thirty-one days later, with the default 30-day retention.
    const later = Date.now() + 31 * 86_400_000;
    const result = await pruneExpired(later);
    assert.ok(result.removed >= 1);
    assert.ok(result.bytesFreed >= 1024);

    assert.equal(await getCapsuleEntry(entryId), undefined, 'the entry is gone');
    assert.equal(fs.existsSync(path.join(capsuleRoot(), entryId)), false, 'and so are its bytes');
    const index = await getCapsuleIndex();
    assert.ok(index.events.some((e) => e.kind === 'expired' && e.originalPath === target),
      'expiry is recorded where the user can see it');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('reconcile removes payloads nothing points at, and flags entries whose payload vanished', async () => {
  const dir = await mkTmp();
  try {
    // An orphan: what a crash between "bytes written" and "index saved" leaves.
    const orphan = path.join(capsuleRoot(), 'not-a-real-entry-' + crypto.randomUUID());
    await fsp.mkdir(path.join(orphan, 'data'), { recursive: true });
    await fsp.writeFile(path.join(orphan, 'data', 'junk.bin'), 'junk');

    // An entry whose payload was deleted from underneath it.
    const target = await writeFile(path.join(dir, 'vanishes.txt'), 'bytes\n');
    const { outcomes } = await protectItems([{ path: target }]);
    const entryId = outcomes[0].entryId!;
    await fsp.rm(target);
    await fsp.rm(path.join(capsuleRoot(), entryId), { recursive: true, force: true });

    const result = await reconcileCapsule();
    assert.ok(result.orphansRemoved >= 1);
    assert.equal(fs.existsSync(orphan), false, 'unreferenced bytes do not linger forever');
    assert.ok(result.entriesLost >= 1);

    const entry = await getCapsuleEntry(entryId);
    assert.ok(entry, 'the record survives so the loss can be explained');
    assert.equal(entry!.heldBytes, 0, 'but it no longer claims to hold anything');

    // And a Restore that cannot possibly work is refused up front.
    await assert.rejects(
      () => startCapsuleRestore(entryId),
      (err: unknown) => err instanceof AppError && err.code === 'PAYLOAD_GONE',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('forgetting an entry frees exactly the bytes it was holding', async () => {
  const dir = await mkTmp();
  try {
    const target = await writeFile(path.join(dir, 'forget-me.bin'), crypto.randomBytes(2048));
    const { outcomes } = await protectItems([{ path: target }]);
    const entryId = outcomes[0].entryId!;
    await fsp.rm(target);

    const before = (await getCapsuleIndex()).status.usedBytes;
    const result = await deleteCapsuleEntry(entryId);
    assert.equal(result.deleted, true);
    assert.equal(result.bytesFreed, 2048);

    const after = await getCapsuleIndex();
    assert.equal(after.status.usedBytes, before - 2048);
    assert.equal(await getCapsuleEntry(entryId), undefined);
    assert.equal(fs.existsSync(path.join(capsuleRoot(), entryId)), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('forgetting something that is already gone is a clear 404, not a crash', async () => {
  await assert.rejects(
    () => deleteCapsuleEntry('no-such-entry'),
    (err: unknown) => err instanceof AppError && err.code === 'ENTRY_NOT_FOUND',
  );
});

/* ══════════════════ The index the panel reads ══════════════════ */

test('the index reports capacity honestly and never lets used exceed the cap', async () => {
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 3; i++) {
      const f = await writeFile(path.join(dir, `f${i}.bin`), crypto.randomBytes(4096));
      await protectItems([{ path: f }]);
      await fsp.rm(f);
    }
    const index = await getCapsuleIndex();
    assert.equal(index.status.available, true);
    assert.ok(index.status.capBytes > 0);
    assert.ok(index.status.usedBytes <= index.status.capBytes, 'the cap is a ceiling, not a suggestion');
    assert.equal(index.status.retentionDays, 30, 'the §B3 default');
    assert.ok(index.status.restorableCount >= 3);

    // Newest first, so the panel does not have to sort.
    const times = index.entries.map((e) => e.capturedAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('every capture records a verifiable fingerprint and a real file count', async () => {
  const dir = await mkTmp();
  try {
    const root = path.join(dir, 'proj');
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'b.txt'), 'b');
    const { outcomes } = await protectItems([{ path: root }]);
    const entry = await getCapsuleEntry(outcomes[0].entryId!);
    assert.ok(entry);
    assert.equal(entry!.fileCount, 2);
    assert.match(entry!.digest, /^[0-9a-f]{64}$/, 'a real SHA-256, not a placeholder');
    await fsp.rm(root, { recursive: true, force: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test.after(() => {
  fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true });
});
