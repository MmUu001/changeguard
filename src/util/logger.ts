/**
 * Logger: human-readable by default, JSON lines with CHANGEGUARD_LOG_FORMAT=json.
 *
 * JSON lines are the machine format for deployed servers (log collectors,
 * indexing). Every line made inside an HTTP request carries the request's
 * context (requestId, and once known tenantId/actor/method/path) via
 * AsyncLocalStorage — no call site passes anything explicitly.
 *
 * CHANGEGUARD_LOG=debug lowers the threshold. Colors apply to the human
 * format only; JSON output is ANSI-free by construction.
 */
import { currentRequestContext } from './request-context.js';

const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold: Level = process.env.CHANGEGUARD_LOG === 'debug' ? 'debug' : 'info';

/** True when structured (one JSON object per line) output is enabled. */
export function isJsonLogFormat(): boolean {
  const v = (process.env.CHANGEGUARD_LOG_FORMAT ?? '').trim().toLowerCase();
  return v === 'json' || v === 'jsonl';
}

function log(level: Level, color: string, args: unknown[]): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const stream = level === 'error' ? process.stderr : process.stdout;
  const msg = args.map(String).join(' ');

  if (isJsonLogFormat()) {
    const ctx = currentRequestContext();
    const line: Record<string, unknown> = { t: ts, level, msg };
    if (ctx) {
      line.requestId = ctx.requestId;
      if (ctx.tenantId) line.tenantId = ctx.tenantId;
      if (ctx.actor) line.actor = ctx.actor;
      if (ctx.method) line.method = ctx.method;
      if (ctx.path) line.path = ctx.path;
    }
    stream.write(`${JSON.stringify(line)}\n`);
    return;
  }

  const tag = level.toUpperCase().padEnd(5);
  stream.write(`${colors.dim}${ts}${colors.reset} ${color}${tag}${colors.reset} ${msg}\n`);
}

export const logger = {
  debug: (...a: unknown[]) => log('debug', colors.gray, a),
  info: (...a: unknown[]) => log('info', colors.cyan, a),
  warn: (...a: unknown[]) => log('warn', colors.yellow, a),
  error: (...a: unknown[]) => log('error', colors.red, a),
  success: (...a: unknown[]) => log('info', colors.green, a),
};
