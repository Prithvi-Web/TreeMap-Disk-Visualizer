import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate notes.json (and everything else) from the user's real app data.
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-notes-test-');
process.env.TREEMAP_NO_GDU = '1';

import {
  listNotes,
  getNote,
  setNote,
  deleteNote,
  suppressedNoteRoots,
  isUnderAny,
  NOTE_MAX_CHARS,
  MAX_NOTES,
} from '../src/services/notes';
import { collectCleanupSuggestions } from '../src/services/cleanupRules';
import { approvePolicyForTests, listPolicies, runPolicy, savePolicies, simulatePolicy } from '../src/services/autopilot';
import { setTrashStepForTests } from '../src/services/cleaner';
import { initPortableMode, resetPortableMode } from '../src/services/portableMode';
import { createApp } from '../src/server';
import { peekScan } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';
import { CompiledIgnore } from '../src/utils/glob';

/**
 * v4 §9.5 — Notes pinned to folders.
 *
 * A note is the user telling the machine "this folder means something" —
 * "client archive, keep until 2027". The tests that matter are therefore not
 * the CRUD (though it is covered) but the promise attached to it: a noted
 * folder is excluded from Smart suggestions and from Autopilot matching by
 * default, and the exclusion is toggleable per note. A note must also survive
 * exactly as typed — it is rendered with textContent, never as HTML, so the
 * server must not "helpfully" alter or interpret it — and in a read-only
 * portable session it must never reach any disk.
 */

/* ------------------------ helpers ------------------------ */

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Scans `root` through POST /api/scan and returns the scan's id once the scan
 * has completed. The scan runs in this process, so its own record says when it
 * settles; peekScan reads it without counting as a use of the scan. Polling
 * GET /api/scan/:id/result for that instead spent the strict "api" rate-limit
 * lane (20 burst, 10/s) that the test's own next requests draw on, against a
 * 10 s deadline: with every core of this Mac busy the fixture scan outlived it
 * and two tests failed "fixture scan never completed" (24 Sep 2026). The wait's
 * limit is a hang guard; the assertion after it is what proves completion.
 */
async function scannedFixture(port: number, root: string): Promise<string> {
  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, `scan refused: ${JSON.stringify(started.body)}`);
  const scanId = started.body.scanId as string;
  await waitFor(() => peekScan(scanId)?.status !== 'running', `the fixture scan ${scanId} settling`);
  const settled = peekScan(scanId);
  assert.equal(
    settled?.status,
    'complete',
    `the fixture scan never completed: ${settled ? `it ended '${settled.status}': ${settled.error}` : 'it is not registered'}`,
  );
  return scanId;
}

/** Remove every note so tests cannot see each other's state. */
async function clearNotes() {
  for (const n of await listNotes()) await deleteNote(n.path);
}

/* Fixture-tree helpers, in the cleanupRules.test.ts style. */
const ROOT = path.resolve(path.sep, 'scanroot');
let uid = 0;
function file(name: string, size = 4096, at = ROOT): FileNode {
  return {
    name, path: path.join(at, name), size, type: 'file', modifiedAt: Date.now(),
    isHidden: name.startsWith('.'), extension: (name.split('.').pop() || '').toLowerCase(),
  };
}
function dir(name: string, children: FileNode[], at = ROOT): FileNode {
  const here = path.join(at, name);
  const rebased = children.map((c) => rebase(c, here));
  return {
    name, path: here, type: 'dir', modifiedAt: 0, isHidden: name.startsWith('.'),
    size: rebased.reduce((s, c) => s + c.size, 0), children: rebased,
  };
}
function rebase(node: FileNode, parent: string): FileNode {
  const here = path.join(parent, node.name);
  if (node.type === 'file') return { ...node, path: here };
  const kids = (node.children || []).map((c) => rebase(c, here));
  return { ...node, path: here, children: kids, size: kids.reduce((s, c) => s + c.size, 0) };
}
function tree(children: FileNode[], rootPath = ROOT): FileNode {
  const kids = children.map((c) => rebase(c, rootPath));
  return {
    name: path.basename(rootPath) || rootPath, path: rootPath, type: 'dir', modifiedAt: 0,
    isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids,
  };
}
function pkg(name: string, bytes = 10_000): FileNode {
  return dir(name, [file(`payload-${uid++}.bin`, bytes)]);
}
const NO_IGNORE: CompiledIgnore[] = [];

async function mkTmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-notes-fx-'));
}
async function writeBin(p: string, bytes: number): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.alloc(bytes, 7));
}

/* ══════════════════════ The service ══════════════════════ */

test('a note round-trips exactly as typed, and suppresses by default', async () => {
  await clearNotes();
  const target = path.join(os.homedir(), 'client-archive');
  const saved = await setNote(target, 'client archive, keep until 2027');
  assert.equal(saved.text, 'client archive, keep until 2027');
  assert.equal(saved.suppress, true, 'a noted folder is excluded from suggestions by default (§9.5)');
  assert.ok(saved.createdMs > 0 && saved.updatedMs >= saved.createdMs);

  const back = await getNote(target);
  assert.ok(back, 'the note is readable back');
  assert.equal(back!.text, 'client archive, keep until 2027');
  await clearNotes();
});

test('hostile note text is stored and returned verbatim — the server never interprets it', async () => {
  // The XSS corpus. Rendering these inert is the frontend's textContent rule;
  // the server's half of the contract is byte-exact storage, because any
  // "sanitising" here would silently rewrite what the user wrote.
  await clearNotes();
  const corpus = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg/onload=alert(1)>',
    "'; DROP TABLE notes; --",
    'plain text with <b>angle brackets</b> & ampersands',
    'unicode ‮override and emoji 📁',
  ];
  for (let i = 0; i < corpus.length; i++) {
    const p = path.join(os.homedir(), `xss-fixture-${i}`);
    const saved = await setNote(p, corpus[i]);
    assert.equal(saved.text, corpus[i], `corpus[${i}] must survive byte-for-byte`);
    const back = await getNote(p);
    assert.equal(back!.text, corpus[i]);
  }
  await clearNotes();
});

test('updating a note keeps its creation time and can lift the suppression', async () => {
  await clearNotes();
  const target = path.join(os.homedir(), 'projects');
  const first = await setNote(target, 'v1');
  await new Promise((r) => setTimeout(r, 5));
  const second = await setNote(target, 'v2', false);
  assert.equal(second.createdMs, first.createdMs, 'an update is not a new note');
  assert.ok(second.updatedMs >= first.updatedMs);
  assert.equal(second.suppress, false, 'the per-note toggle is honoured');
  // An update that does not mention suppress keeps the existing choice.
  const third = await setNote(target, 'v3');
  assert.equal(third.suppress, false, 'silence means "keep my choice", not "reset to default"');
  assert.equal((await listNotes()).length, 1);
  await clearNotes();
});

