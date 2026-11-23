/**
 * JavaScript / TypeScript call-site extraction (tree-sitter-typescript
 * grammar, which also parses plain JavaScript).
 *
 * Resolution strategy (per file):
 *  1. ESM imports + CommonJS require -> binding(localName) -> provider
 *  2. Factory propagation: `const x = new Stripe()`, `const x = createClient()`,
 *     `const x = require('twilio')(a, b)` bind x to the provider instance.
 *  3. Call chains rooted at a binding/instance (incl. `.from().select()` chains).
 *  4. Member/enum references rooted at module bindings (e.g. stripe.ChargeTypeCard).
 *  5. Raw HTTP calls (fetch / axios) pointing at vendor hosts.
 */
import type { CallSite, Language } from '../types.js';
import type { TSNode } from './parser.js';
import type { AnalyzerIndex, LanguageRule } from './rules.js';
import { providerForPackage } from '../providers/registry.js';
import {
  chainSegments,
  isStringLiteral,
  sameNode,
  siteId,
  snippet,
  stringValue,
  walk,
} from './ts-utils.js';

interface Binding {
  providerId: string;
  factory: boolean;
}

function objectKeys(
  node: TSNode | undefined,
  prefix = '',
): { keys: string[]; literals: Map<string, string[]> } {
  const keys: string[] = [];
  const literals = new Map<string, string[]>();
  if (!node) return { keys, literals };
  const pushLit = (key: string, value: TSNode) => {
    if (isStringLiteral(value)) {
      const list = literals.get(key) ?? [];
      list.push(stringValue(value));
      literals.set(key, list);
    }
  };
  for (const pair of node.children.filter(
    (c) =>
      c.type === 'pair' ||
      c.type === 'shorthand_property_identifier' ||
      c.type === 'shorthand_property_identifier_pattern',
  )) {
    let key: string | undefined;
    let value: TSNode | undefined;
    if (pair.type === 'pair') {
      key = pair.childForFieldName('key')?.text;
      value = pair.childForFieldName('value') ?? undefined;
    } else {
      key = pair.text;
    }
    if (!key) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    keys.push(dotted);
    if (value) pushLit(dotted, value);
    if (value?.type === 'object') {
      const nested = objectKeys(value, dotted);
      keys.push(...nested.keys);
      for (const [k, vals] of nested.literals) literals.set(k, vals);
    }
  }
  return { keys, literals };
}

function callArguments(n: TSNode): TSNode[] {
  const list = n.childForFieldName('arguments');
  if (!list) return [];
  return list.children.filter((c) => !['(', ')', ',', 'comment'].includes(c.type));
}

function mergeArgs(callNodes: TSNode[]): { keys: string[]; literals: Record<string, string[]> } {
  const keys: string[] = [];
  const lit = new Map<string, string[]>();
  for (const c of callNodes) {
    const args = callArguments(c);
    const ok = objectKeys(args.find((a) => a.type === 'object'));
    keys.push(...ok.keys);
    for (const [k, vals] of ok.literals) lit.set(k, vals);
    args.forEach((a, i) => {
      if (isStringLiteral(a)) {
        const k = `$${i}`;
        lit.set(k, [...(lit.get(k) ?? []), stringValue(a)]);
      }
    });
  }
  return { keys: [...new Set(keys)], literals: Object.fromEntries(lit) };
}

function unwrapAwait(node: TSNode): TSNode {
  return node.type === 'await_expression' ? (node.childForFieldName('argument') ?? node) : node;
}

