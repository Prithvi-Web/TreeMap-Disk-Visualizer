import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  providerForPath,
  decodeStubName,
  fromPlatformInfo,
  emptyTotals,
  addToTotals,
  resolve,
  type PlaceholderVerdict,
} from '../src/services/placeholderResolver';
import { platform } from '../src/platform';
import type { PlaceholderInfo } from '../src/platform/types';

/**
 * A3 — cloud placeholder and sparse-file accounting.
 *
 * The distinction under test throughout: a file that occupies less than it
 * claims is either **in the cloud** (safe to leave; it costs nothing here) or
 * merely **sparse** (a VM disk, a database — deleting it destroys real data).
 * Conflating them is the bug A3 exists to prevent, and it is the one that
 * would do actual harm.
 */

const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-ph-'));

/* ══════════════════════ Provider inference ══════════════════════ */

test('sync folders are recognised across platforms and spellings', () => {
  assert.equal(providerForPath('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/a.pdf'), 'icloud');
  assert.equal(providerForPath('/Users/me/Library/Mobile Documents/x/y.txt'), 'icloud');
  assert.equal(providerForPath('/Users/me/OneDrive/report.docx'), 'onedrive');
  // A work account appends the organisation name.
  assert.equal(providerForPath('/Users/me/OneDrive - Contoso Ltd/report.docx'), 'onedrive');
  assert.equal(providerForPath('/Users/me/Dropbox/photo.jpg'), 'dropbox');
  assert.equal(providerForPath('/Users/me/Google Drive/sheet.csv'), 'gdrive');
  // Windows separators must work too.
  assert.equal(providerForPath('C:\\Users\\me\\OneDrive\\report.docx'), 'onedrive');
});

test('a file merely named after a sync folder is not claimed by it', () => {
  // The failure a bare substring match produces: an ordinary Desktop file
  // reported as living in the cloud, and therefore as costing nothing.
  assert.equal(providerForPath('/Users/me/Desktop/my-Dropbox-notes.txt'), null);
  assert.equal(providerForPath('/Users/me/Desktop/OneDrive-migration-plan.md'), null);
  assert.equal(providerForPath('/Users/me/Documents/report.docx'), null);
});

test('an evicted iCloud stub reveals the real filename', () => {
  assert.equal(decodeStubName('.Report.pdf.icloud'), 'Report.pdf');
  assert.equal(decodeStubName('.Holiday Video.mov.icloud'), 'Holiday Video.mov');
  assert.equal(decodeStubName('Report.pdf'), null);
  assert.equal(decodeStubName('.icloud'), null, 'a bare marker names nothing');
});

/* ══════════════════════ The cloud / sparse distinction ══════════════════════ */

const evictedInfo = (logical: number): PlaceholderInfo => ({
  logicalSize: logical,
  localSize: 0,
  provider: 'unknown',
  evicted: true,
  mechanism: 'test',
});

test('an evicted cloud file reports both sizes, never one', () => {
  const v = fromPlatformInfo('/Users/me/OneDrive/big.mov', 4_200_000_000, evictedInfo(4_200_000_000));
  assert.equal(v.cloudBytes, 4_200_000_000, 'what downloading it would cost');
  assert.equal(v.localBytes, 0, 'what it costs today');
  assert.equal(v.provider, 'onedrive');
  assert.equal(v.evicted, true);
  assert.equal(v.sparseNotCloud, false);
});

test('a sparse file outside any sync folder is NOT called a cloud file', () => {
  // The dangerous case. A VM disk image occupies far less than it claims, and
  // labelling it "in the cloud" invites deleting something irreplaceable.
  const v = fromPlatformInfo('/Users/me/VMs/ubuntu.qcow2', 60_000_000_000, {
    logicalSize: 60_000_000_000,
    localSize: 3_000_000_000,
    provider: 'unknown',
    evicted: true, // the platform layer only knows "occupies less than it claims"
    mechanism: 'allocated blocks',
  });
  assert.equal(v.provider, null);
  assert.equal(v.evicted, false, 'not evicted — it was never in a cloud to begin with');
  assert.equal(v.sparseNotCloud, true);
  assert.equal(v.localBytes, 3_000_000_000, 'its real cost is still reported accurately');
});

test('a fully-downloaded file in a sync folder reports its full local size', () => {
  // §A3 acceptance, the second half: the same folder after "always keep on this
  // device" must show full local usage.
  const v = fromPlatformInfo('/Users/me/OneDrive/big.mov', 4_200_000_000, {
    logicalSize: 4_200_000_000,
    localSize: 4_200_000_000,
    provider: 'onedrive',
    evicted: false,
    mechanism: 'test',
  });
  assert.equal(v.localBytes, v.cloudBytes, 'it is genuinely here');
  assert.equal(v.evicted, false);
});

test('the path wins over the platform guess when naming the provider', () => {
  // The platform layer infers loosely; the path is the stronger signal.
  const v = fromPlatformInfo('/Users/me/Dropbox/x.bin', 100, {
    logicalSize: 100,
    localSize: 0,
    provider: 'icloud',
    evicted: true,
    mechanism: 'test',
  });
  assert.equal(v.provider, 'dropbox');
});

/* ══════════════════════ Totals ══════════════════════ */

