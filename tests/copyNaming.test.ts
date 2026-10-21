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

/**
 * A piece of a string a script writes or builds: text as written — `node` is
 * the literal or template piece it is, `of` the string it is part of, one for
 * all a template's pieces — or a part code computes.
 */
type Piece = { text: string; node: ts.Node; of: ts.Node } | { hole: ts.Expression };

/** Whether `n` writes or builds a string: a string literal, a template, or a + (whose pieces piecesOf reads). */
function buildsString(n: ts.Node): n is ts.Expression {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)
    || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
}

/** The pieces `expr` builds its string from, in order, + read through: `'a ' + b + \`c${d}\`` is "a ", b, "c", d, "". */
function piecesOf(expr: ts.Expression): Piece[] {
  if (ts.isParenthesizedExpression(expr) && buildsString(expr.expression)) return piecesOf(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ text: expr.text, node: expr, of: expr }];
  if (ts.isTemplateExpression(expr)) {
    return [{ text: expr.head.text, node: expr.head, of: expr },
      ...expr.templateSpans.flatMap((span): Piece[] => [{ hole: span.expression }, { text: span.literal.text, node: span.literal, of: expr }])];
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...piecesOf(expr.left), ...piecesOf(expr.right)];
  return [{ hole: expr }];
}

/**
 * Visits every node under `n` — `onNode` is handed each — but a string a
 * script writes or builds is read once, whole: `onBuild` is handed its
 * pieces, and each part code computes in it is visited in turn.
 */
function visitBuilding(n: ts.Node, onNode: (n: ts.Node) => void, onBuild: (pieces: Piece[]) => void): void {
  if (buildsString(n)) {
    const pieces = piecesOf(n);
    onBuild(pieces);
    for (const piece of pieces) if ('hole' in piece) visitBuilding(piece.hole, onNode, onBuild);
    return;
  }
  onNode(n);
  ts.forEachChild(n, (child) => visitBuilding(child, onNode, onBuild));
}

/**
 * The text of every string in `sf`, a long one wrapped by + read as the one
 * sentence it is (`'Your cleanup ' + 'cart is empty'`), each with the literal
 * its first piece is: one run of text for each stretch between the parts code
 * computes, which stand between the pieces either side of them as a
 * template's `${…}` does.
 */
function stringRuns(sf: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = [];
  visitBuilding(sf, () => undefined, (pieces) => {
    let run: { text: string; node: ts.Node } | null = null;
    for (const piece of pieces) {
      if ('hole' in piece) run = null;
      else if (run) run.text += piece.text;
      else out.push(run = { text: piece.text, node: piece.node });
    }
  });
  return out;
}

/** The text of every string in `code` (stringRuns). */
function literalsOf(code: string): string[] {
  return stringRuns(ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)).map((run) => run.text);
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
 * Each string of the TypeScript under `dirs` — a long one a + wraps read as
 * one (stringRuns) — with the file and line it is on. Comments are not
 * strings, so they are left out, as the page's are. The file is named from the repository with forward
 * slashes on every system — Windows' path.relative gives backslashes — so a
 * name reads, and compares, alike everywhere. `p` is the path module that
 * names it, the host's unless a test hands it another system's.
 */
function sourceStrings(dirs: string[], p: path.PlatformPath = path): { at: string; text: string }[] {
  return dirs.flatMap(tsFilesUnder).flatMap((file) => fileStrings(file, fs.readFileSync(file, 'utf8'), p));
}

/** Each string of the TypeScript `text`, the file `file` holds, with the file and the line its first piece is on (sourceStrings, stringRuns). */
function fileStrings(file: string, text: string, p: path.PlatformPath = path): { at: string; text: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const name = p.relative(ROOT, file).split(p.sep).join('/');
  return stringRuns(sf).map((run) => ({ at: `${name}:${sf.getLineAndCharacterOfPosition(run.node.getStart(sf)).line + 1}`, text: run.text }));
}

