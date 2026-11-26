# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.7.0] - 2026-11-19

### Added

- MCP server (`changeguard mcp` / `changeguard-mcp` bin): the deterministic
  scan engine is now reachable by agents over stdio JSON-RPC. Three read-only
  tools — `list_breaking_changes`, `check_impact` (file:line impact with rule
  ids), `get_feed_status` (explicit provenance for citation) — with
  agent-friendly Markdown output, zero dependencies, and zero kernel changes
  (`persist:false`, `online:false`). Safety is structural: absolute-path
  validation with an optional `CHANGEGUARD_MCP_ALLOWED_ROOTS` allow-list, 30s
  scan timeout, stdout carries protocol frames only (diagnostics on stderr),
  BOM-tolerant framing. Implemented as the legacy handshake era
  (2025-06-18): every current mainstream client probes `server/discover` then
  falls back to `initialize`, so it is reachable everywhere; the 2026-07-28
  stateless era is a follow-up. Publish gate now hard-fails when the tarball
  omits `dist/mcp/*` (the local-works / packaged-missing class of bug).
  `docs/mcp.md` documents the tool contracts, three client configs and the
  read-only/offline guarantees. 15 MCP tests (protocol + tools + e2e).

Nothing yet.

## [0.6.1] - 2026-11-17

### Added

- Performance baseline in README (measured on synthetic repos, dist form):
  100 files/200 call sites in 0.75s, 500/1000 in 0.84s, 2000/4000 in 1.99s —
  marginal cost ≈0.65ms/file. Reproducible via `scripts/gen-synth-repo.ts`
  (mixed TS/Py/Go generator mimicking the fixture call shapes).
- Maintenance-mode declaration at v0.6.0: bug and security fixes only, new
  features require real user demand.

### Fixed

- `changeguard --version` reports the real package version. It had been
  hard-coded as `0.1.0` for five releases (0.2.0–0.6.0 all claimed 0.1.0),
  caught by installing the 0.6.0 tarball into a clean prefix. The version now
  resolves from package.json (from src/ and dist/ alike), with a regression
  test that runs the CLI and compares against package.json.

## [0.6.0] - 2026-11-16

### Added

- Audit-log retention: `purgeAuditLogs(retentionDays)` plus scheduler wiring
  (`CHANGEGUARD_AUDIT_RETENTION_DAYS`, default 90, 0 disables). Runs once at
  boot and every 24h, independently of scan scheduling. The data-policy page
  now states 90-day rotation instead of "kept until deletion".
- Self-service tenant deletion: `DELETE /api/tenant` (owner session or the
  local no-password mode; exact-tenant-name confirmation required; API keys
  refused with 403) backed by a single-transaction `deleteTenantData` that
  removes scans/reports, API keys, installations, audit rows, memberships,
  settings and the tenant row, returning per-table counts. The console
  Settings page gained a SEC-04 danger-zone panel. Verified end-to-end in
  local mode; 6 new tests, 187 total.

### Changed

