import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-settings-schema-');

import { buildOpenApiDocument } from '../src/api/openapi';
import { getSettings } from '../src/services/settings';

/**
 * GET /api/settings answers every key of AppSettings, always (getSettings
 * normalises each one), so the published schema must describe exactly those
 * keys and require them all. It had drifted: the Time Capsule's retention and
 * size cap were answered and accepted by PUT /api/settings but absent from the
 * AppSettings schema, so a client generated from GET /api/openapi.json dropped
 * them.
 */

interface Schema { properties: Record<string, unknown>; required: string[] }

test('the published AppSettings schema describes and requires exactly the keys GET /api/settings answers', async () => {
  const answered = Object.keys(await getSettings()).sort();
  const doc = buildOpenApiDocument() as { components: { schemas: Record<string, Schema> } };
  const schema = doc.components.schemas.AppSettings;
  assert.deepEqual(Object.keys(schema.properties).sort(), answered, 'every answered key is described, and nothing else');
  assert.deepEqual([...schema.required].sort(), answered, 'and every one is required, since every one is always answered');
});
