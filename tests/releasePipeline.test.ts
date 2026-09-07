import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * The release pipeline, held to what it promises.
 *
 * Issue #32: v5.0.0 was published with an empty Assets list. CI had built and
 * attached the installer files — to the release that existed for the tag at
 * that moment. GitHub attaches assets to the release entry, not to the tag, so
 * when that release was replaced by hand, the files went with it, and nothing
 * could put them back: the only trigger that uploaded was a tag push, and
 * re-running the old run would have printed the install note a second time.
 *
 * release.yml now has a repair path (Run workflow with a tag), settles the
 * release and its notes in one job BEFORE the two builds race for it, adds the
 * install note only when it is missing, keeps a release it created a draft
 * until both installers are attached and checked byte for byte, never deletes
 * a working file to re-upload it, and keeps electron-builder's own publisher
 * off — exactly once, because twice is the same as never. The notes logic is a
 * script and is exercised here against a real git tag and a fake GitHub (and
 * once, end to end, against a local HTTP server); the three inline bash steps
 * are RUN under /bin/bash with stand-ins for curl and npm. The YAML is not
 * only read.
 */

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const YML = read('.github', 'workflows', 'release.yml');
const README = read('README.md');
const HANDOFF = read('HANDOFF.md');
const CHANGELOG = read('CHANGELOG.md');
const INSTALL_NOTE = read('.github', 'INSTALL-NOTE.md');
const PKG = JSON.parse(read('package.json')) as {
  version: string;
  scripts: Record<string, string>;
  build: { nsis: { artifactName: string }; portable: { artifactName: string } };
};

interface Decision { action: 'keep' | 'append' | 'write'; body?: string }
interface FetchInit { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
interface Deps { fetch: (url: string, init: FetchInit) => Promise<{ status: number; text(): Promise<string> }>; env: Record<string, string | undefined>; cwd: string; log?: (line: string) => void }
interface Outcome { action: Decision['action']; created: boolean; isDraft: boolean; id: number }
const notes = require('../scripts/release-notes.js') as {
  markerOf(note: string): string;
  changelogEntry(changelog: string, version: string): string | null;
  fillVersion(note: string, version: string): string;
  decide(body: string | null | undefined, facts: { version: string; note: string; changelog: string | (() => string) }): Decision;
  main(tag: string, deps: Deps): Promise<Outcome>;
};
const MARKER = notes.markerOf(INSTALL_NOTE);
const isWin = process.platform === 'win32';

/** Throwaway directories, removed when the file is done. */
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** The text between two markers, hard-failing when either is missing. */
function section(doc: string, start: string, end: string): string {
  const a = doc.indexOf(start);
  assert.notEqual(a, -1, `"${start}" exists`);
  const b = doc.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `"${end}" follows "${start}"`);
  return doc.slice(a, b);
}

/** One job's block of release.yml: from its key to the next job (or the end). */
function job(name: string): string {
  const m = YML.match(new RegExp(`\\n {2}${name}:\\n[\\s\\S]*?(?=\\n {2}\\S|$)`));
  assert.ok(m, `job ${name} exists`);
  return m![0];
}

/** Every step block within `within` (default: the whole file), in order. */
function steps(within = YML): string[] {
  return within.split(/\n(?=\s+- name: )/).slice(1);
}

/** The one step block within `within` that contains `key`. */
function step(key: string, within = YML): string {
  const hits = steps(within).filter((b) => b.includes(key));
  assert.equal(hits.length, 1, `exactly one step mentions ${JSON.stringify(key)}`);
  return hits[0];
}

/** The bash of a step's `run: |` block, dedented, as a runnable script. */
function script(block: string): string {
  const at = block.indexOf('run: |\n');
  assert.notEqual(at, -1, 'the step has a multi-line run block');
  const lines = block.slice(at + 'run: |\n'.length).replace(/\n+$/, '').split('\n');
  const indent = lines[0].match(/^ */)![0].length;
  assert.ok(indent >= 8, 'the script is indented under run:');
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(indent))).join('\n') + '\n';
}

/** The `files:` patterns of one matrix entry, indentation taken from the first line. */
function matrixFiles(runner: string): string[] {
  const matrix = section(YML, 'matrix:', 'runs-on:');
  const at = matrix.indexOf(`- os: ${runner}`);
  assert.notEqual(at, -1, `${runner} is in the matrix`);
  const entry = matrix.slice(at);
  const next = entry.indexOf('- os: ', 1);
  const own = next === -1 ? entry : entry.slice(0, next);
  const files = own.indexOf('files: |\n');
  assert.notEqual(files, -1, `${runner} lists the files it releases`);
  const lines = own.slice(files + 'files: |\n'.length).split('\n');
  const indent = lines[0].match(/^ */)![0].length;
  assert.ok(indent > 0, 'the list is indented under files:');
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim() && l.startsWith(' '.repeat(indent))) out.push(l.trim());
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The workflow's shape.

test('release.yml can be run by hand for an existing tag, and then builds THAT tag', () => {
  assert.match(YML, /workflow_dispatch:\n\s+inputs:\n\s+tag:\n/, 'Run workflow offers a tag box');
  const input = section(YML, 'tag:\n', '\npermissions:');
  assert.match(input, /description: .*installers/, 'the box says what typing a tag does');
  assert.match(input, /required: false/, 'the box may be left empty for a test build');
  assert.match(step('Check out the code', job('build')), /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/,
    'the build checks out the typed tag, else the pushed ref');
  assert.doesNotMatch(step('Check out the code', job('notes')), /ref:/, "the notes job runs the workflow's own commit and fetches the tag itself");
  assert.match(YML, /^env:\n {2}RELEASE_TAG: \$\{\{ inputs\.tag \|\| \(startsWith\(github\.ref, 'refs\/tags\/'\) && github\.ref_name\) \|\| '' \}\}$/m,
    'RELEASE_TAG is the typed tag, else the pushed tag, else empty');
  assert.match(YML, /^concurrency:\n {2}group: release-\$\{\{ inputs\.tag \|\| github\.ref_name \}\}\n {2}cancel-in-progress: false$/m,
    'two runs for one tag queue instead of uploading into the same release at once');
});