/** What a person reads in `markup`: its text, and the words of its titles, aria-labels, placeholders and alt text. */
function readableMarkup(markup: string): string {
  const attrs = [...markup.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  return [markup.replace(/<[^>]*>/g, ' '), ...attrs].join(APART);
}

/**
 * What stands between two pieces of a page that are not one sentence — the
 * markup's text and an attribute, two strings of a script: no white space, so
 * no name is read across it.
 */
const APART = '\n\u0000\n';

/** Everything a person can read on the page, as text: the markup's, and every string its scripts hold. */
function pageText(page: string): string {
  const scripts = scriptsOf(page);
  return [readableMarkup(markupOf(page)), ...scripts.flatMap(literalsOf)].join(APART);
}

/** `text` with each run of white space read as one space: a document wrapped at 80 columns, or markup across lines, says the same words. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The one sentence left to the map's own batch (BQJ-2c is reworking the map
 * and its key, and the key's tooltip is its words): tmMarksKey's "In the
 * cleanup cart". Allowed while it stands, and not required: once that batch
 * says "the Clean Up cart" there, nothing here needs changing.
 */
const LEFT_TO_THE_MAP = 'In the cleanup cart — nothing is deleted until you move it to the Trash';

/**
 * Each place `text` names the feature as "Cleanup", "the cleanup cart" or
 * "the cleanup target", with a little around it — wherever a line break
 * falls in the name.
 */
function cleanupNamings(text: string): string[] {
  const hits: string[] = [];
  const said = oneLine(text).split(LEFT_TO_THE_MAP).join(' ');
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

/** Each text of `a` followed by each of `b`, no more than MOST_VARIANTS of them. */
function joinVariants(a: string[], b: string[]): string[] {
  return a.flatMap((x) => b.map((y) => x + y)).slice(0, MOST_VARIANTS);
}

/** What `escapeHtml(…)` is handed, or null: the page's escaping keeps a label's words, so a label is read through it. */
function escaped(expr: ts.Expression): ts.Expression | null {
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'escapeHtml' && expr.arguments.length === 1
    ? expr.arguments[0] : null;
}

/**
 * The texts `expr` can give, one for each way its branches can go: a string
 * literal or a template's own pieces as written, each arm of a `? :`, either
 * side of `||` or `??`, `+` joining what both sides can give, and what
 * escapeHtml is handed. What code computes (a call such as
 * `icon('cart', 15)`, a name, a property) is a blank, so an icon's name is
 * never read as words.
 */
function variantsOf(expr: ts.Expression): string[] {
  const either = (a: string[], b: string[]): string[] => [...a, ...b].slice(0, MOST_VARIANTS);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  const handed = escaped(expr);
  if (handed) return variantsOf(handed);
  if (ts.isParenthesizedExpression(expr)) return variantsOf(expr.expression);
  if (ts.isConditionalExpression(expr)) return either(variantsOf(expr.whenTrue), variantsOf(expr.whenFalse));
  if (ts.isTemplateExpression(expr)) {
    let out = [expr.head.text];
    for (const span of expr.templateSpans) out = joinVariants(joinVariants(out, variantsOf(span.expression)), [span.literal.text]);
    return out;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return joinVariants(variantsOf(expr.left), variantsOf(expr.right));
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

/**
 * Each button's and modal heading's content in a string a script builds —
 * its text, and each part code computes in it — and whether a + joins the
 * content from more than one string: `'<button>' + escapeHtml(label) +
 * '</button>'`, or a button opened in one template and labelled in the next.
 */
function contentsOf(pieces: Piece[]): { parts: (string | ts.Expression)[]; joined: boolean }[] {
  // The string as written, each part code computes marked by its place, and a
  // mark where one string a + joins ends and the next begins.
  const JOIN = '\u0003';
  let last: ts.Node | null = null;
  const built = pieces.map((piece, i) => {
    if ('hole' in piece) return `\u0001${i}\u0002`;
    const mark = last && last !== piece.of ? JOIN : '';
    last = piece.of;
    return mark + piece.text;
  }).join('');
  return [...built.matchAll(/<(button|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({
    parts: m[2].split(/\u0001(\d+)\u0002/).map((part, j) => (j % 2 ? (pieces[Number(part)] as { hole: ts.Expression }).hole : part.split(JOIN).join(''))),
    joined: m[2].includes(JOIN),
  }));
}

/**
 * Every label in `code` a + joins from more than one string, read from the
 * strings and from what each part code computes can give (variantsOf). A
 * label inside one string is labelsIn's to read, from the code itself.
 */
function builtLabels(code: string): string[] {
  const out: string[] = [];
  visitBuilding(ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), () => undefined, (pieces) => {
    for (const { parts, joined } of contentsOf(pieces)) {
      if (!joined) continue;
      const texts = parts.reduce<string[]>((acc, part) => joinVariants(acc, typeof part === 'string' ? [part] : variantsOf(part)), ['']);
      out.push(...new Set(texts.map(plainLabel).filter(Boolean)));
    }
  });
  return out;
}

/** The ids of the page's buttons and modal headings, as its markup writes them. */
function labelIds(page: string): Set<string> {
  return new Set([...markupOf(page).matchAll(/<(?:button|h3)\b[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
}

/**
 * The parts of `expr` whose words a label shows — the places variantsOf
 * reads: each arm of a `? :`, both sides of `+`, `||` and `??`, a template's
 * interpolations, what escapeHtml is handed. Any other call's arguments
 * (`icon(iconName, 15)`) are not words.
 */
function wordParts(expr: ts.Expression): ts.Expression[] {
  const handed = escaped(expr);
  if (handed) return wordParts(handed);
  if (ts.isParenthesizedExpression(expr)) return wordParts(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...wordParts(expr.whenTrue), ...wordParts(expr.whenFalse)];
  if (ts.isTemplateExpression(expr)) return expr.templateSpans.flatMap((span) => wordParts(span.expression));
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...wordParts(expr.left), ...wordParts(expr.right)];
    }
  }
  return [expr];
}

/** The label `n` writes into a button or a modal heading by its id — `$('confirmOk').innerHTML = …` — or null. */
function labelWrite(n: ts.Node, ids: Set<string>): ts.Expression | null {
  if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    || !ts.isPropertyAccessExpression(n.left) || !/^(?:innerHTML|textContent)$/.test(n.left.name.text)) return null;
  const target = n.left.expression;
  return ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === '$'
    && target.arguments.length === 1 && ts.isStringLiteral(target.arguments[0]) && ids.has(target.arguments[0].text) ? n.right : null;
}

/** A function the page's scripts name: a declaration, or a function or arrow a `const` holds. */
type PageFunction = { name: string; params: ts.NodeArray<ts.ParameterDeclaration>; body: ts.Node | undefined };

/** Every named function in the page's scripts, the source file each was read from beside it. */
function pageFunctions(page: string): { files: ts.SourceFile[]; fns: PageFunction[] } {
  const files = scriptsOf(page).map((code) => ts.createSourceFile('page.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  const fns: PageFunction[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) fns.push({ name: n.name.text, params: n.parameters, body: n.body });
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fns.push({ name: n.name.text, params: n.initializer.parameters, body: n.initializer.body });
    }
    ts.forEachChild(n, visit);
  };
  for (const sf of files) visit(sf);
  return { files, fns };
}

/**
 * Each name a function's parameters bind, with the argument it holds and its
 * default: `'1'` for the second argument, `'0.ok'` for `{ ok }` or
 * `{ ok: okLabel }` taken from the first.
 */
function paramKeys(params: ts.NodeArray<ts.ParameterDeclaration>): Map<string, { key: string; init?: ts.Expression }> {
  const out = new Map<string, { key: string; init?: ts.Expression }>();
  params.forEach((param, i) => {
    if (ts.isIdentifier(param.name)) out.set(param.name.text, { key: `${i}`, init: param.initializer });
    else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        out.set(el.name.text, { key: `${i}.${prop}`, init: el.initializer });
      }
    }
  });
  return out;
}

/** The argument a word part holds, by its key: a parameter (`label`, `title`), or a property of one (`opts.title`). */
function argKey(part: ts.Expression, params: Map<string, { key: string }>): string | null {
  if (ts.isIdentifier(part)) return params.get(part.text)?.key ?? null;
  if (ts.isPropertyAccessExpression(part) && ts.isIdentifier(part.expression)) {
    const whole = params.get(part.expression.text);
    return whole ? `${whole.key}.${part.name.text}` : null;
  }
  return null;
}

/** What `call` hands where its callee writes a label, by `sinks`: an argument, or a property of an object argument. */
function handedLabels(call: ts.CallExpression, sinks: Map<string, Set<string>>): ts.Expression[] {
  if (!ts.isIdentifier(call.expression)) return [];
  const out: ts.Expression[] = [];
  for (const key of sinks.get(call.expression.text) ?? []) {
    const [at, prop] = key.split('.');
    const arg = call.arguments[Number(at)];
    if (!arg) continue;
    if (prop === undefined) out.push(arg);
    else if (ts.isObjectLiteralExpression(arg)) {
      for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === prop) out.push(p.initializer);
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) out.push(p.name);
      }
    }
  }
  return out;
}

