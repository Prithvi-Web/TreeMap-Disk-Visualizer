#!/usr/bin/env node
/**
 * Settle a GitHub release's notes before its installers are attached.
 *
 *   node scripts/release-notes.js v5.0.0
 *
 * Run by the `notes` job of .github/workflows/release.yml, alone and before the
 * two installer builds, so nothing races to create the release or rewrite its
 * notes. Plain CommonJS, Node built-ins only: the notes job does not run
 * `npm ci`, so a `require` of anything from node_modules passes every local
 * test and fails only in CI.
 *
 * It reads package.json, CHANGELOG.md and .github/INSTALL-NOTE.md AT THE TAG
 * (`git show refs/tags/<tag>:<file>`), so a repair run started from main still
 * describes the version it rebuilds. A tag from before INSTALL-NOTE.md existed
 * falls back to the checked-out copy; the CHANGELOG is read only when notes
 * have to be written from scratch, so a tag from before CHANGELOG.md existed
 * can still have its installers re-attached.
 *
 * Three outcomes, decided by what is on the release right now:
 *   - no release for the tag (and no saved draft): create it AS A DRAFT, with
 *     the CHANGELOG entry for the version as its notes and the install note
 *     after it — the workflow's publish job makes it public once both
 *     installers are attached and checked, so no release is ever public with
 *     an empty Assets list;
 *   - notes without the install note (the owner wrote them): append the
 *     install note once;
 *   - notes that already carry the install note (a re-run, a repair): change
 *     nothing.
 * "Already carry the install note" means the notes contain the note's own
 * first heading, taken from the note as read for this tag — not a constant on
 * main, so rewording the heading later cannot make an old tag print it twice.
 * A saved DRAFT for the tag is invisible to the by-tag lookup, so it is looked
 * for in the release list and given its notes; it stays a draft for the
 * publish job — the tag is what ships. Two drafts for one tag, an answer that
 * is neither 200 nor 404, or a body that is not JSON stop the run instead of
 * guessing: a wrong guess here would overwrite notes somebody wrote by hand, or
 * create a second release.
 *
 * Outputs, for the jobs that follow (written to $GITHUB_OUTPUT when set):
 *   release_id=<number>   the release the installers go to
 *   is_draft=true|false   whether the publish job has anything to publish
 *
 * Why this exists: issue #32. v5.0.0's release lost all nine installers when
 * the release CI had populated was replaced by hand. The old workflow let two
 * uploaders (electron-builder and the release action) and two matrix jobs
 * touch the release at once, appended the install note unconditionally, and
 * offered no way to put the installers back.
 *
 * Environment: GITHUB_REPOSITORY (owner/repo), GH_TOKEN or GITHUB_TOKEN, and
 * optionally GITHUB_API_URL (defaults to https://api.github.com).
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** @typedef {{ action: 'keep' }} KeepDecision */
/** @typedef {{ action: 'append' | 'write', body: string }} WriteDecision */
/** @typedef {KeepDecision | WriteDecision} Decision */
/** @typedef {{ status: number, text(): Promise<string> }} FetchResult */
/** @typedef {(url: string, init: { method: string, headers: Record<string, string>, body?: string, signal: AbortSignal }) => Promise<FetchResult>} Fetch */
/** @typedef {{ fetch: Fetch, env: Record<string, string | undefined>, cwd: string, log?: (line: string) => void }} Deps */
/** @typedef {{ action: Decision['action'], created: boolean, isDraft: boolean, id: number }} Outcome */
/** @typedef {{ fetch: Fetch, base: string, repo: string, token: string }} GitHub */

/** How long one request to GitHub may take before the run fails instead of hanging. */
const REQUEST_TIMEOUT_MS = 60_000;
/** GitHub's page size for the release list; pages are read until one comes back short. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * The install note's own first heading — its presence in a release body means
 * the note is already there.
 * @param {string} note
 * @returns {string}
 */
function markerOf(note) {
  const heading = note.replace(/\r\n/g, '\n').split('\n').find((l) => l.startsWith('## '));
  if (!heading) throw new Error('INSTALL-NOTE.md has no "## " heading to recognise it by');
  return heading.trim();
}

