import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import type { Response } from 'express';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-frameBuild-data-');

import { HANG_GUARD_MS, waitFor, withinHangGuard } from './fixtures/waitFor';
import { buildPair } from './fixtures/storeFuzz';
import { sseSend } from '../src/utils/sse';
import { ObjectScanStore, PackedScanStore, type NodeInput, type ScanStore } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';
import type { Overshoot } from '../src/utils/pruneTree';
import {
  FRAME_ATTEMPTS,
  FRAME_BUFFER_MAX,
  FRAME_YIELD_NODES,
  TREE_CHUNK_CHARS,
  TREE_MARK,
  frameBuildStats,
  jsonAroundTree,
  sendPrunedTree,
  setFrameBufferMaxForTests,
  setFrameYieldForTests,
  setTreeFrameMaxCharsForTests,
  type FrameBuildStats,
  type SendTreeOptions,
  type TreeSendOutcome,
  type TreeSink,
} from '../src/services/treeFrame';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { PRUNE_MAX_NODES, sendFinalEvent } from '../src/api/scanRoutes';

/**
 * Plan U-18 (decision U-D10): the first frame is built in slices, a small
 * frame is built once for every reader that arrives while it is being built,
 * and no frame is kept once it is sent.
 *
 * Before, `sendPrunedTree` counted the frame in one synchronous pass (0.75 s
 * at load 9 and 3.6 s at load 25 on the diagnosis Mac, for 671,545 nodes) and
 * then wrote it in a second, and every reader paid both. Now:
 *
 *  - the count runs in slices of FRAME_YIELD_NODES nodes and yields between
 *    them, under the store's version: a change before the first byte counts
 *    again, at most FRAME_ATTEMPTS times, the last in one turn (U-D9);
 *  - a tree whose JSON is at most FRAME_BUFFER_MAX characters is gathered as
 *    chunks during that same count and written from them, with no second
 *    pass; readers that arrive while it is counted share it, and it is let go
 *    when the last of them is served;
 *  - past the cap the count holds nothing, and each reader writes its frame
 *    from the store as T9b does, with its backpressure and close handling.
 *
 * Every assertion counts: builds, attempts, yields, frames written each way,
 * characters held. Nothing is timed.
 */

