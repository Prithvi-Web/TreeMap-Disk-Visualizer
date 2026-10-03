import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { HANG_GUARD_MS } from './fixtures/waitFor';
import { storedZip } from './fixtures/storedZip';
import { chromiumCredits, electronLicence, electronZipEntries, frameworkPlistPath, macAppLayout } from './fixtures/electronLicences';
isolatedDataDir('treemap-electronLicences-data-');

/**
 * scripts/electron-licences.js closes a gap in every macOS build: Electron is
 * MIT-licensed and Chromium's credits list hundreds of licences, and both
 * files sit at the root of every Electron release zip — but electron-builder
 * 24.13.3's createMacApp deletes them from the output folder
 * (app-builder-lib/out/electron/electronMac.js), so TreeMap.app shipped
 * neither, while Windows and Linux builds keep them beside the executable as
 * LICENSE.electron.txt and LICENSES.chromium.html. afterPack now puts the two
 * into the bundle's Contents/Resources under those same names, taken from the
 * Electron zip electron-builder unpacked and checked against the Electron
 * inside the bundle, and refuses, on every platform, a package without them.
 * Nothing here touches the network or a real Electron zip: the download and
 * the zip reader are seams, and the one test of the real reader runs `unzip`
 * on an archive the test writes (tests/fixtures/storedZip.ts).
 */

const VERSION = '31.7.7';
/** UTF-8's byte-order mark, which an editor may put before a text file's first line. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface Source { kind: 'zip' | 'dir'; path: string }
interface Download { version: string; platform: string; arch: string }
interface Deps { downloadZip?: (o: Download) => Promise<string>; readZipEntry?: (zip: string, entry: string) => Buffer }
interface PlaceOptions { appOutDir: string; productFilename: string; arch: string; frameworkVersion: string; config: Record<string, unknown>; projectDir: string }
interface Mod {
  LICENCE_FILE: string;
  CREDITS_FILE: string;
  MIN_CREDITED_PRODUCTS: number;
  checkLicenceText(bytes: Buffer): string | null;
  checkCreditsHtml(bytes: Buffer): string | null;
  bundledElectronVersion(app: string): string;
  electronZipName(version: string, platform: string, arch: string): string;
  licenceSource(opts: { config: Record<string, unknown>; projectDir: string; version: string; platform: string; arch: string }, deps: { downloadZip(o: Download): Promise<string> }): Promise<Source>;
  readLicences(source: Source, deps: { readZipEntry(zip: string, entry: string): Buffer }): { licence: Buffer; credits: Buffer; version: Buffer };
  placeElectronLicences(opts: PlaceOptions, deps?: Deps): Promise<string>;
  assertElectronLicences(opts: { platform: string; appOutDir: string; productFilename: string }): string;
  downloadElectronZip(opts: Download): Promise<string>;
  readZipEntry(zip: string, entry: string): Buffer;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lic = require('../scripts/electron-licences.js') as Mod;

/** A zip reader standing in for `unzip -p`, serving `entries` from a zip at `zip`, and counting its reads. */
function fakeZip(zip: string, entries: Record<string, Buffer>): { readZipEntry(z: string, e: string): Buffer; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readZipEntry(z: string, e: string): Buffer {
      reads.push(e);
      assert.equal(z, zip, 'the reader is handed the zip the source named');
      if (!(e in entries)) throw new Error(`caution: filename not matched:  ${e}`);
      return entries[e];
    },
  };
}

function placeOptions(appOutDir: string, overrides: Partial<PlaceOptions> = {}): PlaceOptions {
  return { appOutDir, productFilename: 'TreeMap', arch: 'arm64', frameworkVersion: VERSION, config: {}, projectDir: appOutDir, ...overrides };
}