test('totals separate what is claimed from what is actually here', () => {
  const totals = emptyTotals();
  addToTotals(totals, fromPlatformInfo('/Users/me/OneDrive/a.mov', 3_000_000_000, evictedInfo(3_000_000_000)));
  addToTotals(totals, fromPlatformInfo('/Users/me/OneDrive/b.mov', 1_000_000_000, evictedInfo(1_000_000_000)));

  assert.equal(totals.fileCount, 2);
  assert.equal(totals.cloudBytes, 4_000_000_000);
  assert.equal(totals.localBytes, 0);
  assert.equal(totals.notOnThisMachine, 4_000_000_000, 'the headline A3 number');
});

test('a sparse local file never inflates the cloud totals', () => {
  const totals = emptyTotals();
  addToTotals(
    totals,
    fromPlatformInfo('/Users/me/VMs/disk.qcow2', 60_000_000_000, {
      logicalSize: 60_000_000_000,
      localSize: 1_000_000,
      provider: 'unknown',
      evicted: true,
      mechanism: 'test',
    }),
  );
  assert.deepEqual(totals, emptyTotals(), 'nothing here is cloud storage');
});

/* ══════════════════════ Against the real filesystem ══════════════════════ */

test('an ordinary local file is not a placeholder', async () => {
  const dir = await mkTmp();
  try {
    const solid = path.join(dir, 'solid.bin');
    await fsp.writeFile(solid, Buffer.alloc(64 * 1024, 1));
    assert.equal(await resolve(solid, 64 * 1024), null, 'nothing to report about an ordinary file');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a real sparse file is detected, and classified as sparse rather than cloud', async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'sparse.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 32 * 1024 * 1024);
    fs.closeSync(fd);

    const verdict = await resolve(sparse, 32 * 1024 * 1024);
    if (verdict === null) {
      // Windows reports no meaningful allocated size from lstat; the provider
      // there uses file attributes instead, and a plain sparse file created
      // this way is not marked. Recorded rather than asserted away.
      assert.equal(process.platform, 'win32', 'only Windows may fail to see this');
      return;
    }
    assert.equal(verdict.provider, null, 'a temp folder is not a sync folder');
    assert.equal(verdict.sparseNotCloud, true);
    assert.ok(verdict.localBytes < verdict.cloudBytes, 'it occupies less than it claims');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Records what `stat.blocks` actually does on this platform.
 *
 * This is a **record, not a gate** — it asserts only the thing that is true
 * everywhere, and prints the rest. It exists because the scanner's original
 * placeholder detection read `stat.blocks === 0` directly, which is correct on
 * macOS and Linux and unverifiable-from-here on Windows: libuv either leaves
 * the field at zero (flagging every OneDrive file as evicted) or derives it
 * from the size (never detecting a placeholder at all). Both are silent
 * failures. The CI run on windows-latest prints the answer here, and
 * A3 routes detection through the platform layer so it is correct either way.
 */
test('record: what stat.blocks reports for a sparse file on this platform', async () => {
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'probe.bin');
    const size = 16 * 1024 * 1024;
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);

    const st = await fsp.lstat(sparse);
    const derivedFromSize = Math.ceil(size / 512);
    const verdict =
      st.blocks === 0
        ? 'ZERO — a real allocated count, or an unfilled field'
        : st.blocks === derivedFromSize
          ? 'DERIVED FROM SIZE — not a real allocated count'
          : `REAL (${String(st.blocks)} blocks = ${String(st.blocks * 512)} bytes)`;

    console.log(`      [platform record] ${process.platform}: size=${String(size)} blocks=${String(st.blocks)} → ${verdict}`);

    assert.equal(typeof st.blocks, 'number', 'the field exists everywhere, whatever it means');
    if (process.platform !== 'win32') {
      assert.ok(st.blocks * 512 < size, 'on POSIX it is a genuine allocated count, and a sparse file occupies less');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the platform provider — not raw stat.blocks — is what decides placeholder status', async () => {
  // The seam that makes Windows correct without this file knowing how Windows
  // works. If a future change reads stat.blocks directly again, this is the
  // test that should have caught it.
  const dir = await mkTmp();
  try {
    const sparse = path.join(dir, 'x.bin');
    const fd = fs.openSync(sparse, 'w');
    fs.ftruncateSync(fd, 8 * 1024 * 1024);
    fs.closeSync(fd);

    const info = await platform().getPlaceholderInfo(sparse);
    if (process.platform === 'win32') {
      // Nothing is asserted about the value; the point is that the call exists
      // and answers without throwing.
      assert.ok(info === null || typeof info.localSize === 'number');
    } else {
      assert.ok(info, 'POSIX platforms detect this through the provider');
      assert.ok(info!.localSize < info!.logicalSize);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════ Honesty of the model ══════════════════════ */

test('cloud and local bytes are separate fields, never one merged number', () => {
  // §A3: "report cloud size and local size separately, never conflated." A
  // single "size" is exactly the bug — it is what makes a 4 GB evicted video
  // look like it is filling the disk.
  const v: PlaceholderVerdict = fromPlatformInfo('/Users/me/OneDrive/v.mov', 4_000_000_000, evictedInfo(4_000_000_000));
  assert.ok('cloudBytes' in v && 'localBytes' in v);
  assert.notEqual(v.cloudBytes, v.localBytes);
});
