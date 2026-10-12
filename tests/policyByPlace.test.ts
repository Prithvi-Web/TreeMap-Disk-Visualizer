import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('treemap-policyByPlace-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { assertPathsAllowed, assertScanAllowed, knownSizeOf, POLICY_FILE } from '../src/services/policy';
import { AppError } from '../src/middleware/errorHandler';

/**
 * agent-policy.json's protectedPaths, allowedRoots and byte cap are judged on where a path LIVES —
 * as the scanned-root rule judges it, and as the delete then acts — not on its text (the final
 * review, F1.3, F1.4, F1.7). By its text, a protected folder spelled through a link in its parents,
 * in another case, or on the Data volume's long spelling passed the policy and was trashed; a path
 * spelled inside an allowed root through a link that leads out of it passed allowedRoots; and the
 * byte cap read such a spelling as "size unknown" and let it through.
 *
 * Every request here is a dry run, which passes through the policy exactly as a real one does; the
 * Trash step is stubbed to fail loudly.
 */

const DARWIN = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';
const POLICY_PATH = path.join(DATA_DIR, POLICY_FILE);

/** A home-like folder, by its real path: Documents/taxes/return.pdf (50,000 bytes), Desktop/notes.txt, Desktop/docs -> Documents. */
const HOME = fs.realpathSync(fileTempDir('treemap-policyByPlace-home-'));
const TAXES = path.join(HOME, 'Documents', 'taxes');
const BYTES = 50_000;
fs.mkdirSync(TAXES, { recursive: true });
fs.writeFileSync(path.join(TAXES, 'return.pdf'), Buffer.alloc(BYTES, 1));
fs.mkdirSync(path.join(HOME, 'Desktop'));
fs.writeFileSync(path.join(HOME, 'Desktop', 'notes.txt'), 'notes');
if (!WINDOWS) fs.symlinkSync(path.join(HOME, 'Documents'), path.join(HOME, 'Desktop', 'docs'));
/** Whether this volume folds case, as macOS's and Windows' do by default. */
const CASE_FOLDS = fs.existsSync(path.join(HOME, 'DOCUMENTS', 'TAXES'));

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
  const scan = await startScan(HOME);
  await waitFor(() => scan.status !== 'running', `the scan of ${HOME}`);
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  fs.rmSync(POLICY_PATH, { force: true });
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(trashed, [], 'nothing was trashed');
});

/** DELETE /api/files as a dry run of `paths`: the refusal's code, or 'ok' with the bytes it counted. */
function dryRunDelete(paths: string[]): Promise<string> {
  return send('DELETE', '/api/files', { paths, dryRun: true });
}

/** A request with a JSON body: the refusal's status and code, or 'ok' with the bytes a dry run counted. */
function send(method: string, url: string, body: unknown): Promise<string> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          const body = JSON.parse(buf) as { code?: string; totalKnownBytes?: number };
          resolve(res.statusCode === 200 ? `ok, ${body.totalKnownBytes} bytes` : `${res.statusCode} ${body.code}`);
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

function withPolicy(policy: object): void {
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy));
}

/** Every spelling of the protected folder (and of the folder holding it) that reaches it on this machine. */
function spellingsOfTaxes(): Record<string, string> {
  const spellings: Record<string, string> = { 'as written': TAXES };
  if (!WINDOWS) spellings['through a link in its parents'] = path.join(HOME, 'Desktop', 'docs', 'taxes');
  if (CASE_FOLDS) spellings['in another case'] = path.join(HOME, 'documents', 'TAXES');
  if (DARWIN) spellings['on the Data volume'] = `/System/Volumes/Data${TAXES}`;
  return spellings;
}

test('a protected folder is refused by every spelling that reaches it — a link in its parents, another case, the Data volume — and so is the folder holding it, in another case', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  withPolicy({ protectedPaths: [TAXES] });
  const answers: Record<string, string> = {};
  for (const [how, p] of Object.entries(spellingsOfTaxes())) answers[how] = await dryRunDelete([p]);
  if (CASE_FOLDS) answers['the folder holding it, in another case'] = await dryRunDelete([path.join(HOME, 'DOCUMENTS')]);
  const refused = Object.fromEntries(Object.keys(answers).map((how) => [how, '403 POLICY_PROTECTED_PATH']));
  assert.deepEqual(answers, refused);
  // The link itself is not the folder: trashing it removes the link, never what it leads to.
  assert.match(await dryRunDelete([path.join(HOME, 'Desktop', 'docs')]), /^ok, \d+ bytes$/);
});

