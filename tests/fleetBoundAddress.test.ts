import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('tm-fleet-bound-');

import { defaultConfig, saveFleetConfig, resetFleetConfig, startPeerServer, type FleetConfig } from '../src/services/fleet/fleetSync';
import { fleetRuntime } from '../src/services/fleet/fleetRuntime';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Hunt C64: the Fleet listener binds one private address, but GET /api/fleet listed every private
 * address of the machine and the panel said "Listening on" all of them — addresses nothing listens
 * on — and README and SECURITY.md said it binds "your private LAN addresses". Now the listener says
 * which address it bound, the route reports that one only, and the docs say one address.
 */

const summary = async () => ({}) as never;

test('the peer listener reports the one address it bound, not every address it was offered', async () => {
  const cfg: FleetConfig = { ...defaultConfig(), port: 0 };
  // 192.0.2.1 is TEST-NET-1: no machine has it, and the listener never binds it.
  const server = await startPeerServer(cfg, { summary, async startScan() { return { scanId: 'x' }; } }, ['127.0.0.1', '192.0.2.1']);
  try {
    assert.deepEqual(server.addresses, ['127.0.0.1']);
  } finally {
    await server.close();
  }
});

test('GET /api/fleet names only addresses the running listener is bound to — none while it is not running', async () => {
  resetRateLimiter();
  await saveFleetConfig({ ...defaultConfig(), enabled: true });
  const app = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  try {
    assert.equal(fleetRuntime().running, false, 'control: nothing was started here');
    const body = await new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      http.get({ host: '127.0.0.1', port: (app.address() as { port: number }).port, path: '/api/fleet', agent: false }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
    assert.deepEqual([body.enabled, body.running, body.addresses], [true, false, []]);
    assert.deepEqual(fleetRuntime().boundAddresses(), [], 'the runtime reports what it bound: nothing');
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    resetFleetConfig();
  }
});

test('README and SECURITY.md say the listener binds one private address', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const security = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  assert.doesNotMatch(readme, /binds your specific private IPv4 addresses/);
  assert.doesNotMatch(security, /bound to your private LAN addresses only/);
  assert.match(security, /bound to one of this machine's private network addresses/);
});
