/**
 * Quick analyzer smoke check: npx tsx scripts/smoke.ts [path]
 * Prints every call site found in a file or repository.
 */
import { resolve } from 'node:path';
import { AstParser, EXTENSION_LANGUAGE } from '../src/analyze/parser.js';
import { analyzeRepository } from '../src/analyze/index.js';
import { LocalRepoSource } from '../src/source/repo-source.js';

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? 'fixtures/sample-repo');
  const source = new LocalRepoSource(target, target);
  const result = await analyzeRepository(source);

  if (process.argv[3] === '--tree') {
    const file = process.argv[2]!;
    const ext = file.split('.').pop()!;
    const lang = EXTENSION_LANGUAGE[ext]!;
    const parser = new AstParser();
    const code = source.readText(file)!;
    const root = await parser.parse(lang, code);
    const dump = (n: any, depth = 0): void => {
      if (depth > 6) return;
      console.log(
        `${'  '.repeat(depth)}${n.type} [${n.startPosition.row}] ${JSON.stringify(n.text.slice(0, 40))}`,
      );
      for (const c of n.children) dump(c, depth + 1);
    };
    dump(root);
    return;
  }

  for (const s of result.sites) {
    const keys = s.argumentKeys.length ? ` keys={${s.argumentKeys.join(',')}}` : '';
    const lits = Object.keys(s.argumentLiterals).length
      ? ` lits=${JSON.stringify(s.argumentLiterals)}`
      : '';
    const refs = s.memberRefs.length ? ` refs={${s.memberRefs.join(',')}}` : '';
    const http = s.http ? ` http=${s.http.method}` : '';
    console.log(
      `${s.providerId?.padEnd(9)} ${s.language.padEnd(10)} ${s.file}:${s.line}  ${s.path}${keys}${lits}${refs}${http}`,
    );
  }
  console.log(
    `\nparsed=${result.filesParsed} skipped=${result.filesSkipped} sites=${result.sites.length}`,
  );
  if (result.errors.length) console.log('errors:', result.errors);
}

void main();
