import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every write this file causes lands in a directory of its own.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mft-engine-test-'));
process.env.TREEMAP_NO_GDU = '1';

import type { MftExpected, MftLiveCheck, WalkResult } from '../native/index';
import { MFT_CROSS_CHECK_ATTEMPTS, MFT_CROSS_CHECK_SAMPLE, MFT_FLUSH_MARGIN_MS, crossCheckMft, type LiveChecker } from '../src/services/scan/mftCrossCheck';
import {
  KIND_DIR,
  KIND_FILE,
  MFT_NOT_VERIFIED,
  MFT_TEMP_FOLDER,
  helperTempRoot,
  resetMftSessionForTests,
  runMftWalk,
  type MftLaunchOutcome,
  type MftLaunchRequest,
  type MftLauncher,
  type MftModule,
} from '../src/services/scan/nativeEngine';
import { MFT_DECLINE_QUIET_MS } from '../src/services/scan/mftPrompt';
import { statToInput } from '../src/services/scan/nodeInput';
import { PackedScanStore } from '../src/services/scanStore';
import { createScanRecord } from '../src/services/diskScanner';
import { loadNative } from '../src/services/scan/native';

/**
 * The Windows MFT turbo mode on the Node side — M6 of
 * docs/superpowers/plans/2026-09-23-phase3-w6-mft.md.
 *
 *  1. The cross-check (W6-8 with correction 9), pure, through a fake live
 *     checker: up to 1,000 entries drawn uniformly without replacement from
 *     those last written well before the read began; an unopenable entry is
 *     replaced; a mismatch is re-read once, and is a divergence only when
 *     the entry still differs and has not itself changed since the read.
 *  2. `runMftWalk` through a fake launcher and a fake module: a declined
 *     prompt is a fallback with its own reason, never an error; a divergence
 *     switches the mode off for the volume for the session, naming the entry
 *     and both values; every answer carries W6-9's label.
 *  3. The real module (after `npm run build:native`): `mftTake` reads a
 *     columns file written here by an independent encoder of the documented
 *     format, and `mftCrossCheck` compares real files in the OS temp folder.
 */

const READ_STARTED = Date.UTC(2026, 8, 23, 12, 0, 0);
const OLD = READ_STARTED - MFT_FLUSH_MARGIN_MS - 60_000;
const RECENT = READ_STARTED - 1_000;

/** A seeded PRNG (mulberry32), so every draw here is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Node { name: string; parent: number; kind?: number; size?: number; mtime?: number }

/** Columns from a node list (index 0 the root, each parent before its children). */
function columns(nodes: Node[]): WalkResult {
  const names: number[] = [];
  const nameOff = [0];
  for (const n of nodes) {
    names.push(...Buffer.from(n.name, 'utf8'));
    nameOff.push(names.length);
  }
  const files = nodes.filter((n) => (n.kind ?? KIND_FILE) !== KIND_DIR).length;
  return {
    parent: Uint32Array.from(nodes.map((n) => n.parent)),
    nameOff: Uint32Array.from(nameOff),
    names: Uint8Array.from(names),
    kind: Uint8Array.from(nodes.map((n) => n.kind ?? KIND_FILE)),
    flags: new Uint8Array(nodes.length),
    size: Float64Array.from(nodes.map((n) => n.size ?? 0)),
    allocBytes: Float64Array.from(nodes.map((n) => n.size ?? 0)),
    mtimeMs: Float64Array.from(nodes.map((n) => n.mtime ?? OLD)),
    atimeMs: Float64Array.from(nodes.map(() => Number.NaN)),
    hardlinkNode: new Uint32Array(0),
    hardlinkFamily: new Uint32Array(0),
    refusalNode: new Uint32Array(0),
    refusalWhy: new Uint8Array(0),
    stats: {
      dirsListed: nodes.length - files, entries: nodes.length - 1, wallMs: 5, cpuSeconds: 0.01, fastPath: 'mft',
      workersPeak: 1, climbSteps: 0, deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
  };
}

/** A root holding `count` files `f0…`, all last written long before the read. */
function flat(count: number, over: (i: number) => Partial<Node> = () => ({})): WalkResult {
  const nodes: Node[] = [{ name: 'data', parent: 0, kind: KIND_DIR }];
  for (let i = 0; i < count; i++) nodes.push({ name: `f${i}`, parent: 0, size: 100 + i, ...over(i) });
  return columns(nodes);
}

const ROOT = 'C:\\data';
const pathOf = (cols: WalkResult) => (i: number): string => {
  if (i === 0) return ROOT;
  const name = Buffer.from(cols.names.buffer, cols.names.byteOffset, cols.names.byteLength).toString('utf8', cols.nameOff[i], cols.nameOff[i + 1]);
  return `${ROOT}\\${name}`;
};

type Live = { kind: number; size: number; mtimeMs: number } | 'unopenable';

/** A live checker that answers from a script (default: exactly what the table said), recording every path it opens. */
function fakeChecker(script: (path: string, want: MftExpected, visit: number) => Live | undefined = () => undefined) {
  const seen: string[] = [];
  const visits = new Map<string, number>();
  const check: LiveChecker = (paths, expected) => paths.map((p, k): MftLiveCheck => {
    seen.push(p);
    const visit = (visits.get(p) ?? 0) + 1;
    visits.set(p, visit);
    const want = expected[k];
    const live = script(p, want, visit) ?? { kind: want.kind, size: want.size, mtimeMs: want.mtimeMs };
    if (live === 'unopenable') return { outcome: 'unopenable', kind: null, size: null, mtimeMs: null, differs: [], reason: 'Windows error 5' };
    const differs: MftLiveCheck['differs'] = [];
    if (live.kind !== want.kind) differs.push('kind');
    if (live.size !== want.size) differs.push('size');
    if (live.mtimeMs !== want.mtimeMs) differs.push('mtime');
    return { outcome: differs.length ? 'mismatch' : 'match', ...live, differs, reason: null };
  });
  return { check, seen, visits };
}

/* ══════════════ 1. the cross-check ══════════════ */

test('the cross-check draws 1,000 entries uniformly without replacement, each opened once, all of them when there are fewer', async () => {
  const big = flat(5_000);
  const { check, seen } = fakeChecker();
  const verdict = await crossCheckMft(big, pathOf(big), READ_STARTED, check, seeded(7));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.ok && verdict.checked === MFT_CROSS_CHECK_SAMPLE, JSON.stringify(verdict));
  assert.equal(seen.length, MFT_CROSS_CHECK_SAMPLE, 'one open per drawn entry');
  assert.equal(new Set(seen).size, MFT_CROSS_CHECK_SAMPLE, 'no entry drawn twice');
  // Uniform: the draws spread over the whole range, not the first thousand.
  const indices = seen.map((p) => (p === ROOT ? -1 : Number(p.slice(p.lastIndexOf('f') + 1))));
  assert.ok(indices.some((i) => i >= 4_000), 'the last fifth is drawn from');
  assert.ok(indices.some((i) => i < 1_000), 'the first fifth too');

  const small = flat(40);
  const few = fakeChecker();
  const all = await crossCheckMft(small, pathOf(small), READ_STARTED, few.check, seeded(3));
  assert.ok(all.ok && all.checked === 41, `every one of the 41 entries: ${JSON.stringify(all)}`);
});