/**
 * Which arguments of which page functions end up as a button's or a modal
 * heading's label: one the function writes there by id
 * (`setConfirmButton(label)` writes `$('confirmOk')`), one it builds into a
 * button or a heading of its own, by + or in a template
 * (`toastAction(msg, label)` builds `'<button class="pill">' +
 * escapeHtml(label) + '</button>'`; an argument in a tag's attribute is not
 * its label), or one it hands on to a function that does
 * (`watchOffloadJob(jobId, title)` hands `title` to watchJob, which writes
 * the progress sheet's heading). Read until nothing more is found, so a
 * function that hands a label on is found wherever it is declared.
 */
function labelSinks(page: string): Map<string, Set<string>> {
  const ids = labelIds(page);
  const { fns } = pageFunctions(page);
  const sinks = new Map<string, Set<string>>();
  let found = true;
  while (found) {
    found = false;
    for (const fn of fns) {
      const params = paramKeys(fn.params);
      const reach = (expr: ts.Expression): void => {
        for (const part of wordParts(expr)) {
          const key = argKey(part, params);
          if (!key || sinks.get(fn.name)?.has(key)) continue;
          sinks.set(fn.name, new Set([...(sinks.get(fn.name) ?? []), key]));
          found = true;
        }
      };
      if (!fn.body) continue;
      visitBuilding(fn.body, (n) => {
        const written = labelWrite(n, ids);
        if (written) reach(written);
        if (ts.isCallExpression(n)) handedLabels(n, sinks).forEach(reach);
      }, (pieces) => {
        for (const { parts } of contentsOf(pieces)) for (const part of parts) if (typeof part !== 'string') reach(part);
      });
    }
  }
  return sinks;
}

