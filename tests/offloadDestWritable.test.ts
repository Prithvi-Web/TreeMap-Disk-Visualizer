import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadDestWritable-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord, peekScan } from '../src/services/diskScanner';
import { prepareOffload, setOffloadDeviceForTests } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { readAudit } from '../src/services/audit';
import { AppError } from '../src/middleware/errorHandler';
import type { ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { dataVolumeAlias, firmlinkAliases, mountedReadOnly, parseFirmlinks, setBoundaryDepsForTests, type BoundaryDeps } from '../src/utils/mountBoundaries';
import { parseBsdMount, parseProcMounts } from '../src/platform/atime';

/**
 * An offload's dry run refuses a destination it cannot write to (sixth browser pass H02). A sealed,
 * read-only volume answered the dry run 200 and the sheet said "Copy, verify, then trash"; the real
 * run would fail at its first copy. AGENTS.md promises that a dry run that succeeds means the real run
 * would act, so the write check is made where both runs plan: prepareOffload. A dry run and a real run
 * refuse alike, with their own code, before anything is copied.
 *
 * The read-only folder is a folder made read-only with chmod. On Windows a folder's write permission
 * is an ACL that fs.access does not read — it reports every folder writable — so there the check would
 * promise what it cannot know, and is not made (the real run's first copy finds it, and rolls back).
 * Root ignores permission bits, so a run as root skips too. Nothing reaches the machine's Trash.
 */

const WHY_SKIP = process.platform === 'win32'
  ? 'Windows keeps a folder\'s write permission in an ACL fs.access does not read, so the check is not made there'
  : typeof process.getuid === 'function' && process.getuid() === 0
    ? 'root may write into a read-only folder, so chmod cannot make one here'
    : false;

const FAKE_TRASH = fileTempDir('treemap-offloadDestWritable-trash-');
const trashed: string[] = [];
let restoreDevice: () => void = () => {};

before(() => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  // Every folder a test can make is on the runner's one drive; the destination here stands for
  // another drive, so the same-drive refusal (E01) is not the one met.
  restoreDevice = setOffloadDeviceForTests(async (_p, end) => (end === 'source' ? 1n : 2n));
});
after(() => {
  restoreDevice();
  setTrashStepForTests(null);
});

/** proj/ holding a.txt (1,000 bytes) under a fresh root, a complete scan listing it, and an empty destination beside it. */
function project(label: string): { root: string; proj: string; a: string; dest: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadDestWritable-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.txt');
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(root), path: root, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{
      name: 'proj', path: proj, size: 1000, type: 'dir', modifiedAt: Date.now(), isHidden: false,
      children: [{ name: 'a.txt', path: a, size: 1000, type: 'file', modifiedAt: Date.now(), isHidden: false }],
    }],
  };
  const dest = fs.realpathSync(fileTempDir(`treemap-offloadDestWritable-${label}-dest-`));
  return { root, proj, a, dest, scan };
}

/** Runs `fn` with `dir` read-only (r-x for everyone), and makes it writable again however `fn` ends. */
async function readOnly<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  fs.chmodSync(dir, 0o555);
  try {
    return await fn();
  } finally {
    fs.chmodSync(dir, 0o755);
  }
}

function post(port: number, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

test('prepareOffload refuses a destination it cannot write to with DEST_NOT_WRITABLE, and plans once it can (H02)', { skip: WHY_SKIP }, async () => {
  const { proj, dest, scan } = project('plan');
  await readOnly(dest, async () => {
    assert.throws(() => fs.writeFileSync(path.join(dest, 'probe'), 'x'), 'control: the folder really is read-only to this process');
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)), (e: unknown) => {
      assert.ok(e instanceof AppError, `an AppError, not ${String(e)}`);
      assert.equal(e.code, 'DEST_NOT_WRITABLE', 'refused by its own code');
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(`"${path.basename(dest)}" cannot be written to`), 'names the folder');
      assert.match(e.message, /permission to add files/, 'says why, in words');
      assert.match(e.message, /Nothing was copied or deleted\./, 'and that nothing happened');
      return true;
    });
  });
  const plan = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.equal(plan.plan.length, 1, 'control: writable again, the same destination plans its one copy');
});

