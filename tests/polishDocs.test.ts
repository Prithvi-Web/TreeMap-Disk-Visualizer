import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The front door — README, SECURITY.md, the Code of Conduct, the issue
 * templates, views.svg and package.json's metadata — is documentation, and
 * documentation drifts silently because nothing runs it. Each test here takes
 * the fact from whatever OWNS it (the sidebar markup, the rate limiter's
 * constants, the release matrix, the updater in electron/main.js, the
 * on-disk store constants) and holds the document to that fact, so a change
 * on either side fails loudly instead of leaving a reader with a claim the
 * app no longer keeps.
 *
 * Nothing here anchors to a line of prose. The documents may be rewritten
 * freely as long as they stay true.
 */

const root = path.join(__dirname, '..');
// CRLF-normalised: a Windows checkout with autocrlf on must not turn every
// newline anchor below into a miss.
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const README = read('README.md');
const SECURITY = read('SECURITY.md');
const COC = read('CODE_OF_CONDUCT.md');
const PKG = JSON.parse(read('package.json')) as {
  version: string;
  description: string;
  author: string | { name: string; url?: string };
  homepage?: string;
  repository?: { type: string; url: string };
  bugs?: { url: string };
  keywords?: string[];
  build: { publish: { provider: string; owner: string; repo: string } };
};
const RELEASE_YML = read('.github', 'workflows', 'release.yml');
const INSTALL_NOTE = read('.github', 'INSTALL-NOTE.md');
const MAIN_JS = read('electron', 'main.js');

const REPO_SLUG = 'Prithvi-Web/TreeMap-Disk-Visualizer';
const ALL_PLATFORMS = ['macOS', 'Windows', 'Linux'] as const;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** The text between two markers, hard-failing when either is missing. */
function section(doc: string, start: string, end: string): string {
  const a = doc.indexOf(start);
  assert.notEqual(a, -1, `"${start}" exists`);
  const b = doc.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `"${end}" follows "${start}"`);
  return doc.slice(a, b);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/* ───────────────────────── The views ───────────────────────── */

/** What the app actually registers: every role="tab" in the sidebar, plus
    the two surfaces the README counts as views that live outside the tab
    list — Clean Up (the sidebar foot) and Scheduled + Ignore (Settings). */
function registeredViews(): string[] {
  const html = read('src', 'ui', 'markup', '000-sidebar.html');
  const tabs = [...html.matchAll(/<button role="tab"[^>]*\btitle="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 10, 'the sidebar registers its views as role="tab" buttons');
  const cleanUp = html.match(/id="cleanupBtn"[^>]*>[\s\S]*?<span class="side-label">([^<]+)<\/span>/);
  assert.ok(cleanUp, 'the Clean Up button lives in the sidebar foot');
  const settings = html.match(/id="settingsBtn"[^>]*\btitle="([^"]+)"/);
  assert.ok(settings && /schedules? & ignore/i.test(settings[1]), 'Settings owns schedules and the ignore list');
  return [...tabs, cleanUp![1].trim(), 'Scheduled + Ignore'];
}

/** The chip labels drawn in views.svg, emoji and entities stripped. */
function svgChips(): string[] {
  const svg = read('views.svg');
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) =>
    m[1].replace(/&#160;|&nbsp;/g, ' ').replace(/[^\p{L}\p{N}+ ]/gu, '').replace(/\s+/g, ' ').trim(),
  );
}

test('views.svg draws exactly the views the sidebar registers, one chip each', () => {
  const expected = registeredViews();
  const drawn = svgChips();
  assert.deepEqual([...drawn].sort(), [...expected].sort(),
    'views.svg and src/ui/markup/000-sidebar.html disagree about which views exist');
  assert.equal(new Set(drawn).size, drawn.length, 'no view is drawn twice');
});

test('the README headline counts the same views the sidebar registers, and its alt text names them', () => {
  const count = registeredViews().length;
  const heading = README.match(/## \S* ?The (\w+) views/);
  assert.ok(heading, 'the README has a "The N views" heading');
  assert.equal(heading![1].toLowerCase(), NUMBER_WORDS[count], `the heading says ${NUMBER_WORDS[count]}`);
  const alt = README.match(/<img src="views\.svg"[^>]*\balt="The views: ([^"]+)"/);
  assert.ok(alt, 'views.svg is embedded with an alt text that lists the views');
  assert.deepEqual(alt![1].split(', ').sort(), [...registeredViews()].sort(),
    'the alt text lists exactly the registered views');
});

