import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Isolate every capsule, settings and audit write from the user's real app
// data — this suite really does protect files into a Time Capsule.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-cartcommit-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { planProtection, getCapsuleIndex, protectItems } from '../src/services/timeCapsule';
import { initPortableMode, resetPortableMode } from '../src/services/portableMode';
import { planCartCommit, commitCart, undoCartRun, normalizeRunId, MAX_CART_PATHS } from '../src/services/cartCommit';
import { updateSettings } from '../src/services/settings';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(__dirname_, '..', 'public', 'index.html'), 'utf8');

/**
 * Phase 4 §4.4 — committing the cart through the Time Capsule.
 *
 * The claim under test is not "it deletes things". It is the harder one §4.4
 * actually makes: **anything too large to protect is left undeleted rather
 * than deleted unprotected**, and the manifest says so before the commit
 * rather than in a summary afterwards. A capsule that quietly lets a delete
 * through when it is full is worse than no capsule, because the user believes
 * they are covered — so the over-cap path gets a direct test, twice: once that
 * it is predicted, once that the file is still on disk afterwards.
 *
 * Nothing here puts anything in the real Trash. The integration tests drive
 * `planCartCommit`, which by construction touches nothing, and the HTTP tests
 * exercise validation and refusal paths that stop before any delete.
 */

