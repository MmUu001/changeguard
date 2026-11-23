/**
 * Go call-site extraction (tree-sitter-go).
 *
 *   import alias resolution (incl. /vN major suffixes and subpackages)
 *   -> factory propagation (stripe.NewClient / twilio.NewRestClient /
 *      openai.NewClient / supabase.NewClient)
 *   -> selector-call chains (client.Messages.Create / client.From("x").Select("*"))
 *   -> struct-literal parameter keys (Params{Field: ...})
 *   -> enum/const selector refs (stripe.PaymentIntentStatusSucceeded)
 *   -> net/http raw requests against vendor hosts.
 */
import type { CallSite } from '../types.js';
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

interface GoBinding {
  providerId: string;
  /** Subpackage path after the module root, e.g. "customer". */
  subpath?: string;
}

function defaultLocalName(path: string): string {
  const segs = path.split('/');
  let last = segs[segs.length - 1]!;
  if (/^v\d+$/.test(last)) last = segs[segs.length - 2]!;
  return last.replace(/^go-/, '').replace(/-go$/, '');
}

function goArgs(call: TSNode): TSNode[] {
  const list = call.childForFieldName('arguments');
  if (!list) return [];
  return list.children.filter((c) => !['(', ')', ',', 'comment'].includes(c.type));
}

function compositeOf(arg: TSNode | undefined): TSNode | undefined {
  if (!arg) return undefined;
  if (arg.type === 'composite_literal') return arg;
  if (arg.type === 'unary_expression') {
    const op = arg.children[0];
    const operand = arg.childForFieldName('operand');
    if (op?.type === '&' || op?.text === '&') return compositeOf(operand ?? undefined);
  }
  return undefined;
}

function structKeys(callNodes: TSNode[]): { keys: string[]; literals: Record<string, string[]> } {
  const keys: string[] = [];
  const lit = new Map<string, string[]>();
  for (const call of callNodes) {
    const args = goArgs(call);
    const comp = args.map((a) => compositeOf(a)).find((c): c is TSNode => !!c);
    const body = comp?.childForFieldName('body');
    if (!body) continue;
    for (const el of body.children.filter((c) => c.type === 'keyed_element')) {
      const keyNode = el.childForFieldName('key');
      const valNode = el.childForFieldName('value');
      const key = keyNode?.type === 'field_identifier' ? keyNode.text : keyNode?.text;
      if (!key) continue;
      keys.push(key);
      if (valNode && isStringLiteral(valNode))
        lit.set(key, [...(lit.get(key) ?? []), stringValue(valNode)]);
    }
    args
      .filter((a) => a.type !== 'composite_literal' && a.type !== 'unary_expression')
      .forEach((a, i) => {
        if (isStringLiteral(a)) lit.set(`$${i}`, [...(lit.get(`$${i}`) ?? []), stringValue(a)]);
      });
  }
  return { keys: [...new Set(keys)], literals: Object.fromEntries(lit) };
}

