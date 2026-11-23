#!/usr/bin/env node
/**
 * Publish gate for the npm tarball.
 *
 *   node scripts/publish.mjs               # dry run: full verification chain only
 *   node scripts/publish.mjs --apply       # verify, then publish to registry.npmjs.org
 *   node scripts/publish.mjs --tarball     # verify, then produce a shareable tgz
 *                                          #   (trial distribution; npm auth not needed)
 *
 * Every check either passes with evidence or aborts the chain. Publishing
 * without the chain (bare `npm publish`) is how broken tarballs reach users;
 * this script exists so publishing is exactly one reviewed action.
 *
 * --tarball mode exists because registry signup may be unavailable: the same
 * eight checks run, the pack lands in the trial-kit directory (override with
 * --dest <dir>), and the script prints the recipient's install commands.
 *
 * Requires npm auth against the OFFICIAL registry in --apply mode (see
 * docs/npm-publish.md). The project .npmrc points at a mirror, so the
 * registry is always passed explicitly.
 */
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const APPLY = process.argv.includes('--apply');
const TARBALL = process.argv.includes('--tarball');
const destIdx = process.argv.indexOf('--dest');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARBALL_DIR =
  destIdx !== -1 && process.argv[destIdx + 1]
    ? process.argv[destIdx + 1]
    : join(REPO_ROOT, '..', 'trial-kit');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const NAME = pkg.name;
const VERSION = pkg.version;

let failed = 0;
const pass = (msg) => console.log(`PASS  ${msg}`);
const fail = (msg) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const info = (msg) => console.log(`      ${msg}`);

function run(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }),
    };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

console.log(
  `\n=== publish gate: ${NAME}@${VERSION} (${APPLY ? 'APPLY' : TARBALL ? 'TARBALL' : 'dry run'}) ===\n`,
);

// 1. npm auth (not required for tarball distribution)
if (TARBALL) {
  info('tarball mode: registry auth not required');
} else {
  const r = run(`npm whoami --registry=${REGISTRY}`);
  if (r.ok) pass(`npm authenticated as ${r.out.trim()}`);
  else
    fail(
      'npm not authenticated against registry.npmjs.org (see docs/npm-publish.md, section "登录")',
    );
}

// 2. version not already taken (skip in tarball mode — no registry involved)
if (TARBALL) {
  info('tarball mode: registry version check skipped');
} else {
  const r = run(`npm view ${NAME}@${VERSION} version --registry=${REGISTRY}`);
  if (!r.ok) pass(`version ${VERSION} is free on the registry`);
  else fail(`version ${VERSION} ALREADY EXISTS on npm — bump package.json first`);
}

// 3. git state
{
  const status = run('git status --porcelain').out.trim();
  if (status === '') pass('working tree clean');
  else fail(`working tree has uncommitted changes:\n${status}`);
  const tag = run(`git tag --points-at HEAD`).out;
  if (tag.includes(`v${VERSION}`)) pass(`HEAD is tagged v${VERSION}`);
  else info(`note: HEAD is not tagged v${VERSION} (tag after publishing, or ignore)`);
}

// 4. build + typecheck + tests
for (const [label, cmd] of [
  ['build', 'npm run build'],
  ['typecheck', 'npm run typecheck'],
  ['tests', 'npm test'],
]) {
  const r = run(cmd);
  if (r.ok) pass(`${label} green`);
  else fail(`${label} failed:\n${r.out.slice(-1200)}`);
}

