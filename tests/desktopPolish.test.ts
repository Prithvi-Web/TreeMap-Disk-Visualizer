import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';
import { formatBytes } from '../src/utils/formatBytes';
import { loadMain, DEFAULT_DISPLAY, FakeNotification, FakeTray, FakeWindow } from './fixtures/desktop/electronStub';

/**
 * Desktop polish round — the Electron shell.
 *
 * Electron cannot launch on the machine that runs this suite, so main.js is
 * split: every decision that matters is a pure function in electron/lib/
 * (tested directly), and main.js itself is loaded under a stub `electron`
 * module and driven the way the real shell drives it (tests/fixtures/desktop).
 * What the stub cannot prove is that Electron honours the requests — that the
 * dock really bounces — only that TreeMap asks for the right thing.
 */

const REPO = path.join(__dirname, '..');
const desktop = require(path.join(REPO, 'electron', 'lib', 'desktop.js'));
const guards = require(path.join(REPO, 'electron', 'lib', 'guards.js'));
const windowState = require(path.join(REPO, 'electron', 'lib', 'windowState.js'));
const menu = require(path.join(REPO, 'electron', 'lib', 'menu.js'));

const mkTmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tm-desktop-'));
const rm = (p: string): void => fs.rmSync(p, { recursive: true, force: true });

/* ═══════════════════════ security-electron-2: the API token ═══════════════════════ */

test('desktopToken mints a fresh 64-hex token, keeps one the owner set, and never repeats', () => {
  const minted = desktop.desktopToken({});
  assert.match(minted, /^[0-9a-f]{64}$/);
  assert.notEqual(desktop.desktopToken({}), minted, 'two launches never share a token');
  assert.equal(desktop.desktopToken({ TREEMAP_TOKEN: 'owner-chose-this' }), 'owner-chose-this');
  assert.match(desktop.desktopToken({ TREEMAP_TOKEN: '' }), /^[0-9a-f]{64}$/, 'an empty value is "unset"');
});

/* ═══════════════════════ security-electron-5: navigation guards ═══════════════════════ */

const ORIGIN = 'http://127.0.0.1:43210';

test('windowOpenDecision: own origin opens in-app, web links go to the browser, everything else dies quietly', () => {
  assert.deepEqual(guards.windowOpenDecision(`${ORIGIN}/`, ORIGIN), { action: 'allow' });
  assert.deepEqual(guards.windowOpenDecision('https://github.com/Prithvi-Web/x', ORIGIN), { action: 'deny', openExternal: 'https://github.com/Prithvi-Web/x' });
  assert.deepEqual(guards.windowOpenDecision('http://example.com/a', ORIGIN), { action: 'deny', openExternal: 'http://example.com/a' });
  assert.deepEqual(guards.windowOpenDecision('mailto:someone@example.com', ORIGIN), { action: 'deny', openExternal: 'mailto:someone@example.com' });
  // The old check was a string prefix: this host matched it and opened IN the app.
  const spoof = guards.windowOpenDecision('http://127.0.0.1.evil.tld/', ORIGIN);
  assert.equal(spoof.action, 'deny', 'a look-alike host is not the app');
  assert.equal(guards.windowOpenDecision('http://127.0.0.1:9999/', ORIGIN).action, 'deny', 'nor is another port');
  for (const url of ['file:///Applications/Evil.app', 'smb://nas/share', 'vnc://host', 'x-apple.systempreferences:', 'javascript:alert(1)', 'not a url']) {
    const d = guards.windowOpenDecision(url, ORIGIN);
    assert.equal(d.action, 'deny', url);
    assert.equal(d.openExternal, undefined, `${url} must never reach shell.openExternal`);
  }
});

test('navigationAllowed permits only the app origin', () => {
  assert.equal(guards.navigationAllowed(`${ORIGIN}/`, ORIGIN), true);
  assert.equal(guards.navigationAllowed(`${ORIGIN}/index.html?x=1`, ORIGIN), true);
  assert.equal(guards.navigationAllowed('http://127.0.0.1.evil.tld/', ORIGIN), false);
  assert.equal(guards.navigationAllowed('http://127.0.0.1:9999/', ORIGIN), false, 'a different port is a different server');
  assert.equal(guards.navigationAllowed('https://github.com/', ORIGIN), false);
  assert.equal(guards.navigationAllowed('file:///etc/hosts', ORIGIN), false);
  assert.equal(guards.navigationAllowed('garbage', ORIGIN), false);
});

test('permissionAllowed grants only what the app uses', () => {
  assert.equal(guards.permissionAllowed('notifications'), true);
  assert.equal(guards.permissionAllowed('clipboard-sanitized-write'), true, 'the tooltip copies paths');
  for (const p of ['media', 'geolocation', 'openExternal', 'fileSystem', 'display-capture', 'midi', 'pointerLock', 'unknown', 'clipboard-read', 'hid', 'usb', 'serial']) {
    assert.equal(guards.permissionAllowed(p), false, p);
  }
  assert.equal(guards.permissionAllowed(undefined), false);
});

/* ═══════════════════════ desktop-polish-3: window state ═══════════════════════ */

const DEFAULTS = { width: 1320, height: 880, minWidth: 1024, minHeight: 700 };
const laptop = DEFAULT_DISPLAY;
const external = { id: 2, bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, workArea: { x: 1920, y: -175, width: 2560, height: 1415 } };
const small = { id: 3, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 25, width: 1280, height: 695 } };

test('windowStateFor: nothing saved → the default size, shrunk to fit the primary work area, centred by Electron', () => {
  const st = windowState.windowStateFor(undefined, [laptop], DEFAULTS);
  assert.deepEqual(st, { width: 1320, height: 880, maximized: false, fullScreen: false });
  const tight = windowState.windowStateFor(null, [small], DEFAULTS);
  assert.equal(tight.width, 1280, 'a 1320px default on a 1280px display would hang off the edge');
  assert.equal(tight.height, 695);
  assert.equal(tight.x, undefined);
});

test('windowStateFor: a window on a display that is still there comes back exactly where it was', () => {
  const saved = { x: 2200, y: 40, width: 1600, height: 1000, maximized: false, fullScreen: false, displayId: 2 };
  const st = windowState.windowStateFor(saved, [laptop, external], DEFAULTS);
  assert.deepEqual(st, { x: 2200, y: 40, width: 1600, height: 1000, maximized: false, fullScreen: false });
});

