import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A2 — byte-accurate sizing across hard links, sparse files and clones.
 *
 * These tests build **real** hard links, **real** sparse files and, on macOS,
 * **real** APFS clones through the OS's own copy tool. §9 is explicit that
 * mocking the filesystem here would test nothing that matters, and it is right:
 * the central fact this feature rests on — that a clone gets its own inode and
 * reports full allocation — is only observable against a real filesystem.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-alloc-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;

import { buildIndex, deleteIndex, closeIndex } from '../src/services/indexEngine';
import { accountFor, allocationForFile, isMountPoint } from '../src/services/allocationAccountant';

const MB = 1024 * 1024;
const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-alloc-'));

/** Can this platform make a copy-on-write clone we can test against? */
function canClone(dir: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const a = path.join(dir, '.clone-probe');
    const b = path.join(dir, '.clone-probe-2');
    fs.writeFileSync(a, 'x');
    execFileSync('cp', ['-c', a, b]);
    fs.unlinkSync(a);
    fs.unlinkSync(b);
    return true;
  } catch {
    return false;
  }
}

after(() => {
  closeIndex();
  // maxRetries: Windows briefly holds locks on just-closed SQLite WAL and
  // watcher handles, and a bare rmSync throws EBUSY into the after() hook —
  // which node:test reports as the whole FILE failing (CI, first real
  // Windows runs). Retrying is the documented cure and free elsewhere.
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ══════════════════════ Hard links — exactly measurable ══════════════════════ */

test('a hard-linked pair is counted once, and neither name owns the bytes', async () => {
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'original.bin');
    const link = path.join(dir, 'hardlink.bin');
    await fsp.writeFile(original, Buffer.alloc(4 * MB, 7));
    await fsp.link(original, link);

    await buildIndex(dir, { live: false });
    const summary = (await accountFor(dir))!;

    // The whole point: a naive tool sees 8 MB, the disk holds 4 MB.
    assert.ok(summary.naiveLogicalBytes >= 8 * MB, 'the naive figure counts both names');
    assert.ok(summary.allocatedBytes < 5 * MB, 'the real figure counts the inode once');
    assert.equal(summary.hardlinkFamilies, 1);
    assert.equal(summary.hardlinkedNames, 1, 'one name beyond the first');

    // Deleting either name frees nothing, so neither owns exclusive bytes.
    for (const p of [original, link]) {
      const file = allocationForFile(dir, p)!;
      assert.equal(file.linksInScope, 2);
      assert.equal(file.linksTotal, 2);
      assert.equal(file.extendsOutsideRoot, false);
      assert.equal(file.exclusiveBytes, 0, 'deleting one name frees nothing');
      assert.ok(file.sharedBytes > 0);
      assert.ok(file.logicalBytes >= 4 * MB, 'both names report the real size, not the zeroed row');
    }
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('three names for one file: the diagnostic counts one file, the dashboard counts two extra names', async () => {
  // The two screens report the same tree with different units. A PAIR makes
  // both figures 1, which is why nothing caught them drifting apart. Only a
  // third name separates them.
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'original.bin');
    await fsp.writeFile(original, Buffer.alloc(4 * MB, 7));
    await fsp.link(original, path.join(dir, 'second.bin'));
    await fsp.link(original, path.join(dir, 'third.bin'));

    await buildIndex(dir, { live: false });
    const summary = (await accountFor(dir))!;

    assert.equal(summary.hardlinkFamilies, 1, 'one inode, however many names — what Settings labels “Hard-linked files”');
    assert.equal(summary.hardlinkedNames, 2, 'two names beyond the first — what the dashboard labels “extra file names”');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('deleting one member of a family makes the survivor exclusive again', async () => {
  // §A2 acceptance: "Deleting one member of a clone family updates the
  // remaining members' exclusive bytes correctly."
  const dir = await mkTmp();
  try {
    const original = path.join(dir, 'original.bin');
    const link = path.join(dir, 'hardlink.bin');
    await fsp.writeFile(original, Buffer.alloc(3 * MB, 1));
    await fsp.link(original, link);

    await buildIndex(dir, { live: false });
    assert.equal(allocationForFile(dir, original)!.exclusiveBytes, 0, 'shared while both names exist');

    await fsp.unlink(link);
    await buildIndex(dir, { live: false }); // re-index after the change

    const after = allocationForFile(dir, original)!;
    assert.equal(after.linksInScope, 1);
    assert.equal(after.linksTotal, 1);
    assert.equal(after.sharedBytes, 0);
    assert.ok(after.exclusiveBytes >= 3 * MB, 'the survivor now genuinely owns its bytes');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a family reaching outside the scanned root is flagged, not counted as exclusive', async () => {
  // The scope rule: `nlink` counts names anywhere on the volume, and the index
  // counts the ones inside the root. When they differ, deleting everything in
  // scope still frees nothing — treating those bytes as exclusive would tell
  // the user they can reclaim space they cannot.
  const outside = await mkTmp();
  const inside = await mkTmp();
  try {
    const target = path.join(outside, 'shared.bin');
    await fsp.writeFile(target, Buffer.alloc(2 * MB, 3));
    await fsp.link(target, path.join(inside, 'copy.bin'));

    await buildIndex(inside, { live: false });
    const file = allocationForFile(inside, path.join(inside, 'copy.bin'))!;

    assert.equal(file.linksInScope, 1, 'only one name is inside this root');
    assert.equal(file.linksTotal, 2, 'but the filesystem knows about two');
    assert.equal(file.extendsOutsideRoot, true);
    assert.equal(file.exclusiveBytes, 0, 'deleting it would free nothing');
    assert.ok(file.sharedBytes > 0);
  } finally {
    deleteIndex(inside);
    await fsp.rm(outside, { recursive: true, force: true });
    await fsp.rm(inside, { recursive: true, force: true });
  }
});

/* ══════════════════════ Sparse files — exactly measurable ══════════════════════ */

// Windows: NTFS allocates truncate-only files solid unless FSCTL_SET_SPARSE
// was set, so "occupies what it claims" is the genuinely correct answer
// there — recorded by CI's first real Windows run, same as the platform
// suite's sparse test.
test('a sparse file is sized by what it occupies, not what it claims', { skip: process.platform === 'win32' && 'NTFS allocates truncate-only files solid' }, async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'sparse.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 64 * MB);
    fs.closeSync(fd);

    await buildIndex(dir, { live: false });
    const summary = (await accountFor(dir))!;
    const file = allocationForFile(dir, sparse)!;

    assert.equal(file.logicalBytes, 64 * MB, 'it claims 64 MB');
    assert.ok(file.allocatedBytes < MB, 'and occupies almost none of it');
    assert.equal(file.underAllocated, true);
    assert.ok(summary.logicalBytes > summary.allocatedBytes * 10, 'the folder total reflects reality, not the claim');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Clones — honestly NOT measurable ══════════════════════ */

test('a clone is indistinguishable from a real copy, and is not pretended otherwise', async (t) => {
  // This test documents a limitation rather than a capability, deliberately.
  // If a future change ever makes clone detection work, this test failing is
  // the signal to update the UI's honesty copy — not to delete the test.
  const dir = await mkTmp();
  if (!canClone(dir)) {
    await fsp.rm(dir, { recursive: true, force: true });
    t.skip('copy-on-write cloning is not available here');
    return;
  }
  try {
    const original = path.join(dir, 'original.bin');
    const clone = path.join(dir, 'clone.bin');
    await fsp.writeFile(original, Buffer.alloc(8 * MB, 5));
    execFileSync('cp', ['-c', original, clone]);

    const [a, b] = [fs.lstatSync(original), fs.lstatSync(clone)];
    assert.notEqual(a.ino, b.ino, 'a clone gets its own inode — this is why it cannot be detected');
    assert.equal(a.nlink, 1, 'and no extra link count to give it away');

    await buildIndex(dir, { live: false });
    const summary = (await accountFor(dir))!;

    // Both are counted in full, because nothing available can say otherwise.
    assert.ok(summary.allocatedBytes >= 16 * MB, 'the clone is counted in full');
    assert.equal(summary.hardlinkFamilies, 0, 'a clone is not a hard-link family');

    // The contract that makes this acceptable: it is labelled approximate,
    // with a reason a person can understand.
    assert.equal(summary.approximate, true);
    assert.match(summary.reason, /share storage/i);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Reconciliation ══════════════════════ */

test('reconciliation is offered only for a whole volume, never invented for a subfolder', async () => {
  // A subfolder's contribution to used space cannot be isolated from outside,
  // so a "delta" computed for one would be made of everything else on the disk.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(MB));
    await buildIndex(dir, { live: false });

    const summary = (await accountFor(dir))!;
    assert.equal(await isMountPoint(dir), false, 'a temp folder is not a mount point');
    assert.equal(summary.reconciliation, null, 'no reconciliation is claimed for a subfolder');
    assert.equal(summary.volume, null);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the filesystem root is recognised as a volume', async () => {
  assert.equal(await isMountPoint(path.parse(process.cwd()).root), true);
});

test('every summary states that it may be an undercount of sharing', async () => {
  // §10 bans reporting a number you cannot verify. On any filesystem that
  // supports copy-on-write, the allocated sum is an upper bound — and saying so
  // is the whole difference between an honest total and a wrong one.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(MB));
    await buildIndex(dir, { live: false });
    const summary = (await accountFor(dir))!;
    assert.equal(summary.approximate, true);
    assert.ok(summary.reason.length > 40, 'the caveat is a sentence, not a flag');
    // Written for a non-technical reader (§3.2: the message goes on screen).
    assert.ok(!/reflink|CLONEID|FIEMAP|inode/i.test(summary.reason), 'no jargon in user-facing copy');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('shared and exclusive always add up to the allocated total', async () => {
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'solo.bin'), Buffer.alloc(2 * MB, 1));
    const linked = path.join(dir, 'linked.bin');
    await fsp.writeFile(linked, Buffer.alloc(3 * MB, 2));
    await fsp.link(linked, path.join(dir, 'linked-again.bin'));

    await buildIndex(dir, { live: false });
    const s = (await accountFor(dir))!;
    assert.equal(s.sharedBytes + s.exclusiveBytes, s.allocatedBytes, 'the split must be exhaustive');
    assert.ok(s.sharedBytes > 0 && s.exclusiveBytes > 0, 'this fixture has both kinds');
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an unindexed folder answers null rather than zeroes', async () => {
  assert.equal(await accountFor('/definitely/not/indexed'), null);
  assert.equal(allocationForFile('/definitely/not/indexed', '/definitely/not/indexed/x'), null);
});

test('an ordinary single-name file reports all of its bytes as exclusive', async () => {
  const dir = await mkTmp();
  try {
    const solo = path.join(dir, 'solo.bin');
    await fsp.writeFile(solo, Buffer.alloc(5 * MB, 9));
    await buildIndex(dir, { live: false });

    const file = allocationForFile(dir, solo)!;
    assert.equal(file.sharedBytes, 0);
    assert.ok(file.exclusiveBytes >= 5 * MB, 'deleting it frees its bytes');
    assert.equal(file.extendsOutsideRoot, false);
    assert.equal(file.underAllocated, false);
  } finally {
    deleteIndex(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a hard-link family is found by index seek, never by rescanning the root', async () => {
  // accountFor looks up one family at a time — WHERE root_id = ? AND ino = ? —
  // up to 200 times per report. Without an index on ino, SQLite falls back to
  // idx_nodes_mtime and rescans EVERY row in the root for each one. Measured on
  // a real 1,013,072-node home index those 200 lookups took 48.3 seconds; and
  // because better-sqlite3 is synchronous, that was 48 seconds with the event
  // loop blocked, so every other request queued behind it. Opening Settings
  // fires this, which is what made the whole app freeze.
  //
  // The plan is what this asserts, not the schema text: an index that exists
  // but is not chosen would leave the bug exactly as it was.
  const dir = await mkTmp();
  try {
    await fsp.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(4096, 1));
    await fsp.link(path.join(dir, 'a.bin'), path.join(dir, 'b.bin'));
    await buildIndex(dir);

    const { openIndex } = await import('../src/services/indexEngine');
    const handle = openIndex();
    const plan = handle
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE root_id = ? AND ino = ? AND is_dir = 0')
      .all(1, 1) as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');

    assert.match(detail, /idx_nodes_ino/, `the ino lookup must be an index seek, got: ${detail}`);
    assert.ok(!/idx_nodes_mtime/.test(detail), `must not fall back to the mtime index: ${detail}`);
    assert.ok(!/SCAN nodes\b/.test(detail), `must not scan the table: ${detail}`);

    // And the report itself still comes out right with the index in place.
    const summary = await accountFor(dir);
    assert.ok(summary, 'a summary is produced');
    assert.equal(summary.hardlinkFamilies, 1, 'the one family is found');
    assert.equal(summary.hardlinkedNames, 1, 'and the extra name is counted once');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
