import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-installedPrograms-data-');
process.env.TREEMAP_NO_GDU = '1';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installedProgramOf, programPhrase } from '../src/services/installedPrograms';
import { isApplicationOwned } from '../src/services/securityHygieneScanner';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { setTrashStepForTests } from '../src/services/cleaner';
import { buildMcpServer } from '../src/mcp/server';
import { buildOpenApiDocument } from '../src/api/openapi';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
import { withOpenFileCheck } from './fixtures/openFileCheck';
destinationsOnAnotherDrive(); // every offload destination here stands for another drive (E01)

// Nothing here moves a file: every request is a dry run or a read. The Trash
// step is replaced by a recorder all the same, and must stay unused.
const trashed: string[] = [];
setTrashStepForTests(async (p) => { trashed.push(p); });
after(() => {
  setTrashStepForTests(null);
  assert.deepEqual(trashed, [], 'nothing reached the Trash step');
});

/**
 * Fifth browser pass F01: "Move to Trash" on a file INSIDE an installed app —
 * Chrome's framework, WhatsApp.app/Contents/MacOS/WhatsApp, an app.asar —
 * showed the generic sheet with no word that it breaks the app. One detector
 * answers "which installed program is this a part of?", for the Trash sheets,
 * the dry-run manifests, Autopilot and the Security panel's "belongs to an
 * installed program" rule alike.
 */

test('a file inside a Mac app is a part of that app, named as a person names it, with the whole app as its root', () => {
  // QA's six rows of Largest Files on /Applications.
  const cases: Array<[string, string, string]> = [
    ['/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/120.0.6099.71/Google Chrome Framework', 'Google Chrome', '/Applications/Google Chrome.app'],
    ['/Applications/WhatsApp.app/Contents/MacOS/WhatsApp', 'WhatsApp', '/Applications/WhatsApp.app'],
    ['/Applications/Wispr Flow.app/Contents/Resources/app.asar', 'Wispr Flow', '/Applications/Wispr Flow.app'],
    ['/Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Claude', '/Applications/Claude.app'],
    ['/Users/me/Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Frameworks/libcef.dylib', 'IntelliJ IDEA', '/Users/me/Applications/IntelliJ IDEA.app'],
  ];
  for (const [file, name, root] of cases) {
    assert.deepEqual(installedProgramOf(file, 'darwin'), { kind: 'app', name, root }, file);
  }
});

test('an app inside an app is part of the outer one: removing it means removing the outer app', () => {
  assert.deepEqual(
    installedProgramOf('/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator', 'darwin'),
    { kind: 'app', name: 'Xcode', root: '/Applications/Xcode.app' },
  );
});

test('the app itself, and anything outside an app, is no part of one', () => {
  for (const p of [
    '/Applications/Google Chrome.app', // trashing the whole app is how a Mac uninstalls it
    '/Applications/Google Chrome.app/', // however it is spelled
    '/Users/me/Downloads/holiday-4k.mov',
    '/Users/me/code/site.application/index.html', // ".application" is not ".app"
    '/Users/me/code/.app/settings.json', // a folder named only ".app" is no app bundle
    '/Users/me/Library/Application Support/Google/Chrome/Default/Cache/data_1', // an app's data, not the app
  ]) {
    assert.equal(installedProgramOf(p, 'darwin'), null, p);
  }
  assert.deepEqual(installedProgramOf('/Volumes/Ext/Old.APP/Contents/Info.plist', 'darwin'), { kind: 'app', name: 'Old', root: '/Volumes/Ext/Old.APP' }, 'in any case');
});

test('a folder merely named like an app is no app: a bundle\'s own folder must come next in the path — Contents, or an iPhone app\'s Wrapper (review F1.3)', () => {
  for (const p of [
    '/Users/me/code/acme.app/node_modules/x/index.js', // a project named after its .app domain
    '/Users/me/code/mysite.web.app/src/main.ts',
    '/Users/me/code/acme.app/Contents.md', // a file named Contents.md is no bundle's folder
  ]) {
    assert.equal(installedProgramOf(p, 'darwin'), null, p);
  }
  assert.deepEqual(installedProgramOf('/Users/me/code/acme.app/build/Foo.app/Contents/MacOS/Foo', 'darwin'),
    { kind: 'app', name: 'Foo', root: '/Users/me/code/acme.app/build/Foo.app' }, 'an app built inside such a project is an app');
  assert.deepEqual(installedProgramOf('/Applications/Clocks.app/Wrapper/Clocks.app/Clocks', 'darwin'),
    { kind: 'app', name: 'Clocks', root: '/Applications/Clocks.app' }, 'an iPhone app installed on a Mac');
  assert.deepEqual(installedProgramOf('/Applications/Foo.app/contents/macos/foo', 'darwin'),
    { kind: 'app', name: 'Foo', root: '/Applications/Foo.app' }, 'spelled in another case, on a volume that folds it');
});

