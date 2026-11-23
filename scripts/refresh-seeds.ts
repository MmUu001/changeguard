#!/usr/bin/env node
/**
 * Seed refresh helper: pull release-note records for every provider SDK repo,
 * filter to actionable kinds, deduplicate cross-language duplicates, and
 * report which records carry match anchors (operations / renames).
 *
 *   npx tsx scripts/refresh-seeds.ts [--since 2025-01-01] [--apply]
 *
 * Records WITHOUT anchors never match a call site (the impact engine needs
 * `operations[].sdkPaths` or `renames`), so they are never written by --apply:
 * they are listed as "needs manual anchoring" instead. Anchoring a record to a
 * concrete API surface is a knowledge task, not a scraping task — this tool
 * deliberately refuses to guess.
 *
 * --apply appends anchored records to data/changes/<provider>.seed.json,
 * skipping ids that already exist. Default is a read-only dry run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS } from '../src/providers/registry.js';
import { fetchReleaseChanges } from '../src/ingest/github-releases.js';
import type { ChangeRecord } from '../src/types.js';

const ACTIONABLE = new Set(['breaking', 'deprecation', 'behavior']);
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const since = arg('--since', '2025-01-01');
const apply = process.argv.includes('--apply');

/** Same change published as N SDK releases (node/py/go) collapses to one.
 *  The leading "### vX.Y.Z - " banner differs per SDK, so strip it first. */
function dedupeKey(r: ChangeRecord): string {
  const body = (r.body ?? '')
    .replace(/^\s*#{1,3}\s*v?\d+\.\d+\.\d+\s*[-–—:]?\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 120);
  return `${r.providerId}|${r.kind}|${r.date}|${body}`;
}

/** A record only matches call sites if it carries non-empty sdkPaths or a
 *  rename — an `operations` entry without sdkPaths is metadata, not an anchor. */
const hasAnchor = (r: ChangeRecord): boolean =>
  (r.renames ?? []).length > 0 ||
  (r.operations ?? []).some((o) =>
    Object.values(o.sdkPaths ?? {}).some((paths) => Array.isArray(paths) && paths.length > 0),
  );

const collected: ChangeRecord[] = [];
for (const provider of PROVIDERS) {
  for (const src of provider.sources.githubReleases) {
    const records = await fetchReleaseChanges(
      {
        owner: src.owner,
        repo: src.repo,
        providerId: provider.id,
        language: src.language,
        ecosystem: src.ecosystem,
      },
      since,
    );
    for (const r of records) if (ACTIONABLE.has(r.kind)) collected.push(r);
  }
}

const seen = new Set<string>();
const unique: ChangeRecord[] = [];
for (const r of collected) {
  const key = dedupeKey(r);
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(r);
}

const anchored = unique.filter(hasAnchor);
const unanchored = unique.filter((r) => !hasAnchor(r));

console.log(`since ${since}: ${collected.length} actionable records -> ${unique.length} unique`);
console.log(`  anchored (matchable):   ${anchored.length}`);
console.log(`  unanchored (needs API surface + sdkPaths annotations): ${unanchored.length}`);
if (anchored.length > 0) {
  console.log('\nanchored records (write-ready):');
  for (const r of anchored) {
    const anchors = [
      ...(r.renames ?? []).map((x) => `rename ${x.from}->${x.to}`),
      ...(r.operations ?? []).map((o) =>
        `op ${o.method ?? ''} ${o.pathTemplate ?? ''}${o.target ? ' target=' + o.target : ''}`.trim(),
      ),
    ];
    console.log(
      `  [${r.providerId} ${r.date} ${r.kind}] ${r.title.slice(0, 60)} | ${anchors.join('; ')}`,
    );
  }
}
if (unanchored.length > 0) {
  console.log('\nunanchored candidates (review before anchoring):');
  for (const r of unanchored.slice(0, 20)) {
    console.log(`  [${r.providerId} ${r.date} ${r.kind}] ${r.title.slice(0, 80)}`);
  }
}

if (!apply) {
  console.log('\ndry run — pass --apply to append anchored records to data/changes/.');
} else if (anchored.length === 0) {
  console.log('\n--apply: nothing to write (no anchored records today).');
} else {
  for (const provider of PROVIDERS) {
    const mine = anchored.filter((r) => r.providerId === provider.id);
    if (mine.length === 0) continue;
    const file = join(process.cwd(), 'data', 'changes', `${provider.id}.seed.json`);
    const existing: ChangeRecord[] = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as ChangeRecord[])
      : [];
    const known = new Set(existing.map((r) => r.id));
    const added = mine.filter((r) => !known.has(r.id));
    if (added.length === 0) continue;
    writeFileSync(file, `${JSON.stringify([...existing, ...added], null, 2)}\n`);
    console.log(`applied ${provider.id}: +${added.length} records -> ${file}`);
  }
}
