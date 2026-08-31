import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/services/query/parse';
import { NL_PHRASES, NL_STOPWORDS, translateNlQuery } from '../src/services/query/nlIntent';
import type { NlMatch } from '../src/services/query/nlIntent';

/**
 * Phase 9.6 — the deterministic natural-language intent table (v4 §9.6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTE: this file tests ONLY the pure translator. The HTTP route, the Ollama
 * passthrough, and the "shows the translated query before running it, always"
 * UI contract are the parent session's job and get their tests there.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The invariant defended above all others: EVERY query this module can emit
 * parses cleanly through the real Phase 2 grammar. A translation that produces
 * a red underline would be worse than no translation at all — the user asked in
 * English precisely because they do not know the grammar, so handing them a
 * broken query they cannot diagnose defeats the feature. The invariant is
 * asserted three ways: on every entry of the table in isolation, on every
 * entry's example end-to-end, and on every sentence in the natural-language
 * sweep below.
 */

/* -------------------------------- helpers -------------------------------- */

/** Translate and demand success, with the reason in the failure message. */
function okT(text: string): { ok: true; q: string; matched: NlMatch[]; unmatched: string[] } {
  const r = translateNlQuery(text);
  assert.equal(r.ok, true, `expected "${text}" to translate` + (r.ok ? '' : `, got: ${r.reason}`));
  return r as { ok: true; q: string; matched: NlMatch[]; unmatched: string[] };
}

/** The invariant, stated once: this string must survive the real parser. */
function assertParses(q: string, context: string): void {
  const p = parse(q);
  assert.equal(
    p.ok, true,
    `${context}: "${q}" must parse through the Phase 2 grammar` + (p.ok ? '' : ` — got: ${(p as { error: string }).error}`),
  );
}

/** Space-split terms of a composed query, for order-independent membership. */
function termsOf(q: string): string[] {
  return q.split(' ');
}

/* ============================ the flagship example ============================ */

test('the spec sentence: big videos I have not opened in a year', () => {
  // v4 §9.6's own example. The three semantic spans each become one grammar
  // term, the filler words vanish into the stopword list, and the whole query
  // parses. Membership is asserted order-independently because composition
  // order (input position) is pinned separately below.
  const r = okT('big videos I have not opened in a year');
  const terms = termsOf(r.q);
  assert.ok(terms.includes('size>1gb'), `size term missing from "${r.q}"`);
  assert.ok(terms.includes('ext:mp4,mov,mkv,avi,webm'), `video ext term missing from "${r.q}"`);
  assert.ok(terms.includes('used>1y'), `used term missing from "${r.q}"`);
  assert.equal(terms.length, 3, `nothing else belongs in "${r.q}"`);
  assert.equal(r.matched.length, 3, 'three phrases matched');
  assert.deepEqual(r.unmatched, [], '"I" and "have" are stopwords, not mystery words');
  assertParses(r.q, 'the flagship sentence');
});

/* ============================ the table invariant ============================ */

test('every entry in NL_PHRASES composes into a query that parses', () => {
  // This is the CRITICAL INVARIANT test. Anyone adding a phrase later gets
  // caught here if the term they wrote does not survive the real grammar —
  // for function terms the entry's own example drives a representative match.
  assert.ok(NL_PHRASES.length >= 25, 'the table covers at least the mandated phrasings');
  const labels = new Set<string>();
  for (const entry of NL_PHRASES) {
    assert.ok(entry.label.length > 0, 'every entry is labelled for the "what can I say?" UI');
    assert.ok(entry.example.length > 0, `entry "${entry.label}" carries an example`);
    assert.ok(!labels.has(entry.label), `label "${entry.label}" appears twice`);
    labels.add(entry.label);
    assert.ok(entry.pattern.flags.includes('i'), `entry "${entry.label}" must match case-insensitively`);

    // The term in isolation. A fresh RegExp so the table's own object is never
    // mutated (lastIndex) by testing.
    const probe = new RegExp(entry.pattern.source, 'i');
    const m = probe.exec(entry.example);
    assert.ok(m, `the example "${entry.example}" must trigger its own pattern (${entry.label})`);
    const termText = typeof entry.term === 'function' ? entry.term(m as RegExpExecArray) : entry.term;
    assertParses(termText, `entry "${entry.label}"`);

    // And end-to-end: the example fed through the whole translator, where an
    // earlier entry could in principle steal its words. It must still succeed.
    const r = okT(entry.example);
    assertParses(r.q, `example "${entry.example}"`);
  }
});

