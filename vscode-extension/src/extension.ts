import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let serverProcess: cp.ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand('treemap.analyze', async () => {
    const storageUri = context.globalStorageUri;
    const destFolder = path.join(storageUri.fsPath, 'TreeMapPlugin');

    try {
      if (!fs.existsSync(storageUri.fsPath)) {
        fs.mkdirSync(storageUri.fsPath, { recursive: true });
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "TreeMap Visualizer",
        cancellable: false
      }, async (progress) => {
        // 1. Clone if not exists
        if (!fs.existsSync(destFolder)) {
          progress.report({ message: "Downloading visualizer..." });
          await runCommand(`git clone https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer.git "${destFolder}"`);
        }

        // 2. Install dependencies (skipping C++ build via --ignore-scripts to ensure multi-platform)
        if (!fs.existsSync(path.join(destFolder, 'node_modules'))) {
          progress.report({ message: "Installing lightweight dependencies..." });
          await runCommand(`npm install --ignore-scripts`, destFolder);
        }

        // 3. Start the process if not running
        if (!serverProcess) {
          progress.report({ message: "Starting local background scanner server..." });
          serverProcess = cp.spawn(/^win/.test(process.platform) ? 'npm.cmd' : 'npm', ['start'], { cwd: destFolder });
          
          await new Promise<void>((resolve) => {
            let started = false;
            serverProcess?.stdout?.on('data', (d) => {
              if (d.toString().includes('running') || d.toString().includes('4280') && !started) {
                started = true;
                resolve();
              }
            });
            setTimeout(() => { if (!started) { started = true; resolve(); } }, 3500);
          });
        }
      });
      
      // 4. Open in VS Code Webview
      const panel = vscode.window.createWebviewPanel(
        'treemapViewer',
        'Storage Visualizer',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      panel.webview.html = `<!DOCTYPE html>
        <html lang="en">
        <body style="padding:0;margin:0;overflow:hidden;width:100%;height:100vh;">
            <iframe src="http://127.0.0.1:4280/" style="width:100%;height:100%;border:none;background:#fff;"></iframe>
        </body>
        </html>`;

    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to start TreeMap Visualizer: " + e.message);
    }
  });

  context.subscriptions.push(disposable);
}

function runCommand(command: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export function deactivate() {
  if (serverProcess) {
    serverProcess.kill();
  }
}
