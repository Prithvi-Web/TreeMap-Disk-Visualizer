import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { skipOrFailOnCi } from './fixtures/ciSkip';
isolatedDataDir('treemap-gduNotices-data-');

/**
 * gdu's third-party notices (v5.2.0). The gdu binary TreeMap bundles
 * (build/gdu/<platform>-<arch>/gdu, fetched by scripts/fetchGdu.js) is one
 * static Go program per platform: gdu's own code, MIT, whose LICENSE.md
 * already shipped, plus some forty Go modules and the Go standard library,
 * linked in — and their licences did not ship. scripts/gdu-notices.js reads
 * the module list each binary records in its Go build information, fetches
 * each module's source at that version from proxy.golang.org (checked
 * against gdu's go.sum), and writes every licence file it carries into
 * build/gdu/THIRD_PARTY_NOTICES.txt, which electron-builder ships beside
 * gdu's LICENSE.md; the module list itself goes into build/gdu/gdu-modules.json.
 *
 * The generator needs the network. This file never does: the first group
 * holds the committed files to scripts/fetchGdu.js's pinned version and to
 * each other, offline, on every CI leg, and holds the gdu binary staged on
 * the machine (CI fetches the host's one before the suite) to the record.
 */

const REPO = path.join(__dirname, '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const sha256hex = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

interface LicenceText { title: string; text: string }
interface ModuleSum { path: string; version: string; sum: string }
interface Dep { path: string; version: string; sum: string; replace: { path: string; version: string; sum: string } | null }
interface BuildInfo { goVersion: string; path: string; main: { path: string; version: string; sum: string }; deps: Dep[]; settings: { key: string; value: string }[] }
interface ZipEntry { name: string; method: number; flags: number; compressedSize: number; size: number; offset: number }
interface GduRecord {
  about: string;
  gdu: { module: string; version: string };
  go: string;
  binaries: Record<string, { file: string; sha256: string; modules: string[] }>;
  modules: ModuleSum[];
}
interface Pin { version: string; targets: Record<string, string> }
interface ModelModule { path: string; version: string; sum: string; platforms: string[]; licence: string; notes: string[]; texts: LicenceText[] }
interface Model {
  gdu: { module: string; version: string };
  go: { version: string; licence: string; texts: LicenceText[] };
  binaries: { target: string; file: string; sha256: string }[];
  modules: ModelModule[];
}
interface Parsed {
  gdu: { module: string; version: string; go: string } | null;
  go: string | null;
  goLicence: string | null;
  goTexts: string[];
  binaries: { target: string; file: string; sha256: string }[];
  modules: { path: string; version: string; platforms: string[]; licence: string; sum: string; texts: string[] }[];
}
interface Reviewed { module: string; file: string; sha256: string; why: string }
interface FakeResponse { status: number; ok: boolean; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }
interface Classified { title: string; text: string; ids: string[]; note: string | null }
interface MainDeps {
  repo: string;
  pin: Pin;
  readBinary(target: string): Buffer;
  fetch(url: string): Promise<Buffer>;
  cacheDir: string | null;
  out(line: string): void;
  err(line: string): void;
}
interface GduNotices {
  NOTICES_PATH: string;
  MODULES_PATH: string;
  GDU_LICENCE_PATH: string;
  GDU_MODULE: string;
  GENERATOR_FILES: string[];
  REVIEWED: Reviewed[];
  binaryName(target: string): string;
  escapeModulePath(s: string): string;
  proxyZipUrl(modulePath: string, version: string): string;
  goSourceUrl(goVersion: string, file: string): string;
  allowedUrl(url: string): boolean;
  getAllowed(url: string, get: (url: string, init: { redirect: string }) => Promise<FakeResponse>): Promise<Buffer>;
  networkFetch(url: string): Promise<Buffer>;
  readBuildInfo(bytes: Buffer): BuildInfo;
  zipEntries(zip: Buffer): ZipEntry[];
  zipEntryData(zip: Buffer, entry: ZipEntry): Buffer;
  hashZip(zip: Buffer): string;
  licenceFiles(names: string[], prefix: string): string[];
  identifyLicences(text: string): string[];
  classifyLicenceFile(o: { module: string; file: string; bytes: Buffer }, reviewed?: Reviewed[]): Classified;
  renderNotices(model: Model): string;
  parseNotices(text: string): Parsed;
  driftProblems(record: GduRecord, notices: string, advice?: string): string[];
  pinProblems(record: GduRecord, pin: Pin): string[];
  binaryProblems(record: GduRecord, target: string, bytes: Buffer): string[];
  licenceProblems(notices: string): string[];
  stagedBinaries(repo: string, pin: Pin, host?: { platform: string; arch: string }): { target: string; file: string }[];
  packagedProblems(resourcesDir: string): string[];
  generatorDigest(read?: (relativePath: string) => string): string;
  sealNotices(body: string, generator: string): string;
  sealProblems(notices: string, generator: string | null): string[];
  main(argv: string[], deps: MainDeps): Promise<number>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gn = require('../scripts/gdu-notices.js') as GduNotices;

/**
 * scripts/fetchGdu.js's pin, read in a child whose fetch is stubbed out:
 * requiring the script must start no download, and were it ever to, nothing
 * would leave the machine and this process would not be ended by its
 * process.exit. What the child printed besides the pin is kept for the test
 * that holds it to that.
 */
function fetchGduInChild(): { pin: Pin; noise: string } {
  const stub = path.join(fileTempDir('treemap-gdu-fetch-stub-'), 'stub.cjs');
  fs.writeFileSync(stub, "globalThis.fetch = async (url) => { process.stderr.write(`FETCHED ${url}\\n`); throw new Error('no network in this test'); };\n");
  const script = "const f = require('./scripts/fetchGdu.js'); process.stdout.write(`PIN ${JSON.stringify({ version: f.VERSION, targets: f.TARGETS })}\\n`);";
  const child = spawnSync(process.execPath, ['-r', stub, '-e', script], { cwd: REPO, encoding: 'utf8', env: { ...process.env } });
  const line = /^PIN (.*)$/m.exec(child.stdout);
  assert.ok(line, `scripts/fetchGdu.js could not be required: ${child.status} ${child.stdout}${child.stderr}`);
  return { pin: JSON.parse(line[1]) as Pin, noise: `${child.stdout.replace(line[0], '')}${child.stderr}`.trim() };
}

const FETCH_GDU = fetchGduInChild();
const PIN: Pin = FETCH_GDU.pin;
const REGENERATE = /node scripts\/gdu-notices\.js/;
const realDigest = (): string => gn.generatorDigest((rel) => read(rel));
const readRecord = (): GduRecord => JSON.parse(read(...gn.MODULES_PATH.split('/'))) as GduRecord;

/* ═══════════════════ the committed files (offline, every CI leg) ═══════════════════ */

test('build/gdu/gdu-modules.json was read from the gdu version and the platforms scripts/fetchGdu.js pins', () => {
  const problems = gn.pinProblems(readRecord(), PIN);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('build/gdu/THIRD_PARTY_NOTICES.txt accounts for every module in gdu-modules.json, at its version, on the platforms that link it, with the Go that built them', () => {
  const problems = gn.driftProblems(readRecord(), read(...gn.NOTICES_PATH.split('/')));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('build/gdu/THIRD_PARTY_NOTICES.txt is what the generator, as it is now, wrote: its seal matches the generator\'s source and its own text', () => {
  const problems = gn.sealProblems(read(...gn.NOTICES_PATH.split('/')), realDigest());
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every module any shipped binary links has its own entry with at least one licence text, counted independently of the parser', () => {
  const record = readRecord();
  const notices = read(...gn.NOTICES_PATH.split('/'));
  const linked = new Set(Object.values(record.binaries).flatMap((b) => b.modules));
  const headers = notices.match(/^={72}\nModule: \S+ \S+$/gm) ?? [];
  assert.ok(linked.size >= 30, `the binaries link gdu's modules (${linked.size})`);
  assert.equal(headers.length, linked.size, `one "Module:" entry per module the binaries link (${linked.size})`);
  assert.deepEqual(record.modules.map((m) => `${m.path} ${m.version}`).sort(), [...linked].sort(), 'and gdu-modules.json has a checksum for each');
  for (const m of record.modules) assert.match(m.sum, /^h1:[A-Za-z0-9+/]{43}=$/, `${m.path} ${m.version} has the go.sum hash its source was checked against`);
  const parsed = gn.parseNotices(notices);
  for (const m of parsed.modules) {
    assert.ok(m.texts.length >= 1, `${m.path} ${m.version} carries a licence text`);
    assert.notEqual(m.licence, '', `${m.path} ${m.version} names its licence`);
    assert.ok(!m.texts.some((t) => /(^|\/)testdata\//.test(t)), `${m.path}: nothing from testdata/, which Go never compiles`);
  }
  assert.equal(parsed.go, record.go);
  assert.deepEqual(parsed.goTexts, ['LICENSE', 'PATENTS'], 'the Go standard library has its entry, with its licence and patent grant');
});

test('every licence in the committed file can be met on permissive terms — copyleft, file-level copyleft (MPL) or an unknown licence is a person\'s decision, never a silent one', () => {
  const problems = gn.licenceProblems(read(...gn.NOTICES_PATH.split('/')));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the app carries the notices in its resources, beside gdu\'s LICENSE.md, on every platform', () => {
  const pkg = JSON.parse(read('package.json')) as { build: { extraResources: { from: string; to: string }[] } };
  const extra = pkg.build.extraResources;
  assert.equal(gn.NOTICES_PATH, 'build/gdu/THIRD_PARTY_NOTICES.txt');
  const notices = extra.find((e) => e.from === gn.NOTICES_PATH);
  assert.ok(notices, `build.extraResources ships ${gn.NOTICES_PATH}: ${JSON.stringify(extra)}`);
  assert.equal(notices.to, 'gdu/THIRD_PARTY_NOTICES.txt', 'beside gdu and its LICENSE.md, in the resources folder');
  assert.ok(extra.some((e) => e.from === gn.GDU_LICENCE_PATH && e.to === 'gdu/LICENSE.md'), 'gdu\'s own licence still ships');
  for (const rel of [gn.NOTICES_PATH, gn.MODULES_PATH, gn.GDU_LICENCE_PATH]) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} is committed, so a dist never packages without it`);
  }
  const ignore = read('.gitignore');
  assert.doesNotMatch(ignore, /^\/build\/gdu\/$/m, 'the folder is not ignored whole, or a new notices file could never be added');
  for (const rel of [gn.NOTICES_PATH, gn.MODULES_PATH, gn.GDU_LICENCE_PATH]) assert.match(ignore, new RegExp(`^!/${rel.replace(/[.]/g, '\\.')}$`, 'm'), `${rel} is kept`);
});

test('the gdu binaries staged on this machine are the very ones gdu-modules.json was read from', (t) => {
  const record = readRecord();
  const staged = gn.stagedBinaries(REPO, PIN);
  if (staged.length === 0) {
    skipOrFailOnCi(t, 'no gdu binary is staged here: node scripts/fetchGdu.js --dev (or --all) stages one');
    return;
  }
  for (const b of staged) {
    const problems = gn.binaryProblems(record, b.target, fs.readFileSync(b.file));
    assert.deepEqual(problems, [], `${b.file}:\n${problems.join('\n')}`);
  }
});

test('scripts/fetchGdu.js names its pin for the notices to check, and requiring it starts no download', () => {
  assert.match(PIN.version, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(PIN.targets).sort(), ['linux-arm64', 'linux-x64', 'mac-arm64', 'mac-x64', 'win-x64']);
  assert.equal(FETCH_GDU.noise, '', `requiring it ran its download: ${FETCH_GDU.noise}`);
});

/* ═══════════════════ fixtures: licence texts, Go binaries, module zips ═══════════════════ */

const MIT = [
  'MIT License', '', 'Copyright (c) 2020 The Alpha Authors', '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction.', '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.', '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.', '',
].join('\n');
const BSD2 = [
  'Copyright (c) 2015 The Beta Authors. All rights reserved.', '',
  'Redistribution and use in source and binary forms, with or without',
  'modification, are permitted provided that the following conditions are met:', '',
  '1. Redistributions of source code must retain the above copyright notice.',
  '2. Redistributions in binary form must reproduce the above copyright notice.', '',
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS".', '',
].join('\n');
const BSD3 = BSD2.replace('copyright notice.\n\n', 'copyright notice.\n3. Neither the name of the copyright holder nor the names of its contributors\nmay be used to endorse or promote products derived from this software\nwithout specific prior written permission.\n\n');
const BSD4 = BSD3.replace('3. Neither', '3. All advertising materials mentioning features or use of this software\nmust display an acknowledgement.\n4. Neither');
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n';
const APACHE_HEADER = 'Copyright 2011-2016 Canonical Ltd.\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.\n';
const ISC = 'Copyright (c) 2020 Gamma\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n';
const GPL = '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n';
const LGPL = '                  GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999\n';
const AGPL = '                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007\n';
const MPL = 'Mozilla Public License Version 2.0\n==================================\n';
const EPL = 'Eclipse Public License - v 2.0\n';
const PATENTS = 'Additional IP Rights Grant (Patents)\n\n"This implementation" means the copyrightable works distributed by\nGoogle as part of the Go project.\n';
const GO_LICENSE = BSD3.replace('The Beta Authors. All rights reserved.', 'The Go Authors.');
const GDU_LICENCE = MIT.replace('The Alpha Authors', 'Daniel Milde');

const MAGIC = Buffer.concat([Buffer.from([0xff]), Buffer.from(' Go buildinf:', 'latin1')]);
const SENTINEL_START = Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex');
const SENTINEL_END = Buffer.from('f932433186182072008242104116d8f2', 'hex');

function uvarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}
const goString = (b: Buffer): Buffer => Buffer.concat([uvarint(b.length), b]);

/** The text a Go binary records after its sentinels, as `go version -m` prints it. */
function modinfoOf(main: [string, string], deps: [string, string, string][], extra: string[] = []): string {
  return `${[
    `path\t${main[0]}/cmd/gdu`, `mod\t${main[0]}\t${main[1]}\t`,
    ...deps.map(([p, v, s]) => `dep\t${p}\t${v}\t${s}`), ...extra,
    'build\t-buildmode=exe', 'build\tCGO_ENABLED=0', 'build\tGOOS=linux',
  ].join('\n')}\n`;
}

/** Bytes laid out as a Go 1.18+ binary lays out its build information, between some code; `decoy` puts the magic in the code first. */
function goBinary(goVersion: string, modinfo: string, { flags = 2, decoy = false } = {}): Buffer {
  const header = Buffer.alloc(32);
  MAGIC.copy(header, 0);
  header[14] = 8;
  header[15] = flags;
  const parts: Buffer[] = [Buffer.from('\x7fELF not really a program\n'), Buffer.alloc(13, 0x90)];
  if (decoy) parts.push(MAGIC, Buffer.from([8, 0]), Buffer.alloc(40, 0xee));
  parts.push(header, goString(Buffer.from(goVersion)), goString(Buffer.concat([SENTINEL_START, Buffer.from(modinfo), SENTINEL_END])), Buffer.alloc(64, 0));
  return Buffer.concat(parts);
}

/** A zip archive as Go's module zips are made: one entry per file, deflated (or stored), no directories. */
function zipOf(files: Record<string, string | Buffer>, { method = 8, flags = 0 } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** golang.org/x/mod/sumdb/dirhash Hash1, computed here independently: sha256 over "<sha256 hex>  <name>\n" for every file in name order, base64. */
function goH1(files: Record<string, string | Buffer>): string {
  const summary = Object.keys(files).sort().map((name) => `${sha256hex(files[name])}  ${name}\n`).join('');
  return `h1:${crypto.createHash('sha256').update(summary).digest('base64')}`;
}

/* ═══════════════════ reading a Go binary's build information ═══════════════════ */

test('readBuildInfo reads the Go version, the main module and every dependency — with or without its go.sum hash — as `go version -m` does', () => {
  const info = gn.readBuildInfo(goBinary('go1.26.2', modinfoOf(['github.com/dundee/gdu/v5', 'v5.36.1'], [
    ['example.com/alpha', 'v1.0.0', 'h1:aaaa='], ['example.com/beta/v2', 'v2.1.0+incompatible', ''],
  ])));
  assert.equal(info.goVersion, 'go1.26.2');
  assert.equal(info.path, 'github.com/dundee/gdu/v5/cmd/gdu');
  assert.deepEqual(info.main, { path: 'github.com/dundee/gdu/v5', version: 'v5.36.1', sum: '' });
  assert.deepEqual(info.deps, [
    { path: 'example.com/alpha', version: 'v1.0.0', sum: 'h1:aaaa=', replace: null },
    { path: 'example.com/beta/v2', version: 'v2.1.0+incompatible', sum: '', replace: null },
  ]);
  assert.deepEqual(info.settings.find((s) => s.key === 'CGO_ENABLED'), { key: 'CGO_ENABLED', value: '0' });
});

test('readBuildInfo looks past the magic where it is not followed by build information, and reads a replacement onto the module it replaces', () => {
  const info = gn.readBuildInfo(goBinary('go1.26.2', modinfoOf(['m', 'v1.0.0'], [['example.com/a', 'v1.0.0', '']], ['=>\texample.com/fork\tv1.0.1\th1:ffff=']), { decoy: true }));
  assert.deepEqual(info.deps, [{ path: 'example.com/a', version: 'v1.0.0', sum: '', replace: { path: 'example.com/fork', version: 'v1.0.1', sum: 'h1:ffff=' } }]);
});

test('readBuildInfo refuses, by name, bytes that are no Go 1.18+ program with modules', () => {
  assert.throws(() => gn.readBuildInfo(Buffer.from('#!/bin/sh\necho not go\n')), /no Go build information/);
  assert.throws(() => gn.readBuildInfo(goBinary('go1.17', modinfoOf(['m', 'v1.0.0'], []), { flags: 0 })), /Go 1\.18/, 'the older pointer layout needs the program\'s memory map; it is named, never guessed at');
  const whole = goBinary('go1.26.2', modinfoOf(['m', 'v1.0.0'], []));
  assert.throws(() => gn.readBuildInfo(whole.subarray(0, whole.indexOf(SENTINEL_START) + 4)), /no Go build information/, 'a truncated file');
  assert.throws(() => gn.readBuildInfo(goBinary('go1.26.2', '')), /records no modules/);
  assert.throws(() => gn.readBuildInfo(goBinary('go1.26.2', '=>\texample.com/x\tv1.0.0\t\n')), /replacement/);
  assert.throws(() => gn.readBuildInfo(goBinary('go1.26.2', modinfoOf(['m', 'v1.0.0'], [['example.com/a', '', '']]).replace('dep\texample.com/a\t\t', 'dep\texample.com/a'))), /dep/);
});

/* ═══════════════════ module zips and their go.sum hash ═══════════════════ */

test('hashZip is Go\'s h1 (dirhash Hash1) of a module zip, whatever order the zip holds its files in, stored or deflated', () => {
  const files = { 'example.com/a@v1.0.0/go.mod': 'module example.com/a\n', 'example.com/a@v1.0.0/LICENSE': MIT, 'example.com/a@v1.0.0/a.go': 'package a\n' };
  const expected = goH1(files);
  assert.equal(gn.hashZip(zipOf(files)), expected);
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  assert.equal(gn.hashZip(zipOf(reversed, { method: 0 })), expected, 'the order of the entries and their compression do not change it');
  assert.notEqual(gn.hashZip(zipOf({ ...files, 'example.com/a@v1.0.0/a.go': 'package b\n' })), expected, 'one changed byte does');
  const zip = zipOf(files);
  const entries = gn.zipEntries(zip);
  assert.deepEqual(entries.map((e) => e.name), Object.keys(files));
  assert.equal(gn.zipEntryData(zip, entries[1]).toString('utf8'), MIT);
});

test('the zip reader refuses what it cannot read faithfully, by name', () => {
  assert.throws(() => gn.zipEntries(Buffer.from('not a zip at all, just some bytes that go on for a while')), /not a zip/);
  const encrypted = zipOf({ 'a@v1/LICENSE': MIT }, { flags: 1 });
  assert.throws(() => gn.zipEntryData(encrypted, gn.zipEntries(encrypted)[0]), /encrypted/);
  const bzip2 = zipOf({ 'a@v1/LICENSE': MIT }, { method: 12 });
  assert.throws(() => gn.zipEntryData(bzip2, gn.zipEntries(bzip2)[0]), /compression method 12/);
  const big = zipOf({ 'a@v1/LICENSE': MIT });
  big.writeUInt32LE(0xffffffff, big.length - 6);
  assert.throws(() => gn.zipEntries(big), /zip64/);
  assert.throws(() => gn.hashZip(zipOf({ 'a@v1/bad\nname': 'x' })), /newline/, 'Go refuses such a name, so the hash would be no hash Go computes');
});

test('module paths reach proxy.golang.org case-encoded, and nothing outside it and the Go source is ever fetched', () => {
  assert.equal(gn.escapeModulePath('github.com/BurntSushi/toml'), 'github.com/!burnt!sushi/toml');
  assert.equal(gn.proxyZipUrl('github.com/BurntSushi/toml', 'v1.2.1'), 'https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.2.1.zip');
  assert.equal(gn.goSourceUrl('go1.26.2', 'LICENSE'), 'https://go.googlesource.com/go/+/refs/tags/go1.26.2/LICENSE?format=TEXT');
  for (const ok of [gn.proxyZipUrl('example.com/a', 'v1.0.0'), gn.goSourceUrl('go1.26.2', 'PATENTS')]) assert.equal(gn.allowedUrl(ok), true, ok);
  for (const no of ['https://proxy.golang.org/example.com/a/@v/list', 'https://example.com/proxy.golang.org/x.zip', 'http://proxy.golang.org/a/@v/v1.zip',
    'https://go.googlesource.com/go/+/refs/heads/master/LICENSE?format=TEXT', 'https://raw.githubusercontent.com/dundee/gdu/v5.36.1/LICENSE.md']) {
    assert.equal(gn.allowedUrl(no), false, no);
  }
});

test('getAllowed follows only the one redirect the proxy makes, to its own storage, and names any other answer', async () => {
  const STORAGE = 'https://storage.googleapis.com/proxy-golang-org-prod/abc-example.com:a-v1.0.0.zip?Expires=1&Signature=x';
  const answer = (status: number, location: string | null = null, body = ''): FakeResponse => ({
    status, ok: status >= 200 && status < 300, headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
    arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer,
  });
  const asked: [string, string][] = [];
  const serve = (routes: Record<string, FakeResponse>) => async (url: string, init: { redirect: string }) => {
    asked.push([url, init.redirect]);
    const r = routes[url];
    if (!r) throw new Error(`unexpected request ${url}`);
    return r;
  };
  const zip = gn.proxyZipUrl('example.com/a', 'v1.0.0');
  assert.equal((await gn.getAllowed(zip, serve({ [zip]: answer(200, null, 'small zip') }))).toString(), 'small zip');
  assert.deepEqual(asked.splice(0), [[zip, 'manual']], 'one GET, redirects left to the caller');
  assert.equal((await gn.getAllowed(zip, serve({ [zip]: answer(302, STORAGE), [STORAGE]: answer(200, null, 'large zip') }))).toString(), 'large zip');
  assert.deepEqual(asked.splice(0), [[zip, 'manual'], [STORAGE, 'error']], 'the proxy\'s own storage, once, and no further redirect from there');
  await assert.rejects(gn.getAllowed(zip, serve({ [zip]: answer(302, 'https://example.com/elsewhere.zip') })), /redirected to https:\/\/example\.com\/elsewhere\.zip, which is not the proxy's own storage/, 'a redirect anywhere else is refused, by address');
  await assert.rejects(gn.getAllowed(zip, serve({ [zip]: answer(302, 'http://storage.googleapis.com/proxy-golang-org-prod/x.zip') })), /redirected to http:\/\/storage\S+, which is not the proxy's own storage/, 'and so is one off https');
  const go = gn.goSourceUrl('go1.26.2', 'LICENSE');
  await assert.rejects(gn.getAllowed(go, serve({ [go]: answer(302, STORAGE) })), /googlesource\S+ redirected to/, 'the Go source is never redirected to the proxy\'s storage');
  await assert.rejects(gn.getAllowed(zip, serve({ [zip]: answer(404) })), new RegExp(`${zip.replace(/[.+?/]/g, '\\$&')}.*404`), 'a failed answer names the address and the status');
  await assert.rejects(gn.getAllowed(zip, async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND proxy.golang.org') }); }),
    /proxy\.golang\.org\/example\.com\/a\/@v\/v1\.0\.0\.zip.*ENOTFOUND/, 'a failed request names the address and why, not only "fetch failed"');
});

test('networkFetch, the only door to the network, stays shut under a test runner and to any address but the two it needs', async () => {
  await assert.rejects(gn.networkFetch(gn.proxyZipUrl('example.com/a', 'v1.0.0')), /test runner/);
  await assert.rejects(gn.networkFetch('https://example.com/a.zip'), /not an address/);
});

/* ═══════════════════ licence files and what they say ═══════════════════ */

test('licenceFiles: every LICENSE*, LICENCE*, COPYING*, NOTICE*, COPYRIGHT*, UNLICENSE* and PATENTS* in the module and everything in a LICENSES folder, at any depth, in name order — never in testdata or a folder Go ignores, never source code', () => {
  const p = 'example.com/a@v1.0.0/';
  const names = ['LICENSE', 'z/LICENSE.txt', 'COPYING', 'NOTICE', 'PATENTS', 'LICENSE-3RD-PARTY.md', 'Licence.md', 'UNLICENSE', 'COPYRIGHT',
    'testdata/x/COPYING', 'sub/testdata/LICENSE', '_examples/LICENSE', '.github/LICENSE', 'cmd/copyright.go', 'license.json', 'LICENSES.txt', 'LICENSES/MIT.txt', 'README.md', 'licensing/doc.go', 'a.go']
    .map((n) => p + n);
  assert.deepEqual(gn.licenceFiles([...names, 'example.com/other@v1.0.0/LICENSE'], p),
    ['COPYING', 'COPYRIGHT', 'LICENSE', 'LICENSE-3RD-PARTY.md', 'LICENSES.txt', 'LICENSES/MIT.txt', 'Licence.md', 'NOTICE', 'PATENTS', 'UNLICENSE', 'z/LICENSE.txt']);
});

test('identifyLicences names the licences a text grants, wherever it wraps its lines or comments them out, and names every copyleft one it meets', () => {
  const cases: [string, string, string[]][] = [
    ['MIT', MIT, ['MIT']],
    ['MIT behind // comments', MIT.split('\n').map((l) => `// ${l}`).join('\n'), ['MIT']],
    ['BSD 2-clause', BSD2, ['BSD-2-Clause']],
    ['BSD 3-clause', BSD3, ['BSD-3-Clause']],
    ['BSD with an advertising clause', BSD4, ['BSD-4-Clause']],
    ['Apache 2.0, the full text', APACHE, ['Apache-2.0']],
    ['Apache 2.0, the header that points at it', APACHE_HEADER, ['Apache-2.0']],
    ['ISC', ISC, ['ISC']],
    ['three in one file, sorted', `${MIT}\n----\n${APACHE}\n----\n${BSD3}`, ['Apache-2.0', 'BSD-3-Clause', 'MIT']],
    ['GPL', GPL, ['GPL']],
    ['LGPL', LGPL, ['LGPL']],
    ['AGPL', AGPL, ['AGPL']],
    ['MPL 2.0, file-level copyleft', MPL, ['MPL-2.0']],
    ['an older MPL', 'Mozilla Public License, version 1.1\n', ['MPL']],
    ['EPL', EPL, ['EPL']],
    ['CDDL', 'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE (CDDL) Version 1.0\n', ['CDDL']],
    ['EUPL', 'European Union Public Licence v. 1.2\n', ['EUPL']],
    ['BUSL', 'Business Source License 1.1\n', ['BUSL']],
    ['SSPL', 'Server Side Public License\nVERSION 1, OCTOBER 16, 2018\n', ['SSPL']],
    ['Commons Clause on Apache', `"Commons Clause" License Condition v1.0\n\n${APACHE_HEADER}`, ['Apache-2.0', 'LicenseRef-Commons-Clause']],
    ['MIT with GPL beside it', `${MIT}\n${GPL}`, ['GPL', 'MIT']],
    ['nothing it knows', 'All rights reserved. Do not copy.\n', []],
    ['a patent grant is no licence', PATENTS, []],
  ];
  for (const [label, text, ids] of cases) assert.deepEqual(gn.identifyLicences(text), ids, label);
});

test('classifyLicenceFile: a licence by its ids; a NOTICE or a patent grant as itself; a reviewed file by its exact text; anything else stops the generator by name', () => {
  const file = (name: string, text: string | Buffer) => gn.classifyLicenceFile({ module: 'example.com/a v1.0.0', file: name, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text) });
  assert.deepEqual(file('LICENSE', `﻿${MIT}\r\n\r\n`), { title: 'LICENSE', text: MIT.replace(/\n+$/, '\n'), ids: ['MIT'], note: null }, 'verbatim, but for a BOM, CRLF and blank lines at the ends');
  assert.deepEqual(file('NOTICE', 'Alpha\nCopyright 2020 Alpha Ltd.\n').ids, []);
  assert.equal(file('NOTICE', 'Alpha\nCopyright 2020 Alpha Ltd.\n').note, null);
  assert.deepEqual(file('NOTICE', APACHE_HEADER).ids, ['Apache-2.0'], 'a NOTICE that grants a licence counts for it');
  assert.deepEqual(file('PATENTS', PATENTS), { title: 'PATENTS', text: PATENTS, ids: [], note: null });
  assert.throws(() => file('PATENTS', 'We hold patents.\n'), /PATENTS/, 'a PATENTS file that is not the grant is read by a person');

  const logo = 'https://commons.wikimedia.org/wiki/File:Memory_infra_logo.png\n';
  const reviewed: Reviewed[] = [{ module: 'example.com/a', file: 'LICENSE-LOGO', sha256: sha256hex(logo), why: 'it names where the README\'s logo image comes from' }];
  const ok = gn.classifyLicenceFile({ module: 'example.com/a v1.0.0', file: 'LICENSE-LOGO', bytes: Buffer.from(logo) }, reviewed);
  assert.deepEqual(ok.ids, []);
  assert.equal(ok.note, 'LICENSE-LOGO names no licence: it names where the README\'s logo image comes from.');
  assert.throws(() => gn.classifyLicenceFile({ module: 'example.com/a v1.0.0', file: 'LICENSE-LOGO', bytes: Buffer.from(`${logo}changed\n`) }, reviewed),
    /example\.com\/a v1\.0\.0: LICENSE-LOGO/, 'a reviewed file whose text changed is read again');
  assert.throws(() => gn.classifyLicenceFile({ module: 'example.com/b v1.0.0', file: 'LICENSE-LOGO', bytes: Buffer.from(logo) }, reviewed),
    /example\.com\/b/, 'and the review is of one module\'s file');
  assert.throws(() => file('LICENSE', 'All rights reserved. Do not copy.\n'), /example\.com\/a v1\.0\.0: LICENSE names no licence this generator recognises/);
  assert.throws(() => file('LICENSE', Buffer.from([0x4d, 0x49, 0x54, 0xff, 0xfe, 0x0a])), /not valid UTF-8/);
  assert.ok(gn.REVIEWED.every((r) => /^[0-9a-f]{64}$/.test(r.sha256) && r.why.length > 20), 'every reviewed file is pinned by its digest and says why');
});

/* ═══════════════════ the notices file ═══════════════════ */

const GDU = 'github.com/dundee/gdu/v5';
const GDU_V = 'v5.36.1';
const GO_V = 'go1.26.2';
const TARGETS3: Record<string, string> = { 'linux-x64': 'gdu_linux_amd64.tgz', 'mac-arm64': 'gdu_darwin_arm64.tgz', 'win-x64': 'gdu_windows_amd64.exe.zip' };
const ALL3 = ['linux-x64', 'mac-arm64', 'win-x64'];

function baseModel(): Model {
  return {
    gdu: { module: GDU, version: GDU_V },
    go: { version: GO_V, licence: 'BSD-3-Clause', texts: [{ title: 'LICENSE', text: GO_LICENSE }, { title: 'PATENTS', text: PATENTS }] },
    binaries: [{ target: 'linux-x64', file: 'gdu', sha256: 'a'.repeat(64) }, { target: 'mac-arm64', file: 'gdu', sha256: 'b'.repeat(64) }, { target: 'win-x64', file: 'gdu.exe', sha256: 'c'.repeat(64) }],
    modules: [
      {
        path: 'example.com/alpha', version: 'v1.0.0', sum: `h1:${'A'.repeat(43)}=`, platforms: ALL3, licence: 'BSD-3-Clause AND MIT', notes: [],
        texts: [{ title: 'LICENSE', text: MIT }, { title: 'sub/LICENSE', text: BSD3 }],
      },
      {
        path: 'example.org/winonly', version: 'v0.0.0-20230129092748-24d4a6f8daec', sum: `h1:${'W'.repeat(43)}=`, platforms: ['win-x64'], licence: 'ISC',
        notes: ['LICENSE-LOGO names no licence: it names where a logo comes from.'], texts: [{ title: 'LICENSE', text: ISC }, { title: 'LICENSE-LOGO', text: 'https://example.invalid/logo.png\n' }],
      },
    ],
  };
}

function baseRecord(): GduRecord {
  return {
    about: 'test',
    gdu: { module: GDU, version: GDU_V },
    go: GO_V,
    binaries: {
      'linux-x64': { file: 'gdu', sha256: 'a'.repeat(64), modules: ['example.com/alpha v1.0.0'] },
      'mac-arm64': { file: 'gdu', sha256: 'b'.repeat(64), modules: ['example.com/alpha v1.0.0'] },
      'win-x64': { file: 'gdu.exe', sha256: 'c'.repeat(64), modules: ['example.com/alpha v1.0.0', 'example.org/winonly v0.0.0-20230129092748-24d4a6f8daec'] },
    },
    modules: [
      { path: 'example.com/alpha', version: 'v1.0.0', sum: `h1:${'A'.repeat(43)}=` },
      { path: 'example.org/winonly', version: 'v0.0.0-20230129092748-24d4a6f8daec', sum: `h1:${'W'.repeat(43)}=` },
    ],
  };
}

const BASE_NOTICES = gn.renderNotices(baseModel());

test('renderNotices and parseNotices agree, and rendering is deterministic', () => {
  const text = gn.renderNotices(baseModel());
  assert.equal(gn.renderNotices(baseModel()), text, 'the same model renders the same bytes');
  const shuffled = baseModel();
  shuffled.modules.reverse();
  shuffled.binaries.reverse();
  assert.equal(gn.renderNotices(shuffled), text, 'whatever order the model lists modules and binaries in');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'one newline at the end');
  assert.doesNotMatch(text, /\r/);
  const parsed = gn.parseNotices(text);
  assert.deepEqual(parsed.gdu, { module: GDU, version: GDU_V, go: GO_V });
  assert.equal(parsed.go, GO_V);
  assert.equal(parsed.goLicence, 'BSD-3-Clause');
  assert.deepEqual(parsed.goTexts, ['LICENSE', 'PATENTS']);
  assert.deepEqual(parsed.binaries, baseModel().binaries);
  assert.deepEqual(parsed.modules, [
    { path: 'example.com/alpha', version: 'v1.0.0', platforms: ALL3, licence: 'BSD-3-Clause AND MIT', sum: `h1:${'A'.repeat(43)}=`, texts: ['LICENSE', 'sub/LICENSE'] },
    { path: 'example.org/winonly', version: 'v0.0.0-20230129092748-24d4a6f8daec', platforms: ['win-x64'], licence: 'ISC', sum: `h1:${'W'.repeat(43)}=`, texts: ['LICENSE', 'LICENSE-LOGO'] },
  ]);
  assert.match(text, /Copyright \(c\) 2020 The Alpha Authors/, 'the licence texts themselves are in the file');
  assert.match(text, /LICENSE-LOGO names no licence: it names where a logo comes from\./, 'with the note on a reviewed file');
  assert.ok(text.replace(/\s+/g, ' ').includes("gdu's own licence (MIT) ships beside this file as LICENSE.md"), 'it points at gdu\'s own licence, which ships beside it');
  assert.match(text, /https:\/\/proxy\.golang\.org\/example\.com\/alpha\/@v\/v1\.0\.0\.zip/, 'and says where each module\'s source is');
  assert.match(text, /Additional IP Rights Grant \(Patents\)/);
});

test('drift: a file in step with gdu-modules.json has nothing to say (the cases below start from it)', () => {
  assert.deepEqual(gn.driftProblems(baseRecord(), BASE_NOTICES), []);
  assert.deepEqual(gn.driftProblems(baseRecord(), BASE_NOTICES.replace(/\n/g, '\r\n')), [], 'a CRLF checkout reads the same');
});

function recordWith(change: (r: GduRecord) => void): GduRecord {
  const r = baseRecord();
  change(r);
  return r;
}

test('drift: a module a binary gained, lost or moved to another version is named, with the command that fixes it', () => {
  const added = gn.driftProblems(recordWith((r) => {
    r.binaries['linux-x64'].modules.push('example.com/beta v0.1.0');
    r.modules.push({ path: 'example.com/beta', version: 'v0.1.0', sum: 'h1:b=' });
  }), BASE_NOTICES);
  assert.equal(added.length, 1, added.join('\n'));
  assert.match(added[0], /example\.com\/beta v0\.1\.0/);
  assert.match(added[0], REGENERATE);
  const gone = gn.driftProblems(recordWith((r) => {
    r.binaries['win-x64'].modules = ['example.com/alpha v1.0.0'];
    r.modules = r.modules.slice(0, 1);
  }), BASE_NOTICES);
  assert.equal(gone.length, 1, gone.join('\n'));
  assert.match(gone[0], /example\.org\/winonly/);
  assert.match(gone[0], /no longer/);
  const moved = gn.driftProblems(recordWith((r) => {
    for (const b of Object.values(r.binaries)) b.modules = b.modules.map((m) => m.replace('alpha v1.0.0', 'alpha v1.0.1'));
    r.modules[0] = { ...r.modules[0], version: 'v1.0.1' };
  }), BASE_NOTICES);
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0], /example\.com\/alpha/);
  assert.match(moved[0], /v1\.0\.1/);
  assert.match(moved[0], /v1\.0\.0/);
});

test('drift: the platforms a module is linked on, its checksum, the binaries, the Go version and the gdu version are each held to the record', () => {
  const cases: [string, (r: GduRecord) => void, RegExp[]][] = [
    ['platforms', (r) => r.binaries['mac-arm64'].modules.push('example.org/winonly v0.0.0-20230129092748-24d4a6f8daec'), [/example\.org\/winonly/, /mac-arm64/]],
    ['checksum', (r) => { r.modules[0] = { ...r.modules[0], sum: 'h1:other=' }; }, [/example\.com\/alpha v1\.0\.0/, /h1:other=/]],
    ['a stray checksum', (r) => { r.modules.push({ path: 'example.com/stray', version: 'v1.0.0', sum: 'h1:s=' }); }, [/example\.com\/stray v1\.0\.0, which no binary links/]],
    ['a binary', (r) => { r.binaries['mac-arm64'].sha256 = 'd'.repeat(64); }, [/mac-arm64/, /d{64}/]],
    ['a platform', (r) => { r.binaries['linux-arm64'] = { file: 'gdu', sha256: 'e'.repeat(64), modules: ['example.com/alpha v1.0.0'] }; }, [/the linux-arm64 binary/]],
    ['a platform gone', (r) => { delete r.binaries['mac-arm64']; }, [/the mac-arm64 binary, which/]],
    ['Go', (r) => { r.go = 'go1.27.0'; }, [/built by go1\.26\.2, but \S+ records go1\.27\.0/, /Go standard library of go1\.26\.2, but \S+ records go1\.27\.0/]],
    ['gdu', (r) => { r.gdu = { ...r.gdu, version: 'v5.37.0' }; }, [/v5\.37\.0/, /v5\.36\.1/]],
  ];
  for (const [label, change, patterns] of cases) {
    const problems = gn.driftProblems(recordWith(change), BASE_NOTICES);
    assert.ok(problems.length >= 1, `${label}: named`);
    for (const p of patterns) assert.ok(problems.some((line) => p.test(line)), `${label}: ${p} in ${problems.join(' | ')}`);
    assert.ok(problems.every((line) => REGENERATE.test(line)), `${label}: with the command that fixes it`);
  }
});

test('drift: a file with a module listed twice, or without its gdu line or its Go entry, is refused', () => {
  const ruler = '='.repeat(72);
  const start = BASE_NOTICES.indexOf(`${ruler}\nModule: example.com/alpha`);
  const twice = BASE_NOTICES + BASE_NOTICES.slice(start, BASE_NOTICES.indexOf(`${ruler}\nModule: example.org/winonly`));
  const dup = gn.driftProblems(baseRecord(), twice);
  assert.ok(dup.some((p) => /example\.com\/alpha v1\.0\.0/.test(p) && /twice/.test(p)), `the module listed twice is named: ${dup.join(' | ')}`);
  const noGdu = gn.driftProblems(baseRecord(), BASE_NOTICES.replace(/^The binaries \(.*$/m, ''));
  assert.ok(noGdu.some((p) => /no line naming the gdu binaries/.test(p)), `a missing gdu line is named: ${noGdu.join(' | ')}`);
  const noGo = gn.driftProblems(baseRecord(), BASE_NOTICES.replace(/^Go standard library: .*$/m, ''));
  assert.ok(noGo.some((p) => /no entry for the Go standard library/.test(p)), `a missing Go entry is named: ${noGo.join(' | ')}`);
});

test('pinProblems: gdu-modules.json must be of the gdu version and the platforms scripts/fetchGdu.js pins, each binary under its own name', () => {
  const pin: Pin = { version: GDU_V, targets: TARGETS3 };
  assert.deepEqual(gn.pinProblems(baseRecord(), pin), []);
  const bumped = gn.pinProblems(baseRecord(), { ...pin, version: 'v5.37.0' });
  assert.equal(bumped.length, 1, bumped.join('\n'));
  assert.match(bumped[0], /v5\.37\.0/);
  assert.match(bumped[0], /v5\.36\.1/);
  assert.match(bumped[0], REGENERATE);
  const more = gn.pinProblems(baseRecord(), { ...pin, targets: { ...TARGETS3, 'linux-arm64': 'gdu_linux_arm64.tgz' } });
  assert.equal(more.length, 1, more.join('\n'));
  assert.match(more[0], /linux-arm64/);
  const { 'mac-arm64': _mac, ...fewer } = TARGETS3;
  void _mac;
  const less = gn.pinProblems(baseRecord(), { ...pin, targets: fewer });
  assert.equal(less.length, 1, less.join('\n'));
  assert.match(less[0], /mac-arm64/);
  const misnamed = gn.pinProblems(recordWith((r) => { r.binaries['win-x64'].file = 'gdu'; }), pin);
  assert.equal(misnamed.length, 1, misnamed.join('\n'));
  assert.match(misnamed[0], /gdu\.exe/);
  assert.equal(gn.binaryName('win-x64'), 'gdu.exe');
  assert.equal(gn.binaryName('mac-arm64'), 'gdu');
});

test('binaryProblems: a staged binary is the one recorded, byte for byte — and when it is not, what it links instead is named', () => {
  const bytes = goBinary(GO_V, modinfoOf([GDU, GDU_V], [['example.com/alpha', 'v1.0.0', '']]));
  const record = recordWith((r) => { r.binaries['mac-arm64'].sha256 = sha256hex(bytes); });
  assert.deepEqual(gn.binaryProblems(record, 'mac-arm64', bytes), []);
  const other = goBinary(GO_V, modinfoOf([GDU, 'v5.37.0'], [['example.com/alpha', 'v1.0.1', ''], ['example.com/new', 'v0.1.0', '']]));
  const problems = gn.binaryProblems(record, 'mac-arm64', other);
  assert.ok(problems.length >= 1, 'named');
  const all = problems.join('\n');
  assert.match(all, new RegExp(sha256hex(other)));
  assert.match(all, /v5\.37\.0/);
  assert.match(all, /example\.com\/new v0\.1\.0/);
  assert.match(all, /example\.com\/alpha v1\.0\.1/);
  assert.match(all, REGENERATE);
  assert.ok(gn.binaryProblems(record, 'win-arm64', bytes).some((p) => /win-arm64/.test(p)), 'a platform the record does not have');
});

test('stagedBinaries: the binaries fetchGdu.js stages for packaging, and the host\'s one it stages for running from source', () => {
  const repo = fileTempDir('treemap-gdu-staged-');
  const put = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), 'x');
  };
  const pin: Pin = { version: GDU_V, targets: TARGETS3 };
  assert.deepEqual(gn.stagedBinaries(repo, pin, { platform: 'darwin', arch: 'arm64' }), []);
  put('build/gdu/linux-x64/gdu');
  put('build/gdu/win-x64/gdu.exe');
  put('gdu/gdu');
  put('build/gdu/linux-arm64/gdu'); // not a pinned target here
  assert.deepEqual(gn.stagedBinaries(repo, pin, { platform: 'darwin', arch: 'arm64' }), [
    { target: 'linux-x64', file: path.join(repo, 'build', 'gdu', 'linux-x64', 'gdu') },
    { target: 'win-x64', file: path.join(repo, 'build', 'gdu', 'win-x64', 'gdu.exe') },
    { target: 'mac-arm64', file: path.join(repo, 'gdu', 'gdu') },
  ]);
  assert.deepEqual(gn.stagedBinaries(repo, pin, { platform: 'win32', arch: 'x64' }).map((b) => b.target), ['linux-x64', 'win-x64'], 'the dev copy is the host\'s; on Windows it is gdu.exe');
  assert.deepEqual(gn.stagedBinaries(repo, pin, { platform: 'freebsd', arch: 'x64' }).map((b) => b.target), ['linux-x64', 'win-x64'], 'a host with no pinned target has no dev copy to check');
  assert.deepEqual(gn.stagedBinaries(repo, pin, { platform: 'linux', arch: 'arm64' }).map((b) => b.target), ['linux-x64', 'win-x64'], 'nor one whose platform the pin does not stage');
});

test('licenceProblems names a module, or the Go standard library, whose licence permissive terms cannot meet', () => {
  assert.deepEqual(gn.licenceProblems(BASE_NOTICES), []);
  for (const licence of ['GPL AND MIT', 'MPL-2.0', 'LGPL', 'BSD-4-Clause', 'LicenseRef-Commons-Clause AND Apache-2.0']) {
    const model = baseModel();
    model.modules[0] = { ...model.modules[0], licence };
    const problems = gn.licenceProblems(gn.renderNotices(model));
    assert.equal(problems.length, 1, `${licence}: ${problems.join('\n')}`);
    assert.match(problems[0], /example\.com\/alpha v1\.0\.0/);
    assert.ok(problems[0].includes(licence), `${licence} is named: ${problems[0]}`);
  }
  const go = baseModel();
  go.go = { ...go.go, licence: 'GPL' };
  assert.ok(gn.licenceProblems(gn.renderNotices(go)).some((p) => /Go standard library/.test(p)), 'the standard library is held to it too');
});

/* ═══════════════════ the seal ═══════════════════ */

test('the seal: a sealed file passes; an edit to its text, a changed generator or a missing seal is named, with the command that fixes it', () => {
  const generator = 'a'.repeat(64);
  const sealed = gn.sealNotices(BASE_NOTICES, generator);
  assert.ok(sealed.startsWith(BASE_NOTICES) && sealed.endsWith('.\n'), 'the seal is one line after the text');
  assert.deepEqual(gn.sealProblems(sealed, generator), []);
  assert.deepEqual(gn.sealProblems(sealed.replace(/\n/g, '\r\n'), generator), [], 'a CRLF checkout reads the same');
  assert.deepEqual(gn.driftProblems(baseRecord(), sealed), [], 'and the drift check reads past it');
  const edited = gn.sealProblems(sealed.replace('The Alpha Authors', 'someone else'), generator);
  assert.equal(edited.length, 1, edited.join('\n'));
  assert.match(edited[0], /edited/);
  assert.match(edited[0], REGENERATE);
  const moved = gn.sealProblems(sealed, 'b'.repeat(64));
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0], /scripts\/gdu-notices\/licences\.js/, 'naming every file of the generator');
  assert.match(moved[0], REGENERATE);
  assert.deepEqual(gn.sealProblems(sealed, null), [], 'with no generator digest given, only the text is held to the seal');
  assert.equal(gn.sealProblems(sealed.replace('The Alpha Authors', 'someone else'), null).length, 1);
  const unsealed = gn.sealProblems(BASE_NOTICES, generator);
  assert.equal(unsealed.length, 1, unsealed.join('\n'));
  assert.match(unsealed[0], /seal/);
});

