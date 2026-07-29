import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SECURITY_PATTERNS,
  collectSecurityFindings,
  relocateSecret,
  relocationTargetFor,
} from '../src/services/securityHygieneScanner';
import { compileIgnoreList } from '../src/utils/glob';
import { FileNode } from '../src/models/types';

/**
 * §C5 — secrets hygiene.
 *
 * Acceptance, verbatim: "Fixtures matching each pattern are flagged outside
 * expected directories and not flagged inside them." Both halves are checked
 * here for EVERY shipped pattern, generated from the catalog itself — so a
 * pattern added later without an expected-location rule fails immediately.
 */

const HOME = path.resolve('/home/tester');

function file(name: string, at: string, size = 2048): FileNode {
  return {
    name, path: path.join(at, name), size, type: 'file', modifiedAt: 1_700_000_000_000,
    isHidden: name.startsWith('.'), extension: (name.split('.').pop() || '').toLowerCase(),
  };
}

/** Build a tree whose root is `root`, holding files at absolute paths. */
function treeWith(root: string, files: FileNode[]): FileNode {
  const dirs = new Map<string, FileNode>();
  const ensure = (p: string): FileNode => {
    if (p === root) return rootNode;
    const existing = dirs.get(p);
    if (existing) return existing;
    const node: FileNode = {
      name: path.basename(p), path: p, type: 'dir', modifiedAt: 0, isHidden: path.basename(p).startsWith('.'),
      size: 0, children: [],
    };
    dirs.set(p, node);
    ensure(path.dirname(p)).children!.push(node);
    return node;
  };
  const rootNode: FileNode = {
    name: path.basename(root) || root, path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: 0, children: [],
  };
  for (const f of files) ensure(path.dirname(f.path)).children!.push(f);
  const size = (n: FileNode): number => {
    if (n.type === 'file') return n.size;
    n.size = (n.children || []).reduce((s, c) => s + size(c), 0);
    return n.size;
  };
  size(rootNode);
  return rootNode;
}

function findingsFor(files: FileNode[], root = HOME, ignore: string[] = []) {
  return collectSecurityFindings(treeWith(root, files), compileIgnoreList(ignore), HOME).findings;
}

/** One representative filename per shipped pattern, taken from the catalog. */
function sampleName(p: (typeof SECURITY_PATTERNS)[number]): string {
  if (p.names?.length) return p.names[0];
  if (p.extensions?.length) return `sample.${p.extensions[0]}`;
  throw new Error(`pattern ${p.id} has nothing to match on`);
}

/* ─────────────── The acceptance criterion, over the whole catalog ─────────────── */

test('every shipped pattern is flagged when it sits somewhere it does not belong', () => {
  for (const pattern of SECURITY_PATTERNS) {
    const name = sampleName(pattern);
    const found = findingsFor([file(name, path.join(HOME, 'Downloads'))]);
    const hit = found.find((f) => f.patternId === pattern.id);
    assert.ok(hit, `${pattern.id} (${name}) in Downloads must be flagged`);
    assert.equal(hit.name, name);
    assert.ok(hit.why.length > 10, 'and must explain why it matters');
    assert.ok(hit.reason.includes('Downloads'), 'and name the folder it is in');
  }
});

test('every pattern with an expected location is silent inside it', () => {
  for (const pattern of SECURITY_PATTERNS) {
    const name = sampleName(pattern);
    const where = pattern.expectedIn.length ? path.join(HOME, ...pattern.expectedIn[0].split('/')) : HOME;
    const found = findingsFor([file(name, where)]);
    assert.equal(
      found.find((f) => f.patternId === pattern.id),
      undefined,
      `${pattern.id} (${name}) in ${where} is where it belongs and must NOT be flagged`,
    );
  }
});

test('a nested expected location still counts', () => {
  // ~/.aws/sso/cache/credentials is inside .aws, however deep.
  assert.equal(findingsFor([file('credentials', path.join(HOME, '.aws', 'sso', 'cache'))]).length, 0);
  // And a multi-segment expected path is matched as a run, not as loose parts.
  assert.equal(findingsFor([file('gcloud-credentials.json', path.join(HOME, '.config', 'gcloud'))]).length, 0);
  assert.equal(findingsFor([file('gcloud-credentials.json', path.join(HOME, 'gcloud', '.config'))]).length, 1);
});

/* ─────────────── Severity, exposure and honesty ─────────────── */

test('a secret in a cloud-synced folder is treated as worse, and says why', () => {
  const inDropbox = findingsFor([file('.env', path.join(HOME, 'Dropbox', 'work'))])[0];
  assert.ok(inDropbox);
  assert.equal(inDropbox.severity, 'high', 'a .env is medium normally, high once it leaves the machine');
  assert.equal(inDropbox.exposed, true);
  assert.match(inDropbox.reason, /syncs to the cloud/);

  const inProject = findingsFor([file('.env', path.join(HOME, 'code', 'api'))])[0];
  assert.equal(inProject.severity, 'medium');
  assert.equal(inProject.exposed, false);
});

test('a public key is never a finding', () => {
  // Flagging id_rsa.pub teaches people to ignore the whole panel.
  assert.deepEqual(findingsFor([file('id_rsa.pub', path.join(HOME, 'Downloads'))]), []);
});

