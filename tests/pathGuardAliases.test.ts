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
import { aliasNamespaceOf, canonicalDirOf, fromExtendedLengthPath, isAppDataPath, judgeSpelling, liesInside, PathRejectedError, resolveAsTyped, sanitizePath } from '../src/utils/pathSanitizer';
import { appDataDir } from '../src/services/storage';
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

test('with Windows stood in for process.platform — as the tests that need its rules on another OS do — the sanitizer judges by Windows’ rules but resolves with the path module Node runs with', () => {
  // The SEC-2 change for F5 resolved by process.platform's rules, so under a stood-in Windows on a
  // Mac /var/folders/… came back as \var\folders\…, a path no file system call finds: every scan the
  // API started there answered 404 "Path does not exist" (scanMftMode), and every Time Capsule
  // record read "not spelled as TreeMap records one" (capsuleRestoreMeta). On a real machine the
  // platform and Node's path module agree, so only the stand-in could tell them apart.
  const dir = fileTempDir('treemap-alias-standin-'); // as os.tmpdir() spells it, links unresolved
  // In the folder as its links lead, so that the spelling alone can refuse it: no second, canonical look.
  const stream = path.join(fs.realpathSync(dir), 'f.txt:Zone.Identifier');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  let answered: unknown;
  let streamRefusal: unknown;
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    answered = sanitizePath(dir);
    try {
      sanitizePath(stream);
    } catch (err) {
      streamRefusal = err;
    }
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.equal(answered, dir, 'this machine’s folder comes back as itself, resolved as Node resolves every path it is then asked about');
  assert.ok(
    streamRefusal instanceof PathRejectedError && streamRefusal.code === 'PATH_BLOCKED',
    `the rules are still Windows’: a colon past the root names an NTFS stream, a second name (${String(streamRefusal)})`,
  );
  if (real.value !== 'win32') assert.equal(sanitizePath(stream), stream, 'outside the stand-in, a colon is a name like any other here');
});

