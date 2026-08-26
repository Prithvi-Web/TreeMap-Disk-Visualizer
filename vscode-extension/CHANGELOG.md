# Changelog

## 1.0.0

First release.

- **TreeMap: Open Disk Visualizer** — fetches TreeMap, builds it, starts its
  server on a free loopback port, and shows the visualizer in an editor tab.
  All of it runs under one cancellable progress notification.
- **TreeMap: Scan This Workspace Folder** — also on the Explorer's right-click
  menu for any folder.
- **TreeMap: Stop the Local Server**, **Show Server Log**, and
  **Reset the Local Copy**.
- Uses the open workspace's own working tree when that workspace *is* the
  TreeMap repository, instead of cloning a second copy.
