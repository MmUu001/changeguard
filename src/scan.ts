/**
 * End-to-end deterministic scan orchestration:
 *
 *   manifests -> dependencies -> Tree-sitter call sites
 *   -> vendor change collection (offline seeds / online fetch)
 *   -> deterministic impact evaluation -> ScanReport
 *
 * No LLM calls happen here; explanation/PR drafting is a separate,
 * strictly post-hoc enrichment step (see src/llm).
 */
import { resolve, basename } from 'node:path';
import type { Dependency, Finding, ScanReport } from './types.js';
import { LocalRepoSource } from './source/repo-source.js';
import type { RepoSource } from './source/repo-source.js';
import { collectDependencies } from './deps/manifests.js';
import { analyzeRepository } from './analyze/index.js';
import { providerForPackage, PROVIDERS, type ProviderId } from './providers/registry.js';
import { collectChanges } from './ingest/store.js';
import type { FeedSourceConfig } from './ingest/feed-client.js';
import { evaluate } from './impact/engine.js';
import { enrichReport } from './llm/explanation.js';
import { logger } from './util/logger.js';

export interface ScanOptions {
  /** Local directory, or a pre-built RepoSource (e.g. a remote GitHub tree). */
  source?: RepoSource;
  repoPath?: string;
  repoName?: string;
  /** Include vendor changes dated on/after this ISO date (default: 1 year). */
  sinceISO?: string;
  /** Fetch GitHub Releases / changelog pages (default: offline curated data). */
  online?: boolean;
  /** Signed change feed; verified records replace the bundled snapshot. */
  feed?: FeedSourceConfig;
  /** Restrict ingestion to these providers; defaults to detected providers. */
  providers?: ProviderId[];
  /** Persist the report to SQLite history (default: true). */
  persist?: boolean;
  /**
   * Keep only findings anchored to a concrete file (call-site hits).
   * Repo-level advisories (R9) and dependency-level pins (R7) are excluded.
   */
  onlyMatched?: boolean;
  /** Owning tenant for billing/audit scoping (server-side triggers only). */
  tenantId?: string;
  /** Run LLM-backed explanation enrichment before persistence. Requires
   *  LLM_API_KEY in the environment; if absent it falls back to the
   *  deterministic template with no extra cost. */
  useLlm?: boolean;
}