test('with Windows stood in for process.platform, a link realpath cannot follow is walked as the system Node runs on reads it — with Node’s own path module, as the sanitizer resolves — so beneath it is where its target leads, not a path no file system call finds', { skip: WINDOWS && 'on Windows the platform and Node’s path module are one; making a link needs a privilege the runner may not hold' }, () => {
  // The link walk read a target by Windows' rules whenever process.platform said win32, resolving it
  // with path.win32: under a stand-in on a Mac a link in /private/var/… led to `\/private/var/…`,
  // which is no place here, so a file beneath a link to a folder of the scan not made yet was outside
  // it. The sanitizer's convention since the SEC-2 F5 regression fix: the platform picks the rules,
  // Node's own path module resolves what the file system is asked about next.
  const dir = path.join(T, 'standin-walk');
  fs.mkdirSync(dir);
  fs.symlinkSync('later', path.join(dir, 'in')); // relative, to a folder of the scan not made yet
  fs.symlinkSync(path.join(DEST, 'standin-not-made'), path.join(dir, 'out'));
  fs.symlinkSync('later\\name', path.join(dir, 'slash')); // one name here, holding a backslash
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  let answers: Record<string, string> = {};
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    answers = Object.fromEntries(['in', 'out', 'slash'].map((link) => [link, canonicalDirOf(path.join(dir, link, 'x.txt'))]));
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.deepEqual(answers, {
    in: path.join(dir, 'later', 'x.txt'),
    out: path.join(DEST, 'standin-not-made', 'x.txt'),
    slash: path.join(dir, 'later\\name', 'x.txt'), // not later/name: a backslash is a separator only to Windows
  });
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

test('Windows: this machine is known however its address is written — the short, decimal, hex and octal IPv4 forms Windows reads, the ipv6-literal.net form with or without a zone — and an admin share with a trailing dot or space is still one', () => {
  // Only the exact spellings were known, so \\127.1\C$\…\SAM, \\2130706433\C$ and \\fe80--1.ipv6-literal.net\c$
  // passed as another machine's shares, and \\localhost\C$.\Windows as an ordinary share (the SEC-2b review, F1.4).
  const own = ['MYPC', '192.168.1.20', 'fe80::1', '2001:db8::5'];
  const thisMachine = [
    '\\\\127.1\\C$\\Windows\\System32\\config\\SAM',
    '\\\\127.0.1\\C$\\x',
    '\\\\2130706433\\C$\\Windows',
    '\\\\0x7f000001\\C$\\x',
    '\\\\0x7f.1\\c$\\x',
    '\\\\0177.0.0.1\\C$\\x',
    '\\\\0.0.0.0\\C$\\x',
    '\\\\3232235796\\C$\\x', // 192.168.1.20
    '\\\\192.168.276\\C$\\x', // 192.168.1.20: the last part fills the bytes left
    '\\\\--1.ipv6-literal.net\\C$\\x',
    '\\\\0-0-0-0-0-0-0-1.IPV6-LITERAL.NET\\C$\\x',
    '\\\\--ffff-7f00-1.ipv6-literal.net\\C$\\x', // ::ffff:127.0.0.1
    '\\\\[0:0:0:0:0:0:0:1]\\C$\\x',
    '\\\\fe80--1.ipv6-literal.net\\c$\\x',
    '\\\\fe80--1s4.ipv6-literal.net\\C$\\x',
    '\\\\FE80-0-0-0-0-0-0-1.ipv6-literal.net\\C$\\x',
    '\\\\2001-db8-0-0-0-0-0-5.ipv6-literal.net\\C$\\x',
    '\\\\?\\UNC\\127.1\\C$\\x',
    '\\\\localhost\\C$.\\Windows',
    '\\\\localhost\\C$ \\Windows',
    '\\\\127.0.0.1\\ADMIN$..\\System32',
    // A host's own trailing space or dots, the unspecified IPv6 address and its IPv4-mapped form, and a
    // dotted quad inside IPv6 (the SEC-2c review, F2.8: each was a branch no spelling here reached).
    '\\\\localhost \\C$\\x',
    '\\\\localhost..\\C$\\x',
    '\\\\--.ipv6-literal.net\\C$\\x', // ::
    '\\\\--ffff-0-0.ipv6-literal.net\\C$\\x', // ::ffff:0.0.0.0
    '\\\\[::ffff:127.0.0.1]\\C$\\x',
  ];
  const anotherMachine = [
    '\\\\10.1\\C$\\x', // 10.0.0.1
    '\\\\3232235797\\C$\\x', // 192.168.1.21
    '\\\\0x7f.example.com\\C$\\x',
    '\\\\127.1.example.com\\C$\\x',
    '\\\\fe80--2.ipv6-literal.net\\C$\\x',
    '\\\\2001-db8--6.ipv6-literal.net\\C$\\x',
    '\\\\1-2-3-4-5-6-7-8-9.ipv6-literal.net\\C$\\x',
    '\\\\localhost\\C$x\\y',
    '\\\\localhost\\share.\\x',
    '\\\\256.0.0.1\\C$\\x',
    '\\\\[::ffff:10.0.0.1]\\C$\\x', // a dotted quad inside IPv6 that is another machine's
  ];
  const wrong = [
    ...thisMachine.filter((p) => judgeSpelling(p, 'win32', own).secondName === null).map((p) => `${p}: passed as another machine's`),
    ...anotherMachine.filter((p) => aliasNamespaceOf(p, 'win32', own) !== null).map((p) => `${p}: refused as this machine's`),
  ];
  assert.deepEqual(wrong, []);
});

test('Windows: print$ is this machine’s admin share too — its printer drivers, under System32 — while another machine’s print$ is a path; and a dotted host is this machine by its first label, since no suffix can be proven another machine’s (the SEC-3 brief, item 4)', () => {
  // \\localhost\print$ is C:\Windows\System32\spool\drivers, under the blocklist, yet only C$ and
  // ADMIN$ were known. A dotted host is still judged by its first label: Windows has a DNS suffix per
  // network connection, and an mDNS name besides, so a suffix this machine does not know may be its own
  // all the same — refusing another machine's admin share of the same first name is the price.
  const own = ['MYPC', 'mypc.corp.example.com', '192.168.1.20'];
  const thisMachine = [
    '\\\\localhost\\print$\\x64\\3',
    '\\\\MYPC\\PRINT$\\x',
    '\\\\127.1\\print$.\\x',
    '\\\\?\\UNC\\localhost\\print$\\x',
    '\\\\mypc.other.org\\C$\\x', // the doubt, kept: its suffix may be one of this machine's
  ];
  const anotherMachine = ['\\\\server\\print$\\x', '\\\\localhost\\printers$\\x', '\\\\localhost\\print\\x'];
  const wrong = [
    ...thisMachine.filter((p) => judgeSpelling(p, 'win32', own).secondName === null).map((p) => `${p}: passed as another machine's`),
    ...anotherMachine.filter((p) => aliasNamespaceOf(p, 'win32', own) !== null).map((p) => `${p}: refused as this machine's`),
  ];
  assert.deepEqual(wrong, []);
});

test('Windows: a path realpath hands back behind \\\\?\\ is read as Windows reads it — \\\\?\\UNC\\srv\\share\\x is \\\\srv\\share\\x, so this machine’s admin share there is still seen, and \\\\?\\C:\\x is C:\\x; any other name behind the prefix keeps it, and stays a second name (the SEC-3 brief, item 5)', () => {
  // Taking four characters off every such path turned \\?\UNC\localhost\C$\Windows into
  // UNC\localhost\C$\Windows, a relative name that neither the admin-share rule nor the blocklist
  // reads as C:\Windows (and \\?\Volume{…}\x into Volume{…}\x, past the device-namespace rule).
  const given = ['\\\\?\\UNC\\srv\\share\\x', '\\\\?\\unc\\localhost\\C$\\Windows', '\\\\?\\C:\\Users\\me', '\\\\?\\c:\\', '\\\\?\\Volume{0a1b}\\x', 'C:\\x', '\\\\srv\\share'];
  assert.deepEqual(given.map((p) => fromExtendedLengthPath(p, 'win32')), [
    '\\\\srv\\share\\x', '\\\\localhost\\C$\\Windows', 'C:\\Users\\me', 'c:\\', '\\\\?\\Volume{0a1b}\\x', 'C:\\x', '\\\\srv\\share',
  ]);
  const own: string[] = [];
  assert.deepEqual(
    ['\\\\?\\UNC\\localhost\\C$\\Windows', '\\\\?\\Volume{0a1b}\\x'].map((p) => aliasNamespaceOf(fromExtendedLengthPath(p, 'win32'), 'win32', own) !== null),
    [true, true],
    'this machine’s admin share and a volume by its GUID, as realpath may hand them back, are second names',
  );
  assert.equal(fromExtendedLengthPath('\\\\?\\UNC\\srv\\share\\x', 'darwin'), '\\\\?\\UNC\\srv\\share\\x', 'elsewhere it is a name like any other');
});

test('with Windows stood in, a folder realpath hands back as \\\\?\\UNC\\localhost\\C$\\… is read through that reading where the rules place a path: a file in it lies in this machine’s admin share, a second name (the SEC-3 brief, item 5; its review)', { skip: WINDOWS && 'here realpath is the real one; the stand-in is what reaches the rule on the other runners' }, () => {
  // The pure reading above is only half: the sanitizer's own realpath answers go through it too, or a
  // mapped drive into \\localhost\C$ is still read as UNC\localhost\C$\…, a relative name.
  const dir = path.join(T, 'unc-mapped');
  fs.mkdirSync(dir);
  const realpath = fs.realpathSync.native;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  let place = '';
  fs.realpathSync.native = ((p: fs.PathLike, ...rest: unknown[]) =>
    String(p) === dir ? '\\\\?\\UNC\\localhost\\C$\\Windows' : (realpath as (...a: unknown[]) => string)(p, ...rest)) as typeof realpath;
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    place = canonicalDirOf(path.join(dir, 'x.txt'));
  } finally {
    Object.defineProperty(process, 'platform', real);
    fs.realpathSync.native = realpath;
  }
  assert.ok(place.startsWith('\\\\localhost\\C$\\Windows'), `as Windows reads it: ${place}`);
  assert.notEqual(aliasNamespaceOf(place, 'win32', []), null, `a second name: ${place}`);
});

test('Windows: a colon in a UNC path’s share name, or in its host outside an IPv6 address’s brackets, is a second name — \\\\localhost\\C$::$INDEX_ALLOCATION\\… is a stream of the share’s own root, which both rules read as part of the root (the SEC-3 brief, item 7)', () => {
  // parse() reads `\\localhost\C$::$INDEX_ALLOCATION\` as the root, so the stream rule (a colon past
  // the root) never saw it, and the admin-share rule saw a share named `C$::$INDEX_ALLOCATION`. SMB
  // would refuse such a share — but no rule here should rest on that.
  const own = ['MYPC'];
  const refused = [
    '\\\\localhost\\C$::$INDEX_ALLOCATION\\Windows\\System32',
    '\\\\localhost\\C$:$I30:$INDEX_ALLOCATION\\x',
    '\\\\?\\UNC\\localhost\\C$::$INDEX_ALLOCATION\\x',
    '\\\\server\\share::$DATA',
    '\\\\server\\share:stream\\x',
    '\\\\srv:445\\share\\x',
    '\\\\::1\\share\\x',
  ];
  const paths = ['\\\\[::ffff:10.0.0.1]\\share\\x', '\\\\server\\share\\x', '\\\\fe80--1s4.ipv6-literal.net\\share\\x', '\\\\?\\UNC\\server\\share\\x'];
  const wrong = [
    ...refused.filter((p) => judgeSpelling(p, 'win32', own).secondName === null).map((p) => `${p}: passed`),
    ...paths.filter((p) => aliasNamespaceOf(p, 'win32', own) !== null).map((p) => `${p}: refused`),
  ];
  assert.deepEqual(wrong, []);
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
  fs.mkdirSync(path.join(target, 'sub', 'deeper'), { recursive: true });
  for (const f of ['f.txt', path.join('sub', 'f.txt'), path.join('sub', 'deeper', 'f.txt')]) fs.writeFileSync(path.join(target, f), 'f');
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
  // Two and three names below each link too: realpath fails there with EINVAL for a /.resolve link, and
  // only a missing name (ENOENT) climbed to the folder holding the link (the SEC-2b review, F1.7). Every
  // grant is collected, so a failure names each spelling that got through.
  const granted: string[] = [];
  for (const name of Object.keys(links)) {
    for (const below of ['f.txt', 'sub', path.join('sub', 'f.txt'), path.join('sub', 'deeper'), path.join('sub', 'deeper', 'f.txt')]) {
      const p = path.join(dir, name, below);
      if (rejection(p) !== 'PATH_BLOCKED') granted.push(`${name}/${below}: the sanitizer`);
      if (insideAnyScanRoot(p)) granted.push(`${name}/${below}: the scanned-root rule`);
    }
  }
  assert.deepEqual(granted, [], 'beneath a link that leads through a second name, nothing is a path of the scan');
  for (const name of Object.keys(links)) {
    const link = path.join(dir, name);
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
  // liesInside (an offload copy inside its destination) read a link realpath cannot follow as its own
  // place, so one inside the folder that leads out of it was inside (the SEC-2d review, F3.2).
  assert.deepEqual([liesInside(T, path.join(dir, 'out')), liesInside(T, path.join(dir, 'in'))], [false, true], 'liesInside judges the link where it leads, as its doc says');
});

test('a link whose target climbs back up through another link (`sub/../x`) is judged where the system reads it — above where sub leads — not in the link’s own folder, though realpath cannot follow it while x is missing', { skip: WINDOWS && 'Windows reads a relative link’s `..` against the link’s own folder, and making a link needs a privilege the runner may not hold' }, () => {
  // The target was resolved from its text, so `sub/..` cancelled out and `out/y` read as a file of the
  // scan; once x is made where the system reads the link, a delete of `out/y` lands outside every scan
  // (the SEC-2b review, F1.1). The blocklist read it the same way.
  const dir = path.join(T, 'f11');
  fs.mkdirSync(path.join(dir, 'plain'), { recursive: true });
  const deep = path.join(DEST, 'f11-deep');
  fs.mkdirSync(deep);
  fs.symlinkSync(deep, path.join(dir, 'sub')); // a live link out of the scan
  fs.symlinkSync(['sub', '..', 'f11-x'].join(path.sep), path.join(dir, 'out')); // read as DEST/f11-x, not made yet
  fs.symlinkSync(['plain', '..', 'f11-in'].join(path.sep), path.join(dir, 'in')); // read as dir/f11-in: in the scan
  fs.symlinkSync('/dev/fd', path.join(dir, 'devfd'));
  fs.symlinkSync(['devfd', '..', 'f11-nothing'].join(path.sep), path.join(dir, 'to-dev')); // read as /dev/f11-nothing (Linux: under /proc)
  const answers = {
    'out/y, the scanned-root rule': insideAnyScanRoot(path.join(dir, 'out', 'y')),
    'out/z/y, the scanned-root rule': insideAnyScanRoot(path.join(dir, 'out', 'z', 'y')),
    'out/y, the sanitizer': rejection(path.join(dir, 'out', 'y')),
    'out itself, the scanned-root rule': insideAnyScanRoot(path.join(dir, 'out')),
    'in/y, the scanned-root rule': insideAnyScanRoot(path.join(dir, 'in', 'y')),
    'to-dev, the sanitizer': rejection(path.join(dir, 'to-dev')),
    'to-dev/x, the sanitizer': rejection(path.join(dir, 'to-dev', 'x')),
  };
  assert.deepEqual(answers, {
    'out/y, the scanned-root rule': false,
    'out/z/y, the scanned-root rule': false,
    'out/y, the sanitizer': null, // DEST is an ordinary folder
    'out itself, the scanned-root rule': true, // the link lives in the scan, and trashing it removes the link
    'in/y, the scanned-root rule': true,
    'to-dev, the sanitizer': 'PATH_BLOCKED',
    'to-dev/x, the sanitizer': 'PATH_BLOCKED',
  });
  // Where the system does read it, once x is there.
  fs.mkdirSync(path.join(DEST, 'f11-x'));
  assert.equal(fs.realpathSync.native(path.join(dir, 'out')), path.join(DEST, 'f11-x'), 'the system’s own realpath (Node’s other one reads a link’s text alone)');
});

test('a loop of links costs a few file-system calls, not a round of the loop for every link the system allows: the walk ends where the loop is certain', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, () => {
  // Each guard walked a two-link loop until its budget of links ran out — about forty realpaths and
  // readlinks a path, twice per path in the scanned-root rule — so a batch of such links held the
  // server for minutes (the SEC-2b review, F1.2). Counted, not timed.
  const dir = path.join(T, 'f12-loop');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a');
  fs.symlinkSync(path.join(dir, 'b'), a);
  fs.symlinkSync(a, path.join(dir, 'b'));
  const asks: Record<string, () => unknown> = {
    sanitizePath: () => sanitizePath(a),
    insideAnyScanRoot: () => insideAnyScanRoot(a),
    isAppDataPath: () => isAppDataPath(a),
  };
  const verdicts = Object.fromEntries(Object.entries(asks).map(([name, ask]) => [name, ask()])); // and the folders' answers are now remembered
  assert.deepEqual(verdicts, { sanitizePath: a, insideAnyScanRoot: true, isAppDataPath: true }, 'the verdicts a loop always had: the link itself is a path of the scan, and no place to write');
  const calls = { realpath: 0, readlink: 0 };
  const realpath = fs.realpathSync.native;
  const readlink = fs.readlinkSync;
  fs.realpathSync.native = ((...args: Parameters<typeof realpath>) => {
    calls.realpath += 1;
    return realpath(...args);
  }) as typeof realpath;
  fs.readlinkSync = ((...args: Parameters<typeof readlink>) => {
    calls.readlink += 1;
    return readlink(...args);
  }) as typeof readlink;
  const cost: Record<string, string> = {};
  try {
    for (const [name, ask] of Object.entries(asks)) {
      calls.realpath = 0;
      calls.readlink = 0;
      ask();
      cost[name] = calls.realpath <= 3 && calls.readlink <= 3 ? 'a few' : `${calls.realpath} realpaths, ${calls.readlink} readlinks`;
    }
  } finally {
    fs.realpathSync.native = realpath;
    fs.readlinkSync = readlink;
  }
  assert.deepEqual(cost, { sanitizePath: 'a few', insideAnyScanRoot: 'a few', isAppDataPath: 'a few' });
});

test('a path longer than the system takes is answered as spelled at the cost of a few file-system calls — never climbed name by name, which held the server for seconds and then overflowed the stack (the SEC-2c review, F2.2)', () => {
  // The climb toward a real folder went on through every realpath failure, ENAMETOOLONG too, one name at
  // a time: a path of 20,000 names (40 kB, well inside a 1 MB request body) blocked the event loop for
  // seconds and then threw RangeError (Maximum call stack size exceeded) — a 500 with a stack in the log.
  // No call takes such a spelling, so nothing can be acted on through it. Counted, not timed.
  const long = path.join(T, ...Array<string>(20_000).fill('a'), 'f.txt');
  const asks: Record<string, () => unknown> = {
    sanitizePath: () => sanitizePath(long) === long,
    insideAnyScanRoot: () => typeof insideAnyScanRoot(long),
  };
  let calls = 0;
  const realpath = fs.realpathSync.native;
  const sync = fs as unknown as { lstatSync: (...args: unknown[]) => unknown };
  const lstat = sync.lstatSync;
  fs.realpathSync.native = ((...args: Parameters<typeof realpath>) => {
    calls += 1;
    return realpath(...args);
  }) as typeof realpath;
  sync.lstatSync = (...args: unknown[]) => {
    calls += 1;
    return lstat(...args);
  };
  const answers: Record<string, unknown> = {};
  try {
    for (const [name, ask] of Object.entries(asks)) {
      calls = 0;
      try {
        answers[name] = ask();
      } catch (err) {
        answers[name] = `threw ${err instanceof Error ? err.name : String(err)}`;
      }
      answers[`${name}, its cost`] = calls <= 8 ? 'a few calls' : `${calls} realpaths and lstats`;
    }
  } finally {
    fs.realpathSync.native = realpath;
    sync.lstatSync = lstat;
  }
  // Only a spelling the system itself refuses is answered that way. A realpath that refuses a short
  // spelling for the length of where it leads — glibc before 2.33 limits its answer to PATH_MAX, while
  // the kernel's own lookup has no such limit — still climbs to the link, judged where it leads.
  const dir = path.join(T, 'f22');
  const out = path.join(DEST, 'f22-out');
  fs.mkdirSync(dir);
  fs.mkdirSync(out);
  const far = path.join(dir, 'far');
  fs.symlinkSync(out, far);
  fs.realpathSync.native = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).startsWith(far)) throw Object.assign(new Error(`ENAMETOOLONG: name too long, realpath '${String(p)}'`), { code: 'ENAMETOOLONG' });
    return (realpath as (...a: unknown[]) => string)(p, ...rest);
  }) as typeof realpath;
  try {
    answers['beneath a link whose real place realpath will not spell'] = insideAnyScanRoot(path.join(far, 'x.txt'));
  } finally {
    fs.realpathSync.native = realpath;
  }
  assert.deepEqual(answers, {
    sanitizePath: true, // as spelled, as a path a realpath refuses for its length always was
    'sanitizePath, its cost': 'a few calls',
    insideAnyScanRoot: 'boolean',
    'insideAnyScanRoot, its cost': 'a few calls',
    'beneath a link whose real place realpath will not spell': false, // DEST is outside the scan
  });
});

