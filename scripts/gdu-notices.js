#!/usr/bin/env node
'use strict';
/*
 * The third-party notices of the gdu binary TreeMap bundles.
 *
 *   node scripts/gdu-notices.js           write build/gdu/THIRD_PARTY_NOTICES.txt and build/gdu/gdu-modules.json
 *   node scripts/gdu-notices.js --check   exit 1 when either committed file is not what it would write
 *
 * gdu (github.com/dundee/gdu, MIT) ships as one static Go program per
 * platform, fetched by scripts/fetchGdu.js at the version it pins. Its own
 * LICENSE.md has always shipped beside it; but each program also links in
 * some forty Go modules and the Go standard library, whose licences (MIT,
 * BSD, Apache-2.0) ask for their notices to travel with every binary copy.
 * This writes them into build/gdu/THIRD_PARTY_NOTICES.txt, which
 * electron-builder ships beside gdu's LICENSE.md (package.json,
 * build.extraResources), and scripts/afterPack.js refuses a package without.
 *
 * What it reads:
 *   - the Go build information of each binary scripts/fetchGdu.js stages
 *     under build/gdu/<platform>-<arch>/ (`node scripts/fetchGdu.js --all`):
 *     gdu's version, the Go that built it and every module it links, read
 *     from the bytes offline (scripts/gdu-notices/buildinfo.js). The
 *     platforms need not link the same modules (cobra links mousetrap on
 *     Windows only); each module's entry names the platforms that do;
 *   - each module's source at that version, the zip proxy.golang.org serves,
 *     checked against the go.sum hash recorded for it — in gdu's own go.sum
 *     (from gdu's module zip) and in any binary that records one — so a zip
 *     that is not the source the binaries were built from is refused; and
 *     from it every licence file the module carries outside the folders Go
 *     never compiles (scripts/gdu-notices/licences.js), word for word;
 *   - Go's LICENSE and PATENTS at the release that built the binaries, from
 *     the Go source (go.googlesource.com).
 * Those are the only addresses it fetches from (allowedUrl), with the one
 * redirect proxy.golang.org makes for larger zips, to its own storage bucket
 * (getAllowed); every zip is checked against go.sum wherever it came from.
 * It keeps what it fetched in a cache (GDU_NOTICES_CACHE, or treemap-gdu-notices
 * under the system's temp folder), checked again on every run.
 *
 * It writes the notices and, beside them, gdu-modules.json: the gdu version,
 * the Go version, each binary's SHA-256 and module list, and each module's
 * go.sum hash. That record is what lets tests/gduNotices.test.ts guard the
 * notices offline, on every CI leg: it holds the record to the version and
 * platforms scripts/fetchGdu.js pins, the notices to the record, and the gdu
 * binary staged on the machine to the record, byte for byte; the notices'
 * last line seals them against a changed generator or an edit by hand. The
 * file's format, the record and every check on them are in
 * scripts/gdu-notices/notices.js, which scripts/afterPack.js uses too.
 *
 * It refuses — writing nothing — when a licence cannot be met on the
 * permissive terms of scripts/rust-notices/spdx.js's PERMISSIVE (copyleft,
 * file-level copyleft such as MPL-2.0, and unknown licences are a person's
 * decision, never a silent one), when a licence file names no licence it
 * knows, when nothing vouches for a module's source, and when the binaries
 * are not the gdu scripts/fetchGdu.js pins.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spdxIds } = require('./rust-notices/spdx');
const { byCodeUnits, normaliseText } = require('./rust-notices/text');
const { readBuildInfo } = require('./gdu-notices/buildinfo');
const { zipEntries, zipEntryData, hashZip } = require('./gdu-notices/zip');
const { REVIEWED, licenceFiles, identifyLicences, isPatentGrant, classifyLicenceFile } = require('./gdu-notices/licences');
const notices = require('./gdu-notices/notices');

const {
  NOTICES_PATH, MODULES_PATH, GDU_LICENCE_PATH, GDU_MODULE, REGENERATE, sha256, binaryName, stagedPath, proxyZipUrl, goSourceUrl,
  linkedModules, renderNotices, recordText, driftProblems, licenceProblems, generatorDigest, sealNotices,
} = notices;

const REPO = path.join(__dirname, '..');
const GO_FILES = ['LICENSE', 'PATENTS'];

/* ───────────────────────────── the network, and the cache ───────────────────────────── */

