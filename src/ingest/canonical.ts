/**
 * Canonical JSON (v1) used for feed signing and verification.
 *
 * Signatures must cover a deterministic byte sequence, never `JSON.stringify`
 * output: key order is not stable in general and whitespace differs by producer.
 *
 * Rules (v1):
 *  - objects: keys sorted by UTF-16 code unit order, no whitespace
 *  - arrays: order preserved
 *  - strings: JSON.stringify escaping (RFC 8259)
 *  - numbers: finite only; -0 is normalized to 0; other values use JSON.stringify
 *  - `undefined` object members are omitted, matching JSON semantics
 *  - null / boolean: as-is
 *  - anything else (bigint, function, symbol) throws
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      if (Object.is(value, -0)) return '0';
      return JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const member = obj[key];
        if (member === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** UTF-8 bytes of the canonical form. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