test('windowStateFor: a window saved on a display that is gone falls back to the default', () => {
  const saved = { x: 2200, y: 40, width: 1600, height: 1000, maximized: false, fullScreen: false, displayId: 2 };
  const st = windowState.windowStateFor(saved, [laptop], DEFAULTS);
  assert.equal(st.x, undefined, 'never restore onto a display that is not plugged in');
  assert.equal(st.width, 1320);
});

test('windowStateFor: a window hanging off an edge is pulled back in, and one larger than the display is shrunk', () => {
  const off = windowState.windowStateFor({ x: 1500, y: 900, width: 1320, height: 880 }, [laptop], DEFAULTS);
  assert.equal(off.x + off.width, laptop.workArea.x + laptop.workArea.width, 'right edge on the work area');
  assert.equal(off.y + off.height, laptop.workArea.y + laptop.workArea.height, 'bottom edge on the work area');
  assert.equal(off.width, 1320);
  const big = windowState.windowStateFor({ x: -300, y: -300, width: 4000, height: 3000 }, [laptop], DEFAULTS);
  assert.deepEqual({ x: big.x, y: big.y, width: big.width, height: big.height }, { ...laptop.workArea });
});

test('windowStateFor: maximised and full-screen survive; garbage does not', () => {
  const st = windowState.windowStateFor({ x: 10, y: 30, width: 1100, height: 800, maximized: true, fullScreen: true }, [laptop], DEFAULTS);
  assert.equal(st.maximized, true);
  assert.equal(st.fullScreen, true);
  const junk = windowState.windowStateFor({ x: 'ten', y: NaN, width: 1100, height: 800 }, [laptop], DEFAULTS);
  assert.equal(junk.x, undefined);
  assert.equal(junk.width, 1320);
  const tiny = windowState.windowStateFor({ x: 10, y: 30, width: 200, height: 100 }, [laptop], DEFAULTS);
  assert.ok(tiny.width >= 1024 && tiny.height >= 700, 'a saved size below the minimum is lifted to it');
});

test('prefs file: round-trips, tolerates a corrupt file, and writes nothing in an ephemeral (read-only portable) session', () => {
  const dir = mkTmp();
  try {
    assert.deepEqual(windowState.readPrefs(dir), {}, 'first run: nothing there');
    windowState.writePrefs(dir, { window: { x: 1, y: 2, width: 1100, height: 800 }, skippedUpdate: '9.9.9' }, { ephemeral: false });
    assert.equal(windowState.readPrefs(dir).skippedUpdate, '9.9.9');
    assert.equal(windowState.readPrefs(dir).window.width, 1100);
    assert.deepEqual(fs.readdirSync(dir), [windowState.PREFS_FILE], 'the temp file from the atomic write is gone');
    fs.writeFileSync(path.join(dir, windowState.PREFS_FILE), '{not json');
    assert.deepEqual(windowState.readPrefs(dir), {}, 'a corrupt file is "nothing saved", never a crash');
    const eph = mkTmp();
    try {
      windowState.writePrefs(eph, { skippedUpdate: '1.0.0' }, { ephemeral: true });
      assert.deepEqual(fs.readdirSync(eph), [], 'a read-only portable run writes nothing anywhere');
    } finally { rm(eph); }
  } finally { rm(dir); }
});

/* ═══════════════════════ desktop-polish-4 / a11y-keyboard-8: the menu ═══════════════════════ */

function flatten(template: any[]): any[] {
  const out: any[] = [];
  for (const item of template) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu));
  }
  return out;
}
const noopActions = () => ({
  command: (name: string) => () => name,
  scanFolder: () => {}, scanHome: () => {}, checkForUpdates: () => {}, showDataFolder: () => {}, openExternal: (_u: string) => {}, about: () => {},
});
/** Electron's own defaults for the roles the template uses — an explicit accelerator must not collide with any of them. */
const ROLE_DEFAULTS = ['CmdOrCtrl+Q', 'CmdOrCtrl+W', 'CmdOrCtrl+Z', 'Shift+CmdOrCtrl+Z', 'CmdOrCtrl+X', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+A',
  'CmdOrCtrl+H', 'Alt+CmdOrCtrl+H', 'CmdOrCtrl+M', 'CmdOrCtrl+0', 'CmdOrCtrl+=', 'CmdOrCtrl+-', 'Ctrl+CmdOrCtrl+F', 'CmdOrCtrl+Shift+R', 'Alt+CmdOrCtrl+I'];

test('packaged menu: no Reload, no Developer Tools, and ⌘R belongs to Rescan alone', () => {
  for (const isMac of [true, false]) {
    const items = flatten(menu.buildMenuTemplate({ isMac, isPackaged: true, actions: noopActions() }));
    const roles = items.map((i) => i.role).filter(Boolean);
    for (const r of ['reload', 'forceReload', 'toggleDevTools']) assert.ok(!roles.includes(r), `${r} shipped to users (isMac=${isMac})`);
    const onR = items.filter((i) => (i.accelerator || '').toLowerCase() === 'cmdorctrl+r');
    assert.equal(onR.length, 1);
    assert.equal(onR[0].label, 'Rescan');
  }
});

test('development menu keeps Reload and Developer Tools, but Reload is off ⌘R so it can never eat a rescan', () => {
  const items = flatten(menu.buildMenuTemplate({ isMac: true, isPackaged: false, actions: noopActions() }));
  const reload = items.find((i) => i.role === 'reload');
  assert.ok(reload, 'developers keep Reload');
  assert.ok(reload.accelerator, 'with an explicit accelerator, or Electron gives it ⌘R');
  assert.notEqual(reload.accelerator.toLowerCase(), 'cmdorctrl+r');
  assert.ok(items.some((i) => i.role === 'toggleDevTools'));
});

