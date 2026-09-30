import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * No test or bench file removes a path built from the real home folder
 * (CONTRIBUTING.md: "never touch a real home folder — synthetic fixtures
 * only"). Until 30 Sep 2026 tests/queryToPolicy.test.ts made
 * `~/q2p-fixture` in the owner's real home and removed it with
 * `fsp.rm(…, { recursive: true, force: true })` on every run: a hard delete,
 * outside the Trash, of whatever folder of that name the owner kept there.
 * `npm test` never changes HOME, so `os.homedir()` in a test is the owner's.
 *
 * It reads each file's syntax tree, by name rather than by scope: a name
 * given a value built from the home folder anywhere in a file — from
 * `os.homedir()`, `os.userInfo().homedir`, or `process.env.HOME`,
 * `USERPROFILE` or `HOMEPATH`, or from another such name — is the home
 * folder's wherever the file uses it. A parameter is not followed, so a
 * helper handed the home folder is not seen, and a name reused for a temp
 * folder elsewhere in the same file is read as the home folder's: rename it.
 */

const REPO = path.join(__dirname, '..');

/** Calls that remove what their first argument names, by their own name or as a method. */
const REMOVERS = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rimraf', 'rimrafSync', 'removeTempDir']);
/** The environment variables that name the home folder, on each OS. */
const HOME_VARIABLES = new Set(['HOME', 'USERPROFILE', 'HOMEPATH']);

function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'env'
    && ts.isIdentifier(node.expression) && node.expression.text === 'process';
}

/** `os.homedir()`, `homedir()`, `os.userInfo().homedir`, `process.env.HOME`, `process.env['USERPROFILE']`… */
function isHomeFolder(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'homedir') return true;
    return HOME_VARIABLES.has(node.name.text) && isProcessEnv(node.expression);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'homedir') return true;
  return ts.isElementAccessExpression(node) && isProcessEnv(node.expression)
    && ts.isStringLiteralLike(node.argumentExpression) && HOME_VARIABLES.has(node.argumentExpression.text);
}

/** An identifier that names a property (`x.HOME`, `{ HOME: 1 }`) rather than a value. */
function isPropertyName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === id)
    || (ts.isPropertyAssignment(parent) && parent.name === id);
}

/** Whether `node` holds the home folder, or a name that does. */
function mentionsHome(node: ts.Node, homeNames: ReadonlySet<string>): boolean {
  if (isHomeFolder(node)) return true;
  if (ts.isIdentifier(node) && homeNames.has(node.text) && !isPropertyName(node)) return true;
  return ts.forEachChild(node, (child) => mentionsHome(child, homeNames) || undefined) ?? false;
}

/** Every name in `source` given a value built from the home folder, followed to a fixed point. */
function homeNamesIn(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const bindings: Array<{ name: string; value: ts.Node }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) bindings.push({ name: node.name.text, value: node.initializer });
      // `const { HOME } = process.env`, `const { homedir } = os` (then `homedir()` is caught by name).
      else if (ts.isObjectBindingPattern(node.name) && isProcessEnv(node.initializer)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) && HOME_VARIABLES.has(key.text) && ts.isIdentifier(element.name)) names.add(element.name.text);
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      bindings.push({ name: node.left.text, value: node.right });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, value } of bindings) {
      if (!names.has(name) && mentionsHome(value, names)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** The name a call is made by: `rm(`, `fs.rmSync(`, `fsp.rm(`, `rimraf.sync(` (as rimraf). */
function calledName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.name.text === 'sync' && ts.isIdentifier(callee.expression)) return callee.expression.text;
  return callee.name.text;
}

/** Every removal in `code` of a path built from the home folder, as `line: call`. */
function homeRemovals(fileName: string, code: string): string[] {
  const kind = /\.(?:c|m)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const homeNames = homeNamesIn(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      const target = node.arguments[0];
      if (name !== null && REMOVERS.has(name) && target !== undefined && mentionsHome(target, homeNames)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${String(line)}: ${node.getText(source).replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('a removal of a path built from the home folder is seen however the path was built', () => {
  for (const code of [
    // tests/queryToPolicy.test.ts until 30 Sep 2026, through two names.
    "const HOME = os.homedir();\nconst SAFE_PATH = path.join(HOME, 'q2p-fixture');\nawait fsp.rm(SAFE_PATH, { recursive: true, force: true });",
    "fs.rmSync(path.join(os.homedir(), 'x'), { recursive: true, force: true });",
    "fs.promises.unlink(`${require('node:os').homedir()}/.x`);",
    "fs.rmdirSync(path.join(process.env.USERPROFILE!, 'x'));",
    "fs.unlinkSync(process.env['HOME'] + '/x');",
    "rimraf.sync(path.join(os.userInfo().homedir, 'x'));",
    "const { homedir } = os;\nremoveTempDir(path.join(homedir(), 'x'));",
    "const { HOME: home } = process.env;\nrm(path.join(home as string, 'x'), () => {});",
    "let target = '';\ntarget = path.join(os.homedir(), 'x');\nfs.rmSync(target);",
  ]) assert.equal(homeRemovals('x.ts', code).length, 1, code);
});

test('a home folder that is only read, or a removal of anything else, is not', () => {
  for (const code of [
    "const home = os.homedir();\nassert.equal(sanitizePath(home), home);\nfs.rmSync(dir, { recursive: true, force: true });",
    "fs.rmSync(path.join(os.tmpdir(), 'x'), { recursive: true, force: true });",
    // A folder the test made, under a name that happens to be HOME (tests/appDataGuard.test.ts).
    "const HOME = isolatedDataDir('treemap-x-home-');\nfs.rmSync(path.join(HOME, 'x'), { recursive: true, force: true });",
    // A hand-built environment's HOME is not this process's, even in a file that also reads the real one.
    "const HOME = os.homedir();\nassert.ok(HOME);\nfs.rmSync(env.HOME, { recursive: true });",
    "// fs.rmSync(os.homedir());\nconst note = 'fs.rmSync(os.homedir())';",
  ]) assert.deepEqual(homeRemovals('x.ts', code), [], code);
});

test('no test or bench file removes a path built from the real home folder', () => {
  const files = [...sourceFiles(path.join(REPO, 'tests')), ...sourceFiles(path.join(REPO, 'bench'))];
  assert.ok(files.length > 250, `the scan sees the suite: ${String(files.length)} files`);
  const found = files.flatMap((file) => {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    return homeRemovals(rel, fs.readFileSync(file, 'utf8')).map((hit) => `${rel}:${hit}`);
  });
  assert.deepEqual(found, [], 'a test that removes a path in the real home deletes the owner\'s files for good: make the folder with fileTempDir() (tests/fixtures/dataDir.ts)');
});
