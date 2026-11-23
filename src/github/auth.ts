/**
 * GitHub App authentication without third-party JWT libraries.
 * RS256 app JWTs are signed with node:crypto, then exchanged for
 * installation access tokens (cached until 5 minutes before expiry).
 */
import { createSign } from 'node:crypto';
import { fetchJson } from '../util/http.js';
import { config } from '../config.js';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppJwt(now = Math.floor(Date.now() / 1000)): string {
  const appId = config.github.appId;
  const key = config.github.privateKey;
  if (!appId || !key) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required for GitHub App auth');
  }
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

  const jwt = createAppJwt();
  const res = await fetchJson<{ token: string; expires_at: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      body: '',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  tokenCache.set(installationId, {
    token: res.token,
    expiresAt: Date.parse(res.expires_at),
  });
  return res.token;
}

/** Use a plain GITHUB_TOKEN when configured, otherwise App installation flow. */
export async function resolveToken(installationId?: number): Promise<string> {
  if (config.github.token) return config.github.token;
  if (installationId !== undefined) return getInstallationToken(installationId);
  throw new Error('No GitHub credentials: set GITHUB_TOKEN or GITHUB_APP_ID/GITHUB_PRIVATE_KEY');
}
