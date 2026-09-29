import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-storageModeTable-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { factProviderIds } from '../src/services/facts';
import { storageModeGate } from '../src/middleware/storageModeGate';
import { ENDPOINTS, buildOpenApiDocument } from '../src/api/openapi';
import {
  AVAILABILITY_MEANS,
  FEATURES,
  PROVIDER_FEATURES,
  ROUTE_FEATURES,
  STORAGE_MODES,
  TOOL_FEATURES,
  canBeOff,
  featuresOf,
  refusalSentence,
  type FeatureId,
  type RouteEntry,
} from '../src/services/storageMode';

/**
 * Phase 4 T17a (plan §S.7, P4-15): the availability table is the one source for what every
 * feature does in each storage mode, and it covers the app exactly. Nothing here is a hand
 * list: the routes are read from the running app's router, the tools from the MCP server's
 * own `tools/list`, the providers from the fact registry. A route, tool or provider the table
 * does not classify fails here by name, and so does a table entry naming one that does not
 * exist. Every route whose feature can be off carries the storage-mode gate right before its
 * handler, and every feature that can be off has somewhere it is refused.
 */

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle: { stack?: Layer[] };
  name: string;
  path?: string;
  match(p: string): boolean;
}

/** Every route the app registers, `METHOD /api/path`, with its own middleware stack. */
function registeredRoutes(): Map<string, { handle: unknown }[]> {
  const app = createApp(path.join(__dirname, '..', 'public')) as unknown as { router: { stack: Layer[] } };
  const routes = new Map<string, { handle: unknown }[]>();
  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.set(`${method.toUpperCase()} ${prefix}${layer.route.path}`, layer.route.stack);
        }
      } else if (Array.isArray(layer.handle.stack)) {
        // A mounted router keeps no path of its own; asking its matcher is how to learn it.
        const probe = ['/api/t17a-probe', '/t17a-probe'].find((p) => layer.match(p));
        assert.ok(probe !== undefined, `the router ${layer.name} is mounted somewhere this walk cannot see`);
        walk(layer.handle.stack, prefix + (layer.path ?? ''));
      }
    }
  };
  walk(app.router.stack, '');
  return routes;
}

/** The tools the MCP server lists, over a real client handshake. */
async function listedTools(): Promise<string[]> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'storage-mode-table-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

function difference(a: Iterable<string>, b: Iterable<string>): string[] {
  const other = new Set(b);
  return [...a].filter((x) => !other.has(x)).sort();
}

test('every route the app registers is classified, and the table names no route the app lacks', () => {
  const routes = registeredRoutes();
  assert.ok(routes.size >= 100, `the walk found the app's routes (${routes.size})`);
  assert.deepEqual(difference(routes.keys(), Object.keys(ROUTE_FEATURES)), [], 'routes the availability table does not classify');
  assert.deepEqual(difference(Object.keys(ROUTE_FEATURES), routes.keys()), [], 'table entries naming a route the app does not register');
});

test('every MCP tool the server lists is classified, and the table names no tool the server lacks', async () => {
  const tools = await listedTools();
  assert.ok(tools.length >= 10, `the server lists its tools (${tools.length})`);
  assert.deepEqual(difference(tools, Object.keys(TOOL_FEATURES)), [], 'MCP tools the availability table does not classify');
  assert.deepEqual(difference(Object.keys(TOOL_FEATURES), tools), [], 'table entries naming an MCP tool the server does not list');
});

test('every fact provider is classified, and the table names no provider the registry lacks', () => {
  const providers = factProviderIds();
  assert.ok(providers.length >= 6, `the registry holds its providers (${providers.length})`);
  assert.deepEqual(difference(providers, Object.keys(PROVIDER_FEATURES)), [], 'fact providers the availability table does not classify');
  assert.deepEqual(difference(Object.keys(PROVIDER_FEATURES), providers), [], 'table entries naming a provider the registry does not hold');
});

