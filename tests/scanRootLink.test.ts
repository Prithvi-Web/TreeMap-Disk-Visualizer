import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('treemap-scanRootLink-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { canLock } from './fixtures/nativeEdge';
import { getScan, startScan } from '../src/services/diskScanner';
import { findGduBinary } from '../src/services/gduScanner';
import { nativeScanModule } from '../src/services/scan/native';
import { storeOf } from '../src/services/scanStore';
import { updateSettings } from '../src/services/settings';
import { settled } from '../src/utils/backgroundWrites';
import { insideAnyScanRoot } from '../src/middleware/pathGuard';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { setBoundaryDepsForTests, type MountTable } from '../src/utils/mountBoundaries';
import { createApp } from '../src/server';
import type { ScanResult } from '../src/models/types';

/**
 * D78 (QA, 5 Oct 2026): a scan whose root is a link to a folder — macOS's
 * /tmp, /var and /etc, a symlinked project folder — showed ONE tile, the link
 * itself: the root was lstat'ed, found to be no folder, and recorded as a
 * file. A person who points TreeMap at a folder by a link means the folder.
 *
 * Now the folder the link points to is scanned, as the scan's root, by its
 * own path (every engine is handed that path), and the scan says so in its
 * engine sentence. A link to a file, or to nothing, stays the one file it is.
 * The scanned-root rule grants the folder by its own path and by the link's
 * spelling (the guard resolves the parents of every path it is asked about),
 * and never the link itself, which no walk listed. A link inside an agent
 * policy's allowed root is followed only into a folder an allowed root holds.
 *
 * Nothing is mounted: a drive inside the folder is an injected table entry.
 * Every assertion counts.
 */

const NO_LINKS = (() => {
  const probe = fileTempDir('treemap-scanRootLink-probe-');
  try {
    fs.symlinkSync(probe, path.join(probe, 'self'), 'dir');
    return false;
  } catch {
    return 'this account cannot create symlinks';
  }
})();

after(async () => {
  setBoundaryDepsForTests(null);
  delete process.env.TREEMAP_NO_GDU;
  await updateSettings({ engine: 'auto', scanBoundary: 'stay' });
  await settled();
});

interface LinkTree {
  /** The folder, by its real path: `real/{a.txt (1000 B), sub/b.txt (2000 B)}`. */
  real: string;
  /** `link` → `real`. */
  link: string;
  /** `filelink` → `real/a.txt`. */
  fileLink: string;
  /** `dangling` → a path that is not there. */
  dangling: string;
  base: string;
}

function linkTree(): LinkTree {
  const base = fs.realpathSync(fileTempDir('treemap-scanRootLink-'));
  const real = path.join(base, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(real, 'a.txt'), 'a'.repeat(1000));
  fs.writeFileSync(path.join(real, 'sub', 'b.txt'), 'b'.repeat(2000));
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link, 'dir');
  const fileLink = path.join(base, 'filelink');
  fs.symlinkSync(path.join(real, 'a.txt'), fileLink, 'file');
  const dangling = path.join(base, 'dangling');
  fs.symlinkSync(path.join(base, 'not-there'), dangling, 'dir');
  return { real, link, fileLink, dangling, base };
}

type Engine = 'walker' | 'native' | 'gdu';

async function scanOf(root: string, engine: Engine | 'auto', opts: { incremental?: boolean } = {}): Promise<ScanResult> {
  await updateSettings({ engine });
  if (engine === 'gdu') delete process.env.TREEMAP_NO_GDU;
  else process.env.TREEMAP_NO_GDU = '1';
  const s = await startScan(root, opts);
  await waitFor(() => s.status !== 'running', `the ${engine} scan of ${root} settling`);
  assert.equal(s.status, 'complete', s.error);
  return getScan(s.scanId) ?? s;
}

const ENGINE_NAMES: Record<Engine, string[]> = { walker: ['walker', 'turbo-walker'], native: ['native'], gdu: ['gdu-turbo'] };

/** Whether this machine has `engine`; a skip (or, on CI, a failure) when it does not. */
async function has(t: TestContext, engine: Engine): Promise<boolean> {
  if (engine === 'native' && !nativeScanModule().available) {
    skipOrFailOnCi(t, 'no native module built for this machine');
    return false;
  }
  if (engine === 'gdu' && !(await findGduBinary())) {
    skipOrFailOnCi(t, 'gdu not available on this machine');
    return false;
  }
  return true;
}