/**
 * The body of one version's CHANGELOG entry: the lines after its `## [X.Y.Z]`
 * heading up to the next `## [` heading, with one trailing newline. Null when
 * the version has no entry.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
function changelogEntry(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * INSTALL-NOTE.md names the files as `TreeMap-x.y.z-…`; the release names them for real.
 * @param {string} note
 * @param {string} version
 */
function fillVersion(note, version) {
  return note.replace(/x\.y\.z/g, version);
}

/**
 * What the notes should become, given the body on the release now. The note is
 * always separated from what precedes it by a blank line, so its `---` stays a
 * rule and never turns the owner's last sentence into a heading.
 * @param {string | null | undefined} body
 * @param {{ version: string, note: string, changelog: string | (() => string) }} facts
 *   `changelog` may be a function: it is read only when the notes must be written.
 * @returns {Decision}
 */
function decide(body, { version, note, changelog }) {
  const current = (body || '').replace(/\r\n/g, '\n');
  const trimmedNote = note.replace(/^\s+/, '');
  if (current.includes(markerOf(note))) return { action: 'keep' };
  if (current.trim()) return { action: 'append', body: `${current.replace(/\s+$/, '')}\n\n${trimmedNote}` };
  const text = typeof changelog === 'function' ? changelog() : changelog;
  const entry = changelogEntry(text, version);
  if (entry === null) throw new Error(`CHANGELOG.md has no '## [${version}]' entry, so the release would have no notes`);
  return { action: 'write', body: `# TreeMap ${version}\n${entry}\n${trimmedNote}` };
}

/**
 * A file's content as it was at the tag. The fully qualified ref, so a branch
 * that happens to share the tag's name cannot be read by mistake.
 * @param {string} cwd
 * @param {string} tag
 * @param {string} file
 * @returns {string}
 */
