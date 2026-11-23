import { AstParser } from '../src/analyze/parser.js';

const lang = process.argv[2] as 'javascript' | 'python' | 'go';
const code = process.argv[3] ?? '';

const parser = new AstParser();
const root = await parser.parse(lang, code);

const fieldOf = (parent: any, child: any): string => {
  const out: string[] = [];
  // web-tree-sitter exposes childrenForFieldName? iterate candidate names via grammar-independent approach:
  for (const f of [
    'object',
    'property',
    'function',
    'arguments',
    'name',
    'clause',
    'source',
    'value',
    'left',
    'right',
    'field',
    'operand',
    'body',
    'key',
    'module_name',
    'path',
    'constructor',
    'alias',
    'pattern',
  ]) {
    if (parent.childForFieldName?.(f) === child) out.push(f);
  }
  return out.length ? `.${out.join('|')}` : '';
};

const walk2 = (n: any, depth = 0): void => {
  if (depth > 10) return;
  const f = n.parent ? fieldOf(n.parent, n) : '';
  const namedCount = n.childCount ?? n.children?.length;
  console.log(
    `${'  '.repeat(depth)}${n.type}${f} named=${namedCount} ${JSON.stringify(n.text.slice(0, 60))}`,
  );
  for (const c of n.children ?? []) walk2(c, depth + 1);
};
walk2(root);
