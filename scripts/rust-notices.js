#!/usr/bin/env node
'use strict';
/*
 * The third-party notices of TreeMap's native core.
 *
 *   node scripts/rust-notices.js           write native/THIRD_PARTY_NOTICES.txt
 *   node scripts/rust-notices.js --check   exit 1 when the committed file is not what it would write
 *
 * treemap_core.node (crate tm-node) and, on Windows, tm-mft-helper.exe are
 * statically linked from the crates in native/treemap-core/Cargo.lock and from
 * Rust's standard library. MIT and Apache-2.0 both ask for their notices to
 * travel with every binary copy, so the release carries this file in the
 * app's resources (package.json, build.extraResources).
 *
 * What it reads, all of it offline:
 *   - `cargo metadata --offline --locked --all-features` in the workspace: every
 *     package, its licence expression, repository and the folder it was
 *     unpacked into in the local registry, and the dependency graph with each
 *     edge's kind;
 *   - each crate's own licence files from that folder (LICENSE*, COPYING*,
 *     NOTICE*, UNLICENSE*, COPYRIGHT*, a LICENSES/ folder, the license-file its
 *     Cargo.toml names), verbatim. A crate whose package holds none gets the
 *     text a person copied from its upstream repository into
 *     native/licence-texts/<crate>/, or else the standard text of each licence
 *     it names, and its entry says which;
 *   - the pinned toolchain (scripts/rust-notices/toolchain.js): the licences of
 *     the standard library's own files, the notices it records for the
 *     crates.io crates the library is built from, and the standard texts.
 *
 * Every crate in Cargo.lock gets an entry with its licence texts, including
 * the ones that only run while the binaries are built (procedural macros, a
 * build script's dependencies) — they are marked "In the binaries: no". That
 * is what lets tests/rustNotices.test.ts guard the file from Cargo.lock alone,
 * offline, on every CI leg: a crate added, removed or re-versioned without
 * regenerating fails it, and no change to how a Cargo.toml classifies a
 * dependency can leave a linked crate without its texts. The file's last line
 * seals it: the digest of this generator and of the text above it, so a
 * change to the generator without regenerating, or an edit by hand, fails the
 * same test.
 *
 * It refuses — writing nothing — when a licence cannot be met on the
 * permissive terms in PERMISSIVE (copyleft and unknown licences are a person's
 * decision, never a silent one), when rustc is not the version
 * rust-toolchain.toml pins, when cargo's metadata and Cargo.lock disagree, or
 * when the toolchain's records do not cover its standard library. The only
 * step that needs the network is getting the crates into the local registry in
 * the first place (`cargo fetch` in native/treemap-core); this script never
 * fetches anything.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PERMISSIVE, parseSpdx, spdxIds, isPermissive } = require('./rust-notices/spdx');
const { byCodeUnits, compareVersions, compareCrates, normaliseText, pack, wrap, authorName } = require('./rust-notices/text');
const { STD_CRATES, SHIPPED_TARGETS, stdCratesInSysroot, parseStdCopyright, crateRecord } = require('./rust-notices/toolchain');

const REPO = path.join(__dirname, '..');
const WORKSPACE = path.join('native', 'treemap-core');
/** The notices file, relative to the repository, spelled as package.json's extraResources spells it. */
const NOTICES_PATH = 'native/THIRD_PARTY_NOTICES.txt';
/** Where a person keeps the upstream licence text of a crate whose package carries none: <this>/<crate>/<file>. */
const UPSTREAM_TEXTS = 'native/licence-texts';
/** The generator's own files. The seal names their digest, so a change to any of them needs the notices regenerated. */
const GENERATOR_FILES = ['scripts/rust-notices.js', 'scripts/rust-notices/spdx.js', 'scripts/rust-notices/text.js', 'scripts/rust-notices/toolchain.js'];
const RULER = '='.repeat(72);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const REGENERATE =
  'run `node scripts/rust-notices.js` (it needs cargo, and the crates in the local registry: `cargo fetch` in native/treemap-core gets them) and commit native/THIRD_PARTY_NOTICES.txt';
const SEAL = /^Sealed by scripts\/rust-notices\.js: generator sha256 ([0-9a-f]{64}), content sha256 ([0-9a-f]{64})\.$/;

/** Kinds of target whose output ships: what the shipped binaries are linked from starts at these. */
const SHIPPED_TARGET_KINDS = ['cdylib', 'bin', 'dylib', 'staticlib'];

