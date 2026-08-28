import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildStatement,
  assertBalances,
  resolveScanVolume,
  volumeForPath,
  containerSiblings,
  purgeableLine,
  type StatementSources,
  type AccountingStatement,
  type StatementLine,
} from '../src/services/missingGigabytes';
import type { LogicalVolumeInfo, VolumeTopology } from '../src/platform/types';
import type { ScanResult } from '../src/models/types';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { startScan } from '../src/services/diskScanner';
import { platform } from '../src/platform';

/**
 * The Missing Gigabytes (Phase 5).
 *
 * The feature's whole claim is that the arithmetic is real — so the tests are
 * about the arithmetic, not about the wording. Three things are load-bearing
 * and each is asserted directly rather than inferred:
 *
 *   1. **The statement balances, always.** Sum of every line === volume used.
 *      Not "usually", not "when sources agree" — the residual line exists
 *      precisely so this can be unconditional.
 *   2. **`unaccounted` is the discrepancy, and is never hidden.** When sources
 *      go missing the residual grows; it does not get spread across the other
 *      lines to keep the page tidy.
 *   3. **An unavailable line is never a zero.** This is the difference between
 *      "there are no snapshots" and "nobody will tell me about snapshots", and
 *      the whole view is worthless if it cannot draw it.
 *
 * Everything is driven through injected sources, because the interesting
 * machines — one with snapshots, one whose snapshot tool is missing, one that
 * does not balance — do not exist on the machine this suite runs on.
 */

/* ────────────────────────────── fixture plumbing ────────────────────────────── */

function vol(over: Partial<LogicalVolumeInfo> & { id: string }): LogicalVolumeInfo {
  return {
    id: over.id,
    name: over.name ?? over.id,
    mountPoint: over.mountPoint ?? null,
    filesystem: over.filesystem ?? 'apfs',
    sizeBytes: over.sizeBytes ?? null,
    freeBytes: over.freeBytes ?? null,
    usedBytes: over.usedBytes ?? null,
    physicalDiskIds: over.physicalDiskIds ?? ['disk0'],
    kind: over.kind ?? 'apfs',
  };
}

const GB = 1_000_000_000;
const BLOCK = 4096;

/**
 * A Mac shaped like the machine this was built on: one container, a sealed
 * system volume firmlinked to a data volume (same device id), and four
 * siblings a scan never walks.
 */
const MAC_VOLUMES: LogicalVolumeInfo[] = [
  vol({ id: 'disk3s1s1', name: 'Macintosh HD', mountPoint: '/', usedBytes: 12 * GB }),
  vol({ id: 'disk3s5', name: 'Data', mountPoint: '/System/Volumes/Data', usedBytes: 163 * GB }),
  vol({ id: 'disk3s2', name: 'Preboot', mountPoint: '/System/Volumes/Preboot', usedBytes: 9 * GB }),
  vol({ id: 'disk3s6', name: 'VM', mountPoint: '/System/Volumes/VM', usedBytes: 2 * GB }),
  vol({ id: 'disk3s4', name: 'Update', mountPoint: '/System/Volumes/Update', usedBytes: 0 }),
  vol({ id: 'disk3s3', name: 'unmounted', mountPoint: null, usedBytes: 1 * GB }),
  // A different container on the same physical disk: never a sibling.
  vol({ id: 'disk1s1', name: 'iSCPreboot', mountPoint: '/System/Volumes/iSCPreboot', usedBytes: 5 * GB }),
];

/** `/`, the Data volume and everything under them are one device. The rest are not. */
const MAC_DEVS: Record<string, number> = {
  '/': 16777233,
  '/System/Volumes/Data': 16777233,
  '/System/Volumes/Preboot': 16777230,
  '/System/Volumes/VM': 16777232,
  '/System/Volumes/Update': 16777231,
  '/System/Volumes/iSCPreboot': 16777222,
};

function scanFixture(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scanId: 'scan-1',
    rootPath: '/',
    status: 'complete',
    scanned: 10,
    fileCount: 8,
    dirCount: 2,
    currentPath: '/',
    startedAt: 0,
    createdAt: 0,
    cancelled: false,
    engine: 'walker',
    ...over,
  } as ScanResult;
}

