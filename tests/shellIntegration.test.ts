import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-shellIntegration-data-');

import { platform } from '../src/platform';
import { capabilityState, invalidateCapabilities } from '../src/platform/capabilities';

/**
 * §D2 — native shell integration.
 *
 * Acceptance: "The entry appears and correctly scopes the scan, verified on
 * Windows Explorer, macOS Finder, and at least two of the three named Linux
 * file managers. **Removing integration cleanly removes the entry.**"
 *
 * The removal half is the one that can be proven anywhere, and it is the half
 * that goes wrong — a dead right-click entry pointing at a deleted app is
 * exactly what §D2 says must not happen. So the round trip runs for real here,
 * against a throwaway HOME so the developer's own Finder is never touched.
 *
 * "The entry appears in Finder/Explorer/Nautilus" needs a human with a mouse on
 * each OS and is not claimed by any test in this file.
 */

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/* ─────────────── The round trip, on a throwaway HOME ─────────────── */

test('installing then removing leaves nothing behind (macOS)', { skip: !IS_MAC }, async () => {
  const { registerShellIntegration, unregisterShellIntegration, isInstalled, bundlePath } =
    await import('../src/platform/macos/shellIntegration');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-'));
  try {
    assert.equal(await isInstalled(home), false, 'nothing there to begin with');

    const installed = await registerShellIntegration('/Applications/TreeMap.app/Contents/MacOS/TreeMap', home);
    assert.equal(installed.installed, true, installed.reason);
    assert.deepEqual(installed.targets, ['finder-quick-action']);
    assert.equal(await isInstalled(home), true);

    // The bundle is the two files Finder needs, and nothing else.
    const contents = path.join(bundlePath(home), 'Contents');
    assert.deepEqual(fs.readdirSync(contents).sort(), ['Info.plist', 'document.wflow']);

    const removed = await unregisterShellIntegration(home);
    assert.equal(removed.installed, false);
    assert.deepEqual(removed.targets, ['finder-quick-action'], 'it reports what it actually removed');
    assert.equal(await isInstalled(home), false);
    assert.equal(fs.existsSync(bundlePath(home)), false, 'the whole bundle is gone, not just its contents');

    // Removing again is not an error, and does not claim to have removed anything.
    const again = await unregisterShellIntegration(home);
    assert.deepEqual(again.targets, [], 'a second removal removes nothing and says so');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the Quick Action passes the folder as one argument, however it is named', { skip: !IS_MAC }, async () => {
  const { documentWflow } = await import('../src/platform/macos/shellIntegration');
  const wflow = documentWflow('/Applications/My Apps/TreeMap.app/Contents/MacOS/TreeMap');
  // The classic failure: an unquoted path launches "/Applications/My" with
  // "Apps/TreeMap.app/..." as an argument. Both sides must be quoted — the
  // program in single quotes, so nothing in its path is read by the shell (review HA-L8).
  assert.match(wflow, /'\/Applications\/My Apps\/TreeMap\.app\/Contents\/MacOS\/TreeMap' "\$target"/);
  assert.match(wflow, /for target in "\$@"/, 'and every selected folder is iterated safely');
});

test('the Quick Action is restricted to Finder, and to folders', { skip: !IS_MAC }, async () => {
  const { infoPlist } = await import('../src/platform/macos/shellIntegration');
  const plist = infoPlist();
  assert.match(plist, /public\.folder/, 'folders only — not every file in every app');
  assert.match(plist, /com\.apple\.finder/, 'and only in Finder’s menu');
});

test('installing then removing leaves nothing behind (Linux)', { skip: !IS_LINUX }, async () => {
  const { registerShellIntegration, unregisterShellIntegration, isInstalled } =
    await import('../src/platform/linux/shellIntegration');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-'));
  try {
    assert.equal(await isInstalled({ home }), false);
    const installed = await registerShellIntegration({ home });
    // A CI container may have no file manager at all — that is a legitimate
    // "nowhere to install", and it must say so rather than claim success.
    if (!installed.installed) {
      assert.match(installed.reason!, /file managers/);
      return;
    }
    assert.ok(installed.targets.length > 0);
    assert.equal(await isInstalled({ home }), true);
    await unregisterShellIntegration({ home });
    assert.equal(await isInstalled({ home }), false, 'removal must be complete');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ─────────────── The argv contract the whole feature rests on ─────────────── */

test('the Windows menu quotes the executable and passes the folder', { skip: process.platform !== 'win32' && false }, async () => {
  const { installCommands, uninstallCommands, SHELL_KEYS } = await import('../src/platform/windows/shellIntegration');
  const cmds = installCommands(String.raw`C:\Program Files\TreeMap\TreeMap.exe`);
  // Only the `…\command` keys hold a command LINE. The sibling `Icon` value is
  // a bare path and must NOT be quoted, so it is deliberately excluded here.
  const commandValues = cmds
    .filter((c) => c.args[1].endsWith(String.raw`\command`))
    .map((c) => c.args[c.args.length - 2]);
  assert.equal(commandValues.length, SHELL_KEYS.length, 'one command line per shell key');
  for (const value of commandValues) {
    // Unquoted, Explorer launches C:\Program with Files\TreeMap\... as an arg.
    assert.match(value, /^"C:\\Program Files\\TreeMap\\TreeMap\.exe"/, `unquoted exe path: ${value}`);
    assert.match(value, /"%1"|"%V"/, `the folder must be passed, quoted: ${value}`);
  }
  const iconValues = cmds
    .filter((c) => c.args.includes('Icon'))
    .map((c) => c.args[c.args.length - 2]);
  for (const value of iconValues) {
    assert.doesNotMatch(value, /^"/, 'a registry Icon value is a bare path, not a command line');
  }

  // Every key installed is a key uninstalled — no orphan can survive.
  const removedKeys = uninstallCommands().map((c) => c.args[1]);
  for (const { key } of SHELL_KEYS) {
    assert.ok(removedKeys.includes(key), `${key} is installed but never removed`);
  }
});

test('the entry launches the app through its ordinary path argument', async () => {
  // §D2: reuse the existing drag-and-drop entry point rather than adding a
  // second path-injection mechanism. Every platform's integration therefore
  // launches `<exe> <folder>`, which electron/main.js already routes through
  // requestScan — the same function a dock drop uses.
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /function scanPathsFromArgv/, 'argv paths are collected');
  assert.match(main, /app\.on\('second-instance'[\s\S]{0,200}scanPathsFromArgv/, 'a second launch forwards its args');
  assert.match(main, /scanPathsFromArgv\(process\.argv\)/, 'and a cold start reads its own');
  assert.match(main, /requestScan\(/, 'both go through the one entry point');
  // Unpackaged, argv[1] is the app directory and would scan the repo.
  assert.match(main, /app\.isPackaged \? 1 : 2/, 'the dev-mode argument offset is handled');
});

/* ─────────────── Capability honesty ─────────────── */

test('the capability names its mechanism, and explains itself when not yet installed', async () => {
  invalidateCapabilities();
  const state = await capabilityState('shellIntegration');
  assert.ok(state.mechanism.length > 0, 'the mechanism is always named');
  if (!state.available) {
    assert.ok(state.reason && state.reason.length > 20, 'and an unavailable one explains why');
  }
});

test('the installed flag is read from the system, never remembered', async () => {
  // A remembered flag goes stale the moment someone deletes the entry by hand,
  // and D2's removal guarantee becomes unverifiable.
  const value = await platform().shellIntegrationInstalled();
  assert.equal(typeof value, 'boolean');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'platformRoutes.ts'), 'utf8');
  assert.match(src, /installed: await provider\.shellIntegrationInstalled\(\)/,
    'the POST response re-reads the real state instead of echoing the intent');
});

/* ─────────────── Only the installed app is offered (hunt C11) ─────────────── */

test('C11: the entry is offered only inside the installed desktop app — under plain Node or from source it is unavailable, and says why', async () => {
  const { DESKTOP_EXEC_ENV, NOT_IN_DESKTOP_APP, desktopLauncher } = await import('../src/platform/desktopLauncher');
  const saved = process.env[DESKTOP_EXEC_ENV];
  try {
    delete process.env[DESKTOP_EXEC_ENV];
    invalidateCapabilities();
    const web = await capabilityState('shellIntegration');
    assert.equal(web.available, false, 'npm start: the entry would run `node <folder>` — that folder\'s own code');
    assert.equal(web.reason, NOT_IN_DESKTOP_APP);
    assert.ok(web.mechanism.length > 0, 'the mechanism is still named');
    process.env[DESKTOP_EXEC_ENV] = path.join(path.parse(process.cwd()).root, 'Applications', 'TreeMap.app', 'Contents', 'MacOS', 'TreeMap');
    invalidateCapabilities();
    const app = await capabilityState('shellIntegration');
    assert.notEqual(app.reason, NOT_IN_DESKTOP_APP, 'inside the app, the platform\'s own answer stands');
    assert.equal(desktopLauncher({ [DESKTOP_EXEC_ENV]: 'TreeMap' }), null, 'a bare name is no program to start');
    assert.equal(desktopLauncher({}), null);
  } finally {
    if (saved === undefined) delete process.env[DESKTOP_EXEC_ENV];
    else process.env[DESKTOP_EXEC_ENV] = saved;
    invalidateCapabilities();
  }
});

test('C11: asked to add the entry with no installed app to start, the platform refuses and writes nothing', async () => {
  const { DESKTOP_EXEC_ENV, NOT_IN_DESKTOP_APP } = await import('../src/platform/desktopLauncher');
  const saved = { exec: process.env[DESKTOP_EXEC_ENV], home: process.env.HOME };
  // A throwaway HOME, so nothing could reach the real one even if the refusal broke.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-c11-'));
  try {
    delete process.env[DESKTOP_EXEC_ENV];
    process.env.HOME = home;
    const r = await platform().registerShellIntegration();
    assert.equal(r.installed, false);
    assert.equal(r.reason, NOT_IN_DESKTOP_APP);
    assert.deepEqual(fs.readdirSync(home), [], 'nothing was written');
  } finally {
    if (saved.exec === undefined) delete process.env[DESKTOP_EXEC_ENV];
    else process.env[DESKTOP_EXEC_ENV] = saved.exec;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ─────────────── Linux entries keep the launcher whole (review F1.5, F1.14) ─────────────── */

/** Exec=… split as the Desktop Entry spec reads it: string escapes first, then double-quote rules, then %% → %. */
function desktopEntryArgv(value: string): string[] {
  const s = value.replace(/\\([\\sntr])/g, (_m, c: string) => ({ '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' })[c]!);
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') { if (cur !== null) out.push(cur); cur = null; continue; }
    if (c === '"') {
      cur = cur ?? '';
      for (i++; i < s.length && s[i] !== '"'; i++) cur += s[i] === '\\' && '"`$\\'.includes(s[i + 1]) ? s[++i] : s[i];
      continue;
    }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  // %% is a literal %; any other % is a field code (%f, %u…), which only the placeholder may be.
  return out.map((a) => {
    if (a === '%f') return a;
    const held = a.replace(/%%/g, '\u0000');
    return held.includes('%') ? `<field code in ${a}>` : held.replace(/\u0000/g, '%');
  });
}

/** A command line split as GLib's g_shell_parse_argv (Thunar's custom actions) reads it. */
function shellArgv(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = cur ?? '';
    if (c === "'") { for (i++; i < s.length && s[i] !== "'"; i++) cur += s[i]; continue; }
    if (c === '"') { for (i++; i < s.length && s[i] !== '"'; i++) cur += s[i] === '\\' && '"`$\\'.includes(s[i + 1]) ? s[++i] : s[i]; continue; }
    if (c === '\\') { cur += s[++i] ?? ''; continue; }
    cur += c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

test('review F1.5/F1.14: Dolphin\'s Exec and Thunar\'s command keep an AppImage path with spaces, parentheses and quotes whole (Dolphin a % too), as each file manager splits it', async () => {
  const { dolphinServiceMenu, addThunarAction } = await import('../src/platform/linux/shellIntegration');
  const launchers = [
    '/home/x/Downloads/TreeMap-5.2.0 (1).AppImage', // a browser's rename of a second download
    '/home/x/My Apps/TreeMap 5.2.0.AppImage',
    '/home/x/it\'s "100%" $HOME `x` \\back/TreeMap.AppImage',
    '/home/x/odd\\"name/TreeMap.AppImage', // a backslash before a quote
    '/opt/TreeMap/treemap',
  ];
  for (const exec of launchers) {
    const line = /^Exec=(.*)$/m.exec(dolphinServiceMenu(exec));
    assert.ok(line, 'Dolphin\'s service menu has an Exec line');
    assert.deepEqual(desktopEntryArgv(line[1]), [exec, '%f'], `Dolphin starts ${exec}, with the folder as its one argument`);
    // Thunar substitutes its own % codes before it splits; a launcher with a % in it is not claimed for Thunar here.
    if (exec.includes('%')) continue;
    const cmd = /<command>([\s\S]*?)<\/command>/.exec(addThunarAction(null, exec));
    assert.ok(cmd, 'Thunar\'s action has a command');
    assert.deepEqual(shellArgv(xmlUnescape(cmd[1])), [exec, '%f'], `Thunar starts ${exec}, with the folder as its one argument`);
  }
});

/* ─────────────── An entry already in place: what it starts (review F1.3, F1.15, F1.16) ─────────────── */

test('review F1.3: the program an entry starts reads back from the entry itself, on every system, as TreeMap wrote it', async () => {
  const mac = await import('../src/platform/macos/shellIntegration');
  const win = await import('../src/platform/windows/shellIntegration');
  const lin = await import('../src/platform/linux/shellIntegration');
  for (const p of ['/Applications/TreeMap.app/Contents/MacOS/TreeMap', '/opt/homebrew/bin/node', '/Users/x/My Apps & <Tools>/it\'s "Tree" (1)/TreeMap']) {
    assert.equal(mac.programOfWorkflow(mac.documentWflow(p)), p, `Finder: ${p}`);
    assert.equal(lin.programOfNautilusScript(lin.nautilusScript(p)), p, `Nautilus: ${p}`);
    assert.equal(lin.programOfDolphinMenu(lin.dolphinServiceMenu(p)), p, `Dolphin: ${p}`);
    assert.equal(lin.programOfThunarActions(lin.addThunarAction(null, p)), p, `Thunar: ${p}`);
  }
  // Entries an earlier build wrote bare (before review F1.5) read back too.
  assert.equal(lin.programOfDolphinMenu('[Desktop Action treemapScan]\nName=Scan with TreeMap\nExec=/usr/bin/node %f\n'), '/usr/bin/node');
  assert.equal(lin.programOfThunarActions('<actions>\n<action>\n\t<unique-id>treemap-scan-1</unique-id>\n\t<command>/usr/bin/node %f</command>\n</action>\n</actions>\n'), '/usr/bin/node');
  // The command value an install writes names the program it starts (how it is read back: the HA-L1 test below).
  const exe = String.raw`C:\Users\x\AppData\Local\Programs\TreeMap\TreeMap.exe`;
  const add = win.installCommands(exe).find((c) => c.args[1].endsWith('\\command'));
  assert.ok(add, 'an install writes a command value');
  assert.equal(win.programOfCommandValue(add.args[add.args.indexOf('/d') + 1]), exe, 'Explorer');
  // Text that is no entry of TreeMap's names no program.
  assert.equal(mac.programOfWorkflow('<plist version="1.0"><dict/></plist>'), null);
  assert.equal(win.programOfCommandValue('C:\\Windows\\notepad.exe %1'), null);
  assert.equal(lin.programOfNautilusScript('#!/bin/sh\necho hello\n'), null);
  assert.equal(lin.programOfThunarActions('<actions>\n<action>\n\t<unique-id>someone-else</unique-id>\n\t<command>/usr/bin/gimp %f</command>\n</action>\n</actions>\n'), null);
});

test('review HA-L8: the Finder entry starts the program at any path — quotes, spaces, `$(…)` and all — as /bin/sh runs it, and runs nothing the path spells', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const mac = await import('../src/platform/macos/shellIntegration');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-finder-'));
  try {
    const marker = path.join(root, 'ran');
    const dir = path.join(root, `My Apps & <Tools>`, `it's "Tree" (1) $(touch ${marker}) \`x\` $HOME`);
    fs.mkdirSync(dir, { recursive: true });
    const program = path.join(dir, 'TreeMap');
    const out = path.join(root, 'started.txt');
    fs.writeFileSync(program, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$TM_STARTED"\n', { mode: 0o755 });
    const command = /<key>COMMAND_STRING<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(mac.documentWflow(program));
    assert.ok(command, 'the workflow holds a shell script');
    const script = command[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const target = path.join(root, 'Folder with "quotes"');
    // Automator runs it with the folders as its arguments; `wait` lets the backgrounded launch end before it is read.
    const r = spawnSync('/bin/sh', ['-c', `${script}\nwait\n`, 'sh', target], { env: { ...process.env, TM_STARTED: out }, encoding: 'utf8' });
    assert.equal(fs.existsSync(marker), false, 'nothing the path spells was run');
    assert.equal(r.status, 0, `the script ran: ${r.stderr}`);
    assert.equal(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '<the program never started>', `${target}\n`, 'the program started, with the folder as its one argument');
    assert.equal(mac.programOfWorkflow(mac.documentWflow(program)), program, 'the program reads back as written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // An entry an earlier build wrote, the program in double quotes, still reads back.
  assert.equal(mac.programOfWorkflow(`<key>COMMAND_STRING</key>\n<string>#!/bin/sh\nfor target in "$@"; do\n  "/opt/homebrew/bin/node" "$target" &amp;\ndone\n</string>`), '/opt/homebrew/bin/node');
});

test('review HA-L1: the Windows entry\'s program reads back whole whatever letters its path holds — never from text a console prints in its own code page', async () => {
  const win = await import('../src/platform/windows/shellIntegration');
  // What a console printing in its own code page (850, 866, 932…) does to a letter past ASCII, as Node reads the text
  // back as UTF-8: it is lost. `reg query` printed C:\Users\José as C:\Users\Jos�, never the launcher.
  const throughConsole = (text: string) => text.replace(/[^\x00-\x7f]/g, '\uFFFD');
  for (const exe of [
    String.raw`C:\Users\José\AppData\Local\Programs\TreeMap\TreeMap.exe`,
    String.raw`C:\Users\Дмитрий\AppData\Local\Programs\TreeMap\TreeMap.exe`,
    String.raw`C:\Users\山田\AppData\Local\Programs\TreeMap\TreeMap.exe`,
    String.raw`C:\Program Files\TreeMap\TreeMap.exe`,
  ]) {
    const add = win.installCommands(exe).find((c) => c.args[1].endsWith('\\command'))!;
    const value = add.args[add.args.indexOf('/d') + 1];
    const scripts: string[] = [];
    // PowerShell, run on the value an install wrote: what the script prints for it — its UTF-8 bytes in Base64 —
    // passed through the console as any text is.
    const run = async (script: string): Promise<unknown> => {
      scripts.push(script);
      return JSON.parse(throughConsole(JSON.stringify({ utf8Base64: Buffer.from(value, 'utf8').toString('base64') })));
    };
    assert.equal(await win.installedProgram(run), exe, `the program reads back as written: ${exe}`);
    assert.equal(scripts.length, 1, 'one PowerShell call');
    assert.ok(scripts[0].includes(`'${win.SHELL_KEYS[0].key.replace(/^HKCU\\/, 'HKCU:\\')}\\command'`), 'it reads the key an install writes');
    assert.match(scripts[0], /\.GetValue\(''\)/, 'its default value');
    assert.match(scripts[0], /\[Convert\]::ToBase64String\(\[Text\.Encoding\]::UTF8\.GetBytes\(/, 'and prints it as Base64 of its UTF-8 bytes, which no code page alters');
  }
  // No value, or an answer that is not TreeMap's: no program — never a guess.
  assert.equal(await win.installedProgram(async () => null), null);
  assert.equal(await win.installedProgram(async () => ({ utf8Base64: 'IkM6XHgu!ZXhlIiAiJTEi' })), null,
    'text that is not Base64 is no answer, though Node would decode it past the stray letter');
  assert.equal(await win.installedProgram(async () => ({ utf8Base64: 'IkM6XHguZXhlIiAiJTEi' })), 'C:\\x.exe', 'control: the same answer whole');
  assert.equal(await win.installedProgram(async () => { throw new Error('Cannot find path'); }), null);
});

test('review F1.15/F1.16: an entry already in place is seen, and can be removed, where adding is not offered; one that starts another program is never called this app\'s', { skip: !IS_MAC && !IS_LINUX }, async () => {
  const { DESKTOP_EXEC_ENV } = await import('../src/platform/desktopLauncher');
  const express = (await import('express')).default;
  const { platformRouter } = await import('../src/api/platformRoutes');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const saved = { exec: process.env[DESKTOP_EXEC_ENV], home: process.env.HOME };
  // A throwaway HOME: the entries are written and removed there, never in the real one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-stale-'));
  const node = '/opt/homebrew/bin/node'; // what an earlier build run with `npm start` wrote: the entry ran `node <folder>`
  const app = '/Applications/TreeMap.app/Contents/MacOS/TreeMap';
  const write = async (program: string) => {
    if (IS_MAC) {
      await (await import('../src/platform/macos/shellIntegration')).registerShellIntegration(program, home);
    } else {
      const dir = path.join(home, '.local', 'share', 'nautilus', 'scripts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Scan with TreeMap'), (await import('../src/platform/linux/shellIntegration')).nautilusScript(program), { mode: 0o755 });
    }
  };
  const web = express();
  web.use(express.json());
  web.use('/api', platformRouter);
  web.use(errorHandler);
  const server = web.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/platform/shell-integration`;
  const get = async () => (await fetch(base)).json() as Promise<Record<string, unknown>>;
  const post = async (install: boolean) => {
    const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install }) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const as = (exec: string | undefined) => {
    if (exec === undefined) delete process.env[DESKTOP_EXEC_ENV];
    else process.env[DESKTOP_EXEC_ENV] = exec;
    invalidateCapabilities();
  };
  try {
    process.env.HOME = home;
    await write(node);
    as(undefined); // a browser tab, or `npm start`
    const tab = await get();
    assert.deepEqual([tab.supported, tab.installed, tab.program, tab.current], [false, true, node, false],
      'the entry in place is seen, with what it starts, where adding is not offered');
    as(app); // the installed app
    const desk = await get();
    assert.deepEqual([desk.installed, desk.program, desk.current], [true, node, false], 'an entry that starts node is not this app\'s');
    as(undefined);
    const added = await post(true);
    assert.deepEqual([added.status, added.body.code], [409, 'CAPABILITY_UNAVAILABLE'], 'adding is still refused where the entry would start nothing of TreeMap\'s');
    const removed = await post(false);
    assert.deepEqual([removed.status, removed.body.installed], [200, false], 'removing is not: the entry in place can always be taken away');
    assert.equal((await get()).installed, false, 'and the system no longer has it');
    // An entry TreeMap cannot read a program from, where no launcher is known: never called this app's.
    await write(node);
    const entry = IS_MAC
      ? path.join(home, 'Library', 'Services', 'Scan with TreeMap.workflow', 'Contents', 'document.wflow')
      : path.join(home, '.local', 'share', 'nautilus', 'scripts', 'Scan with TreeMap');
    fs.writeFileSync(entry, 'not an entry TreeMap wrote');
    const unread = await get();
    assert.deepEqual([unread.installed, unread.program, unread.current], [true, null, false], 'an unreadable entry with no launcher known is not this app\'s');
    await write(app);
    as(app);
    const own = await get();
    assert.deepEqual([own.installed, own.program, own.current], [true, app, true], 'control: the app\'s own entry is its own');
  } finally {
    server.close();
    if (saved.exec === undefined) delete process.env[DESKTOP_EXEC_ENV];
    else process.env[DESKTOP_EXEC_ENV] = saved.exec;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    invalidateCapabilities();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ─────────────── A portable session adds nothing to this computer (review F1.4) ─────────────── */

test('review F1.4: a portable session is never offered the entry, even inside the desktop app — it adds nothing to this computer, as its own panel says', async () => {
  const { DESKTOP_EXEC_ENV } = await import('../src/platform/desktopLauncher');
  const { initPortableMode, resetPortableMode, degradedCapabilities, PORTABLE_NO_SHELL_ENTRY } = await import('../src/services/portableMode');
  const saved = process.env[DESKTOP_EXEC_ENV];
  try {
    process.env[DESKTOP_EXEC_ENV] = path.join(path.parse(process.cwd()).root, 'Tools', 'TreeMap.exe');
    // The Windows portable build names its own folder in PORTABLE_EXECUTABLE_DIR; TREEMAP_DATA_DIR (this test's own) keeps it writing there.
    resetPortableMode();
    initPortableMode({ ...process.env, PORTABLE_EXECUTABLE_DIR: path.join(path.parse(process.cwd()).root, 'Tools') });
    invalidateCapabilities();
    const portable = await capabilityState('shellIntegration');
    assert.equal(portable.available, false, 'a portable session writes nothing to the host, and a right-click entry would name a copy that may be gone');
    assert.equal(portable.reason, PORTABLE_NO_SHELL_ENTRY);
    assert.ok(degradedCapabilities(process.platform, true).some((d) => d.key === 'shellIntegration' && d.reason === PORTABLE_NO_SHELL_ENTRY),
      'the portable panel says the same sentence');
    resetPortableMode();
    initPortableMode({ ...process.env, TREEMAP_PORTABLE: undefined, PORTABLE_EXECUTABLE_DIR: undefined }, fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-notportable-')));
    invalidateCapabilities();
    assert.notEqual((await capabilityState('shellIntegration')).reason, PORTABLE_NO_SHELL_ENTRY, 'control: an installed app is not a portable session');
  } finally {
    if (saved === undefined) delete process.env[DESKTOP_EXEC_ENV];
    else process.env[DESKTOP_EXEC_ENV] = saved;
    resetPortableMode();
    invalidateCapabilities();
  }
});
