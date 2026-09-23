import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

/**
 * M6 / W6-1 — the elevation launcher for tm-mft-helper.exe (electron/mft.js).
 *
 * TreeMap never runs elevated. Only the small helper does, for one scan, after
 * one plain sentence; saying no (to our dialog or to the Windows prompt) is a
 * decline with its own reason, never an error. Electron and PowerShell cannot
 * run here, so the dialog and `spawn` are fakes, and the PowerShell script is
 * checked by decoding exactly what would be handed to powershell.exe.
 *
 * Paths below are written with doubled backslashes; the comment beside each
 * shows the raw text Windows would see.
 */

const MFT_PATH = path.join(__dirname, '..', 'electron', 'mft.js');

type Outcome =
  | { kind: 'exited'; code: number }
  | { kind: 'declined'; reason: string }
  | { kind: 'failed'; reason: string };

interface MftRequest {
  helperPath: string;
  volume: string;
  root: string;
  output: string;
}

type ShowMessageBox = (options: Record<string, unknown>) => Promise<unknown>;
type Spawn = (command: string, args: string[], options: Record<string, unknown>) => unknown;

interface MftModule {
  createMftLauncher(deps: {
    showMessageBox: ShowMessageBox;
    spawn: Spawn;
    platform?: string;
    powershell?: string;
    workingDirectory?: string;
    refuseTarget?: (file: string) => string | null;
  }): (request: MftRequest) => Promise<Outcome>;
  quoteWindowsArg(arg: string): string;
  psSingleQuote(text: string): string;
  encodeCommand(script: string): string;
  explanation(volume: string): string;
  DECLINED_EXIT: number;
  PS_FAILED_EXIT: number;
  OWNER_REFUSED_EXIT: number;
  TRUSTED_OWNER_SIDS: readonly string[];
}

/** Loaded per test, so a missing or broken module fails every test on its own. */
function loadMft(): MftModule {
  return require(MFT_PATH) as MftModule;
}

// C:\Users\O'Brien\AppData\Local\Programs\TreeMap\resources\tm-mft-helper.exe
const HELPER = "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\TreeMap\\resources\\tm-mft-helper.exe";
// C:\Users\O'Brien\AppData\Local\Temp\tm mft\scan.bin
const OUTPUT = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\tm mft\\scan.bin";
const REQUEST: MftRequest = { helperPath: HELPER, volume: 'C:', root: 'C:\\', output: OUTPUT };

const SYSTEM = 'C:\\Windows\\System32';
const PWSH = `${SYSTEM}\\WindowsPowerShell\\v1.0\\powershell.exe`;
/**
 * What main.js hands every launcher on Windows (the third security review of
 * M6): PowerShell by the full path under the system folder the kernel reports,
 * that folder as the working directory, and the check that refuses a program
 * this user could have changed. Here the check lets everything through; the
 * tests that are about it replace it.
 */
const SAFE = { powershell: PWSH, workingDirectory: SYSTEM, refuseTarget: (_file: string): string | null => null };

const DIALOG_DECLINED = 'you chose to scan normally instead of granting administrator permission';
const PROMPT_DECLINED = 'elevation was declined at the Windows prompt';

/* ───────────────────────────── fakes ───────────────────────────── */

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/** A `spawn` whose child runs `behave` on the next turn, the way a real process reports later. */
function fakeSpawn(behave: (child: FakeChild) => void): { spawn: Spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, calls };
}

/** PowerShell writes `stderr` (chunk by chunk, as bytes) and exits with `code`. */
function exitsWith(code: number, stderr: Buffer[] = []): (child: FakeChild) => void {
  return (child) => {
    for (const chunk of stderr) child.stderr.emit('data', chunk);
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
}

/** A dialog that answers `response`, or resolves nothing, or throws. */
function fakeDialog(answer: { response: number } | undefined | Error): { showMessageBox: ShowMessageBox; shown: Array<Record<string, unknown>> } {
  const shown: Array<Record<string, unknown>> = [];
  const showMessageBox: ShowMessageBox = (options) => {
    shown.push(options);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return { showMessageBox, shown };
}

const CONTINUE = { response: 0 };
const SCAN_NORMALLY = { response: 1 };

function decodeScript(call: SpawnCall): string {
  const at = call.args.indexOf('-EncodedCommand');
  assert.ok(at >= 0, 'PowerShell is handed an -EncodedCommand');
  return Buffer.from(call.args[at + 1], 'base64').toString('utf16le');
}

/* ───────────────────────────── outcomes ───────────────────────────── */

test('off Windows the launcher fails without asking anything or starting PowerShell', async () => {
  const { createMftLauncher } = loadMft();
  for (const platform of ['darwin', 'linux']) {
    const dialog = fakeDialog(CONTINUE);
    const ps = fakeSpawn(exitsWith(0));
    const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform })(REQUEST);
    assert.equal(outcome.kind, 'failed', platform);
    assert.match((outcome as { reason: string }).reason, /Windows/, 'the reason names what is missing');
    assert.equal(dialog.shown.length, 0, `${platform}: no dialog`);
    assert.equal(ps.calls.length, 0, `${platform}: no PowerShell`);
  }
});

