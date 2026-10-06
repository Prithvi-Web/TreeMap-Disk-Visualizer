import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-docsTruth-data-');

import { FAST_PATH_UNAVAILABLE, nativeEligibility, nativeRule, type EligibilityInput } from '../src/services/scan/nativeEngine';
import { MEMORY_CAP_ROWS, RESERVE_FACTOR, memoryRoomFor } from '../src/services/scan/nativeMemory';

/**
 * The engineering record and the agents' contract — docs/PLATFORM_NOTES.md,
 * docs/engine/DESIGN.md and RISKS.md, ULTRA-ROADMAP.md, the Track U plan,
 * AGENTS.md and the README's engine paragraph — are documentation, and
 * nothing runs them. The 5.2.0 docs batch rewrote sentences in each, and its
 * review (6 Oct 2026) found several that said more than the code does. Each
 * test here takes its fact from the code that owns it — a pure function
 * called, or the line that decides it — and holds the sentence to that fact,
 * so a change on either side fails here instead of leaving a reader with a
 * claim the app does not keep. Nothing anchors to a line number.
 */

const root = path.join(__dirname, '..');
// CRLF-normalised: a Windows checkout with autocrlf on must not turn every anchor below into a miss.
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

/** The one line of `doc` that starts with `start`, hard-failing when there is none or more than one. */
function lineStarting(doc: string, start: string): string {
  const lines = doc.split('\n').filter((l) => l.startsWith(start));
  assert.equal(lines.length, 1, `one line starts with "${start}"`);
  return lines[0];
}

/** `text` from `from` to its end, hard-failing when `from` is missing. */
function from(text: string, start: string): string {
  const at = text.indexOf(start);
  assert.notEqual(at, -1, `"${start}" exists`);
  return text.slice(at);
}

/** Every .ts file under `dir`, relative to the repository. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) sources(rel, out);
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/* ─────────────── PLATFORM_NOTES: where a fast rescan reads its cache ─────────────── */

test('PLATFORM_NOTES says a fast rescan is not used exactly where the native engine walks, as startScan and nativeRule decide (review F1.1)', () => {
  // The code: startScan skips the request only for a walk the native engine
  // makes, and it makes one only where the scan is eligible — not wherever
  // the module is loaded.
  const scanner = read('src', 'services', 'diskScanner.ts');
  assert.match(scanner, /const fastRescanSkipped = opts\.incremental === true && nativeWalk !== null;/, 'the request is skipped only where the native engine walks');
  assert.match(scanner, /const nativeWalk = native\.eligibility\.ok && native\.module\n?\s*\?/, 'and it walks only where the scan is eligible');

  // What keeps an eligible module off a scan: the rules, before any module
  // is consulted, and a probe of the root that refuses.
  const plain: Omit<EligibilityInput, 'native'> = { ignoreCount: 0, forced: 'auto', rootIsDir: true };
  assert.equal(nativeRule(plain), null, 'a plain scan of a folder is the native engine\'s');
  const sentence = from(lineStarting(read('docs', 'PLATFORM_NOTES.md'), '| Fast enumeration | `getattrlistbulk`'), 'A fast rescan');
  const kept: Array<[string, RegExp, Omit<EligibilityInput, 'native'>]> = [
    ['a "Don\'t scan" list', /"Don't scan" list/, { ...plain, ignoreCount: 1 }],
    ['a single-file root', /single file/, { ...plain, rootIsDir: false }],
    ['the Built-in walker setting', /Built-in walker/, { ...plain, forced: 'walker' }],
    ['the gdu setting', /\bgdu\b/, { ...plain, forced: 'gdu' }],
  ];
  for (const [what, words, input] of kept) {
    assert.notEqual(nativeRule(input), null, `${what} keeps the native engine off whatever module is loaded`);
    assert.match(sentence, words, `PLATFORM_NOTES names ${what} as a scan the native engine does not walk`);
  }
  const refused = nativeEligibility('/x', { ...plain, native: { available: true, probe: { fastPath: FAST_PATH_UNAVAILABLE, reason: 'the test refuses' } } });
  assert.equal(refused.ok, false, 'a loaded module whose probe of the root refuses does not walk it');
  assert.match(sentence, /can list the folder/, 'PLATFORM_NOTES says the core must be able to list the folder');
  assert.doesNotMatch(sentence, /with the core loaded the request is not used/, 'not "whenever the core is loaded"');
});

