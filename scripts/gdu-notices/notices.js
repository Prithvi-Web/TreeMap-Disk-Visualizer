'use strict';
/*
 * The notices file of scripts/gdu-notices.js and everything that reads it:
 * the names and paths both sides use, rendering and parsing the notices and
 * the module record beside them, the checks tests/gduNotices.test.ts runs
 * offline on every CI leg (drift against the record, the record against
 * scripts/fetchGdu.js's pin, a staged binary against the record, licences
 * that need a person), the seal, and the check scripts/afterPack.js runs on
 * a packaged app. Nothing here touches the network.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isPermissive } = require('../rust-notices/spdx');
const { byCodeUnits, compareVersions, pack, wrap } = require('../rust-notices/text');
const { readBuildInfo } = require('./buildinfo');

const REPO = path.join(__dirname, '..', '..');
/** The notices, relative to the repository, spelled as package.json's extraResources spells it. */
const NOTICES_PATH = 'build/gdu/THIRD_PARTY_NOTICES.txt';
/** The module list the notices were written from. */
const MODULES_PATH = 'build/gdu/gdu-modules.json';
/** gdu's own licence, which scripts/fetchGdu.js fetches for the pinned version. */
const GDU_LICENCE_PATH = 'build/gdu/LICENSE.md';
/** gdu's module path at the major version scripts/fetchGdu.js pins. */
const GDU_MODULE = 'github.com/dundee/gdu/v5';
/** The generator's own files, and the helpers it shares with scripts/rust-notices.js. The seal names their digest. */
const GENERATOR_FILES = [
  'scripts/gdu-notices.js', 'scripts/gdu-notices/buildinfo.js', 'scripts/gdu-notices/licences.js', 'scripts/gdu-notices/notices.js',
  'scripts/gdu-notices/zip.js', 'scripts/rust-notices/spdx.js', 'scripts/rust-notices/text.js',
];
/** Node's process.platform -> the platform names scripts/fetchGdu.js stages under (its OS_NAME). */
const OS_NAME = { darwin: 'mac', linux: 'linux', win32: 'win' };
const RULER = '='.repeat(72);
const PROXY = 'https://proxy.golang.org/';
const GO_SOURCE = 'https://go.googlesource.com/go/+/refs/tags/';
const REGENERATE =
  'run `node scripts/gdu-notices.js` (it reads the binaries `node scripts/fetchGdu.js --all` stages and fetches the modules\' source from proxy.golang.org) and commit build/gdu/THIRD_PARTY_NOTICES.txt and build/gdu/gdu-modules.json';
const SEAL = /^Sealed by scripts\/gdu-notices\.js: generator sha256 ([0-9a-f]{64}), content sha256 ([0-9a-f]{64})\.$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The file name of the gdu binary for a platform, as scripts/fetchGdu.js stages it. */
function binaryName(target) {
  return target.startsWith('win') ? 'gdu.exe' : 'gdu';
}

/** Where a platform's binary is staged for packaging, relative to the repository. */
function stagedPath(target) {
  return `build/gdu/${target}/${binaryName(target)}`;
}

function compareModules(a, b) {
  return byCodeUnits(a.path, b.path) || compareVersions(a.version, b.version);
}