test('a program under Program Files is named by the folder it is installed in, never as if the folder were its name — the folder is often its maker\'s (review F1.11)', () => {
  const chrome = installedProgramOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'win32');
  assert.deepEqual(chrome, { kind: 'program', name: 'Google', root: 'C:\\Program Files\\Google' }, 'the vendor\'s folder, as the path has it');
  assert.equal(programPhrase(chrome!), 'a program installed in “C:\\Program Files\\Google”', 'Autopilot\'s sentence names the folder, not a "program Google"');
  assert.equal(programPhrase({ kind: 'app', name: 'Google Chrome', root: '/Applications/Google Chrome.app' }), 'the app “Google Chrome”', 'control: an app is named as a person names it');
});

test('what a program makes again on its own is no part of it: a Steam library\'s shader caches, which the Games view offers to clear (review F1.3)', () => {
  assert.equal(installedProgramOf('C:\\Program Files (x86)\\Steam\\steamapps\\shadercache\\730', 'win32'), null, 'a game\'s shader cache, as the Games view offers it');
  assert.equal(installedProgramOf('C:\\Program Files (x86)\\Steam\\steamapps\\shadercache\\730\\fozpipelinesv6\\steamapprun_pipeline_cache.foz', 'win32'), null, 'and a file in it');
  assert.deepEqual(installedProgramOf('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Game\\game.exe', 'win32'),
    { kind: 'program', name: 'Steam', root: 'C:\\Program Files (x86)\\Steam' }, 'control: a game installed there is still part of what is installed');
});

test('on Windows a file inside a program\'s own folder under Program Files is a part of that program', () => {
  assert.deepEqual(
    installedProgramOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'win32'),
    { kind: 'program', name: 'Google', root: 'C:\\Program Files\\Google' },
  );
  assert.deepEqual(
    installedProgramOf('D:\\Program Files (x86)\\Steam\\steam.exe', 'win32'),
    { kind: 'program', name: 'Steam', root: 'D:\\Program Files (x86)\\Steam' },
  );
  assert.deepEqual(
    installedProgramOf('c:\\PROGRAM FILES\\Mozilla Firefox\\firefox.exe', 'win32'),
    { kind: 'program', name: 'Mozilla Firefox', root: 'c:\\PROGRAM FILES\\Mozilla Firefox' },
    'Windows folds case',
  );
  for (const p of [
    'C:\\Program Files\\desktop.ini', // in Program Files, but in no program's folder
    'C:\\Program Files\\Google', // the program's folder itself
    'D:\\Backup\\Program Files\\Google\\x.dll', // a copy somewhere else is no installed program
    'C:\\Users\\me\\Downloads\\setup.exe',
  ]) {
    assert.equal(installedProgramOf(p, 'win32'), null, p);
  }
});

test('on Linux a file under /usr is the package manager\'s, but /usr/local is where a person installs things', () => {
  assert.deepEqual(installedProgramOf('/usr/lib/x86_64-linux-gnu/libLLVM-17.so.1', 'linux'), { kind: 'package', name: null, root: '/usr' });
  assert.deepEqual(installedProgramOf('/usr/share/code/code', 'linux'), { kind: 'package', name: null, root: '/usr' });
  // /usr/src holds source code, a project's (Docker's /usr/src/app) as often as a package's: nothing there runs (review F1.3).
  for (const p of ['/usr/local/bin/tool', '/usr/local', '/usr', '/home/me/usr/x', '/opt/x/y', '/usr/src/app/node_modules/x/index.js']) {
    assert.equal(installedProgramOf(p, 'linux'), null, p);
  }
  assert.equal(installedProgramOf('/usr/lib/libz.dylib', 'darwin'), null, 'on a Mac /usr is the sealed system, not a package manager\'s');
});

