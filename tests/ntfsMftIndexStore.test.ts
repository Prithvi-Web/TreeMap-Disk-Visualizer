import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveIndex, loadIndex, IndexCheckpoint } from '../src/services/ntfsMftIndexStore';

test('saveIndex then loadIndex round-trips records and checkpoint exactly', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntfs-mft-index-'));
  const file = path.join(dir, 'C.idx');
  const checkpoint: IndexCheckpoint = {
    volumeSerialNumber: 123456789,
    usnJournalId: 0x1122334455667788n,
    lastUsnProcessed: 999n,
    formatVersion: 1,
  };
  const records = [
    { recordNo: 100, parentRecordNo: 5, name: 'fx', size: 0, isDir: true, mtimeMs: 1732000000000 },
    { recordNo: 101, parentRecordNo: 100, name: 'a.txt', size: 5, isDir: false, mtimeMs: 1732000000000 },
  ];

  await saveIndex(file, checkpoint, records);
  const loaded = await loadIndex(file);

  assert.deepEqual(loaded.checkpoint, checkpoint);
  assert.deepEqual(loaded.records, records);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('loadIndex rejects a file with a mismatched format version', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntfs-mft-index-'));
  const file = path.join(dir, 'C.idx');
  await saveIndex(file, {
    volumeSerialNumber: 1, usnJournalId: 1n, lastUsnProcessed: 1n, formatVersion: 999,
  }, []);

  await assert.rejects(() => loadIndex(file), /format version/i);
  await fsp.rm(dir, { recursive: true, force: true });
});
