import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import type { Response } from 'express';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-treeFrame-data-');

import { buildPair, mutateBoth } from './fixtures/storeFuzz';
import { sseSend } from '../src/utils/sse';
import { ObjectScanStore, PackedScanStore, materializeBare, type NodeInput, type ScanStore } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';
import {
  TREE_CHUNK_CHARS,
  TREE_MARK,
  jsonAroundTree,
  sendPrunedTree,
  setTreeFrameMaxCharsForTests,
  treeFrameMaxChars,
  type TreeSink,
} from '../src/services/treeFrame';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { PRUNE_MAX_NODES } from '../src/api/scanRoutes';

/**
 * Phase 4 T9b: the first tree is sent from the store in chunks — no pruned
 * object tree, no one string of the whole frame, no buffer of it — and the
 * bytes are today's: `pruneStore`'s tree, serialized by `JSON.stringify`,
 * inside `sseSend`'s frame. The frame is refused, before a byte is written,
 * exactly when today's one string could not have been built. While the
 * socket takes each chunk the frame is written in one turn (one instant of
 * the store, as today); when it pushes back, nothing more is written until
 * it drains, and a closed socket ends the send.
 */

const STATS = { scanned: 3, fileCount: 2, dirCount: 1, engine: 'native', note: 'é "quoted" \\ \u2028 \t' };

/** Today's frame: the pruned tree built as objects, then the whole event serialized as one string. */
function todaysFrame(store: ScanStore, maxNodes: number, stats: unknown = STATS): string {
  const frames: string[] = [];
  const res = { write: (frame: string) => { frames.push(frame); return true; } } as unknown as Response;
  assert.ok(sseSend(res, { type: 'complete', root: store.prune(store.rootId, { maxNodes }).root, stats }));
  assert.equal(frames.length, 1);
  return frames[0];
}

/** A socket: records every chunk; `push(sink)` says whether it takes more. */
class Sink extends EventEmitter implements TreeSink {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  constructor(private readonly push: (sink: Sink) => boolean = () => true) {
    super();
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.push(this);
  }

  get text(): string {
    return this.chunks.join('');
  }
}

function sendFrame(sink: TreeSink, store: ScanStore, maxNodes: number, stats: unknown = STATS): Promise<'sent' | 'refused' | 'closed'> {
  const [before, after] = jsonAroundTree({ type: 'complete', root: TREE_MARK, stats });
  return sendPrunedTree(sink, store, store.rootId, maxNodes, `data: ${before}`, `${after}\n\n`);
}

test('the event splits around its tree exactly where the tree goes, and a value without exactly one tree mark is refused', () => {
  const tree = { name: 'x', path: '/x', children: [] };
  const [before, after] = jsonAroundTree({ type: 'complete', root: TREE_MARK, stats: STATS });
  assert.equal(before + JSON.stringify(tree) + after, JSON.stringify({ type: 'complete', root: tree, stats: STATS }));
  assert.throws(() => jsonAroundTree({ type: 'complete' }), /exactly once/);
  assert.throws(() => jsonAroundTree({ a: TREE_MARK, b: [TREE_MARK] }), /exactly once/);
});

test('the frame goes out byte for byte as today\'s one-string frame, on the fuzz trees at every budget, before and after watcher edits', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { obj, packed, rng } = buildPair(seed, seed, 300 + seed * 170);
    for (const round of ['as scanned', 'after edits']) {
      if (round === 'after edits') mutateBoth(obj, packed, rng);
      for (const store of [obj, packed]) {
        for (const maxNodes of [1, 2, 7, 20, 250, 20_000, PRUNE_MAX_NODES]) {
          const sink = new Sink();
          assert.equal(await sendFrame(sink, store, maxNodes), 'sent');
          assert.equal(sink.text, todaysFrame(store, maxNodes), `seed ${seed}, ${round}, ${store.constructor.name}, maxNodes ${maxNodes}`);
        }
      }
    }
  }
});