test('a chain of links is followed link by link to a second name at its end: a link to a link to /.resolve or /.vol is refused beneath it and as itself', { skip: !DARWIN && 'the namespaces are macOS’s' }, () => {
  // Every link the F3 test makes leads to a second name in one step, so nothing pinned that the walk
  // goes on through a link to the next one: a walk that stopped at the first target passed it all
  // (the SEC-2b review, F1.8).
  const dir = path.join(T, 'f18-chains');
  const target = path.join(dir, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'f.txt'), 'f');
  const st = fs.lstatSync(target);
  fs.symlinkSync(`/.resolve/1${target}`, path.join(dir, 'L2'));
  fs.symlinkSync(path.join(dir, 'L2'), path.join(dir, 'L1'));
  fs.symlinkSync(`/.vol/${st.dev}/${st.ino}`, path.join(dir, 'M2'));
  fs.symlinkSync(path.join(dir, 'M2'), path.join(dir, 'M1'));
  fs.symlinkSync('L1', path.join(dir, 'R1')); // relative, and three links long
  const granted: string[] = [];
  for (const name of ['L1', 'M1', 'R1']) {
    for (const p of [path.join(dir, name), path.join(dir, name, 'f.txt'), path.join(dir, name, 'f.txt', 'deeper')]) {
      if (rejection(p) !== 'PATH_BLOCKED') granted.push(`${path.relative(dir, p)}: the sanitizer`);
      if (insideAnyScanRoot(p)) granted.push(`${path.relative(dir, p)}: the scanned-root rule`);
    }
  }
  assert.deepEqual(granted, []);
});

