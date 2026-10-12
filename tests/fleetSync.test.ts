import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('tm-fleet-');
process.env.TREEMAP_NO_GDU = '1'; // one test runs a real scan of a small folder, on the walker

import {
  DEFAULT_FLEET_PORT, FleetConfig, PAIRING_WINDOW_MS, beginPairing, cancelPairing,
  defaultConfig, handlePeerRequest, isPrivateIPv4, lanAddresses, pairingOffer,
  peerScanRootRefusal, resetFleetConfig, secretMatches, startPeerServer, verifyPairingCode, walkDarwinLinks,
} from '../src/services/fleet/fleetSync';
import { FleetSummary, SUMMARY_FIELDS, buildSummary, isForbiddenSummaryField, serialiseSummary } from '../src/services/fleet/fleetSummary';
import { fleetRuntime, startPeerScan } from '../src/services/fleet/fleetRuntime';
import { allScans, getScan } from '../src/services/diskScanner';
import { appDataDir } from '../src/services/storage';
import { POLICY_FILE } from '../src/services/policy';
import { AppError } from '../src/middleware/errorHandler';
import { createApp } from '../src/server';

/**
 * §D1 — LAN fleet view.
 *
 * This is the only feature that opens a network surface, and §D1 says to treat
 * it accordingly. Every test here is a security property, because those are the
 * ones whose failure is not merely a bug:
 *
 *   off by default · paired before anything · summaries only · never a tree,
 *   a security finding or a provenance URL · LAN interfaces only · remote scan
 *   separately opt-in · no remote deletion, at all.
 */

afterEach(() => {
  cancelPairing();
  resetFleetConfig();
});

function summary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    ...buildSummary({
      label: 'Studio Mac', instanceId: 'abc', version: '2.6.1', acceptsRemoteScan: false,
      usage: { total: 1000, used: 400, free: 600 },
      lastScan: { rootPath: '/Users/x/Projects', finishedAt: 1_700_000_000_000, totalBytes: 123 },
    }),
    ...over,
  };
}

/** Every path the handler handed on to start a scan, in order. */
const scansStarted: string[] = [];

/** Drive one request through the peer handler without opening a socket. */
async function call(
  cfg: FleetConfig,
  method: string,
  url: string,
  opts: { body?: unknown; secret?: string; from?: string; onPairingAbuse?: (address: string) => void; startScan?: (root: string) => Promise<{ scanId: string }> } = {},
): Promise<{ status: number; body: any }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  req.url = url;
  req.headers = opts.secret ? { authorization: `Bearer ${opts.secret}` } : {};
  Object.defineProperty(req, 'socket', { value: { remoteAddress: opts.from ?? '192.168.1.50' } });

  let status = 0;
  let text = '';
  const fake = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    end(chunk?: string) { text = chunk ?? ''; },
  };
  // A stand-in for the only members handlePeerRequest touches (writeHead, end, headersSent); a real one needs a socket.
  const res = fake as http.ServerResponse;

  const done = handlePeerRequest(req, res, cfg, {
    async summary() { return summary({ acceptsRemoteScan: cfg.allowRemoteScan }); },
    async startScan(root: string) {
      scansStarted.push(root);
      return opts.startScan ? opts.startScan(root) : { scanId: 'scan-1' };
    },
    onPairingAbuse: opts.onPairingAbuse,
  });
  if (payload) { req.emit('data', Buffer.from(payload)); }
  req.emit('end');
  await done;
  return { status, body: text ? JSON.parse(text) : null };
}

/* ─────────────── Off by default ─────────────── */

test('fleet is off by default, and remote scanning is off separately', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false, 'nothing listens until the user says so');
  assert.equal(cfg.allowRemoteScan, false, '§D1: visibility and scan-triggering are separate opt-ins');
  assert.equal(cfg.peers.length, 0);
});

/* ─────────────── What can leave this machine ─────────────── */

test('the summary contains only the fields §D1 allows', () => {
  const wire = serialiseSummary(summary());
  assert.deepEqual(Object.keys(wire).sort(), [...SUMMARY_FIELDS].sort());
  // The three §D1 bans, spelled out.
  const text = JSON.stringify(wire).toLowerCase();
  for (const banned of ['children', 'findings', 'provenance', 'whereFroms'.toLowerCase(), 'id_rsa', 'http']) {
    assert.ok(!text.includes(banned), `the wire summary must not contain "${banned}"`);
  }
});

test('extra fields smuggled onto a summary are never serialised', () => {
  // The allow-list is the guarantee: an object carrying a whole scan tree still
  // sends eleven scalar fields.
  const hostile = {
    ...summary(),
    securityFindings: [{ path: '/Users/x/Downloads/id_rsa' }],
    provenanceUrl: 'https://tracker.example/leak',
    children: [{ name: 'tax-return.pdf' }],
  } as unknown as FleetSummary;
  const wire = serialiseSummary(hostile);
  assert.equal(Object.keys(wire).length, SUMMARY_FIELDS.length);
  assert.equal((wire as Record<string, unknown>).securityFindings, undefined);
  assert.equal((wire as Record<string, unknown>).provenanceUrl, undefined);
  assert.equal((wire as Record<string, unknown>).children, undefined);
});

test('the summary builder is not even given a scan result to leak from', () => {
  // A ScanResult carries the whole packed store. The builder takes three
  // scalars instead, so there is nothing in scope to serialise by accident.
  // Comments must be stripped first: the file's own doc comment explains that
  // it deliberately does NOT take a ScanResult, and scanning raw text would
  // flag that explanation as the violation it warns against.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fleet', 'fleetSummary.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(src, /ScanResult|ScanStore|FileNode/, 'no tree type may be imported here');
});

/* ─────────────── Pairing ─────────────── */

test('an unpaired device gets nothing at all', async () => {
  const cfg = defaultConfig();
  for (const [method, url] of [['GET', '/fleet/summary'], ['POST', '/fleet/scan']] as const) {
    const res = await call(cfg, method, url, { body: { path: '/tmp' } });
    assert.equal(res.status, 401, `${method} ${url} must refuse an unpaired caller`);
    assert.equal(res.body.error, 'Not paired');
    // And it learns nothing about this machine from the refusal.
    assert.equal(JSON.stringify(res.body).includes('Studio Mac'), false);
  }
});

test('pairing is refused unless the user is actively offering a code', async () => {
  const cfg = defaultConfig();
  const res = await call(cfg, 'POST', '/fleet/pair', { body: { code: '123456' } });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /not accepting pairing/);
});

test('a correct code pairs once, and is then spent', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const res = await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'peer-1', label: 'Laptop' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.paired, true);
  assert.ok(res.body.secret.length >= 64, 'a long random secret, not the code');
  assert.notEqual(res.body.secret, offer.code);
  assert.equal(cfg.peers.length, 1);

  // The same code cannot pair a second device.
  const again = await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'peer-2' } });
  assert.equal(again.status, 401);
  assert.equal(cfg.peers.length, 1, 'one code, one device');
});

test('a wrong code does not cancel the pairing window', () => {
  // Otherwise anyone on the network could cancel a pairing by guessing once.
  beginPairing();
  assert.equal(verifyPairingCode('000000'), false);
  assert.ok(pairingOffer(), 'the window survives a wrong guess');
});

test('a pairing code expires', () => {
  const now = 1_000_000;
  const offer = beginPairing(now);
  assert.ok(pairingOffer(now + PAIRING_WINDOW_MS - 1));
  assert.equal(pairingOffer(now + PAIRING_WINDOW_MS), null);
  assert.equal(verifyPairingCode(offer.code, now + PAIRING_WINDOW_MS), false, 'an expired code is no code');
});

