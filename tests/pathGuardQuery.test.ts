import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { guardQueryPath } from '../src/middleware/pathGuard';
import { errorHandler } from '../src/middleware/errorHandler';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode } from '../src/models/types';

/**
 * guardQueryPath has to survive express@5's `req.query` getter.
 *
 * express@5 does not store a query object on the request: `req.query` is a
 * getter that re-parses `req.url`'s query string on every single access and
 * returns a brand-new object each time (node_modules/express/lib/request.js).
 * So the guard's old `req.query[name] = clean` mutated a throwaway object and
 * every handler downstream read the RAW value — a single trailing slash on
 * ?path= reached findByPath un-trimmed and 404'd a subtree that plainly
 * existed. These tests pin the only thing that actually holds: the handler
 * must READ BACK the sanitised value, and everything else about the request
 * (other parameters, their order, their encoding, and the guard's rejections)
 * must be exactly as it was.
 */

/** An app that hands the handler's view of the request straight back. */
function echoApp(...params: string[]): express.Express {
  const app = express();
  // Mounted on a router, like the real routes are (app.use('/api', ...)), so
  // the rewrite is exercised against the mount-stripped `req.url` too.
  const router = express.Router();
  router.get('/echo', guardQueryPath(...params), (req: express.Request, res: express.Response) => {
    res.json({ query: req.query, url: req.url, originalUrl: req.originalUrl });
  });
  app.use('/api', router);
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** GET a RAW request target — no re-encoding, so the test controls the bytes. */
function get(port: number, target: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: target }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
        });
        res.on('end', () => {
          let body: unknown = buf;
          try {
            body = JSON.parse(buf);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on('error', reject);
  });
}

const TMP = os.tmpdir();

test('the handler reads back the SANITISED ?path=, not the raw one', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const raw = path.join(TMP, 'guard-scan', 'Media') + path.sep; // one trailing slash
    const res = await get(port, `/api/echo?path=${encodeURIComponent(raw)}`);
    assert.equal(res.status, 200);
    // path.resolve trims the trailing separator; that trimmed value is the
    // whole point of the guard, and it must be what the handler sees.
    assert.equal(res.body.query.path, path.resolve(raw));
    assert.notEqual(res.body.query.path, raw, 'the raw value must not survive');
  } finally {
    await close();
  }
});

test('every guarded parameter is rewritten, not just the first', async () => {
  const { port, close } = await listen(echoApp('path', 'root'));
  try {
    const p = path.join(TMP, 'a', 'b') + path.sep;
    const r = path.join(TMP, 'c') + path.sep;
    const res = await get(
      port,
      `/api/echo?path=${encodeURIComponent(p)}&root=${encodeURIComponent(r)}`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.query.path, path.resolve(p));
    assert.equal(res.body.query.root, path.resolve(r));
  } finally {
    await close();
  }
});

test('a "~" path is expanded for the handler, not left as a tilde', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const res = await get(port, `/api/echo?path=${encodeURIComponent('~/Documents')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.query.path, path.join(os.homedir(), 'Documents'));
  } finally {
    await close();
  }
});

test('other query parameters survive untouched — value, order and encoding', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const p = path.join(TMP, 'keep') + path.sep;
    const target =
      `/api/echo?maxNodes=500&path=${encodeURIComponent(p)}` +
      `&label=hello%20world&plus=a%2Bb&spaced=a+b&pathx=%2Fnot%2Fmine%2F&flag`;
    const res = await get(port, target);
    assert.equal(res.status, 200);

    assert.equal(res.body.query.path, path.resolve(p));
    assert.equal(res.body.query.maxNodes, '500');
    assert.equal(res.body.query.label, 'hello world');
    assert.equal(res.body.query.plus, 'a+b', 'a %2B must still decode to a plus, not a space');
    assert.equal(res.body.query.spaced, 'a b', 'a literal + must still decode to a space');
    assert.equal(res.body.query.pathx, '/not/mine/', 'a name the guard does not own is untouched');
    assert.equal(res.body.query.flag, '', 'a valueless parameter keeps its shape');

    // Order and raw bytes of the parameters we do not own are preserved.
    const search = String(res.body.url).slice(String(res.body.url).indexOf('?') + 1);
    const names = search.split('&').map((pair) => pair.split('=')[0]);
    assert.deepEqual(names, ['maxNodes', 'path', 'label', 'plus', 'spaced', 'pathx', 'flag']);
    assert.ok(search.includes('label=hello%20world'), `encoding changed: ${search}`);
    assert.ok(search.includes('plus=a%2Bb'), `encoding changed: ${search}`);
    assert.ok(search.includes('spaced=a+b'), `encoding changed: ${search}`);
    assert.ok(search.includes('pathx=%2Fnot%2Fmine%2F'), `encoding changed: ${search}`);
    assert.ok(search.endsWith('&flag'), `valueless parameter changed: ${search}`);
  } finally {
    await close();
  }
});

test('a path containing ?, # and % round-trips through the rewrite intact', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    // Every one of these is a legal filename character that would break a
    // naively re-assembled query string.
    const weird = path.join(TMP, 'a?b#c%d&e=f') + path.sep;
    const res = await get(port, `/api/echo?path=${encodeURIComponent(weird)}&after=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.query.path, path.resolve(weird));
    assert.equal(res.body.query.after, '1', 'the parameter after the weird path survived');
  } finally {
    await close();
  }
});