/** A ScanStore stub: the statement reads exactly one number from it. */
function storeOfSize(bytes: number): ScanResult['store'] {
  return { rootId: 0, size: (id: number) => (id === 0 ? bytes : 0) } as unknown as ScanResult['store'];
}

interface SourceOverrides {
  platform?: NodeJS.Platform;
  volumes?: LogicalVolumeInfo[];
  devs?: Record<string, number>;
  /** Container used bytes; free is derived so the fixture is stated once. */
  totalBytes?: number;
  usedBytes?: number;
  snapshots?: Partial<Awaited<ReturnType<StatementSources['snapshots']>>>;
  zombies?: Partial<Awaited<ReturnType<StatementSources['zombies']>>>;
  snapshotsThrow?: string;
  zombiesThrow?: string;
}

function sourcesFixture(over: SourceOverrides = {}): StatementSources {
  const volumes = over.volumes ?? MAC_VOLUMES;
  const devs = over.devs ?? MAC_DEVS;
  const totalBytes = over.totalBytes ?? 494 * GB;
  const usedBytes = over.usedBytes ?? 188 * GB;
  const topology: VolumeTopology = { physicalDisks: [], logicalVolumes: volumes, mechanism: 'fixture' };
  return {
    platform: over.platform ?? 'darwin',
    topology: () => Promise.resolve(topology),
    statfs: () =>
      Promise.resolve({
        blocks: totalBytes / BLOCK,
        bfree: (totalBytes - usedBytes) / BLOCK,
        bavail: (totalBytes - usedBytes) / BLOCK,
        bsize: BLOCK,
      }),
    devOf: (target: string) => {
      if (target in devs) return Promise.resolve(devs[target]);
      // Anything deeper belongs to the device of its longest matching mount point.
      let best: string | null = null;
      for (const mp of Object.keys(devs)) {
        if (target === mp || target.startsWith(mp === '/' ? '/' : mp + '/')) {
          if (!best || mp.length > best.length) best = mp;
        }
      }
      return Promise.resolve(best ? devs[best] : null);
    },
    snapshots: () => {
      if (over.snapshotsThrow) return Promise.reject(new Error(over.snapshotsThrow));
      return Promise.resolve({
        available: true,
        platform: 'darwin' as NodeJS.Platform,
        snapshots: [],
        totalBytes: null,
        canPurge: false,
        ...over.snapshots,
      });
    },
    zombies: () => {
      if (over.zombiesThrow) return Promise.reject(new Error(over.zombiesThrow));
      return Promise.resolve({
        processes: [],
        totalBytes: 0,
        unknownSizeCount: 0,
        scannedAt: 0,
        ...over.zombies,
      });
    },
  };
}

const lineOf = (s: AccountingStatement, id: string): StatementLine => {
  const l = s.lines.find((x) => x.id === id);
  assert.ok(l, `the statement must always carry a "${id}" line`);
  return l;
};

/* ═══════════════════ 1. The invariant: it always balances ═══════════════════ */

test('the statement balances exactly, in whole bytes', async () => {
  const scan = scanFixture({ store: storeOfSize(167 * GB) });
  const s = await buildStatement(scan, sourcesFixture());

  const sum = s.lines.reduce((a, l) => a + (l.bytes ?? 0), 0);
  assert.equal(sum, s.volume.usedBytes, 'every line, summed, is the volume total');
  assert.doesNotThrow(() => {
    assertBalances(s);
  });
});

test('the discrepancy is exactly the unaccounted line — asserted directly', async () => {
  const scan = scanFixture({ store: storeOfSize(167 * GB) });
  const s = await buildStatement(scan, sourcesFixture());

  const withoutResidual = s.lines.filter((l) => l.id !== 'unaccounted').reduce((a, l) => a + (l.bytes ?? 0), 0);
  assert.equal(
    s.volume.usedBytes - withoutResidual,
    s.unaccountedBytes,
    'what the other lines do not explain IS the unaccounted line, to the byte',
  );
  assert.equal(lineOf(s, 'unaccounted').bytes, s.unaccountedBytes);
});

