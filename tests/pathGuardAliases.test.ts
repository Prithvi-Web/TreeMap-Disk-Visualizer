import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-pathGuardAliases-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server';
import { createApp } from '../src/server';
import { ENDPOINTS } from '../src/api/openapi';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { insideAnyScanRoot } from '../src/middleware/pathGuard';
import { aliasNamespaceOf, judgeSpelling, PathRejectedError, resolveAsTyped, sanitizePath } from '../src/utils/pathSanitizer';
import { createScanRecord, evictExpiredScans, SCAN_TTL_MS, startScan } from '../src/services/diskScanner';
import { setLaunchStepForTests, setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { boundaryRecord } from '../src/utils/mountBoundaries';
import type { ScanResult } from '../src/models/types';

/**
 * The SEC-1 review, M1: a path's second names.
 *
 * macOS answers three names at the root of the boot volume for any path on any
 * mounted volume — `/.nofollow/<path>`, `/.resolve/<flags>/<path>` and
 * `/.vol/<device>/<inode>/…` — and realpath gives the first back unchanged and
 * cannot resolve the other two, while lstat, open and rename go through all
 * three. Neither the blocklist nor the scanned-root rule could see where such a
 * spelling lands: after a scan of / that did not enter /Volumes, a delete of
 * `/.nofollow/Volumes/Backup/f.txt` was granted, and `/.nofollow/private/var/db`
 * walked past the blocklist. Windows has the same in its device namespaces
 * (`\\?\Volume{…}\`, `\\?\GLOBALROOT\…`, `\\.\PhysicalDrive0`, `\??\`).
 *
 * The rule: every such spelling is refused by the sanitizer, 400 PATH_BLOCKED,
 * on every route and MCP tool that takes a path; and the scanned-root rule
 * refuses one on its own, so a caller that skipped the sanitizer still gets no
 * grant. Nothing here is mounted, and every request is a dry run or is refused
 * before it acts: the trash and launch steps are stubbed to fail loudly.
 */

const REPO = path.join(__dirname, '..');
const DARWIN = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';

/** The scanned folder, by its real path: a.txt and b.txt (one content), sub/, occupied.txt. */
const T = fs.realpathSync(fileTempDir('treemap-alias-root-'));
fs.writeFileSync(path.join(T, 'a.txt'), 'same');
fs.writeFileSync(path.join(T, 'b.txt'), 'same');
fs.mkdirSync(path.join(T, 'sub'));
fs.writeFileSync(path.join(T, 'occupied.txt'), 'already here');
/** A destination outside the scan. */
const DEST = fs.realpathSync(fileTempDir('treemap-alias-dest-'));

/**
 * Second names of a path on this platform, each a function of the plain path.
 * macOS: the kernel's three (and one in another case, since APFS folds it).
 * Linux has no such namespace of its own; /proc/self/root is its nearest, and
 * the blocklist already refuses /proc. Windows: a volume reached through the
 * object manager instead of its drive letter.
 */
function spellings(): { name: string; of: (p: string) => string }[] {
  if (DARWIN) {
    const st = fs.lstatSync(T);
    return [
      { name: '/.nofollow', of: (p) => `/.nofollow${p}` },
      { name: '/.resolve/1', of: (p) => `/.resolve/1${p}` },
      { name: '/.vol/<dev>/<ino>', of: (p) => `/.vol/${st.dev}/${st.ino}${p.slice(T.length)}` },
      { name: '/.Nofollow (another case)', of: (p) => `/.Nofollow${p}` },
    ];
  }
  if (WINDOWS) return [{ name: '\\\\?\\GLOBALROOT', of: (p) => `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1${p.slice(2)}` }];
  return [{ name: '/proc/self/root', of: (p) => `/proc/self/root${p}` }];
}

let port = 0;
let server: http.Server;
let client: Client;
let scan: ScanResult;
const acted: string[] = [];

before(async () => {
  setTrashStepForTests(async (p) => {
    acted.push(`trash ${p}`);
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  setLaunchStepForTests(async (command) => {
    acted.push(`launch ${JSON.stringify(command)}`);
    throw new Error('no test here may open anything');
  });
  server = http.createServer(createApp(path.join(REPO, 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'treemap-path-guard-aliases-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  await updateSettings({ engine: 'walker' });
  scan = await startScan(T);
  await waitFor(() => scan.status !== 'running', `the scan of ${T}`);
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  setLaunchStepForTests(null);
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(acted, [], 'nothing was trashed or opened');
});

interface Answer {
  status: number;
  body: any;
}

function request(method: string, url: string, body?: unknown): Promise<Answer> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = (await client.callTool({ name, arguments: args })) as { content?: { text: string }[] };
  return reply.content?.[0]?.text ?? '';
}

function rejection(p: string): string | null {
  try {
    sanitizePath(p);
    return null;
  } catch (err) {
    return err instanceof PathRejectedError ? err.code : `threw ${String(err)}`;
  }
}

/* ─────────────── The spellings, as strings ─────────────── */

test('macOS: /.nofollow, /.resolve and /.vol at the root, in any case, are second names; nothing else is', () => {
  for (const p of ['/.nofollow', '/.nofollow/Volumes/Backup/f.txt', '/.resolve/1/Volumes/Backup/f.txt', '/.resolve', '/.vol/16777234/2/f.txt', '/.vol', '/.NoFollow/x', '/.VOL/1/2', '/.Resolve/3/x']) {
    assert.notEqual(aliasNamespaceOf(p, 'darwin'), null, p);
  }
  for (const p of ['/', '/.nofollowing/x', '/.volumes/x', '/nofollow/x', '/Users/me/.vol/x', '/Users/me/.nofollow', '/private/.resolve/1/x', '/System/Volumes/Data/.vol/1/2']) {
    assert.equal(aliasNamespaceOf(p, 'darwin'), null, p);
  }
  assert.equal(aliasNamespaceOf('/.nofollow/x', 'linux'), null, 'a folder of that name on Linux is a folder');
});

test('Windows: a device or object-manager spelling is refused unless a drive-letter or UNC path stands behind it', () => {
  for (const p of [
    '\\\\?\\Volume{0c8f4a3e-1d2b-4c5e-9f00-0123456789ab}\\Users\\x',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\Windows\\System32',
    '\\\\.\\PhysicalDrive0',
    '\\\\.\\C:',
    '\\\\?\\C:',
    '\\\\.\\pipe\\x',
    '//./pipe/x',
    '\\??\\C:\\Windows\\System32',
    '/??/C:/x',
    '\\\\?\\UNC\\server',
  ]) {
    assert.notEqual(aliasNamespaceOf(p, 'win32'), null, p);
  }
  for (const p of ['C:\\Users\\x', 'c:/users/x', '\\\\server\\share\\x', '\\\\?\\C:\\Users\\x', '//?/c:/users/x', '\\\\.\\D:\\data', '\\\\?\\UNC\\server\\share\\x']) {
    assert.equal(aliasNamespaceOf(p, 'win32'), null, p);
  }
  assert.equal(aliasNamespaceOf('\\\\?\\GLOBALROOT\\x', 'darwin'), null, 'on macOS that is a relative name like any other');
});

test('Windows: a drive’s root behind \\\\?\\ or \\\\.\\ is the drive’s root folder, though resolving drops its separator; the volume itself, typed with none, is still refused (the SEC-2 review, F5)', () => {
  // path.win32.resolve('\\\\?\\C:\\') is '\\\\?\\C:' — the spelling of the volume device — so the
  // sanitizer refused the root folder of every drive spelled behind a long-path prefix.
  for (const p of ['\\\\?\\C:\\', '\\\\.\\C:\\', '//?/c:/', '\\\\?\\D:\\', '\\\\?\\C:\\.', '\\\\?\\C:\\Windows\\..']) {
    const verdict = judgeSpelling(p, 'win32');
    assert.deepEqual([verdict.secondName, verdict.blocked], [null, false], `${p}: ${JSON.stringify(verdict)}`);
    assert.match(verdict.resolved, /^\\\\[?.]\\[a-z]:\\$/i, `${p} resolves to the drive’s root folder: ${verdict.resolved}`);
  }
  for (const p of ['\\\\?\\C:', '\\\\.\\C:', '\\\\.\\C:.', '//?/c:']) {
    assert.notEqual(judgeSpelling(p, 'win32').secondName, null, `${p}: the volume itself`);
  }
  assert.equal(resolveAsTyped('\\\\?\\C:', 'win32'), '\\\\?\\C:', 'typed without a separator, the device is still spelled as the device');
  assert.equal(judgeSpelling('\\\\?\\C:\\Windows\\System32', 'win32').blocked, true, 'the blocklist still sees through the prefix');
  assert.deepEqual(judgeSpelling('\\\\?\\C:\\Users\\me', 'win32'), { resolved: '\\\\?\\C:\\Users\\me', secondName: null, blocked: false });
});

test('Windows: this machine’s own admin shares and an NTFS stream name are second names, refused by the sanitizer and the scanned-root rule; another machine’s share and an ordinary share are paths (the SEC-2 review, LOW-3)', () => {
  // \\localhost\C$\Windows\System32\config\SAM is C:\Windows\System32\config\SAM, and
  // C:\Windows\System32::$INDEX_ALLOCATION is the folder itself, yet neither string starts with a
  // blocked one. `own` stands for this machine's names, so the test reads no real ones.
  const own = ['MYPC', '192.168.1.20'];
  const refused = [
    '\\\\localhost\\C$\\Windows\\System32\\config\\SAM',
    '\\\\LOCALHOST\\c$',
    '\\\\127.0.0.1\\c$\\windows\\system32',
    '\\\\127.0.0.2\\D$\\x',
    '\\\\?\\UNC\\localhost\\C$\\Windows\\System32\\config\\SAM',
    '\\\\.\\UNC\\127.0.0.1\\C$\\x',
    '\\\\?\\UNC\\.\\C$\\x',
    '\\\\localhost.\\C$\\x',
    '//localhost/c$/windows',
    '\\\\mypc\\C$\\Users',
    '\\\\MyPC.corp.example.com\\C$\\Users',
    '\\\\192.168.1.20\\C$\\Users',
    '\\\\localhost\\ADMIN$\\System32',
    '\\\\0--1.ipv6-literal.net\\C$\\x',
    'C:\\Windows\\System32::$INDEX_ALLOCATION',
    'C:\\Windows::$INDEX_ALLOCATION\\System32',
    '\\\\?\\C:\\Windows\\System32::$INDEX_ALLOCATION',
    'C:\\Windows\\System32:$I30:$INDEX_ALLOCATION',
    'c:/windows/system32::$index_allocation',
    'C:\\Users\\me\\f.txt:Zone.Identifier',
    '\\\\server\\share\\f.txt::$DATA',
  ];
  for (const p of refused) {
    assert.notEqual(aliasNamespaceOf(p, 'win32', own), null, `${p}: a second name`);
    assert.notEqual(judgeSpelling(p, 'win32', own).secondName, null, `${p}: refused by the sanitizer`);
  }
  for (const p of [
    '\\\\server\\C$\\x', '\\\\fileserver\\D$\\backups', '\\\\192.168.1.21\\C$\\x', '\\\\mypc2\\C$\\x', '\\\\localhost\\share\\x',
    '\\\\mypc\\Users\\x', '\\\\?\\UNC\\server\\share\\x', 'C:\\Users\\x', 'C:', 'C:foo', '\\\\?\\C:\\Users',
  ]) {
    assert.equal(aliasNamespaceOf(p, 'win32', own), null, p);
  }
  // Asked nothing, the rule knows this machine by its own name.
  assert.notEqual(aliasNamespaceOf(`\\\\${os.hostname()}\\C$\\x`, 'win32'), null, `this machine, ${os.hostname()}, by its own name`);
  // TreeMap's own cloud identifiers are no spelling of the OS's: the colon there is the scheme's.
  for (const p of ['cloud://gdrive/x/empty', 'cloud://onedrive/a:b']) assert.equal(aliasNamespaceOf(p, 'win32', own), null, p);
  for (const p of ['/Users/me/a:b', '/x/f.txt::$DATA', '/localhost/C$/x']) {
    assert.equal(aliasNamespaceOf(p, 'darwin'), null, `${p}: on macOS a name`);
    assert.equal(aliasNamespaceOf(p, 'linux'), null, `${p}: on Linux a name`);
  }
});

/* ─────────────── The sanitizer ─────────────── */

test('the sanitizer refuses every second name, PATH_BLOCKED: past the blocklist, onto another drive, or onto a scanned file', { skip: !DARWIN && 'the namespaces are macOS’s; Windows has its own test below' }, () => {
  for (const { name, of } of spellings()) {
    assert.equal(rejection(of(path.join(T, 'a.txt'))), 'PATH_BLOCKED', `${name}: a scanned file`);
    assert.equal(rejection(of(T)), 'PATH_BLOCKED', `${name}: the scanned folder`);
  }
  for (const p of ['/.nofollow/private/var/db/dslocal/x', '/.resolve/1/private/var/db/dslocal/x', '/.nofollow/Volumes/Backup/f.txt', '/.nofollow', '/.vol', '/.resolve', '/.NOFOLLOW/dev/null']) {
    assert.equal(rejection(p), 'PATH_BLOCKED', p);
  }
  // Refused as a second name, before any look at the disk — not as whatever the blocklist made of it.
  assert.throws(() => sanitizePath('/.vol/1/2/f.txt'), (err: Error) => /through \/\.vol, a second name the system gives it/.test(err.message));
  assert.equal(sanitizePath(path.join(T, 'a.txt')), path.join(T, 'a.txt'), 'the plain spelling still passes');
});

test('a link whose target is spelled through /.nofollow is judged where it leads, and refused', { skip: !DARWIN && 'the namespace is macOS’s' }, () => {
  const holder = fs.realpathSync(fileTempDir('treemap-alias-link-'));
  fs.mkdirSync(path.join(holder, 'target'));
  fs.symlinkSync(`/.nofollow${path.join(holder, 'target')}`, path.join(holder, 'via'));
  assert.equal(rejection(path.join(holder, 'via', 'f.txt')), 'PATH_BLOCKED', 'a file beneath the link');
  assert.equal(rejection(path.join(holder, 'target', 'f.txt')), null, 'the target by its own name is an ordinary path');
});

test('Windows: the sanitizer refuses a device spelling and keeps a drive-letter one behind \\\\?\\', { skip: !WINDOWS && 'Windows path rules' }, () => {
  for (const p of ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Users', '\\\\.\\PhysicalDrive0', '\\\\.\\C:', '\\??\\C:\\Windows']) {
    assert.equal(rejection(p), 'PATH_BLOCKED', p);
  }
  assert.equal(rejection(`\\\\?\\${T}`), null, 'a long-path spelling of an ordinary folder');
  assert.equal(rejection('\\\\?\\C:\\Windows\\System32'), 'PATH_BLOCKED', 'and the blocklist sees through it');
});

/* ─────────────── The scanned-root rule, on its own ─────────────── */

test('after a scan of / that did not enter a drive, a second name of that drive is outside every scan — even with no sanitizer in front', { skip: !DARWIN && 'the namespaces are macOS’s' }, async () => {
  const mnt = path.join(T, 'sub');
  // Only the record of / below: the scan of T would list T/sub itself.
  evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
  const slash = createScanRecord('/');
  slash.status = 'complete';
  slash.finishedAt = Date.now();
  slash.boundary = boundaryRecord({
    rule: 'stay', source: 'mount', reason: null,
    mounts: [{ path: mnt, filesystem: 'apfs', source: '/dev/disk99s1', underFixed: false }],
    fixed: ['/System/Volumes', '/Volumes'], neverDescend: ['/System/Volumes', '/Volumes', mnt],
  });
  try {
    assert.equal(insideAnyScanRoot(path.join(mnt, 'f.txt')), false, 'the plain spelling of the drive is refused (U-25)');
    assert.equal(insideAnyScanRoot(path.join(T, 'a.txt')), true, 'a file the scan of / listed is inside');
    for (const { name, of } of spellings()) {
      assert.equal(insideAnyScanRoot(of(path.join(mnt, 'f.txt'))), false, `${name}: a file on the drive not entered`);
      assert.equal(insideAnyScanRoot(of(path.join(T, 'a.txt'))), false, `${name}: even a listed file, by a name that is not its own`);
    }
    assert.equal(insideAnyScanRoot('/.nofollow/Volumes/Backup/f.txt'), false, '/Volumes, which no walk of / enters');
    assert.equal(insideAnyScanRoot('/.resolve/1/Volumes/Backup/f.txt'), false);
    // A link the scan of / listed, leading to the drive through /.nofollow: where it lives is a second name.
    const link = path.join(T, 'to-drive');
    fs.symlinkSync(`/.nofollow${mnt}`, link);
    assert.equal(insideAnyScanRoot(path.join(link, 'f.txt')), false, 'a file beneath a link that leads through /.nofollow');
    // The link itself lives in the scan, but the sanitizer judges a link where it leads and refuses it,
    // and opening or previewing it would follow it there: the rule agrees (the SEC-2 review, F3).
    assert.equal(insideAnyScanRoot(link), false, 'nor the link itself');
    assert.equal(rejection(link), 'PATH_BLOCKED', 'which the sanitizer refuses too');
    // End to end, a dry run of each: refused by the sanitizer before the rule is asked.
    const alias = `/.nofollow${path.join(mnt, 'f.txt')}`;
    const r = await request('DELETE', '/api/files', { paths: [alias], dryRun: true });
    assert.deepEqual([r.status, r.body.code], [400, 'PATH_BLOCKED'], JSON.stringify(r.body));
    assert.match(await callTool('trash_paths', { paths: [alias], dryRun: true }), /^Error \(PATH_BLOCKED\): /);
  } finally {
    // The record of / would cover every path for the rest of the run; it goes, and the scan of T is made again.
    evictExpiredScans(Date.now() + 2 * SCAN_TTL_MS);
    scan = await startScan(T);
    await waitFor(() => scan.status !== 'running', `the scan of ${T}, again`);
  }
});

/* ─────────────── Links realpath cannot follow (the SEC-2 review, F3) ─────────────── */

test('a link whose target is spelled through /.nofollow, /.resolve or /.vol is judged where it says it leads, though realpath cannot follow the last two: the sanitizer and the scanned-root rule both refuse it, beneath it and as itself', { skip: !DARWIN && 'the namespaces are macOS’s' }, async () => {
  // realpath gives a /.nofollow target back unchanged, but fails on a /.resolve target (EINVAL) and a
  // /.vol one (ENOENT); the failure was answered with the link's own spelling, so `via-resolve/f.txt`
  // and `via-vol/f.txt` read as files of the scan, and the links themselves passed the sanitizer.
  // Today's kernel does not follow these names through a link's target, so the grant dangled — it is
  // refused all the same, as the /.nofollow one always was.
  const dir = path.join(T, 'f3-aliases');
  const target = path.join(dir, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'f.txt'), 'f');
  const st = fs.lstatSync(target);
  // lstat and readlink go through /.resolve to a link there, so the chase must stop at the second
  // name rather than read on to the scanned folder the hop leads to.
  fs.symlinkSync(target, path.join(dir, 'hop'));
  const links: Record<string, string> = {
    'via-nofollow': `/.nofollow${target}`,
    'via-resolve': `/.resolve/1${target}`,
    'via-vol': `/.vol/${st.dev}/${st.ino}`,
    'via-resolve-hop': `/.resolve/1${path.join(dir, 'hop')}`,
  };
  for (const [name, to] of Object.entries(links)) fs.symlinkSync(to, path.join(dir, name));
  for (const name of Object.keys(links)) {
    const link = path.join(dir, name);
    assert.equal(rejection(path.join(link, 'f.txt')), 'PATH_BLOCKED', `${name}/f.txt: the sanitizer`);
    assert.equal(insideAnyScanRoot(path.join(link, 'f.txt')), false, `${name}/f.txt: the scanned-root rule`);
    assert.equal(rejection(link), 'PATH_BLOCKED', `${name}: the link itself, to the sanitizer`);
    assert.equal(insideAnyScanRoot(link), false, `${name}: the link itself, to the scanned-root rule — the two agree`);
  }
  const r = await request('DELETE', '/api/files', { paths: [path.join(dir, 'via-resolve', 'f.txt')], dryRun: true });
  assert.deepEqual([r.status, r.body.code], [400, 'PATH_BLOCKED'], JSON.stringify(r.body));
  // The target by its own name, and a link realpath does follow, are ordinary paths of the scan.
  fs.symlinkSync(target, path.join(dir, 'via-plain'));
  for (const p of [path.join(target, 'f.txt'), path.join(dir, 'via-plain', 'f.txt'), path.join(dir, 'via-plain')]) {
    assert.equal(rejection(p), null, p);
    assert.equal(insideAnyScanRoot(p), true, p);
  }
});

test('a link realpath cannot follow because its target is missing is judged where the target says it leads, never as a folder of the scan', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, () => {
  // Answered with the link's own spelling, `dangling/x` read as a file of the scan; a folder made at
  // the target between the check and the act would then take the act (the SEC-2 review, F3).
  const dir = path.join(T, 'f3-dangling');
  fs.mkdirSync(dir);
  const outside = path.join(DEST, 'not-made-yet');
  fs.symlinkSync(outside, path.join(dir, 'out'));
  fs.symlinkSync(path.join(dir, 'later'), path.join(dir, 'in'));
  assert.equal(insideAnyScanRoot(path.join(dir, 'out', 'x.txt')), false, 'beneath a link that leads out of the scan, to nothing yet');
  assert.equal(insideAnyScanRoot(path.join(dir, 'out', 'sub', 'x.txt')), false, 'and deeper');
  assert.equal(insideAnyScanRoot(path.join(dir, 'in', 'x.txt')), true, 'one that leads to a place in the scan is in the scan');
  assert.equal(insideAnyScanRoot(path.join(dir, 'out')), true, 'the link itself lives in the scan, and trashing it removes the link');
  assert.equal(rejection(path.join(dir, 'out')), null, 'which the sanitizer passes too: its target is an ordinary path');
});

/* ─────────────── Every route and tool that takes a path ─────────────── */

/** Field names that carry a path on this API. */
const PATHISH = new Set(['path', 'paths', 'root', 'dest', 'to', 'destination', 'scope', 'device']);

/** Path fields that take no path through this server's sanitizer, each with why. */
const NOT_A_LOCAL_PATH: Record<string, string> = {
  'POST /api/fleet/peers/{id}/trigger-scan body.path': 'a path on the paired peer, handed to it unread: the peer’s fleet receiver (fleetSync, /fleet/scan) judges it by its own sanitizer before any scan starts (fleetSync.test.ts, the SEC-2 review, F2)',
  'GET /api/health/smart query.device': 'names a drive to ask for SMART data, never a file to read or act on',
};

interface Probe {
  /** `METHOD /registry/path in.field`, as the coverage check below derives it. */
  key: string;
  send: (alias: (p: string) => string) => Promise<Answer>;
}

const enc = encodeURIComponent;

function probes(): Probe[] {
  const id = () => scan.scanId;
  const a = path.join(T, 'a.txt');
  const b = path.join(T, 'b.txt');
  const occupied = path.join(T, 'occupied.txt');
  return [
    { key: 'POST /api/scan body.path', send: (al) => request('POST', '/api/scan', { path: al(T) }) },
    { key: 'GET /api/scan/{scanId}/subtree query.path', send: (al) => request('GET', `/api/scan/${id()}/subtree?path=${enc(al(T))}`) },
    { key: 'POST /api/scan/{scanId}/nodes body.paths', send: (al) => request('POST', `/api/scan/${id()}/nodes`, { paths: [al(a)] }) },
    { key: 'GET /api/scan/{scanId}/treemap query.root', send: (al) => request('GET', `/api/scan/${id()}/treemap?root=${enc(al(T))}`) },
    { key: 'GET /api/duplicates/detail query.paths', send: (al) => request('GET', `/api/duplicates/detail?scanId=${id()}&paths=${enc(al(a))},${enc(al(b))}`) },
    { key: 'POST /api/compression/encode body.paths', send: (al) => request('POST', '/api/compression/encode', { paths: [al(a)] }) },
    { key: 'GET /api/provenance query.path', send: (al) => request('GET', `/api/provenance?path=${enc(al(a))}`) },
    { key: 'POST /api/security/relocate body.path', send: (al) => request('POST', '/api/security/relocate', { path: al(a), to: path.join(T, 'moved.txt'), confirm: true }) },
    { key: 'POST /api/security/relocate body.to', send: (al) => request('POST', '/api/security/relocate', { path: a, to: al(path.join(T, 'moved.txt')), confirm: true }) },
    { key: 'POST /api/git/gc body.path', send: (al) => request('POST', '/api/git/gc', { path: al(T) }) },
    { key: 'POST /api/container/expand body.path', send: (al) => request('POST', '/api/container/expand', { scanId: id(), path: al(a) }) },
    { key: 'GET /api/snapshots query.path', send: (al) => request('GET', `/api/snapshots?path=${enc(al(T))}`) },
    { key: 'GET /api/snapshots/tree query.path', send: (al) => request('GET', `/api/snapshots/tree?path=${enc(al(T))}`) },
    { key: 'GET /api/forecast query.path', send: (al) => request('GET', `/api/forecast?path=${enc(al(T))}`) },
    { key: 'PUT /api/notes body.path', send: (al) => request('PUT', '/api/notes', { path: al(T), text: 'a note' }) },
    { key: 'DELETE /api/notes query.path', send: (al) => request('DELETE', `/api/notes?path=${enc(al(T))}`) },
    { key: 'DELETE /api/files body.paths', send: (al) => request('DELETE', '/api/files', { paths: [al(a)], dryRun: true }) },
    { key: 'POST /api/files/open-handles body.paths', send: (al) => request('POST', '/api/files/open-handles', { paths: [al(a)] }) },
    { key: 'POST /api/files/open body.path', send: (al) => request('POST', '/api/files/open', { path: al(a) }) },
    { key: 'POST /api/files/terminal body.path', send: (al) => request('POST', '/api/files/terminal', { path: al(T) }) },
    { key: 'GET /api/files/preview query.path', send: (al) => request('GET', `/api/files/preview?path=${enc(al(a))}`) },
    { key: 'POST /api/offload body.paths', send: (al) => request('POST', '/api/offload', { scanId: id(), paths: [al(a)], dest: DEST, dryRun: true }) },
    { key: 'POST /api/offload body.dest', send: (al) => request('POST', '/api/offload', { scanId: id(), paths: [a], dest: al(DEST), dryRun: true }) },
    { key: 'POST /api/cloud/trash body.paths', send: (al) => request('POST', '/api/cloud/trash', { scanId: id(), paths: [al(a)] }) },
    { key: 'POST /api/index/build body.path', send: (al) => request('POST', '/api/index/build', { path: al(T), maxEntries: 10 }) },
    { key: 'GET /api/index/status query.path', send: (al) => request('GET', `/api/index/status?path=${enc(al(T))}`) },
    { key: 'GET /api/index/tree query.path', send: (al) => request('GET', `/api/index/tree?path=${enc(al(T))}`) },
    { key: 'POST /api/index/watch body.path', send: (al) => request('POST', '/api/index/watch', { path: al(T) }) },
    { key: 'DELETE /api/index query.path', send: (al) => request('DELETE', `/api/index?path=${enc(al(T))}`) },
    { key: 'GET /api/search query.scope', send: (al) => request('GET', `/api/search?q=a&scope=${enc(al(T))}`) },
    { key: 'GET /api/allocation query.path', send: (al) => request('GET', `/api/allocation?path=${enc(al(T))}`) },
    { key: 'GET /api/allocation/file query.path', send: (al) => request('GET', `/api/allocation/file?path=${enc(al(a))}`) },
    { key: 'GET /api/system/snapshots/find-deleted query.path', send: (al) => request('GET', `/api/system/snapshots/find-deleted?path=${enc(al(a))}`) },
    // An occupied destination ends a restore before anything privileged, whatever else is let through.
    { key: 'POST /api/system/snapshots/restore body.path', send: (al) => request('POST', '/api/system/snapshots/restore', { path: al(a), destination: occupied }) },
    { key: 'POST /api/system/snapshots/restore body.destination', send: (al) => request('POST', '/api/system/snapshots/restore', { path: a, destination: al(occupied) }) },
    { key: 'POST /api/cart/commit body.paths', send: (al) => request('POST', '/api/cart/commit', { paths: [al(a)], dryRun: true }) },
    { key: 'POST /api/facts body.paths', send: (al) => request('POST', '/api/facts', { scanId: id(), paths: [al(a)], providers: ['size'] }) },
    { key: 'GET /api/fs/list query.path', send: (al) => request('GET', `/api/fs/list?path=${enc(al(T))}`) },
    // Paths inside a body's own objects, which the registry describes as one opaque field.
    { key: 'PUT /api/settings body.schedules[].path', send: (al) => request('PUT', '/api/settings', { schedules: [{ id: 's', path: al(T), intervalHours: 24, enabled: false }] }) },
    { key: 'PUT /api/settings body.budgets[].path', send: (al) => request('PUT', '/api/settings', { budgets: [{ path: al(T), maxBytes: 1 }] }) },
    { key: 'PUT /api/autopilot/policies body.policies[].path', send: (al) => request('PUT', '/api/autopilot/policies', { policies: [{ name: 'p', path: al(T), match: { kind: 'query', q: 'size>1gb' } }] }) },
    { key: 'POST /api/autopilot/simulate body.policy.path', send: (al) => request('POST', '/api/autopilot/simulate', { policy: { name: 'p', path: al(T), match: { kind: 'query', q: 'size>1gb' } } }) },
  ];
}

test('the walk covers every path field the registry describes, or says why it need not', () => {
  const described = new Set<string>();
  const routes = new Set<string>();
  for (const e of ENDPOINTS) {
    const route = `${e.method.toUpperCase()} ${e.path}`;
    routes.add(route);
    for (const p of (e.parameters ?? []) as { in?: string; name?: string }[]) {
      if (p.in === 'query' && p.name && PATHISH.has(p.name)) described.add(`${route} query.${p.name}`);
    }
    const schema = (e.requestBody as { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> } | undefined)?.content?.['application/json']?.schema;
    for (const name of Object.keys(schema?.properties ?? {})) if (PATHISH.has(name)) described.add(`${route} body.${name}`);
  }
  const walked = new Set(probes().map((p) => p.key));
  for (const key of described) assert.ok(walked.has(key) || key in NOT_A_LOCAL_PATH, `${key} takes a path, and the walk does not try a second name on it`);
  for (const key of walked) assert.ok(routes.has(key.split(' ').slice(0, 2).join(' ')), `${key}: no such endpoint in the registry`);
  for (const key of Object.keys(NOT_A_LOCAL_PATH)) assert.ok(described.has(key), `${key} is exempted, but the registry does not describe it`);
});

test('every route that takes a path refuses a second name of a scanned path: 400 PATH_BLOCKED, and nothing is acted on', async () => {
  const wrong: string[] = [];
  for (const { name, of } of spellings()) {
    for (const probe of probes()) {
      const r = await probe.send(of);
      if (r.status !== 400 || r.body?.code !== 'PATH_BLOCKED') wrong.push(`${name} ${probe.key}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(fs.existsSync(path.join(T, 'a.txt')) && !fs.existsSync(path.join(T, 'moved.txt')), 'nothing was moved');
});

test('every MCP tool that takes a path refuses a second name of a scanned path: PATH_BLOCKED', async () => {
  const { tools } = await client.listTools();
  const described = new Set<string>();
  for (const tool of tools) {
    for (const name of Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) {
      if (PATHISH.has(name)) described.add(`${tool.name}.${name}`);
    }
  }
  const a = path.join(T, 'a.txt');
  const calls: Record<string, (al: (p: string) => string) => Promise<string>> = {
    'scan_path.path': (al) => callTool('scan_path', { path: al(T), waitMs: 0 }),
    'forecast.path': (al) => callTool('forecast', { path: al(T) }),
    'offload.paths': (al) => callTool('offload', { scanId: scan.scanId, paths: [al(a)], dest: DEST, dryRun: true }),
    'offload.dest': (al) => callTool('offload', { scanId: scan.scanId, paths: [a], dest: al(DEST), dryRun: true }),
    'trash_paths.paths': (al) => callTool('trash_paths', { paths: [al(a)], dryRun: true }),
  };
  assert.deepEqual([...described].sort(), Object.keys(calls).sort(), 'every tool field that takes a path is called below');
  const wrong: string[] = [];
  for (const { name, of } of spellings()) {
    for (const [field, call] of Object.entries(calls)) {
      const text = await call(of);
      if (!/^Error \(PATH_BLOCKED\): /.test(text)) wrong.push(`${name} ${field}: ${text.slice(0, 160)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the capability manifest states the rule', async () => {
  const caps = (await request('GET', '/api/capabilities')).body;
  assert.match(String(caps.safety.pathSanitization), /second name the system gives it \(macOS \/\.nofollow, \/\.resolve, \/\.vol;.*400 PATH_BLOCKED/);
  assert.match(String(caps.safety.pathSanitization), /own admin shares such as \\\\localhost\\C\$, or an NTFS stream name such as ::\$INDEX_ALLOCATION\)/, 'and Windows’ (the SEC-2 review, LOW-3)');
});
