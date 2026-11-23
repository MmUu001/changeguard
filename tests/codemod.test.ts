import { describe, expect, it } from 'vitest';
import { applyCodemods, unifiedDiff } from '../src/codemod/apply.js';
import type { Codemod, Finding } from '../src/types.js';
import type { ChangeRecord } from '../src/types.js';

const changeStub: ChangeRecord = {
  id: 'c1',
  providerId: 'twilio',
  kind: 'breaking',
  title: 't',
  source: 'release-note',
  date: '2024-06-15',
  operations: [],
  renames: [],
  versions: [],
  parserSignals: [],
  confidence: 'high',
};

function f(file: string, line: number, codemod: Codemod): Finding {
  return {
    id: 'f1',
    providerId: 'twilio',
    changeId: 'c1',
    change: changeStub,
    file,
    line,
    ruleId: 'R8',
    match: 'parameter',
    severity: 'high',
    confidence: 'high',
    reason: '',
    codemod,
  } as Finding;
}

describe('applyCodemods', () => {
  it('renames a JS object key spanning multiline call arguments', () => {
    const content = ['client.messages.create({', "  statusCallback: 'https://x',", '});'].join(
      '\n',
    );
    const patch = applyCodemods('a.ts', content, [
      f('a.ts', 1, {
        kind: 'rename-parameter',
        from: 'statusCallback',
        to: 'statusCallbackUrl',
        language: 'javascript',
      }),
    ]);
    expect(patch).toBeTruthy();
    expect(patch!.newContent).toContain("statusCallbackUrl: 'https://x'");
    expect(patch!.newContent).not.toContain('statusCallback:');
    expect(patch!.applied[0]!.count).toBe(1);
  });

  it('renames a method call to its new tail identifier', () => {
    const content = 'return supabase.auth.signIn({ email });';
    const patch = applyCodemods('b.ts', content, [
      f('b.ts', 1, {
        kind: 'rename-method',
        from: 'signIn',
        to: 'signInWithPassword',
        language: 'javascript',
      }),
    ]);
    expect(patch!.newContent).toContain('auth.signInWithPassword(');
    expect(patch!.newContent).not.toContain('.signIn(');
  });

  it('renames a python keyword argument with the "=" separator', () => {
    const content = 'client.messages.create(\n    status_callback="https://x",\n)';
    const patch = applyCodemods('c.py', content, [
      f('c.py', 1, {
        kind: 'rename-parameter',
        from: 'status_callback',
        to: 'status_callback_url',
        language: 'python',
      }),
    ]);
    expect(patch!.newContent).toContain('status_callback_url=');
    expect(patch!.newContent).not.toContain('status_callback=');
  });

  it('leaves the file untouched (undefined) when the codemod does not fire', () => {
    const content = 'client.other.call();';
    const patch = applyCodemods('d.ts', content, [
      f('d.ts', 1, {
        kind: 'rename-method',
        from: 'signIn',
        to: 'signInWithPassword',
        language: 'javascript',
      }),
    ]);
    expect(patch).toBeUndefined();
  });
});

describe('unifiedDiff', () => {
  it('emits headers, hunk markers and +/- lines', () => {
    const diff = unifiedDiff(
      'a.ts',
      'const x = 1;\nsignIn();',
      'const x = 1;\nsignInWithPassword();',
    );
    expect(diff).toContain('--- a/a.ts');
    expect(diff).toContain('+++ b/a.ts');
    expect(diff).toMatch(/@@/);
    expect(diff).toContain('-signIn();');
    expect(diff).toContain('+signInWithPassword();');
  });

  it('returns empty string for identical content', () => {
    expect(unifiedDiff('a.ts', 'x', 'x')).toBe('');
  });
});
