import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/**
 * Golden-response harness for the packed-store rewrite.
 *
 * Builds a deterministic fixture tree on disk, drives a REAL scan through the
 * public HTTP API of whatever server implementation it is handed, captures
 * every read endpoint the frontend consumes, and normalizes the volatile
 * parts. The same harness ran against the pre-rewrite baseline (v2.3.2,
 * commit 16ae5b8) to record tests/fixtures/golden/responses.json; the golden
 * test replays it against the current server and demands byte-identical
 * output. Deliberately imports nothing from src/ so both versions see the
 * exact same driver.
 *
 * Normalized: scanId, timestamps/durations, engine/ioThreads (machine
 * facts), accessedAt values (atime is best-effort by design — presence still
 * compares), and the fixture root path (replaced by <ROOT> so goldens don't
 * bake in a machine path). Everything else — structure, names, sizes,
 * mtimes, flags, child order, property order — must match exactly.
 *
 * Directory-listing order note: children ride in readdir order, which on
 * APFS is a deterministic function of the entry names — stable across runs
 * and macOS machines for this fixed fixture. (CI does not run tests.)
 */

const BASE_MS = 1700000000000; // 2023-11-14T22:13:20Z — fixed epoch for mtimes

/* --------------------------- fixture tree --------------------------- */

async function writeFileAt(p: string, bytes: number, stamp: number): Promise<void> {
  await fsp.writeFile(p, Buffer.alloc(bytes, 0x61));
  await fsp.utimes(p, new Date(stamp + 1000), new Date(stamp));
}

/** Deterministic fixture: ~220 nodes covering every field family the walker emits. */
export async function buildGoldenTree(root: string): Promise<void> {
  await fsp.rm(root, { recursive: true, force: true });
  const dirs = [
    'docs', 'docs/reports', 'media', 'media/pics', 'empty', '.hidden-dir', 'code',
    ...Array.from({ length: 8 }, (_, i) => `code/mod${i}`),
  ];
  await fsp.mkdir(root, { recursive: true });
  for (const d of dirs) await fsp.mkdir(path.join(root, d), { recursive: true });

  let stamp = BASE_MS;
  const file = (rel: string, bytes: number): Promise<void> =>
    writeFileAt(path.join(root, rel), bytes, (stamp += 60_000));

  for (let i = 0; i < 20; i++) await file(`docs/f${String(i).padStart(2, '0')}.txt`, 100 * (i + 1));
  await file('docs/résumé.txt', 777);
  await file('docs/NOEXT', 512);
  for (let i = 0; i < 5; i++) await file(`docs/reports/r${i}.pdf`, 5_000 + i);
  for (let i = 0; i < 10; i++) await file(`media/v${i}.mp4`, 1_000_000 * (i + 1));
  for (let i = 0; i < 30; i++) await file(`media/pics/p${String(i).padStart(2, '0')}.jpg`, 20_000 + i * 3);
  for (let d = 0; d < 8; d++) {
    for (let i = 0; i < 10; i++) await file(`code/mod${d}/s${i}.ts`, 1_000 + d * 100 + i);
  }
  await file('.hidden-dir/.secret', 42);
  await file('archive.zip', 123_456);

  // Hard links in the SAME directory: which twin dedups is decided by the
  // deterministic per-directory listing, not cross-directory worker races.
  await file('hard-a.bin', 9_999);
  await fsp.link(path.join(root, 'hard-a.bin'), path.join(root, 'hard-b.bin'));

  // A symlink (never followed, recorded as a leaf). Relative target, so its
  // on-disk size (the target string) is independent of where the fixture
  // lives; lutimes stamps the link itself — utimes would follow it.
  await fsp.symlink(path.join('docs', 'f00.txt'), path.join(root, 'link.txt'));
  await fsp.lutimes(path.join(root, 'link.txt'), new Date(BASE_MS + 2000), new Date(BASE_MS + 1000));

  // Stamp every directory's times last — creating entries bumps dir mtimes.
  let dirStamp = BASE_MS + 5_000_000;
  for (const d of [...dirs].reverse()) {
    await fsp.utimes(path.join(root, d), new Date(dirStamp + 1000), new Date(dirStamp));
    dirStamp += 60_000;
  }
  await fsp.utimes(root, new Date(dirStamp + 1000), new Date(dirStamp));
}

/* ----------------------------- http bits ----------------------------- */

