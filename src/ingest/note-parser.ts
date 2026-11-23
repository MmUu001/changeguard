/**
 * Deterministic release-note / changelog-entry parser.
 *
 * Vendor prose is converted into structured ChangeRecord candidates purely by
 * lexical rules (keyword signals, HTTP verbs + paths, backtick code spans,
 * version pins, rename patterns). Ambiguous entries are kept at low
 * confidence; the LLM never affects impact decisions.
 */
import type {
  AffectedOperation,
  ChangeKind,
  ChangeRecord,
  Confidence,
  Language,
  VersionInfo,
} from '../types.js';
import { extractRename } from './openapi-diff.js';

export interface NoteContext {
  providerId: string;
  source: 'release-note' | 'changelog';
  sourceUrl?: string;
  date: string;
  /** SDK language when the note comes from a language-specific SDK repo. */
  language?: Language;
  ecosystem?: VersionInfo['ecosystem'];
  packageName?: string;
  /** Release tag, e.g. "v17.0.0" / "2025-04". */
  tag?: string;
}

const BREAKING_PATTERNS: RegExp[] = [
  /\bbreaking change\b/i,
  /\bremoves?\b[^.]{0,60}\b(parameter|field|property|method|endpoint|operation|argument|attribute|enum)\b/i,
  /\bremoved\b[^.]{0,60}\b(parameter|field|property|method|endpoint|operation|argument|attribute|enum|support)\b/i,
  /\bno longer (?:supports?|accepts?|works?|returns?|allows?)\b/i,
  /\brenames?\b[^.]{0,60}\b(parameter|field|property|method|argument)\b/i,
  /\b(incompatible|not backward compatible|migration required)\b/i,
  /\b sunset\b/i,
  /\b(?:will be|is being|was)\s+shut\s+down\b/i,
];

const DEPRECATION_PATTERNS: RegExp[] = [
  /\bdeprecat(?:ed|es|ion)\b/i,
  /\bsunset(?:ted)?\b/i,
  /\bwill stop working\b/i,
  /\bend of life\b/i,
  /\beol\b/i,
];

const BEHAVIOR_PATTERNS: RegExp[] = [
  /\bbehavior change\b/i,
  /\bnow (?:returns?|defaults? to|behaves|treats|requires?)\b/i,
  /\bchange[sd]? (?:the )?(?:default|behavior|behaviour|semantics)\b/i,
  /\bsemantics?\b.*\bchange/i,
];

const METHOD_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:\/[A-Za-z0-9_{}.\-:]+)+)/g;
const BARE_PATH =
  /(?:^|\s)((?:\/v\d+|\/20\d{2}-\d{2}-\d{2}|\/2010-\d{2}-\d{2}|\/admin\/api)(?:\/[A-Za-z0-9_{}.\-:]+)+)/g;
const PARAM_SPAN = /`([a-z][a-z0-9_]{1,48})`/g;
const VERSION_MENTION =
  /\b(?:version|api[ _-]?version|sdk)\s*`?v?(\d{4}-\d{2}(?:-\d{2})?|\d+\.\d+(?:\.\d+)?)`?/gi;
const PARAM_DECL = /\bparameter\s+`?([a-z0-9_]+)`?/gi;

export function classify(text: string): { kind: ChangeKind; signals: string[] } {
  const signals: string[] = [];
  for (const re of BREAKING_PATTERNS)
    if (re.test(text)) signals.push(`break:${re.source.slice(0, 24)}`);
  if (signals.length) return { kind: 'breaking', signals };
  for (const re of DEPRECATION_PATTERNS)
    if (re.test(text)) signals.push(`deprecate:${re.source.slice(0, 24)}`);
  if (signals.length) return { kind: 'deprecation', signals };
  for (const re of BEHAVIOR_PATTERNS)
    if (re.test(text)) signals.push(`behavior:${re.source.slice(0, 24)}`);
  if (signals.length) return { kind: 'behavior', signals };
  return { kind: 'feature', signals: [] };
}