test('a statement that cannot balance is refused rather than published', () => {
  // The guard exists so a future line that forgets to join the sum fails loudly
  // instead of shipping a receipt that is wrong by exactly its own size.
  const broken: AccountingStatement = {
    scanId: 'x',
    rootPath: '/',
    volume: { mountPoint: '/', totalBytes: 100, usedBytes: 100, freeBytes: 0, mechanism: 'fixture' },
    lines: [
      { id: 'scanned', label: 'Files', bytes: 40, available: true, detail: '', count: null, notes: [], remedy: null },
      { id: 'unaccounted', label: 'Unaccounted', bytes: 20, available: true, detail: '', count: null, notes: [], remedy: null },
    ],
    unaccountedBytes: 20,
    coversWholeVolume: true,
    caveats: [],
    generatedAt: 0,
  };
  assert.throws(() => {
    assertBalances(broken);
  }, /does not balance.*off by 40/s);
});

test('the residual is stated, not clamped, when TreeMap counts more than the volume holds', async () => {
  // Copy-on-write clones make this the normal case, not a pathology: two files
  // sharing every block each report their full size. A statement that clamped
  // the residual at zero would be claiming the disk is fuller than it is.
  const scan = scanFixture({ store: storeOfSize(500 * GB) });
  const s = await buildStatement(scan, sourcesFixture({ usedBytes: 188 * GB }));

  assert.ok(s.unaccountedBytes < 0, 'over-counting produces a negative residual');
  assert.equal(lineOf(s, 'unaccounted').bytes, s.unaccountedBytes, 'and it is shown as it is');
  assertBalances(s);
});

/* ══════════════ 2. Unavailable is never zero, and says where it went ══════════════ */

test('purgeable is unavailable with a reason on every platform, and never reads zero', () => {
  for (const plat of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    const line = purgeableLine(plat);
    assert.equal(line.bytes, null, `${plat}: purgeable must be unknown, never 0`);
    assert.equal(line.available, false);
    assert.ok(line.reason && line.reason.length > 20, `${plat}: an unavailable line must say why`);
  }
  assert.match(
    purgeableLine('darwin').reason ?? '',
    /native API/,
    'the macOS reason names the actual obstacle, so the limit is checkable',
  );
});

test('no snapshots is a zero; snapshots that cannot be sized is an unknown', async () => {
  const scan = scanFixture({ store: storeOfSize(GB) });

  const none = await buildStatement(scan, sourcesFixture({ snapshots: { snapshots: [], totalBytes: null } }));
  const noneLine = lineOf(none, 'snapshots');
  assert.equal(noneLine.bytes, 0, 'the tool ran and found none — that is a measurement, so 0 is correct');
  assert.equal(noneLine.available, true);

  const some = await buildStatement(
    scan,
    sourcesFixture({
      snapshots: {
        snapshots: [
          { id: 'com.apple.TimeMachine.2026-03-18-101500.local', date: null, sizeBytes: null },
          { id: 'com.apple.TimeMachine.2026-03-19-101500.local', date: null, sizeBytes: null },
        ],
        totalBytes: null,
        canPurge: true,
      },
    }),
  );
  const someLine = lineOf(some, 'snapshots');
  assert.equal(someLine.bytes, null, 'two snapshots of unknown size must NOT collapse to 0 bytes');
  assert.equal(someLine.available, false);
  assert.equal(someLine.count, 2, 'what IS known — how many — is still reported');
  assert.match(someLine.reason ?? '', /without sizing them/);
  assert.ok(someLine.remedy, 'and the remedy is still offered, since the snapshots are real');
  assertBalances(some);
});

test('a sized snapshot total is used as the arithmetic, not thrown away', async () => {
  // The Windows path really does report a byte figure (vssadmin), so the line
  // must be able to be a number rather than being unknown by construction.
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({
      platform: 'win32',
      snapshots: { snapshots: [{ id: 'shadowstorage-0', date: null, sizeBytes: null }], totalBytes: 7 * GB, canPurge: false },
    }),
  );
  assert.equal(lineOf(s, 'snapshots').bytes, 7 * GB);
  assertBalances(s);
});

test('one source failing costs its own line and nothing else', async () => {
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(167 * GB) }),
    sourcesFixture({ snapshotsThrow: 'tmutil exploded', zombiesThrow: 'lsof is missing' }),
  );

  assert.equal(lineOf(s, 'snapshots').available, false);
  assert.match(lineOf(s, 'snapshots').reason ?? '', /tmutil exploded/, 'the real error is shown, not a paraphrase');
  assert.equal(lineOf(s, 'openHandles').available, false);
  assert.match(lineOf(s, 'openHandles').reason ?? '', /lsof is missing/);

  // The other six lines survived, and the page still adds up.
  assert.equal(lineOf(s, 'scanned').bytes, 167 * GB);
  assert.equal(lineOf(s, 'otherVolumes').available, true);
  assertBalances(s);
});