const REASONS = {
  procMacro: 'a procedural macro: it runs inside the compiler while the binaries are built',
  buildScript: 'used by a build script, which runs while the binaries are built',
  buildOnly: 'used only by procedural macros or build scripts, while the binaries are built',
  devOnly: "used only by the workspace's tests and tools",
};

/* ───────────────────────────── small helpers ───────────────────────────── */

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ───────────────────────────── Cargo.lock ───────────────────────────── */

/**
 * The packages of a Cargo.lock (any version of the format cargo writes):
 * name, version, source (null for the workspace's own and other path
 * crates), checksum and the dependency strings.
 * @returns {{ packages: { name: string, version: string, source: string|null, checksum: string|null, dependencies: string[] }[] }}
 */
function parseCargoLock(text) {
  const packages = [];
  let current = null;
  let inDependencies = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim(); // and so a CRLF checkout reads the same
    if (inDependencies) {
      if (line.startsWith(']')) inDependencies = false;
      else for (const m of line.matchAll(/"([^"]*)"/g)) current.dependencies.push(m[1]);
      continue;
    }
    if (line.startsWith('[')) {
      current = line === '[[package]]' ? { name: null, version: null, source: null, checksum: null, dependencies: [] } : null;
      if (current) packages.push(current);
      continue;
    }
    const kv = current && /^([A-Za-z_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'dependencies') {
      const inline = /^\[(.*)\]$/.exec(value);
      if (inline) for (const m of inline[1].matchAll(/"([^"]*)"/g)) current.dependencies.push(m[1]);
      else if (value === '[') inDependencies = true;
      continue;
    }
    const str = /^"([^"]*)"$/.exec(value);
    if (str && (key === 'name' || key === 'version' || key === 'source' || key === 'checksum')) current[key] = str[1];
  }
  for (const p of packages) {
    if (!p.name || !p.version) throw new Error('Cargo.lock has a [[package]] without a name or a version');
  }
  return { packages };
}

/* ───────────────────────────── cargo metadata ───────────────────────────── */

/**
 * Which crates the shipped binaries contain. They are linked from the normal
 * dependencies of every workspace crate with a cdylib or bin target, on any
 * platform (a `cfg(windows)` dependency counts), never through a procedural
 * macro: a macro runs in the compiler, and so do the crates it uses. What a
 * linked crate reaches through a macro or a build dependency only runs while
 * the binaries are built; what nothing shipped reaches is the workspace's
 * tests and tools. The workspace's own crates are TreeMap's and are named
 * only.
 * @returns {{ own: string[], crates: { name: string, version: string, inBinaries: boolean, reason: string|null, licence: string|null, repository: string|null, dir: string, licenceFile: string|null, authors: string[] }[] }}
 */
function classify(metadata) {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const members = new Set(metadata.workspace_members);
  const deps = new Map(metadata.resolve.nodes.map((n) => [n.id, n.deps]));
  const depsOf = (id) => deps.get(id) ?? [];
  const isProcMacro = (pkg) => pkg.targets.some((t) => t.kind.includes('proc-macro'));
  const hasKind = (edge, kind) => edge.dep_kinds.some((k) => k.kind === kind);

  const linked = new Set();
  const queue = metadata.packages
    .filter((p) => members.has(p.id) && p.targets.some((t) => t.kind.some((k) => SHIPPED_TARGET_KINDS.includes(k))))
    .map((p) => p.id);
  while (queue.length > 0) {
    const id = queue.shift();
    const pkg = byId.get(id);
    if (linked.has(id) || !pkg || isProcMacro(pkg)) continue;
    linked.add(id);
    for (const edge of depsOf(id)) if (hasKind(edge, null)) queue.push(edge.pkg);
  }

  const buildTime = new Map();
  const buildQueue = [];
  for (const id of linked) {
    for (const edge of depsOf(id)) {
      if (linked.has(edge.pkg)) continue;
      if (hasKind(edge, 'build')) buildQueue.push([edge.pkg, 'buildScript']);
      else if (hasKind(edge, null)) buildQueue.push([edge.pkg, 'buildOnly']);
    }
  }
  while (buildQueue.length > 0) {
    const [id, how] = buildQueue.shift();
    const pkg = byId.get(id);
    if (linked.has(id) || buildTime.has(id) || !pkg) continue;
    buildTime.set(id, isProcMacro(pkg) ? 'procMacro' : how);
    for (const edge of depsOf(id)) if (hasKind(edge, null) || hasKind(edge, 'build')) buildQueue.push([edge.pkg, 'buildOnly']);
  }

  const own = metadata.packages.filter((p) => members.has(p.id)).map((p) => p.name).sort(byCodeUnits);
  const crates = metadata.packages
    .filter((p) => !members.has(p.id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      inBinaries: linked.has(p.id),
      reason: linked.has(p.id) ? null : REASONS[buildTime.get(p.id) ?? 'devOnly'],
      licence: p.license ?? null,
      repository: p.repository || p.homepage || null,
      dir: path.dirname(p.manifest_path),
      licenceFile: p.license_file ?? null,
      authors: Array.isArray(p.authors) ? p.authors : [],
    }))
    .sort(compareCrates);
  return { own, crates };
}

