import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-host-data-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { hostAllowed } from '../src/middleware/hostGuard';
import { bindDecision } from '../src/utils/bindPolicy';

/**
 * Three runtime defences the server used to leave to documentation:
 *
 *  - Host header: a DNS-rebinding page (evil.example re-resolving to
 *    127.0.0.1) makes a same-origin request as far as the browser is
 *    concerned, so CORS never applies. Proven on the isolated server before
 *    the fix: `Host: evil.example` POST /api/scan answered 202. Now every
 *    request to a loopback-bound server must name loopback (or the configured
 *    HOST) or it is 403 BAD_HOST before any route runs — the page included,
 *    because the page is what hands out the session cookie.
 *  - Content-Security-Policy on the page: the single-file, no-external-
 *    resources contract is now enforced by the browser on every load.
 *  - A non-loopback HOST with no TREEMAP_TOKEN refuses to start.
 */

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: any }

function req(port: number, method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function listen(opts?: { host?: string }): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(PUBLIC, opts));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* ───────────────────────────── Host header ───────────────────────────── */

test('hostAllowed: loopback names pass at any port, anything else is refused on a loopback bind', () => {
  for (const bind of ['127.0.0.1', 'localhost', '::1']) {
    for (const ok of ['127.0.0.1', '127.0.0.1:4280', 'localhost', 'localhost:1', 'LOCALHOST:4280', '[::1]', '[::1]:4280']) {
      assert.equal(hostAllowed(ok, bind), true, `${ok} on bind ${bind}`);
    }
    for (const bad of ['evil.example', 'evil.example:4280', '127.0.0.1.evil.example', 'localhost.evil.example', '', '10.0.0.5:4280', '[::2]:4280']) {
      assert.equal(hostAllowed(bad, bind), false, `${bad} on bind ${bind}`);
    }
  }
});

test('hostAllowed: the configured HOST is accepted alongside loopback; a wildcard bind accepts any name', () => {
  assert.equal(hostAllowed('192.168.1.5:4280', '192.168.1.5'), true, 'the bind address itself');
  assert.equal(hostAllowed('127.0.0.1:4280', '192.168.1.5'), true, 'loopback still works on the machine itself');
  assert.equal(hostAllowed('evil.example', '192.168.1.5'), false, 'anything else is still refused');
  assert.equal(hostAllowed('treemap.local:4280', 'treemap.local'), true, 'a hostname bind');
  // 0.0.0.0 / :: are reached under whatever name the network gives the machine
  // (Docker behind a proxy sets Host to the public name); the check cannot
  // know it, and security-electron-6 makes that profile carry a token.
  for (const wildcard of ['0.0.0.0', '::', '']) {
    assert.equal(hostAllowed('evil.example', wildcard), true, `wildcard bind ${JSON.stringify(wildcard)}`);
  }
});