/**
 * The labels the page's scripts write into a button or a modal heading by
 * its id — `$('confirmTitle').innerHTML = icon('trash', 18) + 'Move to
 * Trash?'`, `$('confirmOk').innerHTML = …` — and every label handed to a
 * function that writes or builds one (labelSinks): `setConfirmButton('Empty
 * the Trash')`, openBrowse's title and button label, askText's `title` and
 * `ok`, toastAction's button, and a default such a function gives one
 * (`ok = 'OK'`, offerMeant's `label = 'Use that folder'`). A label held in a
 * variable of its own is not followed.
 */
function assignedLabels(page: string): string[] {
  const ids = labelIds(page);
  const sinks = labelSinks(page);
  const { files, fns } = pageFunctions(page);
  const out: string[] = [];
  for (const fn of fns) {
    for (const { key, init } of paramKeys(fn.params).values()) if (init && sinks.get(fn.name)?.has(key)) out.push(...variantsOf(init));
  }
  const visit = (n: ts.Node): void => {
    const written = labelWrite(n, ids);
    if (written) out.push(...variantsOf(written));
    if (ts.isCallExpression(n)) for (const arg of handedLabels(n, sinks)) out.push(...variantsOf(arg));
    ts.forEachChild(n, visit);
  };
  for (const sf of files) visit(sf);
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
  const labels = [...labelsIn(markupOf(page)), ...scriptsOf(page).flatMap(labelsIn), ...scriptsOf(page).flatMap(builtLabels), ...assignedLabels(page)];
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

test('the readers read a name wrapped across lines as the name, and two strings of a script as two, but for the strings a + joins into one (G18 review F2.3, F3.4)', () => {
  // AGENTS.md is wrapped at about 80 columns, its next line indented, and
  // the markup runs across lines: a name split there is still the name.
  assert.equal(cleanupNamings('A deletion staged in the cleanup\n  cart is trashed.').length, 1, 'a document\'s wrapped "cleanup cart"');
  assert.equal(cleanupNamings('Settings\' cleanup\r\n\ttarget').length, 1, 'any white space between the words');
  assert.equal(oldTabNamings('Clean Up\'s Empty\n  Folders tab never offers it.').length, 1, 'a document\'s wrapped "Empty Folders"');
  assert.equal(cleanupNamings(pageText('<p class="hint">Staged in the cleanup\n      cart until you move it</p>')).length, 1, 'markup across lines');
  assert.equal(oldTabNamings(pageText('<p>Open Shrink\n  Video</p>')).length, 1, 'markup across lines, an old tab name');
  assert.deepEqual(cleanupNamings(pageText("<p>the cleanup</p><script>const a = 'it went to the cleanup'; const b = 'cart';</script>")), [],
    'two strings of a script, or the markup and a script, are not one sentence');
  assert.deepEqual(oldTabNamings(pageText("<b title=\"Folders\">Empty</b><script>const a = 'Shrink'; const b = 'Video';</script>")), [],
    'nor are an element\'s text and its title');
  // A long string of a script, or of the server, is wrapped by joining its
  // pieces with + (review F3.4): what the + joins is one sentence.
  assert.equal(cleanupNamings(pageText("<script>toast('Your cleanup ' + 'cart is empty', 'error');</script>")).length, 1, 'a script\'s sentence a + joins');
  assert.equal(cleanupNamings(pageText("<script>toast('Your cleanup ' +\n    'cart is empty', 'error');</script>")).length, 1, 'wrapped across lines');
  assert.equal(cleanupNamings(pageText('<script>toast(`Your cleanup ` + `cart is empty`);</script>')).length, 1, 'backtick strings');
  assert.equal(cleanupNamings(pageText('<script>toast(`${n} left in your cleanup ` + "cart");</script>')).length, 1, 'a template\'s last piece and the string after it');
  assert.equal(oldTabNamings(pageText("<script>const s = 'Open Empty ' + ('Folders' + ' now');</script>")).length, 1, 'parenthesised');
  assert.equal(cleanupNamings(pageText("<script>const s = f(1 + 2, 'the cleanup ' + 'cart');</script>")).length, 1, 'beside a sum of numbers');
  assert.equal(cleanupNamings(pageText("<script>const s = `${n ? 'Staged in the cleanup ' + 'cart' : ''} now`;</script>")).length, 1, 'a string inside a part code computes is read too');
  assert.deepEqual(cleanupNamings(pageText("<script>const s = 'the cleanup ' + kind + ' cart'; const t = `the cleanup ${kind} cart`;</script>")), [],
    'a part code computes stands between the pieces either side of it, as a template\'s ${} does');
  assert.deepEqual(fileStrings(path.join(ROOT, 'src', 'x.ts'), "const a = 'Your cleanup ' +\n  'cart is empty';\nconst b = `two ${c} pieces`;"),
    [{ at: 'src/x.ts:1', text: 'Your cleanup cart is empty' }, { at: 'src/x.ts:3', text: 'two ' }, { at: 'src/x.ts:3', text: ' pieces' }],
    'a server file\'s, named at the line its first piece is on');
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
    "$('note').textContent = 'Not A Label'; $('confirmOk').textContent = label;</script>",
  ].join('\n');
  assert.deepEqual(assignedLabels(page), ['Forget This Copy?', 'Restart It', 'Quit it'],
    'a heading\'s and a button\'s, by id; not another element\'s, not a name');
});