/** A store of one root holding `build`'s nodes, built alike in both stores. */
function storesOf(rootPath: string, sep: '/' | '\\', build: (add: (parent: number, input: NodeInput) => number) => void): ScanStore[] {
  const rootInput: NodeInput = { name: rootPath, isDir: true, size: 0, modifiedAt: 1_700_000_000_000, isHidden: false };
  const obj = new ObjectScanStore(rootPath, sep, rootInput);
  const packed = new PackedScanStore(rootPath, sep, rootInput);
  build((parent, input) => {
    const o = obj.addNode(parent, input);
    const p = packed.addNode(parent, input);
    assert.equal(o, p, 'the two stores number alike');
    return o;
  });
  for (const store of [obj, packed]) {
    store.finalize();
    store.sumSizes();
  }
  return [obj, packed];
}

const file = (name: string, size: number, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: false, size, modifiedAt: 1_700_000_000_123.5, isHidden: name.startsWith('.'), ...extra,
});
const dir = (name: string, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: true, size: 0, modifiedAt: 1_700_000_000_000, isHidden: name.startsWith('.'), ...extra,
});

test('names JSON must escape, virtual and container nodes, empty folders, a folder wider than the budget and the file-system roots go out as today', async () => {
  const shapes: Array<[string, '/' | '\\', (add: (parent: number, input: NodeInput) => number) => void]> = [
    ['/', '/', (add) => {
      const odd = add(0, dir('quote " back \\ slash'));
      add(odd, file('ctl\u0001\u001f.txt', 10, { extension: 'txt' }));
      add(odd, file('sep\u2028par\u2029.md', 11, { extension: 'md' }));
      add(odd, file('lone\uD800surrogate', 12));
      add(odd, file('emoji-😀.png', 13, { extension: 'png' }));
      add(odd, file('.hidden', 14, { accessedAt: 1_700_000_000_999 }));
      add(0, dir('empty'));
      const box = add(0, file('box.zip', 900, { extension: 'zip', container: 'zip' }));
      add(box, file('inside.txt', 400, { virtual: true, logicalSize: 1_000, extension: 'txt' }));
      const wide = add(0, dir('wide'));
      for (let i = 0; i < 300; i++) add(wide, file(`w${i}`, 1 + (i % 7)));
      add(0, file('link', 1, { isSymlink: true }));
      add(0, file('dup', 0, { hardlinkDuplicate: true }));
      add(0, file('cloud.doc', 5, { cloudPlaceholder: true, cloudProvider: 'icloud', extension: 'doc' }));
      add(0, dir('repo', { gitRepo: true }));
    }],
    ['C:\\', '\\', (add) => {
      const users = add(0, dir('Users'));
      add(users, file('ntuser.dat', 77, { extension: 'dat' }));
    }],
  ];
  for (const [rootPath, sep, build] of shapes) {
    for (const store of storesOf(rootPath, sep, build)) {
      for (const maxNodes of [1, 3, 5, 40, PRUNE_MAX_NODES]) {
        const sink = new Sink();
        assert.equal(await sendFrame(sink, store, maxNodes), 'sent');
        assert.equal(sink.text, todaysFrame(store, maxNodes), `${rootPath} ${store.constructor.name} maxNodes ${maxNodes}`);
      }
    }
  }
});

/** A root, `depth` folders one inside the next, and a file at the bottom. */
function chainStores(depth: number): ScanStore[] {
  return storesOf('/deep', '/', (add) => {
    let parent = 0;
    for (let level = 0; level < depth; level++) parent = add(parent, dir(`d${level}`));
    add(parent, file('bottom.txt', 42, { extension: 'txt' }));
  });
}

