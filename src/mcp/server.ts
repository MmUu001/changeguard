/**
 * MCP stdio server loop (legacy handshake era).
 *
 * Transport: one JSON-RPC message per line on stdin, replies as single-line
 * JSON on stdout. The single hard rule: stdout carries protocol frames ONLY —
 * every diagnostic goes to stderr, or the connection dies (the most common
 * MCP server failure mode).
 */
import { createInterface } from 'node:readline';
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  ToolError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Tool,
} from './protocol.js';

/**
 * stderr-only diagnostics. The project logger writes to stdout by design,
 * which would corrupt the protocol stream — never use it here.
 */
function diag(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface McpServerOptions {
  serverName: string;
  serverVersion: string;
  tools: Tool[];
}

function writeFrame(frame: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorFrame(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function runStdioLoop(options: McpServerOptions): Promise<void> {
  const toolsByName = new Map(options.tools.map((t) => [t.definition.name, t]));

  const handleMessage = async (line: string): Promise<void> => {
    let req: JsonRpcRequest;
    try {
      // Some pipes prepend a BOM on the first line (PowerShell especially);
      // strip it so a stray U+FEFF cannot kill the handshake.
      req = JSON.parse(line.replace(/^\uFEFF/, '')) as JsonRpcRequest;
    } catch {
      writeFrame(errorFrame(null, RPC_ERRORS.parse, 'parse error'));
      return;
    }
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      writeFrame(errorFrame(req?.id ?? null, RPC_ERRORS.invalidRequest, 'invalid request'));
      return;
    }

    // Notifications (no id) never get a reply.
    if (req.id === undefined) {
      // notifications/initialized and anything else: nothing to do.
      return;
    }

    const id = req.id;

    if (req.method === METHODS.initialize) {
      writeFrame({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: options.serverName, version: options.serverVersion },
        },
      });
      return;
    }

    if (req.method === METHODS.toolsList) {
      writeFrame({
        jsonrpc: '2.0',
        id,
        result: { tools: options.tools.map((t) => t.definition) },
      });
      return;
    }

    if (req.method === METHODS.toolsCall) {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = toolsByName.get(name);
      if (!tool) {
        writeFrame(
          errorFrame(id, RPC_ERRORS.invalidParams, `unknown tool: ${name || '(missing)'}`),
        );
        return;
      }
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const text = await tool.handler(args);
        writeFrame({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }] },
        });
      } catch (err) {
        // Tool failures are reported in-band with a structured error frame;
        // the loop stays alive so the agent can recover or retry. A ToolError
        // carries its own JSON-RPC code (-32602 for bad parameters).
        const code = err instanceof ToolError ? err.code : RPC_ERRORS.internal;
        writeFrame(
          errorFrame(id, code, err instanceof Error ? err.message : 'tool execution failed'),
        );
      }
      return;
    }

    writeFrame(errorFrame(id, RPC_ERRORS.methodNotFound, `method not found: ${req.method}`));
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      await handleMessage(line);
    } catch (err) {
      // Last-resort guard: never let an exception escape the loop.
      diag(`mcp loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  diag('mcp: stdin closed, shutting down');
}
