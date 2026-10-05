import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-duplicateProgress-data-');

import { createScanRecord } from '../src/services/diskScanner';
import { getDuplicateJob, observeDuplicateProgressForTests } from '../src/services/duplicateFinder';
import { PackedScanStore } from '../src/services/scanStore';
import { resetNativeForTests, setNativeLoadOverrideForTests } from '../src/services/scan/native';
import { waitFor } from './fixtures/waitFor';
import { lift } from './fixtures/liftFrontend';
import http from 'node:http';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import type { DuplicateJob, ScanResult } from '../src/models/types';

/**
 * QA D52: the Duplicates view read "Hashing candidates… 0 / 39,575 files"
 * for about 40 s and then jumped to done. `hashed` was counted only in the
 * third stage (the full read, of files whose first 64 KiB matched), so the
 * second stage — the long one, reading the start of every candidate —
 * showed 0 throughout, and the counter never reached `toHash` because files
 * that differed early were never counted.
 *
 * The contract now: the job says which pass it is in (`phase`), each pass
 * counts its own files one by one as they are read, never past its total,
 * and each pass ends with `hashed === toHash`. Counted through a test seam
 * that is told of every progress change — no clock.
 */

interface Progress { phase: string; hashed: number; toHash: number }

const SMALL = 8_192;
const LARGE = 70_000; // past the 64 KiB partial read, so two of these can match early and differ late

function payload(size: number, fill: number, lastByte?: number): Buffer {
  const b = Buffer.alloc(size, fill);
  if (lastByte !== undefined) b[size - 1] = lastByte;
  return b;
}

/**
 * a, b, c: identical. d: same size, different from the first byte. g, h: same
 * first 64 KiB, different last byte. x: a size of its own (never a candidate).
 */
function built(): { scan: ScanResult; dir: string } {
  const dir = fileTempDir('treemap-dupes-progress-');
  const files: [string, Buffer][] = [
    ['a.dat', payload(SMALL, 1)], ['b.dat', payload(SMALL, 1)], ['c.dat', payload(SMALL, 1)],
    ['d.dat', payload(SMALL, 2)],
    ['g.dat', payload(LARGE, 3, 1)], ['h.dat', payload(LARGE, 3, 2)],
    ['x.dat', payload(5_000, 4)],
  ];
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  for (const [name, bytes] of files) {
    fs.writeFileSync(path.join(dir, name), bytes);
    store.addNode(store.rootId, { name, isDir: false, size: bytes.length, modifiedAt: 1, isHidden: false });
  }
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, dir };
}

/** A native module whose only answer is dataIsLocal, from `local` — so no real module decides what is read. */
function standIn(local: (file: string) => boolean): void {
  resetNativeForTests();
  const mod = { version: () => '0.0.0-test', dataIsLocal: (paths: string[]) => Uint8Array.from(paths.map((p) => (local(p) ? 1 : 0))) };
  setNativeLoadOverrideForTests({ path: '/stand-in/treemap_core.node', expectedVersion: '0.0.0-test', requireModule: () => mod });
}

async function run(scan: ScanResult): Promise<{ job: DuplicateJob; seen: Progress[] }> {
  const seen: Progress[] = [];
  observeDuplicateProgressForTests((p) => seen.push({ ...p }));
  try {
    const job = getDuplicateJob(scan, 1024);
    await waitFor(() => job.status !== 'running', 'the duplicate job finishing');
    assert.equal(job.status, 'complete', job.error);
    return { job, seen };
  } finally {
    observeDuplicateProgressForTests(null);
  }
}

/** The last progress state of each phase, in phase order. */
function lastOfEachPhase(seen: Progress[]): Map<string, Progress> {
  const last = new Map<string, Progress>();
  for (const p of seen) last.set(p.phase, p);
  return last;
}