test('generatorDigest covers every file of the generator, including the helpers it shares with the Rust notices, line ends as LF', () => {
  const files: Record<string, string> = {
    'scripts/gdu-notices.js': 'main\n', 'scripts/gdu-notices/buildinfo.js': 'buildinfo\n', 'scripts/gdu-notices/licences.js': 'licences\n',
    'scripts/gdu-notices/notices.js': 'notices\n', 'scripts/gdu-notices/zip.js': 'zip\n', 'scripts/rust-notices/spdx.js': 'spdx\n',
    'scripts/rust-notices/text.js': 'text\n',
  };
  assert.deepEqual(gn.GENERATOR_FILES, Object.keys(files));
  const digest = gn.generatorDigest((rel) => files[rel]);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(gn.generatorDigest((rel) => files[rel].replace(/\n/g, '\r\n')), digest, 'a CRLF checkout digests the same');
  for (const rel of Object.keys(files)) {
    assert.notEqual(gn.generatorDigest((r) => (r === rel ? `${files[r]}// changed\n` : files[r])), digest, `${rel} is part of the digest`);
  }
});

test('packagedProblems: a packaged app carries gdu\'s LICENSE.md and the sealed notices in its gdu folder, untouched', () => {
  const resources = fileTempDir('treemap-gdu-packaged-');
  const gduDir = path.join(resources, 'gdu');
  fs.mkdirSync(gduDir, { recursive: true });
  const notices = gn.sealNotices(BASE_NOTICES, 'a'.repeat(64));
  fs.writeFileSync(path.join(gduDir, 'LICENSE.md'), GDU_LICENCE);
  fs.writeFileSync(path.join(gduDir, 'THIRD_PARTY_NOTICES.txt'), notices);
  assert.deepEqual(gn.packagedProblems(resources), []);
  fs.writeFileSync(path.join(gduDir, 'THIRD_PARTY_NOTICES.txt'), notices.slice(0, Math.floor(notices.length / 2)));
  const cut = gn.packagedProblems(resources);
  assert.equal(cut.length, 1, cut.join('\n'));
  assert.ok(cut[0].includes(path.join(gduDir, 'THIRD_PARTY_NOTICES.txt')), cut[0]);
  fs.rmSync(path.join(gduDir, 'THIRD_PARTY_NOTICES.txt'));
  fs.rmSync(path.join(gduDir, 'LICENSE.md'));
  const none = gn.packagedProblems(resources);
  assert.equal(none.length, 2, none.join('\n'));
  assert.ok(none.some((p) => p.includes(path.join(gduDir, 'LICENSE.md'))), none.join('\n'));
  assert.ok(none.some((p) => p.includes(path.join(gduDir, 'THIRD_PARTY_NOTICES.txt'))), none.join('\n'));
  fs.writeFileSync(path.join(gduDir, 'LICENSE.md'), '');
  assert.ok(gn.packagedProblems(resources).some((p) => p.includes('LICENSE.md') && /empty/.test(p)), 'an empty licence is no licence');
});

