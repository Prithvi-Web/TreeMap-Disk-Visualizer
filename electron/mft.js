'use strict';
/*
 * Windows whole-drive fast scan (M6, decision W6-1): the elevation launcher.
 *
 * TreeMap itself never runs elevated. Only tm-mft-helper.exe does, for one
 * scan: it reads one drive's file table directly, read-only, and writes what
 * it found to `output`. This module is the only way that helper is started,
 * and it is started the same way every time:
 *
 *   1. One plain sentence in a dialog (`explanation`). "Scan normally" is a
 *      decline, never an error, and nothing is started.
 *   2. PowerShell's `Start-Process -Verb RunAs`, which raises the Windows
 *      permission prompt. Saying no there is a decline too, with its own
 *      reason, so the scan can say which of the two questions was answered.
 *   3. The helper's own exit code, passed back untouched (0 success,
 *      2 refusal). There is no timeout: the person may take a while at the
 *      prompt.
 *
 * Nothing is started as administrator that a program running as the user
 * could have changed (the third security review of M6): PowerShell is started
 * by its full path under the system folder the kernel reports, from that
 * folder, never by a name Windows would look up in the app's own folder; both
 * it and the helper pass `refuseTarget` before the question is even asked; and
 * the script checks, just before it starts the helper, that Windows or its
 * administrators own the helper and its folder (TRUSTED_OWNER_SIDS).
 *
 * Pure: no `electron` import. main.js injects dialog.showMessageBox,
 * child_process.spawn, the PowerShell path, its folder and the target check,
 * and src/services/scan/nativeEngine.ts receives the launcher through
 * setMftLauncher, so plain Node tests (tests/electronMft.test.ts) drive every
 * branch with fakes.
 *
 * Outcome, always one of:
 *   { kind: 'exited', code }     the helper ran elevated and exited with `code`
 *   { kind: 'declined', reason } the person said no, to our dialog or to Windows
 *   { kind: 'failed', reason }   the launch itself failed; nothing ran elevated
 */

const path = require('path');

/*
 * The script's own exit codes sit beside the helper's, which are only 0
 * (columns written), 2 (refused, the reason in its output file) or a crash
 * (Rust's 101, or an NTSTATUS such as 0xC0000005): none of the three below
 * can be the helper's own answer (the third security review of M6, LOW).
 */
/** ERROR_CANCELLED: the Windows permission prompt was declined. */
const DECLINED_EXIT = 1223;
/** The script's own code for "PowerShell could not start the helper". */
const PS_FAILED_EXIT = 9001;
/** The script's own code for "the helper or its folder has an owner outside TRUSTED_OWNER_SIDS". */
const OWNER_REFUSED_EXIT = 9002;
/**
 * The owners a program may have to be started as administrator: the
 * Administrators group, SYSTEM and TrustedInstaller — by security identifier,
 * since their names change with Windows' display language. An install for
 * anyone who uses the computer is owned by one of them; one "only for me", a
 * portable copy or a checkout is owned by the user, who could change it.
 */
const TRUSTED_OWNER_SIDS = Object.freeze([
  'S-1-5-32-544',
  'S-1-5-18',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
]);
/** The most of PowerShell's stderr a failure reason carries. */
const STDERR_CAP_BYTES = 4096;

const CONTINUE_BUTTON = 0;
const SCAN_NORMALLY_BUTTON = 1;
const DIALOG_DECLINED_REASON = 'you chose to scan normally instead of granting administrator permission';
const PROMPT_DECLINED_REASON = 'elevation was declined at the Windows prompt';
const REQUEST_FIELDS = ['helperPath', 'volume', 'root', 'output'];

/**
 * PowerShell's tokenizer ends a single-quoted string on U+2018..U+201B as well
 * as on the ASCII apostrophe, so all five are doubled, not just `'`.
 */