/* ───────────────────────────── licence texts ───────────────────────────── */

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|unlicense|copyright)(?:[-_.][A-Za-z0-9._-]*)?$/i;
const NOT_A_LICENCE = /\.(?:rs|toml|json|ya?ml|lock|sh|py|js|ts|c|h)$/i;
const LICENCE_FOLDER = /^licen[cs]es$/i;

/** The texts of `found` (title → file) in title order: verbatim, empty ones left out, and refused when one is not valid UTF-8. */
function readTexts(found, who) {
  return [...found.keys()]
    .sort(byCodeUnits)
    .map((title) => {
      const text = fs.readFileSync(found.get(title), 'utf8');
      if (text.includes(REPLACEMENT_CHARACTER)) {
        throw new Error(`${who}: ${title} is not valid UTF-8, so it cannot be copied word for word; a person must look at it`);
      }
      return { title, text: normaliseText(text) };
    })
    .filter((t) => t.text !== '');
}

/** The files of a folder, by name, or an empty map when there is no such folder. */
function filesIn(dir) {
  const found = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) if (entry.isFile()) found.set(entry.name, path.join(dir, entry.name));
  return found;
}

/**
 * A crate's licence texts and where they came from: every licence file its
 * package carries ('package'); or, when it carries none, the files a person
 * copied from its upstream repository into `upstreamDir`/<crate>/
 * ('upstream'); or else the standard text of each licence its expression
 * names ('standard', from `standardText(id)`, or null). Throws, naming the
 * crate, when its folder cannot be read, when it has no licence file and no
 * licence, or when a standard text is missing.
 * @returns {{ source: 'package'|'upstream'|'standard', texts: { title: string, text: string }[] }}
 */
function licenceTexts(crate, standardText, upstreamDir = null) {
  const who = `${crate.name} ${crate.version}`;
  let entries;
  try {
    entries = fs.readdirSync(crate.dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`${who}: its package folder ${crate.dir} cannot be read (${err.code || err.message}); is the crate in the local registry? (\`cargo fetch\` in native/treemap-core)`);
  }
  const found = new Map();
  for (const entry of entries) {
    if (LICENCE_FILE.test(entry.name) && !NOT_A_LICENCE.test(entry.name) && entry.isFile()) {
      found.set(entry.name, path.join(crate.dir, entry.name));
    } else if (LICENCE_FOLDER.test(entry.name) && entry.isDirectory()) {
      for (const [name, file] of filesIn(path.join(crate.dir, entry.name))) found.set(`${entry.name}/${name}`, file);
    }
  }
  if (crate.licenceFile) {
    const named = path.resolve(crate.dir, crate.licenceFile);
    if (![...found.values()].some((p) => path.resolve(p) === named)) {
      if (!fs.existsSync(named)) throw new Error(`${who}: its Cargo.toml names license-file ${crate.licenceFile}, which its package does not hold`);
      found.set(path.relative(crate.dir, named).split(path.sep).join('/'), named);
    }
  }
  const own = readTexts(found, who);
  if (own.length > 0) return { source: 'package', texts: own };

  const upstream = upstreamDir ? readTexts(filesIn(path.join(upstreamDir, crate.name)), who) : [];
  if (upstream.length > 0) return { source: 'upstream', texts: upstream };

  if (!crate.licence) {
    throw new Error(`${who}: its package holds no licence file and its Cargo.toml names no licence, so nothing says on what terms it may ship; a person must find out before it does`);
  }
  return {
    source: 'standard',
    texts: spdxIds(crate.licence).map((id) => {
      const text = standardText(id);
      if (text === null) {
        throw new Error(`${who}: its package holds no licence file, and the toolchain's share/doc/rust/licenses has no standard text of ${id} (its licence: ${crate.licence}) to stand in for one; a person must copy the crate's own licence text into ${UPSTREAM_TEXTS}/${crate.name}/`);
      }
      return { title: id, text: normaliseText(text) };
    }),
  };
}

