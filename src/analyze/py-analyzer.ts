/**
 * Python call-site extraction (tree-sitter-python).
 * Mirrors the JS strategy:
 *   import binding -> factory propagation (OpenAI/Client/create_client)
 *   -> attribute-call chains (client.chat.completions.create /
 *      supabase.table('x').select('*').execute())
 *   -> enum/constant attribute refs (stripe.ChargeTypeCard)
 *   -> raw HTTP calls via requests / httpx.
 */
import type { CallSite } from '../types.js';
import type { TSNode } from './parser.js';
import type { AnalyzerIndex, LanguageRule } from './rules.js';
import { providerForPackage } from '../providers/registry.js';
import { normalizePyName } from '../deps/manifests.js';
import { chainSegments, isStringLiteral, sameNode, siteId, snippet, walk } from './ts-utils.js';

interface Binding {
  providerId: string;
  factory: boolean;
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

function pyArgs(call: TSNode): TSNode[] {
  const list = call.childForFieldName('arguments');
  if (!list) return [];
  // positional args only (keyword_argument handled separately)
  return list.children.filter(
    (c) =>
      ![
        '(',
        ')',
        ',',
        'comment',
        'keyword_argument',
        'list_splat_pattern',
        'dictionary_splat_pattern',
      ].includes(c.type),
  );
}

function collectKwargs(callNodes: TSNode[]): {
  keys: string[];
  literals: Record<string, string[]>;
} {
  const keys: string[] = [];
  const lit = new Map<string, string[]>();
  for (const call of callNodes) {
    const list = call.childForFieldName('arguments');
    if (list) {
      for (const kw of list.children.filter((c) => c.type === 'keyword_argument')) {
        const name = kw.childForFieldName('name')?.text;
        const value = kw.childForFieldName('value');
        if (!name) continue;
        keys.push(name);
        if (value && isStringLiteral(value))
          lit.set(name, [...(lit.get(name) ?? []), cleanPyString(value.text)]);
      }
    }
    const args = pyArgs(call);
    args.forEach((a, i) => {
      if (isStringLiteral(a))
        lit.set(`$${i}`, [...(lit.get(`$${i}`) ?? []), cleanPyString(a.text)]);
    });
  }
  return { keys: [...new Set(keys)], literals: Object.fromEntries(lit) };
}

function cleanPyString(raw: string): string {
  let t = raw;
  const m = t.match(/^([rbufRBUF]{0,2})(['"`]{1,3})([\s\S]*)\2$/);
  if (m) t = m[3] ?? t;
  else if (t.length >= 2) t = t.slice(1, -1);
  return t;
}

export function analyzePython(
  root: TSNode,
  code: string,
  file: string,
  index: AnalyzerIndex,
): CallSite[] {
  const rules = index.rules.python;
  const active = new Set<string>();
  const bindings = new Map<string, Binding>();
  const instances = new Map<string, string>();
  const sites: CallSite[] = [];
  const seen = new Set<string>();

  const ruleForModuleRoot = (root0: string): LanguageRule | undefined => {
    const pid = providerForPackage('pypi', normalizePyName(root0));
    if (!pid) return undefined;
    active.add(pid);
    return rules.find((r) => r.providerId === pid);
  };

  const bind = (local: string, rule: LanguageRule, factory: boolean): void => {
    bindings.set(local, {
      providerId: rule.providerId,
      factory: factory || rule.factories.includes(local),
    });
  };

  const importedName = (n: TSNode): { local: string; imported: string } | undefined => {
    if (n.type === 'aliased_import') {
      const name = n.childForFieldName('name');
      const alias = n.childForFieldName('alias');
      if (!name) return undefined;
      return { imported: name.text.split('.').pop()!, local: alias?.text ?? name.text };
    }
    if (n.type === 'dotted_name' || n.type === 'identifier') {
      return { imported: n.text.split('.').pop()!, local: n.text.split('.').pop()! };
    }
    return undefined;
  };

  // --- pass 1: imports ---
  for (const node of walk(root)) {
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (child.type === 'dotted_name') {
          const root0 = child.text.split('.')[0]!;
          const rule = ruleForModuleRoot(root0);
          if (rule) bind(root0, rule, false);
        } else if (child.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          const alias = child.childForFieldName('alias');
          const root0 = name?.text.split('.')[0];
          const rule = root0 ? ruleForModuleRoot(root0) : undefined;
          if (rule && alias) bind(alias.text, rule, false);
        }
      }
    } else if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      const root0 = mod?.text.split('.')[0];
      const rule = root0 ? ruleForModuleRoot(root0) : undefined;
      if (!rule) continue;
      for (const child of node.children) {
        if (child.type === 'wildcard_import') continue;
        const info = importedName(child);
        if (info) bind(info.local, rule, rule.factories.includes(info.imported));
      }
    }
  }

  // --- pass 2: factory propagation through assignments ---
  const calleeProvider = (fn: TSNode): string | undefined => {
    if (fn.type === 'identifier') {
      const b = bindings.get(fn.text);
      return b?.factory ? b.providerId : undefined;
    }
    const segs = chainSegments(fn);
    if (!segs) return undefined;
    const [r, ...rest] = segs;
    const b = r ? bindings.get(r) : undefined;
    if (!b) return undefined;
    const rule = rules.find((x) => x.providerId === b.providerId);
    if (rest.length === 1 && rule?.factories.includes(rest[0]!)) return b.providerId;
    return undefined;
  };

  for (const node of walk(root)) {
    if (node.type !== 'assignment') continue;
    const left = node.childForFieldName('left');
    let right = node.childForFieldName('right');
    if (!left || left.type !== 'identifier' || !right) continue;
    if (right.type === 'await_expression') right = right.childForFieldName('argument') ?? right;
    if (right.type !== 'call') continue;
    const fn = right.childForFieldName('function');
    const pid = fn ? calleeProvider(fn) : undefined;
    if (pid) instances.set(left.text, pid);
  }

  const rootOf = (id: string): string | undefined =>
    instances.get(id) ?? bindings.get(id)?.providerId;

  const emit = (s: Omit<CallSite, 'id'>): void => {
    const key = `${s.file}:${s.line}:${s.path}:${s.receiver}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ id: siteId(s.file, s.line - 1, s.path), ...s });
  };
  const pkgOf = (pid: string): string =>
    rules.find((r) => r.providerId === pid)?.packageName ?? pid;

  // --- pass 3: attribute-call chains ---
  for (const node of walk(root)) {
    if (node.type !== 'call') continue;
    // intermediate of x.a().b()
    if (
      node.parent?.type === 'attribute' &&
      sameNode(node.parent.childForFieldName('object'), node) &&
      node.parent.parent?.type === 'call'
    ) {
      continue;
    }
    const chain: string[] = [];
    const callNodes: TSNode[] = [];
    let cur: TSNode | null = node;
    while (cur && cur.type === 'call') {
      const fn = cur.childForFieldName('function');
      if (!fn || fn.type !== 'attribute') break;
      const attr = fn.childForFieldName('attribute');
      if (attr) chain.unshift(attr.text);
      callNodes.unshift(cur);
      let obj: TSNode | null = fn.childForFieldName('object');
      // descend pure attribute chain: a.b.c() -> [b, c]
      while (obj && obj.type === 'attribute') {
        const a2 = obj.childForFieldName('attribute');
        if (a2) chain.unshift(a2.text);
        obj = obj.childForFieldName('object');
      }
      cur = obj;
    }
    if (cur && cur.type === 'identifier' && chain.length > 0) {
      const pid = rootOf(cur.text);
      if (pid && active.has(pid)) {
        // skip constructor/factory calls bound directly off a package binding
        const binding = bindings.get(cur.text);
        const isFactoryNoise =
          binding &&
          !binding.factory &&
          chain.length === 1 &&
          rules.find((r) => r.providerId === pid)?.factories.includes(chain[0]!);
        if (!isFactoryNoise) {
          const args = collectKwargs(callNodes);
          emit({
            file,
            language: 'python',
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            package: pkgOf(pid),
            providerId: pid,
            path: chain.join('.'),
            receiver: [cur.text, ...chain].join('.'),
            callText: snippet(code, node.startPosition.row),
            argumentKeys: args.keys,
            argumentLiterals: args.literals,
            memberRefs: [],
          });
          continue;
        }
      }
    }

    // raw HTTP: requests.get/post/... / httpx.get / requests.request
    if (
      cur &&
      cur.type === 'identifier' &&
      (cur.text === 'requests' || cur.text === 'httpx') &&
      chain.length === 1
    ) {
      const verb = chain[0]!;
      if (HTTP_VERBS.has(verb)) {
        const args = pyArgs(callNodes[0] ?? node);
        const strArgs = args.filter(isStringLiteral);
        let method = verb.toUpperCase();
        let urlArg = strArgs[0];
        if (verb === 'request' && strArgs.length >= 2) {
          method = cleanPyString(strArgs[0]!.text).toUpperCase();
          urlArg = strArgs[1];
        }
        if (urlArg) {
          const raw = cleanPyString(urlArg.text);
          const pid = hostProvider(raw, index);
          if (pid) {
            let pathname = '/';
            try {
              pathname = new URL(raw).pathname;
            } catch {
              /* keep / */
            }
            emit({
              file,
              language: 'python',
              line: node.startPosition.row + 1,
              package: '(http)',
              providerId: pid,
              path: pathname,
              receiver: raw,
              callText: snippet(code, node.startPosition.row),
              argumentKeys: [],
              argumentLiterals: { $0: [raw] },
              memberRefs: [],
              http: { method, url: raw },
            });
          }
        }
      }
    }
  }

  // --- pass 4: enum / constant attribute references ---
  for (const node of walk(root)) {
    if (node.type !== 'attribute') continue;
    const parent = node.parent;
    if (parent?.type === 'attribute') continue;
    if (parent?.type === 'call' && sameNode(parent.childForFieldName('function'), node)) continue;
    const segs = chainSegments(node);
    if (!segs) continue;
    const [r, ...rest] = segs;
    if (!r || rest.length === 0) continue;
    const pid = rootOf(r);
    if (!pid || !active.has(pid)) continue;
    const ref = rest.join('.');
    emit({
      file,
      language: 'python',
      line: node.startPosition.row + 1,
      package: pkgOf(pid),
      providerId: pid,
      path: ref,
      receiver: segs.join('.'),
      callText: snippet(code, node.startPosition.row),
      argumentKeys: [],
      argumentLiterals: {},
      memberRefs: [ref],
    });
  }

  return sites;
}

function hostProvider(raw: string, index: AnalyzerIndex): string | undefined {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return index.hosts.find((h) => host === h.suffix || host.endsWith(`.${h.suffix}`))?.providerId;
}
