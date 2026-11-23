#!/usr/bin/env node
/**
 * Stripe sandbox self-check.
 *
 *   node scripts/stripe-check.mjs
 *
 * Reads the four env vars the server needs (STRIPE_SECRET_KEY,
 * STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM, STRIPE_WEBHOOK_SECRET) and verifies
 * each one against Stripe's API / local format rules. Read-only: it never
 * creates sessions, charges, or webhooks. Secrets are printed masked only.
 *
 * Exit 0 = all four are usable; exit 1 = at least one is missing or invalid.
 */
const REGISTRY_OK = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

const mask = (v) => (v && v.length > 8 ? `${v.slice(0, 8)}…${v.slice(-4)}` : '(unset)');

const env = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? '',
  pricePro: process.env.STRIPE_PRICE_PRO ?? '',
  priceTeam: process.env.STRIPE_PRICE_TEAM ?? '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
};

let failed = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const warn = (m) => console.log(`WARN  ${m}`);
const fail = (m) => {
  failed++;
  console.log(`FAIL  ${m}`);
};

/** Raw Stripe API GET with form-encoded auth (no SDK dependency). */
async function stripeGet(path, key) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

console.log('\n=== Stripe sandbox self-check ===\n');

// 1. Secret key
if (!env.secretKey) {
  fail('STRIPE_SECRET_KEY is not set');
} else if (!env.secretKey.startsWith('sk_test_')) {
  warn(
    `STRIPE_SECRET_KEY ${mask(env.secretKey)} is not a sk_test_ key — sandbox checklist expects test mode`,
  );
} else {
  const r = await REGISTRY_OK(() => stripeGet('/balance', env.secretKey));
  if (!r) fail('cannot reach api.stripe.com (network)');
  else if (r.status === 200)
    pass(`STRIPE_SECRET_KEY ${mask(env.secretKey)} valid (test mode, /v1/balance 200)`);
  else if (r.status === 401)
    fail(`STRIPE_SECRET_KEY ${mask(env.secretKey)} rejected by Stripe (401)`);
  else fail(`STRIPE_SECRET_KEY check returned HTTP ${r.status}`);
}

// 2 & 3. Prices
for (const [name, id] of [
  ['STRIPE_PRICE_PRO', env.pricePro],
  ['STRIPE_PRICE_TEAM', env.priceTeam],
]) {
  if (!id) {
    fail(`${name} is not set`);
    continue;
  }
  if (!id.startsWith('price_')) {
    fail(`${name} does not look like a price_... id (${mask(id)})`);
    continue;
  }
  if (!env.secretKey) {
    warn(`${name} format ok but cannot be verified without STRIPE_SECRET_KEY`);
    continue;
  }
  const r = await REGISTRY_OK(() => stripeGet(`/prices/${id}`, env.secretKey));
  if (!r) fail(`cannot verify ${name} (network)`);
  else if (r.status !== 200) fail(`${name} ${mask(id)} not found on Stripe (HTTP ${r.status})`);
  else if (!r.body.active) fail(`${name} ${mask(id)} exists but is INACTIVE`);
  else if (r.body.recurring?.interval !== 'month') {
    fail(
      `${name} ${mask(id)} is not a monthly recurring price (interval=${r.body.recurring?.interval ?? 'one_time'})`,
    );
  } else {
    const amount = r.body.unit_amount ? `$${(r.body.unit_amount / 100).toFixed(2)}` : '?';
    pass(`${name} ${mask(id)} valid (monthly ${amount}, active)`);
  }
}

// 4. Webhook secret
if (!env.webhookSecret) fail('STRIPE_WEBHOOK_SECRET is not set');
else if (!env.webhookSecret.startsWith('whsec_'))
  fail(`STRIPE_WEBHOOK_SECRET does not look like whsec_... (${mask(env.webhookSecret)})`);
else
  pass(
    `STRIPE_WEBHOOK_SECRET ${mask(env.webhookSecret)} format ok (verification is exercised by the webhook tests)`,
  );

console.log('');
if (failed > 0) {
  console.log(`=== ${failed} check(s) failed — see docs/stripe-sandbox.md ===`);
  process.exitCode = 1;
} else {
  console.log('=== all four Stripe settings usable — proceed with the sandbox checklist ===');
}
