'use strict';
/*
 * The application menu, as a template. Pure: main.js hands in the actions and
 * feeds the result to Menu.buildFromTemplate; the tests assert on the shape.
 *
 * Rules the template keeps:
 *  - ⌘R is Rescan. The page binds ⌘R itself while a folder is loaded; when it
 *    does not (welcome screen, first scan) the accelerator falls through to
 *    the menu, which sends the page a 'rescan' command instead of Electron's
 *    'reload' role blanking the window mid-scan. Reload and Developer Tools
 *    exist in development only, and Reload sits on ⌘⌥R there.
 *  - Every explicit accelerator is unique and collides with no role default.
 *  - Windows/Linux have no app menu, so Settings lives under File and About
 *    under Help; macOS keeps Apple's placement.
 *  - Every label TreeMap writes is in sentence case, as every word the page
 *    says is (the owner's rule; hunt S4): the roles' own labels are the
 *    system's.
 */
const REPO_URL = 'https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer';
const README_URL = `${REPO_URL}#readme`;
const ISSUES_URL = `${REPO_URL}/issues/new`;

const sep = () => ({ type: 'separator' });

/**
 * @param {{ isMac: boolean, isPackaged: boolean, actions: {
 *   command: (name: 'settings'|'palette'|'sidebar'|'shortcuts'|'rescan') => () => void,
 *   scanFolder: () => void, scanHome: () => void, checkForUpdates: () => void,
 *   showDataFolder: () => void, openExternal: (url: string) => void, about: () => void } }} opts
 */
function buildMenuTemplate({ isMac, isPackaged, actions }) {
  const send = (name) => actions.command(name);
  const settingsItem = () => ({ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') });

  const template = [];
  if (isMac) {
    template.push({
      label: 'TreeMap',
      submenu: [
        { role: 'about' },
        sep(),
        settingsItem(),
        sep(),
        { role: 'services' },
        sep(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep(),
        { role: 'quit' },
      ],
    });
  }
  template.push({
    label: 'File',
    submenu: [
      { label: 'Scan folder…', accelerator: 'CmdOrCtrl+O', click: () => actions.scanFolder() },
      { label: 'Scan home folder', click: () => actions.scanHome() },
      { label: 'Rescan', accelerator: 'CmdOrCtrl+R', click: send('rescan') },
      sep(),
      ...(isMac ? [] : [settingsItem(), sep()]),
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  });
  template.push({ role: 'editMenu' });
  template.push({
    label: 'View',
    submenu: [
      { label: 'Command palette…', accelerator: 'CmdOrCtrl+K', click: send('palette') },
      { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: send('sidebar') },
      sep(),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      sep(),
      { role: 'togglefullscreen' },
      ...(isPackaged ? [] : [sep(), { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' }, { role: 'toggleDevTools' }]),
    ],
  });
  template.push({ role: 'windowMenu' });
  template.push({
    role: 'help',
    submenu: [
      { label: 'Keyboard shortcuts', click: send('shortcuts') },
      { label: 'TreeMap help', click: () => actions.openExternal(README_URL) },
      { label: 'Report a problem…', click: () => actions.openExternal(ISSUES_URL) },
      sep(),
      { label: 'Check for updates…', click: () => actions.checkForUpdates() },
      { label: 'Show data folder', click: () => actions.showDataFolder() },
      ...(isMac ? [] : [sep(), { label: 'About TreeMap', click: () => actions.about() }]),
    ],
  });
  return template;
}

/** Every explicit accelerator in a template, depth-first. */
function collectAccelerators(template) {
  const out = [];
  for (const item of template) {
    if (item.accelerator) out.push(item.accelerator);
    if (Array.isArray(item.submenu)) out.push(...collectAccelerators(item.submenu));
  }
  return out;
}

module.exports = { buildMenuTemplate, collectAccelerators, REPO_URL, README_URL, ISSUES_URL };