const STATS = { scanned: 3, fileCount: 2, dirCount: 1, engine: 'native', note: 'é "quoted" \\ \u2028 \t' };

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Today's frame: the pruned tree built as objects, then the whole event serialized as one string. */
function todaysFrame(store: ScanStore, maxNodes: number, stats: unknown = STATS, overshoot: Overshoot = 'lastFolder'): string {
  const frames: string[] = [];
  const res = { write: (frame: string) => { frames.push(frame); return true; } } as unknown as Response;
  assert.ok(sseSend(res, { type: 'complete', root: store.prune(store.rootId, { maxNodes, overshoot }).root, stats }));
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

interface SendCase extends SendTreeOptions {
  stats?: unknown;
  maxNodes?: number;
}

/** The progress stream's frame of `store`'s tree, sent to `sink`. */
function send(sink: TreeSink, store: ScanStore, options: SendCase = {}): Promise<TreeSendOutcome> {
  const { stats = STATS, maxNodes = PRUNE_MAX_NODES, ...rest } = options;
  const [before, after] = jsonAroundTree({ type: 'complete', root: TREE_MARK, stats });
  return sendPrunedTree(sink, store, store.rootId, maxNodes, `data: ${before}`, `${after}\n\n`, rest);
}

/** What changed in the counters since `before`; `heldChars` and `waiting` as they stand. */
function since(before: FrameBuildStats): FrameBuildStats {
  const now = frameBuildStats();
  return {
    builds: now.builds - before.builds,
    attempts: now.attempts - before.attempts,
    buffered: now.buffered - before.buffered,
    streamed: now.streamed - before.streamed,
    heldChars: now.heldChars,
    waiting: now.waiting,
  };
}

const file = (name: string, size: number): NodeInput => ({ name, isDir: false, size, modifiedAt: 1_700_000_000_000, isHidden: false });
const dir = (name: string): NodeInput => ({ name, isDir: true, size: 0, modifiedAt: 1_700_000_000_000, isHidden: false });

/** Characters of `store`'s pruned tree's JSON. */
function treeChars(store: ScanStore, maxNodes: number): number {
  return JSON.stringify(store.prune(store.rootId, { maxNodes }).root).length;
}

/** A packed store whose `failAt`th node made (counting from 1) throws, as a store whose disk went away might. */
class FailingStore extends PackedScanStore {
  failAt = -1;
  private made = 0;

  override bareNode(id: number, knownPath?: string): FileNode {
    if (this.failAt > 0 && ++this.made === this.failAt) throw new Error('the disk went away');
    return super.bareNode(id, knownPath);
  }
}

/** A root of 7 folders of 2,856 files: 20,000 nodes. */
function twentyThousand(store = new PackedScanStore('/twenty', '/', dir('/twenty'))): PackedScanStore {
  for (let d = 0; d < 7; d++) {
    const folder = store.addNode(0, dir(`d${d}`));
    for (let i = 0; i < 2_856; i++) store.addNode(folder, file(`f${i}`, 1 + ((d * 7 + i) % 97)));
  }
  store.finalize();
  store.sumSizes();
  return store;
}

function failingStore(): FailingStore {
  return twentyThousand(new FailingStore('/twenty', '/', dir('/twenty'))) as FailingStore;
}

test("the plan's numbers: a yield every 4,096 nodes, a frame of up to 32 MiB of JSON built once, three attempts", () => {
  assert.equal(FRAME_YIELD_NODES, 4_096);
  assert.equal(FRAME_BUFFER_MAX, 32 * 1024 * 1024);
  assert.equal(FRAME_ATTEMPTS, 3);
});

/* ------------------------------ one count ------------------------------ */

test('readers that arrive while a small frame is counted share the one count, each written from its chunks with its own head and tail, and nothing is held once the last is served', async () => {
  const { packed } = buildPair(21, 21, 9_000);
  const before = frameBuildStats();
  assert.equal(before.heldChars, 0, 'nothing held before');
  const stats = [STATS, { ...STATS, scanned: 4 }, { other: 'ü' }];
  const sinks = stats.map(() => new Sink());
  const sends = sinks.map((sink, i) => send(sink, packed, { stats: stats[i] }));
  const during = since(before);
  assert.equal(during.builds, 1, 'one count for the three');
  assert.equal(during.waiting, 3, 'all three wait on it');
  assert.ok(during.heldChars > 0, `the chunks gathered so far are held while it runs (${during.heldChars})`);
  assert.deepEqual(await Promise.all(sends), ['sent', 'sent', 'sent']);
  sinks.forEach((sink, i) => assert.equal(sink.text, todaysFrame(packed, PRUNE_MAX_NODES, stats[i]), `reader ${i}: its own bytes`));
  const after = since(before);
  assert.equal(after.builds, 1);
  assert.equal(after.buffered, 3, 'each written from the one count\'s chunks');
  assert.equal(after.streamed, 0, 'none counted again to be written');
  assert.equal(after.heldChars, 0, 'nothing kept once the last reader is served');
  assert.equal(after.waiting, 0);
});

test('a reader that comes after a frame was sent counts it again: no frame is kept', async () => {
  const { packed } = buildPair(22, 22, 5_000);
  const before = frameBuildStats();
  const first = new Sink();
  assert.equal(await send(first, packed), 'sent');
  assert.equal(frameBuildStats().heldChars, 0, 'nothing held once the first is sent');
  const second = new Sink();
  assert.equal(await send(second, packed), 'sent');
  assert.equal(second.text, first.text);
  assert.equal(since(before).builds, 2, 'two counts');
  assert.equal(frameBuildStats().heldChars, 0);
});

test('past the buffer cap the count holds nothing, and readers that arrived together each write their frame from the store', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  const { packed } = buildPair(23, 23, 9_000);
  const frame = todaysFrame(packed, PRUNE_MAX_NODES);
  // The first slice (4,096 of 9,000 nodes) fits under this cap; the whole tree passes it.
  const cap = Math.floor(treeChars(packed, PRUNE_MAX_NODES) * 0.7);
  setFrameBufferMaxForTests(cap);
  const held: number[] = [];
  const yieldTurn = (): Promise<void> => {
    held.push(frameBuildStats().heldChars);
    return nextTurn();
  };
  const before = frameBuildStats();
  const sinks = [new Sink(), new Sink(), new Sink()];
  const sends = sinks.map((sink) => send(sink, packed, { yieldTurn }));
  assert.deepEqual(await Promise.all(sends), ['sent', 'sent', 'sent']);
  for (const sink of sinks) assert.equal(sink.text, frame);
  const after = since(before);
  assert.equal(after.builds, 1, 'one count');
  assert.equal(after.streamed, 3, 'each reader writes its frame from the store');
  assert.equal(after.buffered, 0, 'none from a buffer');
  assert.ok(held[0] > 0 && held[0] <= cap, `within the cap the count holds what it gathered (${held[0]} of ${cap})`);
  assert.ok(held.every((chars) => chars <= cap), `never more than the cap held: ${held.join(', ')}`);
  assert.equal(held.at(-1), 0, 'and once past it, nothing');
  assert.equal(after.heldChars, 0);
});