test('every explicit accelerator is unique and collides with no role default', () => {
  for (const isMac of [true, false]) for (const isPackaged of [true, false]) {
    const accs = menu.collectAccelerators(menu.buildMenuTemplate({ isMac, isPackaged, actions: noopActions() })).map((a: string) => a.toLowerCase());
    assert.equal(new Set(accs).size, accs.length, `duplicate accelerator (isMac=${isMac}, packaged=${isPackaged}): ${accs.join(', ')}`);
    for (const a of accs) assert.ok(!ROLE_DEFAULTS.map((d) => d.toLowerCase()).includes(a), `${a} is already a role default`);
  }
});

test('the menu carries Settings (⌘,), Scan Folder…, Scan Home Folder, a Help menu, and About on every platform', () => {
  for (const isMac of [true, false]) {
    const t = menu.buildMenuTemplate({ isMac, isPackaged: true, actions: noopActions() });
    const items = flatten(t);
    const settings = items.find((i) => /^Settings/.test(i.label || ''));
    assert.ok(settings, `Settings item (isMac=${isMac})`);
    assert.equal(settings.accelerator, 'CmdOrCtrl+,');
    assert.ok(items.some((i) => i.label === 'Scan Folder…'));
    assert.ok(items.some((i) => i.label === 'Scan Home Folder'));
    assert.ok(items.some((i) => /^Check for Updates/.test(i.label || '')));
    assert.ok(items.some((i) => /^Report a Problem/.test(i.label || '')));
    assert.ok(items.some((i) => i.label === 'Show Data Folder'));
    const help = t.find((m: any) => m.role === 'help' || m.label === 'Help');
    assert.ok(help && Array.isArray(help.submenu), 'a Help menu exists (macOS gets its Help search field from it)');
    const about = items.filter((i) => i.role === 'about' || /^About TreeMap/.test(i.label || ''));
    assert.equal(about.length, 1, `exactly one About entry (isMac=${isMac})`);
    if (!isMac) assert.ok(about[0].label, 'Windows/Linux have no app menu, so About is a labelled item');
  }
});

test('menu clicks reach the right actions', () => {
  const calls: string[] = [];
  const actions = {
    command: (name: string) => () => calls.push(`command:${name}`),
    scanFolder: () => calls.push('scanFolder'), scanHome: () => calls.push('scanHome'),
    checkForUpdates: () => calls.push('checkForUpdates'), showDataFolder: () => calls.push('showDataFolder'),
    openExternal: (u: string) => calls.push(`open:${u}`), about: () => calls.push('about'),
  };
  const items = flatten(menu.buildMenuTemplate({ isMac: false, isPackaged: true, actions }));
  const click = (re: RegExp) => { const i = items.find((x) => re.test(x.label || '')); assert.ok(i && i.click, String(re)); i.click(); };
  click(/^Settings/); click(/^Rescan/); click(/^Command Palette/); click(/^Toggle Sidebar/); click(/^Keyboard Shortcuts/);
  click(/^Scan Folder/); click(/^Scan Home/); click(/^Check for Updates/); click(/^Show Data Folder/); click(/^Report a Problem/); click(/^About TreeMap/);
  assert.deepEqual(calls.slice(0, 5), ['command:settings', 'command:rescan', 'command:palette', 'command:sidebar', 'command:shortcuts']);
  assert.deepEqual(calls.slice(5, 9), ['scanFolder', 'scanHome', 'checkForUpdates', 'showDataFolder']);
  assert.match(calls[9], /^open:https:\/\/github\.com\/.*issues/);
  assert.equal(calls[10], 'about');
});

/* ═══════════════════════ copy-3: the growth notification ═══════════════════════ */