test('a foreign Host header is refused before any route, page and API alike', async () => {
  const { port, close } = await listen({ host: '127.0.0.1' });
  try {
    const api = await req(port, 'POST', '/api/scan', { Host: 'evil.example', Origin: 'http://evil.example' }, { path: os.tmpdir() });
    assert.equal(api.status, 403, `rebinding request must be refused, got ${api.status} ${JSON.stringify(api.body)}`);
    assert.equal(api.body.code, 'BAD_HOST');

    const page = await req(port, 'GET', '/', { Host: 'evil.example' });
    assert.equal(page.status, 403, 'the page is what hands out the session cookie, so it is guarded too');

    const ok = await req(port, 'GET', '/api/system', { Host: `127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
    const okLocalhost = await req(port, 'GET', '/api/system', { Host: `localhost:${port}` });
    assert.equal(okLocalhost.status, 200);
    const okV6 = await req(port, 'GET', '/api/system', { Host: `[::1]:${port}` });
    assert.equal(okV6.status, 200);
  } finally {
    await close();
  }
});

test('createApp with no host option guards as a loopback server (every existing caller)', async () => {
  const { port, close } = await listen();
  try {
    const bad = await req(port, 'GET', '/api/system', { Host: 'evil.example' });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 'BAD_HOST');
    const good = await req(port, 'GET', '/api/system');
    assert.equal(good.status, 200, 'node sets Host to 127.0.0.1:<port> by default');
  } finally {
    await close();
  }
});

test('a wildcard bind does not guard the Host header (the proxy sets it)', async () => {
  const { port, close } = await listen({ host: '0.0.0.0' });
  try {
    const r = await req(port, 'GET', '/api/system', { Host: 'tools.example.com' });
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

/* ─────────────────────────────── CSP ─────────────────────────────── */

function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

test('the served page carries a Content-Security-Policy that pins it to itself', async () => {
  const { port, close } = await listen();
  try {
    const page = await req(port, 'GET', '/');
    assert.equal(page.status, 200);
    const csp = page.headers['content-security-policy'];
    assert.ok(typeof csp === 'string' && csp.length > 0, 'GET / must carry Content-Security-Policy');
    const d = directives(csp);
    assert.deepEqual(d.get('default-src'), ["'self'"]);
    assert.deepEqual(d.get('object-src'), ["'none'"]);
    assert.deepEqual(d.get('base-uri'), ["'none'"]);
    assert.deepEqual(d.get('connect-src'), ["'self'"], 'fetch/EventSource never leave the origin');
    assert.ok(d.get('script-src')?.includes("'self'") && d.get('script-src')?.includes("'unsafe-inline'"), 'the page is one inline file');
    assert.ok(d.get('style-src')?.includes("'unsafe-inline'"));
    assert.ok(d.get('img-src')?.includes('data:') && d.get('img-src')?.includes('blob:'), 'favicon and exports');
    assert.ok(d.get('font-src')?.includes('data:'));
    for (const [name, values] of d) {
      for (const v of values) {
        assert.ok(!/^https?:/i.test(v) && !v.includes('*'), `${name} must not open the door to a remote host: ${v}`);
      }
    }
    // The page builds a Worker from a blob: URL (the GIF encoder); without a
    // worker-src that allows blob:, worker-src falls back to script-src and
    // the export silently dies. The invariant is tied to the page, not to a
    // line of code: if the page stops building blob workers, this stops mattering.
    if (INDEX.includes('new Worker(')) {
      assert.ok(d.get('worker-src')?.includes('blob:'), 'the page builds a blob: Worker, so the CSP must allow it');
    }
    assert.ok(!page.headers['content-security-policy']?.includes('frame-ancestors'), 'frame-ancestors is opt-in: the VS Code extension frames this page');
  } finally {
    await close();
  }
});

test('JSON responses carry no CSP (there is nothing for a browser to apply it to)', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/system');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], undefined);
  } finally {
    await close();
  }
});

test('TREEMAP_FRAME_ANCESTORS adds a frame-ancestors directive for a hardened server profile', async () => {
  process.env.TREEMAP_FRAME_ANCESTORS = "'none'";
  try {
    const { port, close } = await listen();
    try {
      const page = await req(port, 'GET', '/');
      const d = directives(String(page.headers['content-security-policy']));
      assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);
    } finally {
      await close();
    }
  } finally {
    delete process.env.TREEMAP_FRAME_ANCESTORS;
  }
});

/* ───────────────────────── fail closed on a LAN bind ───────────────────────── */

test('bindDecision: a non-loopback HOST without a token refuses; a token or an explicit override allows', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const d = bindDecision({ host, token: undefined, insecure: undefined });
    assert.equal(d.ok, true, `${host} needs no token`);
    assert.equal(d.warning, undefined);
  }
  const refused = bindDecision({ host: '0.0.0.0', token: undefined, insecure: undefined });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /TREEMAP_TOKEN/, 'names the variable that fixes it');
  assert.match(refused.reason ?? '', /TREEMAP_INSECURE_BIND/, 'and the override');

  const withToken = bindDecision({ host: '0.0.0.0', token: 'long-random-secret', insecure: undefined });
  assert.equal(withToken.ok, true);
  assert.equal(withToken.warning, undefined);

  const blank = bindDecision({ host: '192.168.1.5', token: '   ', insecure: undefined });
  assert.equal(blank.ok, false, 'a whitespace token is no token');

  const override = bindDecision({ host: '0.0.0.0', token: undefined, insecure: '1' });
  assert.equal(override.ok, true);
  assert.match(override.warning ?? '', /anyone on the network/i, 'the override still says what it costs');
});

test('npm start with HOST=0.0.0.0 and no TREEMAP_TOKEN exits 2 before binding anything', { timeout: 120_000 }, () => {
  const repo = path.join(__dirname, '..');
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '0.0.0.0', PORT: '0', TREEMAP_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-bind-')) };
  delete env.TREEMAP_TOKEN;
  delete env.TREEMAP_INSECURE_BIND;
  const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, path.join(repo, 'src', 'index.ts')], { env, cwd: repo, encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 2, `expected exit 2, got ${String(r.status)} (signal ${String(r.signal)})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /TREEMAP_TOKEN/);
  assert.doesNotMatch(r.stdout, /TreeMap running/, 'it never listened');
});