/* ═══════════════════ the generator end to end, with the binaries and the network stood in for ═══════════════════ */

interface FakeModule { path: string; version: string; files: Record<string, string | Buffer>; targets: string[]; goSum?: 'yes' | 'no' | 'wrong'; binarySum?: 'yes' | 'no' | 'wrong' }

function defaultModules(): FakeModule[] {
  return [
    { path: 'example.com/alpha', version: 'v1.0.0', targets: ALL3, files: { LICENSE: MIT, 'sub/LICENSE': BSD3, 'testdata/COPYING': GPL, 'alpha.go': 'package alpha\n' } },
    { path: 'example.com/Beta/v2', version: 'v2.1.0+incompatible', targets: ALL3, files: { LICENSE: APACHE, NOTICE: 'Beta\nCopyright 2020 Beta Ltd.\n', 'beta.go': 'package beta\n' } },
    { path: 'example.org/winonly', version: 'v0.0.0-20230129092748-24d4a6f8daec', targets: ['win-x64'], files: { LICENSE: ISC, 'w.go': 'package w\n' }, goSum: 'no', binarySum: 'yes' },
  ];
}

interface World { repo: string; pin: Pin; binaries: Record<string, Buffer>; responses: Map<string, Buffer>; fetched: string[] }
interface WorldOpts { modules?: FakeModule[]; goVersions?: Record<string, string>; gduVersion?: string; gduLicence?: string; replace?: boolean; drop?: string }