test('a destination on a read-only drive, or one whose write check fails some other way, is refused too, each saying why in words (review F1.10)', {
  skip: process.platform === 'win32' && 'Windows keeps a folder\'s write permission in an ACL fs.access does not read, so the check is not made there',
}, async () => {
  const { proj, dest, scan } = project('codes');
  // A read-only volume cannot be mounted by a test, so the write check itself is made to answer as one
  // would — for the destination alone; every other path is asked for real.
  const realAccess = fs.promises.access;
  const answer = (code: string): void => {
    fs.promises.access = (async (p: fs.PathLike, mode?: number) => {
      if (path.resolve(String(p)) === dest) throw Object.assign(new Error(`${code}: stand-in`), { code });
      return realAccess(p, mode);
    }) as typeof fs.promises.access;
  };
  try {
    for (const [code, said] of [
      ['EROFS', /: it is on a drive that is read-only\./],
      ['EIO', /: TreeMap could not confirm it may write there \(EIO\)\./],
    ] as const) {
      answer(code);
      await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)), (e: unknown) => {
        assert.ok(e instanceof AppError, `${code}: an AppError, not ${String(e)}`);
        assert.equal(e.code, 'DEST_NOT_WRITABLE', `${code}: refused by its own code`);
        assert.match(e.message, said, `${code}: says why, in words`);
        assert.doesNotMatch(e.message, /permission to add files/, `${code}: not said to be a matter of permission`);
        assert.match(e.message, /Nothing was copied or deleted\./, `${code}: and that nothing happened`);
        return true;
      });
    }
  } finally {
    fs.promises.access = realAccess;
  }
  const plan = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.equal(plan.plan.length, 1, 'control: asked for real again, the same destination plans its one copy');
});

/* ── Seventh browser pass J54: a sealed read-only volume is said to be read-only, not a matter of permission ── */

/** This Mac's own mount table and firmlinks, as `mount` and /usr/share/firmlinks print them (18 Oct 2026, trimmed). */
const MAC_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  '/Applications/Clocks.app/Wrapper on /private/var/folders/7x/X/4B95 (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by me)',
  '/dev/disk7s1 on /Library/Developer/CoreSimulator/Volumes/iOS_22E238 (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)',
  '/dev/disk8s1 on /Volumes/Archive (exfat, local, nodev, nosuid, read-only, noowners)',
  '/dev/disk9s1 on /Volumes/Backup (apfs, local, nodev, nosuid, journaled, noowners)',
].join('\n');
const MAC_FIRMLINKS = ['/Applications\tApplications', '/Library\tLibrary', '/Users\tUsers', '/Volumes\tVolumes', '/private\tprivate', '/usr/local\tusr/local'].join('\n');

/**
 * Boundary deps answering from `table` (null: unreadable) and `aliases` (firmlinks as the file spells them),
 * every path being where it is spelled but for `links`: a link's path and where it leads (review F1.10).
 */
function tableDeps(table: string | null, parse: (t: string) => ReturnType<typeof parseBsdMount>, aliases = '', platform: NodeJS.Platform = 'darwin',
  links: Record<string, string> = {}): Partial<BoundaryDeps> {
  return {
    platform,
    readTable: async () => (table === null
      ? { source: 'mount' as const, entries: null, reason: 'mount: stand-in failure' }
      : { source: 'mount' as const, entries: parse(table), reason: null }),
    realpath: async (p: string) => {
      for (const [link, to] of Object.entries(links)) if (p === link || p.startsWith(`${link}/`)) return to + p.slice(link.length);
      return p;
    },
    aliases: async () => (aliases ? firmlinkAliases(parseFirmlinks(aliases)) : () => []),
  };
}

