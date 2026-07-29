import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanGameLibraries, parseKeyValues, shaderCachePaths } from '../src/services/gameLibraryScanner';

/**
 * §C7 — game-library awareness.
 *
 * These build REAL Steam/Epic/GOG/itch layouts on disk (the manifests are read
 * from disk, so a fake in-memory tree would not exercise the parsers) and scan
 * them through the ordinary walker.
 *
 * §C7's first acceptance criterion is "per-game totals match Steam's own
 * reporting within a small tolerance". Steam's own figure is `SizeOnDisk` in
 * the app manifest, so that comparison is made here against real bytes on
 * disk. **The second criterion — that a game still launches and rebuilds its
 * shaders — cannot be automated: it needs Steam and a real title. What IS
 * pinned is that the shader cache is the ONLY component ever offered for
 * clearing.**
 */

const roots: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-games-'));
  roots.push(dir);
  return dir;
}
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function bytes(file: string, n: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(n, 7));
}

/** Walk a real directory into the FileNode shape the scanner consumes. */
function treeOf(dir: string): import('../src/models/types').FileNode {
  const st = fs.statSync(dir);
  const children = fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const s = fs.statSync(full);
    if (s.isDirectory()) return treeOf(full);
    return {
      name, path: full, size: s.size, type: 'file' as const,
      modifiedAt: s.mtimeMs, isHidden: name.startsWith('.'),
      extension: (name.split('.').pop() || '').toLowerCase(),
    };
  });
  return {
    name: path.basename(dir), path: dir, type: 'dir', modifiedAt: st.mtimeMs, isHidden: false,
    size: children.reduce((s, c) => s + c.size, 0), children,
  };
}

