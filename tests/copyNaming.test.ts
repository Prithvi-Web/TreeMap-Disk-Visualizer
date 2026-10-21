import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { INDEX } from './fixtures/liftFrontend';

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

/** Each place `text` names the feature as "Cleanup" or "the cleanup cart", with a little around it. */
function cleanupNamings(text: string): string[] {
  const hits: string[] = [];
  const said = text.split(LEFT_TO_THE_MAP).join(' ');
  // "Cleanup" as one capitalised word ("Cleanup cart", "Cleanup target"), and "the cleanup cart";
  // the plain noun in lower case ("a cleanup rule pack") is not the feature's name.
  for (const m of said.matchAll(/\bCleanup\b|\bcleanup cart\b/g)) {
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

/** Every button's and every modal heading's label in `code`, markup or script, but a label built by `+` from code. */
function labelsIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/<(button|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const label = plainLabel(m[2]);
    if (!label || /['"`]\s*\+|\+\s*['"`]/.test(label)) continue; // pieces joined by code: no one label to read
    out.push(label);
  }
  return out;
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
  const labels = [...labelsIn(markupOf(page)), ...scriptsOf(page).flatMap(labelsIn)];
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
  assert.deepEqual(titleCaseLabels(INDEX), []);
});

test('the Clean Up cart, its Settings target and the Clean Up tabs say it in the decided words (G18)', () => {
  assert.ok(/<span class="ttl">Clean Up cart<\/span>/.test(INDEX), 'the cart\'s own title');
  assert.ok(/<div class="set-h"[^>]*><span data-icon="cart"><\/span>Clean Up target<\/div>/.test(INDEX), 'the Settings heading');
  assert.ok(/\{ name: 'Clean Up target', hint: '[^']+'/.test(INDEX), 'the palette\'s Settings row, the heading\'s own words');
  assert.ok(/\{ label: 'Empty the Clean Up cart', /.test(INDEX), 'the palette\'s action');
  for (const tab of ['Custom rules', 'Smart Suggestions', 'Empty folders', 'Shrink video', 'Cloud-safe']) {
    assert.ok(new RegExp(`data-pane="\\w+"(?: id="\\w+" hidden)?><span data-icon="[\\w-]+"></span>${tab}</button>`).test(INDEX), `the Clean Up tab "${tab}"`);
  }
  assert.ok(/data-dupmode="near"><span data-icon="image"><\/span>Near-duplicate images<\/button>/.test(INDEX), 'the Duplicates mode');
});

test('what a program reads keeps its name: ids, the setting key, the routes', () => {
  for (const id of ['id="cleanupBtn"', 'id="cleanupGoalValue"', 'id="cleanupGoalUnit"', 'id="cleanupGoalClear"', 'id="cartDock"', 'data-pane="rules"', 'data-pane="empty"', 'data-pane="video"', 'data-dupmode="near"']) {
    assert.ok(INDEX.includes(id), `${id} is still in the page`);
  }
  assert.ok(INDEX.includes('cleanupGoalBytes: collectCleanupGoal()'), 'the Settings sheet still saves cleanupGoalBytes');
  assert.ok(INDEX.includes("'/api/cleanup/suggestions?scanId='"), 'and the page still asks /api/cleanup/suggestions');
});