const PROXY_ZIP = /^https:\/\/proxy\.golang\.org\/[a-z0-9!._~/-]+\/@v\/[A-Za-z0-9!._+~-]+\.zip$/;
const GO_FILE = new RegExp(`^https://go\\.googlesource\\.com/go/\\+/refs/tags/go\\d+(?:\\.\\d+)*/(?:${GO_FILES.join('|')})\\?format=TEXT$`);

/** Whether the generator may fetch `url`: a module zip on proxy.golang.org, or Go's LICENSE or PATENTS at a release tag. */
function allowedUrl(url) {
  return PROXY_ZIP.test(url) || GO_FILE.test(url);
}

/** Whether this process runs under a test runner — the rule src/services/realMachineGuard.ts keeps. */
function underTestRunner(env = process.env) {
  return Boolean(env.TREEMAP_FORBID_REAL_TRASH) || Boolean(env.NODE_TEST_CONTEXT);
}

/** Where proxy.golang.org sends a request for a larger zip: a signed address in its own storage bucket. */
const PROXY_STORAGE = /^https:\/\/storage\.googleapis\.com\/proxy-golang-org-prod\/\S+$/;

/**
 * The body at an allowed `url`, by plain GETs through `get` (fetch's
 * shape). proxy.golang.org answers a larger zip with a redirect to its own
 * storage; that one hop is followed, and nothing further from there. Any
 * other redirect, any failed answer and any failed request is refused,
 * naming the address and why.
 */
async function getAllowed(url, get) {
  const ask = async (target, redirect) => {
    try {
      return await get(target, { redirect });
    } catch (err) {
      const cause = err.cause ? err.cause.message || err.cause.code : null;
      throw new Error(`${target}: ${err.message}${cause ? ` (${cause})` : ''}`);
    }
  };
  let res = await ask(url, 'manual');
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!PROXY_ZIP.test(url) || !location || !PROXY_STORAGE.test(location)) {
      throw new Error(`${url} redirected to ${location || 'nowhere'}, which is not the proxy's own storage (https://storage.googleapis.com/proxy-golang-org-prod/); nothing else is fetched`);
    }
    res = await ask(location, 'error');
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The network, for an allowed address only, and never under a test runner: tests pass `fetch` instead. */
async function networkFetch(url) {
  if (!allowedUrl(url)) {
    throw new Error(`${url} is not an address this generator fetches from (only module zips on proxy.golang.org, and Go's LICENSE and PATENTS at a release tag)`);
  }
  if (underTestRunner()) throw new Error(`${url} is not fetched under a test runner; tests pass fetch in its place`);
  return getAllowed(url, fetch);
}