test('every unavailable line is named inside the unaccounted line', async () => {
  // Otherwise the residual reads as a mystery when in fact TreeMap knows
  // exactly which unmeasured things are sitting in it.
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({ snapshotsThrow: 'tmutil exploded' }),
  );
  const residual = lineOf(s, 'unaccounted');
  for (const line of s.lines) {
    if (line.bytes !== null || line.id === 'unaccounted') continue;
    assert.ok(
      residual.detail.includes(line.label),
      `"${line.label}" has unknown bytes, so the unaccounted line must say it is in there`,
    );
  }
  assert.match(residual.detail, /clones/, 'and the one limitation with no line of its own is named too');
});

test('an unavailable line contributes nothing to the sum — it does not count as zero twice', async () => {
  const withSnapshots = await buildStatement(
    scanFixture({ store: storeOfSize(100 * GB) }),
    sourcesFixture({ snapshots: { snapshots: [{ id: 'a', date: null, sizeBytes: null }], totalBytes: null } }),
  );
  const withoutSnapshots = await buildStatement(
    scanFixture({ store: storeOfSize(100 * GB) }),
    sourcesFixture({ snapshots: { snapshots: [], totalBytes: null } }),
  );
  // Both balance, and the unknown case pushes its bytes into the residual
  // rather than silently asserting the snapshots hold nothing.
  assertBalances(withSnapshots);
  assertBalances(withoutSnapshots);
  assert.equal(
    withSnapshots.unaccountedBytes,
    withoutSnapshots.unaccountedBytes,
    'an unknown line and a zero line both add 0 to the sum — the difference is what the page SAYS',
  );
  assert.equal(lineOf(withSnapshots, 'snapshots').bytes, null);
  assert.equal(lineOf(withoutSnapshots, 'snapshots').bytes, 0);
});

/* ═══════════════ 3. Which volume the scan is on — the firmlink trap ═══════════════ */

test('a home-folder path resolves to its real volume, not the one its path starts with', async () => {
  // `/Users` is a firmlink onto the data volume: by prefix, `/Users/me` is under
  // `/`; by device, it is the same filesystem as /System/Volumes/Data. Getting
  // this wrong attributes a 163 GB scan to a 12 GB sealed volume and books the
  // data volume as somebody else's — an error the size of the disk.
  const src = sourcesFixture();
  const resolved = await resolveScanVolume(MAC_VOLUMES, '/Users/me/Desktop', src.devOf);
  assert.ok(resolved);
  assert.deepEqual(
    resolved.onSameDevice.map((v) => v.id).sort(),
    ['disk3s1s1', 'disk3s5'],
    'the firmlinked pair is one device, and both halves are the scan’s own volume',
  );
  assert.equal(resolved.primary.mountPoint, '/', 'the outermost mount point is the one a user recognises');
});

test('the firmlinked twin is never billed as another volume', async () => {
  const s = await buildStatement(scanFixture({ rootPath: '/', store: storeOfSize(175 * GB) }), sourcesFixture());
  const other = lineOf(s, 'otherVolumes');
  // Preboot 9 + VM 2 + Update 0 + unmounted 1 = 12 GB. The 163 GB data volume
  // is the scan's own and must not appear here.
  assert.equal(other.bytes, 12 * GB, 'only the true siblings, and the data volume is not one of them');
  assert.ok(
    !other.notes.some((n) => n.includes('Data')),
    'the data volume must not be listed as another volume',
  );
});

test('a different container on the same physical disk is not a sibling', async () => {
  const mine = MAC_VOLUMES.find((v) => v.id === 'disk3s1s1');
  assert.ok(mine);
  const siblings = containerSiblings(MAC_VOLUMES, mine, 'darwin').map((v) => v.id);
  assert.ok(!siblings.includes('disk1s1'), 'disk1s1 shares the SSD but not the storage pool');
  assert.deepEqual(siblings.sort(), ['disk3s2', 'disk3s3', 'disk3s4', 'disk3s5', 'disk3s6']);
});

