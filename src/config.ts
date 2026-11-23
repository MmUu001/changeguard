import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader (no external dependency). */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

/** Env booleans accept 1/true/yes/on. Everything else (including unset) is false. */
function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

function pemFromValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('BEGIN')) return value.replace(/\\n/g, '\n');
  const p = resolve(value);
  try {
    if (statSync(p).isFile()) return readFileSync(p, 'utf8');
  } catch {
    /* fall through */
  }
  return undefined;
}

export const config = {
  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    /** Runtime kill-switch for LLM-based explanations. When set, every finding
     *  falls back to the deterministic template without any network call.
     *  Useful to shut off LLM spending or respond to a prompt-injection incident. */
    disabled: envFlag(process.env.CHANGEGUARD_DISABLE_LLM),
    /** Hard cap on LLM calls per hour per process. 0 = unlimited (not recommended).
     *  Prevents runaway spending when a malicious feed floods findings. */
    maxCallsPerHour: Number(process.env.CHANGEGUARD_LLM_MAX_CALLS_PER_HOUR || 200),
    get enabled(): boolean {
      return Boolean(this.apiKey);
    },
  },
  github: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: pemFromValue(process.env.GITHUB_PRIVATE_KEY),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    token: process.env.GITHUB_TOKEN || '',
  },
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  smtpUrl: process.env.SMTP_URL || '',
  emailTo: (process.env.EMAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  port: Number(process.env.PORT || 8787),
  cacheDir: resolve(process.cwd(), process.env.CHANGEGUARD_CACHE_DIR || '.changeguard/cache'),
  dbPath: resolve(process.cwd(), process.env.CHANGEGUARD_DB_PATH || '.changeguard/changeguard.db'),
  /** Cron-style interval for scheduled scans, in hours. 0 disables. */
  scanIntervalHours: Number(process.env.CHANGEGUARD_SCAN_INTERVAL_HOURS || 24),
  /** Comma-separated repo paths to scan on schedule (local dirs or owner/repo). */
  scheduledRepos: (process.env.CHANGEGUARD_SCHEDULED_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // ---- commercial (phase 3) ----
  /** When set, the console + JSON API require a session or API key. */
  consolePassword: process.env.CHANGEGUARD_CONSOLE_PASSWORD || '',
  /** Audit-log retention in days (default 90; 0 disables rotation). */
  auditRetentionDays: (() => {
    const raw = process.env.CHANGEGUARD_AUDIT_RETENTION_DAYS;
    if (raw === undefined || raw === '') return 90;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 90;
  })(),
  /** HMAC secret for session cookies. When unset a random secret is generated
   *  per process (sessions then do not survive a restart). Set this in production. */
  sessionSecret: process.env.CHANGEGUARD_SESSION_SECRET || '',
  // ---- security escape hatches (default OFF: fail-closed) ----
  /** Dev only: serve the console without any credentials. */
  allowAnonymousConsole: envFlag(process.env.CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE),
  /** Dev only: accept GitHub webhooks whose signature cannot be verified. */
  allowUnsignedWebhook: envFlag(process.env.CHANGEGUARD_ALLOW_UNSIGNED_WEBHOOK),
  /** CI mode: any signed-feed verification failure exits non-zero (no fallback). */
  feedStrict: envFlag(process.env.CHANGEGUARD_FEED_STRICT),
  /** Behind a reverse proxy that sets X-Forwarded-Proto / X-Forwarded-For. */
  trustProxy: envFlag(process.env.CHANGEGUARD_TRUST_PROXY),
  /** Force the `Secure` attribute on session cookies (TLS terminates upstream). */
  secureCookies: envFlag(process.env.CHANGEGUARD_SECURE_COOKIES),
  stripe: {
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    pricePro: process.env.STRIPE_PRICE_PRO || '',
    priceTeam: process.env.STRIPE_PRICE_TEAM || '',
    get enabled(): boolean {
      return Boolean(this.webhookSecret);
    },
  },
  githubOAuth: {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
    get enabled(): boolean {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
};
