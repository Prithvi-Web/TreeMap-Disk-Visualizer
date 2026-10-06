import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-fsListOrder-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildOpenApiDocument } from '../src/api/openapi';

/**
 * GET /api/fs/list — the folder picker's listing (POL item 2, 6 Oct 2026).
 *
 * It cut the folders at 500 BEFORE sorting them, so a folder with more than
 * 500 subfolders sent whichever 500 the directory read met first, sorted —
 * not the first 500 in the order the picker shows them (ordinary folders
 * first, dot-folders after them, each by name: browseOrder). And nothing said
 * the list was cut. Now the folders are sorted in that order, then cut, and
 * `total` says how many there are.
 */

function get(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    }).on('error', reject);
  });
}

async function listing(dir: string): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await get((server.address() as { port: number }).port, `/api/fs/list?path=${encodeURIComponent(dir)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const pad = (i: number): string => String(i).padStart(3, '0');

test('a folder with more than 500 subfolders sends the first 500 in the order the picker shows them — ordinary folders by name, then dot-folders — and says how many there are (POL item 2)', async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-many-'));
  const ordinary = Array.from({ length: 510 }, (_, i) => `d${pad(i)}`);
  const hidden = Array.from({ length: 10 }, (_, i) => `.h${pad(i)}`);
  for (const name of [...hidden, ...ordinary]) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'a-file.txt'), 'not a folder');

  const r = await listing(dir);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({
    path: r.body.path,
    total: r.body.total,
    sent: r.body.dirs.length,
    first: r.body.dirs.slice(0, 2).map((d: { name: string }) => d.name),
    last: r.body.dirs.at(-1)?.name,
    hiddenSent: r.body.dirs.filter((d: { isHidden: boolean }) => d.isHidden).length,
  }, {
    path: dir,
    total: 520,
    sent: 500,
    first: ['d000', 'd001'],
    last: 'd499',
    hiddenSent: 0,
  });
  assert.deepEqual(r.body.dirs.map((d: { name: string }) => d.name), ordinary.slice(0, 500), 'exactly the first 500 shown, in that order');
  assert.deepEqual(r.body.dirs[0], { name: 'd000', path: path.join(dir, 'd000'), isHidden: false }, 'each folder as before');
});

test('a folder with 500 or fewer subfolders sends every one, dot-folders last, with total equal to the count sent (POL item 2)', async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-few-'));
  for (const name of ['b', '.cache', 'A', '.agents', 'c']) fs.mkdirSync(path.join(dir, name));
  const r = await listing(dir);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ names: r.body.dirs.map((d: { name: string }) => d.name), total: r.body.total },
    { names: ['A', 'b', 'c', '.agents', '.cache'], total: 5 });
});

test('the published spec names total, always sent, and says dirs is the first 500 in the picker’s order (POL item 2)', () => {
  const doc = buildOpenApiDocument() as any;
  const schema = doc.paths['/api/fs/list'].get.responses['200'].content['application/json'].schema;
  assert.deepEqual({
    required: schema.required,
    total: schema.properties.total?.type,
    dirs: /first 500 in the order the picker shows them: ordinary folders first, then dot-folders, each by name/.test(schema.properties.dirs.description ?? ''),
  }, { required: ['path', 'parent', 'dirs', 'total'], total: 'integer', dirs: true });
});