interface Reply { status: number; body: unknown }

function request(port: number, method: string, url: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (buf += c));
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* raw text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Read the progress SSE until its final (complete/error) frame. */
function finalSseEvent(port: number, scanId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      let last: unknown = null;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              try { last = JSON.parse(line.slice(6)); } catch { /* keep-alive */ }
            }
          }
        }
      });
      res.on('end', () => resolve(last));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/* ---------------------------- normalization ---------------------------- */

const VOLATILE_NUMBERS = new Set(['startedAt', 'finishedAt', 'durationMs', 'tookMs']);

/** Scrub machine/run-specific values; structure and content stay exact. */
export function normalize(value: unknown, treeRoot: string): unknown {
  const fixString = (s: string): string => s.split(treeRoot).join('<ROOT>');
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'scanId') return '<SCAN>';
      if (key === 'engine') return '<ENGINE>';
      return fixString(v);
    }
    if (typeof v === 'number') {
      if (key !== undefined && VOLATILE_NUMBERS.has(key)) return 0;
      if (key === 'ioThreads') return 0;
      if (key === 'accessedAt') return 1; // best-effort atime: presence compares, value doesn't
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[fixString(k)] = walk(val, k);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/* ------------------------------ capture ------------------------------ */

type CreateApp = (publicDir: string) => Parameters<typeof http.createServer>[1];

/**
 * Scan the fixture and capture every golden endpoint, normalized. `dataDir`
 * must be fresh per run — budgets settings are written into it up front.
 */
export async function captureGolden(
  createApp: CreateApp,
  publicDir: string,
  treeRoot: string,
  dataDir: string,
): Promise<Record<string, unknown>> {
  process.env.TREEMAP_NO_GDU = '1'; // one deterministic engine on both versions
  process.env.TREEMAP_DATA_DIR = dataDir;
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      budgets: [
        { path: path.join(treeRoot, 'docs'), maxBytes: 10_000 },
        { path: path.join(treeRoot, 'media'), maxBytes: 999_999_999 },
      ],
    }),
  );

  const server = http.createServer(createApp(publicDir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  try {
    const started = await request(port, 'POST', '/api/scan', { path: treeRoot });
    if (started.status !== 202) throw new Error(`scan refused: ${JSON.stringify(started.body)}`);
    const scanId = (started.body as { scanId: string }).scanId;

    let result: Reply;
    for (let i = 0; ; i++) {
      result = await request(port, 'GET', `/api/scan/${scanId}/result`);
      if (result.status === 200 && (result.body as { status: string }).status === 'complete') break;
      if (i > 200) throw new Error(`scan never completed: ${JSON.stringify(result.body)}`);
      await new Promise((r) => setTimeout(r, 50));
    }

    const enc = encodeURIComponent;
    const codePath = path.join(treeRoot, 'code');
    const mediaPath = path.join(treeRoot, 'media');
    const captures: Record<string, unknown> = {
      result: result.body,
      sseComplete: await finalSseEvent(port, scanId),
      subtreeCode: (await request(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(codePath)}`)).body,
      subtreePruned: (await request(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(treeRoot)}&maxNodes=25`)).body,
      subtreeSingle: (await request(port, 'GET', `/api/scan/${scanId}/subtree?path=${enc(treeRoot)}&maxNodes=1`)).body,
      treemap: (await request(port, 'GET', `/api/scan/${scanId}/treemap?minSize=1&maxDepth=4`)).body,
      treemapMedia: (await request(port, 'GET', `/api/scan/${scanId}/treemap?minSize=1&maxDepth=3&root=${enc(mediaPath)}`)).body,
      largeFiles: (await request(port, 'GET', `/api/large-files?scanId=${scanId}&limit=10&minSize=1`)).body,
      fileTypes: (await request(port, 'GET', `/api/file-types?scanId=${scanId}`)).body,
      nodes: (await request(port, 'POST', `/api/scan/${scanId}/nodes`, {
        paths: [
          path.join(treeRoot, 'docs'),
          path.join(treeRoot, 'media', 'pics'),
          path.join(treeRoot, 'empty'),
          path.join(treeRoot, 'hard-b.bin'),
          path.join(treeRoot, 'definitely-missing.bin'),
        ],
      })).body,
      budgets: (await request(port, 'GET', `/api/scan/${scanId}/budgets`)).body,
    };

    return normalize(captures, treeRoot) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
