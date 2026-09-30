'use strict';
/*
 * node index-poll.cjs <port> <jobId> [intervalSeconds]
 * Follows one index build (GET /api/index/<jobId>/result on 127.0.0.1:<port>) until its status is anything but
 * `running`, printing one line per poll: epoch seconds, 1-minute load, status, phase, processed, fileCount and
 * `err` when the answer carried an error. The diagnosis's shell loop (index-poll.sh) did the same with the port
 * and the job id written into it; here both are arguments. intervalSeconds defaults to the loop's 10.
 * No path is printed: the result's tree is never read.
 */
const http = require('http');
const os = require('os');

const [portArg, jobId, intervalArg] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port <= 0 || !jobId) {
  console.error('usage: node index-poll.cjs <port> <jobId> [intervalSeconds]');
  process.exit(2);
}
const intervalMs = Number(intervalArg ?? 10) * 1000;

/** The body of one poll, as text; '' when the request failed (curl -s printed nothing either). */
function poll() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/index/${encodeURIComponent(jobId)}/result`, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(''));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(''));
  });
}

/** The loop's own summary of a body: `status phase processed fileCount err`, or `unparsed`. */
function summary(text) {
  try {
    const j = JSON.parse(text);
    return [j.status || '', j.phase || '', j.processed || '', j.fileCount || '', j.error ? 'err' : ''].join(' ');
  } catch {
    return 'unparsed';
  }
}

(async () => {
  for (;;) {
    const line = summary(await poll());
    console.log(`${Math.floor(Date.now() / 1000)} ${os.loadavg()[0].toFixed(2)} ${line}`);
    if (!line.startsWith('running')) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
})();
