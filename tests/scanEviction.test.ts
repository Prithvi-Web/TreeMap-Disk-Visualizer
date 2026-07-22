import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanExpired } from '../src/services/diskScanner';
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
