#!/usr/bin/env node
/**
 * Fetch the gdu binary for a target platform/arch and stage it for bundling.
 *
 * gdu (github.com/dundee/gdu) is MIT-licensed and ships as a single static
 * binary per platform — the same bundling shape this repo already uses for
 * sharp's native code. It powers the 'gdu-turbo' scan engine
 * (src/services/gduScanner.ts); without it the app silently falls back to the
 * built-in walker, which works but is slower.
 *
 * Downloads are verified against the release's published sha256sums.txt. A
 * binary we are going to execute on a user's machine does not get installed on
 * trust.
 *
 * Usage:
 *   node scripts/fetchGdu.js                 # host platform, into build/gdu/<platform>-<arch>/
 *   node scripts/fetchGdu.js --all           # every supported target
 *   node scripts/fetchGdu.js --dev           # host platform, into ./gdu/ (what `npm run dev` looks for)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = 'v5.36.1';
const BASE = `https://github.com/dundee/gdu/releases/download/${VERSION}`;
const ROOT = path.join(__dirname, '..');

/**
 * Keyed by electron-builder's ${os}-${arch} macro values — NOT Node's
 * process.platform. electron-builder resolves ${os} to mac/linux/win, so
 * staging under "darwin-arm64" would leave `from` pointing at nothing and the
 * binary would silently not ship.
 */
const TARGETS = {
  'mac-arm64': 'gdu_darwin_arm64.tgz',
  'mac-x64': 'gdu_darwin_amd64.tgz',
  'linux-x64': 'gdu_linux_amd64.tgz',
  'linux-arm64': 'gdu_linux_arm64.tgz',
  'win-x64': 'gdu_windows_amd64.exe.zip',
};

/** Node's process.platform -> electron-builder's ${os}. */
const OS_NAME = { darwin: 'mac', linux: 'linux', win32: 'win' };

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** name -> sha256, parsed from the release's sha256sums.txt. */
async function checksums() {
  const txt = (await download(`${BASE}/sha256sums.txt`)).toString('utf8');
  const map = new Map();
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  if (!map.size) throw new Error('could not parse sha256sums.txt');
  return map;
}

async function fetchTarget(target, sums, destDir) {
  const asset = TARGETS[target];
  if (!asset) throw new Error(`unsupported target ${target}`);

  const exe = target.startsWith('win') ? 'gdu.exe' : 'gdu';
  const finalPath = path.join(destDir, exe);
  if (fs.existsSync(finalPath)) {
    console.log(`  ${target}: already present, skipping`);
    return;
  }

  console.log(`  ${target}: downloading ${asset}`);
  const buf = await download(`${BASE}/${asset}`);

  const expected = sums.get(asset);
  if (!expected) throw new Error(`${asset} has no entry in sha256sums.txt`);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    throw new Error(`${asset} checksum mismatch\n  expected ${expected}\n  actual   ${actual}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdu-fetch-'));
  try {
    const archive = path.join(tmp, asset);
    fs.writeFileSync(archive, buf);
    fs.mkdirSync(destDir, { recursive: true });

    // bsdtar ships with macOS and Windows 10+ and extracts BOTH .tgz and .zip,
    // so it is the one tool available on every runner this builds on. `unzip`
    // is not reliably on PATH under windows-latest — and because a fetch
    // failure is deliberately non-fatal, relying on it meant the Windows build
    // would silently ship with no gdu and quietly fall back to the walker.
    // GNU tar (Linux) cannot read zips, but the only zip asset is the Windows
    // one, which is only ever fetched on Windows.
    try {
      execFileSync('tar', ['xf', archive, '-C', tmp], { stdio: 'inherit' });
    } catch (err) {
      if (!asset.endsWith('.zip')) throw err;
      execFileSync('unzip', ['-o', '-q', archive, '-d', tmp], { stdio: 'inherit' });
    }

    // The archives contain a single binary, named for the target.
    const extracted = fs
      .readdirSync(tmp)
      .filter((n) => n !== asset)
      .map((n) => path.join(tmp, n))
      .find((p) => fs.statSync(p).isFile());
    if (!extracted) throw new Error(`no binary found inside ${asset}`);

    fs.copyFileSync(extracted, finalPath);
    fs.chmodSync(finalPath, 0o755);
    console.log(`  ${target}: -> ${path.relative(ROOT, finalPath)} (verified)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchLicense() {
  // MIT requires the licence text to travel with the binary.
  const dest = path.join(ROOT, 'build', 'gdu', 'LICENSE.md');
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = await download(`https://raw.githubusercontent.com/dundee/gdu/${VERSION}/LICENSE.md`);
  fs.writeFileSync(dest, buf);
  console.log(`  licence: -> ${path.relative(ROOT, dest)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const host = `${OS_NAME[process.platform] ?? process.platform}-${process.arch}`;

  console.log(`gdu ${VERSION}`);
  const sums = await checksums();

  if (args.includes('--dev')) {
    // Where findGduBinary looks when running from source.
    await fetchTarget(host, sums, path.join(ROOT, 'gdu'));
    return;
  }

  await fetchLicense();
  const targets = args.includes('--all') ? Object.keys(TARGETS) : [host];
  for (const t of targets) {
    await fetchTarget(t, sums, path.join(ROOT, 'build', 'gdu', t));
  }
}

main().catch((err) => {
  // Never fail a build over this: the app falls back to the walker, and a
  // developer without network access should still be able to build.
  console.error(`[fetchGdu] ${err.message}`);
  console.error('[fetchGdu] continuing without a bundled gdu — the app will use the built-in walker.');
  process.exit(0);
});
