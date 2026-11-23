import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/impact/engine.js';
import type {
  AffectedOperation,
  CallSite,
  ChangeRecord,
  Dependency,
  Language,
  Rename,
  VersionInfo,
} from '../src/types.js';

let seq = 0;
function change(init: {
  kind?: ChangeRecord['kind'];
  operations?: AffectedOperation[];
  renames?: Rename[];
  versions?: VersionInfo[];
  providerId?: string;
  title?: string;
  date?: string;
}): ChangeRecord {
  seq += 1;
  return {
    id: `ch-${seq}`,
    providerId: init.providerId ?? 'stripe',
    kind: init.kind ?? 'breaking',
    title: init.title ?? 'test change',
    source: 'release-note',
    date: init.date ?? '2024-04-11',
    operations: init.operations ?? [],
    renames: init.renames ?? [],
    versions: init.versions ?? [],
    parserSignals: [],
    confidence: 'high',
  };
}

function site(init: Partial<CallSite> & { path: string; language: Language }): CallSite {
  return {
    id: `site-${Math.random().toString(36).slice(2)}`,
    file: 'src/a.ts',
    line: 10,
    package: 'p',
    providerId: 'stripe',
    receiver: 'client',
    callText: `client.${init.path}()`,
    argumentKeys: [],
    argumentLiterals: {},
    memberRefs: [],
    ...init,
  };
}

function dep(init: Partial<Dependency> & { name: string }): Dependency {
  // scanRepository annotates providerId from the registry before evaluation.
  return { ecosystem: 'npm', dev: false, manifest: 'package.json', providerId: 'stripe', ...init };
}

describe('engine rule R1/R2 (SDK path)', () => {
  it('R1 exact match -> high for breaking changes', () => {
    const ch = change({
      operations: [{ scope: 'operation', sdkPaths: { javascript: ['charges.create'] } }],
    });
    const out = evaluate({
      sites: [site({ path: 'charges.create', language: 'javascript' })],
      dependencies: [],
      changes: [ch],
    });
    expect(out.some((f) => f.ruleId === 'R1' && f.severity === 'high')).toBe(true);
  });

  it('R2 prefix wildcard on removed namespace', () => {
    const ch = change({
      operations: [{ scope: 'sdk-method', sdkPaths: { javascript: ['rest.*'] } }],
    });
    const out = evaluate({
      sites: [site({ path: 'rest.Product.all', language: 'javascript' })],
      dependencies: [],
      changes: [ch],
    });
    expect(out.some((f) => f.ruleId === 'R2')).toBe(true);
  });

  it('unrelated call produces no R1/R2', () => {
    const ch = change({
      operations: [{ scope: 'operation', sdkPaths: { javascript: ['charges.create'] } }],
    });
    const out = evaluate({
      sites: [site({ path: 'payouts.list', language: 'javascript' })],
      dependencies: [],
      changes: [ch],
    });
    expect(out.some((f) => f.ruleId === 'R1')).toBe(false);
  });
});

describe('engine rule R3/R5 (parameters, enums)', () => {
  it('R3 flags a removed request parameter used at the call', () => {
    const ch = change({
      operations: [
        { scope: 'operation', sdkPaths: { javascript: ['charges.create'] } },
        { scope: 'parameter', target: 'source', sdkPaths: { javascript: ['charges.create'] } },
      ],
    });
    const out = evaluate({
      sites: [
        site({
          path: 'charges.create',
          language: 'javascript',
          argumentKeys: ['amount', 'source'],
        }),
      ],
      dependencies: [],
      changes: [ch],
    });
    expect(out.some((f) => f.ruleId === 'R3' && f.reason.includes('source'))).toBe(true);
  });

  it('R5 flags a removed enum literal', () => {
    const ch = change({
      providerId: 'openai',
      operations: [
        {
          scope: 'enum',
          target: 'model',
          detail: 'removed:text-davinci-003',
          sdkPaths: { javascript: ['completions.create'] },
        },
      ],
    });
    const out = evaluate({
      sites: [
        site({
          path: 'completions.create',
          language: 'javascript',
          providerId: 'openai',
          argumentLiterals: { model: ['text-davinci-003'] },
        }),
      ],
      dependencies: [],
      changes: [ch],
    });
    expect(out.some((f) => f.ruleId === 'R5' && f.severity === 'high')).toBe(true);
  });
});

describe('engine rule R6 (raw HTTP)', () => {
  it('matches method + templated path', () => {
    const ch = change({
      providerId: 'openai',
      operations: [{ scope: 'operation', method: 'POST', pathTemplate: '/v1/edits' }],
    });
    const s = site({
      path: '/v1/edits',
      language: 'javascript',
      providerId: 'openai',
      http: { method: 'POST', url: 'https://api.openai.com/v1/edits' },
    });
    const out = evaluate({ sites: [s], dependencies: [], changes: [ch] });
    expect(out.some((f) => f.ruleId === 'R6')).toBe(true);
  });
});

describe('engine rule R7 (dependency pins)', () => {
  it('flags pins older than removedIn and ignores newer pins', () => {
    const ch = change({ versions: [{ ecosystem: 'npm', package: 'stripe', removedIn: '15.0.0' }] });
    const old = evaluate({
      sites: [],
      dependencies: [dep({ name: 'stripe', spec: '^14.2.0', version: '14.2.0' })],
      changes: [ch],
    });
    expect(old.some((f) => f.ruleId === 'R7' && f.severity === 'high')).toBe(true);

    const fresh = evaluate({
      sites: [],
      dependencies: [dep({ name: 'stripe', spec: '^16.0.0', version: '16.0.0' })],
      changes: [ch],
    });
    expect(fresh.some((f) => f.ruleId === 'R7')).toBe(false);
  });
});

