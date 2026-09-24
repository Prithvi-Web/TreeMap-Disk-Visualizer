import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-unattended-delete-data-');
process.env.TREEMAP_NO_GDU = '1';

import { moveToTrash, setTrashStepForTests } from '../src/services/cleaner';
import { AppError } from '../src/middleware/errorHandler';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import { approvePolicy, listPolicies, runPolicy, savePolicies } from '../src/services/autopilot';

/**
 * An unattended delete (Autopilot) never trashes what the open-file check
 * (B2) could not look at. On 24 Sep 2026, with this Mac under load, `lsof`
 * outran its 30 s limit, the check answered "couldn't check", and a live
 * Autopilot run trashed a file another process held open: B2 lets a person's
 * delete go ahead on an unknown answer (they are shown the warning), and
 * nobody is shown anything during an unattended run. Now an unattended delete
 * whose check failed moves nothing and says why; the next run tries again.
 * Where the check can never run on this machine, the documented rule stands
 * for both: refusing every delete there would be worse than the risk.
 *
 * Nothing here reaches the real Trash: the Trash step is replaced by a
 * recorder, so even a build that let the delete through only records it.
 */

type Provider = {
  getOpenHandlesBatch: (paths: string[]) => Promise<unknown>;
  probeOpenHandleGuard: () => Promise<unknown>;
};
const provider = platform() as unknown as Provider;

/** Runs `fn` with the probe answering `probe` and the capability `available`, and the Trash step recorded. */
async function withGuard(
  probe: 'fails' | 'clear',
  available: boolean,
  fn: (trashed: string[]) => Promise<void>,
): Promise<void> {
  const originalBatch = provider.getOpenHandlesBatch.bind(provider);
  const originalProbe = provider.probeOpenHandleGuard.bind(provider);
  const trashed: string[] = [];
  provider.getOpenHandlesBatch = probe === 'fails'
    ? () => Promise.reject(new Error('lsof timed out after 30000 ms'))
    : () => Promise.resolve({ handles: [], complete: true });
  provider.probeOpenHandleGuard = () => Promise.resolve(
    available
      ? { available: true, mechanism: 'test' }
      : { available: false, mechanism: 'none', reason: 'This computer has no way to list open files.' },
  );
  invalidateCapabilities();
  setTrashStepForTests(async (p) => {
    trashed.push(p);
  });
  try {
    await fn(trashed);
  } finally {
    provider.getOpenHandlesBatch = originalBatch;
    provider.probeOpenHandleGuard = originalProbe;
    invalidateCapabilities();
    setTrashStepForTests(null);
  }
}

async function tempFile(): Promise<{ dir: string; file: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-unattended-'));
  const file = path.join(dir, 'item.bin');
  await fsp.writeFile(file, crypto.randomBytes(4096));
  return { dir, file };
}

test('an unattended delete whose open-file check failed moves nothing, and says why', async () => {
  const { dir, file } = await tempFile();
  try {
    await withGuard('fails', true, async (trashed) => {
      await assert.rejects(moveToTrash([file], { unattended: true }), (err: unknown) => {
        assert.ok(err instanceof AppError, String(err));
        assert.equal(err.code, 'OPEN_HANDLE_UNCHECKED');
        assert.equal(err.status, 409);
        assert.match(err.message, /couldn’t check whether these files are in use \(lsof timed out after 30000 ms\)/);
        assert.match(err.message, /nothing was moved to the Trash/);
        return true;
      });
      assert.deepEqual(trashed, [], 'the Trash step was never reached');
    });
    assert.ok(fs.existsSync(file), 'the file is where it was');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a person’s delete still goes ahead when the check failed, as B2 documents', async () => {
  const { dir, file } = await tempFile();
  try {
    await withGuard('fails', true, async (trashed) => {
      const result = await moveToTrash([file]);
      assert.deepEqual(result.deleted, [file]);
      assert.deepEqual(trashed, [file]);
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('where the check can never run on this machine, an unattended delete goes ahead as a person’s does', async () => {
  const { dir, file } = await tempFile();
  try {
    await withGuard('fails', false, async (trashed) => {
      const result = await moveToTrash([file], { unattended: true });
      assert.deepEqual(result.deleted, [file]);
      assert.deepEqual(trashed, [file]);
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a check that ran and found nothing open lets an unattended delete through', async () => {
  const { dir, file } = await tempFile();
  try {
    await withGuard('clear', true, async (trashed) => {
      const result = await moveToTrash([file], { unattended: true });
      assert.deepEqual(result.deleted, [file]);
      assert.deepEqual(trashed, [file]);
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a live Autopilot run whose check failed deletes nothing and is blocked', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-unattended-run-'));
  try {
    const held = path.join(dir, 'proj', 'node_modules', 'dep', 'held.bin');
    await fsp.mkdir(path.dirname(held), { recursive: true });
    await fsp.writeFile(held, crypto.randomBytes(8192));
    await withGuard('fails', true, async (trashed) => {
      const [policy] = await savePolicies([{
        id: 'unattended-unchecked', name: 'p', path: dir,
        match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
        dryRunFirst: false, enabled: true,
      }]);
      await approvePolicy(policy.id);
      const result = await runPolicy((await listPolicies())[0]);
      assert.equal(result.mode, 'live', 'it really did try');
      assert.equal(result.bytesDeleted, 0);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(trashed, [], 'the Trash step was never reached');
    });
    assert.ok(fs.existsSync(held), 'the file is where it was');
  } finally {
    await savePolicies([]);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
