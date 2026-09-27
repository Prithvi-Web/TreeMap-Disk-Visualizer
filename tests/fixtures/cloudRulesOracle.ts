import fs from 'node:fs';
import path from 'node:path';
import { CLOUD_RULES, type CloudProvider, type CloudRuleAt } from '../../src/services/cloudFolders';
import { makeRng } from './storeFuzz';

/**
 * The cloud gate's oracle (decision P4-3a, Phase 4 task T11): paths with the
 * provider JavaScript's regexes give each, written to a file tm-store's Rust
 * tests read (`native/treemap-core/crates/tm-store/tests/fixtures/cloud-oracle.tsv`),
 * so the Rust matcher and the regexes are held to one answer per path.
 *
 * The first table is `CLOUD_RULES` as Node would hand it to Rust (the store's
 * provider numbers), and each of its paths carries what the regexes gave
 * before the table existed (`oldCloudProviderFor`, frozen below): the
 * hand-picked edge cases, then 20,000 generated paths. The other tables are
 * probes the production table cannot reach — no rule of it holds a `k`, and
 * no text of it ends in `i` — so each is answered by a regex per rule with
 * every character written `\uXXXX` and the `i` flag alone: JavaScript's own
 * semantics, with no escaping rule to trust, the first rule to match winning.
 *
 * A path is stored as bytes, and its answer is the regexes' answer for the
 * string Node decodes those bytes to (`Buffer#toString('utf8')`, as the native
 * engine decodes names): the Rust matcher is given the bytes a walk reads,
 * invalid UTF-8 included. `tests/cloudRules.test.ts` fails when the file and
 * the TypeScript disagree; regenerate with
 * `npx tsx tests/fixtures/cloudRulesOracle.ts`.
 *
 * One record per line, tab-separated:
 *   table <name>
 *   rule  <provider number> <anywhere|end> <text>
 *   path  <provider number, 0 for none> <bytes>
 * Text and bytes are percent-escaped: `%XX` for every byte below 0x20, `%`,
 * 0x7F and every byte above it, and for a space that ends the field.
 */

export const ORACLE_PATH = path.join(
  __dirname, '..', '..', 'native', 'treemap-core', 'crates', 'tm-store', 'tests', 'fixtures', 'cloud-oracle.tsv',
);

/** The gate as it stood before the table (src/services/cloudFolders.ts:15-20 at 785cd44), verbatim. */
export function oldCloudProviderFor(p: string): CloudProvider | undefined {
  if (/Library\/Mobile Documents|com~apple~CloudDocs|\.icloud$/i.test(p)) return 'icloud';
  if (/OneDrive/i.test(p)) return 'onedrive';
  if (/Dropbox/i.test(p)) return 'dropbox';
  return undefined;
}

/** The texts of the old regexes: what the generated paths are built around. */
const OLD_TEXTS: readonly string[] = ['Library/Mobile Documents', 'com~apple~CloudDocs', '.icloud', 'OneDrive', 'Dropbox'];

/** `CLOUD_ID` in src/services/scanStore.ts: the provider column's numbers, which tm-store answers in (0 is none). */
export const PROVIDER_ID: Readonly<Record<CloudProvider, number>> = Object.freeze({ icloud: 1, onedrive: 2, dropbox: 3 });

/** A rule as the oracle holds it: a provider number, as tm-store's `CloudRule` has it. */
export interface OracleRule {
  readonly provider: number;
  readonly at: CloudRuleAt;
  readonly text: string;
}

export interface OracleTable {
  readonly name: string;
  readonly rules: readonly OracleRule[];
  readonly paths: readonly Uint8Array[];
  /** The provider number each path gets; 0 for none. */
  readonly expected: readonly number[];
}

/** How the native engine turns a name's bytes into a string: an invalid sequence becomes U+FFFD, and ASCII stays itself. */
export function decodeLikeNode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** A string's UTF-8 bytes (a lone surrogate becomes U+FFFD's). */
export function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

/** Text and raw bytes, joined: a name a walk may read that is not UTF-8. */
function bytesOf(...parts: Array<string | number[]>): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))));
}

export interface EdgeCase {
  readonly path: string | Uint8Array;
  readonly expected: CloudProvider | undefined;
  readonly why: string;
}