test('the release and its notes are settled by one job before the two builds start, and published by one job after them', () => {
  assert.ok(YML.indexOf('\n  notes:\n') < YML.indexOf('\n  build:\n') && YML.indexOf('\n  build:\n') < YML.indexOf('\n  publish:\n'), 'notes, build, publish — in that order');
  const notesJob = job('notes');
  assert.match(notesJob, /\n {4}if: inputs\.tag != '' \|\| startsWith\(github\.ref, 'refs\/tags\/'\)\n/, 'the notes job runs only for a tag');
  assert.match(notesJob, /\n {4}runs-on: ubuntu-latest\n/);
  assert.match(notesJob, /\n {4}outputs:\n {6}release_id: \$\{\{ steps\.settle\.outputs\.release_id \}\}\n {6}is_draft: \$\{\{ steps\.settle\.outputs\.is_draft \}\}\n/, 'it hands the release on to the jobs below');
  const settleStep = step('Create the Release, or bring its notes up to date');
  assert.match(settleStep, /\n {8}id: settle\n/);
  const settle = script(settleStep);
  assert.match(settle, /^set -euo pipefail\n/);
  assert.match(settle, /No `npm ci` here/, 'the built-ins-only constraint is stated where it bites');
  assert.match(settle, /git fetch --no-tags --depth=1 origin "\+refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG"\n/,
    'the tag is fetched, so the script can read the files as they were at the tag');
  assert.match(settle, /node scripts\/release-notes\.js "\$RELEASE_TAG"\n/);
  const buildJob = job('build');
  assert.match(buildJob, /\n {4}needs: notes\n/, 'the builds wait for it');
  assert.match(buildJob, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.notes\.result != 'failure' \}\}\n/,
    'they still run when it is skipped (test build), and stop when it failed');
  const publishJob = job('publish');
  assert.match(publishJob, /\n {4}needs: \[notes, build\]\n/);
  assert.match(publishJob, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.build\.result == 'success' && needs\.notes\.result == 'success' \}\}\n/,
    'a draft goes public only when both builds attached and checked their files');
  const upload = step('Upload installers to the Release');
  assert.doesNotMatch(upload, /\n {10}(body|body_path|append_body|name|prerelease|make_latest):/,
    'the upload step never touches the notes or the title — two jobs racing on the body was a lost-update bug');
  assert.match(upload, /\n {10}draft: \$\{\{ needs\.notes\.outputs\.is_draft == 'true' \}\}\n/, 'a draft stays a draft while the files arrive; a public release stays public');
  assert.match(upload, /\n {10}overwrite_files: false\n/, 'a working file is never deleted to be uploaded again');
});

