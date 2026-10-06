import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-docsTruth-data-');

import { FAST_PATH_UNAVAILABLE, nativeEligibility, nativeRule, type EligibilityInput } from '../src/services/scan/nativeEngine';
import { MEMORY_CAP_ROWS, RESERVE_FACTOR, memoryRoomFor, noRestartRefusal } from '../src/services/scan/nativeMemory';
import { ENDPOINTS } from '../src/api/openapi';

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

/* ─────────────── README: where a failed native walk says why ─────────────── */

test('the README says where each end of a failed native walk says why: the engine line for a walk again, the scan\'s own message for a refusal (review F1.4)', () => {
  // The code: in startScan's native catch, P4-14's refusal is thrown before
  // the walker's reason is recorded (noteFallback, why.push), so the scan
  // ends with it as its error and no engine line carries it; only a walk
  // again in the built-in walker records the reason the engine line is
  // painted from (tests/nativeNoFallbackAboveTmem.test.ts runs both ends).
  const fromRefusal = from(read('src', 'services', 'diskScanner.ts'), 'const refusal = noRestartRefusal(');
  const block = fromRefusal.slice(0, fromRefusal.indexOf('scan.engine = WALKER_ENGINE;'));
  const thrown = block.indexOf('if (refusal !== null) throw refusal;');
  assert.ok(thrown >= 0, 'a refusal is thrown');
  assert.ok(thrown < block.indexOf('noteFallback(scan, reason);') && thrown < block.indexOf('why.push(said(reason));'), 'before the walker\'s reason is recorded');
  const refusal = noRestartRefusal(new Error('the test breaks the walk'), 11, null, 10);
  assert.ok(refusal instanceof Error, 'past T_mem the refusal is an error the scan ends with');
  assert.match(refusal.message, /To scan it anyway/, 'and it says how to scan it anyway');

  const readme = read('README.md');
  const start = readme.indexOf('**The native scan engine lists a whole folder');
  assert.ok(start >= 0, 'the README has its native engine paragraph');
  const para = readme.slice(start, readme.indexOf('\n', start));
  assert.doesNotMatch(para, /Either way the Dashboard's engine line says why/, 'not the engine line for both ends');
  assert.match(para, /the built-in walker scans again from the start, and the Dashboard's engine line says why/, 'a walk again: the engine line');
  assert.match(para, /the scan ends instead, with a message that gives the reason and how to scan it anyway/, 'a refusal: the scan\'s own message');
});

/* ─────────────── ULTRA-ROADMAP: a release granted ahead of the phases ─────────────── */

test('ULTRA-ROADMAP names every release granted ahead of the phases in its standing rule, its approved exceptions and its order of work (review F1.5)', () => {
  // The record: each "Changed for X" under the Release bullet is the owner's
  // grant of a release before every phase is finished. The standing rule a
  // later session reads, the exceptions listed under it and step 11 of the
  // order must each name it, or that release reads as a breach of the rule.
  const doc = read('ULTRA-ROADMAP.md');
  lineStarting(doc, '- **Release:** none until every phase is finished');
  const granted = [...doc.matchAll(/^ {2}- \*\*Changed for (\d+\.\d+\.\d+) \([^)]+\):\*\*/gm)].map((m) => m[1]);
  assert.ok(granted.length >= 1, 'the Release bullet records a release granted ahead of the phases');
  const rule = lineStarting(doc, '- **No release until every phase is complete,**');
  const exceptions = from(doc, '**Exceptions you approved:**');
  const approved = exceptions.slice(0, exceptions.indexOf('\n---')).split('\n').filter((l) => l.startsWith('- '));
  const step11 = lineStarting(doc, '11. **Phase T step 2');
  for (const v of granted) {
    const ver = v.replace(/\./g, '\\.');
    assert.match(rule, new RegExp(`\\(except ${ver}, released ahead of the remaining phases at your request`), `the standing rule names ${v}`);
    assert.ok(approved.some((l) => l.includes(v) && l.includes('No release until every phase is complete')), `the exceptions you approved list ${v}`);
    assert.match(step11, new RegExp(`\\(${ver} excepted`), `step 11 names ${v}`);
  }
});

test('ULTRA-ROADMAP says how the Track U gate stands for every release granted ahead of the phases, wherever it makes the gate a condition of the release (review F2.1)', () => {
  // The record: the Track U plan's Progress row for the gate. A grant (the
  // test above) excepts a release from the phase rule only; the gate is a
  // separate condition of the release, so each place that states it says
  // how it stands for that release, the Release bullet says it as the
  // plan's row records it, and the exception says it does not cover it.
  // Otherwise the release reads as a breach of the gate.
  const doc = read('ULTRA-ROADMAP.md');
  const gateRow = lineStarting(read('docs', 'superpowers', 'plans', '2026-09-30-trackU-owner-issues.md'), '| Track U gate |');
  const notRun = /^\| Track U gate \| not run \|/.test(gateRow);
  const granted = [...doc.matchAll(/^ {2}- \*\*Changed for (\d+\.\d+\.\d+) \([^)]+\):\*\*/gm)].map((m) => m[1]);
  assert.ok(granted.length >= 1, 'the Release bullet records a release granted ahead of the phases');

  const conditions: Array<[string, string]> = [
    ['problem 3 of what you asked for', lineStarting(doc, '| 3 | "Thirdly')],
    ['step 13 of the order of work', lineStarting(doc, '13. **The Track U gate**')],
    ["the gate's own section", between(doc, '#### The Track U gate (before the release)', '\n#')],
    ['the Definition-of-Done row', lineStarting(doc, '| U1-U3 |')],
  ];
  for (const line of doc.split('\n').filter((l) => /release waits for (?:that gate|your decision)|a condition of the release/.test(l))) {
    assert.ok(conditions.some(([, text]) => text.includes(line)), `a line that makes the gate a condition of the release is one held here: ${line.slice(0, 80)}…`);
  }
  const exceptions = from(doc, '**Exceptions you approved:**');
  const approved = exceptions.slice(0, exceptions.indexOf('\n---')).split('\n').filter((l) => l.startsWith('- '));
  for (const v of granted) {
    const ver = v.replace(/\./g, '\\.');
    const bullet = lineStarting(doc, `  - **Changed for ${v} (`);
    if (notRun) {
      assert.match(bullet, new RegExp(`The Track U gate \\(below\\) has not been run for ${ver}, and whether ${ver} waits for it is your decision, not yet given`), `the Release bullet says the gate has not been run for ${v}, as the plan's row records`);
    } else {
      assert.doesNotMatch(bullet, /has not been run/, `the plan's row records the gate run, so the Release bullet does not say it was not (${gateRow.slice(0, 60)})`);
    }
    assert.match(bullet, /this change covers the phases only, not the gate/, `the Release bullet says ${v}'s grant does not cover the gate`);
    const exception = approved.find((l) => l.includes(v) && l.includes('No release until every phase is complete'));
    assert.ok(exception, `the exceptions you approved list ${v}`);
    assert.match(exception, /the phases, not the Track U gate/, `the exception for ${v} does not cover the gate`);
    for (const [where, text] of conditions) {
      const stands = notRun ? 'the gate has not been run, and' : '(?!the gate has not been run)[^)]*';
      assert.match(text, new RegExp(`\\(${ver}: ${stands} whether ${ver} waits for it is your decision; see the Release bullet at the top\\)`), `${where} says how the gate stands for ${v}`);
    }
  }
});