test('the Security panel\'s "belongs to an installed program" rule is this one detector, not a second copy', () => {
  // Every part of a program the detector finds is one the Security panel calls program-owned.
  for (const p of [
    '/Applications/Google Chrome.app/Contents/Resources/cacert.pem',
    'C:\\Program Files\\Google\\Chrome\\Application\\certs\\roots.pem',
  ]) {
    assert.ok(installedProgramOf(p, process.platform), `control: ${p} is part of a program`);
    assert.equal(isApplicationOwned(p), true, p);
  }
  // And the panel asks the detector rather than spotting ".app" itself.
  const scanner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'securityHygieneScanner.ts'), 'utf8');
  assert.match(scanner, /installedProgramOf\(/, 'the Security panel asks the shared detector');
  assert.doesNotMatch(scanner, /endsWith\('\.app'\)/, 'and keeps no ".app" test of its own');
});

/* ══════════════════ The server says it before anything moves (F01) ══════════════════ */

/** One JSON request to a fresh app on an ephemeral port. */
async function call(method: string, url: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }));
      });
      r.on('error', reject);
      r.end(payload);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A scanned folder holding an app — its executable and its app.asar — and a loose file beside it. */
async function scannedFolderWithAnApp(): Promise<{ dir: string; app: string; exe: string; asar: string; loose: string; scanId: string }> {
  const dir = fs.realpathSync(fileTempDir('tm-installed-programs-'));
  const app = path.join(dir, 'Fake.app');
  const exe = path.join(app, 'Contents', 'MacOS', 'Fake');
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
  const loose = path.join(dir, 'loose.bin');
  for (const [file, size] of [[exe, 3000], [asar, 2000], [loose, 1000]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, 1));
  }
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  return { dir, app, exe, asar, loose, scanId: scanned.body.scanId };
}