test('views.svg chips sit inside the canvas and never overlap within a row', () => {
  const svg = read('views.svg');
  const width = Number(svg.match(/<svg[^>]*\bwidth="(\d+)"/)![1]);
  const chips = [...svg.matchAll(/<g transform="translate\((\d+),(\d+)\)">\s*<rect width="(\d+)"/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }));
  assert.equal(chips.length, svgChips().length, 'every chip is a translated group with a rect');
  const rows = new Map<number, typeof chips>();
  for (const c of chips) {
    assert.ok(c.x >= 20 && c.x + c.w <= width - 20, `chip at x=${c.x} w=${c.w} stays inside the ${width}px canvas`);
    rows.set(c.y, [...(rows.get(c.y) ?? []), c]);
  }
  for (const [y, row] of rows) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      assert.ok(row[i - 1].x + row[i - 1].w < row[i].x, `chips in the row at y=${y} do not overlap`);
    }
  }
});

/* ───────────────────────── Which platforms ship ───────────────────────── */

/** The platforms release.yml actually builds — the one fact every other
    platform claim must agree with. */
function releasedPlatforms(): string[] {
  const matrix = section(RELEASE_YML, 'matrix:', 'runs-on:');
  const byRunner: Record<string, string> = { 'macos-latest': 'macOS', 'windows-latest': 'Windows', 'ubuntu-latest': 'Linux' };
  const out = [...matrix.matchAll(/- os: (\S+)/g)].map((m) => {
    assert.ok(byRunner[m[1]], `known runner ${m[1]}`);
    return byRunner[m[1]];
  });
  assert.ok(out.length > 0, 'the release matrix builds something');
  return out;
}

function humanList(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

test('README, INSTALL-NOTE, release.yml and package.json agree about which platforms are released', () => {
  const released = releasedPlatforms();
  const download = section(README, '## ⬇️ Download the app', '\n## ');
  const table = section(download, '<table>', '</table>');
  const yamlHeader = RELEASE_YML.slice(0, RELEASE_YML.indexOf('\non:'));

  for (const p of ALL_PLATFORMS) {
    if (released.includes(p)) {
      const row = table.match(new RegExp(`<tr>\\s*<td>[^<]*<b>${p}</b>[\\s\\S]*?</tr>`));
      assert.ok(row, `the download table has a ${p} row`);
      assert.match(row![0], /<code>TreeMap-[^<]*x\.y\.z[^<]*<\/code>/, `the ${p} row names its file with an x.y.z placeholder`);
      assert.match(INSTALL_NOTE, new RegExp(`\\*\\*${p}\\*\\*`), `INSTALL-NOTE.md has a ${p} entry`);
      assert.match(yamlHeader, new RegExp(`\\b${p}\\b`), `release.yml's header names ${p}`);
      assert.match(PKG.description, new RegExp(`\\b${p}\\b`), `package.json's description names ${p}`);
    } else {
      assert.doesNotMatch(table, new RegExp(`<b>${p}</b>`), `no download row for ${p}, which is not released`);
      assert.match(download, new RegExp(`\\*\\*${p}\\*\\*[^\\n]*no desktop download`), `the README says ${p} has no desktop download`);
      assert.match(INSTALL_NOTE, new RegExp(`${p}[^\\n]*no desktop build`), `INSTALL-NOTE.md says ${p} has no desktop build`);
      assert.match(README, new RegExp(`badge/${p}-web_mode`), `the ${p} badge says web mode, not a download`);
      assert.doesNotMatch(yamlHeader, new RegExp(`\\b${p}\\b(?![^\\n]*not)`), `release.yml's header does not claim ${p}`);
      const mention = PKG.description.match(new RegExp(`[^,.;]*\\b${p}\\b[^,.;]*`));
      if (mention) assert.match(mention[0], /web mode/, `package.json only names ${p} as web mode`);
    }
  }
  assert.match(README, new RegExp(`desktop app\\*\\* for ${humanList(released)}`),
    'the "How it\'s built" line lists the released platforms');
});

/* ───────────────────────── SECURITY.md ───────────────────────── */

test('SECURITY.md supports the current major and carries the private contact', () => {
  const major = PKG.version.split('.')[0];
  assert.match(SECURITY, new RegExp(`latest ${major}\\.x release`), `supported versions = the latest ${major}.x`);
  assert.doesNotMatch(SECURITY, /v1\.\d+\.\d+\s*\|\s*✅/, 'no 1.x release is listed as current');
  assert.match(SECURITY, /vinay\.gopinath@gmail\.com/, 'the private report address is published');
});

test('SECURITY.md describes the network model the code has', () => {
  const host = read('src', 'index.ts').match(/process\.env\.HOST \|\| '([^']+)'/);
  assert.ok(host, 'src/index.ts has a default bind host');
  assert.ok(SECURITY.includes(host![1]), `SECURITY.md names the default bind address ${host![1]}`);

  assert.doesNotMatch(SECURITY, /makes no outbound requests|no network access/i,
    'the app does make outbound requests (update check, cloud, fleet), so the old claim is gone');
  const every = MAIN_JS.match(/setInterval\(check, (\d+) \* 3600_000\)/);
  assert.ok(every, 'electron/main.js re-checks for updates on an hourly multiple');
  assert.match(SECURITY, new RegExp(`every ${every![1]} hours`), 'the update-check cadence is stated');
  assert.equal(PKG.build.publish.provider, 'github');
  assert.match(SECURITY, /GitHub/, 'the update check is attributed to GitHub');

  assert.match(read('src', 'services', 'fleet', 'fleetSync.ts'), /enabled: false/, 'Fleet is off by default in code');
  assert.match(SECURITY, /Fleet[^\n]*off by default/i, 'SECURITY.md says Fleet is off by default');
});

