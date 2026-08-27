import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-reclaimprov-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { clearFactCache, computeFacts } from '../src/services/facts';
import type { ReclaimScoreFactValue } from '../src/services/facts';
import { clearScanInputs, computeSizeDistribution, claimFor, RuleClaims } from '../src/services/reclaimInputs';
import { parseXattrBatch, readDownloadOriginsMac } from '../src/platform/macos/provenance';
import { parseGetfattrBatch, decodeGetfattrValue } from '../src/platform/linux/provenance';
import { readDownloadOriginsWindows } from '../src/platform/windows/zoneIdentifier';
import { buildStoreFromTree } from '../src/services/scanStore';

/**
 * The Reclaim Score provider (v4 §3.1) — the gathering half.
 *
 * `tests/reclaimScore.test.ts` pins the arithmetic. This file pins the part
 * that decides *what the arithmetic is given*, which is where the honesty
 * rules actually get broken: every one of the six components has a state that
 * looks like zero and is not.
 *
 *  - duplicate hashing that has never run is not "no duplicates";
 *  - a download record that could not be read is not "never downloaded";
 *  - `elsewhere: unknown` is not "no copy exists";
 *  - a file inside a claimed `node_modules` is not "unrecognised" merely
 *    because the matcher stopped at the folder.
 *
 * Each of those has a dedicated test below, because each would produce a
 * plausible-looking number that nobody would question.
 */

/* ------------------------------ harness ------------------------------ */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * §3's acceptance fixture, built exactly as the spec words it: "two files of
 * **identical size** — one a `node_modules` in a fully-pushed repo, one an
 * un-backed-up original video **last opened yesterday**".
 *
 * Both conditions are load-bearing, and getting either wrong makes the test
 * pass or fail for the wrong reason. Identical sizes cancel the `size`
 * component, so the gap that remains is the gap the score's *reasoning*
 * produced. A fresh video cancels `staleness` too — an old video would score
 * well for a reason that has nothing to do with the point being made, which
 * is that regenerability and recoverability separate two identical
 * rectangles.
 *
 * The repository is real, with a real bare origin and a real push, because
 * the whole `elsewhere` sub-signal is a `git` invocation. And `node_modules`
 * is genuinely gitignored here — which is what makes this fixture interesting
 * rather than convenient: the remote has never held it, so a correct
 * implementation must NOT credit it as "proven elsewhere". It has to win on
 * regenerability, which is the honest reason it is safe to delete.
 */
const FILE_BYTES = 65_536;