test('a protected path that is a link protects the link, in any spelling, and what it leads to', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  withPolicy({ protectedPaths: [path.join(HOME, 'Desktop', 'docs')] });
  const answers: Record<string, string> = { 'what it leads to, Documents/taxes': await dryRunDelete([TAXES]) };
  if (CASE_FOLDS) answers['the link, in another case'] = await dryRunDelete([path.join(HOME, 'desktop', 'DOCS')]);
  assert.deepEqual(answers, Object.fromEntries(Object.keys(answers).map((how) => [how, '403 POLICY_PROTECTED_PATH'])));
});

test('a protected path written with ~ is the folder under the home folder', { skip: WINDOWS && 'the home folder is read from HOME here' }, () => {
  const prior = process.env.HOME;
  process.env.HOME = HOME;
  try {
    assert.throws(
      () => assertPathsAllowed({ allowedRoots: [], protectedPaths: ['~/Documents/taxes'], maxBytesPerOperation: null }, [path.join(TAXES, 'return.pdf')]),
      (err: unknown) => err instanceof AppError && err.code === 'POLICY_PROTECTED_PATH',
    );
  } finally {
    process.env.HOME = prior;
  }
});

test('allowedRoots holds a path to where it lives: spelled inside an allowed root through a link that leads out of it is outside; the link itself, and what really lies in the root, are inside', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  withPolicy({ allowedRoots: [path.join(HOME, 'Desktop')] });
  assert.deepEqual(
    {
      'Desktop/docs/taxes (lives in Documents)': await dryRunDelete([path.join(HOME, 'Desktop', 'docs', 'taxes')]),
      'Desktop/docs, the link itself': (await dryRunDelete([path.join(HOME, 'Desktop', 'docs')])).replace(/\d+/, 'N'),
      'Desktop/notes.txt': await dryRunDelete([path.join(HOME, 'Desktop', 'notes.txt')]),
    },
    {
      'Desktop/docs/taxes (lives in Documents)': '403 POLICY_ROOT_NOT_ALLOWED',
      'Desktop/docs, the link itself': 'ok, N bytes',
      'Desktop/notes.txt': 'ok, 5 bytes',
    },
  );
});

test('the byte cap and the bytes a delete counts read the folder by where it lives, so another spelling of a sized folder is sized, never "unknown"', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  fs.rmSync(POLICY_PATH, { force: true });
  const answers: Record<string, unknown> = {};
  for (const [how, p] of Object.entries(spellingsOfTaxes())) answers[`${how}: its known size`] = knownSizeOf(p);
  // The bytes the manifest and the audit count for it, with no policy in the way.
  for (const [how, p] of Object.entries(spellingsOfTaxes())) answers[`${how}: a dry run with no policy`] = await dryRunDelete([p]);
  withPolicy({ maxBytesPerOperation: 1000 });
  for (const [how, p] of Object.entries(spellingsOfTaxes())) answers[`${how}: under a 1000-byte cap`] = await dryRunDelete([p]);
  fs.rmSync(POLICY_PATH, { force: true });
  const expected: Record<string, unknown> = {};
  for (const how of Object.keys(spellingsOfTaxes())) {
    expected[`${how}: its known size`] = BYTES;
    expected[`${how}: a dry run with no policy`] = `ok, ${BYTES} bytes`;
    expected[`${how}: under a 1000-byte cap`] = '403 POLICY_BYTES_EXCEEDED';
  }
  assert.deepEqual(answers, expected);
});

test('an index build is held to allowedRoots where its root really is, as a scan is: a folder spelled inside an allowed root through a link above it is refused, and a root that is itself a link is judged as the link the walk lists (the final review, F1.8, F1.15)', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  withPolicy({ allowedRoots: [path.join(HOME, 'Desktop')] });
  const policy = { allowedRoots: [path.join(HOME, 'Desktop')], protectedPaths: [], maxBytesPerOperation: null };
  const verdict = (root: string): string => {
    try {
      assertScanAllowed(policy, root);
      return 'allowed';
    } catch (err) {
      return err instanceof AppError ? err.code : String(err);
    }
  };
  try {
    assert.deepEqual(
      {
        'POST /api/index/build of Desktop/docs/taxes (lives in Documents)': await send('POST', '/api/index/build', { path: path.join(HOME, 'Desktop', 'docs', 'taxes') }),
        'the gate, Desktop/docs/taxes': verdict(path.join(HOME, 'Desktop', 'docs', 'taxes')),
        'the gate, Desktop/docs (a link, indexed as itself)': verdict(path.join(HOME, 'Desktop', 'docs')),
        'the gate, Desktop': verdict(path.join(HOME, 'Desktop')),
      },
      {
        'POST /api/index/build of Desktop/docs/taxes (lives in Documents)': '403 POLICY_ROOT_NOT_ALLOWED',
        'the gate, Desktop/docs/taxes': 'POLICY_ROOT_NOT_ALLOWED',
        'the gate, Desktop/docs (a link, indexed as itself)': 'allowed',
        'the gate, Desktop': 'allowed',
      },
    );
  } finally {
    fs.rmSync(POLICY_PATH, { force: true });
  }
});