/** The toolchain's standard licence texts, by SPDX id, or null. */
function standardTextsOf(sysroot) {
  const dir = path.join(sysroot, 'share', 'doc', 'rust', 'licenses');
  return (id) => {
    const file = path.join(dir, `${id}.txt`);
    return /^[A-Za-z0-9.+-]+$/.test(id) && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
}

/* ───────────────────────────── the Rust standard library ───────────────────────────── */

/**
 * The standard library's entries: the licences of its own files, the texts
 * of every licence they name, and — for each crates.io crate `stdList` says
 * the library is built from — the notices the toolchain records. Refuses a
 * missing list, a list that misses a crate the installed libraries carry, and
 * a crate the toolchain records nothing for.
 */
function rustEntry(channel, sysroot, standardText, stdList) {
  const doc = path.join(sysroot, 'share', 'doc', 'rust');
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(doc, name), 'utf8');
    } catch (err) {
      throw new Error(`the Rust ${channel} toolchain has no ${path.join(doc, name)} (${err.code || err.message}), which records the standard library's licences`);
    }
  };
  const library = read('COPYRIGHT-library.html');
  const files = parseStdCopyright(library);
  if (!stdList) {
    throw new Error(`scripts/rust-notices/toolchain.js has no STD_CRATES list for Rust ${channel}: read the crates.io crates its standard library is built from (the /rust/deps/<crate>-<version>/ paths in lib/rustlib/<target>/lib/*.rlib, and the toolchain's COPYRIGHT files) and add it`);
  }
  const { scanned, found } = stdCratesInSysroot(sysroot);
  if (scanned.length === 0) {
    throw new Error(`no standard library for ${SHIPPED_TARGETS.join(', ')} is installed under ${sysroot}, so nothing can check what it carries; \`rustup target add\` one of them`);
  }
  const listed = new Set(stdList.map((c) => `${c.name} ${c.version}`));
  const unlisted = [...found.keys()].filter((k) => !listed.has(k)).sort(byCodeUnits);
  if (unlisted.length > 0) {
    throw new Error(`Rust ${channel}'s standard library for ${scanned.join(', ')} carries ${unlisted.join(', ')}, which STD_CRATES in scripts/rust-notices/toolchain.js does not list; add them`);
  }
  const htmls = [library, read('COPYRIGHT.html')];
  const crates = stdList
    .map((c) => {
      const record = crateRecord(htmls, c.name, c.version);
      if (!record) throw new Error(`the Rust ${channel} toolchain records no notices for ${c.name} ${c.version}, which STD_CRATES lists; correct the list`);
      const texts = record.notices.map((n) => ({ title: n.title, text: normaliseText(n.text) })).filter((t) => t.text !== '');
      return { name: c.name, version: c.version, on: c.on, licence: record.licence, repository: record.url, texts };
    })
    .sort(compareCrates);
  const ids = [...new Set(['Apache-2.0', 'MIT', ...files.flatMap((f) => spdxIds(f.licence))])].sort(byCodeUnits);
  const texts = ids.map((id) => {
    const text = standardText(id);
    if (text === null) throw new Error(`the Rust ${channel} toolchain's share/doc/rust/licenses has no ${id}.txt, a licence its standard library names`);
    return { title: id, text: normaliseText(text) };
  });
  return { channel, files, texts, crates };
}

/* ───────────────────────────── the file ───────────────────────────── */

function textBlocks(texts) {
  return texts.flatMap((t) => [`---- ${t.title} ----`, '', t.text.replace(/\n$/, ''), '']);
}

const SOURCE_NOTES = {
  package: () => [],
  upstream: (c) => wrap(`The crate's package holds no licence file; the text below is its upstream repository's licence, which TreeMap's repository keeps in ${UPSTREAM_TEXTS}/${c.name}/.`),
  standard: () => wrap("The crate's package holds no licence file, so the standard text of each licence it names follows."),
};

function crateEntry(c) {
  const authors = (c.authors || []).map(authorName).filter(Boolean);
  const note = SOURCE_NOTES[c.source](c);
  return [
    RULER,
    `Crate: ${c.name} ${c.version}`,
    `In the binaries: ${c.inBinaries ? 'yes' : `no (${c.reason})`}`,
    `Licence: ${c.licence}`,
    `Repository: ${c.repository || 'none given in its Cargo.toml'}`,
    ...(c.source === 'standard' && authors.length > 0 ? [`Authors: ${authors.join(', ')}`] : []),
    RULER,
    '',
    ...(note.length > 0 ? [...note, ''] : []),
    ...textBlocks(c.texts),
  ];
}