describe('engine rule R8 (renames + codemods)', () => {
  it('emits a rename-parameter codemod scoped to the language', () => {
    const ch = change({
      providerId: 'twilio',
      operations: [
        {
          scope: 'sdk-method',
          sdkPaths: { javascript: ['messages.create'], python: ['messages.create'] },
        },
      ],
      renames: [
        {
          kind: 'parameter',
          from: 'statusCallback',
          to: 'statusCallbackUrl',
          language: 'javascript',
        },
        {
          kind: 'parameter',
          from: 'status_callback',
          to: 'status_callback_url',
          language: 'python',
        },
      ],
    });
    const js = evaluate({
      sites: [
        site({
          path: 'messages.create',
          language: 'javascript',
          providerId: 'twilio',
          argumentKeys: ['statusCallback'],
        }),
      ],
      dependencies: [],
      changes: [ch],
    });
    const f = js.find((x) => x.ruleId === 'R8');
    expect(f?.codemod).toMatchObject({
      kind: 'rename-parameter',
      from: 'statusCallback',
      to: 'statusCallbackUrl',
    });

    const py = evaluate({
      sites: [
        site({
          path: 'messages.create',
          language: 'python',
          providerId: 'twilio',
          argumentKeys: ['status_callback'],
        }),
      ],
      dependencies: [],
      changes: [ch],
    });
    expect(py.find((x) => x.ruleId === 'R8')?.codemod?.from).toBe('status_callback');
  });

  it('emits a rename-method codemod using the tail identifier', () => {
    const ch = change({
      providerId: 'supabase',
      kind: 'deprecation',
      operations: [{ scope: 'sdk-method', sdkPaths: { javascript: ['auth.signIn'] } }],
      renames: [
        {
          kind: 'method',
          from: 'auth.signIn',
          to: 'auth.signInWithPassword',
          language: 'javascript',
        },
      ],
    });
    const out = evaluate({
      sites: [site({ path: 'auth.signIn', language: 'javascript', providerId: 'supabase' })],
      dependencies: [],
      changes: [ch],
    });
    const f = out.find((x) => x.ruleId === 'R8');
    expect(f?.codemod).toMatchObject({
      kind: 'rename-method',
      from: 'signIn',
      to: 'signInWithPassword',
    });
    expect(f?.severity).toBe('medium'); // deprecation
  });
});

describe('engine rule R9 (repo advisory)', () => {
  it('advises manual review when provider is used but nothing concretely matched', () => {
    const ch = change({
      providerId: 'openai',
      operations: [{ scope: 'operation', sdkPaths: { javascript: ['edits.create'] } }],
    });
    const out = evaluate({
      sites: [site({ path: 'models.list', language: 'javascript', providerId: 'openai' })],
      dependencies: [dep({ name: 'openai', version: '4.0.0' })],
      changes: [ch],
    });
    const adv = out.find((f) => f.ruleId === 'R9');
    expect(adv).toBeTruthy();
    expect(adv!.confidence).toBe('low');
    expect(adv!.file).toBeUndefined();
  });

  it('aggregates all un-matched changes into one advisory per provider', () => {
    const out = evaluate({
      sites: [
        site({ path: 'models.list', language: 'javascript', providerId: 'openai' }),
        site({ path: 'customers.list', language: 'javascript', providerId: 'stripe' }),
      ],
      dependencies: [],
      changes: [
        // openai: 2 breaking + 1 deprecation, none matched
        change({
          providerId: 'openai',
          kind: 'breaking',
          date: '2026-10-20',
          title: 'Live Decisions type change',
        }),
        change({
          providerId: 'openai',
          kind: 'breaking',
          date: '2026-10-25',
          title: 'Live response instructions union',
        }),
        change({
          providerId: 'openai',
          kind: 'deprecation',
          date: '2026-09-01',
          title: 'Legacy models deprecated',
        }),
        // stripe: 1 deprecation only
        change({
          providerId: 'stripe',
          kind: 'deprecation',
          date: '2026-07-29',
          title: 'proof_of_registration removed',
        }),
        // feature noise must be skipped entirely
        change({ providerId: 'openai', kind: 'feature', title: 'New endpoint' }),
      ],
    });
    const advisories = out.filter((f) => f.ruleId === 'R9');
    expect(advisories).toHaveLength(2); // one per provider, not one per change

    const openai = advisories.find((f) => f.providerId === 'openai')!;
    expect(openai.severity).toBe('medium'); // breaking present
    expect(openai.reason).toContain('3 un-matched change(s) from openai');
    expect(openai.reason).toContain('2 breaking');
    expect(openai.reason).toContain('1 deprecation');
    // Representative: newest breaking change drives the report detail.
    expect(openai.change.title).toBe('Live response instructions union');

    const stripe = advisories.find((f) => f.providerId === 'stripe')!;
    expect(stripe.severity).toBe('low'); // deprecation only
    expect(stripe.reason).toContain('1 un-matched change(s) from stripe');
  });

  it('lists at most three titles and summarizes the remainder', () => {
    const changes = Array.from({ length: 5 }, (_, i) =>
      change({
        providerId: 'openai',
        kind: 'breaking',
        date: `2026-0${i + 1}-01`,
        title: `Change ${i + 1}`,
      }),
    );
    const out = evaluate({
      sites: [site({ path: 'models.list', language: 'javascript', providerId: 'openai' })],
      dependencies: [],
      changes,
    });
    const adv = out.find((f) => f.ruleId === 'R9')!;
    expect(adv.reason).toContain('5 un-matched change(s)');
    expect(adv.reason).toContain('+2 more');
  });
});
