/**
 * Draft pull-request body. The body is assembled deterministically from the
 * scan report and engine codemods; LLM prose never decides scope or severity.
 */
import type { ScanReport } from '../types.js';
import type { FilePatch } from '../codemod/apply.js';
import { renderPatchesSection, renderUpgradeChecklist } from './markdown.js';

export interface PrDraft {
  title: string;
  head: string;
  base: string;
  body: string;
  patches: FilePatch[];
}

export function draftPr(
  report: ScanReport,
  patches: FilePatch[],
  opts: { branch?: string; base?: string } = {},
): PrDraft {
  const high = report.summary.high;
  const medium = report.summary.medium;
  const title = `chore(changeguard): upgrade checklist for ${high} breaking / ${medium} other API changes`;
  const body: string[] = [];
  body.push(`## ChangeGuard 自动升级 PR（草稿）`);
  body.push('');
  body.push(
    `本 PR 由 ChangeGuard 针对 \`${report.repoName}\` 的扫描结果生成草稿。影响判定全部来自确定性规则（Tree-sitter 调用点 × 厂商变更 / OpenAPI diff / 版本约束），请在合并前逐项人工确认。`,
  );
  body.push('');
  body.push(
    `| 高风险 | 中风险 | 低风险 | 涉及文件 |\n|---|---|---|---|\n| ${report.summary.high} | ${report.summary.medium} | ${report.summary.low} | ${report.summary.filesAffected} |`,
  );
  body.push('');
  body.push(renderUpgradeChecklist(report));
  body.push('');

  if (patches.length) {
    body.push(renderPatchesSection(patches));
  }

  body.push('### 厂商参考');
  const seen = new Set<string>();
  for (const f of report.findings) {
    const key = f.changeId;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.change.sourceUrl)
      body.push(`- ${f.providerId}: ${f.change.title} — ${f.change.sourceUrl}`);
  }
  body.push('');
  body.push(
    '> ⚠️ 这是**草稿**：参数语义变更、枚举替换为新模型等场景需要人工调整；codemod 仅做官方声明的保守重命名。',
  );

  return {
    title,
    head: opts.branch ?? `changeguard/upgrade-${new Date().toISOString().slice(0, 10)}`,
    base: opts.base ?? 'main',
    body: body.join('\n'),
    patches,
  };
}
