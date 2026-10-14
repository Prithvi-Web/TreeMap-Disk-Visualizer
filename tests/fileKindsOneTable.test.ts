import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-fileKindsOneTable-data-');

import { INDEX, lift } from './fixtures/liftFrontend';
import { parse } from '../src/services/query/parse';
import { NL_PHRASES, translateNlQuery } from '../src/services/query/nlIntent';

/**
 * "Ask in plain words" turned "videos bigger than 1 GB" into ext:mp4,mov,mkv,avi,webm while the app's
 * own type table counts m4v, wmv and flv as video too — the corpus's 52 .m4v clips never matched
 * (fourth browser pass, E11). The kinds now live in ONE file, src/ui/markup/137-file-kinds.json: the
 * page ships it as data (#fileKindTable) and builds its icons and colours from it, and the server's
 * plain-words table reads the same file for every kind it names.
 */

const TABLE_FILE = path.join(__dirname, '..', 'src', 'ui', 'markup', '137-file-kinds.json');

function table(): Record<string, string[]> {
  assert.ok(fs.existsSync(TABLE_FILE), 'the one type table is a file of its own');
  return JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8')) as Record<string, string[]>;
}

test('the page ships the one type table as data and builds every kind from it, with no second list of its own (E11)', () => {
  const kinds = table();
  assert.ok(INDEX.includes(`<script type="application/json" id="fileKindTable">\n${fs.readFileSync(TABLE_FILE, 'utf8')}\n</script>`),
    'the page carries the file itself, byte for byte');
  assert.match(INDEX, /fillExtKinds\(JSON\.parse\(document\.getElementById\('fileKindTable'\)\.textContent\)\);/, 'and fills its kinds from it as it loads');
  const { EXT_KIND, fillExtKinds } = lift<{ EXT_KIND: Record<string, string>; fillExtKinds: (t: Record<string, string[]>) => void }>(
    ['EXT_KIND', 'fillExtKinds'], '({ EXT_KIND, fillExtKinds })');
  fillExtKinds(kinds);
  for (const [kind, exts] of Object.entries(kinds)) {
    for (const ext of exts) assert.equal(EXT_KIND[ext], kind, `.${ext} is ${kind}`);
  }
  for (const ext of ['m4v', 'wmv', 'flv']) assert.equal(EXT_KIND[ext], 'video', `.${ext} is video, as the browser pass found the app says`);
  const every = Object.values(kinds).flat();
  assert.equal(new Set(every).size, every.length, 'no extension is two kinds');
  assert.doesNotMatch(INDEX, /'mp4 mov avi mkv webm m4v wmv flv'|'png jpg jpeg gif webp heic/, 'the page keeps no second copy of the lists');
});

test('every kind the plain-words table names is the app\'s own: videos, photos, music, pdfs and documents read the one type table (E11)', () => {
  const kinds = table();
  const q = (text: string): string => {
    const r = translateNlQuery(text);
    assert.ok(r.ok, `"${text}" translates`);
    return r.ok ? r.q : '';
  };
  const ext = (...names: string[]): string => `ext:${names.flatMap((k) => kinds[k]).join(',')}`;
  assert.equal(q('videos'), ext('video'), 'videos are the table\'s video kind');
  assert.ok(q('videos').split(/[:,]/).includes('m4v'), 'm4v among them');
  assert.equal(q('photos'), ext('image'), 'photos are its images');
  assert.equal(q('music'), ext('audio'), 'music is its audio');
  assert.equal(q('pdfs'), ext('pdf'), 'pdfs are its pdfs');
  assert.equal(q('documents'), ext('pdf', 'doc'), 'documents are its pdfs and documents');
  for (const text of ['videos bigger than 1 GB', 'photos', 'music', 'documents']) assert.ok(parse(q(text)).ok, `"${text}" still parses`);
  const nl = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'query', 'nlIntent.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' '); // its code, not the examples its comments give
  assert.doesNotMatch(nl, /ext:mp4|ext:jpg|ext:mp3|ext:pdf,doc/, 'the plain-words table keeps no list of its own for a kind the type table has');
});

test('archives and disk images read the one type table too, and no plain-words entry but installers keeps a list of its own (E11, review F1.1)', () => {
  const kinds = table();
  const q = (text: string): string => {
    const r = translateNlQuery(text);
    assert.ok(r.ok, `"${text}" translates`);
    return r.ok ? r.q : '';
  };
  const ext = (...names: string[]): string => `ext:${names.flatMap((k) => kinds[k]).join(',')}`;
  for (const text of ['archives', 'zip files', 'zips', 'compressed files']) {
    assert.equal(q(text), ext('archive'), `"${text}" is the table's archive kind`);
  }
  for (const e of ['bz2', 'xz', 'tgz']) assert.ok(q('archives').split(/[:,]/).includes(e), `.${e} is among the archives`);
  assert.equal(q('disk images'), ext('disk'), 'disk images are its disk kind');
  assert.ok(q('disk images').split(/[:,]/).includes('img'), '.img is among the disk images');
  for (const text of ['archives', 'disk images']) assert.ok(parse(q(text)).ok, `"${text}" still parses`);

  // Every ext: term the table emits, but installers' (a mix of kinds plus pkg and deb, which the type
  // table does not name), is exactly the union of the table's kinds it touches — so no literal list
  // can come back for any kind, including one added to the plain-words table later.
  const kindOf = new Map(Object.entries(kinds).flatMap(([kind, exts]) => exts.map((e) => [e, kind] as const)));
  const checked: string[] = [];
  for (const entry of NL_PHRASES) {
    if (typeof entry.term !== 'string' || !entry.term.startsWith('ext:')) continue;
    if (/^installers\b/.test(entry.label)) continue;
    const exts = entry.term.slice('ext:'.length).split(',');
    const named = [...new Set(exts.map((e) => kindOf.get(e)))];
    assert.ok(named.every((k) => k !== undefined), `${entry.label}: every extension is one the type table names`);
    assert.equal(entry.term, ext(...(named as string[])), `${entry.label}: exactly the table's ${named.join(' and ')}, every one`);
    checked.push(entry.label);
  }
  assert.equal(checked.length, 7, `videos, photos, music, pdfs, documents, archives and disk images were each checked: ${checked.join('; ')}`);
});