test('a planted mismatch fails the check: the entry is re-read once, and the reason names it and both values', async () => {
  // 999 files and the root: exactly 1,000 eligible, so every one is drawn.
  const cols = flat(999);
  const { check, visits } = fakeChecker((p, want) => (p === `${ROOT}\\f123` ? { ...want, size: want.size + 66 } : undefined));
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, check, seeded(11));
  assert.equal(verdict.ok, false, 'a divergence');
  assert.ok(!verdict.ok);
  assert.equal(verdict.path, `${ROOT}\\f123`);
  assert.equal(visits.get(`${ROOT}\\f123`), 2, 're-read live once before it is called a divergence');
  assert.match(verdict.reason, /C:\\data\\f123\b/, 'names the entry');
  assert.match(verdict.reason, /\b223 bytes/, 'the table’s size');
  assert.match(verdict.reason, /\b289 bytes/, 'the live size');
});

test('correction 9: an entry last written close to the read is never drawn', async () => {
  const cols = flat(2_000, (i) => (i % 2 === 0 ? { mtime: RECENT } : {}));
  const { check, seen } = fakeChecker((_p, want) => ({ ...want, size: want.size + 1 })); // everything drawn would differ
  // Only odd files are eligible; make them all match, and the recent ones never be asked.
  const matchOdd = fakeChecker((p, want) => (Number(p.slice(p.lastIndexOf('f') + 1)) % 2 === 0 ? { ...want, size: -1 } : undefined));
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, matchOdd.check, seeded(5));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.ok(matchOdd.seen.every((p) => p === ROOT || Number(p.slice(p.lastIndexOf('f') + 1)) % 2 === 1), 'no recent entry opened');
  assert.ok(verdict.ok && verdict.eligible === 1_001, 'the root and the 1,000 old files');
  void check; void seen;
});

test('correction 9: a mismatch whose live re-read shows a write since the read is not a divergence, and is replaced', async () => {
  const cols = flat(1_500);
  const changed = `${ROOT}\\f7`;
  const { check, visits } = fakeChecker((p, want) => (p === changed ? { ...want, size: 1, mtimeMs: READ_STARTED + 5_000 } : undefined));
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, check, seeded(2));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  // Asserted, not assumed: a draw that missed the planted entry would leave
  // the lines below checking nothing (the TypeScript review of M6).
  assert.ok(visits.has(changed), 'this seed draws the planted entry');
  assert.equal(visits.get(changed), 2, 'drawn, re-read once, then set aside');
  assert.ok(verdict.ok && verdict.recent === 1 && verdict.checked === MFT_CROSS_CHECK_SAMPLE, 'another entry took its place');
  // Force the draw onto it: a table of the root and that one file.
  const lone = columns([{ name: 'data', parent: 0, kind: KIND_DIR }, { name: 'f7', parent: 0, size: 5 }]);
  const again = fakeChecker((p, want) => (p === changed ? { ...want, size: 1, mtimeMs: READ_STARTED + 5_000 } : undefined));
  const v2 = await crossCheckMft(lone, pathOf(lone), READ_STARTED, again.check, seeded(1));
  assert.ok(v2.ok && v2.recent === 1 && v2.checked === 1, JSON.stringify(v2));
  assert.equal(again.visits.get(changed), 2);
});

test('a mismatch that matches on its re-read is a transient, not a divergence', async () => {
  const lone = columns([{ name: 'data', parent: 0, kind: KIND_DIR }, { name: 'f0', parent: 0, size: 5 }]);
  const { check, visits } = fakeChecker((p, want, visit) => (p.endsWith('f0') && visit === 1 ? { ...want, size: 6 } : undefined));
  const verdict = await crossCheckMft(lone, pathOf(lone), READ_STARTED, check, seeded(1));
  assert.ok(verdict.ok && verdict.checked === 2, JSON.stringify(verdict));
  assert.equal(visits.get(`${ROOT}\\f0`), 2);
});

test('an entry the app cannot open is skipped and replaced by another draw', async () => {
  // A third of 2,000 cannot be opened; the other 1,334 are enough for 1,000.
  const cols = flat(2_000);
  const { check } = fakeChecker((p) => (Number(p.slice(p.lastIndexOf('f') + 1)) % 3 === 0 ? 'unopenable' : undefined));
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, check, seeded(9));
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.ok(verdict.ok && verdict.checked === MFT_CROSS_CHECK_SAMPLE && verdict.skipped > 0, JSON.stringify(verdict));
});