const LINK_SENTENCE = (link: string, real: string): string => `${link} is a link to ${real}, and TreeMap scanned the folder it points to`;

/* ─────────────────────────── the folder a link points to ─────────────────────────── */

for (const engine of ['walker', 'native', 'gdu'] as const) {
  test(`${engine}: a root that is a link to a folder is scanned as that folder, by the folder's own path, and the scan says so (D78)`, { skip: NO_LINKS }, async (t) => {
    if (!(await has(t, engine))) return;
    const f = linkTree();
    const scan = await scanOf(f.link, engine);
    assert.ok(ENGINE_NAMES[engine].includes(scan.engine ?? ''), `${scan.engine}: ${scan.engineReason} — ${scan.fallbackReason}`);
    assert.equal(scan.rootPath, f.real, 'the scan is rooted at the folder, by its own path');
    const store = storeOf(scan);
    assert.equal(store.isDir(store.rootId), true, 'the root is a folder, not the link');
    assert.equal(scan.fileCount, 2, 'a.txt and sub/b.txt');
    assert.equal(scan.dirCount, 2, 'the folder and sub');
    assert.notEqual(store.findByPath(path.join(f.real, 'sub', 'b.txt')), -1, 'what is inside is spelled under the folder’s path');
    assert.equal(store.size(store.rootId), 3000);
    assert.ok(scan.engineReason?.startsWith(`${LINK_SENTENCE(f.link, f.real)}; `), scan.engineReason);
  });
}

test('a link to a file stays the one file it is, and so does a link to nothing: neither is followed, and neither says it was', { skip: NO_LINKS }, async () => {
  const f = linkTree();
  for (const link of [f.fileLink, f.dangling]) {
    const scan = await scanOf(link, 'walker');
    assert.equal(scan.rootPath, link, 'scanned by the path it was given');
    const store = storeOf(scan);
    assert.equal(store.isDir(store.rootId), false, `${link}: one file`);
    assert.equal(scan.fileCount, 1);
    assert.equal(scan.dirCount, 0);
    assert.equal(store.size(store.rootId), fs.lstatSync(link).size, 'the link’s own bytes');
    assert.doesNotMatch(scan.engineReason ?? '', /is a link to/);
  }
});

test('the folder a link root leads to passes the checks a typed path passes: a link to /dev is refused by the scan itself, whoever asked for it', { skip: NO_LINKS || (process.platform === 'win32' && 'the Unix blocklist') }, async () => {
  const f = linkTree();
  const toDev = path.join(f.base, 'devices');
  fs.symlinkSync('/dev', toDev, 'dir');
  // The route's sanitizer already refuses this spelling; the scheduler, Autopilot and a paired
  // computer hand startScan a path saved earlier, and a link can be pointed elsewhere since.
  await assert.rejects(startScan(toDev), (err: Error & { code?: string }) => err.code === 'PATH_BLOCKED');
});

