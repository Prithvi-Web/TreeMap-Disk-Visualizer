#!/usr/bin/env node
/**
 * Build the ntfs-mft-scan helper (native/ntfs-mft-scan) for the host
 * platform and stage it for bundling — the build-time equivalent of
 * fetchGdu.js, except there's no upstream release to download: this binary
 * only ever comes from this repo's own Rust source.
 *
 * Windows-only, unlike gdu's 5-platform fetch matrix — the helper does
 * nothing on macOS/Linux, so it is never built or staged there.
 *
 * A missing Rust toolchain must never fail a build: the app falls back to
 * gdu/walker, same as a missing gdu binary, and a contributor without Rust
 * installed should still be able to build TreeMap.
 *
 * Usage:
 *   node scripts/buildNtfsMftScan.js         # host platform, into build/ntfs-mft-scan/win-x64/
 *   node scripts/buildNtfsMftScan.js --dev   # into ./ntfs-mft-scan/ (what findNtfsMftBinary looks for in dev)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CRATE_DIR = path.join(ROOT, 'native', 'ntfs-mft-scan');
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

function cargoAvailable() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build(destDir) {
  if (process.platform !== 'win32') {
    console.log('[buildNtfsMftScan] non-Windows host — nothing to build, app will use gdu/walker.');
    return;
  }

  if (!cargoAvailable()) {
    console.log('[buildNtfsMftScan] cargo not found — skipping; app will use gdu/walker.');
    return;
  }

  console.log('[buildNtfsMftScan] cargo build --release...');
  execFileSync('cargo', ['build', '--release', '--target', TARGET_TRIPLE], {
    cwd: CRATE_DIR,
    stdio: 'inherit',
  });

  const built = path.join(CRATE_DIR, 'target', TARGET_TRIPLE, 'release', 'ntfs-mft-scan.exe');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(built, path.join(destDir, 'ntfs-mft-scan.exe'));
  console.log(`[buildNtfsMftScan] -> ${path.relative(ROOT, destDir)}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dev')) {
    build(path.join(ROOT, 'ntfs-mft-scan'));
    return;
  }
  build(path.join(ROOT, 'build', 'ntfs-mft-scan', 'win-x64'));
}

main();