- R3 parameter findings skip feature-kind changes. A feature note ("new
  parameter available") is an update-log entry, not a risk signal; R9
  already excluded feature changes for the same reason. Measured effect: the
  18 LOW findings in an online `--only-matched` view drop to zero (26
  findings → 8; HIGH 3 / MEDIUM 5 / LOW 0). The offline baseline reading
  45 → 44 for the same release is the correct consequence of R9 aggregation
  (a same-provider medium+low pair merged into one medium: 35+9+1 →
  35+9+0), not a regression — no test pins the total.
- Title fallback also rejects generic section headers (`Breaking changes`,
  `Change type`, `Changelog`, `Release notes`, `What's changed` …) and keeps
  scanning the entry body for a substantive line. Also documented: the
  ingest layer caches **parsed** records for 6h, so parser changes require
  clearing `.changeguard/cache` before re-verification (the first re-run
  looked unchanged for exactly this reason).

### Added

- `changeguard scan --only-matched`: keep only findings anchored to a
  concrete file (call-site hits). Repo-level advisories (R9) and
  dependency-level pins (R7) drop out of this view; filtering happens before
  every count so summary and artifacts stay consistent. Verified online:
  26 findings → 19, all file-anchored, HIGH 3 → 1 (the two R7 pins correctly
  excluded).

### Fixed

- Release-note titles: entries headed by a version tag (`### v7.44.0`),
  a date-style name (`2026-08-25`, `2026-09-30.endive`) or punctuation
  (`### -`) now fall back to the first substantive body line, so reports no
  longer show findings titled "v7.44.0". Meaningful headings stay untouched,
  output is clamped to 140 chars, and slug/id generation follows the fixed
  title. Verified against a live online scan: advisory titles now carry the
  actual change text ("Make id, sessionId and sessionToken required…").

### Changed

- R9 repo advisories are now aggregated per provider instead of one finding
  per un-matched change. Measured on a real online scan: 59 findings → 8
  (86% fewer), with the three genuinely matched HIGH findings no longer
  buried under 45 per-change "may affect this repository" entries. Each
  advisory keeps the information: un-matched count, kind breakdown
  (breaking / deprecation / behavior), the three latest titles, and a
  "+N more" tail. Severity logic is unchanged — a group containing any
  un-matched breaking change stays `medium`, deprecation/behavior-only
  groups are `low`. The representative change (newest breaking, else newest)
  still drives the report's change detail.

### Added

- `scripts/backup-to.ps1` + `docs/backup.md`: one-command bundle backup to
  removable media (`-AutoUsb` finds the USB drive, creates the bundle,
  copies, verifies with `git bundle verify`, keeps the newest 3) plus a
  documented restore drill (clone from bundle → npm ci → test). The script
  is pure ASCII on purpose — Windows PowerShell 5.1 parses BOM-less UTF-8
  as ANSI and breaks the parser otherwise.
- `SECURITY.md` with a vulnerability disclosure process (3-day ack, 7-day
  triage, 30/90-day fix windows), in/out of scope, and the fail-closed
  design notes reviewers need. The privacy policy already cited it — now
  the file exists.

### Changed

- CI now enforces the linters that were configured but never wired up: every
  push and PR runs `npm run lint` (ESLint flat config) and
  `npm run format:check`. `npm run check:fast` (typecheck + lint +
  format:check) and `npm run check` (+ tests) reproduce the same gate locally
  before pushing.
- `format` and `format:check` now pass an explicit path (`.`). Prettier 3
  rejects a path-less invocation (`No parser and no file path given`), so the
  check had been failing on its own arguments instead of validating the repo.
- `.prettierignore` also covers `.changeguard/`, `coverage/` and `backups/`:
  runtime artifacts and generated reports are not repository sources, and
  scanning them would make the check depend on whatever was last generated.

### Fixed

- Prettier violations in `docker-compose.yml`, `docker-compose.multi.yml` and
  `tests/node-sqlite-shim.mjs` (formatting only, no behavior change).

## [0.5.0] - 2026-11-14

### Added

- `docs/stripe-sandbox.md` — Stripe test-mode onboarding & verification
  checklist (7 items, each mapped to the implementing code; notes that
  `config.stripe.enabled` depends on the webhook secret alone).
- `docs/trial-playbook.md` — the 3–5 real-user trial script that turns the
  CRL evidence gap into first-hand data: target personas, 30-minute script,
  a 5-question feedback form (false-positive rate, novel findings,
  forwarding intent, price anchor) and a mandatory feedback-log template.
- Legal pages: `/privacy`, `/terms`, `/data-policy` — public (whitelisted in
  UNPROTECTED, served on a locked console), reachable from the login page and
  the pricing footer. Content is grounded in the actual storage schema
  (users/memberships/scans/reports/audit_log/api_keys + stateless HMAC
  sessions): API keys stored hashed, report payloads carry code snippets,
  LLM is disclosed as an optional third-party processor, self-service scan
  deletion documented (`DELETE /api/scans/:id`), account/tenant deletion via
  the contact mailbox in 30 days, plus an explicit "draft, not legal advice"
  notice. A locked-console test proves whitelisting (legal pages 200 while
  other paths 303-redirect). 6 new tests; 174 total.

### Added

- `npm run feed:refresh` — seed refresh tool (`scripts/refresh-seeds.ts`).
  Pulls release notes for every provider SDK repo (default since
  2025-01-01), filters to actionable kinds (breaking / deprecation /
  behavior), deduplicates cross-language SDK duplicates (version banner
  normalized), and separates records that carry **match anchors**
  (non-empty `operations[].sdkPaths` or `renames`) from metadata-only
  records. `--apply` appends only anchored, id-new records to
  `data/changes/<provider>.seed.json`; anchors are never guessed — records
  without one are reported for manual API-surface annotation. Dry run by
  default. Observed on 2026-11-14: 87 actionable records -> ~80 unique,
  only a handful anchored (note-parser extracts sdkPaths from explicit
  field-level release text); the rest need human annotation. Anonymous
  GitHub API allows 60 requests/hour — set `GITHUB_TOKEN` for a full run.

### Added

- Structured logging. `CHANGEGUARD_LOG_FORMAT=json` switches the logger to
  one JSON object per line (`t`, `level`, `msg`); the human format stays the
  default. Every HTTP request runs inside an AsyncLocalStorage context, so
  all 47 existing logger call sites automatically carry `requestId` (plus
  `tenantId`/`actor` once auth resolves, and `method`/`path`) with zero
  signature changes — async continuations and scans enqueued from a request
  keep the context. The server mints a UUID per request (or honors an
  inbound `X-Request-Id` from a proxy) and echoes it in the `X-Request-Id`
  response header. JSON mode also emits one access line per request
  (`access GET /path 200`), skipping `/healthz`, `/favicon.ico` and
  `/metrics`. 8 new tests; 168 total.

### Added

- Data-driven provider registry. Each vendor is now a JSON manifest in
  `data/providers/<id>.json` (file stem must equal the id), loaded and
  strictly validated at startup by `loadProviderManifests()` /
  `validateProviderManifest()`. Adding a vendor is a data change with zero
  code edits: package/host matching, three-language analyzer rules and
  online change sources all derive from the manifest. Validation is
  fail-fast and names the offending file and field (unknown
  ecosystem/language, malformed `githubReleases`, stem/id mismatch, invalid
  JSON, empty directory). `providerForPackage` / `providerForHost` /
  `buildAnalyzerIndex` accept an injectable provider list for tests and
  custom deployments. The five built-ins migrate to manifests with behavior
  unchanged (pinned by `tests/providers.test.ts`, 16 new cases).

## [0.4.0] - 2026-11-13

### Fixed

- `GET /favicon.ico` now answers 204 instead of 404, keeping the browser
  console clean (the real favicon lives with the out-of-repo marketing site).
- The login terminal header shows the server version from package.json
  (it was hard-coded as v0.2 and already stale).

### Changed

- Design docs reality check: the blueprint (`docs/design-plan.md`) drifted
  behind the code after P2 — the server-rendered pages (dashboard / pricing /
  auth) moved from the phosphor-green v1 tokens to the purple Sonar tokens,
  and the pricing page had already been unified into the v2 language (SEC
  section numbering, intercept-log style tier rows, STANDING BY stamp). The
  blueprint now carries a §8 evolution record marking the drift, and P5's
  "inline monospace font" is resolved as **won't do** (system monospace stack
  is sufficient; a base64 woff2 would break the single-file report budget).
