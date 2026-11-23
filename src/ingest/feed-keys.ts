/**
 * Two-layer feed trust: built-in long-lived root keys sign a short-lived
 * keyring, and the keyring lists the keys that sign feeds.
 *
 * Trust anchor: `BUILTIN_ROOT_KEYS` ships inside the Apache-2.0 package, so its
 * integrity is the package's integrity (npm provenance + signed releases).
 * Root keys are the only keys that may introduce signing keys — a compromised
 * feed endpoint cannot self-certify. A keyring may be fetched from a URL:
 * fetching is safe because the root signature is checked locally before any
 * listed `kid` is trusted.
 *
 * Rotation: signing keys rotate by re-signing a keyring with a root key, so
 * already-installed CLIs accept the new keyring without a CLI release. Root
 * keys rotate rarely and require shipping a new CLI release that trusts both
 * roots during the overlap. See docs/feed.md.
 *
 * Bootstrap keys (root1/sign1) were generated locally on 2026-11-13; the root
 * private key stays in the git-ignored `.keys/` directory. Before serving
 * external users, re-run the key ceremony in an isolated environment and
 * rotate: append the new root public key to `BUILTIN_ROOT_KEYS`, ship the
 * overlap release, then retire the bootstrap root.
 */
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import {
  checkKeyValidity,
  deriveKid,
  dropSignature,
  signBody,
  verifySignature,
  type FeedRejectionReason,
  type FeedSignature,
  type TrustedFeedKey,
} from './feed.js';

export const KEYRING_VERSION = 1;

/** Root trust anchors. Public keys only — private keys never ship. */
export const BUILTIN_ROOT_KEYS: TrustedFeedKey[] = [
  {
    kid: 'ed25519:OAJWHQo57zZuOSv-',
    publicKeyPem:
      '-----BEGIN PUBLIC KEY-----\n' +
      'MCowBQYDK2VwAyEAK6+vNffuXsoEQv6w3BvUtcuSS+tJa1XXX5jlVyBqQPo=\n' +
      '-----END PUBLIC KEY-----\n',
  },
];

/**
 * The keyring shipped with the package, signed by a built-in root key.
 * With it in place the CLI trusts the listed signing keys out of the box;
 * verification still fails closed when a feed's `kid` is not in the keyring.
 */
export const BUILTIN_FEED_KEYRING: SignedKeyring = {
  keyringVersion: 1,
  generatedAt: '2026-11-13T06:04:37.944Z',
  keys: [
    {
      kid: 'ed25519:pYFI_sokhVWDncrW',
      publicKeyPem:
        '-----BEGIN PUBLIC KEY-----\n' +
        'MCowBQYDK2VwAyEAQLq/yESD1R3zChhmAr/xtvNI9oD5mPW+nAb0zArxQY8=\n' +
        '-----END PUBLIC KEY-----\n',
    },
  ],
  signature: {
    algorithm: 'ed25519',
    kid: 'ed25519:OAJWHQo57zZuOSv-',
    digest: 'd7c2d18b8329bfa5d4d3dd4391d30c52ab40e34cd3fcf3341c868999f119c20d',
    value:
      'gokFmYqLr2cFzTH5lVqLXgkzhU5TYQAjdb8a3VF57SJ0dNkau+UZ4gSyHuPELvVs3xm5WyYAo1BUDsYpDbvHBQ==',
  },
};

export interface KeyringPayload {
  keyringVersion: number;
  generatedAt?: string;
  keys: TrustedFeedKey[];
}

export interface SignedKeyring extends KeyringPayload {
  signature: FeedSignature;
}

export type KeyringVerification =
  | { ok: true; keys: TrustedFeedKey[]; root: TrustedFeedKey; generatedAt?: string }
  | { ok: false; reason: FeedRejectionReason; detail: string };