function stdEntry(rust) {
  const files = rust.files.flatMap((f) => [`  ${f.path}`, `    Licence: ${f.licence}`, ...f.copyrights.map((c) => `    Copyright: ${c}`)]);
  return [
    RULER,
    `Rust standard library: ${rust.channel}`,
    'In the binaries: yes',
    'Licence: Apache-2.0 OR MIT',
    'Repository: https://github.com/rust-lang/rust',
    RULER,
    '',
    ...wrap(
      `Both binaries are compiled by Rust ${rust.channel}, the version native/treemap-core/rust-toolchain.toml pins, and contain parts of its standard library: core, alloc and std, and the crates.io crates std is built from, which follow this entry with the notices the toolchain records for them (share/doc/rust/COPYRIGHT-library.html and COPYRIGHT.html). The licence and copyright lines of the library's own files, as COPYRIGHT-library.html records them:`,
    ),
    '',
    ...files,
    '',
    ...wrap("Below are the texts of the licences named above, from the same toolchain's share/doc/rust/licenses/."),
    '',
    ...textBlocks(rust.texts),
  ];
}

function stdCrateEntry(c) {
  return [
    RULER,
    `Rust standard library crate: ${c.name} ${c.version}`,
    `In the binaries: yes, in the standard library on ${c.on}`,
    `Licence: ${c.licence}`,
    `Repository: ${c.repository || 'none recorded'}`,
    RULER,
    '',
    ...textBlocks(c.texts),
  ];
}

/**
 * The whole file but its seal, from a model: { own, crates: [{ name,
 * version, inBinaries, reason, licence, repository, authors, source, texts }],
 * rust: { channel, files, texts, crates: [{ name, version, on, licence,
 * repository, texts }] } }. The same model always renders the same bytes.
 */