/** The hand-picked paths: each answer written here by hand, and held against the old regexes too. */
export const EDGE_CASES: readonly EdgeCase[] = [
  // The three providers, and a sparse file that is none of them.
  { path: '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x.pdf', expected: 'icloud', why: 'the iCloud Drive folder' },
  { path: '/Users/me/OneDrive/x.pdf', expected: 'onedrive', why: 'a OneDrive folder' },
  { path: '/Users/me/Dropbox/x.pdf', expected: 'dropbox', why: 'a Dropbox folder' },
  { path: '/Users/me/VMs/Docker.raw', expected: undefined, why: 'a sparse file outside a cloud folder' },
  // Case variants.
  { path: '/users/me/library/mobile documents/x', expected: 'icloud', why: 'lower case' },
  { path: '/USERS/ME/LIBRARY/MOBILE DOCUMENTS/X', expected: 'icloud', why: 'upper case' },
  { path: '/Users/me/lIbRaRy/MoBiLe dOcUmEnTs/x', expected: 'icloud', why: 'mixed case' },
  { path: '/Users/me/COM~APPLE~CLOUDDOCS/x', expected: 'icloud', why: 'the container folder in upper case' },
  { path: 'C:\\Users\\me\\onedrive\\x', expected: 'onedrive', why: 'OneDrive in lower case' },
  { path: '/Users/me/ONEDRIVE - Contoso/x', expected: 'onedrive', why: 'a business OneDrive in upper case' },
  { path: '/Users/me/dropBOX (Personal)/x', expected: 'dropbox', why: 'Dropbox in mixed case' },
  { path: '/Users/me/x.IcLoUd', expected: 'icloud', why: 'a trailing .icloud in mixed case' },
  // A trailing `.icloud` against `.icloud` inside a name.
  { path: '/Users/me/Documents/.report.pdf.icloud', expected: 'icloud', why: 'an iCloud placeholder name' },
  { path: '/Users/me/Documents/report.icloud', expected: 'icloud', why: 'a trailing .icloud' },
  { path: '.icloud', expected: 'icloud', why: '.icloud as the whole path' },
  { path: '/Users/me/Documents/report.icloud.pdf', expected: undefined, why: '.icloud inside a name' },
  { path: '/Users/me/x.icloud/y.pdf', expected: undefined, why: '.icloud ending a folder, not the path' },
  { path: '/Users/me/x.icloudx', expected: undefined, why: 'a letter after .icloud' },
  { path: '/Users/me/xicloud', expected: undefined, why: 'the rule\'s dot is a dot, not any character' },
  { path: '/Users/me/icloud', expected: undefined, why: 'icloud with no dot' },
  { path: '/Users/me/x.icloud\n', expected: undefined, why: '$ without the m flag does not match before a final newline' },
  { path: '/Users/me/x.icloud\r\n', expected: undefined, why: 'nor before a final CR LF' },
  { path: '/Users/me/x.icloud\u2028', expected: undefined, why: 'nor before a final line separator' },
  { path: '/Users/me/x.icloud ', expected: undefined, why: 'a space after .icloud' },
  { path: '/Users/me/x.icloud\u0000', expected: undefined, why: 'a NUL after .icloud' },
  { path: '/Users/me/x.icloud/', expected: undefined, why: 'a separator after .icloud' },
  // Windows separators: the rule's slash is a slash.
  { path: 'C:\\Users\\me\\Library\\Mobile Documents\\x', expected: undefined, why: 'a backslash is not the rule\'s slash' },
  { path: 'C:\\Users\\me\\iCloudDrive\\com~apple~CloudDocs\\x', expected: 'icloud', why: 'the container folder under Windows separators' },
  { path: 'C:\\Users\\me\\iCloudDrive\\x.pdf.icloud', expected: 'icloud', why: 'a trailing .icloud under Windows separators' },
  { path: 'C:\\Users\\me\\OneDrive\\x.docx', expected: 'onedrive', why: 'OneDrive under Windows separators' },
  { path: '\\\\nas\\share\\Dropbox\\x', expected: 'dropbox', why: 'Dropbox on a UNC path' },
  { path: 'C:/Users/me/Library/Mobile Documents/x', expected: 'icloud', why: 'forward slashes in a Windows path' },
  { path: '/Users/me/Library\\Mobile Documents/x', expected: undefined, why: 'a backslash inside a POSIX path' },
  // Lookalikes: the i flag without u folds ASCII letters and nothing else.
  { path: '/Users/me/OneDr\u0130ve/x', expected: undefined, why: 'U+0130 is not i, though it lower-cases to i and U+0307' },
  { path: '/Users/me/OneDr\u0131ve/x', expected: undefined, why: 'U+0131 is not i, though it upper-cases to I' },
  { path: '/Users/me/Library/Mobile Document\u017F/x', expected: undefined, why: 'U+017F is not s, though it upper-cases to S and folds to s' },
  { path: '/Users/me/com~apple~CloudDoc\u017F/x', expected: undefined, why: 'U+017F ending the container folder' },
  { path: '/Users/me/x.\u0130cloud', expected: undefined, why: 'U+0130 in a trailing .icloud' },
  { path: '/Users/me/x.\u0131cloud', expected: undefined, why: 'U+0131 in a trailing .icloud' },
  { path: '/Users/me/L\u0130brary/Mobile Documents/x', expected: undefined, why: 'U+0130 in Library' },
  { path: '/Users/me/\u212Aelvin/OneDrive/x', expected: 'onedrive', why: 'U+212A KELVIN SIGN beside a rule changes nothing' },
  { path: '/Users/me/Dropbox\u212A', expected: 'dropbox', why: 'U+212A after a rule changes nothing' },
  { path: '/Users/me/\u212A.icloud', expected: 'icloud', why: 'U+212A before a trailing .icloud' },
  { path: '/Users/me/\uFF24\uFF52\uFF4F\uFF50\uFF42\uFF4F\uFF58/x', expected: undefined, why: 'fullwidth letters' },
  { path: '/Users/me/Dr\u043Epbox/x', expected: undefined, why: 'a Cyrillic o' },
  { path: '/Users/me/Library/Mobile\u00A0Documents/x', expected: undefined, why: 'a no-break space' },
  { path: '/Users/me/Library/Mobile  Documents/x', expected: undefined, why: 'two spaces' },
  { path: '/Users/me/Library//Mobile Documents/x', expected: undefined, why: 'a doubled slash' },
  { path: '/Users/me/One Drive/x', expected: undefined, why: 'One Drive with a space' },
  { path: '/Users/me/Drop box/x', expected: undefined, why: 'Drop box with a space' },
  { path: '/Users/me/com~apple~Cloud Docs/x', expected: undefined, why: 'a space in the container folder' },
  { path: '/Users/me/OneDri\u0307ve/x', expected: undefined, why: 'a combining dot inside the name' },
  { path: '/Users/me/One\u200BDrive/x', expected: undefined, why: 'a zero-width space inside the name' },
  { path: '\uD83D\uDE00OneDrive', expected: 'onedrive', why: 'OneDrive after an astral character' },
  { path: 'OneDrive\uD83D', expected: 'onedrive', why: 'OneDrive before a lone surrogate' },
  { path: '/x.icloud\uDC00', expected: undefined, why: 'a lone surrogate after .icloud' },
  // Order: the first provider asked wins.
  { path: '/Users/me/OneDrive/Dropbox/x', expected: 'onedrive', why: 'OneDrive is asked before Dropbox' },
  { path: '/Users/me/Dropbox/OneDrive/x', expected: 'onedrive', why: 'OneDrive is asked before Dropbox, wherever each sits' },
  { path: '/Users/me/Dropbox/Library/Mobile Documents/x', expected: 'icloud', why: 'iCloud is asked first' },
  { path: '/Users/me/OneDrive/x.icloud', expected: 'icloud', why: 'iCloud is asked first, by its end rule' },
  { path: '/Users/me/Dropbox/com~apple~CloudDocs', expected: 'icloud', why: 'iCloud is asked first, by the container folder' },
  { path: '/Users/me/OneDropbox/x', expected: 'dropbox', why: 'Dropbox inside another word' },
  { path: '/Users/me/DropboxOneDrive', expected: 'onedrive', why: 'two texts back to back' },
  // Degenerate.
  { path: '', expected: undefined, why: 'the empty path' },
  { path: 'Dropbox', expected: 'dropbox', why: 'a text alone' },
  { path: 'OneDriv', expected: undefined, why: 'one letter short' },
  { path: 'ropbox', expected: undefined, why: 'the first letter missing' },
  // Bytes a walk may read that are not UTF-8, answered as Node decodes them.
  { path: bytesOf('/Users/me/Library', [0xc0, 0xaf], 'Mobile Documents/x'), expected: undefined, why: 'an overlong slash is not a slash' },
  { path: bytesOf('/Users/me/OneDr', [0xff], 'ive/x'), expected: undefined, why: 'an invalid byte inside the name' },
  { path: bytesOf('/Users/me/', [0xff], 'Dropbox/x'), expected: 'dropbox', why: 'an invalid byte before the name' },
  { path: bytesOf('/Users/me/OneDrive', [0xe2, 0x82]), expected: 'onedrive', why: 'a truncated sequence after the name' },
  { path: bytesOf('/Users/me/x.icloud', [0xe2, 0x82]), expected: undefined, why: 'a truncated sequence after .icloud' },
  { path: bytesOf('/Users/me/x.icloud', [0x80]), expected: undefined, why: 'a stray continuation byte after .icloud' },
  { path: bytesOf('/Users/me/x', [0xe0, 0x80, 0xae], 'icloud'), expected: undefined, why: 'an overlong dot is not a dot' },
  { path: bytesOf([0xed, 0xa0, 0x80], 'Dropbox'), expected: 'dropbox', why: 'an encoded surrogate before the name' },
  { path: bytesOf('/x/', [0xf4, 0x90, 0x80, 0x80], '.icloud'), expected: 'icloud', why: 'a sequence past U+10FFFF before a trailing .icloud' },
  { path: bytesOf('/x/Drop', [0xc3], 'box'), expected: undefined, why: 'a lone lead byte inside the name' },
];