function moduleFiles(m: FakeModule): Record<string, string | Buffer> {
  return Object.fromEntries(Object.entries(m.files).map(([rel, body]) => [`${m.path}@${m.version}/${rel}`, body]));
}

/** A repository with gdu's LICENSE.md, three staged binaries recording `modules`, and the proxy and the Go source as a map of answers. */
function fakeWorld(opts: WorldOpts = {}): World {
  const modules = opts.modules ?? defaultModules();
  const repo = fileTempDir('treemap-gdu-notices-repo-');
  fs.mkdirSync(path.join(repo, 'build', 'gdu'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'build', 'gdu', 'LICENSE.md'), opts.gduLicence ?? GDU_LICENCE);
  const responses = new Map<string, Buffer>();
  const sums = new Map<string, string>();
  for (const m of modules) {
    const files = moduleFiles(m);
    responses.set(gn.proxyZipUrl(m.path, m.version), zipOf(files));
    sums.set(m.path, goH1(files));
  }
  const goSum = modules.filter((m) => m.goSum !== 'no').flatMap((m) => [
    `${m.path} ${m.version} ${m.goSum === 'wrong' ? `h1:${'X'.repeat(43)}=` : sums.get(m.path)}`, `${m.path} ${m.version}/go.mod h1:${'G'.repeat(43)}=`,
  ]);
  responses.set(gn.proxyZipUrl(GDU, GDU_V), zipOf({ [`${GDU}@${GDU_V}/LICENSE.md`]: GDU_LICENCE, [`${GDU}@${GDU_V}/go.sum`]: `${goSum.join('\n')}\n`, [`${GDU}@${GDU_V}/gdu.go`]: 'package gdu\n' }));
  responses.set(gn.goSourceUrl(GO_V, 'LICENSE'), Buffer.from(Buffer.from(GO_LICENSE).toString('base64')));
  responses.set(gn.goSourceUrl(GO_V, 'PATENTS'), Buffer.from(Buffer.from(PATENTS).toString('base64')));
  const binaries: Record<string, Buffer> = {};
  for (const target of Object.keys(TARGETS3)) {
    if (target === opts.drop) continue;
    const deps = modules.filter((m) => m.targets.includes(target)).map((m): [string, string, string] => {
      const sum = m.binarySum === 'yes' || (m.binarySum === undefined && target === 'linux-x64') ? sums.get(m.path) ?? '' : m.binarySum === 'wrong' ? `h1:${'Y'.repeat(43)}=` : '';
      return [m.path, m.version, sum];
    });
    const extra = opts.replace && target === 'mac-arm64' ? ['=>\texample.com/fork\tv1.0.1\t'] : [];
    binaries[target] = goBinary(opts.goVersions?.[target] ?? GO_V, modinfoOf([GDU, opts.gduVersion ?? GDU_V], deps, extra));
  }
  return { repo, pin: { version: GDU_V, targets: TARGETS3 }, binaries, responses, fetched: [] };
}

