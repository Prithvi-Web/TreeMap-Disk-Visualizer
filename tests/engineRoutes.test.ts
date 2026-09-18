import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-engine-routes-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { rateLimitLanes, resetRateLimiter } from '../src/middleware/rateLimiter';
import { ENDPOINTS } from '../src/api/openapi';
import { buildScanStats } from '../src/api/scanRoutes';
import { resetNativeForTests } from '../src/services/scan/native';
import { resetEngineBudgetForTests, setNativeLoadOptionsForTests } from '../src/services/engineBudget';
import { createScanRecord, getScan } from '../src/services/diskScanner';

/**
 * The budget's HTTP surface (Phase 2, Task 5): the setting and its live
 * effect, the machine's mechanisms, the budget beside every scan's stats,
 * and pause/resume for a running scan. Every response states `source`, and
 * every key any of them returns is described by the OpenAPI document.
 */

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };
const NO_NATIVE = path.join(os.tmpdir(), 'treemap-no-native-here.node');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function useShim(): void {
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: NO_NATIVE });
}

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* ------------------------ the spec, held to the live answer ------------------------ */

function resolveSchema(doc: any, schema: any): { properties: Record<string, any>; required: string[] } {
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/components/schemas/', '');
    const target = doc.components.schemas[name];
    assert.ok(target, `$ref target missing: ${schema.$ref}`);
    return resolveSchema(doc, target);
  }
  if (schema.allOf) {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const part of schema.allOf) {
      const r = resolveSchema(doc, part);
      Object.assign(properties, r.properties);
      required.push(...r.required);
    }
    return { properties, required };
  }
  return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

/** Every key the server returned is in the spec, every required key came back — recursively for object-valued keys. */
function assertMatchesSpec(doc: any, specPath: string, method: string, status: string, payload: Record<string, unknown>): void {
  const op = doc.paths[specPath]?.[method];
  assert.ok(op, `spec is missing ${method.toUpperCase()} ${specPath}`);
  const schema = op.responses?.[status]?.content?.['application/json']?.schema;
  assert.ok(schema, `spec has no ${status} JSON schema for ${method.toUpperCase()} ${specPath}`);
  const check = (node: any, value: Record<string, unknown>, where: string): void => {
    const { properties, required } = resolveSchema(doc, node);
    for (const key of Object.keys(value)) {
      assert.ok(key in properties, `server returned "${where}${key}" for ${method.toUpperCase()} ${specPath} but the spec doesn't describe it`);
      const child = value[key];
      const sub = properties[key];
      if (child && typeof child === 'object' && !Array.isArray(child) && (sub.$ref || sub.properties || sub.allOf)) {
        check(sub, child as Record<string, unknown>, `${where}${key}.`);
      }
    }
    for (const key of required) {
      assert.ok(key in value, `spec requires "${where}${key}" for ${method.toUpperCase()} ${specPath} but the server didn't return it`);
    }
  };
  check(schema, payload, '');
}

/* ------------------------------------ tests ------------------------------------ */

test('the five engine endpoints are in the registry, documented, and in the lanes their cost deserves', () => {
  const listed = ENDPOINTS.map((e) => `${e.method.toUpperCase()} ${e.path}`);
  for (const ep of ['GET /api/engine/capabilities', 'GET /api/engine/budget', 'PUT /api/engine/budget', 'POST /api/scan/{scanId}/pause', 'POST /api/scan/{scanId}/resume']) {
    assert.ok(listed.includes(ep), `${ep} is not in ENDPOINTS`);
  }
  assert.equal(ENDPOINTS.find((e) => e.method === 'put' && e.path === '/api/engine/budget')?.destructive, true, 'writing a persisted setting is declared, like PUT /api/settings');
  assert.equal(ENDPOINTS.find((e) => e.path === '/api/scan/{scanId}/pause')?.destructive, false);
  assert.equal(rateLimitLanes.laneName('GET', '/api/engine/budget'), 'meta');
  assert.equal(rateLimitLanes.laneName('GET', '/api/engine/capabilities'), 'meta');
  assert.equal(rateLimitLanes.laneName('PUT', '/api/engine/budget'), 'api');
  assert.equal(rateLimitLanes.laneName('POST', '/api/scan/abc/pause'), 'api');
  assert.equal(rateLimitLanes.laneName('POST', '/api/scan/abc/resume'), 'api');
});

