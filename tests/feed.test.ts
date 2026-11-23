import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/ingest/canonical.js';
import {
  deriveKid,
  signFeed,
  verifyFeed,
  type FeedPayload,
  type SignedFeedEnvelope,
  type TrustedFeedKey,
} from '../src/ingest/feed.js';
import {
  parseKeyEntries,
  signKeyring,
  verifySignedKeyring,
  type SignedKeyring,
} from '../src/ingest/feed-keys.js';
import type { ChangeRecord } from '../src/types.js';

function keyPair(): { kid: string; privateKeyPem: string; publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKeyPem = String(publicKey);
  return {
    kid: deriveKid(publicKeyPem),
    privateKeyPem: String(privateKey),
    publicKeyPem,
  };
}

function record(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: 'stripe-2025-01-01-charge-refund',
    providerId: 'stripe',
    kind: 'breaking',
    title: 'Charge.refund() rejects unknown parameters',
    summary: 'Unknown parameters now raise an InvalidRequestError.',
    source: 'release-note',
    sourceUrl: 'https://example.com/changelog',
    date: '2025-01-01',
    operations: [],
    renames: [],
    versions: [],
    parserSignals: [],
    confidence: 'high',
    ...overrides,
  };
}

function payload(records: ChangeRecord[] = [record()]): FeedPayload {
  return {
    feedVersion: 1,
    publisher: 'changeguard',
    generatedAt: '2026-01-01T00:00:00.000Z',
    records,
  };
}

function trusted(
  key: { kid: string; publicKeyPem: string },
  window: { notBefore?: string; retiresAt?: string } = {},
): TrustedFeedKey {
  return { kid: key.kid, publicKeyPem: key.publicKeyPem, ...window };
}

function signedKeyring(
  root: { kid: string; privateKeyPem: string },
  keys: TrustedFeedKey[],
): SignedKeyring {
  return signKeyring({ generatedAt: '2026-01-01T00:00:00.000Z', keys }, root);
}

