'use strict';
/*
 * Licence files in Go module source, for scripts/gdu-notices.js: which files
 * are licence files, and which licences each one grants.
 *
 * Go modules declare no licence anywhere a tool can read — not in go.mod, not
 * on the proxy — so what a module is licensed under is read from its licence
 * files. identifyLicences recognises a licence by sentences its text must
 * contain, compared word for word with case, punctuation, line breaks and
 * comment markers set aside; it names each one it finds, so a file that holds
 * several (a project's own licence and the licences of code it vendors) names
 * them all, and the module's entry joins them with AND.
 *
 * The permissive ones it knows are the ones gdu's modules use. It also names
 * every copyleft and source-available licence it meets, so one inside a file
 * that also grants a permissive licence still stops the generator. A licence
 * file that names nothing it knows stops the generator too, by name — a
 * person reads it, then either teaches identifyLicences the licence or, for a
 * file that grants no licence at all, adds it to REVIEWED with why.
 */
const crypto = require('crypto');
const path = require('path');
const { byCodeUnits, normaliseText } = require('../rust-notices/text');

/** A licence file's name: LICENSE, LICENCE, LICENSES, COPYING, NOTICE, UNLICENSE, COPYRIGHT or PATENTS, with any suffix after a separator. */
const LICENCE_FILE = /^(?:licen[cs]es?|copying|notice|unlicense|copyright|patents)(?:[-_.][A-Za-z0-9._-]*)?$/i;
/** A folder of licence files (the REUSE layout): everything in it counts. */
const LICENCE_FOLDER = /^licen[cs]es$/i;
/** Source code and data that only happen to be named like a licence file (copyright.go, license.json). */
const NOT_A_LICENCE = /\.(?:go|s|c|h|cc|cpp|rs|py|js|ts|sh|json|ya?ml|toml|mod|sum|lock|proto)$/i;

/** Folders the go command never builds from: testdata, and any whose name starts with . or _. */
function ignoredByGo(folder) {
  return folder === 'testdata' || folder.startsWith('.') || folder.startsWith('_');
}

/**
 * The licence files among a module zip's entry `names`, relative to the
 * module's `prefix` ("<module>@<version>/"), at any depth, in code-unit
 * order. A subfolder's own LICENSE covers code linked from it (ristretto's
 * z/, compress's s2/), so depth is no reason to leave one out; testdata and
 * the folders the go command ignores are, since nothing in them is compiled.
 */
function licenceFiles(names, prefix) {
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((rel) => {
      const parts = rel.split('/');
      const base = parts[parts.length - 1];
      const folders = parts.slice(0, -1);
      if (folders.some(ignoredByGo) || NOT_A_LICENCE.test(base)) return false;
      return LICENCE_FILE.test(base) || folders.some((f) => LICENCE_FOLDER.test(f));
    })
    .sort(byCodeUnits);
}

