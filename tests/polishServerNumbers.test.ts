import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-polish-numbers-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { formatBytes } from '../src/utils/formatBytes';
import { formatBytesPlain } from '../src/services/facts/reclaimScoreProvider';
import { buildStatement, assertBalances, StatementSources } from '../src/services/missingGigabytes';
import { diskUsage } from '../src/services/diskUsage';
import { getDuplicateJob } from '../src/services/duplicateFinder';
import { startScan, getScan } from '../src/services/diskScanner';
import { cloudProviderFor } from '../src/services/cloudFolders';
import type { LogicalVolumeInfo, VolumeTopology } from '../src/platform/types';
import type { ScanResult } from '../src/models/types';

/**
 * Numbers the user reads must be numbers a unit system can produce, and the
 * same bytes must print the same way everywhere.
 */

/* ───────────────────────────── formatBytes ───────────────────────────── */

test('formatBytes counts in decimal units, as Finder does: 1 KB = 1,000 B, 1 MB = 1,000,000 B, 1 GB = 1,000,000,000 B (QA D09)', () => {
  // The owner's answer (5 Oct 2026, "Match Finder"). The query grammar was
  // already decimal, so a 700,000,000-byte file used to read "667.6 MB" and
  // still match `size>680mb`.
  assert.equal(formatBytes(3_200_000_000), '3.2 GB', 'Finder\'s figure for 3,200,000,000 bytes');
  assert.equal(formatBytes(700_000_000), '700.0 MB', 'QA\'s raw-footage.mkv');
  assert.equal(formatBytes(1000), '1.0 KB');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(1_000_000), '1.0 MB');
  assert.equal(formatBytes(1_000_000_000), '1.0 GB');
  assert.equal(formatBytes(1_000_000_000_000), '1.0 TB');
  assert.equal(formatBytes(1000 ** 5), '1.0 PB');
  assert.equal(formatBytes(1024), '1.0 KB', '1,024 bytes are 1.024 KB');
  assert.equal(formatBytes(1_048_576), '1.0 MB', 'a mebibyte is 1.05 MB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.4 GB', 'five gibibytes are 5.37 GB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('formatBytes never prints 1000.0 of a unit; it rolls to the next one', () => {
  assert.equal(formatBytes(999_950), '1.0 MB', '999.95 KB rounds to 1000.0 KB, which is a megabyte');
  assert.equal(formatBytes(999_949), '999.9 KB', 'a value that does not round up stays where it is');
  assert.equal(formatBytes(999_960_000), '1.0 GB');
  assert.equal(formatBytes(999_999_000_000), '1.0 TB');
  assert.equal(formatBytes(999_600_000_000_000, 0), '1 PB', 'the tray\'s zero-decimal form rolls too');
  assert.equal(formatBytes(999.6), '1.0 KB', 'rounding a byte count up to 1000 is a kilobyte');
  assert.equal(formatBytes(999.4), '999 B');
  assert.equal(formatBytes(1000 ** 5 * 999.99), '1000.0 PB', 'the last unit has nothing to roll into');
  // Every value in [999.95, 1000) of every unit would print 1000.0.
  for (let unit = 1; unit < 5; unit++) {
    const s = formatBytes(1000 ** unit * 999.97);
    assert.doesNotMatch(s, /^1000/, `unit ${unit}: ${s}`);
  }
});

test('the page\'s copy of formatBytes agrees with the server\'s (src/ui/app/000-prelude.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app', '000-prelude.js'), 'utf8');
  const start = src.indexOf('function formatBytes(');
  assert.ok(start > 0, 'the prelude defines formatBytes');
  const unitsLine = src.slice(src.indexOf('const UNITS'), src.indexOf('\n', src.indexOf('const UNITS')));
  // brace-matching slice of the function body
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const fn = src.slice(start, end);
  const page = vm.runInNewContext(`${unitsLine}; ${fn}; formatBytes`) as (n: number, d?: number) => string;
  for (const n of [0, 999, 999.4, 999.6, 1000, 1024, 1500, 999_949, 999_950, 1_048_576, 700_000_000, 999_960_000,
    3_200_000_000, 5 * 1024 ** 3, 999_999_000_000, 999_600_000_000_000, 1000 ** 5 * 999.99]) {
    assert.equal(page(n), formatBytes(n), `page vs server for ${n}`);
    assert.equal(page(n, 0), formatBytes(n, 0), `page vs server for ${n}, 0 decimals`);
  }
});

