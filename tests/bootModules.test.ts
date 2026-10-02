import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { HANG_GUARD_MS } from './fixtures/waitFor';
isolatedDataDir('treemap-bootModules-data-');

/**
 * Track U, U-6 — what the server loads when it starts.
 *
 * Every boot used to load exceljs, pdfmake, the MCP SDK and zod — 0.56–1.65 s
 * of eager loading on every app open in the Track U diagnosis — for report
 * exports most sessions never make and an MCP server that runs as its own
 * process. Now the report writers load inside the export that needs them, and
 * the server reads the MCP tool list from a file that imports nothing.
 *
 * Counted, not timed: which modules a fresh process holds after createApp, and
 * how many times each report library is required by name. The cost moves to
 * the first PDF or XLSX export; it is not removed.
 */

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');
const CHILD = path.join(__dirname, 'fixtures', 'bootModulesChild.cjs');

type Snapshot = { heavy: string[]; cacheKeys: number; requires: Record<string, number> };
type ChildReport = { boot: Snapshot; afterOneXlsx: Snapshot; afterTwoXlsx: Snapshot; afterTwoPdf: Snapshot };

/** Runs the fixture in a process of its own, with a data folder of its own, and reads its one report line. */
function bootInAFreshProcess(): ChildReport {
  const r = spawnSync(process.execPath, [CHILD, REPO], {
    cwd: REPO,
    env: { ...process.env, TREEMAP_DATA_DIR: fileTempDir('treemap-bootModules-child-'), TREEMAP_NO_GDU: '1' },
    encoding: 'utf8',
    timeout: HANG_GUARD_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `the boot process failed: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('BOOT_MODULES '));
  assert.ok(line, `the boot process reported nothing: ${r.stdout}`);
  return JSON.parse(line.slice('BOOT_MODULES '.length)) as ChildReport;
}

test('starting the server loads no report writer and no MCP library; each export loads its own, once', (t) => {
  const report = bootInAFreshProcess();
  t.diagnostic(`modules in require.cache: ${report.boot.cacheKeys} at boot, ${report.afterTwoPdf.cacheKeys} after the exports`);
  assert.deepEqual(report.boot.heavy, [], 'createApp loads none of exceljs, pdfmake, @modelcontextprotocol, zod');
  assert.deepEqual(report.boot.requires, { exceljs: 0, 'pdfmake/src/printer': 0 }, 'and nothing asked for a report library by name');
  assert.deepEqual(report.afterOneXlsx.heavy, ['exceljs'], 'one XLSX export loads exceljs, and only exceljs: the lazy path is live');
  assert.equal(report.afterTwoXlsx.requires.exceljs, 1, 'a second XLSX export reuses what the first loaded: one require in all');
  assert.deepEqual(report.afterTwoPdf.heavy, ['exceljs', 'pdfmake'], 'the PDF exports load pdfmake; no export loads the MCP SDK or zod');
  assert.equal(report.afterTwoPdf.requires['pdfmake/src/printer'], 1, 'two PDF exports, one require');
});

/* ══════════════════ The source holds it: who may load what ══════════════════ */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

type ModuleUse = { file: string; spec: string; how: 'import' | 'import type' | 'export from' | 'require' | 'dynamic import'; inFunction: string | null; line: number };

/** Every place a file names another module, with how and from inside which function. */
function moduleUses(file: string): ModuleUse[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const rel = path.relative(REPO, file).split(path.sep).join('/');
  const uses: ModuleUse[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const enclosingFunction = (node: ts.Node): string | null => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if (ts.isFunctionLike(p)) return '(anonymous)';
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = !!node.importClause?.isTypeOnly;
      uses.push({ file: rel, spec: node.moduleSpecifier.text, how: typeOnly ? 'import type' : 'import', inFunction: null, line: at(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      uses.push({ file: rel, spec: node.moduleSpecifier.text, how: 'export from', inFunction: null, line: at(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      uses.push({ file: rel, spec: node.moduleReference.expression.text, how: node.isTypeOnly ? 'import type' : 'import', inFunction: null, line: at(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        uses.push({ file: rel, spec: node.arguments[0].text, how: isRequire ? 'require' : 'dynamic import', inFunction: enclosingFunction(node), line: at(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

const ALL_USES = sourceFiles(SRC).flatMap(moduleUses);
const show = (u: ModuleUse): string => `${u.file}:${u.line} ${u.how} '${u.spec}'${u.inFunction ? ` in ${u.inFunction}()` : ''}`;

/** Where the report writers may be loaded: these two functions in reportExport.ts, and nowhere else. */
const REPORT_LOADERS = new Set(['src/services/reportExport.ts#loadExcel', 'src/services/reportExport.ts#getPrinter']);

test('exceljs and pdfmake are loaded only inside the export loaders; everywhere else they are named for their types', () => {
  const report = ALL_USES.filter((u) => /^(?:exceljs|pdfmake)(?:\/|$)/.test(u.spec));
  assert.ok(report.length > 0, 'the scan finds the report libraries where they are used');
  const loads = report.filter((u) => u.how !== 'import type');
  const outside = loads.filter((u) => !(u.how === 'require' && REPORT_LOADERS.has(`${u.file}#${u.inFunction}`)));
  assert.deepEqual(outside.map(show), [], 'a runtime load of a report library outside its loader puts it back on the boot path');
  assert.deepEqual(loads.map((u) => `${u.inFunction}:${u.spec}`).sort(), ['getPrinter:pdfmake/src/printer', 'loadExcel:exceljs'], 'each loader loads its own library');
});

test('nothing outside src/mcp reaches the MCP server; the tool list it shares imports nothing', () => {
  const mcpDir = path.join(SRC, 'mcp');
  const intoMcp = ALL_USES.filter((u) => {
    const from = path.join(REPO, u.file);
    if (from.startsWith(mcpDir + path.sep) || !u.spec.startsWith('.')) return false;
    const target = path.resolve(path.dirname(from), u.spec);
    return target === mcpDir || target.startsWith(mcpDir + path.sep);
  });
  const notTheList = intoMcp.filter((u) => path.resolve(path.dirname(path.join(REPO, u.file)), u.spec) !== path.join(mcpDir, 'toolNames'));
  assert.deepEqual(notTheList.map(show), [], 'only src/mcp/toolNames may be imported from outside src/mcp');
  assert.ok(intoMcp.some((u) => u.file === 'src/api/metaRoutes.ts'), 'metaRoutes reads the tool list from there');
  const sdk = ALL_USES.filter((u) => /^(?:@modelcontextprotocol\/|zod(?:\/|$))/.test(u.spec) && !u.file.startsWith('src/mcp/'));
  assert.deepEqual(sdk.map(show), [], 'the MCP SDK and zod are named only inside src/mcp');
  const own = moduleUses(path.join(mcpDir, 'toolNames.ts'));
  assert.deepEqual(own.map(show), [], 'toolNames.ts imports nothing, so reading the list loads nothing');
});