function defaultSince(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export function annotateProviders(deps: Dependency[]): Dependency[] {
  for (const dep of deps) {
    dep.providerId = providerForPackage(dep.ecosystem, dep.name);
  }
  return deps;
}

/**
 * True only when the optional proprietary persistence module itself is absent.
 * A missing module elsewhere (inside an existing `src/store`) or an actual
 * write failure must still surface as a warning.
 */
function isOptionalStoreMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  const message = err instanceof Error ? err.message : String(err);
  return /store[/\\]sqlite(\.[jt]s)?['"]?/.test(message);
}

export async function scanRepository(opts: ScanOptions = {}): Promise<ScanReport> {
  const start = Date.now();
  const repoPath = resolve(opts.repoPath ?? process.cwd());
  const source = opts.source ?? new LocalRepoSource(opts.repoName ?? basename(repoPath), repoPath);
  const since = opts.sinceISO ?? defaultSince();

  // 1. dependencies
  const dependencies = annotateProviders(await collectDependencies(source));
  const depProviders = new Set(
    dependencies.map((d) => d.providerId).filter((x): x is ProviderId => !!x),
  );

  // 2. call sites (Tree-sitter, deterministic)
  const analysis = await analyzeRepository(source);

  const detected = new Set<ProviderId>(depProviders);
  for (const site of analysis.sites) {
    if (site.providerId) detected.add(site.providerId as ProviderId);
  }
  // Provider manifests without call sites must still be evaluated for R7/R9.
  for (const dep of dependencies) {
    if (dep.providerId) detected.add(dep.providerId as ProviderId);
  }

  // 3. vendor changes
  const known = new Set<ProviderId>(PROVIDERS.map((p) => p.id));
  const scope = (opts.providers ?? [...detected]).filter((p) => known.has(p));
  const changes = await collectChanges({
    online: opts.online ?? false,
    sinceISO: since,
    providers: scope,
    feed: opts.feed,
  });

  // 4. deterministic impact evaluation
  const findings = collapseCorroboratingHttp(
    evaluate({
      sites: analysis.sites,
      dependencies,
      changes,
    }),
  );

  // --only-matched: keep findings anchored to a concrete file (call-site
  // hits). Repo-level advisories (R9) and dependency-level pins (R7) have no
  // file and drop out of this view. Filtering happens before every count so
  // summary/artifacts stay consistent.
  const visible = opts.onlyMatched ? findings.filter((f) => Boolean(f.file)) : findings;

  const filesAffected = new Set(visible.map((f) => f.file).filter(Boolean));
  const byProvider: Record<string, number> = {};
  for (const f of visible) byProvider[f.providerId] = (byProvider[f.providerId] ?? 0) + 1;

  const report: ScanReport = {
    id: `scan-${Buffer.from(`${source.label}:${since}`).toString('base64url')}`,
    repoName: opts.repoName ?? source.label,
    repoPath,
    generatedAt: new Date().toISOString(),
    since,
    mode: opts.online ? 'online' : 'offline',
    dependencies,
    detectedProviders: [...detected].sort(),
    callSiteCount: analysis.sites.length,
    changes,
    findings: visible.sort(bySeverityThenFile),
    summary: {
      total: visible.length,
      high: visible.filter((f) => f.severity === 'high').length,
      medium: visible.filter((f) => f.severity === 'medium').length,
      low: visible.filter((f) => f.severity === 'low').length,
      filesAffected: filesAffected.size,
      byProvider,
    },
    errors: analysis.errors,
  };

  if (opts.persist !== false) {
    // Optional LLM enrichment before persistence — only when explicitly opted
    // in. enrichReport falls back to the deterministic template instantly when
    // no LLM_API_KEY is configured, so callers that don't want LLM spend are
    // unaffected and pay zero extra runtime.
    if (opts.useLlm) await enrichReport(report);
    try {
      const { saveScan } = await import('./store/sqlite.js');
      saveScan(report, Date.now() - start, opts.tenantId);
    } catch (err) {
      // Persistence is proprietary and optional: the Apache-2.0-only build
      // ships without src/store, so a missing module is expected and stays
      // silent. Any other failure is a real write error and is reported.
      if (!isOptionalStoreMissing(err)) {
        logger.warn(`failed to persist scan ${report.id}: ${(err as Error).message}`);
      }
    }
  }
  return report;
}

/**
 * When a curated/release-note record and an OpenAPI-diff record prove the same
 * raw-HTTP hit on the same file/line, keep one row (prefer the curated record,
 * which carries migration guidance). This is cross-source corroboration, not a
 * new impact decision.
 */
function collapseCorroboratingHttp(findings: Finding[]): Finding[] {
  const keep: Finding[] = [];
  const sourceRank: Record<string, number> = { 'release-note': 3, changelog: 2, 'openapi-diff': 1 };
  for (const f of findings) {
    if (f.ruleId !== 'R6') {
      keep.push(f);
      continue;
    }
    const key = `${f.providerId}:${f.file ?? ''}:${f.line ?? ''}:${f.callPath ?? ''}`;
    const idx = keep.findIndex((x) => x.ruleId === 'R6' && keyOf(x) === key);
    if (idx === -1) {
      keep.push(f);
    } else {
      const prev = keep[idx];
      const rank = (x: Finding): number => sourceRank[x.change.source] ?? 0;
      if (prev && rank(f) > rank(prev)) keep[idx] = f;
    }
  }
  return keep;
}

function keyOf(f: Finding): string {
  return `${f.providerId}:${f.file ?? ''}:${f.line ?? ''}:${f.callPath ?? ''}`;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function bySeverityThenFile(
  a: ScanReport['findings'][number],
  b: ScanReport['findings'][number],
): number {
  const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (s !== 0) return s;
  return `${a.file ?? ''}:${a.line ?? 0}:${a.id}`.localeCompare(
    `${b.file ?? ''}:${b.line ?? 0}:${b.id}`,
  );
}