test('off APFS there are no siblings, because statfs reported only this filesystem', async () => {
  // Adding another filesystem's usage to an ext4/NTFS total would add bytes the
  // total never contained, and the statement would fail to balance by that much.
  const mine = MAC_VOLUMES[0];
  assert.deepEqual(containerSiblings(MAC_VOLUMES, mine, 'linux'), []);
  assert.deepEqual(containerSiblings(MAC_VOLUMES, mine, 'win32'), []);

  const s = await buildStatement(
    scanFixture({ store: storeOfSize(50 * GB) }),
    sourcesFixture({ platform: 'linux', usedBytes: 60 * GB }),
  );
  assert.equal(lineOf(s, 'otherVolumes').bytes, 0);
  assertBalances(s);
});

test('when the device cannot be read, the longest matching mount point is the fallback', async () => {
  const resolved = await resolveScanVolume(MAC_VOLUMES, '/System/Volumes/VM/sleepimage', () => Promise.resolve(null));
  assert.ok(resolved);
  assert.equal(resolved.primary.id, 'disk3s6', 'the deepest containing mount point wins');
  assert.equal(volumeForPath(MAC_VOLUMES, '/System/Volumes/VM/x')?.id, 'disk3s6');
});

test('mount-point matching reads the separator off the path, not off the host', async () => {
  // The bug this closes broke the WINDOWS job and nothing else: `isUnder` used
  // `path.sep`, so on a Windows host every one of these macOS-shaped fixtures
  // matched no mount point at all and `resolveScanVolume` returned null. A
  // pure function's answer must not depend on which machine is asking.
  //
  // It is not only a test-fixture problem. A `cloud://` scan root has forward
  // slashes whatever the OS is, so a Windows host really does handle
  // POSIX-shaped paths.
  const posix = await resolveScanVolume(MAC_VOLUMES, '/System/Volumes/VM/sleepimage', () => Promise.resolve(null));
  assert.ok(posix, 'a POSIX path resolves on every platform, including Windows');
  assert.equal(posix.primary.id, 'disk3s6');

  // And the Windows shape resolves everywhere too, including on this Mac.
  const winVolumes: LogicalVolumeInfo[] = [
    vol({ id: 'C', name: 'System', mountPoint: 'C:\\', filesystem: 'ntfs', kind: 'partition', usedBytes: 80 * GB }),
    vol({ id: 'D', name: 'Data', mountPoint: 'D:\\', filesystem: 'ntfs', kind: 'partition', usedBytes: 20 * GB }),
  ];
  assert.equal(volumeForPath(winVolumes, 'C:\\Users\\me\\Downloads')?.id, 'C');
  assert.equal(volumeForPath(winVolumes, 'D:\\media')?.id, 'D');
  assert.equal(volumeForPath(winVolumes, 'E:\\elsewhere'), null, 'an unknown drive matches nothing');

  const unc: LogicalVolumeInfo[] = [vol({ id: 'share', mountPoint: '\\\\server\\share', kind: 'partition' })];
  assert.equal(volumeForPath(unc, '\\\\server\\share\\folder\\file.txt')?.id, 'share', 'UNC paths resolve too');
});

test('a backslash inside a POSIX filename is not read as a folder boundary', () => {
  // Being lenient — treating both separators as boundaries everywhere — would
  // be the obvious "fix" and it is wrong: `\` is a legal character in a POSIX
  // filename, so a file literally named `a\b` would be reported as living
  // inside a folder called `a` that does not exist.
  const volumes: LogicalVolumeInfo[] = [
    vol({ id: 'root', mountPoint: '/' }),
    vol({ id: 'weird', mountPoint: '/x/a' }),
  ];
  assert.equal(volumeForPath(volumes, '/x/a\\b')?.id, 'root', 'the file is on /, not under /x/a');
  assert.equal(volumeForPath(volumes, '/x/a/b')?.id, 'weird', 'a real child still resolves');
});

test('a sibling directory with a shared prefix is not treated as a parent', () => {
  // `/Volumes/Disk2` must not be read as living under `/Volumes/Disk`.
  const volumes: LogicalVolumeInfo[] = [
    vol({ id: 'root', mountPoint: '/' }),
    vol({ id: 'disk', mountPoint: '/Volumes/Disk' }),
  ];
  assert.equal(volumeForPath(volumes, '/Volumes/Disk2/file')?.id, 'root');
  assert.equal(volumeForPath(volumes, '/Volumes/Disk/file')?.id, 'disk');
  assert.equal(volumeForPath(volumes, '/Volumes/Disk')?.id, 'disk', 'the mount point itself is on itself');
});

