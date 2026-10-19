import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('treemap-policyScanRoots-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { updateSettings } from '../src/services/settings';
import { POLICY_FILE } from '../src/services/policy';

/**
 * GET /api/policy?scanRoot=<folder> (repeatable) — which of these folders a scan may start at, as
 * POST /api/scan judges a root before it walks: the path rules, then agent-policy.json's
 * allowedRoots, read where each folder really is (review F3.2). The start screen offers Desktop,
 * Documents, Downloads, the home folder and the whole drive; with an allowedRoots policy every one
 * outside it answered 403 POLICY_ROOT_NOT_ALLOWED, and the page could not know which, short of
 * re-implementing the policy — and missing its `~`, link and Data-volume readings. So the server
 * answers with the rule the scan itself applies, and without the parameter the policy endpoint's
 * answer is what it always was.
 */

const WINDOWS = process.platform === 'win32';
const POLICY_PATH = path.join(DATA_DIR, POLICY_FILE);

/**
 * A home-like folder, by its real path: Desktop, Downloads (one file, and a folder `sub`), and three
 * links: Desktop/dl -> Downloads, Downloads/out -> Desktop, Downloads/inner -> Downloads/sub.
 */
const HOME = fs.realpathSync(fileTempDir('treemap-policyScanRoots-home-'));
const DESKTOP = path.join(HOME, 'Desktop');
const DOWNLOADS = path.join(HOME, 'Downloads');
fs.mkdirSync(DESKTOP);
fs.mkdirSync(path.join(DOWNLOADS, 'sub'), { recursive: true });
fs.writeFileSync(path.join(DOWNLOADS, 'a.zip'), 'zip');
if (!WINDOWS) {
  fs.symlinkSync(DOWNLOADS, path.join(DESKTOP, 'dl'));
  fs.symlinkSync(DESKTOP, path.join(DOWNLOADS, 'out'));
  fs.symlinkSync(path.join(DOWNLOADS, 'sub'), path.join(DOWNLOADS, 'inner'));
}
const ROOT = path.parse(HOME).root;

let port = 0;
let server: http.Server;

before(async () => {
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
});

after(async () => {
  fs.rmSync(POLICY_PATH, { force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

type Answer = { status: number; body: Record<string, unknown> };

function request(method: string, url: string, body?: unknown): Promise<Answer> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) as Record<string, unknown> }));
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** GET /api/policy asking about `roots`, in that order. */
function policyFor(roots: string[]): Promise<Answer> {
  return request('GET', '/api/policy?' + roots.map((p) => 'scanRoot=' + encodeURIComponent(p)).join('&'));
}

/** What POST /api/scan answers for `p`: a scan started — waited out, so none runs on — or the refusal's status, code and words. */
async function scanAnswer(p: string): Promise<{ allowed: true } | { allowed: false; status: number; code: string; error: string }> {
  const r = await request('POST', '/api/scan', { path: p });
  if (r.status !== 202) return { allowed: false, status: r.status, code: String(r.body.code), error: String(r.body.error) };
  const id = String(r.body.scanId);
  await waitFor(async () => (await request('GET', `/api/scan/${id}/stats`)).body.status !== 'running', `the scan of ${p}`);
  return { allowed: true };
}

function withPolicy(contents: string | null): void {
  if (contents === null) fs.rmSync(POLICY_PATH, { force: true });
  else fs.writeFileSync(POLICY_PATH, contents);
}

test('without scanRoot the answer is what it always was: the policy and its file, nothing more', async () => {
  withPolicy(JSON.stringify({ allowedRoots: [DOWNLOADS] }));
  const r = await request('GET', '/api/policy');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['policy', 'file']);
  withPolicy('{ not json');
  const broken = await request('GET', '/api/policy');
  assert.deepEqual(Object.keys(broken.body), ['policy', 'unreadable', 'reason', 'file']);
});

test('with no policy every folder asked about may be scanned, in the order asked', async () => {
  withPolicy(null);
  const r = await policyFor([DESKTOP, DOWNLOADS, ROOT]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.scanRoots, [DESKTOP, DOWNLOADS, ROOT].map((p) => ({ path: p, allowed: true })));
  assert.deepEqual((r.body.policy as { allowedRoots: string[] }).allowedRoots, [], 'and the policy beside them says why');
});

