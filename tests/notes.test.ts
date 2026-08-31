import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate notes.json (and everything else) from the user's real app data.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-notes-test-'));
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
import { savePolicies, simulatePolicy } from '../src/services/autopilot';
import { initPortableMode, resetPortableMode } from '../src/services/portableMode';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';
import { CompiledIgnore } from '../src/utils/glob';

/**
 * v4 §9.5 — Notes pinned to folders.
 *
 * A note is the user telling the machine "this folder means something" —
 * "client archive, keep until 2027". The tests that matter are therefore not
 * the CRUD (though it is covered) but the promise attached to it: a noted
 * folder is excluded from Smart Suggestions and from Autopilot matching by
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

test('a suppressing note removes a folder and everything under it from Smart Suggestions', () => {
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

    const scan = await req(port, 'POST', '/api/scan', { path: fx });
    assert.ok(scan.status === 200 || scan.status === 202, JSON.stringify(scan.body));
    const scanId = scan.body.scanId;
    // The scan runs in the background; suggestions answer 202 until it lands.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await req(port, 'GET', `/api/scan/${scanId}/result`);
      if (r.status === 200) break;
      assert.ok(Date.now() < deadline, 'the fixture scan never completed');
      await new Promise((res) => setTimeout(res, 50));
    }

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

const NO_CHMOD = process.platform === 'win32';

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
      const scan = await req(port, 'POST', '/api/scan', { path: fx });
      const scanId = scan.body.scanId;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const r = await req(port, 'GET', `/api/scan/${scanId}/result`);
        if (r.status === 200) break;
        assert.ok(Date.now() < deadline, 'fixture scan never completed');
        await new Promise((res) => setTimeout(res, 50));
      }
      const sug = await req(port, 'GET', `/api/cleanup/suggestions?scanId=${scanId}`);
      assert.equal(sug.status, 200);
      assert.equal(sug.body.available, false, 'degraded, not silently unsuppressed');
      assert.match(String(sug.body.reason), /note/i);
    } finally {
      await close();
    }
  } finally {
    await savePolicies([]);
    fs.rmSync(notesFile, { force: true });
    await fsp.rm(fx, { recursive: true, force: true });
  }
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
    const scan = await req(port, 'POST', '/api/scan', { path: fx });
    const scanId = scan.body.scanId;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const r = await req(port, 'GET', `/api/scan/${scanId}/result`);
      if (r.status === 200) break;
      assert.ok(Date.now() < deadline, 'fixture scan never completed');
      await new Promise((res) => setTimeout(res, 50));
    }
    const before = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    assert.equal(before.status, 200);
    const bytesBefore = before.body.cleanup?.reclaimableBytes ?? before.body.reclaimableBytes;
    assert.ok(bytesBefore > 0, `the summary advertises the node_modules before any note — got ${JSON.stringify(before.body).slice(0, 200)}`);

    await setNote(path.join(fx, 'work'), 'client work');
    const after = await req(port, 'GET', `/api/agent/summary?scanId=${scanId}`);
    const bytesAfter = after.body.cleanup?.reclaimableBytes ?? after.body.reclaimableBytes;
    assert.equal(bytesAfter, 0, 'a noted folder is not advertised to agents either');
  } finally {
    await close();
    await clearNotes();
    await fsp.rm(fx, { recursive: true, force: true });
  }
});
