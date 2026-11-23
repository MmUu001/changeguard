/**
 * Change ingestion facade.
 *
 *  offline (default): curated seed records + bundled OpenAPI snapshot diffs.
 *  online: additionally pulls GitHub Releases for every supported SDK and
 *          attempts vendor changelog pages; results are file-cached for 6h.
 *
 * Determinism guarantee: every record entering the impact engine has the same
 * ChangeRecord shape regardless of source; the LLM has no role in ingestion.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeRecord, Language } from '../types.js';
import { PROVIDERS, PROVIDER_BY_ID, type ProviderId } from '../providers/registry.js';
import { diffOpenApi, type OpenAPIDoc } from './openapi-diff.js';
import { fetchReleaseChanges } from './github-releases.js';
import { fetchChangelogChanges } from './changelog-html.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import {
  loadVerifiedFeed,
  type FeedLoadFailureReason,
  type FeedSourceConfig,
} from './feed-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', 'data');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface OpenApiBundleMeta {
  name: string;
  old: string;
  new: string;
  date: string;
  sourceUrl?: string;
}

export function loadBundledChanges(providerIds?: string[]): ChangeRecord[] {
  const dir = join(DATA_DIR, 'changes');
  if (!existsSync(dir)) return [];
  const out: ChangeRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const pid = file.replace('.seed.json', '.json').replace('.json', '');
    if (providerIds && !providerIds.includes(pid)) continue;
    const records = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ChangeRecord[];
    out.push(...records);
  }
  return out;
}

export function loadBundledOpenApiDiffs(providerIds?: string[]): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const provider of PROVIDERS) {
    if (providerIds && !providerIds.includes(provider.id)) continue;
    const metaFile = join(DATA_DIR, 'openapi', provider.id, 'meta.json');
    if (!existsSync(metaFile)) continue;
    const bundles = JSON.parse(readFileSync(metaFile, 'utf8')) as OpenApiBundleMeta[];
    for (const b of bundles) {
      const oldDoc = JSON.parse(
        readFileSync(join(DATA_DIR, 'openapi', provider.id, b.old), 'utf8'),
      ) as OpenAPIDoc;
      const newDoc = JSON.parse(
        readFileSync(join(DATA_DIR, 'openapi', provider.id, b.new), 'utf8'),
      ) as OpenAPIDoc;
      out.push(
        ...diffOpenApi(oldDoc, newDoc, {
          providerId: provider.id,
          date: b.date,
          sourceUrl: b.sourceUrl,
        }),
      );
    }
  }
  return out;
}

function cachePath(key: string): string {
  return join(config.cacheDir, `${key}.json`);
}

function readCache<T>(key: string): T[] | undefined {
  const file = cachePath(key);
  if (!existsSync(file)) return undefined;
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; records: T[] };
    if (Date.now() - Date.parse(payload.fetchedAt) > CACHE_TTL_MS) return undefined;
    return payload.records;
  } catch {
    return undefined;
  }
}

function writeCache<T>(key: string, records: T[]): void {
  const file = cachePath(key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), records }, null, 2));
}

export interface CollectOptions {
  online: boolean;
  sinceISO: string;
  providers?: ProviderId[];
  /**
   * Signed change feed. When present it is authoritative: verified records
   * replace the bundled snapshot; a verification failure falls back to the
   * bundled snapshot (never "treat unverified as verified").
   */
  feed?: FeedSourceConfig;
}

