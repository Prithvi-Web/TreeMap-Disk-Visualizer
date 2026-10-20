import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { INDEX } from './fixtures/liftFrontend';

/**
 * The feature that copies what the cart and Autopilot delete, so a run can be
 * undone even after the Trash is emptied, is called the **Undo Vault** (the
 * owner's decision, 20 Oct 2026). It was "Time Capsule", which is also the name
 * of an Apple product. Every place a person reads the name says the new one:
 * the page, the server's sentences (errors, reasons, toasts, the log), the MCP
 * tools, the OpenAPI document and the docs a person reads.
 *
 * What a program reads keeps its name, because people and agents already
 * depend on it: the `/api/timecapsule…` routes, the two setting keys, the
 * capsule's folder and index file in app-data (existing copies must still be
 * found and restored), and the view id `capsule` behind its bookmarkable hash.
 * A careless sweep that renamed those goes RED here too.
 *
 * Comments in server code are not a surface a person reads, so the sweep of
 * src/ reads string literals only — but the built page is read whole, comments
 * included, since anyone can view its source.
 */

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The old name in any case, however it is split: a space, a no-break space
 * (written or as an entity), a line break, or a comment marker that wrapped it
 * ("the Time\n  // Capsule keeps a copy"). "timeCapsule" (an identifier) and
 * "time-capsule" (a file name) are not the name in prose.
 */
const OLD_NAME = /\btime(?:\s|&#160;|&#xa0;|&nbsp;|\/\/|\/\*|\*|<!--|#)+capsule\b/gi;

/** Each place the old name stands in `text`, with a little of what is around it. */
function oldNameIn(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(OLD_NAME)) {
    const at = m.index ?? 0;
    hits.push(JSON.stringify(text.slice(Math.max(0, at - 40), at + m[0].length + 30)));
  }
  return hits;
}

/**
 * The text of every string literal and template piece in a TypeScript file, in
 * source order — what the code can say, never what its comments say. Joined
 * with a space, so a sentence split across `'… the Time ' + 'Capsule …'` is
 * still found.
 */
function literalsOf(source: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.join(' ');
}

/** Every .ts file under `dir` (relative to the repo), recursively. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...tsFilesUnder(rel));
    else if (name.endsWith('.ts')) out.push(rel);
  }
  return out.sort();
}

/** `rel`'s string literals, each place they say the old name prefixed with the file. */
function oldNameInLiterals(rel: string): string[] {
  return oldNameIn(literalsOf(read(rel), rel)).map((hit) => `${rel}: ${hit}`);
}

/* ══════════════ The reader itself ══════════════ */

test('the literal reader finds the old name in strings and templates, however split, and never in comments', () => {
  const said = literalsOf([
    '// the Time Capsule keeps a copy',
    '/* Time Capsule (B3) */',
    "const a = 'nothing here';",
    "const b = `copied into the Time Capsule (${why})`;",
    "const c = 'kept in the Time ' +",
    "  'Capsule until it removes them';",
  ].join('\n'), 'probe.ts');
  assert.equal(oldNameIn(said).length, 2, said);
  assert.deepEqual(oldNameIn(literalsOf('// Time Capsule\n/** the Time\n * Capsule */\nconst x = 1;', 'probe.ts')), []);
  assert.equal(oldNameIn('timeCapsuleRetentionDays /api/timecapsule 130-time-capsule-tab.js').length, 0, 'identifiers, routes and file names are not the name');
  assert.equal(oldNameIn('🕰️ Time&#160;Capsule').length, 1, 'an SVG label with a no-break space is');
  assert.equal(oldNameIn('the Time\n  // Capsule keeps a copy').length, 1, 'a comment that wrapped it is');
});

/* ══════════════ Nowhere a person reads ══════════════ */

test('the page never says "Time Capsule" — not on screen, not in an aria-label or title, not in its source', () => {
  assert.deepEqual(oldNameIn(INDEX), [], 'public/index.html (rebuild with node scripts/build-ui.js)');
});

test('the docs a person reads never say "Time Capsule": README, AGENTS, SECURITY, the bug report form and the pictures they show', () => {
  const docs = ['README.md', 'AGENTS.md', 'SECURITY.md', '.github/ISSUE_TEMPLATE/bug_report.md'];
  const pictures = new Set(readdirSync(ROOT).filter((name) => name.endsWith('.svg')));
  for (const m of read('README.md').matchAll(/src="([^"]+\.svg)"/g)) pictures.add(m[1]);
  assert.ok(pictures.has('views.svg'), 'the README\'s picture of the views is read');
  const hits = [...docs, ...pictures].flatMap((rel) => oldNameIn(read(rel)).map((hit) => `${rel}: ${hit}`));
  assert.deepEqual(hits, []);
});