/** Characters outside ASCII that one case folding or another takes for an ASCII one, or that look like one. */
const LOOKALIKES: Readonly<Record<string, readonly string[]>> = {
  a: ['\u0430', '\u00E0', '\uFF41'], A: ['\u0410', '\u0391', '\uFF21'],
  b: ['\uFF42', '\u0184'], B: ['\u0412', '\uFF22', '\u212C'],
  c: ['\u0441', '\u00E7', '\uFF43', '\u217D'], C: ['\u0421', '\uFF23', '\u216D', '\u2102'],
  d: ['\u0501', '\uFF44', '\u217E'], D: ['\uFF24', '\u216E'],
  e: ['\u0435', '\u00E9', '\uFF45', '\u212F'], E: ['\u0415', '\u0395', '\uFF25'],
  i: ['\u0130', '\u0131', '\u0456', '\uFF49', '\u2170'], I: ['\u0130', '\u0406', '\uFF29', '\u0399', '\u2160'],
  k: ['\u212A', '\u043A', '\uFF4B', '\u0138'], K: ['\u212A', '\u041A', '\uFF2B'],
  l: ['\u04CF', '\uFF4C', '\u217C', '\u2113'], L: ['\uFF2C', '\u216C'],
  m: ['\uFF4D', '\u217F'], M: ['\u041C', '\uFF2D', '\u216F'],
  n: ['\uFF4E', '\u0578'], N: ['\u039D', '\uFF2E'],
  o: ['\u043E', '\u03BF', '\uFF4F', '\u00F6'], O: ['\u041E', '\u039F', '\uFF2F'],
  p: ['\u0440', '\uFF50'], P: ['\u0420', '\uFF30'],
  r: ['\uFF52', '\u0433'], R: ['\uFF32', '\u211B'],
  s: ['\u017F', '\u0455', '\uFF53', '\u00DF'], S: ['\u017F', '\u0405', '\uFF33'],
  t: ['\uFF54'], T: ['\u0422', '\uFF34'],
  u: ['\uFF55', '\u00FC'], U: ['\uFF35'],
  v: ['\uFF56', '\u2174'], V: ['\uFF36', '\u2164'],
  x: ['\u0445', '\uFF58', '\u2179'], X: ['\u0425', '\uFF38', '\u2169'],
  y: ['\u0443', '\uFF59'], Y: ['\uFF39'],
  '.': ['\u2024', '\uFF0E', '\u3002'], '/': ['\u2215', '\uFF0F', '\u2044'], '\\': ['\uFF3C', '\u2216'],
  '~': ['\uFF5E', '\u02DC', '\u223C'], ' ': ['\u00A0', '\u2002', '\u3000'],
};
const ANY_LOOKALIKE: readonly string[] = Object.values(LOOKALIKES).flat();

