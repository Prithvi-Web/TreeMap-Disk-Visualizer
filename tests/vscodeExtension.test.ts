import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The VS Code extension's pure logic, tested from the main suite.
 *
 * The extension is a separate package with its own build, and nothing here
 * imports `vscode` — that is precisely why its decision-making lives in
 * vscode-extension/src/lib/. Those modules decide which source tree gets
 * executed, which URLs get cloned, and what a webview is allowed to frame,
 * and none of that should be provable only by a human clicking through an
 * Extension Development Host.
 */

import {
  findReady,
  parseNodeMajor,
  parseReadyLine,
  nodeIsSupported,
  MINIMUM_NODE_MAJOR,
} from '../vscode-extension/src/lib/serverReady';
import {
  chooseSource,
  isAllowedGitRef,
  isAllowedRepositoryUrl,
  isTreeMapCheckout,
} from '../vscode-extension/src/lib/sourceRoot';
import { commandsFor, planSteps } from '../vscode-extension/src/lib/steps';
import {
  buildMessageHtml,
  buildWebviewHtml,
  contentSecurityPolicy,
  frameOriginOf,
} from '../vscode-extension/src/lib/webview';

const EXT = path.join(__dirname, '..', 'vscode-extension');

/* ---------------------- reading the server's own port ---------------------- */

test('the port comes from what the server printed, not from what we asked for', () => {
  // src/index.ts logs exactly this line once the socket is bound. It is the
  // only statement of the port the server ACTUALLY got: the extension probes
  // for a free port, but a probe-then-bind is a race, and index.ts silently
  // falls back to 4280 for any PORT that is not a positive integer.
  const hit = parseReadyLine('TreeMap running → http://127.0.0.1:52341');
  assert.deepEqual(hit, { url: 'http://127.0.0.1:52341', port: 52341 });
});

test('a mangled arrow still yields the port', () => {
  // The arrow is non-ASCII in a log line piped between two processes. Losing
  // the port to an encoding wobble would hang the open with no explanation.
  assert.equal(parseReadyLine('TreeMap running -> http://127.0.0.1:4280')?.port, 4280);
  assert.equal(parseReadyLine('TreeMap running ? http://127.0.0.1:4280')?.port, 4280);
});

test('the ready line is found even when stdout splits it across chunks', () => {
  const chunks = ['[treemap] boot\nTreeMap runn', 'ing → http://127.0.0.1:4310\n'];
  assert.equal(findReady(chunks[0]), null, 'half a line is not a ready signal');
  assert.equal(findReady(chunks.join(''))?.port, 4310);
});

test('lines that are not the ready line are not mistaken for it', () => {
  for (const line of [
    '',
    '[treemap] failed to start: EADDRINUSE',
    'TreeMap running → http://127.0.0.1:99999', // out of range
    'TreeMap running → http://127.0.0.1:',
    'Something else running → http://127.0.0.1:4280',
  ]) {
    assert.equal(parseReadyLine(line), null, `must not parse: ${JSON.stringify(line)}`);
  }
});

/* ------------------------------- Node gate -------------------------------- */

test('the Node version gate matches what TreeMap actually requires', () => {
  const engines = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ).engines.node as string;
  assert.equal(
    engines,
    `>=${MINIMUM_NODE_MAJOR}`,
    'the extension must refuse exactly the versions TreeMap refuses',
  );
  assert.equal(parseNodeMajor('v20.11.1'), 20);
  assert.equal(parseNodeMajor('v24.16.0'), 24);
  assert.equal(parseNodeMajor('not a version'), null);
  assert.equal(nodeIsSupported('v18.19.0'), false, 'Node 18 cannot run TreeMap');
  assert.equal(nodeIsSupported('v20.0.0'), true);
});

/* --------------------- which source tree gets executed --------------------- */

const REAL_TREE = {
  hasPackageJson: true,
  packageName: 'treemap',
  hasPublicIndexHtml: true,
  hasSrcServer: true,
};

test('a directory is only TreeMap when every marker is present', () => {
  assert.equal(isTreeMapCheckout(REAL_TREE), true);
  // Each marker alone is the difference between running TreeMap and running
  // whatever else happens to be sitting in that folder.
  assert.equal(isTreeMapCheckout({ ...REAL_TREE, packageName: 'something-else' }), false);
  assert.equal(isTreeMapCheckout({ ...REAL_TREE, hasPackageJson: false }), false);
  assert.equal(isTreeMapCheckout({ ...REAL_TREE, hasPublicIndexHtml: false }), false);
  assert.equal(isTreeMapCheckout({ ...REAL_TREE, hasSrcServer: false }), false);
  assert.equal(isTreeMapCheckout({ ...REAL_TREE, packageName: undefined }), false);
});

