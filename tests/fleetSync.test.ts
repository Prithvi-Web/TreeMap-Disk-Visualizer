import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-fleet-'));

import {
  DEFAULT_FLEET_PORT, FleetConfig, PAIRING_WINDOW_MS, beginPairing, cancelPairing,
  defaultConfig, handlePeerRequest, isPrivateIPv4, lanAddresses, pairingOffer,
  resetFleetConfig, secretMatches, verifyPairingCode,
} from '../src/services/fleet/fleetSync';
import { FleetSummary, SUMMARY_FIELDS, buildSummary, isForbiddenSummaryField, serialiseSummary } from '../src/services/fleet/fleetSummary';

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

/** Drive one request through the peer handler without opening a socket. */
async function call(
  cfg: FleetConfig,
  method: string,
  url: string,
  opts: { body?: unknown; secret?: string } = {},
): Promise<{ status: number; body: any }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  req.url = url;
  req.headers = opts.secret ? { authorization: `Bearer ${opts.secret}` } : {};
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '192.168.1.50' } });

  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    end(chunk?: string) { text = chunk ?? ''; },
  } as unknown as http.ServerResponse;

  const done = handlePeerRequest(req, res, cfg, {
    async summary() { return summary({ acceptsRemoteScan: cfg.allowRemoteScan }); },
    async startScan() { return { scanId: 'scan-1' }; },
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

  // Paired is not enough — §D1 makes this a second, separate decision.
  const refused = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: '/tmp' } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /does not accept scans started from other machines/);

  cfg.allowRemoteScan = true;
  const accepted = await call(cfg, 'POST', '/fleet/scan', { secret, body: { path: '/tmp' } });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.scanId, 'scan-1');
  assert.equal(Object.keys(accepted.body).length, 1, 'a scan id, never a result');
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
  const { startPeerServer } = await import('../src/services/fleet/fleetSync');
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