function gitIn(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function scannedFixture(port: number) {
  // No "reclaim" in the directory name: an earlier version of this fixture
  // used one, and the assertion that no score leaked into the byte-locked
  // /result response matched the fixture's own PATH inside it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-accept-fixture-'));

  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  gitIn(repo, ['init', '-q']);
  gitIn(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  gitIn(repo, ['config', 'user.email', 't@example.invalid']);
  gitIn(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), Buffer.alloc(FILE_BYTES, 0x61));
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'init']);
  gitIn(repo, ['remote', 'add', 'origin', origin]);
  gitIn(repo, ['push', '-q', '-u', 'origin', 'main']);

  const video = path.join(root, 'original.mov');
  fs.writeFileSync(video, Buffer.alloc(FILE_BYTES, 0x62));
  const yesterday = new Date(Date.now() - 86_400_000);
  fs.utimesSync(video, yesterday, yesterday);

  // A third file, genuinely old, for the staleness comparison.
  const archive = path.join(root, 'archive.iso');
  fs.writeFileSync(archive, Buffer.alloc(FILE_BYTES, 0x63));
  const longAgo = new Date(Date.now() - 1100 * 86_400_000);
  fs.utimesSync(archive, longAgo, longAgo);

  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, `scan refused: ${JSON.stringify(started.body)}`);
  const scanId = started.body.scanId as string;
  for (let i = 0; i < 400; i++) {
    const stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
    if (stats.body.status === 'complete') break;
    assert.notEqual(stats.body.status, 'error', 'fixture scan failed');
    await new Promise((r) => setTimeout(r, 25));
  }
  clearFactCache();
  clearScanInputs();
  return {
    root,
    scanId,
    nodeModules: path.join(repo, 'node_modules'),
    deepInsideNodeModules: path.join(repo, 'node_modules', 'left-pad', 'index.js'),
    video,
    archive,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function score(scanId: string, paths: string[]): Promise<Record<string, ReclaimScoreFactValue>> {
  const out = await computeFacts(scanId, paths, ['reclaimScore'], new AbortController().signal);
  const provider = out.reclaimScore;
  assert.ok(provider.available, `reclaimScore unavailable: ${provider.reason}`);
  return provider.values as Record<string, ReclaimScoreFactValue>;
}

const missingIds = (f: ReclaimScoreFactValue): string[] => f.missing.map((m) => m.id).sort();
const componentIds = (f: ReclaimScoreFactValue): string[] => f.components.map((c) => c.id).sort();

/* ══════════════════════ end to end, over a real scan ══════════════════════ */

test('§3 acceptance: identical sizes, and the regenerable one scores far higher', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const scored = await score(fx.scanId, [fx.nodeModules, fx.video]);
    const regen = scored[fx.nodeModules];
    const keep = scored[fx.video];
    assert.ok(regen, 'node_modules must be scored');
    assert.ok(keep, 'the original must be scored');

    // Same bytes, same age. Everything separating them is reasoning.
    const regenSize = regen.components.find((c) => c.id === 'size')!;
    const keepSize = keep.components.find((c) => c.id === 'size')!;
    assert.equal(regenSize.value, keepSize.value, 'the fixture cancels the size component by construction');

    assert.ok(regen.score > keep.score * 1.5,
      `node_modules (${regen.score}) must clearly outrank an un-backed-up original (${keep.score})`);

    // It must win for the RIGHT reason. node_modules is gitignored here, so
    // the remote has never held it — crediting it as "a copy exists
    // elsewhere" would be the exact defect an earlier review caught.
    const elsewhere = regen.components.find((c) => c.id === 'elsewhere');
    assert.ok(!elsewhere || elsewhere.value === 0,
      'an ignored folder was never pushed; it must not be credited as recoverable from the remote');
    const rule = regen.components.find((c) => c.id === 'regenerable');
    assert.ok(rule && rule.value > 0, 'it wins on regenerability, which is the honest reason');
    assert.match(rule.why, /npm install/, `the why must name what puts it back: ${rule.why}`);

    // And the video is not claimed by any rule — a checked zero, not a gap.
    const keepRule = keep.components.find((c) => c.id === 'regenerable');
    assert.ok(keepRule);
    assert.equal(keepRule.value, 0);
    assert.match(keepRule.why, /no cleanup rule/i);
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('an un-backed-up original reports "elsewhere" as UNKNOWN, never as zero', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const fact = (await score(fx.scanId, [fx.video]))[fx.video];
    assert.ok(fact);
    const asComponent = fact.components.find((c) => c.id === 'elsewhere');
    const asMissing = fact.missing.find((m) => m.id === 'elsewhere');

    // On a machine with a backup system configured this file could legitimately
    // answer; what must never happen is an `unknown` verdict arriving as a
    // scored zero, because that ranks "TreeMap cannot tell you" identically to
    // "TreeMap checked, and no copy exists".
    if (asMissing) {
      assert.ok(!asComponent, 'a component is either answered or missing, never both');
      assert.ok(asMissing.reason.trim().length > 8, asMissing.reason);
    } else {
      assert.ok(asComponent, 'elsewhere must be either answered or explicitly missing');
      assert.ok(asComponent.why.trim().length > 8);
    }
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('every breakdown reads as English, and no component is a bare number', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const scored = await score(fx.scanId, [fx.video, fx.nodeModules, fx.archive]);
    for (const [p, fact] of Object.entries(scored)) {
      assert.ok(fact.components.length > 0, `${p} scored with no components at all`);
      for (const c of fact.components) {
        assert.ok(c.why.trim().length > 8, `${c.id} has no readable reason: "${c.why}"`);
        assert.ok(c.label.length > 0, `${c.id} has no label`);
        assert.ok(Number.isFinite(c.contribution));
        // The stutter an earlier version produced: "node_modules - A folder
        // named node_modules., restored with npm install".
        assert.ok(!c.why.includes('.,'), `${c.id} reads like a template, not a sentence: "${c.why}"`);
        assert.ok(!/ — $|^ /.test(c.why), `${c.id} has a dangling joiner: "${c.why}"`);
      }
      for (const m of fact.missing) {
        assert.ok(m.reason.trim().length > 8, `${m.id} is missing with no reason: "${m.reason}"`);
      }
    }
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('a file deep inside a claimed folder inherits the rule, and says where from', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const fact = (await score(fx.scanId, [fx.deepInsideNodeModules]))[fx.deepInsideNodeModules];
    assert.ok(fact, 'a file inside node_modules must be scored');
    const rule = fact.components.find((c) => c.id === 'regenerable');
    // The matcher claims the folder and stops descending. Without ancestor
    // lookup this file would read "no cleanup rule recognises this", which is
    // false — one npm install brings it back.
    assert.ok(rule && rule.value > 0, 'a file inside node_modules is regenerable too');
    assert.match(rule.why, /sits inside/, `the why must name the folder it inherited from: ${rule.why}`);
    assert.match(rule.why, /npm install/);
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('a stale file scores higher on staleness than a fresh one of the same size', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const scored = await score(fx.scanId, [fx.archive, fx.video]);
    const stale = scored[fx.archive]?.components.find((c) => c.id === 'staleness');
    const fresh = scored[fx.video]?.components.find((c) => c.id === 'staleness');
    assert.ok(stale && fresh);
    assert.ok(stale.value > fresh.value, `${stale.value} vs ${fresh.value}`);
    assert.equal(stale.value, 1, 'three years is past the two-year ceiling');
    assert.ok(/year|month/.test(stale.why), `the why must state the age in English: ${stale.why}`);
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('duplicate hashing that has never run is reported missing, NOT as "no duplicates"', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    // Nothing has asked for duplicates on this scan, so nothing has looked.
    const fact = (await score(fx.scanId, [fx.video]))[fx.video];
    assert.ok(fact);
    assert.ok(missingIds(fact).includes('redundant'),
      '"no identical copy found" is only true once something looked');
    assert.ok(!componentIds(fact).includes('redundant'), 'and it contributes nothing rather than zero');
    const why = fact.missing.find((m) => m.id === 'redundant')!.reason;
    assert.match(why, /Duplicates view|not looked/i, `the reason must say what would answer it: ${why}`);
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('a path the scan does not contain is skipped, never scored', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const ghost = path.join(fx.root, 'never-existed.bin');
    const out = await computeFacts(fx.scanId, [ghost], ['reclaimScore'], new AbortController().signal);
    assert.equal(out.reclaimScore.available, true);
    assert.deepEqual(out.reclaimScore.values, {}, 'absent from values — never a score of 0');
    assert.equal(out.reclaimScore.stats.skipped, 1);
    assert.equal(out.reclaimScore.stats.computed, 0);
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('an expired or still-running scan is reported, not scored as zero', async () => {
  const s = await listen();
  try {
    const out = await computeFacts('no-such-scan', [path.join(path.sep, 'tmp', 'x')], ['reclaimScore'], new AbortController().signal);
    assert.equal(out.reclaimScore.available, false);
    assert.match(String(out.reclaimScore.reason), /expired|Scan the folder again/i);
    assert.deepEqual(out.reclaimScore.values, {});
  } finally {
    await s.close();
  }
});

test('POST /api/facts serves the score, and adds nothing to the byte-locked responses', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const res = await req(s.port, 'POST', '/api/facts', {
      scanId: fx.scanId,
      paths: [fx.nodeModules],
      providers: ['reclaimScore'],
    });
    assert.equal(res.status, 200);
    const provider = res.body.providers.reclaimScore;
    assert.equal(provider.available, true);
    const fact = provider.values[fx.nodeModules];
    assert.ok(fact, 'the score arrives through the sidecar');
    assert.equal(typeof fact.score, 'number');
    assert.ok(Array.isArray(fact.components) && fact.components.length > 0);
    assert.ok(Array.isArray(fact.missing));
    assert.ok(['high', 'medium', 'low'].includes(fact.confidence));

    // §2.1: the score must not have edged into a golden-locked response.
    // Asserted on the exact field names rather than a loose substring — an
    // earlier version searched for "reclaim" and matched the fixture's own
    // temp-directory path, failing for a reason that had nothing to do with
    // the rule it was defending.
    for (const url of [`/api/scan/${fx.scanId}/result`, `/api/large-files?scanId=${fx.scanId}`, `/api/file-types?scanId=${fx.scanId}`]) {
      const locked = await req(s.port, 'GET', url);
      assert.equal(locked.status, 200, url);
      const body = JSON.stringify(locked.body);
      for (const field of ['"reclaimScore"', '"score"', '"components"', '"confidence"', '"coverage"']) {
        assert.ok(!body.includes(field), `${field} leaked into ${url}`);
      }
    }
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('unknown provider ids are still refused now that a fourth exists', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const res = await req(s.port, 'POST', '/api/facts', {
      scanId: fx.scanId, paths: [fx.video], providers: ['reclaim_score'],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'UNKNOWN_PROVIDER');
    assert.match(res.body.error, /reclaimScore/, 'the error names the valid ids, including the new one');
  } finally {
    fx.cleanup();
    await s.close();
  }
});

test('the score never selects, stages or trashes anything', async () => {
  const s = await listen();
  const fx = await scannedFixture(s.port);
  try {
    const before = fs.readdirSync(fx.root).sort();
    await score(fx.scanId, [fx.nodeModules, fx.video, fx.archive]);
    assert.deepEqual(fs.readdirSync(fx.root).sort(), before, 'scoring is inert — §3.2');
    // And nothing in the provider reaches a delete path.
    const source = fs.readFileSync(new URL('../src/services/facts/reclaimScoreProvider.ts', import.meta.url), 'utf8');
    for (const forbidden of ["from '../trash'", "from '../cleaner'", "from '../offload'", "from '../timeCapsule'", 'moveToTrash']) {
      assert.ok(!source.includes(forbidden), `the score provider must not reach ${forbidden}`);
    }
  } finally {
    fx.cleanup();
    await s.close();
  }
});

/* ══════════════════════ rule claims cover their contents ══════════════════════ */

test('a file INSIDE a claimed folder inherits the claim', () => {
  const claims: RuleClaims = {
    available: true,
    byPath: new Map([[
      path.join(path.sep, 'proj', 'node_modules'),
      { ruleId: 'npm', title: 'npm packages', confidence: 'high' as const, why: 'a node_modules beside a package.json',
        restoreCommand: 'npm install', claimedPath: path.join(path.sep, 'proj', 'node_modules') },
    ]]),
  };
  // The matcher claims the folder and stops descending, so the deep file is
  // not a key. It is regenerated by the same command all the same.
  const deep = path.join(path.sep, 'proj', 'node_modules', 'react', 'lib', 'index.js');
  const hit = claimFor(claims, deep);
  assert.ok(hit, 'a file inside a claimed folder must inherit its claim');
  assert.equal(hit.ruleId, 'npm');
  assert.equal(hit.claimedPath, path.join(path.sep, 'proj', 'node_modules'));

  assert.equal(claimFor(claims, path.join(path.sep, 'proj', 'src', 'app.ts')), null, 'a sibling is not claimed');
  assert.equal(claimFor(claims, path.join(path.sep, 'elsewhere', 'x')), null);
});

test('claimFor terminates at the filesystem root rather than looping', () => {
  const empty: RuleClaims = { available: true, byPath: new Map() };
  assert.equal(claimFor(empty, path.join(path.sep, 'a', 'b', 'c')), null);
  assert.equal(claimFor(empty, path.sep), null);
});

/* ══════════════════════ the size distribution ══════════════════════ */

test('percentiles come from the scan itself, and an empty tree yields no range', () => {
  const sizes = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 900_000_000];
  const store = buildStoreFromTree({
    name: 'root', path: path.join(path.sep, 'r'), size: sizes.reduce((a, b) => a + b, 0), type: 'dir',
    children: sizes.map((s, i) => ({ name: `f${i}`, path: path.join(path.sep, 'r', `f${i}`), size: s, type: 'file' as const })),
  });
  const d = computeSizeDistribution(store);
  assert.equal(d.files, 8);
  // Within one 1/16-octave bucket of the true values — the histogram trades
  // exactness for constant memory, and says so.
  assert.ok(d.p50 >= 7_000 && d.p50 <= 9_000, `p50 was ${d.p50}`);
  assert.ok(d.p99 >= 850_000_000 && d.p99 <= 950_000_000, `p99 was ${d.p99}`);

  const bare = buildStoreFromTree({ name: 'root', path: path.join(path.sep, 'e'), size: 0, type: 'dir', children: [] });
  const empty = computeSizeDistribution(bare);
  assert.deepEqual(empty, { files: 0, p50: 0, p99: 0 });
});

/* ══════════════════════ the bulk download readers ══════════════════════ */

test('xattr batch output is matched against the requested paths, not split on a colon', () => {
  const a = path.join(path.sep, 'x', 'weird: name.zip');
  const b = path.join(path.sep, 'x', 'plain.zip');
  const stdout = `${a}: 0081;68ad1234;Chrome;UUID-A\n${b}: 0081;68ad9999;Safari;UUID-B\n`;
  const got = parseXattrBatch(stdout, [a, b]);
  // Splitting on the first ': ' would attach Chrome's record to nothing and
  // lose the file whose NAME contains a colon.
  assert.equal(got.get(a), '0081;68ad1234;Chrome;UUID-A');
  assert.equal(got.get(b), '0081;68ad9999;Safari;UUID-B');
});

test('a path that is a prefix of another cannot claim its line', () => {
  const short = path.join(path.sep, 'x', 'a.txt');
  const long = path.join(path.sep, 'x', 'a.txt.download');
  const got = parseXattrBatch(`${long}: 0081;68ad0000;Firefox;U\n`, [short, long]);
  assert.equal(got.get(long), '0081;68ad0000;Firefox;U');
  assert.equal(got.has(short), false);
});

test('a single-path xattr batch is a bare value with no prefix', () => {
  const only = path.join(path.sep, 'x', 'one.zip');
  const got = parseXattrBatch('0081;68ad1234;Chrome;UUID\n', [only]);
  assert.equal(got.get(only), '0081;68ad1234;Chrome;UUID');
  // The same shape trap as mdls: requiring a prefix here made every
  // single-file request — the most likely one the UI makes — answer nothing.
  assert.equal(parseXattrBatch('', [only]).size, 0);
});

test('macOS: a file with no quarantine record is CHECKED, not unchecked', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-quar-'));
  try {
    const withRecord = path.join(dir, 'downloaded.zip');
    const without = path.join(dir, 'homemade.txt');
    fs.writeFileSync(withRecord, 'a');
    fs.writeFileSync(without, 'b');
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;68ad1234;Chrome;UUID-1', withRecord]);

    const batch = await readDownloadOriginsMac([withRecord, without]);
    assert.equal(batch.available, true);
    assert.equal(batch.unchecked.size, 0, 'exit code 1 means "one file had none", not "the read failed"');
    assert.equal(batch.origins.get(withRecord)?.agent, 'Chrome');
    assert.ok(batch.origins.get(withRecord)!.downloadedAt! > 0);
    assert.equal(batch.origins.has(without), false, 'checked, and genuinely no record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('macOS: a vanished path does not destroy the rest of the batch', { skip: process.platform !== 'darwin' ? 'macOS only' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-quar2-'));
  try {
    const real = path.join(dir, 'real.zip');
    fs.writeFileSync(real, 'a');
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;68ad4444;Safari;UUID-2', real]);
    // mdls abandons its whole plist when handed a missing path; xattr does not.
    const batch = await readDownloadOriginsMac([path.join(dir, 'gone.zip'), real]);
    assert.equal(batch.origins.get(real)?.agent, 'Safari');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: a stream that cannot be read is unchecked, while ENOENT is a real absence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-zone-'));
  try {
    const plain = path.join(dir, 'plain.txt');
    fs.writeFileSync(plain, 'x');
    // On a non-NTFS filesystem the ':Zone.Identifier' read fails ENOENT,
    // which is exactly the "not downloaded" case the reader must report as a
    // checked zero rather than as unknown.
    const batch = await readDownloadOriginsWindows([plain]);
    assert.equal(batch.available, true);
    assert.equal(batch.origins.size, 0);
    assert.equal(batch.unchecked.size, 0, 'no stream means not downloaded — an answer, not a gap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux: getfattr blocks are parsed per file, with octal escapes decoded', () => {
  const a = '/home/me/a.zip';
  const b = '/home/me/b iso.img';
  const stdout = [
    `# file: ${a}`,
    'user.xdg.origin.url="https://example.com/a.zip"',
    '',
    `# file: ${b}`,
    'user.xdg.origin.url="https://mirror.example.org/b\\040iso.img"',
    '',
  ].join('\n');
  const got = parseGetfattrBatch(stdout);
  assert.equal(got.get(a), 'https://example.com/a.zip');
  // \040 is octal 32 — a space. Decimal would give '(', silently corrupting
  // every URL containing an escaped byte.
  assert.equal(got.get(b), 'https://mirror.example.org/b iso.img');
  assert.equal(got.size, 2);
});

test('Linux: getfattr value decoding handles quotes, backslashes and nothing else', () => {
  assert.equal(decodeGetfattrValue('"plain"'), 'plain');
  assert.equal(decodeGetfattrValue('"a\\\\b"'), 'a\\b');
  assert.equal(decodeGetfattrValue('"say \\"hi\\""'), 'say "hi"');
  assert.equal(decodeGetfattrValue('unquoted'), 'unquoted');
  assert.equal(decodeGetfattrValue('"\\101"'), 'A');
});

test('Linux: a getfattr dump for a different attribute is ignored, not mis-read', () => {
  const stdout = ['# file: /home/me/a.zip', 'user.something.else="nope"', ''].join('\n');
  assert.equal(parseGetfattrBatch(stdout).size, 0);
});