/** A module path or version as the proxy spells it: each capital letter as "!" and the letter in lower case. */
function escapeModulePath(s) {
  return s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

function proxyZipUrl(modulePath, version) {
  return `${PROXY}${escapeModulePath(modulePath)}/@v/${escapeModulePath(version)}.zip`;
}

function goSourceUrl(goVersion, file) {
  return `${GO_SOURCE}${goVersion}/${file}?format=TEXT`;
}

/** Every module the binaries link, once, with the platforms that link it, in path order. */
function linkedModules(binaries) {
  const byKey = new Map();
  for (const target of Object.keys(binaries).sort(byCodeUnits)) {
    for (const key of binaries[target].modules) {
      const [modulePath, version] = key.split(' ');
      const entry = byKey.get(key) ?? { path: modulePath, version, platforms: [] };
      entry.platforms.push(target);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(compareModules);
}

/* ───────────────────────────── the files ───────────────────────────── */

function textBlocks(texts) {
  return texts.flatMap((t) => [`---- ${t.title} ----`, '', t.text.replace(/\n$/, ''), '']);
}

function moduleBlock(m) {
  return [
    RULER,
    `Module: ${m.path} ${m.version}`,
    `In the binaries for: ${m.platforms.join(', ')}`,
    `Licence: ${m.licence}`,
    `Source: ${proxyZipUrl(m.path, m.version)}`,
    `go.sum hash: ${m.sum}`,
    RULER,
    '',
    ...m.notes.flatMap((n) => [...wrap(n), '']),
    ...textBlocks(m.texts),
  ];
}

function goBlock(go, targets) {
  return [
    RULER,
    `Go standard library: ${go.version}`,
    `In the binaries for: ${targets.join(', ')}`,
    `Licence: ${go.licence}`,
    `Source: ${GO_SOURCE}${go.version}`,
    RULER,
    '',
    ...wrap(`Every binary was built by ${go.version} and contains parts of the Go standard library and runtime. Below are Go's licence and its patent grant, from the Go source at that release.`),
    '',
    ...textBlocks(go.texts),
  ];
}

/**
 * The whole file but its seal, from a model: { gdu: { module, version },
 * go: { version, licence, texts }, binaries: [{ target, file, sha256 }],
 * modules: [{ path, version, sum, platforms, licence, notes, texts }] }. The
 * same model renders the same bytes, whatever order it lists things in.
 */
function renderNotices(model) {
  const modules = [...model.modules].sort(compareModules);
  const binaries = [...model.binaries].sort((a, b) => byCodeUnits(a.target, b.target));
  const width = Math.max(...binaries.map((b) => `${b.target}/${b.file}`.length));
  const title = 'TreeMap: third-party notices for gdu';
  const lines = [
    title,
    '='.repeat(title.length),
    '',
    ...wrap(
      "TreeMap bundles gdu (https://github.com/dundee/gdu), the engine behind its fast scans, as one program per platform. gdu's own licence (MIT) ships beside this file as LICENSE.md. Each program also contains code written by others, linked into it when it was built: the Go modules below, at the versions the program records, and the Go standard library.",
    ),
    '',
    ...wrap(
      'Each module is listed with every licence file its source carries at that version, word for word, leaving out only the testdata and other folders Go never compiles. The source is the zip proxy.golang.org serves, checked against the go.sum hash gdu records for it. "Licence" names the licences those files grant, joined by AND.',
    ),
    '',
    `The binaries (${model.gdu.module} ${model.gdu.version}, built by ${model.go.version}):`,
    ...binaries.map((b) => `  ${`${b.target}/${b.file}`.padEnd(width)}  sha256 ${b.sha256}`),
    '',
    ...wrap(
      `This file is written by scripts/gdu-notices.js from the Go build information in those binaries, and sealed by its last line; the module list it was written from is ${MODULES_PATH}. Do not edit either by hand: tests/gduNotices.test.ts fails when they no longer match each other, the gdu scripts/fetchGdu.js pins, the generator or the seal.`,
    ),
    '',
    `Go modules in the binaries (${modules.length}):`,
    ...pack(modules.map((m, i) => `${m.path} ${m.version}${i < modules.length - 1 ? ',' : ''}`), '  '),
    '',
    `The Go standard library (${model.go.version}) follows the modules.`,
    '',
    ...modules.flatMap(moduleBlock),
    ...goBlock(model.go, binaries.map((b) => b.target)),
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** The module record beside the notices, as JSON text: the same record always gives the same bytes. */
function recordText({ gdu, go, binaries }, modules) {
  const record = {
    about: `Written by scripts/gdu-notices.js from the Go build information of the gdu binaries scripts/fetchGdu.js stages; tests/gduNotices.test.ts holds ${NOTICES_PATH} to it. Do not edit by hand.`,
    gdu,
    go,
    binaries: Object.fromEntries(Object.keys(binaries).sort(byCodeUnits).map((t) => [t, binaries[t]])),
    modules: [...modules].sort(compareModules).map((m) => ({ path: m.path, version: m.version, sum: m.sum })),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** What a notices file says: the gdu and Go its binaries line names, the binaries, the modules and the Go entry. */
function parseNotices(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const parsed = { gdu: null, go: null, goLicence: null, goTexts: [], binaries: [], modules: [] };
  let entry = null;
  let goEntryFound = null;
  let state = 'top';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === RULER) {
      const next = lines[i + 1] ?? '';
      const mod = /^Module: (\S+) (\S+)$/.exec(next);
      const go = /^Go standard library: (\S+)$/.exec(next);
      if (mod) {
        entry = { path: mod[1], version: mod[2], platforms: [], licence: '', sum: '', texts: [] };
        parsed.modules.push(entry);
      } else if (go) {
        entry = { platforms: [], licence: '', texts: [] };
        goEntryFound = entry;
        parsed.go = go[1];
      }
      if (mod || go) {
        state = 'header';
        i += 1;
      } else if (state === 'header') {
        state = 'body';
      }
      continue;
    }
    if (state === 'top') {
      const head = /^The binaries \((\S+) (\S+), built by (\S+)\):$/.exec(line);
      const binary = /^ {2}(\S+)\/(\S+) +sha256 ([0-9a-f]{64})$/.exec(line);
      if (head) parsed.gdu = { module: head[1], version: head[2], go: head[3] };
      else if (binary) parsed.binaries.push({ target: binary[1], file: binary[2], sha256: binary[3] });
    } else if (state === 'header') {
      const field = /^(In the binaries for|Licence|go\.sum hash): (.*)$/.exec(line);
      if (field && field[1] === 'In the binaries for') entry.platforms = field[2].split(', ');
      else if (field && field[1] === 'Licence') entry.licence = field[2];
      else if (field && 'sum' in entry) entry.sum = field[2];
    } else {
      const heading = /^---- (.+) ----$/.exec(line);
      if (heading) entry.texts.push(heading[1]);
    }
  }
  if (goEntryFound) {
    parsed.goLicence = goEntryFound.licence;
    parsed.goTexts = goEntryFound.texts;
  }
  return parsed;
}

/* ───────────────────────────── the checks ───────────────────────────── */

function versionsByPath(list) {
  const map = new Map();
  for (const m of list) map.set(m.path, [...new Set([...(map.get(m.path) ?? []), m.version])]);
  return map;
}

/** The notices against the record's gdu, Go and binaries. */
function headerDrift(record, parsed, say) {
  if (!parsed.gdu) {
    say(`${NOTICES_PATH} has no line naming the gdu binaries it describes ("The binaries (…)")`);
  } else {
    if (parsed.gdu.module !== record.gdu.module || parsed.gdu.version !== record.gdu.version) {
      say(`${NOTICES_PATH} was written for ${parsed.gdu.module} ${parsed.gdu.version}, but ${MODULES_PATH} records ${record.gdu.module} ${record.gdu.version}`);
    }
    if (parsed.gdu.go !== record.go) say(`${NOTICES_PATH} says the binaries were built by ${parsed.gdu.go}, but ${MODULES_PATH} records ${record.go}`);
  }
  if (parsed.go === null) say(`${NOTICES_PATH} has no entry for the Go standard library, which every binary contains`);
  else if (parsed.go !== record.go) say(`${NOTICES_PATH} has the Go standard library of ${parsed.go}, but ${MODULES_PATH} records ${record.go}`);
  for (const target of Object.keys(record.binaries).sort(byCodeUnits)) {
    const want = record.binaries[target];
    const got = parsed.binaries.find((b) => b.target === target);
    if (!got) say(`${MODULES_PATH} records the ${target} binary, but ${NOTICES_PATH} does not list it`);
    else if (got.file !== want.file || got.sha256 !== want.sha256) {
      say(`${NOTICES_PATH} lists ${target}/${got.file} with sha256 ${got.sha256}, but ${MODULES_PATH} records ${target}/${want.file} with sha256 ${want.sha256}`);
    }
  }
  for (const b of parsed.binaries) if (!record.binaries[b.target]) say(`${NOTICES_PATH} lists the ${b.target} binary, which ${MODULES_PATH} does not record`);
}

/** The notices' module entries against the modules the record's binaries link. */
function moduleDrift(record, parsed, say) {
  const seen = new Set();
  for (const m of parsed.modules) {
    const key = `${m.path} ${m.version}`;
    if (seen.has(key)) say(`${key} is listed twice in ${NOTICES_PATH}`);
    seen.add(key);
  }
  const linked = linkedModules(record.binaries);
  const sums = new Map(record.modules.map((m) => [`${m.path} ${m.version}`, m.sum]));
  for (const key of sums.keys()) if (!linked.some((m) => `${m.path} ${m.version}` === key)) say(`${MODULES_PATH} has a go.sum hash for ${key}, which no binary links`);
  const inRecord = versionsByPath(linked);
  const inFile = versionsByPath(parsed.modules);
  for (const p of [...new Set([...inRecord.keys(), ...inFile.keys()])].sort(byCodeUnits)) {
    const recordOnly = (inRecord.get(p) ?? []).filter((v) => !(inFile.get(p) ?? []).includes(v)).sort(compareVersions);
    const fileOnly = (inFile.get(p) ?? []).filter((v) => !(inRecord.get(p) ?? []).includes(v)).sort(compareVersions);
    if (recordOnly.length > 0 && fileOnly.length > 0) {
      say(`${p}: the binaries ${MODULES_PATH} records link ${recordOnly.join(', ')}, but ${NOTICES_PATH} has ${fileOnly.join(', ')}`);
      continue;
    }
    for (const v of recordOnly) say(`${p} ${v} is linked into the binaries ${MODULES_PATH} records, but ${NOTICES_PATH} has no entry for it`);
    for (const v of fileOnly) say(`${p} ${v} is in ${NOTICES_PATH} but no longer in the binaries ${MODULES_PATH} records`);
  }
  for (const want of linked) {
    const key = `${want.path} ${want.version}`;
    const got = parsed.modules.find((m) => m.path === want.path && m.version === want.version);
    if (!got) continue;
    if (got.platforms.join(', ') !== want.platforms.join(', ')) {
      say(`${key} is linked into the binaries for ${want.platforms.join(', ')}, but ${NOTICES_PATH} says ${got.platforms.join(', ')}`);
    }
    if (got.sum !== (sums.get(key) ?? '')) say(`${key}: ${NOTICES_PATH} has go.sum hash ${got.sum}, but ${MODULES_PATH} records ${sums.get(key) ?? 'none'}`);
  }
}

/**
 * Everything that makes a notices file stale against the module record —
 * offline, from the two files alone: a module gained, lost or moved to
 * another version, linked on other platforms, with another go.sum hash; a
 * binary added, gone or changed; another gdu or Go. Each sentence names what
 * differs and ends with `advice`; none means the two are in step.
 */
function driftProblems(record, notices, advice = REGENERATE) {
  const problems = [];
  const say = (sentence) => problems.push(`${sentence}; ${advice}`);
  const parsed = parseNotices(notices);
  headerDrift(record, parsed, say);
  moduleDrift(record, parsed, say);
  return problems;
}

/** The record against scripts/fetchGdu.js's pin: the gdu version, the platforms, and each binary's file name. */
function pinProblems(record, pin) {
  const problems = [];
  if (record.gdu.module !== GDU_MODULE || record.gdu.version !== pin.version) {
    problems.push(`scripts/fetchGdu.js pins gdu ${pin.version}, but ${MODULES_PATH} was read from ${record.gdu.module} ${record.gdu.version}; ${REGENERATE}`);
  }
  const pinned = Object.keys(pin.targets).sort(byCodeUnits);
  const recorded = Object.keys(record.binaries).sort(byCodeUnits);
  for (const t of pinned.filter((x) => !recorded.includes(x))) problems.push(`scripts/fetchGdu.js stages gdu for ${t}, but ${MODULES_PATH} records no ${t} binary; ${REGENERATE}`);
  for (const t of recorded.filter((x) => !pinned.includes(x))) problems.push(`${MODULES_PATH} records a ${t} binary, which scripts/fetchGdu.js does not stage; ${REGENERATE}`);
  for (const t of recorded) {
    if (record.binaries[t].file !== binaryName(t)) problems.push(`${MODULES_PATH} records the ${t} binary as ${record.binaries[t].file}, but fetchGdu.js stages it as ${binaryName(t)}; ${REGENERATE}`);
  }
  return problems;
}

/** A staged binary against the record, byte for byte; when it differs, what it is and links instead. */
function binaryProblems(record, target, bytes) {
  const want = record.binaries[target];
  if (!want) return [`${MODULES_PATH} records no ${target} binary; ${REGENERATE}`];
  const actual = sha256(bytes);
  if (actual === want.sha256) return [];
  const problems = [`the ${target} gdu binary here (sha256 ${actual}) is not the one ${MODULES_PATH} was read from (sha256 ${want.sha256}); ${REGENERATE}`];
  let info;
  try {
    info = readBuildInfo(bytes);
  } catch (err) {
    return [...problems, `and its build information cannot be read: ${err.message}`];
  }
  if (info.main.version !== record.gdu.version) problems.push(`it is gdu ${info.main.version}, not ${record.gdu.version}`);
  if (info.goVersion !== record.go) problems.push(`it was built by ${info.goVersion}, not ${record.go}`);
  const links = info.deps.map((d) => `${d.path} ${d.version}`);
  const extra = links.filter((m) => !want.modules.includes(m));
  const missing = want.modules.filter((m) => !links.includes(m));
  if (extra.length > 0) problems.push(`it links ${extra.join(', ')}, which the record does not`);
  if (missing.length > 0) problems.push(`it does not link ${missing.join(', ')}, which the record does`);
  return problems;
}

/** Every entry whose licence permissive terms cannot meet — a person's decision, named. */
function licenceProblems(notices) {
  const parsed = parseNotices(notices);
  const decide =
    'it is copyleft (MPL-2.0 and the like are copyleft file by file), source-available or unknown, and a person decides whether and how it may ship (scripts/rust-notices/spdx.js PERMISSIVE lists what ships without asking)';
  const problems = [];
  for (const m of parsed.modules) {
    if (!isPermissive(m.licence)) problems.push(`${m.path} ${m.version}: its licence files grant ${m.licence || 'nothing recognised'}, which permissive terms cannot meet: ${decide}`);
  }
  if (parsed.go !== null && !isPermissive(parsed.goLicence)) {
    problems.push(`the Go standard library ${parsed.go}: its licence, ${parsed.goLicence || 'none'}, cannot be met on permissive terms: ${decide}`);
  }
  return problems;
}

/** The binaries `fetchGdu.js` has staged here: for packaging under build/gdu/, and the host's own under gdu/ (`--dev`). */
function stagedBinaries(repo, pin, host = { platform: process.platform, arch: process.arch }) {
  const found = [];
  for (const target of Object.keys(pin.targets).sort(byCodeUnits)) {
    const file = path.join(repo, ...stagedPath(target).split('/'));
    if (fs.existsSync(file)) found.push({ target, file });
  }
  const osName = OS_NAME[host.platform];
  const hostTarget = osName ? `${osName}-${host.arch}` : null;
  if (hostTarget && pin.targets[hostTarget]) {
    const file = path.join(repo, 'gdu', binaryName(hostTarget));
    if (fs.existsSync(file)) found.push({ target: hostTarget, file });
  }
  return found;
}

/* ───────────────────────────── the seal ───────────────────────────── */

/** The digest the seal names: of every generator file, read by `read(relativePath)`, line ends as LF. */
function generatorDigest(read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')) {
  return sha256(GENERATOR_FILES.map((rel) => `${rel}\n${String(read(rel)).replace(/\r\n?/g, '\n')}`).join('\n'));
}

/** `body` with its seal appended after a blank line: the generator's digest and the digest of `body` itself. */
function sealNotices(body, generator) {
  return `${body}\nSealed by scripts/gdu-notices.js: generator sha256 ${generator}, content sha256 ${sha256(body)}.\n`;
}

/**
 * What is wrong with a notices file's seal; nothing when the file is the
 * generator's, untouched. With `generator` null only the text is held to the
 * seal (a packaged copy, where the generator is not at hand).
 */
function sealProblems(notices, generator) {
  const text = String(notices).replace(/\r\n?/g, '\n');
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const m = SEAL.exec(lines.pop() ?? '');
  if (!m) return [`${NOTICES_PATH} does not end with its seal, so nothing shows the generator wrote it; ${REGENERATE}`];
  const problems = [];
  if (generator !== null && m[1] !== generator) {
    problems.push(`the generator (${GENERATOR_FILES.join(', ')}) has changed since it wrote ${NOTICES_PATH}; ${REGENERATE}`);
  }
  if (m[2] !== sha256(lines.join('\n'))) {
    problems.push(`${NOTICES_PATH} has been edited since the generator wrote it: its text no longer matches its seal. Never edit it by hand; ${REGENERATE}`);
  }
  return problems;
}

/** What a packaged app's resources folder lacks of gdu's licences: its LICENSE.md, and the notices, sealed and untouched. */
function packagedProblems(resourcesDir) {
  const dir = path.join(resourcesDir, 'gdu');
  const problems = [];
  const licence = path.join(dir, 'LICENSE.md');
  let size = null;
  try {
    size = fs.statSync(licence).size;
  } catch {
    problems.push(`${licence} does not exist`);
  }
  if (size === 0) problems.push(`${licence} is empty`);
  const noticesFile = path.join(dir, 'THIRD_PARTY_NOTICES.txt');
  let notices = null;
  try {
    notices = fs.readFileSync(noticesFile, 'utf8');
  } catch {
    problems.push(`${noticesFile} does not exist`);
  }
  if (notices !== null) {
    const seal = sealProblems(notices, null);
    if (seal.length > 0) problems.push(`${noticesFile} is not the file scripts/gdu-notices.js wrote: ${seal.join(' ')}`);
  }
  return problems;
}

module.exports = {
  NOTICES_PATH, MODULES_PATH, GDU_LICENCE_PATH, GDU_MODULE, GENERATOR_FILES, GO_SOURCE, REGENERATE, sha256,
  binaryName, stagedPath, compareModules, escapeModulePath, proxyZipUrl, goSourceUrl, linkedModules,
  renderNotices, recordText, parseNotices, driftProblems, pinProblems, binaryProblems, licenceProblems, stagedBinaries,
  generatorDigest, sealNotices, sealProblems, packagedProblems,
};
