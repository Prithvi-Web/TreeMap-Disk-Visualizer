import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { INDEX, lift } from './fixtures/liftFrontend';

const ROOT = path.join(__dirname, '..');

/**
 * Design pass G18 (BQL item 13): the page named one feature three ways —
 * "Clean Up", "Cleanup" and "the cleanup cart" — and its buttons mixed Title
 * Case with sentence case. The owner delegated the call; the coordinator's
 * decision, held here:
 *
 * - Where the page names TreeMap's feature or view it says "Clean Up", two
 *   words, as the sidebar does: "the Clean Up cart", "Clean Up target". The
 *   noun in plain English ("a cleanup rule pack") may stay lower case.
 * - Buttons and modal titles are in sentence case, but for proper names: the
 *   feature and view names, and the system's own (the Trash, Terminal…).
 *
 * Only what a person reads is judged: the markup's text and its titles,
 * aria-labels, placeholders and alt text, and the strings of the page's
 * scripts. Comments are left out, and so are ids, classes, routes and setting
 * keys (`cleanupBtn`, `/api/cleanup/…`, `cleanupGoalBytes`), which a program
 * reads and which keep their names.
 */

/** The markup outside the scripts and styles, its comments taken out. */
function markupOf(page: string): string {
  return page
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Each JavaScript script of the page, reprinted without its comments (a JSON data script is not one). */
function scriptsOf(page: string): string[] {
  const printer = ts.createPrinter({ removeComments: true });
  return [...page.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type="application\/json"/i.test(m[1]))
    .map((m) => printer.printFile(ts.createSourceFile('page.js', m[2], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)));
}

/** The text of every string literal and template piece in `code`, in source order. */
function literalsOf(code: string): string[] {
  const sf = ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every TypeScript file under `dir` (relative to the repository), in path order. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

/**
 * Each string literal and template piece of the TypeScript under `dirs`, with
 * the file and line it is on. Comments are not strings, so they are left out,
 * as the page's are. The file is named from the repository with forward
 * slashes on every system — Windows' path.relative gives backslashes — so a
 * name reads, and compares, alike everywhere. `p` is the path module that
 * names it, the host's unless a test hands it another system's.
 */
function sourceStrings(dirs: string[], p: path.PlatformPath = path): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const file of dirs.flatMap(tsFilesUnder)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
        || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        out.push({ at: `${p.relative(ROOT, file).split(p.sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`, text: n.text });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** What a person reads in `markup`: its text, and the words of its titles, aria-labels, placeholders and alt text. */
function readableMarkup(markup: string): string {
  const attrs = [...markup.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  return [markup.replace(/<[^>]*>/g, ' '), ...attrs].join('\n');
}

/** Everything a person can read on the page, as text: the markup's, and every string its scripts hold. */
function pageText(page: string): string {
  const scripts = scriptsOf(page);
  return [readableMarkup(markupOf(page)), ...scripts.flatMap(literalsOf)].join('\n');
}

/**
 * The one sentence left to the map's own batch (BQJ-2c is reworking the map
 * and its key, and the key's tooltip is its words): tmMarksKey's "In the
 * cleanup cart". Allowed while it stands, and not required: once that batch
 * says "the Clean Up cart" there, nothing here needs changing.
 */
const LEFT_TO_THE_MAP = 'In the cleanup cart — nothing is deleted until you move it to the Trash';

/** Each place `text` names the feature as "Cleanup", "the cleanup cart" or "the cleanup target", with a little around it. */
function cleanupNamings(text: string): string[] {
  const hits: string[] = [];
  const said = text.split(LEFT_TO_THE_MAP).join(' ');
  // "Cleanup" as one capitalised word ("Cleanup cart", "Cleanup target"), "the cleanup cart" and
  // "the cleanup target" (Settings' "Clean Up target"); the plain noun in lower case ("a cleanup
  // rule pack") is not the feature's name.
  for (const m of said.matchAll(/\bCleanup\b|\bcleanup cart\b|\bcleanup target\b/g)) {
    const at = m.index ?? 0;
    hits.push(JSON.stringify(said.slice(Math.max(0, at - 40), at + m[0].length + 30)));
  }
  return hits;
}

/**
 * Proper names a button or a modal title keeps capitalised: TreeMap's feature
 * and view names (the sidebar's own labels are read from the page as well),
 * and the system's things it names — the Trash, Finder, Terminal, Quick Look,
 * macOS's Privacy & Security settings, TreeMap's Settings sheet.
 */
const PROPER_NAMES = [
  'Undo Vault', 'Clean Up', 'Finder', 'Full Disk Access', 'Autopilot', 'Smart Suggestions', 'Disk City', 'Treemap', 'Sunburst', 'Voronoi',
  'TreeMap', 'Trash', 'Recycle Bin', 'Settings', 'Terminal', 'Quick Look', 'Privacy',
];

/** The sidebar's labels, as the page shows them. */
function sidebarNames(page: string): string[] {
  return [...page.matchAll(/<span class="side-label">([^<]+)<\/span>/g)].map((m) => m[1].trim());
}

/** `inner` with every `${…}` taken out, however its braces nest. */
function withoutInterpolations(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '$' && inner[i + 1] === '{') {
      let depth = 0;
      for (i += 1; i < inner.length; i++) {
        if (inner[i] === '{') depth++;
        else if (inner[i] === '}' && --depth === 0) break;
      }
      out += ' ';
    } else out += inner[i];
  }
  return out;
}

/** A label as a person reads it: no interpolation, no tag, entities read, spaces collapsed. */
function plainLabel(inner: string): string {
  return withoutInterpolations(inner).replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** No more texts are judged for one expression than this: a label's branches multiply. */
const MOST_VARIANTS = 64;

/**
 * The texts `expr` can give, one for each way its branches can go: a string
 * literal or a template's own pieces as written, each arm of a `? :`, either
 * side of `||` or `??`, and `+` joining what both sides can give. What code
 * computes (a call such as `icon('cart', 15)`, a name, a property) is a blank,
 * so an icon's name is never read as words.
 */
function variantsOf(expr: ts.Expression): string[] {
  const join = (a: string[], b: string[]): string[] => a.flatMap((x) => b.map((y) => x + y)).slice(0, MOST_VARIANTS);
  const either = (a: string[], b: string[]): string[] => [...a, ...b].slice(0, MOST_VARIANTS);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return variantsOf(expr.expression);
  if (ts.isConditionalExpression(expr)) return either(variantsOf(expr.whenTrue), variantsOf(expr.whenFalse));
  if (ts.isTemplateExpression(expr)) {
    let out = [expr.head.text];
    for (const span of expr.templateSpans) out = join(join(out, variantsOf(span.expression)), [span.literal.text]);
    return out;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return join(variantsOf(expr.left), variantsOf(expr.right));
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return either(variantsOf(expr.left), variantsOf(expr.right));
  }
  return [' '];
}

/**
 * The labels a button's or heading's content can show. In a script the
 * content sits inside a template, so each `${…}` is read for the text it can
 * give — `${inCart ? 'Remove from cart' : 'Add to cart'}` gives both — and a
 * content that does not read back as one template's text is read with its
 * interpolations taken out.
 */
function labelVariants(inner: string): string[] {
  if (!inner.includes('${')) return [plainLabel(inner)];
  const sf = ts.createSourceFile('label.js', `\`${inner}\``, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const [stmt] = sf.statements;
  const parsed = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (sf.statements.length !== 1 || !ts.isExpressionStatement(stmt) || !ts.isTemplateExpression(stmt.expression)
    || !parsed || parsed.length > 0) return [plainLabel(inner)];
  return [...new Set(variantsOf(stmt.expression).map(plainLabel))];
}

/** A label pieced together by `+` from code ('<button>' + label + '</button>'): no one label to read. */
function joinedByCode(label: string): boolean {
  return /['"`]\s*\+|\+\s*['"`]/.test(label);
}

/** Every button's and every modal heading's label in `code`, markup or script, but a label built by `+` from code. */
function labelsIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/<(button|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    for (const label of labelVariants(m[2])) if (label && !joinedByCode(label)) out.push(label);
  }
  return out;
}

/** The ids of the page's buttons and modal headings, as its markup writes them. */
function labelIds(page: string): Set<string> {
  return new Set([...markupOf(page).matchAll(/<(?:button|h3)\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
}

/**
 * The labels the page's scripts write into a button or a modal heading by
 * its id — `$('confirmTitle').innerHTML = icon('trash', 18) + 'Move to
 * Trash?'`, `$('confirmOk').innerHTML = …` — and the `title` and `ok` handed
 * to askText and watchJob, which write them into the ask sheet's heading and
 * OK button and the progress sheet's heading. A label passed on through a
 * variable from anywhere else is not followed.
 */
function assignedLabels(page: string): string[] {
  const ids = labelIds(page);
  const out: string[] = [];
  for (const code of scriptsOf(page)) {
    const sf = ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(n.left) && /^(?:innerHTML|textContent)$/.test(n.left.name.text)) {
        const target = n.left.expression;
        if (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === '$'
          && target.arguments.length === 1 && ts.isStringLiteral(target.arguments[0]) && ids.has(target.arguments[0].text)) {
          out.push(...variantsOf(n.right));
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(?:askText|watchJob)$/.test(n.expression.text)
        && n.arguments.length > 0 && ts.isObjectLiteralExpression(n.arguments[0])) {
        for (const prop of n.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && /^(?:title|ok)$/.test(prop.name.text)) out.push(...variantsOf(prop.initializer));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...new Set(out.map(plainLabel))].filter((label) => label && !joinedByCode(label));
}

/** Where `label` capitalises a word that is no proper name: Title Case, or a stray capital. */
function titleCased(label: string, proper: readonly string[]): string | null {
  let rest = label;
  for (const name of [...proper].sort((a, b) => b.length - a.length)) rest = rest.split(name).join('·');
  const words = rest.split(/\s+/).filter(Boolean);
  for (const [i, word] of words.entries()) {
    const parts = word.split('-');
    for (const [j, part] of parts.entries()) {
      if (i === 0 && j === 0) continue; // the first word starts the label
      if (/^[A-Z][a-z]/.test(part)) return part;
    }
  }
  return null;
}

/** Each label in the page that is Title Case where it should be sentence case, with the word that gives it away. */
function titleCaseLabels(page: string): string[] {
  const proper = [...PROPER_NAMES, ...sidebarNames(page)];
  const labels = [...labelsIn(markupOf(page)), ...scriptsOf(page).flatMap(labelsIn), ...assignedLabels(page)];
  return labels.flatMap((label) => {
    const word = titleCased(label, proper);
    return word ? [`"${label}" (${word})`] : [];
  });
}

/* ══════════════ The readers ══════════════ */

test('the readers find what a person reads, and leave out comments, ids and routes', () => {
  const page = [
    '<!-- Cleanup cart (Feature 2) -->',
    '<button id="cleanupBtn" title="Open the Cleanup cart">Go</button>',
    '<span class="ttl">Cleanup cart</span>',
    "<script>/* Cleanup cart */ // the Cleanup cart\nconst a = '/api/cleanup/suggestions'; const b = `${x}Empty the cleanup cart`;</script>",
    '<script type="application/json">{"k":"v"}</script>',
  ].join('\n');
  assert.equal(cleanupNamings(pageText(page)).length, 3, 'the title, the text and the script\'s string — not the comments, the id or the route');
  assert.deepEqual(cleanupNamings('a cleanup rule pack could not be loaded'), [], 'the plain noun in lower case is not the name');
  assert.equal(cleanupNamings('An optional **cleanup target** in Settings').length, 1, 'Settings\' target is the feature\'s too');
  assert.deepEqual(cleanupNamings(LEFT_TO_THE_MAP), [], 'the map\'s own sentence is left to its batch');
  assert.equal(cleanupNamings(`${LEFT_TO_THE_MAP} Cleanup target`).length, 1, 'and nothing else beside it is');
});

test('the label reader judges buttons and modal headings, markup or script, by their words', () => {
  const proper = [...PROPER_NAMES, 'Missing GB'];
  for (const label of ['Custom Rules', 'Near-Duplicate Images', 'Empty Folders', 'Open the Cart', 'Keyboard Shortcuts']) {
    assert.ok(titleCased(label, proper), `"${label}" is Title Case`);
  }
  for (const label of ['Move to Trash', 'Move all to Trash', 'Empty Trash…', 'Change in Settings', 'Open in Terminal', 'Quick Look',
    'Undo Vault', 'Clean Up', 'Missing GB', 'Make this an Autopilot policy', 'PDF report', 'Animated GIF — history', 'Re-encode',
    'Custom rules', 'Near-duplicate images', 'Folders TreeMap could not read', 'What the Undo Vault couldn’t keep']) {
    assert.equal(titleCased(label, proper), null, `"${label}" is sentence case, or a proper name`);
  }
  const code = '<button class="btn">${icon(\'x\', 14)}Remove Budget</button> `<h3>${icon(\'k\')}Keyboard Shortcuts</h3>` \'<button>\' + label + \'</button>\'';
  assert.deepEqual(labelsIn(code), ['Remove Budget', 'Keyboard Shortcuts'], 'an interpolation is not part of the label, and a label joined by code is skipped');
});

test('the label reader reads the words an interpolation gives, and the labels the scripts write by id (G18 review F1.3, F1.4)', () => {
  // The right-click menu's cart entry is all interpolation; read with its
  // interpolations taken out it had no label, so "Add to Cart" passed unseen.
  const menu = '`<button data-act="cart">${icon(inCart ? \'check\' : \'cart\', 15)}${inCart ? \'Remove from Cart\' : \'Add to Cart\'}</button>`';
  assert.deepEqual(labelsIn(menu), ['Remove from Cart', 'Add to Cart'], 'each arm is a label; an icon\'s name is not words');
  assert.deepEqual(labelsIn('`<button>${n ? `Move ${n} to Trash` : \'Move to Trash\'} ${x || \'Now\'}</button>`'),
    ['Move to Trash', 'Move to Trash Now'], 'a template arm keeps its words, and either side of || is read');
  const page = [
    '<h3 id="confirmTitle">Move to Trash?</h3><button id="confirmOk">OK</button><div id="note">x</div>',
    "<script>$('confirmTitle').innerHTML = icon('trash', 18) + 'Forget This Copy?';",
    "$('confirmOk').innerHTML = icon(r ? 'refresh' : 'stop', 15) + (r ? 'Restart It' : 'Quit it');",
    "$('note').textContent = 'Not A Label'; $('confirmOk').textContent = label;",
    "askText({ title: 'Save View', label: 'Name This View', ok: 'Save view' }); watchJob({ title: n === 1 ? 'Putting It Back…' : 'Putting everything back…', cancelUrl: u });</script>",
  ].join('\n');
  assert.deepEqual(assignedLabels(page), ['Forget This Copy?', 'Restart It', 'Quit it', 'Save View', 'Save view', 'Putting It Back…', 'Putting everything back…'],
    'a heading\'s and a button\'s, by id, and askText\'s and watchJob\'s; not another element\'s, not a field label, not a name');
});

/* ══════════════ The page ══════════════ */

test('the page names the feature "Clean Up" — never "Cleanup", never "the cleanup cart" — wherever a person reads it (G18)', () => {
  assert.deepEqual(cleanupNamings(pageText(INDEX)), [], 'public/index.html (rebuild with node scripts/build-ui.js)');
});

test('every button and modal title of the page is in sentence case, but for proper names (G18)', () => {
  const sidebar = sidebarNames(INDEX);
  assert.ok(sidebar.includes('Clean Up') && sidebar.includes('Undo Vault') && sidebar.includes('Missing GB'), `control: the sidebar's names are read (${sidebar.join(', ')})`);
  const labels = [...labelsIn(markupOf(INDEX)), ...scriptsOf(INDEX).flatMap(labelsIn)];
  assert.ok(labels.length > 150, `control: the page's labels are read, markup and script (${labels.length})`);
  assert.ok(labels.includes('Remove budget') && labels.includes('Keyboard shortcuts'), 'control: a script\'s button and a modal heading are among them');
  assert.ok(labels.includes('Edit budget…') && labels.includes('Set budget…'), 'control: both arms of an interpolated label are among them');
  const assigned = assignedLabels(INDEX);
  for (const label of ['Move to Trash?', 'Forget this copy?', 'Copy, verify, then trash', 'Save view', 'Restoring…', 'New policy']) {
    assert.ok(assigned.includes(label), `control: a label written by id, or through askText or watchJob, is read: ${label} (${assigned.length} read)`);
  }
  assert.deepEqual(titleCaseLabels(INDEX), []);
});

test('the Clean Up cart, its Settings target and the Clean Up tabs say it in the decided words (G18)', () => {
  assert.ok(/<span class="ttl">Clean Up cart<\/span>/.test(INDEX), 'the cart\'s own title');
  assert.ok(/<div class="set-h"[^>]*><span data-icon="cart"><\/span>Clean Up target<\/div>/.test(INDEX), 'the Settings heading');
  assert.ok(/\{ name: 'Clean Up target', hint: '[^']+'/.test(INDEX), 'the palette\'s Settings row, the heading\'s own words');
  assert.ok(/\{ label: 'Empty the Clean Up cart', /.test(INDEX), 'the palette\'s action');
  assert.ok(INDEX.includes("<button data-act=\"cart\">${icon(inCart ? 'check' : 'cart', 15)}${inCart ? 'Remove from Clean Up cart' : 'Add to Clean Up cart'}</button>"),
    'the right-click menu\'s cart entry, as every cart toggle says it (review F1.3)');
  for (const tab of ['Custom rules', 'Smart Suggestions', 'Empty folders', 'Shrink video', 'Cloud-safe']) {
    assert.ok(new RegExp(`data-pane="\\w+"(?: id="\\w+" hidden)?><span data-icon="[\\w-]+"></span>${tab}</button>`).test(INDEX), `the Clean Up tab "${tab}"`);
  }
  assert.ok(/data-dupmode="near"><span data-icon="image"><\/span>Near-duplicate images<\/button>/.test(INDEX), 'the Duplicates mode');
});

/* ══════════════ What the server writes for the page ══════════════ */

test('every sentence the server writes names the feature "Clean Up" — never "Cleanup", never "the cleanup cart" — and so does the API description it serves (G18 review F1.1, F1.2)', () => {
  // The page prints some of the server's sentences as they come: the Undo
  // Vault tab's "Deleted because it …" is the reason the cart stamped on the
  // copy (cartCommit.ts), which read "staged in the cleanup cart". And
  // GET /api/openapi.json serves openapi.ts's summaries, which said "the
  // cleanup cart" too. Every TypeScript file of the server is read: the page's
  // own scripts are JavaScript, read above from the built page.
  const strings = sourceStrings(['src']);
  assert.ok(strings.length > 15000, `control: the server's strings are read (${strings.length})`);
  for (const file of ['src/services/cartCommit.ts', 'src/api/openapi.ts', 'src/mcp/server.ts']) {
    assert.ok(strings.some((s) => s.at.startsWith(`${file}:`)), `control: ${file} is among them`);
  }
  // CI runs this file on Windows too, where path.relative spells
  // "src\services\cartCommit.ts" (review F2.1): handed Windows' own path
  // module, the reader names every file as it does here, with forward slashes.
  let asked = 0;
  const win32: path.PlatformPath = { ...path.win32, relative: (from: string, to: string) => { asked++; return path.win32.relative(from, to); } };
  const onWindows = sourceStrings(['src'], win32);
  assert.ok(asked > 0, 'control: the reader names each file through the path module it is handed');
  assert.equal(onWindows.length, strings.length, 'control: the same strings are read');
  assert.equal(onWindows.find((s, i) => s.at !== strings[i].at)?.at, undefined, 'each file is named alike on every system, with forward slashes');
  assert.deepEqual(strings.flatMap((s) => cleanupNamings(s.text).map((hit) => `${s.at}: ${hit}`)), []);
});

/** The documents a person reads beside the app. */
const DOCS = ['README.md', 'SECURITY.md', 'AGENTS.md'];

test('README, SECURITY and AGENTS name the feature "Clean Up" as the page does: "the Clean Up cart", "the Clean Up target" (G18 review F1.2)', () => {
  for (const doc of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    assert.ok(text.includes('Clean Up'), `control: ${doc} is read, and names the feature`);
    assert.deepEqual(cleanupNamings(text), [], doc);
  }
});

/**
 * The Clean Up tabs and the Duplicates mode as they were spelled before G18;
 * the tabs now say "Custom rules", "Empty folders", "Shrink video" and
 * "Near-duplicate images".
 */
const OLD_TAB_NAMES = ['Custom Rules', 'Empty Folders', 'Shrink Video', 'Near-Duplicate Images'];

/** Each place `text` names a Clean Up tab in its old Title Case, with a little around it. */
function oldTabNamings(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(new RegExp(OLD_TAB_NAMES.join('|'), 'g'))) {
    const at = m.index ?? 0;
    hits.push(JSON.stringify(text.slice(Math.max(0, at - 40), at + m[0].length + 30)));
  }
  return hits;
}

test('the page, every sentence the server writes and the docs name a Clean Up tab as the tab says it: "Empty folders", "Shrink video" (G18 review F1.5)', () => {
  // The query box prints the server's degraded reason as it comes, and on a
  // gdu scan it sent the person to "Clean Up › Empty Folders"; a refusal by
  // storage mode named "the Empty Folders view".
  assert.equal(oldTabNamings('Clean Up › Empty Folders looks at each folder').length, 1, 'control: the old spelling is found');
  assert.deepEqual(oldTabNamings('Clean Up › Empty folders looks at each folder; emptyFolders, onlyEmptyFolders'), [], 'control: the new one, and a program\'s names, are not');
  assert.deepEqual(oldTabNamings(pageText(INDEX)), [], 'public/index.html');
  assert.deepEqual(sourceStrings(['src']).flatMap((s) => oldTabNamings(s.text).map((hit) => `${s.at}: ${hit}`)), [], 'the server\'s strings');
  for (const doc of DOCS) assert.deepEqual(oldTabNamings(fs.readFileSync(path.join(ROOT, doc), 'utf8')), [], doc);
});

test('the Undo Vault tab prints a copy\'s reason in the cart\'s words, and an older copy\'s "staged in the cleanup cart" as the cart says it now (G18 review F1.1)', () => {
  // A copy keeps the reason it was stored with (timecapsule.json), so a copy
  // the cart made before the name was settled still holds the old words.
  const capsuleReason = lift<(reason: string) => string>(['capsuleReason'], 'capsuleReason');
  assert.equal(capsuleReason('staged in the cleanup cart'), 'was staged in the Clean Up cart', 'a copy an earlier build stored');
  assert.equal(capsuleReason('was staged in the Clean Up cart'), 'was staged in the Clean Up cart', 'a copy the cart makes now');
  for (const reason of ['matched your query: size>1gb', 'matched “Xcode DerivedData” — build output Xcode rebuilds', 'staged in the cleanup cart, and more']) {
    assert.equal(capsuleReason(reason), reason, `any other reason is printed as it was stored: ${reason}`);
  }
  assert.ok(INDEX.includes('<div class="why">Deleted because it ${escapeHtml(capsuleReason(e.reason))}</div>'), 'the tab reads every reason through it');
});

test('what a program reads keeps its name: ids, the setting key, the routes', () => {
  for (const id of ['id="cleanupBtn"', 'id="cleanupGoalValue"', 'id="cleanupGoalUnit"', 'id="cleanupGoalClear"', 'id="cartDock"', 'data-pane="rules"', 'data-pane="empty"', 'data-pane="video"', 'data-dupmode="near"']) {
    assert.ok(INDEX.includes(id), `${id} is still in the page`);
  }
  assert.ok(INDEX.includes('cleanupGoalBytes: collectCleanupGoal()'), 'the Settings sheet still saves cleanupGoalBytes');
  assert.ok(INDEX.includes("'/api/cleanup/suggestions?scanId='"), 'and the page still asks /api/cleanup/suggestions');
});