test('a growth alert is headlined by the folder and the number, never "folder growing fast"', () => {
  const n = desktop.growthNotification({
    path: '/Users/x/Downloads', message: '/Users/x/Downloads grew by 4.2 GB (8.1%) since the previous scan',
    prevSize: 52 * 1024 ** 3, newSize: 56.2 * 1024 ** 3, delta: 4.2 * 1024 ** 3,
  }, formatBytes);
  assert.equal(n.title, 'Downloads grew 4.2 GB since the last scan');
  assert.match(n.body, /\/Users\/x\/Downloads/);
  assert.match(n.body, /52\.0 GB/);
  assert.match(n.body, /56\.2 GB/);
  assert.doesNotMatch(n.title + n.body, /growing fast/i);
  assert.doesNotMatch(n.title, /^\//, 'the headline leads with a word, not a path');
  const shrank = desktop.growthNotification({ path: '/data', message: '', prevSize: 10e9, newSize: 8e9, delta: -2e9 }, formatBytes);
  assert.match(shrank.title, /shrank/);
});

test('a disk-full forecast gets its own headline with the days that matter', () => {
  const free = 120 * 1024 ** 3;
  const perDay = 10 * 1024 ** 3;
  const n = desktop.growthNotification({
    path: '/Users/x', message: 'At current growth, the disk holding /Users/x is full in ~12 days — top culprits: a, b',
    prevSize: free, newSize: free, delta: perDay,
  }, formatBytes);
  assert.equal(n.title, 'The disk holding x is full in about 12 days');
  assert.match(n.body, /120\.0 GB free/);
  assert.match(n.body, /10\.0 GB a day/);
  // The server may label the kind explicitly; that wins over the shape heuristic.
  const labelled = desktop.growthNotification({ kind: 'growth', path: '/a/b', message: '', prevSize: 5e9, newSize: 5e9, delta: 0 }, formatBytes);
  assert.match(labelled.title, /^b grew/);
  const oneDay = desktop.growthNotification({ kind: 'forecast', days: 1, path: '/', message: '', prevSize: free, newSize: free, delta: perDay }, formatBytes);
  assert.equal(oneDay.title, 'The disk holding / is full in about 1 day');
});

/* ═══════════════════════ desktop-polish-5: progress + finished ═══════════════════════ */

test('progressBarValue maps the page contract onto Electron: 0…1 shows, above 1 spins, anything else clears', () => {
  assert.equal(desktop.progressBarValue(0.5), 0.5);
  assert.equal(desktop.progressBarValue(0), 0);
  assert.equal(desktop.progressBarValue(1), 1);
  assert.equal(desktop.progressBarValue(2), 2);
  assert.equal(desktop.progressBarValue(1.5), 2, 'anything above 1 means indeterminate');
  for (const v of [-1, -0.5, null, undefined, NaN, 'abc', {}]) assert.equal(desktop.progressBarValue(v), -1, String(v));
});

test('scanFinishedNotice: says what finished and how much; silent when the user pressed Stop', () => {
  const ok = desktop.scanFinishedNotice({ ok: true, path: '/Volumes/Archive', files: 128400, bytes: 42.1 * 1024 ** 3 }, formatBytes);
  assert.equal(ok.title, 'Finished scanning Archive');
  assert.match(ok.body, /128,400 items/);
  assert.match(ok.body, /42\.1 GB/);
  assert.match(ok.body, /\/Volumes\/Archive/);
  const bare = desktop.scanFinishedNotice({ ok: true, path: '/x/y' }, formatBytes);
  assert.equal(bare.title, 'Finished scanning y');
  assert.equal(bare.body, '/x/y');
  const failed = desktop.scanFinishedNotice({ ok: false, path: '/x/y', error: "TreeMap isn't allowed to read /x/y." }, formatBytes);
  assert.equal(failed.title, "Couldn't finish scanning y");
  assert.match(failed.body, /isn't allowed/);
  assert.equal(desktop.scanFinishedNotice({ ok: false, path: '/x/y', stopped: true }, formatBytes), null);
  assert.equal(desktop.scanFinishedNotice(null, formatBytes), null);
});

/* ═══════════════════════ desktop-polish-8: the scan queue ═══════════════════════ */

test('ScanQueue: folders scan one at a time, in the order dropped, files resolve to their folder, repeats are ignored', () => {
  const resolve = (p: string) => (p.endsWith('.txt') ? path.dirname(p) : p.startsWith('missing') ? null : p);
  const q = new desktop.ScanQueue(resolve);
  const r = q.enqueue(['/a', '/b/file.txt', '/a', 'missing-1', '/c']);
  assert.deepEqual(r.queued, ['/a', '/b', '/c']);
  assert.deepEqual(r.ignored, ['/a', 'missing-1']);
  assert.equal(q.next(), '/a');
  assert.equal(q.next(), null, 'nothing more until /a finishes — the page refuses a second scan while one runs');
  q.finished();
  assert.equal(q.next(), '/b');
  q.finished();
  assert.equal(q.next(), '/c');
  q.finished();
  assert.equal(q.next(), null);
  assert.deepEqual(q.enqueue(['/c']).queued, ['/c'], 'once finished, the same folder can be queued again');
});

test('ScanQueue: a scan the page started itself holds the queue until it reports finished; a reload releases it but keeps what is waiting', () => {
  const q = new desktop.ScanQueue((p: string) => p);
  q.markBusy();
  q.enqueue(['/dropped']);
  assert.equal(q.next(), null, 'the page is scanning something of its own');
  q.finished();
  assert.equal(q.next(), '/dropped');
  q.enqueue(['/second']);
  q.reset();
  assert.deepEqual(q.pending, ['/second'], 'a page reload forgets what was running, not what was asked for');
  assert.equal(q.next(), '/second', 'after a reload nothing is running, whatever was dispatched before');
  q.finished();
  q.finished();
  assert.equal(q.next(), null, 'finishing twice is harmless');
});

/* ═══════════════════════ copy-4: the crash dialog ═══════════════════════ */

test('the crash dialog is calm, keeps the stack for the clipboard and the log, and offers Copy details', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'x')");
  err.stack = `TypeError: Cannot read properties of undefined (reading 'x')\n    at Object.<anonymous> (/Applications/TreeMap.app/Contents/Resources/app.asar/dist/services/x.js:412:17)\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)`;
  const d = desktop.crashDialogFor(err, { version: '4.1.3', platform: 'darwin', arch: 'arm64', electron: '31.7.7' });
  assert.equal(d.message, 'TreeMap hit an unexpected error.');
  assert.doesNotMatch(d.detail, /\bat \S+ \(|app\.asar|\.js:\d+|node:internal|TypeError/, 'no stack, no paths, no class names in the dialog');
  assert.match(d.detail, /keeps running/i);
  assert.match(d.detail, /Copy details/);
  assert.deepEqual(d.buttons, ['OK', 'Copy details']);
  assert.equal(d.cancelId, 0);
  assert.equal(d.copyIndex, 1);
  assert.match(d.details, /TreeMap 4\.1\.3/);
  assert.match(d.details, /darwin arm64/);
  assert.match(d.details, /x\.js:412:17/, 'the clipboard text carries the whole stack');
  const bare = desktop.crashDialogFor('just a string', { version: '4.1.3', platform: 'linux', arch: 'x64', electron: '31.7.7' });
  assert.match(bare.details, /just a string/);
  assert.equal(bare.buttons.length, 2);
});

/* ═══════════════════════ docs-release-5: About ═══════════════════════ */

test('the About panel names the version, the real copyright holder, the licence, and says what TreeMap is in one line', () => {
  const o = desktop.aboutPanelOptions({ version: '4.1.3' });
  assert.equal(o.applicationName, 'TreeMap');
  assert.equal(o.applicationVersion, '4.1.3');
  assert.match(o.copyright, /Prithvi Vinay/);
  assert.match(o.copyright, /MIT/);
  assert.match(o.credits, /disk/i);
  assert.doesNotMatch(o.credits, /\n/, 'one line');
  assert.match(o.website, /^https:\/\/github\.com\//);
});

/* ═══════════════════════ desktop-polish-6: the update flow ═══════════════════════ */

test('updateOffer: a skipped version stays skipped, one offer per run, and the running version is never "available"', () => {
  assert.equal(desktop.updateOffer({ version: '4.2.0', current: '4.1.3', skippedVersion: undefined, offered: new Set() }), true);
  assert.equal(desktop.updateOffer({ version: '4.2.0', current: '4.1.3', skippedVersion: '4.2.0', offered: new Set() }), false);
  assert.equal(desktop.updateOffer({ version: '4.2.1', current: '4.1.3', skippedVersion: '4.2.0', offered: new Set() }), true, 'skipping 4.2.0 does not skip 4.2.1');
  assert.equal(desktop.updateOffer({ version: '4.2.0', current: '4.1.3', skippedVersion: undefined, offered: new Set(['4.2.0']) }), false);
  assert.equal(desktop.updateOffer({ version: '4.1.3', current: '4.1.3', skippedVersion: undefined, offered: new Set() }), false);
});

test('the macOS update dialog explains Open Anyway, names the right download, and never mentions right-click', () => {
  const d = desktop.updateDialogCopy({ version: '4.2.0', current: '4.1.3', arch: 'arm64' });
  assert.equal(d.message, 'TreeMap 4.2.0 is available.');
  assert.match(d.detail, /You have 4\.1\.3/);
  assert.match(d.detail, /TreeMap-4\.2\.0-arm64\.dmg/);
  assert.match(d.detail, /Open Anyway/);
  assert.match(d.detail, /about an hour/);
  assert.doesNotMatch(d.detail, /right-click|control-click/i, 'Apple removed that path in Sequoia');
  assert.deepEqual(d.buttons, ['Download', 'Skip This Version', 'Later']);
  assert.equal(d.cancelId, 2);
  assert.equal(d.skipIndex, 1);
  assert.equal(d.downloadIndex, 0);
  assert.match(desktop.updateDialogCopy({ version: '4.2.0', current: '4.1.3', arch: 'x64' }).detail, /TreeMap-4\.2\.0-x64\.dmg/);
});

/* ═══════════════════════ desktop-polish-1 / -7: the icons ═══════════════════════ */

const sharp = require('sharp');
type Px = [number, number, number, number];
async function pixels(file: string): Promise<{ width: number; height: number; at: (x: number, y: number) => Px; all: () => Px[] }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Px => {
    const i = (y * info.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const all = (): Px[] => { const out: Px[] = []; for (let i = 0; i < data.length; i += 4) out.push([data[i], data[i + 1], data[i + 2], data[i + 3]]); return out; };
  return { width: info.width, height: info.height, at, all };
}
const lum = ([r, g, b]: Px): number => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Px, b: Px): number => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

async function assertMacIcon(file: string): Promise<void> {
  const p = await pixels(file);
  assert.equal(p.width, 1024); assert.equal(p.height, 1024);
  for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [60, 512], [512, 60], [963, 512]]) {
    assert.equal(p.at(x, y)[3], 0, `(${x},${y}) must be transparent — it is outside Apple's 824px tile`);
  }
  assert.equal(p.at(512, 512)[3], 255, 'the tile itself is opaque');
  assert.equal(p.at(110, 512)[3], 255, 'the tile starts 100px in (the Dock-neighbour margin)');
}
async function assertFullBleedIcon(file: string): Promise<void> {
  const p = await pixels(file);
  assert.equal(p.width, 1024); assert.equal(p.height, 1024);
  for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [20, 20]]) assert.equal(p.at(x, y)[3], 0, `corner (${x},${y})`);
  assert.equal(p.at(8, 512)[3], 255, 'full bleed: the tile reaches the edge');
  assert.equal(p.at(512, 512)[3], 255);
}
async function assertColourTray(file: string, size: number): Promise<void> {
  const p = await pixels(file);
  assert.equal(p.width, size); assert.equal(p.height, size);
  const px = p.all();
  const opaque = px.filter((c) => c[3] === 255);
  const colours = new Set(opaque.map((c) => c.slice(0, 3).join(',')));
  assert.ok(colours.size >= 3, `the three tiles: got ${colours.size} colour(s)`);
  assert.ok(!colours.has('0,0,0'), 'pure black is the template icon, invisible on a dark tray');
  assert.ok(px.some((c) => c[3] === 0), 'transparent background');
  assert.ok(opaque.some((c) => contrast(c, [255, 255, 255, 255]) >= 3), 'something reads on a light tray');
  assert.ok(opaque.some((c) => contrast(c, [0, 0, 0, 255]) >= 3), 'something reads on a dark tray');
}
async function assertTemplateTray(file: string, size: number): Promise<void> {
  const p = await pixels(file);
  assert.equal(p.width, size);
  const opaque = p.all().filter((c) => c[3] > 0);
  assert.ok(opaque.length > 0);
  assert.ok(opaque.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0), 'a macOS template image is black + alpha only');
}