test('the scanner never reads a file, only its name and place', () => {
  // A path that does not exist on disk must still produce a finding: nothing
  // here opens anything.
  const found = findingsFor([file('id_ed25519', path.join(HOME, 'Desktop'))]);
  assert.equal(found.length, 1);
  assert.equal(fs.existsSync(path.join(HOME, 'Desktop', 'id_ed25519')), false);
  // And no field carries content.
  assert.equal(Object.keys(found[0]).some((k) => /content|preview|body|bytes$/i.test(k)), false);
});

test('findings are ordered most serious first, and counted', () => {
  const report = collectSecurityFindings(
    treeWith(HOME, [
      file('.env', path.join(HOME, 'code')),
      file('id_rsa', path.join(HOME, 'Downloads')),
      file('.git-credentials', path.join(HOME, 'code')),
    ]),
    [],
    HOME,
  );
  assert.equal(report.findings[0].severity, 'high');
  assert.equal(report.counts.high, 1);
  assert.equal(report.counts.medium, 2);
  assert.equal(report.truncated, false);
});

test('ignored paths are never inspected', () => {
  assert.deepEqual(findingsFor([file('id_rsa', path.join(HOME, 'Downloads'))], HOME, ['**/Downloads/**']), []);
});

test('a clean tree produces nothing', () => {
  assert.deepEqual(findingsFor([file('notes.txt', path.join(HOME, 'Documents'))]), []);
});

/* ─────────────── Moving one somewhere safer ─────────────── */

test('the suggested destination is inside the pattern home, keeping the file name', () => {
  const found = findingsFor([file('id_rsa', path.join(HOME, 'Downloads'))])[0];
  assert.equal(found.suggestedPath, path.join(HOME, '.ssh'));
  assert.equal(relocationTargetFor(found), path.join(HOME, '.ssh', 'id_rsa'));
});

test('relocating moves the file, keeps its bytes and timestamp, and tightens its mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-'));
  try {
    const from = path.join(dir, 'Downloads', 'id_rsa');
    const to = path.join(dir, '.ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, 'PRIVATE KEY MATERIAL');
    const before = fs.statSync(from);

    const result = await relocateSecret(from, to);
    assert.deepEqual(result, { moved: true, from, to });
    assert.equal(fs.existsSync(from), false, 'the original is gone from the exposed folder');
    assert.equal(fs.readFileSync(to, 'utf8'), 'PRIVATE KEY MATERIAL', 'byte-for-byte');
    assert.equal(Math.round(fs.statSync(to).mtimeMs), Math.round(before.mtimeMs), 'timestamps survive');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(to).mode & 0o777, 0o600, 'only the owner can read it now');
      assert.equal(fs.statSync(path.dirname(to)).mode & 0o777, 0o700, 'and the directory is not listable by others');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an occupied destination aborts, and the original is left untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-'));
  try {
    const from = path.join(dir, 'Downloads', 'id_rsa');
    const to = path.join(dir, '.ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(from, 'NEW KEY');
    fs.writeFileSync(to, 'THE KEY I ACTUALLY USE');

    await assert.rejects(relocateSecret(from, to), /already exists/);
    // The key that was already there is the one that matters here.
    assert.equal(fs.readFileSync(to, 'utf8'), 'THE KEY I ACTUALLY USE', 'never overwritten');
    assert.equal(fs.readFileSync(from, 'utf8'), 'NEW KEY', 'and the source is still there');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory is never treated as a secret to move', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-'));
  try {
    const from = path.join(dir, '.ssh');
    fs.mkdirSync(from, { recursive: true });
    await assert.rejects(relocateSecret(from, path.join(dir, 'moved')), /Only a file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a home destination is only suggested for a file that is already under home', () => {
  // ~/.ssh is the right home for an SSH key found in ~/Downloads. It is NOT an
  // obviously right place for one found on an external drive, and the rename
  // would fail across filesystems anyway — so no suggestion is made.
  const inHome = findingsFor([file('id_rsa', path.join(HOME, 'Downloads'))])[0];
  assert.equal(inHome.suggestedPath, path.join(HOME, '.ssh'));

  const elsewhere = collectSecurityFindings(
    treeWith(path.resolve('/Volumes/Backup'), [file('id_rsa', path.resolve('/Volumes/Backup/keys'))]),
    [],
    HOME,
  ).findings[0];
  assert.ok(elsewhere, 'it is still flagged');
  assert.equal(elsewhere.suggestedPath, undefined, 'but nowhere is proposed for it');
  assert.equal(relocationTargetFor(elsewhere), null);
});

test('the move can only ever be a rename — it never removes anything', () => {
  // Monkey-patching fs to force EXDEV does not survive the module boundary, and
  // a second real filesystem is not something a test can conjure. The invariant
  // that actually matters is structural, and it cannot rot: this service must
  // contain no removal call at all, and must refuse the cross-device case out
  // loud. A copy-then-delete fallback would make this the only place outside
  // cleaner.ts able to destroy a user's file.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'securityHygieneScanner.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const forbidden of ['unlink', 'rm(', 'rmSync', 'rimraf', 'copyFile']) {
    assert.ok(!src.includes(forbidden), `securityHygieneScanner must not call ${forbidden}`);
  }
  assert.match(src, /rename\(from, to\)/, 'the move is a rename');
  assert.match(src, /EXDEV/, 'and the cross-device case is handled explicitly');
  assert.match(src, /different disk/, 'with a refusal a person can act on');
});
