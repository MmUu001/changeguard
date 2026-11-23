/**
 * MCP protocol layer tests (skeleton epoch).
 *
 * Spawns the real CLI in `mcp` mode over a clean UTF-8 pipe and asserts the
 * legacy handshake contract: initialize / notifications / tools/list, the
 * three negative paths (unknown method, unknown tool, malformed JSON), that
 * notifications never get a reply, that a BOM on the first line is tolerated,
 * and — the hard rule — that stdout carries protocol frames only.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { buildTools } from '../src/mcp/tools.js';

interface RunResult {
  lines: unknown[];
  stderr: string;
}

function runMcp(messages: Array<Record<string, unknown> | string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'mcp'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const raw = stdout.trim();
      const lines: unknown[] = [];
      for (const line of raw ? raw.split('\n') : []) {
        try {
          lines.push(JSON.parse(line) as unknown);
        } catch {
          lines.push({ __bad_json__: line.slice(0, 120) });
        }
      }
      resolve({ lines, stderr });
    });
    for (const m of messages) {
      child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
    }
    child.stdin.end();
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

describe('MCP protocol (legacy handshake)', () => {
  it('answers initialize with protocolVersion, tools capability and serverInfo', async () => {
    const { lines } = await runMcp([initialize]);
    expect(lines).toHaveLength(1);
    const res = lines[0] as {
      id: number;
      result: {
        protocolVersion: string;
        capabilities: { tools: object };
        serverInfo: { name: string };
      };
    };
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo.name).toBe('changeguard');
  });

  it('does not reply to notifications', async () => {
    const { lines } = await runMcp([
      initialize,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(lines).toHaveLength(1); // only the initialize reply
  });

  it('lists tools (empty in the skeleton epoch) and keeps stdout clean', async () => {
    const { lines } = await runMcp([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(lines).toHaveLength(2);
    const list = lines[1] as { id: number; result: { tools: unknown[] } };
    expect(list.id).toBe(2);
    expect(Array.isArray(list.result.tools)).toBe(true);
    // The hard rule: every line parses as JSON (no log leakage into stdout).
    expect(lines.every((l) => !(l as { __bad_json__?: string }).__bad_json__)).toBe(true);
  });

  it('returns -32601 for an unknown method', async () => {
    const { lines } = await runMcp([{ jsonrpc: '2.0', id: 5, method: 'nope/method' }]);
    const res = lines[0] as { id: number; error: { code: number } };
    expect(res.id).toBe(5);
    expect(res.error.code).toBe(-32601);
  });

  it('returns -32602 for an unknown tool', async () => {
    const { lines } = await runMcp([
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing', arguments: {} } },
    ]);
    const res = lines[0] as { id: number; error: { code: number; message: string } };
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain('unknown tool');
  });

  it('returns -32700 for malformed JSON without dying', async () => {
    const { lines } = await runMcp([
      'this is not json',
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    ]);
    const err = lines[0] as { id: null; error: { code: number } };
    expect(err.error.code).toBe(-32700);
    // Loop survives: the follow-up request still answers.
    expect((lines[1] as { id: number }).id).toBe(7);
  });

  it('tolerates a BOM on the first line', async () => {
    const { lines } = await runMcp([`\uFEFF${JSON.stringify(initialize)}`]);
    const res = lines[0] as { id: number; result?: unknown };
    expect(res.result).toBeDefined();
    expect(res.id).toBe(1);
  });
});

// ---------------- tool layer (no stdio) ----------------

describe('MCP tools', () => {
  const tools = buildTools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  it('exposes exactly the three contract tools', () => {
    expect(tools.map((t) => t.definition.name).sort()).toEqual([
      'check_impact',
      'get_feed_status',
      'list_breaking_changes',
    ]);
  });

  it('list_breaking_changes returns Markdown with dated breaking entries', async () => {
    const out = await byName.get('list_breaking_changes')!.handler({
      provider: 'stripe',
      since: '2020-01-01',
    });
    expect(out).toContain('Breaking changes');
    expect(out).toContain('Legacy Charges');
    expect(out).toContain('bundled snapshot');
  });

  it('check_impact finds the fixture findings with file:line positions', async () => {
    const repo = `${process.cwd()}/fixtures/sample-repo`.replace(/\\/g, '/');
    const out = await byName.get('check_impact')!.handler({
      repo_path: repo,
      since: '2020-01-01',
    });
    expect(out).toContain('finding');
    expect(out).toContain('high');
    expect(out).toMatch(/src\/billing\.ts|services\/ai\.py|cmd\/billing\/main\.go/);
  });

  it('check_impact rejects a relative repo_path with -32602', async () => {
    await expect(
      byName.get('check_impact')!.handler({ repo_path: 'fixtures/sample-repo' }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('check_impact rejects a missing directory with -32602', async () => {
    await expect(
      byName.get('check_impact')!.handler({ repo_path: 'C:/definitely/not/here' }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects an unknown provider with -32602', async () => {
    await expect(
      byName.get('list_breaking_changes')!.handler({ provider: 'nope' }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('get_feed_status reports the bundled snapshot when no feed is configured', async () => {
    const prev = process.env.CHANGEGUARD_MCP_FEED;
    delete process.env.CHANGEGUARD_MCP_FEED;
    try {
      const out = await byName.get('get_feed_status')!.handler({});
      expect(out).toContain('BUILTIN');
      expect(out).toContain('signed keyring');
    } finally {
      if (prev !== undefined) process.env.CHANGEGUARD_MCP_FEED = prev;
    }
  });
});

describe('MCP end-to-end over stdio', () => {
  it('tools/list returns three tools and tools/call reaches check_impact', async () => {
    const repo = `${process.cwd()}/fixtures/sample-repo`.replace(/\\/g, '/');
    const { lines } = await runMcp([
      initialize,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 10, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'check_impact', arguments: { repo_path: repo, since: '2020-01-01' } },
      },
    ]);
    expect(lines).toHaveLength(3); // initialize + list + call
    const list = lines[1] as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([
      'check_impact',
      'get_feed_status',
      'list_breaking_changes',
    ]);
    const call = lines[2] as { result: { content: Array<{ type: string; text: string }> } };
    expect(call.result.content[0]!.type).toBe('text');
    expect(call.result.content[0]!.text).toContain('Impact:');
  });
});