test('a tree of exactly the cap is built once, and one character longer is written from the store', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  const { packed } = buildPair(35, 35, 3_000);
  const chars = treeChars(packed, PRUNE_MAX_NODES);
  const frame = todaysFrame(packed, PRUNE_MAX_NODES);
  for (const [cap, way] of [[chars, 'buffered'], [chars - 1, 'streamed']] as const) {
    setFrameBufferMaxForTests(cap);
    const before = frameBuildStats();
    const sink = new Sink();
    assert.equal(await send(sink, packed), 'sent');
    assert.equal(sink.text, frame, `cap ${cap}`);
    assert.equal(since(before)[way], 1, `a tree of ${chars} characters under a cap of ${cap} is ${way}`);
  }
});

test('a count that fails fails every reader waiting on it, holds nothing after, and the next count starts afresh', async () => {
  const store = failingStore();
  store.failAt = 5_000; // in the second slice
  const before = frameBuildStats();
  const sinks = [new Sink(), new Sink()];
  const outcomes = await Promise.allSettled(sinks.map((sink) => send(sink, store)));
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.match(String((outcome as PromiseRejectedResult).reason), /the disk went away/);
  }
  assert.ok(sinks.every((sink) => sink.chunks.length === 0), 'nothing written');
  assert.equal(frameBuildStats().heldChars, 0, 'what the count had gathered is let go');
  assert.equal(frameBuildStats().waiting, 0);
  store.failAt = -1;
  const sink = new Sink();
  assert.equal(await send(sink, store), 'sent', 'a later reader counts again');
  assert.equal(sink.text, todaysFrame(store, PRUNE_MAX_NODES));
  assert.equal(since(before).builds, 2);
});

test('a reader whose socket closes while the count runs gets nothing, the other reader its frame, and nothing is held after', async () => {
  const { packed } = buildPair(36, 36, 9_000);
  const leaving = new Sink();
  const staying = new Sink();
  let yields = 0;
  const yieldTurn = (): Promise<void> => {
    if (yields++ === 0) leaving.destroyed = true;
    return nextTurn();
  };
  const outcomes = await Promise.all([send(leaving, packed, { yieldTurn }), send(staying, packed)]);
  assert.deepEqual(outcomes, ['closed', 'sent']);
  assert.equal(leaving.chunks.length, 0);
  assert.equal(staying.text, todaysFrame(packed, PRUNE_MAX_NODES));
  assert.equal(frameBuildStats().heldChars, 0);
});

test('a legacy tree wrapped as a store has a version, so a change during its count is counted again once, never forever', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  const { obj } = buildPair(34, 34, 6_000);
  const wrapped = ObjectScanStore.wrap(obj.prune(obj.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root);
  assert.equal(wrapped.version, 0, 'a wrapped tree starts at 0, as a built store does');
  wrapped.addToSize(wrapped.rootId, 1);
  assert.equal(wrapped.version, 1, 'and counts its changes');
  setFrameBufferMaxForTests(1);
  let changes = 0;
  const yieldTurn = (): Promise<void> => {
    if (changes++ === 0) wrapped.addToSize(wrapped.rootId, 1);
    return nextTurn();
  };
  const before = frameBuildStats();
  const sink = new Sink();
  assert.equal(await send(sink, wrapped, { yieldTurn }), 'sent');
  assert.equal(sink.text, todaysFrame(wrapped, PRUNE_MAX_NODES));
  assert.equal(since(before).attempts, 2);
});