test('this very repository passes the checkout test', () => {
  // The markers are only meaningful if they match reality. If someone renames
  // src/server.ts or the package, this fails here rather than in a user's
  // editor with "TreeMap was set up but dist/index.js is missing".
  const root = path.join(__dirname, '..');
  assert.equal(
    isTreeMapCheckout({
      hasPackageJson: fs.existsSync(path.join(root, 'package.json')),
      packageName: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name,
      hasPublicIndexHtml: fs.existsSync(path.join(root, 'public', 'index.html')),
      hasSrcServer: fs.existsSync(path.join(root, 'src', 'server.ts')),
    }),
    true,
  );
});

test('a workspace that IS TreeMap is run instead of a second clone', () => {
  const choice = chooseSource({
    workspaceFolders: [{ path: '/home/me/TreeMap', tree: REAL_TREE }],
    clonePath: '/storage/treemap-src',
    useWorkspaceRepository: true,
  });
  assert.equal(choice.kind, 'workspace');
  assert.equal(choice.path, '/home/me/TreeMap');
});

test('an unrelated workspace never gets run as TreeMap', () => {
  const choice = chooseSource({
    workspaceFolders: [{ path: '/home/me/some-app', tree: { ...REAL_TREE, packageName: 'some-app' } }],
    clonePath: '/storage/treemap-src',
    useWorkspaceRepository: true,
  });
  assert.equal(choice.kind, 'clone');
  assert.equal(choice.path, '/storage/treemap-src');
});

test('turning the setting off means the clone is used even inside the repo', () => {
  const choice = chooseSource({
    workspaceFolders: [{ path: '/home/me/TreeMap', tree: REAL_TREE }],
    clonePath: '/storage/treemap-src',
    useWorkspaceRepository: false,
  });
  assert.equal(choice.kind, 'clone');
});

/* ------------------------- what may be cloned ----------------------------- */

test('the default repository URL in package.json is one the guard accepts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const url = manifest.contributes.configuration.properties['treemap.repositoryUrl'].default;
  assert.equal(
    isAllowedRepositoryUrl(url),
    true,
    `the shipped default must pass its own validator: ${url}`,
  );
  assert.match(url, /Prithvi-Web\/TreeMap-Disk-Visualizer/, 'and point at the real repository');
  // The repository name contains hyphens. A validator that rejected them would
  // reject its own default, which is the exact bug this pins.
  assert.ok(url.includes('-'), 'the URL genuinely contains hyphens');
});

