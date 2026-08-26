# TreeMap Disk Visualizer for VS Code

See what is eating your disk without leaving the editor.

This extension wraps [TreeMap](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer),
a disk-space visualizer. It fetches TreeMap, builds it, starts its local server,
and opens the visualizer in an editor tab.

## Commands

| Command | What it does |
| --- | --- |
| **TreeMap: Open Disk Visualizer** | Sets TreeMap up if needed, starts the server, opens the panel. |
| **TreeMap: Scan This Workspace Folder** | The same, already scanning that folder. Also on the Explorer's right-click menu. |
| **TreeMap: Stop the Local Server** | Stops the server. Closing the panel does this too. |
| **TreeMap: Show Server Log** | The server's output, and every command the setup ran. |
| **TreeMap: Reset the Local Copy** | Deletes the downloaded copy so the next open sets it up fresh. |

## What happens on first run

The first open does real work and says so as it goes, in one progress
notification you can cancel at any point:

1. **Looking for TreeMap** — if the folder you have open *is* the TreeMap
   repository, that working tree is used and nothing is downloaded.
2. **Downloading TreeMap** — otherwise a shallow clone into the extension's own
   storage. Nothing is written to your workspace.
3. **Installing dependencies** — `npm ci`. This is the slow part, usually under
   a minute.
4. **Building TreeMap** — `npm run build`.
5. **Starting the local server** — on a free port on `127.0.0.1`.

Later opens skip straight to step 5 unless there is an update to fast-forward.

## Requirements

- **Node.js 20 or newer** on your `PATH`. The extension checks before it starts
  and tells you if it is missing or too old.
- **git**, for the clone. Not needed if you are running the TreeMap repository
  as your workspace.

Node has to be a separate process rather than the editor's own: TreeMap uses
native modules (`better-sqlite3`, `sharp`) built for standard Node, and VS Code's
extension host is Electron, whose ABI differs. Loading the server in-process
would crash the extension host.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `treemap.repositoryUrl` | the official repo | Where TreeMap is cloned from. **This is code that will be executed** — only point it at a fork you control. |
| `treemap.gitRef` | `main` | Branch or tag to check out. |
| `treemap.useWorkspaceRepository` | `true` | Use the open workspace when it is the TreeMap repo. |
| `treemap.serverHost` | `127.0.0.1` | Bind address. Leave it unless you know why you are changing it. |
| `treemap.autoUpdate` | `true` | Fast-forward the downloaded copy on each open. |

Only the downloaded copy is ever updated. If you are running your own TreeMap
working tree, the extension never fetches, resets or otherwise touches it.

## What it does not do

- It does not scan anything on its own. Scans start when you ask for one.
- It does not send anything anywhere. The server binds loopback, and the panel
  talks only to that port.
- It does not delete files. TreeMap's own cleanup tools move things to the OS
  Trash, and only inside a folder you scanned — the same rules as the desktop app.

## Remote and Codespaces

The panel resolves its URL through `asExternalUri`, so the port is forwarded
automatically when you are working in a remote window, a container, or a
Codespace. The scan runs where the files are, which is the remote machine.

## Licence

MIT, same as TreeMap.