const FILLERS: readonly string[] = [
  'Users', 'me', 'Documents', 'Desktop', 'x.pdf', 'a', 'Library', 'Mobile', 'Mobile Documents', 'com~apple~', 'CloudDocs',
  'One', 'Drive', 'Drop', 'box', 'icloud', '.icloud', 'Kelvin', '\u017Fecret', '\u0130stanbul', '\u0131i', 'stra\u00DFe',
  '\uFB06', '\u65E5\u672C', '\uD83D\uDE00', 'na\u00EFve', 'K', '.', '..', '~', 'C:', 'iCloudDrive', 'OneDrive - Contoso',
  'Dropbox (Personal)', 'report.icloud.bak',
];
const PREFIXES: readonly string[] = ['', '', '/', '/', '/me/', 'C:\\', '~/', '\\\\nas\\'];
const SEPARATORS: readonly string[] = ['/', '/', '/', '\\', '\\', '//', ''];
const SUFFIXES: readonly string[] = [
  '', '', '', '', '', '/x', '\\x', '.icloud', '.ICLOUD', '.iCloud', '.icloud.bak', '.icloud\n', '.icloud\r\n', '.icloud ',
  '.icloud.', '.icloud/', '\n', ' ', '.', '\u2028', 'xicloud', '.icloudd', '.\u0130cloud',
];
/** What a random word is spelled from: the rules' letters in both cases, their separators, and the lookalikes that matter most. */
const ALPHABET: readonly string[] = [
  ...new Set([...OLD_TEXTS.join(''), ...OLD_TEXTS.join('').toUpperCase(), ...OLD_TEXTS.join('').toLowerCase()]),
  '/', '\\', '.', '~', ' ', '-', '0', '\u212A', '\u0130', '\u0131', '\u017F', '\u00DF', '\uFF4B',
];
/** Raw bytes that are not UTF-8: invalid, overlong, truncated, a surrogate, past U+10FFFF. */
const INVALID_BYTES: readonly number[][] = [
  [0xff], [0xfe], [0x80], [0xc3], [0xc0, 0xaf], [0xc1, 0xbf], [0xe2, 0x82], [0xe0, 0x80, 0xae], [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x80, 0x80, 0xaf],
];

