import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { emptyTrashCommands } from "../src/services/trash";
import {
  terminalCommands,
  windowsRecycleScriptPath,
} from "../src/services/cleaner";

/**
 * Empty Trash and Open Terminal Here both shell out per platform. These tests
 * pin the exact argv arrays chosen for each process.platform WITHOUT executing
 * anything — the security property being guarded is that every command is an
 * execFile argv array and the user's path only ever travels as data, never as
 * shell text it could escape from.
 */

/* ---------------- emptyTrashCommands ---------------- */

test("empty trash on macOS goes through Finder via osascript", () => {
  assert.deepEqual(emptyTrashCommands("darwin"), [
    {
      cmd: "osascript",
      args: ["-e", 'tell application "Finder" to empty trash'],
    },
  ]);
});

test("empty trash on Windows uses Clear-RecycleBin with hard error semantics", () => {
  assert.deepEqual(emptyTrashCommands("win32"), [
    {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Clear-RecycleBin -Force -ErrorAction Stop",
      ],
    },
  ]);
});

test("Windows per-path trash uses SHFileOperation helper script (not VB FileSystem)", () => {
  const script = windowsRecycleScriptPath();
  assert.ok(fs.existsSync(script), `missing ${script}`);
  const src = fs.readFileSync(script, "utf8");
  assert.match(src, /SHFileOperation/);
  assert.match(src, /FOF_ALLOWUNDO/);
  assert.match(src, /TreemapRecycle/);
  assert.match(
    fs.readFileSync(
      new URL("../src/services/cleaner.ts", import.meta.url),
      "utf8",
    ),
    /windowsRecycleScriptPath\(\)/,
  );
});

test("empty trash on Linux prefers gio; the dir-clearing fallback is separate", () => {
  assert.deepEqual(emptyTrashCommands("linux"), [
    { cmd: "gio", args: ["trash", "--empty"] },
  ]);
});

/* ---------------- terminalCommands ---------------- */

// A path chosen to break out of anything that treats it as shell text.
const HOSTILE = "/tmp/we ird$(rm -rf ~)`touch pwned`\"q\" 's'";

test("macOS terminal: osascript primary with escaped AppleScript, open -a fallback", () => {
  const cmds = terminalCommands(HOSTILE, "darwin");
  assert.equal(cmds.length, 2);

  const [osa, fallback] = cmds;
  assert.equal(osa.cmd, "osascript");
  assert.equal(osa.args[0], "-e");
  const script = osa.args[1];
  // The path rides inside an AppleScript string literal handed to
  // `quoted form of` — the shell never parses it directly.
  assert.match(script, /do script "cd " & quoted form of "/);
  // Literal double quotes in the path must be AppleScript-escaped.
  assert.ok(script.includes('\\"q\\"'));
  // $(…) and backticks stay inert data inside the literal.
  assert.ok(script.includes("$(rm -rf ~)"));
  assert.match(script, /^tell application "Terminal"\n/);
  assert.match(script, /\nactivate\nend tell$/);

  assert.deepEqual(fallback, {
    cmd: "open",
    args: ["-a", "Terminal", HOSTILE],
  });
});

test("Windows terminal: wt.exe first, cmd.exe start fallback, path as its own argv entry", () => {
  assert.deepEqual(terminalCommands(HOSTILE, "win32"), [
    { cmd: "wt.exe", args: ["-d", HOSTILE] },
    { cmd: "cmd.exe", args: ["/c", "start", "", "/D", HOSTILE, "cmd.exe"] },
  ]);
});

test("Linux terminal: emulators in preference order with their working-dir flags", () => {
  const cmds = terminalCommands(HOSTILE, "linux");
  assert.deepEqual(
    cmds.map((c) => c.cmd),
    ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"],
  );
  assert.deepEqual(cmds[0].args, [`--working-directory=${HOSTILE}`]);
  assert.deepEqual(cmds[1].args, [`--working-directory=${HOSTILE}`]);
  assert.deepEqual(cmds[2].args, ["--workdir", HOSTILE]);
  // xterm has no working-dir flag: a FIXED sh script reads the target from $1,
  // so the hostile path is never interpolated into shell text.
  assert.deepEqual(cmds[3].args, [
    "-e",
    "sh",
    "-c",
    'cd "$1" && exec "${SHELL:-sh}"',
    "sh",
    HOSTILE,
  ]);
});

test("every candidate on every platform carries the path only as argv data", () => {
  for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
    for (const { cmd, args } of terminalCommands(HOSTILE, platform)) {
      assert.equal(typeof cmd, "string");
      assert.ok(Array.isArray(args));
      if (cmd === "osascript") continue; // path is inside the escaped literal, asserted above
      // The path appears verbatim as (or inside) exactly one argv element.
      const carriers = args.filter((a) => a === HOSTILE || a.endsWith(HOSTILE));
      assert.equal(
        carriers.length,
        1,
        `${platform}/${cmd} should carry the dir in one argv entry`,
      );
    }
  }
});