after(async () => {
  if (shared) await shared.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * One server for the whole file, started on first use.
 *
 * It used to be one per test. Node runs test FILES in parallel, and five
 * server startups plus their scans is real contention on a three-core CI
 * runner — which is the documented cause of the watcher tests in
 * `indexEngine.test.ts` missing their FSEvents callbacks. Nothing here needs
 * a fresh process; the rate limiter is what needed resetting between tests,
 * and that is a function call.
 */
let shared: { port: number; close: () => Promise<void> } | null = null;

async function listen() {
  resetRateLimiter();
  if (shared) return { port: shared.port, close: async () => {} };
  const app = createApp(path.join(__dirname_, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  shared = {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return { port: shared.port, close: async () => {} };
}

function req(
  port: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
          : headers,
      },
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

/** A fixture directory with `files` of `bytes` each. */
async function fixture(prefix: string, files: number, bytes: number): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `tm-cart-${prefix}-`));
  for (let i = 0; i < files; i++) {
    await fsp.writeFile(path.join(dir, `f${i}.bin`), Buffer.alloc(bytes, i % 251));
  }
  return dir;
}

/* ══════════════════ the dry run describes, and touches nothing ══════════════════ */

test('the dry run reports every item with its real walked size, and deletes nothing', async () => {
  const dir = await fixture('plan', 3, 4096);
  try {
    const paths = [0, 1, 2].map((i) => path.join(dir, `f${i}.bin`));
    const plan = await planCartCommit(paths);

    assert.equal(plan.dryRun, true);
    assert.equal(plan.items.length, 3);
    for (const item of plan.items) {
      assert.equal(item.bytes, 4096, 'the walked size, not a stat of the directory');
      assert.equal(item.willDelete, true);
    }
    assert.equal(plan.bytesWouldFree, 4096 * 3);
    assert.equal(plan.bytesSkipped, 0);

    // The whole point: nothing moved, and the capsule holds nothing new.
    for (const p of paths) assert.ok(fs.existsSync(p), `${p} is still there`);
    const index = await getCapsuleIndex();
    assert.equal(index.entries.length, 0, 'a dry run creates no capsule entry');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an item that is already gone is named, not counted as freeable', async () => {
  const dir = await fixture('gone', 1, 512);
  try {
    const missing = path.join(dir, 'never-existed.bin');
    const plan = await planCartCommit([path.join(dir, 'f0.bin'), missing]);
    const item = plan.items.find((i) => i.path === missing)!;
    assert.equal(item.willDelete, false);
    assert.match(item.reason ?? '', /no longer there/i);
    assert.equal(plan.bytesWouldFree, 512, 'only the real one counts');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ the rule that matters: over-cap is LEFT ALONE ══════════════════ */

/**
 * The §4.4 rule, forced for real: an item bigger than the whole capsule.
 *
 * A sparse file is the only honest way to get there without writing terabytes
 * — `truncate` sets the logical size, which is what `walkItem` measures and
 * what the capsule would have to hold, while the volume allocates nothing.
 *
 * Sized from the capsule's ACTUAL cap rather than a constant. The cap is a
 * share of *this* volume's usable space, so a number comfortably over it on
 * one machine need not be on another — and the constant this started with,
 * 1 PiB, is past **ext4's 16 TiB maximum file size**: APFS took it happily and
 * Linux CI failed with EFBIG before the test body ever ran. A test that
 * manufactures its own precondition has to ask the machine what that
 * precondition is.
 *
 * Skipped on Windows deliberately rather than "fixed": NTFS allocates
 * truncate-only files solid, so this fixture would really write the whole
 * thing. That is the handoff's own POSIX-shaped-but-different rule.
 */
const SPARSE_SKIP = process.platform === 'win32'
  ? 'NTFS allocates truncate-only files solid, so a sparse fixture would really be written out in full'
  : false;

test('an item bigger than the whole capsule is left UNDELETED, and says why', { skip: SPARSE_SKIP }, async (t) => {
  const dir = await fixture('cap', 0, 0);
  try {
    // Ask the capsule how much it can hold, then make something larger.
    const { capBytes } = await planProtection([]);
    const overCap = capBytes + 4096;
    const huge = path.join(dir, 'huge.sparse');
    await fsp.writeFile(huge, '');
    try {
      await fsp.truncate(huge, overCap);
    } catch (err) {
      // A filesystem that will not make a sparse file this large cannot host
      // this test. Say so rather than fail for a reason that is not the point.
      t.skip(`this filesystem refused a ${overCap}-byte sparse file (${(err as Error).message})`);
      return;
    }
    const small = path.join(dir, 'small.bin');
    await fsp.writeFile(small, Buffer.alloc(4096, 7));

    const plan = await planCartCommit([huge, small]);
    const forHuge = plan.items.find((i) => i.path === huge)!;
    assert.equal(forHuge.willDelete, false, 'it is not going to be deleted');
    assert.equal(forHuge.code, 'CAPSULE_FULL');
    assert.match(forHuge.reason ?? '', /left alone rather than deleted without a backup/i);
    assert.equal(plan.bytesSkipped, overCap, 'the skipped bytes are stated, not hidden');

    // The small one is unaffected: one refusal does not poison the batch.
    assert.equal(plan.items.find((i) => i.path === small)!.willDelete, true);
    assert.equal(plan.bytesWouldFree, 4096);

    // And the real run leaves it exactly where it is. This is the assertion
    // the whole feature rests on — "left undeleted rather than deleted
    // unprotected" is a claim about the disk, so it is checked on the disk.
    const result = await commitCart([huge]);
    assert.equal(result.trashed.length, 0, 'nothing was trashed');
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].code, 'CAPSULE_FULL');
    assert.ok(fs.existsSync(huge), 'the file is still there');
    assert.equal(fs.statSync(huge).size, overCap, 'untouched, at its full size');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the plan accumulates: later items are planned against a capsule the earlier ones filled', async () => {
  // Ten items and a cap that fits only some of them. The naive predictor —
  // "does each item fit on its own?" — says all ten are safe and then the real
  // run refuses three of them, which is exactly the surprise §4.4 forbids.
  const dir = await fixture('accum', 10, 128 * 1024);
  try {
    const paths = Array.from({ length: 10 }, (_, i) => path.join(dir, `f${i}.bin`));
    const plan = await planProtection(paths);
    // Whatever the machine's cap turns out to be, the plan must be internally
    // consistent: the protected bytes never exceed the cap.
    assert.ok(plan.bytesProtected <= plan.capBytes,
      `planned ${plan.bytesProtected} bytes against a ${plan.capBytes} byte cap`);
    // And every item is accounted for, one way or the other.
    assert.equal(plan.items.length, 10);
    assert.equal(
      plan.items.filter((i) => i.willProtect).length + plan.items.filter((i) => !i.willProtect).length,
      10,
    );
    assert.equal(
      plan.items.filter((i) => i.willProtect).reduce((s, i) => s + i.bytes, 0),
      plan.bytesProtected,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a capsule that cannot run at all reports every item unprotected — and nothing is deleted', async () => {
  // The read-only portable session. `protectAndTrash` returns every request in
  // `skipped` with the capsule's own reason and performs no delete; the plan
  // has to agree with that in advance.
  //
  // Forced by pointing the data dir *inside a regular file*, so mkdir fails
  // with ENOTDIR on every OS. chmod would be the obvious way and is the wrong
  // one: the handoff records that chmod cannot make a directory read-only on
  // Windows, which is why two D3 tests carry a NO_CHMOD skip.
  const dir = await fixture('portable', 2, 1024);
  const blocker = path.join(dir, 'not-a-directory');
  await fsp.writeFile(blocker, 'x');
  try {
    resetPortableMode();
    const status = initPortableMode({
      TREEMAP_PORTABLE: '1',
      TREEMAP_DATA_DIR: path.join(blocker, 'data'),
    } as NodeJS.ProcessEnv);
    assert.equal(status.writable, false, 'the session really is read-only');
    const paths = [0, 1].map((i) => path.join(dir, `f${i}.bin`));
    const plan = await planCartCommit(paths);
    assert.equal(plan.capsule.available, false);
    assert.ok(plan.capsule.reason && plan.capsule.reason.length > 20, 'the reason is shown verbatim');
    assert.equal(plan.bytesWouldFree, 0);
    for (const item of plan.items) {
      assert.equal(item.willDelete, false);
      assert.equal(item.code, 'CAPSULE_UNAVAILABLE');
    }

    const result = await commitCart(paths);
    assert.equal(result.trashed.length, 0, 'nothing was deleted');
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.skipped.length, 2);
    assert.ok(result.capsuleUnavailable);
    for (const p of paths) assert.ok(fs.existsSync(p), 'the originals are untouched');
  } finally {
    // Back to the isolated on-disk data dir, or every later test in this file
    // would run against an in-memory capsule.
    resetPortableMode();
    initPortableMode({ TREEMAP_DATA_DIR: DATA_DIR } as NodeJS.ProcessEnv);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ undo ══════════════════ */

test('undo refuses loudly when the capsule no longer holds the run', async () => {
  await assert.rejects(
    () => undoCartRun('a-run-that-never-happened'),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CAPSULE_EMPTY');
      return true;
    },
  );
});

test('undo needs a runId, and says so', async () => {
  await assert.rejects(() => undoCartRun(''), (err: any) => {
    assert.equal(err.code, 'RUN_ID_REQUIRED');
    return true;
  });
});

test('undo restores every entry a run protected, at its original path', async () => {
  const dir = await fixture('undo', 2, 2048);
  try {
    const paths = [0, 1].map((i) => path.join(dir, `f${i}.bin`));
    // protectItems is the capture half with no delete in it, which is exactly
    // what an undo needs to have something to restore — and it keeps this test
    // from putting anything in the real Trash.
    const { runId } = await protectItems(paths.map((p) => ({ path: p })), {});
    // Stand in for the delete the real commit performs.
    for (const p of paths) await fsp.rm(p);
    for (const p of paths) assert.ok(!fs.existsSync(p));

    const job = await undoCartRun(runId);
    assert.equal(job.entryCount, 2);
    // The restore is a job; wait for the files rather than for a status field.
    for (let i = 0; i < 200 && !paths.every((p) => fs.existsSync(p)); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const p of paths) {
      assert.ok(fs.existsSync(p), `${p} came back`);
      assert.equal(fs.statSync(p).size, 2048, 'byte-for-byte, not a placeholder');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ the route: validation, guards, idempotency ══════════════════ */

test('POST /api/cart/commit refuses a path outside every scanned root', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/cart/commit', {
      paths: [path.join(os.tmpdir(), 'not-scanned', 'x.bin')], dryRun: true,
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');
  } finally {
    await close();
  }
});

test('POST /api/cart/commit validates its body before it walks anything', async () => {
  const { port, close } = await listen();
  try {
    for (const body of [{}, { paths: [] }, { paths: 'x' }, { paths: [1, 2] }, { paths: [''] }]) {
      const r = await req(port, 'POST', '/api/cart/commit', body);
      assert.ok(r.status === 400, `${JSON.stringify(body)} → ${r.status}`);
    }
    const tooMany = await req(port, 'POST', '/api/cart/commit', {
      paths: Array.from({ length: MAX_CART_PATHS + 1 }, (_, i) => `/x/${i}`),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.code, 'TOO_MANY_PATHS');
  } finally {
    await close();
  }
});

test('a retried commit with the same Idempotency-Key cannot run twice', async () => {
  const dir = await fixture('idem', 2, 1024);
  const { port, close } = await listen();
  try {
    // Scan it first, so the paths are inside a scanned root.
    const started = await req(port, 'POST', '/api/scan', { path: dir });
    assert.equal(started.status, 202);
    for (let i = 0; i < 100; i++) {
      const s = await req(port, 'GET', `/api/scan/${started.body.scanId}/stats`);
      if (s.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const body = { paths: [path.join(dir, 'f0.bin')], dryRun: true };
    const key = { 'Idempotency-Key': 'cart-test-key-1' };

    const first = await req(port, 'POST', '/api/cart/commit', body, key);
    assert.equal(first.status, 200);
    const second = await req(port, 'POST', '/api/cart/commit', body, key);
    assert.equal(second.status, 200);
    // The replay is the recorded response, not a second execution.
    assert.deepEqual(second.body, first.body);
  } finally {
    await close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/cart/undo refuses an unknown run through the route too', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/cart/undo', { runId: 'nope' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CAPSULE_EMPTY');
    const missing = await req(port, 'POST', '/api/cart/undo', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'RUN_ID_REQUIRED');
  } finally {
    await close();
  }
});

/* ══════════════════ the frontend's half of §4.4 ══════════════════ */

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  const out = INDEX.slice(start, end);
  assert.ok(out.length > 100, `the slice ${from} → ${to} is suspiciously short`);
  return out;
}

test('the cart always runs a dry run before it commits', () => {
  // §4.4 step 1: "Run a dry run first, always". Not a checkbox, not a setting.
  const body = slice('async function cartTrashAll', 'async function cartExecuteCommit');
  assert.match(body, /dryRun: true/, 'the manifest is fetched before anything is shown');
  assert.ok(!body.includes('dryRun: false'), 'this half never commits');
});

test('the commit sends an Idempotency-Key so a retry cannot double-execute', () => {
  const body = slice('async function cartExecuteCommit', 'function cartCommitSummary');
  assert.match(body, /'Idempotency-Key'/);
  assert.match(body, /dryRun: false/);
});

test('the result summary offers a one-click undo of that run', () => {
  const body = slice('function cartCommitSummary', 'async function cartUndoRun');
  assert.match(body, /data-cart-undo/, 'the undo button carries the runId');
  const undo = slice('async function cartUndoRun', '/* ───────────────────────────── Quick-look preview');
  assert.match(undo, /\/api\/cart\/undo/);
});

test('items the capsule could not protect are shown as left behind, never as deleted', () => {
  const body = slice('function cartCommitSummary', 'async function cartUndoRun');
  assert.match(body, /skipped/, 'the summary reads the skipped list');
  assert.match(body, /left in place|left alone|not deleted/i,
    'and says plainly that those files are still there');
});

test('the manifest is shown before the confirm, including what would be left behind', () => {
  const body = slice('function cartManifestHtml', 'async function cartExecuteCommit');
  assert.match(body, /bytesSkipped|willDelete/, 'the manifest distinguishes the two outcomes');
  assert.match(body, /reason/, 'and shows the reason a file is being left alone');
});

/* ══════════════════ settings the commit depends on ══════════════════ */

test('the capsule percentage still bounds the plan after a settings change', async () => {
  const dir = await fixture('settings', 1, 8192);
  try {
    await updateSettings({ timeCapsuleMaxPercent: 1 });
    const low = await planProtection([path.join(dir, 'f0.bin')]);
    await updateSettings({ timeCapsuleMaxPercent: 90 });
    const high = await planProtection([path.join(dir, 'f0.bin')]);
    assert.ok(high.capBytes > low.capBytes, 'the cap tracks the setting');
    await updateSettings({ timeCapsuleMaxPercent: 10 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an informational cart dialog can never fall back to trashing a stale set', () => {
  // `confirmOk` trashes `confirmPaths` whenever `onConfirmTrash` is null, and
  // that array holds whatever the previous dialog put there. Both of the
  // cart's non-question dialogs must therefore clear it AND install a real
  // no-op — leaving the callback unset would arm the OK button with an
  // unrelated set of files.
  for (const [from, to] of [
    ['async function cartTrashAll', 'function cartManifestHtml'],
    ['function cartCommitSummary', 'async function cartUndoRun'],
  ] as const) {
    const body = slice(from, to);
    assert.match(body, /confirmPaths = \[\];/, `${from} clears the fallback set`);
    assert.ok(!/onConfirmTrash = null;/.test(body), `${from} never leaves the callback null`);
  }
});

test('undo promises the original dates, because it now restores them', () => {
  // Until the capsule recorded timestamps this said the opposite — that a
  // restored file's date modified would read as the moment it came back. The
  // promise and the behaviour have to move together, or the dialog is lying in
  // whichever direction it was last edited.
  const body = slice('function cartCommitSummary', 'async function cartUndoRun');
  assert.match(body, /byte for byte, with their original dates/);
  assert.ok(!body.includes('will read as the moment'), 'the old caveat is gone');
});

test('the result summary restates what the manifest said would be left behind', () => {
  // Only the deletable paths are sent, so the server has nothing to report as
  // skipped. A summary that said nothing about the rest would read as
  // "everything went" — one dialog after the one that said otherwise.
  const trash = slice('async function cartTrashAll', 'function cartManifestHtml');
  assert.match(trash, /const willNot = \(plan\.items \|\| \[\]\)\.filter\(\(i\) => !i\.willDelete\)/);
  assert.match(trash, /cartExecuteCommit\(willDelete\.map\(\(i\) => i\.path\), willNot\)/);
  const exec = slice('async function cartExecuteCommit', 'function cartCommitSummary');
  assert.match(exec, /\.\.\.foreseen\.map/, 'the foreseen refusals join the summary');
  const summary = slice('function cartCommitSummary', 'async function cartUndoRun');
  assert.match(summary, /still on your disk, not deleted, and still in your cart/);
});

/* ══════════════════ a cart bigger than one request ══════════════════ */

test('a runId is accepted only in the shape a commit actually returns', () => {
  assert.equal(normalizeRunId(undefined), undefined);
  assert.equal(normalizeRunId(''), undefined);
  assert.equal(normalizeRunId(null), undefined);
  const real = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  assert.equal(normalizeRunId(real), real);
  // A runId groups Time Capsule entries and undo restores every entry carrying
  // one, so an arbitrary string would let a caller group unrelated commits.
  for (const bad of ['../../etc', 'run-1', 42, {}, 'x'.repeat(36), true]) {
    assert.throws(() => normalizeRunId(bad), (err: any) => {
      assert.equal(err.code, 'BAD_RUN_ID');
      return true;
    }, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a chunked commit is ONE run, so undo puts the whole cart back', async () => {
  // The regression this closes: a query returns up to 1,000 hits and "Stage
  // matches" stages all of them, so a cart above the 500-per-request cap is
  // one click away. Before chunking, that cart could never be committed at
  // all — the route refused it outright.
  const dir = await fixture('chunked', 6, 1024);
  try {
    const all = Array.from({ length: 6 }, (_, i) => path.join(dir, `f${i}.bin`));
    // Two "chunks" of three, the second continuing the first's run.
    const first = await commitCart(all.slice(0, 3));
    assert.ok(first.runId, 'the first chunk starts a run');
    const second = await commitCart(all.slice(3), first.runId);
    assert.equal(second.runId, first.runId, 'the second joins it rather than starting another');

    for (const p of all) assert.ok(!fs.existsSync(p), 'everything was deleted');

    // One undo, both chunks.
    const job = await undoCartRun(first.runId);
    assert.equal(job.entryCount, 6, 'the undo covers both chunks, not just one');
    for (let i = 0; i < 200 && !all.every((p) => fs.existsSync(p)); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const p of all) {
      assert.ok(fs.existsSync(p), `${p} came back`);
      assert.equal(fs.statSync(p).size, 1024);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the frontend chunks both halves of the commit at the server cap', () => {
  assert.match(INDEX, /const CART_COMMIT_CHUNK = 500;/);
  const dry = slice('async function cartDryRun', '/**\n * The manifest, as the confirmation dialog shows it.');
  assert.match(dry, /i \+= CART_COMMIT_CHUNK/, 'the dry run is chunked too');
  assert.match(dry, /merged\.bytesWouldFree \+= part\.bytesWouldFree/, 'and the manifests are merged');
  const exec = slice('async function cartExecuteCommit', 'function cartCommitSummary');
  assert.match(exec, /i \+= CART_COMMIT_CHUNK/);
  assert.match(exec, /result\.runId \? \{ runId: result\.runId \} : \{\}/, 'later chunks join the first run');
  assert.match(exec, /`\$\{cartCommitKey\}-\$\{i \/ CART_COMMIT_CHUNK\}`/, 'one idempotency key per chunk');
});

test('a chunked commit that fails partway never claims nothing was deleted', () => {
  // Earlier chunks may already be gone, and they are recoverable through the
  // run they belong to. "Nothing was deleted" is the one sentence that must
  // not be sent when something was.
  const exec = slice('async function cartExecuteCommit', 'function cartCommitSummary');
  assert.match(exec, /if \(result\.trashed\.length\) \{/);
  assert.match(exec, /Stopped after/);
  assert.match(exec, /cartLastRun = result\.runId/, 'the partial run stays undoable');
});
