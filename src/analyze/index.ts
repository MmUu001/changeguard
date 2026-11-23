import type { CallSite, Language } from '../types.js';
import type { RepoSource } from '../source/repo-source.js';
import { AstParser, EXTENSION_LANGUAGE } from './parser.js';
import type { AnalyzerIndex } from './rules.js';
import { buildAnalyzerIndex } from '../providers/registry.js';
import { analyzeJavaScript } from './js-analyzer.js';
import { analyzePython } from './py-analyzer.js';
import { analyzeGo } from './go-analyzer.js';
import { logger } from '../util/logger.js';

export interface AnalysisResult {
  sites: CallSite[];
  errors: string[];
  filesParsed: number;
  filesSkipped: number;
}

const MAX_SOURCE_BYTES = 400_000;

/**
 * Parse every source file in the repository and extract third-party
 * API/SDK call sites. Files are parsed independently; a syntax error in one
 * file never aborts the scan.
 */
export async function analyzeRepository(
  source: RepoSource,
  analyzerIndex: AnalyzerIndex = buildAnalyzerIndex(),
): Promise<AnalysisResult> {
  const parser = new AstParser();
  const files = await source.listFiles();
  const sites: CallSite[] = [];
  const errors: string[] = [];
  let filesParsed = 0;
  let filesSkipped = 0;

  // Warm all three grammars up front so failures surface once.
  const languages = new Set<Language>();
  for (const file of files) {
    const ext = file.split('.').pop()?.toLowerCase();
    const lang = ext ? EXTENSION_LANGUAGE[ext] : undefined;
    if (lang) languages.add(lang);
  }
  for (const lang of languages) {
    try {
      await parser.forLanguage(lang);
    } catch (err) {
      errors.push(`grammar:${lang}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const file of files) {
    const ext = file.split('.').pop()?.toLowerCase();
    const lang = ext ? EXTENSION_LANGUAGE[ext] : undefined;
    if (!lang) continue;
    if (errors.some((e) => e.startsWith(`grammar:${lang}:`))) {
      filesSkipped++;
      continue;
    }
    const code = await source.readText(file);
    if (typeof code !== 'string' || code.length > MAX_SOURCE_BYTES) {
      filesSkipped++;
      continue;
    }
    // skip obvious generated/minified blobs
    if (code.includes('// !') || /\n[^\n]{4000,}/.test(code)) {
      filesSkipped++;
      continue;
    }
    try {
      const root = await parser.parse(lang, code);
      const found =
        lang === 'javascript'
          ? analyzeJavaScript(root, code, file, lang, analyzerIndex)
          : lang === 'python'
            ? analyzePython(root, code, file, analyzerIndex)
            : analyzeGo(root, code, file, analyzerIndex);
      sites.push(...found);
      filesParsed++;
    } catch (err) {
      logger.debug(`parse failed: ${file}: ${err instanceof Error ? err.message : String(err)}`);
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // deterministic order: file, line, path
  sites.sort((a, b) =>
    a.file === b.file
      ? a.line === b.line
        ? a.path.localeCompare(b.path)
        : a.line - b.line
      : a.file.localeCompare(b.file),
  );
  return { sites, errors, filesParsed, filesSkipped };
}