function cacheFileOf(cacheDir, url) {
  return path.join(cacheDir, url.replace(/^https:\/\//, '').replace(/[^A-Za-z0-9._@+-]+/g, '_'));
}

/**
 * The bytes at `url` and what `verify` makes of them: from the cache when it
 * has them, else fetched, and kept in the cache only once they verify. A
 * cached copy that fails is named, so a person can remove it.
 */
async function obtain(url, deps, verify) {
  const file = deps.cacheDir ? cacheFileOf(deps.cacheDir, url) : null;
  if (file && fs.existsSync(file)) {
    const bytes = fs.readFileSync(file);
    try {
      return { bytes, result: verify(bytes) };
    } catch (err) {
      throw new Error(`${err.message} (read from the cache, ${file}; remove that file to fetch it again)`);
    }
  }
  const bytes = await deps.fetch(url);
  const result = verify(bytes);
  if (file) {
    fs.mkdirSync(deps.cacheDir, { recursive: true });
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
  }
  return { bytes, result };
}

/* ───────────────────────────── the binaries ───────────────────────────── */

/**
 * What the binaries record, one per pinned platform: gdu's version, the Go
 * that built them, each one's SHA-256 and the modules it links, and every
 * go.sum hash a binary records for a module. Throws when a binary is missing,
 * unreadable, of another gdu, built by another Go than the rest, or links a
 * replaced module.
 */
function readBinaries(deps) {
  const targets = Object.keys(deps.pin.targets).sort(byCodeUnits);
  const binaries = {};
  const sums = new Map();
  const goVersions = new Map();
  for (const target of targets) {
    const rel = stagedPath(target);
    let bytes;
    try {
      bytes = deps.readBinary(target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`${rel} cannot be read (${err.code || err.message})`);
      throw new Error(`${rel} is missing; \`node scripts/fetchGdu.js --all\` stages the binaries of all ${targets.length} platforms, which the notices are read from`);
    }
    let info;
    try {
      info = readBuildInfo(bytes);
    } catch (err) {
      throw new Error(`${rel}: ${err.message}`);
    }
    if (info.main.path !== GDU_MODULE || info.main.version !== deps.pin.version) {
      throw new Error(`${rel} is ${info.main.path} ${info.main.version}, but scripts/fetchGdu.js pins ${GDU_MODULE} ${deps.pin.version}; remove the stale binaries and run \`node scripts/fetchGdu.js --all\``);
    }
    goVersions.set(target, info.goVersion);
    const modules = [];
    for (const dep of info.deps) {
      if (dep.replace) {
        throw new Error(`${rel}: ${dep.path} ${dep.version} is replaced by ${dep.replace.path} ${dep.replace.version || '(a local folder)'}; a person decides how a replaced module is credited before it ships`);
      }
      const key = `${dep.path} ${dep.version}`;
      modules.push(key);
      if (dep.sum) sums.set(key, [...(sums.get(key) ?? []), { target, sum: dep.sum }]);
    }
    binaries[target] = { file: binaryName(target), sha256: sha256(bytes), modules: modules.sort(byCodeUnits) };
  }
  const gos = [...new Set(goVersions.values())];
  if (gos.length !== 1) {
    throw new Error(`the binaries were built by different Go versions (${[...goVersions].map(([t, v]) => `${t}: ${v}`).join(', ')}), so no one standard library describes them; a person decides how to credit each`);
  }
  return { gdu: { module: GDU_MODULE, version: deps.pin.version }, go: gos[0], binaries, sums };
}

/* ───────────────────────────── the modules' source ───────────────────────────── */

/** "<path> <version>" -> h1 hash, from a go.sum's text; the go.mod-only lines left out. */
function parseGoSum(text) {
  const sums = new Map();
  for (const line of String(text).split('\n')) {
    const [modulePath, version, sum] = line.trim().split(/\s+/);
    if (sum && !version.endsWith('/go.mod')) sums.set(`${modulePath} ${version}`, sum);
  }
  return sums;
}

/** One file of a module zip, by its path in the module, or null. */
function moduleFile(zip, prefix, rel) {
  const entry = zipEntries(zip).find((e) => e.name === `${prefix}${rel}`);
  return entry ? zipEntryData(zip, entry) : null;
}

/** gdu's go.sum from its module zip, after holding build/gdu/LICENSE.md to the LICENSE.md in that zip. */
function gduSource(repo, gduZip, version) {
  const prefix = `${GDU_MODULE}@${version}/`;
  const goSum = moduleFile(gduZip, prefix, 'go.sum');
  if (!goSum) throw new Error(`gdu ${version}'s module zip holds no go.sum, so nothing vouches for its modules' source`);
  const own = moduleFile(gduZip, prefix, 'LICENSE.md');
  if (!own) throw new Error(`gdu ${version}'s module zip holds no LICENSE.md to check ${GDU_LICENCE_PATH} against`);
  let shipped;
  try {
    shipped = fs.readFileSync(path.join(repo, ...GDU_LICENCE_PATH.split('/')), 'utf8');
  } catch (err) {
    throw new Error(`${GDU_LICENCE_PATH} cannot be read (${err.code || err.message}); \`node scripts/fetchGdu.js\` fetches it for the pinned version`);
  }
  if (normaliseText(shipped) !== normaliseText(own.toString('utf8'))) {
    throw new Error(`${GDU_LICENCE_PATH} is not the LICENSE.md of gdu ${version}; remove it and run \`node scripts/fetchGdu.js\`, which fetches the pinned version's`);
  }
  return parseGoSum(goSum.toString('utf8'));
}

/** Checks a module zip against every go.sum hash recorded for it, and answers its hash; throws, naming the module, when one differs or none is recorded. */
function verifyModuleZip(m, bytes, goSum, binarySums, gduVersion) {
  const who = `${m.path} ${m.version}`;
  let actual;
  try {
    actual = hashZip(bytes);
  } catch (err) {
    throw new Error(`${who}: its zip cannot be read: ${err.message}`);
  }
  const fromGoSum = goSum.get(who);
  const fromBinaries = binarySums.get(who) ?? [];
  if (!fromGoSum && fromBinaries.length === 0) {
    throw new Error(`${who}: nothing records its go.sum hash — gdu ${gduVersion}'s go.sum lacks it and no binary records one — so nothing vouches for the source fetched for it`);
  }
  if (fromGoSum && fromGoSum !== actual) throw new Error(`${who}: its zip hashes to ${actual}, but gdu ${gduVersion}'s go.sum records ${fromGoSum}`);
  for (const b of fromBinaries) {
    if (b.sum !== actual) throw new Error(`${who}: its zip hashes to ${actual}, but the ${b.target} binary records ${b.sum}`);
  }
  return actual;
}

/** A module's entry: every licence file of its zip, classified, and the licences they grant joined by AND. */
function moduleEntry(m, zip, sum) {
  const who = `${m.path} ${m.version}`;
  const prefix = `${m.path}@${m.version}/`;
  const entries = zipEntries(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const files = licenceFiles(entries.map((e) => e.name), prefix);
  if (files.length === 0) {
    throw new Error(`${who}: its source holds no licence file (LICENSE, COPYING, NOTICE…), so nothing says on what terms it may ship; a person must find out before it does`);
  }
  const classified = files.map((rel) => classifyLicenceFile({ module: who, file: rel, bytes: zipEntryData(zip, byName.get(`${prefix}${rel}`)) }));
  const ids = [...new Set(classified.flatMap((c) => c.ids))].sort(byCodeUnits);
  if (ids.length === 0) {
    throw new Error(`${who}: none of its licence files (${files.join(', ')}) grants a licence this generator recognises; a person must read them`);
  }
  return {
    path: m.path, version: m.version, sum, platforms: m.platforms, licence: ids.join(' AND '),
    notes: classified.map((c) => c.note).filter(Boolean),
    texts: classified.filter((c) => c.text !== '').map((c) => ({ title: c.title, text: c.text })),
  };
}

/** A file gitiles serves with ?format=TEXT — base64 — as text. */
function decodeGoSourceText(bytes, url) {
  const b64 = bytes.toString('latin1').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length === 0) throw new Error(`${url} did not answer the base64 text the Go source serves`);
  try {
    return normaliseText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(b64, 'base64')));
  } catch {
    throw new Error(`${url} is not valid UTF-8 once decoded`);
  }
}

