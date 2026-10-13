import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-openapiDeclared-data-');

import { buildOpenApiDocument } from '../src/api/openapi';

/**
 * What GET /api/openapi.json declares for a route is what the route sends (the final review, F1.17,
 * F1.18, F1.19, F1.22, F1.23, F1.24): codes the code throws that were declared nowhere, a field a
 * dry run always sends that its schema left out, a 202 body of the wrong shape, a sentence about a
 * field no frame carries, and the Idempotency-Key header missing from the two idempotent cart routes.
 * An agent generated from the document branches on these.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = buildOpenApiDocument() as Json;
const op = (method: string, route: string): Json => {
  const found = doc.paths?.[route]?.[method];
  assert.ok(found, `${method.toUpperCase()} ${route} is in the document`);
  return found as Json;
};
const said = (method: string, route: string, status: string): string => String(op(method, route).responses?.[status]?.description ?? '');
const REPO = path.join(__dirname, '..');
const source = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('a restore and both undos name every 409 the restore they start can answer, PATH_UNREADABLE included, and an undo says it is refused whole rather than half done (F1.17, F1.18, F1.23)', () => {
  const codes = ['PATH_OCCUPIED', 'PATH_UNREADABLE', 'PAYLOAD_GONE', 'MANIFEST_UNREADABLE', 'CAPSULE_RECORD_INVALID'];
  const missing: string[] = [];
  for (const [method, route] of [['post', '/api/timecapsule/{id}/restore'], ['post', '/api/cart/undo'], ['post', '/api/autopilot/runs/{id}/undo']]) {
    for (const code of codes) if (!said(method, route, '409').includes(code)) missing.push(`${route}: ${code}`);
  }
  assert.deepEqual(missing, []);
  // The code throws these where the restore starts (timeCapsule.ts), so the lists hold no code it does not send.
  const capsule = source('src/services/timeCapsule.ts');
  assert.deepEqual(codes.filter((code) => !capsule.includes(`'${code}'`)), [], 'each is a code the Time Capsule throws');
});

test('an undo\'s unrestorable names what it really carries: a copy that is gone, or a record whose id is not one TreeMap gives — not every record TreeMap did not make (F1.17)', () => {
  for (const route of ['/api/cart/undo', '/api/autopilot/runs/{id}/undo']) {
    const unrestorable = String(op('post', route).responses?.['202']?.content?.['application/json']?.schema?.properties?.unrestorable?.items?.description ?? '');
    assert.match(unrestorable, /id is not one TreeMap gives/, route);
  }
});

test('the index result\'s 202 is the body the route sends — status, phase, processed, currentPath — and no frame is said to carry a field it does not (F1.19, F1.23)', () => {
  const body = op('get', '/api/index/{jobId}/result').responses?.['202']?.content?.['application/json']?.schema as Json;
  assert.deepEqual(Object.keys(body?.properties ?? {}).sort(), ['currentPath', 'phase', 'processed', 'status']);
  assert.doesNotMatch(said('get', '/api/index/{jobId}/progress', '200'), /error frame's processed/);
  const routes = source('src/api/indexRoutes.ts');
  assert.match(routes, /res\.status\(202\)\.json\(\{ status: 'running', phase: job\.phase, processed: job\.processed, currentPath: job\.currentPath \}\)/, 'the route sends that body');
});

test('a delete\'s dry-run manifest declares openHandles, and the cart\'s dry run declares the carryOver it takes and gives back (F1.22)', () => {
  const manifest = doc.components?.schemas?.TrashDryRunManifest as Json;
  assert.ok(manifest?.properties?.openHandles, 'TrashDryRunManifest.openHandles');
  const commit = op('post', '/api/cart/commit');
  assert.ok(commit.requestBody?.content?.['application/json']?.schema?.properties?.carryOver, 'the request\'s carryOver');
  assert.ok(commit.responses?.['200']?.content?.['application/json']?.schema?.properties?.carryOver, 'the dry run\'s carryOver');
});

test('the offload reveal declares 400 ID_REQUIRED and 403 OUTSIDE_DEST_ROOT (F1.23)', () => {
  assert.match(said('post', '/api/offload/reveal', '400'), /ID_REQUIRED/);
  assert.match(said('post', '/api/offload/reveal', '403'), /OUTSIDE_DEST_ROOT/);
});

test('a snapshot restore and a relocation declare their 400 and 403 (F1.23)', () => {
  assert.match(said('post', '/api/system/snapshots/restore', '400'), /PATH_REQUIRED/);
  assert.match(said('post', '/api/system/snapshots/restore', '403'), /SPILL_PATH[\s\S]*APP_DATA_PATH/);
  assert.match(said('post', '/api/security/relocate', '400'), /CONFIRM_REQUIRED[\s\S]*DEST_REQUIRED/);
  assert.match(said('post', '/api/security/relocate', '403'), /OUTSIDE_SCAN_ROOT/);
});

test('every route that refuses a safety record — by its middleware, or through the Trash step or the refusal it reaches — and every other place the document names SAFETY_RECORD, lists the cases the refusal itself names: the agent policy or the audit log, a folder that holds them, or a folder or link TreeMap reaches them through — a folder holding such a link among them', () => {
  // The refusal's own sentence (safetyRecordRefusal), read from the code.
  assert.ok(source('src/middleware/pathGuard.ts').includes('agent policy or its audit log, a folder that holds them, or a folder or link TreeMap reaches them through'), 'the refusal names these cases');
  const cases = 'the agent policy or the audit log, a folder that holds them (app-data, a folder above it), or a folder or link TreeMap reaches them through';
  const verdict = (text: string): string => (!text.includes('SAFETY_RECORD') ? 'does not name SAFETY_RECORD' : text.includes(cases) ? 'names its cases' : 'names SAFETY_RECORD without all its cases');
  const verdicts: Record<string, string> = {};
  let doors = 0;
  for (const name of fs.readdirSync(path.join(REPO, 'src', 'api')).filter((file) => file.endsWith('Routes.ts'))) {
    for (const m of source(path.join('src', 'api', name)).matchAll(/\w+Router\.(get|post|put|delete|patch)\('([^']+)',[^\n]*\brefuseSafetyRecords\b/g)) {
      const route = `/api${m[2].replace(/:(\w+)/g, '{$1}')}`;
      verdicts[`${m[1].toUpperCase()} ${route}, its 403`] = verdict(said(m[1], route, '403'));
      doors++;
    }
  }
  assert.ok(doors >= 4, `the delete, the offload, the cart commit and the relocation refuse a safety record (found ${doors})`);
  // A route refuses one without that middleware too: the Trash step and the Time Capsule refuse a
  // safety record whatever asked them, and a snapshot restore's overwrite reaches the Trash step (the
  // review of LEFT2, F1.3). Every place in src that refuses one, with the routes whose answer carries
  // that 403 — or why none does. A place the table does not name fails here until it does.
  const refusers: Record<string, string | string[]> = {
    'src/middleware/pathGuard.ts': 'the refusal itself, and the middleware the routes above carry',
    'src/services/cleaner.ts': 'the Trash step, reached by the places below',
    'src/services/timeCapsule.ts': 'the Time Capsule, reached by the cart commit and Autopilot below',
    'src/api/fileRoutes.ts': ['delete /api/files'],
    'src/services/cartCommit.ts': ['post /api/cart/commit'],
    'src/services/securityHygieneScanner.ts': ['post /api/security/relocate'],
    'src/services/snapshotRecovery.ts': ['post /api/system/snapshots/restore'],
    'src/services/offload.ts': 'the offload job, which trashes the originals after its route has answered 202',
    'src/services/compressionAdvisor.ts': 'the encode job, which trashes an original after its route has answered 202',
    'src/services/autopilot.ts': 'a run Autopilot starts itself: a refusal there is a failed run, not an answer to a request',
    'src/mcp/server.ts': 'the MCP tools, which answer in their own words rather than over HTTP',
  };
  const refusing = /(?<!function )\b(?:moveToTrash|protectAndTrash|assertNotSafetyRecord|safetyRecordRefusal)\(/;
  const found = (fs.readdirSync(path.join(REPO, 'src'), { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => ['src', ...rel.split(path.sep)].join('/'))
    .filter((rel) => refusing.test(source(rel)));
  assert.deepEqual(found.sort(), Object.keys(refusers).sort(), 'every place that refuses a safety record is in the table');
  for (const routes of Object.values(refusers)) {
    if (typeof routes === 'string') continue;
    for (const door of routes) {
      const [method, route] = door.split(' ');
      verdicts[`${method.toUpperCase()} ${route}, its 403`] = verdict(said(method, route, '403'));
    }
  }
  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'string') {
      if (value.includes('SAFETY_RECORD')) verdicts[at] = verdict(value);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${at}/${key}`);
    }
  };
  walk(doc, '#');
  assert.ok('#/info/description' in verdicts, 'the document\'s own description names SAFETY_RECORD');
  assert.deepEqual(verdicts, Object.fromEntries(Object.keys(verdicts).map((at) => [at, 'names its cases'])));
});

test('every route the idempotency middleware wraps declares the Idempotency-Key header, the cart\'s two included (F1.24)', () => {
  const missing: string[] = [];
  const routeFiles = fs.readdirSync(path.join(REPO, 'src', 'api')).filter((name) => name.endsWith('Routes.ts'));
  for (const name of routeFiles) {
    const text = source(path.join('src', 'api', name));
    for (const m of text.matchAll(/\w+Router\.(get|post|put|delete|patch)\('([^']+)',\s*idempotency\b/g)) {
      const route = `/api${m[2].replace(/:(\w+)/g, '{$1}')}`;
      const params = (op(m[1], route).parameters ?? []) as Json[];
      if (!params.some((p) => p.name === 'Idempotency-Key' && p.in === 'header')) missing.push(`${m[1].toUpperCase()} ${route}`);
    }
  }
  assert.deepEqual(missing, []);
});