test('every release step is gated on RELEASE_TAG, and only the test build runs without one', () => {
  for (const name of ['Upload installers to the Release', 'Check the Release now holds']) {
    assert.match(step(name), /\n {8}if: env\.RELEASE_TAG != ''\n/, `${name} runs only for a tag`);
  }
  assert.match(step('Save installers as workflow artifacts'), /\n {8}if: env\.RELEASE_TAG == ''\n/, 'artifacts are the test-build path only');
  assert.doesNotMatch(YML, /\n {8}if: .*startsWith\(github\.ref/, 'no step keys off the pushed ref alone — that gate ignored Run workflow');
});

test('electron-builder sees --publish never exactly once, whichever tag is checked out, and holds no token', () => {
  const build = step('Build the installer');
  assert.doesNotMatch(build, /GH_TOKEN|GITHUB_TOKEN/, 'no token reaches electron-builder');
  assert.match(build, /\n {10}SCRIPT: \$\{\{ matrix\.script \}\}\n/);
  const dist = Object.entries(PKG.scripts).filter(([k]) => k.startsWith('dist'));
  assert.ok(dist.length >= 4, 'the dist scripts exist');
  for (const [k, v] of dist) {
    const at = v.indexOf('electron-builder');
    assert.notEqual(at, -1, `${k} runs electron-builder`);
    const call = v.slice(at).split('&&')[0];
    assert.match(call, / --publish never(?: |$)/, `${k}'s electron-builder call carries --publish never, so a local token can never cut a release`);
    assert.equal((call.match(/--publish/g) ?? []).length, 1, `${k}: once — twice becomes a list that no longer equals "never"`);
  }
});

test("the upload step targets the tag, uploads this job's own files, and refuses an empty match", () => {
  const upload = step('Upload installers to the Release');
  assert.match(upload, /uses: softprops\/action-gh-release@v2\n/);
  assert.match(upload, /tag_name: \$\{\{ env\.RELEASE_TAG \}\}\n/, "the release is found by RELEASE_TAG, not by the run's own ref");
  assert.match(upload, /fail_on_unmatched_files: true\n/, 'a build that produced nothing fails instead of reporting success with nothing attached');
  assert.match(upload, /files: \$\{\{ matrix\.files \}\}\n/, 'each job uploads its own list');

  const mac = matrixFiles('macos-latest');
  const win = matrixFiles('windows-latest');
  assert.deepEqual(mac, ['release/*.dmg', 'release/*.dmg.blockmap', 'release/*.zip', 'release/*.zip.blockmap', 'release/latest-mac.yml'],
    'macOS: the dmg, the zip the updater installs from, their blockmaps, and latest-mac.yml');
  assert.deepEqual(win, ['release/*.exe', 'release/*.exe.blockmap', 'release/latest.yml'],
    "Windows: both exes, the installer's blockmap, and latest.yml");
  assert.match(step('Save installers as workflow artifacts'), /path: \$\{\{ matrix\.files \}\}\n/, 'the test build saves the same list');

  const check = step('Check the Release now holds');
  assert.doesNotMatch(check, /matrix\.os/, 'each job checks its own files');
  assert.match(check, /\n {10}FILES: \$\{\{ matrix\.files \}\}\n/, 'the check reads the very list the upload step published, not a copy');
  assert.match(check, /\n {10}RELEASE_ID: \$\{\{ needs\.notes\.outputs\.release_id \}\}\n/, 'read by id, which finds a draft as well as a public release');
  assert.match(check, /\n {10}GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\n/);
  assert.match(script(check), /Inline on purpose/, 'says why it is not a script: old tags have none');
});

test('every multi-line run step declares shell: bash — windows-latest defaults to PowerShell', () => {
  const blocks = steps().filter((b) => b.includes('run: |\n'));
  assert.ok(blocks.length >= 4, 'settle, build, check and publish are bash');
  for (const b of blocks) assert.match(b, /\n {8}shell: bash\n/, `bash is explicit in: ${b.split('\n')[0]}`);
});

test('installer names carry no spaces — the check step compares them to the names GitHub stores, and GitHub turns spaces into dots', () => {
  for (const name of [PKG.build.nsis.artifactName, PKG.build.portable.artifactName]) {
    assert.doesNotMatch(name, /\s/, `${name}: a space would fail the post-upload check`);
  }
});

// ---------------------------------------------------------------------------
// The notes script, unit by unit.

const SYNTHETIC_CHANGELOG = `# Changelog

## [Unreleased]

- nothing yet

## [9.9.9] — 2026-09-06

### Fixed

- The nine-nine-nine line.

## [9.9.8] — 2026-09-01

- The old line.
`;

const NOTE_9 = INSTALL_NOTE.replace(/x\.y\.z/g, '9.9.9');
const NOTE_9_BODY = NOTE_9.replace(/^\s+/, '');
const WRITTEN_9 = `# TreeMap 9.9.9\n\n### Fixed\n\n- The nine-nine-nine line.\n\n${NOTE_9_BODY}`;
const quiet = () => {};

test('markerOf: the install note is recognised by its own first heading, whatever the line endings', () => {
  assert.equal(MARKER, '## 📥 Installing');
  assert.equal(notes.markerOf(INSTALL_NOTE.replace(/\n/g, '\r\n')), MARKER);
  assert.throws(() => notes.markerOf('no headings here\n- just a list\n'), /no "## " heading/);
});

test('changelogEntry: the entry for one version, from the real CHANGELOG and a synthetic one', () => {
  const five = notes.changelogEntry(CHANGELOG, '5.0.0')!;
  assert.ok(five, 'the 5.0.0 entry exists');
  assert.match(five, /Disk City/);
  assert.doesNotMatch(five, /\[5\.1\.0\]|pointer is TreeMap's own|\[3\.2\.1\]/, "only 5.0.0's own lines");
  assert.ok(five.startsWith('\nThe first public release since 3.2.1.'), `the heading line itself is not included:\n${five.slice(0, 80)}`);
  assert.ok(five.endsWith('\n') && !five.endsWith('\n\n'), 'ends with exactly one newline');
  assert.equal(notes.changelogEntry(SYNTHETIC_CHANGELOG, '9.9.9'), '\n### Fixed\n\n- The nine-nine-nine line.\n');
  assert.equal(notes.changelogEntry(SYNTHETIC_CHANGELOG, '9.9.7'), null, 'an unknown version is null, not a guess');
  assert.equal(notes.changelogEntry(SYNTHETIC_CHANGELOG.replace(/\n/g, '\r\n'), '9.9.9'), '\n### Fixed\n\n- The nine-nine-nine line.\n', 'a CRLF checkout reads the same');
  // The last entry in the file runs to the end, whole.
  assert.equal(notes.changelogEntry(SYNTHETIC_CHANGELOG, '9.9.8'), '\n- The old line.\n');
  assert.equal(notes.changelogEntry('## [1.0.0] — x\n- the only line', '1.0.0'), '- the only line\n', 'no trailing newline in the file: the last line is still kept');
  const lastHeading = CHANGELOG.match(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm)!.pop()!.match(/\[([^\]]+)\]/)![1];
  const lastLine = CHANGELOG.trimEnd().split('\n').pop()!;
  assert.ok(notes.changelogEntry(CHANGELOG, lastHeading)!.endsWith(`${lastLine}\n`), `the ${lastHeading} entry keeps the file's last line`);
});

test('decide: what the notes become, given what is on the release now', () => {
  const facts = { version: '9.9.9', note: NOTE_9, changelog: SYNTHETIC_CHANGELOG };
  const written = notes.decide(null, facts);
  assert.equal(written.action, 'write');
  assert.equal(written.body, WRITTEN_9, 'heading, entry, a blank line, the install note');
  assert.equal(notes.decide('', facts).body, WRITTEN_9, 'an empty body is no notes');
  assert.equal(notes.decide('  \n', facts).body, WRITTEN_9, 'whitespace is no notes');
  const appended = notes.decide("What changed, in the owner's words.\n", facts);
  assert.equal(appended.action, 'append');
  assert.equal(appended.body, `What changed, in the owner's words.\n\n${NOTE_9_BODY}`, "the owner's notes, a blank line, the install note once");
  assert.deepEqual(notes.decide(written.body, facts), { action: 'keep' }, 'a second run changes nothing');
  assert.deepEqual(notes.decide(appended.body, facts), { action: 'keep' });
  assert.deepEqual(notes.decide(`Older notes with the ${MARKER} heading in them`, facts), { action: 'keep' }, 'the heading alone is the signal');
  assert.doesNotMatch(written.body!, /x\.y\.z/);
  assert.match(written.body!, /`TreeMap-9\.9\.9-arm64\.dmg`/);
  assert.match(written.body!, /`TreeMap-Setup-9\.9\.9\.exe`/);
  assert.equal(notes.fillVersion(INSTALL_NOTE, '9.9.9'), NOTE_9);
});

test('decide: the note is always preceded by a blank line, so its --- stays a rule and never turns the last sentence into a heading', () => {
  const facts = { version: '9.9.9', note: NOTE_9_BODY, changelog: SYNTHETIC_CHANGELOG };
  assert.match(notes.decide('Owner notes.', facts).body!, /^Owner notes\.\n\n---\n/, 'even when the note file has no leading blank line');
  assert.match(notes.decide(null, facts).body!, /line\.\n\n---\n/);
  assert.equal(notes.decide('Owner notes.\n\n\n', facts).body, `Owner notes.\n\n${NOTE_9_BODY}`, 'trailing blank lines do not stack');
});

test('decide: a body written in the web form (CRLF, as the real v5.0.0 body is) is read like any other', () => {
  const facts = { version: '9.9.9', note: NOTE_9, changelog: SYNTHETIC_CHANGELOG };
  assert.deepEqual(notes.decide(`Notes.\r\n\r\n${NOTE_9.replace(/\n/g, '\r\n')}`, facts), { action: 'keep' }, 'kept, not appended to again');
  assert.equal(notes.decide('Owner notes.\r\n', facts).body, `Owner notes.\n\n${NOTE_9_BODY}`, 'the trailing CRLF is stripped before the note');
});

test("decide: the CHANGELOG is read only when notes must be written, and the heading it looks for is the note's own", () => {
  let reads = 0;
  const changelog = () => { reads += 1; return SYNTHETIC_CHANGELOG; };
  notes.decide(`Notes.\n${NOTE_9}`, { version: '9.9.9', note: NOTE_9, changelog });
  notes.decide('Owner notes.', { version: '9.9.9', note: NOTE_9, changelog });
  assert.equal(reads, 0, 'keep and append never open the CHANGELOG — a tag from before it existed can still be repaired');
  assert.equal(notes.decide(null, { version: '9.9.9', note: NOTE_9, changelog }).action, 'write');
  assert.equal(reads, 1);
  assert.throws(() => notes.decide(null, { version: '9.9.9', note: NOTE_9, changelog: '# Changelog\n\n## [9.9.8] — x\n\n- old\n' }), /CHANGELOG\.md has no '## \[9\.9\.9\]' entry/,
    'no entry → no release, rather than a release with empty notes');
  // The heading is taken from the note as read for this tag, not from a constant.
  const reworded = NOTE_9.replace(MARKER, '## 📦 Getting it');
  assert.deepEqual(notes.decide('Body.\n\n## 📦 Getting it\n', { version: '9.9.9', note: reworded, changelog }), { action: 'keep' });
  assert.equal(notes.decide(`Body.\n${NOTE_9}`, { version: '9.9.9', note: reworded, changelog }).action, 'append', "the old heading is not this note's heading");
});

// ---------------------------------------------------------------------------
// The notes script against a real tag and a fake GitHub.

interface RepoOptions { annotated?: boolean; shadowBranch?: boolean; worktree?: Record<string, string> }

/** A throwaway git repository holding `files` at tag `tag`, with a later commit so "at the tag" and "in the working tree" differ. */
function taggedRepo(files: Record<string, string>, tag: string, opts: RepoOptions = {}): string {
  const dir = tmp('treemap-notes-');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (set: Record<string, string>) => {
    for (const [p, c] of Object.entries(set)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), c);
    }
  };
  git('init', '-q');
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'the release');
  if (opts.annotated) git('tag', '-a', tag, '-m', `release ${tag}`);
  else git('tag', tag);
  write({ 'package.json': JSON.stringify({ name: 'treemap', version: '10.0.0' }), 'CHANGELOG.md': '# Changelog\n\n## [10.0.0] — 2026-10-01\n\n- Future.\n', ...(opts.worktree ?? {}) });
  git('add', '-A');
  git('commit', '-q', '-m', 'after the release');
  if (opts.shadowBranch) git('branch', tag);
  return dir;
}

