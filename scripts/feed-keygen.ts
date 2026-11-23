#!/usr/bin/env node
/**
 * Generate an ed25519 key pair for signing the change feed.
 *
 *   npx tsx scripts/feed-keygen.ts [--out <dir>] [--name <base>] [--force]
 *
 * Writes:
 *   <out>/<name>.private.pem   PKCS#8 private key (0600) — never commit
 *   <out>/<name>.public.pem    SPKI public key
 *   <out>/<name>.keyring.json  { "keys": [{ "kid", "publicKeyPem" }] }
 *
 * The registry entry is what clients trust. `.keys/` is git-ignored; the script
 * refuses to write a private key inside the repository unless git confirms the
 * path is ignored, so a key cannot end up in a commit by accident.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveKid } from '../src/ingest/feed.js';

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const hasFlag = (name: string): boolean => process.argv.includes(name);

function repoRoot(): string | undefined {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  const root = res.stdout.trim();
  return root || undefined;
}

function assertOutputDirSafe(dir: string): void {
  const root = repoRoot();
  if (!root) return; // not a git checkout: nothing to protect
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return; // outside the repository
  // Probe a child path: a directory-only pattern (`.keys/`) does not match the
  // bare directory name when it does not exist yet, but it does match contents.
  const probe = relative(root, join(dir, '.probe'));
  const ignored = spawnSync('git', ['check-ignore', '-q', probe.split(sep).join('/')], {
    cwd: root,
  });
  if (ignored.status !== 0) {
    throw new Error(
      `${rel || '.'} is inside the repository and not git-ignored. Use --out outside the ` +
        `repo, or add the directory to .gitignore before generating a key.`,
    );
  }
}

function main(): void {
  const outDir = resolve(argValue('--out', '.keys')!);
  const name = argValue('--name', 'feed-v1')!;
  const force = hasFlag('--force');

  const privatePath = join(outDir, `${name}.private.pem`);
  const publicPath = join(outDir, `${name}.public.pem`);
  const keyringPath = join(outDir, `${name}.keyring.json`);

  if (existsSync(privatePath) && !force) {
    throw new Error(`${privatePath} already exists; pass --force to rotate/overwrite`);
  }
  assertOutputDirSafe(outDir);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyPem = String(publicKey);
  const privateKeyPem = String(privateKey);
  const kid = deriveKid(publicKeyPem);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
  writeFileSync(publicPath, publicKeyPem);
  writeFileSync(keyringPath, JSON.stringify({ keys: [{ kid, publicKeyPem }] }, null, 2) + '\n');

  // Sanity: the printed kid must round-trip through the private key.
  const derivedFromPrivate = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'pem',
  });
  if (deriveKid(String(derivedFromPrivate)) !== kid) {
    throw new Error('generated key pair is inconsistent');
  }

  console.log(`kid      : ${kid}`);
  console.log(`private  : ${privatePath}   (0600, never commit)`);
  console.log(`public   : ${publicPath}`);
  console.log(`keyring  : ${keyringPath}`);
  console.log('');
  console.log('Next — signing key (listed in a root-signed keyring):');
  console.log(
    `  npx tsx scripts/feed-sign.ts --key "${privatePath}" --kid "${kid}" --out .changeguard/feed.json`,
  );
  console.log('Next — root key (signs the keyring, keep offline):');
  console.log(
    `  npx tsx scripts/feed-keyring.ts --root-key "${privatePath}" --root-kid "${kid}" ` +
      '--keys signing-keys.json --out .changeguard/keyring.json',
  );
  console.log('Local bootstrap (root keys are not built in until production keys ship):');
  console.log(
    `  $env:CHANGEGUARD_FEED_ROOT_KEYS="${keyringPath}"; npx tsx src/cli.ts scan <repo> ` +
      '--feed .changeguard/feed.json --trusted-keys .changeguard/keyring.json',
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