/** The Go standard library's entry: Go's LICENSE and PATENTS at the release that built the binaries. */
async function goEntry(goVersion, deps) {
  if (!/^go\d+(?:\.\d+)*$/.test(goVersion)) {
    throw new Error(`the binaries were built by ${goVersion}, which is not a Go release, so there is no released source to take Go's licence from`);
  }
  const texts = [];
  for (const file of GO_FILES) {
    const url = goSourceUrl(goVersion, file);
    const { result } = await obtain(url, deps, (bytes) => decodeGoSourceText(bytes, url));
    texts.push({ title: file, text: result });
  }
  const ids = identifyLicences(texts[0].text);
  if (ids.length === 0) throw new Error(`Go's LICENSE at ${goVersion} names no licence this generator recognises; a person must read it`);
  if (!isPatentGrant(texts[1].text)) throw new Error(`Go's PATENTS at ${goVersion} is not the patent grant it has carried since Go 1; a person must read it`);
  return { version: goVersion, licence: ids.join(' AND '), texts };
}

/* ───────────────────────────── main ───────────────────────────── */

/**
 * Writes the two files, or with --check compares them, and answers the exit
 * code. `deps` stands in for the machine: { repo, pin ({ version, targets },
 * scripts/fetchGdu.js's), readBinary(target), fetch(url), cacheDir (or
 * null), out(line), err(line) }.
 */