type Rng = () => number;

function pick<T>(rng: Rng, from: readonly T[]): T {
  return from[Math.floor(rng() * from.length)];
}

/**
 * Changes the case of A–Z and a–z at random and leaves every other character
 * as it is: case tables outside ASCII differ between engines, and the paths
 * must come out the same on every Node that regenerates the oracle.
 */
function randomCase(rng: Rng, s: string): string {
  return s.replace(/[A-Za-z]/g, (c) => {
    const r = rng();
    return r < 1 / 3 ? c.toUpperCase() : r < 2 / 3 ? c.toLowerCase() : c;
  });
}

/** One change to a rule's text: a near miss, a case change, a lookalike, a separator swapped. */
function changeText(rng: Rng, text: string): string {
  const chars = [...text];
  const at = Math.floor(rng() * chars.length);
  switch (Math.floor(rng() * 9)) {
    case 0: return randomCase(rng, text);
    case 1: {
      const looks = LOOKALIKES[chars[at]];
      chars[at] = looks ? pick(rng, looks) : pick(rng, ANY_LOOKALIKE);
      return chars.join('');
    }
    case 2: chars.splice(at, 1); return chars.join('');
    case 3: chars.splice(at, 0, chars[at]); return chars.join('');
    case 4: chars.splice(at, 0, pick(rng, [' ', '/', '\\', '.', 'x', '\u00A0', '\u200B', '\u0307', '\uFFFD'])); return chars.join('');
    case 5: return text.replace(/\//g, '\\');
    case 6: return rng() < 0.5 ? chars.slice(0, at + 1).join('') : chars.slice(at).join('');
    case 7: return pick(rng, ['My', 'x', '', '.', ' ']) + text + pick(rng, ['Files', 'x', '', '.', ' ']);
    default: return text;
  }
}

function randomWord(rng: Rng): string {
  let word = '';
  const length = 1 + Math.floor(rng() * 8);
  for (let k = 0; k < length; k++) word += pick(rng, ALPHABET);
  return word;
}

/** A path built around the old texts, whole or changed, among other words; now and then with bytes that are not UTF-8. */
function generatedPath(rng: Rng): string | Uint8Array {
  const count = 1 + Math.floor(rng() * 3);
  let p = pick(rng, PREFIXES);
  for (let k = 0; k < count; k++) {
    const r = rng();
    let segment: string;
    if (r < 0.5) {
      segment = pick(rng, OLD_TEXTS);
      const changes = Math.floor(rng() * 3);
      for (let c = 0; c < changes; c++) segment = changeText(rng, segment);
    } else if (r < 0.8) {
      segment = pick(rng, FILLERS);
    } else {
      segment = randomWord(rng);
    }
    p += (k > 0 ? pick(rng, SEPARATORS) : '') + segment;
  }
  p += pick(rng, SUFFIXES);
  if (rng() < 0.03) {
    const at = Math.floor(rng() * (p.length + 1));
    p = p.slice(0, at) + pick(rng, ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']) + p.slice(at);
  }
  if (rng() < 0.1) {
    const bytes = utf8(p);
    const at = rng() < 0.3 ? bytes.length : Math.floor(rng() * (bytes.length + 1));
    return bytesOf([...bytes.subarray(0, at)], pick(rng, INVALID_BYTES), [...bytes.subarray(at)]);
  }
  return p;
}

/** `count` paths from `seed`: strings, and now and then bytes that are not UTF-8. */
export function generatedPaths(seed: number, count: number): Array<string | Uint8Array> {
  const rng = makeRng(seed);
  const out: Array<string | Uint8Array> = [];
  for (let k = 0; k < count; k++) out.push(generatedPath(rng));
  return out;
}

/** `count` strings of up to 24 UTF-16 code units, any of the 65,536 among them, lone surrogates included. */
export function randomCodeUnitStrings(seed: number, count: number): string[] {
  const rng = makeRng(seed);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    let s = '';
    const length = Math.floor(rng() * 25);
    for (let i = 0; i < length; i++) {
      const r = rng();
      if (r < 0.45) s += pick(rng, ALPHABET);
      else if (r < 0.6) s += pick(rng, OLD_TEXTS);
      else if (r < 0.7) s += pick(rng, ['/', '\\', '.', '~', ' ', '\n']);
      else s += String.fromCharCode(Math.floor(rng() * 0x10000));
    }
    out.push(s);
  }
  return out;
}

/** The seed and size of the generated paths in the oracle file. */
export const ORACLE_SEED = 20260925;
export const ORACLE_GENERATED = 20_000;

/** The code points the letter probe tries: every set the Node tests pin, and the blocks around them. */
function probeCodePoints(): number[] {
  const ranges: Array<[number, number]> = [
    [0x80, 0x24f], // Latin-1 Supplement, Latin Extended-A and -B: U+00DF, U+0130, U+0131, U+0149, U+017F, U+01F0
    [0x250, 0x2af], [0x300, 0x36f], [0x370, 0x3ff], [0x400, 0x45f],
    [0x1e00, 0x1eff], // Latin Extended Additional: U+1E96–U+1E9A, U+1E9E
    [0x2100, 0x218f], // letterlike symbols and number forms: U+212A KELVIN SIGN, U+212B, the Roman numerals
    [0x24b6, 0x24e9], [0xfb00, 0xfb06], [0xff01, 0xff5e], [0xfffd, 0xfffd],
    [0x10400, 0x1044f], [0x1d400, 0x1d433],
  ];
  const out: number[] = [];
  for (const [from, to] of ranges) for (let cp = from; cp <= to; cp++) out.push(cp);
  return out;
}

const letters = 'abcdefghijklmnopqrstuvwxyz';

/** The tables the production table cannot reach, each with the paths that try it. */
function probeTables(): Array<{ name: string; rules: OracleRule[]; paths: Uint8Array[] }> {
  const anywhere = (provider: number, text: string): OracleRule => ({ provider, at: 'anywhere', text });
  const end = (provider: number, text: string): OracleRule => ({ provider, at: 'end', text });
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, k) => String.fromCharCode(0x20 + k));
  return [
    {
      // Every ASCII letter its own provider: no character outside ASCII may match one.
      name: 'probe-letters',
      rules: [...letters].map((c, k) => anywhere(k + 1, c)),
      paths: [
        ...probeCodePoints().flatMap((cp) => [utf8(String.fromCodePoint(cp)), utf8(`1${String.fromCodePoint(cp)}2`)]),
        ...printable.map(utf8),
        ...[0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f].map((b) => new Uint8Array([b])),
      ],
    },
    {
      name: 'probe-ends',
      rules: [end(1, 'k'), end(2, 'I'), end(3, 's'), end(4, '.x')],
      paths: [
        'xk', 'xK', 'x\u212A', 'xk\n', 'kx', 'k', 'K', '\u212A', 'xi', 'xI', 'x\u0130', 'x\u0131', 'ix', 'xs', 'xS', 'x\u017F',
        'xs ', 'sx', 'a.x', 'a.X', 'ax', 'a.x.y', 'a.xy', '.x', 'x', '', 'a\u2024x', 'a.x\r', 'a.\uFF58',
      ].map(utf8),
    },
    {
      // The first rule a path matches wins, whatever its provider's number or where else that provider's rules sit.
      name: 'probe-order',
      rules: [anywhere(2, 'b'), end(1, 'a'), anywhere(3, 'a'), anywhere(1, 'c')],
      paths: ['ba', 'xa', 'ax', 'cx', 'axc', 'ca', 'b', 'abc', 'cab', 'CAB', 'AXC', 'c', 'a', 'x', ''].map(utf8),
    },
    {
      // A rule's text is text: nothing in it is regex syntax.
      name: 'probe-syntax',
      rules: [
        anywhere(1, 'a.c'), anywhere(2, '(x)'), anywhere(3, '[y]'), anywhere(4, 'p+q'), anywhere(5, '\\'), end(6, '$'),
        anywhere(7, '^'), anywhere(8, 'u|v'), anywhere(9, '{2}'), anywhere(10, '*'), anywhere(11, '?'), anywhere(12, '/'),
        anywhere(13, '%'), anywhere(14, ' '), end(15, 'z\\d'),
      ],
      paths: [
        'abc', 'a.c', 'A.C', 'x', '(x)', 'y', '[y]', 'pq', 'ppq', 'p+q', 'a\\b', 'x$', 'x$y', '^', 'u', 'v', 'u|v', 'aa',
        'a{2}', '{2}', '*', '?', 'a/b', '100%', 'a b', 'z1', 'z\\d', 'Z\\D', 'zd', '',
      ].map(utf8),
    },
    {
      // Letters a ligature or a special upper case holds: none of them is ASCII to the regex.
      name: 'probe-ligatures',
      rules: [
        anywhere(1, 'ss'), anywhere(2, 'st'), anywhere(3, 'ffi'), anywhere(4, 'ij'), anywhere(5, 'dz'), anywhere(6, 'n'),
        anywhere(7, 'j'), anywhere(8, 'h'), anywhere(9, 't'), anywhere(10, 'w'), anywhere(11, 'y'), anywhere(12, 'a'),
      ],
      paths: [
        '\u00DF', '\u1E9E', '\uFB06', '\uFB05', '\uFB03', '\uFB00', '\uFB01', '\uFB02', '\uFB04', '\u0133', '\u0132', '\u01F3',
        '\u01F2', '\u01F1', '\u0149', '\u01F0', '\u1E96', '\u1E97', '\u1E98', '\u1E99', '\u1E9A', 'SS', 'St', 'FFI', 'IJ', 'dZ',
        '\u02BCN', 'J\u030C', 'x',
      ].map(utf8),
    },
  ];
}