test('a `..` after a second name in a link’s target is the system’s to read, never cancelled by its text: a link to /.vol/<dev>/<ino>/../../../<a scanned folder> — absolute, reached through `..`, or through another link — is refused beneath it and as itself (the SEC-2c review, F2.1)', { skip: !DARWIN && 'the namespaces are macOS’s' }, () => {
  // The walk stopped at the second name and joined the names left with path.join, which cancelled
  // `/.vol/1/2/..` against its own text — and so did every later join of a child name onto such a
  // place — so `/.vol/1/2/../../../<a scanned folder>` read as that folder: inside the scan and past
  // the alias test, while the kernel reads that `..` as the folder above inode 2, wherever it is.
  // Typed directly, the same spelling was refused. (A /.nofollow target is left out: the kernel
  // itself resolves `/.nofollow/..` to /, so realpath answers it, as it should be answered.)
  const dir = path.join(T, 'f21');
  const real = path.join(dir, 'dir');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(real, 'f.txt'), 'f');
  fs.writeFileSync(path.join(real, 'sub', 'g.txt'), 'g');
  const up = (n: number): string[] => Array<string>(n).fill('..');
  const toRoot = up(dir.split('/').filter((name) => name !== '').length); // from dir up to /
  // Joined by hand: path.join would cancel the very `..`s under test.
  const links: Record<string, string> = {
    'abs-vol': ['', '.vol', '1', '2', ...up(3), real.slice(1)].join('/'),
    'rel-vol': [...toRoot, '.vol', '1', '2', ...up(3), real.slice(1)].join('/'),
    'abs-resolve': ['', '.resolve', '1', ...up(2), real.slice(1)].join('/'),
    chain: 'abs-vol',
    through: ['abs-vol', 'sub'].join('/'),
  };
  for (const [name, to] of Object.entries(links)) fs.symlinkSync(to, path.join(dir, name));
  const granted: string[] = [];
  for (const name of Object.keys(links)) {
    for (const below of ['', 'f.txt', path.join('sub', 'g.txt')]) {
      const p = path.join(dir, name, below);
      if (rejection(p) !== 'PATH_BLOCKED') granted.push(`${name}/${below}: the sanitizer`);
      if (insideAnyScanRoot(p)) granted.push(`${name}/${below}: the scanned-root rule`);
      if (liesInside(T, p)) granted.push(`${name}/${below}: liesInside`);
    }
  }
  assert.deepEqual(granted, [], 'beneath such a link, and the link itself, nothing is a path of the scan');
  // Typed, the spelling always was a second name; the folder by its own name is a path of the scan.
  assert.equal(rejection(`${links['abs-vol']}/f.txt`), 'PATH_BLOCKED');
  assert.deepEqual([rejection(path.join(real, 'f.txt')), insideAnyScanRoot(path.join(real, 'f.txt'))], [null, true]);
  // The app-data rule read such a link as where the text cancels to, and still does: no place to write.
  const data = fs.realpathSync(appDataDir());
  fs.symlinkSync(['', '.vol', '1', '2', ...up(3), data.slice(1)].join('/'), path.join(dir, 'to-app-data'));
  assert.deepEqual(
    [isAppDataPath(path.join(dir, 'to-app-data')), isAppDataPath(path.join(dir, 'to-app-data', 'settings.json'))],
    [true, true],
  );
});