function renderNotices(model) {
  const crates = [...model.crates].sort(compareCrates);
  const inBinaries = crates.filter((c) => c.inBinaries);
  const buildOnly = crates.filter((c) => !c.inBinaries);
  const title = 'TreeMap: third-party notices for the native scan core';
  const list = (cs) => (cs.length === 0 ? ['  (none)'] : pack(cs.map((c, i) => `${c.name} ${c.version}${i < cs.length - 1 ? ',' : ''}`), '  '));
  const lines = [
    title,
    '='.repeat(title.length),
    '',
    ...wrap(
      "TreeMap's native scan core is the module treemap_core.node and, on Windows, the helper tm-mft-helper.exe. Both are built from the Rust workspace native/treemap-core in TreeMap's repository, and both contain code written by others: the crates below and the Rust standard library. Each crate is listed with the licence texts its own package carries.",
    ),
    '',
    ...wrap(
      'Every crate in the workspace\'s Cargo.lock is here, with its licence texts, whether or not its code ends up in the binaries: "In the binaries: no" marks one that only runs while they are built, and "yes" means in the binaries of at least one platform, since a crate for one operating system\'s interfaces is linked on that one only.',
    ),
    '',
    `TreeMap's own crates: ${model.own.join(', ')}.`,
    ...wrap("They are TreeMap's, under its MIT licence (LICENSE in the repository)."),
    '',
    ...wrap('gdu, which TreeMap also bundles, carries its own licence: the app keeps it in its resources as gdu/LICENSE.md, beside this file.'),
    '',
    ...wrap("This file is written by scripts/rust-notices.js from Cargo.lock, cargo's metadata and the Rust toolchain, and sealed by its last line. Do not edit it by hand: tests/rustNotices.test.ts fails when it no longer matches Cargo.lock, the generator or its seal."),
    '',
    `In the binaries (${inBinaries.length}):`,
    ...list(inBinaries),
    '',
    `Used only to build them (${buildOnly.length}):`,
    ...list(buildOnly),
    '',
    `The Rust standard library (${model.rust.channel}) and the ${model.rust.crates.length} crates.io crates it is built from follow the crates.`,
    '',
    ...crates.flatMap(crateEntry),
    ...stdEntry(model.rust),
    ...[...model.rust.crates].sort(compareCrates).flatMap(stdCrateEntry),
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** The digest the seal names: of every generator file, read by `read(relativePath)`, line ends as LF. */
function generatorDigest(read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')) {
  return sha256(GENERATOR_FILES.map((rel) => `${rel}\n${String(read(rel)).replace(/\r\n?/g, '\n')}`).join('\n'));
}

/** `body` with its seal appended after a blank line: the generator's digest and the digest of `body` itself. */
function sealNotices(body, generator) {
  return `${body}\nSealed by scripts/rust-notices.js: generator sha256 ${generator}, content sha256 ${sha256(body)}.\n`;
}

/** What is wrong with a notices file's seal, given the digest of the generator as it is now; nothing when the file is the generator's, untouched. */
function sealProblems(notices, generator) {
  const text = String(notices).replace(/\r\n?/g, '\n');
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const m = SEAL.exec(lines.pop() ?? '');
  if (!m) return [`${NOTICES_PATH} does not end with its seal, so nothing shows the generator wrote it; ${REGENERATE}`];
  const problems = [];
  if (m[1] !== generator) {
    problems.push(`the generator (${GENERATOR_FILES.join(', ')}) has changed since it wrote ${NOTICES_PATH}; ${REGENERATE}`);
  }
  if (m[2] !== sha256(lines.join('\n'))) {
    problems.push(`${NOTICES_PATH} has been edited since the generator wrote it: its text no longer matches its seal. Never edit it by hand; ${REGENERATE}`);
  }
  return problems;
}

/**
 * What a notices file says: its crates (name, version, whether in the
 * binaries, licence, the titles of their texts), TreeMap's own crates (null
 * when the line is missing), and the standard library's entries.
 */
function parseNotices(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const crates = [];
  const rustCrates = [];
  let own = null;
  let rust = null;
  let entry = null;
  let state = 'top';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === RULER) {
      const next = lines[i + 1] ?? '';
      const crate = /^Crate: (\S+) (\S+)$/.exec(next) ?? /^Rust standard library crate: (\S+) (\S+)$/.exec(next);
      const std = /^Rust standard library: (\S+)$/.exec(next);
      if (crate || std) {
        entry = crate
          ? { name: crate[1], version: crate[2], inBinaries: null, licence: '', texts: [] }
          : { channel: std[1], inBinaries: null, licence: '', texts: [], files: [], textsBegun: false };
        if (std) rust = entry;
        else if (next.startsWith('Crate: ')) crates.push(entry);
        else rustCrates.push(entry);
        state = 'header';
        i += 1;
      } else if (state === 'header') {
        state = 'body';
      }
      continue;
    }
    if (state === 'top') {
      const m = /^TreeMap's own crates: (.+)\.$/.exec(line);
      if (m) own = m[1].split(', ');
    } else if (state === 'header') {
      const field = /^(In the binaries|Licence): (.*)$/.exec(line);
      if (field && field[1] === 'Licence') entry.licence = field[2];
      else if (field) entry.inBinaries = /^yes\b/.test(field[2]);
    } else {
      const heading = /^---- (.+) ----$/.exec(line);
      if (heading) {
        entry.texts.push(heading[1]);
        entry.textsBegun = true;
      } else if (entry === rust && !rust.textsBegun) {
        const file = /^ {2}(\S.*)$/.exec(line);
        const licence = /^ {4}Licence: (.+)$/.exec(line);
        if (file) rust.files.push({ path: file[1], licence: null });
        else if (licence && rust.files.length > 0) rust.files[rust.files.length - 1].licence = licence[1];
      }
    }
  }
  const strip = ({ name, version, inBinaries, licence, texts }) => ({ name, version, inBinaries, licence, texts });
  return {
    crates: crates.map(strip),
    own,
    rustChannel: rust ? rust.channel : null,
    rustLicence: rust ? rust.licence : null,
    rustFiles: rust ? rust.files : [],
    rustTexts: rust ? rust.texts : [],
    rustCrates: rustCrates.map(strip),
  };
}

/** The channel a rust-toolchain.toml pins, or null. */
function toolchainChannel(toml) {
  const m = /^\s*channel\s*=\s*"([^"]+)"/m.exec(String(toml));
  return m ? m[1] : null;
}

/**
 * Everything that makes a notices file stale, from Cargo.lock and
 * rust-toolchain.toml alone — no cargo, no registry, no network: a crate in
 * one and not the other, a crate at another version, a crate listed twice,
 * one of TreeMap's own crates come or gone, the toolchain moved on. Each
 * sentence names what differs and ends with `advice`; none means the file is
 * in step.
 */
