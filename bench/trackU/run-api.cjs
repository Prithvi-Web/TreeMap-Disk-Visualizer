'use strict';
/*
 * node run-api.cjs <port> <outdir> [idleSeconds]
 * Starts a whole-disk scan exactly as the UI does (POST /api/scan {path:'/', incremental:false, interactive:true}),
 * follows the SSE stream like the UI, polls /stats every 2 s, then fetches /stats and /missing-gigabytes, then idles.
 * Everything path-like is reduced to its top-level folder before it is written.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/*
 * Every absolute path is cut to its top-level folder, whatever that folder is called (U-0 review, findings
 * 13 and 16: a list of eighteen known names let /pkg, /nix, /mnt and every Windows path through whole):
 * a POSIX path (`/top/…`), a drive path (`C:\top\…`), a UNC path (`\\server\…`) and a home path (`~/…`).
 * A path starts where a slash, drive or tilde follows the start of the string or anything but a name
 * character, so `src/x.ts` is not one. Everything after the top-level folder is dropped, to the end of the
 * string: a path may hold spaces and quotes, and nothing in a string says where such a path ends.
 */
const START = String.raw`(^|[^\w.~-])`;
const CUTS = [
  [new RegExp(`${START}\\/([^/]+)\\/[\\s\\S]+$`), (_m, before, top) => `${before}/${top}/…`],
  [new RegExp(`${START}([A-Za-z]:\\\\)([^\\\\]+)\\\\[\\s\\S]+$`), (_m, before, drive, top) => `${before}${drive}${top}\\…`],
  [new RegExp(`${START}\\\\\\\\([^\\\\]+)\\\\[\\s\\S]+$`), (_m, before, server) => `${before}\\\\${server}\\…`],
  [new RegExp(`${START}~\\/[\\s\\S]+$`), (_m, before) => `${before}~/…`],
];
const sanitize = (s) => CUTS.reduce((text, [re, cut]) => text.replace(re, cut), String(s));
/** A copy of `o` with every string in it (keys included) sanitized: walked, never cut as JSON text, so a quote cannot break it. */
const sanitizeJson = (o) => {
  if (typeof o === 'string') return sanitize(o);
  if (Array.isArray(o)) return o.map(sanitizeJson);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [sanitize(k), sanitizeJson(v)]));
  return o;
};

// Exported for tests/trackUTools.test.ts; everything below runs only when this file is the program.
module.exports = { sanitize, sanitizeJson };
if (require.main === module) main();