test('a chain of folders goes out as today\'s bytes where today\'s serialization reached, and far deeper, walked without recursion', async () => {
  for (const store of chainStores(200)) {
    const sink = new Sink();
    assert.equal(await sendFrame(sink, store, PRUNE_MAX_NODES), 'sent');
    assert.equal(sink.text, todaysFrame(store, PRUNE_MAX_NODES));
  }
  // Today's one string was built by a recursive JSON.stringify, which stops
  // near 950 levels in the app's Electron and near 3,100 in Node 24, and the
  // frame was then refused as "too large". This tree is deeper than both:
  // it goes out, and every level carries the bytes today's node had.
  const DEEP = 5_000;
  for (const store of chainStores(DEEP)) {
    const sink = new Sink();
    assert.equal(await sendFrame(sink, store, PRUNE_MAX_NODES), 'sent');
    let node = (JSON.parse(sink.text.slice('data: '.length)) as { root: FileNode }).root;
    let id = store.rootId;
    let levels = 0;
    for (;;) {
      const { children, ...own } = node;
      assert.equal(JSON.stringify(own), JSON.stringify(materializeBare(store, id, node.path)), `level ${levels}`);
      if (!children) break;
      assert.equal(Object.keys(node).at(-1), 'children', `level ${levels}: children last, as pruneStore adds them`);
      assert.equal(children.length, 1);
      node = children[0];
      id = store.childIds(id)[0];
      levels++;
    }
    assert.equal(levels, DEEP + 1, 'every folder and the file');
  }
});

test('the longest frame sent is V8\'s longest string, what today\'s one-string frame could reach', () => {
  assert.equal(treeFrameMaxChars(), constants.MAX_STRING_LENGTH);
});

test('a frame longer than one string can be is refused before a byte is written, and one exactly that long is sent', async (t) => {
  t.after(() => setTreeFrameMaxCharsForTests(null));
  const { packed } = buildPair(4, 4, 800);
  const frame = todaysFrame(packed, 250);
  setTreeFrameMaxCharsForTests(frame.length - 1);
  const refused = new Sink();
  assert.equal(await sendFrame(refused, packed, 250), 'refused');
  assert.equal(refused.chunks.length, 0, 'nothing written');
  setTreeFrameMaxCharsForTests(frame.length);
  const sent = new Sink();
  assert.equal(await sendFrame(sent, packed, 250), 'sent');
  assert.equal(sent.text, frame);
});

test('while the socket takes every chunk, the whole frame is written, in chunks, before the send returns', async () => {
  const { packed } = buildPair(6, 6, 3_000);
  const sink = new Sink();
  const sending = sendFrame(sink, packed, PRUNE_MAX_NODES);
  const frame = todaysFrame(packed, PRUNE_MAX_NODES);
  assert.equal(sink.text, frame, 'written in the same turn: one instant of the store');
  assert.ok(frame.length > 2 * TREE_CHUNK_CHARS, 'the fixture spans several chunks');
  assert.ok(sink.chunks.length > 1, 'in chunks, not one string');
  assert.ok(sink.chunks.every((chunk) => chunk.length <= TREE_CHUNK_CHARS + 8_192), 'no chunk much past the chunk size');
  assert.equal(await sending, 'sent');
});

test('when the socket pushes back, nothing more is written until it drains', async () => {
  const { packed } = buildPair(7, 7, 3_000);
  let full = false;
  let writtenWhileFull = 0;
  const sink = new Sink((s) => {
    if (full) writtenWhileFull++;
    full = true;
    setImmediate(() => {
      full = false;
      s.emit('drain');
    });
    return false;
  });
  assert.equal(await sendFrame(sink, packed, PRUNE_MAX_NODES), 'sent');
  assert.equal(writtenWhileFull, 0, 'a chunk was written before the socket drained');
  assert.ok(sink.chunks.length > 1);
  assert.equal(sink.text, todaysFrame(packed, PRUNE_MAX_NODES));
});

test('a socket that closes while the send waits for it ends the send, writing nothing more', async () => {
  const { packed } = buildPair(8, 8, 3_000);
  const sink = new Sink((s) => {
    setImmediate(() => {
      s.destroyed = true;
      s.emit('close');
    });
    return false;
  });
  assert.equal(await sendFrame(sink, packed, PRUNE_MAX_NODES), 'closed');
  assert.equal(sink.chunks.length, 1, 'the one chunk before the socket pushed back');
});