function driftProblems({ lock, notices, toolchain }, advice = REGENERATE) {
  const problems = [];
  const locked = parseCargoLock(lock).packages;
  const parsed = parseNotices(notices);

  const seen = new Set();
  for (const c of parsed.crates) {
    const key = `${c.name} ${c.version}`;
    if (seen.has(key)) problems.push(`${key} is listed twice in ${NOTICES_PATH}; ${advice}`);
    seen.add(key);
  }

  const listed = (p) => seen.has(`${p.name} ${p.version}`);
  const lockCrates = locked.filter((p) => p.source !== null || listed(p));
  const lockOwn = [...new Set(locked.filter((p) => p.source === null && !listed(p)).map((p) => p.name))];
  const versionsByName = (list) => {
    const map = new Map();
    for (const p of list) map.set(p.name, [...new Set([...(map.get(p.name) ?? []), p.version])]);
    return map;
  };
  const inLock = versionsByName(lockCrates);
  const inFile = versionsByName(parsed.crates);
  for (const name of [...new Set([...inLock.keys(), ...inFile.keys()])].sort(byCodeUnits)) {
    const lockOnly = (inLock.get(name) ?? []).filter((v) => !(inFile.get(name) ?? []).includes(v)).sort(compareVersions);
    const fileOnly = (inFile.get(name) ?? []).filter((v) => !(inLock.get(name) ?? []).includes(v)).sort(compareVersions);
    if (lockOnly.length > 0 && fileOnly.length > 0) {
      problems.push(`${name}: Cargo.lock has ${lockOnly.join(', ')}, but ${NOTICES_PATH} has ${fileOnly.join(', ')}; ${advice}`);
    } else {
      for (const v of lockOnly) problems.push(`${name} ${v} is in Cargo.lock but not in ${NOTICES_PATH}; ${advice}`);
      for (const v of fileOnly) problems.push(`${name} ${v} is in ${NOTICES_PATH} but no longer in Cargo.lock; ${advice}`);
    }
  }

  if (parsed.own === null) {
    problems.push(`${NOTICES_PATH} has no "TreeMap's own crates:" line naming the workspace's own crates; ${advice}`);
  } else {
    for (const name of lockOwn.filter((n) => !parsed.own.includes(n)).sort(byCodeUnits)) {
      problems.push(`${name} is one of TreeMap's own crates in Cargo.lock, but ${NOTICES_PATH} does not name it; ${advice}`);
    }
    for (const name of parsed.own.filter((n) => !lockOwn.includes(n)).sort(byCodeUnits)) {
      problems.push(`${NOTICES_PATH} names ${name} as one of TreeMap's own crates, but Cargo.lock no longer has it; ${advice}`);
    }
  }

  const channel = toolchainChannel(toolchain);
  if (parsed.rustChannel === null) {
    problems.push(`${NOTICES_PATH} has no entry for the Rust standard library, which both binaries contain; ${advice}`);
  } else if (channel === null) {
    problems.push('native/treemap-core/rust-toolchain.toml pins no channel, so nothing says which standard library the binaries contain');
  } else if (channel !== parsed.rustChannel) {
    problems.push(`rust-toolchain.toml pins Rust ${channel}, but ${NOTICES_PATH} was written for Rust ${parsed.rustChannel}; ${advice}`);
  }
  return problems;
}

/** Every entry of a notices file whose licence permissive terms cannot meet — a person's decision, named. */
function licenceProblems(notices) {
  const parsed = parseNotices(notices);
  const decide = 'a person decides whether it may ship (scripts/rust-notices/spdx.js PERMISSIVE lists what ships without asking)';
  const problems = [];
  const check = (who, licence) => {
    if (!isPermissive(licence)) problems.push(`${who}: its licence, ${licence || 'none'}, cannot be met on permissive terms; ${decide}`);
  };
  for (const c of parsed.crates) check(`${c.name} ${c.version}`, c.licence);
  if (parsed.rustLicence !== null) check('the Rust standard library', parsed.rustLicence);
  for (const f of parsed.rustFiles) check(`the Rust standard library's ${f.path}`, f.licence);
  for (const c of parsed.rustCrates) check(`the Rust standard library's crate ${c.name} ${c.version}`, c.licence);
  return problems;
}

/* ───────────────────────────── main ───────────────────────────── */

/**
 * Writes the file, or with --check compares it, and answers the exit code.
 * `deps` stands in for the machine: { repo, metadata() (cargo's JSON),
 * sysroot() and rustVersion() (rustc's), stdCrates(channel) (the standard
 * library's crates.io crates; STD_CRATES when absent), out(line), err(line) }.
 */
