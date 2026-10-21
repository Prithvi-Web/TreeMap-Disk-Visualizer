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
import { refusedChildren } from '../src/utils/pathSanitizer';

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

test('a listing orders its folders with one collator made once, never one per comparison — localeCompare with options makes a collator on every call, and over 50,000 subfolders that held the server for a second and a half (POL item 2 review, F1.3)', async () => {
  // The sort runs on every subfolder, on the event loop, before the cut. Counted, not timed: during one
  // listing nothing calls String.prototype.localeCompare and no Intl.Collator is made.
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-collator-'));
  // Distinct names made in reverse order; how names that differ only in case or accent order is the next test's.
  const names = Array.from({ length: 520 }, (_, i) => `n${pad(519 - i)}`);
  for (const name of [...names, '.z', '.A']) fs.mkdirSync(path.join(dir, name));
  const counts = { localeCompare: 0, collatorsMade: 0 };
  const realLocaleCompare = String.prototype.localeCompare;
  const RealCollator = Intl.Collator;
  const intl = Intl as unknown as { Collator: typeof Intl.Collator };
  let r: { status: number; body: any };
  String.prototype.localeCompare = function (this: string, ...args: unknown[]) {
    counts.localeCompare++;
    return (realLocaleCompare as (...a: unknown[]) => number).apply(this, args);
  } as typeof String.prototype.localeCompare;
  intl.Collator = new Proxy(RealCollator, {
    construct(target, args) { counts.collatorsMade++; return Reflect.construct(target, args); },
    apply(target, self, args) { counts.collatorsMade++; return Reflect.apply(target, self, args); },
  });
  try {
    r = await listing(dir);
  } finally {
    String.prototype.localeCompare = realLocaleCompare;
    intl.Collator = RealCollator;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(counts, { localeCompare: 0, collatorsMade: 0 });
  // The order is the one localeCompare gave, letter case aside: by name, ordinary folders first.
  const expected = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  assert.deepEqual({ first: r.body.dirs.slice(0, 3).map((d: { name: string }) => d.name), total: r.body.total },
    { first: expected.slice(0, 3), total: 522 });
  assert.deepEqual(r.body.dirs.map((d: { name: string }) => d.name), expected.slice(0, 500));
});

test('names that differ only in letter case or accents are equal to the order — "Apple" and "apple", "résumé" and "resume" keep the order the folder was read in, as localeCompare with sensitivity "base" kept them — while a different letter still decides (POL item 2 review, F2.5)', async () => {
  // A disk that folds case (APFS, NTFS) cannot hold both "Apple" and "apple", so the folder read is stood in
  // for: it answers in an order chosen here, the opposite of the one a case- and accent-sensitive collator
  // gives (lower case first, unaccented first). Equal names keep that order: the sort is stable.
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-base-'));
  const read = ['Banana', 'Apple', 'apple', 'résumé', 'resume', '.Z', '.z'];
  const entry = (name: string) => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
  const promises = fs.promises as { readdir: unknown };
  const realReaddir = promises.readdir;
  promises.readdir = async function (p: fs.PathLike, ...rest: unknown[]) {
    if (String(p) === dir) return read.map(entry);
    return (realReaddir as (...a: unknown[]) => unknown).call(fs.promises, p, ...rest);
  };
  let r: { status: number; body: any };
  try {
    r = await listing(dir);
  } finally {
    promises.readdir = realReaddir;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ names: r.body.dirs.map((d: { name: string }) => d.name), total: r.body.total },
    { names: ['Apple', 'apple', 'Banana', 'résumé', 'resume', '.Z', '.z'], total: 7 });
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

test('a folder the path rules refuse is not listed, by its name or by where it leads — through a link to the drive\'s root no "dev" (or System32 under Windows\' folder), on macOS /var no "db", which leads into /private/var/db — and total counts what is listed (eighth browser pass K53)', async () => {
  const win = process.platform === 'win32';
  const target = win ? (process.env.SystemRoot ?? 'C:\\Windows') : '/';
  const refusedName = win ? 'system32' : 'dev';
  const keptName = win ? 'fonts' : 'usr';
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-refused-'));
  const link = path.join(dir, 'leads-to-system');
  fs.symlinkSync(target, link, win ? 'junction' : 'dir');
  const names = (r: { body: { dirs: Array<{ name: string }> } }) => r.body.dirs.map((d) => d.name.toLowerCase());
  const through = await listing(link);
  assert.equal(through.status, 200, JSON.stringify(through.body));
  assert.ok(names(through).includes(keptName), `control: ${keptName} is listed through the link (${names(through).join(', ')})`);
  assert.ok(!names(through).includes(refusedName), `${refusedName}, reached through the link, leads into a folder TreeMap stays out of: not listed`);
  if (through.body.dirs.length < 500) assert.equal(through.body.total, through.body.dirs.length, 'total counts the folders listed, not the one left out');
  const opened = await listing(path.join(link, win ? 'System32' : 'dev'));
  assert.equal(opened.status, 400, 'control: the folder itself, asked for, is refused as before');
  if (!win) assert.ok(!names(await listing('/')).includes('dev'), 'the root lists no /dev, refused by its own name');
  if (process.platform === 'darwin') {
    assert.ok(!names(await listing('/var')).includes('db'), '/var lists no "db": it leads into /private/var/db');
    assert.ok(!names(await listing('/private/var')).includes('db'), 'nor does /private/var, by its name');
    assert.ok(names(await listing('/var')).includes('folders'), 'control: /var still lists its other folders');
  }
});

test('on macOS the root lists none of the second names the system gives every file — /.vol, /.nofollow, /.resolve, refused by their spelling — where the listing kept all three and each row opened only that refusal (review F1.2)', { skip: process.platform !== 'darwin' }, async () => {
  const SECOND = ['.nofollow', '.resolve', '.vol'];
  const there = fs.readdirSync('/', { withFileTypes: true }).filter((e) => SECOND.includes(e.name) && e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  assert.ok(there.length > 0, `control: the root holds at least one of them as a folder the listing would show (${there.join(', ')})`);
  const root = await listing('/');
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const listed = root.body.dirs.map((d: { name: string }) => d.name);
  assert.deepEqual(listed.filter((n: string) => SECOND.includes(n.toLowerCase())), [], `none of them is listed (${listed.join(', ')})`);
  assert.ok(listed.includes('Users'), 'control: the root still lists its other folders');
  assert.equal(root.body.total, root.body.dirs.length, 'and total counts what is listed, not them');
  for (const n of there) assert.equal((await listing(`/${n}`)).status, 400, `control: /${n}, asked for, is refused`);
});

test('which entries of a folder are refused by a second name is judged on macOS\'s rules on every POSIX runner, Linux included — the root\'s .vol, .nofollow and .resolve, in any case, and nothing of the same names deeper down (review F1.2)', {
  // Standing in macOS's platform does not stand in its path module: on Windows path.join('/', '.vol') is
  // "\\.vol", a spelling no macOS rule reads, so there the test would judge a path no Mac can hold (review F2.2).
  skip: process.platform === 'win32' && 'a macOS path cannot be spelled with the Windows path module',
}, () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let atRoot: Set<string>; let deeper: Set<string>;
  Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
  try {
    atRoot = refusedChildren('/', ['.vol', '.nofollow', '.Resolve', '.VOL', 'Users', '.volumes', 'vol']);
    deeper = refusedChildren('/Users', ['.vol', '.nofollow', '.resolve']);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.deepEqual([...atRoot].sort(), ['.Resolve', '.VOL', '.nofollow', '.vol'], 'the root\'s second names, by their spelling in any case — and no other name');
  assert.deepEqual([...deeper], [], 'a folder of the same name deeper down is no second name');
});

test('judging which folders a listing may show asks nothing of the file system per folder where none can be refused — 520 subfolders of an ordinary folder cost no stat, lstat or realpath of one of them (eighth browser pass K53)', async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-fslist-cheap-'));
  for (let i = 0; i < 520; i++) fs.mkdirSync(path.join(dir, `d${pad(i)}`));
  const inside = (p: unknown) => typeof p === 'string' && p.startsWith(dir + path.sep);
  let asked = 0;
  const real = { lstat: fs.lstatSync, stat: fs.statSync, native: fs.realpathSync.native };
  const fsAny = fs as unknown as { lstatSync: unknown; statSync: unknown; realpathSync: { native: unknown } };
  fsAny.lstatSync = (p: fs.PathLike, ...a: unknown[]) => { if (inside(p)) asked++; return (real.lstat as (...x: unknown[]) => unknown)(p, ...a); };
  fsAny.statSync = (p: fs.PathLike, ...a: unknown[]) => { if (inside(p)) asked++; return (real.stat as (...x: unknown[]) => unknown)(p, ...a); };
  fsAny.realpathSync.native = (p: fs.PathLike, ...a: unknown[]) => { if (inside(p)) asked++; return (real.native as (...x: unknown[]) => unknown)(p, ...a); };
  let r: { status: number; body: any };
  try {
    r = await listing(dir);
  } finally {
    fsAny.lstatSync = real.lstat; fsAny.statSync = real.stat; fsAny.realpathSync.native = real.native;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 520, 'control: every subfolder is listed');
  assert.equal(asked, 0, 'and none of them was looked at to judge it');
});