/* ============================ mandated phrasings ============================ */

test('duplicate photos in my downloads', () => {
  const r = okT('duplicate photos in my downloads');
  const terms = termsOf(r.q);
  assert.ok(terms.includes('dupe:yes'), r.q);
  assert.ok(terms.includes('ext:jpg,jpeg,png,heic,gif,webp'), r.q);
  assert.ok(terms.includes('in:~/Downloads'), r.q);
  assert.deepEqual(r.unmatched, []);
  assertParses(r.q, 'duplicates sentence');
});

test('old zips', () => {
  const r = okT('old zips');
  const terms = termsOf(r.q);
  assert.ok(terms.includes('modified>1y'), r.q);
  assert.ok(terms.includes('ext:zip,tar,gz,7z,rar'), r.q);
  // The "old" mapping is an approximation and says so, so the UI can explain.
  const oldMatch = r.matched.find((m) => m.term === 'modified>1y');
  assert.ok(oldMatch && oldMatch.note && /not modified/.test(oldMatch.note), '"old" carries its explanatory note');
  assertParses(r.q, 'old zips');
});

test('files I never opened', () => {
  // Pinning the exact composed string documents two shipped decisions at once:
  // terms compose in input-position order, and "files" maps to type:file.
  const r = okT('files I never opened');
  assert.equal(r.q, 'type:file used:never');
  assert.equal(r.matched.length, 2);
  assert.deepEqual(r.unmatched, []);
  assertParses(r.q, 'never opened');
});

test('videos I have not opened in two years', () => {
  // Spelled-out numbers go through the word→number map.
  const r = okT('videos I have not opened in two years');
  assert.ok(termsOf(r.q).includes('used>2y'), r.q);
  assertParses(r.q, 'two years');
});

test('gibberish is refused with a reason that names working examples', () => {
  const r = translateNlQuery('qwerty asdf');
  assert.equal(r.ok, false);
  const reason = (r as { ok: false; reason: string }).reason;
  // The reason must teach, not just refuse: two phrasings that genuinely work.
  assert.match(reason, /big videos I have not opened in a year/);
  assert.match(reason, /duplicate photos in my downloads/);
});

test('an empty or all-stopword input is refused, not translated to nothing', () => {
  // An empty q would mean "match everything", which the user never said.
  assert.equal(translateNlQuery('').ok, false);
  assert.equal(translateNlQuery('   ').ok, false);
  assert.equal(translateNlQuery('the my of and').ok, false);
});

test('words the table does not know surface in unmatched', () => {
  // The honest failure mode: translate what was understood, and SHOW what was
  // not, so the user can see the gap before running the query.
  const r = okT('huge videos from my vacation');
  assert.ok(termsOf(r.q).includes('size>1gb'), r.q);
  assert.ok(termsOf(r.q).includes('ext:mp4,mov,mkv,avi,webm'), r.q);
  // "my" is a stopword; "from" and "vacation" are genuinely not understood.
  assert.deepEqual(r.unmatched, ['from', 'vacation']);
});

test('same input, same output — twice, on both branches', () => {
  // No Date.now(), no randomness, no shared regex state: the translator is a
  // pure function, and deepEqual over full results proves it end to end.
  const rich = 'big old duplicate movies never opened small in my downloads';
  assert.deepEqual(translateNlQuery(rich), translateNlQuery(rich));
  assert.deepEqual(translateNlQuery('qwerty asdf'), translateNlQuery('qwerty asdf'));
});

test('a repeated phrase emits its term once', () => {
  const r = okT('videos videos');
  const occurrences = termsOf(r.q).filter((t) => t === 'ext:mp4,mov,mkv,avi,webm').length;
  assert.equal(occurrences, 1, `the ext term must appear exactly once in "${r.q}"`);
  // Both words were consumed and both are reported — the second one annotated,
  // so the UI can show why it added nothing.
  assert.equal(r.matched.length, 2);
  assert.ok(r.matched[1].note && /already/.test(r.matched[1].note));
  assertParses(r.q, 'repeated phrase');
});

test('"in documents" is the folder, bare "documents" is the extension set', () => {
  // The ambiguity the ordering rule exists for: folder phrases sit above the
  // extension words in the table, so the two-word phrase claims its words
  // first and the bare word keeps its own meaning.
  const folder = okT('in documents');
  assert.equal(folder.q, 'in:~/Documents');
  assertParses(folder.q, 'in documents');

  const exts = okT('documents');
  assert.equal(exts.q, 'ext:pdf,doc,docx,txt,md');
  assertParses(exts.q, 'bare documents');
});

