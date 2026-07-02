import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FileNode } from '../src/models/types';
import { attributeTree, builtinNames, AttributionContext } from '../src/services/appAttribution';

/**
 * Unit tests for the Apps-tab attribution rules. attributeTree is pure —
 * platform, home dir and the name map all come in through the context — so
 * every OS's rules can be exercised on any machine.
 */

function dir(p: string, children: FileNode[] = []): FileNode {
  return {
    name: path.basename(p) || p,
    path: p,
    size: children.reduce((s, c) => s + c.size, 0),
    type: 'dir',
    children,
    modifiedAt: 0,
    isHidden: false,
  };
}

function file(p: string, size: number): FileNode {
  return { name: path.basename(p), path: p, size, type: 'file', modifiedAt: 0, isHidden: false };
}

function ctxFor(platform: NodeJS.Platform, homeDir: string): AttributionContext {
  return { platform, homeDir, names: builtinNames() };
}

/* ---------------- macOS ---------------- */

const H = '/Users/t';
const j = (...parts: string[]) => path.join(H, ...parts);

function macTree(): FileNode {
  return dir(H, [
    dir(j('Library'), [
      dir(j('Library', 'Caches'), [
        dir(j('Library', 'Caches', 'com.google.Chrome'), [
          file(j('Library', 'Caches', 'com.google.Chrome', 'blob'), 100),
        ]),
        dir(j('Library', 'Caches', 'MyTool'), [
          file(j('Library', 'Caches', 'MyTool', 'x'), 40),
        ]),
      ]),
      dir(j('Library', 'Application Support'), [
        dir(j('Library', 'Application Support', 'Google'), [
          dir(j('Library', 'Application Support', 'Google', 'Chrome'), [
            file(j('Library', 'Application Support', 'Google', 'Chrome', 'Bookmarks'), 150),
            dir(j('Library', 'Application Support', 'Google', 'Chrome', 'Cache'), [
              file(j('Library', 'Application Support', 'Google', 'Chrome', 'Cache', 'c1'), 50),
            ]),
          ]),
        ]),
        dir(j('Library', 'Application Support', 'MyTool'), [
          file(j('Library', 'Application Support', 'MyTool', 'db'), 30),
        ]),
      ]),
      dir(j('Library', 'Logs'), [
        dir(j('Library', 'Logs', 'com.google.Chrome'), [
          file(j('Library', 'Logs', 'com.google.Chrome', 'log'), 10),
        ]),
      ]),
    ]),
    dir(j('Applications'), [
      dir(j('Applications', 'MyTool.app'), [
        file(j('Applications', 'MyTool.app', 'bin'), 500),
      ]),
    ]),
    file(j('Documents', 'report.pdf'), 700),
  ]);
}

test('macOS: bundle ids, vendor dirs and .app bundles merge into one app', () => {
  const r = attributeTree(macTree(), ctxFor('darwin', H));
  const chrome = r.apps.find((a) => a.name === 'Google Chrome');
  assert.ok(chrome, 'Chrome row exists');
  // Caches 100 + Application Support 200 (of which Cache 50) + Logs 10
  assert.equal(chrome.totalBytes, 310);
  assert.equal(chrome.bytesByCategory.cache, 150);
  assert.equal(chrome.bytesByCategory.data, 150);
  assert.equal(chrome.bytesByCategory.logs, 10);
});

test('macOS: safe-to-clear covers caches and logs, never data or the app', () => {
  const r = attributeTree(macTree(), ctxFor('darwin', H));
  const chrome = r.apps.find((a) => a.name === 'Google Chrome')!;
  assert.equal(chrome.safeToClearBytes, 160); // 100 caches + 50 profile Cache + 10 logs
  assert.ok(chrome.safeToClearPaths.includes(j('Library', 'Caches', 'com.google.Chrome')));
  assert.ok(chrome.safeToClearPaths.includes(j('Library', 'Application Support', 'Google', 'Chrome', 'Cache')));
  assert.ok(!chrome.safeToClearPaths.some((p) => p.endsWith('Bookmarks') || p.includes('MyTool')));

  const tool = r.apps.find((a) => a.name === 'MyTool')!;
  // MyTool: cache 40 + data 30 + app bundle 500; only the cache is clearable
  assert.equal(tool.totalBytes, 570);
  assert.equal(tool.bytesByCategory.app, 500);
  assert.equal(tool.safeToClearBytes, 40);
  assert.deepEqual(tool.safeToClearPaths, [j('Library', 'Caches', 'MyTool')]);
});

test('macOS: totals always reconcile with the scan root', () => {
  const root = macTree();
  const r = attributeTree(root, ctxFor('darwin', H));
  const attributed = r.apps.reduce((s, a) => s + a.totalBytes, 0);
  assert.equal(attributed + r.otherBytes, root.size);
  assert.equal(r.totalBytes, root.size);
  assert.equal(r.otherBytes, 700); // only Documents/report.pdf is unclaimed
  // A home scan misses the system-wide /Applications, so the UI should hint.
  assert.equal(r.appsFolderScanned, false);
});