test('the shipped app icon is transparent outside the rounded tile and sits on Apple\'s 824px grid', async () => {
  await assertMacIcon(path.join(REPO, 'build', 'icon.png'));
});

test('the full-bleed icon for Windows/Linux has transparent corners and no margin', async () => {
  await assertFullBleedIcon(path.join(REPO, 'build', 'icon-full.png'));
});

test('the shipped tray icons: a template glyph for macOS, a colour glyph with contrast on both tray shades elsewhere', async () => {
  const assets = path.join(REPO, 'electron', 'assets');
  await assertTemplateTray(path.join(assets, 'trayTemplate.png'), 16);
  await assertTemplateTray(path.join(assets, 'trayTemplate@2x.png'), 32);
  await assertColourTray(path.join(assets, 'tray.png'), 16);
  await assertColourTray(path.join(assets, 'tray@2x.png'), 32);
});

test('the icon generator reproduces every shipped icon with the same invariants', async () => {
  const out = mkTmp();
  try {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gen-tray-icon.js'), '--out', out], { stdio: 'pipe' });
    await assertMacIcon(path.join(out, 'build', 'icon.png'));
    await assertFullBleedIcon(path.join(out, 'build', 'icon-full.png'));
    await assertTemplateTray(path.join(out, 'electron', 'assets', 'trayTemplate.png'), 16);
    await assertColourTray(path.join(out, 'electron', 'assets', 'tray.png'), 16);
    await assertColourTray(path.join(out, 'electron', 'assets', 'tray@2x.png'), 32);
  } finally { rm(out); }
});

/* ═══════════════════════ preload: the bridge the page sees ═══════════════════════ */