/* ============================ composition rules ============================ */

test('a conflicting later term of the same field is dropped and annotated', () => {
  // "big small files" asks for two sizes at once. Keeping both would compose
  // size>1gb size<10mb — a query that matches nothing — so the first wins,
  // and the dropped match says so rather than disappearing silently.
  const r = okT('big small files');
  const terms = termsOf(r.q);
  assert.ok(terms.includes('size>1gb'), r.q);
  assert.ok(!terms.includes('size<10mb'), r.q);
  assert.ok(terms.includes('type:file'), r.q);
  const small = r.matched.find((m) => m.term === 'size<10mb');
  assert.ok(small && small.note && /conflicts with size>1gb/.test(small.note));
  assertParses(r.q, 'conflict handling');
});

test('"zip files" is one phrase — it does not leak a stray type:file', () => {
  // Longest-match-first consumption in action: the two-word phrase claims the
  // word "files" before the bare "files" entry can, because an ext term
  // already implies files.
  const r = okT('zip files');
  assert.deepEqual(termsOf(r.q), ['ext:zip,tar,gz,7z,rar']);
});

test('"disk images" wins over the photo reading of "images"', () => {
  const r = okT('disk images');
  assert.equal(r.q, 'ext:dmg,iso');
  assertParses(r.q, 'disk images');
});

test('weeks become days because the grammar has no week unit', () => {
  const r = okT('videos not opened in 3 weeks');
  assert.ok(termsOf(r.q).includes('used>21d'), r.q);
  assertParses(r.q, 'weeks');
});

test('spelled-out numbers one through twelve work, months keep the m unit', () => {
  const r = okT('files not opened in six months');
  assert.ok(termsOf(r.q).includes('used>6m'), r.q);
  assertParses(r.q, 'six months');
});

test('safe to delete maps onto the Reclaim Score, and says so', () => {
  const r = okT('safe to delete');
  assert.equal(r.q, 'score>70');
  assert.ok(r.matched[0].note && /Reclaim Score/.test(r.matched[0].note));
  assertParses(r.q, 'safe to delete');
});

test('empty folders is one phrase that emits two terms', () => {
  const r = okT('empty folders');
  assert.equal(r.q, 'type:dir empty:yes');
  assertParses(r.q, 'empty folders');
});

/* ============================ the stopword list ============================ */

test('the stopword list is visible, small, and strictly non-semantic', () => {
  // Exported so the UI can explain why "I" and "my" vanished. Words that MEAN
  // something must never be on it: "files" maps to type:file, "never" and
  // "not" negate, "in" starts folder phrases, "or" is grammar.
  assert.ok(NL_STOPWORDS.length > 0);
  for (const expected of ['i', 'my', 'me', 'the', 'a', 'an', 'that', 'this', 'have', 'has', 'had', 'been', 'of', 'and']) {
    assert.ok(NL_STOPWORDS.includes(expected), `"${expected}" belongs on the stopword list`);
  }
  for (const semantic of ['files', 'never', 'in', 'not', 'or', 'old', 'big']) {
    assert.ok(!NL_STOPWORDS.includes(semantic), `"${semantic}" is semantic and must not be a stopword`);
  }
});

/* ============================ the natural sweep ============================ */

test('a sweep of natural sentences: every translation and every shown term parses', () => {
  // Breadth over the whole table, including phrases interacting with each
  // other. For each sentence the invariant is asserted on the composed q AND
  // on every per-phrase term, because the UI shows both.
  const sentences = [
    'big videos I have not opened in a year',
    'duplicate photos in my downloads',
    'old zips',
    'small files on my desktop',
    'music never played',
    'installers in downloads',
    'documents not backed up',
    'dirty repos',
    'fully pushed folders',
    'empty folders in documents',
    'photos in the cloud',
    'local only videos',
    'junk files',
    'unique photos',
    "videos I haven't watched in five years",
    'unused for a year',
    'older than two years',
    'pdfs on my desktop',
    'recent screenshots',
    'big old duplicate movies never opened small in my downloads',
  ];
  for (const sentence of sentences) {
    const r = okT(sentence);
    assertParses(r.q, sentence);
    for (const m of r.matched) {
      assertParses(m.term, `${sentence} → phrase "${m.phrase}"`);
    }
  }
});
