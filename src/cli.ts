#!/usr/bin/env node
/**
 * ChangeGuard CLI — Apache-2.0 entrypoint.
 *
 *   demo                  offline end-to-end run against the bundled fixture
 *   scan <path>           scan a local repository
 *   pr-preview <path>     dry-run PR draft
 *   pr-open <owner/repo>  open a draft PR with codemod patches
 *
 * Hosted-service commands (serve, tenant, key, plan, audit, bind-installation)
 * live in the proprietary `cli-admin.ts` extension. It is loaded dynamically;
 * when the extension is absent the CLI registers unavailable stubs so the
 * Apache-2.0-only distribution still runs the scan commands normally.
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './scan.js';
import { enrichReport, templateExplain } from './llm/explanation.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { draftPr } from './report/pr-draft.js';
import { buildPatches } from './codemod/apply.js';
import { LocalRepoSource } from './source/repo-source.js';
import { config } from './config.js';
import { logger } from './util/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

interface WriteResult {
  outDir: string;
  files: string[];
}

interface ArtifactOptions {
  since: string;
  online: boolean;
  useLlm: boolean;
  feed?: string;
  trustedKeys?: string;
  onlyMatched?: boolean;
}

async function writeArtifacts(
  repoPath: string,
  outDir: string,
  opts: ArtifactOptions,
): Promise<WriteResult> {
  const source = new LocalRepoSource(repoPath.split(/[\\/]/).pop() ?? repoPath, repoPath);
  const report = await scanRepository({
    source,
    repoPath,
    repoName: source.label,
    sinceISO: opts.since,
    online: opts.online,
    feed: opts.feed ? { path: opts.feed, trustedKeys: opts.trustedKeys } : undefined,
    onlyMatched: opts.onlyMatched,
  });
  if (opts.useLlm) await enrichReport(report);
  else {
    // deterministic template explanations, no network
    for (const f of report.findings) f.explanation = templateExplain(f.change, f);
  }
  const patches = await buildPatches(source, report.findings);
  const pr = draftPr(report, patches);

  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, content: string): void => {
    writeFileSync(join(outDir, name), content);
    files.push(name);
  };
  put('report.json', JSON.stringify(report, null, 2));
  put('report.md', renderMarkdown(report));
  put('report.html', renderHtml(report));
  put('pr-body.md', pr.body);
  put(
    'codemod.patch',
    patches
      .map((p) => p.diff)
      .filter(Boolean)
      .join('\n'),
  );
  return { outDir, files };
}

function printSummary(reportPath: string, files: string[]): void {
  const report = JSON.parse(readFileSync(join(reportPath, 'report.json'), 'utf8')) as {
    summary: { total: number; high: number; medium: number; low: number; filesAffected: number };
    detectedProviders: string[];
    callSiteCount: number;
    dependencies: unknown[];
    changes: unknown[];
    mode: string;
  };
  logger.info('');
  logger.info('──────────────── ChangeGuard ────────────────');
  logger.info(`mode=${report.mode} providers=${report.detectedProviders.join(',')}`);
  logger.info(
    `deps=${report.dependencies.length} callSites=${report.callSiteCount} vendorChanges=${report.changes.length}`,
  );
  logger.info(
    `findings=${report.summary.total} HIGH=${report.summary.high} MEDIUM=${report.summary.medium} LOW=${report.summary.low} filesAffected=${report.summary.filesAffected}`,
  );
  logger.info(`artifacts: ${files.map((f) => join(reportPath, f)).join('\n           ')}`);
  logger.info('─────────────────────────────────────────────');
}

/**
 * CLI version from package.json. Previously hard-coded as '0.1.0', which made
 * `changeguard --version` lie about every release since 0.2.0. Resolves from
 * both src/ (tsx) and dist/ alike — both sit one level below the package root.
 */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();
program
  .name('changeguard')
  .description('Detect breaking third-party API/SDK changes that affect your code')
  .version(cliVersion());

program
  .command('demo')
  .description('Run the full offline pipeline against the bundled sample repository')
  .option('--out <dir>', 'output directory', join(process.cwd(), '.changeguard/out'))
  .action(async (opts: { out: string }) => {
    const fixture = join(PKG_ROOT, 'fixtures', 'sample-repo');
    if (!existsSync(fixture)) throw new Error(`fixture not found: ${fixture}`);
    const { outDir, files } = await writeArtifacts(fixture, resolve(opts.out), {
      since: '2023-01-01',
      online: false,
      useLlm: false,
    });
    printSummary(outDir, files);
  });

