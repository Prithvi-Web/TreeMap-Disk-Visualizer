/**
 * The single source of truth for which tools the MCP server exposes, in
 * registration order. GET /api/capabilities republishes it verbatim, and
 * buildMcpServer (./server.ts, which re-exports it) refuses to build if its
 * registrations ever disagree with it — the same one-registry discipline
 * openapi.ts's ENDPOINTS applies to routes.
 *
 * A file of its own that imports nothing (Track U, U-6): the HTTP server
 * reads this list, and importing it from ./server.ts loaded the MCP SDK and
 * zod into every boot. tests/bootModules.test.ts holds both rules.
 */
export const MCP_TOOL_NAMES = [
  'scan_path',
  'get_largest',
  'reclaim_ranked',
  'missing_gigabytes',
  'find_duplicates',
  'cleanup_suggestions',
  'forecast',
  'compare_scans',
  'offload',
  'trash_paths',
] as const;