test('formatBytesPlain (the reclaim-score sentences) rolls over too, keeping its own decimal convention', () => {
  assert.equal(formatBytesPlain(999_960_000), '1.0 GB');
  assert.equal(formatBytesPlain(999_500), '1.0 MB');
  assert.equal(formatBytesPlain(1_500_000), '1.5 MB');
  assert.equal(formatBytesPlain(999), '999 B');
});

/* ───────────────────────── Missing Gigabytes notes ───────────────────────── */

const GB = 1_000_000_000;
const BLOCK = 4096;

function vol(over: Partial<LogicalVolumeInfo>): LogicalVolumeInfo {
  return {
    id: 'v', name: null, mountPoint: null, filesystem: 'apfs', sizeBytes: null, freeBytes: null,
    usedBytes: null, physicalDiskIds: [], kind: 'apfs', ...over,
  };
}

const VOLUMES: LogicalVolumeInfo[] = [
  vol({ id: 'disk3s1s1', name: 'Macintosh HD', mountPoint: '/', usedBytes: 12 * GB }),
  vol({ id: 'disk3s5', name: 'Data', mountPoint: '/System/Volumes/Data', usedBytes: 163 * GB }),
  vol({ id: 'disk3s2', name: 'Preboot', mountPoint: '/System/Volumes/Preboot', usedBytes: 9 * GB }),
  vol({ id: 'disk3s6', name: 'VM', mountPoint: '/System/Volumes/VM', usedBytes: 2 * GB }),
];
const DEVS: Record<string, number> = { '/': 1, '/System/Volumes/Data': 1, '/System/Volumes/Preboot': 2, '/System/Volumes/VM': 3 };

function sources(over: { platform?: NodeJS.Platform; totalBytes?: number; usedBytes?: number; reservedBytes?: number; volumes?: LogicalVolumeInfo[] } = {}): StatementSources {
  const totalBytes = over.totalBytes ?? 494 * GB;
  const usedBytes = over.usedBytes ?? 188 * GB;
  const reserved = over.reservedBytes ?? 0;
  const topology: VolumeTopology = { physicalDisks: [], logicalVolumes: over.volumes ?? VOLUMES, mechanism: 'fixture' };
  return {
    platform: over.platform ?? 'darwin',
    topology: () => Promise.resolve(topology),
    statfs: () => Promise.resolve({
      blocks: totalBytes / BLOCK,
      bfree: (totalBytes - usedBytes) / BLOCK,
      bavail: (totalBytes - usedBytes - reserved) / BLOCK,
      bsize: BLOCK,
    }),
    devOf: (target: string) => {
      let best: string | null = null;
      for (const mp of Object.keys(DEVS)) {
        if (target === mp || target.startsWith(mp === '/' ? '/' : mp + '/')) {
          if (!best || mp.length > best.length) best = mp;
        }
      }
      return Promise.resolve(best ? DEVS[best] : null);
    },
    snapshots: () => Promise.resolve({ available: true, platform: 'darwin' as NodeJS.Platform, snapshots: [], totalBytes: null, canPurge: false }),
    zombies: () => Promise.resolve({ available: false, reason: 'fixture', total: 0, groups: [] } as any),
  };
}

function scanFixture(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scanId: 'scan-1', rootPath: '/', status: 'complete', scanned: 10, fileCount: 8, dirCount: 2,
    currentPath: '/', startedAt: 0, createdAt: 0, cancelled: false, engine: 'walker',
    store: { rootId: 0, size: (id: number) => (id === 0 ? 167 * GB : 0) } as unknown as ScanResult['store'],
    ...over,
  } as ScanResult;
}