- The monospace font stack across all server-rendered pages is unified to
  `ui-monospace, "Cascadia Code", Consolas, monospace` (32 occurrences in
  dashboard.ts / pricing.ts / auth.ts previously mixed a shorter stack).

### Added

- Prometheus metrics: `GET /metrics` serves the standard text exposition
  format (zero dependencies, process-local registry in `util/metrics.ts` so
  the Apache-2.0 `llm/` modules can record without touching the proprietary
  boundary). Counters: scans by result, scan duration (count/sum/last),
  findings by severity, LLM explanations and template fallbacks by reason
  (error / safety-filter / scan-cap / kill-switch); gauges: scan queue depth
  and uptime. Fail-closed: the endpoint returns 404 unless
  `CHANGEGUARD_METRICS_TOKEN` is configured, 401 on a wrong token
  (constant-time comparison); Bearer auth or `?token=` both accepted.
- Go pipeline e2e coverage: `tests/scan-e2e.test.ts` pins the full Go chain
  (go.mod provider attribution → tree-sitter call sites → engine findings)
  with six deterministic findings on `cmd/billing/main.go`, and documents the
  boundary that Go findings carry no codemods (auto-fix is JS/TS/Python).
- Console open-PR endpoint error-path tests (`tests/open-pr.test.ts`): 404
  unknown scan, 400 non-GitHub repoPath, 400 missing installation binding,
  and 502 `GitHub PR failed: …` when credentials are missing (offline).

