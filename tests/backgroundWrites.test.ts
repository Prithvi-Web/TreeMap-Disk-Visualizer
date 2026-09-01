import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pending, resetBackgroundWrites, settled, trackWrite } from '../src/utils/backgroundWrites';

/**
 * Fire-and-forget writes, and why they need a ledger.
 *
 * A promise nobody awaits is how this app stays fast: the scan answers when the
 * WALK is done and lets the snapshot write itself afterwards. It is also how a
 * test gets lied to. `GET /api/agent/summary` reads the snapshot store, so two
 * reads either side of that write disagree — snapshotCount 0 then 1 — and an
 * assertion that the two are identical fails on whichever machine is slow
 * enough to land the write between them. Here that was Windows, in CI, on the
 * second push of the day, having passed the run before.
 *
 * There is no static rule that catches "this test reads state that an
 * unawaited write mutates". So the guard is in two halves:
 *
 *  1. **Completeness, checked here.** Every unawaited call in `src/` is either
 *     wrapped in `trackWrite` or named below with a reason it does not need to
 *     be. Add a new one and this test fails until someone has thought about it.
 *     That is the whole intent — not to forbid the pattern, which is correct
 *     and deliberate, but to stop one being added silently.
 *
 *  2. **A way to wait, proved here.** `settled()` gives a test a real answer to
 *     "has the background finished?", so it can stop guessing. agentErgonomics
 *     uses it in place of polling an endpoint.
 *
 * The allowlist is keyed by file and called symbol, never by line number: a
 * pin to a line fails for edits that cannot affect it, which this repo has been
 * bitten by before.
 */

const SRC = path.join(__dirname, '..', 'src');

/**
 * Unawaited calls that do NOT mutate state a request-serving read can observe
 * mid-flight. Each entry is a claim, and the reason is the argument for it.
 */
const NOT_A_RACE: Record<string, string> = {
  'api/indexRoutes.ts::buildIndex':
    'a long job with a jobId and a progress endpoint — callers already poll it, so it is never silent',
  'services/offload.ts::runOffload': 'long job, progress endpoint',
  'services/offload.ts::runRestore': 'long job, progress endpoint',
  'services/duplicateFinder.ts::findDuplicates': 'long job; the route answers 202 with progress until it lands',
  'services/perceptualDupes.ts::runJob': 'long job; same 202-with-progress contract',
  'services/timeCapsule.ts::runRestoreAll': 'long job, progress endpoint',
  'services/timeCapsule.ts::pruneExpired': 'retention sweep on a timer; owned by no request',
  'services/timeCapsule.ts::reconcileCapsule': 'startup reconciliation; owned by no request',
  'services/scheduler.ts::tick': 'the scheduler daemon itself',
  'services/scheduler.ts::runDuePolicies': 'scheduler daemon',
  'services/scheduler.ts::runScheduled': 'scheduler daemon',
  'services/watcher.ts::onRawEvent': 'filesystem event fan-in; its effect is an SSE push, not a stored read',
  'services/containerScanner.ts::worker.terminate': 'releases a worker; writes nothing',
  'services/fleet/fleetSync.ts::handlePeerRequest': 'a peer HTTP handler — it IS the request, not something after one',
  'server.ts::fleetRuntime': 'shutdown path — stops the LAN listener',
  'server.ts::initFleet': 'boot path; nothing has been answered yet',
  'platform/macos/index.ts::fsp.rm': 'best-effort temp cleanup',
  'platform/windows/index.ts::fsp.rm': 'best-effort temp cleanup',
  'platform/linux/index.ts::seed': 'populates an in-process cache used only by the caller that seeded it',
};

interface Site { key: string; file: string; line: number; text: string }

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Every `void <something>(` in src — the spelling this codebase uses for "I am
 * deliberately not awaiting this". `void x;` with no call is TypeScript's
 * unused/exhaustiveness marker and is not a promise, so the paren is required.
 */
function unawaitedSites(): Site[] {
  const out: Site[] = [];
  for (const full of tsFiles(SRC)) {
    const rel = path.relative(SRC, full).split(path.sep).join('/');
    readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
      // The CALLEE only — the dotted name up to the first paren. Everything
      // after it (`(args).catch(...)`) is this call's own error handling, not
      // part of what is being called, and folding it into the key would make
      // every entry break the moment an argument changed.
      const m = /^\s*void\s+([A-Za-z_$][\w.$]*)\s*\(/.exec(text);
      if (!m) return;
      out.push({ key: `${rel}::${m[1]}`, file: rel, line: i + 1, text: text.trim().slice(0, 100) });
    });
  }
  return out;
}