function readAtTag(cwd, tag, file) {
  try {
    return execFileSync('git', ['show', `refs/tags/${tag}:${file}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`cannot read ${file} at ${tag}: ${String(err.stderr || err.message || '').trim()}`, { cause: err });
  }
}

/**
 * The install note for this tag: the tag's own copy, else the checked-out one
 * (tags from before .github/INSTALL-NOTE.md existed still deserve the note).
 * @param {string} cwd
 * @param {string} tag
 * @param {(line: string) => void} log
 */
function readNote(cwd, tag, log) {
  try {
    return readAtTag(cwd, tag, '.github/INSTALL-NOTE.md');
  } catch (atTag) {
    const local = path.join(cwd, '.github', 'INSTALL-NOTE.md');
    if (!fs.existsSync(local)) throw atTag;
    log(`::notice::${tag} predates .github/INSTALL-NOTE.md; using the checked-out copy`);
    return fs.readFileSync(local, 'utf8');
  }
}

/**
 * One request to the GitHub REST API. Any body that is not JSON is an error,
 * whatever the status: a truncated 200 must never read as "no release".
 * @param {GitHub} gh
 * @param {'GET' | 'POST' | 'PATCH'} method
 * @param {string} route
 * @param {object} [payload]
 * @returns {Promise<{ status: number, json: unknown, raw: string }>}
 */
async function request(gh, method, route, payload) {
  const res = await gh.fetch(`${gh.base}/repos/${gh.repo}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${gh.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'treemap-release-notes',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let json = null;
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${method} ${route} returned HTTP ${res.status} with a body that is not JSON: ${raw.slice(0, 300)}`);
    }
  }
  return { status: res.status, json, raw };
}

function fail(what, r) {
  return new Error(`${what} returned HTTP ${r.status}${r.raw ? `: ${r.raw.slice(0, 300)}` : ''}`);
}

/** @param {unknown} x */
const isRelease = (x) => Boolean(x) && typeof x === 'object' && typeof (/** @type {{ id?: unknown }} */ (x)).id === 'number';

/**
 * The release for the tag: the published one, else a saved draft, else null.
 * @param {GitHub} gh
 * @param {string} tag
 * @returns {Promise<{ id: number, draft: boolean, body?: string | null } | null>}
 */
async function findRelease(gh, tag) {
  const byTag = await request(gh, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
  if (byTag.status === 200) {
    if (!isRelease(byTag.json)) throw fail(`GET /releases/tags/${tag} (200 without a release object)`, byTag);
    return /** @type {{ id: number, draft: boolean, body?: string | null }} */ (byTag.json);
  }
  if (byTag.status !== 404) throw fail(`GET /releases/tags/${tag}`, byTag);
  // A saved draft carries the tag name but is not found by tag.
  const drafts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = await request(gh, 'GET', `/releases?per_page=${PAGE_SIZE}&page=${page}`);
    if (list.status !== 200 || !Array.isArray(list.json)) throw fail(`GET /releases?page=${page}`, list);
    drafts.push(...list.json.filter((r) => r.draft === true && r.tag_name === tag));
    if (list.json.length < PAGE_SIZE) break;
  }
  if (drafts.length > 1) throw new Error(`${drafts.length} draft releases carry tag ${tag}; keep one and delete the rest, then run again`);
  return drafts[0] || null;
}

/**
 * Settle the release for `tag`. Returns what was decided and done.
 * `deps` is injectable so a test can stand in for GitHub and point at a
 * throwaway repository.
 * @param {string} tag
 * @param {Deps} deps
 * @returns {Promise<Outcome>}
 */
async function main(tag, deps) {
  const log = deps.log || ((line) => console.log(line));
  if (!tag) throw new Error('usage: node scripts/release-notes.js <tag>');
  if (!deps.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is not set');
  const token = deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is not set');
  /** @type {GitHub} */
  const gh = { fetch: deps.fetch, base: deps.env.GITHUB_API_URL || 'https://api.github.com', repo: deps.env.GITHUB_REPOSITORY, token };

  let version;
  try {
    version = JSON.parse(readAtTag(deps.cwd, tag, 'package.json')).version;
  } catch (err) {
    throw new Error(`package.json at ${tag} is not readable JSON: ${err.message}`, { cause: err });
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match package.json version ${version} at that tag — ` +
      `electron-builder names the installers after package.json, so the release page and its files would disagree`);
  }
  const note = fillVersion(readNote(deps.cwd, tag, log), version);
  const changelog = () => readAtTag(deps.cwd, tag, 'CHANGELOG.md');

  const release = await findRelease(gh, tag);
  const decision = decide(release ? release.body : null, { version, note, changelog });
  if (decision.action !== 'keep' && typeof decision.body !== 'string') {
    throw new Error(`decide() returned '${decision.action}' without a body — refusing to write empty notes`);
  }

  /** @type {Outcome} */
  let outcome;
  if (!release) {
    const created = await request(gh, 'POST', '/releases', { tag_name: tag, name: tag, body: decision.body, draft: true, prerelease: false });
    if (created.status !== 201) throw fail('POST /releases', created);
    if (!isRelease(created.json)) throw fail('POST /releases (201 without a release object)', created);
    log(`::notice::created release ${tag} as a draft, with the CHANGELOG ${version} entry and the install note; it is published once both installers are attached`);
    outcome = { action: decision.action, created: true, isDraft: true, id: created.json.id };
  } else {
    if (decision.action !== 'keep') {
      const edited = await request(gh, 'PATCH', `/releases/${release.id}`, { body: decision.body });
      if (edited.status !== 200) throw fail(`PATCH /releases/${release.id}`, edited);
    }
    const isDraft = release.draft === true;
    const said = {
      keep: 'notes already carry the install note; left as they are',
      append: 'install note added after the notes',
      write: 'notes written from the CHANGELOG entry and the install note',
    }[decision.action];
    log(`::notice::release ${tag}${isDraft ? ' (a draft; published once both installers are attached)' : ''}: ${said}`);
    outcome = { action: decision.action, created: false, isDraft, id: release.id };
  }
  if (deps.env.GITHUB_OUTPUT) {
    fs.appendFileSync(deps.env.GITHUB_OUTPUT, `release_id=${outcome.id}\nis_draft=${outcome.isDraft}\n`);
  }
  return outcome;
}

module.exports = { markerOf, changelogEntry, fillVersion, decide, findRelease, main };

if (require.main === module) {
  main(process.argv[2], { fetch: globalThis.fetch, env: process.env, cwd: process.cwd() }).catch((err) => {
    // One line: a newline in the message would let a stray value forge a second annotation.
    console.error(`::error::${String(err && err.message ? err.message : err).replace(/[\r\n]+/g, ' ')}`);
    process.exitCode = 1;
  });
}