test('each way the label reader reads a label holds a case of its own (G18 review F2.4)', () => {
  assert.deepEqual(labelsIn('`<button>Move ${x ?? \'Now\'}</button>`'), ['Move', 'Move Now'], 'either side of ??');
  const page = [
    '<h3 id="confirmTitle">x</h3><button id="confirmOk">OK</button>',
    "<script>$('confirmOk').textContent = 'Save Now'; $('confirmTitle').innerHTML = `Plain Backtick Title`;</script>",
  ].join('\n');
  assert.deepEqual(assignedLabels(page), ['Save Now', 'Plain Backtick Title'], 'a label written as text by id, and one written as a backtick string with no ${}');
  // A label's content that does not read back as one template is read with
  // its interpolations taken out, never dropped and never half-read.
  assert.deepEqual(labelVariants("Save ${x ? 'All' : 'It'"), ['Save'], 'an interpolation that never closes');
  assert.deepEqual(labelVariants('a ${b}` + `c'), ['a ` + `c'], 'two templates joined by code');
  assert.deepEqual(labelVariants('${a}`;`${b}'), ['`;`'], 'two statements');
  // Every way a label can go is judged, up to 64 of them for one label.
  const choices = (n: number): string => `\`<button>${Array.from({ length: n }, (_, i) => `\${f${i} ? 'a${i}' : 'b${i}'}`).join('')}</button>\``;
  assert.equal(labelsIn(choices(6)).length, 64, 'six two-way choices: all 64 labels are judged');
  assert.equal(labelsIn(choices(7)).length, 64, 'seven: no more than 64');
});

