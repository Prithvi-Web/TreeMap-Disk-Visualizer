'use strict';
/*
 * Event-loop delay monitor, preloaded with `node --require eld.cjs`.
 * Writes JSON lines to $ELD_LOG:
 *   {kind:'sec'}   once a second: max/p99/mean loop delay (monitorEventLoopDelay, 10 ms resolution),
 *                  rss/heap, process CPU% over the second, load average, in-flight HTTP requests
 *   {kind:'stall'} every gap > 50 ms seen by a 10 ms interval timer, with the requests in flight
 *   {kind:'req'}   every HTTP request when it finishes: method, pathname (query keys only), status, ms, bytes
 *   {kind:'gc'}    every GC pause > 20 ms
 * Paths in query strings are never logged (only the key names).
 */
const { monitorEventLoopDelay, performance, PerformanceObserver } = require('perf_hooks');
const fs = require('fs');
const os = require('os');
const http = require('http');

const out = process.env.ELD_LOG;
if (!out) throw new Error('ELD_LOG not set');
const fd = fs.openSync(out, 'a');
const log = (o) => { try { fs.writeSync(fd, JSON.stringify(o) + '\n'); } catch { /* ignore */ } };

const inflight = new Map();
let rid = 0;
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === 'request' && req && res) {
    const id = ++rid;
    const [p, q] = String(req.url || '').split('?');
    // scrub the scanId/jobId uuids so the log is readable; keep route shape
    const route = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');
    const keys = q ? q.split('&').map((kv) => kv.split('=')[0]).join(',') : '';
    const rec = { id, m: req.method, route, keys, start: Date.now(), bytes: 0 };
    inflight.set(id, rec);
    const w = res.write, e = res.end;
    res.write = function (chunk, ...a) { if (chunk) rec.bytes += Buffer.byteLength(chunk); return w.call(this, chunk, ...a); };
    res.end = function (chunk, ...a) { if (chunk && typeof chunk !== 'function') rec.bytes += Buffer.byteLength(chunk); return e.call(this, chunk, ...a); };
    const done = (how) => {
      if (!inflight.has(id)) return;
      inflight.delete(id);
      log({ t: Date.now(), kind: 'req', m: rec.m, route: rec.route, keys: rec.keys, status: res.statusCode, ms: Date.now() - rec.start, bytes: rec.bytes, how });
    };
    res.on('finish', () => done('finish'));
    res.on('close', () => done('close'));
  }
  return origEmit.apply(this, arguments);
};
const inflightNow = () => [...inflight.values()].map((r) => `${r.m} ${r.route}${r.keys ? '?' + r.keys : ''} (${Date.now() - r.start}ms)`);

const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let lastCpu = process.cpuUsage();
let lastWall = performance.now();
setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu);
  const wall = now - lastWall;
  lastCpu = process.cpuUsage();
  lastWall = now;
  const mu = process.memoryUsage();
  log({
    t: Date.now(), kind: 'sec',
    maxMs: +(h.max / 1e6).toFixed(1), p99Ms: +(h.percentile(99) / 1e6).toFixed(1), meanMs: +(h.mean / 1e6).toFixed(1),
    rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576), extMB: Math.round(mu.external / 1048576), abMB: Math.round(mu.arrayBuffers / 1048576),
    cpuPct: Math.round(((cpu.user + cpu.system) / 1000) / wall * 100),
    load1: +os.loadavg()[0].toFixed(2),
    inflight: inflightNow(),
  });
  h.reset();
}, 1000).unref();

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const gap = now - last - 10;
  if (gap > 50) log({ t: Date.now(), kind: 'stall', ms: Math.round(gap), inflight: inflightNow() });
  last = now;
}, 10).unref();

try {
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration > 20) log({ t: Date.now(), kind: 'gc', ms: Math.round(e.duration), gcKind: e.detail ? e.detail.kind : e.kind });
    }
  });
  obs.observe({ entryTypes: ['gc'] });
} catch { /* ignore */ }

log({ t: Date.now(), kind: 'start', pid: process.pid, node: process.version, uvpool: process.env.UV_THREADPOOL_SIZE || null });
