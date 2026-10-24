import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-scanEviction-data-');

import { scanExpired, createScanRecord, evictExpiredScans, getScan } from '../src/services/diskScanner';
import { ScanResult } from '../src/models/types';

/**
 * Eviction must never cancel a live scan: the old age-only rule deleted any
 * record 30 minutes after creation, so a slow full-disk walk vanished
 * mid-flight and its progress stream (and the UI spinner) never resolved.
 * Retention now starts when a scan settles; 'running' records only expire
 * at the wedge horizon (6 h — a driver that died without settling).
 */

const MIN = 60_000;

function scan(overrides: Partial<ScanResult>): ScanResult {
  const now = Date.now();
  return {
    scanId: 'test',
    rootPath: '/tmp/x',
    status: 'complete',
    scanned: 1,
    fileCount: 1,
    dirCount: 0,
    currentPath: '/tmp/x',
    startedAt: now,
    createdAt: now,
    cancelled: false,
    // Required on every record (the walker's values at start); expiry reads none of them.
    engineReason: '',
    fastPath: 'readdir+lstat',
    fallbackReason: null,
    cpuSeconds: null,
    bytesRead: null,
    peakRssBytes: null,
    placeholdersSkipped: 0,
    budget: { preset: 'auto', effective: 'balanced', source: 'node-shim' },
    ...overrides,
  };
}

test('a running scan never expires inside the wedge horizon', () => {
  const now = Date.now();
  const s = scan({ status: 'running', createdAt: now - 5 * 60 * MIN });
  assert.equal(scanExpired(s, now), false, '5h-old running scan must survive');
});

test('a wedged running scan is collected at the 6h horizon', () => {
  const now = Date.now();
  const s = scan({ status: 'running', createdAt: now - 361 * MIN });
  assert.equal(scanExpired(s, now), true);
});

test('a completed scan is retained for 30 minutes after finishing', () => {
  const now = Date.now();
  const s = scan({ createdAt: now - 90 * MIN, finishedAt: now - 29 * MIN });
  assert.equal(scanExpired(s, now), false, 'retention counts from finishedAt, not createdAt');
  assert.equal(scanExpired(s, now + 2 * MIN), true);
});

test('a settled scan without finishedAt falls back to createdAt', () => {
  const now = Date.now();
  const s = scan({ status: 'error', error: 'boom', createdAt: now - 31 * MIN });
  assert.equal(scanExpired(s, now), true);
});

test('a running scan collected at the six-hour limit is settled first, with its reason, so a progress stream holding the record ends instead of heartbeating for ever (hunt C68)', () => {
  const rec = createScanRecord('/tmp/treemap-scanEviction-wedged');
  rec.createdAt = Date.now() - 7 * 60 * MIN; // past the six-hour hard cap
  assert.ok(evictExpiredScans().includes(rec.scanId), 'the record is collected');
  assert.equal(getScan(rec.scanId), undefined);
  assert.equal(rec.cancelled, true, 'the engine still sees it cancelled');
  assert.equal(rec.status, 'error', 'no longer "running": the /progress timer ends on any other status, with an error frame');
  // The limit counts from when the scan started, paused time included (a paused scan stays "running"):
  // the sentence says the record's age, never that it ran for six hours (review F1.9).
  assert.equal(rec.error, 'The scan was stopped six hours after it started, the longest TreeMap keeps a scan that has not finished.');
  assert.equal(typeof rec.finishedAt, 'number');
  const done = createScanRecord('/tmp/treemap-scanEviction-done');
  done.status = 'complete';
  done.finishedAt = Date.now() - 31 * MIN;
  evictExpiredScans();
  assert.equal(done.status, 'complete', 'control: a settled scan that expires keeps what it was');
  assert.equal(done.error, undefined);
});
