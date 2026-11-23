/**
 * Best-effort deterministic extraction from vendor changelog HTML pages.
 * These pages are often JS-rendered, so results are confidence=low and the
 * bundled curated dataset + GitHub releases are the primary sources.
 */
import type { ChangeRecord, Language } from '../types.js';
import { fetchText } from '../util/http.js';
import { logger } from '../util/logger.js';
import { parseNoteEntry } from './note-parser.js';

interface ChangelogConfig {
  providerId: string;
  url: string;
  sinceISO: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:h[1-6]|li|p|div|article|section|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DATE_RE = /(20\d{2})[-/](\d{2})[-/](\d{2})/g;

export async function fetchChangelogChanges(cfg: ChangelogConfig): Promise<ChangeRecord[]> {
  let html: string;
  try {
    html = await fetchText(cfg.url, { accept: 'text/html' });
  } catch (err) {
    logger.debug(
      `changelog ${cfg.providerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const text = stripTags(html);
  const out: ChangeRecord[] = [];

  // Split into dated blocks: text following a YYYY-MM-DD marker until the next marker.
  const markers: { date: string; index: number }[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    if (m.index !== undefined) markers.push({ date: `${m[1]}-${m[2]}-${m[3]}`, index: m.index });
  }
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!;
    if (start.date < cfg.sinceISO) continue;
    const end = markers[i + 1]?.index ?? text.length;
    const block = text.slice(start.index, end).trim();
    const chunks = block
      .split(/\n(?=\s*[-•]\s+)/)
      .map((c) => c.trim())
      .filter((c) => c.length > 20);
    for (const chunk of chunks) {
      const language: Language | undefined = undefined;
      const record = parseNoteEntry(chunk, {
        providerId: cfg.providerId,
        source: 'changelog',
        sourceUrl: cfg.url,
        date: start.date,
        language,
      });
      if (record && record.kind !== 'feature') out.push(record);
    }
  }
  return out;
}