const TAG_FILES = {
  'package.json': JSON.stringify({ name: 'treemap', version: '9.9.9' }),
  'CHANGELOG.md': SYNTHETIC_CHANGELOG,
  '.github/INSTALL-NOTE.md': INSTALL_NOTE,
};

interface Reply { status: number; json?: unknown; raw?: string; expect?: [string, string] }
interface Call { method: string; url: string; body?: Record<string, unknown>; auth?: string; signal: AbortSignal }

/** Queued replies, each optionally pinned to the [method, url-suffix] it must answer. */
function fakeGitHub(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: Deps['fetch'] = async (url, init) => {
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
    if (reply.expect) {
      assert.equal(init.method, reply.expect[0], `request ${calls.length + 1} method`);
      assert.ok(url.endsWith(reply.expect[1]), `request ${calls.length + 1}: ${url} ends with ${reply.expect[1]}`);
    }
    calls.push({ method: init.method, url, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined, auth: init.headers.authorization, signal: init.signal });
    return { status: reply.status, text: async () => reply.raw ?? (reply.json === undefined ? '' : JSON.stringify(reply.json)) };
  };
  return { fetch, calls };
}

const ENV = { GITHUB_API_URL: 'https://api.example.test', GITHUB_REPOSITORY: 'Owner/Repo', GH_TOKEN: 'stub-token' };
const API = 'https://api.example.test/repos/Owner/Repo';
const run = (tag: string, gh: ReturnType<typeof fakeGitHub>, cwd: string, env: Record<string, string | undefined> = ENV, log: (l: string) => void = quiet) =>
  notes.main(tag, { fetch: gh.fetch, env, cwd, log });
const NOT_FOUND: Reply = { status: 404, json: { message: 'Not Found' }, expect: ['GET', '/releases/tags/v9.9.9'] };
const NO_DRAFTS: Reply = { status: 200, json: [], expect: ['GET', '/releases?per_page=100&page=1'] };
const published = (body: string | null | undefined, id = 7): Reply => ({ status: 200, json: { id, draft: false, tag_name: 'v9.9.9', body }, expect: ['GET', '/releases/tags/v9.9.9'] });
const draftList = (body: string, id = 9): Reply => ({ ...NO_DRAFTS, json: [{ id: 1, draft: false, tag_name: 'v9.9.8', body: 'older' }, { id, draft: true, tag_name: 'v9.9.9', body }, { id: 10, draft: true, tag_name: 'v10.0.0', body: '' }] });

test('main: no release for the tag → one is created as a DRAFT with the CHANGELOG entry and the install note; the publish job makes it public', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([NOT_FOUND, NO_DRAFTS, { status: 201, json: { id: 42 }, expect: ['POST', '/releases'] }]);
  const lines: string[] = [];
  const out = await run('v9.9.9', gh, cwd, ENV, (l) => lines.push(l));
  assert.deepEqual(out, { action: 'write', created: true, isDraft: true, id: 42 });
  assert.deepEqual(gh.calls.map((c) => [c.method, c.url]), [
    ['GET', `${API}/releases/tags/v9.9.9`],
    ['GET', `${API}/releases?per_page=100&page=1`],
    ['POST', `${API}/releases`],
  ]);
  for (const c of gh.calls) {
    assert.equal(c.auth, 'Bearer stub-token');
    assert.ok(c.signal instanceof AbortSignal, 'every request carries a timeout, so a hung connection fails instead of waiting for the job timeout');
  }
  const created = gh.calls[2].body!;
  assert.equal(created.tag_name, 'v9.9.9');
  assert.equal(created.name, 'v9.9.9');
  assert.equal(created.draft, true, 'not public until both installers are attached and checked');
  assert.equal(created.prerelease, false);
  assert.equal(created.body, WRITTEN_9, "the TAG's changelog, not the working tree's 10.0.0");
  assert.ok(lines.some((l) => /created release v9\.9\.9 as a draft/.test(l)), lines.join('\n'));
});

test("main: the owner published the release with their own notes → the install note is appended once, nothing else changes", async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([published("What changed, in the owner's words."), { status: 200, json: { id: 7 }, expect: ['PATCH', '/releases/7'] }]);
  const out = await run('v9.9.9', gh, cwd);
  assert.deepEqual(out, { action: 'append', created: false, isDraft: false, id: 7 });
  assert.deepEqual(gh.calls[1].body, { body: `What changed, in the owner's words.\n\n${NOTE_9_BODY}` }, 'only the body — title, draft flag and everything else are left alone');
});

test('main: the release already carries the install note (a repair, a re-run) → not one request that writes', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([published(`Notes.\n${NOTE_9}`)]);
  const out = await run('v9.9.9', gh, cwd);
  assert.deepEqual(out, { action: 'keep', created: false, isDraft: false, id: 7 });
  assert.equal(gh.calls.length, 1, 'one read, no write');
});

test('main: a release with an empty body counts as having no notes', async () => {
  for (const body of [null, '', undefined]) {
    const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
    const gh = fakeGitHub([published(body), { status: 200, json: { id: 7 }, expect: ['PATCH', '/releases/7'] }]);
    const out = await run('v9.9.9', gh, cwd);
    assert.equal(out.action, 'write', `body ${JSON.stringify(body)}`);
    assert.deepEqual(gh.calls[1].body, { body: WRITTEN_9 });
  }
});