test('mountedReadOnly reads the drive a path is on from the mount table: the deepest mount along its path, through the firmlinks — a sealed root does not make the Data volume read-only (J54)', async () => {
  const mac = tableDeps(MAC_MOUNT, parseBsdMount, MAC_FIRMLINKS) as BoundaryDeps;
  const cases: Array<[string, boolean]> = [
    ['/Library/Developer/CoreSimulator/Volumes/iOS_22E238/Library/Developer', true], // QA's sealed simulator volume
    ['/Library/Developer/CoreSimulator/Volumes/iOS_22E238', true],
    ['/Users/me/Offload', false],            // on the Data volume, through the /Users firmlink — not the sealed root
    ['/System/Volumes/Data/Users/me', false], // the same folder, in the Data volume's own spelling
    ['/Library/Caches', false],               // the Data volume's /Library
    ['/Volumes/Archive/old', true],           // a read-only drive under /Volumes, itself firmlinked
    ['/Volumes/Backup/2026', false],          // a writable one beside it
    ['/private/var/folders/7x/X/4B95/Contents', true], // inside a read-only nullfs view
    ['/private/var/folders/7x/X', false],
    ['/System/Library/Frameworks', true],     // the sealed system volume itself
  ];
  for (const [p, want] of cases) assert.equal(await mountedReadOnly(p, mac), want, `${p}: ${want ? 'read-only' : 'writable'}`);
  const linux = tableDeps([
    '/dev/sda1 / ext4 rw,relatime 0 0',
    '/dev/sdb1 /mnt/ro ext4 ro,relatime 0 0',
    '/dev/sdc1 /mnt/ro/inner ext4 rw,relatime 0 0',
    '/srv/data /mnt/bind\\040ro none ro,bind 0 0',
    '/dev/sdd1 /mnt/stack ext4 rw,relatime 0 0',
    '/dev/sde1 /mnt/stack ext4 ro,relatime 0 0', // mounted over the one above: the later is on top
    '/dev/sdf1 /mnt/restack ext4 ro,relatime 0 0',
    '/dev/sdg1 /mnt/restack ext4 rw,relatime 0 0',
  ].join('\n'), parseProcMounts, '', 'linux') as BoundaryDeps;
  for (const [p, want] of [
    ['/home/me', false], ['/mnt/ro/x', true], ['/mnt/ro/inner/x', false], ['/mnt/bind ro/y', true], ['/mnt/robot', false],
    ['/mnt/stack/x', true], ['/mnt/restack/x', false],
  ] as const) {
    assert.equal(await mountedReadOnly(p, linux), want, `linux ${p}: ${want ? 'read-only' : 'writable'}`);
  }
  assert.equal(await mountedReadOnly('/Users/me', tableDeps(null, parseBsdMount) as BoundaryDeps), null, 'a table that cannot be read is unknown, never "writable"');
  const partial = tableDeps('/dev/sdb1 /mnt/ro ext4 ro,relatime 0 0', parseProcMounts, '', 'linux') as BoundaryDeps;
  assert.equal(await mountedReadOnly('/home/me', partial), null, 'a table that names no mount holding the path is unknown too, never "writable"');
});

test('mountedReadOnly follows a destination\'s links to the drive it is really on — into a read-only volume, out of one — and a link it cannot follow is judged as spelled (review F1.10)', async () => {
  const links = {
    '/Users/me/sim': '/Library/Developer/CoreSimulator/Volumes/iOS_22E238', // a home-folder link into QA's sealed simulator volume
    '/Volumes/Archive/out': '/Users/me/elsewhere',                       // a link on the read-only drive, leading off it
  };
  const mac = tableDeps(MAC_MOUNT, parseBsdMount, MAC_FIRMLINKS, 'darwin', links) as BoundaryDeps;
  assert.equal(await mountedReadOnly('/Users/me/sim/Library/Developer', mac), true, 'a link into a read-only volume: read-only, where its own spelling is on the writable Data volume');
  assert.equal(await mountedReadOnly('/Volumes/Archive/out/2026', mac), false, 'a link out of a read-only drive onto the Data volume: writable, where its own spelling is on the read-only drive');
  assert.equal(await mountedReadOnly('/Users/me/sim', mac), true, 'the link itself: the volume it leads to');
  // A realpath that fails (the folder is gone, or will not answer): the path as typed, never a throw.
  const broken = { ...mac, realpath: async () => { throw Object.assign(new Error('ENOENT: stand-in'), { code: 'ENOENT' }); } } as BoundaryDeps;
  assert.equal(await mountedReadOnly('/Volumes/Archive/missing', broken).catch((e: Error) => `threw ${e.message}`), true, 'a path realpath cannot follow is judged as typed: on the read-only drive');
  assert.equal(await mountedReadOnly('/Users/me/missing', broken).catch((e: Error) => `threw ${e.message}`), false, 'and one typed under /Users is on the Data volume, through the firmlinks');
});