test('the one question is asked exactly as specified, and "Scan normally" declines without starting PowerShell', async () => {
  const { createMftLauncher, explanation } = loadMft();
  const dialog = fakeDialog(SCAN_NORMALLY);
  const ps = fakeSpawn(exitsWith(0));
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.deepEqual(outcome, { kind: 'declined', reason: DIALOG_DECLINED });
  assert.equal(dialog.shown.length, 1, 'asked once');
  assert.deepEqual(dialog.shown[0], {
    type: 'question',
    buttons: ['Continue', 'Scan normally'],
    defaultId: 0,
    cancelId: 1,
    message: explanation('C:'),
    noLink: true,
  });
  assert.equal(ps.calls.length, 0, 'declining in our dialog never reaches the Windows prompt');
});

test('a question that could not be shown, or came back with no answer, never starts the helper', async () => {
  const { createMftLauncher } = loadMft();
  for (const answer of [undefined, new Error('dialog unavailable')]) {
    const dialog = fakeDialog(answer);
    const ps = fakeSpawn(exitsWith(0));
    const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
    assert.equal(outcome.kind, 'failed', String(answer));
    assert.equal(ps.calls.length, 0, `${String(answer)}: nothing started without a yes`);
  }
});

test('declining the Windows prompt (exit 1223) is a decline with its own reason, not the dialog one', async () => {
  const { createMftLauncher, DECLINED_EXIT } = loadMft();
  assert.equal(DECLINED_EXIT, 1223, 'ERROR_CANCELLED');
  const ps = fakeSpawn(exitsWith(1223));
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.deepEqual(outcome, { kind: 'declined', reason: PROMPT_DECLINED });
  assert.notEqual(PROMPT_DECLINED, DIALOG_DECLINED, 'the two declines are told apart');
  assert.equal(ps.calls.length, 1);
});

test('the helper exit code comes back untouched: 0 is success, 2 is its refusal', async () => {
  const { createMftLauncher } = loadMft();
  for (const code of [0, 2]) {
    // Stray stderr on a normal exit is not a failure: only 9001 is.
    const ps = fakeSpawn(exitsWith(code, [Buffer.from('noise')]));
    const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
    assert.deepEqual(outcome, { kind: 'exited', code });
  }
});

test('PowerShell failing to start the helper (exit 9001) is a failure naming its stderr, decoded whole as UTF-8', async () => {
  const { createMftLauncher, PS_FAILED_EXIT } = loadMft();
  assert.equal(PS_FAILED_EXIT, 9001);
  const message = 'Die Datei wurde nicht gefunden: tm-mft-helper.exe (é)';
  const bytes = Buffer.from(`${message}\r\n`, 'utf8');
  const split = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // inside the two-byte é
  const ps = fakeSpawn(exitsWith(9001, [bytes.subarray(0, split), bytes.subarray(split)]));
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.deepEqual(outcome, { kind: 'failed', reason: `PowerShell could not start the helper: ${message}` });
});

test('stderr carried into a failure reason is capped at 4 KiB', async () => {
  const { createMftLauncher } = loadMft();
  const flood = Buffer.alloc(10_000, 'x');
  const ps = fakeSpawn(exitsWith(9001, [flood.subarray(0, 3000), flood.subarray(3000)]));
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.equal(outcome.kind, 'failed');
  const reason = (outcome as { reason: string }).reason;
  const carried = reason.slice('PowerShell could not start the helper: '.length);
  assert.equal(Buffer.byteLength(carried, 'utf8'), 4096, 'exactly the first 4 KiB');
});

