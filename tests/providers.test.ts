/**
 * Provider manifests: data-driven registry.
 *
 * Pins the framework contract — vendors are JSON in data/providers/, adding
 * one is a data change with zero code edits. Also pins fail-fast validation
 * (a typo must abort startup with file + field named, never silently disable
 * a vendor).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDERS,
  PROVIDER_BY_ID,
  buildAnalyzerIndex,
  loadProviderManifests,
  providerForHost,
  providerForPackage,
  validateProviderManifest,
} from '../src/providers/registry.js';

const tmpDirs: string[] = [];

function makeManifestDir(files: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-providers-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* OS cleans temp dirs */
    }
  }
});

const ACME = {
  id: 'acme',
  name: 'Acme API',
  website: 'https://acme.dev',
  packages: { npm: ['acme-sdk'], pypi: ['acme'], go: ['github.com/acme/acme-go'] },
  hosts: ['api.acme.dev'],
  factories: { javascript: ['createAcmeClient'], python: ['AcmeClient'], go: ['NewAcmeClient'] },
  sources: {
    githubReleases: [
      { ecosystem: 'npm', language: 'javascript', owner: 'acme', repo: 'acme-node' },
    ],
  },
};

describe('built-in manifests load and preserve behavior', () => {
  it('loads the five built-in vendors', () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([
      'openai',
      'shopify',
      'stripe',
      'supabase',
      'twilio',
    ]);
    expect(PROVIDER_BY_ID.size).toBe(5);
  });

  it('preserves package matching, including mixed-case Go paths', () => {
    expect(providerForPackage('npm', 'stripe')).toBe('stripe');
    expect(providerForPackage('pypi', 'openai')).toBe('openai');
    expect(providerForPackage('go', 'github.com/stripe/stripe-go/v78')).toBe('stripe');
    expect(providerForPackage('go', 'github.com/Shopify/go-shopify')).toBe('shopify');
    expect(providerForPackage('npm', 'not-a-vendor')).toBeUndefined();
  });

  it('preserves host matching', () => {
    expect(providerForHost('api.stripe.com')).toBe('stripe');
    expect(providerForHost('api.openai.com')).toBe('openai');
    expect(providerForHost('example.com')).toBeUndefined();
  });

  it('builds analyzer rules for every language from manifests', () => {
    const index = buildAnalyzerIndex();
    for (const lang of ['javascript', 'python', 'go'] as const) {
      expect(index.rules[lang].length).toBe(5);
    }
    expect(index.hosts.length).toBeGreaterThanOrEqual(5);
  });
});

describe('adding a vendor is data-only', () => {
  it('loads a brand-new vendor from a JSON manifest alone', () => {
    const dir = makeManifestDir({ 'acme.json': ACME });
    const providers = loadProviderManifests(dir);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe('acme');
    expect(providers[0]!.packages.npm).toEqual(['acme-sdk']);
  });

  it('the new vendor resolves packages and hosts with injected providers', () => {
    const dir = makeManifestDir({ 'acme.json': ACME });
    const providers = loadProviderManifests(dir);
    expect(providerForPackage('npm', 'acme-sdk', providers)).toBe('acme');
    expect(providerForPackage('go', 'github.com/acme/acme-go/v2', providers)).toBe('acme');
    expect(providerForHost('api.acme.dev', providers)).toBe('acme');
    // Built-ins stay invisible when the injected list is used.
    expect(providerForPackage('npm', 'stripe', providers)).toBeUndefined();
  });

  it('analyzer rules are generated for the new vendor without code changes', () => {
    const dir = makeManifestDir({ 'acme.json': ACME });
    const [acme] = loadProviderManifests(dir);
    const index = buildAnalyzerIndex([acme!]);
    expect(index.rules.javascript[0]!.providerId).toBe('acme');
    expect(index.rules.javascript[0]!.packageName).toBe('acme-sdk');
    expect(index.rules.javascript[0]!.roots).toContain('createAcmeClient');
    expect(index.rules.python[0]!.packageName).toBe('acme');
    expect(index.rules.go[0]!.goModulePrefixes).toEqual(['github.com/acme/acme-go']);
    expect(index.hosts).toEqual([{ suffix: 'api.acme.dev', providerId: 'acme' }]);
  });

  it('multiple manifests load in name order', () => {
    const dir = makeManifestDir({
      'zeta.json': { ...ACME, id: 'zeta' },
      'acme.json': ACME,
    });
    expect(loadProviderManifests(dir).map((p) => p.id)).toEqual(['acme', 'zeta']);
  });
});

describe('manifest validation fails fast', () => {
  const base = { ...ACME };

  it('rejects a missing id and non-slug ids', () => {
    expect(() => validateProviderManifest({ ...base, id: undefined })).toThrow(
      /id must be a lowercase slug/,
    );
    expect(() => validateProviderManifest({ ...base, id: 'Acme Corp' })).toThrow(/lowercase slug/);
  });

  it('rejects empty packages and unknown ecosystems', () => {
    expect(() => validateProviderManifest({ ...base, packages: {} })).toThrow(
      /at least one ecosystem/,
    );
    expect(() => validateProviderManifest({ ...base, packages: { cargo: ['acme'] } })).toThrow(
      /unsupported ecosystem "cargo"/,
    );
  });

  it('rejects unknown languages in factories', () => {
    expect(() =>
      validateProviderManifest({ ...base, factories: { rust: ['AcmeClient'] } }),
    ).toThrow(/unsupported factory language "rust"/);
  });

  it('rejects malformed githubReleases', () => {
    expect(() =>
      validateProviderManifest({ ...base, sources: { githubReleases: 'nope' } }),
    ).toThrow(/githubReleases must be an array/);
    expect(() =>
      validateProviderManifest({
        ...base,
        sources: {
          githubReleases: [{ ecosystem: 'npm', language: 'javascript', owner: '', repo: 'x' }],
        },
      }),
    ).toThrow(/owner required/);
  });

  it('rejects invalid JSON with the file named', () => {
    const dir = makeManifestDir({ 'broken.json': '{ not json' });
    expect(() => loadProviderManifests(dir)).toThrow(/broken\.json: not valid JSON/);
  });

  it('rejects a file stem that does not match the id', () => {
    const dir = makeManifestDir({ 'wrong-name.json': ACME });
    expect(() => loadProviderManifests(dir)).toThrow(
      /file stem "wrong-name" must equal provider id "acme"/,
    );
  });

  it('fails fast when the manifest directory is missing', () => {
    expect(() => loadProviderManifests(join(tmpdir(), 'cg-providers-does-not-exist'))).toThrow(
      /provider manifest directory missing/,
    );
  });

  it('fails fast when the manifest directory is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-providers-empty-'));
    tmpDirs.push(dir);
    expect(() => loadProviderManifests(dir)).toThrow(/no provider manifests found/);
  });
});
