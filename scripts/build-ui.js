#!/usr/bin/env node
'use strict';
/*
 * Stitch src/ui/** into public/index.html.
 *
 * The app ships as ONE file on purpose: tests/frontendContract.test.ts forbids
 * any external script, stylesheet or font, so the page works from file://, out
 * of a portable zip, and inside the Electron shell with nothing to resolve.
 * That is a shipping constraint, not an editing one — so the sources live as
 * ~110 small files here and this script concatenates them.
 *
 * Every part is a verbatim slice of the page: the build is a concatenation and
 * nothing else. No templating, no minification, no reordering. That is what
 * makes `--check` meaningful — it can prove the committed artifact is exactly
 * what these sources produce.
 *
 *   node scripts/build-ui.js            write public/index.html
 *   node scripts/build-ui.js --check    exit 1 if the artifact has drifted
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const uiDir = path.join(repoRoot, 'src', 'ui');
const manifestPath = path.join(uiDir, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error(`build-ui: no manifest at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const outPath = path.join(repoRoot, manifest.output);

const pieces = manifest.parts.map((rel) => {
  const file = path.join(uiDir, rel);
  if (!fs.existsSync(file)) {
    console.error(`build-ui: manifest lists ${rel}, which does not exist`);
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
});

/* Parts are contiguous line-ranges of the original page, stored without their
   trailing newline, so the separator restores exactly the line that was cut. */
const built = pieces.join('\n');

/* A source file that is not in the manifest would silently never ship. */
const listed = new Set(manifest.parts);
const orphans = [];
for (const dir of fs.readdirSync(uiDir)) {
  const sub = path.join(uiDir, dir);
  if (!fs.statSync(sub).isDirectory()) continue;
  for (const name of fs.readdirSync(sub)) {
    const rel = `${dir}/${name}`;
    if (!listed.has(rel)) orphans.push(rel);
  }
}
if (orphans.length) {
  console.error(`build-ui: ${orphans.length} file(s) not in the manifest, so they would never ship:`);
  for (const o of orphans) console.error(`  ${o}`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current === built) {
    console.log(`build-ui: ${manifest.output} matches its sources (${manifest.parts.length} parts)`);
    process.exit(0);
  }
  console.error(
    `build-ui: ${manifest.output} does NOT match src/ui — it was edited directly, ` +
    'or a source changed without a rebuild. Run `npm run build:ui`.'
  );
  process.exit(1);
}

/* The Docker build stage compiles from a bare checkout of src/ + scripts/,
   where public/ does not exist yet — the page it is about to write IS that
   directory's only content. */
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, built);
console.log(`build-ui: ${manifest.parts.length} parts -> ${manifest.output}`);
