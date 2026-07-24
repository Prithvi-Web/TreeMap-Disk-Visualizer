import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyJournalEvents } from '../src/services/ntfsMftJournalApply';
import { IndexRecord } from '../src/services/ntfsMftIndexStore';

function baseRecords(): IndexRecord[] {
  return [
    { recordNo: 100, parentRecordNo: 5, name: 'fx', size: 0, isDir: true, mtimeMs: 0 },
    { recordNo: 101, parentRecordNo: 100, name: 'old-name.txt', size: 5, isDir: false, mtimeMs: 0 },
  ];
}

test('a rename event updates name and parent in place, not delete+create', () => {
  const records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, parentRecordNo: 100, name: 'new-name.txt', reason: 'rename', isDir: false, size: 5, mtimeMs: 1 },
  ]);
  const renamed = records.find((r) => r.recordNo === 101)!;
  assert.equal(renamed.name, 'new-name.txt');
  assert.equal(records.length, 2, 'rename must not add a new record');
});

test('delete then a later create with the SAME recordNo is a new file, not corruption', () => {
  let records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, reason: 'delete' },
  ]);
  assert.equal(records.find((r) => r.recordNo === 101), undefined);

  records = applyJournalEvents(records, [
    { recordNo: 101, parentRecordNo: 100, name: 'reused-slot.bin', reason: 'create', isDir: false, size: 9, mtimeMs: 2 },
  ]);
  const reused = records.find((r) => r.recordNo === 101)!;
  assert.equal(reused.name, 'reused-slot.bin', 'a create on a reused FRN is a normal new file');
});

test('an unrelated data-change event updates size/mtime without touching name/parent', () => {
  const records = applyJournalEvents(baseRecords(), [
    { recordNo: 101, reason: 'data-extend', size: 999, mtimeMs: 3 },
  ]);
  const updated = records.find((r) => r.recordNo === 101)!;
  assert.equal(updated.size, 999);
  assert.equal(updated.name, 'old-name.txt', 'name must survive a data-only event');
});

test('a data-only event for an unknown recordNo throws JournalApplyGapError, never a silent no-op', () => {
  assert.throws(
    () => applyJournalEvents(baseRecords(), [
      { recordNo: 9999, reason: 'data-extend', size: 1, mtimeMs: 1 },
    ]),
    /JournalApplyGapError/,
  );
});

test('a create/rename event with no existing record and no parent/name throws rather than defaulting silently', () => {
  assert.throws(
    () => applyJournalEvents(baseRecords(), [
      { recordNo: 202, reason: 'create' },
    ]),
    /JournalApplyGapError/,
  );
});