test('a spawn error event is a failure carrying its message, never an exit', async () => {
  const { createMftLauncher } = loadMft();
  const ps = fakeSpawn((child) => {
    child.emit('error', new Error('spawn powershell.exe ENOENT'));
    child.emit('close', -4058, null); // what Node emits after a failed spawn
  });
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.match((outcome as { reason: string }).reason, /spawn powershell\.exe ENOENT/);
});

test('a spawn that throws outright is a failure too, not a rejected promise', async () => {
  const { createMftLauncher } = loadMft();
  const spawn: Spawn = () => {
    throw new Error('EPERM');
  };
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn, platform: 'win32' })(REQUEST);
  assert.equal(outcome.kind, 'failed');
  assert.match((outcome as { reason: string }).reason, /EPERM/);
});

test('a malformed request fails before any question is asked', async () => {
  const { createMftLauncher } = loadMft();
  const bad: Array<Partial<MftRequest>> = [
    { ...REQUEST, helperPath: '' },
    { ...REQUEST, output: 'C:\\x\0.bin' },
    { volume: 'C:', root: 'C:\\', output: OUTPUT },
  ];
  for (const request of bad) {
    const dialog = fakeDialog(CONTINUE);
    const ps = fakeSpawn(exitsWith(0));
    const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform: 'win32' })(request as MftRequest);
    assert.equal(outcome.kind, 'failed', JSON.stringify(request));
    assert.equal(dialog.shown.length + ps.calls.length, 0, 'nothing asked, nothing started');
  }
});

/* ───────────────────────────── the sentence ───────────────────────────── */

test('the explanation is one plain sentence that names the volume and says what is being asked', () => {
  const { explanation } = loadMft();
  for (const volume of ['C:', 'D:']) {
    const text = explanation(volume);
    assert.ok(text.includes(volume), `names ${volume}`);
    assert.equal(text.split('.').length - 1, 1, `exactly one full stop: ${text}`);
    assert.ok(text.endsWith('.'), 'and it ends the sentence');
    assert.doesNotMatch(text, /[!?]/, 'no other sentence ending');
    assert.match(text, /administrator permission/);
    assert.match(text, /small helper/);
    assert.match(text, /file table directly/);
    assert.match(text, /read-only/);
    assert.match(text, /this one scan/);
    assert.match(text, /Scan normally/);
    assert.doesNotMatch(text, /\bMFT\b|elevat|\bUAC\b|\bNTFS\b|master file table/i, 'plain words only');
  }
});

/* ───────────────────────────── the PowerShell handed over ───────────────────────────── */

/* ───────────────────────────── what may be started as administrator ───────────────────────────── */

test('on Windows a launcher is refused when it is made without a full PowerShell path, a full working folder or the target check', () => {
  const { createMftLauncher } = loadMft();
  const base = { showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: fakeSpawn(exitsWith(0)).spawn, platform: 'win32' };
  assert.doesNotThrow(() => createMftLauncher({ ...base, ...SAFE }));
  for (const [label, over] of [
    ['PowerShell by name, which Windows would look up in the app’s own folder first', { powershell: 'powershell.exe' }],
    ['no PowerShell at all', { powershell: undefined }],
    ['a relative working folder', { workingDirectory: 'System32' }],
    ['no working folder', { workingDirectory: undefined }],
    ['no target check', { refuseTarget: undefined }],
  ] as const) {
    assert.throws(() => createMftLauncher({ ...base, ...SAFE, ...over }), TypeError, label);
  }
  // Off Windows nothing is ever started, so nothing is required.
  assert.doesNotThrow(() => createMftLauncher({ ...base, platform: 'darwin' }));
});

test('nothing is asked or started when PowerShell or the helper sits where a program running as the user could change it', async () => {
  const { createMftLauncher } = loadMft();
  for (const target of [PWSH, HELPER]) {
    const dialog = fakeDialog(CONTINUE);
    const ps = fakeSpawn(exitsWith(0));
    const checked: string[] = [];
    const refuseTarget = (file: string): string | null => {
      checked.push(file);
      return file === target ? `the folder of ${file} lets any program running as you add or replace files in it` : null;
    };
    const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform: 'win32', refuseTarget })(REQUEST);
    assert.equal(outcome.kind, 'failed', target);
    assert.equal((outcome as { reason: string }).reason, `nothing was started as administrator: the folder of ${target} lets any program running as you add or replace files in it`);
    assert.equal(dialog.shown.length, 0, 'no question whose yes could not be used');
    assert.equal(ps.calls.length, 0, 'nothing started');
    assert.deepEqual(checked, target === PWSH ? [PWSH] : [PWSH, HELPER], 'PowerShell is checked, then the helper');
  }
});

