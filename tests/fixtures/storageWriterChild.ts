/*
 * A second TreeMap process saving one app-data file (FG3g review F2.5), as the MCP server beside the
 * app does. In `chunked` mode (the default) it begins a chunked save of `name`, prints HALF once its
 * first chunk is written, waits for a line on stdin, writes the rest and prints DONE — or ERR with the
 * reason. In `json` mode (FG3g review F3.5) it saves `first + rest`, parsed, with writeJsonFile, and is
 * held the same way between writing its temp file and renaming it into place. The parent
 * (tests/storageChunked.test.ts) saves the same file in between.
 *
 * argv: <dataDir> <name> <first chunk> <rest> [chunked|json]
 */
import fs from 'node:fs';
import readline from 'node:readline';

const [dataDir, name, first, rest, mode = 'chunked'] = process.argv.slice(2);
if (!dataDir || !name || first === undefined || rest === undefined || (mode !== 'chunked' && mode !== 'json')) {
  console.error('usage: storageWriterChild.ts <dataDir> <name> <first> <rest> [chunked|json]');
  process.exit(2);
}
process.env.TREEMAP_DATA_DIR = dataDir;

// Required after the environment is set: the module reads it when it writes.
/* eslint-disable @typescript-eslint/no-require-imports */
const { writeFileChunked, writeJsonFile } = require('../../src/services/storage') as typeof import('../../src/services/storage');
/* eslint-enable @typescript-eslint/no-require-imports */

const input = readline.createInterface({ input: process.stdin });
const go = new Promise<void>((resolve) => { input.once('line', () => resolve()); });

/** Holds the first rename this process makes — writeJsonFile's, of its whole temp file — until GO. */
function holdFirstRename(): void {
  const realRename = fs.promises.rename;
  let held = false;
  (fs.promises as { rename: unknown }).rename = async (from: fs.PathLike, to: fs.PathLike): Promise<void> => {
    if (!held) {
      held = true;
      process.stdout.write('HALF\n');
      await go;
    }
    return realRename(from, to);
  };
}

function save(): Promise<unknown> {
  if (mode === 'json') {
    holdFirstRename();
    return writeJsonFile(name, JSON.parse(first + rest) as unknown);
  }
  return writeFileChunked(name, async (write) => {
    await write(first);
    process.stdout.write('HALF\n');
    await go;
    await write(rest);
    return true;
  });
}

save().then(
  () => {
    process.stdout.write('DONE\n');
    input.close();
  },
  (err: unknown) => {
    process.stdout.write(`ERR ${err instanceof Error ? err.message : String(err)}\n`);
    input.close();
    process.exitCode = 1;
  },
);