/* ─────────────── RISKS R95: what a scan says about the memory store's room ─────────────── */

test('RISKS R95 says engineReason speaks of the room only where a projection sized it, as startScan does (review F1.2)', () => {
  // The code: a scan with no projection (every first scan of a folder that is
  // not a whole volume), or one of half the default room or less, starts in
  // the default room, and startScan adds the "sized for" clause only to a
  // room a projection sized. A walk that outgrows its room says it walked
  // again (runNativeWalk); the projection's own reason stays on the record's
  // nativePlan, which no route or MCP tool serves.
  assert.equal(memoryRoomFor(null).sizedBy, 'default', 'no projection: the default room');
  assert.equal(memoryRoomFor({ entries: MEMORY_CAP_ROWS / RESERVE_FACTOR }).sizedBy, 'default', 'a projection of half the default room: the default room');
  const scanner = read('src', 'services', 'diskScanner.ts');
  assert.match(
    scanner,
    /if \(room\?\.sizedBy === 'projection'\) \{\n(?:\s*\/\/[^\n]*\n)*\s*scan\.engineReason = `\$\{scan\.engineReason\}; the memory store was sized for /,
    'the "sized for" clause is added only to a room a projection sized',
  );
  assert.match(read('src', 'services', 'scan', 'nativeEngine.ts'), /so it walked the tree again on the columns path/, 'a walk past its room says it walked the tree again');
  const serving = [...sources(path.join('src', 'api')), ...sources(path.join('src', 'mcp'))].filter((f) => read(f).includes('nativePlan'));
  assert.deepEqual(serving, [], 'no route or MCP tool serves the projection\'s reason');

  const r95 = lineStarting(read('docs', 'engine', 'RISKS.md'), '| R95 |');
  assert.doesNotMatch(r95, /says why the room was what it was/, 'not a sentence for every room');
  assert.match(r95, /`engineReason` says what it was sized for/, 'a sized room is said');
  assert.match(r95, /default room[^|]*says nothing of its room/, 'the default room is not');
  assert.match(r95, /that the tree was walked again/, 'only the walk again is');
  assert.match(r95, /no route serves/, 'and the projection\'s reason is not served');
});

/* ─────────────── DESIGN §14: which module a dist build compiles ─────────────── */

test('DESIGN §14 says a dist build compiles the module for the machine it runs on and refuses to package another target\'s, as the scripts do (review F1.3)', () => {
  // The code: build-native.js takes no target — it reads no argument and
  // builds and installs process.platform/process.arch's module — and every
  // dist script runs it and then check-prebuilt.js for the target it
  // packages, with afterPack.js holding the packaged copy to the same checks.
  const buildNative = read('scripts', 'build-native.js');
  assert.doesNotMatch(buildNative, /process\.argv|--target/, 'build-native.js takes no target');
  assert.match(buildNative, /library = libraryFileName\(process\.platform\)/, 'it builds this machine\'s library');
  assert.match(buildNative, /prebuiltDir\(REPO, process\.platform, process\.arch\)/, 'and installs it as this machine\'s module');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; build: { afterPack?: string } };
  const dists = Object.entries(pkg.scripts).filter(([name]) => name === 'dist' || name.startsWith('dist:'));
  assert.ok(dists.length >= 4, `the dist scripts are found (${dists.map(([n]) => n).join(', ')})`);
  for (const [name, command] of dists) {
    assert.match(command, /npm run build:native && node scripts\/check-prebuilt\.js\b/, `${name} builds this machine's module, then checks the packaged target's`);
  }
  assert.equal(pkg.build.afterPack, 'scripts/afterPack.js', 'afterPack.js checks the packaged copy');

  const bullet = lineStarting(read('docs', 'engine', 'DESIGN.md'), '* Web-mode users');
  assert.doesNotMatch(bullet, /for the target it packages/, 'not a cross-build build-native cannot do');
  assert.match(bullet, /compiles the module for the machine it runs on/, 'this machine\'s module');
  assert.match(bullet, /refuses to package unless `native\/prebuilt` holds the packaged target's module/, 'another target\'s is refused');
  assert.match(bullet, /`scripts\/check-prebuilt\.js` and `scripts\/afterPack\.js`/, 'by the two checks');
  assert.match(bullet, /installer for another OS comes from that OS's build/, 'so another OS\'s installer is built there');
});
