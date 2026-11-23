/**
 * Deterministic Markdown rendering of a ScanReport.
 * Used for CLI output, PR bodies and notification payloads.
 */
import type { ScanReport, Severity } from '../types.js';
import type { FilePatch } from '../codemod/apply.js';

const SEV_EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟡', low: '⚪' };

export function renderMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# ChangeGuard 变更影响报告 — ${report.repoName}`);
  lines.push('');
  lines.push(
    `> 生成时间 ${report.generatedAt} · 模式 **${report.mode}** · 变更起始 ${report.since ?? '-'}`,
  );
  lines.push('');
  lines.push(
    `- 依赖 **${report.dependencies.length}** 个 · 监控厂商 **${report.detectedProviders.length}** 家 · 调用点 **${report.callSiteCount}** 个`,
  );
  lines.push(
    `- 影响发现 **${report.summary.total}**：${SEV_EMOJI.high} 高 ${report.summary.high} · ${SEV_EMOJI.medium} 中 ${report.summary.medium} · ${SEV_EMOJI.low} 低 ${report.summary.low} · 涉及文件 ${report.summary.filesAffected}`,
  );
  lines.push('');

  const byProvider = new Map<string, typeof report.findings>();
  for (const f of report.findings) {
    const list = byProvider.get(f.providerId) ?? [];
    list.push(f);
    byProvider.set(f.providerId, list);
  }

  for (const [provider, findings] of [...byProvider.entries()].sort()) {
    lines.push(`## ${provider}（${findings.length}）`);
    lines.push('');
    for (const f of findings) {
      const loc = f.file ? `\`${f.file}:${f.line ?? '?'}\`` : '_仓库级_';
      lines.push(`### ${SEV_EMOJI[f.severity]} [${f.severity.toUpperCase()}] ${f.change.title}`);
      lines.push('');
      lines.push(`- 位置：${loc}${f.callPath ? ` · 调用 \`${f.callPath}\`` : ''}`);
      lines.push(`- 判定规则：**${f.ruleId}**（${f.match}，置信度 ${f.confidence}）`);
      if (f.codemod) {
        lines.push(`- 自动修复：\`${f.codemod.from}\` → \`${f.codemod.to}\``);
      }
      if (f.change.sourceUrl) lines.push(`- 厂商公告：${f.change.sourceUrl}`);
      if (f.explanation) {
        lines.push(
          `- 说明（${f.explanation.source === 'llm' ? 'LLM' : '模板'}）：${f.explanation.summary}`,
        );
        if (f.explanation.migrationSteps.length) {
          lines.push('- 迁移建议：');
          for (const step of f.explanation.migrationSteps) lines.push(`  1. ${step}`);
        }
      } else if (f.change.migration) {
        lines.push(`- 迁移建议：${f.change.migration}`);
      }
      if (f.codeSnippet) {
        const lang = f.language === 'python' ? 'python' : f.language === 'go' ? 'go' : 'ts';
        lines.push('');
        lines.push('```' + lang);
        lines.push(f.codeSnippet);
        lines.push('```');
      }
      lines.push('');
    }
  }

  if (report.errors.length) {
    lines.push('## 解析错误');
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_本报告由确定性规则（AST 调用点匹配 + OpenAPI diff + 版本规则）生成；LLM 仅负责文字解释，不参与任何影响判定。_',
  );
  return lines.join('\n');
}

export function renderUpgradeChecklist(report: ScanReport): string {
  const lines: string[] = ['## 升级清单', ''];
  const seen = new Set<string>();
  for (const f of report.findings) {
    const key = f.changeId;
    if (seen.has(key)) continue;
    seen.add(key);
    const ownerCount = report.findings.filter((x) => x.changeId === key && x.file).length;
    lines.push(
      `- [ ] **${f.providerId}** ${f.change.title}（${f.change.kind}，${ownerCount} 处代码命中）`,
    );
  }
  return lines.join('\n');
}

export function renderPatchesSection(patches: FilePatch[]): string {
  if (patches.length === 0) return '';
  const lines: string[] = ['## 自动 Codemod 补丁（草稿）', ''];
  for (const p of patches) {
    lines.push(`### ${p.file}`);
    for (const a of p.applied) lines.push(`- \`${a.from}\` → \`${a.to}\`（${a.count} 处）`);
    lines.push('');
    lines.push('```diff');
    lines.push(p.diff);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}