/**
 * JavaScript's answer for a table, with no escaping rule to trust: a regex per
 * rule, every code unit written `\uXXXX`, `$` after an end rule, the `i` flag
 * alone; the first rule to match names the provider, and 0 is none.
 */
export function referenceMatcher(rules: readonly OracleRule[]): (text: string) => number {
  const regexes = rules.map((rule) => {
    const source = rule.text.split('').map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    return { provider: rule.provider, regex: new RegExp(source + (rule.at === 'end' ? '$' : ''), 'i') };
  });
  return (text) => regexes.find(({ regex }) => regex.test(text))?.provider ?? 0;
}

/** `CLOUD_RULES` as Node would hand it to tm-store: the store's provider numbers. */
export function productionRules(): OracleRule[] {
  return CLOUD_RULES.map((rule) => ({ provider: PROVIDER_ID[rule.provider], at: rule.at, text: rule.text }));
}

/** The oracle's tables: `CLOUD_RULES` answered by the old regexes, then the probes answered by the reference. */
export function oracleTables(): OracleTable[] {
  const productionPaths = [
    ...EDGE_CASES.map((edge) => (typeof edge.path === 'string' ? utf8(edge.path) : edge.path)),
    ...generatedPaths(ORACLE_SEED, ORACLE_GENERATED).map((p) => (typeof p === 'string' ? utf8(p) : p)),
  ];
  const production: OracleTable = {
    name: 'cloudProviderFor',
    rules: productionRules(),
    paths: productionPaths,
    expected: productionPaths.map((bytes) => {
      const provider = oldCloudProviderFor(decodeLikeNode(bytes));
      return provider ? PROVIDER_ID[provider] : 0;
    }),
  };
  const probes = probeTables().map(({ name, rules, paths }) => {
    const answer = referenceMatcher(rules);
    return { name, rules, paths, expected: paths.map((bytes) => answer(decodeLikeNode(bytes))) };
  });
  return [production, ...probes];
}

