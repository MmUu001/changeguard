/**
 * web-tree-sitter lifecycle. WASM grammars are used so there are no native
 * compilation requirements (important for Windows / CI).
 */
import { createRequire } from 'node:module';
import type { Language } from '../types.js';

const nodeRequire = createRequire(import.meta.url);

export interface TSNode {
  type: string;
  text: string;
  children: TSNode[];
  parent: TSNode | null;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName(name: string): TSNode | null;
  fieldNameForChild(index: number): string | null;
  /** web-tree-sitter nodes are wrappers; compare with equals(), not ===. */
  equals(other: TSNode): boolean;
}

interface TreeLike {
  rootNode: TSNode;
}

interface ParserLike {
  parse(input: string): TreeLike;
  setLanguage(lang: unknown): void;
}

interface ParserModule {
  Parser: { init(): Promise<void>; new (): ParserLike };
  Language: { load(file: string): Promise<unknown> };
}

let modPromise: Promise<ParserModule> | undefined;
async function getModule(): Promise<ParserModule> {
  if (!modPromise) {
    modPromise = import('web-tree-sitter').then((m) => {
      const anyMod = m as Record<string, unknown>;
      const Parser =
        (anyMod['Parser'] as ParserModule['Parser']) ??
        ((anyMod['default'] as Record<string, unknown>)?.['Parser'] as ParserModule['Parser']);
      const Language =
        (anyMod['Language'] as ParserModule['Language']) ??
        ((anyMod['default'] as Record<string, unknown>)?.['Language'] as ParserModule['Language']);
      return { Parser, Language };
    });
  }
  return modPromise;
}

export const EXTENSION_LANGUAGE: Record<string, Language> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  tsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
};

const GRAMMAR_FILES: Record<Language, string[]> = {
  javascript: ['tree-sitter-typescript.wasm', 'tree-sitter-javascript.wasm'],
  python: ['tree-sitter-python.wasm'],
  go: ['tree-sitter-go.wasm'],
};

export class AstParser {
  private parsers = new Map<Language, ParserLike>();

  private resolveWasm(file: string): string {
    for (const base of ['tree-sitter-wasms/out/', 'tree-sitter-wasms/']) {
      try {
        return nodeRequire.resolve(`${base}${file}`);
      } catch {
        /* try next */
      }
    }
    throw new Error(`Cannot locate grammar wasm: ${file}`);
  }

  async forLanguage(language: Language): Promise<ParserLike> {
    const cached = this.parsers.get(language);
    if (cached) return cached;
    const { Parser, Language: TSLanguage } = await getModule();
    await Parser.init();
    const candidates = GRAMMAR_FILES[language];
    let lastErr: unknown;
    for (const file of candidates) {
      try {
        const grammar = await TSLanguage.load(this.resolveWasm(file));
        const parser = new Parser();
        parser.setLanguage(grammar);
        this.parsers.set(language, parser);
        return parser;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Failed to load grammar for ${language}`);
  }

  async parse(language: Language, code: string): Promise<TSNode> {
    const parser = await this.forLanguage(language);
    return parser.parse(code).rootNode;
  }
}
