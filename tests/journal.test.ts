import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-'));
process.env.TREEMAP_NO_GDU = '1';

import { AppEntry, AuditEntry, SnapshotTreeNode, Snapshot } from '../src/models/types';
import {
  JOURNAL_KEEP_LINES, JOURNAL_ROTATE_AT_LINES, SIGNIFICANT_BYTES, UNATTRIBUTED,
  appendJournal, attributeChange, journalFilePath, readJournal, recordScanJournal,
  sentenceFor, significantChanges,
} from '../src/services/journal';
import { initPortableMode, resetPortableMode } from '../src/services/portableMode';
import { startScan, getScan } from '../src/services/diskScanner';
import { storeOf } from '../src/services/scanStore';
import { formatBytes } from '../src/utils/formatBytes';

/**
 * §7.3 — the disk journal.
 *
 * A rolling, human-readable record of significant disk changes: what changed,
 * by how much, and who did it — persisted to journal.jsonl, capped and
 * rotated. The properties tested here are the ones the master prompt names:
 * rotation, the never-guess attribution rule, and a read-only portable
 * session persisting nothing at all.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function entry(over: Partial<Parameters<typeof appendJournal>[0]> = {}): Parameters<typeof appendJournal>[0] {
  return {
    rootPath: '/Users/x',
    path: '/Users/x/Downloads',
    delta: -4.1 * GB,
    attribution: 'you',
    sentence: 'you removed 4.1 GB from Downloads',
    ...over,
  };
}

function fileLines(): string[] {
  return fs.readFileSync(journalFilePath(), 'utf8').split('\n').filter((l) => l.length > 0);
}

/* ─────────────── Append + read back ─────────────── */

test('entries survive the round trip, newest first, timestamped', async () => {
  await appendJournal(entry({ path: '/Users/x/a', delta: 1 * GB }));
  await appendJournal(entry({ path: '/Users/x/b', delta: 2 * GB }));
  await appendJournal(entry({ path: '/Users/x/c', delta: 3 * GB }));
  const back = await readJournal(2);
  assert.equal(back.length, 2, 'limit is honoured');
  assert.equal(back[0].path, '/Users/x/c', 'newest first');
  assert.equal(back[1].path, '/Users/x/b');
  assert.ok(back[0].at > 0, 'the service stamps the time');
  assert.equal(back[0].rootPath, '/Users/x');
  assert.equal(back[0].attribution, 'you');
  assert.ok(back[0].sentence.length > 0);
});

test('concurrent appends serialise into whole lines, in order', async () => {
  const before = fileLines().length;
  for (let i = 0; i < 50; i++) {
    void appendJournal(entry({ path: `/Users/x/burst-${i}` }));
  }
  await appendJournal(entry({ path: '/Users/x/burst-last' }));
  const lines = fileLines();
  assert.equal(lines.length, before + 51, 'no append was lost');
  const parsed = lines.slice(before).map((l) => JSON.parse(l) as { path: string });
  for (let i = 0; i < 50; i++) {
    assert.equal(parsed[i].path, `/Users/x/burst-${i}`, 'queue preserves order');
  }
  assert.equal(parsed[50].path, '/Users/x/burst-last');
});

/* ─────────────── Rotation ─────────────── */

test('the journal rotates at the cap, keeping only the newest tail', async () => {
  const existing = fileLines().length;
  const toAppend = JOURNAL_ROTATE_AT_LINES + 1 - existing;
  for (let i = 0; i < toAppend - 1; i++) {
    void appendJournal(entry({ path: `/Users/x/fill-${i}` }));
  }
  await appendJournal(entry({ path: '/Users/x/the-newest' }));

  const lines = fileLines();
  assert.equal(lines.length, JOURNAL_KEEP_LINES, 'rotation rewrote the file down to the keep count');
  const first = JSON.parse(lines[0]) as { path: string };
  const last = JSON.parse(lines[lines.length - 1]) as { path: string };
  assert.equal(last.path, '/Users/x/the-newest', 'the newest entry survives rotation');
  assert.notEqual(first.path, '/Users/x/a', 'the oldest entries are gone');
  for (const line of lines) JSON.parse(line); // every surviving line is whole

  // The tmp file used for the atomic rewrite never lingers.
  const dir = path.dirname(journalFilePath());
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('journal') && f.endsWith('.tmp')));

  const back = await readJournal(1);
  assert.equal(back[0].path, '/Users/x/the-newest');
});

