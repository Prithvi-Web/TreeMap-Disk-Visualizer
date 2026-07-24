import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRefreshStrategy } from '../src/services/ntfsMftInvalidation';

const baseCheckpoint = {
  volumeSerialNumber: 111,
  usnJournalId: 999n,
  lastUsnProcessed: 500n,
  formatVersion: 1,
};

test('no stored checkpoint -> full reindex, no reason needed beyond "first run"', () => {
  const result = decideRefreshStrategy(null, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'no-checkpoint');
});

test('volume serial mismatch -> full reindex', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 222, usnJournalId: 999n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'volume-serial-mismatch');
});

test('USN journal ID mismatch -> full reindex (journal was recreated)', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 12345n, firstUsn: 0n, nextUsn: 600n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'journal-id-mismatch');
});

test('checkpoint older than FirstUsn -> full reindex (journal truncated past our checkpoint)', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 600n, nextUsn: 700n,
  });
  assert.equal(result.strategy, 'full-reindex');
  assert.equal(result.reason, 'checkpoint-gap');
});

test('valid checkpoint within range -> incremental, resuming from lastUsnProcessed', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 100n, nextUsn: 700n,
  });
  assert.equal(result.strategy, 'incremental');
  assert.equal(result.resumeFromUsn, 500n);
});

test('checkpoint exactly equal to nextUsn -> incremental with nothing to apply', () => {
  const result = decideRefreshStrategy(baseCheckpoint, {
    volumeSerialNumber: 111, usnJournalId: 999n, firstUsn: 100n, nextUsn: 500n,
  });
  assert.equal(result.strategy, 'incremental');
});
