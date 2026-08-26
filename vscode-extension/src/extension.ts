import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as vscode from 'vscode';
import { findNode, Cancelled } from './exec';
import { prepare } from './workspace';
import { startServer, RunningServer } from './server';
import { buildMessageHtml, buildWebviewHtml } from './lib/webview';

/**
 * TreeMap Disk Visualizer — the editor-side wrapper.
 *
 * What this does, in order: find (or fetch) a TreeMap checkout, make sure it
 * is built, start its server as a CHILD process on a free loopback port, and
 * show the visualizer in a webview pointed at that port. All of it runs under
 * one cancellable progress notification, because the first run clones a
 * repository and installs its dependencies and that is not a quick operation
 * to leave unexplained.
 */

let server: RunningServer | null = null;
let panel: vscode.WebviewPanel | null = null;
let log: vscode.OutputChannel;
/**
 * The in-flight open, if there is one.
 *
 * VS Code does not serialise command invocations, so running "Open Disk
 * Visualizer" twice before the first finishes would run the whole setup twice
 * and spawn a second server — the first of which nothing holds a reference to
 * any more, leaving an orphaned process on a port until the machine reboots.
 * Everyone waits on the same promise instead.
 */
let opening: Promise<RunningServer | null> | null = null;

const PANEL_TYPE = 'treemap.visualizer';

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('TreeMap');
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.commands.registerCommand('treemap.open', () => openVisualizer(context)),
    vscode.commands.registerCommand('treemap.scanWorkspaceFolder', (target?: vscode.Uri) =>
      scanFolder(context, target),
    ),
    vscode.commands.registerCommand('treemap.stopServer', () => stopServer(true)),
    vscode.commands.registerCommand('treemap.showLog', () => log.show()),
    vscode.commands.registerCommand('treemap.resetInstall', () => resetInstall(context)),
    // Everything this extension starts is torn down with the window.
    new vscode.Disposable(() => stopServer(false)),
  );
}

export function deactivate(): void {
  stopServer(false);
}

function setRunningContext(running: boolean): void {
  void vscode.commands.executeCommand('setContext', 'treemap.serverRunning', running);
}

function stopServer(announce: boolean): void {
  if (server) {
    log.appendLine('[treemap] stopping the server');
    server.stop();
    server = null;
    setRunningContext(false);
    if (announce) void vscode.window.showInformationMessage('TreeMap: the local server has stopped.');
  } else if (announce) {
    void vscode.window.showInformationMessage('TreeMap: no server is running.');
  }
}

/** Where a clone lives — per-install storage the extension owns outright. */
function clonePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'treemap-src');
}

async function resetInstall(context: vscode.ExtensionContext): Promise<void> {
  const dir = clonePath(context);
  const choice = await vscode.window.showWarningMessage(
    'Delete TreeMap’s downloaded copy and set it up again next time?',
    { modal: true, detail: dir },
    'Delete',
  );
  if (choice !== 'Delete') return;
  stopServer(false);
  await fsp.rm(dir, { recursive: true, force: true });
  void vscode.window.showInformationMessage('TreeMap: the downloaded copy was removed.');
}

/**
 * Bring the server up if it is not already, then show the panel.
 *
 * Reveals an existing panel rather than making a second one: two webviews onto
 * the same server would each hold their own scan state and quietly disagree.
 */
async function openVisualizer(
  context: vscode.ExtensionContext,
  initialPath?: string,
): Promise<RunningServer | null> {
  if (server && panel) {
    if (initialPath) await showPanel(server, initialPath);
    else panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
    return server;
  }
  if (opening) return opening;
  opening = openOnce(context, initialPath).finally(() => { opening = null; });
  return opening;
}

