import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-cors-body-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Hunt C85: with CORS on, the preflight did not allow the Idempotency-Key header AGENTS.md tells
 * clients to send, so the browser refused every destructive call carrying one, and
 * Idempotency-Replayed and Retry-After were never exposed to the page.
 *
 * Hunt C86: the JSON body parser's own client errors — a body over 1 MB (413), an unsupported
 * charset (415) — fell through to the generic branch and came back 500 INTERNAL, logged as
 * unhandled. They are now { error, code } with their own status.
 */

afterEach(() => { delete process.env.TREEMAP_ALLOWED_ORIGINS; });

async function listen() {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function send(port: number, method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: buf }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('a CORS preflight allows Idempotency-Key, and the replay and rate-limit headers are exposed to the page', async () => {
  process.env.TREEMAP_ALLOWED_ORIGINS = 'https://tools.example.com';
  const srv = await listen();
  try {
    const pre = await send(srv.port, 'OPTIONS', '/api/files', {
      Origin: 'https://tools.example.com',
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'content-type,idempotency-key',
    });
    assert.equal(pre.status, 204);
    const allowed = String(pre.headers['access-control-allow-headers']).toLowerCase().split(/,\s*/);
    for (const h of ['content-type', 'authorization', 'idempotency-key']) assert.ok(allowed.includes(h), `${h} is allowed: ${allowed}`);
    const real = await send(srv.port, 'GET', '/api/capabilities', { Origin: 'https://tools.example.com' });
    const exposed = String(real.headers['access-control-expose-headers']).toLowerCase().split(/,\s*/);
    for (const h of ['idempotency-replayed', 'retry-after']) assert.ok(exposed.includes(h), `${h} is exposed: ${exposed}`);
  } finally {
    await srv.close();
  }
});

test('a body over the parser\'s 1 MB limit is 413 BODY_TOO_LARGE and an unsupported charset 415, each { error, code }', async () => {
  const srv = await listen();
  try {
    const big = JSON.stringify({ scanId: 'x', paths: [Array.from({ length: 1_100_000 }, () => 'a').join('')], providers: ['size'] });
    const tooBig = await send(srv.port, 'POST', '/api/facts', { 'Content-Type': 'application/json' }, big);
    assert.equal(tooBig.status, 413, tooBig.text);
    const tooBigBody = JSON.parse(tooBig.text);
    assert.equal(tooBigBody.code, 'BODY_TOO_LARGE');
    assert.equal(typeof tooBigBody.error, 'string');
    const latin = await send(srv.port, 'POST', '/api/facts', { 'Content-Type': 'application/json; charset=latin1' }, '{}');
    assert.equal(latin.status, 415, latin.text);
    assert.equal(JSON.parse(latin.text).code, 'UNSUPPORTED_MEDIA_TYPE');
  } finally {
    await srv.close();
  }
});