test('only real git remotes are cloned', () => {
  for (const ok of [
    'https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer.git',
    'https://example.com/a/b',
    'git@github.com:Prithvi-Web/TreeMap-Disk-Visualizer.git',
    'ssh://git@example.com/x/y.git',
  ]) {
    assert.equal(isAllowedRepositoryUrl(ok), true, `should allow ${ok}`);
  }
  // This setting names code that gets downloaded and executed, so anything
  // that is not plainly a remote is refused rather than normalised.
  for (const bad of [
    '',
    '   ',
    'file:///etc/passwd',
    'http://example.com/x', // plain http: the clone would be unauthenticated
    '--upload-pack=touch /tmp/pwned',
    '-ext::sh -c touch% /tmp/pwned',
    'https://example.com/a b',
    'ext::sh -c whatever',
    ' https://example.com/a',
  ]) {
    assert.equal(isAllowedRepositoryUrl(bad), false, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('only real git refs are checked out', () => {
  for (const ok of ['main', 'v3.1.0', 'refs/heads/main', 'feature/thing-1']) {
    assert.equal(isAllowedGitRef(ok), true, `should allow ${ok}`);
  }
  for (const bad of ['', '--upload-pack=x', 'a..b', 'a b', 'a;b', '-x', 'x'.repeat(300)]) {
    assert.equal(isAllowedGitRef(bad), false, `should refuse ${JSON.stringify(bad)}`);
  }
});

/* ---------------------------- the setup plan ------------------------------ */

test('a cold start plans every step and a warm start plans almost none', () => {
  const cold = planSteps({ needsClone: true, needsUpdate: false, needsInstall: true, needsBuild: true });
  assert.deepEqual(cold.map((s) => s.id), ['locate', 'clone', 'install', 'build', 'start']);

  const warm = planSteps({ needsClone: false, needsUpdate: false, needsInstall: false, needsBuild: false });
  assert.deepEqual(warm.map((s) => s.id), ['locate', 'start']);
});

test('a clone is never both cloned and updated', () => {
  const both = planSteps({ needsClone: true, needsUpdate: true, needsInstall: false, needsBuild: false });
  assert.deepEqual(both.map((s) => s.id), ['locate', 'clone', 'start'], 'a fresh clone is already current');
});

test('progress weights always total exactly 100', () => {
  // The caller reports each step's weight as an increment without tracking a
  // running total, so anything but 100 leaves the bar short or overflowing.
  for (const needsClone of [true, false]) {
    for (const needsUpdate of [true, false]) {
      for (const needsInstall of [true, false]) {
        for (const needsBuild of [true, false]) {
          const plan = planSteps({ needsClone, needsUpdate, needsInstall, needsBuild });
          const total = plan.reduce((sum, s) => sum + s.weight, 0);
          assert.equal(total, 100, `weights must total 100 for ${JSON.stringify({ needsClone, needsUpdate, needsInstall, needsBuild })}`);
          assert.ok(plan.every((s) => s.weight >= 0), 'and no step may be negative');
        }
      }
    }
  }
});

test('the install step keeps the dev dependencies the build needs', () => {
  // `npm run build` runs tsc, and typescript is a devDependency — omitting dev
  // dependencies would install a tree that cannot build itself, which fails
  // later and confusingly. The step list is asserted by what it must CONTAIN,
  // not as one exact string: the build gained the src/ui stitch step, and a
  // pin that breaks on every pipeline change stops describing the invariant.
  const [install] = commandsFor('install', { repositoryUrl: 'x', gitRef: 'main', dir: '/d' });
  assert.equal(install.command, 'npm');
  assert.ok(!install.args.includes('--omit=dev'), 'tsc is a devDependency');
  assert.ok(!install.args.includes('--ignore-scripts'), 'better-sqlite3 and sharp need their install scripts');
  assert.equal(install.args[0], 'ci');

  const root = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(root.devDependencies.typescript, 'typescript really is a devDependency');
  assert.match(root.scripts.build, /(^|&&\s*)tsc\b/, 'and build really does run tsc');
  assert.match(root.scripts.build, /copy-assets\.js/, 'and still copies the runtime rule packs');
});

test('the clone command cannot be talked into running an option', () => {
  const [clone] = commandsFor('clone', {
    repositoryUrl: 'https://example.com/x.git',
    gitRef: 'main',
    dir: '/d/treemap-src',
  });
  const sep = clone.args.indexOf('--');
  assert.ok(sep !== -1, 'options are separated from values with --');
  assert.ok(clone.args.indexOf('https://example.com/x.git') > sep, 'the URL comes after it');
  assert.ok(clone.args.includes('--depth'), 'and the clone is shallow');
});

test('updating fetches and resets rather than pulling', () => {
  // `git pull` can stop on a divergence to ask a question nobody can see,
  // hanging the progress notification behind an invisible prompt.
  const cmds = commandsFor('update', { repositoryUrl: 'x', gitRef: 'main', dir: '/d' });
  assert.equal(cmds.length, 2, 'fetch, then reset');
  assert.ok(!cmds.some((c) => c.args.includes('pull')), 'never pull');
  assert.deepEqual(cmds[1].args, ['-C', '/d', 'reset', '--hard', 'FETCH_HEAD']);
});

/* --------------------------- the webview page ----------------------------- */

test('only an http(s) origin can be framed', () => {
  assert.equal(frameOriginOf('http://127.0.0.1:4280/'), 'http://127.0.0.1:4280');
  assert.equal(frameOriginOf('https://x-4280.app.github.dev/'), 'https://x-4280.app.github.dev');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'not a url']) {
    assert.equal(frameOriginOf(bad), null, `must refuse ${bad}`);
  }
});

test('the webview refuses to build a page around a non-http URL', () => {
  assert.throws(() => buildWebviewHtml('javascript:alert(1)'), /refusing to frame/);
});

test('the page only lets the frame reach the one origin it was built for', () => {
  // Assert the policy itself, not its escaped form in the attribute: the
  // browser decodes &#39; back to ' before the CSP parser sees it, so matching
  // the markup would pin the escaper rather than the security boundary.
  const csp = contentSecurityPolicy('http://127.0.0.1:4280');
  assert.match(csp, /^default-src 'none'/, 'everything is denied first');
  assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:4280/, 'then exactly one origin is allowed');
  assert.ok(!/script-src/.test(csp), 'this document runs no script of its own');
  assert.ok(!/\*/.test(csp), 'and no wildcard source is ever granted');

  const html = buildWebviewHtml('http://127.0.0.1:4280/?path=%2Ftmp');
  assert.match(html, /http-equiv="Content-Security-Policy"/, 'the page carries the policy');
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:4280/);
  assert.match(html, /<iframe src="http:\/\/127\.0\.0\.1:4280\/\?path=%2Ftmp"/);
});