test('with allowedRoots each folder is judged as POST /api/scan judges it: allowed inside, refused outside with the scan\'s own code and words', async () => {
  withPolicy(JSON.stringify({ allowedRoots: [DOWNLOADS] }));
  const asked = [DOWNLOADS, DESKTOP, HOME, ROOT];
  const r = await policyFor(asked);
  assert.equal(r.status, 200);
  const verdicts = r.body.scanRoots as Array<Record<string, unknown>>;
  assert.deepEqual(verdicts.map((v) => [v.path, v.allowed]), [[DOWNLOADS, true], [DESKTOP, false], [HOME, false], [ROOT, false]]);
  for (const v of verdicts) {
    const scan = await scanAnswer(String(v.path));
    if (v.allowed) assert.deepEqual(scan, { allowed: true }, `${v.path}: allowed, and the scan starts`);
    else assert.deepEqual(scan, { allowed: false, status: 403, code: v.code, error: v.error }, `${v.path}: refused, as the scan refuses it`);
  }
  assert.equal(verdicts[1].code, 'POLICY_ROOT_NOT_ALLOWED');
});

test('a link root is judged by both of the scan\'s gates: where it lies (the route\'s), and where it leads (the walk\'s) — as POST /api/scan judges it, word for word', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  withPolicy(JSON.stringify({ allowedRoots: [DOWNLOADS] }));
  const fromOutside = path.join(DESKTOP, 'dl'); // lies outside, leads in: the route's gate refuses it
  const leadingOut = path.join(DOWNLOADS, 'out'); // lies inside, leads out: the walk's own gate refuses it
  const inside = path.join(DOWNLOADS, 'inner'); // lies inside, leads inside
  const r = await policyFor([fromOutside, leadingOut, inside]);
  const verdicts = r.body.scanRoots as Array<Record<string, unknown>>;
  assert.deepEqual(verdicts.map((v) => [v.path, v.allowed, v.code ?? null]), [
    [fromOutside, false, 'POLICY_ROOT_NOT_ALLOWED'], [leadingOut, false, 'POLICY_ROOT_NOT_ALLOWED'], [inside, true, null],
  ]);
  assert.match(String(verdicts[1].error), /is a link to a folder outside the allowed roots/, 'the walk\'s own words');
  for (const v of verdicts) {
    const scan = await scanAnswer(String(v.path));
    if (v.allowed) assert.deepEqual(scan, { allowed: true }, `${v.path}: allowed, and the scan starts`);
    else assert.deepEqual(scan, { allowed: false, status: 403, code: v.code, error: v.error }, `${v.path}: refused, as the scan refuses it`);
  }
});

test('a policy file that will not parse refuses every folder, as every scan is refused, with the same words — a folder that is not there too, which the scan refuses for the policy before it looks', async () => {
  withPolicy('{ not json');
  const gone = path.join(HOME, 'gone');
  const r = await policyFor([DOWNLOADS, ROOT, gone]);
  assert.equal(r.status, 200, 'the endpoint that says where the file is still answers');
  assert.equal(r.body.unreadable, true);
  const verdicts = r.body.scanRoots as Array<Record<string, unknown>>;
  assert.deepEqual(verdicts.map((v) => [v.path, v.allowed, v.code]), [[DOWNLOADS, false, 'POLICY_UNREADABLE'], [ROOT, false, 'POLICY_UNREADABLE'], [gone, false, 'POLICY_UNREADABLE']]);
  assert.deepEqual(await scanAnswer(DOWNLOADS), { allowed: false, status: 500, code: 'POLICY_UNREADABLE', error: verdicts[0].error });
  assert.deepEqual(await scanAnswer(gone), { allowed: false, status: 500, code: 'POLICY_UNREADABLE', error: verdicts[2].error });
});

test('a folder the path rules refuse is refused with their code, as the scan refuses it; past 64 folders the request is refused', async () => {
  withPolicy(null);
  const bad = 'a\0b';
  const r = await policyFor([DOWNLOADS, bad]);
  const verdicts = r.body.scanRoots as Array<Record<string, unknown>>;
  assert.deepEqual(verdicts.map((v) => [v.path, v.allowed, v.code ?? null]), [[DOWNLOADS, true, null], [bad, false, 'PATH_INVALID']]);
  assert.deepEqual(await scanAnswer(bad), { allowed: false, status: 400, code: 'PATH_INVALID', error: verdicts[1].error });

  const many = await policyFor(Array.from({ length: 65 }, (_, i) => path.join(HOME, `f${i}`)));
  assert.deepEqual([many.status, many.body.code], [400, 'TOO_MANY_PATHS']);
  assert.equal((await policyFor(Array.from({ length: 64 }, (_, i) => path.join(HOME, `f${i}`)))).status, 200, 'control: 64 is answered');
});