### Fixed

- `providerForPackage` now compares package names case-insensitively on both
  sides. Registry entries mix case for Go module paths
  (`github.com/Shopify/go-shopify`), so a `go.mod` depending on it was not
  attributed to the Shopify provider while all other Go paths were. Go
  dependencies now resolve for all five providers.

## [0.3.0] - 2026-11-13

### Security

- LLM explanation hardening. The LLM prompt now explicitly warns that facts
  (coming from potentially malicious feeds or changelogs) are untrusted data
  and any text that looks like an instruction must be treated as content, not
  as a command the model should follow.
- LLM output safety filters. `migrationSteps` returned by the LLM are filtered
  against a blacklist of dangerous shell patterns (`curl|sh`, `wget|sh`,
  `rm -rf`, `eval`, `bash -c`, `powershell -Enc`, ...) and silently dropped
  when any match is found. Remaining steps are capped at 5 items of 500 chars
  each; `summary` is capped at 500 chars.
- LLM rate limiting. Per-scan cap of 50 distinct changes reach the LLM pipeline
  (rest fall back to template); process-wide per-hour hard cap (default 200)
  prevents runaway spend when a malicious feed floods findings; at most 3
  parallel LLM calls share the semaphore.
- Runtime LLM kill-switch. `CHANGEGUARD_DISABLE_LLM=1` is hot-loaded from
  `process.env` on every LLM decision point — no process restart needed to
  flip the whole pipeline to template mode during an incident response.
- Reports mark LLM-written content. The HTML report renders a blue
  `🤖 AI 生成，仅供参考` badge next to explanations whose `source === 'llm'`;
  the Markdown report already distinguishes `说明（LLM）` from
  `说明（模板）`.

### Changed

- Licensing is now dual: the standalone CLI and scanner are Apache-2.0
  (`LICENSE`), while the hosted server, tenant/billing storage, console and
  deployment packaging remain proprietary (`LICENSE-PROPRIETARY`, which also
  defines the path-level boundary and the rules for mixed directories).
  `package.json` declares `"license": "Apache-2.0"`.
- The CLI is split at the license boundary: `serve`, `tenant`, `key`, `plan`,
  `audit` and `bind-installation` moved to the proprietary `src/cli-admin.ts`.
  `src/cli.ts` now contains no import of `src/server/**` or `src/store/**` and
  registers unavailable stubs with the same command names when the extension
  is absent (Apache-2.0-only distribution). Command names, arguments, output
  and exit codes are unchanged when the extension is present.