test('a different origin cannot be smuggled into the policy', () => {
  const csp = contentSecurityPolicy('https://evil.example');
  assert.ok(!csp.includes('127.0.0.1'), 'the policy names only the origin it was given');
  // frameOriginOf is what decides that value, and it only ever returns a bare
  // scheme://host:port parsed by URL — never anything a query or path can reach.
  assert.equal(frameOriginOf('http://127.0.0.1:4280/x?y=https://evil.example'), 'http://127.0.0.1:4280');
});

test('a URL cannot break out of the attribute it is written into', () => {
  const html = buildWebviewHtml('http://127.0.0.1:4280/?path=%22%3E%3Cscript%3E');
  assert.ok(!/<script>/.test(html), 'no script tag is ever produced');
  assert.match(html, /&quot;|%22/, 'the quote is encoded, not closed');
});

test('the waiting and failure pages escape what they are told', () => {
  const html = buildMessageHtml('<img src=x onerror=alert(1)>', 'a & b < c');
  assert.ok(!/<img/.test(html), 'markup in a message is text, not markup');
  assert.match(html, /&amp; b &lt; c/);
});

/* ------------------------- the extension manifest ------------------------- */

test('every contributed command is actually registered', () => {
  // A command in the palette that throws "command not found" is a bug users
  // hit before anything else works.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const declared: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
  const source = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
  for (const command of declared) {
    assert.ok(
      source.includes(`registerCommand('${command}'`),
      `${command} is contributed but never registered`,
    );
  }
  assert.ok(declared.length >= 5, 'the five commands the README documents');
});

test('the manifest points at files that exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(EXT, manifest.icon)), `icon missing: ${manifest.icon}`);
  // `main` points into out/, which is a build artifact and gitignored — so
  // assert the SOURCE it is built from, which is what has to exist in the repo.
  assert.equal(manifest.main, './out/extension.js');
  assert.ok(fs.existsSync(path.join(EXT, 'src', 'extension.ts')), 'src/extension.ts must exist');
});