test('appends keep working after a rotation', async () => {
  const before = fileLines().length;
  await appendJournal(entry({ path: '/Users/x/after-rotation' }));
  assert.equal(fileLines().length, before + 1);
  assert.equal((await readJournal(1))[0].path, '/Users/x/after-rotation');
});

/* ─────────────── Culprit selection over snapshot trees ─────────────── */

function node(n: string, s: number, c?: SnapshotTreeNode[]): SnapshotTreeNode {
  return c ? { n, s, t: 1, c } : { n, s };
}

test('a deep grower is pinned to its own folder, not the scan root', () => {
  const prev = node('x', 100 * GB, [
    node('Library', 50 * GB, [
      node('Containers', 20 * GB, [node('com.docker.docker', 10 * GB), node('com.apple.mail', 10 * GB)]),
      node('Caches', 30 * GB),
    ]),
    node('Downloads', 10 * GB, [node('movie.mkv', 4 * GB), node('keep.zip', 6 * GB)]),
  ]);
  const curr = node('x', 110 * GB, [
    node('Library', 64 * GB, [
      node('Containers', 34 * GB, [node('com.docker.docker', 24 * GB), node('com.apple.mail', 10 * GB)]),
      node('Caches', 30 * GB),
    ]),
    node('Downloads', 6 * GB, [node('keep.zip', 6 * GB)]),
  ]);
  const culprits = significantChanges(prev, curr, '/Users/x');
  assert.equal(culprits.length, 2);
  assert.equal(culprits[0].path, '/Users/x/Library/Containers/com.docker.docker', 'largest change first, pinned deep');
  assert.equal(culprits[0].delta, 14 * GB);
  assert.equal(culprits[1].path, '/Users/x/Downloads');
  assert.equal(culprits[1].delta, -4 * GB);
});

test('changes below the significance threshold produce nothing', () => {
  const prev = node('x', 10 * GB, [node('a', 5 * GB), node('b', 5 * GB)]);
  const curr = node('x', 10 * GB + 50 * MB, [node('a', 5 * GB + 30 * MB), node('b', 5 * GB + 20 * MB)]);
  assert.ok(SIGNIFICANT_BYTES > 50 * MB, 'the fixture must sit under the threshold');
  assert.deepEqual(significantChanges(prev, curr, '/Users/x'), []);
});

test('growth in a child the previous snapshot never stored pins to the parent', () => {
  // The previous tree keeps only the largest children per directory, so an
  // unmatched child cannot yield an honest delta of its own — the parent can.
  const prev = node('x', 10 * GB, [node('Movies', 10 * GB)]);
  const curr = node('x', 24 * GB, [node('Movies', 10 * GB), node('brand-new', 14 * GB)]);
  const culprits = significantChanges(prev, curr, '/Users/x');
  assert.equal(culprits.length, 1);
  assert.equal(culprits[0].path, '/Users/x', 'never a guess: the change is reported where it is known');
  assert.equal(culprits[0].delta, 14 * GB);
});

test('independent changes that cancel at the root are still both found', () => {
  const prev = node('x', 100 * GB, [node('grew', 10 * GB), node('shrank', 20 * GB), node('rest', 70 * GB)]);
  const curr = node('x', 100 * GB, [node('grew', 14 * GB), node('shrank', 16 * GB), node('rest', 70 * GB)]);
  const culprits = significantChanges(prev, curr, '/Users/x');
  assert.equal(culprits.length, 2);
  assert.deepEqual(culprits.map((c) => c.path).sort(), ['/Users/x/grew', '/Users/x/shrank']);
});

/* ─────────────── Attribution: an app, you, or an honest "don't know" ─────────────── */

function app(name: string, locations: string[]): AppEntry {
  return {
    name,
    id: name.toLowerCase(),
    totalBytes: 0,
    bytesByCategory: {},
    locations: locations.map((p) => ({ path: p, bytes: 0, category: 'data' as const, label: 'Data' })),
    safeToClearBytes: 0,
    safeToClearPaths: [],
  };
}

function auditLine(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: 2000,
    action: 'files.trash',
    source: 'http',
    tokenId: 'local',
    paths: ['/Users/x/Downloads/movie.mkv'],
    bytes: 4.1 * GB,
    dryRun: false,
    outcome: 'ok',
    ...over,
  };
}

