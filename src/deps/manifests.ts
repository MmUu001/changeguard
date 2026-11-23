/**
 * Deterministic manifest parsing for npm (package.json), PyPI
 * (requirements.txt style) and Go modules (go.mod).
 */
import type { Dependency, Ecosystem } from '../types.js';
import type { RepoSource } from '../source/repo-source.js';
import { concreteFromSpec } from '../util/versions.js';

function dep(
  ecosystem: Ecosystem,
  name: string,
  spec: string | undefined,
  manifest: string,
  dev: boolean,
  line?: number,
  indirect = false,
): Dependency {
  return {
    ecosystem,
    name,
    spec,
    version: concreteFromSpec(spec),
    dev,
    indirect,
    manifest,
    line,
  };
}

export function parsePackageJson(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return out;
  }
  const buckets: Array<[string, boolean]> = [
    ['dependencies', false],
    ['optionalDependencies', false],
    ['peerDependencies', false],
    ['devDependencies', true],
  ];
  for (const [bucket, isDev] of buckets) {
    const obj = json[bucket];
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, spec] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof spec !== 'string') continue;
      // link/workspace specs carry no upstream version signal.
      if (/^(file:|link:|workspace:|git\+?|http)/.test(spec) && !/\d/.test(spec)) continue;
      out.push(dep('npm', name, spec, manifest, isDev));
    }
  }
  return out;
}

export function parseRequirementsTxt(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    // strip inline comments
    line = line.replace(/\s+#.*$/, '');
    // skip includes/options/URLs without egg name
    if (line.startsWith('-')) return;
    let name: string;
    let spec: string | undefined;
    const egg = line.match(/[?&#]egg=([A-Za-z0-9._-]+)/);
    if (!egg && /:\/\/|^git\+/.test(line)) return; // direct URL without package name
    if (egg) {
      name = egg[1]!;
    } else {
      const m = line.match(/^([A-Za-z0-9._-]+)(\s*\[[^\]]+\])?\s*(.*)$/);
      if (!m) return;
      name = m[1]!;
      spec = m[3]?.trim() || undefined;
    }
    out.push(dep('pypi', normalizePyName(name), spec, manifest, false, idx + 1));
  });
  return out;
}

export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function parseGoMod(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      return;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      return;
    }
    const single = !inBlock ? line.match(/^require\s+(\S+)\s+(\S+)(.*)$/) : undefined;
    const m = inBlock ? line.match(/^(\S+)\s+(\S+)(.*)$/) : single;
    if (!m || !m[1] || !m[2]) return;
    const indirect = /\/\/\s*indirect/.test(m[3] ?? '');
    out.push(dep('go', m[1], m[2], manifest, false, idx + 1, indirect));
  });
  return out;
}

export interface ManifestFile {
  path: string;
  ecosystem: Ecosystem;
  content: string;
}

export async function collectManifests(source: RepoSource): Promise<ManifestFile[]> {
  const files = await source.listFiles();
  const result: ManifestFile[] = [];
  for (const path of files) {
    const base = path.split('/').pop() ?? '';
    let ecosystem: Ecosystem | undefined;
    if (base === 'package.json') ecosystem = 'npm';
    else if (base === 'go.mod') ecosystem = 'go';
    else if (/^requirements[\w.-]*\.txt$/.test(base) || base === 'pyproject.toml') {
      if (base === 'pyproject.toml') continue; // poetry/PEP621 parsing is on the roadmap
      ecosystem = 'pypi';
    }
    if (!ecosystem) continue;
    const content = await source.readText(path);
    if (typeof content !== 'string') continue;
    result.push({ path, ecosystem, content });
  }
  return result;
}

export async function collectDependencies(source: RepoSource): Promise<Dependency[]> {
  const manifests = await collectManifests(source);
  const all: Dependency[] = [];
  for (const m of manifests) {
    if (m.ecosystem === 'npm') all.push(...parsePackageJson(m.content, m.path));
    else if (m.ecosystem === 'pypi') all.push(...parseRequirementsTxt(m.content, m.path));
    else all.push(...parseGoMod(m.content, m.path));
  }
  // de-dupe identical (ecosystem,name) pins, keeping the first (highest manifest)
  const seen = new Set<string>();
  return all.filter((d) => {
    const key = `${d.ecosystem}:${d.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