program
  .command('scan')
  .argument('<path>', 'repository path')
  .description('Scan a local repository for breaking API/SDK changes')
  .option('--since <iso>', 'only include vendor changes since this ISO date')
  .option('--online', 'fetch GitHub releases / changelog pages (cache 6h)', false)
  .option('--feed <path|url>', 'signed change feed; verified records replace the bundled snapshot')
  .option(
    '--trusted-keys <file>',
    'keyring with trusted feed public keys (default: env or built-in)',
  )
  .option('--out <dir>', 'write JSON/Markdown/HTML/PR artifacts to this directory')
  .option('--json', 'print the raw ScanReport JSON to stdout', false)
  .option(
    '--only-matched',
    'only findings anchored to a concrete file (drop repo/dependency advisories)',
    false,
  )
  .option('--no-llm', 'disable LLM explanations even if LLM_API_KEY is set')
  .action(
    async (
      path: string,
      opts: {
        since?: string;
        online: boolean;
        feed?: string;
        trustedKeys?: string;
        out?: string;
        json: boolean;
        onlyMatched: boolean;
        llm: boolean;
      },
    ) => {
      const repoPath = resolve(path);
      const since = opts.since ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      const feed = opts.feed ? { path: opts.feed, trustedKeys: opts.trustedKeys } : undefined;
      if (opts.out) {
        const { outDir, files } = await writeArtifacts(repoPath, resolve(opts.out), {
          since,
          online: opts.online,
          useLlm: opts.llm,
          feed: opts.feed,
          trustedKeys: opts.trustedKeys,
          onlyMatched: opts.onlyMatched,
        });
        printSummary(outDir, files);
        return;
      }
      const report = await scanRepository({
        repoPath,
        sinceISO: since,
        online: opts.online,
        feed,
        onlyMatched: opts.onlyMatched,
      });
      if (opts.llm && config.llm.enabled) await enrichReport(report);
      else {
        for (const f of report.findings) f.explanation = templateExplain(f.change, f);
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2));
      } else {
        process.stdout.write(renderMarkdown(report));
      }
    },
  );

// ---------------- proprietary admin extension ----------------
//
// Loaded dynamically so the Apache-2.0 CLI keeps working without it. The
// extension owns serve/tenant/key/plan/audit/bind-installation and all imports
// of src/server/** and src/store/**.

interface AdminModule {
  registerAdminCommands(program: Command): void;
}

const ADMIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'serve', description: 'Start the GitHub App webhook receiver' },
  { name: 'tenant', description: 'Manage tenants (multi-tenant admin)' },
  { name: 'key', description: 'Manage tenant API keys' },
  {
    name: 'plan',
    description: 'Set a tenant plan manually (free|pro|team, no Stripe involved)',
  },
  { name: 'bind-installation', description: 'Bind a GitHub App installation to a tenant' },
  { name: 'audit', description: 'Query the audit log' },
];

