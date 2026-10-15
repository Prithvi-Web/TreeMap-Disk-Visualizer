import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-trashInstalledProgram-data-');

import { INDEX } from './fixtures/liftFrontend';
import { waitFor } from './fixtures/waitFor';

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
  // The folder under Program Files is often its maker's (Google), not the
  // program's (Google Chrome), and Settings › Apps lists no "Google": the
  // sheet names the folder for what it is and no Apps entry (review F1.11).
  assert.match(win.text, /It is part of a program installed in C:\\Program Files\\Google\. Moving it to the Trash will stop that program from working\. To remove that program, uninstall it in Windows Settings › Apps instead\./, win.text);
  assert.doesNotMatch(win.text, /program Google|stop Google|remove Google/, `no program is named after its folder: ${win.text}`);
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

/** The warning's own functions, out of the built page, over the stubs every sheet here shares. */
const WARNING = ['installedProgramWarningHtml', 'installedProgramWords', 'installedProgramRemoval'];
const sheetDeps = (els: Record<string, { innerHTML: string; classList?: unknown }>): Record<string, unknown> => ({
  $: (id: string) => (els[id] ||= { innerHTML: '', classList: { add: () => {} } }),
  icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, formatCount: String,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

/** The page's confirmOffloadPlan over stubs: the sheet an offload opens for the dry run's `plan`. */
async function offloadSheet(plan: Record<string, unknown>, paths: string[]): Promise<string> {
  const els: Record<string, { innerHTML: string }> = {};
  const deps: Record<string, unknown> = {
    ...sheetDeps(els), state: { scanId: 'scan-1' }, runOffloadJob: async () => assert.fail('nothing runs before OK'),
    api: async (url: string, opts: { body: string }) => {
      assert.equal(url, '/api/offload');
      assert.equal(JSON.parse(opts.body).dryRun, true, 'the sheet is drawn from the dry run');
      return plan;
    },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const confirm = new Function(...keys, `'use strict'; let onConfirmTrash = null; ${[...WARNING, 'confirmOffloadPlan'].map(declOf).join('\n')}\nreturn confirmOffloadPlan;`)(
    ...keys.map((k) => deps[k])) as (paths: string[], dest: string, destName: string, notes: string, isCurrent: () => boolean) => Promise<void>;
  await confirm(paths, '/Volumes/Backup/apps', 'apps', '', () => true);
  return textOf(els.confirmText.innerHTML);
}

test('Offload — copy, verify, then move the originals to the Trash — says it too, from its dry run: the app, and that it will stop working (review F1.4)', async () => {
  const plan = { dryRun: true, fileCount: 2, bytesTotal: 200, dest: '/Volumes/Backup/apps', wouldTrashAfterVerify: [WHATSAPP_EXE, MOVIE], copies: [], copiesTruncated: false };
  const said = await offloadSheet({ ...plan, installedProgramParts: [{ path: WHATSAPP_EXE, installedProgram: WHATSAPP }] }, [WHATSAPP_EXE, MOVIE]);
  assert.match(said, /only then moved to the Trash here/, `control: the offload's own sheet: ${said}`);
  assert.match(said, /1 of these is part of the app WhatsApp\. Moving it to the Trash will stop WhatsApp from working\. To remove WhatsApp, move the whole app to the Trash instead\./, said);
  const plain = await offloadSheet(plan, [WHATSAPP_EXE, MOVIE]);
  assert.doesNotMatch(plain, /installed|part of/, `control: a plan with no part of a program reads as it did: ${plain}`);
});

/** The page's confirmEncode over stubs, for `chosen` videos and the server's answer about them (`parts`). */
function encodeSheet(chosen: Array<{ path: string; estimatedSaving: number }>, parts: unknown[] | null): string {
  const els: Record<string, { innerHTML: string }> = {};
  const deps: Record<string, unknown> = { ...sheetDeps(els), setConfirmButton: () => {}, startEncode: () => assert.fail('nothing runs before OK') };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const confirm = new Function(...keys, `'use strict'; let onConfirmTrash = null; ${[...WARNING, 'confirmEncode'].map(declOf).join('\n')}\nreturn confirmEncode;`)(
    ...keys.map((k) => deps[k])) as (chosen: unknown[], parts: unknown[] | null) => void;
  confirm(chosen, parts);
  return textOf(els.confirmText.innerHTML);
}

test('Shrink Video\'s "Re-encode and replace?" says it too: a video inside an app is part of it, and replacing it will stop the app working (review F1.4)', () => {
  const intro = '/Applications/Google Chrome.app/Contents/Resources/intro.mov';
  const said = encodeSheet([{ path: intro, estimatedSaving: 100 }], [{ path: intro, installedProgram: CHROME }]);
  assert.match(said, /This is lossy/, `control: the re-encode's own sheet: ${said}`);
  assert.match(said, /It is part of the app Google Chrome\. Re-encoding it will stop Google Chrome from working\./, said);
  assert.match(encodeSheet([{ path: intro, estimatedSaving: 100 }], null), /TreeMap couldn’t check whether this is part of an installed app\./, 'and admits it when it could not ask');
  assert.doesNotMatch(encodeSheet([{ path: MOVIE, estimatedSaving: 100 }], []), /installed|part of/, 'control: an ordinary video reads as it did');
});

/**
 * The Shrink Video pane as a person uses it: the page's own loadVideoCandidates
 * draws two videos and wires Re-encode, and its own installedProgramParts asks
 * the server — here `answer`, standing for POST /api/files/installed-programs.
 * confirmEncode records what the sheet was opened with.
 */
async function reencodePane(answer: (paths: string[]) => Promise<{ parts: unknown[] }>) {
  const intro = '/Applications/Google Chrome.app/Contents/Resources/intro.mov';
  const candidates = [intro, MOVIE].map((p) => ({ name: p.split('/').pop(), path: p, size: 9e9, estimatedBytes: 4e9, estimatedSaving: 5e9, reason: 'H264 video' }));
  type Box = { checked: boolean; dataset: { i: string }; addEventListener(): void };
  const boxes: Box[] = candidates.map((_, i) => ({ checked: false, dataset: { i: String(i) }, addEventListener() {} }));
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= {
    innerHTML: '', textContent: '', disabled: false, clicked: [] as Array<() => Promise<void>>,
    querySelectorAll: (sel: string) => (id !== 'videoBody' ? [] : sel === '.vid-ck:checked' ? boxes.filter((b) => b.checked) : sel === '.vid-ck' ? boxes : []),
    addEventListener(t: string, f: () => Promise<void>) { if (t === 'click') this.clicked.push(f); },
  });
  const asked: string[][] = [];
  const opened: Array<{ chosen: Array<{ path: string }>; parts: unknown }> = [];
  const deps: Record<string, unknown> = {
    $, state: { scanId: 's1' },
    api: async (url: string, opts?: { body: string }) => {
      if (url.startsWith('/api/compression/candidates')) return { available: true, candidates, shortlisted: candidates.length, unreadable: 0 };
      assert.equal(url, '/api/files/installed-programs', 'Re-encode asks the server\'s one detector');
      const paths = JSON.parse(opts!.body).paths as string[];
      asked.push(paths);
      return answer(paths);
    },
    skeletonRows: () => '', icon: () => '', escapeHtml: (x: unknown) => String(x), chipFor: () => '',
    formatBytes: (n: number) => `${n} B`, formatCount: String, sizeInk: () => '', sizeColor: () => '',
    confirmEncode: (chosen: Array<{ path: string }>, parts: unknown) => { opened.push({ chosen, parts }); },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(...keys, `let videoCandidates = []; const INSTALLED_PROGRAM_CHUNK = ${/const INSTALLED_PROGRAM_CHUNK = (\d+);/.exec(INDEX)?.[1] ?? 'undefined'};
    ${['installedProgramParts', 'loadVideoCandidates'].map(declOf).join('\n')}
    return loadVideoCandidates;`)(...keys.map((k) => deps[k])) as () => Promise<void>;
  await load();
  assert.equal(els.vidEncodeBtn.clicked.length, 1, 'control: Re-encode has its click');
  return {
    intro, asked, opened,
    tick(i: number) { boxes[i].checked = true; },
    click: (): Promise<void> => els.vidEncodeBtn.clicked[0](),
  };
}

test('Re-encode asks which of the ticked videos are parts of an installed program, waits for the answer, and opens its sheet with it — with null where the server could not be asked (review round 2, F2.6)', async () => {
  // Pinned only by the order of two names in the source, three breakages
  // passed: no `await` (the sheet got a promise, read as "nothing to warn
  // about", and the F1.4 warning was gone), the answer left out, or the two
  // arguments swapped.
  let release = (): void => {};
  const pane = await reencodePane((paths) => new Promise((resolve) => {
    release = () => resolve({ parts: paths.filter((p) => p.includes('.app/')).map((p) => ({ path: p, installedProgram: CHROME })) });
  }));
  pane.tick(0);
  pane.tick(1);
  const clicked = pane.click();
  await waitFor(() => pane.asked.length === 1, 'Re-encode to ask about the ticked videos');
  assert.deepEqual(pane.asked, [[pane.intro, MOVIE]], 'it asks about exactly the ticked videos');
  assert.equal(pane.opened.length, 0, 'and opens no sheet before the answer is in');
  release();
  await clicked;
  assert.equal(pane.opened.length, 1, 'one sheet');
  assert.deepEqual(pane.opened[0].chosen.map((c) => c.path), [pane.intro, MOVIE], 'for the ticked videos');
  assert.deepEqual(pane.opened[0].parts, [{ path: pane.intro, installedProgram: CHROME }], 'with the answer, so the sheet says it before OK');

  // Ticked a strict part of the list, the question is about those videos
  // alone: asked about every candidate, the sheet would say a video nobody is
  // re-encoding is part of Chrome (review round 3, F3.3).
  const answering = async (paths: string[]) => ({ parts: paths.filter((p) => p.includes('.app/')).map((p) => ({ path: p, installedProgram: CHROME })) });
  const ordinary = await reencodePane(answering);
  ordinary.tick(1);
  await ordinary.click();
  assert.deepEqual(ordinary.asked, [[MOVIE]], 'ticked alone, the ordinary video is all it asks about');
  assert.deepEqual(ordinary.opened.map((o) => [o.chosen.map((c) => c.path), o.parts]), [[[MOVIE], []]],
    'and its sheet names no installed program, though an unticked video is part of Chrome');
  const inChrome = await reencodePane(answering);
  inChrome.tick(0);
  await inChrome.click();
  assert.deepEqual(inChrome.asked, [[inChrome.intro]], 'ticked alone, Chrome\'s video is all it asks about');
  assert.deepEqual(inChrome.opened.map((o) => o.parts), [[{ path: inChrome.intro, installedProgram: CHROME }]], 'and its sheet names Chrome');

  const offline = await reencodePane(async () => { throw new Error('offline'); });
  offline.tick(1);
  await offline.click();
  assert.deepEqual(offline.asked, [[MOVIE]], 'offline too, it asked about the ticked video alone');
  assert.deepEqual(offline.opened.map((o) => [o.chosen.map((c) => c.path), o.parts]), [[[MOVIE], null]],
    'where the server could not be asked, the sheet is opened with null, and says it could not check');
});

test('every sheet a person can reach that moves files to the Trash says it: the shared sheet, the cart\'s, Offload\'s and Re-encode\'s (F01; review F1.4)', () => {
  // The openers of the shared sheet whose OK is "Move to Trash" (confirmFooter
  // pins every opener): confirmTrash serves Largest Files, right-click, Grid
  // and ⌘⌫, the Treemap's keyboard, Duplicates, Similar images, Clean Up and
  // the Libraries view; the cart has its own; Offload trashes the originals
  // once their copies verify, and a re-encode trashes the original it
  // replaces; reofferBlockedTrash re-offers what a sheet already warned
  // about; shader caches are a game's, never an app's.
  assert.match(declOf('confirmTrash'), /installedProgramWarningHtml\(/, 'the shared sheet says it');
  assert.match(declOf('cartManifestHtml'), /installedProgramWarningHtml\(/, 'the cart\'s sheet says it');
  assert.match(declOf('confirmOffloadPlan'), /installedProgramWarningHtml\(/, 'Offload\'s sheet says it');
  assert.match(declOf('confirmEncode'), /installedProgramWarningHtml\(/, 'Re-encode\'s sheet says it');
  const callers = [...INDEX.matchAll(/\bconfirmTrash\(/g)].length;
  assert.ok(callers >= 10, `every view's Move to Trash goes through the shared sheet (${callers} calls)`);
});