test('a target check that throws refuses, as a check that answered no would: nothing is asked or started', async () => {
  const { createMftLauncher } = loadMft();
  const dialog = fakeDialog(CONTINUE);
  const ps = fakeSpawn(exitsWith(0));
  const refuseTarget = (): string | null => {
    throw new Error('EBUSY: the probe could not be made');
  };
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: dialog.showMessageBox, spawn: ps.spawn, platform: 'win32', refuseTarget })(REQUEST);
  assert.deepEqual(outcome, { kind: 'failed', reason: `nothing was started as administrator: ${PWSH} could not be checked: EBUSY: the probe could not be made` });
  assert.equal(dialog.shown.length, 0);
  assert.equal(ps.calls.length, 0);
});

test('the script checks who owns the helper and its folder, by security identifier, before it asks Windows to start it', async () => {
  const { createMftLauncher, TRUSTED_OWNER_SIDS, OWNER_REFUSED_EXIT } = loadMft();
  assert.deepEqual([...TRUSTED_OWNER_SIDS], [
    'S-1-5-32-544', // Administrators
    'S-1-5-18', // SYSTEM
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // TrustedInstaller
  ]);
  const ps = fakeSpawn(exitsWith(0));
  await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  const script = decodeScript(ps.calls[0]);
  const folder = "C:\\Users\\O''Brien\\AppData\\Local\\Programs\\TreeMap\\resources";
  const loop = `foreach ($item in @('C:\\Users\\O''Brien\\AppData\\Local\\Programs\\TreeMap\\resources\\tm-mft-helper.exe', '${folder}'))`;
  assert.ok(script.includes(loop), `the helper and its folder, each a quoted literal:\n${script}`);
  assert.ok(script.includes('(Get-Acl -LiteralPath $item).GetOwner([System.Security.Principal.SecurityIdentifier]).Value'), script);
  for (const sid of TRUSTED_OWNER_SIDS) assert.ok(script.includes(`'${sid}'`), sid);
  assert.ok(script.includes(`exit ${OWNER_REFUSED_EXIT}`), script);
  assert.ok(script.indexOf('Get-Acl') < script.indexOf('Start-Process'), 'the owners are checked before anything is started');
  assert.ok(script.includes(`-WorkingDirectory 'C:\\Windows\\System32'`), 'the helper starts in the system folder too');
});

test('a helper whose owner is not Windows or its administrators is a failure that names the owner, never a decline', async () => {
  const { createMftLauncher, OWNER_REFUSED_EXIT } = loadMft();
  const said = `${HELPER} is owned by S-1-5-21-1-2-3-1001, not by Windows or its administrators`;
  const ps = fakeSpawn(exitsWith(OWNER_REFUSED_EXIT, [Buffer.from(said, 'utf8')]));
  const outcome = await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.deepEqual(outcome, { kind: 'failed', reason: `nothing was started as administrator: ${said}` });
});

test('PowerShell is started hidden, with no profile, on the encoded script, exactly as specified', async () => {
  const { createMftLauncher } = loadMft();
  const ps = fakeSpawn(exitsWith(0));
  await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  assert.equal(ps.calls.length, 1);
  const call = ps.calls[0];
  assert.equal(call.command, PWSH, 'PowerShell by its full path, never by a name Windows would look up');
  assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  assert.equal(call.args.length, 6, 'nothing after the encoded script');
  assert.deepEqual(call.options, { cwd: SYSTEM, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }, 'started from the system folder, not the app’s own');

  const custom = fakeSpawn(exitsWith(0));
  const pwsh = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: custom.spawn, platform: 'win32', powershell: pwsh })(REQUEST);
  assert.equal(custom.calls[0].command, pwsh, 'the injected PowerShell path is the one started');
});