test('the statement\'s notes print bytes the way the rest of the app does (decimal units)', async () => {
  const s = await buildStatement(scanFixture({ hardlinkedBytes: 6_000_000 }), sources());
  const scanned = s.lines.find((l) => l.id === 'scanned')!;
  const hardlinkNote = scanned.notes.find((n) => /more than one name/.test(n))!;
  assert.ok(hardlinkNote, 'the hard-link note is there');
  assert.match(hardlinkNote, /6\.0 MB/, `the dashboard chip prints the same bytes as 6.0 MB: ${hardlinkNote}`);
  assert.doesNotMatch(hardlinkNote, /5\.7 MB/, 'not the binary figure for the same bytes');

  const other = s.lines.find((l) => l.id === 'otherVolumes')!;
  const preboot = other.notes.find((n) => n.startsWith('Preboot'))!;
  assert.match(preboot, /9\.0 GB/, `9e9 bytes are 9.0 GB in decimal units, as Finder says: ${preboot}`);
  const vmNote = other.notes.find((n) => n.startsWith('VM'))!;
  assert.match(vmNote, /2\.0 GB/, vmNote);
  // Every byte figure in every note re-derives from a source figure with formatBytes.
  const allowed = new Set([formatBytes(6_000_000), formatBytes(9 * GB), formatBytes(2 * GB), formatBytes(0)]);
  for (const line of s.lines) {
    for (const note of line.notes) {
      for (const m of note.matchAll(/\d+(?:\.\d+)? [KMGT]B/g)) {
        assert.ok(allowed.has(m[0]), `"${m[0]}" in "${note}" is not a formatBytes rendering of a source figure`);
      }
    }
  }
});

