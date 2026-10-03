import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-rustNotices-data-');

/**
 * The native core's third-party notices (v5.2.0, the first release that ships
 * the Rust module). treemap_core.node and, on Windows, tm-mft-helper.exe are
 * statically linked from the crates in native/treemap-core/Cargo.lock and from
 * Rust's standard library, and MIT and Apache-2.0 both ask for their notices
 * to travel with every binary copy. scripts/rust-notices.js writes them into
 * native/THIRD_PARTY_NOTICES.txt from cargo's metadata, the crates' own
 * licence files and the pinned toolchain's records (it needs cargo and the
 * local registry, so it runs on a developer's machine); electron-builder
 * ships that file in the app's resources.
 *
 * What keeps it from going stale is the first group here: it compares the
 * committed file with Cargo.lock, rust-toolchain.toml and the generator's own
 * source alone, so it runs offline on every CI leg with no cargo and no
 * registry. A crate added, removed or re-versioned without regenerating fails
 * it, naming the crate; so do a changed generator and an edit by hand (the
 * file's last line seals it). Every crate in Cargo.lock carries its licence
 * texts, whether or not it ends up in the binaries, so that guarantee does not
 * depend on how a Cargo.toml classifies a dependency.
 */

const REPO = path.join(__dirname, '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const BOM = String.fromCharCode(0xfeff);

type Source = 'package' | 'upstream' | 'standard';
interface LockPackage { name: string; version: string; source: string | null; checksum: string | null; dependencies: string[] }
interface LicenceText { title: string; text: string }
interface NoticeCrate { name: string; version: string; inBinaries: boolean; licence: string; texts: string[] }
interface ParsedNotices {
  crates: NoticeCrate[]; own: string[] | null; rustChannel: string | null; rustTexts: string[]; rustCrates: NoticeCrate[];
}
interface MetaTarget { name: string; kind: string[] }
interface MetaPackage {
  id: string; name: string; version: string; source: string | null; license: string | null; license_file: string | null;
  repository: string | null; homepage: string | null; authors: string[]; manifest_path: string; targets: MetaTarget[];
}
interface MetaDep { name: string; pkg: string; dep_kinds: { kind: 'dev' | 'build' | null; target: string | null }[] }
interface Metadata { packages: MetaPackage[]; workspace_members: string[]; resolve: { nodes: { id: string; deps: MetaDep[] }[] } }
interface ClassifiedCrate {
  name: string; version: string; inBinaries: boolean; reason: string | null; licence: string | null; repository: string | null;
  dir: string; licenceFile: string | null; authors: string[];
}
interface Classified { own: string[]; crates: ClassifiedCrate[] }
interface StdFile { path: string; licence: string; copyrights: string[] }
interface StdListed { name: string; version: string; on: string }
interface StdCrate extends StdListed { licence: string; repository: string | null; texts: LicenceText[] }
interface ModelCrate { name: string; version: string; inBinaries: boolean; reason: string | null; licence: string; repository: string | null; authors: string[]; source: Source; texts: LicenceText[] }
interface Model { own: string[]; crates: ModelCrate[]; rust: { channel: string; files: StdFile[]; texts: LicenceText[]; crates: StdCrate[] } }
interface MainDeps {
  repo: string;
  metadata(): Metadata;
  sysroot(): string;
  rustVersion(): string;
  stdCrates?(channel: string): StdListed[] | undefined;
  out(line: string): void;
  err(line: string): void;
}
interface RustNotices {
  NOTICES_PATH: string;
  UPSTREAM_TEXTS: string;
  GENERATOR_FILES: string[];
  parseCargoLock(text: string): { packages: LockPackage[] };
  spdxIds(expression: string): string[];
  isPermissive(expression: string): boolean;
  classify(metadata: Metadata): Classified;
  licenceTexts(crate: ClassifiedCrate, standardText: (id: string) => string | null, upstreamDir?: string | null): { source: Source; texts: LicenceText[] };
  parseStdCopyright(html: string): StdFile[];
  renderNotices(model: Model): string;
  parseNotices(text: string): ParsedNotices;
  driftProblems(texts: { lock: string; notices: string; toolchain: string }, advice?: string): string[];
  licenceProblems(notices: string): string[];
  generatorDigest(read?: (relativePath: string) => string): string;
  sealNotices(body: string, generator: string): string;
  sealProblems(notices: string, generator: string): string[];
  main(argv: string[], deps: MainDeps): number;
}
interface Toolchain {
  STD_CRATES: Record<string, StdListed[]>;
  stdCratesInSysroot(sysroot: string, targets?: string[]): { scanned: string[]; found: Map<string, Set<string>> };
  crateRecord(htmls: string[], name: string, version: string): { licence: string; url: string | null; notices: LicenceText[] } | null;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rn = require('../scripts/rust-notices.js') as RustNotices;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tc = require('../scripts/rust-notices/toolchain.js') as Toolchain;

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';
const REGENERATE = /node scripts\/rust-notices\.js/;
const realDigest = (): string => rn.generatorDigest((rel) => read(rel));

/* ═══════════════════ the committed file, held to Cargo.lock (offline, every CI leg) ═══════════════════ */

test('native/THIRD_PARTY_NOTICES.txt accounts for every crate in Cargo.lock at its version, names TreeMap\'s own crates and the pinned Rust', () => {
  const problems = rn.driftProblems({
    lock: read('native', 'treemap-core', 'Cargo.lock'),
    notices: read('native', 'THIRD_PARTY_NOTICES.txt'),
    toolchain: read('native', 'treemap-core', 'rust-toolchain.toml'),
  });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('native/THIRD_PARTY_NOTICES.txt is what the generator, as it is now, wrote: its seal matches the generator\'s source and its own text', () => {
  const problems = rn.sealProblems(read('native', 'THIRD_PARTY_NOTICES.txt'), realDigest());
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every third-party crate in Cargo.lock has its own entry, with at least one licence text, counted independently of the parser', () => {
  const lock = read('native', 'treemap-core', 'Cargo.lock').replace(/\r\n/g, '\n');
  const notices = read('native', 'THIRD_PARTY_NOTICES.txt').replace(/\r\n/g, '\n');
  const thirdParty = lock.split('[[package]]').filter((block) => /^source = "/m.test(block)).length;
  const headers = notices.match(/^={72}\nCrate: \S+ \S+$/gm) ?? [];
  assert.ok(thirdParty > 0, 'Cargo.lock has third-party crates');
  assert.equal(headers.length, thirdParty, `one "Crate:" entry per third-party package in Cargo.lock (${thirdParty})`);
  const parsed = rn.parseNotices(notices);
  for (const crate of [...parsed.crates, ...parsed.rustCrates]) {
    assert.ok(crate.texts.length >= 1, `${crate.name} ${crate.version} carries a licence text`);
    assert.notEqual(crate.licence, '', `${crate.name} ${crate.version} names its licence`);
  }
  assert.ok(parsed.rustChannel !== null && parsed.rustTexts.length >= 2, 'the Rust standard library has its entry, with its licence texts');
  assert.ok(parsed.rustCrates.length >= 1, 'and so do the crates.io crates it is built from');
});

test('every licence in the committed file can be met on permissive terms — a copyleft or unknown licence is a person\'s decision, never a silent one', () => {
  const problems = rn.licenceProblems(read('native', 'THIRD_PARTY_NOTICES.txt'));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the app carries the notices in its resources, beside gdu\'s licence, as the About panel says', () => {
  const pkg = JSON.parse(read('package.json')) as { build: { extraResources: { from: string; to: string }[] } };
  const extra = pkg.build.extraResources;
  const notices = extra.find((e) => e.from === rn.NOTICES_PATH);
  assert.ok(notices, `build.extraResources ships ${rn.NOTICES_PATH}: ${JSON.stringify(extra)}`);
  assert.equal(notices.to, 'THIRD_PARTY_NOTICES.txt', 'at the top of the app\'s resources folder (Contents/Resources on macOS, resources\\ on Windows)');
  assert.ok(fs.existsSync(path.join(REPO, notices.from)), `${notices.from} is committed, so a dist never packages without it`);
  assert.ok(extra.some((e) => e.from === 'build/gdu/LICENSE.md' && e.to === 'gdu/LICENSE.md'), 'gdu\'s licence still ships too');
  assert.equal(rn.NOTICES_PATH, 'native/THIRD_PARTY_NOTICES.txt');
});

/* ═══════════════════ drift: what each kind of stale file is told ═══════════════════ */

const TOOLCHAIN = '[toolchain]\nchannel = "1.98.1"\ncomponents = ["clippy", "rustfmt"]\n';

function lockBlock(name: string, version: string, source: string | null = REGISTRY, deps: string[] = []): string {
  const lines = ['[[package]]', `name = "${name}"`, `version = "${version}"`];
  if (source) lines.push(`source = "${source}"`, `checksum = "${'a'.repeat(64)}"`);
  if (deps.length > 0) lines.push('dependencies = [', ...deps.map((d) => ` "${d}",`), ']');
  return lines.join('\n');
}

function lockText(blocks: string[]): string {
  return ['# This file is automatically @generated by Cargo.', '# It is not intended for manual editing.', 'version = 4', '', ...blocks.flatMap((b) => [b, ''])].join('\n');
}

const BASE_BLOCKS = [
  lockBlock('alpha', '1.0.0'),
  lockBlock('app', '0.5.0', null, ['alpha', 'syn 2.0.1', 'syn 3.0.0']),
  lockBlock('syn', '2.0.1'),
  lockBlock('syn', '3.0.0'),
];

function modelCrate(name: string, version: string, inBinaries: boolean): ModelCrate {
  return {
    name, version, inBinaries, reason: inBinaries ? null : 'a procedural macro: it runs inside the compiler while the binaries are built',
    licence: 'MIT OR Apache-2.0', repository: `https://example.invalid/${name}`, authors: [], source: 'package',
    texts: [{ title: 'LICENSE-MIT', text: `Copyright (c) the ${name} authors\n\nPermission is hereby granted, free of charge.\n` }],
  };
}

function baseModel(): Model {
  return {
    own: ['app'],
    crates: [modelCrate('alpha', '1.0.0', true), modelCrate('syn', '2.0.1', false), modelCrate('syn', '3.0.0', false)],
    rust: {
      channel: '1.98.1',
      files: [{ path: '.', licence: 'Apache-2.0 OR MIT', copyrights: ['The Rust Project Developers (see https://thanks.rust-lang.org)'] }],
      texts: [{ title: 'Apache-2.0', text: 'Apache License\nVersion 2.0, January 2004\n' }, { title: 'MIT', text: 'MIT License\n' }],
      crates: [{
        name: 'hashbrown', version: '0.17.1', on: 'macOS, Windows and Linux', licence: 'MIT OR Apache-2.0',
        repository: 'https://crates.io/crates/hashbrown/0.17.1', texts: [{ title: 'LICENSE-MIT', text: "Copyright (c) 2016 Amanieu d'Antras\n" }],
      }],
    },
  };
}

const BASE_NOTICES = rn.renderNotices(baseModel());

test('drift: a file in step with Cargo.lock and the toolchain has nothing to say (the cases below start from it)', () => {
  assert.deepEqual(rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: BASE_NOTICES, toolchain: TOOLCHAIN }), []);
  assert.deepEqual(rn.driftProblems({ lock: lockText(BASE_BLOCKS).replace(/\n/g, '\r\n'), notices: BASE_NOTICES.replace(/\n/g, '\r\n'), toolchain: TOOLCHAIN }), [],
    'a CRLF checkout reads the same');
});

test('drift: a crate added to Cargo.lock without regenerating is named, with the command that fixes it', () => {
  const problems = rn.driftProblems({ lock: lockText([...BASE_BLOCKS, lockBlock('beta', '0.1.0')]), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /beta 0\.1\.0/);
  assert.match(problems[0], /Cargo\.lock/);
  assert.match(problems[0], REGENERATE);
});

test('drift: a crate removed from Cargo.lock is named as still listed', () => {
  const problems = rn.driftProblems({ lock: lockText(BASE_BLOCKS.filter((b) => !b.includes('"alpha"\nversion'))), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /alpha 1\.0\.0/);
  assert.match(problems[0], /no longer in Cargo\.lock/);
  assert.match(problems[0], REGENERATE);
});

test('drift: a re-versioned crate is named with both versions — and of two versions of one crate, only the one that moved', () => {
  const bumped = rn.driftProblems({ lock: lockText([lockBlock('alpha', '1.0.1'), ...BASE_BLOCKS.slice(1)]), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(bumped.length, 1, bumped.join('\n'));
  assert.match(bumped[0], /alpha/);
  assert.match(bumped[0], /1\.0\.1/);
  assert.match(bumped[0], /1\.0\.0/);
  assert.match(bumped[0], REGENERATE);
  const syn = rn.driftProblems({ lock: lockText([...BASE_BLOCKS.slice(0, 3), lockBlock('syn', '3.0.1')]), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(syn.length, 1, syn.join('\n'));
  assert.match(syn[0], /syn/);
  assert.match(syn[0], /3\.0\.1/);
  assert.match(syn[0], /3\.0\.0/);
  assert.doesNotMatch(syn[0], /2\.0\.1/, 'syn 2.0.1 did not move');
});

test('drift: a TreeMap crate added to or gone from the workspace is named; a native version bump changes nothing', () => {
  const added = rn.driftProblems({ lock: lockText([...BASE_BLOCKS, lockBlock('tm-extra', '0.5.0', null)]), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(added.length, 1, added.join('\n'));
  assert.match(added[0], /tm-extra/);
  assert.match(added[0], REGENERATE);
  const gone = rn.driftProblems({ lock: lockText(BASE_BLOCKS.filter((b) => !b.includes('"app"'))), notices: BASE_NOTICES, toolchain: TOOLCHAIN });
  assert.equal(gone.length, 1, gone.join('\n'));
  assert.match(gone[0], /app/);
  const bump = lockText([BASE_BLOCKS[0], lockBlock('app', '0.6.0', null, ['alpha', 'syn 2.0.1', 'syn 3.0.0']), ...BASE_BLOCKS.slice(2)]);
  assert.deepEqual(rn.driftProblems({ lock: bump, notices: BASE_NOTICES, toolchain: TOOLCHAIN }), [],
    'TreeMap\'s own crates are named without versions, so bumping nativeVersion never needs a regeneration');
});

test('drift: a Rust toolchain bump without regenerating is named with both versions', () => {
  const problems = rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: BASE_NOTICES, toolchain: TOOLCHAIN.replace('1.98.1', '1.99.0') });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /1\.99\.0/);
  assert.match(problems[0], /1\.98\.1/);
  assert.match(problems[0], REGENERATE);
  const unpinned = rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: BASE_NOTICES, toolchain: '[toolchain]\ncomponents = ["clippy"]\n' });
  assert.equal(unpinned.length, 1, unpinned.join('\n'));
  assert.match(unpinned[0], /pins no channel/, 'a toolchain file that pins nothing is named, not read as a match');
});

test('drift: a file with a crate listed twice, without its own-crates line or without the standard library is refused', () => {
  const twice = BASE_NOTICES + BASE_NOTICES.slice(BASE_NOTICES.indexOf(`${'='.repeat(72)}\nCrate: alpha`), BASE_NOTICES.indexOf(`${'='.repeat(72)}\nCrate: syn 2.0.1`));
  const dup = rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: twice, toolchain: TOOLCHAIN });
  assert.equal(dup.length, 1, dup.join('\n'));
  assert.match(dup[0], /alpha 1\.0\.0/);
  assert.match(dup[0], /twice/);
  const noOwn = rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: BASE_NOTICES.replace(/^TreeMap's own crates: .*$/m, ''), toolchain: TOOLCHAIN });
  assert.ok(noOwn.some((p) => /own crates/.test(p)), noOwn.join('\n'));
  const noRust = rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: BASE_NOTICES.replace(/^Rust standard library: .*$/m, ''), toolchain: TOOLCHAIN });
  assert.ok(noRust.some((p) => /standard library/.test(p)), noRust.join('\n'));
});

/* ═══════════════════ the seal: a changed generator or an edit by hand ═══════════════════ */

test('the seal: a sealed file passes; an edit to its text, a changed generator or a missing seal is named, with the command that fixes it', () => {
  const generator = 'a'.repeat(64);
  const sealed = rn.sealNotices(BASE_NOTICES, generator);
  assert.ok(sealed.startsWith(BASE_NOTICES) && sealed.endsWith('.\n'), 'the seal is one line after the text');
  assert.deepEqual(rn.sealProblems(sealed, generator), []);
  assert.deepEqual(rn.sealProblems(sealed.replace(/\n/g, '\r\n'), generator), [], 'a CRLF checkout reads the same');
  assert.deepEqual(rn.driftProblems({ lock: lockText(BASE_BLOCKS), notices: sealed, toolchain: TOOLCHAIN }), [], 'and the drift check reads past it');

  const edited = rn.sealProblems(sealed.replace('Copyright (c) the alpha authors', 'Copyright (c) someone else'), generator);
  assert.equal(edited.length, 1, edited.join('\n'));
  assert.match(edited[0], /edited/);
  assert.match(edited[0], REGENERATE);
  const moved = rn.sealProblems(sealed, 'b'.repeat(64));
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0], /generator/);
  assert.match(moved[0], /scripts\/rust-notices\/toolchain\.js/, 'naming every file of the generator');
  assert.match(moved[0], REGENERATE);
  const unsealed = rn.sealProblems(BASE_NOTICES, generator);
  assert.equal(unsealed.length, 1, unsealed.join('\n'));
  assert.match(unsealed[0], /seal/);
});

test('generatorDigest covers every file of the generator, line ends as LF', () => {
  const files: Record<string, string> = {
    'scripts/rust-notices.js': 'main\n', 'scripts/rust-notices/spdx.js': 'spdx\n', 'scripts/rust-notices/text.js': 'text\n', 'scripts/rust-notices/toolchain.js': 'toolchain\n',
  };
  assert.deepEqual(rn.GENERATOR_FILES, Object.keys(files));
  const digest = rn.generatorDigest((rel) => files[rel]);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(rn.generatorDigest((rel) => files[rel].replace(/\n/g, '\r\n')), digest, 'a CRLF checkout digests the same');
  for (const rel of Object.keys(files)) {
    assert.notEqual(rn.generatorDigest((r) => (r === rel ? `${files[r]}// changed\n` : files[r])), digest, `${rel} is part of the digest`);
  }
});

/* ═══════════════════ the generator's parts (no cargo, no registry) ═══════════════════ */

test('parseCargoLock reads every package, with or without a source, and its dependencies', () => {
  const lock = rn.parseCargoLock(lockText(BASE_BLOCKS).replace(/\n/g, '\r\n'));
  assert.deepEqual(lock.packages.map((p) => `${p.name} ${p.version} ${p.source === null ? 'local' : 'registry'}`),
    ['alpha 1.0.0 registry', 'app 0.5.0 local', 'syn 2.0.1 registry', 'syn 3.0.0 registry']);
  assert.deepEqual(lock.packages[1].dependencies, ['alpha', 'syn 2.0.1', 'syn 3.0.0']);
  assert.equal(lock.packages[0].checksum, 'a'.repeat(64));
  const one = rn.parseCargoLock('version = 4\n\n[[package]]\nname = "x"\nversion = "1.0.0"\ndependencies = ["y"]\n\n[[package]]\nname = "y"\nversion = "2.0.0"\n');
  assert.deepEqual(one.packages.map((p) => [p.name, p.dependencies]), [['x', ['y']], ['y', []]], 'a one-line dependencies array');
  assert.throws(() => rn.parseCargoLock('[[package]]\nversion = "1.0.0"\n'), /without a name/, 'a package it cannot name is refused, never skipped');
});

test('SPDX: the ids an expression names, and whether permissive terms can meet it', () => {
  assert.deepEqual(rn.spdxIds('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Apache-2.0', 'Unicode-3.0']);
  assert.deepEqual(rn.spdxIds('MIT/Apache-2.0'), ['MIT', 'Apache-2.0'], 'the legacy slash is OR');
  assert.deepEqual(rn.spdxIds('Apache-2.0 WITH LLVM-exception OR MIT'), ['Apache-2.0', 'LLVM-exception', 'MIT']);
  for (const ok of ['MIT', 'Apache-2.0 OR MIT', 'Unlicense OR MIT', 'ISC', '(MIT OR Apache-2.0) AND Unicode-3.0', 'MIT OR GPL-3.0-only',
    'Apache-2.0 WITH LLVM-exception', 'BSD-2-Clause AND (Apache-2.0 OR MIT)', 'MIT OR Apache-2.0 OR LGPL-2.1-or-later']) {
    assert.equal(rn.isPermissive(ok), true, ok);
  }
  for (const no of ['GPL-3.0-only', 'MIT AND GPL-2.0-only', 'LGPL-2.1-or-later', 'MPL-2.0', 'LicenseRef-Proprietary', '(MIT OR Apache-2.0) AND AGPL-3.0-only']) {
    assert.equal(rn.isPermissive(no), false, no);
  }
  for (const bad of ['', 'MIT OR', '(MIT', 'MIT) OR (Apache-2.0', 'AND MIT', 'MIT Apache-2.0']) {
    assert.equal(rn.isPermissive(bad), false, `"${bad}" does not parse, so nothing vouches for it`);
    assert.throws(() => rn.spdxIds(bad), /licence expression/, `"${bad}" is refused by name`);
  }
});

interface PackageOpts {
  kinds?: string[]; member?: boolean; dir?: string; license?: string | null; license_file?: string | null;
  repository?: string | null; homepage?: string | null; authors?: string[];
}

/** A package as `cargo metadata` describes it; `dir` is the folder its Cargo.toml is in. */
function metaPackage(name: string, version: string, opts: PackageOpts = {}): MetaPackage {
  const member = opts.member ?? false;
  const dir = opts.dir ?? (member ? `/ws/crates/${name}` : `/registry/${name}-${version}`);
  return {
    id: member ? `path+file:///ws/crates/${name}#${version}` : `${REGISTRY}#${name}@${version}`,
    name, version, source: member ? null : REGISTRY, license: opts.license === undefined ? 'MIT' : opts.license, license_file: opts.license_file ?? null,
    repository: opts.repository === undefined ? `https://example.invalid/${name}` : opts.repository, homepage: opts.homepage ?? null, authors: opts.authors ?? [],
    manifest_path: path.join(dir, 'Cargo.toml'),
    targets: (opts.kinds ?? ['lib']).map((k) => ({ name: name.replace(/-/g, '_'), kind: [k] })),
  };
}

/** A metadata object from packages and edges [from, to, kinds], as `cargo metadata --format-version 1` shapes it. */
function metadataOf(packages: MetaPackage[], edges: [string, string, ('dev' | 'build' | null)[], string?][]): Metadata {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const node = (p: MetaPackage) => ({
    id: p.id,
    deps: edges.filter(([from]) => from === p.name).map(([, to, kinds, target]) => ({
      name: to.replace(/-/g, '_'), pkg: byName.get(to)!.id, dep_kinds: kinds.map((kind) => ({ kind, target: target ?? null })),
    })),
  });
  return { packages, workspace_members: packages.filter((p) => p.source === null).map((p) => p.id), resolve: { nodes: packages.map(node) } };
}

const CLASSIFY_FIXTURE = metadataOf(
  [
    metaPackage('app', '0.5.0', { member: true, kinds: ['cdylib'] }),
    metaPackage('helper', '0.5.0', { member: true, kinds: ['lib', 'bin'] }),
    metaPackage('corelib', '0.5.0', { member: true }),
    metaPackage('tool', '0.5.0', { member: true }),
    metaPackage('alpha', '1.0.0'),
    metaPackage('winonly', '0.61.2'),
    metaPackage('macro', '3.3.0', { kinds: ['proc-macro'] }),
    metaPackage('syn', '2.0.1'),
    metaPackage('shared', '1.0.0'),
    metaPackage('builder', '2.2.4'),
    metaPackage('both', '1.0.0'),
    metaPackage('fromhelper', '1.0.0'),
    metaPackage('fromcore', '1.0.0'),
    metaPackage('testonly', '1.0.0'),
    metaPackage('toolonly', '1.0.0'),
  ],
  [
    ['app', 'corelib', [null]],
    ['app', 'alpha', [null]],
    ['alpha', 'winonly', [null], 'cfg(windows)'],
    ['app', 'macro', [null]],
    ['macro', 'syn', [null]],
    ['macro', 'shared', [null]],
    ['alpha', 'shared', [null]],
    ['app', 'builder', ['build']],
    ['app', 'both', [null, 'build']],
    ['helper', 'fromhelper', [null]],
    ['corelib', 'fromcore', [null]],
    ['corelib', 'testonly', ['dev']],
    ['tool', 'toolonly', [null]],
  ],
);

test('classify: what the shipped binaries link — normal dependencies of every cdylib and bin, on any platform, not through a procedural macro', () => {
  const c = rn.classify(CLASSIFY_FIXTURE);
  assert.deepEqual(c.own, ['app', 'corelib', 'helper', 'tool'], 'the workspace\'s own crates, named only');
  const role = Object.fromEntries(c.crates.map((k) => [k.name, k.inBinaries]));
  assert.deepEqual(role, {
    alpha: true, winonly: true, shared: true, both: true, fromhelper: true, fromcore: true,
    macro: false, syn: false, builder: false, testonly: false, toolonly: false,
  });
  const reason = Object.fromEntries(c.crates.map((k) => [k.name, k.reason]));
  assert.equal(reason.alpha, null);
  assert.match(reason.macro!, /procedural macro/);
  assert.match(reason.syn!, /procedural macros or build scripts/);
  assert.match(reason.builder!, /build script/);
  assert.doesNotMatch(reason.builder!, /procedural/);
  assert.match(reason.testonly!, /tests and tools/);
  assert.match(reason.toolonly!, /tests and tools/);
  const alpha = c.crates.find((k) => k.name === 'alpha')!;
  assert.equal(alpha.dir, path.join('/registry/alpha-1.0.0'));
  assert.equal(alpha.licence, 'MIT');
  assert.equal(alpha.repository, 'https://example.invalid/alpha');
});

test('classify: crates come in a fixed order — by name in code-unit order, then by version as numbers, never by the machine\'s locale', () => {
  const c = rn.classify(metadataOf(
    [
      metaPackage('app', '0.5.0', { member: true, kinds: ['cdylib'] }),
      metaPackage('zeta', '1.0.0'), metaPackage('syn', '3.0.6'), metaPackage('syn', '2.0.119'), metaPackage('syn', '2.0.9'),
      metaPackage('Upper', '1.0.0'), metaPackage('a-b', '1.0.0'), metaPackage('a_b', '1.0.0'),
    ],
    [['app', 'zeta', [null]], ['app', 'syn', [null]], ['app', 'Upper', [null]], ['app', 'a-b', [null]], ['app', 'a_b', [null]]],
  ));
  assert.deepEqual(c.crates.map((k) => `${k.name} ${k.version}`), ['Upper 1.0.0', 'a-b 1.0.0', 'a_b 1.0.0', 'syn 2.0.9', 'syn 2.0.119', 'syn 3.0.6', 'zeta 1.0.0']);
});

function crateDir(files: Record<string, string | Buffer>): string {
  const dir = fileTempDir('treemap-rust-notices-crate-');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function classified(dir: string, extra: Partial<ClassifiedCrate> = {}): ClassifiedCrate {
  return { name: 'demo', version: '1.2.3', inBinaries: true, reason: null, licence: 'MIT OR Apache-2.0', repository: null, dir, licenceFile: null, authors: [], ...extra };
}

const NO_STANDARD = (): string | null => null;

test('licenceTexts: every LICENSE*, COPYING*, NOTICE*, UNLICENSE* and COPYRIGHT* the package carries, verbatim, in name order — nothing else', () => {
  const dir = crateDir({
    'LICENSE-MIT': `${BOM}Copyright (c) 2016 Someone\r\n\r\nPermission is hereby granted.\r\n\r\n\r\n`,
    'LICENSE-APACHE': 'Apache License\n   Version 2.0\n',
    'NOTICE': 'This product includes software developed by Someone.\n',
    'COPYING': 'Dual-licensed.\n',
    'UNLICENSE': 'This is free and unencumbered software.\n',
    'COPYRIGHT': 'Copyright notices.\n',
    'license-apache-2.0': 'lower-case Apache text\n',
    'LICENSES/MIT.txt': 'REUSE layout MIT text\n',
    'README.md': 'readme\n',
    'Cargo.toml': '[package]\n',
    'license.rs': 'pub fn license() {}\n',
    'src/LICENSE-in-src': 'not at the top\n',
  });
  const r = rn.licenceTexts(classified(dir), NO_STANDARD);
  assert.equal(r.source, 'package');
  assert.deepEqual(r.texts.map((t) => t.title), ['COPYING', 'COPYRIGHT', 'LICENSE-APACHE', 'LICENSE-MIT', 'LICENSES/MIT.txt', 'NOTICE', 'UNLICENSE', 'license-apache-2.0']);
  const mit = r.texts.find((t) => t.title === 'LICENSE-MIT')!;
  assert.equal(mit.text, 'Copyright (c) 2016 Someone\n\nPermission is hereby granted.\n', 'the BOM, CRLF and trailing blank lines go; every word stays');
  assert.equal(r.texts.find((t) => t.title === 'LICENSE-APACHE')!.text, 'Apache License\n   Version 2.0\n', 'indentation stays');
});

test('licenceTexts: a licence file that is not valid UTF-8 is refused by name — "verbatim" stays true', () => {
  const dir = crateDir({ LICENSE: Buffer.from([0x4d, 0x49, 0x54, 0x20, 0xff, 0xfe, 0x0a]) });
  assert.throws(() => rn.licenceTexts(classified(dir), NO_STANDARD), /demo 1\.2\.3: LICENSE is not valid UTF-8/);
});

test('licenceTexts: a license-file the Cargo.toml names is included once, wherever it lives in the package', () => {
  const dir = crateDir({ 'legal/TERMS.txt': 'Custom terms.\n', 'LICENSE': 'MIT text\n' });
  const r = rn.licenceTexts(classified(dir, { licence: null, licenceFile: 'legal/TERMS.txt' }), NO_STANDARD);
  assert.deepEqual(r.texts.map((t) => t.title), ['LICENSE', 'legal/TERMS.txt']);
  const named = rn.licenceTexts(classified(dir, { licenceFile: 'LICENSE' }), NO_STANDARD);
  assert.deepEqual(named.texts.map((t) => t.title), ['LICENSE'], 'not twice');
  assert.throws(() => rn.licenceTexts(classified(dir, { licenceFile: 'missing.txt' }), NO_STANDARD), /demo 1\.2\.3.*license-file missing\.txt/s,
    'a license-file its package does not hold is named, never skipped');
});

test('licenceTexts: a package with no licence file gets the standard text of each licence it names, says so, and names its authors without their e-mail', () => {
  const dir = crateDir({ 'README.md': 'no licence here\n' });
  const asked: string[] = [];
  const standard = (id: string): string | null => { asked.push(id); return id === 'MIT' ? 'MIT License\n\nCopyright (c) <year> <copyright holders>\n' : null; };
  const r = rn.licenceTexts(classified(dir, { licence: 'MIT', authors: ['LongYinan <lynweklm@gmail.com>', 'Second Author'] }), standard);
  assert.equal(r.source, 'standard');
  assert.deepEqual(r.texts.map((t) => t.title), ['MIT']);
  assert.match(r.texts[0].text, /^MIT License/);
  assert.deepEqual(asked, ['MIT']);
  const model = baseModel();
  model.crates = [{ ...modelCrate('demo', '1.2.3', true), licence: 'MIT', source: 'standard', authors: ['LongYinan <lynweklm@gmail.com>', 'Second Author'], texts: r.texts }];
  const text = rn.renderNotices(model);
  assert.match(text, /no licence file/i, 'the entry says the text is the standard one');
  assert.match(text, /Authors: LongYinan, Second Author/);
  assert.doesNotMatch(text, /lynweklm/, 'no e-mail address is copied into the app');
  const empty = rn.licenceTexts(classified(crateDir({ LICENSE: '\n\n' }), { licence: 'MIT' }), standard);
  assert.equal(empty.source, 'standard', 'an empty LICENSE file is no licence text: the standard one stands in');
  assert.match(empty.texts[0].text, /^MIT License/);
});

test('licenceTexts: the upstream licence a person copied into native/licence-texts/<crate>/ stands in for a package without one, before any standard text', () => {
  const upstream = crateDir({ 'demo/LICENSE': 'MIT License\n\nCopyright (c) 2020-present The Demo Authors\n', 'other/LICENSE': 'not this crate\n' });
  const bare = crateDir({ 'README.md': 'no licence here\n' });
  const r = rn.licenceTexts(classified(bare, { licence: 'MIT' }), () => 'standard MIT\n', upstream);
  assert.equal(r.source, 'upstream');
  assert.deepEqual(r.texts, [{ title: 'LICENSE', text: 'MIT License\n\nCopyright (c) 2020-present The Demo Authors\n' }]);
  const own = rn.licenceTexts(classified(crateDir({ LICENSE: 'the package\'s own\n' })), NO_STANDARD, upstream);
  assert.equal(own.source, 'package', 'a package that carries its licence keeps it');
  const model = baseModel();
  model.crates = [{ ...modelCrate('demo', '1.2.3', true), licence: 'MIT', source: 'upstream', texts: r.texts }];
  const text = rn.renderNotices(model);
  assert.match(text, /upstream repository's licence, which TreeMap's repository keeps in\s+native\/licence-texts\/demo\//);
  assert.equal(rn.UPSTREAM_TEXTS, 'native/licence-texts');
});

test('licenceTexts: a package with no licence file and a licence with no standard text, or with no licence at all, stops the generator by name', () => {
  const dir = crateDir({});
  assert.throws(() => rn.licenceTexts(classified(dir, { licence: 'Zlib' }), NO_STANDARD), /demo 1\.2\.3.*Zlib.*native\/licence-texts\/demo\//s);
  assert.throws(() => rn.licenceTexts(classified(dir, { licence: null }), NO_STANDARD), /demo 1\.2\.3/);
  const missing = path.join(dir, 'gone');
  assert.throws(() => rn.licenceTexts(classified(missing), NO_STANDARD), /demo 1\.2\.3/, 'a package folder that is not there is not "no licence files"');
});

const STD_HTML = `<h2 id="in-tree-files">In-tree files</h2>
<p>The following licenses cover the in-tree source files that were used in this release:</p>
<div style="border:1px solid black; padding: 5px;">
    <p>
    <b>File/Directory:</b> <code>.</code>
    </p>
    <p><b>License:</b> Apache-2.0 OR MIT</p>
    <p><b>Copyright:</b> The Rust Project Developers (see https://thanks.rust-lang.org)</p>
    <p><b>Exceptions:</b></p>
<div style="border:1px solid black; padding: 5px;">
    <p>
    <b>File/Directory:</b> <code>library/core/src/unicode</code>
    </p>
    <p><b>License:</b> Unicode-3.0</p>
    <p><b>Copyright:</b> 1991-2024 Unicode, Inc</p>
    <p><b>Exceptions:</b></p>
<div style="border:1px solid black; padding: 5px;">
    <p>
    <b>File/Directory:</b> <code>mod.rs</code>
    </p>
    <p><b>License:</b> Apache-2.0 OR MIT</p>
    <p><b>Copyright:</b> The Rust Project Developers (see https://thanks.rust-lang.org)</p>
</div>
</div>
<div style="border:1px solid black; padding: 5px;">
    <p>
    <b>File/Directory:</b> <code>library/backtrace</code>
    </p>
    <p><b>License:</b> Apache-2.0 OR MIT</p>
    <p><b>Copyright:</b> 2014 Alex Crichton &amp; the backtrace authors &#40;see AUTHORS&#41;</p>
    <p><b>Copyright:</b> The Rust Project Developers (see https://thanks.rust-lang.org)</p>
</div>
</div>
<h2 id="out-of-tree-dependencies">Out-of-tree dependencies</h2>
<h3>📦 aho-corasick-1.1.4</h3>
<p><b>License:</b> Unlicense OR MIT</p>`;

test('parseStdCopyright: the standard library\'s own files, their licences and every copyright line, with nested paths spelled out', () => {
  assert.deepEqual(rn.parseStdCopyright(STD_HTML), [
    { path: '.', licence: 'Apache-2.0 OR MIT', copyrights: ['The Rust Project Developers (see https://thanks.rust-lang.org)'] },
    { path: 'library/core/src/unicode', licence: 'Unicode-3.0', copyrights: ['1991-2024 Unicode, Inc'] },
    { path: 'library/core/src/unicode/mod.rs', licence: 'Apache-2.0 OR MIT', copyrights: ['The Rust Project Developers (see https://thanks.rust-lang.org)'] },
    { path: 'library/backtrace', licence: 'Apache-2.0 OR MIT', copyrights: ['2014 Alex Crichton & the backtrace authors (see AUTHORS)', 'The Rust Project Developers (see https://thanks.rust-lang.org)'] },
  ]);
  assert.throws(() => rn.parseStdCopyright('<html><body>something else</body></html>'), /In-tree files/);
  assert.throws(() => rn.parseStdCopyright('<h2 id="in-tree-files">In-tree files</h2>\n<p>nothing here</p>'), /lists no file/);
  assert.throws(() => rn.parseStdCopyright(STD_HTML.replace(/<p><b>License:<\/b> Unicode-3\.0<\/p>/, '')), /library\/core\/src\/unicode/, 'an entry without a licence is refused by name');
  const IN_TREE = '<h2 id="in-tree-files">In-tree files</h2>\n';
  assert.deepEqual(rn.parseStdCopyright(`${IN_TREE}<b>File/Directory:</b> <code>.</code>\n<p><b>License:</b> MIT</p>\n<p><b>Copyright:</b> &#x41;da &lt;ada&gt; &quot;A&quot; &apos;B&apos; &copy; &unknownname;</p>`), [
    { path: '.', licence: 'MIT', copyrights: [`Ada <ada> "A" 'B' ${String.fromCharCode(0xa9)} &unknownname;`] },
  ], 'an entry outside any box still counts; character references decode, and one it does not know stays as written');
  assert.throws(() => rn.parseStdCopyright(`${IN_TREE}<p><b>License:</b> MIT</p>\n<b>File/Directory:</b> <code>.</code>`), /before any file/,
    'a licence line that belongs to no file means the layout changed: refused, never dropped');
  assert.throws(() => rn.parseStdCopyright(STD_HTML.replace('1991-2024 Unicode, Inc', '1991-2024 <a href="https://unicode.org">Unicode, Inc</a>')), /Copyright.*cannot read/,
    'a copyright line with markup in it is refused, never dropped');
});

const COPYRIGHT_HTML = `<h2>Out-of-tree dependencies</h2>
    <h3>📦 hashbrown-0.16.1</h3>
    <p><b>License:</b> MIT OR Apache-2.0</p>
        <p><b>Notices:</b>
            <details><summary><code>LICENSE-MIT</code></summary>
                <pre>an older version's text</pre></details>
    <h3>📦 hashbrown-0.17.10</h3>
    <p><b>License:</b> MIT</p>
            <details><summary><code>LICENSE-MIT</code></summary>
                <pre>a later version's text, whose number starts with 0.17.1</pre></details>
    <h3>📦 hashbrown-0.17.1</h3>
    <p><b>URL:</b> <a href="https://crates.io/crates/hashbrown/0.17.1">https://crates.io/crates/hashbrown/0.17.1</a></p>
    <p><b>In libstd:</b>  Yes </p>
    <p><b>Authors:</b> Amanieu d&#39;Antras &#60;amanieu@example.invalid&#62;</p>
    <p><b>License:</b> MIT OR Apache-2.0</p>
        <p><b>Notices:</b>
            <details>
                <summary><code>LICENSE-APACHE</code></summary>
                <pre>
                              Apache License
   &#34;License&#34; shall mean the terms
                </pre>
            </details>
            <details>
                <summary><code>LICENSE-MIT</code></summary>
                <pre>Copyright (c) 2016 Amanieu d&#39;Antras
</pre>
            </details>
    <h3>📦 nolicence-1.0.0</h3>
    <p><b>Authors:</b> Someone</p>
    <h3>📦 halfread-1.0.0</h3>
    <p><b>License:</b> MIT</p>
            <details><summary><code>LICENSE</code> (see below)</summary><pre>text</pre></details>
            <details><summary><code>NOTICE</code></summary><pre>text</pre></details>
`;

test('crateRecord: what the toolchain records for one crate at one version — licence, URL and every notice — from the first file that has it', () => {
  const r = tc.crateRecord(['<html>nothing about it</html>', COPYRIGHT_HTML], 'hashbrown', '0.17.1');
  assert.ok(r);
  assert.equal(r.licence, 'MIT OR Apache-2.0');
  assert.equal(r.url, 'https://crates.io/crates/hashbrown/0.17.1');
  assert.deepEqual(r.notices.map((n) => n.title), ['LICENSE-APACHE', 'LICENSE-MIT']);
  assert.match(r.notices[0].text, /"License" shall mean/, 'the text is decoded');
  assert.match(r.notices[1].text, /Copyright \(c\) 2016 Amanieu d'Antras/);
  assert.ok(!r.notices.some((n) => /older version|later version/.test(n.text)), 'never another version\'s block, not even one whose number starts with this one');
  assert.equal(tc.crateRecord([COPYRIGHT_HTML], 'hashbrown', '0.99.0'), null, 'a version it does not record is null');
  assert.throws(() => tc.crateRecord([COPYRIGHT_HTML], 'nolicence', '1.0.0'), /nolicence 1\.0\.0 without a licence/);
  assert.throws(() => tc.crateRecord([COPYRIGHT_HTML], 'halfread', '1.0.0'), /halfread 1\.0\.0 could not all be read \(1 of 2\)/);
});

/** A sysroot with standard libraries for `targets`, each rlib holding the strings given. */
function fakeSysroot(rlibs: Record<string, Record<string, string>>): string {
  const sysroot = fileTempDir('treemap-rust-notices-sysroot-');
  for (const [target, files] of Object.entries(rlibs)) {
    const dir = path.join(sysroot, 'lib', 'rustlib', target, 'lib');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(body, 'latin1'), Buffer.from([0])]));
  }
  return sysroot;
}

test('stdCratesInSysroot: the crates.io crates the installed standard libraries carry, by their /rust/deps/ paths, on every installed target', () => {
  const sysroot = fakeSysroot({
    'aarch64-apple-darwin': {
      'libstd-0123456789abcdef.rlib': 'panicked at /rust/deps/hashbrown-0.17.1/src/raw.rs\0/rust/deps/libc-0.2.1857f78src/',
      'libaddr2line-0123456789abcdef.rlib': '/rust/deps/addr2line-0.25.1/src/lib.rs',
      'libtest-0123456789abcdef.rlib': '/rust/deps/getopts-0.2.24/src/lib.rs',
      'libstd-0123456789abcdef.rmeta': '/rust/deps/notanrlib-1.0.0/src/lib.rs',
    },
    'x86_64-pc-windows-msvc': { 'librustc_demangle-0123456789abcdef.rlib': 'at /rust/deps\\rustc-demangle-0.1.27\\src\\lib.rs' },
    'wasm32-unknown-unknown': { 'libdlmalloc-0123456789abcdef.rlib': '/rust/deps/dlmalloc-0.2.13/src/lib.rs' },
  });
  const { scanned, found } = tc.stdCratesInSysroot(sysroot);
  assert.deepEqual(scanned, ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc'], 'the shipped targets that are installed, and no other');
  assert.deepEqual([...found.keys()].sort(), ['addr2line 0.25.1', 'hashbrown 0.17.1', 'rustc-demangle 0.1.27'],
    'the test harness\'s getopts, a packed string with no separator after its version, an .rmeta and a target TreeMap does not ship are not read');
  assert.deepEqual([...found.get('rustc-demangle 0.1.27')!], ['x86_64-pc-windows-msvc'], 'Windows spells the path with backslashes');
  assert.deepEqual(tc.stdCratesInSysroot(fileTempDir('treemap-rust-notices-empty-')).scanned, []);
});

test('STD_CRATES names the crates.io crates of the pinned Rust\'s standard library, each with the platforms it is on', () => {
  const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(read('native', 'treemap-core', 'rust-toolchain.toml'))![1];
  const list = tc.STD_CRATES[channel];
  assert.ok(list && list.length > 0, `a list for the pinned Rust ${channel}`);
  for (const c of list) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/, `${c.name}'s version`);
    assert.match(c.on, /^(macOS|Windows|Linux)/, `${c.name}'s platforms`);
  }
  assert.ok(list.some((c) => c.name === 'hashbrown') && list.some((c) => c.name === 'windows-link'), 'macOS and Linux crates and Windows ones alike');
});

test('renderNotices and parseNotices agree, and rendering is deterministic', () => {
  const text = rn.renderNotices(baseModel());
  assert.equal(rn.renderNotices(baseModel()), text, 'the same model renders the same bytes');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'one newline at the end');
  assert.doesNotMatch(text, /\r/);
  const parsed = rn.parseNotices(text);
  assert.deepEqual(parsed.own, ['app']);
  assert.equal(parsed.rustChannel, '1.98.1');
  assert.deepEqual(parsed.rustTexts, ['Apache-2.0', 'MIT']);
  assert.deepEqual(parsed.crates.map((c) => [c.name, c.version, c.inBinaries, c.licence, c.texts]), [
    ['alpha', '1.0.0', true, 'MIT OR Apache-2.0', ['LICENSE-MIT']],
    ['syn', '2.0.1', false, 'MIT OR Apache-2.0', ['LICENSE-MIT']],
    ['syn', '3.0.0', false, 'MIT OR Apache-2.0', ['LICENSE-MIT']],
  ]);
  assert.deepEqual(parsed.rustCrates.map((c) => [c.name, c.version, c.inBinaries, c.licence, c.texts]), [
    ['hashbrown', '0.17.1', true, 'MIT OR Apache-2.0', ['LICENSE-MIT']],
  ], 'the standard library\'s crates are entries of their own, never Cargo.lock crates');
  assert.match(text, /Copyright \(c\) the alpha authors/, 'the licence texts themselves are in the file');
  assert.match(text, /Copyright \(c\) 2016 Amanieu d'Antras/);
  assert.match(text, /In the binaries: yes, in the standard library on macOS, Windows and Linux/);
  assert.match(text, /In the binaries: no \(a procedural macro/);
  assert.match(text, /gdu\/LICENSE\.md/, 'it points at gdu\'s licence, which ships beside it');
  assert.match(text, /at least one platform/, '"yes" says it may be one platform\'s');
});

test('licenceProblems names an entry whose licence permissive terms cannot meet', () => {
  const model = baseModel();
  model.crates = [...model.crates, { ...modelCrate('copyleft', '1.0.0', true), licence: 'GPL-3.0-only' }];
  const problems = rn.licenceProblems(rn.renderNotices(model));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /copyleft 1\.0\.0/);
  assert.match(problems[0], /GPL-3\.0-only/);
  const std = baseModel();
  std.rust.files = [...std.rust.files, { path: 'library/x', licence: 'GPL-2.0-only', copyrights: ['Someone'] }];
  assert.ok(rn.licenceProblems(rn.renderNotices(std)).some((p) => /standard library's library\/x/.test(p) && /GPL-2\.0-only/.test(p)), 'the standard library\'s files are held to it too');
  const stdCrate = baseModel();
  stdCrate.rust.crates = [{ ...stdCrate.rust.crates[0], licence: 'MPL-2.0' }];
  assert.ok(rn.licenceProblems(rn.renderNotices(stdCrate)).some((p) => /standard library's crate hashbrown 0\.17\.1/.test(p) && /MPL-2\.0/.test(p)), 'and so are the crates it is built from');
});

/* ═══════════════════ the generator end to end, with cargo and the toolchain stood in for ═══════════════════ */

interface FakeRepo { repo: string; sysroot: string; metadata: Metadata }
interface FakeRepoOpts {
  alphaLicence?: string | null; alphaLicenceFile?: string; stdHtml?: boolean; toolchain?: string; standardTexts?: string[];
  rlibs?: Record<string, string> | null; upstream?: Record<string, string>;
}

const STD_LIST: StdListed[] = [{ name: 'hashbrown', version: '0.17.1', on: 'macOS, Windows and Linux' }];

/** A repository with a Cargo.lock, a registry of three crates and a toolchain, and the metadata cargo would give for it. */
function fakeRepo(opts: FakeRepoOpts = {}): FakeRepo {
  const repo = fileTempDir('treemap-rust-notices-repo-');
  const ws = path.join(repo, 'native', 'treemap-core');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'rust-toolchain.toml'), opts.toolchain ?? TOOLCHAIN);
  const write = (root: string, rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const reg = path.join(repo, 'registry');
  write(reg, 'alpha-1.0.0/LICENSE-MIT', 'Copyright (c) Alpha\n\nPermission is hereby granted.\n');
  write(reg, 'alpha-1.0.0/LICENSE-APACHE', 'Apache License\n');
  write(reg, 'nofile-0.3.2/README.md', 'nothing\n');
  write(reg, 'macro-3.3.0/LICENSE', 'Macro MIT text\n');
  for (const [rel, body] of Object.entries(opts.upstream ?? {})) write(path.join(repo, 'native', 'licence-texts'), rel, body);
  const pkgs = [
    metaPackage('app', '0.5.0', { member: true, kinds: ['cdylib'], dir: path.join(ws, 'crates', 'app') }),
    metaPackage('alpha', '1.0.0', {
      license: opts.alphaLicence === undefined ? 'MIT OR Apache-2.0' : opts.alphaLicence, license_file: opts.alphaLicenceFile ?? null, dir: path.join(reg, 'alpha-1.0.0'),
    }),
    metaPackage('nofile', '0.3.2', { authors: ['Mads Marquart <mads@example.invalid>'], dir: path.join(reg, 'nofile-0.3.2') }),
    metaPackage('macro', '3.3.0', { kinds: ['proc-macro'], dir: path.join(reg, 'macro-3.3.0') }),
  ];
  const metadata = metadataOf(pkgs, [['app', 'alpha', [null]], ['app', 'nofile', [null]], ['app', 'macro', [null]]]);
  fs.writeFileSync(path.join(ws, 'Cargo.lock'), lockText([
    lockBlock('alpha', '1.0.0'), lockBlock('app', '0.5.0', null, ['alpha', 'macro', 'nofile']), lockBlock('macro', '3.3.0'), lockBlock('nofile', '0.3.2'),
  ]));
  const sysroot = path.join(repo, 'sysroot');
  const doc = path.join(sysroot, 'share', 'doc', 'rust');
  for (const id of opts.standardTexts ?? ['Apache-2.0', 'MIT', 'Unicode-3.0']) write(doc, `licenses/${id}.txt`, `${id} standard text\n`);
  if (opts.stdHtml !== false) write(doc, 'COPYRIGHT-library.html', STD_HTML);
  write(doc, 'COPYRIGHT.html', COPYRIGHT_HTML);
  const rlibs = opts.rlibs === undefined ? { 'libhashbrown-0123456789abcdef.rlib': '/rust/deps/hashbrown-0.17.1/src/raw.rs' } : opts.rlibs;
  for (const [name, body] of Object.entries(rlibs ?? {})) write(path.join(sysroot, 'lib', 'rustlib', 'aarch64-apple-darwin', 'lib'), name, body);
  return { repo, sysroot, metadata };
}

function runMain(f: FakeRepo, argv: string[], rustVersion = '1.98.1', stdCrates: (channel: string) => StdListed[] | undefined = (c) => (c === '1.98.1' ? STD_LIST : undefined)):
  { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = rn.main(argv, {
    repo: f.repo, metadata: () => f.metadata, sysroot: () => f.sysroot, rustVersion: () => rustVersion, stdCrates,
    out: (l) => out.push(l), err: (l) => err.push(l),
  });
  return { code, out, err };
}

test('main writes a sealed file that passes the drift check against the Cargo.lock it was made from, and --check then agrees with it', () => {
  const f = fakeRepo();
  const run = runMain(f, []);
  assert.equal(run.code, 0, run.err.join('\n'));
  const file = path.join(f.repo, rn.NOTICES_PATH);
  const text = fs.readFileSync(file, 'utf8');
  const lock = fs.readFileSync(path.join(f.repo, 'native', 'treemap-core', 'Cargo.lock'), 'utf8');
  assert.deepEqual(rn.driftProblems({ lock, notices: text, toolchain: TOOLCHAIN }), []);
  assert.deepEqual(rn.licenceProblems(text), []);
  assert.deepEqual(rn.sealProblems(text, realDigest()), [], 'sealed with the digest of the generator that wrote it');
  const parsed = rn.parseNotices(text);
  assert.deepEqual(parsed.crates.map((c) => [c.name, c.inBinaries, c.texts]), [
    ['alpha', true, ['LICENSE-APACHE', 'LICENSE-MIT']],
    ['macro', false, ['LICENSE']],
    ['nofile', true, ['MIT']],
  ]);
  assert.match(text, /Authors: Mads Marquart\n/);
  assert.match(text, /library\/core\/src\/unicode\/mod\.rs/, 'the standard library\'s own files are listed');
  assert.match(text, /Unicode-3\.0 standard text/, 'with the texts of the licences they name, from the toolchain');
  assert.deepEqual(parsed.rustTexts, ['Apache-2.0', 'MIT', 'Unicode-3.0']);
  assert.deepEqual(parsed.rustCrates.map((c) => [c.name, c.version, c.texts]), [['hashbrown', '0.17.1', ['LICENSE-APACHE', 'LICENSE-MIT']]],
    'the standard library\'s crates.io crates, with the notices the toolchain records (here only in COPYRIGHT.html)');
  assert.match(text, /Copyright \(c\) 2016 Amanieu d'Antras/);
  assert.match(run.err.join('\n'), /2 crates in the binaries, 1 used only to build them, 1 in Rust 1\.98\.1's standard library/);

  assert.equal(runMain(f, ['--check']).code, 0, 'the file it just wrote is current');
  fs.writeFileSync(file, text.replace('Copyright (c) Alpha', 'Copyright (c) Someone else'));
  const stale = runMain(f, ['--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.err.join('\n'), /out of date/);
  assert.match(stale.err.join('\n'), REGENERATE);
  assert.match(fs.readFileSync(file, 'utf8'), /Someone else/, '--check never writes');
});

test('main takes the upstream licence a person kept in native/licence-texts/ for a crate whose package has none', () => {
  const f = fakeRepo({ upstream: { 'nofile/LICENSE': 'MIT License\n\nCopyright (c) 2020 Mads Marquart\n' } });
  const run = runMain(f, []);
  assert.equal(run.code, 0, run.err.join('\n'));
  const text = fs.readFileSync(path.join(f.repo, rn.NOTICES_PATH), 'utf8');
  const entry = text.slice(text.indexOf('Crate: nofile 0.3.2'), text.indexOf('Rust standard library: '));
  assert.match(entry, /Copyright \(c\) 2020 Mads Marquart/);
  assert.match(entry, /native\/licence-texts\/nofile\//);
  assert.doesNotMatch(entry, /standard text/, 'the standard text no longer stands in');
});

test('main refuses, writing nothing, when a licence needs a person\'s decision or the toolchain is not the pinned one', () => {
  const gpl = fakeRepo({ alphaLicence: 'GPL-3.0-only' });
  const run = runMain(gpl, []);
  assert.equal(run.code, 1);
  assert.match(run.err.join('\n'), /alpha 1\.0\.0/);
  assert.match(run.err.join('\n'), /GPL-3\.0-only/);
  assert.equal(fs.existsSync(path.join(gpl.repo, rn.NOTICES_PATH)), false, 'no file is written');

  const unnamed = fakeRepo({ alphaLicence: null, alphaLicenceFile: 'LICENSE-MIT' });
  const unknown = runMain(unnamed, []);
  assert.equal(unknown.code, 1, 'a crate whose Cargo.toml names no licence, only a file, is a person\'s decision too');
  assert.match(unknown.err.join('\n'), /alpha 1\.0\.0: its licence, none named; see LICENSE-MIT/);
  assert.equal(fs.existsSync(path.join(unnamed.repo, rn.NOTICES_PATH)), false);

  const other = fakeRepo();
  const wrongRust = runMain(other, [], '1.97.0');
  assert.equal(wrongRust.code, 1);
  assert.match(wrongRust.err.join('\n'), /1\.97\.0/);
  assert.match(wrongRust.err.join('\n'), /1\.98\.1/);
  assert.equal(fs.existsSync(path.join(other.repo, rn.NOTICES_PATH)), false);

  const noRecord = fakeRepo({ stdHtml: false });
  const noStd = runMain(noRecord, []);
  assert.equal(noStd.code, 1, 'without the toolchain\'s record of the standard library there is no notice for it');
  assert.match(noStd.err.join('\n'), /COPYRIGHT-library\.html/);
  assert.equal(fs.existsSync(path.join(noRecord.repo, rn.NOTICES_PATH)), false);

  const noUnicode = fakeRepo({ standardTexts: ['Apache-2.0', 'MIT'] });
  const missingText = runMain(noUnicode, []);
  assert.equal(missingText.code, 1, 'a licence the standard library names, with no text to print for it, is not left out');
  assert.match(missingText.err.join('\n'), /Unicode-3\.0/);
  assert.equal(fs.existsSync(path.join(noUnicode.repo, rn.NOTICES_PATH)), false);

  const unpinned = fakeRepo({ toolchain: '[toolchain]\nprofile = "minimal"\n' });
  const noChannel = runMain(unpinned, []);
  assert.equal(noChannel.code, 1);
  assert.match(noChannel.err.join('\n'), /pins no channel/);

  const typo = runMain(fakeRepo(), ['--write']);
  assert.equal(typo.code, 2, 'an argument it does not know is refused, never ignored');
  assert.match(typo.err.join('\n'), /--check/);
});

test('main refuses when the standard library\'s crates are not all accounted for: no list for this Rust, one the libraries carry but the list misses, one the toolchain does not record, none installed', () => {
  const noList = runMain(fakeRepo(), [], '1.98.1', () => undefined);
  assert.equal(noList.code, 1);
  assert.match(noList.err.join('\n'), /no STD_CRATES list for Rust 1\.98\.1/);

  const extra = fakeRepo({ rlibs: { 'libstd-0123456789abcdef.rlib': '/rust/deps/hashbrown-0.17.1/src/raw.rs /rust/deps/newdep-1.2.3/src/lib.rs' } });
  const unlisted = runMain(extra, []);
  assert.equal(unlisted.code, 1);
  assert.match(unlisted.err.join('\n'), /carries newdep 1\.2\.3, which STD_CRATES/);
  assert.equal(fs.existsSync(path.join(extra.repo, rn.NOTICES_PATH)), false);

  const unrecorded = runMain(fakeRepo(), [], '1.98.1', () => [...STD_LIST, { name: 'ghost', version: '9.9.9', on: 'Windows' }]);
  assert.equal(unrecorded.code, 1);
  assert.match(unrecorded.err.join('\n'), /records no notices for ghost 9\.9\.9/);

  const bare = fakeRepo({ rlibs: null });
  const noStd = runMain(bare, []);
  assert.equal(noStd.code, 1, 'with no standard library installed for a shipped target, nothing checks the list');
  assert.match(noStd.err.join('\n'), /rustup target add/);
});

test('main refuses when cargo\'s metadata and Cargo.lock disagree about the crates, naming the difference — without telling you to rerun what you just ran', () => {
  const f = fakeRepo();
  f.metadata.packages = f.metadata.packages.filter((p) => p.name !== 'macro');
  f.metadata.resolve.nodes = f.metadata.resolve.nodes.filter((n) => !n.id.includes('macro')).map((n) => ({ ...n, deps: n.deps.filter((d) => !d.pkg.includes('macro')) }));
  const run = runMain(f, []);
  assert.equal(run.code, 1);
  assert.match(run.err.join('\n'), /macro 3\.3\.0/);
  assert.match(run.err.join('\n'), /cargo metadata --format-version 1 --locked/);
  assert.doesNotMatch(run.err.join('\n'), REGENERATE);
  assert.equal(fs.existsSync(path.join(f.repo, rn.NOTICES_PATH)), false);
});
