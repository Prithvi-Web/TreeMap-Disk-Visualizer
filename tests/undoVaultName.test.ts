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
 * The server's strings are read through the TypeScript parser, so a sentence
 * split across a + is found even with a comment between its pieces; every
 * file under src/ is also read whole, comments included, so the code names the
 * feature one way too; and the built page is read whole, since anyone can view
 * its source.
 */

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The old name in any case, singular or plural, however it is split: a space,
 * a hyphen, any HTML entity (a no-break or thin space written as `&#160;`,
 * `&#x20;`, `&thinsp;`…), a line break, a comment marker that wrapped it
 * ("the Time\n  // Capsule keeps a copy"), or a page script's string joined
 * with + ("'the Time ' +\n  'Capsule'"). "timeCapsule" (an identifier) has no
 * separator, and a file name or id spelled with it is let through below.
 */
const OLD_NAME = /\btime(?:\s|-|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|\/\/|\/\*|\*|<!--|#|['"`]\s*\+\s*['"`])+capsules?\b/gi;

/**
 * "130-time-capsule-tab.js" and the like: the old words in lower case, joined
 * by one hyphen and glued to more of a file name or id, are a name a program
 * reads, never the name in a sentence. A capital letter, any other separator,
 * or a space on both sides ("a time-capsule copy") makes it prose again.
 */
function isFileNameOrId(text: string, at: number, hit: string): boolean {
  if (!/^time-capsules?$/.test(hit)) return false;
  const glued = /[\w./-]/;
  return glued.test(text[at - 1] ?? '') || glued.test(text[at + hit.length] ?? '');
}

/** Each place the old name stands in `text`, with a little of what is around it. */
function oldNameIn(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(OLD_NAME)) {
    const at = m.index ?? 0;
    if (isFileNameOrId(text, at, m[0])) continue;
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

/** Every file under `dir` (relative to the repo) whose name `keep` accepts, recursively. */
function filesUnder(dir: string, keep: (name: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel, keep));
    else if (keep(name)) out.push(rel);
  }
  return out.sort();
}

/** Every .ts file under `dir` (relative to the repo), recursively. */
function tsFilesUnder(dir: string): string[] {
  return filesUnder(dir, (name) => name.endsWith('.ts'));
}

/**
 * The one file in src/ that spells the old name, on purpose: it recognises the sentences TreeMap
 * saved before the rename, so that they are served in today's words (review F1.2). It may spell it
 * only on the left of each of its LEGACY_PHRASES pairs — a phrase it looks for, never one it says —
 * and those literals are blanked before either sweep reads it.
 */
const LEGACY_WORDING = path.join('src', 'services', 'legacyWording.ts');

/** The left of each [before, now] pair of LEGACY_PHRASES in `sf`, as source nodes. */
function legacyBeforeHalves(sf: ts.SourceFile): ts.StringLiteral[] {
  const out: ts.StringLiteral[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'LEGACY_PHRASES'
      && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
      for (const pair of n.initializer.elements) {
        if (ts.isArrayLiteralExpression(pair) && pair.elements.length === 2 && ts.isStringLiteral(pair.elements[0])) out.push(pair.elements[0]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** `rel`'s text as the sweeps read it: for legacyWording.ts, each pair's left half blanked. */
function sweptText(rel: string): string {
  const text = read(rel);
  if (rel !== LEGACY_WORDING) return text;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let out = text;
  for (const lit of legacyBeforeHalves(sf).reverse()) { // from the end, so the earlier offsets hold
    const start = lit.getStart(sf);
    out = `${out.slice(0, start)}'${' '.repeat(lit.end - start - 2)}'${out.slice(lit.end)}`;
  }
  return out;
}

/** `rel`'s string literals, each place they say the old name prefixed with the file. */
function oldNameInLiterals(rel: string): string[] {
  return oldNameIn(literalsOf(sweptText(rel), rel)).map((hit) => `${rel}: ${hit}`);
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

test('the old name is found in the plural, hyphenated, behind any HTML entity, and split across a page script\'s +', () => {
  for (const said of [
    'two Time Capsules', 'a Time-Capsule copy', 'a time-capsule copy', 'TIME-CAPSULE',
    'Time&#8201;Capsule', 'Time&#x20;Capsule', 'Time&thinsp;Capsule',
    "'Reading the Time ' +\n    'Capsule…'", '"the Time" + " Capsule"', '`kept in the Time ` +\n  `Capsule`',
  ]) {
    assert.equal(oldNameIn(said).length, 1, said);
  }
  for (const name of ['130-time-capsule-tab.js', '"app/130-time-capsule-tab.js",', 'timeCapsule', 'TimeCapsuleEntry', '/api/timecapsule', 'timecapsule.json']) {
    assert.deepEqual(oldNameIn(name), [], `${name} is a name a program reads, not the name in prose`);
  }
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

test('no sentence the server can say names "Time Capsule": every string in every .ts file under src/ (the page is read whole above)', () => {
  const files = tsFilesUnder('src').filter((rel) => !rel.startsWith(path.join('src', 'ui') + path.sep));
  for (const rel of ['services/timeCapsule.ts', 'middleware/pathGuard.ts', 'middleware/errorHandler.ts', 'utils/pathSanitizer.ts',
    'utils/copyVerify.ts', 'mcp/index.ts', 'server.ts']) {
    assert.ok(files.includes(path.join('src', rel)), `src/${rel} is read`);
  }
  assert.deepEqual(files.flatMap(oldNameInLiterals), []);
});

test('no comment in TreeMap\'s own source names "Time Capsule" either: every file under src/, read whole', () => {
  // The rename covers the comments that name the feature too, so a reader of
  // the code meets one name. Read whole, a comment that wrapped the name across
  // a line ("the Time\n * Capsule removes its copies") is found as well.
  const files = filesUnder('src');
  for (const rel of ['services/cartCommit.ts', 'ui/app/175-cleanup-cart.js', 'ui/styles/075-modals.css', 'ui/manifest.json']) {
    assert.ok(files.includes(path.join('src', rel)), `src/${rel} is read`);
  }
  assert.deepEqual(files.flatMap((rel) => oldNameIn(sweptText(rel)).map((hit) => `${rel}: ${hit}`)), []);
});

test('the one file let off spells the old name only in the phrases it looks for, and nothing else reads them', () => {
  const sf = ts.createSourceFile(LEGACY_WORDING, read(LEGACY_WORDING), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const halves = legacyBeforeHalves(sf);
  assert.ok(halves.length >= 18, `the pairs are found (${halves.length})`);
  for (const lit of halves) {
    assert.match(lit.text, /time capsule|the capsule/i, `"${lit.text}" is an old phrase, not a place to keep a sentence`);
  }
  assert.ok(oldNameIn(read(LEGACY_WORDING)).length > 0, 'unblanked, the file does spell it');
  assert.deepEqual(oldNameIn(sweptText(LEGACY_WORDING)), [], 'blanked, it spells it nowhere else — no comment, no right half');
  const readers = filesUnder('src').filter((rel) => rel !== LEGACY_WORDING && read(rel).includes('LEGACY_PHRASES'));
  assert.deepEqual(readers, [], 'only inTodaysWords reads the pairs, so a left half is only ever looked for, never said');
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
