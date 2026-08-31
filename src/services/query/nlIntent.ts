/**
 * Phase 9.6 — the deterministic half of natural-language querying (v4 §9.6).
 *
 * A small, fixed table of English phrasings mapped onto the Phase 2 grammar:
 * "big videos I have not opened in a year" → `size>1gb ext:mp4,mov,mkv,avi,webm
 * used>1y`. The translation is shown to the user before anything runs, always,
 * and the user can edit it — which is why every piece of this module is built
 * to be explainable: each match reports the exact words it consumed, the term
 * they became, and (where the mapping is an approximation, or where a term was
 * dropped) a note saying why.
 *
 * The Ollama passthrough and the HTTP route are deliberately NOT here. This
 * module is a pure function with no imports, no network, no clock and no
 * randomness: the same input always produces the same output, so it can run on
 * every keystroke and be tested exhaustively.
 *
 * ── The invariant ──
 *
 * EVERY query this module can emit parses cleanly through `parse()` in
 * ./parse.ts. A translation that produced a red underline would be worse than
 * no translation: the user asked in English precisely because they do not know
 * the grammar, so a broken query is one they cannot diagnose. The invariant is
 * enforced by tests/nlQuery.test.ts, which drives every table entry through
 * the real parser; keeping the module import-free means the invariant lives in
 * one place rather than being re-checked (and re-trusted) at runtime.
 *
 * ── The ordering rule ──
 *
 * The table is applied top to bottom and matched spans are CONSUMED, so no
 * word is ever claimed twice. That makes ordering load-bearing: any entry
 * whose phrase contains a word that a later entry would also claim MUST appear
 * first. This is how "in documents" means the ~/Documents folder while a bare
 * "documents" means the document extensions, how "empty folders" emits
 * `type:dir empty:yes` without the bare "folders" entry firing again, how
 * "zip files" avoids leaking a stray `type:file`, and how "not backed up"
 * beats "backed up". In short: longest, most specific phrase first.
 *
 * ── What is NOT translated ──
 *
 * Words the table does not know are returned in `unmatched` rather than being
 * guessed at (they never silently become name: searches), and only a short,
 * visible list of genuinely non-semantic stopwords is dropped. Surfacing the
 * leftovers is the honest failure mode: the user sees exactly which part of
 * their sentence the translator did not understand, before running anything.
 */

/* --------------------------------- types --------------------------------- */

/** One consumed span of the input and the grammar term it became. */
export interface NlMatch {
  /** The exact words consumed, as they appeared in the input. */
  phrase: string;
  /** The grammar term(s) this phrase maps to, e.g. `used>1y`. */
  term: string;
  /** Why the mapping is approximate, or why the term was not added to q. */
  note?: string;
}

export type NlTranslation =
  | { ok: true; q: string; matched: NlMatch[]; unmatched: string[] }
  | { ok: false; reason: string };

/** One row of the phrase table, exported so the UI can render "what can I say?". */
export interface NlPhrase {
  /** Case-insensitive. Applied with fresh state on every call, never mutated. */
  pattern: RegExp;
  /** The grammar term, or a function of the match for numeric phrasings. */
  term: string | ((m: RegExpExecArray) => string);
  /** Human-readable phrasing for the help UI, e.g. "big / large / huge". */
  label: string;
  /** A minimal input that triggers this entry — the help UI's sample and the test corpus's probe. */
  example: string;
  /** Shown next to the translation when the mapping is an approximation. */
  note?: string;
}

/* ------------------------------ number words ------------------------------ */

/**
 * "in two years" and "in 2 years" must mean the same thing, so spelled-out
 * numbers one through twelve are mapped explicitly. Beyond twelve people write
 * digits, and the patterns accept those directly.
 */
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function countOf(word: string): number {
  const named = NUMBER_WORDS[word.toLowerCase()];
  if (named !== undefined) return named;
  // The patterns only capture \d+ here, so this cannot be NaN; the guard keeps
  // the function total anyway, because a silent NaN would break the invariant.
  const digits = parseInt(word, 10);
  return Number.isFinite(digits) ? digits : 1;
}

/**
 * Compose an age comparison. The grammar's units are d, m and y only, so weeks
 * are translated into days rather than inventing a unit the parser rejects.
 */