test('a link to a folder TreeMap may not look into fails as a scan of that folder would — never a quiet one-file scan of the link', { skip: NO_LINKS || (!canLock && 'a folder cannot be made unreadable here (Windows, or running as root)') }, async () => {
  const f = linkTree();
  const locked = path.join(f.base, 'locked');
  fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
  const toLocked = path.join(f.base, 'tolocked');
  fs.symlinkSync(path.join(locked, 'inner'), toLocked, 'dir');
  fs.chmodSync(locked, 0o000);
  try {
    await assert.rejects(startScan(toLocked), (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM');
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('the drives mounted inside are found under the folder’s own path, and a fast rescan of the link reuses the cache its last scan wrote', { skip: NO_LINKS }, async () => {
  const f = linkTree();
  const sub = path.join(f.real, 'sub');
  const table: MountTable = { source: 'mount', entries: [{ mountPoint: sub, filesystem: 'apfs', options: ['apfs', 'local'], source: '/dev/disk99s1' }], reason: null };
  setBoundaryDepsForTests({ readTable: async () => table, aliases: async () => () => [] });
  try {
    await updateSettings({ scanBoundary: 'stay' });
    const first = await scanOf(f.link, 'walker');
    assert.deepEqual(first.boundary?.mounts?.map((m) => m.path), [sub], 'the table’s mount, under the folder');
    assert.ok(first.boundary?.neverDescend.includes(sub), 'and the walk was told not to enter it');
    const store = storeOf(first);
    assert.equal(store.findByPath(path.join(sub, 'b.txt')), -1, 'so the drive was not entered');
    await settled(); // the fast-rescan cache is written after the scan answers
    const again = await scanOf(f.link, 'walker', { incremental: true });
    assert.equal(again.rootPath, f.real);
    assert.equal(again.incremental, true, 'the cache was found by the folder’s path');
    assert.ok((again.cachedDirs ?? 0) > 0, `a listing came from the cache (cachedDirs ${again.cachedDirs})`);
  } finally {
    setBoundaryDepsForTests(null);
  }
});

/* ─────────────────────────── what the scan grants ─────────────────────────── */

interface Reply { status: number; body: any }

function req(port: number, method: string, url: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  resetIdempotencyCache();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** POST /api/scan for `p`, settled; the record. */
async function scanOverHttp(port: number, p: string): Promise<ScanResult> {
  const started = await req(port, 'POST', '/api/scan', { path: p });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const scan = getScan(started.body.scanId)!;
  await waitFor(() => scan.status !== 'running', `the scan of ${p} settling`);
  assert.equal(scan.status, 'complete', scan.error);
  return scan;
}

test('the scanned-root rule grants the folder by its own path and by the link’s spelling, and never the link itself: a delete dry run answers for both spellings', { skip: NO_LINKS }, async () => {
  const f = linkTree();
  await updateSettings({ engine: 'walker' });
  process.env.TREEMAP_NO_GDU = '1';
  const { port, close } = await listen();
  try {
    const scan = await scanOverHttp(port, f.link);
    assert.equal(scan.rootPath, f.real);
    const real = path.join(f.real, 'a.txt');
    const through = path.join(f.link, 'a.txt');
    assert.equal(insideAnyScanRoot(real), true, 'by its own path');
    assert.equal(insideAnyScanRoot(through), true, 'through the link: the same file');
    assert.equal(insideAnyScanRoot(path.join(f.link, 'sub', 'b.txt')), true, 'deeper through the link too');
    assert.equal(insideAnyScanRoot(f.link), false, 'the link itself lies outside the folder, and no walk listed it');

    const byReal = await req(port, 'DELETE', '/api/files', { paths: [real], dryRun: true });
    assert.equal(byReal.status, 200, JSON.stringify(byReal.body));
    assert.deepEqual(byReal.body.wouldTrash, [{ path: real, bytes: 1000 }]);
    const byLink = await req(port, 'DELETE', '/api/files', { paths: [through], dryRun: true });
    assert.equal(byLink.status, 200, `the same file, spelled through the link: ${JSON.stringify(byLink.body)}`);
    assert.deepEqual(byLink.body.wouldTrash.map((w: { path: string }) => w.path), [through]);
    const theLink = await req(port, 'DELETE', '/api/files', { paths: [f.link], dryRun: true });
    assert.equal(theLink.status, 403, JSON.stringify(theLink.body));
    assert.equal(theLink.body.code, 'OUTSIDE_SCAN_ROOT');
  } finally {
    await close();
  }
  assert.ok(fs.existsSync(path.join(f.real, 'a.txt')) && fs.existsSync(f.link), 'dry runs touched nothing');
});

test('an agent policy’s allowed roots confine where a link root leads: a link in an allowed root to a folder outside them is refused; a folder an allowed root names by a link is followed', { skip: NO_LINKS }, async () => {
  const f = linkTree();
  const allowed = path.join(f.base, 'allowed');
  fs.mkdirSync(allowed);
  const out = path.join(allowed, 'out');
  fs.symlinkSync(f.real, out, 'dir');
  const policyFile = path.join(DATA_DIR, 'agent-policy.json');
  await updateSettings({ engine: 'walker' });
  process.env.TREEMAP_NO_GDU = '1';
  const { port, close } = await listen();
  try {
    fs.writeFileSync(policyFile, JSON.stringify({ allowedRoots: [allowed] }));
    const refused = await req(port, 'POST', '/api/scan', { path: out });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'POLICY_ROOT_NOT_ALLOWED');
    assert.ok(String(refused.body.error).includes(out), `the sentence names the path asked for: ${refused.body.error}`);
    assert.ok(!String(refused.body.error).includes(f.real), `and not where it leads, outside every allowed root: ${refused.body.error}`);

    fs.writeFileSync(policyFile, JSON.stringify({ allowedRoots: [f.link] }));
    const followed = await scanOverHttp(port, f.link);
    assert.equal(followed.rootPath, f.real, 'the allowed root is the folder, named by its link');
  } finally {
    fs.rmSync(policyFile, { force: true });
    await close();
  }
});