test('main: a saved draft for the tag is invisible by tag — it is found in the list, given its notes, and left a draft for the publish job', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([NOT_FOUND, draftList('Drafted by hand.'), { status: 200, json: { id: 9 }, expect: ['PATCH', '/releases/9'] }]);
  const out = await run('v9.9.9', gh, cwd);
  assert.deepEqual(out, { action: 'append', created: false, isDraft: true, id: 9 });
  assert.deepEqual(gh.calls[2].body, { body: `Drafted by hand.\n\n${NOTE_9_BODY}` }, 'the body only; publishing is the last job\'s decision, once the files are there');

  const kept = fakeGitHub([NOT_FOUND, draftList(`Notes.\n${NOTE_9}`)]);
  assert.deepEqual(await run('v9.9.9', kept, taggedRepo(TAG_FILES, 'v9.9.9')), { action: 'keep', created: false, isDraft: true, id: 9 });
  assert.equal(kept.calls.length, 2, 'a draft that already carries the note is not written to at all');

  const empty = fakeGitHub([NOT_FOUND, draftList(''), { status: 200, json: { id: 9 }, expect: ['PATCH', '/releases/9'] }]);
  assert.deepEqual(await run('v9.9.9', empty, taggedRepo(TAG_FILES, 'v9.9.9')), { action: 'write', created: false, isDraft: true, id: 9 });
  assert.deepEqual(empty.calls[2].body, { body: WRITTEN_9 });
});

test('main: writes release_id and is_draft to GITHUB_OUTPUT when the runner provides one', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const output = path.join(tmp('treemap-output-'), 'github-output');
  writeFileSync(output, 'earlier=kept\n');
  await run('v9.9.9', fakeGitHub([published(`x\n${NOTE_9}`, 77)]), cwd, { ...ENV, GITHUB_OUTPUT: output });
  assert.equal(readFileSync(output, 'utf8'), 'earlier=kept\nrelease_id=77\nis_draft=false\n', 'appended, not overwritten');
  await run('v9.9.9', fakeGitHub([NOT_FOUND, NO_DRAFTS, { status: 201, json: { id: 42 } }]), cwd, { ...ENV, GITHUB_OUTPUT: output });
  assert.match(readFileSync(output, 'utf8'), /release_id=42\nis_draft=true\n$/);
});

test('main: the draft search reads every page of the release list, not only the first hundred', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const pageOne = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, draft: i % 2 === 0, tag_name: `v0.0.${i}`, body: '' }));
  const gh = fakeGitHub([
    NOT_FOUND,
    { status: 200, json: pageOne, expect: ['GET', '/releases?per_page=100&page=1'] },
    { status: 200, json: [{ id: 9, draft: true, tag_name: 'v9.9.9', body: 'Drafted by hand.' }], expect: ['GET', '/releases?per_page=100&page=2'] },
    { status: 200, json: { id: 9 }, expect: ['PATCH', '/releases/9'] },
  ]);
  const out = await run('v9.9.9', gh, cwd);
  assert.equal(out.id, 9);
  assert.equal(gh.calls.length, 4, 'page 2 was fetched because page 1 was full; page 3 was not, because page 2 was short');
});

test('main: two drafts for one tag is a question for a person, not a coin toss', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([NOT_FOUND, { ...NO_DRAFTS, json: [{ id: 9, draft: true, tag_name: 'v9.9.9', body: 'a' }, { id: 11, draft: true, tag_name: 'v9.9.9', body: 'b' }] }]);
  await assert.rejects(run('v9.9.9', gh, cwd), /2 draft releases carry tag v9\.9\.9/);
  assert.equal(gh.calls.length, 2, 'and nothing was written');
});

test('main: an answer that is neither 200 nor 404 fails instead of guessing — guessing could overwrite hand-written notes', async () => {
  for (const status of [500, 403, 401]) {
    const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
    const gh = fakeGitHub([{ status, json: { message: 'trouble' } }]);
    await assert.rejects(run('v9.9.9', gh, cwd), new RegExp(`HTTP ${status}`));
    assert.equal(gh.calls.length, 1);
  }
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  await assert.rejects(run('v9.9.9', fakeGitHub([NOT_FOUND, { status: 502, json: {} }]), cwd), /HTTP 502/);
  await assert.rejects(run('v9.9.9', fakeGitHub([NOT_FOUND, NO_DRAFTS, { status: 422, json: { message: 'Validation Failed' } }]), cwd), /^Error: POST \/releases returned HTTP 422: /, 'named as the create that failed, not as some other request');
  await assert.rejects(run('v9.9.9', fakeGitHub([published('Owner notes.'), { status: 500, json: {} }]), cwd), /PATCH \/releases\/7 returned HTTP 500/);
});

test('main: a 200 whose body is not a release — empty, not JSON, or the wrong shape — fails loudly, never reads as "no release"', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  await assert.rejects(run('v9.9.9', fakeGitHub([{ status: 200, raw: 'not json' }]), cwd), /HTTP 200 with a body that is not JSON: not json/);
  await assert.rejects(run('v9.9.9', fakeGitHub([{ status: 200, raw: '' }]), cwd), /200 without a release object/);
  await assert.rejects(run('v9.9.9', fakeGitHub([{ status: 200, json: { message: 'no id here' } }]), cwd), /200 without a release object/);
  await assert.rejects(run('v9.9.9', fakeGitHub([NOT_FOUND, { status: 200, json: { not: 'an array' } }]), cwd), /GET \/releases\?page=1 returned HTTP 200/);
  await assert.rejects(run('v9.9.9', fakeGitHub([NOT_FOUND, { status: 200, raw: '<html>proxy</html>' }]), cwd), /not JSON/);
  const gh = fakeGitHub([NOT_FOUND, NO_DRAFTS, { status: 201, json: {} }]);
  await assert.rejects(run('v9.9.9', gh, cwd), /201 without a release object/);
  assert.equal(gh.calls.length, 3, 'the create was attempted once and its answer was refused, not retried');
});

test('main: the tag must be the version the tagged package.json ships, or the release page and its files would disagree', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.8');
  const gh = fakeGitHub([]);
  await assert.rejects(run('v9.9.8', gh, cwd), /tag v9\.9\.8[^\n]*version 9\.9\.9/);
  assert.equal(gh.calls.length, 0, 'decided before any request');
  const broken = taggedRepo({ ...TAG_FILES, 'package.json': 'not json at all' }, 'v9.9.9');
  await assert.rejects(run('v9.9.9', fakeGitHub([]), broken), /package\.json at v9\.9\.9 is not readable JSON/);
});

