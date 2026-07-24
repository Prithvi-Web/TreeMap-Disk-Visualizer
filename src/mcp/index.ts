#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server';
import { cancelAllScans } from '../services/diskScanner';
import { cancelAllDuplicateJobs } from '../services/duplicateFinder';
import { cancelAllOffloadJobs } from '../services/offload';

/**
 * TreeMap MCP entry point (`npm run mcp`) — stdio transport for MCP clients
 * such as Claude Desktop. Deliberately a separate, optional process: nothing
 * in server.ts, index.ts or electron/main.js imports this file, and it starts
 * no HTTP listener. It shares the service layer, so scans it runs live in
 * this process and die with it.
 *
 * All logging goes to stderr — stdout is the MCP protocol channel.
 */

function shutdown(): void {
  cancelAllScans();
  cancelAllDuplicateJobs();
  cancelAllOffloadJobs();
  process.exit(0);
}

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
