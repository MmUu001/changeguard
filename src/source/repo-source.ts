import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Uniform read access to a repository - local disk or a remote GitHub tree. */
export interface RepoSource {
  readonly kind: 'local' | 'github';
  readonly label: string;
  /** POSIX-style relative paths. */
  listFiles(): string[] | Promise<string[]>;
  /** UTF-8 text, or undefined when the file is missing/binary. */
  readText(relPath: string): string | undefined | Promise<string | undefined>;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  '.changeguard',
  'site-packages',
  '.idea',
  '.vscode',
  'tmp',
  'temp',
]);

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1_500_000;

export class LocalRepoSource implements RepoSource {
  readonly kind = 'local' as const;
  private files: string[] | undefined;

  constructor(
    public readonly label: string,
    private readonly rootDir: string,
  ) {}

  private walk(dir: string, acc: string[]): void {
    if (acc.length > MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        this.walk(abs, acc);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        const rel = relative(this.rootDir, abs).split(sep).join('/');
        acc.push(rel);
      }
    }
  }

  listFiles(): string[] {
    if (!this.files) {
      const acc: string[] = [];
      this.walk(resolve(this.rootDir), acc);
      this.files = acc;
    }
    return this.files;
  }

  readText(relPath: string): string | undefined {
    try {
      return readFileSync(join(this.rootDir, relPath), 'utf8');
    } catch {
      return undefined;
    }
  }
}

/** In-memory source backed by a path->content map (used by tests / GitHub trees). */
export class VirtualRepoSource implements RepoSource {
  readonly kind = 'github' as const;
  constructor(
    public readonly label: string,
    private readonly files: Map<string, string>,
  ) {}

  listFiles(): string[] {
    return [...this.files.keys()];
  }

  readText(relPath: string): string | undefined {
    return this.files.get(relPath);
  }

  put(path: string, content: string): void {
    this.files.set(path, content);
  }
}