test('the check opens at most MFT_CROSS_CHECK_ATTEMPTS entries, and says how few it could verify', async () => {
  // A root the app can barely open (another account's profile, say) once
  // cost an open of every eligible entry, on the main thread (the
  // pre-landing review of 23 Sep 2026).
  const cols = flat(10_000);
  const { check, seen } = fakeChecker(() => 'unopenable');
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, check, seeded(4));
  assert.equal(seen.length, MFT_CROSS_CHECK_ATTEMPTS, 'first reads, and no more');
  assert.ok(verdict.ok && verdict.checked === 0 && verdict.attempts === MFT_CROSS_CHECK_ATTEMPTS, JSON.stringify(verdict));
  assert.ok(verdict.ok && verdict.required === MFT_CROSS_CHECK_SAMPLE, 'the evidence a table this size needs');
});

test('the evidence a table needs: half its eligible entries, at most the sample, at least one', async () => {
  const need = async (files: number): Promise<number> => {
    const cols = flat(files);
    const v = await crossCheckMft(cols, pathOf(cols), READ_STARTED, fakeChecker().check, seeded(1));
    return v.ok ? v.required : -1;
  };
  assert.equal(await need(9), 5, 'ten eligible (the root and nine files): five');
  assert.equal(await need(5_000), MFT_CROSS_CHECK_SAMPLE);
  const none = columns([{ name: 'data', parent: 0, kind: KIND_DIR, mtime: RECENT }]);
  const v = await crossCheckMft(none, pathOf(none), READ_STARTED, fakeChecker().check, seeded(1));
  assert.ok(v.ok && v.eligible === 0 && v.required === 1 && v.checked === 0, `nothing eligible still needs one match: ${JSON.stringify(v)}`);
});

test('the check hands the event loop a turn between two batches', async () => {
  const cols = flat(1_500);
  let turns = 0;
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, fakeChecker().check, seeded(6), async () => { turns++; });
  assert.ok(verdict.ok && verdict.checked === MFT_CROSS_CHECK_SAMPLE, JSON.stringify(verdict));
  assert.equal(turns, 3, 'four batches of 250: a turn before each but the first');
});

test('a live checker that answers fewer entries than it was asked counts the rest as not opened', async () => {
  const cols = flat(20);
  const verdict = await crossCheckMft(cols, pathOf(cols), READ_STARTED, () => [], seeded(1));
  assert.ok(verdict.ok && verdict.checked === 0 && verdict.skipped === 21, JSON.stringify(verdict));
});

test('a mismatch whose re-read reports no time is taken as written since the read, never as a divergence', async () => {
  const lone = columns([{ name: 'data', parent: 0, kind: KIND_DIR }, { name: 'f0', parent: 0, size: 5 }]);
  const check: LiveChecker = (paths, expected) => paths.map((p, k): MftLiveCheck => (p.endsWith('f0')
    ? { outcome: 'mismatch', kind: expected[k].kind, size: 6, mtimeMs: null, differs: ['size'], reason: null }
    : { outcome: 'match', kind: expected[k].kind, size: expected[k].size, mtimeMs: expected[k].mtimeMs, differs: [], reason: null }));
  const verdict = await crossCheckMft(lone, pathOf(lone), READ_STARTED, check, seeded(1));
  assert.ok(verdict.ok && verdict.recent === 1 && verdict.checked === 1, JSON.stringify(verdict));
});

/* ══════════════ 2. runMftWalk ══════════════ */

test('a table the check verified too little of is not trusted, and the sentence counts what was opened', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const { launcher } = fakeLauncher({ kind: 'exited', code: 0 });
  // Nine files in ten cannot be opened: 4,000 first reads verify about 400.
  const { check } = fakeChecker((p) => (Number(p.slice(p.lastIndexOf('f') + 1)) % 10 === 0 ? undefined : 'unopenable'));
  const { module } = fakeModule(flat(10_000), check);
  const r = recordFor(ROOT);
  const outcome = await runMftWalk(r.scan, r.store, ROOT, { launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED, random: seeded(8) });
  assert.ok(!outcome.used && outcome.failed === false, JSON.stringify(outcome));
  assert.match(outcome.reason, /the cross-check verified \d+ of the 1000 entries it needs \(4000 opened: \d+ could not be opened, 0 had been written since the read; 0 were not eligible/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a table as deep as NTFS allows is checked without running out of stack', async () => {
  // The paths the check opens were built by a function that called itself
  // once per level, and a tree thousands of folders deep threw a RangeError
  // out of the mode (the pre-landing review of 23 Sep 2026). NTFS paths
  // reach 32,767 characters: about 16,000 one-letter levels.
  resetMftSessionForTests();
  const folder = tempFolder();
  const nodes: Node[] = [{ name: 'data', parent: 0, kind: KIND_DIR }];
  for (let i = 1; i <= 16_000; i++) nodes.push({ name: 'd', parent: i - 1, kind: KIND_DIR });
  nodes.push({ name: 'leaf.bin', parent: 16_000, size: 7 });
  const { launcher } = fakeLauncher({ kind: 'exited', code: 0 });
  const { module } = fakeModule(columns(nodes));
  const r = recordFor(ROOT);
  // The draw takes the last eligible entry first: the leaf, at the bottom.
  const outcome = await runMftWalk(r.scan, r.store, ROOT, { launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED, random: () => 0.999999 });
  assert.ok(outcome.used, JSON.stringify(outcome).slice(0, 400));
  fs.rmSync(folder, { recursive: true, force: true });
});

function recordFor(root: string) {
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, '\\', statToInput('data', true, 0, OLD, undefined));
  return { scan, store };
}

function tempFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mft-run-'));
}

/**
 * The elevation check (mftHelperPath.ts) standing aside: these tests' helper
 * paths are names, not files. The test that is about the check replaces it.
 */
const allowElevation = (_file: string): string | null => null;

/** A launcher that records its requests and answers `outcome`, writing a placeholder output when it "ran". */
function fakeLauncher(outcome: Awaited<ReturnType<MftLauncher>>) {
  const requests: MftLaunchRequest[] = [];
  const launcher: MftLauncher = async (request) => {
    requests.push(request);
    if (outcome.kind === 'exited') fs.writeFileSync(request.output, 'placeholder');
    return outcome;
  };
  return { launcher, requests };
}

