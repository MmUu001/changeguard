import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LocalRepoSource } from '../src/source/repo-source.js';
import { analyzeRepository } from '../src/analyze/index.js';
import type { CallSite } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRepo = resolve(here, '../fixtures/sample-repo');

describe('tree-sitter analyzers (sample-repo integration)', () => {
  let sites: CallSite[] = [];
  let errors: string[] = [];

  it('parses all three grammars without grammar errors', async () => {
    const source = new LocalRepoSource('sample-repo', fixtureRepo);
    const result = await analyzeRepository(source);
    sites = result.sites;
    errors = result.errors;
    expect(errors.filter((e) => e.startsWith('grammar:'))).toEqual([]);
    expect(result.filesParsed).toBe(3);
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  const find = (fileSuffix: string, path: string): CallSite | undefined =>
    sites.find((s) => s.file.endsWith(fileSuffix) && s.path === path);

  describe('JavaScript/TypeScript (billing.ts)', () => {
    it('extracts multi-segment SDK calls and argument keys', () => {
      const charges = find('billing.ts', 'charges.create');
      expect(charges).toBeTruthy();
      expect(charges!.providerId).toBe('stripe');
      expect(charges!.argumentKeys).toContain('source');
    });

    it('captures enum string literals keyed by argument', () => {
      const edits = find('billing.ts', 'edits.create');
      expect(edits).toBeTruthy();
      expect(edits!.argumentLiterals.model).toContain('text-davinci-edit-001');
    });

    it('captures twilio callback key and supabase auth method', () => {
      const messages = find('billing.ts', 'messages.create');
      expect(messages!.argumentKeys).toContain('statusCallback');
      expect(find('billing.ts', 'auth.signIn')).toBeTruthy();
    });

    it('detects raw HTTP calls to vendor endpoints', () => {
      const httpHits = sites.filter(
        (s) =>
          s.file.endsWith('billing.ts') &&
          s.http?.method === 'POST' &&
          s.http.url.includes('/v1/edits'),
      );
      expect(httpHits.length).toBeGreaterThan(0);
    });
  });

  describe('Python (ai.py)', () => {
    it('extracts SDK calls and keyword arguments', () => {
      expect(find('ai.py', 'Charge.create')).toBeTruthy();
      const messages = find('ai.py', 'messages.create');
      expect(messages).toBeTruthy();
      expect(messages!.argumentKeys).toContain('status_callback');
      expect(find('ai.py', 'auth.sign_in')).toBeTruthy();
    });
  });

  describe('Go (main.go)', () => {
    it('resolves struct params propagation and selector chains', () => {
      expect(sites.some((s) => s.file.endsWith('main.go') && s.path === 'SetSource')).toBe(true);
      expect(sites.some((s) => s.file.endsWith('main.go') && s.path === 'Api.CreateMessage')).toBe(
        true,
      );
      expect(
        sites.some((s) => s.file.endsWith('main.go') && s.path === 'From.Select.Execute'),
      ).toBe(true);
    });

    it('captures package-qualified enum constants as member references', () => {
      const constHit = sites.find(
        (s) =>
          s.file.endsWith('main.go') && s.memberRefs.some((r) => r.endsWith('GPTTextDavinci003')),
      );
      expect(constHit).toBeTruthy();
    });
  });
});