test('a chain of links as long as macOS or Linux follows is followed to its end, out of the scan; a longer one ends with bounded work, placed nowhere and refused (the SEC-2d review, F3.1)', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, () => {
  // The walk's budget of links must be at least macOS's and Linux's own limit (32, 40): one cut short
  // there answers with a link in the scan, while the system follows the chain out of it. Past the budget
  // the walk settled at the link where it stopped, in the scan — but Windows follows 63 links, so where
  // the walk stops says nothing of where the system lands, and no place is guessed.
  const dir = path.join(T, 'f18-long');
  fs.mkdirSync(dir);
  const chain = (prefix: string, links: number, end: string): string => {
    for (let i = links - 1; i >= 0; i--) fs.symlinkSync(i === links - 1 ? end : path.join(dir, `${prefix}${i + 1}`), path.join(dir, `${prefix}${i}`));
    return path.join(dir, `${prefix}0`);
  };
  // Linux follows all 40 (MAXSYMLINKS); macOS stops at 32. The walk reads the first link before it spends
  // its budget, so 40 links cost 39 of it, and a budget cut to 38 answered this chain "in the scan" (the
  // SEC-2c review, F2.9: the chain was 39 links, and no budget above 37 failed it).
  const out = chain('d', 40, path.join(DEST, 'f18-not-made'));
  const tooLong = chain('c', 45, path.join(DEST, 'f18-not-made-either')); // macOS and Linux never follow 45
  const readlink = fs.readlinkSync;
  let readlinks = 0;
  fs.readlinkSync = ((...args: Parameters<typeof readlink>) => {
    readlinks += 1;
    return readlink(...args);
  }) as typeof readlink;
  let answers: Record<string, unknown>;
  try {
    answers = {
      'd0/x, the scanned-root rule': insideAnyScanRoot(path.join(out, 'x')),
      'c0, the sanitizer': rejection(tooLong),
      'c0, the scanned-root rule': insideAnyScanRoot(tooLong),
      'readlinks for c0, the sanitizer': (readlinks = 0, rejection(tooLong), readlinks <= 41 ? 'bounded by the budget of links' : readlinks),
    };
  } finally {
    fs.readlinkSync = readlink;
  }
  assert.deepEqual(answers, {
    'd0/x, the scanned-root rule': false,
    'c0, the sanitizer': 'PATH_BLOCKED',
    'c0, the scanned-root rule': false, // the two agree
    'readlinks for c0, the sanitizer': 'bounded by the budget of links',
  });
});