test('empty text and over-long text are refused with their own codes', async () => {
  await clearNotes();
  const target = path.join(os.homedir(), 'somewhere');
  await assert.rejects(setNote(target, '   '), (e: any) => e.code === 'NOTE_EMPTY');
  await assert.rejects(setNote(target, 'x'.repeat(NOTE_MAX_CHARS + 1)), (e: any) => e.code === 'NOTE_TOO_LONG');
  assert.equal((await listNotes()).length, 0, 'nothing was stored');
  await clearNotes();
});

test('the note store refuses to grow past its cap, naming it — updates still work at the cap', async () => {
  await clearNotes();
  for (let i = 0; i < MAX_NOTES; i++) {
    await setNote(path.join(os.homedir(), `note-cap-${i}`), `n${i}`);
  }
  await assert.rejects(
    setNote(path.join(os.homedir(), 'one-too-many'), 'x'),
    (e: any) => e.code === 'NOTES_FULL' && String(e.message).includes(String(MAX_NOTES)),
  );
  // A full store still lets you edit what is already there.
  const edited = await setNote(path.join(os.homedir(), 'note-cap-0'), 'edited');
  assert.equal(edited.text, 'edited');
  await clearNotes();
});

test('suppressedNoteRoots returns only the notes that suppress', async () => {
  await clearNotes();
  const a = path.join(os.homedir(), 'suppress-me');
  const b = path.join(os.homedir(), 'just-a-label');
  await setNote(a, 'keep');
  await setNote(b, 'label only', false);
  const roots = await suppressedNoteRoots();
  assert.ok(roots.some((r) => r === path.resolve(a)));
  assert.ok(!roots.some((r) => r === path.resolve(b)));
  await clearNotes();
});

test('isUnderAny respects path boundaries — /a/bc is not under /a/b', () => {
  const root = path.join(path.sep, 'a', 'b');
  assert.equal(isUnderAny(path.join(path.sep, 'a', 'b'), [root]), true, 'the folder itself counts');
  assert.equal(isUnderAny(path.join(path.sep, 'a', 'b', 'c.txt'), [root]), true, 'children count');
  assert.equal(isUnderAny(path.join(path.sep, 'a', 'bc'), [root]), false, 'a sibling sharing a prefix does not');
  assert.equal(isUnderAny(path.join(path.sep, 'a'), [root]), false, 'a parent does not');
  assert.equal(isUnderAny(path.join(path.sep, 'a', 'b'), []), false, 'no roots, no match');
});

/* ══════════════════════ Suggestion suppression ══════════════════════ */

test('a suppressing note removes a folder and everything under it from Smart suggestions', () => {
  // Without the note: node_modules under projects/site is suggested.
  const fixture = () => tree([dir('projects', [dir('site', [pkg('node_modules')])])]);
  const before = collectCleanupSuggestions(fixture(), NO_IGNORE, undefined, undefined, []);
  assert.ok(
    before.some((g) => g.id === 'regen-node-modules'),
    'the fixture fires the rule when nothing suppresses it — otherwise this test proves nothing',
  );

  // With the note on an ancestor: the same tree yields no suggestion for it.
  const noted = path.join(ROOT, 'projects');
  const after = collectCleanupSuggestions(fixture(), NO_IGNORE, undefined, undefined, [noted]);
  assert.ok(
    !after.some((g) => g.id === 'regen-node-modules'),
    'a note on projects/ silences suggestions for the node_modules inside it',
  );
});

test('a note on an unrelated folder changes nothing', () => {
  const fixture = tree([dir('projects', [pkg('node_modules')]), dir('media', [file('a.mp4', 5000)])]);
  const groups = collectCleanupSuggestions(fixture, NO_IGNORE, undefined, undefined, [path.join(ROOT, 'media')]);
  assert.ok(groups.some((g) => g.id === 'regen-node-modules'), 'the note only covers its own subtree');
});

