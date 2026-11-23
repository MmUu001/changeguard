/**
 * Signed change feed (envelope v1).
 *
 * The payload is the whole envelope minus `signature`, serialized with
 * canonical JSON (see ./canonical.ts). Because *everything except* the
 * signature is signed, a publisher can add new top-level fields or new record
 * fields later and old clients still verify them byte-for-byte; clients simply
 * ignore fields they do not understand. Removing or retyping a field requires
 * bumping `feedVersion`.
 *
 * Signature: ed25519, detached value embedded in the envelope, key selected by
 * `kid`. `kid` is derived from the public key itself, so a registry entry that
 * pairs a `kid` with a different key is rejected.
 *
 * The same primitives sign the keyring itself (see ./feed-keys.ts): root keys
 * are built into the package, signing keys travel in a root-signed keyring.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { ChangeRecord } from '../types.js';
import { canonicalBytes } from './canonical.js';

export const FEED_VERSION = 1;
export const FEED_PUBLISHER = 'changeguard';
export const FEED_SIGNATURE_ALGORITHM = 'ed25519';

export interface FeedPayload {
  feedVersion: number;
  publisher: string;
  /** ISO timestamp of the signing run. */
  generatedAt: string;
  records: ChangeRecord[];
}

export interface FeedSignature {
  algorithm: typeof FEED_SIGNATURE_ALGORITHM;
  kid: string;
  /** Hex SHA-256 of the canonical payload; diagnostics only. */
  digest: string;
  /** Base64 ed25519 signature over the canonical payload. */
  value: string;
}

export interface SignedFeedEnvelope extends FeedPayload {
  signature: FeedSignature;
}

export interface TrustedFeedKey {
  kid: string;
  /** SPKI PEM (public key only). */
  publicKeyPem: string;
  /** ISO timestamp; the key is rejected before this moment (staged rollout). */
  notBefore?: string;
  /** ISO timestamp; the key is rejected at or after this moment (rotation). */
  retiresAt?: string;
}

export type FeedRejectionReason =
  | 'malformed'
  | 'unsupported-version'
  | 'missing-signature'
  | 'unsupported-algorithm'
  | 'unknown-kid'
  | 'not-yet-valid'
  | 'retired-key'
  | 'bad-signature'
  | 'keyring-malformed'
  | 'keyring-unsigned'
  | 'keyring-unknown-root'
  | 'keyring-bad-signature';

export type FeedVerification =
  | { ok: true; payload: FeedPayload; key: TrustedFeedKey }
  | { ok: false; reason: FeedRejectionReason; detail: string };

/** Stable `kid` derived from the public key (96-bit fingerprint). */
export function deriveKid(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  const fingerprint = createHash('sha256').update(der).digest('base64url');
  return `${FEED_SIGNATURE_ALGORITHM}:${fingerprint.slice(0, 16)}`;
}

export function feedDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalBytes(payload)).digest('hex');
}

/** Sign any canonical JSON body (a feed payload or a keyring payload). */
export function signBody(
  body: Record<string, unknown>,
  key: { kid: string; privateKeyPem: string },
): FeedSignature {
  const expectedKid = deriveKid(publicKeyFromPrivate(key.privateKeyPem));
  if (expectedKid !== key.kid) {
    throw new Error(
      `kid ${key.kid} does not match the supplied private key (expected ${expectedKid})`,
    );
  }
  const digest = feedDigest(body);
  const value = sign(null, canonicalBytes(body), createPrivateKey(key.privateKeyPem));
  return {
    algorithm: FEED_SIGNATURE_ALGORITHM,
    kid: key.kid,
    digest,
    value: value.toString('base64'),
  };
}

/** Check a detached signature over a canonical JSON body. */
export function verifySignature(
  body: Record<string, unknown>,
  sig: { digest?: unknown; value: string },
  publicKeyPem: string,
): { ok: true } | { ok: false; detail: string } {
  const computed = feedDigest(body);
  if (typeof sig.digest === 'string' && sig.digest !== computed) {
    return {
      ok: false,
      detail: `payload digest mismatch (declared ${sig.digest}, computed ${computed})`,
    };
  }
  try {
    const valid = verify(
      null,
      canonicalBytes(body),
      createPublicKey(publicKeyPem),
      Buffer.from(sig.value, 'base64'),
    );
    if (!valid) return { ok: false, detail: 'signature does not match the payload' };
  } catch (err) {
    return { ok: false, detail: `signature could not be checked: ${(err as Error).message}` };
  }
  return { ok: true };
}

