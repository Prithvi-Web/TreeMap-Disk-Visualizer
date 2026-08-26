# The VS Code extension — design

**Date:** 25 August 2026
**Status:** shipped (compiled, packaged and driven headlessly; **never loaded
into a real VS Code**, see "What could not be verified")

## What it is

An editor wrapper around TreeMap. It finds or fetches a TreeMap checkout, makes
sure it is built, starts its server on a free loopback port, and frames the
existing visualizer in a webview panel. All of it runs under one cancellable
progress notification.

It adds no visualizer of its own. The frontend is one self-contained page that
already talks to this exact server; reproducing any of it in a webview would
mean two frontends to keep in step.

## The constraint that shapes everything

**The server must be a child process.** TreeMap depends on `better-sqlite3` and
`sharp` — native modules compiled against a specific `NODE_MODULE_VERSION`. The
VS Code extension host is Electron, whose ABI differs. `require`-ing
`dist/server.js` in-process would abort the entire extension host on first load,
taking every other extension with it.

So: spawn the user's own `node` on `dist/index.js`. `index.js` rather than
`server.js` because it is the entry point that owns a whole process — it installs
SIGTERM/SIGINT draining and exits on a failed bind, which is exactly right for a
child we intend to kill and exactly wrong to require.

That is also why Node's version is checked *before* anything is cloned or built:
finding out after a two-minute `npm ci` that Node 18 cannot run the result is a
bad way to spend someone's afternoon.

## Layout: `lib/` is pure

`vscode-extension/src/lib/` contains no `vscode` import. That is not tidiness —
it is what lets the **main repository's own test suite** cover the decisions that
matter:

- which source tree gets executed (`sourceRoot.ts`)
- which URLs may be cloned and which refs checked out (`sourceRoot.ts`)
- what a webview is allowed to frame (`webview.ts`)
- what commands actually run, and in what order (`steps.ts`)
- how the server's port is discovered (`serverReady.ts`)

`tests/vscodeExtension.test.ts` imports these directly. A test pins that nothing
under `lib/` imports `vscode`, because the day one does, this whole file stops
being runnable and the coverage quietly disappears.

## Believing the printed port

The extension probes for a free port and passes it as `PORT`. It then parses the
port back out of the server's own ready line, and uses **that**.

Two reasons. A probe-then-bind is a race — something can take the port in
between. And `src/index.ts` computes `Number(process.env.PORT) || 4280`, so any
value that is not a positive integer silently becomes 4280. The server's own
statement is the only authority on what it bound. A bind failure is retried on a
fresh port rather than reported.

The ready line is accumulated across stdout chunks, since a line can be split
across two reads. **stderr is buffered too** — `index.ts` reports a failed bind
through `console.error`, so stderr is the only place the reason for an early exit
exists, and the exit handler is what surfaces it.

## Choosing the source tree

Clone by default, into the extension's own global storage. But if the open
workspace *is* the TreeMap repository, that working tree is used instead: a
TreeMap developer running this extension should see the code in front of them,
not a month-old clone of `main`, and that divergence is a genuinely confusing bug
to chase.

"Is TreeMap" means all four of: `package.json` exists, its `name` is `treemap`,
`public/index.html` exists, `src/server.ts` exists. Each rules out a different
wrong answer, and a test asserts that **this repository itself passes** — so
renaming any of them fails here rather than in a user's editor.

**Only a clone is ever updated.** Fetching and hard-resetting a developer's own
working tree would throw away uncommitted work; it is the single most
destructive thing this extension could do, and it is structurally prevented
rather than merely avoided.

## The setup plan is data

`planSteps()` returns which steps run and what each is worth, and `commandsFor()`
returns the exact argv. Both are pure, so the tests pin them.

Weights are not decoration: a cold start is dominated by `npm ci` and the clone,
a warm start is just `start`. Equal weights would park the bar at 20% through the
install and then jump to 100%, which reads as a hang — precisely what a progress
notification exists to prevent. The weights always total exactly 100, checked
across all sixteen combinations, so the caller can report each step's weight as
an increment without tracking a running total.

`needsBuild` is decided **before** planning. A step that is planned and then
skipped still owns its slice of the bar, which made a warm start jump 72% in one
tick.

Two things the install command must not do, both pinned by tests:

- **not** `--omit=dev` — `npm run build` is `tsc`, and typescript is a
  devDependency, so omitting them installs a tree that cannot build itself.
- **not** `--ignore-scripts` — `better-sqlite3` and `sharp` need their install
  scripts to produce working binaries.

Updating fetches and hard-resets rather than pulling: `git pull` can stop on a
divergence to ask a question nobody can see, hanging the progress bar behind an
invisible prompt.

## Security posture

- **No shell, ever.** Every spawn uses an argv array with `shell: false` stated
  explicitly, and a test asserts it. Paths and repository URLs reach these
  commands; TreeMap's whole safety story is that it never builds a command
  string out of a path.
- **`treemap.repositoryUrl` is a code-execution setting** and is validated as
  one: https/ssh remotes only, no leading dash, no whitespace or control
  characters. Bad values are refused rather than normalised, so a user learns
  their setting was wrong. A test asserts the shipped default passes its own
  validator — the repository name contains hyphens, and an over-strict validator
  that rejected its own default is exactly the bug that nearly shipped.
- **The webview CSP is `default-src 'none'` plus one `frame-src`**, built from
  `new URL(...).origin` so nothing in a path or query can reach it. Only http(s)
  is framed, which keeps `javascript:`, `data:` and `file:` out. The document
  runs no script of its own.
- **The child's environment is scrubbed of `TREEMAP_*`.** A user with
  `TREEMAP_TOKEN` exported would otherwise get a server demanding a bearer token
  the webview does not send, and a stray `TREEMAP_DATA_DIR` would silently move
  where their scan history is written.

## `?path=` in the frontend

The webview is cross-origin to the iframe, so the extension cannot script the
page. A query parameter is the only channel there is, so `public/index.html`
gained a boot hook: `?path=<folder>` scans that folder instead of restoring the
last session. It only ever fills the input and calls `startScan` — the same two
things the Browse… picker does — and every path check that matters is still the
server's.

## What could not be verified

**VS Code is not installed on this machine**, so the extension has never been
loaded into an Extension Development Host. Nothing here has been seen rendering
in a real editor. What *was* proven:

- `tsc` compiles it clean, and `vsce package` produces a 38 KB `.vsix` with no
  warnings — which validates the manifest, the icon path and `.vscodeignore`.
- 30 unit tests over the pure logic, in the main suite.
- The whole setup-and-start path driven **headlessly** through the real
  `prepare()` and `startServer()` — possible precisely because they do not
  import `vscode`. Both paths were run for real:
  - **workspace**: `locate → start`, server ready, page served, clean SIGTERM.
  - **cold clone**: `locate → clone → install → build → start`, weights summing
    to 100, a real `git clone` from GitHub, a real `npm ci`, a real build, server
    ready on a real port, clean shutdown.

The cold-clone run served a page *without* the Stop button, which is the correct
result and worth recording: it cloned `main` from GitHub, which does not yet
carry the cancellation commit. That is the proof it genuinely fetched the remote
rather than quietly reusing the local tree.

What remains unproven is everything that needs an editor: the progress
notification's appearance, the panel, `asExternalUri` in a remote window, and the
Explorer context-menu entry. The `.vsix` is installable; a human with VS Code is
the only way to see it.