test('every entry names features that exist, and every feature says what it does in all three modes', () => {
  const entries: [string, RouteEntry][] = [...Object.entries(ROUTE_FEATURES), ...Object.entries(TOOL_FEATURES)];
  for (const [name, entry] of entries) {
    const named = featuresOf(entry);
    assert.ok(named.length > 0, `${name} names a feature`);
    for (const feature of named) assert.ok(feature in FEATURES, `${name} names ${feature}, which is not a feature`);
  }
  for (const [provider, feature] of Object.entries(PROVIDER_FEATURES)) {
    assert.ok(feature in FEATURES, `the provider ${provider} names ${feature}, which is not a feature`);
  }
  for (const [id, row] of Object.entries(FEATURES)) {
    assert.equal(row.memory, 'today', `${id}: memory mode is today's, for every feature`);
    for (const mode of STORAGE_MODES) {
      assert.ok(row[mode] in AVAILABILITY_MEANS, `${id} says what it does in ${mode} mode`);
    }
  }
});

test('the rows are §S.7’s: each row’s cells, and the features the plan names in it', () => {
  const cells = (row: number): string[] => [
    ...new Set(
      Object.values(FEATURES)
        .filter((f) => f.row === row)
        .map((f) => `${f.memory}/${f.spill}/${f.aggregate}`),
    ),
  ];
  assert.deepEqual(cells(1), ['today/exact/keptRows'], 'SSE complete, /result, /subtree, /treemap, snapshot, journal');
  assert.deepEqual(cells(2), ['today/exact/exactOrFlagged'], '/large-files, /file-types, /large-folders, get_largest, reclaim_ranked');
  assert.deepEqual(cells(3), ['today/asyncLookup/notKept'], '/nodes, /budgets, facts, knownSizeOf, /duplicates/detail');
  assert.deepEqual(cells(4), ['today/runner/off'], 'the full passes');
  assert.deepEqual(cells(5), ['today/fold/fold'], 'subtreeCount');
  assert.deepEqual(cells(6), ['today/off/off'], 'duplicates, near-duplicates, compare, empty folders, …');
  assert.deepEqual(cells(7), ['today/off/off'], 'Live mode and container expansion');
  assert.deepEqual(cells(8), ['today/today/today'], '/cost/estimate, /scans, missing-gigabytes, scheduler, fleet, /stats');
  const inRow = (row: number): FeatureId[] =>
    (Object.keys(FEATURES) as FeatureId[]).filter((id) => FEATURES[id].row === row);
  const named: Record<number, FeatureId[]> = {
    1: ['tree', 'snapshot', 'journal'],
    2: ['largest', 'fileTypes', 'reclaimRanked'],
    3: ['nodes', 'budgets', 'facts', 'knownSizeOf', 'duplicateDetail'],
    4: ['cleanupSuggestions', 'customRules', 'query', 'calendar', 'security', 'cloudSafe', 'compression', 'git',
      'packages', 'games', 'media', 'appAttribution', 'browserProfiles', 'humanScale', 'folderExport'],
    5: ['subtreeCount'],
    6: ['duplicates', 'nearDuplicates', 'compare', 'emptyFolders', 'customRulesDup', 'fileExport', 'folderOffload'],
    7: ['liveMode', 'containerExpansion'],
    8: ['costEstimate', 'scanList', 'missingGigabytes', 'scheduler', 'fleet', 'stats'],
  };
  for (const [row, ids] of Object.entries(named)) {
    for (const id of ids) assert.ok(inRow(Number(row)).includes(id), `${id} is in §S.7's row ${row}`);
  }
  // A feature the plan does not name says why it sits in its row.
  const planNamed = new Set(Object.values(named).flat());
  for (const id of Object.keys(FEATURES) as FeatureId[]) {
    if (!planNamed.has(id)) assert.ok('classified' in FEATURES[id], `${id} is not §S.7's, so it says why it sits in row ${FEATURES[id].row}`);
  }
});