function operationsFromText(text: string, ctx: NoteContext): AffectedOperation[] {
  const ops: AffectedOperation[] = [];
  const seen = new Set<string>();
  const add = (o: AffectedOperation) => {
    const k = `${o.method ?? ''} ${o.pathTemplate ?? ''} ${o.scope} ${o.target ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      ops.push(o);
    }
  };

  for (const m of text.matchAll(METHOD_PATH)) {
    add({ method: m[1], pathTemplate: m[2], scope: 'operation' });
  }
  for (const m of text.matchAll(BARE_PATH)) {
    add({ method: undefined, pathTemplate: m[1], scope: 'operation' });
  }
  for (const m of text.matchAll(PARAM_DECL)) {
    add({ scope: 'parameter', target: m[1] });
  }

  // Backtick code spans that look like method chains -> SDK paths
  const chains = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)(?:\(\))?`/g)) {
    const chain = m[1]!;
    if (
      chain
        .split('.')
        .some((seg) => /^(parameter|field|method|endpoint|the|and|for|with)$/i.test(seg))
    )
      continue;
    chains.add(chain);
  }
  // `snake_case` spans near "parameter" are handled above; remaining snake spans
  // are treated as parameter names when the text is parameter-focused.
  const paramLike = /parameter|argument|field|attribute/i.test(text);
  for (const m of text.matchAll(PARAM_SPAN)) {
    const name = m[1]!;
    if (paramLike && !name.includes('.') && /[a-z]/.test(name))
      add({ scope: 'parameter', target: name });
  }

  if (chains.size > 0) {
    const sdkPaths: Partial<Record<Language, string[]>> = {};
    if (ctx.language) sdkPaths[ctx.language] = [...chains];
    const base = ops[0];
    if (base) {
      base.sdkPaths = { ...(base.sdkPaths ?? {}), ...sdkPaths };
      if (chains.size === 1) base.target = [...chains][0];
    } else {
      add({ scope: 'sdk-method', sdkPaths: Object.keys(sdkPaths).length ? sdkPaths : undefined });
    }
  }
  return ops;
}

function versionsFromText(text: string, ctx: NoteContext): VersionInfo[] {
  const out: VersionInfo[] = [];
  if (!ctx.ecosystem || !ctx.packageName) return out;
  const tag = ctx.tag?.replace(/^v/, '');
  const mentions = [...text.matchAll(VERSION_MENTION)].map((m) => m[1]!);
  const deprecated = /deprecat|sunset|end of life/i.test(text);
  const removed = /remov|no longer|sunset|shut\s*down/i.test(text);
  if (tag && /^\d+\.\d+\.\d+$/.test(tag) && (deprecated || removed)) {
    out.push({
      ecosystem: ctx.ecosystem,
      package: ctx.packageName,
      deprecatedIn: deprecated ? tag : undefined,
      removedIn: removed ? tag : undefined,
    });
  }
  for (const v of mentions) {
    out.push({
      ecosystem: ctx.ecosystem,
      package: ctx.packageName,
      deprecatedIn: deprecated ? v : undefined,
    });
  }
  return out;
}

/**
 * Titles must carry information. GitHub release entries commonly look like
 * "### v7.44.0\n- api: ...", which made the version tag the title and left
 * every finding in the report titled "v7.44.0". A title that is only a
 * version / punctuation / too short is replaced by the first substantive
 * line of the entry body.
 */
