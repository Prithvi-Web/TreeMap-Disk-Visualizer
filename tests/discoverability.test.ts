import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-disco-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { ENDPOINTS } from '../src/api/openapi';

/**
 * Discoverability contract: GET /api/openapi.json and GET /api/capabilities
 * must describe the API the server actually serves. These tests hold sampled
 * live responses to the spec — a field the code returns that the spec doesn't
 * know, or a required field the code stopped returning, fails here.
 */

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

/* ------------------------ schema helpers ------------------------ */

/** Follow $ref / allOf until we can list a schema's properties + required. */
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

function specResponseSchema(doc: any, specPath: string, method: string, status: string): any {
  const op = doc.paths[specPath]?.[method];
  assert.ok(op, `spec is missing ${method.toUpperCase()} ${specPath}`);
  const schema = op.responses?.[status]?.content?.['application/json']?.schema;
  assert.ok(schema, `spec has no ${status} JSON schema for ${method.toUpperCase()} ${specPath}`);
  return schema;
}

/** Every key the server returned must exist in the spec, and vice versa for required. */
function assertMatchesSpec(doc: any, specPath: string, method: string, status: string, payload: Record<string, unknown>): void {
  const { properties, required } = resolveSchema(doc, specResponseSchema(doc, specPath, method, status));
  for (const key of Object.keys(payload)) {
    assert.ok(key in properties, `server returned "${key}" for ${method.toUpperCase()} ${specPath} but the spec doesn't describe it`);
  }
  for (const key of required) {
    assert.ok(key in payload, `spec requires "${key}" for ${method.toUpperCase()} ${specPath} but the server didn't return it`);
  }
}

/* ------------------------------ tests ------------------------------ */

test('openapi.json is a well-formed OpenAPI 3 document with resolvable refs', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/openapi.json');
    assert.equal(r.status, 200);
    const doc = r.body;
    assert.equal(doc.openapi, '3.0.3');
    assert.equal(doc.info.title, 'TreeMap API');
    assert.equal(doc.info.version, require('../package.json').version);
    assert.ok(Object.keys(doc.paths).length >= 40, 'covers the API surface');

    // Every $ref anywhere in the document must resolve to a defined schema.
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(doc);
    assert.ok(refs.length > 0);
    for (const r2 of refs) {
      const name = r2.replace('#/components/schemas/', '');
      assert.ok(doc.components.schemas[name], `unresolvable $ref: ${r2}`);
    }
  } finally {
    await close();
  }
});

test('capabilities and openapi are generated from the same endpoint registry', async () => {
  const { port, close } = await listen();
  try {
    const caps = (await req(port, 'GET', '/api/capabilities')).body;
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;

    assert.equal(caps.version, require('../package.json').version);
    assert.equal(caps.endpoints.length, ENDPOINTS.length);
    for (const e of caps.endpoints) {
      const op = doc.paths[e.path]?.[e.method.toLowerCase()];
      assert.ok(op, `capabilities lists ${e.method} ${e.path} but the spec doesn't`);
      assert.equal(op.summary, e.summary, `summaries drifted for ${e.method} ${e.path}`);
      assert.equal(typeof e.destructive, 'boolean');
    }
    // The workflow and safety model are present and non-trivial.
    assert.ok(Array.isArray(caps.workflow) && caps.workflow.length >= 4);
    assert.ok(caps.safety.trashOnlyDeletes && caps.safety.scannedRootRule);
    assert.deepEqual(caps.mcp.tools.slice().sort(), [
      'cleanup_suggestions', 'compare_scans', 'find_duplicates', 'forecast',
      'get_largest', 'offload', 'scan_path', 'trash_paths',
    ]);
  } finally {
    await close();
  }
});

test('spec matches reality: GET /api/system', async () => {
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const r = await req(port, 'GET', '/api/system');
    assert.equal(r.status, 200);
    assertMatchesSpec(doc, '/api/system', 'get', '200', r.body);
  } finally {
    await close();
  }
});

test('spec matches reality: POST /api/scan round-trip and stats', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-disco-fixture-'));
  fs.writeFileSync(path.join(fixture, 'x.txt'), 'hello');
  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;

    const started = await req(port, 'POST', '/api/scan', { path: fixture });
    assert.equal(started.status, 202);
    assertMatchesSpec(doc, '/api/scan', 'post', '202', started.body);

    const scanId = started.body.scanId as string;
    let stats: any;
    for (let i = 0; i < 100; i++) {
      stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
      if (stats.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(stats.body.status, 'complete');
    assertMatchesSpec(doc, '/api/scan/{scanId}/stats', 'get', '200', stats.body);

    const result = await req(port, 'GET', `/api/scan/${scanId}/result`);
    assert.equal(result.status, 200);
    assertMatchesSpec(doc, '/api/scan/{scanId}/result', 'get', '200', result.body);

    const largest = await req(port, 'GET', `/api/large-files?scanId=${scanId}&minSize=0`);
    assert.equal(largest.status, 200);
    assertMatchesSpec(doc, '/api/large-files', 'get', '200', largest.body);
  } finally {
    await close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('capabilities marks exactly the destructive endpoints as destructive', async () => {
  const { port, close } = await listen();
  try {
    const caps = (await req(port, 'GET', '/api/capabilities')).body;
    const destructive = caps.endpoints.filter((e: any) => e.destructive).map((e: any) => `${e.method} ${e.path}`).sort();
    assert.deepEqual(destructive, [
      'DELETE /api/files',
      'POST /api/cloud/disconnect',
      'POST /api/cloud/trash',
      'POST /api/git/gc',
      'POST /api/offload',
      'POST /api/offload/restore',
      'POST /api/system/snapshots/purge',
      'POST /api/trash/empty',
      'PUT /api/settings',
    ]);
  } finally {
    await close();
  }
});

test('meta endpoints are read-only: they answer GET and never accept a body method', async () => {
  const { port, close } = await listen();
  try {
    for (const url of ['/api/openapi.json', '/api/capabilities']) {
      const post = await req(port, 'POST', url, {});
      assert.equal(post.status, 404, `${url} must not accept POST`);
    }
  } finally {
    await close();
  }
});
