#!/usr/bin/env node
/*
 * Copy non-TypeScript runtime assets from src/ into dist/.
 *
 * `tsc` emits .js and nothing else, so the rule-pack JSON that Smart
 * Suggestions loads at runtime would simply not exist in a built app. This
 * runs after tsc (see the `build` script) and mirrors those files across.
 *
 * Kept as a plain copy rather than a JSON import: the packs are meant to be
 * readable and editable in an installed app, and `require`-ing them would bake
 * a snapshot into the bundle instead.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const ASSET_DIRS = [path.join('services', 'rulepacks')];

let copied = 0;
for (const rel of ASSET_DIRS) {
  const from = path.join(repoRoot, 'src', rel);
  const to = path.join(repoRoot, 'dist', rel);
  if (!fs.existsSync(from)) {
    console.error(`copy-assets: missing source directory ${from}`);
    process.exit(1);
  }
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
    fs.copyFileSync(path.join(from, name), path.join(to, name));
    copied++;
  }
}

if (copied === 0) {
  console.error('copy-assets: nothing was copied — the build would ship without its rule packs');
  process.exit(1);
}
console.log(`copy-assets: ${copied} file(s) -> dist/`);