- The npm package is constrained by a `files` allowlist in `package.json`: it
  ships only the Apache-2.0 portion, so `dist/server/**`, `dist/store/**`,
  `dist/cli-admin.*` and the Docker files never enter the tarball.

### Added

- Signed change feeds (feed v1): an ed25519-signed JSON envelope
  (`{feedVersion, publisher, generatedAt, records, signature}`) verified with
  Node's built-in `crypto` (no new dependencies). Signatures cover the
  canonical JSON of everything except `signature`, so later publishers can add
  fields without breaking older clients. `scan`, `pr-preview` and `pr-open`
  accept `--feed <path|url>` and `--trusted-keys <file>`; verification is
  fail-closed (missing signature, unknown `kid`, retired key, tampered payload
  all reject the feed). See `docs/feed.md`.
- Two-layer feed trust: long-lived root keys built into the package
  (`BUILTIN_ROOT_KEYS`, several allowed for root rotation) sign a keyring
  (`{keyringVersion, generatedAt?, keys[], signature}`), and only after that
  root signature verifies are the signing keys listed in the keyring
  (`kid`, public key, optional `notBefore` / `retiresAt`) trusted for feeds.
  Signing-key rotation therefore only re-signs a keyring — already-installed
  CLIs accept it without a release; root rotation ships a CLI release that
  trusts both roots during the overlap. Keyrings may be fetched over
  `http(s)` because the root signature is checked locally.
  `CHANGEGUARD_FEED_KEYS` / `CHANGEGUARD_FEED_ROOT_KEYS` select a keyring and
  extra roots by environment. `BUILTIN_ROOT_KEYS` and `BUILTIN_FEED_KEYRING`
  now carry bootstrap keys (root public key + signed keyring generated
  2026-11-13, private keys stay outside the repository); re-run the key
  ceremony in an isolated environment and rotate before serving external
  users (see `docs/feed.md` for the checklist).
- Strict feed mode: `CHANGEGUARD_FEED_STRICT=1` turns any verification failure
  (including keyring rejections) into a non-zero exit with no fallback; the
  default stays "error + warn + fall back to the bundled snapshot, exit 0".
  CI pipelines must enable it, otherwise a failure silently degrades to stale
  data.
- New rejection reasons: `keyring-malformed`, `keyring-unsigned`,
  `keyring-unknown-root`, `keyring-bad-signature`, and `not-yet-valid` for
  keys before their `notBefore` (retirement keeps using `retired-key`;
  `keyring` covers unreadable root files and a missing keyring).
- `scripts/feed-keyring.ts` (npm `feed:keyring`) signs a keyring with a root
  key and self-checks it against the root public key.
- `scripts/feed-keygen.ts` generates an ed25519 key pair into a git-ignored
  `.keys/` directory (private key mode 0600; refuses paths inside the
  repository that git does not ignore). `scripts/feed-sign.ts` signs the
  bundled snapshot or an explicit `--records` file. npm scripts
  `feed:keygen` / `feed:sign` wrap both.
- `tests/feed.test.ts` covers canonical serialization stability, sign→verify,
  tampered payload, missing signature, unknown `kid`, unsupported version,
  keyring root-signature acceptance/rejection (tampered bytes, unknown root,
  unsigned, unsupported version), signing-key rotation with `notBefore` /
  `retiresAt`, and keyring `kid`/key mismatch.
- `tests/cli-admin.test.ts` pinning the proprietary admin command surface
  (tenant / key / audit subcommands).
- `tests/license-boundary.test.ts` guards the Apache-2.0 boundary: no
  `server`/`store` imports in `src/cli.ts` (comments excluded) and no
  proprietary path can match the `files` allowlist in `package.json`. It also
  asserts the CLI resources (dist, `data/`, `fixtures/`, both license files)
  are still shipped. The check is static, so it needs no network.

### Fixed

