import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-trashInstalledProgram-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * Fifth browser pass F01 (MEDIUM, safety). Scan /Applications; Largest Files'
 * first six rows are app internals — Chrome's framework, WhatsApp's own
 * executable, an app.asar. The trash icon on "Google Chrome Framework" opened
 * "Move Google Chrome Framework (519.5 MB) to the Trash? You can put it back
 * from the Trash until the Trash is emptied." — two clicks from breaking
 * Chrome, and not a word of it.
 *
 * Every Trash sheet now says it before anyone confirms: the shared sheet
 * (confirmTrash: Largest Files, right-click, Grid and ⌘⌫, Treemap, Duplicates,
 * Similar images, Clean Up) asks the server's one detector, and the cart's
 * sheet reads the same fact from its own dry-run manifest. The page's own code
 * runs here over stubs.
 */

function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}

/** A function declaration of the built page, by name. */
function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  return INDEX.slice(m!.index, matchingBrace(INDEX.indexOf('{', INDEX.indexOf(')', m!.index))) + 1);
}

/** The page's whole "Trash (confirm + execute)" section, where confirmTrash and its helpers live. */
function trashSection(): string {
  const from = INDEX.indexOf('/* ───────────────────────────── Trash (confirm + execute) ');
  const to = INDEX.indexOf('/* ───────────────────────────── Open-file guard (B2)');
  assert.ok(from > 0 && to > from, 'the Trash section is in the built page');
  return INDEX.slice(from, to);
}

const CHROME = { kind: 'app', name: 'Google Chrome', root: '/Applications/Google Chrome.app' };
const WHATSAPP = { kind: 'app', name: 'WhatsApp', root: '/Applications/WhatsApp.app' };
const FRAMEWORK = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/A/Google Chrome Framework';
const HELPER = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper';
const WHATSAPP_EXE = '/Applications/WhatsApp.app/Contents/MacOS/WhatsApp';
const MOVIE = '/Users/me/Movies/holiday-4k.mov';

type Answer = (paths: string[]) => Promise<{ parts: unknown[] }>;

/**
 * The page's confirmTrash over stubs. `answer` is the server's
 * /api/files/installed-programs; `at open` is what the sheet said at the
 * moment it opened — what a person reads before they can press anything.
 */