test('POST /api/files/installed-programs names the installed program each path is a part of, for the Trash sheet to say before anything moves — and nothing for a path that is no part of one (F01)', async () => {
  const { app, exe, asar, loose } = await scannedFolderWithAnApp();
  const r = await call('POST', '/api/files/installed-programs', { paths: [exe, loose, asar, app] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fake = { kind: 'app', name: 'Fake', root: app };
  assert.deepEqual(r.body, { parts: [{ path: exe, installedProgram: fake }, { path: asar, installedProgram: fake }] },
    'the executable and the app.asar are parts of Fake; the loose file and the whole app are not');
  const outside = await call('POST', '/api/files/installed-programs', { paths: ['/definitely/not/scanned/Thing.app/Contents/x'] });
  assert.equal(outside.status, 403, 'a path outside every scanned root is refused, as the open-file check refuses it');
  const mixed = await call('POST', '/api/files/installed-programs', { paths: [exe, '/definitely/not/scanned/Thing.app/Contents/x'] });
  assert.deepEqual([mixed.status, mixed.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'and one such path refuses the whole request (review F1.7)');
});

test('AGENTS.md says of the route what it does: paths inside a scanned root, one refused path refusing the request — never "for any paths", nor "reading nothing on the disk" (review F1.7)', () => {
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const at = agents.indexOf('`POST /api/files/installed-programs { paths }`');
  assert.notEqual(at, -1, 'the route is in AGENTS.md');
  const said = agents.slice(at, agents.indexOf('\n   - ', at)).replace(/\s+/g, ' ');
  assert.doesNotMatch(said, /for any paths|reading nothing on the disk/, `it claims nothing the route does not do: ${said}`);
  assert.match(said, /inside a scanned root/, `it says which paths it answers: ${said}`);
  assert.match(said, /refuses the whole request/, `and what one refused path does: ${said}`);
});

test('the dry-run manifests say which paths are parts of an installed program: DELETE /api/files and the cart over HTTP, trash_paths over MCP (F01)', async () => {
  const { app, exe, loose } = await scannedFolderWithAnApp();
  const fake = { kind: 'app', name: 'Fake', root: app };

  const del = await call('DELETE', '/api/files', { paths: [exe, loose], dryRun: true });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(del.body.wouldTrash, [{ path: exe, bytes: 3000, installedProgram: fake }, { path: loose, bytes: 1000 }], 'DELETE /api/files');

  const cart = await call('POST', '/api/cart/commit', { paths: [exe, loose], dryRun: true });
  assert.equal(cart.status, 200, JSON.stringify(cart.body));
  const byPath = new Map((cart.body.items as Array<Record<string, unknown>>).map((i) => [i.path, i]));
  assert.deepEqual(byPath.get(exe)?.installedProgram, fake, 'the cart\'s manifest names the app');
  assert.equal(byPath.get(loose)?.installedProgram, undefined, 'and nothing for the loose file');

  const mcp = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'treemap-installed-programs-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    const reply = (await client.callTool({ name: 'trash_paths', arguments: { paths: [exe, loose], dryRun: true } })) as { isError?: boolean; structuredContent?: Record<string, any> };
    assert.ok(!reply.isError, JSON.stringify(reply));
    const [first, second] = reply.structuredContent!.wouldTrash as Array<Record<string, unknown>>;
    assert.deepEqual([first.path, first.installedProgram], [exe, fake], 'trash_paths names the app');
    assert.deepEqual([second.path, 'installedProgram' in second], [loose, false], 'and nothing for the loose file');
  } finally {
    await client.close();
  }
  assert.ok(fs.existsSync(exe) && fs.existsSync(loose), 'dry runs move nothing');
});

test('a path reached through a link in its folders is judged where it really is: a folder linked into an app is that app\'s, for the Trash sheet and the dry run alike (review F1.5)', { skip: process.platform === 'win32' && 'symlinks need a privilege on Windows' }, async () => {
  const dir = fs.realpathSync(fileTempDir('tm-installed-link-'));
  const contents = path.join(dir, 'apps', 'Foo.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Resources', 'big.bin'), Buffer.alloc(2000, 1));
  fs.symlinkSync(contents, path.join(dir, 'L'), 'dir');
  const folder = path.join(dir, 'L', 'Resources'); // spelled through the link: no ".app" in it
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: folder });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const spelled = path.join(folder, 'big.bin');
  assert.equal(installedProgramOf(spelled), null, 'control: its spelling names no app');
  const foo = { kind: 'app', name: 'Foo', root: path.join(dir, 'apps', 'Foo.app') };
  const r = await call('POST', '/api/files/installed-programs', { paths: [spelled] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { parts: [{ path: spelled, installedProgram: foo }] }, 'the route names the app, where it really is');
  const del = await call('DELETE', '/api/files', { paths: [spelled], dryRun: true });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(del.body.wouldTrash[0].installedProgram, foo, 'and so does the dry run');
});

test('DELETE /api/files\'s dry run with onlyEmptyFolders says it too: an empty folder inside an app is a part of it (review F1.9)', async () => {
  const dir = fs.realpathSync(fileTempDir('tm-installed-empty-'));
  const app = path.join(dir, 'Fake.app');
  const empty = path.join(app, 'Contents', 'Resources', 'empty');
  const plain = path.join(dir, 'plain-empty');
  fs.mkdirSync(empty, { recursive: true });
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), 'x');
  const scanned = await call('POST', '/api/scan?wait=true&waitMs=55000', { path: dir });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  const r = await call('DELETE', '/api/files', { paths: [empty, plain], dryRun: true, onlyEmptyFolders: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.wouldTrash.map((w: { path: string }) => w.path), [empty, plain], 'control: both are empty folders the real run would trash');
  assert.deepEqual(r.body.wouldTrash[0].installedProgram, { kind: 'app', name: 'Fake', root: app }, 'the empty folder inside the app is named as a part of it');
  assert.equal('installedProgram' in r.body.wouldTrash[1], false, 'and nothing for the folder outside it');
  assert.ok(fs.existsSync(empty) && fs.existsSync(plain), 'a dry run moves nothing');
});