function loadPreload() {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const invoked: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  let exposed: { name: string; api: Record<string, any> } | null = null;
  const electron = {
    contextBridge: { exposeInMainWorld(name: string, api: Record<string, any>) { exposed = { name, api }; } },
    ipcRenderer: {
      send(channel: string, ...args: unknown[]) { sent.push({ channel, args }); },
      invoke(channel: string, ...args: unknown[]) { invoked.push({ channel, args }); return Promise.resolve('invoked'); },
      on(channel: string, fn: (event: unknown, ...args: unknown[]) => void) { listeners.set(channel, fn); },
    },
    webUtils: { getPathForFile: (f: { name: string }) => `/dropped/${f.name}` },
  };
  const mod = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const orig = mod._load;
  mod._load = function (r: string, p: unknown, m: boolean) { return r === 'electron' ? electron : orig.call(this, r, p, m); };
  const file = path.join(REPO, 'electron', 'preload.js');
  try {
    delete require.cache[file];
    require(file);
  } finally {
    mod._load = orig;
    delete require.cache[file];
  }
  assert.ok(exposed, 'preload exposes an API');
  return { api: exposed!.api, name: exposed!.name, sent, invoked, listeners };
}

test('preload exposes the documented desktop bridge and routes each call to its IPC channel', async () => {
  const { api, name, sent, invoked, listeners } = loadPreload();
  assert.equal(name, 'treemapDesktop');
  for (const m of ['getPathForFile', 'resolveScanPath', 'onScanPath', 'requestScans', 'scanProgress', 'scanFinished', 'onCommand']) {
    assert.equal(typeof api[m], 'function', m);
  }
  assert.equal(api.getPathForFile({ name: 'a.txt' }), '/dropped/a.txt');
  await api.resolveScanPath('/x');
  await api.requestScans(['/a', '/b']);
  api.scanProgress(0.4);
  api.scanFinished({ ok: true, path: '/a' });
  assert.deepEqual(invoked.map((i) => i.channel), ['treemap:resolve-scan-path', 'treemap:request-scans']);
  assert.deepEqual(invoked[1].args, [['/a', '/b']]);
  assert.deepEqual(sent, [
    { channel: 'treemap:scan-progress', args: [0.4] },
    { channel: 'treemap:scan-finished', args: [{ ok: true, path: '/a' }] },
  ]);
  const got: string[] = [];
  api.onScanPath((p: string) => got.push(`scan:${p}`));
  api.onCommand((n: string) => got.push(`cmd:${n}`));
  listeners.get('treemap:scan-path')!({}, '/dock');
  listeners.get('treemap:command')!({}, 'settings');
  assert.deepEqual(got, ['scan:/dock', 'cmd:settings']);
});

/* ═══════════════════════ main.js, driven through the stub ═══════════════════════ */

test('main: the backend starts with a fresh TREEMAP_TOKEN, and an owner-provided one is kept', async () => {
  const dir = mkTmp();
  let h = await loadMain({ dataDir: dir });
  try {
    const call = h.stub.backend.startServerCalls[0];
    assert.ok(call, 'server started');
    assert.match(String(call.tokenAtStart), /^[0-9a-f]{64}$/, 'the API is never open to any local process that finds the port');
    assert.equal(call.opts.host, '127.0.0.1');
  } finally { h.dispose(); }
  h = await loadMain({ dataDir: dir, token: 'mine' });
  try {
    assert.equal(h.stub.backend.startServerCalls[0].tokenAtStart, 'mine');
  } finally { h.dispose(); rm(dir); }
});

test('main: the window opens where it was last closed, and closing it saves the state', async () => {
  const dir = mkTmp();
  const external = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 25, width: 2560, height: 1415 } };
  windowState.writePrefs(dir, { window: { x: 2200, y: 40, width: 1600, height: 1000, maximized: false, fullScreen: false, displayId: 2 } }, { ephemeral: false });
  const h = await loadMain({ dataDir: dir, displays: [DEFAULT_DISPLAY, external] });
  try {
    const w = h.win();
    assert.equal(w.options.x, 2200); assert.equal(w.options.y, 40);
    assert.equal(w.options.width, 1600); assert.equal(w.options.height, 1000);
    assert.equal(w.options.minWidth, 1024);
    w.bounds = { x: 2300, y: 60, width: 1500, height: 900 };
    w.maximized = true;
    w.close();
    const saved = windowState.readPrefs(dir).window;
    assert.deepEqual({ x: saved.x, y: saved.y, width: saved.width, height: saved.height, maximized: saved.maximized }, { x: 2300, y: 60, width: 1500, height: 900, maximized: true });
    assert.equal(saved.displayId, 2);
  } finally { h.dispose(); rm(dir); }
});

test('main: a saved position on a display that is gone, or no saved state, gives the default window that fits the screen', async () => {
  const dir = mkTmp();
  windowState.writePrefs(dir, { window: { x: 2200, y: 40, width: 1600, height: 1000, displayId: 2 } }, { ephemeral: false });
  const small = { id: 3, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 25, width: 1280, height: 695 } };
  const h = await loadMain({ dataDir: dir, displays: [small] });
  try {
    const w = h.win();
    assert.equal(w.options.x, undefined, 'centred by Electron, not restored off-screen');
    assert.equal(w.options.width, 1280);
    assert.equal(w.options.height, 695);
  } finally { h.dispose(); rm(dir); }
});

test('main: an ephemeral portable session never writes the prefs file', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, ephemeral: true });
  try {
    h.win().close();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { h.dispose(); rm(dir); }
});

test('main: navigation and permission guards are installed on the real window and session', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir });
  try {
    const w = h.win();
    const origin = `http://127.0.0.1:${h.stub.backend.port}`;
    assert.equal(w.url, `${origin}/`);
    const open = w.webContents.windowOpenHandler!;
    assert.deepEqual(open({ url: `${origin}/` }), { action: 'allow' });
    assert.deepEqual(open({ url: 'file:///Applications/Evil.app' }), { action: 'deny' });
    assert.deepEqual(h.stub.shell.opened, [], 'file: never reached the OS');
    assert.deepEqual(open({ url: 'https://github.com/x' }), { action: 'deny' });
    assert.deepEqual(h.stub.shell.opened, ['https://github.com/x']);
    let prevented = 0;
    const nav = (url: string) => w.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, url);
    nav(`${origin}/`); assert.equal(prevented, 0, 'the app may navigate to itself');
    nav('https://example.com/'); assert.equal(prevented, 1);
    nav('http://127.0.0.1.evil.tld/'); assert.equal(prevented, 2);
    const s = h.stub.session.defaultSession;
    assert.ok(s.permissionRequestHandler && s.permissionCheckHandler, 'both permission handlers are set');
    const asked: boolean[] = [];
    s.permissionRequestHandler!({}, 'media', (ok) => asked.push(ok));
    s.permissionRequestHandler!({}, 'notifications', (ok) => asked.push(ok));
    assert.deepEqual(asked, [false, true]);
    assert.equal(s.permissionCheckHandler!({}, 'geolocation'), false);
    assert.equal(s.permissionCheckHandler!({}, 'clipboard-sanitized-write'), true);
  } finally { h.dispose(); rm(dir); }
});