test('the label reader reads a label a + joins from more than one string (G18 review F3.3)', () => {
  // The cart's result summary opens its "Undo this run" button in one
  // template and writes the label in the next. Read as code, the content was
  // "` + `…", dropped as joined by code, so a Title Case label there passed
  // unseen. It is read from the strings the + joins instead.
  const cart = "html += `<div class=\"cart-mf-undo\"><button class=\"btn\" data-cart-undo=\"${escapeHtml(id)}\">` +\n  `${icon('refresh', 14)}Undo This Run</button>` + `<span>${n}</span>`;";
  assert.deepEqual(labelsIn(cart), [], 'control: read as code, the label is joined by code');
  assert.deepEqual(builtLabels(cart), ['Undo This Run'], 'the label two templates a + joins hold');
  assert.deepEqual(builtLabels("el.innerHTML = '<h3>' + icon('k', 18) + 'Keyboard ' + (mac ? 'Keys' : 'Shortcuts') + '</h3>';"), ['Keyboard Keys', 'Keyboard Shortcuts'],
    'a heading, each way its parts can go; an icon\'s name is not words');
  assert.deepEqual(builtLabels("el.innerHTML = 'a' + `<button class=\"pill\">` + escapeHtml(label) + '</button>';"), [], 'a label code computes has no words of its own');
  // A label inside one string is labelsIn's to read, from the code: read once.
  const oneString = "x = `<button>${a ? 'Read Once' : 'b'}</button>`; y = '<button class=\"' + c + '\">Read Once Too</button>';";
  assert.deepEqual(labelsIn(oneString), ['Read Once', 'b', 'Read Once Too'], 'control: labelsIn reads a label inside one string');
  assert.deepEqual(builtLabels(oneString), [], 'so the strings a + joins do not read it again');
});

