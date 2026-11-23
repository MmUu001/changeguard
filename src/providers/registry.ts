/**
 * Provider registry.
 *
 * Vendors are pure data: each provider is a JSON manifest in
 * `data/providers/<id>.json`, loaded and strictly validated at startup.
 * Adding a vendor is therefore a data change — a new manifest (plus optional
 * `data/changes/<id>.seed.json` records for offline mode) — with no code
 * changes. Malformed manifests fail fast at import time; the error names the
 * offending file and field.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ecosystem, Language } from '../types.js';
import type { AnalyzerIndex, HostRule, LanguageRule } from '../analyze/rules.js';

/**
 * Provider ids are open strings so new manifests need no type change.
 * `string & {}` keeps autocomplete for built-ins without closing the union.
 */
export type ProviderId = string & {};

export interface GithubReleaseSource {
  ecosystem: Ecosystem;
  language: Language;
  owner: string;
  repo: string;
}

export interface ChangelogSource {
  url: string;
  /** html = vendor page parsed with section heuristics; github = handled by releases API. */
  kind: 'html' | 'atom';
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  website: string;
  packages: Partial<Record<Ecosystem, string[]>>;
  /** REST host suffixes used to identify raw HTTP calls. */
  hosts: string[];
  /**
   * Bindings that act as factories/constructors. `const x = makeX(...)` or
   * `new X()` transitively binds x to the provider even when aliased.
   */
  factories: Partial<Record<Language, string[]>>;
  sources: {
    changelog?: ChangelogSource;
    githubReleases: GithubReleaseSource[];
    openapiSpecs?: { name: string; url?: string; bundled?: string }[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDER_DIR = join(HERE, '..', '..', 'data', 'providers');

const ECOSYSTEMS: ReadonlySet<string> = new Set<Ecosystem>(['npm', 'pypi', 'go']);
const LANGUAGES: ReadonlySet<string> = new Set<Language>(['javascript', 'python', 'go']);
const CHANGELOG_KINDS: ReadonlySet<string> = new Set(['html', 'atom']);

function fail(source: string, message: string): never {
  throw new Error(`provider manifest ${source}: ${message}`);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural validation of one manifest; returns the normalized config. */
export function validateProviderManifest(raw: unknown, source = 'manifest'): ProviderConfig {
  if (!isRecord(raw)) fail(source, 'expected a JSON object');
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(raw.id)) {
    fail(source, 'id must be a lowercase slug (a-z0-9, starting alphanumeric)');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim())
    fail(source, 'name must be a non-empty string');
  if (typeof raw.website !== 'string' || !raw.website.trim()) {
    fail(source, 'website must be a non-empty string');
  }

  if (!isRecord(raw.packages)) fail(source, 'packages must be an object');
  const pkgEntries = Object.entries(raw.packages);
  if (pkgEntries.length === 0) fail(source, 'packages must declare at least one ecosystem');
  for (const [eco, list] of pkgEntries) {
    if (!ECOSYSTEMS.has(eco)) fail(source, `unsupported ecosystem "${eco}" (npm|pypi|go)`);
    if (!isStringArray(list) || list.length === 0) {
      fail(source, `packages.${eco} must be a non-empty string[]`);
    }
  }

  if (raw.hosts !== undefined && !isStringArray(raw.hosts))
    fail(source, 'hosts must be a string[]');
  if (raw.factories !== undefined) {
    if (!isRecord(raw.factories)) fail(source, 'factories must be an object');
    for (const [lang, list] of Object.entries(raw.factories)) {
      if (!LANGUAGES.has(lang))
        fail(source, `unsupported factory language "${lang}" (javascript|python|go)`);
      if (!isStringArray(list)) fail(source, `factories.${lang} must be a string[]`);
    }
  }

  if (!isRecord(raw.sources)) fail(source, 'sources must be an object');
  const sources = raw.sources;
  if (!Array.isArray(sources.githubReleases)) {
    fail(source, 'sources.githubReleases must be an array (may be empty)');
  }
  sources.githubReleases.forEach((rel, i) => {
    if (!isRecord(rel)) fail(source, `sources.githubReleases[${i}] must be an object`);
    if (!ECOSYSTEMS.has(String(rel.ecosystem))) {
      fail(source, `sources.githubReleases[${i}].ecosystem must be npm|pypi|go`);
    }
    if (!LANGUAGES.has(String(rel.language))) {
      fail(source, `sources.githubReleases[${i}].language must be javascript|python|go`);
    }
    if (typeof rel.owner !== 'string' || !rel.owner)
      fail(source, `sources.githubReleases[${i}].owner required`);
    if (typeof rel.repo !== 'string' || !rel.repo)
      fail(source, `sources.githubReleases[${i}].repo required`);
  });
  if (sources.changelog !== undefined) {
    const c = sources.changelog;
    if (!isRecord(c)) fail(source, 'sources.changelog must be an object');
    if (typeof c.url !== 'string' || !c.url) fail(source, 'sources.changelog.url required');
    if (!CHANGELOG_KINDS.has(String(c.kind)))
      fail(source, 'sources.changelog.kind must be html|atom');
  }
  if (sources.openapiSpecs !== undefined) {
    if (!Array.isArray(sources.openapiSpecs)) fail(source, 'sources.openapiSpecs must be an array');
    sources.openapiSpecs.forEach((spec, i) => {
      if (!isRecord(spec) || typeof spec.name !== 'string' || !spec.name) {
        fail(source, `sources.openapiSpecs[${i}] must be an object with a name`);
      }
    });
  }

  return {
    id: raw.id,
    name: raw.name,
    website: raw.website,
    packages: raw.packages as ProviderConfig['packages'],
    hosts: (raw.hosts as string[] | undefined) ?? [],
    factories: (raw.factories as ProviderConfig['factories'] | undefined) ?? {},
    sources: sources as unknown as ProviderConfig['sources'],
  };
}

/**
 * Load and validate every `*.json` manifest in `dir` (defaults to
 * `data/providers`). Files are processed in name order; the file stem must
 * equal the manifest id, and ids must be unique. Throws with the file name
 * and field on any defect (fail-fast — a typo must not silently disable a
 * vendor).
 */
export function loadProviderManifests(dir: string = DEFAULT_PROVIDER_DIR): ProviderConfig[] {
  if (!existsSync(dir)) {
    throw new Error(
      `provider manifest directory missing: ${dir} — the package must ship data/providers/*.json`,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`no provider manifests found in ${dir}`);

  const providers: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      fail(file, `not valid JSON: ${(err as Error).message}`);
    }
    const provider = validateProviderManifest(raw, file);
    const stem = file.replace(/\.json$/, '');
    if (provider.id !== stem)
      fail(file, `file stem "${stem}" must equal provider id "${provider.id}"`);
    if (seen.has(provider.id)) fail(file, `duplicate provider id "${provider.id}"`);
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

export const PROVIDERS: ProviderConfig[] = loadProviderManifests();

export const PROVIDER_BY_ID = new Map<ProviderId, ProviderConfig>(PROVIDERS.map((p) => [p.id, p]));

export function providerForPackage(
  ecosystem: Ecosystem,
  name: string,
  providers: ProviderConfig[] = PROVIDERS,
): ProviderId | undefined {
  const needle = name.toLowerCase();
  for (const p of providers) {
    const list = p.packages[ecosystem];
    if (!list) continue;
    // Compare case-insensitively on both sides: registry entries mix case for
    // Go module paths (e.g. github.com/Shopify/go-shopify), and Go import
    // paths are case-insensitive in practice (GitHub owner casing varies).
    if (
      list.some((pkg) => {
        const target = pkg.toLowerCase();
        return needle === target || needle.startsWith(`${target}/`);
      })
    ) {
      return p.id;
    }
  }
  return undefined;
}

export function providerForHost(
  hostname: string,
  providers: ProviderConfig[] = PROVIDERS,
): ProviderId | undefined {
  const h = hostname.toLowerCase();
  for (const p of providers) {
    if (p.hosts.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return p.id;
  }
  return undefined;
}

/**
 * Build the analyzer index. Rules are permissive on aliases because each
 * analyzer resolves imports per-file and only activates a rule when the
 * provider's package is actually imported in that file.
 */
export function buildAnalyzerIndex(providers: ProviderConfig[] = PROVIDERS): AnalyzerIndex {
  const rules: Record<Language, LanguageRule[]> = {
    javascript: [],
    python: [],
    go: [],
  };
  const hosts: HostRule[] = [];

  for (const p of providers) {
    for (const suffix of p.hosts) hosts.push({ suffix, providerId: p.id });

    const js = p.packages.npm ?? [];
    rules.javascript.push({
      providerId: p.id,
      packageName: js[0] ?? p.id,
      roots: [p.id, ...(p.factories.javascript ?? [])],
      factories: p.factories.javascript ?? [],
    });

    rules.python.push({
      providerId: p.id,
      packageName: (p.packages.pypi ?? [p.id])[0]!,
      roots: [p.id, ...(p.factories.python ?? [])],
      factories: p.factories.python ?? [],
    });

    const goPrefixes = p.packages.go ?? [];
    rules.go.push({
      providerId: p.id,
      packageName: goPrefixes[0] ?? p.id,
      roots: [p.id, ...(p.factories.go ?? [])],
      factories: p.factories.go ?? [],
      goModulePrefixes: goPrefixes,
    });
  }
  return { rules, hosts };
}
