import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-idem-inflight-data-');

import express from 'express';
import { idempotency, resetIdempotencyCache } from '../src/middleware/idempotency';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C50: an Idempotency-Key did not cover a retry that arrived while the first request was
 * still running — the usual retry, sent after a client timeout — so both executed: a second
 * moveToTrash, a second Undo Vault copy. Now a repeat that arrives while the first is in flight
 * waits for it and replays its answer; a first request that fails lets the repeat genuinely retry.
 */

beforeEach(() => resetIdempotencyCache());

interface Harness {
  port: number;
  arrivals: () => number;
  executions: () => number;
  release: (status: number) => void;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  let arrivals = 0;
  let executions = 0;
  let gates: Array<(status: number) => void> = [];
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => { arrivals++; next(); });
  app.post('/api/act', idempotency, async (_req, res) => {
    executions++;
    const status = await new Promise<number>((resolve) => { gates.push(resolve); });
    res.status(status).json(status < 300 ? { done: executions } : { error: 'it failed', code: 'FAILED' });
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    arrivals: () => arrivals,
    executions: () => executions,
    release: (status) => { const open = gates; gates = []; for (const g of open) g(status); },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function post(port: number, key: string): Promise<{ status: number; replayed: boolean; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/act', method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, replayed: res.headers['idempotency-replayed'] === 'true', body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end('{}');
  });
}

test('a repeat that arrives while the first request runs waits for it and replays its answer — the handler runs once', async () => {
  const h = await harness();
  try {
    const first = post(h.port, 'k1');
    await waitFor(() => h.executions() === 1, 'the first request running');
    const second = post(h.port, 'k1');
    await waitFor(() => h.arrivals() === 2, 'the repeat arriving while the first still runs');
    h.release(200);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([a.status, a.replayed, a.body], [200, false, { done: 1 }]);
    assert.deepEqual([b.status, b.replayed, b.body], [200, true, { done: 1 }], 'the repeat is the first one\'s answer, replayed');
    assert.equal(h.executions(), 1, 'the handler ran once');
  } finally {
    await h.close();
  }
});

test('when the first request fails, a repeat that waited on it genuinely retries', async () => {
  const h = await harness();
  try {
    const first = post(h.port, 'k2');
    await waitFor(() => h.executions() === 1, 'the first request running');
    let secondAnswered = false;
    const second = post(h.port, 'k2').finally(() => { secondAnswered = true; });
    await waitFor(() => h.arrivals() === 2, 'the repeat arriving while the first still runs');
    h.release(500);
    assert.equal((await first).status, 500);
    await waitFor(() => h.executions() === 2 || secondAnswered, 'the repeat running once the first failed, or answering');
    assert.equal(h.executions(), 2, 'the failure was not replayed: the repeat ran');
    h.release(200);
    const b = await second;
    assert.deepEqual([b.status, b.replayed, b.body], [200, false, { done: 2 }]);
  } finally {
    await h.close();
  }
});

test('a first client that gives up (the timeout behind the usual retry) does not end the wait: the retry still replays the one execution', async () => {
  const h = await harness();
  try {
    const abandoned = http.request({ host: '127.0.0.1', port: h.port, path: '/api/act', method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k3' } });
    abandoned.on('error', () => { /* the client hung up on purpose */ });
    abandoned.end('{}');
    await waitFor(() => h.executions() === 1, 'the first request running');
    abandoned.destroy();
    const retry = post(h.port, 'k3');
    await waitFor(() => h.arrivals() === 2, 'the retry arriving while the first still runs');
    h.release(200);
    const b = await retry;
    assert.deepEqual([b.status, b.replayed, b.body], [200, true, { done: 1 }]);
    assert.equal(h.executions(), 1, 'the handler ran once');
  } finally {
    await h.close();
  }
});
