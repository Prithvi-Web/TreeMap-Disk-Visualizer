'use strict';
// node analyze.cjs <rundir> <t0ms> [phase marks as name=ms,...]
// Summarises eld.jsonl (stalls, per-phase loop delay) and rss.txt (peak RSS) relative to t0.
const fs = require('fs');
const path = require('path');
const [dir, t0Arg, marksArg] = process.argv.slice(2);
const t0 = Number(t0Arg);
const lines = fs.readFileSync(path.join(dir, 'eld.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const marks = (marksArg || '').split(',').filter(Boolean).map((kv) => { const [n, v] = kv.split('='); return { n, v: Number(v) }; }).sort((a, b) => a.v - b.v);
const phaseOf = (rel) => { let p = 'before'; for (const m of marks) if (rel >= m.v) p = m.n; return p; };
const rel = (t) => ((t - t0) / 1000).toFixed(1) + 's';
const stalls = lines.filter((l) => l.kind === 'stall' && l.t >= t0);
console.log(`stalls >50ms after t0: ${stalls.length}; >100ms: ${stalls.filter((s) => s.ms > 100).length}; >250ms: ${stalls.filter((s) => s.ms > 250).length}; >1s: ${stalls.filter((s) => s.ms > 1000).length}`);
const byPhase = {};
for (const s of stalls) {
  const endRel = s.t - t0; // stall ENDS at s.t
  const p = phaseOf(endRel - s.ms);
  (byPhase[p] ||= []).push(s);
}
for (const [p, arr] of Object.entries(byPhase)) {
  const tot = arr.reduce((a, s) => a + s.ms, 0);
  const max = Math.max(...arr.map((s) => s.ms));
  console.log(`  phase ${p}: ${arr.length} stalls, total ${tot} ms, max ${max} ms`);
}
console.log('stalls > 250 ms (start→end, relative to t0):');
for (const s of stalls.filter((x) => x.ms > 250)) console.log(`  ${rel(s.t - s.ms)} → ${rel(s.t)}  ${s.ms} ms  [${phaseOf(s.t - t0 - s.ms)}]  inflight=${JSON.stringify(s.inflight)}`);
const secs = lines.filter((l) => l.kind === 'sec' && l.t >= t0);
const peakHeap = Math.max(...secs.map((s) => s.heapMB));
const peakAB = Math.max(...secs.map((s) => s.abMB));
const peakRssEld = Math.max(...secs.map((s) => s.rssMB));
console.log(`eld: peak rssMB ${peakRssEld}, peak heapMB ${peakHeap}, peak arrayBuffersMB ${peakAB}`);
const loads = secs.map((s) => s.load1);
console.log(`load1 during run: min ${Math.min(...loads)} max ${Math.max(...loads)} median ${loads.sort((a, b) => a - b)[Math.floor(loads.length / 2)]}`);
const reqs = lines.filter((l) => l.kind === 'req' && l.t >= t0);
const slow = reqs.filter((r) => r.ms > 500 && !/progress$/.test(r.route));
console.log(`requests: ${reqs.length}; slower than 500 ms (excluding SSE): ${slow.length}`);
for (const r of slow) console.log(`  ${rel(r.t - r.ms)} ${r.m} ${r.route}${r.keys ? '?' + r.keys : ''} ${r.status} ${r.ms} ms ${r.bytes} B`);
const gcs = lines.filter((l) => l.kind === 'gc' && l.t >= t0);
console.log(`gc pauses >20ms: ${gcs.length}, max ${gcs.length ? Math.max(...gcs.map((g) => g.ms)) : 0} ms, total ${gcs.reduce((a, g) => a + g.ms, 0)} ms`);
try {
  const rss = fs.readFileSync(path.join(dir, 'rss.txt'), 'utf8').trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => l.split(' ').map(Number));
  let peak = [0, 0];
  for (const r of rss) if (r[0] >= t0 && r[1] > peak[1]) peak = r;
  console.log(`ps rss peak: ${(peak[1] / 1024).toFixed(0)} MB at ${rel(peak[0])}`);
  for (const m of marks) {
    const inPhase = rss.filter((r) => r[0] - t0 >= m.v);
    if (inPhase.length) console.log(`  rss at ${m.n} (${(m.v / 1000).toFixed(1)}s): ${(inPhase[0][1] / 1024).toFixed(0)} MB`);
  }
} catch (e) { console.log('no rss.txt', e.message); }