test('where the firmlinks cannot be read, a folder that only the sealed root\'s mount holds is unknown, never called read-only — a home folder reaches the writable Data volume through a firmlink the table cannot show (review F1.6)', async () => {
  const oneWay = { ...(tableDeps(MAC_MOUNT, parseBsdMount) as BoundaryDeps), aliases: async () => dataVolumeAlias };
  const failing = { ...oneWay, aliases: async () => { throw new Error('firmlinks: stand-in failure'); } };
  for (const [what, deps] of [['the one-way fallback', oneWay], ['an aliases call that fails', failing]] as const) {
    for (const [p, want] of [
      ['/Users/me/Offload', null],          // on the Data volume through /Users — the table cannot say
      ['/System/Library/Frameworks', null], // truly on the sealed root — but nothing tells the two apart
      ['/Library/Developer/CoreSimulator/Volumes/iOS_22E238/Library', true], // its own read-only mount, along its path
      ['/Volumes/Archive/old', true],       // a read-only drive mounted along its path
      ['/Volumes/Backup/2026', false],      // a writable one
      ['/System/Volumes/Data/Users/me', false], // the Data volume in its own spelling
    ] as const) {
      assert.equal(await mountedReadOnly(p, deps), want, `${what}, ${p}: ${want === null ? 'unknown' : want ? 'read-only' : 'writable'}`);
    }
  }
});

test('a destination on a drive mounted read-only is refused as read-only even where the write check answers "permission denied" first, as macOS does for a root-owned folder on a sealed volume (J54)', {
  skip: process.platform === 'win32' && 'Windows keeps a folder\'s write permission in an ACL fs.access does not read, so the check is not made there',
}, async () => {
  const { proj, dest, scan } = project('rdonly');
  // macOS answers access() with EACCES before EROFS for a root-owned 755 folder on a read-only
  // mount (QA B/shots/141). A test cannot mount a read-only volume, so the write check answers as
  // that folder did, and the mount table is a stand-in that lists the destination as its own mount.
  const realAccess = fs.promises.access;
  fs.promises.access = (async (p: fs.PathLike, mode?: number) => {
    if (path.resolve(String(p)) === dest) throw Object.assign(new Error('EACCES: stand-in'), { code: 'EACCES' });
    return realAccess(p, mode);
  }) as typeof fs.promises.access;
  const refusal = async (table: string | null, aliases?: typeof dataVolumeAlias): Promise<string> => {
    setBoundaryDepsForTests(aliases ? { ...tableDeps(table, parseBsdMount), aliases: async () => aliases } : tableDeps(table, parseBsdMount));
    try {
      let message = '';
      await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)), (e: unknown) => {
        assert.ok(e instanceof AppError, `an AppError, not ${String(e)}`);
        assert.equal(e.code, 'DEST_NOT_WRITABLE', 'refused by its own code');
        assert.match(e.message, /Nothing was copied or deleted\./, 'and that nothing happened');
        message = e.message;
        return true;
      });
      return message;
    } finally {
      setBoundaryDepsForTests(null);
    }
  };
  try {
    const sealed = await refusal(`/dev/disk3s5 on / (apfs, local, journaled)\n/dev/disk7s1 on ${dest} (apfs, sealed, local, nodev, nosuid, read-only, journaled)`);
    assert.match(sealed, /: it is on a drive that is read-only\./, `on a read-only mount it says so (${sealed})`);
    assert.doesNotMatch(sealed, /permission/, 'and not that it is a matter of permission');
    const writable = await refusal(`/dev/disk3s5 on / (apfs, local, journaled)\n/dev/disk7s1 on ${dest} (apfs, local, journaled)`);
    assert.match(writable, /: you do not have permission to add files to it\./, `control: on a writable drive it is permission (${writable})`);
    const unknown = await refusal(null);
    assert.match(unknown, /: you do not have permission to add files to it\./, `a table that cannot be read leaves the write check's own answer (${unknown})`);
    // A Mac whose firmlinks cannot be read, the destination held only by the sealed root's mount (review F1.6):
    // it may be on the Data volume, so it is not called read-only.
    const noFirmlinks = await refusal('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)', dataVolumeAlias);
    assert.match(noFirmlinks, /: you do not have permission to add files to it\./, `without the firmlinks, the sealed root does not make it read-only (${noFirmlinks})`);
    assert.doesNotMatch(noFirmlinks, /read-only/, 'and the refusal does not say so');
  } finally {
    fs.promises.access = realAccess;
  }
  const plan = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.equal(plan.plan.length, 1, 'control: asked for real again, the same destination plans its one copy');
});

