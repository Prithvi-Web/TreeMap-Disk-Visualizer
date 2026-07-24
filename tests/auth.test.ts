import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Auth (TREEMAP_TOKEN) and CORS (TREEMAP_ALLOWED_ORIGINS) — both opt-in.
 * The invariant that matters most: with neither env var set, behavior is
 * byte-identical to the historical server (no auth, no CORS headers), and
 * with a token set the served human UI keeps working via its auto-set
 * cookie while bare API calls get an honest 401.
 */

afterEach(() => {
  delete process.env.TREEMAP_TOKEN;
  delete process.env.TREEMAP_ALLOWED_ORIGINS;
});

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function req(port: number, method: string, url: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

/* --------------------- no env vars: today's behavior --------------------- */

test('with no env vars, the API is open and emits no CORS or auth headers', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/system', { Origin: 'http://evil.example' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS header when unconfigured');
    assert.equal(r.headers['www-authenticate'], undefined);

    const page = await req(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['set-cookie'], undefined, 'no auth cookie when unconfigured');
  } finally {
    await close();
  }
});

/* ------------------------------ token auth ------------------------------ */

test('with TREEMAP_TOKEN set, bare /api calls get a { error, code } 401', async () => {
  process.env.TREEMAP_TOKEN = 'secret-token-1';
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/system');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'UNAUTHORIZED');
    assert.equal(typeof r.body.error, 'string');
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  } finally {
    await close();
  }
});

test('the right bearer token opens the API; a wrong one does not', async () => {
  process.env.TREEMAP_TOKEN = 'secret-token-2';
  const { port, close } = await listen();
  try {
    const good = await req(port, 'GET', '/api/system', { Authorization: 'Bearer secret-token-2' });
    assert.equal(good.status, 200);
    assert.equal(good.body.platform, process.platform);

    const bad = await req(port, 'GET', '/api/system', { Authorization: 'Bearer wrong' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'UNAUTHORIZED');
  } finally {
    await close();
  }
});

test('the served UI still works: page load sets the cookie and the cookie opens the API', async () => {
  process.env.TREEMAP_TOKEN = 'secret token/with specials';
  const { port, close } = await listen();
  try {
    const page = await req(port, 'GET', '/');
    assert.equal(page.status, 200, 'the UI page itself is served');
    const setCookie = page.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1, 'page load sets the session cookie');
    assert.match(setCookie[0], /^treemap_token=/);
    assert.match(setCookie[0], /HttpOnly/);
    assert.match(setCookie[0], /SameSite=Strict/);

    // The browser would replay exactly this cookie on fetch() and EventSource.
    const cookie = setCookie[0].split(';')[0];
    const r = await req(port, 'GET', '/api/system', { Cookie: cookie });
    assert.equal(r.status, 200, 'the cookie authenticates API calls');

    const sse = await req(port, 'GET', '/api/scan/nope/progress', { Cookie: cookie });
    assert.equal(sse.status, 404, 'SSE routes see an authenticated request (404 = past auth, unknown scan)');
  } finally {
    await close();
  }
});

test('static assets are still served without auth (only /api is gated)', async () => {
  process.env.TREEMAP_TOKEN = 'secret-token-3';
  const { port, close } = await listen();
  try {
    const page = await req(port, 'GET', '/');
    assert.equal(page.status, 200);
  } finally {
    await close();
  }
});

/* --------------------------------- CORS --------------------------------- */

test('allowed origins get CORS headers; others and preflights behave', async () => {
  process.env.TREEMAP_ALLOWED_ORIGINS = 'http://a.example, https://b.example';
  const { port, close } = await listen();
  try {
    const allowed = await req(port, 'GET', '/api/system', { Origin: 'https://b.example' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://b.example');

    const denied = await req(port, 'GET', '/api/system', { Origin: 'http://evil.example' });
    assert.equal(denied.status, 200, 'non-browser clients are unaffected');
    assert.equal(denied.headers['access-control-allow-origin'], undefined);

    const preflight = await req(port, 'OPTIONS', '/api/scan', {
      Origin: 'http://a.example',
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://a.example');
    assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/);
  } finally {
    await close();
  }
});

test('preflights pass without a token even when auth is on (browsers omit credentials there)', async () => {
  process.env.TREEMAP_TOKEN = 'secret-token-4';
  process.env.TREEMAP_ALLOWED_ORIGINS = 'http://a.example';
  const { port, close } = await listen();
  try {
    const preflight = await req(port, 'OPTIONS', '/api/scan', {
      Origin: 'http://a.example',
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(preflight.status, 204, 'preflight must not be blocked by auth');

    const real = await req(port, 'GET', '/api/system', { Origin: 'http://a.example' });
    assert.equal(real.status, 401, 'the real request still needs the token');
  } finally {
    await close();
  }
});

/* --------------------------- discoverability --------------------------- */

test('capabilities reports the live auth and CORS state', async () => {
  const { port, close } = await listen();
  try {
    const off = await req(port, 'GET', '/api/capabilities');
    assert.equal(off.body.auth.enabled, false);
    assert.equal(off.body.cors.enabled, false);
  } finally {
    await close();
  }

  process.env.TREEMAP_TOKEN = 'secret-token-5';
  const gated = await listen();
  try {
    const r = await req(gated.port, 'GET', '/api/capabilities', { Authorization: 'Bearer secret-token-5' });
    assert.equal(r.status, 200);
    assert.equal(r.body.auth.enabled, true);
    assert.equal(r.body.auth.unauthorized.code, 'UNAUTHORIZED');
  } finally {
    await gated.close();
  }
});