/** `doc`'s paragraphs (and table blocks) with struck-through text removed and each run of whitespace made one space. */
const paragraphs = (doc: string): string[] =>
  doc.replace(/~~[\s\S]*?~~/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());

test('ULTRA-ROADMAP and DESIGN say P4-14 is built above T_mem in memory mode (Track U U-32), as startScan does (found with review F1.5; DESIGN, review F2.2)', () => {
  // The code: a native walk that fails part-way above T_mem is refused a
  // walk again in the built-in walker (noRestartRefusal; startScan throws it,
  // the README test above). The roadmap still called P4-14 "decided, not
  // built" in three places, and said nothing enforces T_mem; DESIGN §6
  // still called it "pending the owner".
  const refusal = noRestartRefusal(new Error('the test breaks the walk'), 11, null, 10);
  assert.ok(refusal instanceof Error, 'P4-14 is built: a failure above T_mem ends the scan');
  const doc = read('ULTRA-ROADMAP.md');
  const p414 = doc.split('\n').filter((l) => l.includes('P4-14'));
  assert.ok(p414.length >= 3, 'the roadmap names P4-14');
  for (const line of p414) {
    assert.doesNotMatch(line, /decided,? (?:but )?not built|Decided, not built/, `not "not built": ${line.slice(0, 80)}…`);
  }
  assert.ok(p414.every((l) => l.includes('U-32')), 'each line that names P4-14 says U-32 built it');
  assert.doesNotMatch(doc, /nothing enforces `T_mem` yet/, 'T_mem is enforced where a native walk fails');

  // DESIGN is wrapped, so it is read a paragraph at a time.
  const design = paragraphs(read('docs', 'engine', 'DESIGN.md')).filter((p) => p.includes('P4-14'));
  assert.ok(design.length >= 2, 'DESIGN names P4-14 in §6 and §6.1');
  for (const para of design) {
    assert.doesNotMatch(para, /P4-14,? pending the owner|pending the owner[^.]*P4-14/, `not "pending the owner": ${para.slice(0, 80)}…`);
    assert.match(para, /U-32/, `each paragraph that names P4-14 says U-32 built it: ${para.slice(0, 80)}…`);
  }
  const rule = design.find((p) => p.includes('No legacy engine takes over'));
  assert.ok(rule, 'DESIGN §6 states the rule');
  assert.match(rule, /\(P4-14, decided by the owner on 28 Sep 2026, plan §S\.11 Q10\)/, 'the rule is the owner\'s decision of 28 Sep');
  assert.match(rule, /Track U U-32 built it above `T_mem` in memory mode/, 'built above T_mem in memory mode');
  assert.match(rule, /spill and aggregate are not built/, 'and the modes it also covers do not exist yet');
});