test('a walk through link targets that spell more names than its bound ends there: one lstat a name, and no more names than the bound, however many a chain of long targets spells — and no place is guessed for it (the SEC-2c review, F2.9; the SEC-2d review, F3.1)', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, () => {
  // The bound on names (MAX_WALK_NAMES) caps one judgement's work whatever link targets spell, and nothing
  // pinned it: without it, 31 links (fewer than any system's limit) whose targets each spell 201 real
  // names cost an lstat for every one of them. Counted, not timed; built from real folders, since a name
  // that is not there ends a walk at once. The verdict is asserted too, so the cost alone hides nothing:
  // the chain's end is never read, so the path is placed nowhere and refused.
  const dir = path.join(T, 'f29-names');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  const chain = (prefix: string): string => {
    const links = 31;
    for (let i = links - 1; i >= 0; i--) {
      const next = i === links - 1 ? `${prefix}-not-made` : `${prefix}${i + 1}`;
      // 200 rounds of `a/../` and a link's name: under the 1023 bytes macOS allows a link's target.
      fs.symlinkSync(`${'a/../'.repeat(200)}${next}`, path.join(dir, `${prefix}${i}`));
    }
    return path.join(dir, `${prefix}0`, 'x');
  };
  const asks: Record<string, () => unknown> = {
    sanitizePath: ((p: string) => () => rejection(p))(chain('s')),
    insideAnyScanRoot: ((p: string) => () => insideAnyScanRoot(p))(chain('i')),
  };
  const sync = fs as unknown as { lstatSync: (...args: unknown[]) => unknown };
  const lstat = sync.lstatSync;
  let lstats = 0;
  sync.lstatSync = (...args: unknown[]) => {
    lstats += 1;
    return lstat(...args);
  };
  const answers: Record<string, unknown> = {};
  try {
    for (const [name, ask] of Object.entries(asks)) {
      lstats = 0;
      const verdict = ask();
      answers[name] = lstats <= 4096 + 64 ? 'bounded by the names one walk may spend' : `${lstats} lstats`;
      answers[`${name}, its verdict`] = verdict;
    }
  } finally {
    sync.lstatSync = lstat;
  }
  assert.deepEqual(answers, {
    sanitizePath: 'bounded by the names one walk may spend',
    'sanitizePath, its verdict': 'PATH_BLOCKED',
    insideAnyScanRoot: 'bounded by the names one walk may spend',
    'insideAnyScanRoot, its verdict': false,
  });
});

