/**
 * The three MCP tools — the only place that touches business logic.
 *
 * All three are READ-ONLY by contract: no persistence (persist:false), no
 * file writes, no network (online:false), no codemods. Handlers are plain
 * async functions so they can be unit-tested without stdio.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { collectChanges } from '../ingest/store.js';
import { loadVerifiedFeed } from '../ingest/feed-client.js';
import { PROVIDERS } from '../providers/registry.js';
import { scanRepository } from '../scan.js';
import { RPC_ERRORS, ToolError, type Tool, type ToolDefinition } from './protocol.js';
import {
  renderBreakingChanges,
  renderFeedStatusBuiltin,
  renderFeedStatusRejected,
  renderFeedStatusVerified,
  renderImpact,
} from './format.js';

const PROVIDER_IDS: string[] = PROVIDERS.map((p) => p.id);
const DEFAULT_SINCE_DAYS = 365;
const SCAN_TIMEOUT_MS = 30_000;

function defaultSinceISO(): string {
  return new Date(Date.now() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function sinceParam(args: Record<string, unknown>): string {
  const raw = args.since;
  if (raw === undefined) return defaultSinceISO();
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ToolError(RPC_ERRORS.invalidParams, 'since must be an ISO date string (YYYY-MM-DD)');
  }
  return raw;
}

function providerParam(args: Record<string, unknown>, required: boolean): string | undefined {
  const raw = args.provider;
  if (raw === undefined) {
    if (required) throw new ToolError(RPC_ERRORS.invalidParams, 'provider is required');
    return undefined;
  }
  if (typeof raw !== 'string' || !PROVIDER_IDS.includes(raw)) {
    throw new ToolError(
      RPC_ERRORS.invalidParams,
      `provider must be one of: ${PROVIDER_IDS.join(', ')}`,
    );
  }
  return raw;
}

/** repo_path: absolute, existing directory; optional allow-list via env. */
function repoPathParam(args: Record<string, unknown>): string {
  const raw = args.repo_path;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ToolError(RPC_ERRORS.invalidParams, 'repo_path is required (absolute path)');
  }
  if (!isAbsolute(raw)) {
    throw new ToolError(RPC_ERRORS.invalidParams, 'repo_path must be an absolute path');
  }
  const resolved = resolve(raw);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ToolError(RPC_ERRORS.invalidParams, `repo_path is not a directory: ${raw}`);
  }
  const allow = (process.env.CHANGEGUARD_MCP_ALLOWED_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
  if (
    allow.length > 0 &&
    !allow.some(
      (root) =>
        resolved === root ||
        resolved.startsWith(`${root}${'\\'}`) ||
        resolved.startsWith(`${root}/`),
    )
  ) {
    throw new ToolError(
      RPC_ERRORS.invalidParams,
      `repo_path is outside CHANGEGUARD_MCP_ALLOWED_ROOTS (${allow.join(', ')})`,
    );
  }
  return resolved;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(
      () =>
        rej(
          new ToolError(
            RPC_ERRORS.internal,
            `${label} exceeded ${ms / 1000}s; narrow the scope with a smaller repo or a later since`,
          ),
        ),
      ms,
    );
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      (e) => {
        clearTimeout(timer);
        rej(e);
      },
    );
  });
}

function define(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return { name, description, inputSchema };
}

export function buildTools(): Tool[] {
  return [
    {
      definition: define(
        'list_breaking_changes',
        'List recorded breaking API/SDK changes for one provider within a time window. ' +
          'Use before writing integration code with that vendor, or when the user asks what changed recently.',
        {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              enum: PROVIDER_IDS,
              description: 'Vendor to inspect',
            },
            since: {
              type: 'string',
              description: 'ISO date (YYYY-MM-DD); default: one year ago',
            },
          },
          required: ['provider'],
          additionalProperties: false,
        },
      ),
      handler: async (args) => {
        const provider = providerParam(args, true)!;
        const since = sinceParam(args);
        const records = await collectChanges({
          online: false,
          sinceISO: since,
          providers: [provider],
        });
        const breaking = records.filter((r) => r.kind === 'breaking');
        return renderBreakingChanges(provider, since, breaking);
      },
    },
    {
      definition: define(
        'check_impact',
        'Check whether a repository is affected by recorded breaking changes. ' +
          'Returns concrete file:line positions with rule ids and evidence. ' +
          'READ-ONLY: scans the working tree without modifying anything.',
        {
          type: 'object',
          properties: {
            repo_path: {
              type: 'string',
              description: 'Absolute path to the project root',
            },
            provider: {
              type: 'string',
              enum: PROVIDER_IDS,
              description: 'Limit the check to one vendor (default: all detected)',
            },
            since: {
              type: 'string',
              description: 'ISO date (YYYY-MM-DD); default: one year ago',
            },
          },
          required: ['repo_path'],
          additionalProperties: false,
        },
      ),
      handler: async (args) => {
        const repoPath = repoPathParam(args);
        const provider = providerParam(args, false);
        const since = sinceParam(args);
        const report = await withTimeout(
          scanRepository({
            repoPath,
            sinceISO: since,
            online: false,
            persist: false,
            onlyMatched: true,
            providers: provider ? [provider] : undefined,
          }),
          SCAN_TIMEOUT_MS,
          'scan',
        );
        return renderImpact(report);
      },
    },
    {
      definition: define(
        'get_feed_status',
        'Report the provenance and trust status of the change database this server uses: ' +
          'whether the data is a verified signed feed or the bundled offline snapshot. ' +
          'Call this before citing any answer as authoritative.',
        {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      ),
      handler: async () => {
        const feedPath = (process.env.CHANGEGUARD_MCP_FEED ?? '').trim();
        if (feedPath) {
          const outcome = await loadVerifiedFeed({
            path: feedPath,
            trustedKeys: process.env.CHANGEGUARD_FEED_KEYS,
          });
          if (outcome.ok) {
            return renderFeedStatusVerified({
              kid: outcome.kid,
              rootKid: outcome.rootKid,
              records: outcome.payload.records.length,
              generatedAt: outcome.payload.generatedAt,
              sourceKind: outcome.sourceKind,
              keySource: outcome.keySource,
            });
          }
          return renderFeedStatusRejected(outcome.reason, outcome.detail);
        }
        // Count the whole bundled database, not a time window — a windowed
        // count reads as "0 records" whenever the curated snapshot predates it.
        const all = await collectChanges({ online: false, sinceISO: '2000-01-01' });
        return renderFeedStatusBuiltin(all.length);
      },
    },
  ];
}
