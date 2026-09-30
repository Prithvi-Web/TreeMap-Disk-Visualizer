import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Track U's measuring tools (bench/trackU/, plan U-0).
 *
 * The Track U gate reruns the diagnosis with the diagnosis's own instruments,
 * so what they record — and what they refuse to record — is pinned here. The
 * privacy rule they were written under is the reason most of this exists: a
 * log of a whole-disk scan names the owner's folders unless every path is cut
 * to its top-level folder before it is written, and a request log names them
 * unless a query string is reduced to its key names.
 */

const TOOLS = path.join(__dirname, '..', 'bench', 'trackU');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runApi = require(path.join(TOOLS, 'run-api.cjs')) as {
  sanitize: (s: unknown) => string;
  sanitizeJson: <T>(o: T) => T;
};

type Profile = { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>; startTime: number; samples: number[]; timeDeltas: number[] };
type EldLine = { t: number; kind: string; ms?: number; inflight?: string[] };
type StallReport = { stall: EldLine; samples: number; self: Map<string, number>; inclusive: Map<string, number> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prof = require(path.join(TOOLS, 'prof.cjs')) as {
  attributeStalls: (profile: Profile, eld: EldLine[], minStallMs: number) => StallReport[];
};

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Runs `node <args>` with this process's environment plus `extra`; resolves with its exit code and output. */
function runNode(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    // A hang guard, not a measurement: a tool that never exits fails here instead of holding the file open.
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`node ${args.join(' ')} did not exit: ${stderr}`)); }, 60_000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });
}

/* ══════════════ run-api: every path cut to its top-level folder ══════════════ */

/**
 * A path deeper than its top-level folder, as it would appear in a log line: a
 * slash, a name, a slash, and then anything but the ellipsis the sanitizer
 * leaves. `/Users/…` and `/Users` pass; `/Users/x` does not.
 */
const DEEP_PATH = /\/[^/\s"…]+\/(?!…)[^/\s"]/;

const TWELVE_PATHS = [
  '/Users/x/y',
  '/private/tmp/a',
  '/Volumes/Ext/z',
  '/Applications/Some App.app/Contents/MacOS',
  '/Library/Caches/com.example.cache',
  '/System/Volumes/Data/.Spotlight-V100',
  '/opt/homebrew/Cellar/node',
  '/usr/local/lib/node_modules',
  '/var/folders/ab/cd/T',
  '/tmp/scratch/file.txt',
  '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/secret.pages',
  '/private/var/db/diagnostics',
];

test('run-api\'s sanitizer writes no path deeper than its top-level folder', () => {
  assert.equal(TWELVE_PATHS.length, 12, 'the fixture is the twelve paths the plan names');
  for (const p of TWELVE_PATHS) {
    assert.match(p, DEEP_PATH, `the fixture path ${p} is itself deeper than its top-level folder, so the check can fail`);
    const out = runApi.sanitize(p);
    assert.doesNotMatch(out, DEEP_PATH, `${p} was written as ${out}`);
    const top = p.split('/')[1];
    assert.equal(out, `/${top}/…`, `${p} keeps exactly its top-level folder, marked as cut`);
  }
  assert.equal(runApi.sanitize('/Users'), '/Users', 'a top-level folder alone is kept as it is');

  // A path inside a JSON string — the stats and Missing GB bodies run-api saves — is cut at the string's end.
  const body = { rootPath: '/', currentPath: '/Users/x/y', nested: { examples: ['/private/tmp/a', '/Volumes/Ext/z'] }, note: 'scanning /Users/x/Library/Mobile Documents now' };
  const text = JSON.stringify(runApi.sanitizeJson(body));
  assert.doesNotMatch(text, DEEP_PATH, `the saved JSON names no deep path: ${text}`);
  const back = runApi.sanitizeJson(body) as typeof body;
  assert.equal(back.currentPath, '/Users/…');
  assert.deepEqual(back.nested.examples, ['/private/…', '/Volumes/…']);
  assert.equal(back.rootPath, '/', 'the scanned root itself is not a folder name and stays');
  assert.equal(back.note, 'scanning /Users/…', 'a path inside a sentence is cut too, to the end of the string');
});

/* ══════════════ eld: query keys, never their values ══════════════ */

