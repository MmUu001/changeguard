/**
 * Deterministic OpenAPI breaking-change detector.
 *
 * The diff itself is the ONLY thing that decides "breaking / deprecation /
 * behavior"; the LLM never participates here. Each emitted ChangeRecord
 * carries enough structure (operation + scope + target) for the impact engine
 * to pinpoint files and lines.
 *
 * Rules (see docs/architecture.md):
 *   D1 operation removed            -> breaking / operation
 *   D2 path removed                 -> breaking / service
 *   D3 required request param added -> breaking / parameter
 *   D4 optional request param removed / renamed -> breaking / parameter
 *   D5 request body field removed / newly required -> breaking / request-field
 *   D6 response field removed       -> breaking / response-field
 *   D7 enum value removed (request) / added (response) -> breaking / enum
 *   D8 operation flagged deprecated -> deprecation
 *   D9 declared type changed        -> breaking / field
 */
import type {
  AffectedOperation,
  ChangeKind,
  ChangeRecord,
  Confidence,
  Language,
  Rename,
} from '../types.js';

export interface OpenAPIParameter {
  name: string;
  in?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenAPISchema;
}

export interface OpenAPISchema {
  type?: string;
  $ref?: string;
  enum?: (string | number)[];
  required?: string[];
  properties?: Record<string, OpenAPISchema>;
  items?: OpenAPISchema;
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];
  additionalProperties?: boolean | OpenAPISchema;
  description?: string;
}

export interface OpenAPIOperation {
  operationId?: string;
  deprecated?: boolean;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenAPISchema }>;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: OpenAPISchema }>; description?: string }
  >;
}

export interface OpenAPIPathItem {
  [method: string]: OpenAPIOperation | string | undefined;
}

export interface OpenAPIDoc {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, OpenAPIPathItem>;
}

export interface DiffOptions {
  providerId: string;
  /** ISO date stamped on emitted records. */
  date: string;
  sourceUrl?: string;
  /** Free-form SDK hints keyed by "METHOD path". */
  sdkHints?: Partial<Record<Language, string[]>>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const HTTP_VERBS = new Set(METHODS.map((m) => m.toUpperCase()));

let seq = 0;
function record(
  partial: Omit<
    ChangeRecord,
    'id' | 'providerId' | 'source' | 'parserSignals' | 'confidence' | 'date'
  > & { date?: string },
  opts: DiffOptions,
  signals: string[],
  confidence: Confidence = 'high',
): ChangeRecord {
  seq += 1;
  const slug = (partial.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 6).join('-');
  return {
    id: `${opts.providerId}-openapi-${partial.date ?? opts.date}-${slug}-${seq}`,
    providerId: opts.providerId,
    source: 'openapi-diff',
    sourceUrl: opts.sourceUrl,
    parserSignals: signals,
    confidence,
    ...partial,
    date: partial.date ?? opts.date,
  };
}

function op(
  method: string,
  path: string,
  scope: AffectedOperation['scope'],
  target?: string,
  detail?: string,
  hints?: DiffOptions['sdkHints'],
): AffectedOperation {
  return {
    method: method.toUpperCase(),
    pathTemplate: path,
    scope,
    target,
    detail,
    sdkPaths: hints ? { ...hints } : undefined,
  };
}

function jsonRequestSchema(o: OpenAPIOperation): OpenAPISchema | undefined {
  return o.requestBody?.content?.['application/json']?.schema;
}
function jsonResponseSchema(o: OpenAPIOperation): OpenAPISchema | undefined {
  const ok = Object.keys(o.responses ?? {}).find((code) => code.startsWith('2'));
  return ok ? o.responses?.[ok]?.content?.['application/json']?.schema : undefined;
}

function flattenRequired(schema: OpenAPISchema | undefined): Set<string> {
  const out = new Set<string>();
  if (!schema) return out;
  for (const r of schema.required ?? []) out.add(r);
  for (const sub of [...(schema.allOf ?? []), schema.items].filter(Boolean) as OpenAPISchema[]) {
    for (const r of flattenRequired(sub)) out.add(r);
  }
  return out;
}

function enumValues(s: OpenAPISchema | undefined): (string | number)[] {
  if (!s) return [];
  if (Array.isArray(s.enum)) return s.enum;
  if (s.items?.enum) return s.items.enum;
  return [];
}

/**
 * Compare two OpenAPI documents. Records are returned in deterministic order.
 */
export function diffOpenApi(
  oldDoc: OpenAPIDoc,
  newDoc: OpenAPIDoc,
  opts: DiffOptions,
): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  const oldPaths = oldDoc.paths ?? {};
  const newPaths = newDoc.paths ?? {};

