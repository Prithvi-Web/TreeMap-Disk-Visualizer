import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
// App-data reached through links, as a person who moved ~/Library/Application Support/TreeMap to a
// bigger volume has it: TreeMap spells it HOME/Library/Application Support/TreeMap, a link to
// BIG/hop/treemap-data, where BIG/hop is itself a link to VOL — so app-data really is
// VOL/treemap-data. Everything sits in one folder this file scans, so the scanned-root rule allows a
// request that names any of it.
const T_DIR = isolatedDataDir('treemap-safetyRecordsLink-');
const T = fs.realpathSync(T_DIR);
const HOME = path.join(T, 'home');
const BIG = path.join(T, 'big');
const VOL = path.join(T, 'vol');
const REAL = path.join(VOL, 'treemap-data');
const HOP = path.join(BIG, 'hop');
const SUPPORT = path.join(HOME, 'Library', 'Application Support');
const LINK = path.join(SUPPORT, 'TreeMap');
fs.mkdirSync(REAL, { recursive: true });
fs.mkdirSync(SUPPORT, { recursive: true });
fs.mkdirSync(BIG, { recursive: true });
fs.symlinkSync(VOL, HOP, 'junction');
fs.symlinkSync(path.join(HOP, 'treemap-data'), LINK, 'junction');
process.env.TREEMAP_DATA_DIR = LINK;
process.env.TREEMAP_NO_GDU = '1';
/** Whether this volume folds case, as macOS's and Windows' do by default. */
const CASE_FOLDS = fs.existsSync(path.join(T, 'HOME'));

import { createApp } from '../src/server';
import { startScan } from '../src/services/diskScanner';
import { moveToTrash, setTrashStepForTests } from '../src/services/cleaner';
import { normalizePolicy, simulatePolicy } from '../src/services/autopilot';
import { getPolicy, POLICY_FILE } from '../src/services/policy';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { AppError } from '../src/middleware/errorHandler';
import { updateSettings } from '../src/services/settings';
import { waitFor } from './fixtures/waitFor';

/**
 * TreeMap's agent policy and audit log are never removed through TreeMap, nor is a folder that holds
 * them (the final review, F1.11). When app-data is reached through a link, removing the link — or a
 * link the way to app-data passes, or a folder that holds either — takes the records from TreeMap
 * just as surely: app-data as TreeMap spells it is then nothing, the policy reads as absent, and an
 * absent policy means no limits (the final review, F2.1). Each of those is refused, 403
 * SAFETY_RECORD, at every door; Autopilot leaves each alone and says so. A file beside them is
 * deleted as before.
 *
 * Nothing reaches the Trash: the step is replaced for the whole file.
 */

const NOTHING = path.join(HOME, 'nothing-here');
fs.writeFileSync(path.join(REAL, POLICY_FILE), JSON.stringify({ protectedPaths: [NOTHING] }));
fs.writeFileSync(path.join(SUPPORT, 'beside.txt'), 'beside the link');
fs.writeFileSync(path.join(BIG, 'beside.txt'), 'beside the hop');

let port = 0;
let server: http.Server;
const trashed: string[] = [];

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
  const scan = await startScan(T);
  await waitFor(() => scan.status !== 'running', `the scan of ${T}`);
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(trashed, [], 'nothing was trashed');
});

/** A dry-run DELETE /api/files of one path: its status, and the refusal's code and sentence. */
function dryRunAnswer(p: string): Promise<{ status: number; code: string; error: string }> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ paths: [p], dryRun: true });
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/files', method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let body: { code?: string; error?: string } = {};
          try { body = JSON.parse(buf) as { code?: string; error?: string }; } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, code: body.code ?? '', error: body.error ?? '' });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** A dry-run DELETE /api/files of one path: its status and code. */
async function dryRunDelete(p: string): Promise<string> {
  const { status, code } = await dryRunAnswer(p);
  return `${status}${code ? ` ${code}` : ''}`;
}

test('the policy is read through the links, so this file tests what it means to', async () => {
  assert.deepEqual((await getPolicy()).protectedPaths, [NOTHING]);
});