function sheet(answer: Answer) {
  const asked: string[][] = [];
  let atOpen: string | null = null;
  const els: Record<string, { innerHTML: string; classList: { add: (c: string) => void } }> = {};
  const $ = (id: string) => (els[id] ||= {
    innerHTML: '',
    classList: { add: (c: string) => { if (id === 'confirmModal' && c === 'open') atOpen = els.confirmText?.innerHTML ?? ''; } },
  });
  const deps: Record<string, unknown> = {
    $, ensureNodes: async () => {}, nodeFor: (p: string) => ({ name: p.split('/').pop(), size: 100 }),
    resetOpenHandleWarning: () => {}, checkOpenHandlesFor: async () => {}, cloudTrashPaths: () => {},
    cloudProviderOfScan: () => ({ name: 'Google Drive', trashLabel: 'Google Drive trash' }),
    icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, formatCount: String,
    api: async (url: string, opts: { body: string }) => {
      assert.equal(url, '/api/files/installed-programs', 'the sheet asks the server\'s one detector');
      const paths = JSON.parse(opts.body).paths as string[];
      asked.push(paths);
      return answer(paths);
    },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const confirmTrash = new Function(...keys, `'use strict'; ${declOf('tmParentPath')}\n${trashSection()}\nreturn confirmTrash;`)(
    ...keys.map((k) => deps[k])) as (paths: string[]) => Promise<void>;
  return {
    asked,
    /** Opens the sheet for `paths`; answers its words at the moment it opened, tags dropped. */
    open: async (paths: string[]) => {
      atOpen = null;
      await confirmTrash(paths);
      assert.notEqual(atOpen, null, 'control: the sheet opened');
      return { html: atOpen as unknown as string, text: (atOpen as unknown as string).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ') };
    },
  };
}

const partsOf = (map: Record<string, unknown>): Answer => async (paths) => ({
  parts: paths.filter((p) => p in map).map((p) => ({ path: p, installedProgram: map[p] })),
});

test('Move to Trash on a file inside an app says, before anyone confirms, that it is part of that app, which will stop working — and how to remove the app whole (F01)', async () => {
  const s = sheet(partsOf({ [FRAMEWORK]: CHROME }));
  const { text } = await s.open([FRAMEWORK]);
  assert.match(text, /^Move Google Chrome Framework \(100 B\) to the Trash\?/, 'control: the sheet still names what it moves');
  assert.match(text, /It is part of the app Google Chrome\./, `it names the app: ${text}`);
  assert.match(text, /Moving it to the Trash will stop Google Chrome from working\./, 'it says the app will stop working');
  assert.match(text, /To remove Google Chrome, move the whole app to the Trash instead\./, 'and points to removing the app whole');
  assert.deepEqual(s.asked, [[FRAMEWORK]], 'the server was asked about exactly what the sheet moves');
});

test('a selection with parts of several apps names each app, and how many of the items are parts (F01)', async () => {
  const s = sheet(partsOf({ [FRAMEWORK]: CHROME, [HELPER]: CHROME, [WHATSAPP_EXE]: WHATSAPP }));
  const { text } = await s.open([FRAMEWORK, MOVIE, HELPER, WHATSAPP_EXE]);
  assert.match(text, /^Move 4 items \(400 B total\) to the Trash\?/, 'control');
  assert.match(text, /3 of these are parts of 2 installed programs — the app Google Chrome, the app WhatsApp\./, text);
  assert.match(text, /Moving them to the Trash can stop those programs from working\./);
  assert.match(text, /To remove an app, move the whole app to the Trash instead\./);
  const one = await sheet(partsOf({ [WHATSAPP_EXE]: WHATSAPP })).open([MOVIE, WHATSAPP_EXE]);
  assert.match(one.text, /1 of these is part of the app WhatsApp\. Moving it to the Trash will stop WhatsApp from working\./, one.text);
});

test('a selection with no part of any installed program reads exactly as it did — no warning (F01 control)', async () => {
  const { html, text } = await sheet(partsOf({})).open([MOVIE]);
  assert.doesNotMatch(html, /app-part-warn/, 'nothing is added');
  assert.equal(text, 'Move holiday-4k.mov (100 B) to the Trash?You can put it back from the Trash until the Trash is emptied.');
});

test('when the server cannot be asked, the sheet says it could not check — never silence, which reads as "not part of any app" (F01)', async () => {
  const { text } = await sheet(async () => { throw new Error('offline'); }).open([FRAMEWORK]);
  assert.match(text, /TreeMap couldn’t check whether this is part of an installed app\./, text);
  const many = await sheet(async () => { throw new Error('offline'); }).open([FRAMEWORK, MOVIE]);
  assert.match(many.text, /couldn’t check whether any of these is part of an installed app\./, many.text);
});

test('a cloud account\'s files are not asked about: they are on no computer\'s disk (F01)', async () => {
  const s = sheet(partsOf({}));
  await s.open(['cloud://drive/a.bin']);
  assert.deepEqual(s.asked, [], 'nothing was asked');
});

test('a big selection is asked about in the route\'s own chunks of 2,000, and every part found is counted (F01)', async () => {
  const paths = Array.from({ length: 4500 }, (_, i) => `/Applications/Big.app/Contents/Resources/f${i}`);
  const s = sheet(partsOf(Object.fromEntries(paths.map((p) => [p, { kind: 'app', name: 'Big', root: '/Applications/Big.app' }]))));
  const { text } = await s.open(paths);
  assert.deepEqual(s.asked.map((chunk) => chunk.length), [2000, 2000, 500], 'three questions, none past the route\'s limit');
  assert.match(text, /4500 of these are parts of the app Big\./, text);
});

test('a Windows program and Linux\'s packages are named and advised for in their own words (F01)', async () => {
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const win = await sheet(partsOf({ [exe]: { kind: 'program', name: 'Google', root: 'C:\\Program Files\\Google' } })).open([exe]);
  assert.match(win.text, /It is part of the program Google in Program Files\. Moving it to the Trash will stop Google from working\. To remove Google, uninstall it in Windows Settings › Apps instead\./, win.text);
  const lib = '/usr/lib/x86_64-linux-gnu/libLLVM-17.so.1';
  const linux = await sheet(partsOf({ [lib]: { kind: 'package', name: null, root: '/usr' } })).open([lib]);
  assert.match(linux.text, /It is part of the software your package manager installed in \/usr\. Moving it to the Trash can stop programs that use it from working\. To remove software your package manager installed, uninstall its package with the package manager instead\./, linux.text);
});

/** The page's cartManifestHtml over stubs, for a dry-run plan. */
function cartSheet(plan: Record<string, unknown>): string {
  const deps: Record<string, unknown> = {
    icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, formatCount: String,
    baseName: (p: string) => p.split('/').pop(), state: { capsuleOff: false },
  };
  const keys = Object.keys(deps);
  const names = ['cartManifestHtml', 'cartSpaceSaid', 'installedProgramWarningHtml', 'installedProgramWords', 'installedProgramRemoval'];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const html = new Function(...keys, `'use strict'; ${names.map(declOf).join('\n')}\nreturn cartManifestHtml;`)(
    ...keys.map((k) => deps[k])) as (plan: unknown, missing: number) => string;
  return html(plan, 0).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

test('the cart\'s sheet says it too, from the dry-run manifest the server made — only for what it will move (F01)', () => {
  const base = { bytesWouldFree: 300, bytesSkipped: 0, evicts: [], capsule: { available: true }, openHandles: null, batches: 1 };
  const said = cartSheet({ ...base, items: [
    { path: FRAMEWORK, bytes: 100, willDelete: true, installedProgram: CHROME },
    { path: MOVIE, bytes: 100, willDelete: true },
    { path: WHATSAPP_EXE, bytes: 100, willDelete: false, reason: 'Could not be protected.', installedProgram: WHATSAPP },
  ] });
  assert.match(said, /1 of these is part of the app Google Chrome\. Moving it to the Trash will stop Google Chrome from working\./, said);
  assert.doesNotMatch(said, /app WhatsApp/, 'an item the cart leaves in place is not said to be moved');
  const plain = cartSheet({ ...base, items: [{ path: MOVIE, bytes: 100, willDelete: true }] });
  assert.doesNotMatch(plain, /installed|part of/, `control: an ordinary cart reads as it did: ${plain}`);
});

test('every Trash sheet a person can reach says it: the shared sheet and the cart\'s, and no other sheet moves files to the Trash (F01)', () => {
  // The openers of the shared sheet whose OK is "Move to Trash" (confirmFooter
  // pins every opener): confirmTrash serves Largest Files, right-click, Grid
  // and ⌘⌫, the Treemap's keyboard, Duplicates, Similar images, Clean Up and
  // the Libraries view; the cart has its own; reofferBlockedTrash re-offers
  // what a sheet already warned about; shader caches are a game's, never an app's.
  assert.match(declOf('confirmTrash'), /installedProgramWarningHtml\(/, 'the shared sheet says it');
  assert.match(declOf('cartManifestHtml'), /installedProgramWarningHtml\(/, 'the cart\'s sheet says it');
  const callers = [...INDEX.matchAll(/\bconfirmTrash\(/g)].length;
  assert.ok(callers >= 10, `every view's Move to Trash goes through the shared sheet (${callers} calls)`);
});
