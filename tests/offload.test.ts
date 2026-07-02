import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FileNode, OffloadEntry } from '../src/models/types';
import { planOffload, destNameFor, trimManifest, hashFile } from '../src/services/offload';
import { promises as fsp } from 'fs';
import os from 'os';
import crypto from 'crypto';

/** Offload: planning, collision naming, manifest trimming, hashing. */

function file(p: string, size: number): FileNode {
  return { name: path.basename(p), path: p, size, type: 'file', modifiedAt: 0, isHidden: false };
}
function dir(p: string, children: FileNode[]): FileNode {
  return {
    name: path.basename(p), path: p, size: children.reduce((s, c) => s + c.size, 0),
    type: 'dir', children, modifiedAt: 0, isHidden: false,
  };
}

test('planOffload flattens folder selections and preserves structure', () => {
  const sel = [
    file('/src/report.pdf', 100),
    dir('/src/Projects', [
      file('/src/Projects/a.txt', 10),
      dir('/src/Projects/deep', [file('/src/Projects/deep/b.bin', 20)]),
    ]),
  ];
  const plan = planOffload(sel, '/dest');
  assert.deepEqual(plan.map((p) => [p.src, p.dest, p.size]), [
    ['/src/report.pdf', path.join('/dest', 'report.pdf'), 100],
    ['/src/Projects/a.txt', path.join('/dest', 'Projects', 'a.txt'), 10],
    ['/src/Projects/deep/b.bin', path.join('/dest', 'Projects', 'deep', 'b.bin'), 20],
  ]);
});

test('planOffload skips virtual (in-archive) entries and empty dirs', () => {
  const virt: FileNode = { ...file('/src/box.zip/inner.txt', 5), virtual: true };
  const sel = [dir('/src/mix', [virt, file('/src/mix/real.txt', 7)]), dir('/src/empty', [])];
  const plan = planOffload(sel, '/d');
  assert.deepEqual(plan.map((p) => p.src), ['/src/mix/real.txt']);
});

test('destNameFor dedupes top-level name collisions', () => {
  const taken = new Set<string>();
  const pick = (n: string) => { const r = destNameFor(n, taken); taken.add(r.toLowerCase()); return r; };
  assert.equal(pick('notes.txt'), 'notes.txt');
  assert.equal(pick('notes.txt'), 'notes (offloaded 2).txt');
  assert.equal(pick('notes.txt'), 'notes (offloaded 3).txt');
  assert.equal(pick('Makefile'), 'Makefile');
  assert.equal(pick('makefile'), 'makefile (offloaded 2)'); // case-insensitive clash, input casing kept
});

test('planOffload keeps two same-named selections apart at the destination', () => {
  const sel = [file('/a/data.csv', 1), file('/b/data.csv', 2)];
  const plan = planOffload(sel, '/d');
  assert.notEqual(plan[0].dest, plan[1].dest);
  assert.equal(plan[1].dest, path.join('/d', 'data (offloaded 2).csv'));
});

test('trimManifest drops restored entries before active ones', () => {
  const entry = (id: string, offloadedAt: number, restoredAt?: number): OffloadEntry => ({
    id, name: id, originalPath: '/' + id, destPath: '/d/' + id, destRoot: '/d',
    size: 1, hash: 'x', offloadedAt, restoredAt,
  });
  const entries = [entry('active-old', 1), entry('restored-new', 9, 10), entry('active-new', 5)];
  const kept = trimManifest(entries, 2);
  assert.deepEqual(kept.map((e) => e.id).sort(), ['active-new', 'active-old']);
  // Under the cap nothing is touched.
  assert.equal(trimManifest(entries, 5).length, 3);
});

test('hashFile matches an independently computed SHA-256', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-offload-'));
  const f = path.join(tmp, 'sample.bin');
  const data = crypto.randomBytes(300_000);
  await fsp.writeFile(f, data);
  const expected = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(await hashFile(f), expected);
  await fsp.rm(tmp, { recursive: true, force: true });
});