test('eld logs query keys, never their values', async () => {
  const dir = scratch('treemap-trackU-eld-');
  try {
    const log = path.join(dir, 'eld.jsonl');
    // A server in a child, preloaded with eld exactly as the diagnosis ran it,
    // answering one request whose query names a folder.
    const script = [
      "const http = require('http');",
      "const s = http.createServer((req, res) => { res.end('ok'); });",
      "s.listen(0, '127.0.0.1', () => {",
      "  const port = s.address().port;",
      "  http.get({ host: '127.0.0.1', port, path: '/api/index/status?path=%2FUsers%2Fsecret-owner%2FDocuments&scanId=0f0e0d0c-0b0a-4908-8706-050403020100' }, (res) => {",
      "    res.resume();",
      "    res.on('end', () => s.close(() => process.exit(0)));",
      '  });',
      '});',
    ].join('\n');
    const run = await runNode(['--require', path.join(TOOLS, 'eld.cjs'), '-e', script], { ELD_LOG: log });
    assert.equal(run.code, 0, `the child ran: ${run.stderr}`);
    const text = fs.readFileSync(log, 'utf8');
    const reqs = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === 'req');
    assert.equal(reqs.length, 1, 'the one request is logged once');
    assert.equal(reqs[0].route, '/api/index/status', 'its route');
    assert.equal(reqs[0].keys, 'path,scanId', 'its query as key names only');
    assert.doesNotMatch(text, /secret-owner|Documents|%2F/, 'no query value reaches the log, encoded or not');
    assert.doesNotMatch(text, /0f0e0d0c/, 'nor an id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════════ prof: a sample inside a stall window, and none outside it ══════════════ */

test('prof attributes a sample inside a stall window and none outside it', () => {
  const frame = (functionName: string) => ({ functionName, url: `file:///app/dist/services/${functionName}.js`, lineNumber: 9 });
  // Three samples, one in each of three functions, 100 ms apart: at 10.1 s,
  // 10.2 s and 10.3 s after the epoch the eld log starts at.
  const profile: Profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3, 4] },
      { id: 2, callFrame: frame('before') },
      { id: 3, callFrame: frame('during') },
      { id: 4, callFrame: frame('after') },
    ],
    startTime: 0,
    samples: [2, 3, 4],
    timeDeltas: [100_000, 100_000, 100_000],
  };
  const eld: EldLine[] = [
    { t: 10_000, kind: 'start' },
    // A stall from 10.15 s to 10.25 s: only the second sample falls inside it.
    { t: 10_250, kind: 'stall', ms: 100, inflight: [] },
    // Shorter than the threshold: not reported at all.
    { t: 10_400, kind: 'stall', ms: 30, inflight: [] },
  ];
  const reports = prof.attributeStalls(profile, eld, 50);
  assert.equal(reports.length, 1, 'one stall is at least the threshold');
  const [r] = reports;
  assert.equal(r.samples, 1, 'exactly one sample lies inside the window');
  assert.deepEqual([...r.self.keys()].map((k) => k.split(' ')[0]), ['during'], 'and it is the one taken during the stall');
  assert.ok(![...r.inclusive.keys()].some((k) => /^(before|after) /.test(k)), 'the samples either side are not attributed to it');
});

/* ══════════════ index-poll: its port and job id come from its arguments ══════════════ */

test('index-poll takes its port and job id from its arguments and stops on a status other than running', async () => {
  const asked: string[] = [];
  const answers = [
    { status: 'running', phase: 'enumerating', processed: 5000 },
    { status: 'running', phase: 'summing', processed: 9000 },
    { status: 'complete', root: { path: '/x' } },
    { status: 'running', phase: 'never asked' },
  ];
  const server = http.createServer((req, res) => {
    asked.push(String(req.url));
    const body = answers[Math.min(asked.length - 1, answers.length - 1)];
    res.writeHead(body.status === 'running' ? 202 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const jobId = '3e817b26-0000-4000-8000-000000000001';
    // The last argument is the pause between polls in seconds: 0 here, 10 by default as the diagnosis ran it.
    const run = await runNode([path.join(TOOLS, 'index-poll.cjs'), String(port), jobId, '0']);
    assert.equal(run.code, 0, `index-poll exited cleanly: ${run.stderr}`);
    assert.deepEqual(asked, [1, 2, 3].map(() => `/api/index/${jobId}/result`), 'three polls of this job, then it stopped');
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 3, 'one line per poll');
    assert.match(lines[0], /^\d+ \d+(\.\d+)? running enumerating 5000/, 'epoch seconds, load, status, phase, processed');
    assert.match(lines[2], /^\d+ \d+(\.\d+)? complete/, 'the last line is the status that stopped it');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('index-poll refuses to start without a port and a job id', async () => {
  const run = await runNode([path.join(TOOLS, 'index-poll.cjs')]);
  assert.notEqual(run.code, 0, 'it exits with an error');
  assert.match(run.stderr, /usage: node index-poll\.cjs <port> <jobId>/, 'and says how to call it');
});