test('main: a tag whose name needs URL encoding is encoded in the request', async () => {
  const cwd = taggedRepo({ ...TAG_FILES, 'package.json': JSON.stringify({ version: '9.9.9+ci.1' }) }, 'v9.9.9+ci.1');
  const gh = fakeGitHub([{ status: 200, json: { id: 3, draft: false, body: `x\n${NOTE_9}` }, expect: ['GET', '/releases/tags/v9.9.9%2Bci.1'] }]);
  await run('v9.9.9+ci.1', gh, cwd);
  assert.equal(gh.calls.length, 1);
});

test("main: reads the files at the TAG — an annotated tag, and a branch that shares the tag's name, change nothing", async () => {
  for (const opts of [{ annotated: true }, { shadowBranch: true }, { annotated: true, shadowBranch: true }]) {
    const cwd = taggedRepo(TAG_FILES, 'v9.9.9', opts);
    const gh = fakeGitHub([NOT_FOUND, NO_DRAFTS, { status: 201, json: { id: 42 } }]);
    const out = await run('v9.9.9', gh, cwd);
    assert.equal(out.created, true, JSON.stringify(opts));
    assert.equal(gh.calls[2].body!.body, WRITTEN_9, `${JSON.stringify(opts)}: the 9.9.9 files, not the 10.0.0 working tree`);
  }
});

test('main: a tag from before CHANGELOG.md existed can still have its installers re-attached — the CHANGELOG is only needed to write notes', async () => {
  const { 'CHANGELOG.md': _omit, ...files } = TAG_FILES;
  const cwd = taggedRepo(files, 'v9.9.9');
  const kept = fakeGitHub([published(`Old notes.\n${NOTE_9}`)]);
  assert.equal((await run('v9.9.9', kept, cwd)).action, 'keep');
  const appended = fakeGitHub([published('Old notes.'), { status: 200, json: { id: 7 } }]);
  assert.equal((await run('v9.9.9', appended, cwd)).action, 'append');
  const none = fakeGitHub([NOT_FOUND, NO_DRAFTS]);
  await assert.rejects(run('v9.9.9', none, cwd), /cannot read CHANGELOG\.md at v9\.9\.9/, 'with no notes anywhere, it says what is missing');
  assert.equal(none.calls.length, 2, 'and creates nothing');
});

test('main: a tag from before INSTALL-NOTE.md existed uses the checked-out copy, and says so', async () => {
  const { '.github/INSTALL-NOTE.md': _omit, ...files } = TAG_FILES;
  const cwd = taggedRepo(files, 'v9.9.9', { worktree: { '.github/INSTALL-NOTE.md': INSTALL_NOTE } });
  const lines: string[] = [];
  const gh = fakeGitHub([published('Old notes.'), { status: 200, json: { id: 7 } }]);
  const out = await run('v9.9.9', gh, cwd, ENV, (l) => lines.push(l));
  assert.equal(out.action, 'append');
  assert.equal(gh.calls[1].body!.body, `Old notes.\n\n${NOTE_9_BODY}`, 'the checked-out note, with this version filled in');
  assert.ok(lines.some((l) => /predates \.github\/INSTALL-NOTE\.md; using the checked-out copy/.test(l)), lines.join('\n'));

  const nowhere = taggedRepo(files, 'v9.9.9');
  const none = fakeGitHub([]);
  await assert.rejects(run('v9.9.9', none, nowhere), /cannot read \.github\/INSTALL-NOTE\.md at v9\.9\.9/);
  assert.equal(none.calls.length, 0, 'decided before asking GitHub');
});

test('main: without a token or a repository it stops before asking GitHub anything', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const gh = fakeGitHub([]);
  await assert.rejects(run('v9.9.9', gh, cwd, { ...ENV, GH_TOKEN: undefined }), /GH_TOKEN/);
  await assert.rejects(run('v9.9.9', gh, cwd, { ...ENV, GITHUB_REPOSITORY: undefined }), /GITHUB_REPOSITORY/);
  await assert.rejects(run('', gh, cwd), /usage/);
  const viaGithubToken = fakeGitHub([published(`x\n${NOTE_9}`, 1)]);
  await run('v9.9.9', viaGithubToken, cwd, { ...ENV, GH_TOKEN: undefined, GITHUB_TOKEN: 'other' });
  assert.equal(viaGithubToken.calls[0].auth, 'Bearer other', 'GITHUB_TOKEN is the fallback name');
});

// ---------------------------------------------------------------------------
// The command line the notes job actually runs.

const CLI = path.join(root, 'scripts', 'release-notes.js');

test('cli: a failure exits 1 with one ::error:: line — that exit code is what stops the builds', () => {
  const noTag = spawnSync(process.execPath, [CLI], { env: { ...process.env, ...ENV }, encoding: 'utf8' });
  assert.equal(noTag.status, 1);
  assert.match(noTag.stderr, /^::error::usage: node scripts\/release-notes\.js <tag>$/m);
  const noRepo = spawnSync(process.execPath, [CLI, 'v9.9.9'], { env: { ...process.env, GH_TOKEN: 't', GITHUB_REPOSITORY: '' }, encoding: 'utf8' });
  assert.equal(noRepo.status, 1);
  assert.match(noRepo.stderr, /^::error::GITHUB_REPOSITORY is not set$/m);
  assert.equal(noRepo.stderr.trim().split('\n').length, 1, 'one annotation line, nothing a stray value could turn into a second one');
});