test('the first pass counts every candidate it reads, so progress moves long before the full read starts', async () => {
  const { scan, dir } = built();
  standIn(() => true);
  try {
    const { job, seen } = await run(scan);
    const partial = seen.filter((p) => p.phase === 'partial');
    assert.ok(partial.length > 0, `no progress was reported in the partial pass: ${JSON.stringify(seen)}`);
    assert.equal(partial[0]!.toHash, 6, 'six candidates: a, b, c, d (8 KiB) and g, h (70,000 bytes)');
    assert.ok(partial.some((p) => p.hashed > 0), `the partial pass stayed at 0 / ${partial[0]!.toHash}: ${JSON.stringify(partial)}`);
    const last = lastOfEachPhase(seen);
    assert.deepEqual(last.get('partial'), { phase: 'partial', hashed: 6, toHash: 6 }, 'the partial pass ends with every candidate counted');
    // The full pass reads only what matched early: a, b, c and g, h.
    const full = seen.filter((p) => p.phase === 'full');
    assert.equal(full[0]?.toHash, 5);
    assert.equal(full[0]?.hashed, 0, 'the full pass counts from zero');
    assert.deepEqual(last.get('full'), { phase: 'full', hashed: 5, toHash: 5 }, 'the full pass ends with every file counted');
    // Phases go forward only, and no state ever reads more than its total.
    const order = ['sizes', 'partial', 'full'];
    for (let i = 1; i < seen.length; i++) {
      assert.ok(order.indexOf(seen[i]!.phase) >= order.indexOf(seen[i - 1]!.phase), `phase went back: ${JSON.stringify(seen)}`);
    }
    for (const p of seen) assert.ok(p.hashed <= p.toHash, `${p.hashed} / ${p.toHash} in ${p.phase}`);
    // The job a poll reads finishes at its total too.
    assert.equal(job.hashed, job.toHash);
    assert.equal(job.phase, 'full');
    assert.deepEqual(job.groups?.map((g) => g.files.map((f) => path.basename(f.path)).sort()), [['a.dat', 'b.dat', 'c.dat']]);
  } finally {
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a candidate left with no copy to compare is taken off the total, so the pass still ends at its total', async () => {
  // b, c and d evicted since the scan: a is alone at its size and is never read.
  const { scan, dir } = built();
  standIn((file) => !['b.dat', 'c.dat', 'd.dat'].includes(path.basename(file)));
  try {
    const { seen } = await run(scan);
    const last = lastOfEachPhase(seen);
    assert.deepEqual(last.get('partial'), { phase: 'partial', hashed: 2, toHash: 2 }, `only g and h were read: ${JSON.stringify(seen)}`);
  } finally {
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Duplicates view names the pass it is showing progress for', () => {
  const text = lift<(d: Record<string, unknown>) => string>(['dupProgressText', 'formatCount', 'UI_LOCALE'], 'dupProgressText');
  assert.equal(text({ status: 'running', phase: 'sizes', hashed: 0, toHash: 0 }), 'Comparing file sizes…');
  assert.match(text({ status: 'running', phase: 'partial', hashed: 1200, toHash: 39575 }), /^Hashing candidates… 1,200 \/ 39,575 files$/);
  assert.match(text({ status: 'running', phase: 'full', hashed: 3, toHash: 40 }), /^Confirming matches… 3 \/ 40 files/);
});

test('a poll of /api/duplicates while hashing says which pass its counts are for', async () => {
  const { scan, dir } = built();
  standIn(() => true);
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/duplicates?scanId=${scan.scanId}&minSize=1024` }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf) }));
      }).on('error', reject);
    });
    // The first poll starts the job, which has sized its candidates and begun the partial pass before it answers.
    assert.equal(body.status, 202);
    assert.deepEqual(body.json, { status: 'running', phase: 'partial', hashed: 0, toHash: 6 });
    const job = getDuplicateJob(scan, 1024);
    await waitFor(() => job.status !== 'running', 'the duplicate job finishing');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setNativeLoadOverrideForTests(null);
    resetNativeForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
