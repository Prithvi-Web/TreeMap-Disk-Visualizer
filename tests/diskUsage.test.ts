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

test('a path that does not exist is refused, not answered with zero', async () => {
  // The rule this module exists to enforce: never invent a number. A caller
  // that gets `{ free: 0 }` for an unreadable volume tells the user their
  // disk is full, which is what `/api/system` and the forecast did before.
  await assert.rejects(
    () => diskUsage(path.join(os.tmpdir(), 'treemap-no-such-path-ever-8f3a2b')),
    (err: unknown) => err instanceof Error && err.message.length > 0,
    'an unreadable path must reject rather than resolve',
  );
});

test('two readings of the same volume report the same total', async () => {
  const a = await diskUsage(os.tmpdir());
  const b = await diskUsage(os.tmpdir());
  assert.equal(a.total, b.total, 'the size of a volume does not change between two calls');
});