test("checkLicenceText accepts Electron's MIT licence and refuses anything else, saying why", () => {
  assert.equal(lic.checkLicenceText(electronLicence()), null);
  assert.equal(lic.checkLicenceText(Buffer.from(electronLicence().toString('utf8').replace(/\n/g, '\r\n'))), null, 'whatever its line endings');
  assert.equal(lic.checkLicenceText(Buffer.concat([BOM, electronLicence()])), null, 'a byte-order mark is not part of the text');
  const own = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'));
  const refusals: [string, Buffer, RegExp][] = [
    ['an empty file', Buffer.alloc(0), /empty|Electron/],
    ["TreeMap's own MIT licence", own, /Electron/],
    ["another holder's MIT licence, opening with its copyright line", Buffer.from(own.toString('utf8').replace(/^MIT License\s+/, '')), /Electron's copyright/],
    ["Electron's copyright lines over another licence", Buffer.from('Copyright (c) Electron contributors\n\nLicensed under the Apache License, Version 2.0\n'), /MIT grant/],
    ['the MIT grant without its disclaimer', Buffer.from(electronLicence().toString('utf8').replace(/THE SOFTWARE IS PROVIDED[\s\S]*$/, '')), /AS IS/],
    ["Chromium's credits page", chromiumCredits(), /Copyright|Electron/],
  ];
  for (const [label, bytes, reason] of refusals) {
    const r = lic.checkLicenceText(bytes);
    assert.ok(r !== null, `${label}: refused`);
    assert.match(r, reason, `${label}: ${r}`);
  }
});

test("checkCreditsHtml accepts Chromium's credits page and refuses a cut-off, mistitled or foreign one", () => {
  assert.ok(lic.MIN_CREDITED_PRODUCTS >= 100, `a page credits at least ${lic.MIN_CREDITED_PRODUCTS} products (Electron 31.7.7's lists 410)`);
  assert.equal(lic.checkCreditsHtml(chromiumCredits(lic.MIN_CREDITED_PRODUCTS)), null, 'exactly the floor passes');
  assert.equal(lic.checkCreditsHtml(Buffer.concat([BOM, chromiumCredits()])), null, 'a byte-order mark is not part of the page');
  const page = chromiumCredits().toString('utf8');
  const refusals: [string, Buffer, RegExp][] = [
    ['a page cut off one product short', chromiumCredits(lic.MIN_CREDITED_PRODUCTS - 1), new RegExp(`${lic.MIN_CREDITED_PRODUCTS - 1}\\b.*${lic.MIN_CREDITED_PRODUCTS}|${lic.MIN_CREDITED_PRODUCTS}\\b.*${lic.MIN_CREDITED_PRODUCTS - 1}`)],
    ['a page licenses.py did not generate', Buffer.from(page.replace('<!-- Generated by licenses.py; do not edit. -->', '')), /licenses\.py/],
    ['a page titled otherwise', Buffer.from(page.replace('<title>Credits</title>', '<title>About</title>')), /Credits/],
    ["Electron's licence", electronLicence(), /licenses\.py/],
    ['an empty file', Buffer.alloc(0), /licenses\.py|empty/],
  ];
  for (const [label, bytes, reason] of refusals) {
    const r = lic.checkCreditsHtml(bytes);
    assert.ok(r !== null, `${label}: refused`);
    assert.match(r, reason, `${label}: ${r}`);
  }
});

test("bundledElectronVersion reads the bundle's own Electron Framework version, and says where it looked when it cannot", () => {
  const { app } = macAppLayout(fileTempDir('treemap-eversion-'), 'TreeMap', VERSION);
  assert.equal(lic.bundledElectronVersion(app), VERSION);

  const bare = path.join(fileTempDir('treemap-eversion-bare-'), 'TreeMap.app');
  fs.mkdirSync(bare);
  assert.throws(() => lic.bundledElectronVersion(bare), (err: Error) => err.message.includes(frameworkPlistPath(bare)), 'no plist: the path it read is named');

  const { app: blank } = macAppLayout(fileTempDir('treemap-eversion-blank-'), 'TreeMap', VERSION);
  fs.writeFileSync(frameworkPlistPath(blank), '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>');
  assert.throws(() => lic.bundledElectronVersion(blank), (err: Error) => err.message.includes(frameworkPlistPath(blank)) && /CFBundleVersion/.test(err.message));
});

test("licenceSource is where electron-builder took Electron from: electronDist's zip, electronDist's folder, or the verified zip @electron/get keeps", async () => {
  const asked: Download[] = [];
  const downloadZip = async (o: Download) => {
    asked.push(o);
    return '/cache/electron-v31.7.7-darwin-arm64.zip';
  };
  const project = fileTempDir('treemap-esource-');
  const base = { projectDir: project, version: VERSION, platform: 'darwin', arch: 'arm64' };

  assert.deepEqual(await lic.licenceSource({ ...base, config: {} }, { downloadZip }), { kind: 'zip', path: '/cache/electron-v31.7.7-darwin-arm64.zip' });
  assert.deepEqual(asked, [{ version: VERSION, platform: 'darwin', arch: 'arm64' }], 'no electronDist: the zip for this version, platform and architecture, asked for once');

  const withZip = path.join(project, 'with-zip');
  fs.mkdirSync(withZip);
  const zip = path.join(withZip, lic.electronZipName(VERSION, 'darwin', 'arm64'));
  assert.equal(path.basename(zip), 'electron-v31.7.7-darwin-arm64.zip', "the name electron-builder's unpack looks for");
  fs.writeFileSync(zip, 'zip');
  assert.deepEqual(await lic.licenceSource({ ...base, config: { electronDist: withZip } }, { downloadZip }), { kind: 'zip', path: zip },
    'electronDist holding the zip: electron-builder unpacked that zip, so its licences are read from it');

  const unpacked = path.join(project, 'unpacked');
  fs.mkdirSync(unpacked);
  assert.deepEqual(await lic.licenceSource({ ...base, config: { electronDist: unpacked } }, { downloadZip }), { kind: 'dir', path: unpacked },
    'electronDist without it: electron-builder copied Electron.app from that folder, which holds the licences beside it');
  assert.deepEqual(await lic.licenceSource({ ...base, config: { electronDist: 'unpacked' } }, { downloadZip }), { kind: 'dir', path: unpacked },
    'a relative electronDist is read from the project folder, as electron-builder reads it');
  assert.equal(asked.length, 1, 'an electronDist is never second-guessed with a download');

  await assert.rejects(lic.licenceSource({ ...base, config: { electronDist: () => unpacked } }, { downloadZip }), /electronDist.*function/);
  await assert.rejects(lic.licenceSource({ ...base, config: { electronDownload: { mirror: 'https://example.invalid/' } } }, { downloadZip }), /electronDownload/,
    'a download setting this step does not follow is refused, not ignored');
  assert.equal(asked.length, 1);
});

test('readLicences reads exactly LICENSE, LICENSES.chromium.html and version — from a zip by entry, from a folder by file — and names what is missing', () => {
  const entries = electronZipEntries(VERSION);
  const zip = '/cache/electron.zip';
  const reader = fakeZip(zip, entries);
  const read = lic.readLicences({ kind: 'zip', path: zip }, reader);
  assert.deepEqual(reader.reads.sort(), ['LICENSE', 'LICENSES.chromium.html', 'version']);
  assert.ok(read.licence.equals(entries.LICENSE) && read.credits.equals(entries['LICENSES.chromium.html']) && read.version.equals(entries.version));

  const { LICENSE: _gone, ...noLicence } = entries;
  void _gone;
  assert.throws(() => lic.readLicences({ kind: 'zip', path: zip }, fakeZip(zip, noLicence)), (err: Error) => err.message.includes(zip) && err.message.includes('LICENSE'));

  const dir = fileTempDir('treemap-edir-');
  for (const [name, bytes] of Object.entries(entries)) fs.writeFileSync(path.join(dir, name), bytes);
  const fromDir = lic.readLicences({ kind: 'dir', path: dir }, { readZipEntry: () => assert.fail('a folder is read as files') });
  assert.ok(fromDir.credits.equals(entries['LICENSES.chromium.html']));
  fs.rmSync(path.join(dir, 'LICENSES.chromium.html'));
  assert.throws(() => lic.readLicences({ kind: 'dir', path: dir }, { readZipEntry: () => Buffer.alloc(0) }), (err: Error) => err.message.includes(path.join(dir, 'LICENSES.chromium.html')));
});

test("the default zip reader returns an entry larger than execFileSync's 1 MiB default buffer, byte for byte, and names an entry the zip lacks", (t) => {
  const hasUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf8', timeout: HANG_GUARD_MS }).status === 0;
  if (!hasUnzip) {
    // afterPack reads the zip only when it packages macOS, which only a Mac can, and every Mac has /usr/bin/unzip.
    assert.notEqual(process.platform, 'darwin', 'unzip ships with macOS');
    t.skip(`no unzip on ${process.platform}; the reader runs only where macOS apps are packaged`);
    return;
  }
  const credits = Buffer.concat([chromiumCredits(), Buffer.alloc(3 * 1024 * 1024, 'credits ')]);
  const zip = path.join(fileTempDir('treemap-ezip-'), 'electron-v31.7.7-darwin-arm64.zip');
  fs.writeFileSync(zip, storedZip([{ name: 'LICENSE', data: electronLicence() }, { name: 'LICENSES.chromium.html', data: credits }, { name: 'version', data: Buffer.from(VERSION) }]));
  assert.ok(lic.readZipEntry(zip, 'LICENSES.chromium.html').equals(credits), 'a 3 MiB entry comes back whole (Electron 31.7.7 ships 9.5 MB)');
  assert.ok(lic.readZipEntry(zip, 'LICENSE').equals(electronLicence()));
  assert.equal(lic.readZipEntry(zip, 'version').toString('utf8'), VERSION);
  assert.throws(() => lic.readZipEntry(zip, 'NOTICE'), (err: Error) => err.message.includes('NOTICE') && err.message.includes(zip));
});

test('the default downloader refuses under a test runner before it looks anything up, so a forgotten stand-in can never fetch Electron in CI', async () => {
  await assert.rejects(lic.downloadElectronZip({ version: '0.0.0', platform: 'darwin', arch: 'arm64' }),
    (err: Error) => /test runner/.test(err.message) && /downloadZip/.test(err.message));
});

test("placeElectronLicences puts Electron's two files in the bundle's Resources, byte for byte as the zip holds them", async () => {
  const out = fileTempDir('treemap-eplace-');
  const { resources } = macAppLayout(out, 'TreeMap', VERSION);
  const entries = electronZipEntries(VERSION);
  const zip = '/cache/electron-v31.7.7-darwin-arm64.zip';
  const asked: Download[] = [];
  const reader = fakeZip(zip, entries);
  const summary = await lic.placeElectronLicences(placeOptions(out), {
    downloadZip: async (o) => {
      asked.push(o);
      return zip;
    },
    readZipEntry: reader.readZipEntry,
  });
  assert.deepEqual(asked, [{ version: VERSION, platform: 'darwin', arch: 'arm64' }], 'the zip of the Electron electron-builder packaged');
  assert.equal(lic.LICENCE_FILE, 'LICENSE.electron.txt', 'the name electron-builder gives it beside the Windows and Linux executables');
  assert.equal(lic.CREDITS_FILE, 'LICENSES.chromium.html');
  assert.ok(fs.readFileSync(path.join(resources, lic.LICENCE_FILE)).equals(entries.LICENSE), 'LICENSE.electron.txt is the zip\'s LICENSE');
  assert.ok(fs.readFileSync(path.join(resources, lic.CREDITS_FILE)).equals(entries['LICENSES.chromium.html']), 'LICENSES.chromium.html is the zip\'s');
  assert.match(summary, new RegExp(VERSION.replace(/\./g, '\\.')));
  assert.ok(summary.includes(zip), `the summary names the zip: ${summary}`);
});

test("placeElectronLicences writes nothing, and says why, when the zip is another Electron's, or what it holds is not Electron's and Chromium's licences", async () => {
  const zip = '/cache/electron.zip';
  const cases: [string, Partial<Record<string, Buffer>>, RegExp][] = [
    ["another Electron's zip", { version: Buffer.from('31.7.6') }, /31\.7\.6[\s\S]*31\.7\.7|31\.7\.7[\s\S]*31\.7\.6/],
    ["TreeMap's licence where Electron's belongs", { LICENSE: fs.readFileSync(path.join(__dirname, '..', 'LICENSE')) }, /Electron/],
    ['a credits page cut off', { 'LICENSES.chromium.html': chromiumCredits(3) }, /product/],
  ];
  for (const [label, swap, reason] of cases) {
    const out = fileTempDir('treemap-eplace-bad-');
    const { resources } = macAppLayout(out, 'TreeMap', VERSION);
    const entries = { ...electronZipEntries(VERSION), ...swap } as Record<string, Buffer>;
    await assert.rejects(
      lic.placeElectronLicences(placeOptions(out), { downloadZip: async () => zip, readZipEntry: fakeZip(zip, entries).readZipEntry }),
      (err: Error) => reason.test(err.message) && err.message.includes(resources),
      label,
    );
    assert.deepEqual(fs.readdirSync(resources), [], `${label}: nothing is written`);
  }
  const out = fileTempDir('treemap-eplace-nolicence-');
  const { resources } = macAppLayout(out, 'TreeMap', VERSION);
  const { LICENSE: _gone, ...noLicence } = electronZipEntries(VERSION);
  void _gone;
  await assert.rejects(lic.placeElectronLicences(placeOptions(out), { downloadZip: async () => zip, readZipEntry: fakeZip(zip, noLicence).readZipEntry }),
    (err: Error) => err.message.includes('LICENSE') && err.message.includes(zip));
  assert.deepEqual(fs.readdirSync(resources), [], 'a zip without LICENSE: nothing is written');
});

test('assertElectronLicences: inside the bundle on macOS, beside the executable on Windows and Linux, under the names electron-builder gives them there', () => {
  const mac = fileTempDir('treemap-eassert-mac-');
  const { resources } = macAppLayout(mac, 'TreeMap', VERSION);
  assert.throws(() => lic.assertElectronLicences({ platform: 'darwin', appOutDir: mac, productFilename: 'TreeMap' }),
    (err: Error) => err.message.includes(path.join(resources, 'LICENSE.electron.txt')) && err.message.includes(path.join(resources, 'LICENSES.chromium.html')),
    'a macOS app without them: both paths are named');
  fs.writeFileSync(path.join(resources, 'LICENSE.electron.txt'), electronLicence());
  fs.writeFileSync(path.join(resources, 'LICENSES.chromium.html'), chromiumCredits());
  assert.match(lic.assertElectronLicences({ platform: 'darwin', appOutDir: mac, productFilename: 'TreeMap' }), /LICENSE\.electron\.txt/);

  for (const platform of ['win32', 'linux']) {
    const out = fileTempDir(`treemap-eassert-${platform}-`);
    fs.writeFileSync(path.join(out, 'LICENSE'), electronLicence());
    fs.writeFileSync(path.join(out, 'LICENSES.chromium.html'), chromiumCredits());
    assert.throws(() => lic.assertElectronLicences({ platform, appOutDir: out, productFilename: 'TreeMap' }),
      (err: Error) => err.message.includes(path.join(out, 'LICENSE.electron.txt')),
      `${platform}: electron-builder renames LICENSE to LICENSE.electron.txt there, so a bare LICENSE is not it`);
    fs.renameSync(path.join(out, 'LICENSE'), path.join(out, 'LICENSE.electron.txt'));
    assert.match(lic.assertElectronLicences({ platform, appOutDir: out, productFilename: 'TreeMap' }), /LICENSES\.chromium\.html/);
    fs.writeFileSync(path.join(out, 'LICENSES.chromium.html'), chromiumCredits(2));
    assert.throws(() => lic.assertElectronLicences({ platform, appOutDir: out, productFilename: 'TreeMap' }), /product/, `${platform}: the content is checked, not only the name`);
  }
});