/* ------------------------------ the slices ------------------------------ */


test('the count yields ceil(nodes / 4,096) times on a 20,000-node tree, and work queued behind it runs before the frame is written', async () => {
  const store = twentyThousand();
  assert.equal(store.prune(store.rootId, { maxNodes: PRUNE_MAX_NODES }).nodes, 20_000);
  let yields = 0;
  const counted = new Sink();
  const sending = send(counted, store, {
    yieldTurn: () => {
      yields++;
      return nextTurn();
    },
  });
  assert.equal(counted.chunks.length, 0, 'nothing written in the turn the send began');
  assert.equal(await sending, 'sent');
  assert.equal(yields, Math.ceil(20_000 / FRAME_YIELD_NODES), 'one yield a slice of 4,096 nodes');
  assert.equal(counted.text, todaysFrame(store, PRUNE_MAX_NODES));

  // The default yield: a probe queued after the send began runs before any of the frame is written.
  const probed = new Sink();
  let writtenWhenProbed = -1;
  const probing = send(probed, store);
  setImmediate(() => {
    writtenWhenProbed = probed.chunks.length;
  });
  assert.equal(await probing, 'sent');
  assert.equal(writtenWhenProbed, 0, 'the probe ran while the frame was being counted');
});

test('a change to the store while the count waits counts again: two attempts, and the frame is the store after the change', async () => {
  const { packed } = buildPair(24, 24, 9_000);
  const beforeChange = todaysFrame(packed, PRUNE_MAX_NODES);
  let changes = 0;
  const yieldTurn = (): Promise<void> => {
    if (changes === 0) {
      changes++;
      packed.addToSize(packed.rootId, 1);
      packed.addToSize(packed.childIds(packed.rootId).at(-1) as number, 1);
    }
    return nextTurn();
  };
  const before = frameBuildStats();
  const sink = new Sink();
  assert.equal(await send(sink, packed, { yieldTurn }), 'sent');
  const afterChange = todaysFrame(packed, PRUNE_MAX_NODES);
  assert.notEqual(afterChange, beforeChange, 'the change shows in the frame');
  assert.equal(sink.text, afterChange, 'the frame is the store after the change, whole');
  assert.equal(since(before).attempts, 2, 'counted twice');
  assert.equal(since(before).builds, 1, 'in one build');
});

test('a store that changes at every yield is counted three times, the third in one turn without yielding, and the frame is the store as it then stands', async () => {
  const { packed } = buildPair(25, 25, 9_000);
  let yields = 0;
  const yieldTurn = (): Promise<void> => {
    yields++;
    // Bounded, so a count that never stopped yielding ends here rather than looping.
    if (yields <= 10) packed.addToSize(packed.rootId, 1);
    return nextTurn();
  };
  const before = frameBuildStats();
  const sink = new Sink();
  assert.equal(await send(sink, packed, { yieldTurn }), 'sent');
  assert.equal(since(before).attempts, 3, 'three attempts');
  assert.equal(yields, 2, 'one yield in each of the first two, none in the last');
  assert.equal(sink.text, todaysFrame(packed, PRUNE_MAX_NODES), 'the frame is the store after both changes');
});

