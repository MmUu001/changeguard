/**
 * Feed retrieval + verification. Retrieval never bypasses verification:
 * callers receive either a verified payload or a typed rejection and must
 * fall back on their own (see collectChanges in ./store.ts).
 *
 * Verification order is keyring first, then feed:
 *   1. load built-in root keys (+ CHANGEGUARD_FEED_ROOT_KEYS for local ops)
 *   2. load the signed keyring (file or URL) and verify its root signature
 *   3. only then verify the feed with the signing keys listed in that keyring
 * A keyring rejection stops the flow before the feed is even parsed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyFeed, type FeedPayload, type FeedRejectionReason } from './feed.js';
import { BUILTIN_FEED_KEYRING, resolveRootKeys, verifySignedKeyring } from './feed-keys.js';

export interface FeedSourceConfig {
  /** Local path or http(s) URL. */
  path: string;
  /** Signed keyring path or URL (alternative to CHANGEGUARD_FEED_KEYS). */
  trustedKeys?: string;
}

export type FeedLoadFailureReason = FeedRejectionReason | 'unreachable' | 'keyring';

export type FeedLoadOutcome =
  | {
      ok: true;
      payload: FeedPayload;
      kid: string;
      rootKid: string;
      keySource: string;
      sourceKind: 'file' | 'url';
    }
  | { ok: false; reason: FeedLoadFailureReason; detail: string };

export async function loadVerifiedFeed(cfg: FeedSourceConfig): Promise<FeedLoadOutcome> {
  let roots;
  try {
    roots = resolveRootKeys().keys;
  } catch (err) {
    return { ok: false, reason: 'keyring', detail: (err as Error).message };
  }

  let keyringRaw: unknown;
  let keyringSource = 'built-in signed keyring';
  try {
    if (cfg.trustedKeys) {
      keyringSource = cfg.trustedKeys;
      keyringRaw = await readJson(cfg.trustedKeys);
    } else if (process.env.CHANGEGUARD_FEED_KEYS) {
      keyringSource = `${process.env.CHANGEGUARD_FEED_KEYS} (env)`;
      keyringRaw = await readJson(process.env.CHANGEGUARD_FEED_KEYS);
    } else if (BUILTIN_FEED_KEYRING) {
      keyringSource = 'built-in signed keyring';
      keyringRaw = BUILTIN_FEED_KEYRING;
    } else {
      return {
        ok: false,
        reason: 'keyring',
        detail:
          'no trusted feed keyring configured; pass --trusted-keys or set CHANGEGUARD_FEED_KEYS ' +
          '(the keyring must be signed by a built-in root key)',
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'keyring',
      detail: `cannot read keyring ${keyringSource}: ${(err as Error).message}`,
    };
  }

  const keyring = verifySignedKeyring(keyringRaw, roots);
  if (!keyring.ok) return keyring;

  const isUrl = /^https?:\/\//i.test(cfg.path);
  let raw: unknown;
  try {
    raw = await readJson(cfg.path);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, reason: 'malformed', detail: `feed is not valid JSON: ${err.message}` };
    }
    return {
      ok: false,
      reason: 'unreachable',
      detail: `cannot read feed from ${cfg.path}: ${(err as Error).message}`,
    };
  }

  const result = verifyFeed(raw, keyring.keys);
  if (!result.ok) return result;
  return {
    ok: true,
    payload: result.payload,
    kid: result.key.kid,
    rootKid: keyring.root.kid,
    keySource: `${keyringSource} (root ${keyring.root.kid})`,
    sourceKind: isUrl ? 'url' : 'file',
  };
}

async function readJson(source: string): Promise<unknown> {
  const text = /^https?:\/\//i.test(source)
    ? await fetchText(source)
    : readFileSync(resolve(source), 'utf8');
  return JSON.parse(text);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return await response.text();
}