test('the label reader follows a label handed to a page function that writes it into a button or a heading (G18 review F2.2)', () => {
  // setConfirmButton('Empty the Trash') writes its label into the confirm
  // button, openBrowse its title and button label into the folder picker,
  // watchOffloadJob its title through watchJob into the progress sheet: the
  // reader knew only askText and watchJob by name, so a Title Case label
  // handed to any other passed unseen.
  const page = [
    '<h3 id="confirmTitle">x</h3><button id="confirmOk">OK</button><h3 id="jobTitle">x</h3><h3 id="browseTitle">x</h3><button id="browseUse">x</button><div id="note">x</div>',
    '<script>',
    'function forward(a, t) { relay(t); }', // handed on twice, by functions declared before the one that writes it
    'function relay(x) { setOk(x); }',
    "function setOk(label, iconName = 'trash') { $('confirmOk').innerHTML = icon(iconName, 15) + escapeHtml(label); }",
    "function setOkOr(label = 'Delete Item') { $('confirmOk').textContent = label; }", // a plain parameter's default (review F3.1)
    "function ask({ title, hint, ok: okLabel = 'Got It' }) { $('confirmTitle').textContent = title; $('note').textContent = hint; $('confirmOk').textContent = okLabel; }",
    "function job(opts) { $('jobTitle').innerHTML = icon(opts.icon || 'x', 18) + opts.title; }",
    "function jobFor(id, title) { job({ title, icon: 'archive' }); }",
    'function jobNamed(t) { job({ title: t }); }',
    "async function browse(start, pick, title, use) { $('browseTitle').innerHTML = icon('folder', 18) + (title || 'Choose A Folder'); $('browseUse').innerHTML = escapeHtml(use || (pick ? 'Use This Folder' : 'Scan this folder')); }",
    "function noted(text) { $('note').textContent = text; }",
    'const okLater = (text) => { setTimeout(() => setOk(text)); };',
    'const okNow = function (text) { setOk(text); };',
    "function headed(n, name, fallback) { $('jobTitle').innerHTML = n ? `Open ${name}` : (fallback ?? 'Open it?'); }",
    '</script>',
    "<script>setOk('Empty The Trash'); forward(1, 'Save Now'); relay(n ? 'Move It' : 'Keep it'); okLater('Approve All'); okNow('Done Now'); headed(2, 'Old Files', 'Open Them?');",
    "ask({ title: 'Save View', hint: 'Not A Label', ok: 'Save view' }); jobFor(3, 'Offloading Files…'); jobNamed('Putting It Back…');",
    "job({ title: 'Restoring…', icon: 'Not Words' }); browse(s, cb, 'Folder This Policy Cleans', 'Offload To This Folder'); browse(s);",
    "noted('Not A Label Either'); setOk(label);</script>",
  ].join('\n');
  const sinks = Object.fromEntries([...labelSinks(page)].map(([name, keys]) => [name, [...keys].sort()]));
  assert.deepEqual(sinks, {
    forward: ['1'], relay: ['0'], setOk: ['0'], setOkOr: ['0'], ask: ['0.ok', '0.title'], job: ['0.title'], jobFor: ['1'], jobNamed: ['0'], browse: ['2', '3'], okLater: ['0'],
    okNow: ['0'], headed: ['1', '2'],
  }, 'the arguments that end up as a label: written by id, or handed on, wherever declared; not an icon\'s name, not a field label');
  assert.deepEqual([...assignedLabels(page)].sort(), [
    'Got It', 'Delete Item', 'Choose A Folder', 'Use This Folder', 'Scan this folder', 'Empty The Trash', 'Save Now', 'Move It', 'Keep it', 'Approve All',
    'Done Now', 'Open', 'Open it?', 'Old Files', 'Open Them?',
    'Save View', 'Save view', 'Offloading Files…', 'Putting It Back…', 'Restoring…', 'Folder This Policy Cleans', 'Offload To This Folder',
  ].sort(), 'every label handed to a function that writes it, directly, destructured, as a property or handed on; its default, a plain parameter\'s or a destructured one\'s; what escapeHtml is handed — not a field label, an icon\'s name or a name');
});

test('the label reader follows a label a page function builds into a button or a heading it makes (G18 review F3.2)', () => {
  // toastAction(msg, label, …) builds its button as '<button class="pill"…>'
  // + escapeHtml(label) + '</button>' and writes it into an element of its
  // own, not one the page names by id: its labels — "Scan again", "Undo",
  // offerMeant's "Use that folder" — passed unseen.
  const page = [
    '<script>',
    "function toastish(msg, label, fn) { const el = document.createElement('div'); el.innerHTML = icon('alert', 16) + `<span>` + escapeHtml(msg) + '</span>' +",
    "  `<button class=\"pill\" type=\"button\">` + escapeHtml(label) + '</button>'; }",
    "function offer(p, label = 'Use That Folder') { toastish(`No folder is named ${p}`, label, () => {}); }",
    'function chip(id, name) { return `<button class="chip" data-id="${id}">${escapeHtml(name)}</button>`; }',
    "function heading(title) { return '<h3>' + icon('x', 18) + title + '</h3>'; }",
    'function row(item) { return `<div class="row">${escapeHtml(item)}</div>`; }',
    "function wrapped(t) { return `<div>${toastish('Not A Label', t)}</div>`; }", // handed on from inside a template
    '</script>',
    "<script>toastish('Not A Label', 'Scan Again', go); toastish(m, 'Undo It'); offer(p); offer(p, 'Open That Folder'); chip('Not An Id Label', 'Pick Me');",
    "heading('Old Files'); row('Not A Label Either'); wrapped('Try Again');</script>",
  ].join('\n');
  const sinks = Object.fromEntries([...labelSinks(page)].map(([name, keys]) => [name, [...keys].sort()]));
  assert.deepEqual(sinks, { toastish: ['1'], offer: ['1'], chip: ['1'], heading: ['0'], wrapped: ['0'] },
    'an argument a function builds into a button or a heading it makes, by + or in a template, or hands on to one that does; not one in a tag\'s attribute, not one outside a button');
  assert.deepEqual([...assignedLabels(page)].sort(), ['Scan Again', 'Undo It', 'Use That Folder', 'Open That Folder', 'Pick Me', 'Old Files', 'Try Again'].sort(),
    'every label handed to such a function, and its default');
});