test('a reader whose frame would be written from the store after a change counts again; readers of chunks are written the instant they were counted', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  for (const [label, cap] of [['from the store', 1], ['from chunks', null]] as const) {
    setFrameBufferMaxForTests(cap);
    const { packed } = buildPair(32, 32, 9_000);
    const counted = todaysFrame(packed, 250);
    // The smallest folder the budget leaves closed, made the largest: the
    // change moves which folders the prune opens, not just a number.
    const closed = packed.prune(packed.rootId, { maxNodes: 250 }).root;
    const shut: string[] = [];
    const walk = [closed];
    while (walk.length > 0) {
      const n = walk.pop() as { path: string; pruned?: boolean; children?: unknown[] };
      if (n.pruned) shut.push(n.path);
      for (const c of (n.children ?? []) as typeof walk) walk.push(c);
    }
    assert.ok(shut.length > 0, `${label}: the budget leaves folders closed`);
    const grown = packed.findByPath(shut[shut.length - 1]);
    // The first reader's socket changes the store as its last chunk arrives:
    // its own frame is whole, and the change lands before the others write.
    const first = new Sink((sink) => {
      if (sink.text.endsWith('\n\n')) packed.addToSize(grown, 1e15);
      return true;
    });
    const others = [new Sink(), new Sink()];
    const before = frameBuildStats();
    const outcomes = await Promise.all([first, ...others].map((sink) => send(sink, packed, { maxNodes: 250 })));
    assert.deepEqual(outcomes, ['sent', 'sent', 'sent'], label);
    assert.equal(first.text, counted, `${label}: the first frame is the store before the change`);
    const changed = todaysFrame(packed, 250);
    assert.notEqual(changed, counted, `${label}: the change moved the prune`);
    if (cap === 1) {
      for (const sink of others) assert.equal(sink.text, changed, `${label}: a reader past the cap writes the store as it now stands`);
      assert.equal(since(before).builds, 2, `${label}: the two count again, once, together`);
      assert.equal(since(before).streamed, 3, label);
    } else {
      for (const sink of others) assert.equal(sink.text, counted, `${label}: a reader of chunks writes the instant they were counted`);
      assert.equal(since(before).builds, 1, label);
      assert.equal(since(before).buffered, 3, label);
    }
    assert.equal(frameBuildStats().heldChars, 0, label);
  }
});

test('once counted, the frame goes out with no turn between its first chunk and its last while the socket takes them, from chunks or from the store', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  const { packed } = buildPair(26, 26, 9_000);
  for (const [label, cap] of [['from chunks', null], ['from the store', TREE_CHUNK_CHARS]] as const) {
    setFrameBufferMaxForTests(cap);
    let writtenWhenProbed = -1;
    const sink = new Sink((s) => {
      if (s.chunks.length === 1) {
        setImmediate(() => {
          writtenWhenProbed = s.chunks.length;
        });
      }
      return true;
    });
    assert.equal(await send(sink, packed), 'sent');
    await nextTurn();
    assert.ok(sink.chunks.length > 2, `${label}: the frame spans several chunks (${sink.chunks.length})`);
    assert.ok(sink.chunks.every((chunk) => chunk.length <= TREE_CHUNK_CHARS + 8_192), `${label}: no chunk much past the chunk size`);
    assert.equal(writtenWhenProbed, sink.chunks.length, `${label}: a turn queued at the first chunk ran only after the last`);
    assert.equal(sink.text, todaysFrame(packed, PRUNE_MAX_NODES), label);
  }
});

test('the refusal holds whichever way the frame is written, and for readers that share a count: a frame one character too long writes nothing, one exactly as long goes', async (t) => {
  t.after(() => {
    setTreeFrameMaxCharsForTests(null);
    setFrameBufferMaxForTests(null);
  });
  const { packed } = buildPair(27, 27, 6_000);
  const frame = todaysFrame(packed, PRUNE_MAX_NODES);
  for (const [label, cap] of [['from chunks', null], ['from the store', TREE_CHUNK_CHARS]] as const) {
    setFrameBufferMaxForTests(cap);
    setTreeFrameMaxCharsForTests(frame.length - 1);
    const refused = [new Sink(), new Sink()];
    assert.deepEqual(await Promise.all(refused.map((sink) => send(sink, packed))), ['refused', 'refused'], label);
    assert.ok(refused.every((sink) => sink.chunks.length === 0), `${label}: nothing written`);
    setTreeFrameMaxCharsForTests(frame.length);
    const sent = [new Sink(), new Sink()];
    assert.deepEqual(await Promise.all(sent.map((sink) => send(sink, packed))), ['sent', 'sent'], label);
    for (const sink of sent) assert.equal(sink.text, frame, label);
  }
  assert.equal(frameBuildStats().heldChars, 0, 'and a refused frame is not kept either');
});