function fakeModule(cols: WalkResult | (() => WalkResult), check: LiveChecker = fakeChecker().check) {
  const calls = { take: 0, check: 0 };
  const module: MftModule = {
    mftTake: () => { calls.take++; return typeof cols === 'function' ? cols() : cols; },
    mftCrossCheck: (p, e) => { calls.check++; return check(p, e); },
  };
  return { module, calls };
}

test('declined elevation is a fallback with its own reason — never an error, nothing taken, nothing left behind', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const { launcher, requests } = fakeLauncher({ kind: 'declined', reason: 'elevation was declined at the Windows prompt' });
  const { module, calls } = fakeModule(flat(3));
  const { scan, store } = recordFor(ROOT);
  const outcome = await runMftWalk(scan, store, ROOT, { launcher, module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.equal(outcome.used, false);
  assert.ok(!outcome.used && outcome.failed === false, 'a choice, not a failure: no fallbackReason');
  assert.match(outcome.reason, /declined/);
  assert.match(outcome.reason, new RegExp(MFT_NOT_VERIFIED));
  assert.equal(calls.take, 0, 'nothing to take');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].volume, 'C:');
  assert.equal(requests[0].root, ROOT);
  assert.equal(path.dirname(requests[0].output), folder);
  assert.match(path.basename(requests[0].output), /^[0-9a-f-]+\.tmmft$/);
  assert.deepEqual(fs.readdirSync(folder), [], 'no file left behind');
  assert.equal(scan.status, 'running', 'the scan goes on — on the listing walk');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a helper a program running as the user could change is never started: nobody is asked, and the reason says how to fix it', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const { launcher, requests } = fakeLauncher({ kind: 'exited', code: 0 });
  const { module, calls } = fakeModule(flat(3));
  const helperPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\TreeMap\\tm-mft-helper.exe';
  const checked: string[] = [];
  const elevationRefusal = (file: string): string | null => {
    checked.push(file);
    return 'the folder C:\\Users\\me\\AppData\\Local\\Programs\\TreeMap lets any program running as you add or replace files in it';
  };
  const { scan, store } = recordFor(ROOT);
  const outcome = await runMftWalk(scan, store, ROOT, { launcher, module, helperPath, elevationRefusal, tempFolder: folder, now: () => READ_STARTED });
  assert.deepEqual(checked, [helperPath], 'the helper that would run is the one checked');
  assert.equal(requests.length, 0, 'nobody was asked');
  assert.equal(calls.take, 0);
  assert.ok(!outcome.used && outcome.failed === false, 'how TreeMap is installed is a rule, not a failure');
  assert.equal(
    outcome.reason,
    `the NTFS turbo mode (${MFT_NOT_VERIFIED}: no test has run its elevation prompt end to end) was not used: Windows would start ${helperPath} as administrator, and the folder C:\\Users\\me\\AppData\\Local\\Programs\\TreeMap lets any program running as you add or replace files in it; installed for anyone who uses this computer (in Program Files), TreeMap can use it`,
  );
  fs.rmSync(folder, { recursive: true, force: true });
});