test('SECURITY.md quotes the rate limiter the code enforces, lane by lane', () => {
  const src = read('src', 'middleware', 'rateLimiter.ts');
  const lanes = [...src.matchAll(/const \w+Lane: Lane = \{ name: '(\w+)', capacity: (\d+), refillPerSec: (\d+)/g)];
  assert.ok(lanes.length >= 2, 'the limiter has named lanes');
  for (const [, name, capacity, refill] of lanes) {
    const line = SECURITY.split('\n').find((l) => l.includes(`\`${name}\``));
    assert.ok(line, `SECURITY.md has a line for the \`${name}\` lane`);
    assert.match(line!, new RegExp(`\\b${refill}\\b`), `the \`${name}\` lane's sustained rate (${refill}/s) is stated`);
    assert.match(line!, new RegExp(`\\b${capacity}\\b`), `the \`${name}\` lane's burst (${capacity}) is stated`);
  }
  // The README's safety list quotes the api lane too.
  const api = lanes.find((l) => l[1] === 'api')!;
  const readmeLine = README.split('\n').find((l) => /rate limit/i.test(l));
  assert.ok(readmeLine, 'the README mentions rate limiting');
  assert.match(readmeLine!, new RegExp(`\\b${api[3]}\\b`), 'README states the api lane rate');
  assert.match(readmeLine!, new RegExp(`\\b${api[2]}\\b`), 'README states the api lane burst');
});

test('SECURITY.md lists every file the app keeps on disk, and how long scans live in memory', () => {
  const stores = new Set<string>();
  for (const file of walk(path.join(root, 'src', 'services'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^(?:export )?const [A-Z_]+_(?:FILE|DIR) = '([^'/][^']*)'/gm)) stores.add(m[1]);
  }
  assert.ok(stores.size >= 10, `found the on-disk store constants (${stores.size})`);
  for (const name of stores) {
    assert.ok(SECURITY.includes(`\`${name}\``), `SECURITY.md documents \`${name}\``);
  }
  const ttl = read('src', 'services', 'diskScanner.ts').match(/SCAN_TTL_MS = (\d+) \* 60 \* 1000/);
  assert.ok(ttl, 'the scan TTL is a minute multiple');
  assert.match(SECURITY, new RegExp(`${ttl![1]} minutes`), 'the scan retention window is stated');
});

test('SECURITY.md names every blocked system folder the sanitizer refuses', () => {
  const list = read('src', 'utils', 'pathSanitizer.ts').match(/UNIX_BLOCKLIST = \[([^\]]+)\]/);
  assert.ok(list, 'the sanitizer has a Unix blocklist');
  const entries = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.length >= 3);
  for (const e of entries) assert.ok(SECURITY.includes(`\`${e}\``), `SECURITY.md names \`${e}\``);
});