async function runMain(w: World, argv: string[], cacheDir: string | null = null): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await gn.main(argv, {
    repo: w.repo,
    pin: w.pin,
    readBinary: (target) => {
      const b = w.binaries[target];
      if (!b) throw Object.assign(new Error(`ENOENT: no such file, open '${target}'`), { code: 'ENOENT' });
      return b;
    },
    fetch: async (url) => {
      w.fetched.push(url);
      const body = w.responses.get(url);
      if (!body) throw new Error(`${url} -> HTTP 404`);
      return body;
    },
    cacheDir,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

const noticesOf = (w: World): string => fs.readFileSync(path.join(w.repo, gn.NOTICES_PATH), 'utf8');
const recordOf = (w: World): GduRecord => JSON.parse(fs.readFileSync(path.join(w.repo, gn.MODULES_PATH), 'utf8')) as GduRecord;
const nothingWritten = (w: World): boolean => !fs.existsSync(path.join(w.repo, gn.NOTICES_PATH)) && !fs.existsSync(path.join(w.repo, gn.MODULES_PATH));

test('main writes sealed notices and the module record that pass every check above, from the binaries and the sources it was given — and --check then agrees', async () => {
  const w = fakeWorld();
  const run = await runMain(w, []);
  assert.equal(run.code, 0, run.err.join('\n'));
  const text = noticesOf(w);
  const record = recordOf(w);
  assert.deepEqual(gn.driftProblems(record, text), []);
  assert.deepEqual(gn.pinProblems(record, w.pin), []);
  assert.deepEqual(gn.licenceProblems(text), []);
  assert.deepEqual(gn.sealProblems(text, realDigest()), [], 'sealed with the digest of the generator that wrote it');
  for (const [target, bytes] of Object.entries(w.binaries)) assert.deepEqual(gn.binaryProblems(record, target, bytes), [], target);
  assert.deepEqual(record.gdu, { module: GDU, version: GDU_V });
  assert.equal(record.go, GO_V);
  assert.deepEqual(record.binaries['win-x64'].modules, ['example.com/Beta/v2 v2.1.0+incompatible', 'example.com/alpha v1.0.0', 'example.org/winonly v0.0.0-20230129092748-24d4a6f8daec']);
  const parsed = gn.parseNotices(text);
  assert.deepEqual(parsed.modules.map((m) => [m.path, m.platforms, m.licence, m.texts]), [
    ['example.com/Beta/v2', ALL3, 'Apache-2.0', ['LICENSE', 'NOTICE']],
    ['example.com/alpha', ALL3, 'BSD-3-Clause AND MIT', ['LICENSE', 'sub/LICENSE']],
    ['example.org/winonly', ['win-x64'], 'ISC', ['LICENSE']],
  ], 'every licence file each module carries outside testdata/, and the platforms that link it');
  assert.doesNotMatch(text, /GNU GENERAL PUBLIC LICENSE/, 'the GPL text under testdata/ is no part of any binary');
  assert.match(text, /Copyright 2020 Beta Ltd\./, 'a NOTICE travels with its module');
  assert.deepEqual(parsed.goTexts, ['LICENSE', 'PATENTS']);
  assert.match(text, /Copyright \(c\) 2015 The Go Authors\./, 'Go\'s licence, from the Go source at the version that built the binaries');
  assert.ok(w.fetched.length > 0 && w.fetched.every((u) => gn.allowedUrl(u)), `only the proxy's zips and the Go source are fetched: ${w.fetched.join(', ')}`);
  assert.ok(w.fetched.includes('https://proxy.golang.org/example.com/!beta/v2/@v/v2.1.0+incompatible.zip'), 'upper case reaches the proxy escaped');
  assert.match(run.err.join('\n'), /3 modules in the binaries/);

  assert.equal((await runMain(w, ['--check'])).code, 0, 'the files it just wrote are current');
  fs.writeFileSync(path.join(w.repo, gn.NOTICES_PATH), text.replace('Beta Ltd.', 'Someone Else'));
  const stale = await runMain(w, ['--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.err.join('\n'), /out of date/);
  assert.match(stale.err.join('\n'), REGENERATE);
  assert.match(noticesOf(w), /Someone Else/, '--check never writes');
  fs.writeFileSync(path.join(w.repo, gn.NOTICES_PATH), text);
  fs.writeFileSync(path.join(w.repo, gn.MODULES_PATH), JSON.stringify({ ...record, go: 'go1.0' }));
  assert.equal((await runMain(w, ['--check'])).code, 1, 'and the module record is held to it as well');
});

test('main keeps what it fetched in its cache and checks it again on the next run, without the network', async () => {
  const cache = fileTempDir('treemap-gdu-notices-cache-');
  const w = fakeWorld();
  assert.equal((await runMain(w, [], cache)).code, 0);
  const first = w.fetched.length;
  assert.ok(first >= 5, `it fetched the three modules, gdu and Go's two files: ${first}`);
  const again = await runMain(w, ['--check'], cache);
  assert.equal(again.code, 0, again.err.join('\n'));
  assert.equal(w.fetched.length, first, 'nothing was fetched the second time');
  const cached = fs.readdirSync(cache);
  const alpha = cached.find((n) => n.includes('alpha'));
  assert.ok(alpha, cached.join(', '));
  fs.writeFileSync(path.join(cache, alpha), zipOf({ 'example.com/alpha@v1.0.0/LICENSE': MIT }));
  const tampered = await runMain(w, ['--check'], cache);
  assert.equal(tampered.code, 1, 'a cached zip is checked against go.sum like a fetched one');
  assert.match(tampered.err.join('\n'), /example\.com\/alpha v1\.0\.0/);
  assert.ok(tampered.err.join('\n').includes(path.join(cache, alpha)), 'naming the cached file to remove');
});

test('main refuses, writing nothing, when a module\'s licence is copyleft, file-level copyleft or unknown', async () => {
  const cases: [string, string, RegExp][] = [['GPL', GPL, /GPL/], ['MPL-2.0', MPL, /MPL-2\.0/], ['unknown', 'All rights reserved.\n', /names no licence this generator recognises/]];
  for (const [label, licence, reason] of cases) {
    const modules = defaultModules();
    modules[0] = { ...modules[0], files: { ...modules[0].files, 'sub/LICENSE': licence } };
    const w = fakeWorld({ modules });
    const run = await runMain(w, []);
    assert.equal(run.code, 1, `${label}: refused`);
    assert.match(run.err.join('\n'), /example\.com\/alpha v1\.0\.0/, `${label}: the module is named`);
    assert.match(run.err.join('\n'), reason, `${label}: ${run.err.join('\n')}`);
    assert.match(run.err.join('\n'), /nothing was written/);
    assert.ok(nothingWritten(w), `${label}: no file is written`);
  }
});

test('main refuses, writing nothing, a module source nothing vouches for: a zip that differs from go.sum or from the binary\'s own record, or one neither records', async () => {
  const cases: [string, Partial<FakeModule>, RegExp][] = [
    ['go.sum differs', { goSum: 'wrong' }, /go\.sum/],
    ['the binary differs', { goSum: 'yes', binarySum: 'wrong' }, /records/],
    ['neither records it', { goSum: 'no', binarySum: 'no' }, /nothing records/],
  ];
  for (const [label, change, reason] of cases) {
    const modules = defaultModules();
    modules[2] = { ...modules[2], ...change };
    const w = fakeWorld({ modules });
    const run = await runMain(w, []);
    assert.equal(run.code, 1, `${label}: refused`);
    assert.match(run.err.join('\n'), /example\.org\/winonly/, `${label}: the module is named`);
    assert.match(run.err.join('\n'), reason, `${label}: ${run.err.join('\n')}`);
    assert.ok(nothingWritten(w), `${label}: no file is written`);
  }
});

test('main refuses, writing nothing, binaries that are not the pinned gdu: another version, one missing, built by different Gos, a replaced module — and gdu\'s licence file of another version', async () => {
  const cases: [string, WorldOpts, RegExp[]][] = [
    ['another gdu', { gduVersion: 'v5.35.0' }, [/v5\.35\.0/, /v5\.36\.1/]],
    ['a missing binary', { drop: 'mac-arm64' }, [/build\/gdu\/mac-arm64\/gdu/, /fetchGdu\.js --all/]],
    ['two Gos', { goVersions: { 'win-x64': 'go1.25.0' } }, [/go1\.25\.0/, /go1\.26\.2/]],
    ['a replacement', { replace: true }, [/example\.com\/fork/, /replace/]],
    ['gdu\'s LICENSE.md', { gduLicence: 'something else\n' }, [/build\/gdu\/LICENSE\.md/, /v5\.36\.1/]],
  ];
  for (const [label, opts, reasons] of cases) {
    const w = fakeWorld(opts);
    const run = await runMain(w, []);
    assert.equal(run.code, 1, `${label}: refused`);
    for (const r of reasons) assert.match(run.err.join('\n'), r, `${label}: ${run.err.join('\n')}`);
    assert.ok(nothingWritten(w), `${label}: no file is written`);
  }
  const typo = await runMain(fakeWorld(), ['--write']);
  assert.equal(typo.code, 2, 'an argument it does not know is refused, never ignored');
  assert.match(typo.err.join('\n'), /--check/);
});

test('the committed notices name gdu\'s licence beside them, and say why a reviewed licence file needs none', () => {
  const notices = read(...gn.NOTICES_PATH.split('/'));
  assert.ok(notices.replace(/\s+/g, ' ').includes("gdu's own licence (MIT) ships beside this file as LICENSE.md"), 'it points at gdu\'s own licence');
  for (const r of gn.REVIEWED) {
    const at = notices.indexOf(`Module: ${r.module} `);
    assert.ok(at >= 0, `${r.module} has an entry`);
    const entry = notices.slice(at, notices.indexOf('\nModule: ', at + 1)).replace(/\s+/g, ' ');
    assert.ok(entry.includes(`${r.file} names no licence: ${r.why}.`), `${r.module} ${r.file}: the note says why`);
  }
});