test('growth inside an app-owned folder names the app — deepest owner wins', () => {
  const apps = [
    app('Docker', ['/Users/x/Library/Containers/com.docker.docker']),
    app('Everything', ['/Users/x/Library']),
  ];
  const who = attributeChange('/Users/x/Library/Containers/com.docker.docker/Data', 14.2 * GB, apps, [], 0);
  assert.equal(who, 'Docker');
  // The location itself, not just paths under it.
  assert.equal(attributeChange('/Users/x/Library/Containers/com.docker.docker', 14.2 * GB, apps, [], 0), 'Docker');
});

test('when no app owns the path, the entry says exactly "an unidentified process" — never a guess', () => {
  const apps = [app('Docker', ['/Users/x/Library/Containers/com.docker.docker'])];
  assert.equal(UNATTRIBUTED, 'an unidentified process');
  assert.equal(attributeChange('/Users/x/Movies', 20 * GB, apps, [], 0), UNATTRIBUTED);
  // A shared string prefix is not containment.
  assert.equal(attributeChange('/Users/x/Library/Containers/com.docker.docker-backup', 20 * GB, apps, [], 0), UNATTRIBUTED);
  // An app living INSIDE the changed folder is not evidence it caused the
  // whole folder's growth.
  assert.equal(attributeChange('/Users/x/Library', 20 * GB, apps, [], 0), UNATTRIBUTED);
});

test('shrinkage that matches a TreeMap deletion in the audit window is "you"', () => {
  const audit = [auditLine()];
  // The deleted file sits inside the changed folder.
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [], audit, 1000), 'you');
  // The changed path sits inside what was deleted (a whole folder trashed).
  assert.equal(
    attributeChange('/Users/x/Downloads/movie.mkv', -4.1 * GB, [], [auditLine({ paths: ['/Users/x/Downloads'] })], 1000),
    'you',
  );
  // "you" outranks an app claim over the same folder: TreeMap knows what it did.
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [app('Hoarder', ['/Users/x/Downloads'])], audit, 1000), 'you');
});

test('the audit log only speaks for real, successful deletions inside the window', () => {
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [], [auditLine({ dryRun: true })], 1000), UNATTRIBUTED);
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [], [auditLine({ outcome: 'refused' })], 1000), UNATTRIBUTED);
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [], [auditLine({ at: 500 })], 1000), UNATTRIBUTED, 'a deletion before the previous scan explains nothing');
  assert.equal(attributeChange('/Users/x/Downloads', -4.1 * GB, [], [auditLine({ paths: ['/Users/x/Desktop/other'] })], 1000), UNATTRIBUTED);
  // Growth is never "you": TreeMap only ever removes.
  assert.equal(attributeChange('/Users/x/Downloads', 4.1 * GB, [], [auditLine()], 1000), UNATTRIBUTED);
});

/* ─────────────── Sentences ─────────────── */

test('sentences read like the feature promises, from the entry fields alone', () => {
  const home = '/Users/x';
  assert.equal(
    sentenceFor('Docker', '/Users/x/Library/Containers/com.docker.docker', 14.2 * GB, home),
    `Docker added ${formatBytes(14.2 * GB)} (~/Library/Containers/com.docker.docker)`,
  );
  assert.equal(
    sentenceFor('you', '/Users/x/Downloads', -4.1 * GB, home),
    `you removed ${formatBytes(4.1 * GB)} from Downloads`,
  );
  assert.equal(
    sentenceFor(UNATTRIBUTED, '/private/var/log', 2 * GB, home),
    `an unidentified process added ${formatBytes(2 * GB)} (/private/var/log)`,
  );
});

/* ─────────────── Portable mode: a read-only session persists NOTHING ─────────────── */

const NO_CHMOD = process.platform === 'win32'
  ? 'chmod cannot make a directory read-only on Windows — the read-only medium case is POSIX-shaped'
  : false;