function ageTerm(field: 'used' | 'modified', numberWord: string, unitWord: string): string {
  const n = countOf(numberWord);
  const unit = unitWord.toLowerCase();
  if (unit.startsWith('year')) return `${field}>${n}y`;
  if (unit.startsWith('month')) return `${field}>${n}m`;
  if (unit.startsWith('week')) return `${field}>${n * 7}d`;
  // Days — the only remaining unit the patterns admit.
  return `${field}>${n}d`;
}

/* ------------------------- shared pattern fragments ------------------------ */

// Built once from fragments so the three duration entries cannot drift apart.
const NUM = String.raw`(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)`;
const UNIT = String.raw`(years?|months?|weeks?|days?)`;
// "in over a year", "for more than 6 months", "in the last year" all read
// naturally as the same age comparison.
const ABOUT = String.raw`(?:the\s+last\s+|over\s+|more\s+than\s+)?`;
const OPEN_VERBS = String.raw`(?:opened|used|touched|accessed|watched|played)`;

/* -------------------------------- the table -------------------------------- */

/**
 * Ordering is load-bearing — see the header. Sections:
 *   1. multi-word phrases that must claim their words before single-word
 *      entries can (durations, folders, negations, compound nouns);
 *   2. single-word mappings.
 */
export const NL_PHRASES: readonly NlPhrase[] = [
  /* ---- 1. phrases that must win their words first ---- */
  {
    pattern: /\bsafe\s+to\s+(?:delete|remove|trash|clean\s+up)\b/i,
    term: 'score>70',
    label: 'safe to delete / safe to remove',
    example: 'safe to delete',
    note: 'ranked by Reclaim Score',
  },
  {
    // "junk" is what people actually call reclaimable space; same score gate.
    pattern: /\b(?:junk|cruft)\b/i,
    term: 'score>70',
    label: 'junk / cruft',
    example: 'junk',
    note: 'ranked by Reclaim Score',
  },
  {
    // Before the bare "folders" entry, so the word is not claimed twice.
    pattern: /\bempty\s+(?:folders?|directories|dirs?)\b/i,
    term: 'type:dir empty:yes',
    label: 'empty folders',
    example: 'empty folders',
  },
  {
    // "have not opened in a year", "haven't used in 2 years", "never watched
    // in six months" — a negated verb plus a duration. Sits above the bare
    // "never opened" entry because it consumes a longer span when the
    // duration is present.
    pattern: new RegExp(
      String.raw`\b(?:(?:have|has|had)\s+not|haven't|havent|hasn't|hasnt|hadn't|hadnt|not|never)(?:\s+been)?\s+` +
      OPEN_VERBS + String.raw`\s+(?:in|for)\s+` + ABOUT + NUM + String.raw`\s+` + UNIT + String.raw`\b`, 'i'),
    term: (m) => ageTerm('used', m[1], m[2]),
    label: "not opened in a year / haven't used in 2 years / not touched in six months",
    example: 'not opened in a year',
  },
  {
    // The adjectival spelling of the same thing.
    pattern: new RegExp(
      String.raw`\b(?:unused|untouched|unopened)\s+(?:in|for)\s+` + ABOUT + NUM + String.raw`\s+` + UNIT + String.raw`\b`, 'i'),
    term: (m) => ageTerm('used', m[1], m[2]),
    label: 'unused for a year / untouched for 6 months',
    example: 'unused for a year',
  },
  {
    // No duration → no last-opened date at all. After the duration entries,
    // so "never opened in two years" keeps its number.
    pattern: new RegExp(String.raw`\b(?:(?:have|has|had)\s+)?never\s+(?:been\s+)?` + OPEN_VERBS + String.raw`\b|\bunopened\b`, 'i'),
    term: 'used:never',
    label: 'never opened / never used / unopened',
    example: 'never opened',
  },
  {
    // Above the bare "old" entry so the explicit duration wins.
    pattern: new RegExp(String.raw`\bolder\s+than\s+(?:over\s+)?` + NUM + String.raw`\s+` + UNIT + String.raw`\b`, 'i'),
    term: (m) => ageTerm('modified', m[1], m[2]),
    label: 'older than a year / older than 6 months',
    example: 'older than a year',
  },
  {
    // The negation MUST sit above "backed up", or "not backed up" would match
    // the positive phrase and leave a stray "not" — the inverted query.
    pattern: /\b(?:(?:have|has)\s+not\s+been|haven't\s+been|hasn't\s+been|not|isn't|isnt|aren't|arent|never)\s+backed\s+up\b/i,
    term: 'backup:no',
    label: 'not backed up',
    example: 'not backed up',
  },
  {
    pattern: /\bbacked\s+up\b/i,
    term: 'backup:yes',
    label: 'backed up',
    example: 'backed up',
  },
  {
    // Folder phrases sit above the extension words: "in documents" is the
    // ~/Documents folder, bare "documents" is the extension set. The optional
    // trailing "folder" is consumed too, so it cannot fire the type:dir entry.
    pattern: /\b(?:in|from|inside|under)\s+(?:my\s+|the\s+|our\s+)?downloads(?:\s+folder)?\b/i,
    term: 'in:~/Downloads',
    label: 'in my downloads',
    example: 'in downloads',
  },
  {
    pattern: /\b(?:on|in|from|inside|under)\s+(?:my\s+|the\s+|our\s+)?desktop(?:\s+folder)?\b/i,
    term: 'in:~/Desktop',
    label: 'on my desktop',
    example: 'on my desktop',
  },
  {
    pattern: /\b(?:in|from|inside|under)\s+(?:my\s+|the\s+|our\s+)?documents(?:\s+folder)?\b/i,
    term: 'in:~/Documents',
    label: 'in my documents',
    example: 'in documents',
  },
  {
    // Bare "downloads" and "desktop" have no other reading in a disk tool, so
    // they map to their folders even without a preposition. There is
    // deliberately NO bare-folder entry for "documents": that word belongs to
    // the extension mapping below, and only the prepositioned phrase means
    // the folder.
    pattern: /\bdownloads(?:\s+folder)?\b/i,
    term: 'in:~/Downloads',
    label: 'downloads',
    example: 'downloads',
  },
  {
    pattern: /\bdesktop(?:\s+folder)?\b/i,
    term: 'in:~/Desktop',
    label: 'desktop',
    example: 'desktop',
  },
  {
    // The negative cloud phrases sit above "synced" for the same reason
    // "not backed up" sits above "backed up".
    pattern: /\b(?:local[-\s]only|only\s+on\s+this\s+(?:computer|machine|mac|pc|laptop)|(?:not|never)\s+(?:in\s+the\s+cloud|synced))\b/i,
    term: 'cloud:local-only',
    label: 'local only / only on this computer / not synced',
    example: 'local only',
  },
  {
    pattern: /\b(?:in\s+the\s+cloud|cloud[-\s]synced|synced(?:\s+to\s+the\s+cloud)?)\b/i,
    term: 'cloud:synced',
    label: 'in the cloud / synced',
    example: 'in the cloud',
  },
  {
    pattern: /\b(?:dirty(?:\s+(?:repos?|repositories|projects?))?|uncommitted)\b/i,
    term: 'git:dirty',
    label: 'dirty repos / uncommitted',
    example: 'dirty repos',
  },
  {
    // The lookbehinds keep "not pushed" from being read as git:pushed with a
    // stray "not" left over — the exact inverse of what was asked. The words
    // stay unmatched instead, which the UI surfaces.
    pattern: /(?<!\bnot\s)(?<!n't\s)\b(?:fully\s+)?pushed\b/i,
    term: 'git:pushed',
    label: 'fully pushed / pushed',
    example: 'fully pushed',
  },
  {
    // Above the photo entry, or the "images" half would be claimed as photos.
    pattern: /\bdisk\s+images?\b/i,
    term: 'ext:dmg,iso',
    label: 'disk images',
    example: 'disk images',
  },
  {
    // "zip files" is one phrase: the ext term already implies files, so the
    // word "files" is consumed here rather than leaking a stray type:file.
    // Inside the alternation the longer spelling comes first, because JS
    // alternation is leftmost-first and "zips?" would otherwise split it.
    pattern: /\b(?:archives?|zip\s+files?|zips?|compressed\s+files?)\b/i,
    term: 'ext:zip,tar,gz,7z,rar',
    label: 'archives / zips / zip files',
    example: 'zip files',
  },
  {
    pattern: /\b(?:installers?|setup\s+files?)\b/i,
    term: 'ext:dmg,pkg,msi,exe,deb',
    label: 'installers / setup files',
    example: 'installers',
  },
  {
    // Above "duplicates" so the negation wins its words.
    pattern: /\b(?:not\s+(?:duplicates?|duplicated|dupes?)|unique)\b/i,
    term: 'dupe:no',
    label: 'not duplicated / unique',
    example: 'unique',
  },

  /* ---- 2. single-word mappings ---- */
  {
    pattern: /\b(?:duplicates?|duplicated|dupes?)\b/i,
    term: 'dupe:yes',
    label: 'duplicates / dupes',
    example: 'duplicates',
  },
  {
    pattern: /\b(?:videos?|movies?|films?)\b/i,
    term: 'ext:mp4,mov,mkv,avi,webm',
    label: 'videos / movies / films',
    example: 'videos',
  },
  {
    pattern: /\b(?:photos?|pictures?|pics?|images?)\b/i,
    term: 'ext:jpg,jpeg,png,heic,gif,webp',
    label: 'photos / pictures / images',
    example: 'photos',
  },
  {
    pattern: /\b(?:music|songs?|audio)\b/i,
    term: 'ext:mp3,m4a,flac,wav,aac',
    label: 'music / songs / audio',
    example: 'music',
  },
  {
    pattern: /\bpdfs?\b/i,
    term: 'ext:pdf',
    label: 'pdfs',
    example: 'pdfs',
  },
  {
    pattern: /\b(?:documents?|docs?)\b/i,
    term: 'ext:pdf,doc,docx,txt,md',
    label: 'documents / docs',
    example: 'documents',
  },
  {
    pattern: /\b(?:big|large|huge|massive|giant|enormous)\b/i,
    term: 'size>1gb',
    label: 'big / large / huge',
    example: 'big',
    note: 'big ≈ over 1 GB',
  },
  {
    pattern: /\b(?:small|tiny|little)\b/i,
    term: 'size<10mb',
    label: 'small / tiny',
    example: 'small',
    note: 'small ≈ under 10 MB',
  },
  {
    pattern: /\bold\b/i,
    term: 'modified>1y',
    label: 'old',
    example: 'old',
    note: 'old ≈ not modified in a year',
  },
  {
    // Longer alternative first, so "recently modified" is not split after
    // "recent" fails its trailing word boundary.
    pattern: /\b(?:recently\s+(?:modified|changed|edited)|recent)\b/i,
    term: 'modified<30d',
    label: 'recent / recently modified',
    example: 'recent',
    note: 'recent ≈ modified in the last 30 days',
  },
  {
    pattern: /\b(?:folders?|directories|dirs?)\b/i,
    term: 'type:dir',
    label: 'folders / directories',
    example: 'folders',
  },
  {
    pattern: /\bfiles?\b/i,
    term: 'type:file',
    label: 'files',
    example: 'files',
  },
];

/* ------------------------------- stopwords ------------------------------- */

/**
 * Words dropped from `unmatched` because they carry no filter meaning. Kept
 * deliberately tiny and strictly non-semantic: "files" maps to type:file,
 * "never"/"not" negate, "in" starts folder phrases and "or" belongs to the
 * grammar, so none of those may ever appear here — hiding a semantic word
 * would hide a misunderstanding. "i've" is pure filler when it survives the
 * phrase patterns; "haven't" is NOT listed, because a stray "haven't" means a
 * negation phrase failed to complete and the user should see that.
 */
export const NL_STOPWORDS: readonly string[] = [
  'a', 'an', 'and', 'been', 'had', 'has', 'have', 'i', "i've", 'me', 'my', 'of', 'that', 'the', 'this',
];

const STOPWORD_SET = new Set(NL_STOPWORDS);

/* ------------------------------ the translator ------------------------------ */

interface FoundMatch {
  start: number;
  end: number;
  entry: NlPhrase;
  m: RegExpExecArray;
}

/** True when [start, end) overlaps any already-consumed span. */
function overlaps(spans: { start: number; end: number }[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

/** The field name of an emitted term, for the keep-first-per-field rule. */
function fieldOf(component: string): string {
  const m = /^[a-z]+/i.exec(component);
  return m ? m[0].toLowerCase() : component;
}

/**
 * Translate one English sentence into a grammar query.
 *
 * Deterministic by construction: no clock, no randomness, and every RegExp is
 * cloned before use so no lastIndex state survives between calls.
 */
export function translateNlQuery(text: string): NlTranslation {
  // Normalise typographic quotes so "haven’t" typed with a smart apostrophe
  // matches the same pattern as "haven't". The replacement is one-to-one per
  // character, so offsets into the normalised text are offsets into the input.
  const input = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  /* -- pass 1: claim spans, table order, no word claimed twice -- */
  const found: FoundMatch[] = [];
  const consumed: { start: number; end: number }[] = [];
  for (const entry of NL_PHRASES) {
    // A fresh clone: the exported table's RegExp objects are never mutated,
    // which is what makes two calls with the same input identical.
    const re = new RegExp(entry.pattern.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      // No pattern in the table can match the empty string, but a stuck
      // zero-width match would loop forever, and an infinite loop behind a
      // search box is the one failure this feature may never have.
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(consumed, start, end)) continue;
      consumed.push({ start, end });
      found.push({ start, end, entry, m });
    }
  }

  if (found.length === 0) {
    return {
      ok: false,
      reason: 'No known phrasings found. Try something like ' +
        '"big videos I have not opened in a year" or "duplicate photos in my downloads".',
    };
  }

  // Compose in input order, not table order: the query should read back in
  // the sequence the user said it, and the keep-first rule below should keep
  // the term the user said FIRST.
  found.sort((a, b) => a.start - b.start);

  /* -- pass 2: compose q, de-duplicating and keeping first per field -- */
  const qParts: string[] = [];
  const seenExact = new Set<string>();
  const firstByField = new Map<string, string>();
  const matched: NlMatch[] = [];

  for (const f of found) {
    const termText = typeof f.entry.term === 'function' ? f.entry.term(f.m) : f.entry.term;
    // One phrase may emit several grammar terms ("empty folders" →
    // `type:dir empty:yes`), so dedup runs per component.
    const components = termText.split(/\s+/).filter((c) => c.length > 0);
    let kept = 0;
    let conflictWith: string | undefined;
    for (const component of components) {
      if (seenExact.has(component)) continue; // an identical repeat adds nothing
      const field = fieldOf(component);
      const prior = firstByField.get(field);
      if (prior !== undefined) {
        // Two different values for one field ("big small" → two sizes) would
        // compose a query that matches nothing, so the first occurrence wins.
        // The dropped match is annotated below rather than vanishing.
        conflictWith = prior;
        continue;
      }
      seenExact.add(component);
      firstByField.set(field, component);
      qParts.push(component);
      kept++;
    }

    // Only a match that contributed NOTHING gets a drop note; a partial
    // overlap (one of two components already present) still added something.
    let dropNote: string | undefined;
    if (kept === 0) {
      dropNote = conflictWith !== undefined
        ? `conflicts with ${conflictWith}; kept the first`
        : 'already in the query';
    }
    const noteText = [f.entry.note, dropNote].filter((n): n is string => n !== undefined).join('; ');
    matched.push(noteText.length > 0
      ? { phrase: f.m[0], term: termText, note: noteText }
      : { phrase: f.m[0], term: termText });
  }

  /* -- pass 3: everything not consumed is surfaced, minus pure filler -- */
  const chars = input.split('');
  for (const span of consumed) {
    for (let i = span.start; i < span.end; i++) chars[i] = ' ';
  }
  const unmatched = chars.join('')
    .split(/\s+/)
    // Strip edge punctuation so "vacation," surfaces as "vacation"; inner
    // apostrophes survive so "i've" still hits the stopword list.
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w.length > 0 && !STOPWORD_SET.has(w.toLowerCase()));

  return { ok: true, q: qParts.join(' '), matched, unmatched };
}