async function main(argv, deps) {
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    deps.err(`gdu-notices: unknown argument ${unknown[0]}; the only one is --check`);
    return 2;
  }
  const check = argv.includes('--check');
  try {
    const read = readBinaries(deps);
    const { bytes: gduZip } = await obtain(proxyZipUrl(GDU_MODULE, read.gdu.version), deps, (bytes) => zipEntries(bytes));
    const goSum = gduSource(deps.repo, gduZip, read.gdu.version);
    const modules = [];
    for (const m of linkedModules(read.binaries)) {
      const { bytes, result: sum } = await obtain(proxyZipUrl(m.path, m.version), deps, (zip) => verifyModuleZip(m, zip, goSum, read.sums, read.gdu.version));
      modules.push(moduleEntry(m, bytes, sum));
    }
    const go = await goEntry(read.go, deps);
    const binaries = Object.keys(read.binaries).map((target) => ({ target, file: read.binaries[target].file, sha256: read.binaries[target].sha256 }));
    const text = sealNotices(renderNotices({ gdu: read.gdu, go, binaries, modules }), generatorDigest());
    const json = recordText(read, modules);

    const problems = [...licenceProblems(text), ...driftProblems(JSON.parse(json), text, 'the generator disagrees with itself; this is a bug in scripts/gdu-notices.js')];
    if (problems.length > 0) {
      for (const p of problems) deps.err(`gdu-notices: ${p}`);
      deps.err('gdu-notices: nothing was written');
      return 1;
    }

    const files = [[NOTICES_PATH, text], [MODULES_PATH, json]].map(([rel, body]) => ({ rel, file: path.join(deps.repo, ...rel.split('/')), body }));
    const ids = [...new Set([...modules.map((m) => m.licence), go.licence].flatMap((l) => spdxIds(l)))].sort(byCodeUnits);
    const summary = `${modules.length} modules in the binaries of gdu ${read.gdu.version} for ${binaries.length} platforms, built by ${go.version}; licences named: ${ids.join(', ')}`;
    if (check) {
      const stale = files.filter((f) => (fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8').replace(/\r\n/g, '\n') : null) !== f.body);
      if (stale.length > 0) {
        deps.err(`gdu-notices: ${stale.map((f) => f.rel).join(' and ')} ${stale.length === 1 ? 'is' : 'are'} out of date; ${REGENERATE}`);
        return 1;
      }
      deps.err(`gdu-notices: ${NOTICES_PATH} and ${MODULES_PATH} are current (${summary})`);
      return 0;
    }
    for (const f of files) {
      fs.mkdirSync(path.dirname(f.file), { recursive: true });
      fs.writeFileSync(f.file, f.body);
    }
    deps.err(`gdu-notices: ${summary}`);
    for (const f of files) {
      deps.err(`gdu-notices: wrote ${f.rel} (${Buffer.byteLength(f.body)} bytes)`);
      deps.out(f.file);
    }
    return 0;
  } catch (err) {
    deps.err(`gdu-notices: ${err.message}`);
    deps.err('gdu-notices: nothing was written');
    return 1;
  }
}

const MACHINE = {
  repo: REPO,
  /** Read when the generator runs, never when it is required: requiring fetchGdu.js is safe, but nothing here needs it sooner. */
  get pin() {
    const { VERSION, TARGETS } = require('./fetchGdu.js');
    return { version: VERSION, targets: TARGETS };
  },
  readBinary: (target) => fs.readFileSync(path.join(REPO, ...stagedPath(target).split('/'))),
  fetch: networkFetch,
  cacheDir: process.env.GDU_NOTICES_CACHE || path.join(os.tmpdir(), 'treemap-gdu-notices'),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

if (require.main === module) {
  main(process.argv.slice(2), MACHINE).then((code) => {
    process.exitCode = code;
  });
} else {
  module.exports = {
    ...notices,
    REVIEWED,
    allowedUrl,
    getAllowed,
    networkFetch,
    readBuildInfo,
    zipEntries,
    zipEntryData,
    hashZip,
    licenceFiles,
    identifyLicences,
    classifyLicenceFile,
    main,
  };
}