test('the statement names the disk in plain words, and keeps the raw mechanism for the API', async () => {
  const s = await buildStatement(scanFixture(), sources());
  assert.match(s.volume.mechanism, /^statfs\(/, 'the API field is unchanged');
  const label = s.volume.mechanismLabel;
  assert.equal(typeof label, 'string');
  assert.ok(!label.includes('(') && !label.includes('/') && !/statfs/i.test(label), `no C call, no mount path: ${label}`);
  assert.match(label, /Macintosh HD/, 'names the volume');
  assert.match(label, /macOS reports/, label);

  const unnamed = await buildStatement(
    scanFixture(),
    sources({ volumes: VOLUMES.map((v) => ({ ...v, name: null })) }),
  );
  assert.match(unnamed.volume.mechanismLabel, /this disk/, 'a nameless volume is still a sentence');
  const linux = await buildStatement(scanFixture(), sources({ platform: 'linux', volumes: [vol({ id: 'sda2', name: 'root', mountPoint: '/', usedBytes: 60 * GB })] }));
  assert.match(linux.volume.mechanismLabel, /Linux reports/, linux.volume.mechanismLabel);
});

test('the root reserve is reported, so used + free + reserved is the disk', async () => {
  const s = await buildStatement(scanFixture({ store: { rootId: 0, size: () => 50 * GB } as any }), sources({ platform: 'linux', totalBytes: 1000 * GB, usedBytes: 600 * GB, reservedBytes: 50 * GB, volumes: [vol({ id: 'sda2', name: 'root', mountPoint: '/', filesystem: 'ext4', kind: 'partition', usedBytes: 600 * GB })] }));
  assertBalances(s);
  assert.equal(s.volume.reservedBytes, 50 * GB);
  assert.equal(s.volume.usedBytes + s.volume.freeBytes + s.volume.reservedBytes, s.volume.totalBytes);
  const apfs = await buildStatement(scanFixture(), sources());
  assert.equal(apfs.volume.reservedBytes, 0, 'APFS reserves nothing');
});

/* ───────────────────────────── disk usage ───────────────────────────── */

test('diskUsage reports used the way the statement does, and /api/system publishes it', async () => {
  const u = await diskUsage(os.homedir());
  assert.ok(Number.isFinite(u.used) && u.used > 0, `used must be a positive number, got ${String(u.used)}`);
  assert.ok(u.used + u.free <= u.total, 'used + free never exceed the disk (the difference is the root reserve)');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const info = await new Promise<any>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/system' }, (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { d += c; });
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(typeof info.usedDisk, 'number');
    assert.ok(Math.abs(info.usedDisk - u.used) < u.total * 0.01, 'same disk, same answer (within a percent of churn)');
    assert.ok(info.usedDisk + info.freeDisk <= info.totalDisk);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ───────────────────────────── duplicates ───────────────────────────── */

test('the duplicate job says whether its reclaimable figure is an upper bound (APFS clones)', async () => {
  const base = fileTempDir('treemap-polish-dupes-');
  const payload = Buffer.alloc(8192, 3);
  fs.writeFileSync(path.join(base, 'a.dat'), payload);
  fs.writeFileSync(path.join(base, 'b.dat'), payload);
  const scan = await startScan(base);
  await waitFor(() => getScan(scan.scanId)?.status !== 'running', 'the scan settling', 20);
  const job = getDuplicateJob(getScan(scan.scanId)!, 1024);
  await waitFor(() => job.status !== 'running', 'the duplicate job settling', 20);
  assert.equal(job.status, 'complete');
  assert.equal(job.totalReclaimable, 8192);
  assert.equal(job.reclaimableIsUpperBound, process.platform === 'darwin');
  if (process.platform === 'darwin') {
    assert.match(job.reclaimableCaveat ?? '', /Duplicate/, 'names the Finder command that makes clones');
    assert.match(job.reclaimableCaveat ?? '', /free nothing|frees nothing/, job.reclaimableCaveat);
  } else {
    assert.equal(job.reclaimableCaveat, undefined);
  }
});

/* ───────────────────────────── the preview pane ───────────────────────────── */

test('the preview pane\'s limits are the decimal sizes its sentences name: "Image larger than 10 MB", "first 8 KB shown"', async () => {
  const base = fileTempDir('treemap-polish-preview-');
  const over = path.join(base, 'over.png');
  fs.writeFileSync(over, '');
  fs.truncateSync(over, 10_000_001); // sparse: a size, not ten megabytes of writing
  const long = path.join(base, 'long.txt');
  fs.writeFileSync(long, 'a'.repeat(9000));
  const scan = await startScan(base);
  await waitFor(() => getScan(scan.scanId)?.status !== 'running', 'the scan settling', 20);
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const answer = (p: string) => new Promise<{ ctype: string; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/files/preview?path=${encodeURIComponent(p)}` }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); });
      res.on('end', () => resolve({ ctype: String(res.headers['content-type']), body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  const preview = async (p: string): Promise<{ type: string; reason?: string; content?: string; truncated?: boolean }> => {
    const a = await answer(p);
    assert.match(a.ctype, /json/, `a JSON answer for ${path.basename(p)}, not the file itself`);
    return JSON.parse(a.body);
  };
  try {
    const big = await preview(over);
    assert.equal(big.type, 'meta', 'an image of 10,000,001 bytes is over the 10 MB it names');
    assert.equal(big.reason, 'Image larger than 10 MB');
    const text = await preview(long);
    assert.equal(text.type, 'text');
    assert.equal(text.content?.length, 8000, 'the first 8 KB is the first 8,000 bytes');
    assert.equal(text.truncated, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ───────────────────────────── cloud folders ───────────────────────────── */

test('cloudProviderFor is the one gate every engine shares', () => {
  assert.equal(cloudProviderFor('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x.pdf'), 'icloud');
  assert.equal(cloudProviderFor('/Users/me/OneDrive/x.pdf'), 'onedrive');
  assert.equal(cloudProviderFor('/Users/me/Dropbox/x.pdf'), 'dropbox');
  assert.equal(cloudProviderFor('/Users/me/VMs/Docker.raw'), undefined, 'a sparse file outside a cloud folder is not a placeholder');
});
