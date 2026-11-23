#!/usr/bin/env node
/**
 * Sign a feed keyring with a long-lived root key.
 *
 *   npx tsx scripts/feed-keyring.ts --root-key <root.private.pem> \
 *     --root-kid <kid> --keys <signing-keys.json> [--out <file>] \
 *     [--generated-at <iso>]
 *
 * `--keys` accepts `{ "keys": [...] }` or a bare array of entries:
 *   { "publicKeyPem": "...", "kid"?: "...", "notBefore"?: "...", "retiresAt"?: "..." }
 * `kid` is derived from the PEM when omitted.
 *
 * The resulting keyring is what clients trust for feed signatures. It can be
 * served next to the feed: the root signature is checked locally, so an
 * attacker-controlled endpoint cannot introduce signing keys.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deriveKid } from '../src/ingest/feed.js';
import { parseKeyEntries, signKeyring, verifySignedKeyring } from '../src/ingest/feed-keys.js';

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readSigningKeys(path: string): unknown[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { keys?: unknown }).keys)
      ? (raw as { keys: unknown[] }).keys
      : undefined;
  if (!list) throw new Error(`${path}: expected {"keys":[...]} or an array of entries`);
  return list.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const { publicKeyPem, kid } = entry as { publicKeyPem?: unknown; kid?: unknown };
    if (kid !== undefined || typeof publicKeyPem !== 'string') return entry;
    return { ...entry, kid: deriveKid(publicKeyPem) };
  });
}

function main(): void {
  const rootKeyPath = argValue('--root-key');
  const rootKid = argValue('--root-kid');
  if (!rootKeyPath) throw new Error('--root-key <root.private.pem> is required');
  if (!rootKid) throw new Error('--root-kid <kid> is required (printed by scripts/feed-keygen.ts)');
  const keysPath = argValue('--keys');
  if (!keysPath) throw new Error('--keys <signing-keys.json> is required');
  const out = resolve(argValue('--out', '.changeguard/keyring.json')!);
  const generatedAt = argValue('--generated-at', new Date().toISOString())!;
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`--generated-at is not a valid ISO timestamp: ${generatedAt}`);
  }

  const privateKeyPem = readFileSync(resolve(rootKeyPath), 'utf8');
  const rootPublicPem = String(
    createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }),
  );
  if (deriveKid(rootPublicPem) !== rootKid) {
    throw new Error(`--root-kid ${rootKid} does not match ${rootKeyPath}`);
  }

  const entries = readSigningKeys(keysPath);
  const keyring = signKeyring(
    { keyringVersion: 1, generatedAt, keys: parseKeyEntries({ keys: entries }, 'signing keys') },
    { kid: rootKid, privateKeyPem },
  );

  const selfCheck = verifySignedKeyring(keyring, [{ kid: rootKid, publicKeyPem: rootPublicPem }]);
  if (!selfCheck.ok) {
    throw new Error(`self-check failed: ${selfCheck.reason}: ${selfCheck.detail}`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(keyring, null, 2) + '\n');

  console.log(`signed keyring : ${out}`);
  console.log(`root           : ${rootKid}`);
  console.log(`generatedAt    : ${generatedAt}`);
  for (const key of keyring.keys) {
    const window = [
      key.notBefore ? `notBefore=${key.notBefore}` : '',
      key.retiresAt ? `retiresAt=${key.retiresAt}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`signing key    : ${key.kid}${window ? `  (${window})` : ''}`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
