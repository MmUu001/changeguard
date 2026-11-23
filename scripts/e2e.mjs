/**
 * Zero-dependency end-to-end regression for the ChangeGuard console.
 *
 * Runs against a LIVE server (default http://localhost:8788 — start one with
 * `npm run dev`). Uses only Node built-ins: fetch, assert, node:test runner
 * semantics are avoided in favor of a plain sequential script with explicit
 * exit codes so CI output stays readable.
 *
 *   node scripts/e2e.mjs                 # against http://localhost:8788
 *   E2E_BASE_URL=http://localhost:9000 node scripts/e2e.mjs
 *   npm run e2e
 *
 * Coverage:
 *   1. healthz probe
 *   2. access control: unauthenticated redirects + 401s + wrong password
 *   3. login (form POST) -> session cookie
 *   4. trigger a scan against the bundled fixtures/sample-repo (202)
 *   5. poll GET /api/scans until the scan is persisted
 *   6. report page /reports/{id}.html renders DISPATCH elements
 *   7. dashboard HTML carries the intercept-log drawer + radar instrumentation
 *   8. /api/plans machine-readable catalog
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:8788').replace(/\/$/, '');
const PASSWORD = process.env.E2E_PASSWORD ?? 'cg-demo-2026';
const FIXTURE = fileURLToPath(new URL('../fixtures/sample-repo', import.meta.url));
const POLL_MS = 2000;
const POLL_TRIES = 90; // 3 minutes — first scan warms tree-sitter wasm

let cookie = '';
let passed = 0;

async function call(method, path, { form, jsonBody } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (jsonBody !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(jsonBody);
  }
  const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    cookie = cookie ? `${cookie}; ${pair}` : pair;
  }
  return res;
}

function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`E2E against ${BASE} (fixture: ${FIXTURE})`);

  // 1. healthz
  let res = await call('GET', '/healthz');
  assert.equal(res.status, 200, 'healthz should be 200');
  ok('healthz 200');

  // 2. access control
  res = await call('GET', '/');
  assert.equal(res.status, 303, 'unauthenticated / should redirect');
  assert.ok((res.headers.get('location') ?? '').includes('/login'), 'redirect target is /login');
  ok('unauthenticated / redirects to /login');

  res = await call('GET', '/api/scans');
  assert.equal(res.status, 401, 'unauthenticated /api/scans should be 401');
  ok('unauthenticated /api/scans 401');

  res = await call('POST', '/login', { form: { password: 'definitely-wrong' } });
  assert.equal(res.status, 401, 'wrong password should be 401');
  ok('wrong password 401');

  // 3. login
  res = await call('POST', '/login', { form: { password: PASSWORD } });
  assert.equal(res.status, 303, 'correct password should redirect');
  assert.ok(cookie, 'session cookie set');
  ok('login sets session cookie');

  // 4. trigger scan (old `since` so the bundled fixture yields findings)
  res = await call('POST', '/api/scans', {
    jsonBody: { repoPath: FIXTURE, since: '2020-01-01' },
  });
  assert.equal(res.status, 202, 'scan trigger should be accepted');
  const accepted = await res.json();
  assert.equal(accepted.accepted, true, 'scan accepted flag');
  ok(`scan accepted (repoPath=${accepted.repoPath}, since=${accepted.since})`);

  // 5. poll until persisted
  const deadline = Date.now() + POLL_TRIES * POLL_MS;
  let scan;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    res = await call('GET', '/api/scans');
    assert.equal(res.status, 200, 'GET /api/scans should be 200');
    const list = (await res.json()).scans ?? [];
    scan = list.find((s) => s.repoPath?.replace(/\\/g, '/') === FIXTURE.replace(/\\/g, '/'));
    if (scan) break;
  }
  assert.ok(scan, 'scan should appear in /api/scans within timeout');
  assert.equal(typeof scan.id, 'string', 'scan has id');
  assert.ok(scan.generatedAt, 'scan has generatedAt');
  assert.ok(scan.total >= 1, `fixture scan should yield findings (got total=${scan.total})`);
  ok(`scan persisted id=${scan.id} total=${scan.total} high=${scan.high} (${scan.durationMs}ms)`);

  // 6. report page
  res = await call('GET', `/reports/${scan.id}.html`);
  assert.equal(res.status, 200, 'report page should be 200');
  const html = await res.text();
  assert.ok(html.includes('DISPATCH'), 'report carries DISPATCH header');
  assert.ok(html.includes('barcode'), 'report carries fingerprint barcode');
  assert.ok(html.includes('SIG-'), 'report carries signal-numbered findings');
  ok('report page renders DISPATCH + barcode');

  // 7. dashboard instrumentation markup
  res = await call('GET', '/');
  assert.equal(res.status, 200, 'dashboard should be 200 when authed');
  const dash = await res.text();
  assert.ok(dash.includes('sigdrawer'), 'dashboard carries intercept-log drawer');
  assert.ok(dash.includes('renderLog'), 'dashboard carries renderLog script');
  assert.ok(dash.includes('buildRadar'), 'dashboard carries radar script');
  ok('dashboard HTML carries drawer + radar instrumentation');

  // 8. plan catalog
  res = await call('GET', '/api/plans');
  assert.equal(res.status, 200, 'GET /api/plans should be 200');
  const plans = (await res.json()).plans ?? [];
  assert.equal(plans.length, 3, 'three plans in catalog');
  assert.ok(
    plans.every((p) => typeof p.maxRepos === 'number' && typeof p.current === 'boolean'),
    'plan fields shaped',
  );
  ok('plan catalog returns 3 plans');

  console.log(`\nE2E OK — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\nE2E FAILED after ${passed} passed checks:\n${err.message}`);
  process.exit(1);
});