test('the encoded command is a Start-Process RunAs script with the helper and its three arguments quoted twice over', async () => {
  const { createMftLauncher } = loadMft();
  const ps = fakeSpawn(exitsWith(0));
  await createMftLauncher({ ...SAFE, showMessageBox: fakeDialog(CONTINUE).showMessageBox, spawn: ps.spawn, platform: 'win32' })(REQUEST);
  const script = decodeScript(ps.calls[0]);

  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /Start-Process /);
  assert.ok(script.includes('-Verb RunAs'), script);
  assert.match(script, /-Wait\b/);
  assert.match(script, /-PassThru\b/);
  assert.match(script, /-WindowStyle Hidden/);
  // Raw: -FilePath 'C:\Users\O''Brien\AppData\Local\Programs\TreeMap\resources\tm-mft-helper.exe'
  assert.ok(
    script.includes("-FilePath 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\TreeMap\\resources\\tm-mft-helper.exe'"),
    'the helper path sits in a single-quoted literal with its apostrophe doubled',
  );
  // Raw: -ArgumentList '"C:" "C:\\" "C:\Users\O''Brien\AppData\Local\Temp\tm mft\scan.bin"'
  assert.ok(
    script.includes("-ArgumentList '\"C:\" \"C:\\\\\" \"C:\\Users\\O''Brien\\AppData\\Local\\Temp\\tm mft\\scan.bin\"'"),
    'volume, root and output are each MSVC-quoted, then the whole line PowerShell-quoted',
  );
  assert.match(script, /exit \$p\.ExitCode/);
  assert.match(script, /Win32Exception/);
  assert.match(script, /NativeErrorCode -eq 1223/);
  assert.match(script, /InnerException/);
  assert.match(script, /exit 1223\b/);
  assert.match(script, /\[Console\]::Error\.WriteLine\(/);
  assert.match(script, /exit 9001\b/);
});

test('encodeCommand is base64 of UTF-16LE, the only encoding -EncodedCommand accepts', () => {
  const { encodeCommand } = loadMft();
  assert.equal(encodeCommand('a'), 'YQA=', "'a' is 61 00 in UTF-16LE");
  assert.equal(encodeCommand('exit 1'), 'ZQB4AGkAdAAgADEA');
  const unusual = "Write-Host 'Zoë ’ 名前'";
  assert.equal(Buffer.from(encodeCommand(unusual), 'base64').toString('utf16le'), unusual);
});

test('quoteWindowsArg follows the MSVC / CommandLineToArgvW rules', () => {
  const { quoteWindowsArg } = loadMft();
  const vectors: Array<[string, string]> = [
    ['C:\\', '"C:\\\\"'], //                                   C:\  ->  "C:\\"
    ['C:\\Program Files\\x', '"C:\\Program Files\\x"'], //     backslashes before ordinary text stay single
    ['a"b', '"a\\"b"'], //                                     a"b  ->  "a\"b"
    ['a\\\\"b', '"a\\\\\\\\\\"b"'], //                         a\\"b  ->  "a\\\\\"b"
    ['a\\b', '"a\\b"'], //                                     a\b  ->  "a\b"
    ['', '""'], //                                             empty is still one argument
    ['C:\\dir with space\\\\', '"C:\\dir with space\\\\\\\\"'], // a trailing run doubles: \\ -> \\\\
  ];
  for (const [input, expected] of vectors) assert.equal(quoteWindowsArg(input), expected, JSON.stringify(input));
});

test('psSingleQuote doubles every character PowerShell would end a single-quoted literal on', () => {
  const { psSingleQuote } = loadMft();
  assert.equal(psSingleQuote("it's"), "'it''s'");
  assert.equal(psSingleQuote(''), "''");
  assert.equal(psSingleQuote('C:\\a "b" $c'), "'C:\\a \"b\" $c'", 'no other character is special inside single quotes');
  // PowerShell's tokenizer also closes a single-quoted string on U+2018..U+201B.
  assert.equal(psSingleQuote('O\u2019Brien'), "'O\u2019\u2019Brien'");
  assert.equal(psSingleQuote('\u2018\u201a\u201b'), "'\u2018\u2018\u201a\u201a\u201b\u201b'");
});

test('the module never loads electron, so plain Node (and these tests) can use it', () => {
  const source = fs.readFileSync(MFT_PATH, 'utf8');
  assert.doesNotMatch(source, /require\(\s*['"`]electron['"`]\s*\)/);
  const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = mod._load;
  const requested: string[] = [];
  mod._load = function recording(this: unknown, request: string, parent: unknown, isMain: boolean) {
    requested.push(request);
    if (request === 'electron') throw new Error('electron/mft.js asked for electron');
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(MFT_PATH)];
    require(MFT_PATH);
  } finally {
    mod._load = original;
  }
  assert.ok(!requested.includes('electron'), `requested: ${requested.join(', ')}`);
});