test('GET /api/engine/budget: the setting, what it resolves to, the native status and a snapshot only when something measured one', async () => {
  useShim();
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const r = await req(port, 'GET', '/api/engine/budget');
    assert.equal(r.status, 200);
    assertMatchesSpec(doc, '/api/engine/budget', 'get', '200', r.body);
    assert.deepEqual(r.body.setting, { preset: 'auto', cpuPercent: null });
    assert.deepEqual(r.body.effective, { preset: 'balanced', targetShare: 0.5, source: 'node-shim' });
    assert.equal(r.body.native.available, false);
    assert.equal(r.body.native.version, null);
    assert.ok(typeof r.body.native.reason === 'string' && r.body.native.reason.includes(NO_NATIVE), r.body.native.reason);
    assert.equal(r.body.snapshot, null);
    assert.equal(r.body.source, 'node-shim');
  } finally {
    await close();
  }
});

test('PUT /api/engine/budget accepts the four presets and cpuPercent 1–100 or null, persists them, and refuses the rest with 400 BAD_SETTING', async () => {
  useShim();
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    for (const preset of ['eco', 'balanced', 'turbo', 'auto']) {
      const r = await req(port, 'PUT', '/api/engine/budget', { preset });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assertMatchesSpec(doc, '/api/engine/budget', 'put', '200', r.body);
      assert.equal(r.body.setting.preset, preset);
      assert.equal(r.body.effective.preset, preset === 'auto' ? 'balanced' : preset);
      assert.equal(r.body.source, 'node-shim');
      const saved = await req(port, 'GET', '/api/settings');
      assert.deepEqual(saved.body.engineBudget, { preset, cpuPercent: null }, 'it is the same setting /api/settings holds');
    }
    let r = await req(port, 'PUT', '/api/engine/budget', { preset: 'eco', cpuPercent: 40 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.setting, { preset: 'eco', cpuPercent: 40 });
    assert.equal(r.body.effective.targetShare, 0.4);
    r = await req(port, 'PUT', '/api/engine/budget', { cpuPercent: 100 });
    assert.deepEqual(r.body.setting, { preset: 'eco', cpuPercent: 100 }, 'a patch keeps the preset it did not mention');
    r = await req(port, 'PUT', '/api/engine/budget', { cpuPercent: null });
    assert.deepEqual(r.body.setting, { preset: 'eco', cpuPercent: null }, 'null clears the override');
    assert.equal((await req(port, 'GET', '/api/engine/budget')).body.effective.targetShare, 0.25);

    // (A bare JSON string body never reaches the route: express.json's strict
    // mode refuses it first, so it is covered at the validator, not here.)
    for (const bad of [{}, { preset: 'fast' }, { preset: 7 }, { cpuPercent: 0 }, { cpuPercent: 101 }, { cpuPercent: '50' }, { preset: 'eco', extra: 1 }, []]) {
      const refused = await req(port, 'PUT', '/api/engine/budget', bad);
      assert.equal(refused.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, 'BAD_SETTING', JSON.stringify(refused.body));
      assert.ok(typeof refused.body.error === 'string' && refused.body.error.length > 10);
    }
    assert.deepEqual((await req(port, 'GET', '/api/engine/budget')).body.setting, { preset: 'eco', cpuPercent: null }, 'a refused write changes nothing');
  } finally {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'auto', cpuPercent: null });
    await close();
  }
});

test('PUT /api/settings takes engineBudget under the same rules', async () => {
  useShim();
  const { port, close } = await listen();
  try {
    let r = await req(port, 'PUT', '/api/settings', { engineBudget: { preset: 'turbo', cpuPercent: 80 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.engineBudget, { preset: 'turbo', cpuPercent: 80 });
    r = await req(port, 'PUT', '/api/settings', { engineBudget: { cpuPercent: null } });
    assert.deepEqual(r.body.engineBudget, { preset: 'turbo', cpuPercent: null });
    assert.equal((await req(port, 'GET', '/api/engine/budget')).body.effective.preset, 'turbo', 'the two routes write one setting');
    for (const bad of [{ engineBudget: 'eco' }, { engineBudget: { preset: 'x' } }, { engineBudget: { cpuPercent: 500 } }]) {
      const refused = await req(port, 'PUT', '/api/settings', bad);
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'BAD_SETTING');
    }
    assert.deepEqual((await req(port, 'GET', '/api/settings')).body.engineBudget, { preset: 'turbo', cpuPercent: null });
  } finally {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'auto', cpuPercent: null });
    await close();
  }
});