function main(argv, deps) {
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    deps.err(`rust-notices: unknown argument ${unknown[0]}; the only one is --check`);
    return 2;
  }
  const check = argv.includes('--check');
  try {
    const workspace = path.join(deps.repo, WORKSPACE);
    const lock = fs.readFileSync(path.join(workspace, 'Cargo.lock'), 'utf8');
    const toolchain = fs.readFileSync(path.join(workspace, 'rust-toolchain.toml'), 'utf8');
    const channel = toolchainChannel(toolchain);
    if (!channel) throw new Error('native/treemap-core/rust-toolchain.toml pins no channel');
    const version = deps.rustVersion();
    if (/^\d+\.\d+\.\d+$/.test(channel) && version !== channel) {
      throw new Error(`rustc here is ${version}, but rust-toolchain.toml pins ${channel}; the notices name the standard library the binaries are built with, so run this where rustup gives the workspace ${channel}`);
    }
    const sysroot = deps.sysroot();
    const standardText = standardTextsOf(sysroot);
    const upstreamDir = path.join(deps.repo, ...UPSTREAM_TEXTS.split('/'));
    const classified = classify(deps.metadata());
    const crates = classified.crates.map((c) => {
      const { source, texts } = licenceTexts(c, standardText, upstreamDir);
      return {
        name: c.name, version: c.version, inBinaries: c.inBinaries, reason: c.reason,
        licence: c.licence ?? `none named; see ${c.licenceFile}`, repository: c.repository,
        authors: source === 'standard' ? c.authors : [], source, texts,
      };
    });
    const stdList = deps.stdCrates ? deps.stdCrates(channel) : STD_CRATES[channel];
    const rust = rustEntry(channel, sysroot, standardText, stdList);
    const text = sealNotices(renderNotices({ own: classified.own, crates, rust }), generatorDigest());

    const disagreement = "cargo's metadata and Cargo.lock should never disagree; `cargo metadata --format-version 1 --locked` in native/treemap-core shows what it reads";
    const drift = driftProblems({ lock, notices: text, toolchain }, disagreement).map((p) => `cargo's metadata and Cargo.lock disagree: ${p}`);
    const problems = [...licenceProblems(text), ...drift];
    if (problems.length > 0) {
      for (const p of problems) deps.err(`rust-notices: ${p}`);
      deps.err('rust-notices: nothing was written');
      return 1;
    }

    const file = path.join(deps.repo, ...NOTICES_PATH.split('/'));
    const ids = [...new Set([...crates, ...rust.crates].flatMap((c) => spdxIds(c.licence)))].sort(byCodeUnits);
    const summary = `${crates.filter((c) => c.inBinaries).length} crates in the binaries, ${crates.filter((c) => !c.inBinaries).length} used only to build them, ${rust.crates.length} in Rust ${channel}'s standard library; licences named: ${ids.join(', ')}`;
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
      if (current !== text) {
        deps.err(`rust-notices: ${NOTICES_PATH} is out of date; ${REGENERATE}`);
        return 1;
      }
      deps.err(`rust-notices: ${NOTICES_PATH} is current (${summary})`);
      return 0;
    }
    fs.writeFileSync(file, text);
    deps.err(`rust-notices: ${summary}`);
    deps.err(`rust-notices: wrote ${NOTICES_PATH} (${Buffer.byteLength(text)} bytes)`);
    deps.out(file);
    return 0;
  } catch (err) {
    deps.err(`rust-notices: ${err.message}`);
    deps.err('rust-notices: nothing was written');
    return 1;
  }
}

/** cargo and rustc, run in the workspace so rustup takes rust-toolchain.toml's version — and never installs one. */
function runInWorkspace(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: path.join(REPO, WORKSPACE),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
  });
  if (r.error) {
    throw new Error(r.error.code === 'ENOENT' ? `${cmd} is not on PATH; install Rust from https://rustup.rs` : `could not run ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

const MACHINE = {
  repo: REPO,
  metadata() {
    try {
      return JSON.parse(runInWorkspace('cargo', ['metadata', '--format-version', '1', '--offline', '--locked', '--all-features']));
    } catch (err) {
      throw new Error(`${err.message}\n(every crate's licence files are read from the local registry; \`cargo fetch\` in native/treemap-core puts them there, and is the one step that uses the network)`);
    }
  },
  sysroot: () => runInWorkspace('rustc', ['--print', 'sysroot']).trim(),
  rustVersion() {
    const m = /^rustc (\S+)/.exec(runInWorkspace('rustc', ['--version']));
    if (!m) throw new Error('rustc --version did not say its version');
    return m[1];
  },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), MACHINE);
} else {
  module.exports = {
    NOTICES_PATH,
    UPSTREAM_TEXTS,
    GENERATOR_FILES,
    PERMISSIVE,
    parseCargoLock,
    parseSpdx,
    spdxIds,
    isPermissive,
    classify,
    licenceTexts,
    parseStdCopyright,
    renderNotices,
    parseNotices,
    toolchainChannel,
    driftProblems,
    licenceProblems,
    generatorDigest,
    sealNotices,
    sealProblems,
    main,
  };
}