test('POST /api/offload refuses a read-only destination — DEST_NOT_WRITABLE, a dry run and a real run alike, audited, and nothing copied or trashed (H02)', { skip: WHY_SKIP }, async () => {
  const { root, proj, a, dest } = project('route');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await post(port, '/api/scan', { path: root });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan settling');
    await readOnly(dest, async () => {
      for (const dryRun of [true, false]) {
        const before = trashed.length;
        const r = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun }));
        assert.equal(r.status, 400, `dryRun ${dryRun}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'DEST_NOT_WRITABLE', `dryRun ${dryRun}: refused by its own code`);
        assert.deepEqual(fs.readdirSync(dest), [], `dryRun ${dryRun}: nothing was copied`);
        assert.ok(fs.existsSync(a), `dryRun ${dryRun}: the original is where it was`);
        assert.equal(trashed.length, before, `dryRun ${dryRun}: nothing went to the Trash`);
        const [last] = await readAudit(1);
        assert.deepEqual({ action: last?.action, outcome: last?.outcome, code: last?.code, dryRun: last?.dryRun },
          { action: 'offload.start', outcome: 'refused', code: 'DEST_NOT_WRITABLE', dryRun }, `dryRun ${dryRun}: the refusal is in the audit log`);
      }
    });
    const ok = await withOpenFileCheck('clear', () => post(port, '/api/offload', { scanId: started.body.scanId, paths: [proj], dest, dryRun: true }));
    assert.equal(ok.status, 200, `control: writable again, the dry run plans (${JSON.stringify(ok.body)})`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the refusal is documented where an agent reads the offload: the OpenAPI document, the MCP tool and AGENTS.md (H02)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>> };
  assert.match(String(doc.paths['/api/offload'].post.responses['400'].description), /DEST_NOT_WRITABLE[^;]*cannot write/,
    'the document names the code and says what it means');
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.ts'), 'utf8');
  const tool = mcp.slice(mcp.indexOf("'offload',"), mcp.indexOf('inputSchema', mcp.indexOf("'offload',")));
  assert.match(tool, /DEST_NOT_WRITABLE/, 'the MCP offload tool names the refusal');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const offloadSection = agents.slice(agents.indexOf('`POST /api/offload` with `{ scanId, paths, dest }`'), agents.indexOf('`POST /api/cart/commit` with `{ paths }`'));
  assert.match(offloadSection, /`400 DEST_NOT_WRITABLE`/, 'AGENTS.md\'s offload section lists it among its refusals');
  assert.match(offloadSection, /dry run included \(`400 DEST_NOT_WRITABLE`\)/, 'as refused by a dry run too');
  assert.match(offloadSection, /on\s+Windows[^;]*?it is not\s+checked, and the real run's first copy finds it/, 'and says where the check is not made, and what finds it there');
});