/**
 * Apply `notBefore` / `retiresAt` to a trusted key. Used for signing keys in a
 * verified keyring and for built-in root keys alike.
 */
export function checkKeyValidity(
  key: TrustedFeedKey,
  now: Date,
):
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'not-yet-valid' | 'retired-key'; detail: string } {
  if (key.notBefore) {
    const from = Date.parse(key.notBefore);
    if (!Number.isFinite(from)) {
      return { ok: false, reason: 'malformed', detail: `key ${key.kid} has an invalid notBefore` };
    }
    if (now.getTime() < from) {
      return {
        ok: false,
        reason: 'not-yet-valid',
        detail: `kid ${key.kid} is not valid before ${key.notBefore}`,
      };
    }
  }
  if (key.retiresAt) {
    const until = Date.parse(key.retiresAt);
    if (!Number.isFinite(until)) {
      return { ok: false, reason: 'malformed', detail: `key ${key.kid} has an invalid retiresAt` };
    }
    if (now.getTime() >= until) {
      return {
        ok: false,
        reason: 'retired-key',
        detail: `kid ${key.kid} was retired at ${key.retiresAt}`,
      };
    }
  }
  return { ok: true };
}

export function signFeed(
  payload: FeedPayload,
  key: { kid: string; privateKeyPem: string },
): SignedFeedEnvelope {
  return {
    ...payload,
    signature: signBody(payload as unknown as Record<string, unknown>, key),
  };
}

/** Fail-closed verification: every branch either returns ok or a typed rejection. */
export function verifyFeed(
  raw: unknown,
  trustedKeys: TrustedFeedKey[],
  opts: { now?: Date } = {},
): FeedVerification {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'malformed', detail: 'feed must be a JSON object' };
  }
  const version = raw.feedVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'malformed', detail: 'feedVersion must be a positive integer' };
  }
  if (version !== FEED_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      detail: `feedVersion ${version} is not supported by this client (max ${FEED_VERSION})`,
    };
  }
  if (!Array.isArray(raw.records)) {
    return { ok: false, reason: 'malformed', detail: 'records must be an array' };
  }

  const sig = raw.signature;
  if (!isPlainObject(sig)) {
    return { ok: false, reason: 'missing-signature', detail: 'feed has no signature' };
  }
  if (sig.algorithm !== FEED_SIGNATURE_ALGORITHM) {
    return {
      ok: false,
      reason: 'unsupported-algorithm',
      detail: `algorithm ${String(sig.algorithm)} is not supported`,
    };
  }
  if (typeof sig.kid !== 'string' || typeof sig.value !== 'string') {
    return { ok: false, reason: 'missing-signature', detail: 'signature must have kid and value' };
  }

  const key = trustedKeys.find((candidate) => candidate.kid === sig.kid);
  if (!key) {
    const known = trustedKeys.map((candidate) => candidate.kid).join(', ') || '(none configured)';
    return {
      ok: false,
      reason: 'unknown-kid',
      detail: `kid ${sig.kid} is not trusted; trusted kids: ${known}`,
    };
  }
  const validity = checkKeyValidity(key, opts.now ?? new Date());
  if (!validity.ok) return validity;

  // Sign the payload exactly as received: every member except `signature`.
  const payload = dropSignature(raw);
  const checked = verifySignature(
    payload,
    { digest: sig.digest, value: sig.value },
    key.publicKeyPem,
  );
  if (!checked.ok) return { ok: false, reason: 'bad-signature', detail: checked.detail };

  return {
    ok: true,
    payload: payload as unknown as FeedPayload,
    key,
  };
}

/** Remove the signature member; everything else is signed. */
export function dropSignature(raw: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'signature') continue;
    payload[key] = value;
  }
  return payload;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicKeyFromPrivate(privateKeyPem: string): string {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  return publicKey.export({ type: 'spki', format: 'pem' }) as string;
}
