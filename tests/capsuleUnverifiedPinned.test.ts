import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-capsuleUnverifiedPinned-data-');
process.env.TREEMAP_NO_GDU = '1';

import { deleteCapsuleEntry, getCapsuleIndex, protectItems, setCapsuleCapForTests } from '../src/services/timeCapsule';
import { CommandStopped, setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, planCartCommit } from '../src/services/cartCommit';
import type { TimeCapsuleEntry } from '../src/models/types';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3g L6 (the FG3f review's L6). A copy whose original's trash step could not be confirmed is kept,
 * and marked: the original may be in the Trash, so the copy may be the only one ("a copy is never
 * discarded while it may be the only one"). Only the copies of runs under way were pinned, so once
 * its run ended such a copy was evicted like any other to make room. Now a copy marked unconfirmed is
 * never evicted, by a real run or in a dry run's plan.
 *
 * Nothing reaches the machine's Trash: the trash step moves each file into this file's own folder —
 * and for a name starting "late" it is stopped at its time limit, the file left in place, so its copy
 * is kept as unconfirmed.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleUnverifiedPinned-trash-');
let trashCalls = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    if (path.basename(p).startsWith('late')) throw new CommandStopped('osascript was stopped at its time limit (a test)');
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

const ITEM = 100_000;

function item(label: string, name: string, fill: number): string {
  const p = path.join(fileTempDir(`treemap-capsuleUnverifiedPinned-${label}-`), name);
  fs.writeFileSync(p, Buffer.alloc(ITEM, fill));
  return p;
}

async function entryOf(id: string): Promise<TimeCapsuleEntry | undefined> {
  return (await getCapsuleIndex()).entries.find((e) => e.id === id);
}

/**
 * Forgets every copy the capsule holds, so each test starts from an empty capsule whatever ran before
 * it (FG3g review F1.8): the second test relied on a copy the first one left, and failed run alone.
 */
async function emptyCapsule(): Promise<void> {
  for (const e of (await getCapsuleIndex()).entries) await deleteCapsuleEntry(e.id);
  assert.deepEqual((await getCapsuleIndex()).entries, [], 'the capsule starts empty');
}

test('a copy kept because its trash step could not be confirmed is never evicted once its run is over: a newer copy goes instead', async () => {
  await emptyCapsule();
  const uncap = setCapsuleCapForTests(250_000);
  try {
    const late = item('late', 'late.bin', 1);
    const committed = await withOpenFileCheck('clear', () => commitCart([late]));
    assert.deepEqual((committed.unverified ?? []).map((u) => u.path), [late], 'unconfirmed: its copy is kept, and may be the only one');
    const unconfirmed = (await getCapsuleIndex()).entries.find((e) => e.runId === committed.runId);
    assert.ok(unconfirmed);

    const newer = item('newer', 'newer.bin', 2);
    const [{ entryId: newerId }] = (await protectItems([{ path: newer }])).outcomes;
    const incoming = item('incoming', 'incoming.bin', 3); // needs room: one copy must go

    const plan = await planCartCommit([incoming]);
    assert.equal(plan.items[0].willDelete, true, 'it fits by evicting the newer, ordinary copy');
    assert.deepEqual(plan.evicts.map((e) => e.id), [newerId], 'the dry run never plans to evict the unconfirmed copy');

    const { outcomes } = await protectItems([{ path: incoming }]);
    assert.equal(outcomes[0].protected, true, outcomes[0].detail);
    assert.equal((await entryOf(unconfirmed.id))?.hasPayload, true, 'the unconfirmed copy, the oldest, is still held');
    assert.equal((await entryOf(newerId as string))?.hasPayload, false, 'the newer ordinary copy went instead');
  } finally {
    uncap();
  }
});

test('an item that would fit only by evicting unconfirmed copies is left undeleted, saying why', async () => {
  await emptyCapsule();
  const uncap = setCapsuleCapForTests(250_000);
  try {
    // Two unconfirmed copies of this test's own fill the room: 200 kB held, never evicted.
    for (const [n, fill] of [[1, 4], [2, 6]] as const) {
      const late = item(`late-full-${n}`, `late-full-${n}.bin`, fill);
      const committed = await withOpenFileCheck('clear', () => commitCart([late]));
      assert.deepEqual((committed.unverified ?? []).map((u) => u.path), [late], 'unconfirmed: its copy is kept');
    }
    const big = item('big', 'big.bin', 5);
    const result = await withOpenFileCheck('clear', () => commitCart([big]));
    const row = result.skipped.find((s) => s.path === big);
    assert.equal(row?.code, 'CAPSULE_FULL', JSON.stringify(result.skipped));
    assert.match(row?.reason ?? '', /could not be confirmed/, row?.reason);
    assert.ok(fs.existsSync(big), 'and it is still in place');
  } finally {
    uncap();
  }
});
