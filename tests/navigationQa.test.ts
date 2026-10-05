import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * Finding your way around (QA, 5 Oct 2026 — batch QA-4a).
 *
 *  - D03: the sidebar drew Disk City and Apps with the same "box" glyph,
 *    Autopilot and Clean Up with the same sparkles, and Dashboard and Grid as
 *    two arrangements of four rounded squares — at 16 px, the same picture.
 *
 * Everything is read out of the built page: the sidebar markup, the icon
 * table the page draws from, and the view registry.
 */

/** The sidebar's navigation entries: every view tab, then the Clean Up button. */
function sidebarEntries(): { name: string; icon: string }[] {
  const nav = INDEX.slice(INDEX.indexOf('<nav class="tabbar"'), INDEX.indexOf('</nav>', INDEX.indexOf('<nav class="tabbar"')));
  const tabs = [...nav.matchAll(/data-view="([\w-]+)" title="[^"]*"><span data-icon="(\w+)">/g)]
    .map((m) => ({ name: m[1], icon: m[2] }));
  assert.ok(tabs.length >= 15, `found the sidebar's view tabs (${tabs.length})`);
  const clean = /id="cleanupBtn"[^>]*><span data-icon="(\w+)">/.exec(INDEX);
  assert.ok(clean, 'the sidebar has its Clean Up button');
  return [...tabs, { name: 'Clean Up', icon: clean![1] }];
}

const PATHS = lift<Record<string, string>>(['PATHS'], 'PATHS');

/** The element names a glyph is drawn from, e.g. ['rect', 'rect', 'rect', 'rect']. */
const shapes = (svg: string) => [...svg.matchAll(/<(\w+)/g)].map((m) => m[1]);

test('every sidebar entry has its own glyph — no two share an icon (D03)', () => {
  const entries = sidebarEntries();
  const byIcon = new Map<string, string[]>();
  for (const e of entries) byIcon.set(e.icon, [...(byIcon.get(e.icon) ?? []), e.name]);
  const shared = [...byIcon].filter(([, names]) => names.length > 1).map(([icon, names]) => `${icon}: ${names.join(' + ')}`);
  assert.deepEqual(shared, [], 'each icon is used by one sidebar entry');
  for (const e of entries) assert.ok(PATHS[e.icon], `${e.name}'s icon "${e.icon}" is drawn, not the fallback file glyph`);
  const byDrawing = new Map<string, string[]>();
  for (const e of entries) byDrawing.set(PATHS[e.icon], [...(byDrawing.get(PATHS[e.icon]) ?? []), e.name]);
  const sameDrawing = [...byDrawing.values()].filter((names) => names.length > 1);
  assert.deepEqual(sameDrawing, [], 'and no two names draw the same picture');
});

test('no two sidebar glyphs are the same number of plain rectangles — Dashboard was Grid rearranged (D03)', () => {
  // A glyph built only from rounded rectangles reads as its count at 16 px:
  // four rects in a masonry and four rects in a 2×2 are the same picture.
  const byCount = new Map<number, string[]>();
  for (const e of sidebarEntries()) {
    const s = shapes(PATHS[e.icon]);
    if (!s.length || s.some((tag) => tag !== 'rect')) continue;
    byCount.set(s.length, [...(byCount.get(s.length) ?? []), e.name]);
  }
  const alike = [...byCount].filter(([, names]) => names.length > 1).map(([n, names]) => `${n} rects: ${names.join(' + ')}`);
  assert.deepEqual(alike, [], 'rectangle-only glyphs differ in how many rectangles they have');
});

test('the view registry names the same icon as the sidebar tab for every view (D03)', () => {
  const registry = new Map<string, string>();
  for (const m of INDEX.matchAll(/id: '([\w-]+)',\s*label: '[^']*',\s*icon: '(\w+)'/g)) registry.set(m[1], m[2]);
  for (const e of sidebarEntries()) {
    if (e.name === 'Clean Up') continue;
    if (!registry.has(e.name)) continue; // a view registered without an icon field
    assert.equal(registry.get(e.name), e.icon, `the ${e.name} view's registry icon matches its tab`);
  }
  assert.ok(['dashboard', 'city', 'apps', 'autopilot'].every((v) => registry.has(v)), 'the views D03 named are all registered with an icon');
});

/* ══════════════ D68 — the palette lists views in the sidebar's order ══════════════ */

type View = { id: string; label: string };

/** cmdkItems, as shipped, over a given registry and sidebar — only the view rows are read. */
function paletteViews(views: View[], sidebarIds: string[]): string[] {
  const start = INDEX.indexOf('function cmdkItems(');
  assert.notEqual(start, -1, 'cmdkItems is in the page');
  const order = INDEX.indexOf('function cmdkViewOrder(');
  assert.notEqual(order, -1, 'the palette has one function that orders the views');
  const body = (at: number) => {
    let depth = 0;
    for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
    }
    return assert.fail('unbalanced function');
  };
  const tabs = sidebarIds.map((id) => ({ dataset: { view: id } }));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const items = new Function(
    'VIEWS', 'tabs',
    `'use strict';
     const CMDK_ACTIONS = [], CMDK_SETTINGS_SECTIONS = [], cmdkRoots = [];
     const state = { savedViews: [], root: null };
     function viewBlockedReason() { return null; }
     function switchView() {}
     ${body(order)}
     ${body(start)}
     return cmdkItems();`,
  )(views, tabs) as { label: string; hint: string }[];
  return items.filter((i) => i.hint === 'view').map((i) => i.label);
}

test('the command palette lists views in the order the sidebar shows them, not registration order (D68)', () => {
  const sidebar = sidebarEntries().filter((e) => e.name !== 'Clean Up').map((e) => e.name);
  // Registered in another order — Disk City and Autopilot register late, from their own files.
  const registry: View[] = [...sidebar].reverse().map((id) => ({ id, label: `L-${id}` }));
  assert.deepEqual(paletteViews(registry, sidebar), sidebar.map((id) => `L-${id}`));
});

test('a view with no sidebar tab still appears, after the tabbed ones, in registry order (D68)', () => {
  const views: View[] = [{ id: 'extraA', label: 'Extra A' }, { id: 'b', label: 'B' }, { id: 'extraB', label: 'Extra B' }, { id: 'a', label: 'A' }];
  assert.deepEqual(paletteViews(views, ['a', 'b']), ['A', 'B', 'Extra A', 'Extra B'], 'none vanish; the palette never lies about what exists');
});
