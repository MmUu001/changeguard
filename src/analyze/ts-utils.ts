import type { TSNode } from './parser.js';

export function* walk(node: TSNode): Generator<TSNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function findChildren(node: TSNode, type: string): TSNode[] {
  return node.children.filter((c) => c.type === type);
}

export function isStringLiteral(node: TSNode | null | undefined): boolean {
  return (
    !!node &&
    (node.type === 'string' ||
      node.type === 'string_literal' ||
      node.type === 'interpreted_string_literal')
  );
}

/** Decode the text of a string-literal node (best effort, no escape semantics needed). */
export function stringValue(node: TSNode): string {
  let t = node.text;
  // python f-strings / js template literals: keep raw but trim wrappers
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  if (t.startsWith('`') && t.endsWith('`')) t = t.slice(1, -1);
  return t;
}

export function snippet(code: string, row: number): string {
  const line = code.split(/\r?\n/)[row];
  return (line ?? '').trim().slice(0, 220);
}

/** Node wrappers from web-tree-sitter are not referentially stable. */
export function sameNode(a: TSNode | null | undefined, b: TSNode | null | undefined): boolean {
  return !!a && !!b && (a.equals(b) ?? false);
}

let counter = 0;
export function siteId(file: string, row: number, path: string): string {
  counter += 1;
  return `${file}:${row + 1}:${path}#${counter}`;
}

/**
 * Normalize a member/selector chain to identifier segments.
 * e.g. stripe . customers . create -> ["stripe","customers","create"]
 */
export function chainSegments(root: TSNode): string[] | undefined {
  if (root.type === 'identifier') return [root.text];
  // JS/Python use object/property; Go uses operand/field.
  const obj = root.childForFieldName('object') ?? root.childForFieldName('operand');
  const prop = root.childForFieldName('property') ?? root.childForFieldName('field');
  if (!obj || !prop) return undefined;
  const head = chainSegments(obj);
  if (!head) return undefined;
  if (
    prop.type === 'property_identifier' ||
    prop.type === 'identifier' ||
    prop.type === 'field_identifier'
  ) {
    return [...head, prop.text];
  }
  if (isStringLiteral(prop)) return [...head, stringValue(prop)];
  return undefined;
}
