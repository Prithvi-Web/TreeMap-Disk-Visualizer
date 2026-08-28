import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `agent-policy.json` is the user's guard rail on what agents and the HTTP API
 * may scan and destroy, and every enforcement short-circuits on an EMPTY
 * policy: `assertScanAllowed` returns immediately when `allowedRoots` is
 * empty, the `protectedPaths` loop never runs, `assertBytesCap` returns when
 * the cap is null.
 *
 * So "the policy file could not be read" and "the user configured no
 * restrictions" produced byte-identical behaviour — every guard rail off,
 * silently. An ABSENT file genuinely means no restrictions and is documented
 * as today's behaviour; a file that is there and will not parse is a different
 * fact, and this boundary fails CLOSED on it.
 *
 * Tested in BOTH directions, because a boundary that refuses everything is as
 * broken as one that permits everything.
 */

function withPolicy<T>(contents: string | null, fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-policy-'));
  const prior = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = dir;
  if (contents !== null) fs.writeFileSync(path.join(dir, 'agent-policy.json'), contents);
  return fn().finally(() => {
    process.env.TREEMAP_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('an ABSENT policy file means no restrictions — the documented default', async () => {
  await withPolicy(null, async () => {
    const { getPolicy } = await import('../src/services/policy');
    const policy = await getPolicy();
    assert.deepEqual(policy.allowedRoots, []);
    assert.deepEqual(policy.protectedPaths, []);
    assert.equal(policy.maxBytesPerOperation, null);
  });
});

test('a valid policy is read as written', async () => {
  await withPolicy(JSON.stringify({ allowedRoots: ['/tmp/x'], protectedPaths: ['/tmp/x/keep'], maxBytesPerOperation: 42 }), async () => {
    const { getPolicy } = await import('../src/services/policy');
    const policy = await getPolicy();
    assert.deepEqual(policy.allowedRoots, ['/tmp/x']);
    assert.deepEqual(policy.protectedPaths, ['/tmp/x/keep']);
    assert.equal(policy.maxBytesPerOperation, 42);
  });
});

test('a CORRUPT policy file refuses, rather than reading as "no limits"', async () => {
  await withPolicy('{"allowedRoots": ["/tmp/x"', async () => {
    const { getPolicy } = await import('../src/services/policy');
    await assert.rejects(
      () => getPolicy(),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message: string };
        assert.equal(e.code, 'POLICY_UNREADABLE');
        // 500, not 403: nothing about the CALLER is forbidden — the server
        // cannot determine authorization at all, and a 403 is
        // indistinguishable in logs from a genuine policy denial.
        assert.equal(e.status, 500);
        return true;
      },
    );
  });
});

test('the refusal leaks no local path, and does not tell the user to delete the file', async () => {
  await withPolicy('{oops', async () => {
    const { getPolicy } = await import('../src/services/policy');
    const message = await getPolicy().then(() => '', (e: Error) => e.message);
    // `errorHandler` passes an AppError through verbatim at any status, while
    // its own generic 500 branch hides internals — and the Dockerfile binds
    // 0.0.0.0. An absolute path here leaks the OS username.
    assert.ok(!/\/Users\/|\/home\/|C:\\/.test(message), `message leaks a path: ${message}`);
    // And "remove it" would hand the user the no-limits shape the refusal
    // exists to avoid, in the same sentence as the refusal.
    assert.ok(!/remove/i.test(message), `message recommends removal: ${message}`);
    assert.match(message, /Repair/i);
  });
});

test('malformed FIELDS still fall back to no restriction — only the FILE fails closed', async () => {
  // The distinction the module documents: a hand-edited entry putting a
  // string where an array belongs is normalised, because the file parsed and
  // the user's intent is readable. That is not the same as a file that will
  // not parse at all.
  await withPolicy(JSON.stringify({ allowedRoots: 'not-an-array', maxBytesPerOperation: -5 }), async () => {
    const { getPolicy } = await import('../src/services/policy');
    const policy = await getPolicy();
    assert.deepEqual(policy.allowedRoots, []);
    assert.equal(policy.maxBytesPerOperation, null);
  });
});