test('an allowed root is compared exactly, never folded: a folder the volume tells apart from it is outside it, though its name folds the same (the final review, F2.11)', async (t) => {
  // Ｄesktop (a fullwidth Ｄ, which no volume folds to D, though a fold of names does) is another folder
  // everywhere; on a volume that keeps case, so is desktop.
  const others: Record<string, string> = { 'Ｄesktop (a fullwidth Ｄ)': path.join(HOME, 'Ｄesktop') };
  if (!CASE_FOLDS) others['desktop (another case, on a volume that keeps it)'] = path.join(HOME, 'desktop');
  for (const folder of Object.values(others)) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'x.txt'), 'elsewhere');
  }
  const desktop = fs.statSync(path.join(HOME, 'Desktop')).ino;
  const distinct = Object.entries(others).filter(([, folder]) => fs.statSync(folder).ino !== desktop);
  if (distinct.length === 0) {
    t.skip('this volume reads every such name as Desktop');
    return;
  }
  withPolicy({ allowedRoots: [path.join(HOME, 'Desktop')] });
  try {
    const answers: Record<string, string> = {};
    for (const [what, folder] of distinct) answers[`${what}/x.txt`] = await dryRunDelete([path.join(folder, 'x.txt')]);
    answers['Desktop/notes.txt'] = await dryRunDelete([path.join(HOME, 'Desktop', 'notes.txt')]);
    assert.deepEqual(answers, { ...Object.fromEntries(distinct.map(([what]) => [`${what}/x.txt`, '403 POLICY_ROOT_NOT_ALLOWED'])), 'Desktop/notes.txt': 'ok, 5 bytes' });
  } finally {
    fs.rmSync(POLICY_PATH, { force: true });
    for (const folder of Object.values(others)) fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('every gate reads an allowed root alike: the route\'s gate and the scan\'s own agree on an entry written with ~ or on the Data volume\'s long spelling, and a refused scan blames no link that is not there (the final review, F2.2, F2.5)', { skip: WINDOWS && 'the home folder is read from HOME here' }, async () => {
  const desktop = path.join(HOME, 'Desktop');
  const documents = path.join(HOME, 'Documents');
  const entries: Record<string, string> = { '~/Desktop': '~/Desktop' };
  if (DARWIN) entries['Desktop on the Data volume'] = `/System/Volumes/Data${desktop}`;
  /** The route's gate (assertScanAllowed, also the index build's) for `root`. */
  const gate = (entry: string, root: string): string => {
    try {
      assertScanAllowed({ allowedRoots: [entry], protectedPaths: [], maxBytesPerOperation: null }, root);
      return 'allowed';
    } catch (err) {
      return err instanceof AppError ? err.code : String(err);
    }
  };
  /** A scan of `root` (its own gate, which every caller of startScan meets), settled; or the refusal's code and sentence. */
  const scanOf = async (root: string): Promise<string> => {
    try {
      const scan = await startScan(root);
      await waitFor(() => scan.status !== 'running', `the scan of ${root}`);
      return scan.status === 'complete' ? 'allowed' : `failed: ${scan.error}`;
    } catch (err) {
      return err instanceof AppError ? `${err.code}${/link/.test(err.message) ? ', blaming a link' : ''}` : String(err);
    }
  };
  const prior = process.env.HOME;
  process.env.HOME = HOME;
  const answers: Record<string, string> = {};
  try {
    for (const [what, entry] of Object.entries(entries)) {
      withPolicy({ allowedRoots: [entry] });
      answers[`${what}: the route's gate, Desktop`] = gate(entry, desktop);
      answers[`${what}: a scan of Desktop`] = await scanOf(desktop);
      answers[`${what}: the route's gate, Documents`] = gate(entry, documents);
      answers[`${what}: a scan of Documents`] = await scanOf(documents);
    }
  } finally {
    process.env.HOME = prior;
    fs.rmSync(POLICY_PATH, { force: true });
  }
  const expected: Record<string, string> = {};
  for (const what of Object.keys(entries)) {
    expected[`${what}: the route's gate, Desktop`] = 'allowed';
    expected[`${what}: a scan of Desktop`] = 'allowed';
    expected[`${what}: the route's gate, Documents`] = 'POLICY_ROOT_NOT_ALLOWED';
    expected[`${what}: a scan of Documents`] = 'POLICY_ROOT_NOT_ALLOWED';
  }
  assert.deepEqual(answers, expected);
});
