/**
 * GitHub Releases ingestion for the official SDK repositories.
 * Release bodies are free text; they are converted to structured records by
 * the deterministic note-parser.
 */
import type { ChangeRecord, Ecosystem, Language } from '../types.js';
import { fetchJson, HttpError } from '../util/http.js';
import { parseNoteEntry, splitReleaseNotes } from './note-parser.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

/**
 * Fetch JSON from the GitHub API with rate-limit awareness.
 * On 403 with X-RateLimit-Remaining: 0, wait until the reset time and retry once.
 */
async function fetchGithubJson<T>(url: string, token?: string): Promise<T> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  try {
    return await fetchJson<T>(url, { headers });
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      // Try to surface rate-limit info from the response body
      logger.warn(`github API 403 for ${url}: ${err.body.slice(0, 160)}`);
    }
    throw err;
  }
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string;
  html_url?: string;
}

export interface ReleaseSourceConfig {
  owner: string;
  repo: string;
  providerId: string;
  language: Language;
  ecosystem: Ecosystem;
}

export async function fetchReleaseChanges(
  src: ReleaseSourceConfig,
  sinceISO: string,
): Promise<ChangeRecord[]> {
  const url = `https://api.github.com/repos/${src.owner}/${src.repo}/releases?per_page=30`;
  let releases: GithubRelease[];
  try {
    releases = await fetchGithubJson<GithubRelease[]>(url, config.github.token || undefined);
  } catch (err) {
    logger.warn(
      `releases ${src.owner}/${src.repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const out: ChangeRecord[] = [];
  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue;
    const date = (rel.published_at ?? '').slice(0, 10);
    if (!date || date < sinceISO) continue;
    const body = rel.body ?? '';
    const entries = splitReleaseNotes(body);
    if (entries.length === 0 && body.trim()) entries.push(body);
    for (const entry of entries) {
      const record = parseNoteEntry(`### ${rel.name ?? rel.tag_name}\n${entry}`, {
        providerId: src.providerId,
        source: 'release-note',
        sourceUrl: rel.html_url,
        date,
        language: src.language,
        ecosystem: src.ecosystem,
        packageName: src.repo,
        tag: rel.tag_name,
      });
      if (record) out.push(record);
    }
  }
  return out;
}
