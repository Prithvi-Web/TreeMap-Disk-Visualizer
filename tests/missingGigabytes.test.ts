import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-missingGigabytes-data-');

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
import { mapLsblk } from '../src/platform/linux/topology';
import type { ScanResult } from '../src/models/types';
import { groupZombies, RESTART_REFUSES } from '../src/services/zombieHandles';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { boundaryRecord, readMountTable, setBoundaryDepsForTests, type MountTable } from '../src/utils/mountBoundaries';
import { formatBytes } from '../src/utils/formatBytes';
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
        fileCount: 0,
        sharedFileCount: 0,
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
    volume: {
      mountPoint: '/', totalBytes: 100, usedBytes: 100, freeBytes: 0, mechanism: 'fixture',
      mechanismLabel: 'what the operating system reports for this disk', reservedBytes: 0,
    },
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

test('the scanned line explains shared-storage copies in plain words, not developer terms (B19)', async () => {
  const s = await buildStatement(scanFixture({ store: storeOfSize(5 * GB) }), sourcesFixture({ usedBytes: 9 * GB }));
  const notes = lineOf(s, 'scanned').notes;
  const clone = notes.find((n) => /share their storage/.test(n));
  assert.ok(clone, `the scanned line still says such copies are counted in full: ${JSON.stringify(notes)}`);
  assert.match(clone, /Unaccounted/, 'and where the difference goes');
  for (const n of notes) {
    assert.doesNotMatch(
      n,
      /\bAPI\b|\bNode\b|native scan core|inode|copy-on-write|clone identity|APFS/i,
      `no developer terms on a page a person reads: ${n}`,
    );
  }
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
    /Apple.s own programming interface/,
    'the macOS reason names the actual obstacle, so the limit is checkable',
  );
  // QA D41: the page is read by people, so the obstacle is named in plain words.
  for (const plat of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    assert.doesNotMatch(
      purgeableLine(plat).reason ?? '',
      /NSURL|statfs|diskutil|system_profiler|\bAPI\b/,
      `${plat}: no developer names on a page a person reads`,
    );
  }
});