  const push = (
    kind: ChangeKind,
    title: string,
    summary: string,
    operations: AffectedOperation[],
    signals: string[],
    extra: Partial<ChangeRecord> = {},
  ): void => {
    out.push(
      record(
        {
          kind,
          title,
          summary,
          operations,
          renames: extra.renames ?? [],
          versions: extra.versions ?? [],
          migration: extra.migration,
          body: extra.body,
        },
        opts,
        signals,
        extra.confidence ?? 'high',
      ),
    );
  };

  for (const [path, oldItem] of Object.entries(oldPaths)) {
    const newItem = newPaths[path];

    // D2 whole path removed
    if (!newItem) {
      const verbs = METHODS.filter((m) => oldItem[m]).map((m) => m.toUpperCase());
      push(
        'breaking',
        `Endpoint removed: ${path}`,
        `All operations on ${path} (${verbs.join(', ')}) were removed.`,
        verbs.map((m) => op(m, path, 'operation')),
        ['D2:path-removed'],
        {
          migration:
            'Remove calls to this endpoint and migrate to the replacement documented by the vendor.',
        },
      );
      continue;
    }

    for (const method of METHODS) {
      const oldOp = oldItem[method] as OpenAPIOperation | undefined;
      const newOp = newItem[method] as OpenAPIOperation | undefined;
      if (!oldOp) continue;
      const hints = opts.sdkHints;

      // D1 operation removed
      if (!newOp) {
        push(
          'breaking',
          `${method.toUpperCase()} ${path} removed`,
          `The ${method.toUpperCase()} operation on ${path} was removed.`,
          [op(method, path, 'operation', undefined, undefined, hints)],
          ['D1:operation-removed'],
        );
        continue;
      }

      // D8 newly deprecated
      if (!oldOp.deprecated && newOp.deprecated) {
        push(
          'deprecation',
          `${method.toUpperCase()} ${path} deprecated`,
          `The ${method.toUpperCase()} operation on ${path} is now marked deprecated.`,
          [op(method, path, 'operation', undefined, 'OpenAPI deprecated: true', hints)],
          ['D8:deprecated-flag'],
          {
            migration:
              'Plan migration to the vendor-recommended replacement before the sunset date.',
          },
        );
      }

      // D3 + D4 parameters
      const oldParams = new Map((oldOp.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
      const newParams = new Map((newOp.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
      for (const [key, oldP] of oldParams) {
        const np = newParams.get(key);
        if (!np) {
          push(
            'breaking',
            `Parameter removed: ${oldP.name} (${oldP.in}) on ${method.toUpperCase()} ${path}`,
            `The ${oldP.in} parameter "${oldP.name}" was removed.`,
            [op(method, path, 'parameter', oldP.name, undefined, hints)],
            ['D4:parameter-removed'],
          );
        } else if (
          JSON.stringify(enumValues(oldP.schema)) !== JSON.stringify(enumValues(np.schema))
        ) {
          // D7 enum narrowing (request)
          const removed = enumValues(oldP.schema).filter(
            (v) => !enumValues(np.schema).map(String).includes(String(v)),
          );
          if (removed.length > 0) {
            push(
              'breaking',
              `Enum values removed for parameter ${oldP.name} on ${method.toUpperCase()} ${path}`,
              `No longer accepted: ${removed.join(', ')}`,
              [op(method, path, 'enum', oldP.name, `removed:${removed.join(',')}`, hints)],
              ['D7:enum-narrowed'],
            );
          }
        }
      }
      for (const [key, np] of newParams) {
        const op0 = oldParams.get(key);
        if (!op0 && np.required) {
          push(
            'breaking',
            `New required parameter: ${np.name} (${np.in}) on ${method.toUpperCase()} ${path}`,
            `Requests must now include the ${np.in} parameter "${np.name}".`,
            [op(method, path, 'parameter', np.name, 'newly-required', hints)],
            ['D3:required-parameter-added'],
          );
        }
      }

      // D5 request body schema
      const oldReq = jsonRequestSchema(oldOp);
      const newReq = jsonRequestSchema(newOp);
      if (oldReq && newReq) {
        const oldProps = oldReq.properties ?? {};
        const newProps = newReq.properties ?? {};
        for (const [name, oldField] of Object.entries(oldProps)) {
          const newField = newProps[name];
          if (!newField) {
            push(
              'breaking',
              `Request field removed: ${name} on ${method.toUpperCase()} ${path}`,
              `The request-body field "${name}" is no longer accepted.`,
              [op(method, path, 'request-field', name, undefined, hints)],
              ['D5:request-field-removed'],
            );
            continue;
          }
          if (oldField.type && newField.type && oldField.type !== newField.type) {
            push(
              'breaking',
              `Request field type changed: ${name} (${oldField.type} -> ${newField.type}) on ${method.toUpperCase()} ${path}`,
              `The field "${name}" changed type; existing values may be rejected.`,
              [
                op(
                  method,
                  path,
                  'request-field',
                  name,
                  `${oldField.type}->${newField.type}`,
                  hints,
                ),
              ],
              ['D9:type-changed'],
            );
          }
          const removedEnums = enumValues(oldField).filter(
            (v) => !enumValues(newField).map(String).includes(String(v)),
          );
          if (removedEnums.length) {
            push(
              'breaking',
              `Enum values removed for request field ${name} on ${method.toUpperCase()} ${path}`,
              `No longer accepted: ${removedEnums.join(', ')}`,
              [op(method, path, 'enum', name, `removed:${removedEnums.join(',')}`, hints)],
              ['D7:enum-narrowed'],
            );
          }
        }
        const oldRequired = flattenRequired(oldReq);
        const newRequired = flattenRequired(newReq);
        for (const name of newRequired) {
          if (!oldRequired.has(name) && oldProps[name] && newProps[name]) {
            push(
              'breaking',
              `Request field newly required: ${name} on ${method.toUpperCase()} ${path}`,
              `The field "${name}" must now be provided.`,
              [op(method, path, 'request-field', name, 'newly-required', hints)],
              ['D5:request-field-required'],
            );
          }
        }
      }

      // D6 response field removal + D7 response enum expansion
      const oldRes = jsonResponseSchema(oldOp);
      const newRes = jsonResponseSchema(newOp);
      if (oldRes?.properties && newRes?.properties) {
        for (const [name, oldField] of Object.entries(oldRes.properties)) {
          if (!newRes.properties[name]) {
            push(
              'breaking',
              `Response field removed: ${name} on ${method.toUpperCase()} ${path}`,
              `Clients reading response.${name} will break.`,
              [op(method, path, 'response-field', name, undefined, hints)],
              ['D6:response-field-removed'],
            );
          } else {
            const added = enumValues(newRes.properties[name]).filter(
              (v) => !enumValues(oldField).map(String).includes(String(v)),
            );
            if (added.length) {
              push(
                'breaking',
                `New enum values in response field ${name} on ${method.toUpperCase()} ${path}`,
                `Strict clients must handle: ${added.join(', ')}`,
                [op(method, path, 'enum', name, `added:${added.join(',')}`, hints)],
                ['D7:response-enum-expanded'],
                { confidence: 'medium' },
              );
            }
          }
        }
      }
    }
  }

  // deterministic ordering
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

export function isHttpVerb(s: string): boolean {
  return HTTP_VERBS.has(s.toUpperCase());
}

/** Extract "oldName -> newName" renames mentioned in free text. Deterministic token rules. */
export function extractRename(text: string): Rename[] {
  const renames: Rename[] = [];
  // `oldMethod()` is renamed to `newMethod()`  /  use `newMethod()` instead of `oldMethod()`
  const codeSpans = [...text.matchAll(/`([A-Za-z_][\w.]*)(?:\(\))?`/g)].map((m) => m[1]!);
  const arrow = text.match(
    /`([A-Za-z_][\w.]*)`(?:\(\))?\s+(?:is\s+)?(?:now\s+)?(?:renamed|replaced)\s+(?:to|with)\s+`([A-Za-z_][\w.]*)`/i,
  );
  if (arrow) {
    renames.push({
      kind: arrow[1]!.includes('.') ? 'method' : 'identifier',
      from: arrow[1]!,
      to: arrow[2]!,
    });
  }
  const instead = text.match(
    /use\s+`([A-Za-z_][\w.]*)`(?:\(\))?\s+instead\s+of\s+`([A-Za-z_][\w.]*)`/i,
  );
  if (instead) {
    renames.push({
      kind: instead[2]!.includes('.') ? 'method' : 'identifier',
      from: instead[2]!,
      to: instead[1]!,
    });
  }
  // parameter `old_name` -> `new_name`
  const paramArrow = text.match(
    /parameter\s+`([A-Za-z_][\w]*)`\s*(?:is\s+)?(?:renamed|replaced)\s+(?:to|with)\s+`([A-Za-z_][\w]*)`/i,
  );
  if (paramArrow) {
    renames.push({ kind: 'parameter', from: paramArrow[1]!, to: paramArrow[2]! });
  }
  void codeSpans;
  return dedupeRenames(renames);
}

function dedupeRenames(rs: Rename[]): Rename[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = `${r.kind}:${r.from}->${r.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