/* ------------------------------ the routes ------------------------------ */

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function get(port: number, route: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HANG_GUARD_MS, () => req.destroy(new Error(`${route} never answered`)));
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

/** The first frame's tree as the routes prune it (U-19). */
const firstTree = (store: ScanStore): string => JSON.stringify(store.prune(store.rootId, { maxNodes: PRUNE_MAX_NODES, overshoot: 'none' }).root);

/** A yield seam that holds every count until `release()`, then yields a turn as the default does. */
function holdCounts(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setFrameYieldForTests(async () => {
    await gate;
    await nextTurn();
  });
  return { release };
}

/** Two `/result` requests and the progress stream at once, released once all three wait on a count. */
async function threeReaders(port: number, scanId: string, store: ScanStore, before: FrameBuildStats): Promise<void> {
  const { release } = holdCounts();
  try {
    const stream = get(port, `/api/scan/${scanId}/progress`);
    const results = [get(port, `/api/scan/${scanId}/result`), get(port, `/api/scan/${scanId}/result`)];
    await waitFor(() => since(before).waiting === 3, 'the three readers waiting on the count');
    assert.equal(since(before).builds, 1, 'one count for the three');
    release();
    const [streamed, ...fallbacks] = await Promise.all([stream, ...results]);
    const frame = streamed.body.slice(streamed.body.indexOf('data: {"type":"complete"'));
    const { stats } = JSON.parse(frame.slice('data: '.length)) as { stats: unknown };
    assert.equal(frame, todaysFrame(store, PRUNE_MAX_NODES, stats, 'none'), "the stream's frame, today's bytes");
    for (const fallback of fallbacks) {
      assert.equal(fallback.status, 200);
      assert.equal(JSON.stringify((JSON.parse(fallback.body) as { root: unknown }).root), firstTree(store), "/result's tree");
    }
  } finally {
    release();
    setFrameYieldForTests(null);
  }
}

test('two /result requests and the progress stream that arrive while a small frame is counted share one count', async () => {
  const { packed } = buildPair(28, 28, 6_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    const before = frameBuildStats();
    await threeReaders(port, scanId, packed, before);
    const after = since(before);
    assert.equal(after.builds, 1);
    assert.equal(after.buffered, 3, 'all three written from its chunks');
    assert.equal(after.heldChars, 0, 'and let go');
  } finally {
    await close();
  }
});

test('past the buffer cap the three readers share the count and each writes from the store', async (t) => {
  t.after(() => setFrameBufferMaxForTests(null));
  setFrameBufferMaxForTests(TREE_CHUNK_CHARS);
  const { packed } = buildPair(29, 29, 6_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    const before = frameBuildStats();
    await threeReaders(port, scanId, packed, before);
    const after = since(before);
    assert.equal(after.streamed, 3, 'each reader streams');
    assert.equal(after.buffered, 0);
    assert.equal(after.heldChars, 0);
  } finally {
    await close();
  }
});

test("the stream's frame and a later /result are counted once each: no frame is kept once sent", async () => {
  const { packed } = buildPair(30, 30, 6_000);
  const scanId = completedScan(packed);
  const { port, close } = await listen();
  try {
    const before = frameBuildStats();
    const streamed = await get(port, `/api/scan/${scanId}/progress`);
    assert.ok(streamed.body.includes('data: {"type":"complete"'));
    assert.equal(frameBuildStats().heldChars, 0, 'nothing held once the stream has its frame');
    const fallback = await get(port, `/api/scan/${scanId}/result`);
    assert.equal(JSON.stringify((JSON.parse(fallback.body) as { root: unknown }).root), firstTree(packed));
    assert.equal(since(before).builds, 2, 'one count each');
    assert.equal(frameBuildStats().heldChars, 0);
  } finally {
    await close();
  }
});