test('GET /api/cleanup/suggestions honours a suppressing note end to end', async () => {
  await clearNotes();
  const fx = await mkTmp();
  const { port, close } = await listen();
  try {
    await writeBin(path.join(fx, 'work', 'node_modules', 'dep', 'a.bin'), 8192);

    // The scan runs in the background; suggestions answer 202 until it lands.
    const scanId = await scannedFixture(port, fx);

    const before = await req(port, 'GET', `/api/cleanup/suggestions?scanId=${scanId}`);
    assert.equal(before.status, 200);
    assert.ok(
      (before.body.groups as any[]).some((g) => g.id === 'regen-node-modules'),
      'without a note the suggestion is there',
    );

    const put = await req(port, 'PUT', '/api/notes', { path: path.join(fx, 'work'), text: 'client work, keep' });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const after = await req(port, 'GET', `/api/cleanup/suggestions?scanId=${scanId}`);
    assert.equal(after.status, 200);
    assert.ok(
      !(after.body.groups as any[]).some((g) => g.id === 'regen-node-modules'),
      'the note silences the suggestion over HTTP too',
    );
  } finally {
    await close();
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

/* ══════════════════════ Autopilot suppression ══════════════════════ */

test('Autopilot skips a noted folder and says why — for rule matches', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    await writeBin(path.join(fx, 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    const [policy] = await savePolicies([{
      id: 'note-suppress-rule', name: 'p', path: fx,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);

    // Without a note, the first (dry) run matches the node_modules.
    const before = await simulatePolicy(policy);
    assert.ok(before.items.length > 0, 'the fixture matches when nothing suppresses it');

    await setNote(path.join(fx, 'project'), 'client project — keep');
    const after = await simulatePolicy(policy);
    assert.equal(after.items.length, 0, 'a noted folder is never matched');
    const noteSkips = after.skipped.filter((s) => /note/i.test(s.reason));
    assert.equal(noteSkips.length, 1, `one collapsed entry per note root — got ${JSON.stringify(after.skipped)}`);
    assert.ok(noteSkips[0].path.endsWith('project'), 'anchored on the noted folder itself');
    assert.match(noteSkips[0].reason, /1 matched item/, 'and it counts what it covered');
  } finally {
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('Autopilot skips a noted folder for custom matches too', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    await writeBin(path.join(fx, 'archive', 'big.bin'), 200_000);
    const [policy] = await savePolicies([{
      id: 'note-suppress-custom', name: 'p', path: fx,
      match: { kind: 'custom', minBytes: 1 },
      dryRunFirst: false, enabled: true,
    }]);

    await setNote(path.join(fx, 'archive'), 'do not touch');
    const run = await simulatePolicy(policy);
    assert.ok(!run.items.some((i) => i.path.includes('big.bin')), 'the noted file is not in the match');
    const noteSkips = run.skipped.filter((s) => /note/i.test(s.reason));
    assert.equal(noteSkips.length, 1, 'one collapsed entry per note root');
    assert.ok(noteSkips[0].path.endsWith('archive'), 'anchored on the noted folder');
    assert.match(noteSkips[0].reason, /1 matched item/);
  } finally {
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a run that left everything it matched alone says why — paused by a note, a part of an installed program, or both — never "Nothing matched this time." (review F1.2)', async () => {
  await clearNotes();
  const fx = await mkTmp();
  const trashed: string[] = [];
  setTrashStepForTests(async (p) => { trashed.push(p); });
  try {
    await writeBin(path.join(fx, 'archive', 'big.bin'), 200_000);
    await setNote(path.join(fx, 'archive'), 'do not touch');
    const run = async (id: string): Promise<string | undefined> => {
      await savePolicies([{ id, name: 'p', path: fx, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
      await approvePolicyForTests(id);
      const result = await runPolicy((await listPolicies())[0]);
      assert.deepEqual(result.items, [], `${id}: control: nothing is selected`);
      return result.blockedReason;
    };
    assert.equal(await run('noted-only'), 'Everything that matched is paused by your notes — nothing was deleted.', 'paused by a note');
    await writeBin(path.join(fx, 'Fake.app', 'Contents', 'MacOS', 'Fake'), 200_000);
    assert.equal(await run('noted-and-app'), 'Everything that matched is paused by your notes or part of an installed program — nothing was deleted.', 'both');
    assert.deepEqual(trashed, [], 'nothing reached the Trash step');
  } finally {
    setTrashStepForTests(null);
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a note with suppression turned off changes nothing anywhere', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    await writeBin(path.join(fx, 'project', 'node_modules', 'dep', 'a.bin'), 4096);
    await setNote(path.join(fx, 'project'), 'label only', false);
    const [policy] = await savePolicies([{
      id: 'note-label-only', name: 'p', path: fx,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    const run = await simulatePolicy(policy);
    assert.ok(run.items.length > 0, 'a label-only note does not block matching');
  } finally {
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

/* ══════════════════════ The routes ══════════════════════ */

test('PUT / GET / DELETE /api/notes round-trip, with paths sanitized', async () => {
  await clearNotes();
  const { port, close } = await listen();
  try {
    const target = path.join(os.homedir(), 'route-note-fixture');
    const put = await req(port, 'PUT', '/api/notes', { path: target, text: 'hello', suppress: false });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.note.text, 'hello');
    assert.equal(put.body.note.suppress, false);

    const list = await req(port, 'GET', '/api/notes');
    assert.equal(list.status, 200);
    assert.ok((list.body.notes as any[]).some((n) => n.text === 'hello'));

    const del = await req(port, 'DELETE', `/api/notes?path=${encodeURIComponent(target)}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.existed, true);

    const empty = await req(port, 'GET', '/api/notes');
    assert.equal((empty.body.notes as any[]).length, 0);
  } finally {
    await close();
    await clearNotes();
  }
});

test('the notes routes refuse bad input with stable codes', async () => {
  const { port, close } = await listen();
  try {
    const noPath = await req(port, 'PUT', '/api/notes', { text: 'x' });
    assert.equal(noPath.status, 400);

    const nulByte = await req(port, 'PUT', '/api/notes', { path: 'a\u0000b', text: 'x' });
    assert.equal(nulByte.status, 400);
    assert.equal(nulByte.body.code, 'PATH_INVALID');

    const empty = await req(port, 'PUT', '/api/notes', { path: os.homedir(), text: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'NOTE_EMPTY');

    const tooLong = await req(port, 'PUT', '/api/notes', { path: os.homedir(), text: 'x'.repeat(NOTE_MAX_CHARS + 1) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, 'NOTE_TOO_LONG');

    const delNoPath = await req(port, 'DELETE', '/api/notes');
    assert.equal(delNoPath.status, 400);

    const notString = await req(port, 'PUT', '/api/notes', { path: os.homedir(), text: 42 });
    assert.equal(notString.status, 400);
  } finally {
    await close();
  }
});

/* ══════════════════════ Portable mode ══════════════════════ */

const NO_CHMOD = process.platform === 'win32'
  ? 'chmod cannot make a directory read-only on Windows'
  : process.getuid?.() === 0
    ? 'root may write anywhere: chmod cannot make a directory read-only for root'
    : false;

test('a read-only portable session keeps notes in memory only', { skip: NO_CHMOD }, async () => {
  await clearNotes();
  const roBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-notes-ro-'));
  const roDir = path.join(roBase, 'ro');
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o500);
  try {
    resetPortableMode();
    const status = initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(roDir, 'TreeMap-Data') } as NodeJS.ProcessEnv);
    assert.equal(status.writable, false, 'the fixture really is read-only');

    const notesFile = path.join(process.env.TREEMAP_DATA_DIR!, 'notes.json');
    const diskBefore = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null;

    await setNote(path.join(os.homedir(), 'ephemeral'), 'session-only note');
    const back = await getNote(path.join(os.homedir(), 'ephemeral'));
    assert.equal(back?.text, 'session-only note', 'the session still remembers, in memory');

    const diskAfter = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null;
    assert.equal(diskAfter, diskBefore, 'nothing reached any disk file');
  } finally {
    fs.chmodSync(roDir, 0o700);
    fs.rmSync(roBase, { recursive: true, force: true });
    resetPortableMode();
  }
});

/* ══════════════════════ Frontend structural contract ══════════════════════ */

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('the note editor exists, is modal, and caps its text at the server limit', () => {
  assert.ok(INDEX_HTML.includes('id="noteModal"'), 'the note modal exists');
  const tag = INDEX_HTML.slice(INDEX_HTML.indexOf('id="noteModal"') - 200, INDEX_HTML.indexOf('id="noteModal"') + 200);
  assert.match(tag, /aria-modal="true"/, 'announced as modal');
  assert.ok(INDEX_HTML.includes(`maxlength="${NOTE_MAX_CHARS}"`), 'the textarea cap matches NOTE_MAX_CHARS');
  assert.ok(INDEX_HTML.includes('id="noteSuppress"'), 'the per-note suppression toggle exists');
});

test('note text only ever reaches markup through escapeHtml, and the editor through .value', () => {
  // The server stores hostile text verbatim (asserted above), so the frontend
  // must be the layer that keeps it inert. Two sinks exist: the tooltip line
  // (innerHTML — must escape) and the editor textarea (.value — inert).
  const start = INDEX_HTML.indexOf('function noteTooltipLine');
  assert.notEqual(start, -1, 'noteTooltipLine exists');
  const fn = INDEX_HTML.slice(start, INDEX_HTML.indexOf('\n}', start));
  assert.match(fn, /escapeHtml\(/, 'the tooltip escapes the note text');
  assert.ok(!/\$\{(?:n\.text|brief)\}/.test(fn), 'no bare interpolation of the text');
  assert.match(INDEX_HTML, /\$\('noteText'\)\.value = existing \? existing\.text : ''/, 'the editor fills via .value, an inert sink');
  assert.match(INDEX_HTML, /\$\('noteFolderName'\)\.textContent/, 'the folder name renders via textContent');
});

test('folders can be noted from the context menu and the keyboard', () => {
  assert.match(INDEX_HTML, /data-act="note"/, 'the context menu offers the note editor');
  assert.match(INDEX_HTML, /act === 'note'\) openNoteDialog\(ctxTarget\)/, 'and it opens the dialog');
  assert.match(INDEX_HTML, /case 'n': if \(state\.treemap\.kbSel && state\.treemap\.kbSel\.type === 'dir'/, "the treemap's n key opens it too");
  assert.ok(INDEX_HTML.includes('<kbd>n</kbd>'), 'and the shortcuts panel says so');
});

test('the treemap paints a glyph for noted folders, and the tooltip explains the pause', () => {
  const present = INDEX_HTML.slice(INDEX_HTML.indexOf('function presentTreemap('), INDEX_HTML.indexOf('function presentTreemap(') + 6000);
  assert.match(present, /state\.notes\.has\(pr\.n\.path\)/, 'the glyph pass reads the notes map');
  const tipFn = INDEX_HTML.slice(INDEX_HTML.indexOf('function noteTooltipLine'), INDEX_HTML.indexOf('function noteTooltipLine') + 900);
  assert.match(tipFn, /suggestions paused here/, 'a suppressing note says what it is doing');
});

test('the tooltip truncates note text by code points, never through an emoji', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function noteTooltipLine'), html.indexOf('function noteTooltipLine') + 900);
  assert.match(fn, /\[\.\.\.n\.text\]/, 'truncation walks code points, so no lone surrogates render as �');
});

/* ═══════════ The fleet's findings (backend review, round 1) ═══════════ */

test('a matched folder CONTAINING a noted keeper is never suggested — reverse containment', () => {
  // Review finding 1: "is the candidate under a note?" is only half the
  // promise. A node_modules holding a noted keep-me must not be offered
  // whole — deleting it deletes the very thing the user said to keep.
  const fixture = () => tree([dir('projects', [dir('site', [
    dir('node_modules', [file('payload.bin', 9000), dir('keep-me', [file('patch.js', 500)])]),
  ])])]);
  const keeper = path.join(ROOT, 'projects', 'site', 'node_modules', 'keep-me');
  const before = collectCleanupSuggestions(fixture(), NO_IGNORE, undefined, undefined, []);
  assert.ok(before.some((g) => g.id === 'regen-node-modules'), 'the fixture fires without the note');
  const after = collectCleanupSuggestions(fixture(), NO_IGNORE, undefined, undefined, [keeper]);
  const nm = after.find((g) => g.id === 'regen-node-modules');
  assert.ok(
    !nm || !nm.items.some((i) => i.path.endsWith('node_modules')),
    'the ancestor that contains the keeper is withheld',
  );
});

test('Autopilot refuses a match that contains a noted keeper, and says so', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    await writeBin(path.join(fx, 'proj', 'node_modules', 'dep', 'a.bin'), 4096);
    await writeBin(path.join(fx, 'proj', 'node_modules', 'keep-me', 'patch.js'), 512);
    await setNote(path.join(fx, 'proj', 'node_modules', 'keep-me'), 'hand-patched — keep');
    const [policy] = await savePolicies([{
      id: 'note-reverse', name: 'p', path: fx,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    const sim = await simulatePolicy(policy);
    assert.ok(!sim.items.some((i) => i.path.endsWith('node_modules')), 'the containing folder is not deletable');
    assert.ok(
      sim.skipped.some((s) => /note/i.test(s.reason) && /keep-me|contains/i.test(s.reason + s.path)),
      `the refusal is stated — got ${JSON.stringify(sim.skipped)}`,
    );
  } finally {
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a suppressing note pauses Autopilot whichever spelling of the folder the policy or the note uses — through a link in the parents, or the folder it leads to (the final review, F1.13)', { skip: process.platform === 'win32' && 'making a link needs a privilege the runner may not hold' }, async () => {
  // Both sides were compared as folded text: a policy whose folder was typed through a link reached
  // the noted folder's files by a spelling the note's text did not start with, and the unattended
  // deleter selected them.
  await clearNotes();
  const fx = fs.realpathSync(await mkTmp());
  try {
    await writeBin(path.join(fx, 'real', 'sub', 'keep', 'a.log'), 2000);
    await writeBin(path.join(fx, 'real', 'sub', 'other', 'b.log'), 2000);
    fs.symlinkSync(path.join(fx, 'real'), path.join(fx, 'lnk'));
    const wouldDelete = async (where: string): Promise<string[]> => {
      const [policy] = await savePolicies([{
        id: 'note-link', name: 'p', path: where,
        match: { kind: 'custom', exts: ['log'], minBytes: 1 },
        dryRunFirst: false, enabled: true,
      }]);
      return (await simulatePolicy(policy)).items.map((i) => path.relative(where, i.path)).sort();
    };
    await setNote(path.join(fx, 'real', 'sub', 'keep'), 'do not clean this', true);
    const answers: Record<string, string[]> = {
      'note on the folder, policy typed through the link': await wouldDelete(path.join(fx, 'lnk', 'sub')),
      'note on the folder, policy on the folder': await wouldDelete(path.join(fx, 'real', 'sub')),
    };
    await clearNotes();
    await setNote(path.join(fx, 'lnk', 'sub', 'keep'), 'do not clean this', true);
    answers['note typed through the link, policy on the folder'] = await wouldDelete(path.join(fx, 'real', 'sub'));
    await clearNotes();
    await setNote(path.join(fx, 'real'), 'none of this', true);
    answers['note on a folder holding the policy folder, policy typed through the link'] = await wouldDelete(path.join(fx, 'lnk', 'sub'));
    const onlyOther = [path.join('other', 'b.log')];
    assert.deepEqual(answers, {
      'note on the folder, policy typed through the link': onlyOther,
      'note on the folder, policy on the folder': onlyOther,
      'note typed through the link, policy on the folder': onlyOther,
      'note on a folder holding the policy folder, policy typed through the link': [],
    });
  } finally {
    await savePolicies([]);
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a suppressing note typed through a link silences Smart suggestions for the folder the scan lists by its own path (the final review, F1.13)', { skip: process.platform === 'win32' && 'making a link needs a privilege the runner may not hold' }, async () => {
  const fx = fs.realpathSync(await mkTmp());
  try {
    await fsp.mkdir(path.join(fx, 'real', 'proj'), { recursive: true });
    fs.symlinkSync(path.join(fx, 'real'), path.join(fx, 'lnk'));
    const fixture = () => tree([dir('proj', [pkg('node_modules')])], path.join(fx, 'real'));
    const fires = (noted: string[]) => collectCleanupSuggestions(fixture(), NO_IGNORE, undefined, undefined, noted).some((g) => g.id === 'regen-node-modules');
    assert.deepEqual(
      { 'no note': fires([]), 'a note on lnk/proj': fires([path.join(fx, 'lnk', 'proj')]), 'a note on lnk/proj/node_modules/x, inside it': fires([path.join(fx, 'lnk', 'proj', 'node_modules', 'x')]) },
      { 'no note': true, 'a note on lnk/proj': false, 'a note on lnk/proj/node_modules/x, inside it': false },
    );
  } finally {
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a corrupt notes.json fails CLOSED — automation refuses rather than running unsuppressed', async () => {
  // Review finding 2: a note that suppresses is a guard rail on unattended
  // deletion. A file that cannot be read must pause automation, never
  // silently switch every pause off.
  await clearNotes();
  const fx = await mkTmp();
  const notesFile = path.join(process.env.TREEMAP_DATA_DIR!, 'notes.json');
  try {
    await writeBin(path.join(fx, 'proj', 'node_modules', 'dep', 'a.bin'), 4096);
    fs.writeFileSync(notesFile, '{ not json');

    await assert.rejects(suppressedNoteRoots(), (e: any) => e.code === 'NOTES_UNREADABLE');

    const [policy] = await savePolicies([{
      id: 'note-corrupt', name: 'p', path: fx,
      match: { kind: 'suggestion', groupIds: ['regen-node-modules'] },
      dryRunFirst: false, enabled: true,
    }]);
    await assert.rejects(simulatePolicy(policy), (e: any) => /note/i.test(String(e.message)));

    // The suggestions surface degrades with the reason instead of serving an
    // unsuppressed list.
    const { port, close } = await listen();
    try {
      const scanId = await scannedFixture(port, fx);
      const sug = await req(port, 'GET', `/api/cleanup/suggestions?scanId=${scanId}`);
      assert.equal(sug.status, 200);
      assert.equal(sug.body.available, false, 'degraded, not silently unsuppressed');
      assert.match(String(sug.body.reason), /note/i);
      // …and says which cause it is, so the page never blames a rule pack (review HD-L2/L6).
      assert.equal(sug.body.code, 'NOTES_UNREADABLE', 'the answer names its cause');
    } finally {
      await close();
    }
  } finally {
    await savePolicies([]);
    fs.rmSync(notesFile, { force: true });
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('a corrupt notes.json is never written over — listing, saving and removing a note refuse with the reason, and every pause it held still holds (hunt C05)', async () => {
  // The hunt (C05): load() fell back to an empty list on a parse error, so
  // GET /api/notes answered [] and the next save rewrote the file with that
  // one note — every earlier pause lifted, and Autopilot ran inside those
  // folders again. An unreadable file must be kept, and said.
  await clearNotes();
  const notesFile = path.join(process.env.TREEMAP_DATA_DIR!, 'notes.json');
  const garbage = '{ "notes": [ { "path": "/a", "text": "keep", "suppress": true }, TRUNCATED';
  try {
    fs.writeFileSync(notesFile, garbage);
    await assert.rejects(listNotes(), (e: any) => e.code === 'NOTES_UNREADABLE' && /nothing is written over/i.test(e.message));
    await assert.rejects(setNote(path.join(os.homedir(), 'other'), 'new note'), (e: any) => e.code === 'NOTES_UNREADABLE');
    await assert.rejects(deleteNote('/a'), (e: any) => e.code === 'NOTES_UNREADABLE');
    assert.equal(fs.readFileSync(notesFile, 'utf8'), garbage, 'the unreadable file is kept exactly as it was');
    await assert.rejects(suppressedNoteRoots(), (e: any) => e.code === 'NOTES_UNREADABLE', 'the pauses still hold');

    const { port, close } = await listen();
    try {
      const got = await req(port, 'GET', '/api/notes');
      assert.equal(got.status, 500);
      assert.equal(got.body.code, 'NOTES_UNREADABLE', 'never an empty list');
      const put = await req(port, 'PUT', '/api/notes', { path: path.join(os.homedir(), 'other'), text: 'x' });
      assert.equal(put.body.code, 'NOTES_UNREADABLE');
      assert.equal(fs.readFileSync(notesFile, 'utf8'), garbage, 'the route wrote nothing over it either');
    } finally {
      await close();
    }
  } finally {
    fs.rmSync(notesFile, { force: true });
    for (const f of fs.readdirSync(process.env.TREEMAP_DATA_DIR!)) {
      if (f.startsWith('notes.json.corrupt')) fs.rmSync(path.join(process.env.TREEMAP_DATA_DIR!, f), { force: true });
    }
  }
});

test('a notes.json that parses but is not the store TreeMap writes is unreadable too: its pauses hold, it is kept and copied aside, never read as "no notes" or written over (review F1.8)', async () => {
  await clearNotes();
  const dataDir = process.env.TREEMAP_DATA_DIR!;
  const notesFile = path.join(dataDir, 'notes.json');
  const copies = (): string[] => fs.readdirSync(dataDir).filter((f) => f.startsWith('notes.json.corrupt')).map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8'));
  const shapes = [
    '[{"path":"/Users/x/archive","text":"keep","suppress":true}]', // a bare list
    'null',
    '"notes"',
    '{"notes":{"path":"/Users/x/archive","text":"keep","suppress":true}}', // one note, not a list
    '{"notes":[{"path":"/Users/x/archive","suppress":true}]}', // a pausing row with no text
    '{"notes":[{"text":"keep","suppress":true}]}', // a row with no path
    '{"note":[{"path":"/Users/x/archive","text":"keep","suppress":true}]}', // a misspelt key
  ];
  try {
    for (const raw of shapes) {
      fs.writeFileSync(notesFile, raw);
      await assert.rejects(suppressedNoteRoots(), (e: any) => e.code === 'NOTES_UNREADABLE', `the pauses still hold: ${raw}`);
      await assert.rejects(listNotes(), (e: any) => e.code === 'NOTES_UNREADABLE', `never "no notes": ${raw}`);
      await assert.rejects(setNote(path.join(os.homedir(), 'other'), 'new note'), (e: any) => e.code === 'NOTES_UNREADABLE', raw);
      await assert.rejects(deleteNote('/Users/x/archive'), (e: any) => e.code === 'NOTES_UNREADABLE', raw);
      assert.equal(fs.readFileSync(notesFile, 'utf8'), raw, `kept exactly as it was: ${raw}`);
      assert.ok(copies().includes(raw), `and copied aside: ${raw}`);
    }
    // Control: an absent file and the store TreeMap writes still read.
    fs.writeFileSync(notesFile, JSON.stringify({ notes: [{ path: '/Users/x/archive', text: 'keep', suppress: true, createdMs: 1, updatedMs: 1 }] }));
    assert.deepEqual((await listNotes()).map((n) => n.path), ['/Users/x/archive']);
    fs.rmSync(notesFile, { force: true });
    assert.deepEqual(await listNotes(), []);
  } finally {
    fs.rmSync(notesFile, { force: true });
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('notes.json.corrupt')) fs.rmSync(path.join(dataDir, f), { force: true });
    }
  }
});

test('after notes that could not be read, the note sheet reads them again before it opens — never blank over a note the page never saw — and does not open while they still cannot be read (review F1.18)', async () => {
  const at = INDEX_HTML.indexOf('function noteFor(path)');
  const src = INDEX_HTML.slice(at, INDEX_HTML.indexOf('async function commitNote', at));
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ??= { value: '', checked: false, textContent: '', title: '', style: { display: 'none' }, opened: 0, classList: { add() { els[id].opened++; } }, focus() {} });
  const answers: Array<() => Promise<unknown>> = [];
  const toasts: string[] = [];
  const unreadable = () => Promise.reject(Object.assign(new Error('notes.json could not be read'), { code: 'NOTES_UNREADABLE' }));
  const state = { notes: new Map() };
  const page = new Function('$', 'state', 'api', 'toast', 'setTimeout', `${src}; return { loadNotes, openNoteDialog };`)(
    $, state, () => answers.shift()!(), (m: string) => toasts.push(m), () => undefined,
  ) as { loadNotes: () => Promise<unknown>; openNoteDialog: (n: unknown) => Promise<void> };
  const folder = { path: '/Users/x/archive', name: 'archive' };

  answers.push(unreadable);
  await page.loadNotes();
  assert.equal(toasts.length, 1, 'control: the boot read failed and said why');

  answers.push(unreadable);
  await page.openNoteDialog(folder);
  assert.equal($('noteModal').opened, 0, 'still unreadable: the sheet does not open, so Save cannot write over a note it never showed');
  assert.deepEqual(toasts.slice(1), ['notes.json could not be read'], 'and says why again (review HD-L12)');

  // Any other failed read — the server not answering — keeps the sheet shut too, and says why (review HD-L12).
  answers.push(() => Promise.reject(new Error('Failed to fetch')));
  await page.openNoteDialog(folder);
  assert.equal($('noteModal').opened, 0, 'a read that failed for any reason: the sheet does not open');
  assert.deepEqual(toasts.slice(2), ['Could not read your notes: Failed to fetch'], 'and it says why, once');

  answers.push(async () => ({ notes: [{ path: folder.path, text: 'client archive, keep', suppress: false }] }));
  await page.openNoteDialog(folder);
  assert.equal($('noteModal').opened, 1, 'repaired: the sheet opens');
  assert.equal($('noteText').value, 'client archive, keep', 'with the note the page now has');
  assert.equal($('noteSuppress').checked, false, 'and its pause choice');
  assert.equal($('noteRemoveBtn').style.display, '', 'and Remove offered');
  await page.openNoteDialog(folder);
  assert.equal($('noteModal').opened, 2, 'read once repaired, the sheet opens again without asking again');
});

test('the page says why the notes could not be read, rather than booting with none (hunt C05)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app', '160-folder-budgets.js'), 'utf8');
  const body = src.slice(src.indexOf('async function loadNotes'), src.indexOf('let noteTarget'));
  assert.match(body, /NOTES_UNREADABLE/, 'loadNotes tells an unreadable notes.json apart');
  assert.match(body, /toast\(e\.message, 'error'\)/, 'and says the server\'s reason');
});

test('cloud:// pseudo-paths are refused — a note there could never do its job', async () => {
  await assert.rejects(setNote('cloud://gdrive/Photos', 'keep'), (e: any) => e.code === 'NOTE_INVALID');
});

test('the agent summary respects notes — teeth for a wire the review found untested', async () => {
  await clearNotes();
  const fx = await mkTmp();
  const { port, close } = await listen();
  try {
    await writeBin(path.join(fx, 'work', 'node_modules', 'dep', 'a.bin'), 8192);
    const scanId = await scannedFixture(port, fx);
    const before = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    assert.equal(before.status, 200);
    const bytesBefore = before.body.cleanup?.reclaimableBytes ?? before.body.reclaimableBytes;
    assert.ok(bytesBefore > 0, `the summary advertises the node_modules before any note — got ${JSON.stringify(before.body).slice(0, 200)}`);

    await setNote(path.join(fx, 'work'), 'client work');
    const after = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const bytesAfter = after.body.cleanup?.reclaimableBytes ?? after.body.reclaimableBytes;
    assert.equal(bytesAfter, 0, 'a noted folder is not advertised to agents either');
  } finally {
    await close();
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('the suggestions surface names what a pausing note is hiding — never a silent absence', () => {
  // QA finding 8: "nothing matches" with folders quietly excluded reads as
  // good news. One honest line whenever a pausing note exists.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('const pausedNotes');
  assert.notEqual(at, -1, 'the surface counts pausing notes');
  const region = html.slice(at, at + 900);
  assert.match(region, /excluded by a note that pauses suggestions/, 'and says so, with the way back');
  assert.match(region, /n\.suppress/, 'label-only notes do not trigger the hint');
});

/* ══════════════════════ The hunt (C39, C61) ══════════════════════ */

import { createScanRecord } from '../src/services/diskScanner';
import { buildStoreFromTree } from '../src/services/scanStore';
import { shortlistFromScan } from '../src/services/compressionAdvisor';
import { emptyFoldersForScan } from '../src/services/emptyFolders';
import { notePausedTest, prepareSuppressed, suppressedRootCovering, noteRootInside } from '../src/services/notes';

test('a pausing note keeps its folder out of Package leftovers, as the note sheet promises (hunt C39, C61)', async () => {
  await clearNotes();
  const home = path.join(os.homedir(), 'tm-c39-fixture');
  const archive = path.join(home, 'archive');
  const stale = (at: string) => dir('node_modules', [file('.package-lock.json', 1, path.join(at, 'node_modules')), file('big.js', 3_000_000, path.join(at, 'node_modules'))], at);
  const root = tree([dir('archive', [dir('old', [stale(path.join(archive, 'old'))], archive)], home), dir('other', [stale(path.join(home, 'other'))], home)], home);
  const scan = createScanRecord(home);
  scan.store = buildStoreFromTree(root);
  scan.status = 'complete';
  const { port, close } = await listen();
  try {
    const before = await req(port, 'GET', `/api/packages/orphans?scanId=${scan.scanId}`);
    const listed = (b: any): string[] => (b.ecosystems ?? []).flatMap((g: any) => g.entries.map((e: any) => e.path));
    assert.ok(listed(before.body).some((p) => p.startsWith(archive)), `control: listed before the note: ${JSON.stringify(listed(before.body))}`);
    await setNote(archive, 'client archive, keep');
    const after = await req(port, 'GET', `/api/packages/orphans?scanId=${scan.scanId}`);
    assert.equal(after.status, 200);
    assert.deepEqual(listed(after.body).filter((p) => p.startsWith(archive)), [], 'nothing inside the paused folder is offered');
    assert.ok(listed(after.body).some((p) => p.startsWith(path.join(home, 'other'))), 'control: the other folder\'s leftover is still listed');
    const counted = (after.body.ecosystems ?? []).reduce((n: number, g: any) => n + g.orphanCount, 0);
    assert.equal(after.body.orphanCount, counted, 'the totals count what is listed');
  } finally {
    await close();
    await clearNotes();
  }
});

test('a pausing note keeps its folder out of Shrink video\'s shortlist and out of Empty folders (hunt C39)', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    const kept = path.join(fx, 'kept');
    const vids = [path.join(kept, 'a.mov'), path.join(fx, 'loose', 'b.mov')];
    const big = 200_000_000;
    const root = tree([dir('kept', [file('a.mov', big, kept)], fx), dir('loose', [file('b.mov', big, path.join(fx, 'loose'))], fx)], fx);
    await setNote(kept, 'keep these');
    const paused = await notePausedTest(fx);
    const shortlisted = shortlistFromScan(buildStoreFromTree(root), [], 10, paused).map((s) => s.path);
    assert.deepEqual(shortlisted, [vids[1]], 'only the video outside the paused folder is shortlisted');

    // Empty folders: one inside the paused folder, and an empty folder holding a paused empty one.
    for (const d of ['kept/empty', 'holder/paused-empty', 'free']) fs.mkdirSync(path.join(fx, d), { recursive: true });
    await setNote(path.join(fx, 'holder', 'paused-empty'), 'keep this empty folder');
    const real = fs.realpathSync(fx);
    const scan = createScanRecord(real);
    const empty = (name: string, at: string): FileNode => ({ name, path: path.join(at, name), type: 'dir', size: 0, modifiedAt: 0, isHidden: false, children: [] });
    const rRoot: FileNode = {
      name: path.basename(real), path: real, type: 'dir', size: 0, modifiedAt: 0, isHidden: false, children: [
        { ...empty('kept', real), children: [empty('empty', path.join(real, 'kept'))] },
        { ...empty('holder', real), children: [empty('paused-empty', path.join(real, 'holder'))] },
        empty('free', real),
      ],
    };
    scan.store = buildStoreFromTree(rRoot);
    scan.status = 'complete';
    const answer = await emptyFoldersForScan(scan, true, await notePausedTest(real));
    assert.deepEqual(answer.folders.map((f) => path.basename(f.path)), ['free'], `only the folder no note pauses: ${JSON.stringify(answer.folders)}`);
  } finally {
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

/* ══════════════════════ The review of the hunt fixes (F1.1, F1.3, F1.6, F1.7, F1.11, F1.12, F1.15) ══════════════════════ */

import { setMediaTools, type MediaTools } from '../src/services/compressionAdvisor';

test('a pausing note covers no cloud listing — not even a note over the folder the server runs in (review F1.3)', async () => {
  await clearNotes();
  try {
    await setNote(path.dirname(process.cwd()), 'over the server\'s own folder');
    const cloud = await notePausedTest('cloud://gdrive');
    assert.equal(cloud.covers('cloud://gdrive/Photos'), false, 'a cloud id is no path under the server\'s folder');
    assert.equal(cloud.covers('cloud://gdrive'), false);
    assert.equal(cloud.holds('cloud://gdrive'), false);
    const local = await notePausedTest(process.cwd());
    assert.equal(local.covers(path.join(process.cwd(), 'src')), true, 'control: the note covers local paths under it');
    assert.equal(local.covers('cloud://gdrive/Photos'), false, 'and no cloud id, whatever walk asks');
    // No note can pause a cloud listing, so a notes.json that cannot be read does not refuse one either.
    fs.writeFileSync(path.join(process.env.TREEMAP_DATA_DIR!, 'notes.json'), '{ not json');
    assert.equal((await notePausedTest('cloud://gdrive')).covers('cloud://gdrive/Photos'), false, 'a cloud listing is not refused for notes that cannot pause it');
  } finally {
    fs.rmSync(path.join(process.env.TREEMAP_DATA_DIR!, 'notes.json'), { force: true });
    for (const f of fs.readdirSync(process.env.TREEMAP_DATA_DIR!)) {
      if (f.startsWith('notes.json.corrupt')) fs.rmSync(path.join(process.env.TREEMAP_DATA_DIR!, f), { force: true });
    }
    await clearNotes();
  }
});

/*
 * F1.3 patched notePausedTest only. Smart suggestions — and so the agent summary and MCP
 * cleanup_suggestions — resolved cloud:// ids under the server's working folder, so a pausing note over
 * an ancestor of that folder emptied a cloud scan's suggestions (review HD-L4).
 */
test('Smart suggestions, the agent summary and MCP read no note into a cloud listing — not even one over the folder the server runs in (review HD-L4)', () => {
  const root = 'cloud://gdrive';
  const leaf = (name: string, rel: string, size: number, extension: string): FileNode =>
    ({ name, path: `${root}/${rel}`, type: 'file', modifiedAt: 0, isHidden: false, size, extension });
  const cloudTree: FileNode = {
    name: 'gdrive', path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: 1_000_000, children: [
      { name: 'node_modules', path: `${root}/node_modules`, type: 'dir', modifiedAt: 0, isHidden: false, size: 900_000, children: [leaf('a.js', 'node_modules/a.js', 900_000, 'js')] },
      leaf('package.json', 'package.json', 100_000, 'json'),
    ],
  };
  const ids = (noted: string[]) => collectCleanupSuggestions(buildStoreFromTree(cloudTree), NO_IGNORE, undefined, undefined, noted).map((g) => g.id);
  const none = ids([]);
  assert.ok(none.includes('regen-node-modules'), `control: the cloud listing has a suggestion: ${none.join(', ')}`);
  const overServer = path.dirname(process.cwd());
  assert.deepEqual(ids([overServer]), none, 'a note over the server\'s folder pauses nothing of a cloud listing');
  // The helpers every list uses, each asked about a cloud id.
  assert.deepEqual(prepareSuppressed([overServer], root), [], 'a walk of a cloud listing has no note to judge');
  assert.equal(suppressedRootCovering(`${root}/node_modules`, prepareSuppressed([overServer], root)), null, 'no note covers a cloud id');
  assert.equal(suppressedRootCovering(`${root}/node_modules`, prepareSuppressed([overServer], process.cwd())), null, 'whatever walk asks');
  assert.equal(noteRootInside(root, prepareSuppressed([path.resolve(`${root}/node_modules`)], process.cwd())), null, 'no note sits inside a cloud id');
  assert.equal(isUnderAny(`${root}/node_modules`, [overServer]), false, 'nor is a cloud id under any note');
  assert.equal(isUnderAny(path.join(process.cwd(), 'src'), [overServer]), true, 'control: a local path under the note is');
});

test('Empty folders judges the pause before its cap and its count: a free folder past a thousand paused ones is still offered, and totalCount and paused say which is which (review F1.12, F1.11)', async () => {
  await clearNotes();
  const fx = await mkTmp();
  try {
    const real = fs.realpathSync(fx);
    const archive = path.join(real, 'archive');
    fs.mkdirSync(path.join(real, 'zz-free'));
    fs.mkdirSync(path.join(real, 'holder', 'free-inner'), { recursive: true });
    const empties = Array.from({ length: 1100 }, (_, i) => dir(`e${String(i).padStart(4, '0')}`, []));
    // `holder` is empty but holds a noted empty folder: not offered whole, while the free folder beside the noted one is.
    const root = tree([dir('archive', [file('keep.txt', 10), ...empties]), dir('holder', [dir('paused-empty', []), dir('free-inner', [])]), dir('zz-free', [])], real);
    await setNote(archive, 'keep these');
    await setNote(path.join(real, 'holder', 'paused-empty'), 'keep this empty folder');
    const scan = createScanRecord(real);
    scan.store = buildStoreFromTree(root);
    scan.status = 'complete';
    const answer = await emptyFoldersForScan(scan, true, await notePausedTest(real));
    assert.deepEqual(answer.folders.map((f) => path.basename(f.path)), ['free-inner', 'zz-free'], 'the free folders are offered, not crowded out of the list');
    assert.equal(answer.totalCount, 2, 'only what may be offered is counted');
    assert.equal(answer.truncated, false, 'nothing that may be offered was cut');
    assert.equal(answer.paused, 1102, 'and how many a note left out is said: the archive\'s 1,100, the noted folder and the one holding it');
  } finally {
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('Shrink video and Empty folders, asked over HTTP, leave a paused folder out and say how many; with Package leftovers, Git repositories and browser caches they refuse NOTES_UNREADABLE (review F1.11, F1.6)', async () => {
  await clearNotes();
  const fx = await mkTmp();
  const dataDir = process.env.TREEMAP_DATA_DIR!;
  const notesFile = path.join(dataDir, 'notes.json');
  const fake: MediaTools = {
    availability: async () => ({ available: true, encoder: 'hevc_videotoolbox', hardwareCodecs: ['hevc'], mechanism: 'test' }),
    probe: async () => ({ durationSeconds: 60, videoCodec: 'h264', width: 1920, height: 1080, bitrateBps: 8e6, frameCount: 1440 }),
    encode: async () => { throw new Error('this test never encodes'); },
  };
  setMediaTools(fake);
  const { port, close } = await listen();
  try {
    for (const v of [['kept', 'a.mov'], ['loose', 'b.mov']]) {
      fs.mkdirSync(path.join(fx, v[0]), { recursive: true });
      const fd = fs.openSync(path.join(fx, ...v), 'w');
      fs.ftruncateSync(fd, 80 * 1024 * 1024); // over the shortlist's floor, and sparse: nothing is written
      fs.closeSync(fd);
    }
    fs.mkdirSync(path.join(fx, 'kept', 'empty'));
    fs.mkdirSync(path.join(fx, 'free'));
    const scanId = await scannedFixture(port, fx);
    await setNote(path.join(fx, 'kept'), 'keep these');

    const videos = await req(port, 'GET', `/api/compression/candidates?scanId=${scanId}`);
    assert.equal(videos.status, 200, JSON.stringify(videos.body));
    assert.deepEqual(videos.body.candidates.map((c: any) => c.name), ['b.mov'], 'the paused folder\'s video is not offered for a re-encode, which trashes it');
    assert.equal(videos.body.paused, 1, 'and is counted as left out by a note');

    const empties = await req(port, 'GET', `/api/empty-folders?scanId=${scanId}`);
    assert.equal(empties.status, 200, JSON.stringify(empties.body));
    assert.deepEqual(empties.body.folders.map((f: any) => path.basename(f.path)), ['free'], JSON.stringify(empties.body));
    assert.equal(empties.body.totalCount, 1);
    assert.equal(empties.body.paused, 1);

    fs.writeFileSync(notesFile, '{ not json');
    for (const route of ['/api/empty-folders', '/api/compression/candidates', '/api/packages/orphans', '/api/git/repos', '/api/cleanup/browser-profiles']) {
      const r = await req(port, 'GET', `${route}?scanId=${scanId}`);
      assert.equal(r.status, 500, `${route}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'NOTES_UNREADABLE', `${route} never offers what an unreadable notes.json may pause`);
    }
  } finally {
    setMediaTools(null);
    await close();
    fs.rmSync(notesFile, { force: true });
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('notes.json.corrupt')) fs.rmSync(path.join(dataDir, f), { force: true });
    }
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});

test('Smart suggestions leave a paused folder out of every list in the pane: Git repositories, browser caches, and a package folder holding a noted one (review F1.15, F1.1, F1.7, F1.11)', async () => {
  await clearNotes();
  const home = path.join(os.homedir(), 'tm-review-pause-fixture');
  const repo = (): FileNode => dir('repo', [dir('.git', [dir('objects', [dir('pack', [file('p.pack', 2_000_000)])]), file('HEAD', 30)])]);
  const chrome = (): FileNode => dir('Library', [dir('Application Support', [dir('Google', [dir('Chrome', [dir('Default', [dir('Cache', [file('data_1', 500_000)])])])])])]);
  const modules = (): FileNode => dir('node_modules', [file('.package-lock.json', 1), file('big.js', 3_000_000)]);
  const root = tree([dir('archive', [repo(), chrome()]), dir('other', [repo(), chrome()]), dir('proj2', [modules()]), dir('proj3', [modules()])], home);
  const scan = createScanRecord(home);
  scan.store = buildStoreFromTree(root);
  scan.status = 'complete';
  const at = (...p: string[]) => path.join(home, ...p);
  const lists = async (port: number) => {
    const repos = (await req(port, 'GET', `/api/git/repos?scanId=${scan.scanId}`)).body.repos.map((r: any) => r.repoPath);
    const profiles = (await req(port, 'GET', `/api/cleanup/browser-profiles?scanId=${scan.scanId}`)).body.profiles.flatMap((g: any) => g.items.map((i: any) => i.path));
    const packages = (await req(port, 'GET', `/api/packages/orphans?scanId=${scan.scanId}`)).body.ecosystems.flatMap((g: any) => g.entries.map((e: any) => e.path));
    return { repos, profiles, packages };
  };
  const { port, close } = await listen();
  try {
    const before = await lists(port);
    assert.ok(before.repos.includes(at('archive', 'repo')) && before.repos.includes(at('other', 'repo')), `control: both repositories listed: ${before.repos}`);
    assert.equal(before.profiles.filter((p: string) => p.startsWith(at('archive'))).length, 1, `control: the archive's browser cache listed: ${before.profiles}`);
    assert.ok(before.packages.includes(at('proj2', 'node_modules')), `control: proj2's leftover listed: ${before.packages}`);

    await setNote(at('archive'), 'client archive, keep');
    await setNote(at('proj2', 'node_modules', 'keep-me'), 'a patched dependency, keep');
    const after = await lists(port);
    assert.deepEqual(after.repos, [at('other', 'repo')], 'no "Run git gc" offered inside the paused folder');
    assert.deepEqual(after.profiles.filter((p: string) => p.startsWith(at('archive'))), [], 'no browser cache offered inside it');
    assert.equal(after.profiles.length, 1, 'control: the other folder\'s browser cache is still offered');
    assert.ok(!after.packages.includes(at('proj2', 'node_modules')), 'a leftover holding a noted folder is not offered whole');
    assert.ok(after.packages.includes(at('proj3', 'node_modules')), 'control: the other leftover still is');
  } finally {
    await close();
    await clearNotes();
  }
});

test('the note sheet names the lists a pausing note keeps a folder out of, and the views that still show what is inside it (review F1.1, F1.7, F1.15)', () => {
  const at = INDEX_HTML.indexOf('id="noteSuppress"');
  const region = INDEX_HTML.slice(at, INDEX_HTML.indexOf('class="modal-foot"', at));
  assert.doesNotMatch(region, /nothing inside this folder is ever suggested for cleanup/, 'not a promise the Libraries and Duplicates views break');
  for (const list of ['Smart suggestions', 'Empty folders', 'Shrink video', 'Autopilot']) assert.match(region, new RegExp(list), `names ${list}`);
  for (const view of ['Custom rules', 'Cloud-safe', 'Libraries', 'Duplicates']) assert.match(region, new RegExp(view), `names ${view}`);
});
