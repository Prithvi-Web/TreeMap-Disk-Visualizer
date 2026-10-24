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
  linkedFileSize,
  relocateSecret,
  relocationTargetFor,
} from '../src/services/securityHygieneScanner';
import { compileIgnoreList } from '../src/utils/glob';
import { FileNode } from '../src/models/types';
import { storeOf } from '../src/services/scanStore';
import { startScan, peekScan } from '../src/services/diskScanner';
import { waitFor } from './fixtures/waitFor';
import http from 'node:http';
import { fileTempDir } from './fixtures/dataDir';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { appDataDir } from '../src/services/storage';

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

test('a folder whose name starts with ".." is inside home, and a sibling of home is not (shared isInside)', () => {
  // A bare `startsWith('..')` read "~/..data" as outside home (F6 fixed that test
  // everywhere else; this scanner kept its own copy).
  const dotted = findingsFor([file('id_rsa', path.join(HOME, '..data'))])[0];
  assert.ok(dotted, 'still flagged');
  assert.equal(dotted.suggestedPath, path.join(HOME, '.ssh'), 'a key in ~/..data is under home, so ~/.ssh is offered');

  const sibling = collectSecurityFindings(
    treeWith(path.dirname(HOME), [file('id_rsa', path.join(path.dirname(HOME), 'other-user'))]),
    [],
    HOME,
  ).findings[0];
  assert.ok(sibling, 'a key beside home is flagged');
  assert.equal(sibling.suggestedPath, undefined, 'but it is not under home, so no home destination is offered');
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
  assert.match(owned.reason, /under “Application Support”, where programs keep their own data/, 'the reason names the data folder it is in (review F2.2)');

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

/* ─────────────── B17: a hard link's second name is a file, not a 0 ─────────────── */

test('a hard link’s second name shows the file’s own size, not the 0 the scan total gives it (B17)', () => {
  // The scan counts a hard-linked file once, so its second name carries 0 in
  // the tree — right for totals, wrong for a panel that describes files.
  const at = path.join(HOME, 'Downloads');
  const second: FileNode = { ...file('GlobalSignRootCA.pem', at, 0), hardlinkDuplicate: true };
  const plain = file('server.pem', path.join(HOME, 'Desktop'), 900);
  const notASecret: FileNode = { ...file('notes.txt', at, 0), hardlinkDuplicate: true };
  const asked: string[] = [];
  const sizeOf = (p: string): number | null => {
    asked.push(p);
    return 1261;
  };
  const found = collectSecurityFindings(treeWith(HOME, [second, plain, notASecret]), [], HOME, sizeOf).findings;
  assert.equal(found.find((f) => f.name === 'GlobalSignRootCA.pem')?.size, 1261, 'the second name shows the file’s size');
  assert.equal(found.find((f) => f.name === 'server.pem')?.size, 900, 'a file with one name keeps the scan’s size');
  assert.deepEqual(asked, [second.path], 'only a second name that could be a finding is looked up');

  // Its own size decides the size rule, as it does for its first name.
  const bigKey: FileNode = { ...file('Pitch.key', at, 0), hardlinkDuplicate: true };
  assert.deepEqual(collectSecurityFindings(treeWith(HOME, [bigKey]), [], HOME, () => 400_000).findings, [],
    'a 400 KB .key is not a key under its second name either');

  // A size that cannot be read is unknown, never a zero — and cannot rule the file out.
  const unknown = collectSecurityFindings(treeWith(HOME, [second]), [], HOME, () => null).findings;
  assert.equal(unknown.length, 1, 'still listed');
  assert.equal(unknown[0].size, null, 'its size is unknown, not 0');
});

test('a second name’s size is read from the file system: its bytes for a file, unknown — never 0 B — when it is gone or not a file (B17 review)', () => {
  // The default sizeOfLinkedName. The test above injects its answers, so this
  // is where the real metadata read's failure branches are held to null.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-size-'));
  try {
    const cert = path.join(dir, 'GlobalSignRootCA.pem');
    fs.writeFileSync(cert, 'x'.repeat(1261));
    const empty = path.join(dir, 'empty.pem');
    fs.writeFileSync(empty, '');
    assert.equal(linkedFileSize(cert), 1261, 'a file’s own byte size');
    assert.equal(linkedFileSize(empty), 0, 'an empty file is a measured 0');
    assert.equal(linkedFileSize(path.join(dir, 'vanished.pem')), null, 'a name whose file is gone is unknown, not 0 B');
    assert.equal(linkedFileSize(dir), null, 'a folder is not a file to size, not 0 B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both names of a real hard-linked certificate show its size after a scan (B17)', { skip: process.platform === 'win32' && 'hard links need NTFS privileges on some runners' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-'));
  try {
    const first = path.join(dir, 'bundler', 'GlobalSignRootCA.pem');
    const second = path.join(dir, 'rubygems', 'GlobalSignRootCA.pem');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(first, 'x'.repeat(1261));
    fs.linkSync(first, second);
    const scan = await startScan(dir);
    await waitFor(() => scan.status !== 'running', `the scan of ${dir}`);
    assert.equal(scan.status, 'complete', scan.error);
    const store = storeOf(scan);
    const sizes = [...store.childIds(store.rootId)].flatMap((d) => [...store.childIds(d)]).map((f) => store.size(f)).sort();
    assert.deepEqual(sizes, [0, 1261], 'the scan counts the file once (the precondition)');

    const found = collectSecurityFindings(store, [], HOME).findings;
    assert.deepEqual(found.map((f) => [f.path, f.size]).sort(), [[first, 1261], [second, 1261]],
      'each name is listed at the file’s own size');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Security panel says a size it could not read is unknown, never "0 B" (B17)', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = index.slice(index.indexOf('function renderSecurity'), index.indexOf('function confirmRelocateSecret'));
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const info = { textContent: '', innerHTML: '' };
  const stubs: Record<string, unknown> = {
    $: (id: string) => (id === 'securityBody' ? host : info),
    state: { scanId: 's', security: { report: {
      findings: [
        { severity: 'low', name: 'a.pem', label: 'Cert', path: '/x/a.pem', reason: 'r', why: 'w', size: null },
        { severity: 'low', name: 'b.pem', label: 'Cert', path: '/x/b.pem', reason: 'r', why: 'w', size: 1261 },
      ],
      counts: { high: 0, medium: 0, low: 2 }, total: 2, patternCount: 9,
    } } },
    escapeHtml: (s: unknown) => String(s),
    formatBytes: (n: number) => `${String(n)} B`,
    formatCount: (n: number) => String(n),
    icon: () => '',
    baseName: (p: string) => path.basename(p),
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } },
    SEVERITY_LABEL: { low: 'Minor' },
    openInOS: () => {},
    confirmRelocateSecret: () => {},
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `${fn}; return renderSecurity;`)(...keys.map((k) => stubs[k])) as () => void;
  render();
  const rows = host.innerHTML.split('sec-item').slice(1);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0], /null B|0 B/, 'an unknown size is not printed as a number');
  assert.match(rows[0], /size unknown/, 'it is called unknown');
  assert.match(rows[1], /1261 B/, 'a known size is printed as before');
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

test('a .pem is said to hold what its name suggests — public certificates, or a private key — and otherwise that it may hold a private key; never "usually a private key" (seventh browser pass J53)', () => {
  // QA: every .pem row said "PEM files usually hold a private key or a certificate with one", but
  // roots.pem, zcacert.pem and cacert.pem are public CA bundles. A .pem may hold a private key or only
  // public material, and TreeMap reads names, never contents — so the row says what the name suggests,
  // where it suggests something, and otherwise that the file may hold a private key.
  const at = path.join(HOME, 'Downloads');
  const whyOf = (name: string, severity: 'high' | 'low' = 'high') => {
    const f = findingsFor([file(name, at)])[0];
    assert.ok(f, `${name}: listed`);
    assert.equal(f.patternId, 'pem-key', `${name}: by the .pem rule`);
    // Serious unless the name suggests public certificates, which are minor (K54) — listed still: a .pem can hold a key.
    assert.equal(f.severity, severity, `${name}: ${severity === 'high' ? 'serious' : 'minor'}`);
    assert.doesNotMatch(f.why, /usually hold a private key/, `${name}: never the old overstatement`);
    assert.match(f.why, /names and sizes/, `${name}: says TreeMap goes by the name, never the contents`);
    return f.why;
  };
  for (const name of ['roots.pem', 'zcacert.pem', 'cacert.pem', 'ca-bundle.pem', 'fullchain.pem', 'cert.pem', 'DigiCertGlobalRootCA.pem']) {
    const why = whyOf(name, 'low');
    assert.match(why, /^Its name suggests public certificates/, `${name}: the name suggests certificates (${why})`);
    assert.match(why, /can hold a private key too/, `${name}: and a .pem can still hold a key (${why})`);
  }
  for (const name of ['privkey.pem', 'server-key.pem', 'private.pem', 'tls.key.pem']) {
    assert.match(whyOf(name), /^Its name suggests a private key/, `${name}: the name suggests a private key`);
  }
  // A name that suggests nothing, or both at once, says only what is true of every .pem.
  for (const name of ['server.pem', 'monkey.pem', 'cert-and-key.pem', 'sample.pem']) {
    const why = whyOf(name);
    assert.match(why, /^A \.pem file may hold a private key, or only public material/, `${name}: may hold a key (${why})`);
    assert.doesNotMatch(why, /suggests/, `${name}: and claims no suggestion its name does not make`);
  }
});

test('a .pem whose name suggests public certificates is minor, never badged serious beside "which are not secret", and a folder named certs or ca-certificates is where a .pem belongs; the counts still cover every finding (eighth browser pass K54)', () => {
  const downloads = path.join(HOME, 'Downloads');
  const bundles = ['roots.pem', 'cacert.pem', 'ca-bundle.pem'].map((n) => file(n, downloads, 200_000));
  const keys = ['privkey.pem', 'server.pem'].map((n) => file(n, downloads, 3_000));
  const report = collectSecurityFindings(treeWith(HOME, [...bundles, ...keys]), [], HOME);
  const sev = Object.fromEntries(report.findings.map((f) => [f.name, f.severity]));
  assert.deepEqual(sev, { 'roots.pem': 'low', 'cacert.pem': 'low', 'ca-bundle.pem': 'low', 'privkey.pem': 'high', 'server.pem': 'high' },
    'a name that suggests certificates is minor; one that suggests a key, or nothing, stays serious');
  for (const f of report.findings.filter((x) => x.severity === 'low')) {
    assert.match(f.why, /^Its name suggests public certificates/, `${f.name}: minor because its name suggests certificates, and it says so`);
  }
  assert.deepEqual({ counts: report.counts, total: report.total }, { counts: { high: 2, medium: 0, low: 3 }, total: 5 },
    'the counts and the total still cover every finding, by the severity each is listed with');
  // Where certificates are kept on purpose: not listed at all.
  for (const dir of [path.join(HOME, 'certs'), path.join(HOME, 'code', 'app', 'ssl', 'certs'), path.join(HOME, 'tools', 'ca-certificates'), path.join(HOME, 'Projects', 'certs', 'live')]) {
    assert.deepEqual(findingsFor([file('cacert.pem', dir), file('server.pem', dir)]).map((f) => f.name), [], `${dir}: a .pem in it is where it belongs`);
  }
  // Nor is every folder named like certs one: a folder whose name only holds the word is not.
  assert.equal(findingsFor([file('cacert.pem', path.join(HOME, 'mycerts-backup'))]).length, 1, 'control: a folder that is not named certs gives no pass');
});

test('a folder named certs or ca-certificates gives a .pem no pass inside a folder that syncs to the cloud or is easy to share — a private key in Downloads/certs, Dropbox/certs or Desktop/ca-certificates is listed, serious, as anywhere there (review F1.5)', () => {
  // K54 made any folder named certs an expected place, judged before the synced and exposed folders were: a
  // downloaded zip that unpacks to certs/privkey.pem, or a key in ~/Dropbox/certs, was dropped from the panel.
  for (const [dir, reason] of [
    [path.join(HOME, 'Downloads', 'certs'), /easy to share/],
    [path.join(HOME, 'Dropbox', 'certs'), /syncs to the cloud/],
    [path.join(HOME, 'Desktop', 'ca-certificates'), /easy to share/],
    [path.join(HOME, 'Dropbox', 'Documents', 'certs'), /syncs to the cloud/],
    [path.join(HOME, 'Documents', 'site', 'ssl', 'certs'), /easy to share/],
  ] as const) {
    const found = findingsFor([file('privkey.pem', dir), file('server-key.pem', dir), file('cacert.pem', dir)]);
    assert.deepEqual(Object.fromEntries(found.map((f) => [f.name, f.severity])), { 'privkey.pem': 'high', 'server-key.pem': 'high', 'cacert.pem': 'low' },
      `${dir}: listed — a name that suggests a key serious, one that suggests certificates minor`);
    for (const f of found) {
      assert.equal(f.exposed, true, `${dir}/${f.name}: marked as in a synced or exposed folder`);
      assert.match(f.reason, reason, `${dir}/${f.name}: and its reason says which (${f.reason})`);
    }
  }
  // A certs folder in no synced or exposed folder still gives its pass.
  assert.deepEqual(findingsFor([file('privkey.pem', path.join(HOME, 'Projects', 'certs'))]), [], 'control: a certs folder in no synced or exposed folder is where a .pem belongs');
});

test('a folder that syncs to the cloud is known where macOS keeps it too — iCloud Drive under Library/Mobile Documents, and the File Provider folders under Library/CloudStorage (Box, Google Drive, OneDrive, Dropbox) — so a certs folder there gives a private key no pass, and a medium finding there is serious (review F2.1)', () => {
  // SYNC_FOLDERS knew "iCloud Drive", a name Finder shows but no path holds, and no Box Drive: a private key in
  // ~/Library/Mobile Documents/com~apple~CloudDocs/certs was dropped from the panel, the failure F1.5 closed elsewhere.
  for (const dir of [
    path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'certs'),
    path.join(HOME, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'vault', 'certs'),
    path.join(HOME, 'Library', 'CloudStorage', 'Box-Box', 'certs'),
    path.join(HOME, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive', 'ssl', 'certs'),
    path.join(HOME, 'iCloudDrive', 'certs'),
  ]) {
    const found = findingsFor([file('privkey.pem', dir), file('cacert.pem', dir)]);
    assert.deepEqual(Object.fromEntries(found.map((f) => [f.name, f.severity])), { 'privkey.pem': 'high', 'cacert.pem': 'low' },
      `${dir}: listed — the key serious, the certificates minor`);
    for (const f of found) {
      assert.equal(f.exposed, true, `${dir}/${f.name}: marked as in a synced folder`);
      assert.match(f.reason, /syncs to the cloud/, `${dir}/${f.name}: and its reason says it syncs (${f.reason})`);
    }
  }
  const env = findingsFor([file('.env', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'app'))])[0];
  assert.deepEqual([env?.severity, env?.exposed], ['high', true], 'a .env in iCloud Drive is serious, as in Dropbox: it leaves the machine');
  // Only where the system keeps them: a folder merely named like one is no synced folder.
  for (const dir of [path.join(HOME, 'Projects', 'CloudStorage', 'certs'), path.join(HOME, 'Mobile Documents', 'certs')]) {
    assert.deepEqual(findingsFor([file('privkey.pem', dir)]), [], `control: ${dir} is not a synced folder, so its certs folder gives its pass`);
  }
});

test('inside a folder that syncs to the cloud or is easy to share no folder gives a key a pass — not .ssh, .certs or .config/certs either: a private key in ~/Dropbox/.ssh leaves the computer as surely as one in ~/Dropbox/certs, and is listed (review F2.7)', () => {
  for (const [dir, names, reason] of [
    [path.join(HOME, 'Dropbox', '.ssh'), ['id_rsa', 'privkey.pem'], /syncs to the cloud/],
    [path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'dotfiles', '.ssh'), ['id_ed25519'], /syncs to the cloud/],
    [path.join(HOME, 'Dropbox', 'dotfiles', '.aws'), ['credentials'], /syncs to the cloud/],
    [path.join(HOME, 'Downloads', '.certs'), ['privkey.pem'], /easy to share/],
    [path.join(HOME, 'Desktop', '.config', 'certs'), ['privkey.pem'], /easy to share/],
  ] as const) {
    const found = findingsFor(names.map((n) => file(n, dir)));
    assert.deepEqual(found.map((f) => f.name).sort(), [...names].sort(), `${dir}: every key in it is listed`);
    for (const f of found) {
      assert.deepEqual([f.severity, f.exposed], ['high', true], `${dir}/${f.name}: serious, and marked as in a synced or exposed folder`);
      assert.match(f.reason, reason, `${dir}/${f.name}: and its reason says which (${f.reason})`);
    }
  }
  // The same places in no synced or exposed folder are where a key belongs, as before.
  for (const dir of [path.join(HOME, '.ssh'), path.join(HOME, '.certs'), path.join(HOME, '.config', 'certs'), path.join(HOME, 'code', 'site', '.ssh')]) {
    assert.deepEqual(findingsFor([file('privkey.pem', dir)]), [], `control: ${dir} is where a key is kept on purpose`);
  }
  assert.deepEqual(findingsFor([file('credentials', path.join(HOME, '.aws'))]), [], 'control: ~/.aws/credentials is where it belongs');
});

test('every folder name a synced folder goes by is known — OneDrive and "OneDrive - <organisation>", Google Drive and its My Drive, Box Sync and Box Drive\'s ~/Box, iCloud Drive, "Dropbox (Personal)" — and a name that merely holds one of the words is not one (review F3.2, F3.4)', () => {
  // SYNC_FOLDERS spelled Google Drive's own folder "mydrive", so G:\My Drive (and ~/My Drive, where mirror mode puts it)
  // gave a key in .ssh its pass; Box Drive's ~/Box was unknown; and only Dropbox and iCloudDrive were pinned by a test.
  for (const dir of [
    path.join(HOME, 'OneDrive', 'certs'),
    path.join(HOME, 'OneDrive - Contoso', 'certs'),
    path.join(HOME, 'Google Drive', 'certs'),
    path.join(HOME, 'GoogleDrive', 'certs'),
    path.join(HOME, 'Box Sync', 'certs'),
    path.join(HOME, 'Box', '.ssh'),
    path.join(HOME, 'My Drive', '.ssh'),
    path.join(HOME, 'MyDrive', 'certs'),
    path.join(HOME, 'iCloud Drive', 'certs'),
    path.join(HOME, 'Dropbox (Personal)', 'certs'),
  ]) {
    const found = findingsFor([file('privkey.pem', dir)]);
    assert.equal(found.length, 1, `${dir}: a private key there is listed`);
    assert.deepEqual([found[0].severity, found[0].exposed], ['high', true], `${dir}: serious, and marked as in a synced folder`);
    assert.match(found[0].reason, /syncs to the cloud/, `${dir}: and its reason says it syncs (${found[0].reason})`);
  }
  // Google Drive for desktop's drive on Windows (G:\My Drive), outside the home folder: its .ssh gives no pass either.
  const drive = path.resolve('/mnt/g');
  for (const dir of [path.join(drive, 'My Drive', '.ssh'), path.join(drive, 'My Drive', 'keys')]) {
    const found = findingsFor([file('id_rsa', dir)], drive);
    assert.deepEqual(found.map((f) => [f.severity, f.exposed]), [['high', true]], `${dir}: listed, serious, as in a synced folder`);
    assert.match(found[0].reason, /syncs to the cloud/, `${dir}: and says it syncs (${found[0].reason})`);
  }
  // A longer word, a name that only holds one, or "box" anywhere but Box Drive's own folder, is no synced folder.
  for (const dir of [
    path.join(HOME, 'My Drivers', '.ssh'),
    path.join(HOME, 'Dropboxes', 'certs'),
    path.join(HOME, 'notes-onedrive', 'certs'),
    path.join(HOME, 'Projects', 'box', '.ssh'),
    path.join(HOME, 'Boxes', 'certs'),
  ]) {
    assert.deepEqual(findingsFor([file('privkey.pem', dir)]), [], `control: ${dir} is not a synced folder, so its folder gives its pass`);
  }
});

test('for a file in the home folder only the folders below it say whether it is easy to share — a home that is itself inside a folder named shared, public or documents leaves ~/.ssh, ~/.aws and a certs folder where they belong; a file outside home is judged by every folder above it (review F3.1)', () => {
  // ce289d53 let an exposed folder cancel every pass, judged on the whole path: with the home folder at /home/shared/tester
  // the user's own ~/.ssh/id_rsa was listed as serious, "In “.ssh”, a folder that is easy to share", and offered a move to ~/.ssh.
  for (const home of [path.resolve('/home/shared/tester'), path.resolve('/Volumes/Public/Users/tester'), path.resolve('/srv/Documents/tester')]) {
    const at = (...p: string[]) => path.join(home, ...p);
    const report = collectSecurityFindings(treeWith(home, [
      file('id_rsa', at('.ssh')), file('credentials', at('.aws')), file('privkey.pem', at('Projects', 'certs')), file('id_ed25519', at('keys')),
      file('id_ecdsa', at('Downloads')),
    ]), [], home);
    const by = Object.fromEntries(report.findings.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(by).sort(), ['id_ecdsa', 'id_ed25519'], `${home}: only the keys outside their places are listed`);
    assert.deepEqual([by.id_ed25519.exposed, by.id_ed25519.reason], [false, 'In “keys”, which is not where this kind of file belongs.'],
      `${home}: a key in ~/keys is in the wrong place, not in a folder easy to share`);
    assert.deepEqual([by.id_ecdsa.exposed, by.id_ecdsa.reason], [true, 'In “Downloads”, a folder that is easy to share or hand over by accident.'],
      `${home}: ~/Downloads still is one`);
  }
  // Outside the home folder every folder above the file counts: /home/shared/other is in a folder named shared.
  const shared = path.resolve('/home/shared');
  const outside = collectSecurityFindings(treeWith(shared, [file('id_rsa', path.join(shared, 'other', '.ssh'))]), [], path.join(shared, 'tester')).findings;
  assert.deepEqual(outside.map((f) => [f.name, f.exposed]), [['id_rsa', true]], 'a key outside home, under a folder named shared, is listed as exposed');
  assert.match(outside[0].reason, /easy to share/);
  // A synced folder's names are its own: a home kept inside one syncs with it, so its .ssh gives no pass.
  const synced = path.resolve('/srv/Dropbox/tester');
  const inSynced = collectSecurityFindings(treeWith(synced, [file('id_rsa', path.join(synced, '.ssh'))]), [], synced).findings;
  assert.deepEqual(inSynced.map((f) => [f.name, f.exposed]), [['id_rsa', true]], 'a home inside a Dropbox folder syncs with it');
  assert.match(inSynced[0].reason, /syncs to the cloud/);
  // AGENTS.md says both, as the scanner judges them (review F3.1, F3.2).
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const flat = agents.slice(agents.indexOf('`GET /api/security/findings`'), agents.indexOf('`GET /api/provenance?path=`')).replace(/\s+/g, ' ');
  assert.match(flat, /Google Drive and its `My Drive`, Box Sync and Box Drive's `~\/Box`, iCloud Drive/, 'AGENTS.md names the synced folders the scanner knows');
  assert.match(flat, /For a file in the home folder only the folders below it say whether it is easy to share, so a home folder that is itself inside one named Shared keeps `~\/\.ssh` and `~\/\.aws` where they belong;/,
    'and that a file in the home folder is judged by the folders below it');
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
  // /usr/share/ca-certificates and /etc/ssl/certs are folders certificates are kept in on purpose: a .pem there is
  // where it belongs, and not listed at all (eighth browser pass K54).
  for (const dir of ['/usr/share/ca-certificates/mozilla', '/etc/ssl/certs']) {
    assert.deepEqual(collectSecurityFindings(treeWith('/', [file('ca.pem', dir)]), [], HOME).findings, [], `${dir}: where a .pem belongs`);
  }
  for (const dir of ['/System/Library/Security', '/private/etc/ssl', '/etc/pki/tls']) {
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

/* ─────────────── Offer only the move the server will make (fourth browser pass, E10) ─────────────── */

function call(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/**
 * A stand-in home folder for the findings' "~": os.homedir() reads HOME on POSIX only — Windows reads
 * USERPROFILE and ignores HOME — so the tests that need it are skipped there (review F1.6), as
 * policyByPlace's are. Restores HOME as it was, unset included: assigning `undefined` would store the
 * string "undefined".
 */
const HOME_FROM_ENV = process.platform === 'win32' ? 'the home folder is read from HOME here, and Windows reads USERPROFILE' : false;
async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const prior = process.env.HOME;
  process.env.HOME = home; // the findings' "~" is this folder, read when the findings are asked for
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test('a finding is offered "Move it" only where the server will move it: a scan that does not cover ~/.ssh says what is needed instead, and the server agrees (E10)', { skip: HOME_FROM_ENV }, async () => {
  // A stand-in home folder: ~/corpus/id_rsa belongs in ~/.ssh.
  const standInHome = fs.realpathSync(fileTempDir('treemap-securityHygiene-e10-home-'));
  const corpus = path.join(standInHome, 'corpus');
  fs.mkdirSync(corpus);
  const key = path.join(corpus, 'id_rsa');
  fs.writeFileSync(key, 'not a real key');
  const ssh = path.join(standInHome, '.ssh');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await withHome(standInHome, async () => {
      const scanOf = async (dir: string): Promise<string> => {
        const started = await call(port, 'POST', '/api/scan', { path: dir });
        assert.equal(started.status, 202, JSON.stringify(started.body));
        await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', `the scan of ${dir}`);
        return started.body.scanId as string;
      };
      const findingOf = async (scanId: string) => {
        const r = await call(port, 'GET', `/api/security/findings?scanId=${scanId}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const f = r.body.findings.find((x: { path: string }) => x.path === key);
        assert.ok(f, 'control: the key is a finding');
        assert.equal(f.suggestedPath, ssh, 'control: it belongs in ~/.ssh');
        return f as { relocateRefusal?: string | null };
      };

      const corpusScan = await scanOf(corpus);
      const outside = await findingOf(corpusScan);
      assert.equal(typeof outside.relocateRefusal, 'string', 'a scan of ~/corpus alone does not cover ~/.ssh: the finding says the move would be refused');
      assert.match(outside.relocateRefusal!, /only into a folder it has scanned/, 'it says why');
      assert.ok(outside.relocateRefusal!.includes(ssh), 'naming the folder the move needs');
      assert.match(outside.relocateRefusal!, /your home folder/, 'and what to scan');
      const refused = await call(port, 'POST', '/api/security/relocate', { path: key, to: path.join(ssh, 'id_rsa'), confirm: true });
      assert.equal(refused.body.code, 'OUTSIDE_SCAN_ROOT', 'control: the server does refuse that move');
      assert.ok(fs.existsSync(key), 'and nothing moved');

      fs.mkdirSync(ssh);
      fs.writeFileSync(path.join(ssh, 'id_rsa'), 'already here');
      const homeScan = await scanOf(standInHome);
      const occupied = await findingOf(homeScan);
      assert.match(String(occupied.relocateRefusal), /already/, 'with something already at ~/.ssh/id_rsa the move would be cancelled, and the finding says so first');
      fs.renameSync(path.join(ssh, 'id_rsa'), path.join(standInHome, 'moved-aside'));

      // The agent policy is the route's too: a protected ~/.ssh is said first, and an unreadable policy
      // file refuses the move without taking the findings down with it.
      const policyFile = path.join(appDataDir(), 'agent-policy.json');
      fs.writeFileSync(policyFile, JSON.stringify({ protectedPaths: [ssh] }));
      assert.match(String((await findingOf(homeScan)).relocateRefusal), /protected path/, 'a move the agent policy forbids is not offered');
      fs.writeFileSync(policyFile, '{ not json');
      assert.match(String((await findingOf(homeScan)).relocateRefusal), /could not be read/, 'nor one an unreadable policy file would refuse — and the findings still answer');
      fs.rmSync(policyFile);
      for (const kept of fs.readdirSync(appDataDir()).filter((n) => n.startsWith('agent-policy.json.corrupt'))) fs.rmSync(path.join(appDataDir(), kept));

      const inside = await findingOf(homeScan);
      assert.equal(inside.relocateRefusal, null, 'once ~/.ssh is free and inside a scanned folder the move is offered');
      const moved = await call(port, 'POST', '/api/security/relocate', { path: key, to: path.join(ssh, 'id_rsa'), confirm: true });
      assert.equal(moved.status, 200, `and the server makes it: ${JSON.stringify(moved.body)}`);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a finding that is a link, not the file, is not offered "Move it" — the server moves only a real file — and one gone since the scan says it cannot be looked at (E10, review F1.3)', { skip: HOME_FROM_ENV }, async () => {
  const home = fs.realpathSync(fileTempDir('treemap-securityHygiene-e10-link-'));
  fs.mkdirSync(path.join(home, 'real'));
  fs.writeFileSync(path.join(home, 'real', 'keyfile'), 'not a real key');
  fs.mkdirSync(path.join(home, 'dl'));
  const link = path.join(home, 'dl', 'id_rsa');
  fs.symlinkSync(path.join(home, 'real', 'keyfile'), link);
  const gone = path.join(home, 'dl', 'id_ed25519');
  fs.writeFileSync(gone, 'not a real key either');
  const ssh = path.join(home, '.ssh');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await withHome(home, async () => {
      const started = await call(port, 'POST', '/api/scan', { path: home });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan of the stand-in home');
      fs.rmSync(gone); // gone between the scan and the findings
      const r = await call(port, 'GET', `/api/security/findings?scanId=${started.body.scanId}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const of = (p: string) => r.body.findings.find((x: { path: string }) => x.path === p) as { suggestedPath?: string; relocateRefusal?: string | null } | undefined;
      const linked = of(link);
      assert.ok(linked, 'control: the link is a finding');
      assert.equal(linked.suggestedPath, ssh, 'control: it is told it belongs in ~/.ssh, which is free and inside the scanned folder');
      assert.equal(typeof linked.relocateRefusal, 'string', 'a link is not offered the move');
      assert.match(linked.relocateRefusal!, /a link, not the file itself/, 'it says why');
      const refused = await call(port, 'POST', '/api/security/relocate', { path: link, to: path.join(ssh, 'id_rsa'), confirm: true });
      assert.equal(refused.body.code, 'RELOCATE_FAILED', `control: the server does refuse that move: ${JSON.stringify(refused.body)}`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), 'and nothing moved');

      const missing = of(gone);
      assert.ok(missing, 'control: the file gone since the scan is still a finding of it');
      assert.match(String(missing.relocateRefusal), /could not look at/, 'its move is not offered: the server would find nothing to move');
      assert.ok(String(missing.relocateRefusal).includes(gone), 'naming the file');
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the Security panel offers "Move it" only to a finding the server will move, and shows the reason in its place (E10)', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = index.slice(index.indexOf('function renderSecurity'), index.indexOf('function confirmRelocateSecret'));
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const info = { textContent: '', innerHTML: '' };
  const finding = (name: string, relocateRefusal: string | null) => ({
    severity: 'high', name, label: 'SSH private key', path: `/h/corpus/${name}`, reason: 'r', why: 'w', size: 40, suggestedPath: '/h/.ssh', relocateRefusal,
  });
  const stubs: Record<string, unknown> = {
    $: (id: string) => (id === 'securityBody' ? host : info),
    state: { scanId: 's', security: { report: {
      findings: [finding('id_rsa', 'TreeMap moves a file only into a folder it has scanned, and /h/.ssh is outside every scanned folder.'), finding('id_ed25519', null)],
      counts: { high: 2, medium: 0, low: 0 }, total: 2, patternCount: 9,
    } } },
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${String(n)} B`, formatCount: (n: number) => String(n),
    icon: () => '', baseName: (p: string) => path.basename(p),
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } },
    SEVERITY_LABEL: { high: 'Serious' }, openInOS: () => {}, confirmRelocateSecret: () => {},
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `${fn}; return renderSecurity;`)(...keys.map((k) => stubs[k])) as () => void;
  render();
  const rows = host.innerHTML.split('sec-item').slice(1);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows[0], /data-sec-move/, 'a move the server would refuse is not offered');
  assert.match(rows[0], /only into a folder it has scanned, and \/h\/\.ssh is outside every scanned folder/, 'the row says what is needed instead');
  assert.match(rows[1], /data-sec-move="1"/, 'control: a move the server will make is offered');
  assert.doesNotMatch(rows[1], /outside every scanned folder/);
});

test('relocateRefusal is declared where an agent reads: the OpenAPI document and AGENTS.md (E10)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const said = JSON.stringify((buildOpenApiDocument() as { paths: Record<string, unknown> }).paths['/api/security/findings']);
  assert.match(said, /relocateRefusal \(beside a suggestedPath: why POST \/api\/security\/relocate would refuse that move/, 'the document names the field and what it means');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(agents, /`relocateRefusal`[\s\S]{0,200}offer the move only on `null`/, 'AGENTS.md says to offer the move only when it is null');
  assert.match(said, /a link rather than the file or is gone since the scan/, 'the document names a link or a vanished file among the refusals (review F1.3)');
  assert.match(agents, /a finding that is a link rather than\s+the file \(only a real file is moved\) or is gone since the scan/, 'and so does AGENTS.md');
});

/* ─────────────── Every finding reachable (fourth browser pass, E09) ─────────────── */

test('every finding is reachable: the page after the first 500 starts where it ended, in the same order, and says whether more remain (E09)', () => {
  const docs = Array.from({ length: 601 }, (_, i) => file(`Deck-${i}.key`, path.join(HOME, 'Documents', `d${i % 7}`), 1200));
  const real = ['id_rsa', 'id_ed25519', 'server.pem', 'wallet.dat'].map((n) => file(n, path.join(HOME, 'Misc'), 40));
  const tree = treeWith(HOME, [...docs, ...real]);
  const page = (offset?: number) => (collectSecurityFindings as unknown as (...a: unknown[]) => ReturnType<typeof collectSecurityFindings> & { offset?: number })(
    tree, [], HOME, undefined, offset);
  const first = page();
  const rest = page(500);
  assert.equal(first.total, 605, 'control: 605 findings');
  assert.deepEqual([first.findings.length, first.truncated, first.offset], [500, true, 0], 'the first page: the 500 most serious, more to come');
  assert.deepEqual([rest.findings.length, rest.truncated, rest.offset], [105, false, 500], 'the next page: the other 105, and nothing after it');
  assert.deepEqual(rest.counts, first.counts, 'every page counts every finding');
  const all = [...first.findings, ...rest.findings].map((f) => f.path);
  assert.equal(new Set(all).size, 605, 'every finding appears once across the pages');
  const whole = page(0).findings.concat(page(500).findings);
  assert.deepEqual(whole.map((f) => f.path), all, 'in one order, the same every time');
  assert.equal(page(605).findings.length, 0, 'past the end: no findings');
  assert.deepEqual([page(-4).findings.length, page(-4).offset], [500, 0], 'a negative offset is the start');
  assert.deepEqual([page(Number.NaN).findings.length, page(Number.NaN).offset], [500, 0], 'and so is one that is no number');
});

test('GET /api/security/findings takes an offset, and a bad one reads as the start (E09)', async () => {
  const dir = fs.realpathSync(fileTempDir('treemap-securityHygiene-e09-'));
  for (const n of ['id_rsa', 'id_ed25519', 'wallet.dat']) fs.writeFileSync(path.join(dir, n), 'x');
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await call(port, 'POST', '/api/scan', { path: dir });
    await waitFor(() => peekScan(started.body.scanId)?.status !== 'running', 'the scan');
    const at = async (q: string) => (await call(port, 'GET', `/api/security/findings?scanId=${started.body.scanId}${q}`)).body;
    const whole = await at('');
    assert.equal(whole.total, 3, 'control: three findings');
    const tail = await at('&offset=1');
    assert.deepEqual(tail.findings.map((f: { path: string }) => f.path), whole.findings.slice(1).map((f: { path: string }) => f.path), 'offset=1: the list from its second finding');
    assert.equal(tail.offset, 1);
    assert.equal(tail.total, 3, 'and the total is still every finding');
    assert.deepEqual((await at('&offset=-4')).findings.length, 3, 'a negative offset reads as the start');
    assert.deepEqual((await at('&offset=abc')).findings.length, 3, 'so does one that is not a number');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/** One page of the 801 findings the panel tests list, as GET /api/security/findings answers it from `offset`. */
function findingsPage(all: Array<Record<string, unknown>>, url: string, scanId = 's1'): Record<string, unknown> {
  const offset = Number(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('offset') ?? 0);
  const findings = all.slice(offset, offset + 500);
  return { scanId, findings, counts: { high: 0, medium: 0, low: 801 }, total: 801, truncated: offset + findings.length < 801, offset, patternCount: 9 };
}

/**
 * The page's own renderSecurity and loadMoreSecurity over a scan with 801 findings, the first 500
 * shown. `api` answers every request the panel makes; `paints` counts each time the list is drawn.
 */
function securityPanel(api: (url: string) => Promise<unknown>) {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // With the app's one rule for the scan behind the tree on screen (treeScanId), which loadMoreSecurity asks of.
  const ruleAt = index.indexOf('function treeScanId(');
  const fn = index.slice(ruleAt, index.indexOf('\n}', ruleAt) + 2) + '\n'
    + index.slice(index.indexOf('function renderSecurity'), index.indexOf('function confirmRelocateSecret'));
  const finding = (i: number) => ({ severity: 'low', name: `Deck-${i}.key`, label: 'Key', path: `/h/Deck-${i}.key`, reason: 'r', why: 'w', size: 1 });
  const all = Array.from({ length: 801 }, (_, i) => finding(i));
  const clicks: Record<string, () => unknown> = {};
  const out = { focused: '', paints: 0 };
  const more = { disabled: false, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } };
  let html = '';
  const host = {
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; out.paints++; },
    querySelectorAll: (sel: string) => (sel === '[data-sec-more]' && html.includes('data-sec-more')
      ? [{ addEventListener: (_t: string, f: () => unknown) => { clicks.more = f; } }] : [] as unknown[]),
    querySelector: (sel: string) => {
      if (sel === '[data-sec-more]') return html.includes('data-sec-more') ? more : null;
      const m = /data-sec-reveal="(\d+)"/.exec(sel);
      return m ? { focus: () => { out.focused = m[1]; } } : null;
    },
  };
  const info = { textContent: '', innerHTML: '' };
  const state = { scanId: 's1' as string, security: { report: { findings: all.slice(0, 500), counts: { high: 0, medium: 0, low: 801 }, total: 801, truncated: true, offset: 0, patternCount: 9 } as Record<string, unknown> } };
  const toasts: string[] = [];
  const stubs: Record<string, unknown> = {
    $: (id: string) => (id === 'securityBody' ? host : info), state,
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${String(n)} B`, formatCount: (n: number) => n.toLocaleString('en-US'),
    icon: () => '', baseName: (p: string) => path.basename(p),
    FxNum: { rollHtml: (el: { innerHTML: string }, h: string) => { el.innerHTML = h; } },
    SEVERITY_LABEL: { low: 'Minor' }, openInOS: () => {}, confirmRelocateSecret: () => {}, toast: (m: string) => { toasts.push(m); }, api,
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `${fn}; return renderSecurity;`)(...keys.map((k) => stubs[k])) as () => void;
  return { all, render, clicks, out, host, info, state, more, toasts };
}

test('the Security panel says how many findings it has not shown, and "Show more" brings in the next page until every one is listed (E09)', async () => {
  const asked: string[] = [];
  const panel = securityPanel(async (url) => { asked.push(url); return findingsPage(panel.all, url); });
  const { host, info, clicks, out } = panel;
  panel.render();
  assert.match(info.innerHTML, /the 500 most serious shown — 301 more below/, 'the headline says how many are not shown');
  assert.match(host.innerHTML, /data-sec-more[^>]*>[^<]*Show more<\/button>/, 'and a button reaches them');
  assert.match(host.innerHTML, /500 of 801 shown/, 'saying how far the list goes');
  await clicks.more();
  assert.deepEqual(asked, ['/api/security/findings?scanId=s1&offset=500'], 'the next page is asked for, from where the list ends');
  assert.equal(host.innerHTML.split('sec-item').length - 1, 801, 'every finding is listed');
  assert.doesNotMatch(host.innerHTML, /data-sec-more/, 'with nothing left to show, no button');
  assert.doesNotMatch(info.innerHTML, /more below/, 'and the headline no longer says some are hidden');
  assert.equal(out.focused, '500', 'focus moves to the first finding the click brought in, not to the page');
  assert.deepEqual(panel.toasts, [], 'the page reported nothing');
});

test('a page of findings that lands after a new scan, or after the panel was filled again, is dropped — never appended to findings it does not belong to (E09, review F1.8)', async () => {
  for (const change of ['a new scan', 'the panel filled again'] as const) {
    let answer: (v: unknown) => void = () => {};
    const panel = securityPanel((url) => new Promise((resolve) => { answer = () => resolve(findingsPage(panel.all, url)); }));
    panel.render();
    const pressed = panel.clicks.more();
    const paintsBefore = panel.out.paints;
    const fresh = { findings: panel.all.slice(0, 3), counts: { high: 0, medium: 0, low: 3 }, total: 3, truncated: false, offset: 0, patternCount: 9 };
    if (change === 'a new scan') panel.state.scanId = 's2';
    else panel.state.security.report = fresh;
    const owner = panel.state.security.report;
    answer(undefined);
    await pressed;
    assert.equal(panel.state.security.report, owner, `${change}: the report is the one that owns the panel now`);
    assert.equal((owner.findings as unknown[]).length, change === 'a new scan' ? 500 : 3, `${change}: and nothing was appended to it`);
    assert.equal(panel.out.paints, paintsBefore, `${change}: the list was not drawn again`);
    assert.equal(panel.out.focused, '', `${change}: and focus did not move`);
    assert.deepEqual(panel.toasts, [], `${change}: nothing was reported`);
  }
});

test('the paging is declared where an agent reads: the OpenAPI document and AGENTS.md (E09)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const said = JSON.stringify((buildOpenApiDocument() as { paths: Record<string, unknown> }).paths['/api/security/findings']);
  assert.match(said, /"name":"offset"/, 'the offset parameter is declared');
  assert.match(said, /every finding is reachable/, 'saying what it is for');
  assert.match(said, /ask again with offset = offset \+ findings.length/, 'and truncated says how to go on');
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.match(agents, /`\?offset=` \(the page's `offset` plus its length\) lists the next 500,\s+so every finding is reachable/, 'AGENTS.md says how to reach every finding');
});

test('"Show more" asks once while its page is on the way: a second press is ignored and the button says it is busy, and a page that fails gives the button back (E09, review F1.11)', async () => {
  const asked: string[] = [];
  let answer: (fail: boolean) => void = () => {};
  const panel = securityPanel((url) => new Promise((resolve, reject) => {
    asked.push(url);
    answer = (fail) => (fail ? reject(new Error('the server went away')) : resolve(findingsPage(panel.all, url)));
  }));
  panel.render();
  const first = panel.clicks.more();
  const second = panel.clicks.more();
  assert.deepEqual(asked, ['/api/security/findings?scanId=s1&offset=500'], 'one request for a double press — each one re-walks the whole scan');
  assert.equal(panel.more.disabled, true, 'the button is disabled while the page is on the way');
  assert.equal(panel.more.attrs['aria-busy'], 'true', 'and says it is busy');
  answer(true);
  await Promise.all([first, second]);
  assert.deepEqual(panel.toasts, ['Could not list more findings: the server went away'], 'a failure is said once');
  assert.equal(panel.more.disabled, false, 'and the button is given back');
  assert.equal(panel.more.attrs['aria-busy'], undefined, 'no longer busy');
  const retry = panel.clicks.more();
  assert.equal(asked.length, 2, 'so a press after it asks again');
  answer(false);
  await retry;
  assert.equal(panel.host.innerHTML.split('sec-item').length - 1, 801, 'and every finding is listed, once');
});

/* ─────────────── Sixth browser pass H05: the headline counts what is really misplaced ─────────────── */

// These fixtures are macOS and Linux folders under a "/" root (/Applications, /System, ~/Library, a
// WSL /mnt/c): on Windows the home folder resolves to a drive (D:\home\tester), outside that root, so
// the walk never reaches it. Windows' own folders are tested with Windows paths on the drive the home
// folder is on, by the tests after these, which run on Windows (BQR-1 A2), as the D42 test above
// already skips here.
const POSIX_ROOTED = process.platform === 'win32' && 'the fixtures are macOS and Linux folders under a / root';
/** The Windows tests' skip: they spell Windows paths, which the scanner reads by Windows' path rules. */
const WINDOWS_ONLY = process.platform !== 'win32' && 'Windows paths, read by Windows path rules';

test('the report counts, over every finding, those in folders installed software or the operating system keeps for itself, and a row inside an app names it (H05)', { skip: POSIX_ROOTED }, () => {
  const report = collectSecurityFindings(treeWith('/', [
    file('ca.pem', '/Applications/Thing.app/Contents/Resources'),
    file('server.pem', path.join(HOME, 'projects', 'web', 'node_modules', 'pkg', 'test')),
    file('cert.pem', '/System/Library/Security'),
    file('id_rsa', path.join(HOME, 'Downloads')),
  ]), [], HOME) as unknown as { findings: Array<{ name: string; reason: string; appOwned: boolean }>; total: number; counts: Record<string, number>; appOwnedCount?: number };
  assert.equal(report.total, 4, 'control: every finding is still counted in total');
  assert.deepEqual(report.counts, { high: 1, medium: 0, low: 3 }, 'and in counts, as before');
  assert.equal(report.appOwnedCount, 3, 'three of them sit in an app, a package folder or the operating system\'s own');
  const reason = (name: string) => report.findings.find((f) => f.name === name)!.reason;
  assert.match(reason('ca.pem'), /part of the app “Thing”/, 'a file inside an app names the app (the shared installed-programs detector)');
  assert.doesNotMatch(reason('ca.pem'), /an installed program/, 'not a nameless "installed program"');
  assert.match(reason('server.pem'), /inside “node_modules”, a folder a package manager fills with installed packages/, 'the panel\'s wider net, which the detector does not name, says which folder it is (review F2.2)');
  assert.doesNotMatch(reason('server.pem'), /part of that software|moving it would break it/, 'and claims no more than that: a file in a package folder need not be part of any package');
  assert.match(reason('cert.pem'), /operating system/, 'the operating system\'s own is said as such');
});

test('the 500 cap leaves the app-owned count over every finding (H05)', { skip: POSIX_ROOTED }, () => {
  const owned = Array.from({ length: 520 }, (_, i) => file(`c${i}.pem`, `/Applications/A${i % 3}.app/Contents/Resources`));
  const report = collectSecurityFindings(treeWith('/', [...owned, file('id_rsa', path.join(HOME, 'Downloads'))]), [], HOME) as unknown as { findings: unknown[]; total: number; appOwnedCount?: number };
  assert.equal(report.findings.length, 500, 'control: the page holds 500');
  assert.equal(report.appOwnedCount, 520, 'the count is over every finding, not the page');
});

/** The page's renderSecurity over `report`; answers the headline's text. */
function securityHeadline(report: Record<string, unknown>): string {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = index.slice(index.indexOf('function renderSecurity'), index.indexOf('/** The report a "Show more" page'));
  const host = { innerHTML: '', querySelectorAll: () => [] as unknown[] };
  const info = { textContent: '', innerHTML: '' };
  const stubs: Record<string, unknown> = {
    $: (id: string) => (id === 'securityBody' ? host : info),
    state: { scanId: 's', security: { report } },
    escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${String(n)} B`, formatCount: (n: number) => String(n),
    icon: () => '', baseName: (p: string) => path.basename(p),
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } },
    SEVERITY_LABEL: { high: 'Serious', medium: 'Worth fixing', low: 'Minor' }, openInOS: () => {}, confirmRelocateSecret: () => {}, loadMoreSecurity: () => {},
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(...keys, `${fn}; return renderSecurity;`)(...keys.map((k) => stubs[k])) as () => void)();
  return info.innerHTML.replace(/<[^>]+>/g, '');
}

test('the Security headline calls only the misplaced findings "outside the folder they belong in", and says plainly where the rest sit — in folders installed software or the operating system keeps for itself — never that they ship inside a program, nor that nothing is out of place (H05, review F1.3)', () => {
  const row = (name: string, severity: string, appOwned: boolean) => ({ severity, name, label: 'Cert', path: `/x/${name}`, reason: 'r', why: 'w', size: 1, appOwned });
  // QA: three .pem files, all inside apps, headlined as three files outside the folder they belong in.
  const allOwned = securityHeadline({
    findings: [row('a.pem', 'low', true), row('b.pem', 'low', true), row('c.pem', 'low', true)],
    counts: { high: 0, medium: 0, low: 3 }, total: 3, appOwnedCount: 3, patternCount: 9,
  });
  assert.doesNotMatch(allOwned, /outside the folder/, 'no app-owned file is called misplaced');
  assert.doesNotMatch(allOwned, /Nothing out of place|ships? inside/, 'nor reassures: a program\'s data folder may hold a key a person saved there');
  assert.match(allOwned, /^The 3 files below sit in folders that installed software or the operating system keeps for itself \(a program, its data or its packages\): listed for awareness, not to move\./,
    'it says plainly where the three are');
  const mixed = securityHeadline({
    findings: [row('id_rsa', 'high', false), row('a.pem', 'low', true), row('b.pem', 'low', true)],
    counts: { high: 1, medium: 0, low: 2 }, total: 3, appOwnedCount: 2, patternCount: 9,
  });
  assert.match(mixed, /^1 file sitting outside the folder it belongs in — 1 serious/, 'only the misplaced one is counted as such');
  assert.match(mixed, /\. 2 more sit in folders that installed software or the operating system keeps for itself \(a program, its data or its packages\)\./, 'and the rest are said for what they are');
  const one = securityHeadline({
    findings: [row('id_rsa', 'high', false), row('a.pem', 'low', true)],
    counts: { high: 1, medium: 0, low: 1 }, total: 2, appOwnedCount: 1, patternCount: 9,
  });
  assert.match(one, /\. 1 more sits in a folder that installed software or the operating system keeps for itself \(a program, its data or its packages\)\./, 'one is said in the singular');
  const plain = securityHeadline({
    findings: [row('id_rsa', 'high', false), row('k.json', 'medium', false)],
    counts: { high: 1, medium: 1, low: 0 }, total: 2, appOwnedCount: 0, patternCount: 9,
  });
  assert.match(plain, /^2 files sitting outside the folder they belong in — 1 serious, 1 worth fixing\./, 'control: with none app-owned the headline reads as before');
  assert.doesNotMatch(plain, /keeps for itself|ship inside/, 'and says nothing about programs');
});

test('a key a program keeps in its data folder is counted app-owned, and the headline over it neither says it ships inside a program nor that nothing is out of place (review F1.3)', { skip: POSIX_ROOTED }, () => {
  const data = path.join(HOME, 'Library', 'Application Support', 'SomeGitGui');
  const report = collectSecurityFindings(treeWith('/', [file('id_rsa', data), file('deploy.pem', data)]), [], HOME) as unknown as Record<string, unknown> & { total: number; appOwnedCount?: number };
  assert.equal(report.total, 2, 'control: both are findings');
  assert.equal(report.appOwnedCount, 2, 'control: both are in a folder a program keeps for itself, so app-owned');
  const said = securityHeadline({ ...report, patternCount: 9 });
  assert.doesNotMatch(said, /Nothing out of place|ships? inside/, 'neither file shipped inside a program, and nothing reassures about them');
  assert.match(said, /^The 2 files below sit in folders that installed software or the operating system keeps for itself \(a program, its data or its packages\)/, 'where they are, said as it is');
  // The row under the headline says the same (review F2.2, F2.6): a key a person saved in a tool's data
  // folder is not "part of that software", and moving it would break nothing that shipped.
  for (const f of (report as unknown as { findings: Array<{ name: string; reason: string }> }).findings) {
    assert.equal(f.reason,
      'In “SomeGitGui”, under “Application Support”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.',
      `${f.name}: the row names the data folder and claims no more`);
  }
});

test('every app-owned row says only what its folder is — a data folder, a package folder, a software bundle, the programs folder, the nearest where a path holds two — never that a file the detector names no program for is part of that software (review F2.2, F3.5)', { skip: POSIX_ROOTED }, () => {
  const reasonOf = (name: string, dir: string): string => {
    const [f] = findingsFor([file(name, dir)], '/');
    assert.equal(f?.appOwned, true, `control: ${dir} is app-owned`);
    return f.reason;
  };
  const cases: Array<[name: string, dir: string, said: string]> = [
    ['id_rsa', path.join(HOME, 'Library', 'Containers', 'com.example.app', 'Data'),
      'In “Data”, under “Containers”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.'],
    ['id_rsa', path.join(HOME, 'Library', 'Group Containers', 'group.com.example'),
      'In “group.com.example”, under “Group Containers”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.'],
    ['id_rsa', path.join(HOME, 'AppData', 'Roaming', 'Tool'),
      'In “Tool”, under “AppData”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.'],
    ['id_rsa', path.join(HOME, 'Library', 'Application Support'),
      'In “Application Support”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.'],
    ['server.pem', path.join(HOME, 'proj', '.venv', 'lib', 'python3.12', 'site-packages', 'pkg', 'tests'),
      'In “tests”, inside “site-packages”, a folder a package manager fills with installed packages — TreeMap does not offer to move it, since a package may rely on it.'],
    ['server.pem', path.join(HOME, 'Library', 'Application Support', 'Tool', 'node_modules', 'pkg'),
      'In “pkg”, inside “node_modules”, a folder a package manager fills with installed packages — TreeMap does not offer to move it, since a package may rely on it.'],
    ['id_rsa', path.join(HOME, 'Library', 'Stuff', 'Foo.framework', 'Versions', 'A', 'Resources'),
      'In “Resources”, inside “Foo.framework”, a software bundle — this file is part of that bundle, so moving it could break the software that loads it.'],
    ['id_rsa', path.join(HOME, 'Library', 'Stuff', 'Helper.bundle'),
      'In “Helper.bundle”, a software bundle — this file is part of that bundle, so moving it could break the software that loads it.'],
    ['cert.pem', '/mnt/c/Program Files',
      'In “Program Files”, where installed programs live — TreeMap does not offer to move it, since a program may rely on it.'],
    // Two places in one path (review F3.5): the nearest names the row, whichever kind it is.
    ['id_rsa', path.join(HOME, 'proj', 'node_modules', 'foo', 'Bar.framework', 'Resources'),
      'In “Resources”, inside “Bar.framework”, a software bundle — this file is part of that bundle, so moving it could break the software that loads it.'],
    ['server.pem', path.join(HOME, 'Library', 'Stuff', 'Foo.framework', 'Versions', 'A', 'Resources', 'node_modules', 'pkg'),
      'In “pkg”, inside “node_modules”, a folder a package manager fills with installed packages — TreeMap does not offer to move it, since a package may rely on it.'],
  ];
  for (const [name, dir, said] of cases) assert.equal(reasonOf(name, dir), said, dir);
});

/* ─────────────── The same rows on Windows, with Windows paths (BQR-1 A2) ─────────────── */

/** The Windows tests' drive — the one the home folder resolves to — and a home folder on it as Windows makes one. */
function windowsDrive(): { root: string; home: string } {
  const root = path.parse(HOME).root;
  return { root, home: path.join(root, 'Users', 'tester') };
}

test('on Windows a key-shaped file in a program\'s folder under Program Files is part of that program, one in AppData or ProgramData sits where programs keep their data, one under Windows is the operating system\'s, and only the key in Downloads is misplaced (BQR-1 A2)', { skip: WINDOWS_ONLY }, () => {
  const { root, home } = windowsDrive();
  const vendor = path.join(root, 'Program Files', 'Vendor');
  const oldVendor = path.join(root, 'Program Files (x86)', 'Old Vendor');
  const report = collectSecurityFindings(treeWith(root, [
    file('ca.pem', path.join(vendor, 'Tool', 'resources')),
    file('server.pem', path.join(oldVendor, 'ssl')),
    file('id_rsa', path.join(home, 'AppData', 'Roaming', 'Tool')),
    file('deploy.pem', path.join(home, 'AppData', 'Local', 'Tool', 'keys')),
    file('agent.pem', path.join(root, 'ProgramData', 'Vendor')),
    file('cert.pem', path.join(root, 'Windows', 'System32', 'config')),
    file('id_ed25519', path.join(home, 'Downloads')),
  ]), [], home) as unknown as { findings: Array<{ name: string; reason: string; appOwned: boolean; severity: string; suggestedPath?: string }>; total: number; counts: Record<string, number>; appOwnedCount: number };
  assert.equal(report.total, 7, 'control: every file is a finding');
  assert.deepEqual(report.counts, { high: 1, medium: 0, low: 6 }, 'only the key in Downloads is serious');
  assert.equal(report.appOwnedCount, 6, 'six sit in folders installed software or Windows keeps for itself');
  const row = (name: string) => report.findings.find((f) => f.name === name)!;
  assert.deepEqual(Object.fromEntries(report.findings.map((f) => [f.name, f.reason])), {
    'ca.pem': `In “resources”, part of a program installed in “${vendor}” — this file ships with that program, so moving it would break it.`,
    'server.pem': `In “ssl”, part of a program installed in “${oldVendor}” — this file ships with that program, so moving it would break it.`,
    id_rsa: 'In “Tool”, under “AppData”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.',
    'deploy.pem': 'In “keys”, under “AppData”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.',
    'agent.pem': 'In “Vendor”, under “ProgramData”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.',
    'cert.pem': 'In “config”, a folder the operating system manages — this file is part of the system, so moving it would break whatever uses it.',
    id_ed25519: 'In “Downloads”, a folder that is easy to share or hand over by accident.',
  }, 'each row says where its file is, by its Windows folder');
  assert.equal(row('id_ed25519').suggestedPath, path.join(home, '.ssh'), 'the misplaced key is offered the home folder\'s .ssh');
  assert.deepEqual(report.findings.filter((f) => f.appOwned).map((f) => f.suggestedPath), [undefined, undefined, undefined, undefined, undefined, undefined],
    'no file a program or Windows keeps is offered a move');
});

test('on Windows the 500 cap leaves the app-owned count over every finding, and a Program Files folder away from the drive\'s top is a programs folder, never a program by name (BQR-1 A2)', { skip: WINDOWS_ONLY }, () => {
  const { root, home } = windowsDrive();
  const owned = Array.from({ length: 520 }, (_, i) => file(`c${String(i)}.pem`, path.join(root, 'Program Files', `Vendor ${String(i % 3)}`, 'resources')));
  const report = collectSecurityFindings(treeWith(root, [...owned, file('id_rsa', path.join(home, 'Downloads'))]), [], home) as unknown as { findings: unknown[]; total: number; appOwnedCount: number };
  assert.deepEqual([report.findings.length, report.total], [500, 521], 'control: the page holds 500 of 521');
  assert.equal(report.appOwnedCount, 520, 'the count is over every finding, not the page');
  const copy = path.join(root, 'Backup', 'Program Files', 'Vendor');
  const [f] = collectSecurityFindings(treeWith(root, [file('server.pem', copy)]), [], home).findings;
  assert.equal(f.appOwned, true, 'control: a programs folder still');
  assert.equal(f.reason, 'In “Vendor”, inside “Program Files”, where installed programs live — TreeMap does not offer to move it, since a program may rely on it.',
    'a copy of Program Files elsewhere is said as a programs folder: no program is installed there');
});

/* ─────────────── Only Windows' own ProgramData is where programs keep their data (review F1.3) ─────────────── */

type Row = { name: string; severity: string; appOwned: boolean; suggestedPath?: string; reason: string; exposed: boolean };
/** Each row by its file's name, its folder's name `folder` spelled `as` in its reason: rows in folders named otherwise read the same. */
function rowsSpelling(rows: Row[], folder: string, as: string) {
  return Object.fromEntries(rows.map((r) => [r.name, {
    severity: r.severity, appOwned: r.appOwned, suggestedPath: r.suggestedPath, exposed: r.exposed, reason: r.reason.replaceAll(`“${folder}”`, `“${as}”`),
  }]));
}

test('a folder named ProgramData that a person made in their own folders is theirs: a key in it is ranked, said and offered a move as in a folder of any other name (review F1.3)', () => {
  const rowsIn = (folder: string) => findingsFor([
    file('id_rsa', path.join(HOME, 'Desktop', folder)),
    file('deploy.pem', path.join(HOME, 'Projects', folder, 'keys')),
  ]) as unknown as Row[];
  const control = rowsSpelling(rowsIn('Backup'), 'Backup', 'ProgramData');
  assert.deepEqual([control.id_rsa?.severity, control.id_rsa?.appOwned, control.id_rsa?.suggestedPath], ['high', false, path.join(HOME, '.ssh')],
    'control: a key in a folder on the Desktop is serious and offered the home folder\'s .ssh');
  assert.equal(control['deploy.pem']?.appOwned, false, 'control: a key in a project\'s folder is no program\'s');
  assert.deepEqual(rowsSpelling(rowsIn('ProgramData'), 'ProgramData', 'ProgramData'), control,
    'a folder named ProgramData away from the top of a drive is the person\'s: not "where programs keep their own data", not held back from the serious list or the move');
});

test('under WSL, Windows\' own ProgramData at the top of a drive (/mnt/c/ProgramData) is where programs keep their data (review F1.3)', { skip: POSIX_ROOTED }, () => {
  const [f] = findingsFor([file('agent.pem', '/mnt/c/ProgramData/Vendor')], '/');
  assert.equal(f?.appOwned, true, 'the drive\'s own ProgramData, seen from WSL');
  assert.equal(f?.reason, 'In “Vendor”, under “ProgramData”, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.');
  const [mine] = findingsFor([file('agent.pem', '/mnt/c/Users/me/ProgramData/Vendor')], '/');
  assert.equal(mine?.appOwned, false, 'one a person made deeper on the drive is theirs');
});

test('on Windows only the ProgramData at the top of a drive is where programs keep their data: one a person made in their own folders, or deeper on the drive, is theirs (review F1.3)', { skip: WINDOWS_ONLY }, () => {
  const { root, home } = windowsDrive();
  const report = collectSecurityFindings(treeWith(root, [
    file('agent.pem', path.join(root, 'ProgramData', 'Vendor')),
    file('id_rsa', path.join(home, 'Desktop', 'ProgramData')),
    file('server.pem', path.join(root, 'Backup', 'ProgramData', 'Vendor')),
  ]), [], home) as unknown as { findings: Row[] };
  const row = (name: string) => report.findings.find((f) => f.name === name)!;
  assert.equal(row('agent.pem').appOwned, true, 'control: the drive\'s own ProgramData is a program data folder');
  assert.deepEqual([row('id_rsa').appOwned, row('id_rsa').severity, row('id_rsa').suggestedPath, row('id_rsa').reason],
    [false, 'high', path.join(home, '.ssh'), 'In “ProgramData”, a folder that is easy to share or hand over by accident.'],
    'a key in a ProgramData folder on the Desktop is misplaced, serious, and offered the home folder\'s .ssh');
  assert.deepEqual([row('server.pem').appOwned, row('server.pem').reason], [false, 'In “Vendor”, which is not where this kind of file belongs.'],
    'nor is a copy of ProgramData deeper on the drive a program data folder');
});

test('the API\'s appOwnedCount is declared where an agent reads it, beside the total/counts contract it leaves true (H05)', async () => {
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const section = agents.slice(agents.indexOf('`GET /api/security/findings`'), agents.indexOf('`GET /api/provenance?path=`'));
  assert.match(section, /`total` and `counts` cover every finding/, 'control: the contract stands');
  assert.match(section, /`appOwnedCount`[^.]*every finding/, 'AGENTS.md names the count, over every finding');
  const flat = section.replace(/\s+/g, ' ');
  assert.match(flat, /a program's data folders \(`Library\/Application Support`, `Library\/Containers`, `AppData`\)/, 'AGENTS.md says a program\'s data folders are app-owned too (review F1.3)');
  assert.match(flat, /package folders \(`node_modules`, `site-packages`\)/, 'and its package folders');
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const said = JSON.stringify((buildOpenApiDocument() as { paths: Record<string, unknown> }).paths['/api/security/findings']);
  assert.match(said, /appOwnedCount/, 'the OpenAPI document declares it');
  assert.doesNotMatch(said, /ship inside/, 'never as files that ship inside a program: a program\'s data folder is app-owned too (review F1.3)');
  assert.match(said, /keeps for itself \(a program, its data or its packages\)/, 'but as what they are');
});

test('each cloud credential file is offered the folder its own provider keeps it in, never another provider\'s (hunt C66)', () => {
  const at = path.join(HOME, 'Downloads');
  const offered = Object.fromEntries(findingsFor([file('credentials', at), file('gcloud-credentials.json', at), file('azureprofile.json', at)])
    .map((f) => [path.basename(f.path), f.suggestedPath]));
  assert.deepEqual(offered, {
    credentials: path.join(HOME, '.aws'),
    'gcloud-credentials.json': path.join(HOME, '.config', 'gcloud'),
    'azureprofile.json': path.join(HOME, '.azure'),
  });
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /only an SSH\s+key carries a `suggestedPath`/, 'AGENTS.md no longer says only an SSH key is offered a move');
});