test('a walk that runs out of its bound on names answers no place, and every rule refuses it — never the link where it stopped, inside the scan: a chain of long targets that leads out of the scan, to /.resolve or to /.vol is outside every scan, beneath it and as itself (the SEC-2d review, F3.1)', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, () => {
  // The walk settled where its budget ran out and joined the names it had not walked: 22 links whose
  // targets each spell 200 rounds of `a/../` spend the 4096 names around the 21st link, so the answer was
  // the 22nd link's own place in the scan, and the link to the second name, or out of the scan, was never
  // read — while the system's own lookup has no limit on names (32 links of 1023 bytes on macOS, 40 of
  // 4095 on Linux). With 20 links the same chain was refused.
  const dir = path.join(T, 'f31');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  const chain = (prefix: string, links: number, end: string): string => {
    for (let i = links - 1; i >= 0; i--) fs.symlinkSync(i === links - 1 ? end : `${'a/../'.repeat(200)}${prefix}${i + 1}`, path.join(dir, `${prefix}${i}`));
    return path.join(dir, `${prefix}0`);
  };
  const ends: Record<string, string> = { 'out of the scan, to a folder not made yet': path.join(DEST, 'f31-not-made') };
  if (DARWIN) {
    const st = fs.lstatSync(DEST);
    Object.assign(ends, { '/.resolve': `/.resolve/1${DEST}`, '/.vol': `/.vol/${st.dev}/${st.ino}` });
  }
  const granted: string[] = [];
  Object.entries(ends).forEach(([what, end], n) => {
    const first = chain(`e${n}-`, 22, end);
    for (const below of ['', 'x', path.join('sub', 'x')]) {
      const p = path.join(first, below);
      const which = `${what}, ${path.relative(dir, p)}`;
      if (rejection(p) !== 'PATH_BLOCKED') granted.push(`${which}: the sanitizer`);
      if (insideAnyScanRoot(p)) granted.push(`${which}: the scanned-root rule`);
      if (liesInside(T, p)) granted.push(`${which}: liesInside`);
      // A write to the link itself goes where the chain ends, which the app-data rule follows hop by hop,
      // each hop a walk of its own; beneath the link, one walk must place the whole chain.
      if (below !== '' && !isAppDataPath(p)) granted.push(`${which}: the app-data rule, as a place to write`);
    }
  });
  assert.deepEqual(granted, [], 'past the bound on names, no place is guessed');
});

