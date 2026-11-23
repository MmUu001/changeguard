#!/usr/bin/env node
/**
 * `changeguard-mcp` bin entry — the same stdio MCP server as `changeguard mcp`,
 * without arguments. MCP client config can point at this binary directly.
 *
 * Fatal errors go to stderr only (stdout is the protocol stream).
 */
import { runMcpServer } from './index.js';

runMcpServer().catch((err: unknown) => {
  process.stderr.write(`mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
