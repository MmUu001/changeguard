import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Apache-2.0 side of the dual license: guards the CLI boundary and the npm
 * package allowlist. No network access and no proprietary modules are used.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function stripComments(src: string): string {
  // Line comments first: they may contain `/**` (e.g. "src/server/**"), which
  // would otherwise open a block comment and swallow the code after it.
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

describe('license boundary', () => {
  it('keeps src/cli.ts free of proprietary server/store imports', () => {
    const source = stripComments(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'));
    const proprietaryImport = /(?:from\s*|import\s*\(\s*)['"](?:\.{1,2}\/)+(?:server|store)\//;
    expect(source).not.toMatch(proprietaryImport);
    // The only extension point is the proprietary admin module, loaded lazily.
    expect(source).toMatch(/import\s*\(\s*['"]\.\/cli-admin\.js['"]\s*\)/);
  });

  it('keeps proprietary paths out of the npm package allowlist', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(Array.isArray(pkg.files)).toBe(true);
    const files = pkg.files ?? [];

    const proprietaryPaths = [
      'dist/server/auth.js',
      'dist/server/dashboard.js',
      'dist/store/sqlite.js',
      'dist/store/tenant.js',
      'dist/cli-admin.js',
      'dist/cli-admin.js.map',
      'Dockerfile',
      'docker-compose.yml',
      'docker-compose.multi.yml',
    ];
    const matchers = files.map(globToRegExp);
    const leaked = proprietaryPaths.filter((path) => matchers.some((re) => re.test(path)));
    expect(leaked).toEqual([]);
  });

  it('still ships the resources the Apache-2.0 CLI needs', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    const matchers = (pkg.files ?? []).map(globToRegExp);
    const required = [
      'dist/cli.js',
      'dist/scan.js',
      'dist/ingest/store.js',
      'data/changes/stripe.seed.json',
      'data/openapi/openai/meta.json',
      'fixtures/sample-repo/package.json',
      'LICENSE',
      'LICENSE-PROPRIETARY',
      'README.md',
    ];
    const missing = required.filter((path) => !matchers.some((re) => re.test(path)));
    expect(missing).toEqual([]);
  });
});
