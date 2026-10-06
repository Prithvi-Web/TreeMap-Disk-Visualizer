/*
 * A second TreeMap process saving one app-data file (FG3g review F2.5), as the MCP server beside the
 * app does: it begins a chunked save of `name`, prints HALF once its first chunk is written, waits
 * for a line on stdin, writes the rest and prints DONE — or ERR with the reason. The parent
 * (tests/storageChunked.test.ts) saves the same file in between.
 *
 * argv: <dataDir> <name> <first chunk> <rest>
 */
import readline from 'node:readline';

const [dataDir, name, first, rest] = process.argv.slice(2);
if (!dataDir || !name || first === undefined || rest === undefined) {
  console.error('usage: storageWriterChild.ts <dataDir> <name> <first> <rest>');
  process.exit(2);
}
process.env.TREEMAP_DATA_DIR = dataDir;

// Required after the environment is set: the module reads it when it writes.
/* eslint-disable @typescript-eslint/no-require-imports */
const { writeFileChunked } = require('../../src/services/storage') as typeof import('../../src/services/storage');
/* eslint-enable @typescript-eslint/no-require-imports */

const input = readline.createInterface({ input: process.stdin });
const go = new Promise<void>((resolve) => { input.once('line', () => resolve()); });

writeFileChunked(name, async (write) => {
  await write(first);
  process.stdout.write('HALF\n');
  await go;
  await write(rest);
  return true;
}).then(
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
