import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-query-cap-');
process.env.TREEMAP_NO_GDU = '1';

import { parse } from '../src/services/query/parse';
import { executeAgainstScan, type QueryOutcome } from '../src/services/query/execute';
import { createScanRecord } from '../src/services/diskScanner';
import { buildStoreFromTree } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';
import type { Ast } from '../src/services/query/types';

/**
 * D31: a query's total was the 20,000 cap, in tree-walk order.
 *
 * The executor kept at most 20,000 candidates from its first pass, in the
 * order the walk met them, then reported `total: hits.length`. So `size>0` on
 * a 465,602-item scan said "Showing the 1000 biggest of 20000 matches" — wrong
 * twice: the total was the cap, and the 1,000 were the biggest of an arbitrary
 * 20,000, not of the scan. `-dupe:` reported "20,000 items could not be
 * decided" for the same reason. Autopilot's query policies ride the same
 * executor, so they chose from that arbitrary 20,000 as well.
 *
 * The cap exists to bound the expensive part — facts fetched, and creation
 * dates statted, one file at a time. A query that needs neither has every
 * verdict final after the walk, so now it is counted exactly and only the page
 * asked for is kept. A query that does need them still stops at 20,000, and
 * says so in `degraded` instead of passing the cap off as the count.
 *
 * Scans here are built in memory (buildStoreFromTree); nothing touches a disk
 * except the creation-date reads of the capped case, which find nothing.
 */

const N = 20_005;
const ROOT = '/qcap';

/** N files, each a distinct size; the five biggest are f0…f4. */
function bigScan(): string {
  const file = (i: number): FileNode => ({
    name: `f${i}.bin`, path: `${ROOT}/f${i}.bin`, type: 'file', extension: 'bin',
    size: 1_000_000 - i, modifiedAt: 1_800_000_000_000, isHidden: false,
  });
  const root: FileNode = {
    name: 'qcap', path: ROOT, type: 'dir', size: 0, modifiedAt: 1_800_000_000_000, isHidden: false,
    children: Array.from({ length: N }, (_, i) => file(i)),
  };
  const scan = createScanRecord(ROOT);
  scan.store = buildStoreFromTree(root);
  scan.status = 'complete';
  return scan.scanId;
}

function ast(q: string): Ast {
  const r = parse(q);
  assert.ok(r.ok, `"${q}" parses`);
  return (r as { ok: true; ast: Ast }).ast;
}

async function run(scanId: string, q: string, limit: number, offset = 0): Promise<QueryOutcome> {
  const out = await executeAgainstScan(scanId, ast(q), { limit, offset, sort: 'size', signal: new AbortController().signal });
  assert.ok(!('error' in out), JSON.stringify(out));
  return out as QueryOutcome;
}

test('a query that needs no looked-up facts counts every match, not the first 20,000', async () => {
  const out = await run(bigScan(), 'type:file size>0', 5);
  assert.equal(out.total, N, 'every one of the 20,005 matching files is counted');
  assert.equal(out.truncated, true, 'only five are returned, and the answer says so');
  assert.ok(!out.degraded.some((d) => d.provider === 'capped'), 'nothing was capped, so nothing claims it was');
});

test('"the biggest" are the biggest in the scan, not the biggest of whatever the walk met first', async () => {
  const out = await run(bigScan(), 'type:file size>0', 5);
  assert.deepEqual(out.hits.map((h) => h.name), ['f0.bin', 'f1.bin', 'f2.bin', 'f3.bin', 'f4.bin']);
});

test('paging reaches the far end of an uncapped answer, in order', async () => {
  const out = await run(bigScan(), 'type:file size>0', 10, N - 3);
  assert.equal(out.total, N);
  assert.deepEqual(out.hits.map((h) => h.name), [`f${N - 3}.bin`, `f${N - 2}.bin`, `f${N - 1}.bin`],
    'the three smallest, after 20,002 bigger ones');
});

test('"could not be decided" counts every undecided item, not the cap', async () => {
  // dupe: has no source at all, so every item is undecided — and it needs no
  // fetched fact, so the walk can count them exactly.
  const out = await run(bigScan(), 'dupe:yes', 10);
  const undecided = out.degraded.find((d) => d.provider === 'undecided');
  assert.ok(undecided, JSON.stringify(out.degraded));
  assert.match(undecided!.reason, /^20,006 items could not be decided/, 'all 20,005 files and their folder');
});

test('a query that stats every candidate still stops at 20,000 — and says so instead of calling it the total', async () => {
  // created: needs one stat per candidate, so the cap stays. These paths do not
  // exist, so every read fails and is reported; what matters here is the cap.
  const out = await run(bigScan(), 'created>1d type:file', 10);
  const capped = out.degraded.find((d) => d.provider === 'capped');
  assert.ok(capped, `the cap is stated: ${JSON.stringify(out.degraded.map((d) => d.provider))}`);
  assert.match(capped!.reason, /20,000/, 'with the number, formatted');
  assert.match(capped!.reason, /more/i, 'and that there may be more than counted');
  assert.equal(out.truncated, true);
});