/** Structural validation of key entries (root files and keyring bodies). */
export function parseKeyEntries(raw: unknown, source = 'keyring'): TrustedFeedKey[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { keys?: unknown }).keys)
      ? (raw as { keys: unknown[] }).keys
      : undefined;
  if (!list) {
    throw new Error(`${source}: expected {"keys":[...]} or an array of keys`);
  }
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${source}: key #${index} must be an object`);
    }
    const { kid, publicKeyPem, notBefore, retiresAt } = entry as Partial<TrustedFeedKey>;
    if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
      throw new Error(`${source}: key #${index} needs a PEM public key`);
    }
    let derived: string;
    try {
      derived = deriveKid(publicKeyPem);
      createPublicKey(publicKeyPem);
    } catch (err) {
      throw new Error(
        `${source}: key #${index} is not a valid public key (${(err as Error).message})`,
        { cause: err },
      );
    }
    if (typeof kid !== 'string') {
      throw new Error(`${source}: key #${index} is missing kid (expected ${derived})`);
    }
    if (kid !== derived) {
      throw new Error(`${source}: key #${index} kid ${kid} does not match the key (${derived})`);
    }
    for (const [field, value] of [
      ['notBefore', notBefore],
      ['retiresAt', retiresAt],
    ] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(String(value)))) {
        throw new Error(`${source}: key #${index} has an invalid ${field}`);
      }
    }
    return {
      kid: derived,
      publicKeyPem,
      ...(notBefore === undefined ? {} : { notBefore: String(notBefore) }),
      ...(retiresAt === undefined ? {} : { retiresAt: String(retiresAt) }),
    };
  });
}

/** Sign a keyring payload with a root key. */
export function signKeyring(
  payload: { keyringVersion?: number; generatedAt?: string; keys: TrustedFeedKey[] },
  root: { kid: string; privateKeyPem: string },
): SignedKeyring {
  const body: KeyringPayload = {
    keyringVersion: payload.keyringVersion ?? KEYRING_VERSION,
    ...(payload.generatedAt === undefined ? {} : { generatedAt: payload.generatedAt }),
    keys: parseKeyEntries({ keys: payload.keys }, 'keyring'),
  };
  return {
    ...body,
    signature: signBody(body as unknown as Record<string, unknown>, root),
  };
}

/**
 * Verify a keyring against the built-in root keys. No signing key from the
 * keyring is trusted unless this function returns ok.
 */
export function verifySignedKeyring(
  raw: unknown,
  rootKeys: TrustedFeedKey[],
  opts: { now?: Date } = {},
): KeyringVerification {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'keyring-malformed', detail: 'keyring must be a JSON object' };
  }
  const version = raw.keyringVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version !== KEYRING_VERSION) {
    return {
      ok: false,
      reason: 'keyring-malformed',
      detail: `keyringVersion ${String(version)} is not supported (expected ${KEYRING_VERSION})`,
    };
  }

  let keys: TrustedFeedKey[];
  try {
    keys = parseKeyEntries(raw, 'keyring');
  } catch (err) {
    return { ok: false, reason: 'keyring-malformed', detail: (err as Error).message };
  }

  const sig = raw.signature;
  if (!isPlainObject(sig)) {
    return { ok: false, reason: 'keyring-unsigned', detail: 'keyring has no root signature' };
  }
  if (sig.algorithm !== 'ed25519' || typeof sig.kid !== 'string' || typeof sig.value !== 'string') {
    return {
      ok: false,
      reason: 'keyring-unsigned',
      detail: 'keyring signature must be {algorithm:"ed25519", kid, value}',
    };
  }

  const root = rootKeys.find((candidate) => candidate.kid === sig.kid);
  if (!root) {
    const known = rootKeys.map((candidate) => candidate.kid).join(', ') || '(none configured)';
    return {
      ok: false,
      reason: 'keyring-unknown-root',
      detail: `keyring root kid ${sig.kid} is not trusted; trusted roots: ${known}`,
    };
  }
  const validity = checkKeyValidity(root, opts.now ?? new Date());
  if (!validity.ok) return validity;

  const checked = verifySignature(
    dropSignature(raw),
    sig as unknown as { digest?: unknown; value: string },
    root.publicKeyPem,
  );
  if (!checked.ok) return { ok: false, reason: 'keyring-bad-signature', detail: checked.detail };

  return {
    ok: true,
    keys,
    root,
    ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
  };
}

/**
 * Built-in roots plus an optional operator-provided root file
 * (`CHANGEGUARD_FEED_ROOT_KEYS`). Local/private deployments use the file;
 * production clients rely on the built-in list.
 */
export function resolveRootKeys(): { keys: TrustedFeedKey[]; source: string } {
  const envPath = process.env.CHANGEGUARD_FEED_ROOT_KEYS;
  if (!envPath) return { keys: BUILTIN_ROOT_KEYS, source: 'built-in root keys' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(envPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read root keys from ${envPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const keys = parseKeyEntries(raw, `${envPath} (env)`);
  return { keys: [...BUILTIN_ROOT_KEYS, ...keys], source: `${envPath} (env) + built-in roots` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