test('a stream that ends while its too-large frame is counted is written nothing more, not even the too-large error', async (t) => {
  t.after(() => {
    setTreeFrameMaxCharsForTests(null);
    setFrameYieldForTests(null);
  });
  const { packed } = buildPair(33, 33, 6_000);
  const scan = createScanRecord(packed.rootPath);
  scan.status = 'complete';
  scan.store = packed;
  scan.finishedAt = scan.startedAt + 10;
  setTreeFrameMaxCharsForTests(1_000);
  for (const ends of [false, true]) {
    const res = new Sink();
    setFrameYieldForTests(() => {
      if (ends) res.writableEnded = true; // the client left, or the server is shutting down
      return nextTurn();
    });
    let firstBytes = 0;
    await sendFinalEvent(res as unknown as Response, scan, () => {
      firstBytes++;
    });
    if (ends) {
      assert.deepEqual(res.chunks, [], 'nothing written to a stream that has ended');
      assert.equal(firstBytes, 0);
    } else {
      assert.equal(res.chunks.length, 1, 'the too-large error, once');
      assert.match(res.chunks[0], /^data: \{"type":"error","message":"This scan is too large to display/);
      assert.equal(firstBytes, 1, 'the heartbeats stop as it is written');
    }
  }
});

/** The progress stream's raw frames, read to its end; `onFrame` runs on each. */
function rawFrames(port: number, scanId: string, onFrame: (frame: string, frames: string[]) => void): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let split: number;
        while ((split = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          frames.push(frame);
          onFrame(frame, frames);
        }
      });
      res.on('end', () => resolve(frames));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

const isProgress = (frame: string): boolean => frame.startsWith('data: {"type":"progress"');

test('heartbeats flow while the complete frame is counted, held by the seam, and none follows its first byte', async (t) => {
  const { release } = holdCounts();
  t.after(() => {
    release();
    setFrameYieldForTests(null);
  });
  const { packed } = buildPair(31, 31, 3_000);
  const scan = createScanRecord(packed.rootPath);
  scan.scanned = 9;
  scan.currentPath = packed.rootPath;
  const { port, close } = await listen();
  try {
    let flippedAt = -1;
    const frames = await withinHangGuard(rawFrames(port, scan.scanId, (frame, all) => {
      if (flippedAt === -1 && isProgress(frame)) {
        // The scan finishes: from here its frame is counted, and the seam holds the count.
        scan.status = 'complete';
        scan.store = packed;
        scan.finishedAt = scan.startedAt + 10;
        flippedAt = all.length;
      } else if (flippedAt !== -1 && all.slice(flippedAt).filter(isProgress).length === 2) {
        release();
      }
    }), 'the progress stream ending');
    const after = frames.slice(flippedAt);
    const completeAt = after.findIndex((f) => f.startsWith('data: {"type":"complete"'));
    assert.ok(completeAt >= 2, `two heartbeats while the count was held (frames after the scan finished: ${after.length})`);
    assert.ok(after.slice(0, completeAt).every(isProgress), 'each an unchanged progress frame');
    assert.equal(completeAt, after.length - 1, 'and nothing follows the complete frame');
    const { stats } = JSON.parse(after[completeAt].slice('data: '.length)) as { stats: unknown };
    assert.equal(`${after[completeAt]}\n\n`, todaysFrame(packed, PRUNE_MAX_NODES, stats, 'none'), 'which is whole');
  } finally {
    // Let a count still held go first: the server closes only once its streams have ended.
    release();
    await close();
  }
});

/* ---------------------- both stores, both rules ---------------------- */

test('the frame is today\'s bytes from either store under either rule when its count spans several slices', async () => {
  for (let seed = 40; seed < 44; seed++) {
    const { obj, packed } = buildPair(seed, seed, 4_000 + seed * 100);
    for (const store of [obj, packed] as Array<ObjectScanStore | PackedScanStore>) {
      for (const overshoot of ['lastFolder', 'none'] as const) {
        for (const maxNodes of [7, 250, 20_000]) {
          const sink = new Sink();
          assert.equal(await send(sink, store, { maxNodes, overshoot }), 'sent');
          assert.equal(sink.text, todaysFrame(store, maxNodes, STATS, overshoot), `seed ${seed}, ${store.constructor.name}, ${overshoot}, ${maxNodes}`);
        }
      }
    }
  }
});