describe('canonical JSON v1', () => {
  it('sorts object keys and ignores insertion order', () => {
    const a = { z: 1, a: { y: true, b: [3, 2, 1] } };
    const b = { a: { b: [3, 2, 1], y: true }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":[3,2,1],"y":true},"z":1}');
  });

  it('omits undefined members and normalizes -0', () => {
    expect(canonicalJson({ a: undefined, b: -0, c: null })).toBe('{"b":0,"c":null}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });
});

describe('signed feed envelope', () => {
  it('verifies a freshly signed feed', () => {
    const key = keyPair();
    const envelope = signFeed(payload(), key);
    const result = verifyFeed(envelope, [trusted(key)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key.kid).toBe(key.kid);
    expect(result.payload.records).toHaveLength(1);
    expect(result.payload.records[0]!.title).toBe('Charge.refund() rejects unknown parameters');
  });

  it('rejects a payload modified after signing', () => {
    const key = keyPair();
    const envelope = signFeed(payload(), key);
    const tampered: SignedFeedEnvelope = {
      ...envelope,
      records: [{ ...envelope.records[0]!, title: `${envelope.records[0]!.title}!` }],
    };
    const result = verifyFeed(tampered, [trusted(key)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects a feed with no signature', () => {
    const key = keyPair();
    const { signature: _signature, ...unsigned } = signFeed(payload(), key);
    const result = verifyFeed(unsigned, [trusted(key)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-signature');
  });

  it('rejects an unknown kid', () => {
    const signer = keyPair();
    const other = keyPair();
    const result = verifyFeed(signFeed(payload(), signer), [trusted(other)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-kid');
  });

  it('rejects unsupported feed versions', () => {
    const key = keyPair();
    const envelope = { ...signFeed(payload(), key), feedVersion: 2 };
    const result = verifyFeed(envelope, [trusted(key)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-version');
  });

  it('verifies fields added by a newer publisher (unknown fields are signed, not filtered)', () => {
    const key = keyPair();
    const extended = {
      ...payload([record({ futureField: 'ignored-but-signed' } as Partial<ChangeRecord>)]),
      feedRevision: 7,
    } as FeedPayload;
    const result = verifyFeed(signFeed(extended, key), [trusted(key)]);
    expect(result.ok).toBe(true);
  });
});

describe('two-layer keyring', () => {
  it('trusts signing keys only after the root signature verifies', () => {
    const root = keyPair();
    const signing = keyPair();
    const keyring = signedKeyring(root, [trusted(signing)]);
    const verified = verifySignedKeyring(keyring, [trusted(root)]);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.root.kid).toBe(root.kid);
    expect(verified.keys[0]!.kid).toBe(signing.kid);
    expect(verifyFeed(signFeed(payload(), signing), verified.keys).ok).toBe(true);
  });

  it('rejects a keyring whose contents were modified after signing', () => {
    const root = keyPair();
    const signing = keyPair();
    const keyring = signedKeyring(root, [trusted(signing)]);
    const tampered: SignedKeyring = {
      ...keyring,
      keys: [{ ...keyring.keys[0]!, retiresAt: '2026-06-01T00:00:00.000Z' }],
    };
    const result = verifySignedKeyring(tampered, [trusted(root)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('keyring-bad-signature');
  });

  it('rejects a keyring signed by an unknown root', () => {
    const trustedRoot = keyPair();
    const otherRoot = keyPair();
    const keyring = signedKeyring(otherRoot, [trusted(keyPair())]);
    const result = verifySignedKeyring(keyring, [trusted(trustedRoot)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('keyring-unknown-root');
  });

  it('rejects an unsigned keyring', () => {
    const root = keyPair();
    const { signature: _signature, ...unsigned } = signedKeyring(root, [trusted(keyPair())]);
    const result = verifySignedKeyring(unsigned, [trusted(root)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('keyring-unsigned');
  });

  it('accepts a keyring signed by any trusted root (multi-root overlap)', () => {
    const rootA = keyPair();
    const rootB = keyPair();
    const signing = keyPair();
    const keyring = signedKeyring(rootB, [trusted(signing)]);
    const result = verifySignedKeyring(keyring, [trusted(rootA), trusted(rootB)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.kid).toBe(rootB.kid);
  });

  it('rejects unsupported keyring versions', () => {
    const root = keyPair();
    const keyring = { ...signedKeyring(root, [trusted(keyPair())]), keyringVersion: 2 };
    const result = verifySignedKeyring(keyring, [trusted(root)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('keyring-malformed');
  });
});

describe('key rotation', () => {
  it('supports the parallel window, then rejects the retired signing key', () => {
    const root = keyPair();
    const oldKey = keyPair();
    const newKey = keyPair();
    const keyring = signedKeyring(root, [
      trusted(oldKey, { retiresAt: '2026-02-01T00:00:00.000Z' }),
      trusted(newKey),
    ]);
    const verified = verifySignedKeyring(keyring, [trusted(root)]);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const signedByOld = signFeed(payload(), oldKey);
    const signedByNew = signFeed(payload(), newKey);

    expect(
      verifyFeed(signedByOld, verified.keys, {
        now: new Date('2026-01-15T00:00:00.000Z'),
      }).ok,
    ).toBe(true);
    expect(
      verifyFeed(signedByNew, verified.keys, {
        now: new Date('2026-01-15T00:00:00.000Z'),
      }).ok,
    ).toBe(true);

    const retired = verifyFeed(signedByOld, verified.keys, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(retired.ok).toBe(false);
    if (retired.ok) return;
    expect(retired.reason).toBe('retired-key');

    expect(
      verifyFeed(signedByNew, verified.keys, {
        now: new Date('2026-02-01T00:00:00.000Z'),
      }).ok,
    ).toBe(true);
  });

  it('rejects a signing key that is not valid yet', () => {
    const root = keyPair();
    const staged = keyPair();
    const keyring = signedKeyring(root, [
      trusted(staged, { notBefore: '2026-03-01T00:00:00.000Z' }),
    ]);
    const verified = verifySignedKeyring(keyring, [trusted(root)]);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const result = verifyFeed(signFeed(payload(), staged), verified.keys, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-yet-valid');
  });

  it('rejects a retired root key', () => {
    const root = keyPair();
    const keyring = signedKeyring(root, [trusted(keyPair())]);
    const result = verifySignedKeyring(
      keyring,
      [trusted(root, { retiresAt: '2026-02-01T00:00:00.000Z' })],
      { now: new Date('2026-02-01T00:00:00.000Z') },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('retired-key');
  });
});

describe('trusted key entries', () => {
  it('rejects a kid that does not match its public key', () => {
    const key = keyPair();
    const other = keyPair();
    expect(() =>
      parseKeyEntries({ keys: [{ kid: other.kid, publicKeyPem: key.publicKeyPem }] }),
    ).toThrow(/does not match the key/);
  });

  it('accepts both the wrapped and the bare-array form', () => {
    const key = keyPair();
    const entry = { kid: key.kid, publicKeyPem: key.publicKeyPem };
    expect(parseKeyEntries({ keys: [entry] })[0]!.kid).toBe(key.kid);
    expect(parseKeyEntries([entry])[0]!.kid).toBe(key.kid);
  });

  it('rejects invalid rotation windows', () => {
    const key = keyPair();
    expect(() =>
      parseKeyEntries({
        keys: [{ kid: key.kid, publicKeyPem: key.publicKeyPem, retiresAt: 'nope' }],
      }),
    ).toThrow(/invalid retiresAt/);
  });
});
