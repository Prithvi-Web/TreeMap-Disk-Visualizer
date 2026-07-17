import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { PRUNE_MAX_NODES } from '../src/api/scanRoutes';
import { createScanRecord } from '../src/services/diskScanner';
import { FileNode } from '../src/models/types';

/**
 * The tree that crosses to the UI, end to end through the real routes.
 *
 * The contract: a scan far too big to hand over whole still completes, still
 * tells the truth about sizes, and the detail it withheld is retrievable.
 */

/** root → `dirs` folders → `filesPer` files each. Folder N holds bigger files. */
function wideTree(dirs: number, filesPer: number): FileNode {
  const children: FileNode[] = [];
  for (let d = 0; d < dirs; d++) {
    const kids: FileNode[] = [];
    for (let f = 0; f < filesPer; f++) {
      kids.push({
        name: `f${f}.bin`, path: `/root/d${d}/f${f}.bin`,
        size: d + 1, type: 'file', modifiedAt: 0, isHidden: false,
      });
    }
    children.push({
      name: `d${d}`, path: `/root/d${d}`, type: 'dir', modifiedAt: 0, isHidden: false,
      size: kids.reduce((s, k) => s + k.size, 0),
      children: kids,
    });
  }
  return {
    name: 'root', path: '/root', type: 'dir', modifiedAt: 0, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0),
    children,
  };
}

function countNodes(n: FileNode): number {
  let total = 1;
  if (n.children) for (const c of n.children) total += countNodes(c);
  return total;
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function get(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let body: unknown = buf;
        try { body = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    }).on('error', reject);
  });
}

/** Read the progress stream to its final frame. */
function finalEvent(port: number, scanId: string, onFrame: (e: any) => void = () => {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let last: unknown = null;
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6));
          last = event;
          onFrame(event);
        }
      });
      res.on('end', () => resolve(last));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => reject(new Error('stream never closed')));
  });
}

// ~300k nodes: comfortably over the 250k budget, cheap to build.
const OVERSIZED_DIRS = 600;
const OVERSIZED_FILES = 500;

test('a scan far over the node budget completes with a bounded tree, not an error', async () => {
  const big = wideTree(OVERSIZED_DIRS, OVERSIZED_FILES);
  const trueNodes = countNodes(big);
  assert.ok(trueNodes > PRUNE_MAX_NODES, `fixture must exceed the budget (${trueNodes})`);

  const scan = createScanRecord('/root');
  const { port, close } = await listen();
  try {
    const last = await finalEvent(port, scan.scanId, (e) => {
      if (e.type === 'progress') { scan.status = 'complete'; scan.root = big; }
    });

    assert.equal(last.type, 'complete', 'an over-budget scan must still complete');
    const delivered = countNodes(last.root);
    assert.ok(delivered <= PRUNE_MAX_NODES + OVERSIZED_FILES + 1, `delivered ${delivered}, over budget`);
    assert.ok(delivered < trueNodes, 'the tree should actually have been pruned');
    // The whole point: magnitude survives even where detail did not.
    assert.equal(last.root.size, big.size, 'root size must stay exact');
  } finally {
    await close();
  }
});

test('pruned directories keep exact sizes and are marked, never half-filled', async () => {
  const big = wideTree(OVERSIZED_DIRS, OVERSIZED_FILES);
  const truth = new Map(big.children!.map((c) => [c.path, c]));

  const scan = createScanRecord('/root');
  const { port, close } = await listen();
  try {
    const last = await finalEvent(port, scan.scanId, (e) => {
      if (e.type === 'progress') { scan.status = 'complete'; scan.root = big; }
    });

    let pruned = 0, expanded = 0;
    for (const child of last.root.children as FileNode[]) {
      const real = truth.get(child.path)!;
      assert.equal(child.size, real.size, `${child.path} size drifted`);
      assert.ok(!(child.children && child.pruned), `${child.path}: both children and pruned`);
      if (child.pruned) { pruned++; assert.equal(child.children, undefined); }
      else { expanded++; assert.equal(child.children!.length, OVERSIZED_FILES, `${child.path} is half-filled`); }
    }
    assert.ok(pruned > 0, 'this fixture should have pruned some folders');
    assert.ok(expanded > 0, 'and fully expanded others');
    // Biggest-first: the largest folder (highest index) must be expanded.
    const biggest = last.root.children[last.root.children.length - 1];
    assert.ok(!biggest.pruned, 'the largest folder should never be the pruned one');
  } finally {
    await close();
  }
});

test('the subtree endpoint returns the detail that pruning withheld', async () => {
  const big = wideTree(OVERSIZED_DIRS, OVERSIZED_FILES);
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = big;

  const { port, close } = await listen();
  try {
    // d0 holds the smallest files, so it is the first thing pruning drops.
    const r = await get(port, `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/root/d0')}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.root.path, '/root/d0');
    assert.equal(r.body.root.children.length, OVERSIZED_FILES, 'drill-in must return the whole folder');
    assert.equal(r.body.root.pruned, undefined);
    assert.equal(r.body.root.size, big.children![0].size, 'size must match the scan');
  } finally {
    await close();
  }
});

test('the subtree endpoint honours its own node budget', async () => {
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = wideTree(10, 100);

  const { port, close } = await listen();
  try {
    const r = await get(port, `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/root')}&maxNodes=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.root.pruned, true, 'a budget of 1 must withhold everything below root');
    assert.equal(r.body.root.children, undefined);
    assert.equal(r.body.root.size, scan.root.size, 'and still report the true size');
  } finally {
    await close();
  }
});

test('the subtree endpoint rejects unknown and out-of-scope paths', async () => {
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = wideTree(2, 2);

  const { port, close } = await listen();
  try {
    const missing = await get(port, `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/root/nope')}`);
    assert.equal(missing.status, 404);

    const outside = await get(port, `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/etc')}`);
    assert.equal(outside.status, 403, 'a path outside the scan root must be refused');
  } finally {
    await close();
  }
});

test('the /result fallback is pruned to the same budget as the stream', async () => {
  const big = wideTree(OVERSIZED_DIRS, OVERSIZED_FILES);
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = big;
  scan.fileCount = OVERSIZED_DIRS * OVERSIZED_FILES;
  scan.dirCount = OVERSIZED_DIRS + 1;

  const { port, close } = await listen();
  try {
    const r = await get(port, `/api/scan/${scan.scanId}/result`);
    assert.equal(r.status, 200);
    const delivered = countNodes(r.body.root);
    assert.ok(delivered <= PRUNE_MAX_NODES + OVERSIZED_FILES + 1, `delivered ${delivered}, over budget`);
    assert.equal(r.body.root.size, big.size);
    // The exact counters must still describe the REAL scan, not the pruned copy.
    assert.equal(r.body.fileCount, OVERSIZED_DIRS * OVERSIZED_FILES);
    assert.equal(r.body.dirCount, OVERSIZED_DIRS + 1);
  } finally {
    await close();
  }
});