/* ───────────────────────── Code of Conduct ───────────────────────── */

test('the Code of Conduct says where to report', () => {
  const enforcement = section(COC, '## Enforcement\n', '## Enforcement Guidelines');
  assert.match(enforcement, /vinay\.gopinath@gmail\.com/, 'a contact address is given');
  assert.doesNotMatch(enforcement, /\bat\s*\n\s*\.\s*\n/, 'the sentence no longer ends in "at ."');
});

/* ───────────────────────── Issue templates ───────────────────────── */

test('the issue templates ask what a TreeMap bug report needs, and route security reports privately', () => {
  const dir = path.join(root, '.github', 'ISSUE_TEMPLATE');
  assert.ok(!existsSync(path.join(dir, 'custom.md')), "GitHub's empty custom template stub is gone");
  const config = readFileSync(path.join(dir, 'config.yml'), 'utf8');
  assert.match(config, /blank_issues_enabled:\s*false/);
  assert.match(config, /url:[^\n]*SECURITY\.md/, 'a contact link points at SECURITY.md');

  const bug = readFileSync(path.join(dir, 'bug_report.md'), 'utf8');
  assert.doesNotMatch(bug, /smartphone|iphone|stock browser/i, 'no phone questions in a desktop app');
  for (const needle of ['TreeMap version', '/api/capabilities', 'How you run it', '.dmg', 'Setup', 'portable',
    'web mode', 'VS Code', 'Docker', 'Which view', 'OS and version']) {
    assert.ok(bug.includes(needle), `bug_report.md asks about: ${needle}`);
  }
  // The template must not send a reporter somewhere a RELEASED build does not
  // go: Developer Tools and Reload are development-only (desktop-polish-4), so
  // asking a user with a .dmg for a console they have no menu item for is a
  // dead end. The menu module is where that decision lives.
  const menu = readFileSync(path.join(__dirname, '..', 'electron', 'lib', 'menu.js'), 'utf8');
  assert.match(menu, /isPackaged \? \[\] : \[[^\]]*toggleDevTools/, 'Developer Tools is development-only');
  assert.doesNotMatch(bug, /Toggle Developer Tools/, 'so the template does not send a released user there');
  assert.match(bug, /- \[ \]/, 'the install types are checkboxes');
});

/* ───────────────────────── package.json metadata ───────────────────────── */