test('DESIGN and RISKS call nothing pending the owner that the Phase 4 plan records as decided (review F2.2)', () => {
  // The record: each question of the Phase 4 plan's §S.11 carries its status,
  // and the P4-x rule its title names. A "pending the owner" that names one
  // the owner has decided (by its Q, or by the rule it decides) is stale.
  const plan = read('docs', 'superpowers', 'plans', '2026-09-18-phase4-storage.md');
  const s11 = between(plan, '#### S.11 Open questions for the owner', '\n#');
  const decided = new Set<string>();
  const rulesOf = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of s11.split('\n')) {
    const q = /^\d+\. \*\*(Q\d+) —/.exec(line);
    if (q) {
      current = q[1];
      const rules = [...line.matchAll(/P4-\d+[a-z]?/g)].map((m) => m[0]);
      if (rulesOf.has(current)) throw new Error(`${current} is listed twice`);
      rulesOf.set(current, rules);
      continue;
    }
    if (current !== null && /^\s+- \*\*Status: decided by the owner/.test(line)) decided.add(current);
  }
  assert.ok(decided.has('Q5') && decided.has('Q10'), `the plan's decided questions are read (${[...decided].join(', ')})`);
  assert.deepEqual(rulesOf.get('Q10'), ['P4-14'], 'Q10 is the question that decides P4-14');
  const decides = (ref: string): boolean =>
    decided.has(ref) || [...decided].some((q) => (rulesOf.get(q) ?? []).includes(ref));

  const stale: string[] = [];
  for (const file of [['docs', 'engine', 'DESIGN.md'], ['docs', 'engine', 'RISKS.md'], ['ULTRA-ROADMAP.md']]) {
    const text = paragraphs(read(...file)).join(' ');
    const said = [
      ...[...text.matchAll(/\(([^()]*pending the owner[^()]*)\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/pending the owner,? \(([^()]*)\)/g)].map((m) => m[1]),
    ];
    for (const words of said) {
      const refs = [...words.matchAll(/\bQ\d+\b|P4-\d+[a-z]?/g)].map((m) => m[0]);
      if (refs.some(decides)) stale.push(`${file.join('/')}: "${words}"`);
    }
  }
  assert.deepEqual(stale, [], 'no question the owner decided is called pending');

  const design = paragraphs(read('docs', 'engine', 'DESIGN.md')).join(' ');
  assert.match(design, /Live mode and container expansion, because the store is read-only \(decided by the owner on 28 Sep 2026, plan §S\.11 Q5\)/, 'DESIGN §6: Q5 decided');
  const risks = read('docs', 'engine', 'RISKS.md');
  assert.match(lineStarting(risks, '| R78 |'), /that T20 lands inside Phase 4 was decided by the owner on 28 Sep 2026, plan §S\.11 Q13/, 'R78: Q13 decided');
  assert.match(lineStarting(risks, '| R80 |'), /that it lands inside Phase 4 was decided by the owner on 28 Sep 2026, plan §S\.11 Q6/, 'R80: Q6 decided');
  assert.match(lineStarting(risks, '| R81 |'), /Live mode and container expansion off in the large modes was decided by the owner on 28 Sep 2026 \(plan §S\.11 Q5\)/, 'R81: Q5 decided');
});

