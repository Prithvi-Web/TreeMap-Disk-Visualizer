import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';

/**
 * Two integration inconsistencies the contract sweep found and left open.
 *
 * Both are the same species: the app is honest about a thing in one place and
 * silent about it in the neighbouring one, so a person reading the screen
 * draws a conclusion the system never stated.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: buf }));
    }).on('error', reject);
  });
}

/**
 * The dashboard fetches these three together, in one Promise.all, and reads a
 * field off each. They answered a running scan three different ways — two with
 * 202 "still working" and one with 409 SCAN_RUNNING — so the row could take an
 * error from one sibling while the other two were merely waiting. Whatever the
 * answer is, it has to be the SAME answer: this is one row, not three.
 */
test('the dashboard trio answers a running scan identically', async () => {
  const srv = await listen();
  try {
    const scan = createScanRecord('/tmp/consistency-probe');
    scan.status = 'running';
    const id = encodeURIComponent(scan.scanId);
    const paths = [
      `/api/large-files?scanId=${id}&limit=10&minSize=1`,
      `/api/file-types?scanId=${id}`,
      `/api/large-folders?scanId=${id}&limit=10`,
    ];
    const answers = [];
    for (const p of paths) answers.push(await get(srv.port, p));
    const statuses = answers.map((a) => a.status);
    assert.equal(new Set(statuses).size, 1,
      `one row, one answer — got ${paths.map((p, i) => `${p.split('?')[0]} → ${statuses[i]}`).join(', ')}`);
    assert.equal(statuses[0], 202, 'and it is the app\'s documented "still working" shape, which api() knows how to poll');
    for (const a of answers) {
      assert.equal(JSON.parse(a.body).status, 'running', 'each says which state it is in');
    }
  } finally {
    await srv.close();
  }
});

test('the trio documents the answer it actually gives', () => {
  const openapi = readFileSync(path.join(__dirname, '..', 'src', 'api', 'openapi.ts'), 'utf8');
  for (const route of ['/api/large-files', '/api/file-types', '/api/large-folders']) {
    const at = openapi.indexOf(`path: '${route}'`);
    assert.notEqual(at, -1, `${route} is in the spec`);
    const block = openapi.slice(at, at + 900);
    const responses = block.slice(block.indexOf('responses'), block.indexOf('},\n  {'));
    assert.match(responses, /'202': running202/,
      `${route} documents the 202 it can return — an undocumented status is a caller reading undefined`);
  }
});

/**
 * The dashboard must WAIT for a running scan rather than report it as a
 * failure: "Could not load stats" is wrong when the honest answer is "not yet".
 */
test('the dashboard trio polls instead of surfacing a running scan as an error', () => {
  const at = INDEX.indexOf('const [lf, ft, lfo] = await Promise.all([');
  assert.notEqual(at, -1, 'the dashboard still fetches the trio in one Promise.all');
  const call = INDEX.slice(at, INDEX.indexOf(']);', at));
  const fetches = call.match(/api\(`\/api\/(large-files|file-types|large-folders)[^`]*`[^)]*\)/g) || [];
  assert.equal(fetches.length, 3, 'all three are fetched together');
  for (const f of fetches) {
    assert.match(f, /poll:\s*true/, `${f.slice(0, 40)}… waits the scan out instead of reading an undefined field`);
  }
});

/**
 * Dismissing the progress dialog is not cancelling the job — the copy keeps
 * running and its stream keeps reporting. The dialog has a Cancel button for
 * stopping it. Left silent, a scrim tap reads as "stopped", which is the one
 * reading that could cost someone their files' whereabouts.
 */
test('dismissing the job dialog says the job is still running', () => {
  const hook = INDEX.slice(INDEX.indexOf("if (id === 'offloadModal')"), INDEX.indexOf("if (id === 'offloadModal')") + 900);
  assert.ok(hook, 'the offloadModal close hook exists');
  assert.match(hook, /activeJob/,
    'the hook can tell a dismissal (job still live) from a completion (done() clears it first)');
  assert.match(hook, /toast\(/, 'and it says so rather than letting the dialog vanish silently');
  assert.ok(!/cancelUrl|\/cancel/.test(hook),
    'dismissing must NOT cancel the job — that is what the Cancel button is for');
});
