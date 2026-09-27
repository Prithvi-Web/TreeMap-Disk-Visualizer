import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-sizeBuckets-data-');

import { BUCKETS, bucketFor } from '../src/services/reclaimInputs';

/**
 * Phase 4 T12b: tm-store's aggregate state puts each file in the size histogram's bucket
 * (`computeSizeDistribution`) without trusting Rust's `log2` to round as V8's does. It holds
 * the smallest positive double of each bucket from 1 on, as JavaScript finds them
 * (`native/treemap-core/crates/tm-store/src/aggregate/buckets.rs`), and counts how many a
 * size has reached. This recomputes each start in the JavaScript running the test — Node 20
 * on CI, Node 24 here — and holds the Rust table to it. Electron 31.7.7 gave the same table,
 * bit for bit (27 Sep 2026).
 */
const TABLE = path.join(__dirname, '..', 'native', 'treemap-core', 'crates', 'tm-store', 'src', 'aggregate', 'buckets.rs');

const view = new DataView(new ArrayBuffer(8));
const fromBits = (bits: bigint): number => {
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
};

/** The table's entries, in order: the hex literals between its declaration and its end. */
function rustStarts(): bigint[] {
  const source = fs.readFileSync(TABLE, 'utf8');
  const from = source.indexOf('pub const SIZE_BUCKET_STARTS');
  assert.ok(from >= 0, 'the table is declared');
  const body = source.slice(from, source.indexOf('];', from));
  return [...body.matchAll(/0x([0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4})/g)].map((m) => BigInt(`0x${m[1].replaceAll('_', '')}`));
}

test("tm-store's size-bucket table starts each bucket at the smallest double this JavaScript puts in it", () => {
  const starts = rustStarts();
  assert.equal(starts.length, BUCKETS - 1, 'one start for each bucket from 1 on');
  starts.forEach((bits, i) => {
    const bucket = i + 1;
    const start = fromBits(bits);
    assert.equal(bucketFor(start), bucket, `bucket ${bucket} starts at ${start}`);
    const below = fromBits(bits - 1n);
    assert.equal(bucketFor(below), bucket - 1, `${below}, the double below bucket ${bucket}'s start, is in the bucket before`);
  });
});

test('a size of zero or less, and 1, are in bucket 0; 2 starts bucket 16; from 2^64 bytes on, every size is in the last bucket', () => {
  assert.equal(bucketFor(0), 0);
  assert.equal(bucketFor(-5), 0);
  assert.equal(bucketFor(1), 0);
  assert.equal(bucketFor(2), 16);
  // 2^64 is where the logarithm first reaches past the last bucket, so the clamp decides it.
  assert.equal(bucketFor(2 ** 64), BUCKETS - 1);
  assert.equal(bucketFor(Number.MAX_VALUE), BUCKETS - 1);
});
