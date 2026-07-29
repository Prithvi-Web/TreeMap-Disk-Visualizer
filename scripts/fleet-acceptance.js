#!/usr/bin/env node
/*
 * §D1 acceptance, driven against three REAL TreeMap servers on this machine.
 *
 * Kept as a script rather than a suite test: it spawns three node processes and
 * binds a LAN port, which is far too heavy for `npm test` and depends on the
 * machine having a private network address at all. Run it by hand:
 *
 *   npm run build && node scripts/fleet-acceptance.js
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const __dirname_repo = process.cwd();

function call(port, method, p, body, headers = {}, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host, port, path: p, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => { let b; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const procs = [];
  const dirs = [];
  const start = async (name, apiPort, fleetPort) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-fleet-${name}-`));
    dirs.push(dir);
    // Seed the config so each instance gets its own peer port. `enabled` stays
    // false — proving the default is what the SERVER chooses, not the harness.
    fs.writeFileSync(path.join(dir, 'fleet.json'), JSON.stringify({ port: fleetPort, label: name }));
    const p = spawn(process.execPath, ['dist/index.js'], {
      env: { ...process.env, PORT: String(apiPort), TREEMAP_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    await sleep(2500);
    return { name, apiPort, fleetPort, dir };
  };

  try {
    const A = await start('alpha', 4310, 4390);
    const B = await start('bravo', 4311, 4391);
    const C = await start('charlie', 4312, 4392);

    // 1. Off by default, on all three.
    for (const s of [A, B, C]) {
      const r = await call(s.apiPort, 'GET', '/api/fleet');
      console.log(`${s.name}: enabled=${r.body.enabled} running=${r.body.running} peers=${r.body.peers.length}`);
      if (r.body.enabled !== false) throw new Error(`${s.name} was enabled by default!`);
    }

    // 2. Opt A and B in. Charlie stays off — it is the unpaired third machine.
    const onA = await call(A.apiPort, 'PUT', '/api/fleet', { enabled: true, label: 'Alpha' });
    const onB = await call(B.apiPort, 'PUT', '/api/fleet', { enabled: true, label: 'Bravo' });
    console.log(`alpha enabled=${onA.body.enabled} running=${onA.body.running}`);
    console.log(`bravo enabled=${onB.body.enabled} running=${onB.body.running}`);
    if (!onA.body.running || !onB.body.running) {
      console.log('SKIP: no private LAN address on this machine — cannot bind a peer listener');
      return;
    }

    // 3. Pair A with B, using a code B is showing.
    const offer = await call(B.apiPort, 'POST', '/api/fleet/pairing');
    const bState = await call(B.apiPort, 'GET', '/api/fleet');
    const bAddr = bState.body.addresses[0];
    const paired = await call(A.apiPort, 'POST', '/api/fleet/peers', { address: bAddr, port: 4391, code: offer.body.code });
    console.log(`pairing A→B: status=${paired.status} peer=${paired.body.peer && paired.body.peer.label}`);
    if (paired.status !== 200) throw new Error('pairing failed: ' + JSON.stringify(paired.body));

    // 4. A can read B's summary, and it contains ONLY the allowed fields.
    const sum = await call(A.apiPort, 'GET', `/api/fleet/peers/${paired.body.peer.instanceId}/summary`);
    console.log('summary keys:', Object.keys(sum.body.summary).sort().join(','));
    const text = JSON.stringify(sum.body.summary);
    for (const banned of ['children', 'findings', 'provenance', 'id_rsa']) {
      if (text.includes(banned)) throw new Error(`summary leaked ${banned}`);
    }

    // 5. THE THIRD INSTANCE: unpaired, and must see nothing.
    const cState = await call(C.apiPort, 'GET', '/api/fleet');
    console.log(`charlie: enabled=${cState.body.enabled} peers=${cState.body.peers.length}`);
    // 5a. The peer surface is NOT on loopback — it binds the LAN address only.
    const loop = await call(4391, 'GET', '/fleet/summary', undefined, {}, '127.0.0.1');
    console.log(`bravo peer port on 127.0.0.1: status=${loop.status} (${loop.body.error || ''})`);
    if (loop.status !== 0) throw new Error('the peer server is listening on loopback');

    // 5b. Over the LAN address, unauthenticated, Charlie gets nothing.
    const direct = await call(4391, 'GET', '/fleet/summary', undefined, {}, bAddr);
    console.log(`charlie → bravo /fleet/summary unauthenticated: ${direct.status} ${JSON.stringify(direct.body)}`);
    if (direct.status !== 401) throw new Error('an unpaired instance got something!');
    const guessed = await call(4391, 'GET', '/fleet/summary', undefined, { Authorization: 'Bearer ' + 'a'.repeat(64) }, bAddr);
    console.log(`charlie → bravo with a guessed key: ${guessed.status}`);
    if (guessed.status !== 401) throw new Error('a guessed key worked!');
    const pairAttempt = await call(4391, 'POST', '/fleet/pair', { code: '000000' }, {}, bAddr);
    console.log(`charlie → bravo /fleet/pair with a guessed code: ${pairAttempt.status}`);
    if (pairAttempt.status === 200) throw new Error('a guessed pairing code worked!');
    // And Bravo's MAIN api is not on that port at all.
    const mainApi = await call(4391, 'GET', '/api/security/findings?scanId=x', undefined, {}, bAddr);
    console.log(`charlie → bravo /api/security/findings on the peer port: ${mainApi.status}`);
    if (mainApi.status === 200) throw new Error('the main API is reachable over the LAN!');

    // 6. Remote scan is refused until separately allowed.
    const scanTarget = path.join(process.cwd(), 'public');
    const refused = await call(A.apiPort, 'POST', `/api/fleet/peers/${paired.body.peer.instanceId}/trigger-scan`, { path: scanTarget });
    console.log(`remote scan before opt-in: ${refused.status}`);
    await call(B.apiPort, 'PUT', '/api/fleet', { allowRemoteScan: true });
    const allowed = await call(A.apiPort, 'POST', `/api/fleet/peers/${paired.body.peer.instanceId}/trigger-scan`, { path: scanTarget });
    console.log(`remote scan after opt-in: ${allowed.status} ${JSON.stringify(allowed.body)}`);

    // 7. It really ran ON BRAVO, and is reflected in Bravo's OWN state — the
    //    acceptance criterion is about the other machine's UI, not the caller's.
    let reflected = null;
    for (let i = 0; i < 20 && !reflected; i++) {
      await sleep(1000);
      const own = await call(B.apiPort, 'GET', '/api/scans');
      // /api/scans already returns only completed scans and carries no
      // `status` field — filtering on one matches nothing, forever.
      const done = ((own.body && own.body.scans) || []).find((sc) => sc.rootPath === scanTarget);
      if (done) reflected = done;
    }
    console.log('bravo\'s own scan list shows it:', reflected ? `${reflected.rootPath} (${reflected.fileCount} files)` : 'NOT FOUND');
    if (!reflected) throw new Error('the triggered scan never appeared on the other machine');
    const viaSummary = await call(A.apiPort, 'GET', `/api/fleet/peers/${paired.body.peer.instanceId}/summary`);
    console.log('and alpha sees it in the summary:', viaSummary.body.summary.lastScanPath);

    console.log('\nALL D1 ACCEPTANCE CHECKS PASSED');
  } finally {
    for (const p of procs) p.kill();
    await sleep(400);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