test('a socket that fails while the send waits for it ends the send, writing nothing more', async () => {
  const { packed } = buildPair(13, 13, 3_000);
  const sink = new Sink((s) => {
    setImmediate(() => s.emit('error', new Error('EPIPE')));
    return false;
  });
  assert.equal(await sendFrame(sink, packed, PRUNE_MAX_NODES), 'closed');
  assert.equal(sink.chunks.length, 1, 'the one chunk before the socket pushed back');
});

test('a socket already closed or ended is not written to', async () => {
  const { packed } = buildPair(9, 9, 200);
  const closed = new Sink();
  closed.destroyed = true;
  assert.equal(await sendFrame(closed, packed, 20), 'closed');
  assert.equal(closed.chunks.length, 0);
  const ended = new Sink();
  ended.writableEnded = true;
  assert.equal(await sendFrame(ended, packed, 20), 'closed');
  assert.equal(ended.chunks.length, 0);
});

/* ------------------------------ the routes ------------------------------ */

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function get(port: number, route: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function completedScan(store: ScanStore): string {
  const scan = createScanRecord(store.rootPath);
  scan.status = 'complete';
  scan.store = store;
  scan.fileCount = 3;
  scan.dirCount = 2;
  scan.scanned = 5;
  scan.finishedAt = scan.startedAt + 10;
  return scan.scanId;
}

test('the progress stream\'s complete frame and /result\'s tree are sent from the store, as today\'s bytes', async () => {
  const { packed } = buildPair(10, 10, 2_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    const stream = await get(port, `/api/scan/${scanId}/progress`);
    const frame = stream.body.slice(stream.body.indexOf('data: {"type":"complete"'));
    const event = JSON.parse(frame.slice('data: '.length)) as { stats: unknown };
    assert.equal(frame, todaysFrame(packed, PRUNE_MAX_NODES, event.stats));

    const result = await get(port, `/api/scan/${scanId}/result`);
    assert.equal(result.status, 200);
    assert.match(result.type, /^application\/json; charset=utf-8$/);
    const body = JSON.parse(result.body) as { root: unknown };
    assert.equal(result.body, JSON.stringify(body), 'compact JSON, keys in order');
    assert.equal(JSON.stringify(body.root), JSON.stringify(packed.prune(packed.rootId, { maxNodes: PRUNE_MAX_NODES }).root));
  } finally {
    await close();
  }
});

test('a reader that stops reading mid-frame gets exactly one complete frame, today\'s bytes, once it reads again', async () => {
  // Far more than the sockets between the two ends hold, so the send waits
  // for the reader across several of the stream's 150 ms ticks.
  const { packed } = buildPair(12, 12, 60_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
        res.pause();
        setTimeout(() => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { text += chunk; });
          res.on('end', () => resolve(text));
          res.on('error', reject);
          res.resume();
        }, 600);
      }).on('error', reject);
    });
    const frames = body.split('\n\n').filter((frame) => frame.startsWith('data: {"type":"complete"'));
    assert.equal(frames.length, 1, 'one complete frame');
    const stats = (JSON.parse(frames[0].slice('data: '.length)) as { stats: unknown }).stats;
    assert.equal(`${frames[0]}\n\n`, todaysFrame(packed, PRUNE_MAX_NODES, stats));
  } finally {
    await close();
  }
});

test('past the longest string, the stream says the scan is too large and /result fails as today\'s serialization failed', async (t) => {
  t.after(() => setTreeFrameMaxCharsForTests(null));
  const { packed } = buildPair(11, 11, 2_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    setTreeFrameMaxCharsForTests(1_000);
    const stream = await get(port, `/api/scan/${scanId}/progress`);
    assert.ok(!stream.body.includes('"type":"complete"'), 'no tree frame');
    assert.match(stream.body, /data: \{"type":"error","message":"This scan is too large to display/);
    const result = await get(port, `/api/scan/${scanId}/result`);
    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(result.body), { error: 'Internal server error', code: 'INTERNAL' });
  } finally {
    await close();
  }
});