const PS_SINGLE_QUOTE_CHARS = /['\u2018\u2019\u201A\u201B]/g;

/**
 * One argument quoted for the helper's command-line parser (the MSVC and
 * CommandLineToArgvW rules): wrapped in double quotes; backslashes are literal
 * unless a double quote follows them, so every run of backslashes before an
 * embedded quote or the closing quote is doubled, and an embedded quote
 * becomes \". So C:\ becomes "C:\\": "C:\" would swallow its closing quote.
 * @param {string} arg
 * @returns {string}
 */
function quoteWindowsArg(arg) {
  const escaped = String(arg)
    .replace(/(\\*)"/g, (_match, run) => `${run}${run}\\"`)
    .replace(/(\\+)$/, (_match, run) => `${run}${run}`);
  return `"${escaped}"`;
}

/**
 * A PowerShell single-quoted literal: nothing inside one is special except a
 * single quote, which is written twice.
 * @param {string} text
 * @returns {string}
 */
function psSingleQuote(text) {
  return `'${String(text).replace(PS_SINGLE_QUOTE_CHARS, (quote) => quote + quote)}'`;
}

/**
 * The form `powershell.exe -EncodedCommand` accepts: base64 of UTF-16LE. It
 * keeps every path out of the command line's own quoting rules.
 * @param {string} script
 * @returns {string}
 */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * The one sentence the person reads before Windows asks for permission.
 * @param {string} volume e.g. "C:"
 * @returns {string}
 */
function explanation(volume) {
  return (
    `To read the ${volume} drive's file table directly, a small helper needs administrator ` +
    `permission, read-only and for this one scan only; choose "Scan normally" to skip it.`
  );
}

/**
 * The PowerShell run hidden and unelevated; only the helper it starts is
 * elevated. Exit codes: the helper's own, DECLINED_EXIT when the Windows
 * prompt was declined, PS_FAILED_EXIT (message on stderr) for anything else.
 *
 * The decline is recognised two ways. The spec'd one: the exception, or its
 * InnerException, is a Win32Exception with NativeErrorCode 1223. And a
 * fallback, because Start-Process can rethrow that Win32Exception as an
 * InvalidOperationException that keeps only its text: the text is compared
 * with this machine's own wording of error 1223, which both come from
 * Windows, so it holds in every display language.
 * @param {{ helperPath: string, volume: string, root: string, output: string }} request
 * @param {string} workingDirectory the folder the helper starts in
 * @returns {string}
 */
function elevationScript({ helperPath, volume, root, output }, workingDirectory) {
  const argline = [volume, root, output].map(quoteWindowsArg).join(' ');
  const isCancelled = `$x -is [System.ComponentModel.Win32Exception] -and $x.NativeErrorCode -eq ${DECLINED_EXIT}`;
  const trusted = TRUSTED_OWNER_SIDS.map(psSingleQuote).join(', ');
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    // Who owns the helper and its folder, checked last thing before the start:
    // an owner outside TRUSTED_OWNER_SIDS could have changed what runs.
    `  foreach ($item in @(${psSingleQuote(helperPath)}, ${psSingleQuote(path.win32.dirname(helperPath))})) {`,
    '    $owner = (Get-Acl -LiteralPath $item).GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    `    if (@(${trusted}) -notcontains $owner) {`,
    '      [Console]::Error.WriteLine("$item is owned by $owner, not by Windows or its administrators")',
    `      exit ${OWNER_REFUSED_EXIT}`,
    '    }',
    '  }',
    `  $p = Start-Process -FilePath ${psSingleQuote(helperPath)} -ArgumentList ${psSingleQuote(argline)} -WorkingDirectory ${psSingleQuote(workingDirectory)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    // A missing exit code must never read as `exit 0`, which is success.
    "  if ($null -eq $p -or $null -eq $p.ExitCode) { throw 'Windows did not report how the helper finished' }",
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    `  foreach ($x in @($e, $e.InnerException)) { if (${isCancelled}) { exit ${DECLINED_EXIT} } }`,
    `  $cancelled = (New-Object System.ComponentModel.Win32Exception ${DECLINED_EXIT}).Message`,
    `  if ($cancelled -and "$($e.Message)".Contains($cancelled)) { exit ${DECLINED_EXIT} }`,
    '  [Console]::Error.WriteLine($e.Message)',
    `  exit ${PS_FAILED_EXIT}`,
    '}',
  ].join('\n');
}

const declined = (reason) => ({ kind: 'declined', reason });
const failed = (reason) => ({ kind: 'failed', reason });
const messageOf = (err) => (err && err.message ? err.message : String(err));

/** Why a request cannot be launched, or null when it can. Paths never contain NUL. */
function requestProblem(request) {
  if (!request || typeof request !== 'object') return 'no scan was described to the helper';
  const bad = REQUEST_FIELDS.find((key) => typeof request[key] !== 'string' || request[key] === '' || request[key].includes('\0'));
  return bad ? `the helper was given no usable ${bad}` : null;
}

/** Ask the one question. Resolves null to go ahead, or the outcome that ends here. */
async function askFirst(showMessageBox, volume) {
  let answer;
  try {
    answer = await showMessageBox({
      type: 'question',
      buttons: ['Continue', 'Scan normally'],
      defaultId: CONTINUE_BUTTON,
      cancelId: SCAN_NORMALLY_BUTTON,
      message: explanation(volume),
      noLink: true,
    });
  } catch (err) {
    return failed(`the permission question could not be shown: ${messageOf(err)}`);
  }
  const response = answer && typeof answer === 'object' ? answer.response : undefined;
  if (response === CONTINUE_BUTTON) return null;
  // Escape and the close box answer cancelId; only an explicit Continue goes on.
  if (typeof response === 'number') return declined(DIALOG_DECLINED_REASON);
  return failed('the permission question could not be shown, so nothing was started');
}

/** PowerShell's stderr, kept as bytes up to the cap and decoded once, as UTF-8. */
function collectStderr(stream) {
  const chunks = [];
  let kept = 0;
  let readError = null;
  if (stream && typeof stream.on === 'function') {
    stream.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const room = STDERR_CAP_BYTES - kept;
      if (room <= 0) return; // keep draining, so PowerShell never blocks on a full pipe
      const part = bytes.length > room ? bytes.subarray(0, room) : bytes;
      chunks.push(part);
      kept += part.length;
    });
    // A stream 'error' with no listener would crash the main process.
    stream.on('error', (err) => {
      readError = err;
    });
  }
  return () => {
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) return text;
    return readError ? `its error output could not be read (${messageOf(readError)})` : 'it gave no reason';
  };
}

function outcomeOfExit(code, signal, stderrText) {
  if (code === DECLINED_EXIT) return declined(PROMPT_DECLINED_REASON);
  if (code === PS_FAILED_EXIT) return failed(`PowerShell could not start the helper: ${stderrText()}`);
  if (code === OWNER_REFUSED_EXIT) return failed(`nothing was started as administrator: ${stderrText()}`);
  if (typeof code === 'number') return { kind: 'exited', code };
  return failed(`PowerShell was stopped (${signal || 'no exit code'}) before the helper finished`);
}

/** Run the script; resolves exactly once, and never rejects. */
function runElevated(spawn, powershell, workingDirectory, request) {
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(elevationScript(request, workingDirectory))];
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      const child = spawn(powershell, args, { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const stderrText = collectStderr(child.stderr);
      // `on`, not `once`: an 'error' emitted with no listener left would throw.
      child.on('error', (err) => settle(failed(`PowerShell could not be started: ${messageOf(err)}`)));
      // 'close' (not 'exit') fires after stderr has been read to the end.
      child.on('close', (code, signal) => settle(outcomeOfExit(code, signal, stderrText)));
    } catch (err) {
      settle(failed(`PowerShell could not be started: ${messageOf(err)}`));
    }
  });
}

/**
 * On Windows `powershell` and `workingDirectory` must be full paths and
 * `refuseTarget` a function (a TypeError otherwise): main.js passes
 * powershell.exe under the system folder the kernel reports, that folder, and
 * the check that refuses a program the user's own processes could change.
 * @param {{
 *   showMessageBox: (options: object) => Promise<{ response: number } | undefined>,
 *   spawn: Function,
 *   platform?: string,
 *   powershell?: string,
 *   workingDirectory?: string,
 *   refuseTarget?: (file: string) => string | null,
 * }} deps
 * @returns {(request: { helperPath: string, volume: string, root: string, output: string }) => Promise<object>}
 */
function createMftLauncher({ showMessageBox, spawn, platform = process.platform, powershell, workingDirectory, refuseTarget } = {}) {
  if (typeof showMessageBox !== 'function' || typeof spawn !== 'function') {
    throw new TypeError('createMftLauncher needs showMessageBox and spawn functions');
  }
  if (platform === 'win32') {
    if (typeof powershell !== 'string' || !path.win32.isAbsolute(powershell)) {
      throw new TypeError('createMftLauncher needs the full path of powershell.exe: by name, Windows would look in the app’s own folder first');
    }
    if (typeof workingDirectory !== 'string' || !path.win32.isAbsolute(workingDirectory)) {
      throw new TypeError('createMftLauncher needs the full path of the folder PowerShell and the helper start in');
    }
    if (typeof refuseTarget !== 'function') {
      throw new TypeError('createMftLauncher needs refuseTarget, the check that nothing a program running as the user could change is started as administrator');
    }
  }
  return async function launchMftHelper(request) {
    if (platform !== 'win32') {
      return failed(`reading a drive's file table directly needs Windows, and this is ${platform}`);
    }
    const problem = requestProblem(request);
    if (problem) return failed(problem);
    // Before the question: a yes that could not be used should not be asked for.
    for (const target of [powershell, request.helperPath]) {
      let why;
      try {
        why = refuseTarget(target);
      } catch (err) {
        why = `${target} could not be checked: ${messageOf(err)}`;
      }
      if (why) return failed(`nothing was started as administrator: ${why}`);
    }
    const stop = await askFirst(showMessageBox, request.volume);
    if (stop) return stop;
    return runElevated(spawn, powershell, workingDirectory, request);
  };
}

module.exports = {
  createMftLauncher,
  quoteWindowsArg,
  psSingleQuote,
  encodeCommand,
  explanation,
  DECLINED_EXIT,
  PS_FAILED_EXIT,
  OWNER_REFUSED_EXIT,
  TRUSTED_OWNER_SIDS,
};