/* ─────────────── AGENTS.md: the sentences the 5.2.0 docs batch changed ─────────────── */

/** AGENTS.md with every run of whitespace made one space, so a sentence can be matched across its line wraps. */
const agents = (): string => read('AGENTS.md').replace(/\s+/g, ' ');

/** The text of `doc` between `start` and the next `end` after it, hard-failing when either is missing. */
function between(doc: string, start: string, end: string): string {
  const a = doc.indexOf(start);
  assert.notEqual(a, -1, `"${start}" exists`);
  const b = doc.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `"${end}" follows "${start}"`);
  return doc.slice(a + start.length, b);
}

test('AGENTS.md lists exactly the engines a scan can report, as ScanResult\'s union names them (review F1.6)', () => {
  const union = /\n  engine\?: ((?:'[a-z-]+'(?: \| )?)+);/.exec(read('src', 'models', 'types.ts'));
  assert.ok(union, "ScanResult's engine union is found in types.ts");
  const engines = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  const listed = between(agents(), '`/stats.engine` names the engine that ran — ', ' — and `engineReason`');
  assert.deepEqual([...listed.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort(), engines, `AGENTS.md lists the union's engines: ${listed}`);
});

test('AGENTS.md says what a fast-rescan request does as startScan does it (review F1.6)', () => {
  // The code: the request is skipped where the native engine walks, the
  // skip is said in engineReason, and the answer's incremental is whether a
  // cache was read (POST /api/scan's answer and the stats both carry it).
  const scanner = read('src', 'services', 'diskScanner.ts');
  assert.match(scanner, /const fastRescanSkipped = opts\.incremental === true && nativeWalk !== null;\n\s*const incremental = opts\.incremental === true && !fastRescanSkipped;/, 'skipped where the native engine walks');
  assert.match(scanner, /\.\.\.\(fastRescanSkipped \? \[FAST_RESCAN_NOT_USED\] : \[\]\)/, 'and said in engineReason');
  assert.match(scanner, /\n\s*incremental: !!cache,\n/, 'the record\'s incremental is whether a cache was read');
  assert.match(read('src', 'api', 'scanRoutes.ts'), /res\.status\(202\)\.json\(\{ scanId: scan\.scanId, incremental: scan\.incremental === true \}\)/, 'and POST /api/scan\'s answer carries it');
  const text = agents();
  assert.match(text, /`incremental: true` asks for a fast rescan, which only the built-in walker does/, 'the walker\'s');
  assert.match(text, /where the native engine walks the folder the request is not used, and `engineReason` says so/, 'not used where the native engine walks');
  assert.match(text, /The answer's `incremental` says whether saved listings were reused/, 'the answer says what happened');
});

test('AGENTS.md describes the mountedInside line as mountedInsideLine builds it (review F1.6)', () => {
  // The behaviour is tests/missingGigabytes.test.ts's (U-28); this holds the
  // sentence to the branches that produce it.
  const source = read('src', 'services', 'missingGigabytes.ts');
  const body = between(source, 'function mountedInsideLine(scan: ScanResult): StatementLine {', '\n}\n');
  assert.match(body, /const unknown = \(reason: string, count: number \| null, more\?: string\): StatementLine => \(\{\s*id: 'mountedInside', label, bytes: null, available: false, reason,/, 'an unknown line is null with its reason');
  assert.match(body, /if \(report\.rule === null\) \{\s*return unknown\(/, 'unknown where the scan did not read the table');
  assert.match(body, /if \(!report\.known\) \{\s*return unknown\(/, 'unknown where the table could not be read');
  assert.match(body, /if \(crossed\.count > 0\) \{\s*return unknown\(/, 'unknown where the walk went onto a device the table does not list');
  const windows = between(body, "if (report.source === 'none' && report.reason) {", '\n  }\n');
  assert.match(windows, /^\s*return \{\s*id: 'mountedInside', label, bytes: 0, available: true,[\s\S]*\n\s*count: null,/, 'Windows: a measured 0 with no count');
  const stay = between(body, "if (report.rule === 'stay') {", '\n  }\n');
  assert.match(stay, /^\s*const n = report\.notEntered\.count;\s*return \{\s*id: 'mountedInside', label, bytes: 0, available: true,[\s\S]*\n\s*count: n,/, 'stay: a measured 0 with the count');
  assert.match(body, /const n = report\.entered\.count;[\s\S]*?return unknown\(/, 'cross into a drive: unknown');
  const text = agents();
  assert.match(text, /`mountedInside`, the drives mounted inside the scanned folder\. Under "Stay on this drive" it is a measured 0, since the scan entered none, with their count \(`null` on Windows, which keeps no mount table\)\./);
  assert.match(text, /It is unknown, with the reason, after a scan that entered any \(`"cross"`\)/);
  assert.match(text, /when the mount table could not be read or the scan did not read it; and when the walk went onto a device the table does not list\./);
});

test('AGENTS.md says how the index readers answer an index that is not finished, as the routes and the spec do (review F1.6)', () => {
  const routes = read('src', 'api', 'indexRoutes.ts');
  const tree = between(routes, "indexRouter.get('/index/tree'", 'const maxNodes');
  assert.match(tree, /res\.status\(202\)\.json\(\{ status: 'running', root \}\)/, '/api/index/tree: 202 running while building');
  assert.match(tree, /throw new AppError\(500, 'INDEX_BUILD_FAILED'/, 'and 500 after a failed build');
  const unread = between(routes, 'function answeredUnread(', '\n}\n');
  assert.match(unread, /res\.status\(202\)\.json\(\{ status: 'building' \}\)/, 'allocation: 202 building');
  assert.match(unread, /throw new AppError\(500, 'INDEX_BUILD_FAILED'/, 'and 500 after a failed build');
  assert.equal((routes.match(/if \(answeredUnread\(root, res\)\) return;/g) ?? []).length, 2, 'both allocation routes ask it first');
  assert.match(read('src', 'services', 'indexEngine.ts'), /const roots = listRoots\(\)\.filter\(\(r\) => r\.state === 'ready' \|\| r\.state === 'stale'\);/, 'search reads finished roots only');
  const accountant = read('src', 'services', 'allocationAccountant.ts');
  assert.match(accountant, /if \(!allocationMeasured\(root\)\) throw new AppError\(409, 'ALLOCATION_NOT_MEASURED'/, '409 where allocation was not measured');
  assert.match(accountant, /return root\.mechanism !== MECHANISM_FROM_SCAN && platform\(\)\.blocksAreMeaningful;/, 'which is Windows (no blocks) or an index built from a scan');
  assert.match(read('src', 'platform', 'windows', 'index.ts'), /override get blocksAreMeaningful\(\): boolean \{\s*return false;/, 'Windows reports no blocks');

  // The spec says the same, so an agent reading either is told one thing.
  const spec = (p: string) => {
    const e = ENDPOINTS.find((x) => x.method === 'get' && x.path === p);
    assert.ok(e, `${p} is described`);
    return e.responses as Record<string, { description: string; content?: { 'application/json': { schema: { properties?: Record<string, unknown> } } } }>;
  };
  const treeSpec = spec('/api/index/tree');
  assert.match(treeSpec['500']?.description ?? '', /INDEX_BUILD_FAILED/, 'the spec gives /api/index/tree its 500');
  assert.deepEqual(Object.keys(treeSpec['202']?.content?.['application/json'].schema.properties ?? {}).sort(), ['root', 'status'], "the spec's 202 for /api/index/tree is the body the route sends");
  for (const p of ['/api/allocation', '/api/allocation/file']) {
    const r = spec(p);
    assert.ok(r['202'], `${p}: 202`);
    assert.match(r['409']?.description ?? '', /ALLOCATION_NOT_MEASURED/, `${p}: 409`);
    assert.match(r['500']?.description ?? '', /INDEX_BUILD_FAILED/, `${p}: 500`);
  }

  const text = agents();
  assert.match(text, /while a folder's index is being built `GET \/api\/index\/tree` answers `202` with `status: "running"`/);
  assert.match(text, /`GET \/api\/allocation` and `\/api\/allocation\/file` answer `202 \{ status: "building" \}`/);
  assert.match(text, /`\/api\/search` searches only finished indexes/);
  assert.match(text, /after a failed build the tree and allocation routes answer `500 INDEX_BUILD_FAILED`/);
  assert.match(text, /answer `409 ALLOCATION_NOT_MEASURED`, with a sentence and no number, where TreeMap did not measure what the files occupy — on Windows, which reports no blocks/);
});

test('the Track U plan calls a test a reader of AGENTS.md only where it reads it, and names as comment-only readers only tests that are (review F1.6, F2.3)', () => {
  // U-40's row named nine tests "AGENTS.md's readers"; each names AGENTS.md
  // in a comment only. A reader is a test whose code (not a comment) names
  // the file. The guard does not depend on the row's wording (review F2.3):
  // every sentence of the row that names tests and AGENTS.md is held to the
  // code, whichever way it is worded, and a sentence that speaks of
  // AGENTS.md's readers without naming them fails.
  const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
  const readsAgents = (name: string): boolean =>
    read('tests', `${name}.test.ts`).split('\n').some((l) => !COMMENT.test(l) && /['"]AGENTS\.md['"]/.test(l));
  const testNames = new Set(readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => f.slice(0, -'.test.ts'.length)));
  // A test is named as `tests/<name>.test.ts`, or in a parenthesised list
  // whose every item is a test: never as a bare word, since `notes` and
  // `scanBoundary` are test files and words of the row alike.
  const named = (sentence: string): string[] => {
    const out = [...sentence.matchAll(/tests\/([A-Za-z0-9]+)\.test\.ts/g)].map((m) => m[1]);
    for (const m of sentence.matchAll(/\(([^()]*)\)/g)) {
      const items = m[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim());
      if (items.every((x) => testNames.has(x))) out.push(...items);
    }
    return out;
  };
  const SPEAKS_OF_READERS = /readers? of AGENTS\.md|AGENTS\.md['’]s readers?|\breads? AGENTS\.md/;
  const COMMENT_ONLY = /in a comment only|no test read/;

  const row = lineStarting(read('docs', 'superpowers', 'plans', '2026-09-30-trackU-owner-issues.md'), '| U-40 ');
  const held: string[] = [];
  for (const sentence of row.split(/(?<=[.!?])\s+(?=[A-Z*`])/)) {
    const names = named(sentence);
    if (SPEAKS_OF_READERS.test(sentence)) assert.ok(names.length > 0, `a sentence that speaks of AGENTS.md's readers names them: ${sentence.slice(0, 120)}…`);
    if (names.length === 0 || !sentence.includes('AGENTS.md')) continue;
    const commentOnly = COMMENT_ONLY.test(sentence);
    for (const name of names) {
      if (commentOnly) assert.equal(readsAgents(name), false, `${name} is said to name AGENTS.md in a comment only, but it reads it`);
      else assert.ok(readsAgents(name), `${name} is called a reader of AGENTS.md but does not read it`);
      held.push(`${name}:${commentOnly ? 'comment' : 'reads'}`);
    }
  }
  assert.ok(held.includes('docsTruth:reads'), `the row names the test that reads AGENTS.md (held: ${held.join(', ')})`);
  assert.ok(held.some((h) => h.endsWith(':comment')), `the row's correction is held to the tests it names (held: ${held.join(', ')})`);
});