test('main: scan progress drives the dock bar; a finish while unfocused bounces the dock and posts a notice; Stop is silent', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, focused: false });
  try {
    await h.loadPage();
    const w = h.win();
    h.stub.ipcMain.fire('treemap:scan-progress', 2);
    h.stub.ipcMain.fire('treemap:scan-progress', 0.3);
    h.stub.ipcMain.fire('treemap:scan-progress', 'junk');
    assert.deepEqual(w.progress, [2, 0.3, -1]);
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: true, path: '/Volumes/Archive', files: 10, bytes: 1024 ** 3 });
    assert.equal(w.progress.at(-1), -1, 'the bar is cleared when the scan ends');
    assert.deepEqual(h.stub.app.dockBounces, ['informational']);
    assert.equal(FakeNotification.shown.length, 1);
    assert.equal(FakeNotification.shown[0].title, 'Finished scanning Archive');
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: false, path: '/x', stopped: true });
    assert.equal(FakeNotification.shown.length, 1, 'Stop is the user\'s own action — no notice');
    assert.deepEqual(h.stub.app.dockBounces, ['informational'], 'and no bounce');
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: false, path: '/x', error: 'boom' });
    assert.deepEqual(h.stub.app.dockBounces, ['informational', 'critical']);
    w.focused = true;
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: true, path: '/y' });
    assert.equal(FakeNotification.shown.length, 2, 'a focused window needs no notice: the user is looking at it');
    assert.equal(h.stub.app.dockBounces.length, 2);
  } finally { h.dispose(); rm(dir); }
});

test('main (Windows): a finish while unfocused flashes the taskbar button, and focus stops the flash', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, focused: false, platform: 'win32' });
  try {
    await h.loadPage();
    const w = h.win();
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: true, path: 'C:\\Users\\x\\Downloads' });
    assert.deepEqual(w.flashes, [true]);
    assert.equal(h.stub.app.dockBounces.length, 0, 'no dock on Windows');
    w.emit('focus');
    assert.deepEqual(w.flashes, [true, false]);
    assert.equal(h.stub.app.appUserModelId, 'com.prithviweb.treemap', 'toasts need the AppUserModelID to match the Start-menu shortcut');
  } finally { h.dispose(); rm(dir); }
});

test('main: dropped folders are queued and scanned one after another, in order; files resolve to their folder', async () => {
  const dir = mkTmp();
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b'); const c = path.join(dir, 'c');
  for (const d of [a, b, c]) fs.mkdirSync(d);
  const file = path.join(b, 'note.txt'); fs.writeFileSync(file, 'x');
  const h = await loadMain({ dataDir: dir });
  try {
    const w = h.win();
    const paths = () => w.webContents.on_channel('treemap:scan-path');
    const r = await h.stub.ipcMain.invoke('treemap:request-scans', [a, file, a, path.join(dir, 'missing'), c]) as { queued: string[]; ignored: string[] };
    assert.deepEqual(r.queued, [a, b, c]);
    assert.deepEqual(r.ignored, [a, path.join(dir, 'missing')]);
    assert.deepEqual(paths(), [], 'nothing is pushed before the page has loaded');
    await h.loadPage();
    assert.deepEqual(paths(), [a]);
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: true, path: a });
    await new Promise((r2) => setTimeout(r2, 400));
    assert.deepEqual(paths(), [a, b]);
    h.stub.ipcMain.fire('treemap:scan-progress', -1);
    await new Promise((r2) => setTimeout(r2, 400));
    assert.deepEqual(paths(), [a, b, c], 'a cleared progress bar also means "done" — the queue never stalls on a page that only reports progress');
    assert.equal(await h.stub.ipcMain.invoke('treemap:request-scans', 'not-an-array'), null);
    assert.equal(h.stub.ipcMain.invoke('treemap:resolve-scan-path', file), b, 'the older single-path resolver still works');
  } finally { h.dispose(); rm(dir); }
});

test('main: folders handed over by the OS before the window exists (dock drop, second launch) scan in order once the page is up', async () => {
  const dir = mkTmp();
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const h = await loadMain({ dataDir: dir });
  try {
    const w = h.win();
    h.stub.app.emit('open-file', { preventDefault() {} }, a);
    h.stub.app.emit('open-file', { preventDefault() {} }, b);
    assert.deepEqual(w.webContents.on_channel('treemap:scan-path'), []);
    await h.loadPage();
    assert.deepEqual(w.webContents.on_channel('treemap:scan-path'), [a]);
    h.stub.ipcMain.fire('treemap:scan-finished', { ok: true, path: a });
    await new Promise((r2) => setTimeout(r2, 400));
    assert.deepEqual(w.webContents.on_channel('treemap:scan-path'), [a, b]);
  } finally { h.dispose(); rm(dir); }
});

test('main: the application menu is the packaged template, and its items reach the page as commands', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, isPackaged: true });
  try {
    await h.loadPage();
    const applied = h.stub.Menu.applied;
    assert.ok(applied, 'an application menu was set');
    const items = flatten(applied.template as any[]);
    assert.ok(!items.some((i) => i.role === 'toggleDevTools'), 'no Developer Tools for users');
    assert.ok(!items.some((i) => i.role === 'reload'));
    const rescan = items.find((i) => i.label === 'Rescan');
    rescan.click();
    const settings = items.find((i) => /^Settings/.test(i.label || ''));
    settings.click();
    assert.deepEqual(h.win().webContents.on_channel('treemap:command'), ['rescan', 'settings']);
    assert.ok(h.win().visible, 'a menu command brings the window forward');
    items.find((i) => i.label === 'Show Data Folder').click();
    assert.deepEqual(h.stub.shell.openedPaths, [dir]);
    assert.equal(h.stub.app.aboutOptions?.applicationVersion, '4.1.3');
    assert.match(String(h.stub.app.aboutOptions?.copyright), /Prithvi Vinay/);
  } finally { h.dispose(); rm(dir); }
});