async function openOnce(
  context: vscode.ExtensionContext,
  initialPath?: string,
): Promise<RunningServer | null> {
  const cfg = vscode.workspace.getConfiguration('treemap');
  const running = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'TreeMap',
      cancellable: true,
    },
    async (progress, token): Promise<RunningServer | null> => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        progress.report({ message: 'Checking your Node install' });
        const node = await findNode(process.env);
        log.appendLine(`[treemap] using ${node.path} (${node.version})`);

        const prepared = await prepare({
          repositoryUrl: String(cfg.get('repositoryUrl')),
          gitRef: String(cfg.get('gitRef')),
          useWorkspaceRepository: cfg.get<boolean>('useWorkspaceRepository') !== false,
          autoUpdate: cfg.get<boolean>('autoUpdate') !== false,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
          clonePath: clonePath(context),
          onStep: (step) => progress.report({ message: step.title, increment: step.weight }),
          onLog: (chunk) => log.append(chunk),
          signal: controller.signal,
        });
        log.appendLine(`[treemap] ${prepared.source.reason}: ${prepared.dir}`);

        progress.report({ message: 'Starting the local server' });
        const started = await startServer({
          nodePath: node.path,
          dir: prepared.dir,
          host: String(cfg.get('serverHost') || '127.0.0.1'),
          onLog: (chunk) => log.append(chunk),
          signal: controller.signal,
        });
        log.appendLine(`[treemap] server ready on ${started.url}`);
        return started;
      } catch (err) {
        if (err instanceof Cancelled || (err as Error)?.message === 'Cancelled') {
          log.appendLine('[treemap] cancelled');
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.appendLine(`[treemap] failed: ${message}`);
        const pick = await vscode.window.showErrorMessage(`TreeMap: ${message}`, 'Show Log');
        if (pick === 'Show Log') log.show();
        return null;
      }
    },
  );

  if (!running) return null;
  server = running;
  setRunningContext(true);
  await showPanel(running, initialPath);
  return running;
}

async function showPanel(running: RunningServer, initialPath?: string): Promise<void> {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(PANEL_TYPE, 'TreeMap', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The visualizer holds a whole scan in memory; letting VS Code tear the
      // webview down on tab-switch would throw that away and make the user
      // rescan every time they looked at a file.
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = null;
      // The panel is the only consumer; a server with no window is just a
      // process holding a port and a scan.
      stopServer(false);
    });
  }
  panel.webview.html = buildMessageHtml('Starting TreeMap…', 'Connecting to the local server.');
  // In a remote or Codespaces window the webview cannot reach 127.0.0.1
  // directly; asExternalUri sets up the port forward and hands back the URL
  // that actually resolves from where the webview runs.
  //
  // The query is attached AFTER that call, with `.with()`, rather than being
  // parsed in as part of the URL: forwarding rewrites the authority, and
  // round-tripping a query through parse/forward/toString is not something to
  // take on trust when the failure is silent (the page just scans the wrong
  // folder). toString(true) then leaves the already-encoded value alone
  // instead of encoding the percent signs a second time.
  const base = await vscode.env.asExternalUri(vscode.Uri.parse(running.url));
  const target = initialPath
    ? base.with({ query: `path=${encodeURIComponent(initialPath)}` })
    : base;
  panel.webview.html = buildWebviewHtml(target.toString(true));
  panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
}

/**
 * Open the visualizer already scanning a folder.
 *
 * The path is handed to the page as a query parameter rather than typed into
 * the DOM from here: the webview is cross-origin to the iframe, so the
 * extension cannot script it. `?path=` is the visualizer's boot hook for
 * exactly this — it takes priority over restoring the last session.
 */
async function scanFolder(context: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
  const folder = target ?? (vscode.workspace.workspaceFolders ?? [])[0]?.uri;
  if (!folder) {
    void vscode.window.showWarningMessage('TreeMap: open a folder first, or right-click one in the Explorer.');
    return;
  }
  if (folder.scheme !== 'file') {
    void vscode.window.showWarningMessage(
      `TreeMap scans a real filesystem, and "${folder.scheme}:" is not one.`,
    );
    return;
  }
  // Handed to openVisualizer rather than applied afterwards: setting the panel
  // HTML a second time reloads the page, and the first, path-less load would
  // have already started restoring the previous session — a full scan of a
  // different root that nobody asked for, racing the one they did.
  await openVisualizer(context, folder.fsPath);
}