test('cli: end to end against a local GitHub stand-in — real fetch, real git, the release already carrying the note', async () => {
  const cwd = taggedRepo(TAG_FILES, 'v9.9.9');
  const output = path.join(tmp('treemap-output-'), 'github-output');
  writeFileSync(output, '');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/repos/Owner/Repo/releases/tags/v9.9.9') res.end(JSON.stringify({ id: 1, draft: false, tag_name: 'v9.9.9', body: `x\n${NOTE_9}` }));
    else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    // Spawned asynchronously: the stand-in server lives in this process, and a
    // synchronous spawn would block the loop it needs to answer the request.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'v9.9.9'], { cwd, env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: 'Owner/Repo', GH_TOKEN: 'stub-token', GITHUB_OUTPUT: output } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^::notice::release v9\.9\.9: notes already carry the install note; left as they are$/m);
    assert.deepEqual(seen, ['GET /repos/Owner/Repo/releases/tags/v9.9.9 Bearer stub-token']);
    assert.equal(readFileSync(output, 'utf8'), 'release_id=1\nis_draft=false\n', 'the outputs the build and publish jobs read');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// The inline bash steps, executed under /bin/bash with stand-ins on PATH.

/**
 * Stand-in for curl: answers with STUB_STATUS and the file STUB_BODY_FILE,
 * and logs what the step asked for so the test can see it.
 */
const STUB_CURL = `#!/bin/bash
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--max-time) shift 2 ;;
    -X) echo "method: $2" >> "$STUB_LOG"; shift 2 ;;
    -d) echo "data: $2" >> "$STUB_LOG"; shift 2 ;;
    -H) echo "header: $2" >> "$STUB_LOG"; shift 2 ;;
    -*) shift ;;
    *) echo "url: $1" >> "$STUB_LOG"; shift ;;
  esac
done
cp "$STUB_BODY_FILE" "$out"
printf '%s' "$STUB_STATUS"
`;

/** Stand-in for npm: records its arguments and does nothing else. */
const STUB_NPM = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
`;

interface Sandbox { dir: string; repo: string; log: string; env: NodeJS.ProcessEnv }

function sandbox(opts: { status?: string; response?: unknown; built?: string[]; files?: string[]; noteFile?: boolean; packageJson?: string }): Sandbox {
  const dir = tmp('treemap-step-');
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'release'), { recursive: true });
  for (const f of opts.built ?? []) writeFileSync(path.join(repo, 'release', f), `fake ${f}`);
  if (opts.noteFile !== false) {
    mkdirSync(path.join(repo, '.github'));
    writeFileSync(path.join(repo, '.github', 'INSTALL-NOTE.md'), INSTALL_NOTE);
  }
  if (opts.packageJson) writeFileSync(path.join(repo, 'package.json'), opts.packageJson);
  const temp = path.join(dir, 'runner-temp');
  mkdirSync(temp);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['curl', STUB_CURL], ['npm', STUB_NPM]] as const) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const response = path.join(dir, 'response.json');
  writeFileSync(response, JSON.stringify(opts.response ?? {}));
  const log = path.join(dir, 'stub.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    RUNNER_TEMP: temp,
    GITHUB_API_URL: 'https://api.example.test',
    GITHUB_REPOSITORY: 'Owner/Repo',
    RELEASE_TAG: 'v9.9.9',
    RELEASE_ID: '77',
    GH_TOKEN: 'stub-token',
    FILES: (opts.files ?? []).join('\n') + '\n',
    STUB_STATUS: opts.status ?? '200',
    STUB_BODY_FILE: response,
    STUB_LOG: log,
  };
  return { dir, repo, log, env };
}

function runStep(name: string, sb: Sandbox, extraEnv: NodeJS.ProcessEnv = {}) {
  const file = path.join(sb.dir, 'step.sh');
  writeFileSync(file, script(step(name)));
  const r = spawnSync('/bin/bash', [file], { cwd: sb.repo, env: { ...sb.env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', log: existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : '' };
}

const skipOnWindows = isWin && 'the steps are bash; macOS and Linux CI run them here, and the Windows release job runs them for real';
const MAC_BUILT = ['TreeMap-9.9.9-arm64.dmg', 'TreeMap-9.9.9-arm64.dmg.blockmap', 'TreeMap-9.9.9-arm64-mac.zip', 'TreeMap-9.9.9-arm64-mac.zip.blockmap', 'latest-mac.yml'];
const WIN_BUILT = ['TreeMap-Setup-9.9.9.exe', 'TreeMap-Setup-9.9.9.exe.blockmap', 'TreeMap-9.9.9.exe', 'latest.yml'];
const ASSET_COUNT = MAC_BUILT.length + WIN_BUILT.length;
const sizeOf = (name: string) => Buffer.byteLength(`fake ${name}`);
interface AssetShape { size?: number; state?: string }
const release = (names: string[], body: string | null = `Notes.\n${NOTE_9}`, shapes: Record<string, AssetShape> = {}) =>
  ({ id: 77, body, assets: names.map((name, id) => ({ id, name, size: shapes[name]?.size ?? sizeOf(name), state: shapes[name]?.state ?? 'uploaded' })) });

test('build: electron-builder gets --publish never once — appended for a tag whose scripts lack it, not for one whose scripts carry it', { skip: skipOnWindows }, () => {
  const old = sandbox({ packageJson: JSON.stringify({ scripts: { 'dist:mac': 'npm run build && electron-builder --mac' } }) });
  const r1 = runStep('Build the installer', old, { SCRIPT: 'dist:mac' });
  assert.equal(r1.status, 0, r1.out);
  assert.equal(r1.log, 'run dist:mac -- --publish never\n', 'the old script gets the flag appended');
  const current = sandbox({ packageJson: read('package.json') });
  const r2 = runStep('Build the installer', current, { SCRIPT: 'dist:win' });
  assert.equal(r2.status, 0, r2.out);
  assert.equal(r2.log, 'run dist:win\n', "today's script already carries it, so nothing is appended");
  for (const [scriptName, args] of [['npm run build && electron-builder --mac', 'run dist:mac -- --publish never'], [PKG.scripts['dist:win'], 'run dist:win']] as const) {
    const composed = `${scriptName} ${args.replace(/^run \S+( -- )?/, '')}`;
    assert.equal((composed.match(/--publish never/g) ?? []).length, 1, `what electron-builder finally sees, for: ${scriptName}`);
  }
  const missing = sandbox({ packageJson: JSON.stringify({ scripts: {} }) });
  const r3 = runStep('Build the installer', missing, { SCRIPT: 'dist:mac' });
  assert.equal(r3.log, 'run dist:mac -- --publish never\n', 'a script that does not exist at all still gets the flag (npm then fails on its own)');
});

test('check: every finished file the job built is attached, byte for byte → passes and names each one', { skip: skipOnWindows }, () => {
  for (const [runner, built] of [['macos-latest', MAC_BUILT], ['windows-latest', WIN_BUILT]] as const) {
    const r = runStep('Check the Release now holds', sandbox({ response: release([...built, 'unrelated-extra.txt']), built: [...built], files: matrixFiles(runner) }));
    assert.equal(r.status, 0, `${runner}: ${r.out}`);
    for (const name of built) assert.match(r.stdout, new RegExp(`^attached: ${name.replace(/\./g, '\\.')} \\(${sizeOf(name)} bytes\\)$`, 'm'), `${runner} reports ${name}`);
    assert.equal((r.stdout.match(/^attached: /gm) ?? []).length, built.length, `${runner}: one line per file, no more`);
    assert.match(r.log, /url: https:\/\/api\.example\.test\/repos\/Owner\/Repo\/releases\/77\n/, "it asked for the release by id — a draft has no public tag page");
    assert.match(r.log, /header: Authorization: Bearer stub-token\n/, 'authenticated');
  }
});

test('check: a built file missing from the release fails and names it', { skip: skipOnWindows }, () => {
  // latest-mac.yml has no look-alike on the release; the dmg has its own
  // .blockmap there, so only an exact name match may count it as attached.
  for (const gone of ['latest-mac.yml', 'TreeMap-9.9.9-arm64.dmg']) {
    const r = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT.filter((n) => n !== gone)), built: MAC_BUILT, files: matrixFiles('macos-latest') }));
    assert.notEqual(r.status, 0, `${gone} is missing, so the job must go red`);
    assert.match(r.out, new RegExp(`${gone.replace(/\./g, '\\.')} was built but is not attached to release v9\\.9\\.9`));
    assert.equal((r.stdout.match(/^attached: /gm) ?? []).length, MAC_BUILT.length - 1, 'the others are still listed as attached');
  }
});

test('check: a wrong-sized or half-uploaded file is not a success', { skip: skipOnWindows }, () => {
  const wrongSize = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT, `Notes.\n${NOTE_9}`, { 'TreeMap-9.9.9-arm64.dmg': { size: sizeOf('TreeMap-9.9.9-arm64.dmg') * 10 } }), built: MAC_BUILT, files: matrixFiles('macos-latest') }));
  assert.notEqual(wrongSize.status, 0);
  assert.match(wrongSize.out, /TreeMap-9\.9\.9-arm64\.dmg is attached to release v9\.9\.9 but its size differs from the \d+ bytes built here; delete it on the release page and run the workflow again/);
  const halfUploaded = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT, `Notes.\n${NOTE_9}`, { 'latest-mac.yml': { state: 'open' } }), built: MAC_BUILT, files: matrixFiles('macos-latest') }));
  assert.notEqual(halfUploaded.status, 0);
  assert.match(halfUploaded.out, /latest-mac\.yml was built but is not attached/, 'an upload GitHub still lists as "open" does not count');
});

test('check: a pattern that matches no built file fails — the build produced less than the release needs', { skip: skipOnWindows }, () => {
  const built = MAC_BUILT.filter((n) => !n.endsWith('-mac.zip'));
  const r = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT), built, files: matrixFiles('macos-latest') }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /nothing here matches release\/\*\.zip\b/, 'names the empty pattern (the .zip.blockmap does not satisfy *.zip)');
});

test('check: a release that cannot be read fails and says which status it got', { skip: skipOnWindows }, () => {
  for (const status of ['404', '500']) {
    const r = runStep('Check the Release now holds', sandbox({ status, response: { message: 'nope' }, built: MAC_BUILT, files: matrixFiles('macos-latest') }));
    assert.notEqual(r.status, 0, `HTTP ${status}`);
    assert.match(r.out, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(r.stdout, /^attached: /m, 'no file is claimed attached when the release could not be read');
  }
});

test('check: the notes must still carry the install note after uploading; a tag from before the note existed skips that check', { skip: skipOnWindows }, () => {
  const lost = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT, 'Notes without the note.'), built: MAC_BUILT, files: matrixFiles('macos-latest') }));
  assert.notEqual(lost.status, 0);
  assert.match(lost.out, /no longer carry the install note heading: ## 📥 Installing/);
  const oldTag = runStep('Check the Release now holds', sandbox({ response: release(MAC_BUILT, 'Notes without the note.'), built: MAC_BUILT, files: matrixFiles('macos-latest'), noteFile: false }));
  assert.equal(oldTag.status, 0, oldTag.out);
});

test('publish: one PATCH that makes the release public and lets GitHub choose Latest by version, and a failure says why', { skip: skipOnWindows }, () => {
  const ok = runStep('Publish the Release', sandbox({ response: { id: 77, draft: false } }));
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.log, /method: PATCH\n/);
  assert.match(ok.log, /data: \{"draft":false,"make_latest":"legacy"\}\n/, 'legacy: an old tag rebuilt never becomes the download everyone is offered');
  assert.match(ok.log, /url: https:\/\/api\.example\.test\/repos\/Owner\/Repo\/releases\/77\n/);
  assert.match(ok.stdout, /release v9\.9\.9 is published with every installer attached/);
  const bad = runStep('Publish the Release', sandbox({ status: '404', response: { message: 'Not Found' } }));
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /PATCH releases\/77 \(v9\.9\.9\) returned HTTP 404/);
});

// ---------------------------------------------------------------------------
// The words around it.

test('README tells the owner how to repair a release and never to delete one that has installers', () => {
  const publish = section(README, 'Publish a new version', '</details>');
  assert.match(publish, /\*\*Edit a release, never delete it\.\*\*/, 'the rule, in bold');
  assert.match(publish, /attached to the release itself, not to the tag/, 'and why');
  assert.match(publish, /Run workflow\*\*, leave \*Use workflow from\* at `main`, type the tag/, 'the repair path, click by click');
  assert.match(publish, /\*\*A saved draft does not ship by itself\.\*\*/, 'a draft creates no tag; once the tag exists the workflow finishes the draft');
  assert.match(publish, /finds the draft, adds the install instructions, attaches the installers and publishes it once they are all there/);
  assert.match(publish, /only then publishes the release/, 'a release the workflow creates is never public with an empty Assets list');
  assert.match(publish, /stays a \*\*Draft\*\* only you can see/, 'what a red build leaves behind');
  assert.match(publish, /CHANGELOG\.md/, 'the notes come from the CHANGELOG when the workflow creates the release');
  assert.match(publish, /Create Tag/, 'how to make the tag in GitHub Desktop');
  assert.match(publish, /\*\*notes\*\* job says what to fix/, 'what to do with a red run');
  assert.match(publish, /added under them only if they are missing/, 'the repair keeps the notes, with the one qualifier');
  assert.equal((README.match(/Edit a release, never delete it/g) ?? []).length, 1, 'said once, where releases are cut');
});

test("HANDOFF's release recipe counts the assets the workflow lists and carries the repair path", () => {
  const recipe = section(HANDOFF, '## The release recipe', '## CI: how it stays green');
  assert.match(recipe, new RegExp(`all ${ASSET_COUNT} assets`), 'the count follows the two file lists');
  assert.doesNotMatch(recipe, /all 8 assets/);
  assert.match(recipe, /Never delete a release that has installers/);
  assert.match(recipe, /Run workflow/, 'the repair path is in the recipe');
  assert.doesNotMatch(recipe, /TreeMap\.Setup\./, 'the dotted asset name is history; the check step needs the hyphenated one to match');
});

test('CHANGELOG records the fix under the version that ships it', () => {
  const at = CHANGELOG.indexOf(`## [${PKG.version}]`);
  assert.notEqual(at, -1, `the ${PKG.version} entry exists`);
  const top = CHANGELOG.slice(at, CHANGELOG.indexOf('\n## [', at + 1));
  assert.match(top, /### Fixed/);
  assert.match(top, /lose its installers/, 'names the failure');
  assert.match(top, /Run workflow/, 'names the remedy');
  assert.match(top, /issues\/32/, 'links the report');
  assert.match(top, /name and size/, 'says what the check compares');
  assert.match(top, /published only after both installers are attached and checked/, 'the release exists as a draft until then');
  assert.doesNotMatch(top, /instead of publishing an empty release/, 'the old overclaim');
});