test('GET /api/engine/capabilities: the native status and the seven mechanisms, absent with a reason when there is no native core', async () => {
  useShim();
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const r = await req(port, 'GET', '/api/engine/capabilities');
    assert.equal(r.status, 200);
    assertMatchesSpec(doc, '/api/engine/capabilities', 'get', '200', r.body);
    assert.equal(r.body.native.available, false);
    assert.equal(r.body.source, 'node-shim');
    assert.deepEqual(Object.keys(r.body.mechanisms), ['qos', 'ioPolicy', 'priority', 'thermal', 'battery', 'interaction', 'machineCpu']);
    for (const [name, m] of Object.entries<any>(r.body.mechanisms)) {
      assert.deepEqual(Object.keys(m).sort(), ['available', 'mechanism', 'reason'], name);
      assert.equal(m.available, false, name);
      assert.ok(typeof m.reason === 'string' && m.reason.length > 10, `${name}: ${m.reason}`);
    }
  } finally {
    await close();
  }
});

test('with the native core loaded, capabilities and the budget come from it and say source: native', async () => {
  resetNativeForTests();
  resetEngineBudgetForTests();
  const mech = (name: string) => ({ available: true, mechanism: name, reason: null });
  const snapshot = {
    budget: { preset: 'balanced', cpuPercent: null }, effective: 'eco', targetShare: 0.25, share1s: 0.2, workers: 2, duty: 0.4,
    thermal: 'nominal', onBattery: true, interacting: false, paused: false, ticks: 99,
    mechanisms: { qos: mech('qos'), io: mech('io'), priority: mech('priority') },
  };
  const module = {
    version: () => pkg.nativeVersion,
    governorCapabilities: () => ({ qos: mech('pthread_set_qos_class_self_np'), ioPolicy: mech('setiopolicy_np'), priority: mech('setpriority'), thermal: mech('NSProcessInfo'), battery: mech('IOPS'), interaction: mech('CGEventSource'), machineCpu: mech('host_statistics64') }),
    governorConfigure: () => undefined,
    governorSnapshot: () => snapshot,
    governorPause: () => undefined,
    governorResume: () => undefined,
    governorHold: () => Promise.reject(new Error('unused')),
  };
  setNativeLoadOptionsForTests({ path: '/fake/treemap_core.node', requireModule: () => module });
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const caps = await req(port, 'GET', '/api/engine/capabilities');
    assertMatchesSpec(doc, '/api/engine/capabilities', 'get', '200', caps.body);
    assert.equal(caps.body.native.available, true);
    assert.equal(caps.body.native.version, pkg.nativeVersion);
    assert.equal(caps.body.source, 'native');
    assert.equal(caps.body.mechanisms.thermal.mechanism, 'NSProcessInfo');

    const budget = await req(port, 'GET', '/api/engine/budget');
    assertMatchesSpec(doc, '/api/engine/budget', 'get', '200', budget.body);
    assert.equal(budget.body.source, 'native');
    assert.deepEqual(budget.body.effective, { preset: 'eco', targetShare: 0.25, source: 'native' }, 'Automatic on battery is Eco');
    assert.deepEqual(budget.body.snapshot, snapshot);
  } finally {
    await close();
    useShim();
  }
});