test('a path on no known volume is an error, not a statement against nothing', async () => {
  await assert.rejects(
    () => buildStatement(scanFixture({ rootPath: '/nowhere' }), sourcesFixture({ volumes: [], devs: {} })),
    /no mounted volume contains/,
  );
});

/* ═══════════════════ 4. Whole-volume vs a folder inside it ═══════════════════ */

test('scanning a folder says so, and puts the rest of the volume in the residual', async () => {
  const s = await buildStatement(
    scanFixture({ rootPath: '/Users/me/Downloads', store: storeOfSize(2 * GB) }),
    sourcesFixture(),
  );
  assert.equal(s.coversWholeVolume, false);
  assert.ok(s.caveats.some((c) => c.includes('/Users/me/Downloads')), 'the limitation leads, rather than hiding');
  assert.match(lineOf(s, 'unaccounted').detail, /everything on \/ outside \/Users\/me\/Downloads/);
  assert.ok(lineOf(s, 'scanned').remedy, 'and the fix — scan the whole volume — is offered');
  assertBalances(s);
});

test('scanning the volume root claims the whole volume, and offers no such remedy', async () => {
  const s = await buildStatement(scanFixture({ rootPath: '/', store: storeOfSize(175 * GB) }), sourcesFixture());
  assert.equal(s.coversWholeVolume, true);
  assert.deepEqual(s.caveats, []);
  assert.equal(lineOf(s, 'scanned').remedy, null);
});

/* ═══════════════════ 5. What the scan was refused ═══════════════════ */

test('the walker counts refusals exactly; a refusal has a count but never bytes', async () => {
  const s = await buildStatement(
    scanFixture({ engine: 'walker', deniedDirs: 12, deniedEntries: 5, unreadableDirs: 2, store: storeOfSize(GB) }),
    sourcesFixture(),
  );
  const line = lineOf(s, 'unscannable');
  assert.equal(line.count, 19, '12 + 5 denied, plus 2 unreadable');
  assert.equal(line.bytes, null, 'something that will not open cannot be sized — this is never a byte figure');
  assert.equal(line.available, false);
  assert.ok(line.notes.some((n) => n.includes('Full Disk Access')), 'the refusals name their usual fix');
  assertBalances(s);
});

test('nothing refused is a real zero when the engine can actually tell', async () => {
  const s = await buildStatement(scanFixture({ engine: 'turbo-walker', store: storeOfSize(GB) }), sourcesFixture());
  const line = lineOf(s, 'unscannable');
  assert.equal(line.bytes, 0);
  assert.equal(line.available, true);
  assert.equal(line.count, 0);
});

test('an engine that cannot see refusals reports unknown, not zero', async () => {
  // Measured: `gdu -o-` emits a mode-000 directory as an ordinary EMPTY
  // directory and exits 0. Reporting "0 refused" from that would be a
  // confidently wrong answer, which is the one thing this view must never be.
  const s = await buildStatement(scanFixture({ engine: 'gdu-turbo', store: storeOfSize(GB) }), sourcesFixture());
  const line = lineOf(s, 'unscannable');
  assert.equal(line.bytes, null);
  assert.equal(line.count, null, 'not 0 — the count itself is unknown');
  assert.equal(line.available, false);
  assert.match(line.reason ?? '', /gdu-turbo engine/);
  assert.match(lineOf(s, 'unaccounted').detail, /Refused to the scan/, 'and it is named in the residual');
});

/* ═══════════════════ 6. Corrections that are already applied ═══════════════════ */

test('hard links are reported as a note, not subtracted a second time', async () => {
  // The walker zeroes every name after the first, so the tree total ALREADY
  // counts each inode once. An arithmetic line here would remove them twice.
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(100 * GB), hardlinkedBytes: 4 * GB, hardlinkedFiles: 900 }),
    sourcesFixture(),
  );
  const scanned = lineOf(s, 'scanned');
  assert.equal(scanned.bytes, 100 * GB, 'the scanned line is the tree total, unmodified');
  assert.ok(scanned.notes.some((n) => n.includes('more than one name')), 'and the fact is stated');
  assert.ok(scanned.notes.some((n) => n.includes('clone')), 'as is the clone limitation §5.2 requires');
  assertBalances(s);
});