test('a machine gets five guesses, and the sixth is refused even when it is right', async () => {
  // A million possibilities is only a defence if guessing is bounded, and it
  // was not: this listener is a bare http server, and the express limiter is
  // mounted on the main API, which no peer ever reaches. An audit managed
  // 33,966 attempts in three seconds.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const wrong = offer.code === '000000' ? '111111' : '000000';
  const from = '192.168.1.77';
  for (let i = 0; i < 5; i++) {
    const res = await call(cfg, 'POST', '/fleet/pair', { from, body: { code: wrong } });
    assert.equal(res.status, 401, `guess ${i + 1} is simply wrong`);
  }
  // The SIXTH carries the REAL code. It must still be refused, or five wrong
  // guesses cost the guesser nothing at all.
  const right = await call(cfg, 'POST', '/fleet/pair', { from, body: { code: offer.code, instanceId: 'peer-1' } });
  assert.equal(right.status, 429);
  assert.equal(cfg.peers.length, 0, 'and nothing is paired');
  // One machine guessing must not lock the USER out of their own pairing.
  assert.ok(pairingOffer(), 'the code on screen still works');
  const elsewhere = await call(cfg, 'POST', '/fleet/pair', { from: '192.168.1.9', body: { code: offer.code, instanceId: 'peer-1' } });
  assert.equal(elsewhere.status, 200, 'the limit is per machine, not a lockout');
});

test('fifty wrong codes from fifty machines withdraw the offer entirely', async () => {
  // Five each is no defence against two hundred machines, or against one
  // machine willing to lie about its address.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const wrong = offer.code === '000000' ? '111111' : '000000';
  const abused: string[] = [];
  for (let i = 0; i < 50; i++) {
    await call(cfg, 'POST', '/fleet/pair', {
      from: `192.168.1.${i}`,
      body: { code: wrong },
      onPairingAbuse: (address) => abused.push(address),
    });
  }
  assert.equal(pairingOffer(), null, 'the offer is withdrawn, not merely slowed');
  assert.deepEqual(abused, ['192.168.1.49'], 'and the person here is told once, with the address');
  // The real code no longer pairs anything.
  const late = await call(cfg, 'POST', '/fleet/pair', { from: '192.168.1.200', body: { code: offer.code, instanceId: 'x' } });
  assert.equal(late.status, 401);
  assert.equal(cfg.peers.length, 0);
});

test('asking for a new code restores a machine that had spent its guesses', async () => {
  const cfg = defaultConfig();
  const first = beginPairing();
  const wrong = first.code === '000000' ? '111111' : '000000';
  const from = '192.168.1.77';
  for (let i = 0; i < 5; i++) await call(cfg, 'POST', '/fleet/pair', { from, body: { code: wrong } });
  assert.equal((await call(cfg, 'POST', '/fleet/pair', { from, body: { code: first.code } })).status, 429);
  // The refusal tells that machine to ask for a new code, so a new code must work.
  const second = beginPairing();
  const ok = await call(cfg, 'POST', '/fleet/pair', { from, body: { code: second.code, instanceId: 'peer-1' } });
  assert.equal(ok.status, 200, 'a fresh offer is a fresh allowance');
  assert.equal(cfg.peers.length, 1);
});

test('one machine is one machine whether it arrives as IPv4 or IPv4-in-IPv6', async () => {
  // A dual-stack socket reports ::ffff:192.168.1.77 for the same peer that an
  // IPv4 one reports as 192.168.1.77. Two buckets would be ten guesses.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const wrong = offer.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) await call(cfg, 'POST', '/fleet/pair', { from: '192.168.1.77', body: { code: wrong } });
  for (let i = 0; i < 2; i++) await call(cfg, 'POST', '/fleet/pair', { from: '::ffff:192.168.1.77', body: { code: wrong } });
  const right = await call(cfg, 'POST', '/fleet/pair', { from: '::ffff:192.168.1.77', body: { code: offer.code } });
  assert.equal(right.status, 429, 'a dual-stack socket must not buy a second allowance');
  assert.equal(cfg.peers.length, 0);
});

test('codes are six digits from a cryptographic source, and vary', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const { code } = beginPairing();
    assert.match(code, /^\d{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 30, 'codes must not repeat predictably');
});

test('secrets are compared in constant time, and length-checked first', () => {
  const secret = 'a'.repeat(64);
  assert.equal(secretMatches(secret, secret), true);
  assert.equal(secretMatches('b'.repeat(64), secret), false);
  assert.equal(secretMatches('short', secret), false, 'a length mismatch must not throw');
  assert.equal(secretMatches(undefined, secret), false);
});

/* ─────────────── The paired surface ─────────────── */

test('a paired peer gets the summary, and only the summary', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const paired = await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'peer-1' } });
  const secret = paired.body.secret;

  const res = await call(cfg, 'GET', '/fleet/summary', { secret });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...SUMMARY_FIELDS].sort());
});

test('remote scanning is refused until it is separately turned on', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;

  // A folder of this machine on every OS: on Windows a peer's root must be on one of its drives, and /tmp is not.
  const folder = path.resolve(os.tmpdir());
  // Paired is not enough — §D1 makes this a second, separate decision.
  const refused = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: folder } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /does not accept scans started from other machines/);

  cfg.allowRemoteScan = true;
  const accepted = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: folder } });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.scanId, 'scan-1');
  assert.equal(Object.keys(accepted.body).length, 1, 'a scan id, never a result');
});

