'use strict';
// node prof.cjs <cpuprofile> <eld.jsonl> [minStallMs]
// For every event-loop stall in eld.jsonl longer than minStallMs, lists the functions the CPU profile
// sampled inside that window: self time by function, and inclusive time by function (each function once per sample).
const fs = require('fs');

const label = (n) => {
  const cf = n.callFrame;
  const file = (cf.url || '').replace(/^.*\/(dist|node_modules)\//, '$1/').replace(/^node:/, 'node:');
  return `${cf.functionName || '(anon)'} ${file}${cf.url ? ':' + (cf.lineNumber + 1) : ''}`;
};

/**
 * Every stall in `eld` at least `min` ms long, with the profile's samples that fall inside it:
 * `{ stall, samples, self, inclusive }`, the last two as Maps of label → sample count.
 */
function attributeStalls(prof, eld, min) {
  const startLog = eld.find((l) => l.kind === 'start');
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
  // sample timestamps in profile µs
  const times = [];
  let t = prof.startTime;
  for (let i = 0; i < prof.samples.length; i++) { t += prof.timeDeltas[i]; times.push(t); }
  // align: profile start ≈ process start; eld 'start' is logged during preload, so use it as profile start (error: tens of ms)
  const epochOfProf = (us) => startLog.t + (us - prof.startTime) / 1000;
  const stalls = eld.filter((l) => l.kind === 'stall' && l.ms >= min);
  const reports = [];
  for (const s of stalls) {
    const endE = s.t, startE = s.t - s.ms;
    const self = new Map(), incl = new Map();
    let n = 0;
    for (let i = 0; i < times.length; i++) {
      const e = epochOfProf(times[i]);
      if (e < startE || e > endE) continue;
      n++;
      const leaf = byId.get(prof.samples[i]);
      const ll = label(leaf);
      self.set(ll, (self.get(ll) || 0) + 1);
      const seen = new Set();
      for (let id = prof.samples[i]; id !== undefined; id = parent.get(id)) {
        const lab = label(byId.get(id));
        if (seen.has(lab)) continue;
        seen.add(lab);
        incl.set(lab, (incl.get(lab) || 0) + 1);
      }
    }
    reports.push({ stall: s, samples: n, self, inclusive: incl });
  }
  return reports;
}

// Exported for tests/trackUTools.test.ts; the report below prints only when this file is the program.
module.exports = { attributeStalls };
if (require.main === module) main();

function main() {
  const [profFile, eldFile, minArg] = process.argv.slice(2);
  const MIN = Number(minArg || 500);
  const prof = JSON.parse(fs.readFileSync(profFile, 'utf8'));
  const eld = fs.readFileSync(eldFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const { stall: s, samples: n, self, inclusive: incl } of attributeStalls(prof, eld, MIN)) {
    const endE = s.t;
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, c]) => `    ${String(Math.round((c / Math.max(1, n)) * 100)).padStart(3)}%  ${f}`).join('\n');
    console.log(`\n=== stall ${s.ms} ms ending ${new Date(endE).toISOString()} inflight=${JSON.stringify(s.inflight)} samples=${n}`);
    console.log('  self:');
    console.log(top(self, 8));
    console.log('  inclusive (app frames):');
    console.log(top(new Map([...incl.entries()].filter(([f]) => /dist\/|node_modules\//.test(f))), 14));
  }
}
