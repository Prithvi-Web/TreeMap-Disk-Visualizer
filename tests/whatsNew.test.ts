import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/services/snapshots';
import { Snapshot } from '../src/models/types';

/**
 * The "What's new since last scan" banner is computed from diffSnapshots (via
 * GET /api/snapshots/compare) over the two most recent snapshots of a root:
 * totalDelta drives the bytes badge, fileCount difference drives the files
 * badge, and the FIRST entry with delta > 0 is shown as the biggest mover.
 * That last rule is only correct because entries arrive sorted by |delta|
 * descending — these tests pin every property the banner leans on.
 */

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    id: 'id-' + Math.random().toString(36).slice(2),
    rootPath: '/root',
    takenAt: 1_000,
    totalSize: 0,
    fileCount: 0,
    dirCount: 0,
    topEntries: [],
    ...over,
  };
}

const entry = (name: string, size: number) => ({ name, path: `/root/${name}`, size, type: 'dir' as const });

test('growth: totalDelta is signed positive and the top grower leads the entries', () => {
  const a = snap({ takenAt: 1000, totalSize: 10_000, fileCount: 100, topEntries: [entry('Videos', 6000), entry('Docs', 4000)] });
  const b = snap({ takenAt: 2000, totalSize: 12_500, fileCount: 120, topEntries: [entry('Videos', 8000), entry('Docs', 4500)] });
  const diff = diffSnapshots(a, b);

  assert.equal(diff.totalDelta, 2_500);
  assert.equal(b.fileCount - a.fileCount, 20); // files badge input
  const mover = diff.entries.find((e) => e.delta > 0);
  assert.ok(mover);
  assert.equal(mover.name, 'Videos');
  assert.equal(mover.delta, 2_000);
});

test('shrink: totalDelta goes negative and no positive mover exists', () => {
  const a = snap({ totalSize: 9_000, fileCount: 50, topEntries: [entry('Cache', 5000)] });
  const b = snap({ totalSize: 7_800, fileCount: 36, topEntries: [entry('Cache', 3800)] });
  const diff = diffSnapshots(a, b);

  assert.equal(diff.totalDelta, -1_200);
  assert.equal(diff.entries.find((e) => e.delta > 0), undefined); // banner omits the mover line
});

test('entries are ordered by |delta| desc, so first-positive IS the biggest grower', () => {
  const a = snap({ totalSize: 0, topEntries: [entry('big-shrink', 10_000), entry('small-grow', 100), entry('big-grow', 200)] });
  const b = snap({ totalSize: 0, topEntries: [entry('big-shrink', 1_000), entry('small-grow', 400), entry('big-grow', 5_200)] });
  const diff = diffSnapshots(a, b);

  assert.deepEqual(diff.entries.map((e) => e.name), ['big-shrink', 'big-grow', 'small-grow']);
  const mover = diff.entries.find((e) => e.delta > 0);
  assert.equal(mover?.name, 'big-grow'); // NOT small-grow, despite appearing earlier in topEntries
  assert.equal(mover?.delta, 5_000);
});

test('entries that appear or disappear count with their full size', () => {
  const a = snap({ topEntries: [entry('gone', 700)] });
  const b = snap({ topEntries: [entry('new', 900)] });
  const diff = diffSnapshots(a, b);

  const gone = diff.entries.find((e) => e.name === 'gone');
  const fresh = diff.entries.find((e) => e.name === 'new');
  assert.equal(gone?.delta, -700);
  assert.equal(gone?.sizeB, null);
  assert.equal(fresh?.delta, 900);
  assert.equal(fresh?.sizeA, null);
});

test('unchanged entries are filtered out entirely', () => {
  const a = snap({ topEntries: [entry('same', 1234), entry('moved', 10)] });
  const b = snap({ topEntries: [entry('same', 1234), entry('moved', 20)] });
  const diff = diffSnapshots(a, b);

  assert.deepEqual(diff.entries.map((e) => e.name), ['moved']);
});
