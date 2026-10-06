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
import { aliasNamespaceOf, foldName, isSpillPath, spillCandidateTest, win32Normalize } from '../src/utils/pathSanitizer';
import { isThisMachine } from '../src/utils/win32Host';
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

/* ═══════════ Windows' name folding, whichever separator spells the path (POL item 8) ═══════════ */

test('Windows’ trailing dots and spaces come off every name, whichever separator spells the path — a backslash path folds exactly as before (POL item 8)', () => {
  // The tests stand Windows in for process.platform while Node's path module
  // stays this OS's, so a path reaching the fold under that stand-in is spelled
  // with "/". Split on "\\" alone, it lost the dots and spaces of its last name
  // only: "/x/scan./appdata" kept the dot that "/x/scan." lost.
  assert.deepEqual({
    windows: win32Normalize('C:\\Windows\\System32 \\Drivers. \\x. '),
    windowsDots: win32Normalize('C:\\a..\\. \\b'),
    posixSpelled: win32Normalize('/Var/TM/scan. /data. /f '),
    mixed: win32Normalize('C:/Users. \\Me /x.'),
    inside: win32Normalize('/a.b/c d/e'),
  }, {
    windows: 'c:\\windows\\system32\\drivers\\x',
    windowsDots: 'c:\\a\\\\b',
    posixSpelled: '/var/tm/scan/data/f',
    mixed: 'c:/users\\me/x',
    inside: '/a.b/c d/e',
  });
});

test('nothing in the app trims a run of dots and spaces with a regex anchored at a name’s end — that backtracks once per character of a long run inside a name, so one request path could hold the server for seconds — and the loops that do it read every name as before (POL item 8 review, F1.4 and F1.7)', () => {
  // A structural guard, because the repo counts rather than times and no output can tell the two forms
  // apart: over every string up to length 7 the regex and the loop agree. `[ .]+$`, `[ .]+(?=…)` and
  // their spellings (`[. ]`, `*`) are the shape: a greedy run that can fail after it, tried from each
  // start in the run.
  const shape = /\[(?: \.|\. )\][+*](?:\$|\(\?=)/;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (/\.(?:ts|js)$/.test(entry.name)) files.push(at);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.ok(files.length > 50, 'the whole of src/ was read');
  const offenders = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')
    .map((line, i) => (shape.test(line) ? `${path.relative(path.join(__dirname, '..'), f)}:${i + 1}: ${line.trim()}` : null))
    .filter((hit): hit is string => hit !== null));
  assert.deepEqual(offenders, []);
  // The loops read names as the regexes did: every name's trailing run goes, and nothing inside it.
  assert.deepEqual({
    fold: foldName('Scan-Spill. . ', 'win32'),
    foldInside: foldName('a . b. .', 'win32'),
    foldAllDots: foldName('. .', 'win32'),
    foldLeading: foldName(' .x', 'win32'),
    foldElsewhere: foldName('TreeMap. .', 'linux'),
    // A host keeps at least one character: `.` alone is this machine, and so is any run of dots and spaces.
    hostDotsAndSpaces: isThisMachine('. .', []),
    hostTrailing: isThisMachine('LOCALHOST. .', []),
    hostOther: isThisMachine('server. ', ['mypc']),
    hostSpace: isThisMachine(' ', []),
    // An admin share's name loses its trailing dots and spaces too: `C$. .` is `C$`.
    adminShare: aliasNamespaceOf('\\\\localhost\\C$. .\\x', 'win32', []),
    notAdminShare: aliasNamespaceOf('\\\\localhost\\C$x. \\x', 'win32', []),
  }, {
    fold: 'scan-spill',
    foldInside: 'a . b',
    foldAllDots: '',
    foldLeading: ' .x',
    foldElsewhere: 'treemap. .',
    hostDotsAndSpaces: true,
    hostTrailing: true,
    hostOther: false,
    hostSpace: false,
    adminShare: '\\\\localhost\\C$. .',
    notAdminShare: null,
  });
});

test('with Windows stood in for process.platform, the Autopilot prefilter finds app-data inside a scanned folder whose name ends in a dot, as Windows reads the names; on this machine itself nothing changes (POL item 8)', { skip: process.platform === 'win32' && 'a name ending in a dot cannot be made through the Windows API' }, () => {
  const base = fs.realpathSync(fileTempDir('tm-spill-dot-'));
  const scanned = path.join(base, 'scan.');
  const appData = path.join(scanned, 'appdata');
  fs.mkdirSync(appData, { recursive: true });
  const leftover = path.join(appData, SPILL_DIR, 'x.bin');
  const saved = process.env.TREEMAP_DATA_DIR;
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  process.env.TREEMAP_DATA_DIR = appData;
  let here: boolean;
  let asWindows: boolean;
  try {
    here = spillCandidateTest(scanned)(leftover);
    Object.defineProperty(process, 'platform', { ...real, value: 'win32' });
    try {
      asWindows = spillCandidateTest(scanned)(leftover);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  } finally {
    process.env.TREEMAP_DATA_DIR = saved;
  }
  assert.deepEqual({ here, asWindows }, { here: true, asWindows: true }, 'a path in the spill folder is passed on for the full check');
});