/** A text as words: lower case, every run of anything but letters and digits one space, a space at either end. */
function wordsOf(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Whether `words` holds every phrase of `phrases`, each as whole words. */
function holds(words, ...phrases) {
  return phrases.every((p) => words.includes(` ${p} `));
}

const MIT_GRANT = 'permission is hereby granted free of charge to any person obtaining a copy';
const MIT_CONDITION = 'the above copyright notice and this permission notice shall be included in all copies or substantial portions of the software';
const BSD_GRANT = 'redistribution and use in source and binary forms with or without modification are permitted provided that';
const BSD_ENDORSEMENT = 'endorse or promote products derived from this software';
const BSD_ADVERTISING = 'all advertising materials mentioning features';
const ISC_GRANT_FORMS = ['permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted',
  'permission to use copy modify and distribute this software for any purpose with or without fee is hereby granted'];
const ISC_CONDITION = 'provided that the above copyright notice and this permission notice appear in all copies';

/**
 * Each licence's test over a text's words. The permissive ones are the
 * licences of gdu's modules; the rest are every copyleft or source-available
 * licence likely to turn up, named so the generator can refuse them.
 */
const RULES = [
  ['Apache-2.0', (w) => holds(w, 'apache license version 2 0')],
  ['MIT', (w) => holds(w, MIT_GRANT, MIT_CONDITION)],
  ['BSD', (w) => holds(w, BSD_GRANT)],
  ['ISC', (w) => ISC_GRANT_FORMS.some((g) => holds(w, g, ISC_CONDITION))],
  ['GPL', (w) => holds(w, 'gnu general public license')],
  ['LGPL', (w) => holds(w, 'gnu lesser general public license') || holds(w, 'gnu library general public license')],
  ['AGPL', (w) => holds(w, 'gnu affero general public license')],
  ['MPL', (w) => holds(w, 'mozilla public license')],
  ['EPL', (w) => holds(w, 'eclipse public license')],
  ['CDDL', (w) => holds(w, 'common development and distribution license')],
  ['EUPL', (w) => holds(w, 'european union public licence') || holds(w, 'european union public license')],
  ['BUSL', (w) => holds(w, 'business source license')],
  ['SSPL', (w) => holds(w, 'server side public license')],
  ['LicenseRef-Commons-Clause', (w) => holds(w, 'commons clause license condition')],
];

/** Which BSD licence a BSD text is: four clauses with the advertising clause, three with the endorsement clause, else two. */
function bsdKind(words) {
  if (holds(words, BSD_ADVERTISING)) return 'BSD-4-Clause';
  return holds(words, BSD_ENDORSEMENT) ? 'BSD-3-Clause' : 'BSD-2-Clause';
}

/** The SPDX ids of every licence `text` grants or names, once each, in code-unit order; none for a text it knows no licence in. */
function identifyLicences(text) {
  const words = wordsOf(text);
  const ids = new Set();
  for (const [id, test] of RULES) {
    if (!test(words)) continue;
    if (id === 'BSD') ids.add(bsdKind(words));
    else if (id === 'MPL') ids.add(holds(words, 'mozilla public license version 2 0') ? 'MPL-2.0' : 'MPL');
    else ids.add(id);
  }
  return [...ids].sort(byCodeUnits);
}

/** Go's patent grant (the PATENTS file of Go and its golang.org/x modules): a grant beside the licence, not a licence. */
function isPatentGrant(text) {
  return holds(wordsOf(text), 'additional ip rights grant patents');
}

/**
 * Licence files that grant no licence, each read by a person, pinned by the
 * SHA-256 of its text (as normaliseText leaves it) so a changed text is read
 * again, with why it needs none. The why ends without a full stop; the notices
 * print it after "<file> names no licence: ".
 */
const REVIEWED = [
  {
    module: 'modernc.org/memory',
    file: 'LICENSE-LOGO',
    sha256: '5ae5bee3072a841376451b48d8cfcec7188e10543926d5870828d36c8a750dc5',
    why: "it names where the logo image in the module's repository comes from; the image is not Go code and is no part of any gdu binary",
  },
];

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** `bytes` as UTF-8 text, refused when they are not: a licence that cannot be copied word for word is a person's to read. */
function utf8Text(bytes, who) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${who} is not valid UTF-8, so it cannot be copied word for word; a person must look at it`);
  }
}

/**
 * One licence file of `module` ("<path> <version>"): { title, text, ids,
 * note }. `text` is verbatim but for a byte-order mark, CRLF line ends and
 * blank lines at either end. A file that names a licence counts for it,
 * whatever it is called; a NOTICE and Go's patent grant are carried as they
 * are; a file in `reviewed`, by its module, name and exact text, is carried
 * with a note saying why it needs no licence. Anything else throws, naming
 * the module and the file.
 */
function classifyLicenceFile({ module, file, bytes }, reviewed = REVIEWED) {
  const text = normaliseText(utf8Text(bytes, `${module}: ${file}`));
  const ids = identifyLicences(text);
  const base = path.posix.basename(file);
  if (ids.length > 0 || /^notice/i.test(base) || (/^patents/i.test(base) && isPatentGrant(text))) {
    return { title: file, text, ids, note: null };
  }
  const modulePath = module.split(' ')[0];
  const review = reviewed.find((r) => r.module === modulePath && r.file === file && r.sha256 === sha256(text));
  if (review) return { title: file, text, ids, note: `${file} names no licence: ${review.why}.` };
  throw new Error(
    `${module}: ${file} names no licence this generator recognises; a person must read it, then either teach identifyLicences in scripts/gdu-notices/licences.js the licence it grants or, if it grants none, add it to REVIEWED there with why`,
  );
}

module.exports = { LICENCE_FILE, REVIEWED, licenceFiles, identifyLicences, isPatentGrant, classifyLicenceFile };
