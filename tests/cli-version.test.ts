/**
 * `changeguard --version` must match package.json.
 *
 * Regression guard: the version was hard-coded as '0.1.0' for five releases
 * (0.2.0 … 0.6.0 all claimed 0.1.0), discovered when installing the 0.6.0
 * tarball reported the wrong version.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('CLI version', () => {
  it('--version prints the package.json version', () => {
    const out = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', '--version'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    expect(out).toBe(pkg.version);
  });
});