test('a fragment in the request target is not folded into the query', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const p = path.join(TMP, 'frag') + path.sep;
    const res = await get(port, `/api/echo?path=${encodeURIComponent(p)}#tail`);
    assert.equal(res.status, 200);
    // express parses the query up to the '#', so the guard must too — the
    // handler must not end up with "#tail" glued onto its path.
    assert.equal(res.body.query.path, path.resolve(p));
  } finally {
    await close();
  }
});

test('an empty query string is left alone', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const res = await get(port, '/api/echo');
    assert.equal(res.status, 200);
    assert.equal(res.body.query.path, undefined);
    assert.equal(res.body.url, '/echo', 'no query string must be invented');
  } finally {
    await close();
  }
});

test('rejections are unchanged: bad, empty, blocked and repeated paths still fail the same way', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const empty = await get(port, '/api/echo?path=');
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'PATH_INVALID');

    const nul = await get(port, '/api/echo?path=%2Ftmp%2Fa%00b');
    assert.equal(nul.status, 400);
    assert.equal(nul.body.code, 'PATH_INVALID');

    // Repeated parameters arrive as an array, which is not a string.
    const repeated = await get(port, '/api/echo?path=%2Ftmp%2Fa&path=%2Ftmp%2Fb');
    assert.equal(repeated.status, 400);
    assert.equal(repeated.body.code, 'PATH_INVALID');

    if (process.platform !== 'win32') {
      const blocked = await get(port, '/api/echo?path=%2Fproc%2Fself%2Fmem');
      assert.equal(blocked.status, 400);
      assert.equal(blocked.body.code, 'PATH_BLOCKED');
    }
  } finally {
    await close();
  }
});

test('a cloud:// path is passed through verbatim, still readable by the handler', async () => {
  const { port, close } = await listen(echoApp('path'));
  try {
    const res = await get(port, `/api/echo?path=${encodeURIComponent('cloud://gdrive/My Drive/x')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.query.path, 'cloud://gdrive/My Drive/x');
  } finally {
    await close();
  }
});

/** A two-file scan tree, enough for findByPath to have something to find. */
function tinyTree(root: string): FileNode {
  const media: FileNode = {
    name: 'Media',
    path: path.join(root, 'Media'),
    type: 'dir',
    size: 30,
    modifiedAt: 0,
    isHidden: false,
    children: [
      {
        name: 'clip.mov',
        path: path.join(root, 'Media', 'clip.mov'),
        size: 30,
        type: 'file',
        modifiedAt: 0,
        isHidden: false,
      },
    ],
  };
  return {
    name: path.basename(root),
    path: root,
    type: 'dir',
    size: 30,
    modifiedAt: 0,
    isHidden: false,
    children: [media],
  };
}

test('end to end: /scan/:id/subtree?path=.../Media/ (trailing slash) returns the subtree, not a 404', async () => {
  const root = path.join(TMP, 'treemap-guard-e2e');
  const scan = createScanRecord(root);
  scan.root = tinyTree(root);
  scan.status = 'complete';
  scan.finishedAt = Date.now();

  const { port, close } = await listen(createApp(path.join(__dirname, '..', 'public')));
  try {
    const target = path.join(root, 'Media');
    const clean = await get(port, `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent(target)}`);
    assert.equal(clean.status, 200, `control request failed: ${JSON.stringify(clean.body)}`);

    const slashed = await get(
      port,
      `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent(target + path.sep)}`
    );
    assert.equal(
      slashed.status,
      200,
      `a trailing slash must not 404: ${JSON.stringify(slashed.body)}`
    );
    assert.equal(slashed.body.root.path, target);
    assert.deepEqual(slashed.body.root, clean.body.root, 'both spellings must yield the same subtree');
  } finally {
    await close();
  }
});