// 5. tarball contents
{
  const r = run('npm pack --dry-run --json');
  let files = [];
  try {
    files = (JSON.parse(r.out)[0]?.files ?? []).map((f) => f.path);
  } catch {
    /* fall through to failure below */
  }
  const mustHave = [
    'dist/cli.js',
    'data/providers/stripe.json',
    'LICENSE',
    'LICENSE-PROPRIETARY',
    'SECURITY.md',
    'README.md',
    'CHANGELOG.md',
    // MCP surface: local runs succeed even when the tarball silently omits
    // dist/mcp — this is the only check that catches it.
    'dist/mcp/index.js',
    'dist/mcp/tools.js',
    'dist/mcp/server.js',
    'dist/mcp/standalone.js',
  ];
  const missing = mustHave.filter((p) => !files.includes(p));
  const leaked = files.filter((p) => p.startsWith('dist/server/') || p.startsWith('dist/store/'));
  if (missing.length === 0)
    pass(`tarball has all ${mustHave.length} required files (${files.length} total)`);
  else fail(`tarball missing: ${missing.join(', ')}`);
  if (leaked.length === 0) pass('tarball contains no proprietary dist/server or dist/store files');
  else fail(`license boundary leak in tarball: ${leaked.join(', ')}`);
}

console.log('');
if (failed > 0) {
  console.log(`=== GATE FAILED: ${failed} check(s) failed — do not distribute ===`);
  process.exitCode = 1;
} else if (!APPLY && !TARBALL) {
  console.log(
    '=== GATE PASSED (dry run). Re-run with --apply to publish or --tarball to package. ===',
  );
} else if (TARBALL) {
  console.log(`=== packing ${NAME}@${VERSION} for trial distribution ===`);
  mkdirSync(TARBALL_DIR, { recursive: true });
  const pack = run(`npm pack --pack-destination "${TARBALL_DIR}"`);
  const tgz = join(TARBALL_DIR, `${NAME}-${VERSION}.tgz`);
  if (!pack.ok || !existsSync(tgz)) {
    console.log('\n=== PACK FAILED ===');
    process.exitCode = 1;
  } else {
    // Verify the artefact the way a recipient would: install it into a clean
    // prefix and ask the CLI for its version (this is the check that would
    // have caught the hard-coded 0.1.0).
    const tmp = mkdtempSync(join(tmpdir(), 'cg-pack-verify-'));
    try {
      const inst = run(`npm install -g --prefix "${tmp}" "${tgz}" --no-audit --no-fund`);
      if (!inst.ok) throw new Error(`install failed: ${inst.out.slice(-400)}`);
      const bin =
        process.platform === 'win32'
          ? join(tmp, 'changeguard.cmd')
          : join(tmp, 'bin', 'changeguard');
      const v = run(`"${bin}" --version`);
      if (!v.ok || v.out.trim() !== VERSION) {
        throw new Error(`installed copy reports "${v.out.trim()}", expected "${VERSION}"`);
      }
      pass(`installed copy reports ${v.out.trim()}`);
    } catch (err) {
      console.log(`\n=== ARTIFACT VERIFICATION FAILED: ${err.message} ===`);
      process.exitCode = 1;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (!process.exitCode) {
      console.log(`\nartifact: ${tgz}`);
      console.log('\n收件人安装两步：');
      console.log(`  1. npm install -g "<收到的 ${NAME}-${VERSION}.tgz 路径>"`);
      console.log(`  2. changeguard --version        # 应输出 ${VERSION}`);
      console.log('\n=== TARBALL READY ===');
    }
  }
} else {
  console.log(`=== publishing ${NAME}@${VERSION} to ${REGISTRY} ===`);
  try {
    execSync(`npm publish --registry=${REGISTRY} --access public`, { stdio: 'inherit' });
  } catch {
    console.log('\n=== PUBLISH FAILED (see npm output above) ===');
    process.exitCode = 1;
    process.exit();
  }
  // Post-publish smoke: the version must be visible and installable.
  const view = run(`npm view ${NAME}@${VERSION} version --registry=${REGISTRY}`);
  if (view.ok) console.log(`\nverified on registry: ${NAME}@${view.out.trim()}`);
  else
    console.log(
      `\nWARNING: published but npm view did not confirm yet (registry propagation can lag ~1 min)`,
    );
  console.log('\n=== PUBLISHED ===');
}
