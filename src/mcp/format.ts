/**
 * Markdown rendering for MCP tool responses.
 *
 * Agents read Markdown far better than raw JSON, so every tool returns a
 * compact Markdown document: conclusion first, then one line per finding,
 * then a provenance footer the agent can quote as its evidence.
 *
 * Kept isolated from tools.ts on purpose — output format is the thing most
 * likely to be iterated on, and changing it must never touch business logic.
 */
import type { ChangeRecord, ScanReport } from '../types.js';
import { BUILTIN_FEED_KEYRING } from '../ingest/feed-keys.js';

const MAX_LINES = 60;

function oneLine(s: string, max = 220): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function provenanceLine(): string {
  const keyring = BUILTIN_FEED_KEYRING;
  const kid = keyring?.signature?.kid ?? 'unknown';
  return `_Source: bundled snapshot · signed keyring (root ${kid}) in place · local, offline, read-only_`;
}

/** list_breaking_changes */
export function renderBreakingChanges(
  providerId: string,
  sinceLabel: string,
  changes: ChangeRecord[],
): string {
  if (changes.length === 0) {
    return [
      `**No breaking changes recorded for \`${providerId}\` since ${sinceLabel}.**`,
      '',
      'The vendor is covered; the window simply contains none. Widening `since` may find older ones.',
      '',
      provenanceLine(),
    ].join('\n');
  }
  const lines = changes.slice(0, MAX_LINES).map((c) => {
    const ops = c.operations
      .map((o) => [o.method, o.pathTemplate].filter(Boolean).join(' ') || o.target || o.scope)
      .filter(Boolean)
      .slice(0, 3)
      .join('; ');
    const mig = c.migration ? ` → migrate: ${oneLine(c.migration, 160)}` : '';
    return `- **${c.date}** ${oneLine(c.title, 140)} (\`${c.id}\`)${ops ? ` — ${ops}` : ''}${mig}`;
  });
  const more = changes.length > MAX_LINES ? `\n- … +${changes.length - MAX_LINES} more` : '';
  return [
    `## Breaking changes · ${providerId} · since ${sinceLabel}`,
    '',
    `**${changes.length} recorded breaking change(s).** Each entry is a deterministic record from the change database.`,
    '',
    ...lines,
    more,
    '',
    provenanceLine(),
  ]
    .filter(Boolean)
    .join('\n');
}

/** check_impact */
export function renderImpact(report: ScanReport): string {
  const s = report.summary;
  if (s.total === 0) {
    return [
      `**No impact found** — none of the ${report.callSiteCount} call site(s) in \`${report.repoName}\` ` +
        `match a breaking change since ${report.since}.`,
      '',
      'That means: for the providers detected, nothing in this repository calls an API that changed. ' +
        'It does not mean the repository is risk-free in general.',
      '',
      provenanceLine(),
    ].join('\n');
  }
  const lines = report.findings.slice(0, MAX_LINES).map((f) => {
    const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '_(repo-level)_';
    const cm = f.codemod ? ' `[auto-fixable]`' : '';
    return `- ${loc} — **${f.severity.toUpperCase()}** ${f.ruleId} — ${oneLine(f.reason, 170)}${cm}`;
  });
  const more =
    report.findings.length > MAX_LINES ? `\n- … +${report.findings.length - MAX_LINES} more` : '';
  return [
    `## Impact: ${report.repoName}`,
    '',
    `**${s.total} finding(s): ${s.high} high / ${s.medium} medium / ${s.low} low across ${s.filesAffected} file(s).** ` +
      `Scanned since ${report.since} (${report.mode}), ${report.callSiteCount} call site(s), providers: ${report.detectedProviders.join(', ') || 'none'}.`,
    '',
    ...lines,
    more,
    '',
    provenanceLine(),
  ]
    .filter(Boolean)
    .join('\n');
}

/** get_feed_status */
export function renderFeedStatusVerified(info: {
  kid: string;
  rootKid: string;
  records: number;
  generatedAt: string;
  sourceKind: 'file' | 'url';
  keySource: string;
}): string {
  return [
    '**Feed status: VERIFIED**',
    '',
    `- signing key: \`${info.kid}\` (kid)`,
    `- root key: \`${info.rootKid}\``,
    `- records: ${info.records}`,
    `- generated: ${info.generatedAt}`,
    `- source: ${info.sourceKind === 'url' ? 'remote signed feed' : 'local signed feed'}`,
    `- keyring: ${info.keySource}`,
    '- verdict: signature chains to a trusted root; data is authentic and may be cited.',
  ].join('\n');
}

export function renderFeedStatusRejected(reason: string, detail: string): string {
  return [
    '**Feed status: REJECTED**',
    '',
    `- reason: \`${reason}\``,
    `- detail: ${oneLine(detail, 300)}`,
    '- verdict: the feed could NOT be verified; the server fell back to the bundled snapshot.',
    '- implication: treat any answer drawn from this fallback as "bundled data", not as "verified fresh data".',
  ].join('\n');
}

export function renderFeedStatusBuiltin(records: number): string {
  const keyring = BUILTIN_FEED_KEYRING;
  const kid = keyring?.signature?.kid ?? 'unknown';
  return [
    '**Feed status: BUILTIN (bundled snapshot)**',
    '',
    '- source: package-bundled change database (offline, shipped with this release)',
    `- records: ${records} (whole bundled snapshot)`,
    `- signed keyring: in place (root ${kid})`,
    '- verdict: authentic package data (integrity protected by the signed keyring); it is not a live feed.',
    '- to use a signed external feed instead, set CHANGEGUARD_MCP_FEED to a local file path.',
  ].join('\n');
}
