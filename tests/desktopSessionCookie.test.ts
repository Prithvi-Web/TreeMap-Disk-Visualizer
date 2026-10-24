import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-session-cookie-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { loadMain } from './fixtures/desktop/electronStub';

/**
 * Hunt C10: the desktop app's per-launch API token was handed to any local client that asked
 * for the UI page, because the page's cookie value WAS the token. Any process on the machine —
 * another account's included, the loopback interface being shared — could `GET /` and then drive
 * the API as the TreeMap user.
 *
 * Now the desktop shell opts in to a session cookie of its own (TREEMAP_SESSION_COOKIE): the
 * server hands no cookie to a page load, accepts as a session only a cookie of that separate
 * value, which is not the bearer token, and the shell puts that cookie into its own browser
 * session before it loads the page. `npm start` without the variable behaves as documented.
 */

const DESKTOP_ORIGIN = 'http://127.0.0.1:43210';

afterEach(() => {
  delete process.env.TREEMAP_TOKEN;
  delete process.env.TREEMAP_SESSION_COOKIE;
});

async function listen() {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function get(port: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    }).on('error', reject);
  });
}

test('with a session cookie configured, loading the page hands out nothing, and only that cookie — never the token in a cookie — is a session', async () => {
  process.env.TREEMAP_TOKEN = 'the-bearer-token';
  process.env.TREEMAP_SESSION_COOKIE = 'the-window-session';
  const srv = await listen();
  try {
    for (const page of ['/', '/index.html']) {
      const r = await get(srv.port, page);
      assert.equal(r.status, 200, `${page} is still served`);
      assert.equal(r.headers['set-cookie'], undefined, `${page}: a local client that loads the page gets no session`);
    }
    const answers = {
      none: (await get(srv.port, '/api/system')).status,
      session: (await get(srv.port, '/api/system', { Cookie: 'treemap_session=the-window-session' })).status,
      wrongSession: (await get(srv.port, '/api/system', { Cookie: 'treemap_session=guess' })).status,
      tokenAsCookie: (await get(srv.port, '/api/system', { Cookie: 'treemap_token=the-bearer-token' })).status,
      bearer: (await get(srv.port, '/api/system', { Authorization: 'Bearer the-bearer-token' })).status,
      sessionAsBearer: (await get(srv.port, '/api/system', { Authorization: 'Bearer the-window-session' })).status,
    };
    assert.deepEqual(answers, { none: 401, session: 200, wrongSession: 401, tokenAsCookie: 401, bearer: 200, sessionAsBearer: 401 });
  } finally {
    await srv.close();
  }
});

test('without one (the npm start profile), serving the page still sets the token cookie, as AGENTS.md documents', async () => {
  process.env.TREEMAP_TOKEN = 'the-bearer-token';
  const srv = await listen();
  try {
    const r = await get(srv.port, '/');
    assert.match(String(r.headers['set-cookie']), /^treemap_token=the-bearer-token;/);
  } finally {
    await srv.close();
  }
});

test('the desktop shell mints a session secret apart from the token and puts its cookie into its own session before the window loads the page', async () => {
  const h = await loadMain({ dataDir: fileTempDir('treemap-session-cookie-main-') });
  try {
    const call = h.stub.backend.startServerCalls[0];
    assert.ok(call, 'server started');
    assert.match(String(call.sessionAtStart), /^[0-9a-f]{64}$/, 'the server is started with the window session configured');
    assert.notEqual(call.sessionAtStart, call.tokenAtStart, 'the session is not the bearer token');
    assert.deepEqual(h.stub.session.defaultSession.cookiesSet, [{
      details: { url: DESKTOP_ORIGIN, name: 'treemap_session', value: call.sessionAtStart, httpOnly: true, sameSite: 'strict' },
      windowsLoaded: 0,
    }], 'one cookie, put in place before any window loaded a page');
    assert.equal(h.win().url, `${DESKTOP_ORIGIN}/`);
  } finally {
    h.dispose();
  }
});

test('the docs and the shell say how the desktop session works', () => {
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(agents, /\| `TREEMAP_SESSION_COOKIE` \|/, 'the variable is in the server-profile table');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /hands the page its own session\s*\/\/\s*cookie when it serves the UI/, 'the old comment, which described the hole, is gone');
});