test('package.json metadata points at the real repository and the real author', () => {
  assert.equal(PKG.repository?.url, `https://github.com/${REPO_SLUG}.git`);
  assert.equal(`${PKG.build.publish.owner}/${PKG.build.publish.repo}`, REPO_SLUG, 'the updater feed is the same repo');
  assert.ok(PKG.homepage?.startsWith(`https://github.com/${REPO_SLUG}`), 'homepage is the repo');
  assert.equal(PKG.bugs?.url, `https://github.com/${REPO_SLUG}/issues`);
  assert.ok((PKG.keywords?.length ?? 0) >= 5, 'keywords are set');
  for (const k of ['disk-space', 'treemap', 'mcp']) assert.ok(PKG.keywords!.includes(k), `keyword ${k}`);

  const holder = read('LICENSE').match(/Copyright \(c\) \d{4} (.+)/);
  assert.ok(holder, 'LICENSE names a copyright holder');
  const authorName = typeof PKG.author === 'string' ? PKG.author.replace(/\s*[<(].*$/, '') : PKG.author.name;
  assert.equal(authorName, holder![1].trim(), 'the author (which electron-builder prints as the copyright line) is the LICENSE holder');
});

/* ───────────────────────── README facts ───────────────────────── */

test('README download links go to the latest release and never to a stale tag or the old repo slug', () => {
  for (const [name, doc] of [['README.md', README], ['SECURITY.md', SECURITY], ['CODE_OF_CONDUCT.md', COC], ['INSTALL-NOTE.md', INSTALL_NOTE]] as const) {
    assert.doesNotMatch(doc, /Prithvi-Web\/Treemap(?![-\w])/, `${name} does not use the old repository slug`);
  }
  assert.match(README, new RegExp(`img\\.shields\\.io/github/package-json/v/${REPO_SLUG.replace('/', '\\/')}`),
    'the version badge reads package.json, so a bump is one place');
  assert.doesNotMatch(README, /releases\/tag\/v\d/, 'no download link is pinned to a specific tag');
  assert.ok(README.includes(`https://github.com/${REPO_SLUG}/releases`), 'downloads go to the Releases page');
  const version = section(README, 'Which version', '\n\n');
  assert.match(version, /\/api\/capabilities/, 'the README says how to read the running version');
});

test('README describes the macOS updater the app actually has', () => {
  // The dialog's words live in the pure copy helper, which is where the
  // unsigned-build story is told; main.js only shows what it returns.
  const desk = readFileSync(path.join(__dirname, '..', 'electron', 'lib', 'desktop.js'), 'utf8');
  const button = /buttons: \['([^']+)'/.exec(desk.slice(desk.indexOf('function updateDialogCopy(')));
  assert.ok(button, 'the macOS update dialog has a primary button');
  const bullet = README.split('\n').find((l) => /Auto-updates?\*\*/.test(l));
  assert.ok(bullet, 'the README has an Auto-updates bullet');
  assert.ok(bullet!.includes(button![1]), `the bullet names the "${button![1]}" dialog`);
  // Not a bare /skip/: the dialog now HAS a "Skip This Version" button, and
  // naming it is accurate. What the bullet must never say is that macOS skips
  // the check itself — it checks, and offers the download.
  assert.doesNotMatch(bullet!, /skips? (the )?(update )?check/i, 'macOS checks; it is the install it cannot do');
});

test('README first-launch guidance never offers right-click → Open as a working route on current macOS', () => {
  const mac = section(README, '### 🍎 First launch on macOS', '### 🪟 First launch on Windows');
  assert.match(mac, /Open Anyway/, 'the Privacy & Security route is documented');
  const paragraphs = mac.split(/\n\s*\n/);
  for (const para of paragraphs) {
    if (!/right-click/i.test(para)) continue;
    assert.match(para, /no longer works|Apple removed|Sonoma \(14\) or older/,
      `a right-click mention is only ever a warning or a Sonoma-and-older note:\n${para}`);
  }
  assert.match(INSTALL_NOTE, /Open Anyway/);
  assert.match(INSTALL_NOTE, /right-click[^\n]*no longer works/i);
});

test('the generated page is the only index.html, and the README steers contributors at src/ui', () => {
  assert.ok(!existsSync(path.join(root, 'index.html')), 'no stale index.html at the repo root');
  const layout = section(README, '## 🗂️ Project layout', '\n## ');
  assert.match(layout, /src\/ui\//, 'the layout block lists src/ui/');
  assert.match(layout, /scripts\/build-ui\.js/, 'and the build that stitches it');
  assert.match(layout, /public\/[\s\S]*?index\.html[^\n]*(generated|never edit)/i, 'public/index.html is marked generated');
  assert.match(README, /generated from `src\/ui\/`/, 'the "How it\'s built" line says the page is generated');
});

test('every image the README embeds exists, and every screenshot in demo/ is used', () => {
  const refs = [...README.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  assert.ok(refs.length > 0);
  for (const r of refs) assert.ok(existsSync(path.join(root, r)), `README embeds ${r}, which exists`);
  const demo = readdirSync(path.join(root, 'demo')).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
  assert.ok(demo.length > 0, 'demo/ holds screenshots');
  for (const f of demo) assert.ok(refs.includes(`demo/${f}`), `demo/${f} is shown somewhere in the README`);
});