export function analyzeJavaScript(
  root: TSNode,
  code: string,
  file: string,
  language: Language,
  index: AnalyzerIndex,
): CallSite[] {
  const rules = index.rules.javascript;
  const active = new Set<string>();
  const bindings = new Map<string, Binding>();
  const instances = new Map<string, string>();
  const sites: CallSite[] = [];
  const seen = new Set<string>();

  const ruleForModule = (source: string): LanguageRule | undefined => {
    const pid = providerForPackage('npm', source);
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

  const bindImport = (source: string, clause: TSNode): void => {
    const rule = ruleForModule(source);
    if (!rule) return;
    // tree-sitter-typescript does NOT expose the default-import identifier as a field.
    const def =
      clause.childForFieldName('name') ??
      clause.children.find((c) => c.type === 'identifier') ??
      null;
    if (def?.type === 'identifier') bind(def.text, rule, rule.factories.includes(def.text));
    const ns = clause.children.find((c) => c.type === 'namespace_import');
    if (ns) {
      const id = ns.childForFieldName('name');
      if (id) bind(id.text, rule, false);
    }
    const named = clause.children.find((c) => c.type === 'named_imports');
    if (named) {
      for (const spec of named.children.filter((c) => c.type === 'import_specifier')) {
        const imported =
          spec.childForFieldName('name') ?? spec.children.find((c) => c.type === 'identifier');
        const alias = spec.childForFieldName('alias');
        const local = (alias ?? imported)?.text;
        if (local && imported) bind(local, rule, rule.factories.includes(imported.text));
      }
    }
  };

  const innerRequire = (n: TSNode | null | undefined): TSNode | undefined => {
    if (!n || n.type !== 'call_expression') return undefined;
    const fn = n.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'require') return n;
    if (fn?.type === 'call_expression') return innerRequire(fn);
    return undefined;
  };

  // --- pass 1: imports & requires ---
  for (const node of walk(root)) {
    if (node.type === 'import_statement') {
      const src = node.childForFieldName('source');
      const clause =
        node.childForFieldName('clause') ?? node.children.find((c) => c.type === 'import_clause');
      if (src && clause && isStringLiteral(src)) bindImport(stringValue(src), clause);
      continue;
    }
    if (node.type !== 'variable_declarator') continue;
    const value = node.childForFieldName('value');
    const req = innerRequire(value);
    if (!req) continue;
    const arg = req.childForFieldName('arguments')?.children.find((c) => isStringLiteral(c));
    if (!arg) continue;
    const rule = ruleForModule(stringValue(arg));
    if (!rule) continue;
    const name = node.childForFieldName('name');
    if (name?.type === 'identifier') {
      bind(name.text, rule, !sameNode(value, req));
    } else if (name?.type === 'object_pattern') {
      for (const p of name.children) {
        if (
          p.type === 'shorthand_property_identifier_pattern' ||
          p.type === 'shorthand_property_identifier'
        ) {
          bind(p.text, rule, rule.factories.includes(p.text));
        } else if (p.type === 'pair_pattern' || p.type === 'pair') {
          const k = p.childForFieldName('key');
          const v = p.childForFieldName('value') ?? p.childForFieldName('pattern');
          if (k && v) bind(v.text, rule, rule.factories.includes(k.text));
        }
      }
    }
  }

  // --- pass 2: factory propagation ---
  const calleeProvider = (callee: TSNode): string | undefined => {
    if (callee.type === 'identifier') {
      return bindings.get(callee.text)?.factory ? bindings.get(callee.text)!.providerId : undefined;
    }
    const segs = chainSegments(callee);
    if (!segs) return undefined;
    const [r, ...rest] = segs;
    const b = r ? bindings.get(r) : undefined;
    if (!b) return undefined;
    const rule = rules.find((x) => x.providerId === b.providerId);
    if (rest.length === 1 && rule?.factories.includes(rest[0]!)) return b.providerId;
    return undefined;
  };

  for (const node of walk(root)) {
    if (node.type !== 'variable_declarator') continue;
    const name = node.childForFieldName('name');
    let value = node.childForFieldName('value');
    if (!name || name.type !== 'identifier' || !value) continue;
    value = unwrapAwait(value);
    let pid: string | undefined;
    if (value.type === 'new_expression') {
      const ctor =
        value.childForFieldName('constructor') ??
        value.children.find((c) => c.type === 'identifier' || c.type === 'member_expression');
      pid = ctor ? calleeProvider(ctor) : undefined;
    } else if (value.type === 'call_expression') {
      const fn = value.childForFieldName('function');
      pid = fn ? calleeProvider(fn) : undefined;
    }
    if (pid) instances.set(name.text, pid);
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

  // --- pass 3: member-call chains ---
  for (const node of walk(root)) {
    if (node.type !== 'call_expression') continue;
    // Suppress intermediate calls of a.b().c() chains; the terminal call wins.
    if (
      node.parent?.type === 'member_expression' &&
      sameNode(node.parent.childForFieldName('object'), node) &&
      node.parent.parent?.type === 'call_expression'
    ) {
      continue;
    }
    const chain: string[] = [];
    const callNodes: TSNode[] = [];
    let cur: TSNode | null = node;
    while (cur && cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (!fn || (fn.type !== 'member_expression' && fn.type !== 'subscript_expression')) break;
      const prop = fn.childForFieldName('property');
      if (prop) {
        chain.unshift(
          prop.type === 'property_identifier' || prop.type === 'identifier'
            ? prop.text
            : isStringLiteral(prop)
              ? stringValue(prop)
              : prop.text,
        );
      }
      callNodes.unshift(cur);
      let obj: TSNode | null = fn.childForFieldName('object');
      // descend pure member chain: a.b.c() -> [b, c]; calls stay in outer loop
      while (obj && (obj.type === 'member_expression' || obj.type === 'subscript_expression')) {
        const p2 = obj.childForFieldName('property');
        if (p2) {
          chain.unshift(
            p2.type === 'property_identifier' || p2.type === 'identifier'
              ? p2.text
              : isStringLiteral(p2)
                ? stringValue(p2)
                : p2.text,
          );
        }
        obj = obj.childForFieldName('object');
      }
      cur = obj;
    }

    if (
      cur &&
      cur.type === 'identifier' &&
      chain.length > 0 &&
      active.has(rootOf(cur.text) ?? '')
    ) {
      const pid = rootOf(cur.text)!;
      const args = mergeArgs(callNodes);
      emit({
        file,
        language,
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

    const http = detectHttp(node, cur, chain, callNodes, index);
    if (http) {
      let pathname = '/';
      try {
        pathname = new URL(http.url).pathname;
      } catch {
        /* keep / */
      }
      emit({
        file,
        language,
        line: node.startPosition.row + 1,
        package: '(http)',
        providerId: http.providerId,
        path: pathname,
        receiver: http.url,
        callText: snippet(code, node.startPosition.row),
        argumentKeys: [],
        argumentLiterals: { $0: [http.url] },
        memberRefs: [],
        http: { method: http.method, url: http.url },
      });
    }
  }

  // --- pass 4: enum / constant member references ---
  for (const node of walk(root)) {
    if (node.type !== 'member_expression' && node.type !== 'subscript_expression') continue;
    const parent = node.parent;
    if (parent?.type === 'member_expression' || parent?.type === 'subscript_expression') continue;
    if (
      parent?.type === 'call_expression' &&
      sameNode(parent.childForFieldName('function'), node)
    ) {
      continue;
    }
    const segs = chainSegments(node);
    if (!segs) continue;
    const [r, ...rest] = segs;
    if (!r || rest.length === 0) continue;
    const pid = rootOf(r);
    if (!pid || !active.has(pid)) continue;
    const ref = rest.join('.');
    emit({
      file,
      language,
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

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

interface HttpDetect {
  method: string;
  url: string;
  providerId: string;
}

function detectHttp(
  node: TSNode,
  root: TSNode | null,
  chain: string[],
  callNodes: TSNode[],
  index: AnalyzerIndex,
): HttpDetect | undefined {
  if (!root) return undefined;
  const hostFor = (raw: string): string | undefined => {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    const hit = index.hosts.find((h) => host === h.suffix || host.endsWith(`.${h.suffix}`));
    return hit?.providerId;
  };

  if (root.type === 'identifier' && root.text === 'fetch' && chain.length === 0) {
    const args = callArguments(node);
    const urlArg = args.find(isStringLiteral);
    if (!urlArg) return undefined;
    const pid = hostFor(stringValue(urlArg));
    if (!pid) return undefined;
    const opts = args.find((a) => a.type === 'object');
    const methodPair = opts?.children.find(
      (c) => c.type === 'pair' && c.childForFieldName('key')?.text === 'method',
    );
    const method =
      methodPair?.childForFieldName('value')?.text.replace(/['"`]/g, '').toUpperCase() ?? 'GET';
    return { method, url: stringValue(urlArg), providerId: pid };
  }
  if (root.type === 'identifier' && root.text === 'axios' && chain.length === 1) {
    const verb = chain[0]!.toLowerCase();
    if (!HTTP_VERBS.has(verb)) return undefined;
    const args = callArguments(callNodes[0] ?? node);
    const urlArg = args.find(isStringLiteral);
    if (!urlArg) return undefined;
    const pid = hostFor(stringValue(urlArg));
    if (!pid) return undefined;
    return { method: verb.toUpperCase(), url: stringValue(urlArg), providerId: pid };
  }
  return undefined;
}
