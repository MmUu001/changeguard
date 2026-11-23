#!/usr/bin/env node
/**
 * Produce a signed change feed.
 *
 *   npx tsx scripts/feed-sign.ts --key <private.pem> --kid <kid> [--out <file>]
 *     [--since <iso>] [--generated-at <iso>] [--records <json>] [--publisher <name>]
 *
 * By default records come from the bundled offline snapshot (curated seeds +
 * bundled OpenAPI diffs); `--records` signs an explicit ChangeRecord[] file
 * instead (useful for staging or for tests). Signing always runs over the
 * canonical JSON of the whole envelope minus `signature`, never over the
 * pretty-printed file.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectChanges } from '../src/ingest/store.js';
import {
  FEED_PUBLISHER,
  FEED_VERSION,
  feedDigest,
  signFeed,
  verifyFeed,
  type FeedPayload,
} from '../src/ingest/feed.js';
import { PROVIDERS } from '../src/providers/registry.js';
import type { ChangeRecord } from '../src/types.js';

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readPrivateKey(): { path: string; kid: string; pem: string } {
  const path = argValue('--key');
  const kid = argValue('--kid');
  if (!path) throw new Error('--key <private.pem> is required');
  if (!kid) throw new Error('--kid <kid> is required (printed by scripts/feed-keygen.ts)');
  return { path: resolve(path), kid, pem: readFileSync(resolve(path), 'utf8') };
}

function readRecords(path: string): ChangeRecord[] {
  const raw: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as { records?: unknown }).records)
      ? (raw as { records: unknown[] }).records
      : undefined;
  if (!list) throw new Error(`${path}: expected a ChangeRecord[] or {"records":[...]}`);
  return list as ChangeRecord[];
}

async function main(): Promise<void> {
  const key = readPrivateKey();
  const out = resolve(argValue('--out', '.changeguard/feed.json')!);
  const publisher = argValue('--publisher', FEED_PUBLISHER)!;
  const generatedAt = argValue('--generated-at', new Date().toISOString())!;
  const recordsFile = argValue('--records');

  const since =
    argValue('--since') ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`--generated-at is not a valid ISO timestamp: ${generatedAt}`);
  }

  const records = recordsFile
    ? readRecords(recordsFile)
    : await collectChanges({
        online: false,
        sinceISO: since,
        providers: PROVIDERS.map((provider) => provider.id),
      });

  const payload: FeedPayload = {
    feedVersion: FEED_VERSION,
    publisher,
    generatedAt,
    records,
  };
  const envelope = signFeed(payload, { kid: key.kid, privateKeyPem: key.pem });

  // Fail loudly if the artifact does not verify with its own public key.
  const publicKeyPem = String(
    createPublicKey(createPrivateKey(key.pem)).export({ type: 'spki', format: 'pem' }),
  );
  const selfCheck = verifyFeed(envelope, [{ kid: key.kid, publicKeyPem }], {
    now: new Date(Date.parse(generatedAt)),
  });
  if (!selfCheck.ok) {
    throw new Error(`self-check failed: ${selfCheck.reason}: ${selfCheck.detail}`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(envelope, null, 2) + '\n');

  console.log(`signed feed : ${out}`);
  console.log(`records     : ${records.length}`);
  console.log(`publisher   : ${publisher}`);
  console.log(`generatedAt : ${generatedAt}`);
  console.log(`kid         : ${envelope.signature.kid}`);
  console.log(`digest      : ${feedDigest(payload)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
