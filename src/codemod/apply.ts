/**
 * Deterministic codemod application.
 *
 * Only engine-emitted codemods (rename-method / rename-parameter) are applied,
 * using conservative line-scoped textual rules - never LLM-generated patches.
 * Each replacement is word-boundary checked and a unified diff is produced for
 * the draft PR. A file is only patched when every codemod for it fires at
 * least once; otherwise it is left untouched.
 */
import type { Finding, Language } from '../types.js';
import type { RepoSource } from '../source/repo-source.js';

export interface FilePatch {
  file: string;
  oldContent: string;
  newContent: string;
  diff: string;
  applied: {
    from: string;
    to: string;
    count: number;
    kind: 'rename-method' | 'rename-parameter';
    language?: Language;
  }[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Replace {
  from: string;
  to: string;
  kind: 'rename-method' | 'rename-parameter';
  language?: Language;
}

function applyOne(line: string, r: Replace): { text: string; count: number } {
  let count = 0;
  if (r.kind === 'rename-method') {
    const re = new RegExp(`\\.${escapeRegExp(r.from)}(?=\\s*[(<])`, 'g');
    const text = line.replace(re, () => {
      count++;
      return `.${r.to}`;
    });
    return { text, count };
  }
  // rename-parameter
  if (r.language === 'python') {
    // keyword argument: from_=  / from=
    const re = new RegExp(`\\b${escapeRegExp(r.from)}(?=\\s*=)`);
    const text = line.replace(re, () => {
      count++;
      return r.to;
    });
    return { text, count };
  }
  // JS/TS/Go object/struct key: from:
  const re = new RegExp(`\\b${escapeRegExp(r.from)}(?=\\s*:)`);
  const text = line.replace(re, () => {
    count++;
    return r.to;
  });
  return { text, count };
}

/**
 * Minimal unified diff (3 lines of context). Codemods only perform same-line
 * substitutions, so changed lines pair 1:1 as '-' / '+'.
 */
export function unifiedDiff(file: string, oldContent: string, newContent: string): string {
  const a = oldContent.split(/\r?\n/);
  const b = newContent.split(/\r?\n/);
  const changed: number[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) changed.push(i);
  if (changed.length === 0) return '';

  // merge changed indices into hunks when gaps are small
  const hunks: Array<[number, number]> = [];
  for (const idx of changed) {
    const last = hunks[hunks.length - 1];
    if (last && idx - last[1] <= 7) last[1] = idx;
    else hunks.push([idx, idx]);
  }

  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start0, end0] of hunks) {
    const ctx = 3;
    const sa = Math.max(0, start0 - ctx);
    const ea = Math.min(a.length, end0 + ctx + 1);
    out.push(`@@ -${sa + 1},${ea - sa} +${sa + 1},${ea - sa} @@`);
    for (let i = sa; i < ea; i++) {
      if (a[i] === b[i]) {
        out.push(` ${a[i] ?? ''}`);
      } else {
        out.push(`-${a[i] ?? ''}`);
        out.push(`+${b[i] ?? ''}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * Lines spanned by the call expression starting at `startIdx`: walk forward
 * tracking parenthesis depth (multiline arguments), capped at 15 lines.
 */
function callSpan(lines: string[], startIdx: number): [number, number] {
  let depth = 0;
  let started = false;
  const end = Math.min(lines.length, startIdx + 15);
  for (let i = startIdx; i < end; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '(') {
        depth++;
        started = true;
      } else if (ch === ')') depth--;
    }
    if (started && depth <= 0) return [startIdx, i];
  }
  return [startIdx, end - 1];
}

export function applyCodemods(
  file: string,
  content: string,
  findings: Finding[],
): FilePatch | undefined {
  // One entry per call site emitting a codemod (dedupe defensively).
  const jobs = new Map<string, Replace & { line: number }>();
  for (const f of findings) {
    if (!f.codemod || f.file !== file) continue;
    if (f.codemod.kind !== 'rename-method' && f.codemod.kind !== 'rename-parameter') continue;
    const key = `${f.codemod.kind}:${f.codemod.language ?? ''}:${f.codemod.from}->${f.codemod.to}@${f.line ?? 0}`;
    jobs.set(key, {
      from: f.codemod.from,
      to: f.codemod.to,
      kind: f.codemod.kind,
      language: f.codemod.language,
      line: f.line ?? 1,
    });
  }
  if (jobs.size === 0) return undefined;

  const lines = content.split(/\r?\n/);
  const totals = new Map<string, { count: number; r: Replace }>();

  for (const job of jobs.values()) {
    const [from, to] = callSpan(lines, Math.max(0, job.line - 1));
    let count = 0;
    for (let i = from; i <= to; i++) {
      const res = applyOne(lines[i]!, job);
      if (res.count > 0) {
        lines[i] = res.text;
        count += res.count;
      }
    }
    if (count > 0) {
      const tKey = `${job.kind}:${job.language ?? ''}:${job.from}->${job.to}`;
      const prev = totals.get(tKey);
      totals.set(tKey, { count: (prev?.count ?? 0) + count, r: job });
    }
  }
  const applied: FilePatch['applied'] = [];
  for (const { count, r } of totals.values()) {
    applied.push({ from: r.from, to: r.to, count, kind: r.kind, language: r.language });
  }

  if (applied.length === 0) return undefined;
  const newContent = lines.join(content.includes('\r\n') ? '\r\n' : '\n');
  return {
    file,
    oldContent: content,
    newContent,
    diff: unifiedDiff(file, content, newContent),
    applied,
  };
}

export async function buildPatches(source: RepoSource, findings: Finding[]): Promise<FilePatch[]> {
  const files = [...new Set(findings.filter((f) => f.codemod && f.file).map((f) => f.file!))];
  const patches: FilePatch[] = [];
  for (const file of files) {
    const content = await source.readText(file);
    if (typeof content !== 'string') continue;
    const patch = applyCodemods(file, content, findings);
    if (patch) patches.push(patch);
  }
  return patches;
}
