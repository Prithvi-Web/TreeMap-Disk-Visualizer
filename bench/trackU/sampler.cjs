'use strict';
// node sampler.cjs <pid> <outfile> — rss (KB) and %cpu of <pid> every 250 ms, plus 1-min load, until the pid exits.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const [pid, out] = process.argv.slice(2);
const fd = fs.openSync(out, 'a');
let peak = 0;
const tick = () => {
  let line;
  try { line = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', pid], { encoding: 'utf8' }).trim(); } catch { fs.writeSync(fd, `# exited peakKB=${peak}\n`); process.exit(0); }
  const [rss, cpu] = line.split(/\s+/);
  if (+rss > peak) peak = +rss;
  fs.writeSync(fd, `${Date.now()} ${rss} ${cpu} ${os.loadavg()[0].toFixed(2)}\n`);
};
setInterval(tick, 250);
tick();
