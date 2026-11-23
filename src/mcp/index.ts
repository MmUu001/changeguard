/**
 * MCP entry point: assemble the server and start the stdio loop.
 * Called by the `changeguard mcp` CLI command (dynamic import, so plain
 * scan/demo invocations never load this module).
 */
import { readFileSync } from 'node:fs';
import { buildTools } from './tools.js';
import { runStdioLoop } from './server.js';

/**
 * Version from package.json. `npm_package_version` only exists when launched
 * via npm scripts, so a directly-invoked bin would report "dev" otherwise.
 * Resolves from src/ and dist/ alike (both are two levels below the root).
 */
function serverVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

export async function runMcpServer(): Promise<void> {
  await runStdioLoop({
    serverName: 'changeguard',
    serverVersion: serverVersion(),
    tools: buildTools(),
  });
}