test('cloud placeholders are taken back off, because they were counted and are not there', async () => {
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(100 * GB), cloudBytes: 30 * GB, cloudFiles: 400 }),
    sourcesFixture(),
  );
  assert.equal(lineOf(s, 'cloudPlaceholders').bytes, -30 * GB, 'a correction, and a negative one');
  assert.equal(lineOf(s, 'cloudPlaceholders').count, 400);
  assertBalances(s);
});

/* ═══════════════════ 7. Open handles ═══════════════════ */

test('held space is a floor when some held files cannot be sized, and says so', async () => {
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({
      zombies: {
        processes: [{ pid: 42, processName: 'Docker', bytes: 3 * GB, appBundle: null, handles: [] }] as never,
        totalBytes: 3 * GB,
        unknownSizeCount: 7,
      },
    }),
  );
  const line = lineOf(s, 'openHandles');
  assert.equal(line.bytes, 3 * GB);
  assert.ok(line.notes.some((n) => n.includes('floor')), 'a partial total states that it is partial');
  assert.ok(line.remedy, 'and the remedy exists');
  assert.match(line.remedy?.caveat ?? '', /force-killed/, 'with the existing refusal rails stated up front');
  assertBalances(s);
});

test('nothing holding anything is a zero, with no remedy offered', async () => {
  const s = await buildStatement(scanFixture({ store: storeOfSize(GB) }), sourcesFixture());
  const line = lineOf(s, 'openHandles');
  assert.equal(line.bytes, 0);
  assert.equal(line.remedy, null, 'there is nothing to act on, so no button is offered');
});

/* ═══════ 8. The route turns an unreadable layout into an honest state ═══════ */

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

function get(port: number, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf) as unknown; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as Record<string, unknown> });
        });
      })
      .on('error', reject);
  });
}

test('a layout that will not read is 409 with its reason, never a 500', async () => {
  // `volumeTopology()` throws rather than hand back an answer that cannot be
  // true — deliberately, because an empty topology returned as a success would
  // be a zero. But a throw is only the honest OUTCOME; a 500 is not the honest
  // PRESENTATION of it. §10 asks for an unavailable state carrying its reason,
  // which is what the tab already knows how to render, so the route must turn
  // one into the other. This is that contract, not a mock of it: the real route
  // runs against a real scan, and only the disk-layout read is made to fail.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'treemap-mg-'));
  await fs.promises.writeFile(path.join(dir, 'a.txt'), 'hello');
  const srv = await listen();
  const provider = platform() as unknown as { getVolumeTopology: () => Promise<VolumeTopology> };
  const real = provider.getVolumeTopology.bind(provider);
  try {
    const scan = await startScan(dir);
    // Bounded: an unbounded poll on a scan that never settles hangs the whole
    // CI job instead of failing one test, and a hung job reports nothing.
    const t0 = Date.now();
    while (scan.status === 'running') {
      assert.ok(Date.now() - t0 < 30_000, 'the fixture scan never settled — timed out after 30s');
      await new Promise((r) => setTimeout(r, 50));
    }

    provider.getVolumeTopology = () =>
      Promise.reject(new Error('diskutil reported no disks at all after 3 attempts, which cannot be true on a running system'));

    const res = await get(srv.port, `/api/missing-gigabytes?scanId=${scan.scanId}`);
    assert.equal(res.status, 409, 'an unreadable layout is a feature that is unavailable, not a server fault');
    assert.equal(res.body.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(
      String(res.body.error),
      /cannot be true on a running system/,
      "and the reader's own words survive to the UI, rather than being replaced by a generic message",
    );

    // Restored, the same request answers — so the 409 was about the layout and
    // nothing else, and the failure is not sticky.
    provider.getVolumeTopology = real;
    const ok = await get(srv.port, `/api/missing-gigabytes?scanId=${scan.scanId}`);
    assert.equal(ok.status, 200);
    const lines = ok.body.lines as { bytes: number | null }[];
    const volume = ok.body.volume as { usedBytes: number };
    assert.equal(
      lines.reduce((a, l) => a + (l.bytes ?? 0), 0),
      volume.usedBytes,
      'and the statement it serves balances on this real machine, not just on fixtures',
    );
  } finally {
    provider.getVolumeTopology = real;
    await srv.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