process.on('exit', () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/* ─────────────────────── Valve KeyValues ─────────────────────── */

test('the KeyValues parser handles nesting, escapes and comments', () => {
  const kv = parseKeyValues(`
    // a comment
    "AppState"
    {
      "appid"    "440"
      "name"     "Team \\"Fortress\\" 2"
      "InstalledDepots"
      {
        "441" { "size" "12" }
      }
    }
  `);
  const state = kv.AppState as Record<string, unknown>;
  assert.equal(state.appid, '440');
  assert.equal(state.name, 'Team "Fortress" 2');
  assert.equal(((state.InstalledDepots as Record<string, unknown>)['441'] as Record<string, unknown>).size, '12');
});

test('a truncated manifest yields what parsed rather than throwing', () => {
  // One bad file must never hide a whole library.
  const kv = parseKeyValues('"AppState" { "appid" "570" "name" "Dota');
  const state = kv.AppState as Record<string, unknown>;
  assert.equal(state.appid, '570');
});

/* ─────────────────────── Steam ─────────────────────── */

function steamFixture(): { root: string; steamapps: string; baseBytes: number } {
  const root = tmp();
  const steamapps = path.join(root, 'Steam', 'steamapps');
  const baseBytes = 40_000;
  bytes(path.join(steamapps, 'common', 'Half-Life Alyx', 'game.pak'), baseBytes);
  bytes(path.join(steamapps, 'common', 'Half-Life Alyx', 'DLC', 'extra.pak'), 5_000);
  bytes(path.join(steamapps, 'shadercache', '546560', 'cache.bin'), 3_000);
  bytes(path.join(steamapps, 'workshop', 'content', '546560', 'mod1', 'mod.vpk'), 2_000);
  bytes(path.join(steamapps, 'compatdata', '546560', 'pfx', 'drive_c', 'x.dll'), 1_000);
  write(path.join(steamapps, 'appmanifest_546560.acf'), `"AppState"
{
	"appid"		"546560"
	"name"		"Half-Life: Alyx"
	"StateFlags"		"4"
	"installdir"		"Half-Life Alyx"
	"LastUpdated"		"1700000000"
	"SizeOnDisk"		"${baseBytes + 5_000}"
	"InstalledDepots"
	{
		"546561" { "manifest" "111" "size" "${baseBytes}" }
	}
}
`);
  write(path.join(steamapps, 'libraryfolders.vdf'), `"libraryfolders"
{
	"0"
	{
		"path"		"${path.join(root, 'Steam').replace(/\\/g, '\\\\')}"
		"apps" { "546560" "${baseBytes + 5_000}" }
	}
}
`);
  return { root, steamapps, baseBytes };
}

test('a Steam title is broken into base, shader cache, workshop, Proton prefix and DLC', () => {
  const { root, steamapps, baseBytes } = steamFixture();
  const report = scanGameLibraries(treeOf(root));

  assert.equal(report.libraries.length, 1);
  const lib = report.libraries[0];
  assert.equal(lib.launcher, 'steam');
  assert.equal(lib.path, steamapps);
  assert.equal(lib.titles.length, 1);

  const title = lib.titles[0];
  assert.equal(title.id, '546560');
  assert.equal(title.name, 'Half-Life: Alyx');
  const byKind = Object.fromEntries(title.components.map((c) => [c.kind, c.bytes]));
  assert.equal(byKind.base, baseBytes + 5_000, 'the base install includes everything under its folder');
  assert.equal(byKind.dlc, 5_000, 'a DLC folder inside the game is broken out');
  assert.equal(byKind.shaderCache, 3_000);
  assert.equal(byKind.workshop, 2_000);
  assert.equal(byKind.compatPrefix, 1_000);
  assert.equal(title.updatedAt, 1_700_000_000_000, 'Steam records seconds; we report milliseconds');
  assert.equal(report.titleCount, 1);
  assert.equal(report.shaderCacheBytes, 3_000);
});

test("a title's measured size matches Steam's own SizeOnDisk", () => {
  // §C7 acceptance: "per-game totals match Steam's own reporting within a small
  // tolerance". Steam's own number is SizeOnDisk, compared against the base
  // install (SizeOnDisk excludes shader cache, workshop and the compat prefix).
  const { root } = steamFixture();
  const title = scanGameLibraries(treeOf(root)).libraries[0].titles[0];
  assert.ok(title.reportedBytes, 'SizeOnDisk is read from the manifest');
  assert.ok(title.reportedDelta !== undefined);
  assert.ok(title.reportedDelta < 0.02, `within 2%, got ${(title.reportedDelta * 100).toFixed(2)}%`);
});

test('a disagreement with Steam is reported, not hidden', () => {
  const { root, steamapps } = steamFixture();
  const manifest = path.join(steamapps, 'appmanifest_546560.acf');
  write(manifest, fs.readFileSync(manifest, 'utf8').replace(/"SizeOnDisk"\s+"\d+"/, '"SizeOnDisk"		"90000"'));
  const title = scanGameLibraries(treeOf(root)).libraries[0].titles[0];
  assert.equal(title.reportedBytes, 90_000);
  assert.ok(title.reportedDelta > 0.4, 'the gap is surfaced so a stale manifest is visible');
});

test('a game with no separate DLC folder says so instead of inventing a split', () => {
  const root = tmp();
  const steamapps = path.join(root, 'steamapps');
  bytes(path.join(steamapps, 'common', 'Portal 2', 'game.pak'), 9_000);
  write(path.join(steamapps, 'appmanifest_620.acf'),
    '"AppState" { "appid" "620" "name" "Portal 2" "installdir" "Portal 2" "SizeOnDisk" "9000" }');
  const title = scanGameLibraries(treeOf(root)).libraries[0].titles[0];
  assert.equal(title.dlcInsideBase, true);
  assert.equal(title.components.find((c) => c.kind === 'dlc'), undefined, 'no invented DLC component');
});

test('a manifest with no installdir is skipped rather than half-reported', () => {
  const root = tmp();
  const steamapps = path.join(root, 'steamapps');
  bytes(path.join(steamapps, 'common', 'Something', 'x.bin'), 100);
  write(path.join(steamapps, 'appmanifest_1.acf'), '"AppState" { "appid" "1" "name" "Broken" }');
  assert.deepEqual(scanGameLibraries(treeOf(root)).libraries, []);
});

/* ─────────────────────── Epic, GOG, itch.io ─────────────────────── */

test('an Epic manifest is matched on its contents, not on where the launcher lives', () => {
  const root = tmp();
  const install = path.join(root, 'Epic Games', 'Rocket League');
  bytes(path.join(install, 'game.pak'), 25_000);
  write(path.join(root, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests', 'ab12.item'), JSON.stringify({
    FormatVersion: 0, AppName: 'Sugar', DisplayName: 'Rocket League',
    InstallLocation: install, InstallSize: 25_000,
  }));
  const report = scanGameLibraries(treeOf(root));
  const epic = report.libraries.find((l) => l.launcher === 'epic');
  assert.ok(epic, 'the Manifests folder full of .item files is Epic');
  assert.equal(epic.titles[0].name, 'Rocket League');
  assert.equal(epic.titles[0].totalBytes, 25_000, 'sized from the tree, not from the manifest');
  assert.equal(epic.titles[0].reportedDelta, 0);
});

