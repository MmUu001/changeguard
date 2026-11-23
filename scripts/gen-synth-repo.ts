#!/usr/bin/env node
/**
 * Synthetic repository generator for performance baselines.
 *
 *   npx tsx scripts/gen-synth-repo.ts --files 1000 --out .changeguard/synth
 *
 * Produces a repo mixing TS / Python / Go files (70/20/10) that import all
 * five supported providers and call them through realistic member chains —
 * the same shapes the analyzers recognize in fixtures/sample-repo. Meant for
 * timing scans at scale, not for semantic testing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const files = Math.max(1, Number(arg('--files', '100')));
const out = arg('--out', '.changeguard/synth')!;

mkdirSync(out, { recursive: true });

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'synth-repo',
      private: true,
      dependencies: {
        stripe: '^18.0.0',
        openai: '^7.0.0',
        '@shopify/shopify-api': '^9.0.0',
        twilio: '^6.0.0',
        '@supabase/supabase-js': '^2.0.0',
      },
    },
    null,
    2,
  ),
);
writeFileSync(join(out, 'requirements.txt'), 'stripe==12.0.0\nopenai==1.40.0\ntwilio==9.0.0\n');
writeFileSync(
  join(out, 'go.mod'),
  'module synth\n\ngo 1.22\n\nrequire (\n\tgithub.com/stripe/stripe-go/v78 v78.0.0\n\tgithub.com/twilio/twilio-go v1.20.0\n)\n',
);

const tsFile = (i: number): string => `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_placeholder');

export async function runModule${i}() {
  await stripe.charges.create({ amount: ${100 + i}, currency: 'usd', source: 'tok_placeholder' });
  const session = await stripe.checkout.sessions.create({ mode: 'payment' });
  return session;
}
`;

const pyFile = (i: number): string => `import stripe

def run_module_${i}():
    stripe.api_key = "sk_test_placeholder"
    stripe.Charge.create(amount=${100 + i}, currency="usd", source="tok_placeholder")
    return True
`;

const goFile = (i: number): string => `package mod

import (
	"github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/charge"
)

func RunModule${i}() {
	params := &stripe.ChargeParams{Amount: stripe.Int64(${100 + i}), Currency: stripe.String("usd")}
	charge.New(params)
}
`;

let lazy = 0;
let py = 0;
let go = 0;
for (let i = 0; i < files; i++) {
  const bucket = i % 10;
  if (bucket < 7) {
    mkdirSync(join(out, 'src', 'mod'), { recursive: true });
    writeFileSync(join(out, 'src', 'mod', `mod_${i}.ts`), tsFile(i));
    lazy++;
  } else if (bucket < 9) {
    mkdirSync(join(out, 'py'), { recursive: true });
    writeFileSync(join(out, 'py', `mod_${i}.py`), pyFile(i));
    py++;
  } else {
    mkdirSync(join(out, 'gomod'), { recursive: true });
    writeFileSync(join(out, 'gomod', `mod_${i}.go`), goFile(i));
    go++;
  }
}

console.log(`synthetic repo: ${files} files (ts=${lazy} py=${py} go=${go}) -> ${out}`);