test('the extension never loads TreeMap into the extension host', () => {
  // TreeMap depends on better-sqlite3 and sharp, native modules built for
  // standard Node. VS Code's extension host is Electron, whose ABI differs —
  // a require() of the server would abort the whole host on first load. The
  // server must always be a child process.
  const files = ['extension.ts', 'server.ts', 'workspace.ts', 'exec.ts']
    .map((f) => fs.readFileSync(path.join(EXT, 'src', f), 'utf8'))
    .join('\n');
  assert.ok(!/require\(.*dist[\/\\]server/.test(files), 'never require the server');
  assert.ok(!/from '.*dist[\/\\]server/.test(files), 'never import the server');
  assert.match(
    fs.readFileSync(path.join(EXT, 'src', 'server.ts'), 'utf8'),
    /spawn\(/,
    'the server is spawned as a child process',
  );
});

test('nothing under lib/ imports vscode, so this file can test it at all', () => {
  const libDir = path.join(EXT, 'src', 'lib');
  const names = fs.readdirSync(libDir).filter((n) => n.endsWith('.ts'));
  assert.ok(names.length >= 4, 'the pure modules are there');
  for (const name of names) {
    const src = fs.readFileSync(path.join(libDir, name), 'utf8');
    assert.ok(
      !/from 'vscode'|require\('vscode'\)/.test(src),
      `${name} imports vscode, which cannot be resolved outside an extension host`,
    );
  }
});

test('no shell is used to run git or npm', () => {
  // Paths and repository URLs reach these commands. TreeMap's whole safety
  // story is that it never builds a command string out of a path.
  for (const f of ['exec.ts', 'server.ts']) {
    const src = fs.readFileSync(path.join(EXT, 'src', f), 'utf8');
    assert.ok(!/shell:\s*true/.test(src), `${f} must never spawn through a shell`);
    assert.match(src, /shell:\s*false/, `${f} states shell:false explicitly`);
  }
});

/* -------------------- fixes from the adversarial review -------------------- */

test('npm is reachable on Windows, where it is npm.cmd and not npm.exe', () => {
  // libuv's PATH search only appends .com and .exe and never consults PATHEXT,
  // so a bare `npm` with shell:false is ENOENT on Windows — and the user is
  // told npm is not installed when it plainly is. Spawning npm.cmd directly is
  // not the answer either: Node refuses a .cmd without a shell.
  const src = fs.readFileSync(path.join(EXT, 'src', 'exec.ts'), 'utf8');
  assert.match(src, /process\.platform === 'win32' && command === 'npm'/, 'npm is special-cased, by name');
  assert.match(src, /ComSpec/, 'and routed through the command processor');
  assert.match(src, /'\/d', '\/s', '\/c'/, 'with cmd flags that disable AutoRun and stop quote-stripping');
  // git must NOT be routed through cmd: git.exe resolves normally, and git is
  // the one that receives user-controlled values (the URL and the ref).
  assert.ok(!/command === 'git'/.test(src), 'git keeps its direct spawn');
  assert.match(src, /shell:\s*false/, 'and nothing gains a shell');
});

test('the autoUpdate setting is actually read', () => {
  // A contributed setting that no code consults is worse than no setting: the
  // user turns it off, the extension keeps hard-resetting their clone anyway,
  // and nothing explains why.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.contributes.configuration.properties);
  const ext = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
  for (const key of declared) {
    const name = key.replace(/^treemap\./, '');
    assert.ok(ext.includes(`'${name}'`), `${key} is contributed but never read`);
  }
  const workspace = fs.readFileSync(path.join(EXT, 'src', 'workspace.ts'), 'utf8');
  assert.match(workspace, /cloned && present && opts\.autoUpdate/, 'and it gates the fetch-and-reset');
});

test('opening twice cannot spawn two servers', () => {
  // VS Code does not serialise command invocations. A second Open before the
  // first finished would run the whole setup again and leave the first server
  // orphaned on its port, with nothing holding a reference to stop it.
  const src = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
  const start = src.indexOf('async function openVisualizer');
  assert.ok(start !== -1, 'openVisualizer must exist');
  const end = src.indexOf('async function openOnce', start);
  assert.ok(end > start, 'openOnce must follow it');
  const fn = src.slice(start, end);
  assert.ok(fn.length > 100, 'the openVisualizer slice is non-empty');
  assert.match(fn, /if \(opening\) return opening/, 'a second caller waits on the first');
  assert.match(fn, /opening = openOnce\([^)]*\)\.finally\(/, 'and the latch is always released');
});

test('the folder to scan reaches the first page load, not a second one', () => {
  // Assigning panel.webview.html twice reloads the page. The first, path-less
  // load would already have begun restoring the previous session — a full scan
  // of a different root, racing the one the user actually asked for.
  const src = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
  const start = src.indexOf('async function scanFolder');
  assert.ok(start !== -1, 'scanFolder must exist');
  const fn = src.slice(start);
  assert.ok(fn.length > 100, 'the scanFolder slice is non-empty');
  assert.match(fn, /openVisualizer\(context, folder\.fsPath\)/, 'the path is passed in, not applied after');
  assert.ok(!/webview\.html/.test(fn), 'scanFolder never sets the html itself');
});

test('the query is attached after the port forward, and encoded exactly once', () => {
  // asExternalUri rewrites the authority in a remote window. Round-tripping a
  // query through parse -> forward -> toString is not something to trust when
  // the failure is silent: the page would just scan the wrong folder.
  const src = fs.readFileSync(path.join(EXT, 'src', 'extension.ts'), 'utf8');
  const start = src.indexOf('async function showPanel');
  assert.ok(start !== -1, 'showPanel must exist');
  const end = src.indexOf('async function scanFolder', start);
  assert.ok(end > start, 'scanFolder must follow it');
  const fn = src.slice(start, end);
  assert.ok(fn.length > 200, 'the showPanel slice is non-empty');

  const forwardAt = fn.indexOf('asExternalUri');
  const queryAt = fn.indexOf('.with({ query:');
  assert.ok(forwardAt !== -1 && queryAt > forwardAt, 'the query is attached AFTER the forward');
  assert.match(fn, /encodeURIComponent\(initialPath\)/, 'the path is encoded once');
  assert.match(fn, /toString\(true\)/, 'and toString does not encode it a second time');
});