test('the scanner finds the unawaited calls it is supposed to police', () => {
  // An empty list would make the completeness check below pass over everything.
  const sites = unawaitedSites();
  assert.ok(sites.length >= 10, `expected the void-call sites to be found, got ${sites.length}`);
  assert.ok(
    sites.some((s) => s.file === 'services/scheduler.ts'),
    'the scheduler daemon is one of them, so the pattern still matches real code',
  );
});

test('every unawaited call is either tracked or explained', () => {
  const unexplained = unawaitedSites()
    .filter((s) => !(s.key in NOT_A_RACE))
    .map((s) => `${s.file}:${s.line}  ${s.key.split('::')[1]}\n      ${s.text}`);
  assert.deepEqual(
    unexplained,
    [],
    'an unawaited call keeps mutating state after the request that started it has answered.\n' +
      'If a request-serving read can observe it mid-flight, wrap it:\n' +
      "    trackWrite('label', doTheWrite().catch(...))\n" +
      'so tests can `await settled()` instead of polling and hoping. If it cannot — a long job with\n' +
      'its own progress endpoint, a daemon, a cleanup — add it to NOT_A_RACE with the reason.\n\n  ' +
      unexplained.join('\n  '),
  );
});

test('the writes that bit us are the ones being tracked', () => {
  // Named explicitly, because the completeness check above is satisfied just as
  // well by moving something into NOT_A_RACE — which is the one way to defeat
  // this file without noticing.
  const scanner = readFileSync(path.join(SRC, 'services', 'diskScanner.ts'), 'utf8');
  assert.match(scanner, /trackWrite\('saveSnapshot'/, 'the snapshot write behind the CI race');
  assert.match(scanner, /trackWrite\('saveMtimeCache'/, 'and the cache write beside it');
  assert.equal(
    (scanner.match(/trackWrite\(/g) ?? []).length, 4,
    'both scan-completion paths — the incremental one and the full one — track both writes',
  );
  for (const [file, label] of [
    ['services/cloud/cloudScan.ts', "trackWrite('saveSnapshot(cloud)'"],
    ['services/indexEngine.ts', "trackWrite('applyPendingChanges'"],
  ] as const) {
    assert.ok(readFileSync(path.join(SRC, file), 'utf8').includes(label), `${file} tracks its write`);
  }
});

/* ─────────────────────────── the ledger itself ─────────────────────────── */

test('settled() waits for a tracked write, and resolves immediately when idle', async () => {
  resetBackgroundWrites();
  await settled(); // idle: must not hang

  let finish!: () => void;
  const slow = new Promise<void>((r) => { finish = r; });
  trackWrite('slow-write', slow);

  let done = false;
  const waiter = settled().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, 'settled() must not resolve while a write is in flight');
  assert.deepEqual(pending().map((p) => p.split(' ')[0]), ['slow-write'], 'and it can name what it is waiting for');

  finish();
  await waiter;
  assert.equal(done, true);
  assert.deepEqual(pending(), []);
});

test('a rejected write still settles, and its rejection is left to its owner', async () => {
  resetBackgroundWrites();
  // The product always attaches its own .catch before tracking; the ledger must
  // not become a second handler, and must not leave the map holding a corpse.
  const handled = Promise.reject(new Error('disk full')).catch(() => 'handled by the caller');
  const returned = trackWrite('failing-write', handled);
  assert.equal(returned, handled, 'the promise is passed through untouched');
  await settled();
  assert.deepEqual(pending(), [], 'a failure releases the ledger exactly like a success');
  assert.equal(await handled, 'handled by the caller', 'and the caller’s own handler still ran');
});

test('a write started by another write is waited for too', async () => {
  // The reason settled() loops instead of resolving on the first drain.
  resetBackgroundWrites();
  let secondDone = false;
  const first = Promise.resolve().then(() => {
    trackWrite('second', new Promise<void>((r) => setTimeout(() => { secondDone = true; r(); }, 30)));
  });
  trackWrite('first', first);
  await settled();
  assert.equal(secondDone, true, 'settled() must not return between two chained writes');
});

test('resetBackgroundWrites releases a waiter rather than stranding it', async () => {
  resetBackgroundWrites();
  trackWrite('abandoned', new Promise<void>(() => { /* never settles */ }));
  const waiter = settled();
  resetBackgroundWrites();
  await waiter; // would hang forever if reset did not release
  assert.deepEqual(pending(), []);
});