const PURE_VERSION = /^v?\d{1,4}(?:\.\d{1,3}){1,3}(?:[-+][\w.]+)?$/i;
// Date-style release names: "2026-08-25", "2025-04", "2026-09-30.endive".
const PURE_DATE = /^\d{4}-\d{2}(?:-\d{2})?(?:[.\w-]*)$/;
// Generic section headers carry no per-change information either.
const SECTION_TITLE =
  /^(?:breaking changes?|change ?type|changelog|what'?s changed|release notes?|deprecations?|new features?|bug fixes?|updates?)$/i;

function isMeaningfulTitle(candidate: string): boolean {
  const core = candidate
    .replace(/[*_`~[\]()#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (core.length < 8) return false;
  if (PURE_VERSION.test(core) || PURE_DATE.test(core)) return false;
  if (SECTION_TITLE.test(core)) return false;
  // Require some real word material (letters/digits, CJK counts as letters).
  return /[\p{L}\p{N}]{4,}/u.test(core);
}

function clampTitle(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 140) return oneLine;
  return `${oneLine.slice(0, 137)}...`;
}

function titleFrom(entry: string): string {
  const lines = entry.split(/\r?\n/);
  const first = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
  if (isMeaningfulTitle(first)) return clampTitle(first);

  for (let i = 1; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim();
    if (!raw) continue;
    const cleaned = raw
      .replace(/^[-*+]\s+/, '') // bullets
      .replace(/^\d+\.\s+/, '') // ordered lists
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown links
      .replace(/[*_`~]/g, '') // inline code / emphasis
      .trim();
    if (isMeaningfulTitle(cleaned)) return clampTitle(cleaned);
  }
  // Nothing substantive in the body — keep the original heading as-is.
  return clampTitle(first);
}

/** Parse one note entry (heading + body). */
export function parseNoteEntry(entry: string, ctx: NoteContext): ChangeRecord | undefined {
  const text = entry.trim();
  if (text.length < 12) return undefined;
  const { kind, signals } = classify(text);
  // Skip pure noise unless it carries a structured signal even when "feature".
  const ops = operationsFromText(text, ctx);
  if (kind === 'feature' && ops.length === 0) return undefined;
  const renames = extractRename(text);
  if (renames.length) signals.push('rename-token');
  const versions = versionsFromText(text, ctx);

  const body = text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
  const slug = titleFrom(entry)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 6)
    .join('-');
  const confidence: Confidence =
    kind === 'breaking' && (ops.length > 0 || renames.length > 0)
      ? 'high'
      : kind === 'breaking'
        ? 'medium'
        : ops.length > 0
          ? 'medium'
          : 'low';

  return {
    id: `${ctx.providerId}-${ctx.source}-${ctx.date}-${slug}-${hash(text)}`.slice(0, 120),
    providerId: ctx.providerId,
    kind,
    title: titleFrom(entry),
    summary: text
      .split(/\r?\n/)
      .find((l) => l.trim() && !/^#/.test(l.trim()))
      ?.trim()
      .slice(0, 300),
    body,
    source: ctx.source,
    sourceUrl: ctx.sourceUrl,
    date: ctx.date,
    operations: ops,
    renames,
    versions,
    migration: migrationHint(text),
    parserSignals: [...new Set(signals)],
    confidence,
  };
}

function migrationHint(text: string): string | undefined {
  const m = text.match(/(?:migrate|migration|instead of|use `?[A-Za-z_][\w.]*`?)[^]*?(?:\n\n|$)/i);
  return m ? m[0]!.trim().slice(0, 600) : undefined;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Split GitHub-release-style markdown (## headings or "- " bullets) into
 * candidate entries.
 */
export function splitReleaseNotes(markdown: string): string[] {
  const entries: string[] = [];
  // ## / ### heading sections
  const sections = markdown.split(/\r?\n(?=##\s+)/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^##\s+(.+)/);
    if (heading && /breaking|deprecat|changed|removed|sunset/i.test(heading[1]!)) {
      for (const bullet of splitBullets(trimmed)) entries.push(bullet);
    } else if (heading) {
      // keep high-signal bullets only
      for (const bullet of splitBullets(trimmed)) {
        if (/deprecat|remov|breaking|no longer|renamed|sunset/i.test(bullet)) entries.push(bullet);
      }
    } else {
      for (const bullet of splitBullets(trimmed)) entries.push(bullet);
    }
  }
  return entries;
}

function splitBullets(text: string): string[] {
  const bullets = text.split(/\r?\n(?=\s*(?:[-*]|\d+\.)\s+)/).map((b) => b.trim());
  return bullets.filter((b) => b.length > 12);
}
