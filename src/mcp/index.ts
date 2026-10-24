#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server';
import { createMcpShutdown } from './mcpShutdown';

/**
 * TreeMap MCP entry point (`npm run mcp`) — stdio transport for MCP clients
 * such as Claude Desktop. Deliberately a separate, optional process: nothing
 * in server.ts, index.ts or electron/main.js imports this file, and it starts
 * no HTTP listener. It shares the service layer, so scans it runs live in
 * this process and die with it.
 *
 * All logging goes to stderr — stdout is the MCP protocol channel.
 */

/**
 * Cancel everything, then exit once a cancelled offload has rolled back and saved its record and any
 * trash_paths call has answered (bounded; hunt C58) — not in the same tick, which skipped both. Once,
 * however many signals arrive (mcpShutdown.ts).
 */
const shutdownOnce = createMcpShutdown({ exit: (code) => process.exit(code) });
const shutdown = (): void => {
  void shutdownOnce();
};

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[treemap-mcp] server ready on stdio');

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The client closing our stdin is the normal way an MCP session ends.
  process.stdin.on('close', shutdown);
}

main().catch((err: unknown) => {
  console.error('[treemap-mcp] fatal:', err);
  process.exit(1);
});