export async function collectChanges(opts: CollectOptions): Promise<ChangeRecord[]> {
  const ids = opts.providers?.map(String) ?? PROVIDERS.map((p) => p.id);

  if (opts.feed) {
    return collectFromFeed(opts.feed, ids, opts.sinceISO, opts.online);
  }

  const records: ChangeRecord[] = [...loadBundledChanges(ids), ...loadBundledOpenApiDiffs(ids)];

  if (!opts.online) return dedupeAndSort(records, opts.sinceISO);

  for (const id of ids) {
    const provider = PROVIDER_BY_ID.get(id as ProviderId)!;
    for (const gh of provider.sources.githubReleases) {
      const key = `gh-${gh.owner}-${gh.repo}`.replace(/[^a-z0-9_-]/gi, '_');
      let cached = readCache<ChangeRecord>(key);
      if (!cached) {
        logger.info(`fetching releases ${gh.owner}/${gh.repo}`);
        cached = await fetchReleaseChanges(
          {
            owner: gh.owner,
            repo: gh.repo,
            providerId: provider.id,
            language: gh.language,
            ecosystem: gh.ecosystem,
          },
          opts.sinceISO,
        );
        writeCache(key, cached);
      }
      records.push(...cached);
    }
    if (provider.sources.changelog) {
      const key = `html-${provider.id}`;
      let cached = readCache<ChangeRecord>(key);
      if (!cached) {
        logger.info(`fetching changelog ${provider.name}`);
        cached = await fetchChangelogChanges({
          providerId: provider.id,
          url: provider.sources.changelog.url,
          sinceISO: opts.sinceISO,
        });
        writeCache(key, cached);
      }
      records.push(...cached);
    }
  }

  return dedupeAndSort(records, opts.sinceISO);
}

async function collectFromFeed(
  feed: FeedSourceConfig,
  ids: string[],
  sinceISO: string,
  online: boolean,
): Promise<ChangeRecord[]> {
  const outcome = await loadVerifiedFeed(feed);
  if (outcome.ok) {
    logger.info(
      `signed feed verified: ${outcome.payload.records.length} records, kid=${outcome.kid}` +
        `, root=${outcome.rootKid} (${outcome.sourceKind}, keys from ${outcome.keySource}, ` +
        `generated ${outcome.payload.generatedAt})`,
    );
    if (online) {
      logger.warn('--online is ignored when a signed feed is configured');
    }
    return dedupeAndSort(
      outcome.payload.records.filter((record) => ids.includes(record.providerId)),
      sinceISO,
    );
  }

  const hint = failureHint(outcome.reason);
  logger.error(`signed feed rejected [${outcome.reason}]: ${outcome.detail}${hint}`);
  if (config.feedStrict) {
    throw new Error(
      `signed feed rejected [${outcome.reason}] and CHANGEGUARD_FEED_STRICT=1 forbids falling back; ` +
        'refusing to run with unverified or stale feed data',
    );
  }
  logger.warn(
    'falling back to the bundled offline snapshot (unsigned); no unverified feed records are used',
  );
  return dedupeAndSort([...loadBundledChanges(ids), ...loadBundledOpenApiDiffs(ids)], sinceISO);
}

function failureHint(reason: FeedLoadFailureReason): string {
  switch (reason) {
    case 'keyring':
      return ' (fix the keyring source: --trusted-keys or CHANGEGUARD_FEED_KEYS)';
    case 'keyring-unknown-root':
      return ' (the keyring was signed by a root key this CLI does not trust; root rotation requires a CLI release)';
    case 'keyring-unsigned':
      return ' (the keyring must be signed by a built-in root key)';
    case 'keyring-bad-signature':
      return ' (the keyring signature does not match its contents; re-sign it with a trusted root key)';
    case 'keyring-malformed':
      return ' (see docs/feed.md for the keyring schema)';
    case 'unknown-kid':
      return ' (the signing key is not in the trusted keyring; see docs/feed.md for rotation)';
    default:
      return '';
  }
}

function dedupeAndSort(records: ChangeRecord[], sinceISO: string): ChangeRecord[] {
  const seen = new Map<string, ChangeRecord>();
  for (const r of records) {
    if (r.date < sinceISO) continue;
    // same operation+title+date from two sources keeps the higher-confidence record
    const key = `${r.providerId}:${r.date}:${r.title.toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || confidenceRank(r.confidence) > confidenceRank(prev.confidence)) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) =>
    a.date === b.date
      ? a.providerId.localeCompare(b.providerId) || a.title.localeCompare(b.title)
      : b.date.localeCompare(a.date),
  );
}

function confidenceRank(c: ChangeRecord['confidence']): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

export type { Language };
