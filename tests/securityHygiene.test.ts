import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-securityHygiene-data-');

import {
  SECURITY_PATTERNS,
  collectSecurityFindings,
  relocateSecret,
  relocationTargetFor,
} from '../src/services/securityHygieneScanner';
import { compileIgnoreList } from '../src/utils/glob';
import { FileNode } from '../src/models/types';
import { startScan } from '../src/services/diskScanner';
import { waitFor } from './fixtures/waitFor';

/**
 * Scans `dir`, as a relocation always follows a scan of the folder: `relocateSecret` checks
 * both of its ends itself and moves nothing outside every scanned folder (T17a's security
 * review), so these tests scan their temp folder the way the Security view's scan does.
 */
async function scanned(dir: string): Promise<void> {
  const scan = await startScan(dir);
  await waitFor(() => scan.status !== 'running', `the scan of ${dir}`);
  assert.equal(scan.status, 'complete', scan.error);
}

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
    await scanned(dir);

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
    await scanned(dir);

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
    await scanned(dir);
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

test('a file an installed program owns is listed, but never called serious and never offered a move', () => {
  // The real case this came from: Google Drive ships its own CA bundle at
  // Library/Application Support/Google/DriveFS/Resources/roots.pem. It matches
  // the PEM rule exactly, but it is part of the software — calling it SERIOUS is
  // wrong, and "Move to .ssh" would break Google Drive, because the relocate is
  // a rename of the app's own resource.
  const owned = findingsFor([
    file('roots.pem', path.join(HOME, 'Library', 'Application Support', 'Google', 'DriveFS', 'Resources')),
  ])[0];
  assert.ok(owned, 'still listed — hiding a key-shaped file is the one thing this panel must not do');
  assert.equal(owned.appOwned, true);
  assert.equal(owned.severity, 'low', 'not serious: it is where its program put it');
  assert.equal(owned.suggestedPath, undefined, 'and nothing is proposed');
  assert.equal(relocationTargetFor(owned), null, 'so there is no destination to move to');
  assert.match(owned.reason, /installed program/);

  // Every shape of app ownership, and the control: the same file loose in
  // Downloads is still a serious finding with a home to go to.
  for (const dir of [
    path.join(HOME, 'Library', 'Containers', 'com.example.app', 'Data'),
    path.join(HOME, 'projects', 'app', 'node_modules', 'some-pkg', 'test', 'fixtures'),
    path.join(HOME, 'Applications', 'Thing.app', 'Contents', 'Resources'),
    path.join(HOME, 'Library', 'Application Support', 'Vendor'),
  ]) {
    const f = findingsFor([file('id_rsa', dir)])[0];
    assert.ok(f, `${dir} is still listed`);
    assert.equal(f.appOwned, true, `${dir} counts as program-owned`);
    assert.equal(f.suggestedPath, undefined, `${dir} is never offered a move`);
  }

  const loose = findingsFor([file('id_rsa', path.join(HOME, 'Downloads'))])[0];
  assert.equal(loose.appOwned, false);
  assert.equal(loose.severity, 'high', 'the ordinary case is unchanged');
  assert.equal(loose.suggestedPath, path.join(HOME, '.ssh'));
});

/* ─────────────── QA D77 / D42: false alarms, and the cap ─────────────── */

test('a small .key file is listed as ambiguous: never serious, never moved into ~/.ssh (D77)', () => {
  // On a Mac ".key" is the Keynote document extension. TreeMap never opens a file, so the
  // name alone cannot tell a TLS key from a presentation. It is listed, as minor, and no
  // move is offered: "Move to .ssh" on a presentation is the harm QA found.
  for (const [name, dir] of [
    ['Quarterly review.key', path.join(HOME, 'Documents')],
    ['server.key', path.join(HOME, 'Downloads')],
  ] as const) {
    const f = findingsFor([file(name, dir, 1700)])[0];
    assert.ok(f, `${name} is still listed: it may be a real key`);
    assert.equal(f.severity, 'low', `${name} is not called serious`);
    assert.equal(f.suggestedPath, undefined, `${name} is never offered a move`);
    assert.equal(relocationTargetFor(f), null);
    assert.match(f.why, /Keynote/, 'and the ambiguity is stated');
  }
  // A synced folder raises a medium finding to high. A minor one stays minor, so a deck in
  // Dropbox does not become serious.
  assert.equal(findingsFor([file('Deck.key', path.join(HOME, 'Dropbox'), 1700)])[0].severity, 'low',
    'a minor finding in a synced folder stays minor');
});

test('a .key file too large to be any private key is not a finding (D77)', () => {
  // A PEM private key is a few KB (RSA-8192 is about 6.5 KB). A Keynote document is far larger.
  assert.deepEqual(findingsFor([file('Pitch.key', path.join(HOME, 'Documents'), 400_000)]), [], 'a 400 KB .key is not a key');
  assert.equal(findingsFor([file('big.pem', path.join(HOME, 'Documents'), 400_000)]).length, 1,
    'the size rule is the .key rule alone');
});

