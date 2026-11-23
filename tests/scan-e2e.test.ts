import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LocalRepoSource } from '../src/source/repo-source.js';
import { scanRepository } from '../src/scan.js';
import { templateExplain } from '../src/llm/explanation.js';
import { buildPatches } from '../src/codemod/apply.js';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown, renderUpgradeChecklist } from '../src/report/markdown.js';
import { draftPr } from '../src/report/pr-draft.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRepo = resolve(here, '../fixtures/sample-repo');

describe('end-to-end offline scan of sample-repo', () => {
  it('detects all five providers and produces deterministic findings', async () => {
    const source = new LocalRepoSource('sample-repo', fixtureRepo);
    const report = await scanRepository({
      source,
      repoPath: fixtureRepo,
      repoName: 'sample-repo',
      sinceISO: '2023-01-01',
      online: false,
      persist: false,
    });

    expect(report.mode).toBe('offline');
    expect([...report.detectedProviders].sort()).toEqual([
      'openai',
      'shopify',
      'stripe',
      'supabase',
      'twilio',
    ]);
    expect(report.callSiteCount).toBe(25);
    expect(report.changes.length).toBeGreaterThan(0);
    expect(report.summary.total).toBe(report.findings.length);
    expect(report.summary.high).toBeGreaterThan(0);
    expect(report.summary.filesAffected).toBe(3);

    const rules = new Set(report.findings.map((f) => f.ruleId));
    for (const r of ['R1', 'R5', 'R6', 'R7', 'R8'])
      expect(rules.has(r), `missing rule ${r}`).toBe(true);

    // every finding must carry a deterministic reason (LLM never decides)
    expect(report.findings.every((f) => f.reason.length > 0)).toBe(true);

    const codemods = report.findings.filter((f) => f.codemod);
    expect(codemods.some((f) => f.codemod!.from === 'statusCallback')).toBe(true);
    expect(codemods.some((f) => f.codemod!.from === 'status_callback')).toBe(true);
    expect(codemods.some((f) => f.codemod!.from === 'signIn')).toBe(true);
    expect(codemods.some((f) => f.codemod!.from === 'sign_in')).toBe(true);
  });

  it('template explanations, codemod patches and report artifacts are coherent', async () => {
    const source = new LocalRepoSource('sample-repo', fixtureRepo);
    const report = await scanRepository({
      source,
      repoPath: fixtureRepo,
      repoName: 'sample-repo',
      sinceISO: '2023-01-01',
      online: false,
    });
    for (const f of report.findings) f.explanation = templateExplain(f.change, f);
    expect(report.findings.every((f) => f.explanation?.source === 'template')).toBe(true);

    const patches = await buildPatches(source, report.findings);
    const patchText = patches.map((p) => p.diff).join('\n');
    expect(patchText).toContain('statusCallbackUrl');
    expect(patchText).toContain('status_callback_url');
    expect(patchText).toContain('signInWithPassword');
    expect(patchText).toContain('sign_in_with_password');

    const md = renderMarkdown(report);
    expect(md).toContain('ChangeGuard');
    expect(renderUpgradeChecklist(report)).toContain('- [ ]');

    const html = renderHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('application/json');
    // self-contained: no external resources
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=https?:/);

    const pr = draftPr(report, patches);
    expect(pr.head).toMatch(/^changeguard\/upgrade-/);
    expect(pr.body).toContain('草稿');
    expect(pr.patches.length).toBe(patches.length);
  });

  it('Go pipeline: go.mod deps, call sites and engine findings close the loop for main.go', async () => {
    const source = new LocalRepoSource('sample-repo', fixtureRepo);
    const report = await scanRepository({
      source,
      repoPath: fixtureRepo,
      repoName: 'sample-repo',
      sinceISO: '2023-01-01',
      online: false,
      persist: false,
    });

    // go.mod lists six Go deps across the five providers; every provider must
    // be recognized from the Go module paths alone.
    const goDeps = report.dependencies.filter((d) => d.ecosystem === 'go');
    expect(goDeps.length).toBeGreaterThanOrEqual(6);
    const providersFromGo = new Set(goDeps.map((d) => d.providerId).filter(Boolean));
    expect([...providersFromGo].sort()).toEqual([
      'openai',
      'shopify',
      'stripe',
      'supabase',
      'twilio',
    ]);

    // Engine findings on the Go call sites — deterministic, all language-tagged.
    const go = report.findings.filter((f) => f.language === 'go');
    expect(go.length).toBe(6);
    expect(go.every((f) => f.file === 'cmd/billing/main.go')).toBe(true);
    expect(go.every((f) => f.reason.length > 0)).toBe(true);

    const byLine = new Map(go.map((f) => [`${f.ruleId}:${f.line}`, f]));
    // Stripe legacy Charges/Sources: type reference + SetSource call.
    expect(byLine.has('R1:20')).toBe(true);
    expect(byLine.has('R1:21')).toBe(true);
    // Twilio Api.CreateMessage rename chain.
    expect(byLine.has('R1:33')).toBe(true);
    // Supabase Go query builder behavior change via From.Select.Execute.
    expect(byLine.has('R1:41')).toBe(true);
    // Raw HTTP to the sunset OpenAI /v1/edits endpoint (OpenAPI diff cross-hit).
    expect(byLine.has('R6:44')).toBe(true);

    // Deterministic boundary: codemods exist for JS/TS/Python only — Go
    // findings are reported without auto-fix.
    expect(go.every((f) => !f.codemod)).toBe(true);
  });

  it('only-matched view keeps findings anchored to a concrete file', async () => {
    const source = new LocalRepoSource('sample-repo', fixtureRepo);
    const full = await scanRepository({
      source,
      repoPath: fixtureRepo,
      repoName: 'sample-repo',
      sinceISO: '2023-01-01',
      online: false,
    });
    const only = await scanRepository({
      source,
      repoPath: fixtureRepo,
      repoName: 'sample-repo',
      sinceISO: '2023-01-01',
      online: false,
      onlyMatched: true,
    });
    expect(only.findings.every((f) => Boolean(f.file))).toBe(true);
    expect(only.summary.total).toBe(only.findings.length);
    expect(only.findings.length).toBeLessThanOrEqual(full.findings.length);
    // Severity counts must be consistent with the filtered list.
    const high = only.findings.filter((f) => f.severity === 'high').length;
    expect(only.summary.high).toBe(high);
  });
});