test('a delete of the link TreeMap reaches app-data by, of a link on the way to it, or of a folder holding either, is refused 403 SAFETY_RECORD — while a file beside them is deleted as before', async () => {
  const targets: Record<string, string> = {
    'the link TreeMap spells app-data as': LINK,
    'the folder holding that link': SUPPORT,
    'a folder above that': path.join(HOME, 'Library'),
    'a link the way to app-data passes': HOP,
    'the folder holding that link too': BIG,
    'app-data where it really is': REAL,
  };
  // Each entry on TreeMap's way to app-data is judged by identity, so any spelling of it is caught —
  // pinned here on a volume that folds case, as the hard-link stand-in below pins it where the system
  // makes a second name of a link (the final review, F3.3).
  if (CASE_FOLDS) {
    targets['the link, in another case'] = path.join(SUPPORT, 'treemap');
    targets['a folder above it, in another case'] = path.join(HOME, 'LIBRARY');
    targets['the hop, in another case'] = path.join(BIG, 'HOP');
  }
  const answers: Record<string, string> = {};
  for (const [what, p] of Object.entries(targets)) answers[what] = await dryRunDelete(p);
  answers['a file beside the link'] = await dryRunDelete(path.join(SUPPORT, 'beside.txt'));
  answers['a file beside the hop'] = await dryRunDelete(path.join(BIG, 'beside.txt'));
  const expected = Object.fromEntries(Object.keys(targets).map((what) => [what, '403 SAFETY_RECORD']));
  assert.deepEqual(answers, { ...expected, 'a file beside the link': '200', 'a file beside the hop': '200' });
});

test('the refusal says truly what it refused: a folder holding a link TreeMap reaches the records through holds neither the policy nor the log, and is named as what it is (the final review, F3.2)', async () => {
  const sentences: Record<string, string> = {};
  for (const [what, p] of [['a folder above the link', path.join(HOME, 'Library')], ['the folder holding the hop', BIG]] as const) {
    const { code, error } = await dryRunAnswer(p);
    sentences[what] = `${code}: ${error.replace(`"${p}"`, '<the path>').split('. ')[0]}`;
  }
  const sentence = "SAFETY_RECORD: <the path> is TreeMap's agent policy or its audit log, a folder that holds them, or a folder or link TreeMap reaches them through";
  assert.deepEqual(sentences, { 'a folder above the link': sentence, 'the folder holding the hop': sentence });
});

test('the Trash step itself refuses the link, and the policy still reads afterwards', async () => {
  let refusal = 'went ahead';
  try {
    await moveToTrash([LINK]);
  } catch (err) {
    refusal = err instanceof AppError ? err.code : String(err);
  }
  assert.equal(refusal, 'SAFETY_RECORD');
  assert.deepEqual([fs.lstatSync(LINK).isSymbolicLink(), (await getPolicy()).protectedPaths], [true, [NOTHING]]);
});

test('Autopilot leaves the links alone, and says so, over the folder holding either', async () => {
  const reason = /agent policy and its audit log/;
  const verdicts: Record<string, unknown> = {};
  for (const [what, root, link] of [['HOME, holding the link', HOME, LINK], ['the folder holding the hop', BIG, HOP]] as const) {
    const policy = normalizePolicy({ name: what, path: root, match: { kind: 'custom', maxAgeMs: 1 }, enabled: true }); // everything older than a millisecond
    const result = await simulatePolicy(policy);
    verdicts[what] = {
      'the link would be deleted': result.items.some((i) => i.path === link),
      'left alone, and why': result.skipped.filter((s) => reason.test(s.reason)).map((s) => s.path),
      'the file beside it would be deleted': result.items.some((i) => i.path === path.join(path.dirname(link), 'beside.txt')),
    };
  }
  assert.deepEqual(verdicts, {
    'HOME, holding the link': { 'the link would be deleted': false, 'left alone, and why': [LINK], 'the file beside it would be deleted': true },
    'the folder holding the hop': { 'the link would be deleted': false, 'left alone, and why': [HOP], 'the file beside it would be deleted': true },
  });
});

test('a second name of the link that no fold explains — an 8.3 short name on Windows, stood in for by a hard link to the link where the system makes one — is refused by identity', async (t) => {
  const alias = path.join(SUPPORT, 'TREEMA~9');
  try {
    fs.linkSync(LINK, alias);
  } catch (err) {
    t.skip(`this system makes no second name of a link (${(err as NodeJS.ErrnoException).code})`);
    return;
  }
  try {
    if (!fs.lstatSync(alias).isSymbolicLink()) {
      t.skip('a hard link here names what the link leads to, not the link');
      return;
    }
    assert.equal(await dryRunDelete(alias), '403 SAFETY_RECORD');
  } finally {
    fs.rmSync(alias, { force: true });
  }
});