test('the Missing GB page names its source in plain words and labels the scanned folder as one (QA D41)', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = index.indexOf('const MG_SEG = {');
  const end = index.indexOf('/* Segment → its row.', start);
  assert.ok(start > 0 && end > start, 'the Missing GB renderer is in the built page');
  type El = { textContent: string; innerHTML: string; classList: { add(): void; remove(): void } };
  const els: Record<string, El> = {};
  const stubs: Record<string, unknown> = {
    $: (id: string): El => (els[id] ||= { textContent: '', innerHTML: '', classList: { add() {}, remove() {} } }),
    state: {}, api: async () => null, skeletonRows: () => '',
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${String(n)} B`, formatCount: (n: number) => String(n),
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const show = new Function(...keys, `${index.slice(start, end)}; return (d) => { missingData = d; renderMissing(); };`)(
    ...keys.map((k) => stubs[k]),
  ) as (d: unknown) => void;
  show({
    scanId: 's', rootPath: '/System/Library',
    volume: {
      mountPoint: '/', totalBytes: 100, usedBytes: 60, freeBytes: 40, reservedBytes: 0,
      mechanism: 'statfs(/) — the shared pool this volume draws from', mechanismLabel: 'what macOS reports for Macintosh HD',
    },
    lines: [{ id: 'scanned', label: 'Scanned', bytes: 60, available: true, detail: 'd', count: null, notes: [], remedy: null }],
    unaccountedBytes: 0, coversWholeVolume: false, caveats: [], generatedAt: 0,
  });
  assert.match(els.missingInfo.textContent, /what macOS reports for Macintosh HD/, 'the source is named in the user’s words');
  assert.doesNotMatch(els.missingInfo.textContent, /statfs/, 'not by the call that read it');
  assert.match(els.missingBody.innerHTML, /Scanned: \/System\/Library/, 'the scanned folder is labelled as the scanned folder');
  assert.doesNotMatch(
    els.missingBody.innerHTML,
    /This disk<\/span><span class="mg-mp">\/System\/Library/,
    'not set beside "This disk" as if it were the disk’s name',
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

test('a scan on a filesystem made directly on the whole disk resolves to that disk, and the statement balances', async () => {
  // Recorded on a Linux cloud container (see tests/platformCrossOs.test.ts for
  // the fixture's provenance): `/` is ext4 on the bare /dev/vda, no partition
  // table. Before the whole-disk rule, the topology held no volume at all and
  // every scan there was "no mounted volume contains …".
  const doc = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'lsblk-v2.39.3-whole-disk.json'), 'utf8'),
  ) as Parameters<typeof mapLsblk>[0];
  const volumes = mapLsblk(doc).logicalVolumes;
  // The device id as the kernel numbers it: vda is 254:0.
  const devs: Record<string, number> = { '/': 65024 };
  const src = sourcesFixture({ platform: 'linux', volumes, devs, totalBytes: 270_553_174_016, usedBytes: 12_534_636_544 });

  const resolved = await resolveScanVolume(volumes, '/home/user/project', src.devOf);
  assert.ok(resolved, 'a path under / must resolve to the whole-disk volume mounted there');
  assert.equal(resolved.primary.id, '/dev/vda', 'the disk itself is the volume');
  assert.equal(resolved.primary.mountPoint, '/', 'mounted at /');
  assert.deepEqual(resolved.onSameDevice.map((v) => v.id), ['/dev/vda'], 'and nothing else shares its device');

  const s = await buildStatement(scanFixture({ rootPath: '/home/user/project', store: storeOfSize(GB) }), src);
  assert.equal(s.volume.mountPoint, '/', 'the statement is drawn up against /');
  assertBalances(s);
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
  assert.match(line.reason ?? '', /^This scan was produced by the gdu engine, which reports a folder it was refused as an ordinary empty folder/);
  assert.doesNotMatch(line.reason ?? '', /gdu-turbo/, 'the engine is named as Settings names it, not by its id');
  assert.deepEqual(
    line.notes,
    ['A scan by the native engine or the built-in walker counts these exactly: choose Built-in walker in Settings › Scan engine and scan again, at some cost in speed.'],
    'the control a person has is the Scan engine setting — not an environment variable the desktop app cannot take',
  );
  assert.match(lineOf(s, 'unaccounted').detail, /Refused to the scan/, 'and it is named in the residual');
});

test('the native engine and the NTFS turbo mode count refusals exactly, as the walker does', async () => {
  // Both fill the counters from a walk's own refusal table (ingestColumns in
  // nativeEngine.ts), and the equivalence gate holds the native engine's
  // counters equal to the walker's. The statement once said of the default
  // engine that its refusals "cannot be known" and sent the user to
  // TREEMAP_NO_GDU=1 for a count the scan already had (the pre-landing review
  // of 23 Sep 2026).
  for (const engine of ['native', 'ntfs-mft'] as const) {
    const s = await buildStatement(
      scanFixture({ engine, deniedDirs: 12, deniedEntries: 5, unreadableDirs: 2, store: storeOfSize(GB) }),
      sourcesFixture(),
    );
    const line = lineOf(s, 'unscannable');
    assert.equal(line.count, 19, `${engine}: 12 + 5 denied, plus 2 unreadable`);
    assert.equal(line.bytes, null, engine);
    assert.doesNotMatch(line.reason ?? '', /cannot be known/, engine);
    const none = lineOf(await buildStatement(scanFixture({ engine, store: storeOfSize(GB) }), sourcesFixture()), 'unscannable');
    assert.equal(none.count, 0, `${engine}: nothing refused is a real zero`);
    assert.equal(none.available, true, engine);
  }
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

test('held space counts each held file once and names how many programs hold them (QA D17, D41)', async () => {
  // One deleted 1 GB file held by three programs is 1 GB held, not 3 GB: the line used
  // to sum per program, and because the statement balances, Unaccounted shrank to match.
  const shared = { path: '/private/var/db/cache', ino: 9, bytes: GB };
  const report = groupZombies([
    { pid: 1001, processName: 'logd', ...shared },
    { pid: 1002, processName: 'Finder', ...shared },
    { pid: 1003, processName: 'Dock', ...shared },
  ]);
  const s = await buildStatement(scanFixture({ store: storeOfSize(GB) }), sourcesFixture({ zombies: { ...report, scannedAt: 0 } }));
  const line = lineOf(s, 'openHandles');
  assert.equal(line.bytes, GB, 'the file once, not once per program holding it');
  assert.equal(line.count, 1, 'the count is of held files, which the page calls items, not of programs');
  assert.ok(line.notes.some((n) => /3 programs/.test(n)), `how many programs hold them is stated (notes: ${line.notes.join(' | ')})`);
  assert.ok(line.notes.some((n) => /counted once/.test(n)), 'and that a shared file is counted once');
  assertBalances(s);
  // QA D40: the remedy's safety claim is the restart code's own sentence, so the two cannot drift.
  assert.ok(line.remedy?.caveat.includes(RESTART_REFUSES), `the caveat quotes what restart refuses (got: ${line.remedy?.caveat ?? ''})`);
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
    // Bounded by the hang guard: an unbounded poll on a scan that never
    // settles hangs the whole CI job instead of failing one test.
    await waitFor(() => scan.status !== 'running', 'the fixture scan settling', 50);

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

/* ═══════════════════ 9. Windows says so in Windows words (issue #33) ═══════════════════ */

test('a snapshot size the platform withholds is explained in the platform’s own words, not tmutil’s', async () => {
  const s = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({
      platform: 'win32',
      snapshots: {
        platform: 'win32',
        snapshots: [{ id: '{A}', date: null, sizeBytes: null }],
        totalBytes: null,
        canPurge: false,
        sizeReason: 'Windows reports the space its restore points hold only to an administrator.',
      },
    }),
  );
  const line = lineOf(s, 'snapshots');
  assert.equal(line.available, false);
  assert.equal(line.bytes, null);
  assert.equal(line.count, 1);
  assert.equal(line.reason, 'Windows reports the space its restore points hold only to an administrator.', 'the source’s reason is shown verbatim');
  assert.doesNotMatch(line.detail, /Time Machine/);
  assertBalances(s);
});

test('no restore points on a PC is said as restore points, not as "local snapshots"', async () => {
  const s = await buildStatement(scanFixture({ store: storeOfSize(GB) }), sourcesFixture({ platform: 'win32', snapshots: { platform: 'win32', snapshots: [], totalBytes: 0 } }));
  const line = lineOf(s, 'snapshots');
  assert.equal(line.bytes, 0);
  assert.match(line.detail, /restore points/);
  assert.doesNotMatch(line.detail, /local snapshots/);
  const mac = await buildStatement(scanFixture({ store: storeOfSize(GB) }), sourcesFixture({ snapshots: { snapshots: [], totalBytes: null } }));
  assert.match(lineOf(mac, 'snapshots').detail, /local snapshots/, 'macOS keeps its own word');
});

test('a refusal names the fix for the platform it happened on', async () => {
  const scan = scanFixture({ engine: 'walker', deniedDirs: 3, store: storeOfSize(GB) });
  const win = lineOf(await buildStatement(scan, sourcesFixture({ platform: 'win32' })), 'unscannable');
  assert.ok(win.notes.some((n) => /administrator/i.test(n)), 'Windows: run as administrator');
  assert.ok(win.notes.some((n) => /system tray/i.test(n)), 'and quit the copy in the tray first, or the elevated one exits at once');
  assert.ok(!win.notes.some((n) => /Full Disk Access/.test(n)), 'Full Disk Access is a macOS setting');
  const linux = lineOf(await buildStatement(scan, sourcesFixture({ platform: 'linux' })), 'unscannable');
  assert.ok(!linux.notes.some((n) => /Full Disk Access|administrator/i.test(n)));
  assert.ok(linux.notes.some((n) => /permission/.test(n)), 'Linux still explains what refused');
  const mac = lineOf(await buildStatement(scan, sourcesFixture()), 'unscannable');
  assert.ok(mac.notes.some((n) => /Full Disk Access/.test(n)), 'macOS unchanged');
  assert.ok(!mac.notes.some((n) => /administrator/i.test(n)));
});

test('a measured figure is kept even when no restore point is listed; a doubtful empty listing is an unknown, not a zero', async () => {
  const kept = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({ platform: 'win32', snapshots: { platform: 'win32', snapshots: [], totalBytes: 9 * GB, scope: 'volume' } }),
  );
  const keptLine = lineOf(kept, 'snapshots');
  assert.equal(keptLine.bytes, 9 * GB, 'storage in use with nothing listed is still storage in use');
  assert.equal(keptLine.available, true);
  assert.match(keptLine.detail, /holds this much/);
  assertBalances(kept);

  const doubtful = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({ platform: 'win32', snapshots: { platform: 'win32', snapshots: [], totalBytes: null, sizeReason: 'Windows reported none, but only an administrator is shown everything.' } }),
  );
  const doubtfulLine = lineOf(doubtful, 'snapshots');
  assert.equal(doubtfulLine.bytes, null, 'a listing that doubts itself is not a zero');
  assert.equal(doubtfulLine.available, false);
  assert.equal(doubtfulLine.reason, 'Windows reported none, but only an administrator is shown everything.');
  assertBalances(doubtful);
});

test('a PC-wide figure says so when Windows could not tell which drive each restore point belongs to', async () => {
  const wide = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({ platform: 'win32', snapshots: { platform: 'win32', snapshots: [{ id: '{A}', date: null, sizeBytes: null }], totalBytes: 2 * GB, scope: 'machine' } }),
  );
  const line = lineOf(wide, 'snapshots');
  assert.equal(line.bytes, 2 * GB);
  assert.equal(line.label, 'Restore points', 'the Windows word, as a label');
  assert.ok(line.notes.some((n) => /every drive of this PC/.test(n)), line.notes.join(' | '));
  const scoped = await buildStatement(
    scanFixture({ store: storeOfSize(GB) }),
    sourcesFixture({ platform: 'win32', snapshots: { platform: 'win32', snapshots: [{ id: '{A}', date: null, sizeBytes: null }], totalBytes: 2 * GB, scope: 'volume' } }),
  );
  assert.deepEqual(lineOf(scoped, 'snapshots').notes, [], 'scoped to the drive: nothing to warn about');
  assert.match(lineOf(scoped, 'snapshots').detail, /1 restore point holds space no folder scan can see/);
});

/* ═══════════ Track U, U-28: drives mounted inside the scanned folder ═══════════ */

const NO_TABLE = process.platform === 'win32' ? 'Windows keeps no mount table, so no scan there has a drive inside it to stop at' : null;

/**
 * A real walk of root/{here.txt, mnt-a/{a.bin, thin.img}, mnt-b/b.bin}, the
 * mount table naming mnt-a and mnt-b; thin.img is sparse (64 MiB claimed,
 * nothing written), so its logical size is far from what it holds.
 */
async function mountedScan(rule: 'stay' | 'cross'): Promise<{ scan: ScanResult; root: string; logicalInside: number }> {
  const root = fs.realpathSync(fileTempDir('treemap-mg-mounted-'));
  const a = path.join(root, 'mnt-a');
  const b = path.join(root, 'mnt-b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(root, 'here.txt'), 'h'.repeat(1000));
  fs.writeFileSync(path.join(a, 'a.bin'), 'a'.repeat(3000));
  fs.writeFileSync(path.join(a, 'thin.img'), '');
  fs.truncateSync(path.join(a, 'thin.img'), 64 * 1024 * 1024);
  fs.writeFileSync(path.join(b, 'b.bin'), 'b'.repeat(5000));
  const table: MountTable = { source: 'mount', entries: [a, b].map((m) => ({ mountPoint: m, filesystem: 'apfs', options: ['apfs'], source: '/dev/disk99s1' })), reason: null };
  setBoundaryDepsForTests({ readTable: async () => table, aliases: async () => () => [] });
  try {
    await updateSettings({ scanBoundary: rule, engine: 'walker' });
    const scan = await startScan(root);
    await waitFor(() => scan.status !== 'running', `the scan of ${root} settling`);
    assert.equal(scan.status, 'complete', scan.error);
    return { scan, root, logicalInside: 3000 + 64 * 1024 * 1024 + 5000 };
  } finally {
    setBoundaryDepsForTests(null);
    await updateSettings({ scanBoundary: 'stay' });
  }
}

test('stay: the drives mounted inside are a measured zero, with their count — none of their files was counted', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { scan, root } = await mountedScan('stay');
  const s = await buildStatement(scan, sourcesFixture());
  const line = lineOf(s, 'mountedInside');
  assert.equal(line.bytes, 0, 'a measurement: nothing on another disk is in the scanned line');
  assert.equal(line.available, true);
  assert.equal(line.count, 2);
  assert.equal(line.label, 'Drives mounted inside the scanned folder');
  assert.equal(line.detail, `2 separate drives are mounted inside ${root}; by the mount table the scan did not enter them, so none of their files are counted above.`);
  assertBalances(s);
});

test('cross: unknown, never a subtraction — the logical total is stated, the allocated share is already in the sparse-file line', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { scan, root, logicalInside } = await mountedScan('cross');
  const s = await buildStatement(scan, sourcesFixture());
  const line = lineOf(s, 'mountedInside');
  assert.equal(line.bytes, null, 'never the logical total taken back off: the sparse image inside was already netted by its own line');
  assert.equal(line.available, false);
  assert.equal(line.count, 2);
  assert.equal(line.reason, `The scan counted ${formatBytes(logicalInside)} inside drives mounted in this folder; their allocated share is already inside the sparse-file line and is not tracked per drive, so TreeMap cannot say how much to take back off.`);
  assert.ok(line.detail.includes(formatBytes(logicalInside)) && line.detail.includes(root), 'the logical total and the folder are in the detail');
  assert.ok(lineOf(s, 'sparseFiles').bytes! < 0, 'the sparse image inside the drive is in the sparse-file line');
  assert.ok(lineOf(s, 'unaccounted').detail.includes(line.label), 'an unknown line is named in the residual');
  assertBalances(s);
});

test('a crossing the mount table did not list makes the line unknown, naming the folder', async (t) => {
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { scan } = await mountedScan('stay');
  scan.boundary!.walk.crossedUnlisted = { count: 1, examples: ['/odd/btrfs-subvolume'] };
  const s = await buildStatement(scan, sourcesFixture());
  const line = lineOf(s, 'mountedInside');
  assert.equal(line.bytes, null);
  assert.match(line.reason ?? '', /1 folder on another device that the mount table does not list \(\/odd\/btrfs-subvolume\)/);
  assert.ok(lineOf(s, 'unaccounted').detail.includes(line.label));
  assertBalances(s);
});

test('no boundary on the record, or a table that could not be read: unknown with the reason, named in the residual', async (t) => {
  const old = await buildStatement(scanFixture({ store: storeOfSize(GB) }), sourcesFixture());
  const none = lineOf(old, 'mountedInside');
  assert.equal(none.bytes, null);
  assert.match(none.reason ?? '', /mount table/);
  assert.ok(lineOf(old, 'unaccounted').detail.includes(none.label));
  assertBalances(old);
  if (NO_TABLE) return t.skip(NO_TABLE);
  const { scan } = await mountedScan('stay');
  scan.boundary = { ...scan.boundary!, mounts: null, reason: '/sbin/mount did not answer within 5 s', neverDescend: scan.boundary!.fixed };
  const s = await buildStatement(scan, sourcesFixture());
  const line = lineOf(s, 'mountedInside');
  assert.equal(line.bytes, null);
  assert.match(line.reason ?? '', /\/sbin\/mount did not answer within 5 s/);
  assertBalances(s);
});

test('Windows: no mount table is read, so the line says why there is nothing to count rather than "no drive is mounted" (TS review R11)', async () => {
  // What a scan on Windows records: the table it read is Windows' own sentence, with no entries.
  const table = await readMountTable('win32');
  assert.ok(table.reason, 'Windows says why it has no table');
  const scan = scanFixture({ store: storeOfSize(GB) });
  scan.boundary = boundaryRecord({ rule: 'stay', source: table.source, reason: table.reason, mounts: [], fixed: [], neverDescend: [] });
  const s = await buildStatement(scan, sourcesFixture());
  const line = lineOf(s, 'mountedInside');
  assert.equal(line.bytes, 0, 'the engines do not follow a folder-mounted volume there, so nothing on another disk is counted');
  assert.equal(line.available, true);
  assert.equal(line.count, null, 'how many drives are mounted in folders is not known: no table was read');
  assert.ok(line.detail.includes(table.reason!), `the detail is Windows' own sentence: ${line.detail}`);
  assert.doesNotMatch(line.detail, /No drive is mounted inside/, 'nothing was read that could say so');
  assertBalances(s);
});