/** Percent-escapes every byte below 0x20, `%`, 0x7F and above, and a space that ends the field. */
export function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  bytes.forEach((b, k) => {
    const last = k === bytes.length - 1;
    if (b < 0x20 || b === 0x25 || b >= 0x7f || (b === 0x20 && last)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += String.fromCharCode(b);
  });
  return out;
}

export function unescapeBytes(field: string): Uint8Array {
  const out: number[] = [];
  for (let k = 0; k < field.length; k++) {
    const c = field.charCodeAt(k);
    if (c === 0x25) {
      const hex = field.slice(k + 1, k + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`a bad escape at ${k} in ${JSON.stringify(field)}`);
      out.push(parseInt(hex, 16));
      k += 2;
    } else {
      out.push(c);
    }
  }
  return new Uint8Array(out);
}

export function oracleText(): string {
  const lines: string[] = [];
  for (const table of oracleTables()) {
    lines.push(`table\t${table.name}`);
    for (const rule of table.rules) lines.push(`rule\t${rule.provider}\t${rule.at}\t${escapeBytes(utf8(rule.text))}`);
    table.paths.forEach((bytes, k) => lines.push(`path\t${table.expected[k]}\t${escapeBytes(bytes)}`));
  }
  return lines.join('\n') + '\n';
}

/** Reads the oracle file back into its tables. */
export function parseOracle(text: string): OracleTable[] {
  const tables: Array<{ name: string; rules: OracleRule[]; paths: Uint8Array[]; expected: number[] }> = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\t');
    const table = tables[tables.length - 1];
    if (fields[0] === 'table' && fields.length === 2) {
      tables.push({ name: fields[1], rules: [], paths: [], expected: [] });
    } else if (fields[0] === 'rule' && fields.length === 4 && table && (fields[2] === 'anywhere' || fields[2] === 'end')) {
      table.rules.push({ provider: Number(fields[1]), at: fields[2], text: decodeLikeNode(unescapeBytes(fields[3])) });
    } else if (fields[0] === 'path' && fields.length === 3 && table) {
      table.paths.push(unescapeBytes(fields[2]));
      table.expected.push(Number(fields[1]));
    } else {
      throw new Error(`a line the oracle does not hold: ${JSON.stringify(line)}`);
    }
  }
  return tables;
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(ORACLE_PATH), { recursive: true });
  fs.writeFileSync(ORACLE_PATH, oracleText());
  process.stdout.write(`wrote ${ORACLE_PATH}\n`);
}
