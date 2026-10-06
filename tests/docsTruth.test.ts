import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-docsTruth-data-');

import { FAST_PATH_UNAVAILABLE, nativeEligibility, nativeRule, type EligibilityInput } from '../src/services/scan/nativeEngine';

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