test('a scan another machine asks for is judged by this machine’s own path rules first: a blocked folder, a second name or a relative path is refused 400, and no scan starts (the SEC-2 review, F2)', async () => {
  // The receiver handed body.path straight to startScan, which sanitizes nothing: a paired peer
  // allowed to start scans could root one at a blocked OS folder, at a second name of a path, or
  // at a path read from this server's working folder, and learn its sizes from the summary.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const windows = process.platform === 'win32';
  const tmp = path.resolve(os.tmpdir());
  const refused: [string, string][] = [
    [windows ? 'C:\\Windows\\System32' : '/dev', 'PATH_BLOCKED'],
    ['Documents', 'PATH_INVALID'],
    [path.join('..', 'elsewhere'), 'PATH_INVALID'],
    [`${tmp}\0x`, 'PATH_INVALID'],
    // `~` alone or `~/` is this machine's home; `~user` and `~x` are relative names (the SEC-2b review, F1.9).
    ['~user/x', 'PATH_INVALID'],
    ['~x', 'PATH_INVALID'],
  ];
  if (process.platform === 'darwin') refused.push(['/.nofollow/private/tmp', 'PATH_BLOCKED'], ['/.vol/1/2', 'PATH_BLOCKED']);
  if (windows) refused.push(['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Users', 'PATH_BLOCKED'], ['C:Users', 'PATH_INVALID']);
  for (const [p, code] of refused) {
    const r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } });
    assert.deepEqual([r.status, r.body?.code], [400, code], `${JSON.stringify(p)}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(scansStarted, [], 'no scan was started');
  // A path that passes is handed on as the sanitizer resolves it.
  const accepted = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: `  ${tmp}${path.sep}a${path.sep}..` } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  // And `~`, alone or before a separator, is this machine's home folder (the SEC-2b review, F1.9).
  const statuses = [];
  for (const p of ['~', '~/x']) statuses.push((await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } })).status);
  assert.deepEqual(statuses, [202, 202]);
  assert.deepEqual(scansStarted, [tmp, os.homedir(), path.join(os.homedir(), 'x')]);
});

test('on Windows a scan another machine asks for must be rooted on one of this machine’s drives: a network share would make this machine sign in to whatever server the peer names — its NTLM hash with it — so \\\\server\\share, //server/share, \\\\?\\UNC\\… and every other non-drive root are refused; elsewhere nothing changes (the SEC-3 brief, item 6b)', () => {
  const codes = (platform: NodeJS.Platform, paths: string[]) => Object.fromEntries(paths.map((p) => [p, peerScanRootRefusal(p, platform)?.code ?? null]));
  assert.deepEqual(codes('win32', [
    'C:\\Users\\me', 'd:/Photos', '\\\\?\\C:\\Users', '\\\\.\\D:\\', '~', '~\\Documents', '~/x',
    '\\\\attacker\\share', '//attacker/share/x', '\\\\?\\UNC\\attacker\\share', '\\\\.\\UNC\\attacker\\share', '\\/attacker/share',
    '  \\\\attacker\\share', '\\\\?\\GLOBALROOT\\Device\\Mup\\attacker\\share', '\\Users\\me',
    'C:Users', 'C:', 'Documents', '..\\elsewhere',
  ]), {
    'C:\\Users\\me': null, 'd:/Photos': null, '\\\\?\\C:\\Users': null, '\\\\.\\D:\\': null, '~': null, '~\\Documents': null, '~/x': null,
    '\\\\attacker\\share': 'PATH_BLOCKED', '//attacker/share/x': 'PATH_BLOCKED', '\\\\?\\UNC\\attacker\\share': 'PATH_BLOCKED',
    '\\\\.\\UNC\\attacker\\share': 'PATH_BLOCKED', '\\/attacker/share': 'PATH_BLOCKED', '  \\\\attacker\\share': 'PATH_BLOCKED',
    '\\\\?\\GLOBALROOT\\Device\\Mup\\attacker\\share': 'PATH_BLOCKED', '\\Users\\me': 'PATH_BLOCKED', // the current drive's root: which drive is not the peer's to know
    'C:Users': 'PATH_INVALID', 'C:': 'PATH_INVALID', 'Documents': 'PATH_INVALID', '..\\elsewhere': 'PATH_INVALID',
  });
  // On macOS and Linux //server/share is /server/share, a folder of this machine, and a share is a mount the user made.
  // `~` is read under a Mac's own home folder, never the host's: a Linux runner's is /home/runner.
  assert.deepEqual(Object.fromEntries(['/Volumes/share', '//server/share', '~', 'Documents'].map((p) => [p, peerScanRootRefusal(p, 'darwin', '/Users/me')?.code ?? null])),
    { '/Volumes/share': null, '//server/share': null, '~': null, 'Documents': 'PATH_INVALID' });
  assert.deepEqual(codes('linux', ['/mnt/share', '//server/share', '../x']), { '/mnt/share': null, '//server/share': null, '../x': 'PATH_INVALID' });
});

test('on a Mac a scan another machine asks for is refused at or under /net, /Network and /home — autofs mounts a network share there as soon as anything looks the name up, and a share that does not answer holds the scan — in any case and however the path is spelled; elsewhere, and on other systems, nothing changes (POL item 1)', () => {
  const codes = (platform: NodeJS.Platform, paths: string[]) => Object.fromEntries(paths.map((p) => [p, peerScanRootRefusal(p, platform, '/Users/me')?.code ?? null]));
  assert.deepEqual(codes('darwin', [
    '/net', '/net/nas/share', '/Network', '/Network/Servers/nas', '/home', '/home/someone', '/NET/nas', '/network/x', 'ｎｅｔ',
    '/tmp/../net/nas', '//net/nas', '/net/', '  /net/nas',
    '/netx', '/networks', '/Users/me/net', '/Volumes/net', '/homes', '/', '/Users/me', '~/x',
  ]), {
    '/net': 'AUTOMOUNT_PATH', '/net/nas/share': 'AUTOMOUNT_PATH', '/Network': 'AUTOMOUNT_PATH', '/Network/Servers/nas': 'AUTOMOUNT_PATH',
    '/home': 'AUTOMOUNT_PATH', '/home/someone': 'AUTOMOUNT_PATH', '/NET/nas': 'AUTOMOUNT_PATH', '/network/x': 'AUTOMOUNT_PATH',
    'ｎｅｔ': 'PATH_INVALID', // not absolute
    '/tmp/../net/nas': 'AUTOMOUNT_PATH', '//net/nas': 'AUTOMOUNT_PATH', '/net/': 'AUTOMOUNT_PATH', '  /net/nas': 'AUTOMOUNT_PATH',
    '/netx': null, '/networks': null, '/Users/me/net': null, '/Volumes/net': null, '/homes': null, '/': null, '/Users/me': null, '~/x': null,
  });
  // `~` is this machine's home — the one named, never the host's own, so the table reads the same on a
  // Linux runner (HOME=/home/runner) as on a Mac — and climbing out of it reaches the root like any other path.
  const homeCodes = (home: string, paths: string[]) => Object.fromEntries(paths.map((p) => [p, peerScanRootRefusal(p, 'darwin', home)?.code ?? null]));
  assert.deepEqual(homeCodes('/Users/me', ['~', '~/x', '~\\x', '~/../../net/nas', '~/../../Users/x']), {
    '~': null, '~/x': null, '~\\x': null, '~/../../net/nas': 'AUTOMOUNT_PATH', '~/../../Users/x': null,
  });
  assert.deepEqual(homeCodes('/home/someone', ['~', '~/x', '~/../../Users/x']), {
    '~': 'AUTOMOUNT_PATH', '~/x': 'AUTOMOUNT_PATH', // a home folder auto_home mounts
    '~/../../Users/x': null,
  });
  // Linux and Windows read these as before: a folder of this machine, or (on Windows) no drive.
  assert.deepEqual(codes('linux', ['/net/nas', '/Network/x', '/home/me']), { '/net/nas': null, '/Network/x': null, '/home/me': null });
  assert.deepEqual(codes('win32', ['/net/nas', 'C:\\net\\nas']), { '/net/nas': 'PATH_BLOCKED', 'C:\\net\\nas': null });
});

test('on a Mac the automount folders are refused under the Data volume’s spelling too — /home is a link to /System/Volumes/Data/home, where auto_home is mounted — in any case; the rest of the Data volume, and other systems, are unchanged (POL item 1 review, F1.1)', () => {
  const codes = (platform: NodeJS.Platform, paths: string[], home = '/Users/me') => Object.fromEntries(paths.map((p) => [p, peerScanRootRefusal(p, platform, home)?.code ?? null]));
  assert.deepEqual(codes('darwin', [
    '/System/Volumes/Data/home', '/System/Volumes/Data/home/x', '/System/Volumes/Data/net/nas', '/System/Volumes/Data/Network/Servers/x',
    '/system/volumes/data/HOME/x', '/System/Volumes/Data/./home/x', '/Users/../System/Volumes/Data/net/nas',
    '/System/Volumes/Data', '/System/Volumes/Data/Users/me', '/System/Volumes/Data/homes', '/System/Volumes/Preboot/home', '/System/Volumes/home/x', '/System/home',
  ]), {
    '/System/Volumes/Data/home': 'AUTOMOUNT_PATH', '/System/Volumes/Data/home/x': 'AUTOMOUNT_PATH', '/System/Volumes/Data/net/nas': 'AUTOMOUNT_PATH',
    '/System/Volumes/Data/Network/Servers/x': 'AUTOMOUNT_PATH', '/system/volumes/data/HOME/x': 'AUTOMOUNT_PATH',
    '/System/Volumes/Data/./home/x': 'AUTOMOUNT_PATH', '/Users/../System/Volumes/Data/net/nas': 'AUTOMOUNT_PATH',
    '/System/Volumes/Data': null, '/System/Volumes/Data/Users/me': null, '/System/Volumes/Data/homes': null,
    '/System/Volumes/Preboot/home': null, '/System/Volumes/home/x': null, '/System/home': null,
  });
  assert.deepEqual(codes('darwin', ['~', '~/x'], '/System/Volumes/Data/home/me'), { '~': 'AUTOMOUNT_PATH', '~/x': 'AUTOMOUNT_PATH' }, 'a home folder auto_home mounts, by its Data-volume name');
  assert.deepEqual(codes('linux', ['/System/Volumes/Data/home/x']), { '/System/Volumes/Data/home/x': null });
});

test('on a Mac a folder whose path reaches an automount folder through a link — the boot volume’s own entry in /Volumes, /home itself, a link a person made, relative or chained — is refused before any name inside it is looked up; a link elsewhere, a loop and a missing name are left to the sanitizer (POL item 1 review, F1.1)', () => {
  // A stand-in Mac: what lstat and readlink answer for each path, and a record of every lookup.
  const links: Record<string, string> = {
    '/home': '/System/Volumes/Data/home',
    '/Volumes/Macintosh HD': '/',
    '/Users/me/to-net': '/net',
    '/Users/me/hop': '/Users/me/to-net',
    '/Users/me/rel': '../../System/Volumes/Data/home',
    '/Users/me/rel2': '../me/to-net', // read from /Users/me, where the link is — from / it leads nowhere
    '/Users/me/to-data': '/System/Volumes/Data',
    '/Users/me/dotdot': '/Volumes/Macintosh HD/Users/..',
    '/Users/me/to-docs': '/Users/me/Documents',
    '/Users/me/loop': '/Users/me/loop',
  };
  const dirs = new Set(['/Users', '/Users/me', '/Users/me/Documents', '/System', '/System/Volumes', '/System/Volumes/Data',
    '/System/Volumes/Data/home', '/System/Volumes/Data/Users', '/Volumes', '/net', '/Network', '/Network/Servers']);
  const automounts = ['/net', '/Network', '/Network/Servers', '/System/Volumes/Data/home'];
  const looked: string[] = [];
  const io = {
    lstat(p: string) {
      looked.push(p);
      if (p in links) return { isSymbolicLink: () => true };
      if (dirs.has(p)) return { isSymbolicLink: () => false };
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    readlink(p: string) { looked.push(`readlink ${p}`); return links[p]; },
  };
  const verdicts = Object.fromEntries([
    '/Volumes/Macintosh HD/home/x', '/Volumes/Macintosh HD/net/nas', '/Volumes/Macintosh HD/Network/Servers/x',
    '/Users/me/to-net', '/Users/me/to-net/nas', '/Users/me/hop/nas', '/Users/me/rel/someone', '/Users/me/rel2/nas', '/Users/me/to-data/home/x',
    '/Users/me/dotdot/home/x', '/home/x',
    '/Volumes/Macintosh HD/Users/me/Documents', '/Users/me/to-docs/x', '/Users/me/loop/x', '/Users/me/missing/x', '/Users/me',
  ].map((p) => [p, walkDarwinLinks(p, io)]));
  assert.deepEqual(verdicts, {
    '/Volumes/Macintosh HD/home/x': 'automount', '/Volumes/Macintosh HD/net/nas': 'automount', '/Volumes/Macintosh HD/Network/Servers/x': 'automount',
    '/Users/me/to-net': 'automount', '/Users/me/to-net/nas': 'automount', '/Users/me/hop/nas': 'automount', '/Users/me/rel/someone': 'automount', '/Users/me/rel2/nas': 'automount',
    '/Users/me/to-data/home/x': 'automount', '/Users/me/dotdot/home/x': 'automount', '/home/x': 'automount',
    '/Volumes/Macintosh HD/Users/me/Documents': 'clear', '/Users/me/to-docs/x': 'clear', '/Users/me/loop/x': 'clear',
    '/Users/me/missing/x': 'clear', '/Users/me': 'clear',
  });
  const inside = looked.filter((p) => automounts.some((a) => path.posix.dirname(p.replace(/^readlink /, '')) === a));
  assert.deepEqual(inside, [], 'no name was looked up inside an automount folder');
});

/** Whether a lookup (as the stand-ins record it: "<call> <path>") reached a second name, or anything below one. */
const throughASecondName = (lookup: string): boolean => /^(?:\S+ )?\/\.(?:nofollow|resolve|vol)(?:\/|$)/i.test(lookup);

test('on a Mac the link walk never looks a name up through a second name — /.nofollow, /.resolve or /.vol, typed or where a link leads, absolute or relative, in any case — and ends there: /.nofollow/net/<host> is /net/<host>, and a look through it mounts the host’s share (POL item 1 review, F2.3 and F2.4)', () => {
  // A stand-in Mac where a second name answers as macOS answers it: as the folder it names.
  const links: Record<string, string> = {
    '/Users/me/to-nofollow-net': '/.nofollow/net/tm-no-such-host',
    '/Users/me/to-vol': '/.vol/16777220/2/net',
    '/Users/me/rel-alias': '../../.resolve/16777220/2',
    '/Users/me/to-shouted': '/.NoFollow/Users',
  };
  const dirs = new Set(['/Users', '/Users/me', '/.nofollow', '/.NoFollow', '/.nofollow/net', '/.nofollow/System', '/.nofollow/System/Volumes',
    '/.nofollow/System/Volumes/Data', '/.nofollow/System/Volumes/Data/home', '/.vol', '/.vol/16777220', '/.vol/16777220/2', '/.vol/16777220/2/net',
    '/.resolve', '/.RESOLVE', '/.resolve/16777220', '/.resolve/16777220/2', '/.NoFollow/Users']);
  const looked: string[] = [];
  const io = {
    lstat(p: string) {
      looked.push(`lstat ${p}`);
      if (p in links) return { isSymbolicLink: () => true };
      if (dirs.has(p)) return { isSymbolicLink: () => false };
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    readlink(p: string) { looked.push(`readlink ${p}`); return links[p]; },
  };
  const verdicts = Object.fromEntries([
    '/.nofollow/net/tm-no-such-host/share', '/.vol/16777220/2/net/tm-no-such-host', '/.nofollow/System/Volumes/Data/home/tm-no-such-user',
    '/.RESOLVE/16777220/2/x', '/Users/../.nofollow/net/x',
    '/Users/me/to-nofollow-net/share', '/Users/me/to-vol/tm-no-such-host', '/Users/me/rel-alias/x', '/Users/me/to-shouted/me',
    '/Users/me/.nofollow/x', // a folder of that name inside a home is no second name: it is looked up, and is not there
  ].map((p) => [p, walkDarwinLinks(p, io)]));
  assert.deepEqual(verdicts, {
    '/.nofollow/net/tm-no-such-host/share': 'second-name', '/.vol/16777220/2/net/tm-no-such-host': 'second-name',
    '/.nofollow/System/Volumes/Data/home/tm-no-such-user': 'second-name', '/.RESOLVE/16777220/2/x': 'second-name', '/Users/../.nofollow/net/x': 'second-name',
    '/Users/me/to-nofollow-net/share': 'second-name', '/Users/me/to-vol/tm-no-such-host': 'second-name', '/Users/me/rel-alias/x': 'second-name',
    '/Users/me/to-shouted/me': 'second-name',
    '/Users/me/.nofollow/x': 'clear',
  });
  assert.deepEqual(looked.filter(throughASecondName), [], 'nothing was looked up at or through a second name');
});

test('with macOS stood in for process.platform, the receiver refuses a peer’s folder spelled through a second name, or reached through a link to one, before anything is looked up through it — and a blocked folder before anything is looked up at all — 400 PATH_BLOCKED in words of its own, no scan (POL item 1 review, F2.3 and F2.4)', { skip: process.platform === 'win32' && 'making a link needs a privilege the runner may not hold' }, async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const tmp = fs.realpathSync(fileTempDir('tm-fleet-alias-link-'));
  fs.symlinkSync('/.nofollow/net/tm-no-such-host', path.join(tmp, 'to-alias'));
  // Every lookup is recorded. One at or through a second name, in an automount folder, under /dev or of a
  // tm-no-such name is answered "not there" by the stand-in and never reaches the file system, and nothing
  // that follows a link (realpath, stat) is let through to the link made here: on this Mac a regression
  // would otherwise really ask autofs for the host.
  const never = (p: string): boolean => throughASecondName(p) || /^\/(?:net|Network|home|dev)(?:\/|$)/i.test(p) || p.includes('tm-no-such');
  const touched: string[] = [];
  const writable = fs as { lstatSync: typeof fs.lstatSync; statSync: typeof fs.statSync; readlinkSync: typeof fs.readlinkSync };
  const realpath = fs.realpathSync.native;
  const { lstatSync: lstat, statSync: stat, readlinkSync: readlink } = writable;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  const stand = <F extends (...a: never[]) => unknown>(name: string, fn: F, follows: boolean): F => ((p: fs.PathLike, ...rest: unknown[]) => {
    touched.push(`${name} ${String(p)}`);
    if (never(String(p)) || (follows && String(p).includes('to-alias'))) {
      // "Not there", as the call itself says it: undefined where the caller asked for no throw.
      if ((rest[0] as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
    }
    return (fn as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as F;
  const answers: unknown[] = [];
  fs.realpathSync.native = stand('realpath', realpath, true);
  writable.lstatSync = stand('lstat', lstat, false);
  writable.statSync = stand('stat', stat, true);
  writable.readlinkSync = stand('readlink', readlink, false);
  Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
  try {
    for (const p of ['/.nofollow/net/tm-no-such-host/share', '/.vol/16777220/2/net/tm-no-such-host', '/.nofollow/System/Volumes/Data/home/tm-no-such-user',
      '/.Resolve/16777220/2', '/dev/tm-no-such-device', path.join(tmp, 'to-alias'), path.join(tmp, 'to-alias', 'share')]) {
      const r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } });
      answers.push([p.startsWith(tmp) ? path.relative(tmp, p) : p, r.status, r.body?.code ?? null, /^That machine/.test(String(r.body?.error))]);
    }
  } finally {
    Object.defineProperty(process, 'platform', real);
    fs.realpathSync.native = realpath;
    writable.lstatSync = lstat;
    writable.statSync = stat;
    writable.readlinkSync = readlink;
  }
  assert.deepEqual(answers, [
    ['/.nofollow/net/tm-no-such-host/share', 400, 'PATH_BLOCKED', true],
    ['/.vol/16777220/2/net/tm-no-such-host', 400, 'PATH_BLOCKED', true],
    ['/.nofollow/System/Volumes/Data/home/tm-no-such-user', 400, 'PATH_BLOCKED', true],
    ['/.Resolve/16777220/2', 400, 'PATH_BLOCKED', true],
    ['/dev/tm-no-such-device', 400, 'PATH_BLOCKED', true],
    ['to-alias', 400, 'PATH_BLOCKED', true],
    [path.join('to-alias', 'share'), 400, 'PATH_BLOCKED', true],
  ]);
  assert.deepEqual(touched.filter((t) => never(t.slice(t.indexOf(' ') + 1)) || /^(?:realpath|stat) .*to-alias/.test(t)), [],
    'nothing was looked up through a second name, at /dev, or by following the link to one');
  assert.deepEqual(scansStarted, [], 'no scan was started');
});

test('with macOS stood in for process.platform, the receiver refuses a peer’s folder that a link leads into /home, before any name inside it is looked up — 400 AUTOMOUNT_PATH in words of its own, no scan — while a link to an ordinary folder still scans (POL item 1 review, F1.1)', { skip: process.platform === 'win32' && 'making a link needs a privilege the runner may not hold' }, async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const tmp = fs.realpathSync(fileTempDir('tm-fleet-automount-link-'));
  fs.mkdirSync(path.join(tmp, 'real'));
  fs.symlinkSync('/home', path.join(tmp, 'to-home')); // /home: auto_home's on a Mac (by its link), an ordinary folder on Linux
  fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'to-real'));
  const touched: string[] = [];
  const writable = fs as { lstatSync: typeof fs.lstatSync; statSync: typeof fs.statSync; readlinkSync: typeof fs.readlinkSync };
  const realpath = fs.realpathSync.native;
  const { lstatSync: lstat, statSync: stat, readlinkSync: readlink } = writable;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  const answers: unknown[] = [];
  fs.realpathSync.native = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`realpath ${String(p)}`); return (realpath as (...a: unknown[]) => string)(p, ...rest); }) as typeof realpath;
  writable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`lstat ${String(p)}`); return (lstat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof lstat;
  writable.statSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`stat ${String(p)}`); return (stat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof stat;
  writable.readlinkSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`readlink ${String(p)}`); return (readlink as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof readlink;
  const homeBefore = process.env.HOME;
  const ask = async (platform: string, p: string) => {
    Object.defineProperty(process, 'platform', { ...real, value: platform });
    const r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } });
    answers.push([platform, p.startsWith(tmp) ? path.relative(tmp, p) : p, r.status, r.body?.code ?? null, r.status === 400 ? /^That machine/.test(String(r.body?.error)) : null]);
  };
  try {
    process.env.HOME = tmp; // os.homedir() reads it: `~` is the stand-in home, never the real one
    for (const p of [path.join(tmp, 'to-home', 'tm-no-such-user'), path.join(tmp, 'to-home'), '~/to-home', path.join(tmp, 'to-real')]) await ask('darwin', p);
    // On Linux /home is an ordinary folder: a link to it is scanned as before. (The folder itself, never a
    // name inside it, so on a Mac host nothing is looked up inside auto_home either.)
    await ask('linux', path.join(tmp, 'to-home'));
  } finally {
    Object.defineProperty(process, 'platform', real);
    if (homeBefore === undefined) delete process.env.HOME;
    else process.env.HOME = homeBefore;
    fs.realpathSync.native = realpath;
    writable.lstatSync = lstat;
    writable.statSync = stat;
    writable.readlinkSync = readlink;
  }
  assert.deepEqual(answers, [
    ['darwin', path.join('to-home', 'tm-no-such-user'), 400, 'AUTOMOUNT_PATH', true],
    ['darwin', 'to-home', 400, 'AUTOMOUNT_PATH', true],
    ['darwin', '~/to-home', 400, 'AUTOMOUNT_PATH', true],
    ['darwin', 'to-real', 202, null, null],
    ['linux', 'to-home', 202, null, null],
  ]);
  assert.deepEqual(touched.filter((t) => t.includes('tm-no-such-user')), [], 'no name inside the automount folder was looked up');
  assert.deepEqual(scansStarted, [path.join(tmp, 'to-real'), path.join(tmp, 'to-home')], 'only the ordinary folders were scanned');
});

test('with macOS stood in for process.platform, the receiver refuses a peer’s /net path before anything touches it — no realpath, lstat or stat — answers 400 AUTOMOUNT_PATH in words of its own, and no scan starts (POL item 1)', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const touched: string[] = [];
  const writable = fs as { lstatSync: typeof fs.lstatSync; statSync: typeof fs.statSync };
  const realpath = fs.realpathSync.native;
  const lstat = fs.lstatSync;
  const stat = fs.statSync;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  const answers: unknown[] = [];
  fs.realpathSync.native = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`realpath ${String(p)}`); return (realpath as (...a: unknown[]) => string)(p, ...rest); }) as typeof realpath;
  writable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`lstat ${String(p)}`); return (lstat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof lstat;
  writable.statSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`stat ${String(p)}`); return (stat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof stat;
  Object.defineProperty(process, 'platform', { ...real, value: 'darwin' });
  try {
    for (const p of ['/net/tm-no-such-host/share', '/Network/Servers/tm-no-such-host']) {
      const r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } });
      answers.push([p, r.status, r.body?.code, /^That machine/.test(String(r.body?.error))]);
    }
  } finally {
    Object.defineProperty(process, 'platform', real);
    fs.realpathSync.native = realpath;
    writable.lstatSync = lstat;
    writable.statSync = stat;
  }
  assert.deepEqual(answers, [
    ['/net/tm-no-such-host/share', 400, 'AUTOMOUNT_PATH', true],
    ['/Network/Servers/tm-no-such-host', 400, 'AUTOMOUNT_PATH', true],
  ]);
  assert.deepEqual(touched.filter((t) => /tm-no-such-host|\/net\b|\/Network\b/.test(t)), [], 'nothing asked the file system about the share');
  assert.deepEqual(scansStarted, [], 'no scan was started');
});

test('every sentence a peer reads about this machine’s refusal of its folder speaks of “that machine”, as the asker shows it as is — never “this machine”, which there names the asker (SEC-3 review, wording)', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  const sentences: Record<string, string> = {
    'not absolute': String(peerScanRootRefusal('Documents', 'win32')?.message),
    'a share, on Windows': String(peerScanRootRefusal('\\\\srv\\share', 'win32')?.message),
    'no drive, on Windows': String(peerScanRootRefusal('/Users/x', 'win32')?.message),
    'an automount folder, on a Mac': String(peerScanRootRefusal('/net/nas', 'darwin')?.message),
  };
  for (const p of [process.platform === 'win32' ? 'C:\\Windows\\System32' : '/dev', 'Documents']) {
    sentences[`the receiver, ${p}`] = String((await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } })).body?.error);
  }
  const wrong = Object.entries(sentences).filter(([, s]) => !/^That machine/.test(s) || /this machine/i.test(s)).map(([k, s]) => `${k}: ${s}`);
  assert.deepEqual(wrong, []);
});

test('with Windows stood in for process.platform, the receiver refuses a peer’s network share before anything touches the path — no realpath, lstat or stat, so no sign-in to the server it names — and no scan starts (the SEC-3 brief, item 6b)', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const touched: string[] = [];
  const writable = fs as { lstatSync: typeof fs.lstatSync; statSync: typeof fs.statSync };
  const realpath = fs.realpathSync.native;
  const lstat = fs.lstatSync;
  const stat = fs.statSync;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  const answers: unknown[] = [];
  fs.realpathSync.native = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`realpath ${String(p)}`); return (realpath as (...a: unknown[]) => string)(p, ...rest); }) as typeof realpath;
  writable.lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`lstat ${String(p)}`); return (lstat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof lstat;
  writable.statSync = ((p: fs.PathLike, ...rest: unknown[]) => { touched.push(`stat ${String(p)}`); return (stat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof stat;
  Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
  try {
    for (const p of ['\\\\attacker\\share', '//attacker/share/x', '\\\\?\\UNC\\attacker\\share']) {
      const r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: p } });
      answers.push([p, r.status, r.body?.code]);
    }
  } finally {
    Object.defineProperty(process, 'platform', real);
    fs.realpathSync.native = realpath;
    writable.lstatSync = lstat;
    writable.statSync = stat;
  }
  assert.deepEqual(answers, [
    ['\\\\attacker\\share', 400, 'PATH_BLOCKED'],
    ['//attacker/share/x', 400, 'PATH_BLOCKED'],
    ['\\\\?\\UNC\\attacker\\share', 400, 'PATH_BLOCKED'],
  ]);
  assert.deepEqual(touched.filter((t) => t.includes('attacker')), [], 'nothing asked the file system about the share');
  assert.deepEqual(scansStarted, [], 'no scan was started');
});

test('a peer refused by this machine’s path rules is told why in words of its own — never the path as resolved here, which names this machine’s home folder once `~` is expanded (the SEC-3 brief, item 7)', { skip: process.platform === 'win32' && 'making a link needs a privilege the runner may not hold' }, async () => {
  // The receiver sent the sanitizer's sentence, `Scanning "/Users/<name>/x" is not allowed`, to the
  // machine that asked for `~/x`: this machine's home folder, and with it the person's account name.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  scansStarted.length = 0;
  const home = fs.realpathSync(fileTempDir('tm-fleet-home-'));
  fs.symlinkSync('/dev/null', path.join(home, 'to-dev'));
  const before = process.env.HOME;
  process.env.HOME = home; // os.homedir() reads it: the real home is never looked at
  let r: { status: number; body: any };
  try {
    assert.equal(os.homedir(), home, 'the stand-in home is the one `~` expands to');
    r = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: '~/to-dev' } });
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
  assert.deepEqual([r.status, r.body?.code], [400, 'PATH_BLOCKED']);
  assert.ok(!String(r.body?.error).includes(home), `the answer names no path of this machine: ${String(r.body?.error)}`);
  assert.match(String(r.body?.error), /path rules/, 'and says what refused it');
  assert.deepEqual(scansStarted, []);
});

test('a scan another machine asks for is held to agent-policy.json’s allowedRoots, as one asked for here is: outside them 403 POLICY_ROOT_NOT_ALLOWED and nothing is scanned; inside them it starts', async () => {
  // AGENTS.md: allowedRoots "confines both scanning and destruction". POST /api/scan, the MCP scan_path
  // tool, the index and Autopilot asked it; the scan a paired peer starts did not.
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  const allowed = fs.realpathSync(fileTempDir('tm-fleet-allowed-'));
  fs.writeFileSync(path.join(allowed, 'a.txt'), 'a');
  const elsewhere = fs.realpathSync(fileTempDir('tm-fleet-elsewhere-'));
  const policyFile = path.join(appDataDir(), POLICY_FILE);
  fs.writeFileSync(policyFile, JSON.stringify({ allowedRoots: [allowed] }));
  try {
    const refused = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: elsewhere }, startScan: startPeerScan });
    assert.deepEqual([refused.status, refused.body?.code], [403, 'POLICY_ROOT_NOT_ALLOWED'], JSON.stringify(refused.body));
    // In words for the person who reads them, on the machine that asked: the policy's own sentence told
    // that person to edit agent-policy.json, which named their own file — it governs nothing here (the
    // SEC-2c review, F2.4).
    const sentence = String(refused.body?.error);
    assert.deepEqual({
      'names the other machine': /^That machine\b/.test(sentence),
      'names whose file it is': /\bits own agent-policy\.json\b/.test(sentence),
      'never tells the reader to edit a file': !/\bedit\b/i.test(sentence),
      fields: Object.keys(refused.body ?? {}).sort(),
    }, {
      'names the other machine': true, 'names whose file it is': true, 'never tells the reader to edit a file': true, fields: ['code', 'error'],
    }, sentence);
    // Ids, not records: a finished scan's record holds its whole store, and a diff of that is not a message.
    assert.deepEqual(allScans().filter((s) => s.rootPath === elsewhere).map((s) => s.scanId), [], 'nothing was scanned');
    const started = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: allowed }, startScan: startPeerScan });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const scan = getScan(started.body.scanId);
    await waitFor(() => scan?.status !== 'running', 'the scan inside the allowed root');
    assert.deepEqual([scan?.rootPath, scan?.status], [allowed, 'complete']);
  } finally {
    fs.rmSync(policyFile, { force: true });
  }
});

/** GET /api/fleet as the fleet panel asks it: the real app, on a port of its own, its JSON body. */
async function fleetPanelReply(): Promise<unknown> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as { port: number };
    return await new Promise<unknown>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/fleet' }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (err) {
            reject(new Error(`GET /api/fleet answered ${res.statusCode} with no JSON: ${String(err)}`));
          }
        });
      }).on('error', reject);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('the listener FleetRuntime starts hands a paired peer’s scan to startPeerScan — its own hooks, not a copy — so allowedRoots holds for it; its summary is this machine’s for the config it runs with, and a guesser it reports reaches the fleet panel (the SEC-2c review, F2.6; the SEC-2d review, F3.6)', async () => {
  // The test above hands startPeerScan to the harness itself, so the one line wiring it into the listener
  // (FleetRuntime.apply) was pinned by nothing: putting back the old hook, which asked no policy, left this
  // file green. apply() binds a LAN socket and advertises on mDNS, so the wiring is read from its source
  // — the hooks it starts the listener with are `this.peerHooks(cfg)` — and those hooks are driven here.
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fleet', 'fleetRuntime.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.deepEqual(
    (runtimeSource.match(/startPeerServer\([^;]*\)/g) ?? []).map((call) => call.replace(/\s+/g, ' ')),
    ['startPeerServer(cfg, this.peerHooks(cfg), addresses)'],
    'apply() starts the listener with the runtime’s own hooks, and nothing else starts one',
  );
  const cfg = { ...defaultConfig(), label: 'tm-fleet-hooks-label' };
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;
  const allowed = fs.realpathSync(fileTempDir('tm-fleet-hooks-allowed-'));
  const elsewhere = fs.realpathSync(fileTempDir('tm-fleet-hooks-elsewhere-'));
  const policyFile = path.join(appDataDir(), POLICY_FILE);
  fs.writeFileSync(policyFile, JSON.stringify({ allowedRoots: [allowed] }));
  try {
    const hooks = fleetRuntime().peerHooks(cfg);
    const refused = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: elsewhere }, startScan: hooks.startScan });
    assert.deepEqual([refused.status, refused.body?.code], [403, 'POLICY_ROOT_NOT_ALLOWED'], JSON.stringify(refused.body));
    assert.deepEqual(allScans().filter((s) => s.rootPath === elsewhere).map((s) => s.scanId), [], 'nothing was scanned');
    // The other two hooks were moved into peerHooks with it and driven by nothing: dropping the guesser
    // warning, or answering with another config's summary, left this file green (the SEC-2d review, F3.6).
    fleetRuntime().clearPairingAbuse();
    hooks.onPairingAbuse?.('192.168.1.9');
    const summary = await hooks.summary();
    // What the panel reads is GET /api/fleet's `pairingStopped`: the route is driven too, since the
    // runtime's own record reached no panel while that line was missing (the final review, F1.6).
    const panel = await fleetPanelReply();
    assert.deepEqual(
      {
        'the guesser the runtime records': fleetRuntime().pairingAbuse()?.address,
        'the guesser GET /api/fleet tells the panel of': (panel as { pairingStopped?: { address?: string } | null }).pairingStopped?.address,
        label: summary.label,
        instanceId: summary.instanceId,
      },
      {
        'the guesser the runtime records': '192.168.1.9',
        'the guesser GET /api/fleet tells the panel of': '192.168.1.9',
        label: 'tm-fleet-hooks-label',
        instanceId: cfg.instanceId,
      },
    );
  } finally {
    fleetRuntime().clearPairingAbuse();
    fs.rmSync(policyFile, { force: true });
  }
});

test('this machine tells the network the version it is, read from its own package.json: the desktop app is started by Electron, not npm, so npm_package_version is not there to read, and peers saw a blank version (the LEFT brief, item 1)', async () => {
  const saved = process.env.npm_package_version;
  // As the packaged app runs: npm sets this only for a process it starts itself.
  delete process.env.npm_package_version;
  try {
    const shipped = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
    assert.match(shipped, /^\d+\.\d+\.\d+/, 'control: package.json names a version');
    const cfg = defaultConfig();
    assert.equal((await fleetRuntime().summary(cfg)).version, shipped, 'the summary a paired peer reads');
    assert.equal(fleetRuntime().advertisedTxt(cfg).v, shipped, 'and the mDNS record every machine on the network reads');
    assert.deepEqual(
      [fleetRuntime().advertisedTxt(cfg).id, fleetRuntime().advertisedTxt(cfg).label],
      [cfg.instanceId, cfg.label],
      'the record still names this machine as it did',
    );
  } finally {
    if (saved === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = saved;
  }
  // apply() binds a LAN socket, so what it advertises is read from its source, as the hooks are above.
  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fleet', 'fleetRuntime.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.deepEqual(
    (runtimeSource.match(/\btxt:[^\n]*/g) ?? []).map((line) => line.trim()),
    ['txt: this.advertisedTxt(cfg),'],
    'apply() advertises the record advertisedTxt builds, and nothing else does',
  );
  // And no code anywhere reads the variable that only exists under `npm run` (a comment may name it).
  const readers: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|cjs)$/.test(name)) continue;
      const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
      if (code.includes('npm_package_version')) readers.push(path.relative(path.join(__dirname, '..'), full));
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  walk(path.join(__dirname, '..', 'electron'));
  assert.deepEqual(readers, [], 'no shipped code reads npm_package_version');
});

test('only this machine’s allowedRoots refusal is the peer’s 403: a policy file that cannot be read, or any other refusal the scan meets, is this server’s own failure — 500, its detail kept here — and nothing is scanned (the SEC-2c review, F2.10)', async () => {
  // The receiver passed any 403 AppError on word for word, and nothing pinned the line that chose: a
  // receiver passing on EVERY AppError — a corrupt agent-policy.json's 500 POLICY_UNREADABLE among them,
  // its parse detail crossing the network as a 403 — stayed green.
  const cfg: FleetConfig = { ...defaultConfig(), port: 0, allowRemoteScan: true };
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  const folder = fs.realpathSync(fileTempDir('tm-fleet-unreadable-'));
  const policyFile = path.join(appDataDir(), POLICY_FILE);
  let hook: (root: string) => Promise<{ scanId: string }> = startPeerScan;
  // A real listener on loopback: what the asking machine reads is what the socket answers.
  const server = await startPeerServer(cfg, { async summary() { return summary(); }, startScan: (root) => hook(root) }, ['127.0.0.1']);
  const ask = () => new Promise<[number, unknown]>((resolve, reject) => {
    const payload = JSON.stringify({ path: folder });
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: '/fleet/scan', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve([res.statusCode ?? 0, JSON.parse(text)]));
    });
    req.on('error', reject);
    req.end(payload);
  });
  try {
    fs.writeFileSync(policyFile, '{"allowedRoots": [');
    const answers: Record<string, unknown> = { 'a policy file that cannot be read': await ask() };
    fs.rmSync(policyFile, { force: true });
    hook = async () => { throw new AppError(403, 'PERMISSION_DENIED', 'a refusal of this machine, in words for this machine'); };
    answers['another 403'] = await ask();
    hook = async () => { throw new AppError(404, 'NOT_FOUND', 'a refusal of this machine, in words for this machine'); };
    answers['another status'] = await ask();
    const failure = [500, { error: 'fleet request failed' }];
    assert.deepEqual(answers, { 'a policy file that cannot be read': failure, 'another 403': failure, 'another status': failure });
    assert.deepEqual(allScans().filter((s) => s.rootPath === folder).map((s) => s.scanId), [], 'nothing was scanned');
  } finally {
    await server.close();
    for (const f of fs.readdirSync(appDataDir())) if (f.startsWith(POLICY_FILE)) fs.rmSync(path.join(appDataDir(), f), { force: true });
  }
});

test('there is no route that deletes, reads a file, or lists a directory', async () => {
  const cfg = defaultConfig();
  const offer = beginPairing();
  const secret = (await call(cfg, 'POST', '/fleet/pair', { body: { code: offer.code, instanceId: 'p' } })).body.secret;
  cfg.allowRemoteScan = true;

  for (const [method, url] of [
    ['DELETE', '/fleet/files'], ['POST', '/fleet/delete'], ['POST', '/fleet/trash'],
    ['GET', '/fleet/files'], ['GET', '/fleet/tree'], ['GET', '/fleet/security'],
    ['GET', '/fleet/provenance'], ['GET', '/api/security/findings'], ['GET', '/api/scan/1/result'],
  ] as const) {
    const res = await call(cfg, method, url, { secret });
    assert.equal(res.status, 404, `${method} ${url} must not exist on the peer surface`);
  }
});

test('the peer handler source contains no deletion path at all', () => {
  // §D1: "Remote deletion is out of scope entirely." Not guarded — absent.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fleet', 'fleetSync.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  for (const forbidden of ['moveToTrash', 'unlink', 'rmSync', 'emptyTrash', 'offload']) {
    assert.ok(!src.includes(forbidden), `the fleet service must not reference ${forbidden}`);
  }
});

/* ─────────────── LAN only ─────────────── */

test('only private addresses count as LAN', () => {
  for (const addr of ['10.0.0.5', '172.16.4.1', '172.31.255.254', '192.168.1.9', '169.254.3.3']) {
    assert.equal(isPrivateIPv4(addr), true, `${addr} is private`);
  }
  for (const addr of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.7', 'not-an-ip', '999.1.1.1']) {
    assert.equal(isPrivateIPv4(addr), false, `${addr} must never be advertised on`);
  }
});

test('loopback and public interfaces are never bound', () => {
  const addresses = lanAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
    ppp0: [{ address: '203.0.113.9', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
    en1: [{ address: 'fe80::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo],
  });
  assert.deepEqual(addresses, ['192.168.1.20'], 'the private v4 interface, and nothing else');
});

test('a machine with no private address does not start the listener', async () => {
  await assert.rejects(
    startPeerServer(defaultConfig(), { async summary() { return summary(); }, async startScan() { return { scanId: 'x' }; } }, []),
    /No private network address/,
  );
});

/* ─────────────── Defaults survive a hostile config file ─────────────── */

test('a malformed stored config can never turn the feature on', async () => {
  const { loadFleetConfig } = await import('../src/services/fleet/fleetSync');
  const { writeJsonFile } = await import('../src/services/storage');
  resetFleetConfig();
  await writeJsonFile('fleet.json', { enabled: 'yes', allowRemoteScan: 1, peers: [{ nope: true }, null] });
  const cfg = await loadFleetConfig();
  assert.equal(cfg.enabled, false, 'only a real boolean true enables it');
  assert.equal(cfg.allowRemoteScan, false);
  assert.deepEqual(cfg.peers, [], 'entries that are not peers are dropped');
  assert.equal(cfg.port, DEFAULT_FLEET_PORT);
});

/* ══════════ v4 §6: no derived fact ever crosses the network ══════════ */

test('the boundary check rejects every per-node fact v4 derives', () => {
  // §6 names these by category: reclaim scores, journal entries, notes and
  // recoverability verdicts. Each is a statement about what is on this
  // machine's disks — the category §D1 bans outright.
  //
  // Asserted against the predicate rather than through `serialiseSummary`,
  // and that distinction is the point. The allow-list already makes these
  // unreachable: a smuggled `reclaimScore` is dropped before its name is ever
  // inspected (the test below proves that). The second check only fires if
  // someone ADDS one of these to SUMMARY_FIELDS — the exact future mistake it
  // exists to catch, and one no call to the public function can reproduce.
  const facts = [
    'reclaimScore', 'score', 'scoreComponents', 'reclaimWeights', // §3
    'recoverability', 'elsewhere', 'lastUsed', 'lastUsedMs', // §1
    'journal', 'journalEntries', // §7.3
    'note', 'notes', 'folderNotes', // §9.5
    'unaccounted', 'unaccountedBytes', 'statement', 'accountingStatement', // §5
    'purgeable', 'purgeableBytes', 'unscannable', 'mountPoint', // §5
    'subtreeCount', 'subtreeCounts', 'fileCount', // §6.1
  ];
  for (const field of facts) {
    assert.ok(isForbiddenSummaryField(field), `a "${field}" field must be refused at the boundary`);
  }
});

test('the eleven fields §D1 does allow still pass the same check', () => {
  // A substring ban is easy to widen past what it meant to catch, and a guard
  // that quietly made the summary unsendable would look exactly like the
  // fleet being broken.
  for (const key of SUMMARY_FIELDS) {
    assert.equal(isForbiddenSummaryField(key), false, `${key} must still be sendable`);
  }
  const out = serialiseSummary(summary());
  assert.equal(Object.keys(out).length, SUMMARY_FIELDS.length);
});

test('a reclaim score smuggled onto a summary is dropped by the allow-list', () => {
  const hostile = {
    ...summary(),
    reclaimScore: 92,
    recoverability: { elsewhere: 'none' },
    notes: ['client archive, keep until 2027'],
    // §5 — an accounting statement is a description of this machine's disks,
    // right down to the name of every volume attached to it.
    statement: { lines: [{ id: 'snapshots', bytes: 42 }], mountPoint: "/Volumes/Bob's Backup" },
    unaccountedBytes: 7,
  } as unknown as FleetSummary;
  const wire = serialiseSummary(hostile) as Record<string, unknown>;
  assert.equal(Object.keys(wire).length, SUMMARY_FIELDS.length);
  assert.equal(wire.reclaimScore, undefined);
  assert.equal(wire.recoverability, undefined);
  assert.equal(wire.notes, undefined);
  assert.equal(wire.statement, undefined);
  assert.equal(wire.unaccountedBytes, undefined);
  assert.ok(!JSON.stringify(wire).includes('2027'), 'and no note text reaches the wire');
  assert.ok(!JSON.stringify(wire).includes('Bob'), 'and no volume name reaches it either');
});

test('journal entries smuggled onto a summary are dropped by the allow-list', () => {
  // §7.3 — every journal line narrates what is on this machine's disks and
  // who put it there, which is the category §D1 bans from the wire outright.
  const hostile = {
    ...summary(),
    journalEntries: [{
      path: '/Users/x/Library/Containers/com.docker.docker',
      delta: 14_200_000_000,
      sentence: 'Docker added 14.2 GB (~/Library/Containers/com.docker.docker)',
    }],
    journal: 'you removed 4.1 GB from Downloads',
  } as unknown as FleetSummary;
  const wire = serialiseSummary(hostile) as Record<string, unknown>;
  assert.equal(Object.keys(wire).length, SUMMARY_FIELDS.length);
  assert.equal(wire.journalEntries, undefined);
  assert.equal(wire.journal, undefined);
  assert.ok(!JSON.stringify(wire).includes('docker'), 'no journal text reaches the wire');
  assert.ok(!JSON.stringify(wire).includes('Downloads'), 'not a sentence of it');
  // And the second check would refuse the fields by name even if a future
  // change added them to the allow-list itself.
  assert.ok(isForbiddenSummaryField('journalEntries'));
  assert.ok(isForbiddenSummaryField('journal'));
});
