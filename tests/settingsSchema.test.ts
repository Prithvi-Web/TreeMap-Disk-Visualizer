import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-settings-schema-');

import { buildOpenApiDocument } from '../src/api/openapi';
import { getSettings, updateSettings } from '../src/services/settings';

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

test('a scheduled scan\'s folder keeps the whitespace at its end — part of its name — and loses only leading whitespace, as sanitizePath reads a path (final review F1.4)', async () => {
  // normalizeSchedules trimmed both ends, on every save and every load of
  // settings.json, so a schedule for "Screenshots " scanned — and alerted
  // on — its sibling "Screenshots" from the next save on. Disabled here, so
  // no scheduler running in this process ever picks them up.
  await updateSettings({
    schedules: [
      { id: 'shots', path: '/Users/me/Screenshots ', intervalHours: 24, enabled: false },
      { id: 'docs', path: '  /Users/me/Documents', intervalHours: 24, enabled: false },
      { id: 'blank', path: '   ', intervalHours: 24, enabled: false },
    ],
  });
  const saved = (await getSettings()).schedules.map((s) => [s.id, s.path]);
  assert.deepEqual(saved, [['shots', '/Users/me/Screenshots '], ['docs', '/Users/me/Documents']],
    'the trailing space stays, leading whitespace goes, and a blank folder is no schedule');
  await updateSettings({ schedules: [] });
});

test('a folder budget keeps the whitespace at its end — part of its name — and loses only leading whitespace, as a schedule\'s folder does (final review F2.1)', async () => {
  // normalizeBudgets trimmed both ends after sanitizePath had kept the end,
  // so a budget set on "Screenshots " was stored as — and measured against —
  // its sibling "Screenshots", and the two folders' budgets collapsed into
  // one. The 1000-character cap applies to the path once its leading
  // whitespace is gone.
  const long = '/' + 'x'.repeat(1100);
  await updateSettings({
    budgets: [
      { path: '/Users/me/Screenshots ', maxBytes: 1000 },
      { path: '/Users/me/Screenshots', maxBytes: 2000 },
      { path: '  /Users/me/Documents', maxBytes: 3000 },
      { path: '   ', maxBytes: 4000 },
      { path: `   ${long}`, maxBytes: 5000 },
    ],
  });
  // A long path is shown by its start and length, so a failure reads.
  const shown = (p: string) => (p.length > 100 ? `${p.slice(0, 4)}… ${p.length} chars` : p);
  const saved = (await getSettings()).budgets.map((b) => [shown(b.path), b.maxBytes]);
  assert.deepEqual(saved, [
    ['/Users/me/Screenshots ', 1000],
    ['/Users/me/Screenshots', 2000],
    ['/Users/me/Documents', 3000],
    ['/xxx… 1000 chars', 5000],
  ], 'the trailing space stays (two folders, two budgets), leading whitespace goes, a blank folder is no budget, and the cap counts the path without its leading whitespace');
  await updateSettings({ budgets: [] });
});