- The CLI now exits 1 cleanly instead of crashing with 0xC0000409 on Windows
  with Node >= 24 when a command fails while tree-sitter WASM / SQLite handles
  are still closing: the synchronous `process.exit(1)` in the top-level catch
  tripped a libuv assertion (`src/win/async.c`). Affected paths include
  `CHANGEGUARD_FEED_STRICT=1` rejecting a feed. The failure exit is now
  `process.exitCode` plus a natural drain, with a bounded unref'd timer as
  fallback.
- Scans no longer warn `failed to persist scan … Cannot find module` in the
  Apache-2.0-only build. A missing `store/sqlite` module is treated as
  "persistence not available" and skipped silently; real write failures are
  still reported.

## [0.2.0] - 2026-11-07

### Changed

- **Security: fail-closed defaults.** The console and JSON API now require
  authentication by default; when neither `CHANGEGUARD_CONSOLE_PASSWORD` nor
  GitHub OAuth is configured the console returns 503 with setup instructions
  instead of serving the implicit local tenant. Local development opts out
  explicitly with `CHANGEGUARD_ALLOW_ANONYMOUS_CONSOLE=1`.
- `POST /webhook` now rejects payloads that cannot be verified when
  `GITHUB_WEBHOOK_SECRET` is unset (previously accepted). Dev opt-in:
  `CHANGEGUARD_ALLOW_UNSIGNED_WEBHOOK=1`.
- Session cookies no longer fall back to a hard-coded secret. An unset
  `CHANGEGUARD_SESSION_SECRET` generates a random per-process secret, so
  sessions end on restart; set the variable in production.

### Added

- Login rate limiting: 10 attempts per client IP per 15 minutes, then 429 with
  `Retry-After`.
- `Secure` session cookies when the request arrives over TLS (or via a trusted
  proxy's `X-Forwarded-Proto`), plus `CHANGEGUARD_SECURE_COOKIES` to force it.
- Baseline security response headers: CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS over TLS.
- `CHANGEGUARD_TRUST_PROXY` for reverse-proxy deployments (per-client rate
  limiting and `Secure` cookies).
- `tests/security.test.ts` covering fail-closed defaults, signature
  verification, session secret, rate limiting and cookie attributes.

## [0.1.0] - 2026-11-07

First tagged baseline. Everything below is the state of the repository at this tag.

### Added

- Deterministic scanning engine: 9 rules (R1-R9) over 5 providers (Stripe, OpenAI,
  Shopify, Twilio, Supabase) across JavaScript/TypeScript, Python and Go.
- Tree-sitter (WASM) based parsing with zero native build dependencies.
- Artifacts per scan: `report.json`, `report.md`, `report.html`, `pr-body.md`,
  `codemod.patch`.
- CLI: `scan`, `demo`, `serve`, `pr-open <owner/repo>`, `github pr`.
- Multi-tenant control plane: tenants, hashed API keys, HMAC session cookies,
  GitHub OAuth SSO, Stripe Checkout and webhook plan sync, quota gating (HTTP 402),
  audit log, usage export (CSV/JSON), `/pricing` page.
- Plan limits: free (2 repos / 10 scans), pro (25 repos / 500 scans), team
  (100 repos / 5000 scans).
- Notification channels: GitHub Issue (deduplicated by findings hash), draft
  pull request, Slack webhook, SMTP email.
- GitHub App webhook receiver (`installation`, `installation_repositories`, `push`) with
  HMAC-SHA256 signature verification.
- Scheduler for periodic re-scans, plus a bounded task queue.
- Console: scan history with per-scan Issue / PR links, repo management, API key
  management, and the two HTML manuals with full-text search.
- Docker support: `Dockerfile` (node:22-bookworm-slim) and single- / multi-instance
  `docker-compose` files.

### Known gaps

- No signed change feed: seeds are hand-maintained and untrusted-by-default.
- SQLite is single-writer, so the multi-instance compose file is only safe with
  the app-ro replica read-only.