test('an Epic install outside the scan claims no bytes it did not measure', () => {
  const root = tmp();
  write(path.join(root, 'Manifests', 'x.item'), JSON.stringify({
    AppName: 'Elsewhere', DisplayName: 'Elsewhere', InstallLocation: path.join(os.tmpdir(), 'not-scanned-' + process.pid), InstallSize: 999_999,
  }));
  const epic = scanGameLibraries(treeOf(root)).libraries.find((l) => l.launcher === 'epic');
  assert.ok(epic);
  assert.equal(epic.titles[0].totalBytes, 0);
  assert.deepEqual(epic.titles[0].components, [], 'no component is claimed for bytes nobody measured');
});

test('a GOG install is found by its goggame info file', () => {
  const root = tmp();
  const game = path.join(root, 'GOG Games', 'The Witcher');
  bytes(path.join(game, 'data.bin'), 18_000);
  write(path.join(game, 'goggame-1207658924.info'), JSON.stringify({ gameId: '1207658924', name: 'The Witcher' }));
  const gog = scanGameLibraries(treeOf(root)).libraries.find((l) => l.launcher === 'gog');
  assert.ok(gog);
  assert.equal(gog.titles[0].name, 'The Witcher');
  assert.equal(gog.titles[0].id, '1207658924');
  assert.ok(gog.titles[0].totalBytes >= 18_000);
});

test('two GOG games under one folder become one library', () => {
  const root = tmp();
  for (const [dir, id, name] of [['Witcher', '1', 'The Witcher'], ['Stardew', '2', 'Stardew Valley']]) {
    const game = path.join(root, 'GOG Games', dir);
    bytes(path.join(game, 'data.bin'), 5_000);
    write(path.join(game, `goggame-${id}.info`), JSON.stringify({ gameId: id, name }));
  }
  const libs = scanGameLibraries(treeOf(root)).libraries.filter((l) => l.launcher === 'gog');
  assert.equal(libs.length, 1);
  assert.equal(libs[0].titles.length, 2);
});

test('itch.io games are found under its apps directory', () => {
  const root = tmp();
  bytes(path.join(root, 'itch', 'apps', 'celeste', 'game.exe'), 12_000);
  const itch = scanGameLibraries(treeOf(root)).libraries.find((l) => l.launcher === 'itch');
  assert.ok(itch);
  assert.equal(itch.titles[0].name, 'celeste');
  assert.equal(itch.titles[0].totalBytes, 12_000);
});

/* ─────────────────────── Safety ─────────────────────── */

test('the shader cache is the ONLY thing ever offered for clearing', () => {
  const { root } = steamFixture();
  const report = scanGameLibraries(treeOf(root));
  const paths = shaderCachePaths(report);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /shadercache[\\/]546560$/);

  // Nothing that would cost a redownload, break a mod subscription or destroy a
  // Proton prefix may appear in that list.
  const everythingElse = report.libraries
    .flatMap((l) => l.titles)
    .flatMap((t) => t.components)
    .filter((c) => c.kind !== 'shaderCache')
    .map((c) => c.path);
  for (const p of everythingElse) {
    assert.ok(!paths.includes(p), `${p} must never be offered for clearing`);
  }
});

test('a folder with no game libraries reports nothing', () => {
  const root = tmp();
  bytes(path.join(root, 'documents', 'notes.txt'), 100);
  const report = scanGameLibraries(treeOf(root));
  assert.deepEqual(report.libraries, []);
  assert.equal(report.titleCount, 0);
  assert.equal(report.totalBytes, 0);
});