test('main: the tray uses the template glyph on macOS and the colour glyph elsewhere; Linux quits with the last window', async () => {
  const dir = mkTmp();
  let h = await loadMain({ dataDir: dir, platform: 'darwin' });
  try {
    assert.equal(path.basename(FakeTray.created[0].icon.path), 'trayTemplate.png');
    assert.equal(FakeTray.created[0].icon.template, true);
    h.stub.app.emit('window-all-closed');
    assert.equal(h.stub.app.quitCalls, 0, 'macOS stays in the menu bar');
  } finally { h.dispose(); }
  h = await loadMain({ dataDir: dir, platform: 'win32' });
  try {
    assert.equal(path.basename(FakeTray.created[0].icon.path), 'tray.png');
    assert.equal(FakeTray.created[0].icon.template, false);
    h.stub.app.emit('window-all-closed');
    assert.equal(h.stub.app.quitCalls, 0, 'Windows has a tray icon that works, so it stays');
  } finally { h.dispose(); }
  h = await loadMain({ dataDir: dir, platform: 'linux' });
  try {
    assert.equal(path.basename(FakeTray.created[0].icon.path), 'tray.png');
    h.stub.app.emit('window-all-closed');
    assert.equal(h.stub.app.quitCalls, 1, 'a Linux desktop may have no tray host at all — never strand an invisible process');
  } finally { h.dispose(); rm(dir); }
});

test('main: a growth alert arrives under the folder-and-number headline', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir });
  try {
    h.growth({ path: '/Users/x/Downloads', message: '/Users/x/Downloads grew by 4.2 GB (8.1%) since the previous scan', prevSize: 52 * 1024 ** 3, newSize: 56.2 * 1024 ** 3, delta: 4.2 * 1024 ** 3 });
    assert.equal(FakeNotification.shown.length, 1);
    assert.equal(FakeNotification.shown[0].title, 'Downloads grew 4.2 GB since the last scan');
    assert.doesNotMatch(String(FakeNotification.shown[0].body), /^\//);
  } finally { h.dispose(); rm(dir); }
});

test('main (packaged): an uncaught exception shows one calm dialog; Copy details puts the stack on the clipboard; a second throw shows nothing', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, isPackaged: true });
  const quiet = console.error;
  console.error = () => {};
  try {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at thing (/Applications/TreeMap.app/Contents/Resources/app.asar/dist/x.js:1:2)';
    h.stub.dialog.responses.push(1);
    h.crash(err);
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1);
    const box = h.stub.dialog.boxes[0].opts;
    assert.doesNotMatch(String(box.detail), /app\.asar|\.js:\d/);
    assert.deepEqual(box.buttons, ['OK', 'Copy details']);
    assert.equal(h.stub.clipboard.texts.length, 1);
    assert.match(h.stub.clipboard.texts[0], /x\.js:1:2/);
    h.crash(new Error('again'));
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1, 'no dialog storm');
  } finally { console.error = quiet; h.dispose(); rm(dir); }
});

test('main (macOS, packaged): updates are checked quietly after the page is up, offered once as a sheet, and a skipped version stays skipped across launches', async (t) => {
  const dir = mkTmp();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let h = await loadMain({ dataDir: dir, isPackaged: true, platform: 'darwin' });
  try {
    const u = h.stub.autoUpdater;
    assert.equal(u.autoDownload, false, 'an unsigned macOS build cannot install what it downloads');
    assert.equal(u.checks, 0, 'no check before the window exists');
    u.emit('update-available', { version: '4.2.0' });
    assert.equal(h.stub.dialog.boxes.length, 0, 'never a dialog before the window can parent it');
    await h.loadPage();
    assert.equal(u.checks, 0, 'still quiet right after load');
    t.mock.timers.tick(20_000);
    assert.equal(u.checks, 1, 'one quiet check, a little after launch');
    h.stub.dialog.responses.push(1); // Skip This Version
    u.emit('update-available', { version: '4.2.0' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1);
    assert.equal(h.stub.dialog.boxes[0].parent, h.win(), 'a sheet on the window, not a floating box');
    assert.deepEqual(h.stub.dialog.boxes[0].opts.buttons, ['Download', 'Skip This Version', 'Later']);
    assert.equal(windowState.readPrefs(dir).skippedUpdate, '4.2.0');
    u.emit('update-available', { version: '4.2.0' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1, 'skipped: no re-nag this run');
  } finally { h.dispose(); }
  h = await loadMain({ dataDir: dir, isPackaged: true, platform: 'darwin' });
  try {
    await h.loadPage();
    h.stub.autoUpdater.emit('update-available', { version: '4.2.0' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 0, 'skipped: no re-nag next launch either');
    h.stub.dialog.responses.push(0); // Download
    h.stub.autoUpdater.emit('update-available', { version: '4.2.1' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1, 'a newer version is offered again');
    assert.match(h.stub.shell.opened[0], /github\.com\/.*releases/);
  } finally { h.dispose(); rm(dir); }
});

test('main: Help › Check for Updates… reports "up to date" only when the user asked', async () => {
  const dir = mkTmp();
  const h = await loadMain({ dataDir: dir, isPackaged: true, platform: 'darwin' });
  try {
    await h.loadPage();
    const items = flatten(h.stub.Menu.applied!.template as any[]);
    const u = h.stub.autoUpdater;
    u.emit('update-not-available', { version: '4.1.3' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 0, 'a background check that finds nothing says nothing');
    items.find((i) => /^Check for Updates/.test(i.label || '')).click();
    assert.equal(u.checks, 1);
    u.emit('update-not-available', { version: '4.1.3' });
    await h.settle();
    assert.equal(h.stub.dialog.boxes.length, 1);
    assert.match(String(h.stub.dialog.boxes[0].opts.message), /up to date/i);
    assert.match(String(h.stub.dialog.boxes[0].opts.message), /4\.1\.3/);
  } finally { h.dispose(); rm(dir); }
});