test('only a file very likely to be an SSH key is offered a move into ~/.ssh (D77)', () => {
  const at = path.join(HOME, 'Downloads');
  assert.equal(findingsFor([file('id_ed25519', at)])[0].suggestedPath, path.join(HOME, '.ssh'));
  assert.equal(findingsFor([file('work.ppk', at)])[0].suggestedPath, path.join(HOME, '.ssh'), 'a PuTTY key is an SSH key');
  const pem = findingsFor([file('server.pem', at)])[0];
  assert.equal(pem.severity, 'high', 'a loose .pem is still serious');
  assert.equal(pem.suggestedPath, undefined, 'but a certificate or a TLS key is not an SSH key');
  for (const p of SECURITY_PATTERNS.filter((x) => x.suggestedHome === '.ssh')) {
    assert.match(p.label, /SSH|PuTTY/, `${p.id} proposes ~/.ssh, so it must be an SSH key pattern`);
  }
});

test('the 500 cap keeps the most serious findings, and the counts describe every finding (D77)', () => {
  // QA's corpus: 951 ".key" documents walked before Misc/keys-in-wrong-place, so the cap
  // (applied in walk order) dropped the real keys, and the counts described the slice.
  const docs = Array.from({ length: 600 }, (_, i) => file(`Deck-${i}.key`, path.join(HOME, 'Documents', `d${i % 7}`), 1200));
  const wrong = path.join(HOME, 'Misc', 'keys-in-wrong-place');
  const real = ['id_rsa', 'id_ed25519', 'server.pem', 'wallet.dat'].map((n) => file(n, wrong, 40));
  const report = collectSecurityFindings(treeWith(HOME, [...docs, ...real]), [], HOME);
  assert.equal(report.truncated, true, 'more than 500 findings: the report says the list is partial');
  assert.equal(report.findings.length, 500, 'the list is still capped');
  for (const n of ['id_rsa', 'id_ed25519', 'server.pem', 'wallet.dat']) {
    assert.ok(report.findings.some((f) => f.name === n), `${n} survives the cap`);
  }
  assert.deepEqual(report.findings.slice(0, 4).map((f) => f.severity), ['high', 'high', 'high', 'high'], 'most serious first');
  assert.deepEqual(report.counts, { high: 4, medium: 0, low: 600 }, 'counted over every finding, not the slice');
  assert.equal(report.total, 604, 'and the total says how many there are');
});

test('certificates inside frameworks and bundles belong to the software (D42)', () => {
  // QA's stock Mac: Apple ships public root CA .pem files inside Ruby.framework.
  const ruby = path.resolve('/System/Library/Frameworks/Ruby.framework/Versions/2.6/usr/lib/ruby/2.6.0/bundler/ssl_certs/rubygems.org');
  const report = collectSecurityFindings(
    treeWith(path.resolve('/System/Library'), [file('DigiCertHighAssuranceEVRootCA.pem', ruby)]), [], HOME,
  );
  assert.ok(report.findings[0], 'still listed');
  assert.equal(report.findings[0].appOwned, true, 'a file inside Ruby.framework belongs to the software');
  assert.equal(report.findings[0].severity, 'low', 'a CA certificate Apple ships is not serious');
  assert.equal(report.counts.high, 0, 'nothing serious on a stock Mac');
  for (const bundle of ['Foo.framework', 'Helper.bundle', 'Share.appex', 'Agent.xpc', 'Codec.plugin', 'Driver.kext']) {
    const f = findingsFor([file('id_rsa', path.join(HOME, 'Library', 'Stuff', bundle, 'Contents', 'Resources'))])[0];
    assert.equal(f.appOwned, true, `${bundle} is a program's own bundle`);
    assert.equal(f.suggestedPath, undefined, `${bundle} is never offered a move`);
  }
  // Bundler's per-project ".bundle" settings folder is not a program bundle.
  assert.equal(findingsFor([file('id_rsa', path.join(HOME, 'code', 'app', '.bundle'))])[0].appOwned, false,
    'Bundler\u2019s .bundle settings folder is not a program bundle');
});

test('files in the operating system’s own folders belong to it (D42)', { skip: process.platform === 'win32' }, () => {
  for (const dir of ['/System/Library/Security', '/usr/share/ca-certificates/mozilla', '/etc/ssl/certs', '/private/etc/ssl']) {
    const f = collectSecurityFindings(treeWith('/', [file('ca.pem', dir)]), [], HOME).findings[0];
    assert.ok(f, `${dir}: still listed`);
    assert.equal(f.appOwned, true, `${dir} is the operating system's`);
    assert.equal(f.severity, 'low', `${dir} is not serious`);
    assert.match(f.reason, /operating system/, `${dir}: the reason names who owns it`);
  }
  // /usr/local is where a person installs things, not the operating system.
  const local = collectSecurityFindings(treeWith('/', [file('server.pem', '/usr/local/etc/nginx')]), [], HOME).findings[0];
  assert.equal(local.appOwned, false, '/usr/local is not the operating system\u2019s');
});

test('the Security panel headline counts every finding, not the 500 shown (D77)', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = index.slice(index.indexOf('function renderSecurity'), index.indexOf('function confirmRelocateSecret'));
  assert.ok(fn.length > 0, 'renderSecurity must be findable');
  assert.match(fn, /report\.total/, 'the headline reads the total the server counted');
  assert.doesNotMatch(fn, /first 500 shown/, 'and the shown slice is stated from the list itself');
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
