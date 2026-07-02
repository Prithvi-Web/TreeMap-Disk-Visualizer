import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { gdriveFilesToTree, dropboxEntriesToTree, onedriveItemsToTree, retryDelayMs } from '../src/services/cloud/providers';
import { makePkce } from '../src/services/cloud/oauth';

/** Cloud provider tree mapping — the master prompt's "provider tree mapping" tests. */

test('gdrive: parent links, folder sizes and cloud ids map correctly', () => {
  const tree = gdriveFilesToTree([
    { id: 'root-docs', name: 'Docs', mimeType: 'application/vnd.google-apps.folder', parents: ['ROOT'] },
    { id: 'f1', name: 'thesis.pdf', size: '5000', mimeType: 'application/pdf', parents: ['root-docs'] },
    { id: 'f2', name: 'movie.mp4', size: '900000', mimeType: 'video/mp4', parents: ['ROOT'] },
    { id: 'gdoc', name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: ['root-docs'] }, // Docs have no size
  ], 'ROOT');
  assert.equal(tree.path, 'cloud://gdrive');
  assert.equal(tree.size, 905_000);
  const docs = tree.children!.find((c) => c.name === 'Docs')!;
  assert.equal(docs.type, 'dir');
  assert.equal(docs.size, 5000);
  assert.equal(docs.path, 'cloud://gdrive/Docs');
  const thesis = docs.children!.find((c) => c.name === 'thesis.pdf')!;
  assert.equal(thesis.path, 'cloud://gdrive/Docs/thesis.pdf');
  assert.equal(thesis.cloudId, 'f1');
  assert.equal(thesis.extension, 'pdf');
  const gdoc = docs.children!.find((c) => c.name === 'Notes')!;
  assert.equal(gdoc.size, 0);
});

test('gdrive: files with unknown parents land in Shared & orphaned', () => {
  const tree = gdriveFilesToTree([
    { id: 'x', name: 'mystery.bin', size: '10', mimeType: 'application/octet-stream', parents: ['someone-elses-folder'] },
    { id: 'y', name: 'no-parent.txt', size: '5', mimeType: 'text/plain' },
  ], 'ROOT');
  const orphans = tree.children!.find((c) => c.name === 'Shared & orphaned')!;
  assert.ok(orphans, 'orphan bucket exists');
  assert.equal(orphans.children!.length, 2);
  assert.equal(tree.size, 15); // totals still reconcile
});

test('gdrive: slashes in cloud file names cannot forge deeper paths', () => {
  const tree = gdriveFilesToTree([
    { id: 'evil', name: 'a/b.txt', size: '7', mimeType: 'text/plain', parents: ['ROOT'] },
  ], 'ROOT');
  const child = tree.children![0];
  assert.ok(!child.path.includes('/a/b'), 'slash replaced: ' + child.path);
  assert.equal(tree.children!.length, 1);
});

test('dropbox: path-based entries rebuild the folder structure', () => {
  const tree = dropboxEntriesToTree([
    { '.tag': 'folder', path_display: '/Photos' },
    { '.tag': 'file', id: 'id:aaa', path_display: '/Photos/trip.jpg', size: 2048 },
    { '.tag': 'file', id: 'id:bbb', path_display: '/notes.txt', size: 10 },
    { '.tag': 'deleted', path_display: '/gone.txt' },
    { '.tag': 'file', id: 'id:ccc', path_display: '/Deep/Nested/x.bin', size: 1 }, // implicit dirs
  ]);
  assert.equal(tree.size, 2059);
  const photos = tree.children!.find((c) => c.name === 'Photos')!;
  assert.equal(photos.children![0].path, 'cloud://dropbox/Photos/trip.jpg');
  const deep = tree.children!.find((c) => c.name === 'Deep')!;
  assert.equal(deep.children![0].name, 'Nested');
  assert.ok(!JSON.stringify(tree).includes('gone.txt'), 'deleted entries are skipped');
});

test('onedrive: delta items link via parentReference and skip deleted', () => {
  const tree = onedriveItemsToTree([
    { id: 'ROOT', name: 'root', root: {} },
    { id: 'd1', name: 'Work', folder: {}, parentReference: { id: 'ROOT' } },
    { id: 'f1', name: 'plan.xlsx', size: 4000, parentReference: { id: 'd1' } },
    { id: 'f2', name: 'old.tmp', size: 1, parentReference: { id: 'd1' }, deleted: {} },
    { id: 'f3', name: 'top.txt', size: 50, parentReference: { id: 'ROOT' } },
  ]);
  assert.equal(tree.size, 4050);
  const work = tree.children!.find((c) => c.name === 'Work')!;
  assert.equal(work.size, 4000);
  assert.equal(work.children![0].path, 'cloud://onedrive/Work/plan.xlsx');
  assert.ok(!JSON.stringify(tree).includes('old.tmp'));
});

test('retry policy: rate limits and server errors back off, client errors never', () => {
  // 429 honors Retry-After
  assert.equal(retryDelayMs(429, 1, '3', ''), 3000);
  // 5xx backs off exponentially (jitter ≤ 250ms on top of the base)
  const d1 = retryDelayMs(503, 1, null, '');
  const d2 = retryDelayMs(503, 2, null, '');
  assert.ok(d1 >= 500 && d1 < 800, `attempt1 ~500ms, got ${d1}`);
  assert.ok(d2 >= 1000 && d2 < 1300, `attempt2 ~1000ms, got ${d2}`);
  // Google's rate-limit-flavored 403 is transient…
  assert.ok(retryDelayMs(403, 1, null, '{"reason":"userRateLimitExceeded"}') !== null);
  // …but a plain 403 (permissions) is not
  assert.equal(retryDelayMs(403, 1, null, '{"error":"insufficient permissions"}'), null);
  // 4xx client mistakes never retry
  assert.equal(retryDelayMs(400, 1, null, ''), null);
  assert.equal(retryDelayMs(404, 1, null, ''), null);
  // attempts are capped
  assert.equal(retryDelayMs(429, 4, '1', ''), null);
  // Retry-After is clamped so a hostile header can't stall a scan
  assert.equal(retryDelayMs(429, 1, '9999', ''), 30_000);
});

test('pkce: challenge is the base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = makePkce();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43 && verifier.length <= 128, 'RFC 7636 length');
  assert.notEqual(makePkce().verifier, verifier, 'verifiers are random');
});
