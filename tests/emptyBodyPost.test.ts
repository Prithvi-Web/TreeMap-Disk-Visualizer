import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * A POST with no Content-Type must still get the route's own validation
 * error, never a 500.
 *
 * express@5 ships body-parser@2, which — unlike express 4 — leaves
 * `req.body` as `undefined` when the request's Content-Type does not match
 * the parser (no header at all, text/plain, a form post, a probe from curl).
 * Every handler in this codebase was written against the express-4
 * invariant and destructures the body on its first line
 * (`const { confirm } = req.body as ...`). Destructuring `undefined` throws
 * a TypeError, the error handler cannot recognise it, and the caller gets a
 * 500 INTERNAL where the API documents a 400 with a specific code.
 *
 * The routes below are all pure validators — each rejects before it touches
 * the filesystem, the Trash, or a snapshot — so exercising them here is
 * free of side effects.
 */

async function listen() {
  resetRateLimiter(); // suites share a process; don't inherit a drained bucket
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * POST with NO Content-Type and NO body — exactly what
 * `curl -X POST http://127.0.0.1:PORT/api/trash/empty` sends. Deliberately
 * not using JSON.stringify + a Content-Type header: the header is the whole
 * point of the trap.
 */
function postBare(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Length': '0' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* leave as text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed as any });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

/**
 * Every route here takes a JSON body and validates it on entry. `code` is
 * the documented 4xx code the route answers when that body is missing —
 * asserting the code, not merely "not 500", is what proves the request
 * reached the route's own validation branch rather than dying earlier.
 */
const BODY_ROUTES: { url: string; code: string }[] = [
  { url: '/api/trash/empty', code: 'CONFIRM_REQUIRED' },
  { url: '/api/system/snapshots/purge', code: 'CONFIRM_REQUIRED' },
  { url: '/api/system/snapshots/restore', code: 'PATH_REQUIRED' },
  { url: '/api/query/validate', code: 'QUERY_REQUIRED' },
  { url: '/api/nl-query', code: 'NL_TEXT_REQUIRED' },
  { url: '/api/cloud/connect/manual', code: 'INPUT_REQUIRED' },
];

test('POST with no Content-Type answers the route validation error, not 500', async () => {
  const srv = await listen();
  try {
    for (const route of BODY_ROUTES) {
      const res = await postBare(srv.port, route.url);
      assert.notEqual(res.status, 500, `${route.url} answered 500 (body: ${JSON.stringify(res.body)})`);
      assert.equal(res.status, 400, `${route.url} should answer 400, got ${res.status}`);
      assert.equal(res.body?.code, route.code, `${route.url} should answer code ${route.code}, got ${JSON.stringify(res.body)}`);
    }
  } finally {
    await srv.close();
  }
});

/**
 * The same trap with a body present but a Content-Type the JSON parser
 * skips. body-parser@2 leaves req.body undefined here too, so a client that
 * merely forgets the header — or sends a form post — must not be able to
 * 500 the server either.
 */
function postTyped(port: number, url: string, contentType: string, payload: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as any });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

test('POST with a non-JSON Content-Type answers the route validation error, not 500', async () => {
  const srv = await listen();
  try {
    for (const route of BODY_ROUTES) {
      const res = await postTyped(srv.port, route.url, 'text/plain', '{"confirm":true}');
      assert.notEqual(res.status, 500, `${route.url} answered 500 (body: ${JSON.stringify(res.body)})`);
      assert.equal(res.body?.code, route.code, `${route.url} should answer code ${route.code}, got ${JSON.stringify(res.body)}`);
    }
  } finally {
    await srv.close();
  }
});

/**
 * The other half of the invariant: filling in the missing body must never
 * touch a body the parser DID produce. The obvious wrong fix
 * (`req.body = {}` unconditionally, or `req.body ||= {}` placed before the
 * json parser) blanks every real request instead — and every route would
 * then answer its "you forgot the body" 400 forever, which no existing test
 * would notice because they all assert on 4xx codes for bad input.
 */
function postJson(port: number, url: string, body: unknown): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as any });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

test('a real JSON body still reaches the handler untouched', async () => {
  const srv = await listen();
  try {
    // A route that answers 200 only if it actually saw the body it was sent.
    const ok = await postJson(srv.port, '/api/query/validate', { q: 'size > 1mb' });
    assert.equal(ok.status, 200, `expected the parsed query to reach the handler, got ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body?.ok, true);

    // A second route, so the guard isn't resting on one handler's quirks:
    // sent a real body it must translate, never answer NL_TEXT_REQUIRED.
    const nl = await postJson(srv.port, '/api/nl-query', { text: 'big files' });
    assert.equal(nl.status, 200, `expected the parsed text to reach the handler, got ${JSON.stringify(nl.body)}`);
    assert.notEqual(nl.body?.code, 'NL_TEXT_REQUIRED', 'a present body was mistaken for a missing one');
  } finally {
    await srv.close();
  }
});
