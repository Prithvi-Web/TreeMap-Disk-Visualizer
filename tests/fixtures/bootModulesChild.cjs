'use strict';
/*
 * bootModulesChild — a fresh process for tests/bootModules.test.ts (Track U, U-6).
 *
 * It builds the app exactly as the server does (createApp), then reports which
 * of the heavy libraries sit in require.cache — at boot, after one XLSX
 * export, after a second, and after two PDF exports — and how many times each
 * report library was required BY NAME, so a loader that does not keep what it
 * loaded shows up as a second require. A separate process because the test
 * runner's own has long since loaded all of them.
 *
 * Plain CommonJS that installs tsx's require hook itself (the house rule for
 * anything a child process loads). Writes one `BOOT_MODULES {json}` line on
 * stdout and exits; the caller gives it its own TREEMAP_DATA_DIR.
 */
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

const repo = process.argv[2];
require('tsx/cjs');

/** The libraries a boot must not load: the report writers and the MCP SDK with its schema library. */
const HEAVY = /[\\/]node_modules[\\/](exceljs|pdfmake|@modelcontextprotocol|zod)[\\/]/;
/** The report libraries as reportExport asks for them. */
const requires = { exceljs: 0, 'pdfmake/src/printer': 0 };

const load = Module._load;
Module._load = function countingLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(requires, request)) requires[request] += 1;
  return load.call(this, request, parent, isMain);
};

function snapshot() {
  const heavy = new Set();
  for (const key of Object.keys(require.cache)) {
    const m = HEAVY.exec(key);
    if (m) heavy.add(m[1]);
  }
  return { heavy: [...heavy].sort(), cacheKeys: Object.keys(require.cache).length, requires: { ...requires } };
}

/** A response stand-in that drains what it is sent, and settles when the export ends it. */
function response() {
  const res = new PassThrough();
  res.status = () => res;
  res.setHeader = () => {};
  res.resume();
  const ended = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  return { res, ended };
}

const scan = {
  rootPath: os.tmpdir(),
  status: 'complete',
  fileCount: 1,
  dirCount: 1,
  root: {
    name: 'demo', path: '/demo', size: 10, type: 'dir', modifiedAt: 0, isHidden: false,
    children: [{ name: 'a.txt', path: '/demo/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' }],
  },
};

async function main() {
  const { createApp } = require(path.join(repo, 'src', 'server.ts'));
  createApp(path.join(repo, 'public'));
  const boot = snapshot();

  const { streamXlsx, streamPdf } = require(path.join(repo, 'src', 'services', 'reportExport.ts'));
  const xlsx = async () => { const { res, ended } = response(); await streamXlsx(scan, 'files', res); await ended; };
  const pdf = async () => { const { res, ended } = response(); await streamPdf(scan, res); await ended; };

  await xlsx();
  const afterOneXlsx = snapshot();
  await xlsx();
  const afterTwoXlsx = snapshot();
  await pdf();
  await pdf();
  const afterTwoPdf = snapshot();
  process.stdout.write(`BOOT_MODULES ${JSON.stringify({ boot, afterOneXlsx, afterTwoXlsx, afterTwoPdf })}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  },
);