test('the MCP tools and the OpenAPI document never say "Time Capsule"', () => {
  assert.deepEqual([...oldNameInLiterals('src/mcp/server.ts'), ...oldNameInLiterals('src/api/openapi.ts')], []);
});

test('no sentence the server can say names "Time Capsule": every string in src/services, src/api and src/models', () => {
  const files = [...tsFilesUnder('src/services'), ...tsFilesUnder('src/api'), ...tsFilesUnder('src/models')];
  assert.ok(files.includes(path.join('src', 'services', 'timeCapsule.ts')), 'the capsule\'s own service is read');
  assert.deepEqual(files.flatMap(oldNameInLiterals), []);
});

/* ══════════════ The new name where a person looks for it ══════════════ */

/** The element of the page that opens at `open`, up to `close` after it. */
function slice(open: string, close: string): string {
  const start = INDEX.indexOf(open);
  assert.notEqual(start, -1, `the page has ${open}`);
  const end = INDEX.indexOf(close, start);
  assert.notEqual(end, -1, `${open} closes with ${close}`);
  return INDEX.slice(start, end + close.length);
}

test('the sidebar, the view and Settings call it the Undo Vault', () => {
  const button = slice('data-view="capsule"', '</button>');
  assert.match(button, /title="Undo Vault"/, `the sidebar button's tooltip: ${button}`);
  assert.match(button, /<span class="side-label">Undo Vault<\/span>/, `the sidebar label: ${button}`);

  const view = slice('<section class="view" id="view-capsule"', '</h2>');
  assert.match(view, /aria-label="Undo Vault"/, `the view's name for a screen reader: ${view}`);
  assert.match(view, /<h2><span data-icon="clock"><\/span>Undo Vault<\/h2>/, `the view's heading: ${view}`);

  assert.match(INDEX, /<div class="set-h"[^>]*><span data-icon="clock"><\/span>Undo Vault<\/div>/, 'the Settings section heading');
  assert.match(INDEX, /registerView\(\{\s+id: 'capsule',\s+label: 'Undo Vault',/, 'the view registry\'s label');
  assert.match(INDEX, /\{ name: 'Undo Vault', hint: '[^']+' \}/, 'the command palette finds it by its name');
});

/* ══════════════ What a program reads keeps its name ══════════════ */

test('the routes, the setting keys, the capsule\'s folder and the view id keep their names', () => {
  const routes = read('src/api/timeCapsuleRoutes.ts');
  for (const [method, route] of [['get', '/timecapsule'], ['post', '/timecapsule/:id/restore'], ['delete', '/timecapsule/:id'],
    ['post', '/timecapsule/jobs/:jobId/cancel'], ['get', '/timecapsule/jobs/:jobId/progress']]) {
    assert.ok(routes.includes(`timeCapsuleRouter.${method}('${route}'`), `${method.toUpperCase()} /api${route} is still served`);
  }
  const openapi = read('src/api/openapi.ts');
  for (const route of ['/api/timecapsule', '/api/timecapsule/{id}/restore', '/api/timecapsule/{id}',
    '/api/timecapsule/jobs/{jobId}/progress', '/api/timecapsule/jobs/{jobId}/cancel']) {
    assert.ok(openapi.includes(`path: '${route}',`), `the OpenAPI document still declares ${route}`);
  }
  assert.ok(INDEX.includes("api('/api/timecapsule')"), 'the page still reads the capsule from /api/timecapsule');

  const types = read('src/models/types.ts');
  const settings = read('src/services/settings.ts');
  for (const key of ['timeCapsuleRetentionDays', 'timeCapsuleMaxPercent']) {
    assert.ok(types.includes(`  ${key}: number;`), `AppSettings still has ${key}`);
    assert.ok(settings.includes(`raw.${key}`), `a saved settings file's ${key} is still read`);
    assert.ok(INDEX.includes(`settingsData.${key}`) && INDEX.includes(`${key}: Math.min(`), `the Settings sheet still reads and saves ${key}`);
  }

  const capsule = read('src/services/timeCapsule.ts');
  assert.ok(capsule.includes("const INDEX_FILE = 'timecapsule.json';"), 'the index existing copies are listed in is still found');
  assert.ok(capsule.includes("const CAPSULE_DIR = 'timecapsule';"), 'the folder existing copies sit in is still found');

  assert.match(INDEX, /registerView\(\{\s+id: 'capsule',/, 'the view id behind #capsule is still capsule');
  assert.ok(INDEX.includes('data-view="capsule"'), 'and the sidebar still opens it by that id');
});
