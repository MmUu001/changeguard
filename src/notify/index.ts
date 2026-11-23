/**
 * Notification dispatch: Slack incoming webhook, SMTP email (smtps://),
 * and GitHub issues. Every channel is optional; the runner never fails a
 * scan because a notification is unconfigured.
 */
import { type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { config } from '../config.js';
import { fetchText } from '../util/http.js';
import { logger } from '../util/logger.js';
import type { ScanReport } from '../types.js';
import { renderMarkdown } from '../report/markdown.js';
import { GitHubClient } from '../github/api.js';

export async function notifySlack(webhookUrl: string, report: ScanReport): Promise<void> {
  const s = report.summary;
  const lines = [
    `*ChangeGuard 变更哨兵 — ${report.repoName}*`,
    `🔴 高风险 ${s.high} · 🟡 中 ${s.medium} · ⚪ 低 ${s.low} · 文件 ${s.filesAffected}`,
  ];
  const high = report.findings.filter((f) => f.severity === 'high').slice(0, 10);
  for (const f of high) {
    lines.push(`• [${f.providerId}] ${f.change.title} — ${f.file ?? 'repo'}:${f.line ?? ''}`);
  }
  if (report.findings.length > high.length)
    lines.push(`…另有 ${report.findings.length - high.length} 项`);
  await fetchText(webhookUrl, {
    method: 'POST',
    body: JSON.stringify({ text: lines.join('\n') }),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Minimal SMTPS client (implicit TLS, port 465) with AUTH LOGIN.
 * Enough for transaction providers (SendGrid/Mailgun/SES SMTP/Gmail).
 */
export async function sendEmail(
  to: string[],
  subject: string,
  body: string,
  smtpUrl = config.smtpUrl,
): Promise<void> {
  if (!smtpUrl) throw new Error('SMTP_URL is not configured (expected smtps://user:pass@host:465)');
  const url = new URL(smtpUrl);
  if (url.protocol !== 'smtps:') throw new Error(`unsupported mail protocol: ${url.protocol}`);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const from = user;
  const port = Number(url.port || 465);

  const socket = tlsConnect({ host: url.hostname, port, servername: url.hostname });
  try {
    await eventOnce(socket, 'secureConnect');
    await expectCode(socket, 220);
    await cmd(socket, `EHLO changeguard`, 250);
    await cmd(socket, 'AUTH LOGIN', 334);
    await cmd(socket, Buffer.from(user).toString('base64'), 334);
    await cmd(socket, Buffer.from(pass).toString('base64'), 235);
    await cmd(socket, `MAIL FROM:<${from}>`, 250);
    for (const rcpt of to) await cmd(socket, `RCPT TO:<${rcpt}>`, 250);
    await cmd(socket, 'DATA', 354);
    const message = [
      `From: ChangeGuard <${from}>`,
      `To: ${to.join(', ')}`,
      `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '.',
    ].join('\r\n');
    await cmd(socket, message, 250);
    await cmd(socket, 'QUIT', 221).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

function eventOnce(emitter: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(event, () => resolve());
    emitter.once('error', reject);
  });
}

function readReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      const lines = text.trim().split(/\r?\n/);
      const last = lines[lines.length - 1] ?? '';
      if (/^\d{3}\s/.test(last)) {
        socket.off('data', onData);
        socket.off('error', onErr);
        resolve(last);
      }
    };
    const onErr = (err: Error): void => reject(err);
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function expectCode(socket: Socket, code: number): Promise<string> {
  const reply = await readReply(socket);
  if (!reply.startsWith(String(code))) throw new Error(`SMTP expected ${code}, got: ${reply}`);
  return reply;
}

async function cmd(socket: Socket, text: string, code: number): Promise<string> {
  socket.write(`${text}\r\n`);
  return expectCode(socket, code);
}

export async function notifyEmail(report: ScanReport): Promise<void> {
  if (config.emailTo.length === 0) throw new Error('EMAIL_TO is not configured');
  const s = report.summary;
  await sendEmail(
    config.emailTo,
    `[ChangeGuard] ${report.repoName}: ${s.high} high / ${s.medium} medium API changes`,
    renderMarkdown(report),
  );
}

export interface IssueTarget {
  owner: string;
  repo: string;
  installationId?: number;
}

/**
 * Stable short string derived from the findings set — used to distinguish
 * "same repo same batch" from "same repo new batch" so we don't erroneously
 * reuse an older issue that referenced a different breaking API change.
 */
function findingsHash(report: ScanReport): string {
  const ids = report.findings
    .map((f) => f.changeId)
    .filter(Boolean)
    .sort();
  let hash = 0;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(6, '0');
}

/** Open (or reuse) a GitHub issue carrying the Markdown report.
 *
 *  Marker is `<!-- changeguard:<repo>:<since>:<hash> -->`. The hash covers the
 *  change IDs — if a previous scan of the same repo produced a different
 *  findings batch we open a new issue instead of silently appending to an
 *  outdated one.
 */
export async function notifyGitHubIssue(
  report: ScanReport,
  target: IssueTarget,
): Promise<{ number: number; html_url: string } | undefined> {
  const client = await GitHubClient.forInstallation(target.installationId);
  const marker = `<!-- changeguard:${report.repoName}:${report.since ?? 'all'}:${findingsHash(report)} -->`;
  const open = await client.get<
    Array<{ number: number; title: string; body?: string; html_url: string }>
  >(`/repos/${target.owner}/${target.repo}/issues?state=open&per_page=50`);
  const existing = open.find((i) => i.body?.includes(marker));
  if (existing) {
    logger.info(
      `GitHub issue #${existing.number} already exists for ${target.owner}/${target.repo}`,
    );
    return { number: existing.number, html_url: existing.html_url };
  }
  const s = report.summary;
  return client.createIssue(target.owner, target.repo, {
    title: `ChangeGuard: ${s.high} high / ${s.medium} medium breaking API changes detected`,
    body: `${marker}\n\n${renderMarkdown(report)}`,
    labels: ['changeguard', 'dependencies'],
  });
}

/** Fire every configured channel; collect failures as logs, never throw. */
export async function dispatchNotifications(
  report: ScanReport,
  issueTarget?: IssueTarget,
): Promise<void> {
  if (config.slackWebhookUrl) {
    try {
      await notifySlack(config.slackWebhookUrl, report);
    } catch (err) {
      logger.warn(`Slack notification failed: ${(err as Error).message}`);
    }
  }
  if (config.smtpUrl && config.emailTo.length) {
    try {
      await notifyEmail(report);
    } catch (err) {
      logger.warn(`Email notification failed: ${(err as Error).message}`);
    }
  }
  if (issueTarget) {
    try {
      await notifyGitHubIssue(report, issueTarget);
    } catch (err) {
      logger.warn(`GitHub issue failed: ${(err as Error).message}`);
    }
  }
}
