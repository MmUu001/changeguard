import { AstParser } from '../src/analyze/parser.js';
import { analyzeJavaScript } from '../src/analyze/js-analyzer.js';
import { buildAnalyzerIndex } from '../src/providers/registry.js';
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const p = new AstParser();
  const file = process.argv[2] ?? 'fixtures/sample-repo/src/billing.ts';
  const code = readFileSync(file, 'utf8');
  const root = await p.parse('javascript', code);
  const sites = analyzeJavaScript(root, code, file, 'typescript' as any, buildAnalyzerIndex());
  for (const s of sites) {
    console.log(
      `${s.line}  ${s.path}  keys={${s.argumentKeys.join(',')}} lits=${JSON.stringify(s.argumentLiterals)} refs={${s.memberRefs.join(',')}}`,
    );
  }
}
void main();
