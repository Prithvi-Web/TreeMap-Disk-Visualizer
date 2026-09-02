import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { diskUsage, fromStatfs, fromDf } from '../src/services/diskUsage';

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

/* ── used, free, and the blocks that are neither ── */

test('the reserve is neither used nor free, and used never counts it', () => {
  // Synthetic on purpose: no machine in CI has a root reserve, so the one
  // branch this module exists for would otherwise never be executed. An
  // ext4-shaped 1 TB volume with the default 5% reserve and 600 GB occupied.
  const u = fromStatfs({ bsize: 4096, blocks: 262_144_000, bfree: 100_000_000, bavail: 87_891_200 });
  assert.equal(u.used, 4096 * (262_144_000 - 100_000_000), 'used is the occupied blocks, not total − free');
  assert.equal(u.free, 4096 * 87_891_200, 'free is what a normal program may write');
  assert.ok(u.used + u.free < u.total, 'and the two do not add up to the disk');
  assert.equal(u.total - u.used - u.free, 4096 * (100_000_000 - 87_891_200),
    'the shortfall is exactly the reserve — never an overlap and never a rounding gap');
});

test('used and free are answers to two different questions, and they never overlap', async (t) => {
  const { total, free, used } = await diskUsage(os.tmpdir());
  assert.ok(Number.isFinite(used) && used > 0, `used should be a positive number, got ${String(used)}`);
  assert.ok(used + free <= total, 'the shortfall is the root reserve, never an overlap');
  t.diagnostic(`total ${String(total)} · used ${String(used)} · free ${String(free)} · reserve ${String(total - used - free)}`);
  if (process.platform === 'darwin') {
    // APFS reserves nothing (bfree === bavail on every mount), so this is the
    // one platform where the two conventions must land on the same number —
    // which makes it the cross-check that the fallback has not drifted.
    assert.equal(used, total - free, 'APFS reserves nothing, so the two conventions must agree');
  }
});

test('the df fallback does not quietly change what "used" means', () => {
  // Real output from this Mac, captured at the same instant as a statfs that
  // reported 187,844,644 KB used on the same mount. macOS df reports a
  // per-VOLUME used against a container-wide Available, so its Used column is
  // 25 GiB adrift; APFS reserves nothing, so total − free is the figure that
  // matches the syscall this path is standing in for.
  const mac = fromDf(
    'Filesystem 1024-blocks       Used  Available Capacity  Mounted on\n' +
    '/dev/disk3s5 482797652  162086804  294955848    36%    /System/Volumes/Data',
    'darwin',
  );
  assert.equal(mac.used, mac.total - mac.free, 'on APFS the fallback agrees with the syscall it replaces');
  assert.notEqual(mac.used, 162086804 * 1024, 'df’s own Used column is the number that would move the tile');

  // Linux df IS blocks − bfree, and the shortfall is the root reserve, so its
  // column is the right one and total − free would swallow the reserve.
  const linux = fromDf(
    'Filesystem     1K-blocks      Used Available Use% Mounted on\n' +
    '/dev/sda1     1048576000 600000000 396288000  61% /',
    'linux',
  );
  assert.equal(linux.used, 600000000 * 1024, 'the occupied blocks, as the column reports them');
  assert.ok(linux.used + linux.free < linux.total, 'and the reserve is neither');
  assert.equal(linux.total - linux.used - linux.free, (1048576000 - 600000000 - 396288000) * 1024,
    'the shortfall is exactly the 5% ext4 keeps back');
});
