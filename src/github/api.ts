/**
 * GitHub REST/Git Data API client: read a repository tree into a
 * VirtualRepoSource, open draft PRs from engine codemods, and file issues.
 */
import { fetchJson } from '../util/http.js';
import { VirtualRepoSource } from '../source/repo-source.js';
import { resolveToken } from './auth.js';
import type { FilePatch } from '../codemod/apply.js';

const API = 'https://api.github.com';

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export class GitHubClient {
  private constructor(private readonly token: string) {}

  static async forInstallation(installationId?: number): Promise<GitHubClient> {
    return new GitHubClient(await resolveToken(installationId));
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
  }

  async get<T>(path: string): Promise<T> {
    return fetchJson<T>(`${API}${path}`, { headers: this.headers() });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return fetchJson<T>(`${API}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: this.headers(),
    });
  }

  /** Read the whole tracked tree (default branch) as an in-memory source. */
  async fetchRepoSource(owner: string, repo: string, ref?: string): Promise<VirtualRepoSource> {
    const target = ref
      ? encodeURIComponent(ref)
      : (await this.get<{ default_branch: string }>(`/repos/${owner}/${repo}`)).default_branch;
    const tree = await this.get<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(target)}?recursive=1`,
    );
    if (tree.truncated) {
      // Deterministic limitation surfaced instead of silently missing files.
      throw new Error(`repository tree truncated by GitHub for ${owner}/${repo}; repo too large`);
    }
    const source = new VirtualRepoSource(`${owner}/${repo}@${target}`, new Map());
    const SKIP = /^(?:node_modules|vendor|\.changeguard|dist|build|out|coverage)\//;
    const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|json|txt|mod|toml|ya?ml|yaml)$/;
    const blobs = tree.tree.filter(
      (e) =>
        e.type === 'blob' &&
        !SKIP.test(e.path) &&
        SOURCE_EXT.test(e.path) &&
        (e.size ?? 0) < 500_000,
    );
    for (const entry of blobs) {
      const blob = await this.get<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
      );
      if (blob.encoding !== 'base64') continue;
      source.put(entry.path, Buffer.from(blob.content, 'base64').toString('utf8'));
    }
    return source;
  }

  /**
   * Create a branch, commit codemod patches, and open a DRAFT pull request.
   * All changes come from deterministic engine codemods only.
   */
  async openDraftPr(
    owner: string,
    repo: string,
    opts: { head: string; base: string; title: string; body: string; patches: FilePatch[] },
  ): Promise<{ number: number; html_url: string }> {
    const source = await this.fetchRepoSource(owner, repo, opts.base);
    const changed: { path: string; content: string }[] = [];
    for (const patch of opts.patches) {
      const original = source.readText(patch.file);
      if (original === undefined) continue;
      // Re-run the same deterministic transforms the FilePatch recorded.
      const reapplied = applyCodemodsToContent(original, patch);
      if (reapplied && reapplied !== original)
        changed.push({ path: patch.file, content: reapplied });
    }
    if (changed.length === 0) throw new Error('codemod patches produced no changes on remote');

    const baseRef = await this.get<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(opts.base)}`,
    );
    const baseSha = baseRef.object.sha;
    const baseTree = await this.get<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${baseSha}`,
    );

    const treeItems = await Promise.all(
      changed.map(async (c) => {
        const blob = await this.post<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
          content: c.content,
          encoding: 'utf-8',
        });
        return { path: c.path, mode: '100644', type: 'blob', sha: blob.sha };
      }),
    );
    const tree = await this.post<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree.tree.sha,
      tree: treeItems,
    });
    const commit = await this.post<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
      message: `chore(changeguard): apply breaking API renames

ChangeGuard deterministic codemods for ${changed.length} file(s).
Draft - requires human review for semantic changes.`,
      tree: tree.sha,
      parents: [baseSha],
    });
    try {
      await this.post(`/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${opts.head}`,
        sha: commit.sha,
      });
    } catch (err) {
      throw new Error(
        `failed to create branch ${opts.head} (it may already exist): ${(err as Error).message}`,
        { cause: err },
      );
    }
    return this.post(`/repos/${owner}/${repo}/pulls`, {
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body,
      draft: true,
    });
  }

  async createIssue(
    owner: string,
    repo: string,
    issue: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number; html_url: string }> {
    return this.post(`/repos/${owner}/${repo}/issues`, issue);
  }
}

/** Rebuild patched content deterministically: the FilePatch only carries a diff. */
function applyCodemodsToContent(original: string, patch: FilePatch): string | undefined {
  let content = original;
  for (const a of patch.applied) {
    if (a.kind === 'rename-method') {
      content = content.replace(new RegExp(`\\.${escapeRe(a.from)}(?=\\s*[(<])`, 'g'), `.${a.to}`);
    } else if (a.kind === 'rename-parameter') {
      const sep = a.language === 'python' ? '=' : ':';
      content = content.replace(new RegExp(`\\b${escapeRe(a.from)}(?=\\s*${sep})`, 'g'), a.to);
    }
  }
  return content === original ? undefined : content;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