function isMissingModule(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function registerUnavailableAdminCommands(target: Command): void {
  for (const spec of ADMIN_COMMANDS) {
    target
      .command(spec.name)
      .argument('[args...]', 'arguments for the proprietary command')
      .description(`${spec.description} (proprietary distribution only)`)
      .allowUnknownOption(true)
      .action(() => {
        logger.error(
          `The "${spec.name}" command belongs to the proprietary ChangeGuard server distribution and is not included in this Apache-2.0 CLI package.`,
        );
        logger.error(
          'Scan commands (demo, scan, pr-preview, pr-open) work without it. See LICENSE-PROPRIETARY for details.',
        );
        process.exit(1);
      });
  }
}

async function registerAdminCommands(): Promise<void> {
  try {
    const mod = (await import('./cli-admin.js')) as AdminModule;
    mod.registerAdminCommands(program);
  } catch (err) {
    if (!isMissingModule(err)) throw err;
    registerUnavailableAdminCommands(program);
  }
}

await registerAdminCommands();

program
  .command('pr-preview')
  .argument('<path>', 'repository path')
  .description('Dry-run: show the draft PR that would be created (no GitHub API calls)')
  .option('--since <iso>', 'only include vendor changes since this ISO date')
  .option('--base <branch>', 'base branch for the PR', 'main')
  .option('--feed <path|url>', 'signed change feed; verified records replace the bundled snapshot')
  .option(
    '--trusted-keys <file>',
    'keyring with trusted feed public keys (default: env or built-in)',
  )
  .action(
    async (
      path: string,
      opts: { since?: string; base: string; feed?: string; trustedKeys?: string },
    ) => {
      const repoPath = resolve(path);
      const since = opts.since ?? new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
      const source = new LocalRepoSource(repoPath.split(/[\\/]/).pop() ?? repoPath, repoPath);
      const report = await scanRepository({
        source,
        repoPath,
        repoName: source.label,
        sinceISO: since,
        online: false,
        persist: false,
        feed: opts.feed ? { path: opts.feed, trustedKeys: opts.trustedKeys } : undefined,
      });
      for (const f of report.findings) f.explanation = templateExplain(f.change, f);
      const patches = await buildPatches(source, report.findings);
      const pr = draftPr(report, patches);

      const branch = `changeguard/upgrade-${Date.now().toString(36)}`;
      logger.info('');
      logger.info('══════════ ChangeGuard PR Preview (dry-run) ══════════');
      logger.info(`base branch : ${opts.base}`);
      logger.info(`head branch : ${branch}`);
      logger.info(`title       : ${pr.title}`);
      logger.info(
        `findings    : ${report.summary.total} (H${report.summary.high}/M${report.summary.medium}/L${report.summary.low})`,
      );
      logger.info(`files to patch: ${patches.length}`);
      for (const p of patches) {
        logger.info(`  - ${p.file}  (${p.applied.length} codemod(s))`);
      }
      logger.info('');
      logger.info('── PR body ──');
      process.stdout.write(pr.body + '\n');
      logger.info('');
      logger.info('── unified diff ──');
      const diff = patches
        .map((p) => p.diff)
        .filter(Boolean)
        .join('\n');
      process.stdout.write((diff || '(no codemod patches — nothing to commit)') + '\n');
      logger.info('');
      logger.info(
        patches.length > 0
          ? `To actually open this draft PR, run with GITHUB_TOKEN set and use the webhook/serve flow.`
          : `No automatic patches available. Review report for manual migration steps.`,
      );
    },
  );

program
  .command('pr-open')
  .argument('<owner/repo>', 'GitHub repository to file a draft PR against')
  .description('Scan a remote repo and open a DRAFT pull request with codemod patches')
  .option('--since <iso>', 'only include vendor changes since this ISO date')
  .option('--base <branch>', 'base branch for the PR (auto-detects main/master if unset)')
  .option(
    '--installation <id>',
    'GitHub App installation id (falls back to GITHUB_TOKEN or tokenless)',
  )
  .option('--feed <path|url>', 'signed change feed; verified records replace the bundled snapshot')
  .option(
    '--trusted-keys <file>',
    'keyring with trusted feed public keys (default: env or built-in)',
  )
  .action(
    async (
      ownerRepo: string,
      opts: {
        since?: string;
        base?: string;
        installation?: string;
        feed?: string;
        trustedKeys?: string;
      },
    ) => {
      const m = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
      if (!m) throw new Error('argument must be in owner/repo form (e.g. stripe/stripe-node)');
      const owner = m[1]!;
      const repo = m[2]!;
      const since = opts.since ?? new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);

      const { GitHubClient } = await import('./github/api.js');
      const client = await GitHubClient.forInstallation(
        opts.installation ? Number(opts.installation) : undefined,
      );

      // Resolve base branch — explicit flag wins, otherwise probe main → master.
      let base: string = opts.base ?? '';
      if (!base) {
        for (const candidate of ['main', 'master']) {
          try {
            await client.get(`/repos/${owner}/${repo}/git/ref/heads/${candidate}`);
            base = candidate;
            break;
          } catch {
            /* try next */
          }
        }
        if (!base) throw new Error(`could not detect base branch for ${owner}/${repo}`);
      }

      logger.info(`fetching ${owner}/${repo} (base=${base})…`);
      const source = await client.fetchRepoSource(owner, repo, base);
      const report = await scanRepository({
        source,
        repoPath: ownerRepo,
        repoName: `${owner}/${repo}`,
        sinceISO: since,
        online: false,
        persist: false,
        feed: opts.feed ? { path: opts.feed, trustedKeys: opts.trustedKeys } : undefined,
      });
      for (const f of report.findings) f.explanation = templateExplain(f.change, f);

      if (report.findings.length === 0) {
        logger.info(`no breaking API changes affect ${owner}/${repo} — skipping PR`);
        return;
      }
      const patches = await buildPatches(source, report.findings);
      const pr = draftPr(report, patches, { base });
      const result = await client.openDraftPr(owner, repo, {
        head: pr.head,
        base,
        title: pr.title,
        body: pr.body,
        patches,
      });
      logger.info('');
      logger.info('══════════ ChangeGuard DRAFT PR opened ══════════');
      logger.info(`repo        : ${owner}/${repo}`);
      logger.info(`head branch : ${pr.head}`);
      logger.info(
        `findings    : ${report.summary.total} (H${report.summary.high}/M${report.summary.medium}/L${report.summary.low})`,
      );
      logger.info(`files patched: ${patches.length}`);
      logger.info(`PR #${result.number}: ${result.html_url}`);
    },
  );

program
  .command('mcp')
  .description('run as an MCP server over stdio (Claude Code / Cursor / VS Code / Cline)')
  .action(async () => {
    // Dynamic import: plain scan/demo invocations never load the MCP module.
    const { runMcpServer } = await import('./mcp/index.js');
    await runMcpServer();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
  // On Windows with Node >= 24, a synchronous process.exit() while tree-sitter
  // WASM / SQLite handles are still closing trips a libuv assertion
  // (src/win/async.c) and dies with 0xC0000409 instead of exiting 1. Prefer a
  // natural exit (process.exitCode above); the unref'd timer below only fires
  // when a resident handle keeps the loop alive, as a bounded fallback.
  setTimeout(() => process.exit(1), 100).unref();
});