/* ─────────────── Every route and tool that takes a path ─────────────── */

/** Field names that carry a path on this API. */
const PATHISH = new Set(['path', 'paths', 'root', 'dest', 'to', 'destination', 'scope', 'device']);

/**
 * Whether a field may carry a path: one of the names above, or text whose own name or description
 * reads like one — so a field added as `file`, `folder` or `target`, or described as "the folder
 * to …", is walked below or exempted with a reason, never missed (the SEC-2 review, INFO). A field
 * of no stated type counts as text.
 */
const PATH_NAME = /path|file|folder|dir|root|dest|target|location|drive|volume/i;
const PATH_WORDS = /\bpaths?\b|\bfolders?\b|\bdirector(?:y|ies)\b/i;
function mayCarryAPath(name: string, schema: { type?: unknown; items?: { type?: unknown } } | undefined, description: string): boolean {
  if (PATHISH.has(name)) return true;
  const type = schema?.type;
  const text = type === undefined || type === 'string' || (Array.isArray(type) && type.includes('string')) || (type === 'array' && (schema?.items?.type ?? 'string') === 'string');
  return text && (PATH_NAME.test(name) || PATH_WORDS.test(description));
}

/** Path fields that take no path through this server's sanitizer, each with why. */
const NOT_A_LOCAL_PATH: Record<string, string> = {
  'POST /api/fleet/peers/{id}/trigger-scan body.path': 'a path on the paired peer, handed to it unread: the peer’s fleet receiver (fleetSync, /fleet/scan) judges it by its own sanitizer before any scan starts (fleetSync.test.ts, the SEC-2 review, F2)',
  'GET /api/health/smart query.device': 'names a drive to ask for SMART data, never a file to read or act on',
  'GET /api/scan/{scanId}/export query.mode': 'one of two words, files or folders: what the export lists, never a path',
  'POST /api/query body.sort': 'one of four sort keys, path among them: never a path',
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
    for (const p of (e.parameters ?? []) as { in?: string; name?: string; description?: string; schema?: { type?: unknown; description?: string } }[]) {
      if (p.in === 'query' && p.name && mayCarryAPath(p.name, p.schema, p.description ?? p.schema?.description ?? '')) described.add(`${route} query.${p.name}`);
    }
    type Field = { type?: unknown; items?: { type?: unknown }; description?: string };
    const schema = (e.requestBody as { content?: Record<string, { schema?: { properties?: Record<string, Field> } }> } | undefined)?.content?.['application/json']?.schema;
    for (const [name, field] of Object.entries(schema?.properties ?? {})) {
      if (mayCarryAPath(name, field, field.description ?? '')) described.add(`${route} body.${name}`);
    }
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
    type Field = { type?: unknown; items?: { type?: unknown }; description?: string };
    for (const [name, field] of Object.entries((tool.inputSchema as { properties?: Record<string, Field> }).properties ?? {})) {
      if (mayCarryAPath(name, field, field.description ?? '')) described.add(`${tool.name}.${name}`);
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
  // Tool fields that read like paths by that rule but take none, each with why.
  const notAPath: Record<string, string> = {
    'get_largest.kind': 'files or folders: what to rank, never a path',
    'reclaim_ranked.kind': 'files or folders: what to rank, never a path',
    'offload.scanId': 'names the scan the paths belong to, never a path',
  };
  assert.deepEqual([...described].filter((key) => !(key in notAPath)).sort(), Object.keys(calls).sort(), 'every tool field that takes a path is called below');
  for (const key of Object.keys(notAPath)) assert.ok(described.has(key), `${key} is exempted, but no tool describes it`);
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