test('macOS: a scan containing /Applications counts the apps folder as covered', () => {
  const root = dir('/', [
    dir('/Applications', [
      dir('/Applications/MyTool.app', [file('/Applications/MyTool.app/bin', 500)]),
    ]),
  ]);
  const r = attributeTree(root, ctxFor('darwin', H));
  assert.equal(r.appsFolderScanned, true);
  assert.equal(r.apps[0].name, 'MyTool');
  assert.equal(r.apps[0].bytesByCategory.app, 500);
});

test('macOS: unknown bundle id falls back to a prettified name', () => {
  const root = dir(H, [
    dir(j('Library'), [
      dir(j('Library', 'Caches'), [
        dir(j('Library', 'Caches', 'com.example.SuperEditor'), [
          file(j('Library', 'Caches', 'com.example.SuperEditor', 'x'), 5),
        ]),
      ]),
    ]),
  ]);
  const r = attributeTree(root, ctxFor('darwin', H));
  assert.equal(r.apps[0].name, 'SuperEditor');
  assert.equal(r.appsFolderScanned, false); // no Applications dir in this scan
});

/* ---------------- Windows ---------------- */

const WH = 'C:\\Users\\t';

test('windows: Program Files, vendor AppData nesting and cache subdir split', () => {
  const wj = (...parts: string[]) => path.join(WH, ...parts);
  const pf = 'C:\\Program Files';
  const root = dir('C:\\', [
    dir(pf, [
      dir(path.join(pf, 'Google'), [
        dir(path.join(pf, 'Google', 'Chrome'), [file(path.join(pf, 'Google', 'Chrome', 'chrome.exe'), 300)]),
      ]),
    ]),
    dir(wj(), [
      dir(wj('AppData'), [
        dir(wj('AppData', 'Local'), [
          dir(wj('AppData', 'Local', 'Google'), [
            dir(wj('AppData', 'Local', 'Google', 'Chrome'), [
              file(wj('AppData', 'Local', 'Google', 'Chrome', 'profile'), 80),
              dir(wj('AppData', 'Local', 'Google', 'Chrome', 'Cache'), [
                file(wj('AppData', 'Local', 'Google', 'Chrome', 'Cache', 'c'), 20),
              ]),
            ]),
          ]),
          dir(wj('AppData', 'Local', 'Temp'), [file(wj('AppData', 'Local', 'Temp', 't'), 999)]),
        ]),
      ]),
    ]),
  ]);
  const r = attributeTree(root, ctxFor('win32', WH));
  const chrome = r.apps.find((a) => a.name === 'Google Chrome');
  assert.ok(chrome, 'Chrome merged across Program Files + AppData');
  assert.equal(chrome.totalBytes, 400);
  assert.equal(chrome.bytesByCategory.app, 300);
  assert.equal(chrome.bytesByCategory.cache, 20);
  assert.equal(chrome.bytesByCategory.data, 80);
  assert.equal(chrome.safeToClearBytes, 20);
  // Temp is system-wide, not an app
  assert.ok(!r.apps.some((a) => a.name.toLowerCase() === 'temp'));
  const attributed = r.apps.reduce((s, a) => s + a.totalBytes, 0);
  assert.equal(attributed + r.otherBytes, root.size);
});

/* ---------------- Linux ---------------- */

const LH = '/home/t';

test('linux: dot-dirs merge by app name and reconcile', () => {
  const lj = (...parts: string[]) => path.join(LH, ...parts);
  const root = dir(LH, [
    dir(lj('.cache'), [
      dir(lj('.cache', 'google-chrome'), [file(lj('.cache', 'google-chrome', 'c'), 60)]),
    ]),
    dir(lj('.config'), [
      dir(lj('.config', 'google-chrome'), [file(lj('.config', 'google-chrome', 'prefs'), 25)]),
    ]),
    dir(lj('.local'), [
      dir(lj('.local', 'share'), [
        dir(lj('.local', 'share', 'myapp'), [file(lj('.local', 'share', 'myapp', 'd'), 15)]),
      ]),
    ]),
    file(lj('notes.txt'), 5),
  ]);
  const r = attributeTree(root, ctxFor('linux', LH));
  const chrome = r.apps.find((a) => a.name === 'Google Chrome');
  assert.ok(chrome, 'curated name maps google-chrome dirs to one app');
  assert.equal(chrome.totalBytes, 85);
  assert.equal(chrome.bytesByCategory.cache, 60);
  assert.equal(chrome.safeToClearBytes, 60);
  const attributed = r.apps.reduce((s, a) => s + a.totalBytes, 0);
  assert.equal(attributed + r.otherBytes, root.size);
  assert.equal(r.otherBytes, 5);
});
