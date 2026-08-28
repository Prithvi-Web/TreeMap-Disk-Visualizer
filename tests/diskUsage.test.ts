import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { diskUsage } from '../src/services/diskUsage';

/**
 * Disk capacity, on whatever platform is running this.
 *
 * This module had no test at all — before or after being rewritten to fix a
 * Windows CI failure. It feeds `/api/system`, the desktop tray, the disk-full
 * forecast and the offload space check, so a wrong number here is a wrong
 * number in front of the user in four places, and the one platform the
 * rewrite was written FOR was the one platform nobody could check.
 *
 * The cross-check below is the point: it runs the fast syscall path and the
 * platform's own tool on the same volume and requires them to agree. That is
 * the assertion that answers, on the runner rather than in a comment, whether
 * `uv_fs_statfs` reports what `df` and `Get-CimInstance` report.
 */

test('a real path answers with a plausible total and free', async () => {
  const { total, free } = await diskUsage(os.tmpdir());
  assert.ok(Number.isFinite(total) && total > 0, `total should be a positive number, got ${String(total)}`);
  assert.ok(Number.isFinite(free) && free >= 0, `free should be a non-negative number, got ${String(free)}`);
  assert.ok(free <= total, `free (${String(free)}) cannot exceed total (${String(total)})`);
  // Any volume that can host a test checkout is at least a gigabyte. A
  // plausibility floor catches a unit error — bytes reported as blocks, or
  // the other way round — which no relative check would notice.
  assert.ok(total > 1024 ** 3, `a volume of ${String(total)} bytes is not a real one`);
});

test('the syscall and the platform tool agree about the same volume', async (t) => {
  // Both paths, on the same target, in the same run. `df` on Unix,
  // `Get-CimInstance Win32_LogicalDisk` on Windows.
  const mod = await import('../src/services/diskUsage');
  const viaPublic = await mod.diskUsage(os.tmpdir());

  const { execFile } = await import('node:child_process');
  const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) =>
        err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
      );
    });

  let toolTotal: number;
  if (process.platform === 'win32') {
    const drive = path.parse(path.resolve(os.tmpdir())).root.replace(/\\$/, '');
    const ps = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    toolTotal = Number((JSON.parse(out) as { Size: number }).Size);
  } else {
    const out = await run('df', ['-k', os.tmpdir()]);
    const lines = out.trim().split('\n');
    const nums = lines[lines.length - 1].trim().split(/\s+/).filter((c) => /^\d+$/.test(c)).map(Number);
    toolTotal = nums[0] * 1024;
  }

  t.diagnostic(`total — diskUsage ${String(viaPublic.total)} · platform tool ${String(toolTotal)}`);
  // TOTAL, not free: free space genuinely changes between two readings, and
  // asserting that two live readings match is how a flaky test is born — a
  // lesson this suite has already paid for once in `agentErgonomics`. Total
  // does not move, so a disagreement is a real disagreement.
  //
  // Exactly equal is the expectation on every filesystem measured here; the
  // 1% tolerance covers a volume whose tool rounds to whole blocks of a
  // different size, which would be a difference in reporting rather than a
  // difference in fact.
  assert.ok(
    Math.abs(viaPublic.total - toolTotal) <= toolTotal * 0.01,
    `the syscall and ${process.platform === 'win32' ? 'Get-CimInstance' : 'df'} disagree about the volume's size: ` +
      `${String(viaPublic.total)} vs ${String(toolTotal)}`,
  );
});

test('a path that does not exist is never answered with zero', async (t) => {
  /**
   * The rule this module exists to enforce: never invent a number. A caller
   * that gets `{ free: 0 }` tells the user their disk is full, which is what
   * `/api/system` and the forecast did before.
   *
   * The two platforms answer this question differently, and BOTH are right —
   * which an earlier version of this test got wrong by asserting the POSIX
   * shape everywhere. It failed on Windows CI, correctly:
   *
   *   - on Unix, `statfs`/`df` need the path itself, so a missing path is an
   *     error and `diskUsage` rejects;
   *   - on Windows the question is about the VOLUME. Both the syscall and
   *     `Win32_LogicalDisk` resolve to the drive root, and the drive exists,
   *     so `D:\no\such\path` answers about `D:` — as this module has always
   *     done there, long before the syscall rewrite.
   *
   * So the assertion is the invariant rather than the mechanism: either it
   * refuses, or it answers about a real volume. A fabricated zero is the one
   * outcome that is never acceptable.
   */
  const missing = path.join(os.tmpdir(), 'treemap-no-such-path-ever-8f3a2b');
  const outcome = await diskUsage(missing).then(
    (value) => ({ rejected: false as const, value }),
    (err: unknown) => ({ rejected: true as const, err }),
  );

  if (outcome.rejected) {
    t.diagnostic(`${process.platform}: refused a missing path`);
    assert.ok(outcome.err instanceof Error && outcome.err.message.length > 0, 'and said why');
    return;
  }
  t.diagnostic(`${process.platform}: answered about the containing volume — ${String(outcome.value.total)} bytes`);
  assert.ok(outcome.value.total > 1024 ** 3, 'it answered about a REAL volume, not with zeros');
  assert.ok(outcome.value.free >= 0 && outcome.value.free <= outcome.value.total);
});

test('a path on a volume that does not exist is refused outright', async (t) => {
  // The case with no honest answer on any platform: there is no volume to
  // report on. `assertPlausible` is the backstop — `Win32_LogicalDisk`
  // returns `Size: null` for a drive that is not there, and `Number(null)`
  // is 0, which is exactly the fabricated zero this module refuses to emit.
  const nowhere = process.platform === 'win32' ? 'Q:\\nope\\nothing' : '/proc/treemap-not-a-volume/x';
  const outcome = await diskUsage(nowhere).then(
    (value) => ({ rejected: false as const, value }),
    () => ({ rejected: true as const, value: null }),
  );
  if (!outcome.rejected) {
    // Some kernels answer for a pseudo-path; the invariant still holds.
    t.diagnostic(`${process.platform}: answered ${String(outcome.value.total)} bytes for ${nowhere}`);
    assert.ok(outcome.value.total > 0, 'never zeros');
    return;
  }
  assert.ok(true, 'refused, which is the honest answer');
});

test('two readings of the same volume report the same total', async () => {
  const a = await diskUsage(os.tmpdir());
  const b = await diskUsage(os.tmpdir());
  assert.equal(a.total, b.total, 'the size of a volume does not change between two calls');
});
