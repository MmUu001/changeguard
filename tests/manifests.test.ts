import { describe, expect, it } from 'vitest';
import {
  normalizePyName,
  parseGoMod,
  parsePackageJson,
  parseRequirementsTxt,
} from '../src/deps/manifests.js';

describe('parsePackageJson', () => {
  it('parses runtime and dev buckets with concrete versions', () => {
    const deps = parsePackageJson(
      JSON.stringify({
        dependencies: { stripe: '^14.2.0', openai: '4.28.0' },
        devDependencies: { vitest: '^2.1.5' },
      }),
      'package.json',
    );
    expect(deps.map((d) => d.name)).toEqual(['stripe', 'openai', 'vitest']);
    const stripe = deps.find((d) => d.name === 'stripe')!;
    expect(stripe.version).toBe('14.2.0');
    expect(stripe.dev).toBe(false);
    expect(deps.find((d) => d.name === 'vitest')!.dev).toBe(true);
  });

  it('ignores local link/workspace specs without versions', () => {
    const deps = parsePackageJson(
      JSON.stringify({ dependencies: { a: 'workspace:*', b: 'file:../b', c: '^1.0.0' } }),
      'package.json',
    );
    expect(deps.map((d) => d.name)).toEqual(['c']);
  });

  it('returns nothing on invalid JSON', () => {
    expect(parsePackageJson('{broken', 'package.json')).toEqual([]);
  });
});

describe('parseRequirementsTxt', () => {
  it('parses pins, extras, comments and egg URLs', () => {
    const content = [
      '# comment',
      'openai==1.35.0',
      'Stripe_Toolkit[ext] >= 5.5.0  # inline comment',
      'git+https://x/y.git@cafe#egg=supa-client',
      '-r other.txt',
    ].join('\n');
    const deps = parseRequirementsTxt(content, 'requirements.txt');
    expect(deps.map((d) => d.name)).toEqual(['openai', 'stripe-toolkit', 'supa-client']);
    expect(deps[1]!.version).toBe('5.5.0');
  });

  it('normalizes PyPI names', () => {
    expect(normalizePyName('Google_API.core')).toBe('google-api-core');
  });
});

describe('parseGoMod', () => {
  it('parses single and block require entries, flags indirect and /vN', () => {
    const content = `module demo

go 1.22

require github.com/stripe/stripe-go/v78 v78.4.0

require (
	github.com/twilio/twilio-go v1.22.0
	github.com/pkg/errors v0.9.1 // indirect
)`;
    const deps = parseGoMod(content, 'go.mod');
    expect(deps.map((d) => d.name)).toEqual([
      'github.com/stripe/stripe-go/v78',
      'github.com/twilio/twilio-go',
      'github.com/pkg/errors',
    ]);
    expect(deps[0]!.version).toBe('78.4.0');
    expect(deps[2]!.indirect).toBe(true);
    expect(deps[1]!.indirect).toBe(false);
  });
});