function main() {
  const [port, outdir, idleArg] = process.argv.slice(2);
  const IDLE_S = Number(idleArg || 60);
  fs.mkdirSync(outdir, { recursive: true });
  const ev = fs.openSync(path.join(outdir, 'client.jsonl'), 'a');
  const log = (o) => fs.writeSync(ev, JSON.stringify({ t: Date.now(), ...o }) + '\n');

  function req(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, bytes: Buffer.byteLength(text) });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  function follow(scanId, t0) {
    // Linear in the bytes received: chunks are kept in an array and only joined when a frame boundary arrives.
    return new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scanId}/progress` }, (res) => {
        let parts = [];
        let tail = '';
        let completeStart = null;
        let firstByte = null;
        let bytes = 0;
        let frames = 0;
        let lastLogged = 0;
        res.setEncoding('utf8');
        const handleFrame = (frame) => {
          if (!frame.startsWith('data: ')) return;
          const text = frame.slice(6);
          frames++;
          const now = Date.now();
          if (text.startsWith('{"type":"progress"')) {
            const m = JSON.parse(text);
            if (now - lastLogged >= 1000) { lastLogged = now; log({ kind: 'progress', sinceStartMs: now - t0, scanned: m.scanned, top: sanitize(m.currentPath || '') }); }
            return;
          }
          const parseT = Date.now();
          const m = JSON.parse(text);
          const parseMs = Date.now() - parseT;
          let nodes = 0, maxDepth = 0;
          const stack = m.root ? [[m.root, 0]] : [];
          while (stack.length) { const [n, d] = stack.pop(); nodes++; if (d > maxDepth) maxDepth = d; if (n.children) for (const c of n.children) stack.push([c, d + 1]); }
          log({ kind: 'final-frame', type: m.type, sinceStartMs: now - t0, frameChars: text.length, frameBytes: Buffer.byteLength(text), receiveMs: completeStart ? now - completeStart : null, firstByteMs: firstByte ? firstByte - t0 : null, clientParseMs: parseMs, nodes, maxDepth, rootSize: m.root ? m.root.size : null, message: m.message ? sanitize(m.message) : undefined });
          if (m.stats) fs.writeFileSync(path.join(outdir, 'stats-from-frame.json'), JSON.stringify(sanitizeJson(m.stats), null, 2));
        };
        res.on('data', (chunk) => {
          if (firstByte === null) firstByte = Date.now();
          bytes += Buffer.byteLength(chunk);
          const probe = tail + chunk;
          if (completeStart === null && probe.includes('"type":"complete"')) { completeStart = Date.now(); log({ kind: 'complete-frame-start', sinceStartMs: completeStart - t0 }); }
          tail = probe.slice(-40);
          if (chunk.includes('\n\n') || (parts.length && parts[parts.length - 1].endsWith('\n') && chunk.startsWith('\n'))) {
            let buf = parts.join('') + chunk;
            parts = [];
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) { handleFrame(buf.slice(0, i)); buf = buf.slice(i + 2); }
            if (buf) parts.push(buf);
          } else {
            parts.push(chunk);
          }
        });
        res.on('end', () => { log({ kind: 'sse-end', totalBytes: bytes, frames }); resolve(); });
      });
      r.on('error', (e) => { log({ kind: 'sse-error', message: e.message }); resolve(); });
    });
  }

  if (process.env.FINAL_ONLY) {
    // Re-measure only the last frame of an already-complete scan: a new stream on a finished scan sends it at once.
    (async () => {
      const scanId = process.env.FINAL_ONLY;
      const t0 = Date.now();
      await follow(scanId, t0);
    })();
  } else
  (async () => {
    const t0 = Date.now();
    const start = await req('POST', '/api/scan', { path: '/', incremental: false, interactive: true });
    log({ kind: 'scan-post', status: start.status, body: sanitizeJson(start.json) });
    const scanId = start.json && start.json.scanId;
    if (!scanId) { console.error('no scanId', start); process.exit(1); }
    let done = false;
    const poll = (async () => {
      let lastReason = null;
      while (!done) {
        const s = await req('GET', `/api/scan/${scanId}/stats`).catch((e) => ({ status: 0, json: { err: e.message } }));
        const j = s.json || {};
        if (j.engineReason !== lastReason) { lastReason = j.engineReason; log({ kind: 'engineReason', sinceStartMs: Date.now() - t0, engine: j.engine, reason: sanitize(j.engineReason || ''), fallback: j.fallbackReason ? sanitize(j.fallbackReason) : null }); }
        log({ kind: 'stats-poll', sinceStartMs: Date.now() - t0, status: j.status, scanned: j.scanned, httpStatus: s.status });
        if (j.status && j.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    await follow(scanId, t0);
    done = true;
    await poll;
    const stats = await req('GET', `/api/scan/${scanId}/stats`);
    fs.writeFileSync(path.join(outdir, 'stats.json'), JSON.stringify(sanitizeJson(stats.json), null, 2));
    log({ kind: 'stats-final', status: stats.status });
    const tMg = Date.now();
    const mg = await req('GET', `/api/missing-gigabytes?scanId=${scanId}`);
    log({ kind: 'missing-gigabytes', status: mg.status, ms: Date.now() - tMg, bytes: mg.bytes });
    fs.writeFileSync(path.join(outdir, 'missing-gigabytes.json'), JSON.stringify(sanitizeJson(mg.json), null, 2));
    fs.writeFileSync(path.join(outdir, 'scanId'), scanId);
    log({ kind: 'idle-start', seconds: IDLE_S });
    await new Promise((r) => setTimeout(r, IDLE_S * 1000));
    log({ kind: 'idle-end' });
  })();
}