test('the offload dry runs say which originals they would trash are parts of an installed program: POST /api/offload and the MCP offload tool (review F1.4)', async () => {
  const { app, exe, loose, scanId } = await scannedFolderWithAnApp();
  const dest = fs.realpathSync(fileTempDir('tm-installed-offload-dest-'));
  const fake = { kind: 'app', name: 'Fake', root: app };
  await withOpenFileCheck('clear', async () => {
    const plan = await call('POST', '/api/offload', { scanId, paths: [exe, loose], dest, dryRun: true });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual(plan.body.installedProgramParts, [{ path: exe, installedProgram: fake }], 'POST /api/offload names the app, and nothing for the loose file');
    const plain = await call('POST', '/api/offload', { scanId, paths: [loose], dest, dryRun: true });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal('installedProgramParts' in plain.body, false, 'control: a plan with no part of a program reads as it did');

    const mcp = buildMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'treemap-installed-programs-offload-test', version: '0.0.0' });
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
    try {
      const reply = (await client.callTool({ name: 'offload', arguments: { scanId, paths: [exe, loose], dest, dryRun: true } })) as { isError?: boolean; structuredContent?: Record<string, any> };
      assert.ok(!reply.isError, JSON.stringify(reply));
      assert.deepEqual(reply.structuredContent!.installedProgramParts, [{ path: exe, installedProgram: fake }], 'the MCP offload tool names the app');
    } finally {
      await client.close();
    }
  });
  assert.ok(fs.existsSync(exe) && fs.existsSync(loose), 'dry runs move nothing');
  assert.deepEqual(fs.readdirSync(dest), [], 'and copy nothing');
});

test('the published spec declares the route and the manifests\' installedProgram field (F01)', () => {
  const doc = buildOpenApiDocument() as Record<string, any>;
  const route = doc.paths['/api/files/installed-programs']?.post;
  assert.ok(route, 'POST /api/files/installed-programs is in the document');
  assert.doesNotMatch(String(route.description ?? ''), /DESTRUCTIVE/, 'and is not destructive: it reads nothing but the paths it is sent');
  const said = JSON.stringify(route.responses['200']);
  assert.match(said, /parts/, 'its answer is declared');
  const item = doc.components.schemas.TrashDryRunManifest.properties.wouldTrash.items;
  assert.ok(item.properties.installedProgram, 'DELETE /api/files\'s dry run declares installedProgram on each entry');
  // OpenAPI 3.0: a Reference Object's siblings are ignored, so the field's own
  // words ride beside an allOf of the schema, never beside a $ref (review F1.10).
  assert.deepEqual(item.properties.installedProgram.allOf, [{ $ref: '#/components/schemas/InstalledProgram' }], 'the field is the InstalledProgram schema');
  assert.match(String(item.properties.installedProgram.description), /say so to the person before acting/, 'with its own description where a 3.0 reader keeps it');
  const refWithSiblings: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && '$ref' in node && Object.keys(node).length > 1) refWithSiblings.push(at);
    for (const [k, v] of Object.entries(node)) walk(v, `${at}/${k}`);
  };
  walk(doc, '#');
  assert.deepEqual(refWithSiblings, [], 'no $ref in the document has a sibling a 3.0 reader would drop');
  assert.match(JSON.stringify(doc.paths['/api/cart/commit'].post.responses), /installedProgram/, 'and so does the cart\'s');
  assert.ok(doc.components.schemas.OffloadDryRunManifest.properties.installedProgramParts, 'and the offload dry run\'s installedProgramParts (review F1.4)');
});

test('the published words for `root` say what it is for a path reached through a link: the program where it really is, which the path asked about need not begin with (review round 2, F2.5)', () => {
  // installedProgramAt judges a path where it really is (review F1.5): for
  // …/L/Resources/x.bin, L a link to …/Foo.app/Contents, `root` is the real
  // …/Foo.app. The spec and AGENTS.md still said "as the path spells it".
  const doc = buildOpenApiDocument() as Record<string, any>;
  const root = String(doc.components.schemas.InstalledProgram.properties.root.description).replace(/\s+/g, ' ');
  assert.match(root, /as the path spells it/, `control: the usual case: ${root}`);
  assert.match(root, /through a link[^.]*where it really is/, `and the path through a link: ${root}`);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8');
  const at = agents.indexOf('**A part of an installed program breaks it.**');
  assert.notEqual(at, -1, 'the bullet is in AGENTS.md');
  const said = agents.slice(at, agents.indexOf('\n   - ', at)).replace(/\s+/g, ' ');
  assert.match(said, /removed whole \(`root`[^)]*through a link[^)]*where it really is[^)]*\)/, `AGENTS.md says it where it names root: ${said}`);
});
