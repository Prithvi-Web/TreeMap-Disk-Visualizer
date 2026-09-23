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
 * Pure: no `electron` import. main.js injects dialog.showMessageBox and
 * child_process.spawn, and src/services/scan/nativeEngine.ts receives the
 * launcher through setMftLauncher, so plain Node tests
 * (tests/electronMft.test.ts) drive every branch with fakes.
 *
 * Outcome, always one of:
 *   { kind: 'exited', code }     the helper ran elevated and exited with `code`
 *   { kind: 'declined', reason } the person said no, to our dialog or to Windows
 *   { kind: 'failed', reason }   the launch itself failed; nothing ran elevated
 */

/** ERROR_CANCELLED: the Windows permission prompt was declined. */
const DECLINED_EXIT = 1223;
/** The script's own code for "PowerShell could not start the helper". */
const PS_FAILED_EXIT = 9001;
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
 * @returns {string}
 */
function elevationScript({ helperPath, volume, root, output }) {
  const argline = [volume, root, output].map(quoteWindowsArg).join(' ');
  const isCancelled = `$x -is [System.ComponentModel.Win32Exception] -and $x.NativeErrorCode -eq ${DECLINED_EXIT}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath ${psSingleQuote(helperPath)} -ArgumentList ${psSingleQuote(argline)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
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
  if (typeof code === 'number') return { kind: 'exited', code };
  return failed(`PowerShell was stopped (${signal || 'no exit code'}) before the helper finished`);
}

/** Run the script; resolves exactly once, and never rejects. */
function runElevated(spawn, powershell, request) {
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(elevationScript(request))];
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      const child = spawn(powershell, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
 * @param {{
 *   showMessageBox: (options: object) => Promise<{ response: number } | undefined>,
 *   spawn: Function,
 *   platform?: string,
 *   powershell?: string,
 * }} deps
 * @returns {(request: { helperPath: string, volume: string, root: string, output: string }) => Promise<object>}
 */
function createMftLauncher({ showMessageBox, spawn, platform = process.platform, powershell = 'powershell.exe' } = {}) {
  if (typeof showMessageBox !== 'function' || typeof spawn !== 'function') {
    throw new TypeError('createMftLauncher needs showMessageBox and spawn functions');
  }
  return async function launchMftHelper(request) {
    if (platform !== 'win32') {
      return failed(`reading a drive's file table directly needs Windows, and this is ${platform}`);
    }
    const problem = requestProblem(request);
    if (problem) return failed(problem);
    const stop = await askFirst(showMessageBox, request.volume);
    if (stop) return stop;
    return runElevated(spawn, powershell, request);
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
};
