/**
 * The search query language — parsed once, here.
 *
 * §A4 is explicit: "matching the existing Treemap search syntax exactly — do
 * not invent a second query language." The treemap's highlight box has used
 * these three rules since it shipped, and users have them in their fingers:
 *
 *   1. `*.zip`  → files with that extension
 *   2. `.zip`   → the same thing, shorthand
 *   3. anything else → case-insensitive substring of the file's **name**
 *      (not its path — matching the path would make every file under
 *      `~/Downloads` match the query "downloads")
 *
 * The frontend implements them in `treemapMatch()`; this module is the backend
 * half, and `tests/searchQuery.test.ts` asserts the two agree case by case,
 * including against the frontend's own source. Splitting the language across
 * two implementations without that check is how "*.zip" would quietly start
 * meaning something different depending on which box you typed it into.
 *
 * Note the query is trimmed and **lower-cased** before parsing, exactly as the
 * frontend does (`state.treemap.query.trim().toLowerCase()`), and stored
 * extensions are already lower-case — so extension comparison is a plain
 * equality test rather than a case-folding one.
 */

export type ParsedQuery =
  | { kind: 'empty' }
  /** `*.zip` or `.zip` — an exact extension match, files only. */
  | { kind: 'extension'; extension: string }
  /** Anything else — a case-insensitive substring of the basename. */
  | { kind: 'substring'; needle: string };

/**
 * Parse a raw query string.
 *
 * Mirrors `treemapMatch` in public/index.html, including its edge cases:
 * a bare `.` is not an extension query (the frontend requires length > 1), and
 * `*.` with nothing after it yields an empty extension, which matches the
 * files that genuinely have none.
 */
export function parseQuery(raw: string): ParsedQuery {
  const q = raw.trim().toLowerCase();
  if (q.length === 0) return { kind: 'empty' };
  if (q.startsWith('*.')) return { kind: 'extension', extension: q.slice(2) };
  // The frontend's guard is `q.startsWith('.') && q.length > 1`, so a lone '.'
  // falls through to a substring search — which is what a user typing a path
  // fragment expects.
  if (q.startsWith('.') && q.length > 1) return { kind: 'extension', extension: q.slice(1) };
  return { kind: 'substring', needle: q };
}

/**
 * Reference implementation of a match, for tests and for any caller holding
 * nodes in memory rather than rows in the index.
 *
 * `extension` follows the scanner's rule: the text after the last dot, but only
 * when that dot is neither the first character (so `.gitignore` is a hidden
 * file, not a `gitignore` extension) nor the last (so `archive.` has none).
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot >= name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function matches(query: ParsedQuery, name: string, isDir: boolean): boolean {
  switch (query.kind) {
    case 'empty':
      return false;
    case 'extension':
      // Directories never have extensions as far as this language is concerned,
      // matching the frontend's `n.type === 'file'` guard.
      return !isDir && extensionOf(name) === query.extension;
    case 'substring':
      return name.toLowerCase().includes(query.needle);
  }
}

/** Escape a string for use inside a SQL LIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}