export function analyzeGo(
  root: TSNode,
  code: string,
  file: string,
  index: AnalyzerIndex,
): CallSite[] {
  const rules = index.rules.go;
  const active = new Set<string>();
  const bindings = new Map<string, GoBinding>();
  const instances = new Map<string, GoBinding>();
  const sites: CallSite[] = [];
  const seen = new Set<string>();

  const matchModule = (path: string): { rule: LanguageRule; subpath?: string } | undefined => {
    const pid = providerForPackage('go', path);
    if (!pid) return undefined;
    const rule = rules.find((r) => r.providerId === pid)!;
    active.add(pid);
    // Normalize major-version suffixes: .../stripe-go/v78 == .../stripe-go
    const norm = (p: string): string => p.replace(/\/v\d+(\/|$)/, (_m, tail: string) => tail ?? '');
    const normalized = norm(path);
    let bestPrefix: string | undefined;
    for (const prefix of rule.goModulePrefixes ?? []) {
      const npre = norm(prefix);
      if (normalized === npre || normalized.startsWith(`${npre}/`)) {
        if (!bestPrefix || npre.length > bestPrefix.length) bestPrefix = npre;
      }
    }
    let subpath: string | undefined;
    if (bestPrefix !== undefined) {
      const rest = normalized.slice(bestPrefix.length).replace(/^\/+/, '');
      if (rest) subpath = rest.split('/').join('.');
    }
    return { rule, subpath };
  };

  // --- pass 1: imports ---
  for (const node of walk(root)) {
    if (node.type !== 'import_spec') continue;
    const pathNode = node.childForFieldName('path');
    if (!pathNode || !isStringLiteral(pathNode)) continue;
    const path = stringValue(pathNode);
    const match = matchModule(path);
    if (!match) continue;
    const alias = node.childForFieldName('name');
    const local = alias?.text ?? defaultLocalName(path);
    bindings.set(local, { providerId: match.rule.providerId, subpath: match.subpath });
  }

  // --- pass 2: factory propagation ---
  const calleeBinding = (fn: TSNode): GoBinding | undefined => {
    if (fn.type !== 'selector_expression') return undefined;
    const operand = fn.childForFieldName('operand');
    const field = fn.childForFieldName('field');
    if (!operand || operand.type !== 'identifier' || !field) return undefined;
    const b = bindings.get(operand.text);
    if (!b || b.subpath) return undefined;
    const rule = rules.find((r) => r.providerId === b.providerId);
    if (!rule?.factories.includes(field.text)) return undefined;
    return b;
  };

  /** Resolve the package of a selector type, e.g. &stripe.ChargeParams{} -> stripe binding */
  const compositePackage = (n: TSNode | null): GoBinding | undefined => {
    let lit = n;
    if (lit?.type === 'unary_expression') {
      const op = lit.children[0];
      if (op?.text !== '&') return undefined;
      lit = lit.childForFieldName('operand');
    }
    if (!lit || lit.type !== 'composite_literal') return undefined;
    const typeNode = lit.childForFieldName('type');
    if (!typeNode || typeNode.type !== 'qualified_type') return undefined;
    const pkg = typeNode.children.find((c) => c.type === 'package_identifier');
    if (!pkg) return undefined;
    return bindings.get(pkg.text);
  };

  for (const node of walk(root)) {
    const isDecl =
      node.type === 'short_var_declaration' ||
      node.type === 'assignment_statement' ||
      node.type === 'var_spec';
    if (!isDecl) continue;
    const leftNode = node.childForFieldName('left') ?? node.childForFieldName('name');
    const lefts = (
      leftNode?.type === 'identifier' ? [leftNode] : (leftNode?.children ?? [])
    ).filter((c) => c.type === 'identifier');
    const rhs = node.childForFieldName('right') ?? node.childForFieldName('value');
    if (!rhs || lefts.length === 0) continue;
    const exprs = rhs.type === 'expression_list' ? rhs.children : [rhs];
    exprs.forEach((expr, i) => {
      const target = lefts[i] ?? lefts[0];
      if (!target || target.text === '_') return;
      if (expr.type === 'call_expression') {
        const fn = expr.childForFieldName('function');
        const b = fn ? calleeBinding(fn) : undefined;
        if (b) instances.set(target.text, b);
      } else {
        const b = compositePackage(expr);
        if (b) instances.set(target.text, b);
      }
    });
  }

  const rootOf = (id: string): GoBinding | undefined => instances.get(id) ?? bindings.get(id);

  const emit = (s: Omit<CallSite, 'id'>): void => {
    const key = `${s.file}:${s.line}:${s.path}:${s.receiver}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ id: siteId(s.file, s.line - 1, s.path), ...s });
  };
  const pkgOf = (pid: string): string =>
    rules.find((r) => r.providerId === pid)?.packageName ?? pid;

  // --- pass 3: selector-call chains ---
  for (const node of walk(root)) {
    if (node.type !== 'call_expression') continue;
    if (
      node.parent?.type === 'selector_expression' &&
      sameNode(node.parent.childForFieldName('operand'), node) &&
      node.parent.parent?.type === 'call_expression'
    ) {
      continue;
    }
    const chain: string[] = [];
    const callNodes: TSNode[] = [];
    let cur: TSNode | null = node;
    while (cur && cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (!fn || fn.type !== 'selector_expression') break;
      const field = fn.childForFieldName('field');
      if (field) chain.unshift(field.text);
      callNodes.unshift(cur);
      let operand: TSNode | null = fn.childForFieldName('operand');
      // descend pure selector chain: pkg.Api.CreateMessage() -> [Api, CreateMessage]
      while (operand && operand.type === 'selector_expression') {
        const f2 = operand.childForFieldName('field');
        if (f2) chain.unshift(f2.text);
        operand = operand.childForFieldName('operand');
      }
      cur = operand;
    }

    if (cur && cur.type === 'identifier' && chain.length > 0) {
      const resolved = rootOf(cur.text);
      if (resolved && active.has(resolved.providerId)) {
        // suppress bare factory calls: stripe.NewClient() / twilio.NewRestClient()
        const isFactoryNoise =
          !instances.has(cur.text) &&
          chain.length === 1 &&
          rules.find((r) => r.providerId === resolved.providerId)?.factories.includes(chain[0]!);
        if (!isFactoryNoise) {
          const args = structKeys(callNodes);
          const pathParts = resolved.subpath ? [resolved.subpath, ...chain] : chain;
          emit({
            file,
            language: 'go',
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            package: pkgOf(resolved.providerId),
            providerId: resolved.providerId,
            path: pathParts.join('.'),
            receiver: [cur.text, ...pathParts].join('.'),
            callText: snippet(code, node.startPosition.row),
            argumentKeys: args.keys,
            argumentLiterals: args.literals,
            memberRefs: [],
          });
          continue;
        }
      }
    }

    // net/http raw calls
    if (cur && cur.type === 'identifier' && cur.text === 'http' && chain.length === 1) {
      const fnName = chain[0];
      const args = goArgs(callNodes[0] ?? node);
      if (fnName === 'NewRequest' || fnName === 'NewRequestWithContext') {
        const offset = fnName === 'NewRequestWithContext' ? 1 : 0;
        const methodArg = args[offset];
        const urlArg = args[offset + 1];
        if (methodArg && urlArg && isStringLiteral(methodArg) && isStringLiteral(urlArg)) {
          emitHttp(
            sites,
            emit,
            file,
            node,
            stringValue(methodArg).toUpperCase(),
            stringValue(urlArg),
            index,
            code,
          );
        }
      } else if (
        ['Get', 'Post', 'PostForm', 'Head'].includes(fnName!) &&
        isStringLiteral(args[0])
      ) {
        const method = fnName === 'PostForm' ? 'POST' : fnName!.toUpperCase();
        emitHttp(sites, emit, file, node, method, stringValue(args[0]!), index, code);
      }
    }
  }

  // --- pass 4: enum / const selector references + qualified struct types ---
  for (const node of walk(root)) {
    if (node.type === 'qualified_type') {
      const pkg = node.children.find((c) => c.type === 'package_identifier');
      const binding = pkg ? bindings.get(pkg.text) : undefined;
      if (!binding || !active.has(binding.providerId)) continue;
      const typeName =
        node.children.find((c) => c.type === 'field_identifier')?.text ??
        node.children.find((c) => c.type === 'type_identifier')?.text;
      if (!typeName) continue;
      const fullRef = binding.subpath ? `${binding.subpath}.${typeName}` : typeName;
      emit({
        file,
        language: 'go',
        line: node.startPosition.row + 1,
        package: pkgOf(binding.providerId),
        providerId: binding.providerId,
        path: fullRef,
        receiver: node.text,
        callText: snippet(code, node.startPosition.row),
        argumentKeys: [],
        argumentLiterals: {},
        memberRefs: [fullRef],
      });
      continue;
    }
    if (node.type !== 'selector_expression') continue;
    const parent = node.parent;
    if (parent?.type === 'selector_expression') continue;
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
    const binding = rootOf(r);
    const pid = binding?.providerId;
    if (!pid || !active.has(pid)) continue;
    const ref = rest.join('.');
    const fullRef = binding.subpath ? `${binding.subpath}.${ref}` : ref;
    emit({
      file,
      language: 'go',
      line: node.startPosition.row + 1,
      package: pkgOf(pid),
      providerId: pid,
      path: fullRef,
      receiver: segs.join('.'),
      callText: snippet(code, node.startPosition.row),
      argumentKeys: [],
      argumentLiterals: {},
      memberRefs: [fullRef],
    });
  }

  return sites;
}

function emitHttp(
  _sites: CallSite[],
  emit: (s: Omit<CallSite, 'id'>) => void,
  file: string,
  node: TSNode,
  method: string,
  raw: string,
  index: AnalyzerIndex,
  code: string,
): void {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return;
  }
  const hit = index.hosts.find((h) => host === h.suffix || host.endsWith(`.${h.suffix}`));
  if (!hit) return;
  emit({
    file,
    language: 'go',
    line: node.startPosition.row + 1,
    package: '(http)',
    providerId: hit.providerId,
    path: new URL(raw).pathname,
    receiver: raw,
    callText: snippet(code, node.startPosition.row),
    argumentKeys: [],
    argumentLiterals: { $0: [raw] },
    memberRefs: [],
    http: { method, url: raw },
  });
}