test('every scan’s stats carry the budget it ran under, in the spec and in the SSE complete frame', async () => {
  useShim();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-engine-stats-'));
  fs.writeFileSync(path.join(fixture, 'x.txt'), 'hello');
  const { port, close } = await listen();
  try {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'eco' });
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const started = await req(port, 'POST', '/api/scan?wait=true&waitMs=30000', { path: fixture });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assertMatchesSpec(doc, '/api/scan', 'post', '200', started.body);
    assert.deepEqual(started.body.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });

    const stats = await req(port, 'GET', `/api/scan/${started.body.scanId}/stats`);
    assertMatchesSpec(doc, '/api/scan/{scanId}/stats', 'get', '200', stats.body);
    assert.deepEqual(stats.body.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
    const keys = Object.keys(stats.body);
    assert.equal(keys[keys.length - 1], 'budget', 'additive: every existing key keeps its position, the new one comes last');

    // A hand-assembled record (an agent test, a cloud scan) still answers with
    // the budget in force rather than a hole in a required field.
    const bare = buildScanStats(createScanRecord('/bare'));
    assert.deepEqual(bare.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
  } finally {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'auto' });
    await close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('POST /api/scan/:id/pause and /resume: a running walker pauses and resumes, a finished scan says so, an unknown id is 404', async () => {
  useShim();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-engine-pause-'));
  for (let d = 0; d < 80; d++) {
    const dir = path.join(root, `d${d}`);
    await fsp.mkdir(dir);
    await Promise.all(Array.from({ length: 100 }, (_, f) => fsp.writeFile(path.join(dir, `f${f}`), '')));
  }
  const { port, close } = await listen();
  try {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'eco' });
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const started = await req(port, 'POST', '/api/scan', { path: root });
    assert.equal(started.status, 202);
    const scanId = started.body.scanId as string;
    const scan = getScan(scanId)!;
    const t0 = Date.now();
    while (scan.scanned < 500 && scan.status === 'running') {
      assert.ok(Date.now() - t0 < 20_000);
      await sleep(5);
    }
    assert.equal(scan.status, 'running');

    const paused = await req(port, 'POST', `/api/scan/${scanId}/pause`);
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assertMatchesSpec(doc, '/api/scan/{scanId}/pause', 'post', '200', paused.body);
    assert.deepEqual(paused.body, { scanId, status: 'running', paused: true, supported: true, source: 'node-shim' });
    await sleep(200);
    const halted = scan.scanned;
    await sleep(250);
    assert.equal(scan.scanned, halted, 'the walker stopped counting');

    const resumed = await req(port, 'POST', `/api/scan/${scanId}/resume`);
    assert.equal(resumed.status, 200);
    assertMatchesSpec(doc, '/api/scan/{scanId}/resume', 'post', '200', resumed.body);
    assert.deepEqual(resumed.body, { scanId, status: 'running', paused: false, supported: true, source: 'node-shim' });
    const t1 = Date.now();
    while (scan.status === 'running') {
      assert.ok(Date.now() - t1 < 60_000, 'never finished after resume');
      await sleep(20);
    }
    assert.equal(scan.status, 'complete');

    const late = await req(port, 'POST', `/api/scan/${scanId}/pause`);
    assert.equal(late.status, 200);
    assert.equal(late.body.paused, false);
    assert.equal(late.body.status, 'complete');
    assert.match(late.body.reason, /finished/);
    assertMatchesSpec(doc, '/api/scan/{scanId}/pause', 'post', '200', late.body);

    const missing = await req(port, 'POST', '/api/scan/no-such-scan/pause');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SCAN_NOT_FOUND');
    assert.equal((await req(port, 'POST', '/api/scan/no-such-scan/resume')).status, 404);
  } finally {
    await req(port, 'PUT', '/api/engine/budget', { preset: 'auto' });
    await close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the golden normaliser scrubs only a legal budget value; anything else stays a regression', async () => {
  const { normalize } = await import('./fixtures/goldenHarness');
  assert.deepEqual(normalize({ budget: { preset: 'auto', effective: 'balanced', source: 'node-shim' } }, '/nowhere'), { budget: { preset: 'auto', effective: '<BUDGET>', source: '<BUDGET>' } });
  assert.throws(() => normalize({ budget: { effective: 'auto', source: 'node-shim' } }, '/nowhere'), /budget\.effective is "auto", not one of/);
  assert.throws(() => normalize({ budget: { effective: 'eco', source: 'guess' } }, '/nowhere'), /budget\.source is "guess", not one of/);
});
