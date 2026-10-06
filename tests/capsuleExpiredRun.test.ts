import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-capsuleExpiredRun-data-');
process.env.TREEMAP_NO_GDU = '1';

import { deleteCapsuleEntry, getCapsuleIndex, getCapsuleJob, pruneExpired } from '../src/services/timeCapsule';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart, undoCartRun } from '../src/services/cartCommit';
import { getSettings } from '../src/services/settings';
import type { TimeCapsuleEntry } from '../src/models/types';
import { buildOpenApiDocument } from '../src/api/openapi';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * FG3g L3 (the FG3f review's L3). The expiry sweep deleted each expired record outright. A run whose
 * copies were taken a little apart — a chunked cart commit, or a long run — could expire one record
 * before the others, and its undo then knew nothing of that item: it put back the rest and said
 * "Everything from that run is back", and an Autopilot run was stamped undone. Now an expired copy's
 * record is kept, marked expired and holding nothing, until every record of its run has expired;
 * an undo names the item as one it cannot put back, and the expiry is recorded once.
 *
 * "A little apart" is made exact by moving one record's capture time back in the index. Nothing
 * reaches the machine's Trash: the trash step moves each file into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleExpiredRun-trash-');
let trashCalls = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

const INDEX = path.join(DATA, 'timecapsule.json');
const DAY = 86_400_000;

/** Moves one record's capture time back by `ms`, in the index on disk. */
function capturedEarlier(id: string, ms: number): void {
  const store = JSON.parse(fs.readFileSync(INDEX, 'utf8')) as { entries: TimeCapsuleEntry[] };
  const entry = store.entries.find((e) => e.id === id);
  assert.ok(entry);
  entry.capturedAt -= ms;
  fs.writeFileSync(INDEX, JSON.stringify(store));
}

async function ofRun(runId: string): Promise<TimeCapsuleEntry[]> {
  return (await getCapsuleIndex()).entries.filter((e) => e.runId === runId);
}

test('an undo of a run whose older copy has expired names that item as gone, and never says everything is back', async () => {
  const dir = fileTempDir('treemap-capsuleExpiredRun-run-');
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'the first item');
  fs.writeFileSync(b, 'the second item');
  const committed = await withOpenFileCheck('clear', () => commitCart([a, b]));
  assert.deepEqual([...committed.trashed].sort(), [a, b].sort());
  const entryA = (await ofRun(committed.runId)).find((e) => e.originalPath === a);
  const entryB = (await ofRun(committed.runId)).find((e) => e.originalPath === b);
  assert.ok(entryA && entryB);
  capturedEarlier(entryA.id, 60_000); // A's copy was taken a minute before B's

  const { timeCapsuleRetentionDays } = await getSettings();
  const justPastA = entryA.capturedAt - 60_000 + timeCapsuleRetentionDays * DAY + 1; // A has expired; B has not
  const swept = await pruneExpired(justPastA);
  assert.equal(swept.removed, 1, 'A\'s copy expired');

  const records = await ofRun(committed.runId);
  const tombstone = records.find((e) => e.id === entryA.id);
  assert.ok(tombstone, 'A\'s record is kept while B\'s copy is still held');
  assert.equal(tombstone.hasPayload, false);
  assert.equal(tombstone.heldBytes, 0);
  assert.equal(typeof tombstone.expiredAt, 'number', 'and it says it expired');
  assert.equal(fs.existsSync(path.join(DATA, 'timecapsule', entryA.id)), false, 'its copy is gone');

  await pruneExpired(justPastA);
  const events = (await getCapsuleIndex()).events.filter((e) => e.kind === 'expired' && e.originalPath === a);
  assert.equal(events.length, 1, 'a second sweep does not record the expiry again');

  const undo = await undoCartRun(committed.runId);
  assert.equal(undo.entryCount, 1, 'B is put back');
  assert.deepEqual(undo.unrestorable?.map((u) => u.path), [a], 'and A is named as one it cannot put back');
  assert.match(undo.unrestorable?.[0].reason ?? '', /time copies are kept/, 'saying why');
  await waitFor(() => getCapsuleJob(undo.jobId)?.status !== 'running', 'the undo');
  assert.equal(getCapsuleJob(undo.jobId)?.status, 'complete', getCapsuleJob(undo.jobId)?.error);
  assert.equal(fs.readFileSync(b, 'utf8'), 'the second item');

  // B's record is forgotten: nothing of the run is left unexpired, so A's record goes at the next sweep,
  // though nothing new expires in it.
  await deleteCapsuleEntry(entryB.id);
  assert.deepEqual(await pruneExpired(justPastA), { removed: 0, bytesFreed: 0 });
  assert.deepEqual(await ofRun(committed.runId), [], 'the expired record goes once its run holds nothing else');
});

test('once every copy of a run has expired, all its records go in the same sweep', async () => {
  const dir = fileTempDir('treemap-capsuleExpiredRun-whole-');
  const files = ['x.txt', 'y.txt'].map((n) => path.join(dir, n));
  for (const f of files) fs.writeFileSync(f, `the content of ${path.basename(f)}`);
  const committed = await withOpenFileCheck('clear', () => commitCart(files));
  assert.equal(committed.trashed.length, 2);
  const { timeCapsuleRetentionDays } = await getSettings();
  const swept = await pruneExpired(Date.now() + (timeCapsuleRetentionDays + 1) * DAY);
  assert.ok(swept.removed >= 2);
  assert.deepEqual(await ofRun(committed.runId), [], 'the whole run\'s records go together');
});

test('the contract names every kind of item an undo reports it cannot put back: evicted, expired, missing, and a record TreeMap did not make (FG3g review F1.5)', () => {
  const descriptions: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string' && node.includes('which no undo can put back')) descriptions.push(node);
    else if (node !== null && typeof node === 'object') for (const v of Object.values(node)) visit(v);
  };
  visit(buildOpenApiDocument());
  assert.equal(descriptions.length, 2, `the cart undo and the Autopilot undo each describe it: ${JSON.stringify(descriptions)}`);
  for (const d of descriptions) {
    for (const kind of [/evicted to make room/, /expired/, /missing from the capsule folder/, /a record in the run that TreeMap did not make/]) {
      assert.match(d, kind, d);
    }
  }
});