test('a read-only portable session keeps the journal in memory only', { skip: NO_CHMOD }, async () => {
  const roBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-ro-'));
  const roDir = path.join(roBase, 'ro');
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o500);
  try {
    resetPortableMode();
    const status = initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(roDir, 'TreeMap-Data') } as NodeJS.ProcessEnv);
    assert.equal(status.writable, false, 'the fixture really is read-only');

    const sizeBefore = fs.statSync(journalFilePath()).size;
    await appendJournal(entry({ path: '/Users/x/ephemeral-only' }));
    assert.equal(fs.statSync(journalFilePath()).size, sizeBefore, 'nothing reached the disk file');

    const back = await readJournal(1);
    assert.equal(back[0].path, '/Users/x/ephemeral-only', 'the session still remembers, in memory');
  } finally {
    fs.chmodSync(roDir, 0o700);
    fs.rmSync(roBase, { recursive: true, force: true });
    resetPortableMode();
  }
});

test('back in a writable session, appends persist again', async () => {
  const before = fileLines().length;
  await appendJournal(entry({ path: '/Users/x/persisted-again' }));
  assert.equal(fileLines().length, before + 1);
});

/* ─────────────── Feeding the journal from a completed scan ─────────────── */

test('recordScanJournal turns a scan-vs-snapshot delta into an attributed entry', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-scan-'));
  fs.writeFileSync(path.join(fixture, 'small.txt'), 'hello');
  const { scanId } = await startScan(fixture);
  for (let i = 0; i < 200; i++) {
    if (getScan(scanId)?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const scan = getScan(scanId);
  assert.ok(scan && scan.status === 'complete');
  const store = storeOf(scan);
  const currentTotal = store.size(store.rootId);

  // A previous snapshot claiming 300 MB that no longer exists: the entry the
  // journal must write is a removal it cannot attribute to any app.
  const prev: Snapshot = {
    id: 'prev-snapshot',
    rootPath: fixture,
    takenAt: Date.now() - 60_000,
    totalSize: currentTotal + 300 * MB,
    fileCount: 2,
    dirCount: 1,
    topEntries: [
      { name: 'small.txt', path: path.join(fixture, 'small.txt'), size: currentTotal, type: 'file' },
      { name: 'vanished', path: path.join(fixture, 'vanished'), size: 300 * MB, type: 'dir' },
    ],
  };

  const written = await recordScanJournal(scan, prev);
  assert.equal(written, 1);
  const back = await readJournal(1);
  assert.equal(back[0].rootPath, fixture);
  assert.equal(back[0].path, fixture, 'the vanished folder is unmatched, so the change pins to the root');
  assert.equal(back[0].delta, -300 * MB);
  assert.equal(back[0].attribution, UNATTRIBUTED, 'no audit line and no app claim: an honest "don\'t know"');
  assert.ok(back[0].sentence.includes('removed'), back[0].sentence);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('a scan that changed nothing significant writes nothing', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-still-'));
  fs.writeFileSync(path.join(fixture, 'small.txt'), 'hello');
  const { scanId } = await startScan(fixture);
  for (let i = 0; i < 200; i++) {
    if (getScan(scanId)?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const scan = getScan(scanId);
  assert.ok(scan && scan.status === 'complete');
  const store = storeOf(scan);
  const size = store.size(store.rootId);
  const prev: Snapshot = {
    id: 'prev-still', rootPath: fixture, takenAt: Date.now() - 60_000,
    totalSize: size, fileCount: 1, dirCount: 1,
    topEntries: [{ name: 'small.txt', path: path.join(fixture, 'small.txt'), size, type: 'file' }],
  };
  assert.equal(await recordScanJournal(scan, prev), 0);
  fs.rmSync(fixture, { recursive: true, force: true });
});

/* ─────────────── The read-only HTTP surface ─────────────── */

test('GET /api/journal serves the journal newest first; nothing writes it over HTTP', async () => {
  const { createApp } = await import('../src/server');
  const { resetRateLimiter } = await import('../src/middleware/rateLimiter');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const req = (method: string, url: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: url, method }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      r.on('error', reject);
      r.end();
    });
  try {
    await appendJournal(entry({ path: '/Users/x/served-first' }));
    const ok = await req('GET', '/api/journal?limit=2');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.entries.length, 2);
    assert.equal(ok.body.entries[0].path, '/Users/x/served-first');
    for (const key of ['at', 'rootPath', 'path', 'delta', 'attribution', 'sentence']) {
      assert.ok(key in ok.body.entries[0], `entry carries "${key}"`);
    }
    // The journal is written by the service off the scheduler's own scans —
    // there is no HTTP verb that writes it.
    const post = await req('POST', '/api/journal');
    assert.equal(post.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