/* ══════════════ The page ══════════════ */

test('the page names the feature "Clean Up" — never "Cleanup", never "the cleanup cart" — wherever a person reads it (G18)', () => {
  assert.deepEqual(cleanupNamings(pageText(INDEX)), [], 'public/index.html (rebuild with node scripts/build-ui.js)');
});

test('every button and modal title of the page is in sentence case, but for proper names (G18)', () => {
  const sidebar = sidebarNames(INDEX);
  assert.ok(sidebar.includes('Clean Up') && sidebar.includes('Undo Vault') && sidebar.includes('Missing GB'), `control: the sidebar's names are read (${sidebar.join(', ')})`);
  assert.deepEqual(titleCaseLabels(INDEX), []);
  // The controls come after the verdict, so a label gone Title Case is named
  // by it, and a reader that stopped reading one fails here.
  const labels = [...labelsIn(markupOf(INDEX)), ...scriptsOf(INDEX).flatMap(labelsIn)];
  assert.ok(labels.length > 150, `control: the page's labels are read, markup and script (${labels.length})`);
  assert.ok(labels.includes('Remove budget') && labels.includes('Keyboard shortcuts'), 'control: a script\'s button and a modal heading are among them');
  assert.ok(labels.includes('Edit budget…') && labels.includes('Set budget…'), 'control: both arms of an interpolated label are among them');
  assert.ok(scriptsOf(INDEX).flatMap(builtLabels).includes('Undo this run'), 'control: the cart\'s "Undo this run", a label a + joins from two templates, is read (review F3.3)');
  const sinks = labelSinks(INDEX);
  for (const [fn, key] of [['setConfirmButton', '0'], ['openBrowse', '2'], ['openBrowse', '3'], ['watchOffloadJob', '1'], ['askText', '0.title'], ['askText', '0.ok'], ['watchJob', '0.title'],
    ['toastAction', '1'], ['offerMeant', '3']]) {
    assert.ok(sinks.get(fn)?.has(key), `control: ${fn}'s argument ${key} is known to end up as a label (${[...sinks.keys()].join(', ')})`);
  }
  const assigned = assignedLabels(INDEX);
  for (const label of ['Move to Trash?', 'Forget this copy?', 'Copy, verify, then trash', 'Save view', 'Restoring…', 'New policy',
    'Purge snapshots', 'Forget this copy', 'Folder this policy cleans', 'Offload to this folder', 'Offloading…', 'Use this folder', 'OK', 'Show all',
    'Scan again', 'Undo', 'Use that folder', 'Open that folder']) {
    assert.ok(assigned.includes(label), `control: a label written by id, or handed to a function that writes one, is read: ${label} (${assigned.length} read)`);
  }
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

/** Each place `text` names a Clean Up tab in its old Title Case, with a little around it — wherever a line break falls in the name. */
function oldTabNamings(text: string): string[] {
  const hits: string[] = [];
  const said = oneLine(text);
  for (const m of said.matchAll(new RegExp(OLD_TAB_NAMES.join('|'), 'g'))) {
    const at = m.index ?? 0;
    hits.push(JSON.stringify(said.slice(Math.max(0, at - 40), at + m[0].length + 30)));
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
