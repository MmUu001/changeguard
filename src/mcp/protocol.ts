/**
 * MCP protocol constants — the single source of truth.
 *
 * We implement the LEGACY (handshake) era first: every current client
 * (Claude Code 2.1.292, the official SDK, Cursor, VS Code, Cline) probes
 * `server/discover` first and falls back to `initialize`, so a legacy server
 * is reachable by all of them (verified against the official client matrix,
 * 2026-10). The 2026-07-28 stateless era becomes a follow-up inside this
 * same file.
 */
export const PROTOCOL_VERSION = '2025-06-18';

export const METHODS = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  toolsList: 'tools/list',
  toolsCall: 'tools/call',
} as const;

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * A tool-level failure with an explicit JSON-RPC code, so the server can
 * answer -32602 (bad params) rather than the generic -32603.
 */
export class ToolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