test('every route whose feature can be off carries the storage-mode gate, right before its handler', () => {
  const routes = registeredRoutes();
  const ungated: string[] = [];
  const misplaced: string[] = [];
  for (const [route, entry] of Object.entries(ROUTE_FEATURES)) {
    const stack = routes.get(route);
    if (!stack) continue; // the coverage test above names it
    const gated = stack.some((layer) => layer.handle === storageModeGate);
    const refusedInRun = typeof entry !== 'string' && 'refusedIn' in entry;
    if (!featuresOf(entry).some(canBeOff) || refusedInRun) {
      if (gated) misplaced.push(`${route} carries the gate but nothing it serves is ever off`);
      continue;
    }
    if (!gated) ungated.push(route);
    else if (stack[stack.length - 2]?.handle !== storageModeGate) misplaced.push(`${route}: the gate is not the last step before the handler`);
  }
  assert.deepEqual(ungated, [], 'routes serving a feature that can be off, with no gate');
  assert.deepEqual(misplaced, []);
});

test('every feature that can be off is refused somewhere: a gated route, a tool, a provider or its run', () => {
  const refusable = new Set<FeatureId>();
  for (const entry of [...Object.values(ROUTE_FEATURES), ...Object.values(TOOL_FEATURES)]) {
    for (const feature of featuresOf(entry)) refusable.add(feature);
  }
  for (const feature of Object.values(PROVIDER_FEATURES)) refusable.add(feature);
  const nowhere = (Object.keys(FEATURES) as FeatureId[]).filter((id) => canBeOff(id) && !refusable.has(id));
  assert.deepEqual(nowhere, [], 'features that are off in a mode, with nothing that could refuse them');
});

test('a refusal says the feature, the mode, why, and what a person can do', () => {
  const spill = refusalSentence('duplicates', 'spill');
  assert.match(spill, /^Duplicate finding is off for this scan\./);
  assert.match(spill, /spill mode/);
  assert.match(spill, /holds something in memory for every file/);
  assert.match(spill, /Scan a smaller folder/);
  const aggregate = refusalSentence('cleanupSuggestions', 'aggregate');
  assert.match(aggregate, /^The Smart Suggestions list is off for this scan\./);
  assert.match(aggregate, /aggregate mode, which keeps a summary/);
  assert.match(aggregate, /needs every file/);
  assert.match(refusalSentence('liveMode', 'spill'), /a spill scan cannot be changed once it is walked, and Live mode changes it/);
  assert.match(refusalSentence('containerExpansion', 'aggregate'), /an aggregate scan cannot be changed once it is walked/);
});

test('the capability manifest tells an agent about both refusals', async () => {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const caps = await new Promise<{ safety: Record<string, string> }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/capabilities' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.match(String(caps.safety.spillFolder), /SPILL_PATH/, 'the manifest\'s safety rules name the spill folder\'s refusal');
    assert.match(String(caps.safety.storageModes), /STORAGE_MODE/, 'and the storage-mode refusal');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the published spec documents the refusal on exactly the endpoints that can give it', () => {
  const doc = buildOpenApiDocument() as {
    info: { description: string };
    paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
  };
  assert.match(doc.info.description, /STORAGE_MODE/, 'the spec says what the refusal is');
  assert.match(doc.info.description, /SPILL_PATH/, 'and what the spill folder\'s refusal is');
  let documented = 0;
  for (const ep of ENDPOINTS) {
    const key = `${ep.method.toUpperCase()} ${ep.path.replace(/\{(\w+)\}/g, ':$1')}`;
    const entry = ROUTE_FEATURES[key];
    assert.ok(entry !== undefined, `${key}, in the spec, is in the table`);
    const said = doc.paths[ep.path][ep.method].responses['409']?.description ?? '';
    const off = featuresOf(entry).filter(canBeOff);
    if (off.length > 0) {
      documented++;
      assert.match(said, /STORAGE_MODE/, `${key} documents its 409 STORAGE_MODE`);
      for (const feature of off) assert.ok(said.includes(FEATURES[feature].label), `${key} names ${feature}`);
      const own = (ep.responses['409'] as { description?: string } | undefined)?.description;
      if (own) assert.ok(said.startsWith(own), `${key} keeps its own 409 (${own})`);
    } else {
      assert.doesNotMatch(said, /STORAGE_MODE/, `${key} never refuses by storage mode`);
    }
  }
  assert.equal(documented, 24, 'the 23 gated routes and Autopilot\'s simulate');
});
