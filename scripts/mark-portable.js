#!/usr/bin/env node
/*
 * Drop the portable marker beside a built bundle (§D3).
 *
 * Windows needs nothing: electron-builder's `portable` target sets
 * PORTABLE_EXECUTABLE_DIR at runtime, which TreeMap already reads. The mac zip
 * and the Linux AppImage have no such signal, so the marker file is how those
 * bundles identify themselves as portable.
 *
 * The marker is also the user's own switch: deleting it turns a portable copy
 * back into an ordinary one, and creating it beside any install turns that
 * install portable. It is documented in its own contents for exactly that
 * reason — a mystery file on a USB stick is worse than no file.
 */
const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'release');
const MARKER = 'treemap-portable.txt';
const BODY = `TreeMap portable mode
=====================

While this file sits next to the TreeMap application, TreeMap runs as a
PORTABLE session:

  * It writes nothing to the computer it is running on.
  * Settings, scan history and the search index are kept in the
    "TreeMap-Data" folder beside this file instead.
  * If this drive is read-only, nothing is saved at all and TreeMap says so.

Delete this file to turn the copy back into an ordinary installation.
`;

if (!fs.existsSync(releaseDir)) {
  console.error('mark-portable: no release/ directory — run a dist script first');
  process.exit(1);
}

let written = 0;
for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
  // The unpacked bundle directories electron-builder leaves behind, e.g.
  // release/mac-arm64/ and release/linux-unpacked/.
  if (!entry.isDirectory()) continue;
  if (!/^(mac|linux|win)/.test(entry.name)) continue;
  fs.writeFileSync(path.join(releaseDir, entry.name, MARKER), BODY);
  written++;
}

if (written === 0) {
  console.error('mark-portable: found no unpacked bundle to mark');
  process.exit(1);
}
console.log(`mark-portable: marked ${written} bundle(s) portable`);
