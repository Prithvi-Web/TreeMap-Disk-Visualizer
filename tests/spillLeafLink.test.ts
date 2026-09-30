import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
// The security review's layout: app-data reached through a link of its own (moved to a bigger
// volume and linked back), so the last name of TREEMAP_DATA_DIR is the link and the folder is
// somewhere else. BASE holds both, as a home folder holds ~/Library.
const BASE = isolatedDataDir('treemap-spillLeafLink-');
const REAL = path.join(BASE, 'real-tm');
fs.mkdirSync(REAL);
fs.mkdirSync(path.join(BASE, 'Library'));
const LINK = path.join(BASE, 'Library', 'TreeMap');
fs.symlinkSync(REAL, LINK, 'junction');
process.env.TREEMAP_DATA_DIR = LINK;
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { setSpillCheckForTests } from '../src/services/autopilot';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { isSpillPath, spillCandidateTest } from '../src/utils/pathSanitizer';
import { SPILL_DIR } from '../src/services/spillSweep';

/**
 * Phase 4 T17a, the second security review (N1). Autopilot passes a candidate to the full
 * spill check only when it may be under app-data (`spillCandidateTest`), and that test once
 * compared the policy's folder and app-data with their last names as spelled — so with
 * app-data a link, the leftover in the real folder was never checked: listed as an item,
 * `skipped` empty. Now both folders are compared where they really are, and on any doubt
 * every candidate gets the full check. Nothing here deletes: every run is a simulation.
 */

const SPILL = path.join(REAL, SPILL_DIR);
fs.mkdirSync(SPILL, { mode: 0o700 });
const LEFTOVER = path.join(SPILL, '4247-1790656308811-3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab-names');
fs.writeFileSync(LEFTOVER, 'what a crash left');
fs.writeFileSync(path.join(REAL, 'kept.txt'), 'a file of app-data');
/** The user's own files beside app-data. */
const USER = path.join(BASE, 'user');
for (let i = 0; i < 10; i++) {
  fs.mkdirSync(path.join(USER, `f${i}`), { recursive: true });
  fs.writeFileSync(path.join(USER, `f${i}`, 'file.txt'), `file ${i}`);
}
/** The folder holding app-data, reached through a link of its own. */
const TO_BASE = path.join(fileTempDir('treemap-spillLeafLink-alias-'), 'to-base');
fs.symlinkSync(BASE, TO_BASE, 'junction');
/** BASE under a name only the file system folds (ſ for its first s), where the volume folds it. */
const LONG_S_BASE = path.join(path.dirname(BASE), path.basename(BASE).replace('s', 'ſ'));
const FOLDS_LONG_S = fs.existsSync(LONG_S_BASE);

let server: http.Server;
let port: number;

before(async () => {
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function simulate(root: string): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  const payload = JSON.stringify({ policy: { path: root, match: { kind: 'custom', minBytes: 1 } } });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/autopilot/simulate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('the spill folder is where app-data really is, whichever spelling a path takes', () => {
  assert.equal(isSpillPath(path.join(REAL, SPILL_DIR, 'x')), true, 'in the real folder');
  assert.equal(isSpillPath(path.join(LINK, SPILL_DIR, 'x')), true, 'through the link');
  assert.equal(isSpillPath(path.join(TO_BASE, 'real-tm', SPILL_DIR, 'x')), true, 'through a link to the folder holding it');
});

// A policy over a link is not here: a scan lists a link as itself, its own root included, and
// never walks through it.
test('Autopilot leaves the leftover alone over the folder holding the link, the real folder, and a folder spelled as only the volume reads it', async () => {
  const roots: [string, string][] = [
    [BASE, 'the folder holding app-data and its link'],
    [REAL, 'the real app-data folder'],
  ];
  if (FOLDS_LONG_S) roots.push([LONG_S_BASE, 'the folder holding app-data, spelled with ſ']);
  let full = 0;
  setSpillCheckForTests((p) => {
    full++;
    return isSpillPath(p);
  });
  try {
    for (const [root, what] of roots) {
      full = 0;
      const answer = await simulate(root);
      assert.equal(answer.status, 200, `${what}: ${JSON.stringify(answer.body).slice(0, 200)}`);
      const items = (answer.body.items as { path: string }[]).map((i) => i.path);
      assert.ok(items.length > 0, `${what}: the policy matched files (${items.length})`);
      assert.deepEqual(items.filter((p) => p.endsWith(path.basename(LEFTOVER))), [], `${what}: the leftover is not an item`);
      const left = (answer.body.skipped as { path: string; reason: string }[]).filter((s) => s.reason.includes(`TreeMap's own ${SPILL_DIR} folder`));
      assert.equal(left.length, 1, `${what}: the spill folder is named once as left alone`);
      assert.match(left[0].reason, /\(1 matched item\)/, what);
      // Counted: the full check ran for the candidates under the real app-data folder, as the
      // scan spells them, and for nothing else.
      const underAppData = root === REAL ? items.length : items.filter((p) => p.startsWith(path.join(root, 'real-tm') + path.sep)).length;
      assert.equal(full, underAppData + 1, `${what}: one full check per candidate under app-data, the leftover included, and none for the rest`);
    }
  } finally {
    setSpillCheckForTests(null);
  }
});

/** Thirty paths: ten under the real app-data folder, ten of the user's beside it, ten elsewhere. */
const SAMPLE = [
  ...Array.from({ length: 10 }, (_, i) => path.join(BASE, 'real-tm', `a${i}`, 'x.bin')),
  ...Array.from({ length: 10 }, (_, i) => path.join(USER, `f${i}`, 'file.txt')),
  ...Array.from({ length: 10 }, (_, i) => path.join(path.parse(BASE).root, 'elsewhere', `e${i}`)),
];
function passedOn(root: string): number {
  const mayBeInSpill = spillCandidateTest(root);
  return SAMPLE.filter((p) => mayBeInSpill(p)).length;
}

test('without a doubt the prefilter passes on exactly the paths under app-data', () => {
  assert.equal(passedOn(BASE), 10, 'a folder holding app-data: its ten');
  assert.equal(passedOn(USER), 0, 'a folder beside app-data: none');
  assert.equal(passedOn(REAL), SAMPLE.length, 'app-data itself: all of them');
});

test('on any doubt every path gets the full check (counted)', () => {
  const missing = path.join(BASE, 'no-such-folder');
  assert.equal(passedOn(missing), SAMPLE.length, 'a policy folder that cannot be resolved');
  assert.equal(passedOn('.'), SAMPLE.length, 'a policy folder that is not an absolute path');
  const saved = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = path.join(BASE, 'no-app-data-yet');
  try {
    assert.equal(passedOn(USER), SAMPLE.length, 'an app-data folder that cannot be resolved');
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
  }
});

const OTHER_VOLUME = process.platform === 'win32' ? null : '/dev';
const onAnotherVolume = OTHER_VOLUME !== null && fs.statSync(OTHER_VOLUME, { bigint: true }).dev !== fs.statSync(REAL, { bigint: true }).dev;

test('a policy folder on another volume than app-data is a doubt too (counted)', { skip: !onAnotherVolume && 'no second volume at a fixed path here' }, () => {
  // Whatever the two paths say, a mount, a junction or a firmlink can join two volumes.
  assert.equal(passedOn(OTHER_VOLUME as string), SAMPLE.length, `${OTHER_VOLUME}: every path`);
});