test('one scan asks at a time (W6-1): a scan that wants the mode while another waits on the prompt falls back without asking', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const requests: MftLaunchRequest[] = [];
  const answers: ((o: MftLaunchOutcome) => void)[] = [];
  const failures: ((e: Error) => void)[] = [];
  let open = 0;
  const launcher: MftLauncher = (request) => {
    requests.push(request);
    // A second prompt while one is open is answered at once, so a missing
    // rule fails the count below instead of waiting on a prompt forever.
    if (open > 0) return Promise.resolve({ kind: 'failed', reason: 'a second prompt while one was open' });
    open++;
    return new Promise((resolve, reject) => {
      answers.push((o) => { open--; resolve(o); });
      failures.push((e) => { open--; reject(e); });
    });
  };
  const deps = { launcher, module: fakeModule(flat(3)).module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED };
  const walk = (root = ROOT) => { const r = recordFor(root); return runMftWalk(r.scan, r.store, root, deps); };

  const first = walk();
  const second = await walk();
  assert.equal(requests.length, 1, 'the second scan did not ask');
  assert.ok(!second.used && second.failed === false, 'a rule, not a failure');
  assert.match(second.reason, /only one scan asks at a time/);

  // A prompt that ends in any way frees the next scan to ask: a launch that failed…
  answers[0]({ kind: 'failed', reason: 'powershell.exe was not found' });
  await first;
  // A failed launch switches its drive off for the session (so it is not
  // asked about again for nothing): the next scans are of other drives.
  const third = walk('D:\\data');
  assert.equal(requests.length, 2, 'asked once the first prompt was over');
  // …and a launcher that threw.
  failures[1](new Error('spawn EACCES'));
  await third;
  const fourth = walk('E:\\data');
  assert.equal(requests.length, 3, 'asked once the second prompt was over');
  answers[2]({ kind: 'failed', reason: 'done' });
  await fourth;
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a scan cancelled before the prompt is never asked about: nobody is asked, and the one prompt slot stays free', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const { launcher, requests } = fakeLauncher({ kind: 'exited', code: 0 });
  const deps = { launcher, module: fakeModule(flat(3)).module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED };
  const cancelled = recordFor(ROOT);
  cancelled.scan.cancelled = true;
  const outcome = await runMftWalk(cancelled.scan, cancelled.store, ROOT, deps);
  assert.equal(requests.length, 0, 'no prompt for a scan already cancelled');
  assert.ok(!outcome.used && outcome.failed === false, JSON.stringify(outcome));
  assert.match(outcome.reason, /the scan was cancelled/);
  const next = recordFor(ROOT);
  await runMftWalk(next.scan, next.store, ROOT, deps);
  assert.equal(requests.length, 1, 'the next scan may ask');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a clock that fails when the prompt ends cannot leave the prompt open, nor start a quiet period with no end', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  let asked = false;
  const requests: MftLaunchRequest[] = [];
  // A decline, so a decline time the clock could not give (NaN) is exercised too.
  const launcher: MftLauncher = async (request) => {
    requests.push(request);
    asked = true;
    return { kind: 'declined', reason: 'elevation was declined at the Windows prompt' };
  };
  const now = (): number => {
    if (asked) throw new Error('the clock is gone');
    return READ_STARTED;
  };
  const deps = { launcher, module: fakeModule(flat(3)).module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now };
  const r = recordFor(ROOT);
  const outcome = await runMftWalk(r.scan, r.store, ROOT, deps);
  assert.ok(!outcome.used, 'the scan still falls back with a reason');
  asked = false;
  const again = recordFor(ROOT);
  await runMftWalk(again.scan, again.store, ROOT, deps);
  assert.equal(requests.length, 2, 'the next scan may ask: the prompt was not left open, and a decline with no time starts no quiet period');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('after a decline no scan asks for ten minutes — the reason says how long — and only time, or a restart, ends it', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  let now = READ_STARTED;
  const { launcher, requests } = fakeLauncher({ kind: 'declined', reason: 'elevation was declined at the Windows prompt' });
  const deps = { launcher, module: fakeModule(flat(3)).module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => now };
  const walk = () => { const r = recordFor(ROOT); return runMftWalk(r.scan, r.store, ROOT, deps); };

  await walk();
  assert.equal(requests.length, 1);
  now += 30_000;
  const soon = await walk();
  assert.equal(requests.length, 1, 'half a minute later: not asked again');
  assert.match(soon.reason, /\b10 more minutes\b/, 'nine and a half minutes left is said as ten, never as fewer than remain');
  now += MFT_DECLINE_QUIET_MS - 60_000 - 30_000;
  const quiet = await walk();
  assert.equal(requests.length, 1, 'nine minutes later: not asked again');
  assert.ok(!quiet.used && quiet.failed === false, 'a rule, not a failure');
  assert.match(quiet.reason, /declined/);
  assert.match(quiet.reason, /\b1 more minute\b/);
  assert.match(quiet.reason, /, or until TreeMap restarts\b/);
  assert.doesNotMatch(quiet.reason, /Settings/, 'nothing reachable through the settings API ends it');
  assert.match(quiet.reason, new RegExp(MFT_NOT_VERIFIED));

  now += 60_000;
  await walk();
  assert.equal(requests.length, 2, 'ten minutes after the decline: asked (and declined again)');
  await walk();
  assert.equal(requests.length, 2, 'the new decline starts a new quiet period');

  now -= 3_600_000;
  await walk();
  assert.equal(requests.length, 3, 'a clock set back does not stretch the quiet period');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('an app temp folder that is a link or junction is refused before anyone is asked, and nothing is written where it points', async () => {
  resetMftSessionForTests();
  const base = tempFolder();
  const target = path.join(base, 'somewhere');
  fs.mkdirSync(target);
  const linked = path.join(base, MFT_TEMP_FOLDER);
  // A directory junction on Windows (no privilege needed: the review's attack); a symbolic link elsewhere.
  fs.symlinkSync(target, linked, 'junction');
  const { launcher, requests } = fakeLauncher({ kind: 'exited', code: 0 });
  const { module, calls } = fakeModule(flat(3));
  const { scan, store } = recordFor(ROOT);
  const outcome = await runMftWalk(scan, store, ROOT, { launcher, module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: linked, now: () => READ_STARTED });
  assert.equal(requests.length, 0, 'nobody was asked');
  assert.equal(calls.take, 0);
  assert.ok(!outcome.used && outcome.failed === true, JSON.stringify(outcome));
  assert.match(outcome.reason, /is a link, a junction or not a folder/);
  assert.deepEqual(fs.readdirSync(target), [], 'nothing written where it points');

  const file = path.join(base, 'a-file');
  fs.writeFileSync(file, '');
  const r = recordFor(ROOT);
  const notFolder = await runMftWalk(r.scan, r.store, ROOT, { launcher, module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: file, now: () => READ_STARTED });
  assert.equal(requests.length, 0, 'nobody was asked');
  assert.ok(!notFolder.used && notFolder.failed === true, JSON.stringify(notFolder));
  fs.rmSync(base, { recursive: true, force: true });
});

test('a helper that ran and a cross-check that passed: the columns are ingested, the output removed, and the reason carries W6-9’s label', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const { launcher, requests } = fakeLauncher({ kind: 'exited', code: 0 });
  const { module, calls } = fakeModule(flat(10));
  const { scan, store } = recordFor(ROOT);
  const outcome = await runMftWalk(scan, store, ROOT, { launcher, module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED, random: seeded(4) });
  assert.equal(outcome.used, true, JSON.stringify(outcome));
  assert.match(outcome.reason, new RegExp(MFT_NOT_VERIFIED), 'every scan through the mode says so');
  assert.match(outcome.reason, /11 of 11/, 'how many entries were checked');
  assert.equal(calls.take, 1);
  assert.equal(scan.fileCount, 10);
  assert.equal(scan.dirCount, 1);
  assert.equal(store.childIds(store.rootId).length, 10, 'the tree is in the store');
  assert.equal(fs.existsSync(requests[0].output), false, 'the output file is removed');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a table the app could verify none of is not trusted — every entry too recent, or none could be opened — and the volume stays on offer', async () => {
  // A gate that checked nothing must not open; and a folder written within
  // the margin is exactly the one a raw read may be missing creates in.
  const allRecent = columns([
    { name: 'data', parent: 0, kind: KIND_DIR, mtime: RECENT },
    ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, parent: 0, size: 100 + i, mtime: RECENT })),
  ]);
  const cases: Array<[string, WalkResult, LiveChecker]> = [
    ['every entry written within the margin', allRecent, fakeChecker().check],
    ['no entry could be opened', flat(5), fakeChecker(() => 'unopenable').check],
  ];
  for (const [label, cols, check] of cases) {
    resetMftSessionForTests();
    const folder = tempFolder();
    const { launcher, requests } = fakeLauncher({ kind: 'exited', code: 0 });
    const { module } = fakeModule(cols, check);
    const { scan, store } = recordFor(ROOT);
    const deps = { launcher, module, helperPath: 'C:\\app\\tm-mft-helper.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED, random: seeded(4) };
    const outcome = await runMftWalk(scan, store, ROOT, deps);
    assert.equal(outcome.used, false, `${label}: ${JSON.stringify(outcome)}`);
    assert.ok(!outcome.used && outcome.failed === false, `${label}: an inability to check, not a failure of the reader`);
    assert.match(outcome.reason, /the cross-check verified 0 of the \d+ entries it needs/, label);
    assert.match(outcome.reason, new RegExp(MFT_NOT_VERIFIED), label);
    assert.equal(store.count, 1, `${label}: nothing was ingested — the store holds only its root`);
    assert.equal(fs.existsSync(requests[0].output), false, `${label}: the output file is removed`);
    const again = recordFor(ROOT);
    await runMftWalk(again.scan, again.store, ROOT, deps);
    assert.equal(requests.length, 2, `${label}: the mode is not switched off for the volume`);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a divergence switches the mode off for the volume for the session: the reason names the entry and both values, and the next scan is not even offered the prompt', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const planted = `${ROOT}\\f2`;
  const { check } = fakeChecker((p, want) => (p === planted ? { ...want, mtimeMs: want.mtimeMs - 3_600_000 } : undefined));
  const first = fakeLauncher({ kind: 'exited', code: 0 });
  const { module } = fakeModule(flat(4), check);
  const a = recordFor(ROOT);
  const outcome = await runMftWalk(a.scan, a.store, ROOT, { launcher: first.launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED, random: seeded(8) });
  assert.equal(outcome.used, false);
  assert.ok(!outcome.used && outcome.failed === true, 'a fallbackReason');
  assert.match(outcome.reason, /C:\\data\\f2/, 'the entry');
  assert.match(outcome.reason, new RegExp(String(OLD)), 'the table’s last-write time');
  assert.match(outcome.reason, new RegExp(String(OLD - 3_600_000)), 'the live one');
  assert.match(outcome.reason, /off for C: until TreeMap restarts/);
  assert.equal(a.scan.fileCount, 0, 'nothing was ingested');

  const second = fakeLauncher({ kind: 'exited', code: 0 });
  const b = recordFor(`${ROOT}\\sub`);
  const again = await runMftWalk(b.scan, b.store, `${ROOT}\\sub`, { launcher: second.launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.equal(again.used, false);
  assert.equal(second.requests.length, 0, 'no second prompt this session');
  assert.match(again.reason, /C:\\data\\f2/, 'the original divergence is repeated');
  const d = fakeLauncher({ kind: 'declined', reason: 'no' });
  const other = recordFor('D:\\x');
  await runMftWalk(other.scan, other.store, 'D:\\x', { launcher: d.launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.equal(d.requests.length, 1, 'another volume is still offered');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a helper refusal, a missing launcher, a missing helper and a root without a drive letter each fall back with their own reason', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const refusing: MftModule = { mftTake: () => { throw new Error('D: is formatted exFAT, not NTFS; only NTFS keeps a master file table'); }, mftCrossCheck: () => [] };
  const exit2 = fakeLauncher({ kind: 'exited', code: 2 });
  const r = recordFor(ROOT);
  const refused = await runMftWalk(r.scan, r.store, ROOT, { launcher: exit2.launcher, module: refusing, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder });
  assert.ok(!refused.used && refused.failed, JSON.stringify(refused));
  assert.match(refused.reason, /exFAT, not NTFS/, 'the helper’s own sentence');
  assert.equal(fs.existsSync(exit2.requests[0].output), false, 'removed');

  // Each case on a fresh session: the refusal above switched C: off.
  resetMftSessionForTests();
  const none = await runMftWalk(r.scan, r.store, ROOT, { launcher: null, module: fakeModule(flat(1)).module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder });
  assert.ok(!none.used && none.failed);
  assert.match(none.reason, /desktop app/);

  resetMftSessionForTests();
  const noHelper = await runMftWalk(r.scan, r.store, ROOT, { launcher: fakeLauncher({ kind: 'exited', code: 0 }).launcher, module: fakeModule(flat(1)).module, helperPath: null, tempFolder: folder });
  assert.ok(!noHelper.used && noHelper.failed);
  assert.match(noHelper.reason, /tm-mft-helper/);

  resetMftSessionForTests();
  const unc = await runMftWalk(r.scan, r.store, '\\\\server\\share', { launcher: fakeLauncher({ kind: 'exited', code: 0 }).launcher, module: fakeModule(flat(1)).module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder });
  assert.ok(!unc.used);
  assert.match(unc.reason, /drive letter/);
  for (const o of [refused, none, noHelper, unc]) assert.match(o.reason, new RegExp(MFT_NOT_VERIFIED));
  fs.rmSync(folder, { recursive: true, force: true });
});

test('after the prompt, a launch that fails, a helper that exits non-zero or a result that cannot be read switches the mode off for the drive: no scan asks again for nothing', async () => {
  // Each of these outlives one scan — a PowerShell that cannot start the
  // helper, a helper that refuses its folder or crashes, a result that will
  // not read — and the mode once asked on every scan anyway (the
  // pre-landing review of 23 Sep 2026).
  const unreadable: MftModule = { mftTake: () => { throw new Error('the columns file ends inside its size column'); }, mftCrossCheck: () => [] };
  const cases: Array<[string, MftLauncher, MftModule]> = [
    ['a failed launch', fakeLauncher({ kind: 'failed', reason: 'PowerShell refused to start the helper' }).launcher, fakeModule(flat(3)).module],
    ['a non-zero exit', fakeLauncher({ kind: 'exited', code: 3 }).launcher, fakeModule(flat(3)).module],
    ['an unreadable result', fakeLauncher({ kind: 'exited', code: 0 }).launcher, unreadable],
    ['a launcher that throws', async () => { throw new Error('spawn EACCES'); }, fakeModule(flat(3)).module],
  ];
  for (const [label, launcher, module] of cases) {
    resetMftSessionForTests();
    const folder = tempFolder();
    const r = recordFor(ROOT);
    const first = await runMftWalk(r.scan, r.store, ROOT, { launcher, module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
    assert.ok(!first.used && first.failed, `${label}: ${JSON.stringify(first)}`);
    assert.match(first.reason, /the mode is off for C: until TreeMap restarts/, label);
    const again = fakeLauncher({ kind: 'exited', code: 0 });
    const second = await runMftWalk(r.scan, r.store, ROOT, { launcher: again.launcher, module: fakeModule(flat(3)).module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
    assert.equal(again.requests.length, 0, `${label}: nobody is asked again`);
    assert.match(second.reason, /off for C: until TreeMap restarts/, label);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a drive the helper would refuse is refused before anyone is asked, by the helper’s own checks run unelevated', async () => {
  // A network drive, one Windows cannot type, or a volume that is not NTFS:
  // the prompt once came first, and the elevated helper then refused (the
  // pre-landing review of 23 Sep 2026: the red team). A module built before
  // mftPrecheck existed goes ahead as before.
  resetMftSessionForTests();
  const folder = tempFolder();
  const refusing = fakeLauncher({ kind: 'exited', code: 0 });
  const sentence = 'C:\\ is a network drive, whose table is on another machine';
  const precheck: MftModule = { ...fakeModule(flat(3)).module, mftPrecheck: () => sentence };
  const r = recordFor(ROOT);
  const out = await runMftWalk(r.scan, r.store, ROOT, { launcher: refusing.launcher, module: precheck, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.equal(refusing.requests.length, 0, 'nobody was asked');
  assert.ok(!out.used && out.failed === false, 'a rule, not a failure');
  assert.ok(out.reason.includes(sentence), out.reason);
  const passing = fakeLauncher({ kind: 'exited', code: 0 });
  const older = await runMftWalk(recordFor(ROOT).scan, recordFor(ROOT).store, ROOT, { launcher: passing.launcher, module: fakeModule(flat(3)).module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.equal(passing.requests.length, 1, 'a module without the check asks as before');
  assert.ok(older.used, JSON.stringify(older));
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a helper that refuses before writing anything most often will not write to the folder it was given, and the reason says why', async () => {
  resetMftSessionForTests();
  const folder = tempFolder();
  const launcher: MftLauncher = async () => ({ kind: 'exited', code: 2 });
  const r = recordFor(ROOT);
  const out = await runMftWalk(r.scan, r.store, ROOT, { launcher, module: fakeModule(flat(3)).module, helperPath: 'x.exe', elevationRefusal: allowElevation, tempFolder: folder, now: () => READ_STARTED });
  assert.ok(!out.used && out.failed, JSON.stringify(out));
  assert.match(out.reason, /refused before writing anything/);
  assert.match(out.reason, /TMP and TEMP/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test('the app temp folder is worked out as the helper works out its own: TMP, then TEMP, then USERPROFILE, on Windows', () => {
  assert.equal(MFT_TEMP_FOLDER, 'TreeMap-mft');
  // Read from the helper's source, not restated: the two must name one folder.
  const helperSource = fs.readFileSync(path.join(__dirname, '..', 'native', 'treemap-core', 'crates', 'tm-mft-helper', 'src', 'lib.rs'), 'utf8');
  assert.ok(helperSource.includes(`pub const APP_TEMP_FOLDER: &str = "${MFT_TEMP_FOLDER}";`), 'the helper names the same folder');
  // Rust's std::env::temp_dir() is Windows' GetTempPath2: TMP first. Node's
  // os.tmpdir() reads TEMP first, so where the two differed the helper
  // refused the app's output as outside its own folder.
  assert.equal(helperTempRoot({ TMP: 'C:\\T1', TEMP: 'C:\\T2', USERPROFILE: 'C:\\U' }, true), 'C:\\T1');
  assert.equal(helperTempRoot({ TEMP: 'C:\\T2', USERPROFILE: 'C:\\U' }, true), 'C:\\T2');
  assert.equal(helperTempRoot({ USERPROFILE: 'C:\\U' }, true), 'C:\\U');
  assert.equal(helperTempRoot({ TMP: 'C:\\T1' }, false), os.tmpdir(), 'elsewhere, the OS temp folder');
});

/* ══════════════ 3. the real module ══════════════ */

const PREBUILT = path.join(__dirname, '..', 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

function realModule(): MftModule {
  const outcome = loadNative({ path: PREBUILT });
  assert.ok(outcome.available, `the prebuilt module loads (run npm run build:native): ${outcome.available ? '' : outcome.reason}`);
  const mod = outcome.module as unknown as MftModule;
  assert.equal(typeof mod.mftTake, 'function', 'the module exports mftTake');
  assert.equal(typeof mod.mftCrossCheck, 'function', 'the module exports mftCrossCheck');
  return mod;
}

/** The documented format, written by an encoder independent of the Rust one. */
function encodeColumnsFile(c: WalkResult, flags = 1): Buffer {
  const n = c.parent.length;
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const f64 = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
  parts.push(Buffer.from('TMMFT002', 'ascii'), u32(n), u32(flags));
  for (const v of c.parent) parts.push(u32(v));
  for (const v of c.nameOff) parts.push(u32(v));
  parts.push(Buffer.from(c.names), Buffer.from(c.kind), Buffer.from(c.flags));
  for (const col of [c.size, c.allocBytes, c.mtimeMs, c.atimeMs]) for (const v of col) parts.push(f64(v));
  parts.push(u32(c.hardlinkNode.length));
  for (let i = 0; i < c.hardlinkNode.length; i++) parts.push(u32(c.hardlinkNode[i]), u32(c.hardlinkFamily[i]));
  parts.push(u32(c.refusalNode.length));
  for (let i = 0; i < c.refusalNode.length; i++) parts.push(u32(c.refusalNode[i]), Buffer.from([c.refusalWhy[i]]));
  const s = c.stats;
  parts.push(u64(s.dirsListed), u64(s.entries), f64(s.wallMs), f64(s.cpuSeconds ?? Number.NaN), Buffer.from([5]), u32(s.workersPeak), u32(s.climbSteps), u64(s.deniedEntries), u64(s.unreadableEntries), u64(s.dataless));
  return Buffer.concat(parts);
}

test('systemDirectory: the kernel’s answer on Windows, a full path to its System32; null anywhere else', () => {
  const mod = realModule() as unknown as { systemDirectory?: () => string | null };
  assert.equal(typeof mod.systemDirectory, 'function', 'the module exports systemDirectory');
  const dir = mod.systemDirectory?.();
  if (process.platform === 'win32') {
    assert.ok(typeof dir === 'string' && path.win32.isAbsolute(dir), `${dir}`);
    assert.match(dir, /\\System32$/i);
    assert.ok(fs.existsSync(path.join(dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe')), 'PowerShell is where the launcher will look');
  } else {
    assert.equal(dir, null);
  }
});

test('mftPrecheck: nothing to say off Windows; on Windows the runner’s own system drive passes, and a path with no drive does not', () => {
  const mod = realModule() as unknown as { mftPrecheck?: (root: string) => string | null };
  assert.equal(typeof mod.mftPrecheck, 'function', 'the module exports mftPrecheck');
  if (process.platform === 'win32') {
    const drive = `${(process.env.SystemDrive ?? 'C:').replace(/\\$/, '')}\\`;
    assert.equal(mod.mftPrecheck?.(drive), null, `${drive} is a local NTFS volume`);
    assert.match(mod.mftPrecheck?.('relative\\folder') ?? '', /absolute/, 'a relative root is refused with the reader’s own sentence');
  } else {
    assert.equal(mod.mftPrecheck?.(os.tmpdir()), null);
  }
});

test('mftTake reads a columns file written to the documented format, every column equal; a refusal throws the helper’s sentence; a tampered file throws', () => {
  const mod = realModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mft-take-'));
  try {
    const cols = flat(5);
    cols.hardlinkNode = Uint32Array.from([2, 3]);
    cols.hardlinkFamily = Uint32Array.from([0, 0]);
    cols.refusalNode = Uint32Array.from([0]);
    cols.refusalWhy = Uint8Array.from([3]);
    const file = path.join(dir, 'a.tmmft');
    fs.writeFileSync(file, encodeColumnsFile(cols));
    const back = mod.mftTake(file);
    for (const key of ['parent', 'nameOff', 'names', 'kind', 'flags', 'size', 'allocBytes', 'mtimeMs', 'hardlinkNode', 'hardlinkFamily', 'refusalNode', 'refusalWhy'] as const) {
      assert.deepEqual(Array.from(back[key] as ArrayLike<number>), Array.from(cols[key] as ArrayLike<number>), key);
    }
    assert.ok(Array.from(back.atimeMs).every(Number.isNaN), 'NaN survives');
    assert.equal(back.stats.fastPath, 'mft', 'the stats say mft');
    assert.equal(back.stats.entries, 5);

    const refusal = path.join(dir, 'b.tmmft');
    const sentence = 'the scan root "D:\\x" is not a folder on C:: it is on another drive';
    const text = Buffer.from(sentence, 'utf8');
    const header = Buffer.alloc(16);
    header.write('TMMFTERR', 0, 'ascii');
    header.writeUInt32LE(text.length, 8);
    fs.writeFileSync(refusal, Buffer.concat([header, text]));
    assert.throws(() => mod.mftTake(refusal), (e: Error) => e.message === sentence);

    const cyclic = flat(3);
    cyclic.parent[1] = 3;
    const bad = path.join(dir, 'c.tmmft');
    fs.writeFileSync(bad, encodeColumnsFile(cyclic));
    assert.throws(() => mod.mftTake(bad), /parent that does not precede its child/);
    assert.throws(() => mod.mftTake(path.join(dir, 'missing.tmmft')), /could not be read/);

    // Defense in depth (the security review of M6): only a file named as the
    // app names its columns files is read — a well-formed one under any other
    // name is refused on its name, before a byte of it is read.
    for (const name of ['a.json', 'a.tmmft.exe', 'a.TMMFT', '.tmmft', 'a b.tmmft']) {
      const misnamed = path.join(dir, name);
      fs.writeFileSync(misnamed, encodeColumnsFile(cols));
      assert.throws(() => mod.mftTake(misnamed), /is not a columns file the app named/, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mftCrossCheck opens real files, unelevated: a match, a planted size mismatch with the live values, and a vanished path', () => {
  const mod = realModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-mft-check-'));
  try {
    const file = path.join(dir, 'real.bin');
    fs.writeFileSync(file, Buffer.alloc(1234));
    const st = fs.lstatSync(file);
    const dirSt = fs.lstatSync(dir);
    const results = mod.mftCrossCheck(
      [file, file, dir, path.join(dir, 'gone')],
      [
        { kind: KIND_FILE, size: 1234, mtimeMs: st.mtimeMs },
        { kind: KIND_FILE, size: 999, mtimeMs: st.mtimeMs },
        { kind: KIND_DIR, size: 0, mtimeMs: dirSt.mtimeMs },
        { kind: KIND_FILE, size: 1, mtimeMs: 1 },
      ],
    );
    assert.equal(results[0].outcome, 'match', JSON.stringify(results[0]));
    assert.equal(results[1].outcome, 'mismatch');
    assert.deepEqual(results[1].differs, ['size']);
    assert.equal(results[1].size, 1234, 'the live size');
    assert.equal(results[2].outcome, 'match', JSON.stringify(results[2]));
    assert.equal(results[3].outcome, 'unopenable');
    assert.ok(results[3].reason && results[3].reason.length > 0);
    assert.throws(() => mod.mftCrossCheck([file], []), /one \{ kind/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
